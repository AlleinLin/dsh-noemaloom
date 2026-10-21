/**
 * The device's process table.
 *
 * One entry per process this connection started: the child, its two bounded
 * output windows, and any spill files. Built on `node:child_process` rather
 * than on dsh's local subprocess provider on purpose — that provider's
 * dependency closure is exactly what makes upstream's helper impossible to
 * deploy as one file, and this table needs very little of it.
 *
 * Two decisions worth stating, because the seam lets a provider choose and both
 * choices are observable:
 *
 * - **Children are started detached and terminated as a group.** The seam's
 *   termination verb acts on "the managed range", and a bare `child.kill()`
 *   reaches only the process it names: `bash -c 'thing & wait'` would leave
 *   `thing` running on the device after the caller believed it stopped. A new
 *   process group plus a negative-pid kill is the equivalent of what the ssh
 *   client's disconnection used to achieve.
 * - **Collect mode is the only output mode.** Upstream forwards real sockets so
 *   a caller can stream bytes; that needs a stream channel this transport does
 *   not have yet, so a `'pipe'` or `'inherit'` request is refused loudly rather
 *   than approximated — a silently-emptied stream would look like a process
 *   that printed nothing.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** One stream's bounded in-memory window plus its whole-stream size. */
class OutputWindow {
  private bytes: Buffer = Buffer.alloc(0)

  constructor(private readonly maxBytes: number) {}

  /** Whole-stream bytes seen so far, retained or not. */
  totalBytes = 0

  /** Absolute offset of this window's first retained byte. */
  get windowStart(): number {
    return this.totalBytes - this.bytes.length
  }

  push(chunk: Buffer): void {
    this.totalBytes += chunk.length
    this.bytes = this.bytes.length === 0 ? chunk : Buffer.concat([this.bytes, chunk])
    if (this.bytes.length > this.maxBytes) this.bytes = this.bytes.subarray(this.bytes.length - this.maxBytes)
  }

  /**
   * Bytes from a whole-stream offset.
   * @param fromByte - requested offset.
   * @returns the available slice and the offset it actually starts at; a
   *   returned `from` above `fromByte` is how a reader learns it fell behind.
   */
  slice(fromByte: number): { chunk: Buffer; from: number } {
    const from = Math.max(fromByte, this.windowStart)
    return { chunk: this.bytes.subarray(from - this.windowStart), from }
  }

  /** The retained tail, for the final reply. */
  tail(): Buffer {
    return this.bytes
  }
}

/**
 * A whole-stream spill file.
 *
 * Discarded whole once it exceeds its cap, which is the seam's rule: a
 * truncated spill would silently claim to be the complete stream, and the
 * caller's only recovery path would then be a file that lies.
 */
class Spill {
  private readonly stream: WriteStream
  private written = 0
  private discarded = false
  private finished: Promise<void>

  constructor(private readonly path: string, private readonly maxBytes: number) {
    this.stream = createWriteStream(path, { mode: 0o600 })
    this.stream.on('error', () => { this.discarded = true })
    this.finished = new Promise<void>((resolve) => { this.stream.once('close', () => { resolve() }) })
  }

  write(chunk: Buffer): void {
    if (this.discarded) return
    this.written += chunk.length
    if (this.written > this.maxBytes) {
      this.discarded = true
      this.stream.destroy()
      return
    }
    this.stream.write(chunk)
  }

  /** @returns the path when a complete spill survives, otherwise undefined. */
  async close(): Promise<string | undefined> {
    if (!this.discarded) this.stream.end()
    await this.finished
    if (this.discarded) {
      await unlink(this.path).catch(() => undefined)
      return undefined
    }
    return this.path
  }
}

/** One stream's collection: the in-memory window, plus a spill when asked for. */
interface Collector {
  window: OutputWindow
  spill?: Spill
  /** Set once the spill closes, and only when a complete file survived. */
  spillPath?: string
}

/** One live process. */
interface Entry {
  child: ChildProcess
  stdout: Collector
  stderr: Collector
  /** Resolves once the child has closed and any spill files are final. */
  closed: Promise<void>
  outcome?: { exitCode: number | null; signal: string | null }
  /** A start failure, which is not an exit status and must not be reported as one. */
  spawnError?: Error
  termination?: NodeJS.Timeout | undefined
}

