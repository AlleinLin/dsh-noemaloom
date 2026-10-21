/**
 * One device, one channel, one helper, one RPC peer.
 *
 * This replaces "spawn `ssh` per command and assemble the command as shell
 * text": a channel is opened once on the device's pooled connection, serves a
 * helper process on the device for as long as the connection lives, and every
 * operation after that is a request with JSON arguments. The channel is the
 * transport's own — the same trust decision, the same credentials, the same
 * keepalives every other command on this device travels with.
 *
 * There is deliberately no `child_process` here any more. The seam that routes a
 * bound session's subprocesses to this connection is `ctx.subprocess.spawn`
 * itself, so a local child would have had to be created outside the harness's
 * own process primitives; a channel is not a local process at all, which is why
 * it cannot recurse.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SshRpcPeer } from '@deepseek-ai/dsh-ssh/protocol'
import type { z } from 'zod'
import type { DeviceConnection } from './devices.js'
import { quote } from './shell-quote.js'
import { deviceTransport, type DeviceCommand } from './transport/transport.js'
import {
  DSHELL_HELPER_LEASE_MS,
  DSHELL_HELPER_MAX_FRAME_BYTES,
  DSHELL_HELPER_MAX_PENDING,
  DSHELL_HELPER_PROTOCOL,
  HELPER_OPS,
  helloReply,
  nullReply,
} from './helper/protocol.js'

/** How much of the channel's stderr to keep for a failure message. */
const STDERR_KEEP_BYTES = 4 * 1024

/** The helper artifact this build ships, and the identity a device must match. */
export interface HelperArtifact {
  /** Absolute path of the built bundle on the machine running dshell. */
  readonly path: string
  /** Lowercase SHA-256 of its bytes. */
  readonly hash: string
}

let artifact: HelperArtifact | undefined

/**
 * The helper bundle this build ships.
 *
 * Resolved from the package root rather than from a sibling URL so it answers
 * the same path whether the host is running compiled (`lib/connection.js`) or
 * from source under tsx (`src/connection.ts`) — the two differ by one directory
 * level, and a sibling-relative URL would silently point at a file that does
 * not exist in one of them.
 *
 * @returns the artifact path and digest.
 * @throws when the bundle is absent, which means the host is unbundled and the
 *   build step has not run; the message says so rather than failing later with
 *   a bare ENOENT from the device.
 */
export function localHelperArtifact(): HelperArtifact {
  if (artifact !== undefined) return artifact
  const root = packageRoot(fileURLToPath(import.meta.url))
  const path = join(root, 'lib', 'helper.js')
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch (error) {
    throw new Error(`the dshell SSH helper bundle is missing at ${path}; run "pnpm build" first (${String(error)})`)
  }
  artifact = { path, hash: createHash('sha256').update(bytes).digest('hex') }
  return artifact
}

/**
 * The package directory that owns a file inside it.
 * @param from - absolute path of a file within the package.
 * @returns the nearest ancestor holding a `package.json`.
 */
function packageRoot(from: string): string {
  let directory = dirname(from)
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown }
      if (manifest.name === '@nexus-aethra/dshell-ssh') return directory
      throw new Error(`expected the @nexus-aethra/dshell-ssh package root, found "${String(manifest.name)}" at ${directory}`)
    } catch (error) {
      if (error instanceof SyntaxError) throw error
      // No manifest here; keep walking. The name check above throws, so this
      // only absorbs ENOENT.
      if (!(error instanceof Error) || !('code' in error) || (error as { code?: unknown }).code !== 'ENOENT') throw error
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`no package.json above ${from}`)
    directory = parent
  }
}

/** Where a device's helper is installed, and what it must contain. */
export interface HelperTarget {
  /** Absolute remote Node executable. */
  readonly node: string
  /** Absolute path of the installed helper entry on the device. */
  readonly helper: string
  /** The digest the device's entry must report; see {@link localHelperArtifact}. */
  readonly expectedHash: string
}

