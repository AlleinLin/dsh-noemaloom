/**
 * `ctx.fs`, made device-aware.
 *
 * This provider is loaded INSTEAD of the stock sandbox backend, which is the
 * swap dsh documents for exactly this kind of overlay. It extends that backend
 * (so the local half is the stock implementation verbatim, including the
 * sandbox fence on mutations) and adds one decision per call: which session
 * does this call belong to, and is that session bound to a device?
 *
 * Unbound → `super`, byte-for-byte the behaviour a composition without this
 * package has. Bound → the same operations against the device, over SSH.
 *
 * Dispatch is by the ambient initiator agent, the same signal the shell seam
 * uses, because a call carries no session field: the tool layer resolves paths
 * against its session's cwd and hands the backend only a target.
 *
 * The remote directory a call operates in is derived from the same mapping the
 * session's cwd encodes, so a relative path in a tool argument means the same
 * place to the model, the shell, and the file tools.
 */

import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry, FsEditOutcome, FsEditRequest, FsInfo, FsPathInfo,
  FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { HostCopy } from '@nexus-aethra/dshell-std'
// Type-only: pulls the host agent service merge (ctx.agents).
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: pulls the sandbox-policy service merge (ctx.sandboxPolicy).
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { isUnderRemote, mappingFor, toMountPath, type MountMapping } from './mount.js'
import { hostCopy, type DshellSshTranslate } from './host-locales.js'
import { RemoteFileSystem } from './remote-fs.js'
import { SSH_ROUTING_SERVICE, type SshRouter } from './router.js'
import { installDeviceFs } from './device-fs-provider.js'

/** Remote temp areas a `workspace-write` session may also write, mirroring the local backend's temp allowance. */
const REMOTE_TEMP_ROOTS = ['/tmp', '/var/tmp'] as const

/**
 * The filesystem seam for dshell. Constructing it registers `ctx.fs`, so the
 * composition must disable the stock `fs-sandbox` row: a service name has
 * exactly one provider, and a second registration fails loudly.
 *
 * Deliberately NOT a class plugin: the base class already declares a static
 * `inject`, and a subclass's longer tuple is not assignable to it, so the
 * declaration lives on the exported plugin object instead.
 */
export class DshellFileSystem extends SandboxedFileSystem {
  /** Per-target serialization for remote mutations; the local half has its own. */
  private readonly remoteLocks = new Map<string, Promise<unknown>>()

  /**
   * @param ctx - host context, as the base class takes it.
   * @param config - base config, as the base class takes it.
   * @param t - this package's bound host copy, handed to each remote backend.
   */
  constructor(
    ctx: Context,
    config: ConstructorParameters<typeof SandboxedFileSystem>[1],
    private readonly t: DshellSshTranslate,
  ) {
    super(ctx, config)
  }

  /**
   * The device backend for the ambient call, or undefined for a local session.
   *
   * The helper connection is looked up per call and never awaited. Looking one
   * up asks whether a helper is verified *now*, and a device with none — no
   * Node, no helper installed yet, a handshake still in flight — is answered by
   * the assembled-command lane instead. Waiting here would turn the absence of
   * a helper into a stall on every read, and a device that will never have one
   * into a hang.
   */
  private async remote(): Promise<RemoteFileSystem | undefined> {
    const routed = this.route()
    if (routed === undefined) return undefined
    const { target, sessionCwd } = routed
    // The mapping's root has to be an ABSOLUTE device path: the helper's
    // protocol admits nothing else, and the containment check can only compare
    // a path against an absolute root. A device that has not said where its
    // home is asked now, rather than being sent a `~` it cannot open.
    const remoteRoot = await this.absoluteRoot(target)
    const mapping = mappingFor({ ...target, remoteRoot }, sessionCwd)
    if (mapping === undefined) return undefined
    return new RemoteFileSystem({
      ctx: this.ctx,
      device: target.device,
      mapping,
      diffBasisMaxBytes: this.config.diffBasisMaxBytes,
      t: this.t,
      connection: this.ctx[SSH_ROUTING_SERVICE].helperConnection?.(target.device.id),
    })
  }

  /** The device's absolute root, asked for once if the device has not said. */
  private async absoluteRoot(
    target: NonNullable<ReturnType<SshRouter['targetForSession']>>,
  ): Promise<string> {
    if (target.remoteRoot.startsWith('/')) return target.remoteRoot
    const root = await this.ctx[SSH_ROUTING_SERVICE].ensureDeviceRoot(target.device.id)
    return root ?? target.remoteRoot
  }

  /** The mapping for the ambient call, for the policy fence. */
  private mapping(): MountMapping | undefined {
    const routed = this.route()
    if (routed === undefined) return undefined
    return mappingFor(routed.target, routed.sessionCwd)
  }

  /**
   * Where the ambient call belongs: its device and the mapping to translate
   * with, or undefined for a session that runs on this machine.
   *
   * A session that IS bound to a device has no local half, so the two states
   * that used to look alike are now told apart. "No binding" falls through to
   * `super`, which is the stock backend and exactly right. "Bound, but nothing
   * can serve it" — the device was deleted, or the binding carries no mount to
   * translate with — is a refusal: falling through would hand a device session
   * this machine's disk, where its reads answer from the reader's own files and
   * its writes land there too, while every layer above reports a successful
   * operation on the device. That is the risk this seam exists to remove, so it
   * is stated rather than absorbed.
   *
   * The mapping carries the session's own directory as an alias of its remote
   * root when the two differ, which is what makes the model's relative paths
   * land on the device (see `mappingFor`).
   */
  private route(): { target: NonNullable<ReturnType<SshRouter['targetForSession']>>; sessionCwd: string | undefined } | undefined {
    const agent = this.ctx.agents.currentInitiator()
    if (agent === undefined) return undefined
    const routing = this.ctx[SSH_ROUTING_SERVICE]
    const sessionId = String(agent.id)
    const target = routing.targetForSession(sessionId)
    const sessionCwd = agent.session.header.cwd
    if (target !== undefined && mappingFor(target, sessionCwd) !== undefined) return { target, sessionCwd }
    const bound = routing.assignmentForSession(sessionId)
    if (bound === undefined) return undefined
    throw new FsError(routing.unservableMessage(bound.deviceId), 'FS_PERMISSION_DENIED')
  }

