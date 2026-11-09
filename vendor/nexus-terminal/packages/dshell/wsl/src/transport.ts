/**
 * A WSL2 distribution as a device: the transport that runs one in-process.
 *
 * WSL is "a device on this machine whose transport is `wsl.exe`", and this
 * package is the whole of it: the doors (`exec`/`open` as plain child
 * processes, `shell` as a ConPTY pty), the distribution detection, and the
 * provider that registers all three into dshell-ssh's device registry. The
 * device MODEL — bindings, spawn plans, mount translation, the subprocess and
 * filesystem seams — belongs to the registry's owner; the only thing that
 * differs from an SSH device is HOW bytes leave this process, and that is all
 * that lives here. The bridge's own settle injection (its PROMPT_COMMAND
 * written into the pty after the shell is up) is transport-agnostic, so the
 * command splitter, the block log and the completion warm trigger all work
 * over this path unchanged — proven against a real machine (the `wsl-spike`):
 * the marker bytes survive ConPTY, resize reaches the inner shell, and the
 * session exits cleanly.
 *
 * What is deliberately NOT here: the SSH vocabulary. A WSL device has no host
 * key (there is no handshake to verify), no credential (the distro is the
 * credential), no helper deployment (the exec lane serves everything the
 * helper would), and no port forwards (WSL2 shares this machine's loopback —
 * the provider refuses them before anyone asks).
 */

import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { Duplex } from 'node:stream'
import { Readable } from 'node:stream'
import type { Writable } from 'node:stream'
// Type-only: DeviceConnection is the std fact; the door vocabulary is
// dshell-ssh's extension point (see the note in this package's index.ts).
import type { DeviceConnection } from '@nexus-aethra/dshell-std'
import type {
  DeviceCommand,
  DeviceDoors,
  DeviceExecOptions,
  DeviceExecResult,
  DeviceOutcome,
  DeviceShell,
} from '@nexus-aethra/dshell-ssh'

/** One WSL distribution this machine could run a shell in. */
export interface WslDistro {
  /** The registered distribution name, as `wsl.exe` spells it. */
  readonly name: string
  /** Whether `wsl.exe` runs this one when no `-d` is given. */
  readonly default: boolean
  /** WSL architecture generation. Only 2 is supported. */
  readonly version: 1 | 2
}

/**
 * Decode `wsl.exe` management output.
 *
 * The management subcommands (`--list`, `--status`) answer in UTF-16LE —
 * with a BOM when redirected, without one in some pipes — while everything
 * an executed Linux command prints is UTF-8. A UTF-8 decoder fed UTF-16LE
 * interleaves NUL bytes into every other position, which is the tell used
 * here before trusting either decoding.
 */
export function decodeWslOutput(raw: Buffer): string {
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return raw.subarray(2).toString('utf16le')
  }
  // No BOM: count NUL bytes. UTF-16LE ASCII text puts one in every other
  // byte; UTF-8 output of the same length has essentially none.
  let nulls = 0
  for (const byte of raw) {
    if (byte === 0) nulls += 1
  }
  return nulls > raw.length / 8 ? raw.toString('utf16le') : raw.toString('utf8')
}

/**
 * Parse `wsl.exe --list --verbose` output into distributions.
 *
 * The columns are whitespace-separated and the header line is LOCALIZED
 * (NAME / 名称), so the header is skipped positionally rather than by
 * matching its text: the first non-empty line never carries a trailing
 * digit. A row is read as `[·] NAME STATE VERSION` — the default marker may
 * be glued to the name or stand alone, the version is the last token, the
 * state the one before it. Distribution names are store identifiers without
 * runs of whitespace in practice; a row that cannot be read this way is
 * skipped rather than turned into a device.
 *
 * @param text - decoded output of one `--list --verbose` run.
 * @returns the distributions, in the order wsl.exe listed them.
 */
export function parseWslList(text: string): WslDistro[] {
  const distros: WslDistro[] = []
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  for (const line of lines.slice(1)) {
    const versionMatch = line.match(/(?:^|\s)([12])$/u)
    if (versionMatch === null) continue
    const head = line.slice(0, line.length - versionMatch[0].length).trim()
    const defaultMarked = head.startsWith('*')
    const withoutMark = defaultMarked ? head.slice(1).trim() : head
    const stateMatch = withoutMark.match(/^(.*?)\s+(\S+)$/u)
    const name = (stateMatch === null ? withoutMark : stateMatch[1]).trim()
    if (name === '') continue
    distros.push({
      name,
      default: defaultMarked,
      version: versionMatch[1] === '1' ? 1 : 2,
    })
  }
  return distros
}

