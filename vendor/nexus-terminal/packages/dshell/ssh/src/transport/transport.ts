/**
 * The device transport: one SSH connection per device, everything on top of it.
 *
 * This is the seam the whole package now hangs off. Where it used to spawn the
 * system `ssh` client once per command, it holds a pooled `ssh2` connection per
 * device and opens a channel per operation, so a connection is paid for once and
 * then amortised across every command, file read and helper request that follows.
 * What does NOT change is anything a caller can observe: the remote command
 * strings are the same lines, the trust decision is the same one (this plugin's
 * own known_hosts, trust on first use), and the failure vocabulary is the same
 * four kinds.
 *
 * Three shapes are served, because three consumers need them:
 *
 *  - {@link DeviceTransport.exec} — one command, collected output. The file
 *    layer's operations, the probe, the deploy, the connection test.
 *  - {@link DeviceTransport.open} — a long-lived channel. The helper's RPC
 *    transport and the legacy spawn lane both speak over one.
 *  - {@link DeviceTransport.shell} — a pty channel, which is what the user's
 *    visible terminal is.
 *
 * The host key is verified inside `ssh2`'s own `hostVerifier`, against the file
 * this plugin owns: an unknown key is recorded (trust on first use, the same
 * policy `ssh -o StrictHostKeyChecking=accept-new` had), a known one is compared
 * by bytes, and a mismatch refuses the connection before any credential is sent.
 */