/**
 * A live connection to one device's helper.
 *
 * Reconciliation with the device is deliberately narrow: the handshake reports
 * the digest of the file that is running, and a mismatch **refuses** the
 * connection. dshell later redeploys on a mismatch rather than refusing (the
 * artifact is ours and the device is ours to manage), but the deploy path is an
 * explicit action, so refusing here is the honest behaviour until it has run.
 */
export class DshellSshConnection {
  private readonly peer: SshRpcPeer
  private readonly command: DeviceCommand
  private readonly stderr: Buffer[] = []
  private stderrBytes = 0
  private heartbeat: NodeJS.Timeout | undefined
  private disposed = false
  private failure: Error | undefined
  /** Whether the handshake completed, which is what makes an exit diagnosable. */
  private verified = false

  /**
   * The device's own absolute root, from the verified handshake.
   *
   * Read by the router to expand a `~`-spelled session root before it becomes a
   * mapping: the helper's protocol refuses anything that is not absolute, and the
   * device is the only party that knows what its own `~` means.
   */
  private deviceRootValue: string | undefined
  /** Whether the recorded failure came from our own diagnosis or the transport. */
  private selfDiagnosed = false
  /** Resolves after the handshake has been verified. */
  readonly ready: Promise<{ hash: string; platform: string; node: string; nodeVersion: string; root: string }>

