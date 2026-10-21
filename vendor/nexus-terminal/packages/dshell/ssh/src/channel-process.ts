/**
 * One device process, seen as a `SubprocessHandle`.
 *
 * This is the legacy lane's new shape: where it used to rewrite the caller's
 * argv into an `ssh …` line and hand that to the local provider, it now opens a
 * channel on the device's pooled connection and runs the same line over it.
 * The command string is unchanged — `cd <dir> && exec <argv>` — so what a caller
 * observes is the same process on the same device with the same output; only the
 * bytes' route differs.
 *
 * Everything the seam promises is served here: stdin as a pipe, stdout/stderr as
 * pipes or bounded collectors with a spill file, `done` from the channel's exit
 * status, `terminate` as a signal plus a channel close, and `waitForExit` over
 * the same range. Two things are deliberately NOT served, and both are honest
 * about it:
 *
 *  - **A control channel.** It needs a separately authenticated stream the
 *    transport does not have, so `control` is undefined — the same answer the
 *    RPC lane gives for the same reason.
 *  - **An inherited descriptor.** `'inherit'` asks for the parent's own stream,
 *    which a remote process has no access to; it is served as a pipe instead,
 *    which is the closest thing that carries the same bytes.
 *
 * `env` is not forwarded either: the remote side is a login shell whose sshd
 * accepts only a handful of variables from a client, and the assembled path this
 * replaces never got them there either. A caller that needs an environment
 * variable on the device gets it through the RPC lane, whose helper sets it on
 * the child directly.
 */
import { closeSync, mkdtempSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Duplex, Readable, Writable } from 'node:stream'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { DeviceCommand } from './transport/transport.js'

/**
 * A private per-process directory for spill files.
 *
 * Under the OS tmpdir, 0700, created once: a predictable world-readable path
 * would let another local user read a command's output or pre-create a symlink.
 * Completed spill files are left for the OS's temp hygiene, exactly as the local
 * provider leaves them — they are recovery artifacts, and deleting one when the
 * handle is closed would delete it before the reader that asked for it has read.
 */
const SPILL_DIR = mkdtempSync(join(tmpdir(), 'dshell-ssh-'))

/** How many spill files this process has opened, for unique names. */
let spillCount = 0

/**
 * One collected stream: a bounded tail, plus the whole stream on disk.
 *
 * The in-memory window keeps the newest `maxBytes` bytes, and the spill file
 * holds everything up to `spillMaxBytes`. A stream past the spill cap discards
 * its now-incomplete spill rather than keeping a truncated file that reads as
 * the whole output.
 */
class Collector implements SubprocessOutputReader {
  private chunks: Buffer[] = []
  private size = 0
  private total = 0
  private spillPath: string | undefined
  private spillFd: number | undefined
  private spillBytes = 0
  /** Set once the spill is gone or was never opened; nothing is retried after. */
  private spillDiscarded = false

  constructor(
    stream: Readable,
    private readonly maxBytes: number,
    private readonly spillMaxBytes: number | undefined,
    private readonly label: string,
  ) {
    stream.on('data', (chunk: Buffer) => { this.push(chunk) })
    stream.on('error', () => { this.closeSpill() })
    stream.on('end', () => { this.closeSpill() })
  }

  /** The whole stream so far, as an offset the caller can resume from. */
  private push(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.size += chunk.length
    this.total += chunk.length
    if (this.size > this.maxBytes * 2) {
      const merged = Buffer.concat(this.chunks)
      const excess = this.size - this.maxBytes
      this.chunks = [merged.subarray(excess)]
      this.size = this.maxBytes
    }
    this.spill(chunk)
  }

  /** Append to the spill file, opening it on the first byte. */
  private spill(chunk: Buffer): void {
    if (this.spillMaxBytes === undefined || this.spillDiscarded) return
    if (this.spillFd === undefined) {
      spillCount += 1
      try {
        this.spillPath = join(SPILL_DIR, `${this.label}-${String(process.pid)}-${String(spillCount)}`)
        this.spillFd = openSync(this.spillPath, 'w', 0o600)
      } catch {
        // A spill that cannot be opened degrades to the in-memory tail, which is
        // what a collector with no `spill` asked for in the first place.
        this.discardSpill()
        return
      }
    }
    try {
      writeSync(this.spillFd, chunk)
      this.spillBytes += chunk.length
    } catch {
      this.discardSpill()
      return
    }
    if (this.spillBytes > this.spillMaxBytes) this.discardSpill()
  }