import type { Duplex, Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import type { ClientChannel, ConnectConfig, ExecOptions } from 'ssh2'
import { Client } from 'ssh2'
import type { DeviceConnection } from '../devices.js'
import { sshKnownHostsPath } from '../paths.js'
import { connectConfig } from './auth.js'
import { classifyDeviceError, hostKeyMismatch } from './errors.js'
import {
  entriesFor,
  fingerprintOf,
  hostKeyDecision,
  keyTypeOfBlob,
  readKnownHosts,
  recordHostKey,
} from './known-hosts.js'

/** How one remote command ended. */
export interface DeviceOutcome {
  /** The remote exit status, or null when it ended on a signal. */
  readonly exitCode: number | null
  /** The signal that ended it, when it did. */
  readonly signal: string | null
  /**
   * The channel was closed without an exit status: the far side tore it down.
   *
   * Not a signal and not a cancellation — the command's fate is unknown, and
   * the only honest reading is that the connection is gone. A caller that can
   * repeat its command (see {@link DeviceTransport.exec}) says so; a caller
   * that cannot reports it as the loss it is.
   */
  readonly connectionLost?: boolean
}

/** One running remote command, before its output has been read. */
export interface DeviceCommand {
  /** The command's stdin and stdout, as one duplex channel. */
  readonly stream: Duplex
  /** The command's stderr, a stream of its own. */
  readonly stderr: Readable
  /** Settles with the remote outcome; never rejects. */
  readonly done: Promise<DeviceOutcome>
  /** Ask the device to stop. Fire-and-forget; `done` reports the result. */
  terminate(signal?: string): void
}

/** What one collected command produced. */
export interface DeviceExecResult extends DeviceOutcome {
  readonly stdout: string
  readonly stderr: string
  /** Whether the stdout cap dropped bytes from the front. */
  readonly truncated: boolean
}

/** Options one command runs with. */
export interface DeviceExecOptions {
  /** Cancellation; the remote side is asked to stop. */
  readonly signal?: AbortSignal | undefined
  /** Bound on the run, after which the command is terminated. */
  readonly graceMs?: number | undefined
  /** Environment additions for the remote process. */
  readonly env?: Record<string, string | undefined> | undefined
  /** Bytes to write to the command's stdin before it is closed. */
  readonly stdin?: string | Uint8Array | undefined
  /**
   * Leave the command's stdin open for the caller to write to.
   *
   * The default closes it, which is what `ssh -T` gave a command that asked for
   * no input: the remote side sees EOF rather than a pipe nobody writes to, and a
   * program that reads stdin therefore ends instead of waiting for the grace
   * period. A caller that wants to write later says so here.
   */
  readonly openStdin?: boolean | undefined
}

/** A pty-backed remote shell, which is what a visible terminal is. */
export interface DeviceShell {
  /** The shell's stdin and stdout, as one duplex channel. */
  readonly stream: Duplex
  /** Settles with the shell's exit status; never rejects. */
  readonly done: Promise<DeviceOutcome>
  /** Resize the remote terminal. */
  setWindow(rows: number, cols: number): void
  /** End the shell. */
  close(): void
}

/** What a host key probe found. */
export interface ProbedHostKey {
  readonly keyType: string
  readonly fingerprint: string
}

/** stdout/stderr caps, matching what the assembled path's specs asked for. */
const STDOUT_MAX_BYTES = 8 * 1024 * 1024
const STDERR_MAX_BYTES = 64 * 1024
/** stdin is fed in slices of this size, so a bundle does not sit in one buffer. */
const STDIN_CHUNK_BYTES = 64 * 1024
/** What a run this transport stopped reports, whatever the channel said. */
const TERMINATED: DeviceOutcome = { exitCode: null, signal: 'SIGTERM' }

/**
 * A tail-keeping window over one stream.
 *
 * Compacted only once the retained bytes reach twice the cap: trimming on every
 * chunk would copy the whole window once per chunk, which is the difference
 * between a large `cat` costing one pass and costing one per 64 KiB.
 */
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

/** One open channel, as a {@link DeviceCommand}. */
class ChannelCommand implements DeviceCommand {
  readonly done: Promise<DeviceOutcome>
  /** The signal this channel was stopped with, when WE stopped it. */
  private stoppedWith: string | undefined

  constructor(private readonly channel: ClientChannel) {
    // A channel whose stream errors after the far side is gone has already been
    // reported by `done`; an unhandled 'error' event would take the host down.
    channel.on('error', () => undefined)
    channel.stderr.on('error', () => undefined)
    this.done = new Promise<DeviceOutcome>((resolve) => {
      let settled = false
      const settle = (outcome: DeviceOutcome): void => {
        if (settled) return
        settled = true
        resolve(outcome)
      }
      // A signal exit arrives as `(null, name, …)` and a normal one as `(code)`.
      channel.on('exit', (code: number | null, signal?: string) => {
        settle(typeof signal === 'string' && signal !== ''
          ? { exitCode: null, signal }
          : { exitCode: typeof code === 'number' ? code : null, signal: null })
      })
      // A channel that closes without an exit status leaves the outcome unknown:
      // the far side is gone, and guessing zero would report a success we never saw.
      // The `connectionLost` flag says which unknown this is, because "the far side
      // dropped the channel" and "we stopped it" call for different answers — and
      // reporting the first as the second is how a lost connection came to be
      // described as a signal that never arrived.
      channel.on('close', () => {
        settle(this.stoppedWith === undefined
          ? { exitCode: null, signal: null, connectionLost: true }
          : { exitCode: null, signal: this.stoppedWith })
      })
    })
  }

  get stream(): Duplex {
    return this.channel
  }

  get stderr(): Readable {
    return this.channel.stderr
  }

  terminate(signal = 'SIGTERM'): void {
    this.stoppedWith = signal
    try { this.channel.signal(signal) } catch { /* the channel is already gone */ }
    // Closing is what the far side reads as the session going away: sshd hangs
    // up the command's process group, which is how the old `kill ssh` worked.
    this.channel.close()
  }
}

/** The half of `ssh2.Client` this module uses, so a test can supply its own. */
export interface SshClient {
  connect(config: ConnectConfig): unknown
  on(event: string, listener: (...args: never[]) => void): unknown
  exec(command: string, options: ExecOptions, callback: (error: Error | undefined, channel: ClientChannel) => void): unknown
  end(): void
}

/** A client factory, injectable so the pool can be tested without a server. */
export type SshClientFactory = () => SshClient

/** The real one: `ssh2`'s own client, unconnected. */
function ssh2Client(): SshClient {
  return new Client() as unknown as SshClient
}

/** One pooled client, and the credential fingerprint it was opened with. */
interface Pooled {
  readonly client: SshClient
  readonly fingerprint: string
}

/**
 * Connections by device, so one device keeps one connection for the host's life.
 *
 * Keyed by device AND by a fingerprint of the credentials it was opened with:
 * a rotated key must not keep serving from a connection authenticated with the
 * old one, which would look exactly like a device that still accepts it.
 */
export class DeviceTransport {
  private readonly pool = new Map<string, Pooled>()
  /**
   * The dial in flight per device, so concurrent callers share ONE connection.
   *
   * Without it the pool had a race: two callers arriving together both found
   * it empty, both dialled, and the pool kept only the last client — so the
   * first caller's connection was orphaned, and the pool held one that nobody
   * was using.
   */
  private readonly dialing = new Map<string, Promise<Pooled>>()

  /** @param factory - how a client is made; the default is `ssh2`'s own. */
  constructor(private readonly factory: SshClientFactory = ssh2Client) {}

  /** Run one command and collect its output, bounded. */
  async exec(device: DeviceConnection, command: string, options: DeviceExecOptions = {}): Promise<DeviceExecResult> {
    const attempt = async (): Promise<{ outcome: DeviceOutcome; stdout: string; stderr: string; truncated: boolean }> => {
      const run = await this.open(device, command, options)
      const stdout = new Window(STDOUT_MAX_BYTES)
      const stderr = new Window(STDERR_MAX_BYTES)
      // Both windows are filled by the streams' own data events, so the reads are
      // already in flight when `done` settles and nothing has to be re-requested.
      run.stream.on('data', (chunk: Buffer) => { stdout.push(chunk) })
      run.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk) })
      const outcome = await this.bounded(run, options)
      return { outcome, stdout: stdout.text(), stderr: stderr.text(), truncated: stdout.truncated }
    }
    const first = await attempt()
    // A channel torn down without an exit status means the far side dropped
    // that channel, not that the command failed. Every command this package
    // runs through `exec` is idempotent — a read, a probe, a `mkdir -p`, a
    // staged rename — so one repeat is safe.
    //
    // The repeat opens a NEW CHANNEL on the SAME connection. It does not end
    // the connection, because the connection is probably fine: a channel can be
    // torn down on its own, and ending the connection to retry one command
    // would kill every other operation running on it. A connection that is
    // genuinely dead fails the next `exec` instead, and the dial path below
    // replaces it.
    if (first.outcome.connectionLost === true) {
      const second = await attempt()
      return { ...second.outcome, stdout: second.stdout, stderr: second.stderr, truncated: second.truncated }
    }
    return { ...first.outcome, stdout: first.stdout, stderr: first.stderr, truncated: first.truncated }
  }

  /** Run one command, leaving its output on the returned streams. */
  async open(device: DeviceConnection, command: string, options: DeviceExecOptions = {}): Promise<DeviceCommand> {
    const channel = await this.channel(device, command, options)
    const run = new ChannelCommand(channel)
    if (options.stdin !== undefined) void this.feed(run, options.stdin)
    else if (options.openStdin !== true) run.stream.end()
    if (options.signal !== undefined) {
      const abort = (): void => { run.terminate() }
      if (options.signal.aborted) abort()
      else options.signal.addEventListener('abort', abort, { once: true })
      void run.done.then(() => { options.signal?.removeEventListener('abort', abort) })
    }
    // The bound belongs HERE, where every path passes through: `exec` collects
    // its output and `open` hands back a live stream, and a bound that only the
    // collecting path honoured left a device read, a device stream and a device
    // subprocess able to hang for as long as the SSH keepalive tolerated —
    // three times the bound the caller asked for, and no bound at all on a
    // command that never answered.
    if (options.graceMs !== undefined) {
      const timer = setTimeout(() => { run.terminate() }, options.graceMs)
      timer.unref()
      void run.done.then(() => { clearTimeout(timer) })
    }
    return run
  }

  /** Open a pty shell on the device, running one remote line. */
  async shell(device: DeviceConnection, command: string, window: { rows: number; cols: number; term: string }): Promise<DeviceShell> {
    const channel = await this.channel(device, command, { pty: window })
    const run = new ChannelCommand(channel)
    return {
      stream: channel,
      done: run.done,
      setWindow: (rows: number, cols: number) => {
        try { channel.setWindow(rows, cols, 0, 0) } catch { /* already closing */ }
      },
      close: () => { run.terminate() },
    }
  }

  /**
   * What one device's host key is right now, over a connection that is not trusted.
   *
   * The key is taken from `hostVerifier` and the connection is then refused, so
   * nothing is ever authenticated: the answer is exactly what an interposed host
   * would want a reader to believe, and it is offered for COMPARISON against a
   * fingerprint obtained some other way.
   *
   * @param device - device to ask.
   * @returns the key the device offered, or undefined when it answered nothing.
   */
  async probeHostKey(device: DeviceConnection): Promise<ProbedHostKey | undefined> {
    const offered = Promise.withResolvers<ProbedHostKey | undefined>()
    const client = this.factory()
    client.on('error', () => { offered.resolve(undefined) })
    client.on('ready', () => { client.end() })
    const timer = setTimeout(() => { offered.resolve(undefined); client.end() }, 8_000)
    timer.unref()
    try {
      client.connect({
        host: device.host,
        port: device.port,
        username: device.user,
        readyTimeout: 8_000,
        hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
          const keyType = keyTypeOfBlob(key)
          offered.resolve(keyType === undefined
            ? undefined
            : { keyType, fingerprint: fingerprintOf(key.toString('base64')) })
          verify(false)
        },
      })
    } catch {
      offered.resolve(undefined)
    }
    try {
      return await offered.promise
    } finally {
      clearTimeout(timer)
    }
  }

  /** End one device's connection. */
  release(deviceId: string): void {
    const pooled = this.pool.get(deviceId)
    if (pooled === undefined) return
    this.pool.delete(deviceId)
    try { pooled.client.end() } catch { /* already gone */ }
  }

  /** End every connection; used when the host unloads. */
  releaseAll(): void {
    for (const deviceId of [...this.pool.keys()]) this.release(deviceId)
  }

  /** Wait for a bounded run, terminating it when its bound is reached. */
  private async bounded(run: DeviceCommand, options: DeviceExecOptions): Promise<DeviceOutcome> {
    if (options.signal?.aborted === true) {
      run.terminate()
      return TERMINATED
    }
    /** Whether this run was stopped by a bound rather than by the device. */
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
        void run.done.then(() => { clearTimeout(timer) })
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
    // Ending a channel settles `done` with an outcome nobody observed, and a run
    // we stopped ourselves is not an unknown one: what we did to it is the fact
    // worth reporting. The abort handler in `open` fires first and closes the
    // channel before this race is asked, so the flag is read after the await.
    return outcome.exitCode === null && outcome.signal === null && stopped ? TERMINATED : outcome
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

  /** Open one channel, dialing (or re-using) the device's connection. */
  private async channel(device: DeviceConnection, command: string, options: DeviceExecOptions & { pty?: { rows: number; cols: number; term: string } }): Promise<ClientChannel> {
    const exec: ExecOptions = {
      ...options.env === undefined ? {} : { env: options.env },
      ...options.pty === undefined ? {} : { pty: { term: options.pty.term, rows: options.pty.rows, cols: options.pty.cols } },
    }
    const dial = async (): Promise<ClientChannel> => {
      const client = await this.pooled(device)
      return await new Promise<ClientChannel>((resolve, reject) => {
        let settled = false
        client.exec(command, exec, (error: Error | undefined, channel: ClientChannel) => {
          if (error !== undefined && error !== null) {
            if (!settled) { settled = true; reject(error) }
            return
          }
          if (settled) { channel.close(); return }
          settled = true
          resolve(channel)
        })
      })
    }
    try {
      return await dial()
    } catch (error) {
      // A pooled connection that turned out to be dead fails its first channel;
      // one fresh dial is the honest retry, and anything past it is a real fault.
      if (classifyDeviceError(error) !== 'transport') throw error
      this.release(device.id)
      return await dial()
    }
  }

  /** The device's connection, opened when it is not pooled or has gone stale. */
  private async pooled(device: DeviceConnection): Promise<SshClient> {
    const config = await connectConfig(device)
    const fingerprint = connectionFingerprint(config)
    const existing = this.pool.get(device.id)
    if (existing !== undefined && existing.fingerprint === fingerprint) return existing.client
    if (existing !== undefined) this.release(device.id)
    // ONE dial per device, shared by whoever asks at the same time.
    //
    // The prompt assembly reads several files at once, and every one of those
    // reads is a device operation. Without this, each of them found the pool
    // empty, dialled its own connection, and left every connection but the last
    // one orphaned — six connections for one turn, none of them pooled, and a
    // pool that then held a connection none of the readers was using. The
    // check and the claim happen together, with nothing awaited in between, so
    // two callers cannot both decide to dial.
    let pending = this.dialing.get(device.id)
    if (pending === undefined) {
      pending = this.dial(device, config).then(client => {
        this.dialing.delete(device.id)
        const pooled: Pooled = { client, fingerprint }
        this.pool.set(device.id, pooled)
        return pooled
      }, (error: unknown) => {
        this.dialing.delete(device.id)
        throw error
      })
      this.dialing.set(device.id, pending)
    }
    const pooled = await pending
    // The credentials were rotated while this dial was in flight: the client
    // it opened was authenticated with the old ones, so it is not the one this
    // caller may use.
    if (pooled.fingerprint !== fingerprint) return await this.dial(device, config)
    return pooled.client
  }

  /**
   * Connect and verify the handshake.
   *
   * The host key decision is made here rather than after: `ssh2` calls
   * `hostVerifier` with the key the device offered, and refusing there means no
   * credential has been sent yet when a mismatch is discovered.
   */
  private async dial(device: DeviceConnection, config: ConnectConfig): Promise<SshClient> {
    const entries = readKnownHosts(sshKnownHostsPath())
    let hostKeyError: Error | undefined
    const client = this.factory()
    const ready = Promise.withResolvers<SshClient>()
    client.on('ready', () => { ready.resolve(client) })
    client.on('error', (error: unknown) => {
      const failure = hostKeyError ?? (error instanceof Error ? error : new Error(String(error)))
      // A client that failed is not pooled: the next call dials again rather than
      // inheriting a dead socket.
      if (this.pool.get(device.id)?.client === client) this.pool.delete(device.id)
      ready.reject(failure)
    })
    try {
      client.connect({
        ...config,
        hostVerifier: (key: Buffer, verify: (success: boolean) => void) => {
          const decision = hostKeyDecision(entries, device.host, device.port, key)
          if (decision === 'trusted') { verify(true); return }
          if (decision === 'first') {
            recordHostKey(sshKnownHostsPath(), device.host, device.port, key)
            verify(true)
            return
          }
          const offered = fingerprintOf(key.toString('base64'))
          const recorded = entriesFor(entries, device.host, device.port).map(entry => fingerprintOf(entry.blob))
          hostKeyError = hostKeyMismatch(device.host, device.port, recorded[0], offered)
          verify(false)
        },
      })
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error))
    }
    return await ready.promise
  }
}

/**
 * A fingerprint of the credentials a connection was opened with.
 *
 * Of the secret itself rather than of the path to it: a rotated credential keeps
 * its path, and a connection that outlived the rotation would keep answering as
 * the identity the device no longer accepts.
 */
function connectionFingerprint(config: ConnectConfig): string {
  const material = [config.password ?? '', config.privateKey ?? '', config.passphrase ?? ''].join('\n')
  return createHash('sha256').update(material).digest('hex').slice(0, 32)
}

let shared: DeviceTransport | undefined

/**
 * The process-wide transport.
 *
 * One pool per host, because a second one means a second connection per device:
 * the helper's RPC, the file layer's commands and the user's terminal would each
 * open their own, and a device that limits concurrent sessions would start
 * refusing them.
 */
export function deviceTransport(): DeviceTransport {
  shared ??= new DeviceTransport()
  return shared
}

/** Bind the process-wide transport; tests replace it with one of their own. */
export function useDeviceTransport(transport: DeviceTransport | undefined): void {
  shared = transport
}