  /**
   * @param target - remote Node, installed helper path, expected digest.
   * @param command - the already-open channel running the device's helper.
   */
  constructor(target: HelperTarget, command: DeviceCommand) {
    this.command = command
    this.peer = new SshRpcPeer(this.command.stream, this.command.stream, DSHELL_HELPER_MAX_FRAME_BYTES, DSHELL_HELPER_MAX_PENDING)
    // Diagnostics can name configured paths, so they are kept for our own error
    // messages rather than forwarded anywhere.
    this.command.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.length
      this.stderr.push(chunk)
      while (this.stderrBytes > STDERR_KEEP_BYTES && this.stderr.length > 1) {
        this.stderrBytes -= (this.stderr.shift() as Buffer).length
      }
    })
    // A channel that ends is a lost connection, never a completed session:
    // whether the far side is gone or was never there, no later request can be
    // served, and pretending otherwise would report outcomes we never saw.
    //
    // Before the handshake the distinction matters to whoever reads this: a
    // missing or unlaunchable helper is a setup fact with a known cause (the
    // helper's own stderr, appended below), not an unknown outcome. Only after
    // the handshake is "unknown" the honest word, because the device may have
    // been running something when the link dropped.
    void this.command.done.then(() => {
      this.fail(new Error(this.verified
        ? 'the dshell SSH helper exited; the outcome of any operation in flight is unknown'
        : 'the dshell SSH helper did not start on the device'), 'self')
    })
    // The transport's own reason, which is weaker than anything diagnosed here:
    // when the helper never started, the peer can only report that its channel
    // closed, while the channel's exit and the helper's stderr say why.
    this.peer.once('closed', (error) => { this.fail(error instanceof Error ? error : new Error(String(error)), 'transport') })
    this.ready = this.handshake(target.expectedHash)
    void this.ready.catch(() => {})
  }

  /**
   * Send one operation to the device.
   * @param method - operation name from the helper protocol.
   * @param params - JSON request fields.
   * @param schema - validation for the reply, applied before it reaches a caller.
   * @param signal - cancellation; a completed remote effect is not undone.
   * @returns the validated reply.
   */
  async request<T>(method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    await this.ready
    return await this.peer.request(method, params, schema, signal)
  }

  /**
   * Release the connection: ask the helper to close, then end the channel.
   *
   * The `close` op comes first so the device reaps its own process instead of
   * waiting for a lease to expire; ending the channel is the fallback for a
   * device that cannot answer.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.heartbeat !== undefined) { clearInterval(this.heartbeat); this.heartbeat = undefined }
    try {
      await Promise.race([
        this.peer.request(HELPER_OPS.close, {}, nullReply),
        new Promise<void>((resolve) => { setTimeout(resolve, 2_000).unref() }),
      ])
    } catch {
      // A device that cannot answer is exactly why the channel is closed below.
    }
    this.peer.close(new Error('the dshell SSH connection was disposed'))
    this.command.terminate()
  }

  /** Send the handshake request. Split out so its failure can be re-diagnosed. */
  /** Send the handshake request. Split out so its failure can be re-diagnosed. */
  /**
   * The device's own absolute root, once the handshake has settled.
   * @returns the absolute default directory, or undefined before verification.
   */
  deviceRoot(): string | undefined {
    return this.deviceRootValue
  }
  private async hello(): Promise<{ hash: string; platform: string; node: string; nodeVersion: string; root: string }> {
    return await this.peer.request(
      HELPER_OPS.hello,
      { protocol: DSHELL_HELPER_PROTOCOL, leaseMs: DSHELL_HELPER_LEASE_MS },
      helloReply,
    )
  }

  /**
   * Complete and verify the handshake, then start the lease heartbeat.
   * @param expectedHash - digest the device's running helper must report.
   * @returns the verified handshake facts.
   */
  private async handshake(expectedHash: string): Promise<{ hash: string; platform: string; node: string; nodeVersion: string; root: string }> {
    const hello = await this.hello().catch(async (error: unknown) => {
      // A peer that closes rejects its pending request with its own reason
      // ("outcome is unknown"), which is true but the least specific thing
      // available: when the helper never started, the channel's exit and the
      // helper's stderr say why, and both land moments later. Waiting for the
      // channel to finish is what turns "unknown" into "it did not start,
      // because <stderr>", which is the difference between a mystery and a
      // wrong path.
      if (this.verified) throw error
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000)
        timer.unref()
        void this.command.done.then(() => { clearTimeout(timer); resolve() })
      })
      throw this.failure ?? (error instanceof Error ? error : new Error(String(error)))
    })
    if (hello.hash !== expectedHash) {
      // Refuse loudly and tear down: a device serving a different helper is
      // either stale or not the machine we provisioned, and every later reply
      // would be shaped by that difference.
      const error = new Error(
        `the device's dshell SSH helper differs from this build (device ${hello.hash.slice(0, 12)}…, expected ${expectedHash.slice(0, 12)}…)`,
      )
      this.fail(error, 'self')
      throw error
    }
    if (this.disposed) throw new Error('the dshell SSH connection was disposed during its handshake')
    const period = Math.floor(DSHELL_HELPER_LEASE_MS / 3)
    this.heartbeat = setInterval(() => {
      this.peer.request(HELPER_OPS.heartbeat, {}, nullReply).catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)), 'transport')
      })
    }, period)
    this.heartbeat.unref()
    this.verified = true
    this.deviceRootValue = hello.root
    return hello
  }

  /**
   * Record the failure and make sure the channel does not outlive it.
   *
   * Precedence is deliberate. 'self' means we diagnosed the cause (the exit of a
   * helper that never completed its handshake, a digest mismatch); 'transport'
   * means the peer noticed its channel close, which is true but says nothing
   * about why. A self-diagnosis replaces a transport one, and is never replaced
   * in turn — without that, ending the channel after a digest mismatch would
   * overwrite the mismatch with "did not start", burying the actual problem.
   *
   * @param error - the failure to report.
   * @param cause - who is reporting it; see above.
   */
  private fail(error: Error, cause: 'self' | 'transport'): void {
    if (this.failure !== undefined && !(cause === 'self' && !this.selfDiagnosed)) return
    this.failure = new Error(this.describe(error), { cause: error })
    this.selfDiagnosed ||= cause === 'self'
    this.peer.close(this.failure)
    this.command.terminate()
  }

  /** Append what the helper said, which is where auth and setup errors live. */
  private describe(error: Error): string {
    const diagnostics = Buffer.concat(this.stderr).toString('utf8').trim()
    return diagnostics === '' ? error.message : `${error.message}: ${diagnostics}`
  }
}