/** The WSL device id prefix; a device id carrying it is a built-in row. */
export const WSL_DEVICE_PREFIX = 'wsl:'

/** Whether this device id names a WSL distribution. */
export function isWslDevice(deviceId: string): boolean {
  return deviceId.startsWith(WSL_DEVICE_PREFIX)
}

/** The distribution a WSL device runs, from its id. */
export function distroOf(deviceId: string): string {
  return deviceId.slice(WSL_DEVICE_PREFIX.length)
}

/** The argv that runs one command line inside one distribution. */
export function wslExecArgs(deviceId: string, command: string): string[] {
  return ['-d', distroOf(deviceId), '-e', 'bash', '-c', command]
}

/** The management executable; System32 is on every PATH that has WSL at all. */
export const WSL_EXE = 'wsl.exe'

/** stdout/stderr caps, matching the SSH transport's. */
const STDOUT_MAX_BYTES = 8 * 1024 * 1024
const STDERR_MAX_BYTES = 64 * 1024
const STDIN_CHUNK_BYTES = 64 * 1024
const TERMINATED: DeviceOutcome = { exitCode: null, signal: 'SIGTERM' }

/** A tail-keeping window over one stream (the SSH transport's shape). */
class Window {
  private chunks: Buffer[] = []
  private size = 0
  private dropped = 0

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.size += chunk.length
    if (this.size <= this.maxBytes * 2) return
    const merged = Buffer.concat(this.chunks)
    const excess = this.size - this.maxBytes
    this.dropped += excess
    this.chunks = [merged.subarray(excess)]
    this.size = this.maxBytes
  }

  get truncated(): boolean {
    return this.dropped > 0
  }

  text(): string {
    return this.chunks.length === 0 ? '' : Buffer.concat(this.chunks).toString('utf8')
  }
}

/**
 * Write into a child pipe that may already be dead. A dying child turns its
 * pipes into EPIPE — thrown synchronously here or delivered later as an
 * 'error' event — and an unhandled either is fatal to the whole host, which
 * is why every pipe touch is guarded and every pipe carries a handler.
 */
function guardedWrite(target: Writable | null, chunk: Buffer): void {
  if (target === null) return
  try {
    if (!target.writableEnded) target.write(chunk)
  } catch { /* EPIPE and friends: the child is gone; `done` reports it */ }
}

/** End a child pipe that may already be dead, with the same guard. */
function guardedEnd(target: Writable | null): void {
  if (target === null) return
  try { target.end() } catch { /* already gone */ }
}

/**
 * One running `wsl.exe` command, as a {@link DeviceCommand}.
 *
 * The duplex is OUR pipe: writes into it go to the child's stdin, the
 * child's stdout comes out of it. Ending the duplex is what the no-stdin
 * contract reads as EOF on the far side, and `terminate` kills the host
 * process — which is what carries the distro's process tree, so a killed
 * command ends the way a killed SSH channel does, residue on the far side
 * included.
 */
class ProcessCommand implements DeviceCommand {
  readonly stream: Duplex
  readonly stderr: Readable
  readonly done: Promise<DeviceOutcome>

  constructor(private readonly process: ChildProcess) {
    // TWO sides, not one. The duplex's WRITABLE side is the child's stdin and
    // its READABLE side is the child's stdout, and the two never touch: ending
    // the writable side (what the no-stdin contract does) must not end the
    // readable one. Carrying both directions on one PassThrough did exactly
    // that - the exec door closed its own read side and dropped every byte the
    // child printed, so a WSL device answered every command with an empty
    // stdout. The SSH transport keeps three separate PassThroughs for the same
    // reason (see dshell-ssh/src/channel-process.ts).
    const stream = new Duplex({
      write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        guardedWrite(process.stdin, chunk as Buffer)
        callback()
      },
      final(callback: (error?: Error | null) => void) {
        guardedEnd(process.stdin)
        callback()
      },
      read() {
        // The readable side is fed by push() below; nothing is pulled here.
      },
    })
    process.stdout?.on('data', (chunk: Buffer) => { stream.push(chunk) })
    process.stdout?.on('end', () => { stream.push(null) })
    // The pipes' async failures (EPIPE after the child died) arrive as
    // 'error' events; without handlers they are fatal to the host, exactly
    // like the channel errors the SSH transport swallows.
    process.stdin?.on('error', () => undefined)
    process.stdout?.on('error', () => undefined)
    process.stderr?.on('error', () => undefined)
    // The child's errors are reported through `done` as the lost-process
    // outcome they are; an unhandled 'error' event would take the host down.
    process.on('error', () => undefined)
    this.stream = stream
    this.stderr = process.stderr ?? Readable.from([])
    this.done = new Promise<DeviceOutcome>((resolve) => {
      let settled = false
      const once = (outcome: DeviceOutcome): void => {
        if (settled) return
        settled = true
        resolve(outcome)
      }
      process.on('exit', (code, signal) => {
        once(signal !== null
          ? { exitCode: null, signal }
          : { exitCode: typeof code === 'number' ? code : null, signal: null })
        // The child's stdout 'end' pushes the readable side's EOF; what is left
        // to close here is the write side, so a reader waiting on the stream
        // is not held open by a stdin nobody will write to again.
        guardedEnd(process.stdin)
      })
      process.on('error', () => {
        // Spawn failure (wsl.exe missing, distro gone): no exit status exists,
        // and `exec`'s idempotent repeat is safe to make.
        once({ exitCode: null, signal: null, connectionLost: true })
      })
    })
  }

  terminate(signal = 'SIGTERM'): void {
    void signal
    try { this.process.kill() } catch { /* already gone */ }
  }
}