/** Terminal signals a managed range is ended with, in escalation order. */
const TERMINATION_SIGNAL = 'SIGTERM'
const ESCALATION_SIGNAL = 'SIGKILL'

/** What the helper needs to know about a collect request. */
export interface CollectRequest {
  maxBytes: number
  spill?: { maxBytes: number } | undefined
}

/** A fully-specified process start, as the wire contract spells it. */
export interface PrepareRequest {
  argv: readonly string[]
  cwd: string
  env?: Record<string, string | null> | undefined
  stdin: 'ignore' | { data: string }
  stdout: CollectRequest
  stderr: CollectRequest
  graceMs: number
}

/**
 * Processes this connection owns.
 *
 * Every entry is reaped when the table closes, including on lease expiry: a
 * helper that exited without its children would leave them running on the
 * device with nothing left that knows they exist.
 */
export class RemoteProcesses {
  private readonly entries = new Map<string, Entry>()

  /**
   * @param root - private directory for spill files on the device.
   * @param maxProcesses - live-process cap; a spawn past it is refused.
   */
  constructor(private readonly root: () => string, private readonly maxProcesses: number) {}

  /**
   * Start one process.
   * @param request - argv, directory, environment, stdio and grace.
   * @returns the process's identity, and its pid when the platform supplied one.
   * @throws when the table is full.
   */
  prepare(request: PrepareRequest): { id: string; pid?: number } {
    if (this.entries.size >= this.maxProcesses) {
      throw new Error(`the dshell SSH helper already owns ${String(this.maxProcesses)} processes`)
    }
    const id = randomUUID()
    const stdin = request.stdin
    const child = spawn(request.argv[0] as string, request.argv.slice(1), {
      cwd: request.cwd,
      env: mergeEnvironment(request.env),
      // A new group, so termination can reach whatever the command started.
      detached: true,
      stdio: [stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    const stdout = this.collector(id, 'stdout', request.stdout)
    const stderr = this.collector(id, 'stderr', request.stderr)
    const closed = Promise.withResolvers<void>()
    const entry: Entry = { child, stdout, stderr, closed: closed.promise }
    this.entries.set(id, entry)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.window.push(chunk)
      stdout.spill?.write(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.window.push(chunk)
      stderr.spill?.write(chunk)
    })
    if (stdin !== 'ignore' && child.stdin !== null) {
      child.stdin.end(stdin.data)
    }
    // A child that cannot be started reports here rather than through a null
    // exit code, and the difference matters to a caller: "the device has no such
    // program" is a setup fact, not an exit status.
    child.on('error', (error: Error) => { entry.spawnError = error })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      entry.outcome = { exitCode: code, signal }
      void this.finalize(entry).then(() => { closed.resolve() })
    })
    // No throw for a missing `pid`: the child object exists either way, the
    // platform's error arrives on its own event, and answering `done` with it
    // tells a caller what actually went wrong.
    return child.pid === undefined ? { id } : { id, pid: child.pid }
  }

  /**
   * Read one stream from an offset.
   * @param id - process identity.
   * @param stream - which output.
   * @param fromByte - whole-stream offset to resume from.
   * @returns the available bytes and the offset they start at.
   */
  snapshot(id: string, stream: 'stdout' | 'stderr', fromByte: number): { chunk: Buffer; from: number; totalBytes: number } {
    const entry = this.require(id)
    const collector = stream === 'stdout' ? entry.stdout : entry.stderr
    const { chunk, from } = collector.window.slice(fromByte)
    return { chunk, from, totalBytes: collector.window.totalBytes }
  }