/**
 * The remote line that starts one device's helper.
 *
 * `--disable-sigusr1` is a security measure, not a preference. Node opens its
 * inspector on SIGUSR1, and a device's sandbox confines file effects only, so a
 * same-user process can still signal this one; without the flag the inspector
 * would expose the helper's unrestricted filesystem and process services to
 * anyone who can send that signal.
 *
 * @param target - remote Node and the installed helper entry.
 * @returns the shell line the device's login shell runs.
 */
export function helperLine(target: HelperTarget): string {
  return [target.node, '--disable-sigusr1', target.helper].map(quote).join(' ')
}

/**
 * Connections by device, so one device keeps one helper for the life of the host.
 *
 * Memoized by device **and** by target: a device whose helper path or expected
 * digest changed must not keep serving from a connection that was verified
 * against the old pair.
 */
export class DshellSshConnections {
  private readonly entries = new Map<string, { key: string; connection: Promise<DshellSshConnection>; live?: DshellSshConnection }>()
  private disposed = false

  /**
   * The connection for a device, if one is verified **now**.
   *
   * Synchronous on purpose: the subprocess seam cannot await, so it asks this
   * before deciding between the RPC path and the assembled-command one. An
   * absent answer is not an error — it means "not connected yet", and the
   * caller falls back rather than waiting.
   *
   * @param deviceId - device to look up.
   * @returns the verified connection, or undefined when there is none.
   */
  peek(deviceId: string): DshellSshConnection | undefined {
    return this.entries.get(deviceId)?.live
  }

  /**
   * The live connection for a device, established on first use.
   * @param device - device to connect to.
   * @param target - remote Node, helper path and expected digest.
   * @returns the connection, after its handshake has been verified.
   */
  async forDevice(device: DeviceConnection, target: HelperTarget): Promise<DshellSshConnection> {
    if (this.disposed) throw new Error('the dshell SSH connections were disposed')
    const key = `${target.node}\n${target.helper}\n${target.expectedHash}`
    const existing = this.entries.get(device.id)
    if (existing !== undefined && existing.key === key) return await existing.connection
    if (existing !== undefined) await this.release(device.id)
    // The promise, not the object, is what goes in the map: two calls arriving
    // for one device while the handshake is in flight must share it rather than
    // start a second helper on the device.
    const pending = (async (): Promise<DshellSshConnection> => {
      const command = await deviceTransport().open(device, helperLine(target), { openStdin: true })
      const connection = new DshellSshConnection(target, command)
      try {
        await connection.ready
        return connection
      } catch (error) {
        await connection.dispose().catch(() => undefined)
        throw error
      }
    })()
    const entry: { key: string; connection: Promise<DshellSshConnection>; live?: DshellSshConnection } = { key, connection: pending }
    this.entries.set(device.id, entry)
    void pending.then((connection) => {
      // Only publish into the entry we created: a superseding resolve may have
      // replaced the map by the time this settles.
      if (this.entries.get(device.id) === entry) entry.live = connection
    }).catch(() => undefined)
    try {
      return await pending
    } catch (error) {
      // A failed handshake must not be remembered: the next call is exactly how
      // a user retries after fixing the device or deploying a helper. Guarded so
      // a superseding entry is left alone.
      if (this.entries.get(device.id)?.connection === pending) this.entries.delete(device.id)
      throw error
    }
  }

  /**
   * Drop one device's connection.
   * @param deviceId - device whose connection should end.
   */
  async release(deviceId: string): Promise<void> {
    const entry = this.entries.get(deviceId)
    if (entry === undefined) return
    this.entries.delete(deviceId)
    const connection = await entry.connection.catch(() => undefined)
    await connection?.dispose().catch(() => undefined)
  }

  /** End every connection; used when the host unloads. */
  async disposeAll(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.entries.keys()].map(async (id) => { await this.release(id) }))
  }
}