/**
 * How a `wsl.exe` process is started.
 *
 * Injectable so the doors can be proven without a WSL machine: the exec
 * lane's output contract is a property of the duplex's two sides, not of
 * what `wsl.exe` happens to print.
 */
export type WslSpawn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess

/**
 * Extend `WSLENV` with the names a caller asked to pass through.
 *
 * `WSLENV` is a colon-separated list (a `/p` suffix marks a path to translate
 * between the two filesystems). An existing list is preserved, so a caller's
 * additions never erase whatever the host already bridges.
 * @param current - the host's own `WSLENV`, when it has one.
 * @param names - the variables to carry into the distro.
 * @returns the list `wsl.exe` should read.
 */
function wslEnvBridge(current: string | undefined, names: readonly string[]): string {
  const kept = (current ?? '').split(':').filter(name => name !== '')
  return [...new Set([...kept, ...names])].join(':')
}

/** The real one: `wsl.exe` with the given arguments. */
const defaultSpawn: WslSpawn = (file, args, options) => spawn(file, [...args], options)

/**
 * The WSL doors. One instance per host; nothing is pooled, because every
 * operation is a fresh `wsl.exe` process and the distro's own start-up is
 * what a cold call pays for.
 */
export class WslTransport implements DeviceDoors {
  /**
   * @param spawn - how a `wsl.exe` process is started; the default is the real one.
   */
  constructor(private readonly spawn: WslSpawn = defaultSpawn) {}