  /** Drop the spill file: past its cap it is worse than nothing. */
  private discardSpill(): void {
    this.closeSpill()
    if (this.spillPath !== undefined) {
      try { unlinkSync(this.spillPath) } catch { /* already gone */ }
      this.spillPath = undefined
    }
    this.spillDiscarded = true
  }

  private closeSpill(): void {
    if (this.spillFd === undefined) return
    try { closeSync(this.spillFd) } catch { /* already closed */ }
    this.spillFd = undefined
  }

  readFrom(fromByte: number): SubprocessOutputRead {
    const windowStart = this.total - this.size
    const lossy = fromByte < windowStart
    const bytes = Buffer.concat(this.chunks)
    const text = (lossy ? bytes : bytes.subarray(fromByte - windowStart)).toString('utf8')
    return {
      text,
      nextOffset: this.total,
      lossy,
      ...this.spillPath === undefined ? {} : { spillPath: this.spillPath },
    }
  }
}

/** One stream's collector, or undefined when the caller asked for a pipe. */
function collectorFor(
  mode: SubprocessSpawnSpec['stdio']['stdout'],
  stream: Readable,
  label: string,
): SubprocessOutputReader | undefined {
  if (typeof mode !== 'object') return undefined
  return new Collector(stream, mode.maxBytes, mode.spill?.maxBytes, label)
}

/** Whether one output mode exposes the raw stream to the caller. */
function piped(mode: SubprocessSpawnSpec['stdio']['stdout']): boolean {
  return mode === 'pipe' || mode === 'inherit'
}

/**
 * A process running on a device, over one channel.
 *
 * The handle is returned before the channel is open: the seam's `spawn` is
 * synchronous, and dialing a device is not. The shims below are what make that
 * work — a caller that writes to stdin or reads stdout sees ordinary streams
 * immediately, and the channel is wired behind them the moment it exists.
 */
export class DeviceSubprocessHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  /** Never served here; see the module header. */
  readonly control: Duplex | undefined = undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  private run: DeviceCommand | undefined

  /**
   * @param start - the channel being opened; may reject for a spawn failure.
   * @param spec - the caller's fully-specified spawn.
   */
  constructor(start: Promise<DeviceCommand>, spec: SubprocessSpawnSpec) {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    this.stdin = spec.stdio.stdin === 'pipe' ? stdin : undefined
    this.stdout = piped(spec.stdio.stdout) ? stdout : undefined
    this.stderr = piped(spec.stdio.stderr) ? stderr : undefined
    const out = collectorFor(spec.stdio.stdout, stdout, 'stdout')
    const err = collectorFor(spec.stdio.stderr, stderr, 'stderr')
    this.collected = {
      ...out === undefined ? {} : { stdout: out },
      ...err === undefined ? {} : { stderr: err },
    }
    this.done = (async (): Promise<SubprocessOutcome> => {
      const run = await start
      this.run = run
      run.stream.pipe(stdout)
      run.stderr.pipe(stderr)
      if (spec.stdio.stdin === 'pipe') stdin.pipe(run.stream)
      const outcome = await run.done
      return { exitCode: outcome.exitCode, signal: outcome.signal as NodeJS.Signals | null }
    })()
    // A spawn failure the caller never awaited must not become an unhandled
    // rejection: the seam allows `done` to reject, and the harness treats an
    // unhandled one as fatal to the whole host.
    void this.done.catch(() => undefined)
  }

  terminate(): void {
    this.run?.terminate()
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted === true) return false
    // The channel IS the managed range: once it is closed there is nothing left
    // on the device belonging to this spawn, so a settled `done` — resolved or
    // rejected — is an empty range either way.
    return await Promise.race([
      this.done.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        signal?.addEventListener('abort', () => { resolve(false) }, { once: true })
      }),
    ])
  }
}