  /**
   * The process's end state.
   * @param id - process identity.
   * @returns exit facts, final tails and surviving spill paths.
   * @throws when the child could not be started — there is no honest exit code.
   */
  async done(id: string): Promise<{
    outcome: { exitCode: number | null; signal: string | null }
    collected: { stdout: { tail: Buffer; totalBytes: number }; stderr: { tail: Buffer; totalBytes: number } }
    spills: { stdout?: string; stderr?: string }
  }> {
    const entry = this.require(id)
    await entry.closed
    const spills: { stdout?: string; stderr?: string } = {}
    try {
      if (entry.spawnError !== undefined) throw entry.spawnError
      const outcome = entry.outcome ?? { exitCode: null, signal: null }
      if (entry.stdout.spillPath !== undefined) spills.stdout = entry.stdout.spillPath
      if (entry.stderr.spillPath !== undefined) spills.stderr = entry.stderr.spillPath
      return {
        outcome,
        collected: {
          stdout: { tail: entry.stdout.window.tail(), totalBytes: entry.stdout.window.totalBytes },
          stderr: { tail: entry.stderr.window.tail(), totalBytes: entry.stderr.window.totalBytes },
        },
        spills,
      }
    } finally {
      // The entry is released here: its window is the last thing a caller
      // needs, and holding it would keep a finished command's output alive for
      // the life of the connection.
      //
      // Released on EVERY path out of this method, and the throwing one is
      // exactly the path that used to leak: a child that could not be started
      // was charged a slot it will never use, so one failed spawn per attempt
      // filled the table and the helper began refusing EVERY process on that
      // device. The table is per connection, and the terminal, the agent's tool
      // calls and the metric probe all draw from this one table — a leak here
      // takes down all three at once, and it only shows up as a refusal long
      // after the failure that caused it.
      this.entries.delete(id)
    }
  }

  /**
   * Terminate the process's group.
   * @param id - process identity.
   */
  terminate(id: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    this.signalGroup(entry, TERMINATION_SIGNAL)
    // A command that ignores the polite signal is escalated rather than waited
    // on forever; the caller asked for termination, not for a negotiation.
    entry.termination ??= setTimeout(() => { this.signalGroup(entry, ESCALATION_SIGNAL) }, 5_000)
    entry.termination.unref()
  }

  /**
   * Whether the process's managed range is empty.
   *
   * The observable range is the child: a group member that outlives it is not
   * distinguishable here, which is the limit this provider documents.
   *
   * @param id - process identity.
   * @returns the direct child's quiescence.
   */
  async wait(id: string): Promise<boolean> {
    const entry = this.entries.get(id)
    if (entry === undefined) return true
    await entry.closed
    return true
  }

  /** Terminate everything still running and release spill files. */
  async close(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.outcome === undefined) this.signalGroup(entry, TERMINATION_SIGNAL)
    }
    await Promise.allSettled([...this.entries.values()].map(async (entry) => { await entry.closed }))
    this.entries.clear()
  }

  /** Build one stream's collector, creating its spill when the seam asked. */
  private collector(id: string, stream: 'stdout' | 'stderr', request: CollectRequest): Collector {
    const collector: Collector = { window: new OutputWindow(request.maxBytes) }
    if (request.spill !== undefined) {
      collector.spill = new Spill(join(this.root(), `${id}.${stream}`), request.spill.maxBytes)
    }
    return collector
  }

  /** Finish a child: flush spills so their paths are decided before `done`. */
  private async finalize(entry: Entry): Promise<void> {
    if (entry.termination !== undefined) { clearTimeout(entry.termination); entry.termination = undefined }
    const [out, err] = await Promise.all([
      entry.stdout.spill?.close(),
      entry.stderr.spill?.close(),
    ])
    if (out !== undefined) entry.stdout.spillPath = out
    if (err !== undefined) entry.stderr.spillPath = err
  }

  /** Signal the child's process group, falling back to the child itself. */
  private signalGroup(entry: Entry, signal: NodeJS.Signals): void {
    const pid = entry.child.pid
    try {
      if (pid === undefined) entry.child.kill(signal)
      else process.kill(-pid, signal)
    } catch {
      // The group is already gone, which is the outcome termination wanted.
    }
  }

  /** Resolve an entry or explain that it is not this connection's. */
  private require(id: string): Entry {
    const entry = this.entries.get(id)
    if (entry === undefined) throw new Error(`the dshell SSH helper does not own process ${id}`)
    return entry
  }
}

/** Layer explicit entries onto the helper's own environment, `null` removing. */
function mergeEnvironment(env: Record<string, string | null> | undefined): NodeJS.ProcessEnv {
  if (env === undefined) return process.env
  const merged: NodeJS.ProcessEnv = { ...process.env }
  for (const [name, value] of Object.entries(env)) {
    if (value === null) Reflect.deleteProperty(merged, name)
    else merged[name] = value
  }
  return merged
}