  /** Run one remote mutation under a per-target lock. */
  private async withRemoteLock<T>(key: string, op: () => Promise<T>): Promise<T> {
    const prior = this.remoteLocks.get(key) ?? Promise.resolve()
    const run = prior.then(op, op)
    const tail = run.then(() => undefined, () => undefined)
    this.remoteLocks.set(key, tail)
    try {
      return await run
    } finally {
      if (this.remoteLocks.get(key) === tail) this.remoteLocks.delete(key)
    }
  }

  /**
   * Apply the per-call policy to a remote mutation.
   *
   * The device has its own permissions; this fence is the harness's own policy
   * statement, so it is enforced here in trusted code against the device path
   * rather than delegated. `workspace-write` contains to the session's remote
   * root (plus the device's temp areas), which is the remote analogue of the
   * local backend's workspace root.
   */
  private fence(mapping: MountMapping, remotePath: string, sandboxPolicy?: SandboxExecutionPolicy): void {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const { mode } = policy
    if (mode === 'danger-full-access') return
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${remotePath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    // Both sides are DEVICE paths, so the containment check is the device's.
    const allowed = [mapping.remoteRoot, ...REMOTE_TEMP_ROOTS].some(root => isUnderRemote(root, remotePath))
    if (!allowed) {
      throw new FsError(`cannot write "${remotePath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
    }
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const remote = await this.remote()
    return remote === undefined ? await super.resolve(path, opts) : await remote.resolve(path, opts)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const remote = await this.remote()
    return remote === undefined ? await super.stat(target, signal) : await remote.stat(target, signal)
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const remote = await this.remote()
    return remote === undefined ? await super.lstat(path, opts, signal) : await remote.lstat(path, opts, signal)
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const remote = await this.remote()
    return remote === undefined ? await super.readText(target, signal) : await remote.readText(target, signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const remote = await this.remote()
    return remote === undefined ? await super.streamText(target, signal) : await remote.streamText(target, signal)
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const remote = await this.remote()
    return remote === undefined
      ? await super.readBytes(target, signal, maxBytes)
      : await remote.readBytes(target, signal, maxBytes)
  }

  override async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const remote = await this.remote()
    return remote === undefined
      ? await super.readByteRange(target, range, signal)
      : await remote.readByteRange(target, range, signal)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const remote = await this.remote()
    return remote === undefined ? await super.listDir(target, signal) : await remote.listDir(target, signal)
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const remote = await this.remote()
    const mapping = this.mapping()
    if (remote === undefined || mapping === undefined) {
      return await super.writeText(target, content, expected, signal, sandboxPolicy)
    }
    return await this.withRemoteLock(String(target.targetKey), async () => {
      this.fence(mapping, String(target.targetKey), sandboxPolicy)
      return await remote.writeText(target, content, expected, signal)
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const remote = await this.remote()
    const mapping = this.mapping()
    if (remote === undefined || mapping === undefined) {
      return await super.editText(target, edit, expected, signal, sandboxPolicy)
    }
    return await this.withRemoteLock(String(target.targetKey), async () => {
      this.fence(mapping, String(target.targetKey), sandboxPolicy)
      return await remote.editText(target, edit, expected, signal)
    })
  }

  /**
   * For a remote target, the URL points at the local mount directory — the one
   * local path that stands for this file. It is an empty shadow by design, so
   * the URL resolves (rather than naming a path that does not exist) without
   * pretending the device's file is on this machine.
   */
  override fileUrl(target: FsTarget): string {
    const mapping = this.mapping()
    if (mapping === undefined) return super.fileUrl(target)
    return pathToFileURL(toMountPath(mapping, String(target.targetKey))).href
  }
}

/**
 * Services this provider needs before it may start.
 *
 * `subprocess` is not incidental: it is how the assembled-command lane runs an
 * `ssh` invocation on the device, which is the lane every call falls back to
 * when no helper is verified, and reaching for a service a context did not
 * inject throws in cordis rather than resolving lazily.
 */
export const inject = ['agents', 'sandboxPolicy', 'subprocess', SSH_ROUTING_SERVICE, 'dshellHostCopy'] as const

/** Config schema, re-exported so the loader applies the base defaults. */
export const Config = DshellFileSystem.Config

/** Plugin entry: one provider instance per composition. */
export function apply(ctx: Context, config: ConstructorParameters<typeof DshellFileSystem>[1]): void {
  // Structural read: the accessor's declaration lives with the provider
  // (dshell-mode), which this package's tsc program does not include. The
  // `inject` above is what guarantees the service is there.
  const copy = ctx.get('dshellHostCopy') as HostCopy
  const t = copy.bind(hostCopy)
  new DshellFileSystem(ctx, config, t)
  // The byte-level ops seat is published alongside `ctx.fs` because both
  // share the same routing table and the same host-copy binding; the
  // transfer and buffer relays read it as `ctx.deviceFs`.
  installDeviceFs(ctx, config, t)
}

export default { name: 'dshell-fs', inject, Config, apply }
