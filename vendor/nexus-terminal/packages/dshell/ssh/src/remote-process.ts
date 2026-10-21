/**
 * One device process, seen as a `SubprocessHandle`.
 *
 * This is what makes the migration cheap: the shell executor, the search tool
 * and anything else that spawns through `ctx.subprocess` keep their own
 * timeouts, output caps, spills, streaming and background handles, because
 * those live *above* this seam. All that changes is where the process runs.
 *
 * The seam's output contract is offset-based and synchronous — `readFrom` takes
 * a byte offset and returns immediately — so this class keeps its own bounded
 * window of what the device has reported and answers from it. Two consequences
 * are worth stating rather than discovering:
 *
 * - **Live output is polled, not pushed.** Upstream forwards real sockets so a
 *   caller can stream; that channel does not exist here yet, so a reader that
 *   actually reads before the process ends starts a poller, and the granularity
 *   of "live" is that interval. A reader that only reads after the end (the
 *   foreground shape, and the search shape) never polls at all.
 * - **`spillPath` is a path on the DEVICE.** That is correct rather than
 *   confusing in a device session — every file operation there is remote too,
 *   so the path is readable by the same tools that produced it — but it is not
 *   a path the harness itself can open, and a message that shows it should say
 *   which machine it names.
 */
import type { Duplex, Readable, Writable } from 'node:stream'
import type { SubprocessCollectedOutputs, SubprocessHandle, SubprocessOutcome, SubprocessOutputRead, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { DshellSshConnection } from './connection.js'
import {
  HELPER_OPS,
  nullReply,
  processDoneReply,
  processPrepareReply,
  processSnapshotReply,
  processWaitReply,
} from './helper/protocol.js'

/** How often a reader that is actively reading asks the device for new output. */
const LIVE_POLL_MS = 400

/**
 * Whether this provider can serve the caller's stdio dispositions.
 *
 * Collect-only by design: `'pipe'` and `'inherit'` need a stream channel the
 * transport does not have, and `control` needs a separately authenticated one.
 * A `false` here is not a failure — the seam answers such a spec with the
 * assembled-command path instead, which serves them through the local ssh
 * client's own pipes. Approximating a `'pipe'` as an empty stream would have
 * looked exactly like a process that printed nothing.
 *
 * @param spec - the caller's spawn spec.
 * @returns whether the remote handle can serve it.
 */
export function supportsStdio(spec: SubprocessSpawnSpec): boolean {
  if (typeof spec.stdio.stdout !== 'object' || typeof spec.stdio.stderr !== 'object') return false
  return spec.stdio.stdin !== 'pipe' && spec.stdio.control === undefined
}

/** A bounded window of one stream, fed by polls and finalized by the end state. */
class RemoteStream {
  private bytes: Buffer = Buffer.alloc(0)
  private total = 0
  private spill: string | undefined
  /** Set by the first read: only a reader that reads needs the live poll. */
  polled = false

  constructor(private readonly maxBytes: number) {}

  /** Whole-stream bytes the device has reported. */
  get totalBytes(): number {
    return this.total
  }

  /** Absolute offset of this window's first retained byte. */
  private get windowStart(): number {
    return this.total - this.bytes.length
  }

  /**
   * Absorb a poll result.
   * @param chunk - bytes the device sent.
   * @param from - whole-stream offset of the first byte in `chunk`.
   * @param totalBytes - the device's whole-stream size at that moment.
   */
  push(chunk: Buffer, from: number, totalBytes: number): void {
    if (from > this.total) {
      // The device trimmed past what we held, so the bytes between are gone
      // from its window too; keeping the old ones would splice two disjoint
      // stretches into one stream.
      this.bytes = Buffer.alloc(0)
      this.total = from
    }
    if (chunk.length > 0) {
      this.bytes = this.bytes.length === 0 ? chunk : Buffer.concat([this.bytes, chunk])
      this.total = from + chunk.length
      if (this.bytes.length > this.maxBytes) this.bytes = this.bytes.subarray(this.bytes.length - this.maxBytes)
    }
    this.total = Math.max(this.total, totalBytes)
  }

  /**
   * Adopt the authoritative end state.
   * @param tail - the device's retained tail at exit, base64.
   * @param totalBytes - the whole-stream size.
   * @param spillPath - the device's spill file, when one survived.
   */
  finalize(tail: string, totalBytes: number, spillPath: string | undefined): void {
    const bytes = Buffer.from(tail, 'base64')
    // Only trust the tail when the device saw everything: a poll may have
    // already delivered bytes the tail no longer covers.
    if (totalBytes >= this.total) {
      this.bytes = bytes.length > this.maxBytes ? bytes.subarray(bytes.length - this.maxBytes) : bytes
      this.total = totalBytes
    }
    this.spill = spillPath
  }

  /**
   * Read from an offset.
   * @param fromByte - whole-stream offset to resume from.
   * @returns the delta, its next offset, and whether the request fell behind.
   */
  read(fromByte: number): SubprocessOutputRead {
    this.polled = true
    const lossy = fromByte < this.windowStart
    const text = (lossy ? this.bytes : this.bytes.subarray(fromByte - this.windowStart)).toString('utf8')
    return {
      text,
      nextOffset: this.total,
      lossy,
      ...this.spill === undefined ? {} : { spillPath: this.spill },
    }
  }
}

/**
 * Narrow the seam's stdin disposition to what this provider sends.
 *
 * `supportsStdio` already refused the piped shape; this makes the invariant
 * explicit instead of relying on a comparison the type system reads as an
 * overlap.
 *
 * @param mode - the caller's stdin disposition.
 * @returns the wire form.
 */
function stdinFor(mode: SubprocessSpawnSpec['stdio']['stdin']): 'ignore' | { data: string } {
  if (mode === 'ignore') return 'ignore'
  if (typeof mode === 'object') return { data: mode.data }
  throw new Error('a device session cannot serve a piped stdin')
}

/** Options the routing seam supplies alongside the caller's spec. */
export interface RemoteProcessOptions {
  /** The program as the DEVICE should resolve it; may differ from `spec.argv[0]`. */
  program: string
  /** Overrides the start-failure message; used to keep a tool's own diagnostic. */
  describeStartFailure?: (program: string, error: Error) => Error
}

/**
 * A process running on the device.
 *
 * Nothing is written to the device at construction beyond the start request, and
 * no caller can observe the handle until `spawn` returns it — so a start that
 * fails must surface on `done`, which the seam explicitly allows ("may reject
 * for spawn or provider failures").
 */
export class RemoteProcess implements SubprocessHandle {
  readonly stdin: Writable | undefined = undefined
  readonly stdout: Readable | undefined = undefined
  readonly stderr: Readable | undefined = undefined
  readonly control: Duplex | undefined = undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>

  private readonly streams: { stdout: RemoteStream; stderr: RemoteStream }
  private id: string | undefined
  private poll: NodeJS.Timeout | undefined
  private pollPending = false
  private settled = false
  /** Set when termination was asked for before the device had named the process. */
  private terminateRequested = false
  private readonly prepared = Promise.withResolvers<string | undefined>()

  /**
   * @param connection - the verified connection to the owning device.
   * @param spec - the caller's fully-specified spawn.
   * @param options - the device-side program name and failure text.
   */
  constructor(private readonly connection: DshellSshConnection, spec: SubprocessSpawnSpec, options: RemoteProcessOptions) {
    const stdoutMode = spec.stdio.stdout as { maxBytes: number }
    const stderrMode = spec.stdio.stderr as { maxBytes: number }
    this.streams = { stdout: new RemoteStream(stdoutMode.maxBytes), stderr: new RemoteStream(stderrMode.maxBytes) }
    this.collected = {
      stdout: this.reader('stdout'),
      stderr: this.reader('stderr'),
    }
    const abort = (): void => { this.terminate() }
    spec.signal?.addEventListener('abort', abort, { once: true })
    this.done = this.start(spec, options).finally(() => {
      this.settled = true
      this.stopPolling()
      this.prepared.resolve(this.id)
      spec.signal?.removeEventListener('abort', abort)
    })
    void this.done.catch(() => {})
  }

  /**
   * End the process's managed range.
   *
   * Fire-and-forget by contract (the seam's verb returns nothing): termination
   * is a request to the device, and its success is observable through `done`.
   */
  terminate(): void {
    this.terminateRequested = true
    if (this.settled) return
    if (this.id === undefined) {
      // The start request is still in flight. Acting on the request rather than
      // on the id means an abort that arrives in that window still ends the
      // process, instead of leaving one running that nobody can name any more.
      void this.prepared.promise.then((id) => {
        if (id === undefined || this.settled) return
        void this.connection.request(HELPER_OPS.processTerminate, { id }, nullReply).catch(() => undefined)
      })
      return
    }
    void this.connection.request(HELPER_OPS.processTerminate, { id: this.id }, nullReply).catch(() => undefined)
  }

  /**
   * Wait for the range to be empty.
   * @param signal - optional bound on the wait.
   * @returns true when empty, false when the signal aborted first.
   */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    // Waiting on the start request first: "the range is empty" is not a claim we
    // can make before knowing whether anything was started.
    const id = await this.prepared.promise
    if (id === undefined) return true
    if (signal?.aborted === true) return false
    this.id = id
    const wait = this.connection.request(HELPER_OPS.processWait, { id }, processWaitReply).catch(() => true)
    if (signal === undefined) return await wait
    return await Promise.race([
      wait,
      new Promise<boolean>((resolve) => { signal.addEventListener('abort', () => { resolve(false) }, { once: true }) }),
    ])
  }

  /** One stream's reader over this class's window. */
  private reader(stream: 'stdout' | 'stderr'): SubprocessOutputReader {
    return {
      readFrom: (fromByte: number): SubprocessOutputRead => {
        this.ensurePolling()
        return this.streams[stream].read(fromByte)
      },
    }
  }

  /** Start the process, then adopt its end state. */
  private async start(spec: SubprocessSpawnSpec, options: RemoteProcessOptions): Promise<SubprocessOutcome> {
    const stdout = spec.stdio.stdout as { maxBytes: number; spill?: { maxBytes: number } }
    const stderr = spec.stdio.stderr as { maxBytes: number; spill?: { maxBytes: number } }
    let prepared: { id: string; pid?: number | undefined }
    try {
      prepared = await this.connection.request(HELPER_OPS.processPrepare, {
        argv: [options.program, ...spec.argv.slice(1)],
        cwd: spec.cwd,
        ...spec.env === undefined ? {} : { env: Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, value ?? null])) },
        stdin: stdinFor(spec.stdio.stdin),
        stdout: { maxBytes: stdout.maxBytes, ...stdout.spill === undefined ? {} : { spill: stdout.spill } },
        stderr: { maxBytes: stderr.maxBytes, ...stderr.spill === undefined ? {} : { spill: stderr.spill } },
        graceMs: spec.graceMs,
      }, processPrepareReply)
    } catch (error) {
      throw this.explain(options, error)
    }
    this.id = prepared.id
    if (this.terminateRequested) this.terminate()
    // A start that failed in the platform's own time rejects here, and that is
    // where the useful reason lives — so the translation applies to both ends.
    const finished = await this.connection.request(HELPER_OPS.processDone, { id: prepared.id }, processDoneReply)
      .catch((error: unknown) => { throw this.explain(options, error) })
    this.streams.stdout.finalize(finished.collected.stdout.tail, finished.collected.stdout.totalBytes, finished.spills.stdout)
    this.streams.stderr.finalize(finished.collected.stderr.tail, finished.collected.stderr.totalBytes, finished.spills.stderr)
    return { exitCode: finished.outcome.exitCode, signal: finished.outcome.signal as NodeJS.Signals | null }
  }

  /** Let the caller's own diagnostic replace a generic platform failure. */
  private explain(options: RemoteProcessOptions, error: unknown): Error {
    const failure = error instanceof Error ? error : new Error(String(error))
    return options.describeStartFailure?.(options.program, failure) ?? failure
  }

  /**
   * Begin polling, once, and only because a reader asked.
   *
   * Lazily rather than at spawn: the foreground and search shapes read only
   * after `done`, and polling for them would be one round trip per interval
   * spent on output nobody looks at until it is already complete.
   */
  private ensurePolling(): void {
    if (this.poll !== undefined || this.settled || this.id === undefined) return
    if (!this.streams.stdout.polled && !this.streams.stderr.polled) return
    this.poll = setInterval(() => { void this.refresh() }, LIVE_POLL_MS)
    this.poll.unref()
  }

  /** One poll over the streams a reader has touched. */
  private async refresh(): Promise<void> {
    // One in flight at a time: a slow device must not accumulate a queue of
    // overlapping reads whose results arrive out of order.
    if (this.pollPending || this.settled || this.id === undefined) return
    this.pollPending = true
    try {
      for (const stream of ['stdout', 'stderr'] as const) {
        if (!this.streams[stream].polled) continue
        const reply = await this.connection.request(HELPER_OPS.processSnapshot, {
          id: this.id,
          stream,
          fromByte: this.streams[stream].totalBytes,
        }, processSnapshotReply)
        this.streams[stream].push(Buffer.from(reply.chunk, 'base64'), reply.from, reply.totalBytes)
      }
    } catch {
      // The process ended or the connection went away between polls; `done`
      // owns reporting either, so a failed poll is not itself news.
    } finally {
      this.pollPending = false
    }
  }

  private stopPolling(): void {
    if (this.poll === undefined) return
    clearInterval(this.poll)
    this.poll = undefined
  }
}