  /** Run one command and collect its output, bounded. */
  async exec(device: DeviceConnection, command: string, options: DeviceExecOptions = {}): Promise<DeviceExecResult> {
    const run = await this.open(device, command, options)
    const stdout = new Window(STDOUT_MAX_BYTES)
    const stderr = new Window(STDERR_MAX_BYTES)
    // Both windows are filled by the streams' own data events, so the reads are
    // already in flight when `done` settles and nothing has to be re-requested.
    // `open` has already taken care of stdin by the time it returns.
    run.stream.on('data', (chunk: Buffer) => { stdout.push(chunk) })
    run.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk) })
    const outcome = await this.bounded(run, options)
    return { ...outcome, stdout: stdout.text(), stderr: stderr.text(), truncated: stdout.truncated }
  }

  /** Run one command, leaving its output on the returned streams. */
  async open(device: DeviceConnection, command: string, options: DeviceExecOptions = {}): Promise<DeviceCommand> {
    const child = this.spawn(WSL_EXE, wslExecArgs(device.id, command), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // The caller's environment additions, the way the SSH transport passes
      // them to the channel. A provider's command runs with the host's
      // environment plus what the caller asked for, so a seam that sets one
      // variable for the device gets it.
      //
      // `wsl.exe` does NOT forward the Windows environment: it hands the distro
      // a fixed set (PATH, HOME, …) and drops everything else, so setting the
      // variable on this process alone would satisfy nothing. `WSLENV` is the
      // bridge WSL itself provides — a name listed there is copied into the
      // distro — and the caller's keys are appended to it, so the variable
      // arrives on the far side the way an SSH channel's `env` does.
      ...options.env === undefined ? {} : {
        env: {
          ...process.env,
          ...options.env,
          WSLENV: wslEnvBridge(process.env.WSLENV, Object.keys(options.env)),
        },
      },
    })
    const run = new ProcessCommand(child)
    // The stdin contract is the SSH transport's, in the same order: a payload
    // is written and then the write side is closed, a caller that asked to keep
    // it open gets it left open, and a command that asked for neither is closed
    // so the far side sees EOF rather than a pipe nobody writes to. Without
    // this the `open` door would drop a batch payload entirely — the one path
    // the exec door used to lose stdout on, in the other direction.
    // Fire-and-forget: a payload the child refuses is reported through the
    // command's own exit, and an unhandled rejection here would take the host
    // down instead.
    if (options.stdin !== undefined) void this.feed(run, options.stdin).catch(() => {})
    else if (options.openStdin !== true) run.stream.end()
    if (options.signal !== undefined) {
      const abort = (): void => { run.terminate() }
      if (options.signal.aborted) abort()
      else options.signal.addEventListener('abort', abort, { once: true })
      // A `done` that rejects is the child's own death, reported to the
      // caller that awaits it. This chain only removes a listener, and a
      // rejection nobody handles is fatal to the host.
      void run.done.then(() => { options.signal?.removeEventListener('abort', abort) }).catch(() => {})
    }
    if (options.graceMs !== undefined) {
      const timer = setTimeout(() => { run.terminate() }, options.graceMs)
      timer.unref()
      void run.done.then(() => { clearTimeout(timer) }).catch(() => {})
    }
    return run
  }

  /** Write one payload to a command's stdin, then close it. */
  private async feed(run: DeviceCommand, stdin: string | Uint8Array): Promise<void> {
    const data = typeof stdin === 'string' ? Buffer.from(stdin, 'utf8') : Buffer.from(stdin)
    for (let at = 0; at < data.length; at += STDIN_CHUNK_BYTES) {
      if (!run.stream.write(data.subarray(at, at + STDIN_CHUNK_BYTES))) {
        await new Promise<void>(resolve => { run.stream.once('drain', resolve) })
      }
    }
    run.stream.end()
  }

  /** Open a pty shell inside the distribution, running one remote line. */
  async shell(device: DeviceConnection, command: string, window: { rows: number; cols: number; term: string }): Promise<DeviceShell> {
    // Imported lazily: the exec and open doors are plain child processes, so
    // the native module is only owed where a pty is actually opened — and by
    // then the profile it runs in is one the terminal bridge shares.
    const nodePty = await import('node-pty')
    const pty = nodePty.spawn(WSL_EXE, wslExecArgs(device.id, command), {
      name: window.term,
      cols: window.cols,
      rows: window.rows,
      env: { ...process.env, TERM: window.term },
    })
    const done = new Promise<DeviceOutcome>((resolve) => {
      pty.onExit(({ exitCode }) => { resolve({ exitCode, signal: null }) })
    })
    return {
      stream: pty as unknown as Duplex,
      done,
      setWindow: (rows, cols) => {
        try { pty.resize(cols, rows) } catch { /* already closing */ }
      },
      close: () => { try { pty.kill() } catch { /* already gone */ } },
    }
  }

  /** End one device's processes; a WSL device pools nothing. */
  release(_deviceId: string): void { /* nothing pooled */ }

  /** End everything; a WSL device pools nothing. */
  releaseAll(): void { /* nothing pooled */ }

  /** Wait for a bounded run, terminating it when its bound is reached. */
  private async bounded(run: DeviceCommand, options: DeviceExecOptions): Promise<DeviceOutcome> {
    if (options.signal?.aborted === true) {
      run.terminate()
      return TERMINATED
    }
    let stopped = false
    const bounds: Promise<DeviceOutcome>[] = [run.done]
    if (options.graceMs !== undefined) {
      bounds.push(new Promise<DeviceOutcome>((resolve) => {
        const timer = setTimeout(() => {
          stopped = true
          run.terminate()
          resolve(TERMINATED)
        }, options.graceMs)
        timer.unref()
        void run.done.then(() => { clearTimeout(timer) }).catch(() => {})
      }))
    }
    if (options.signal !== undefined) {
      bounds.push(new Promise<DeviceOutcome>((resolve) => {
        options.signal?.addEventListener('abort', () => {
          stopped = true
          run.terminate()
          resolve(TERMINATED)
        }, { once: true })
      }))
    }
    const outcome = await Promise.race(bounds)
    return outcome.exitCode === null && outcome.signal === null && stopped ? TERMINATED : outcome
  }
}

let shared: WslTransport | undefined

/** The process-wide WSL transport. */
export function wslTransport(): WslTransport {
  shared ??= new WslTransport()
  return shared
}
