/**
 * Which session runs where, and the one seam that acts on it.
 *
 * Routing is decided per call, not per session object: `ctx.agents.currentInitiator()`
 * is the ambient agent of the executing tool call (the agent loop establishes
 * that boundary for the whole turn), so a bound session's `bash` calls can be
 * redirected without changing any tool signature or re-registering anything.
 *
 * The seam is `ctx.shell.resolve`: the local executor has already applied its
 * defaults and caps by then, so wrapping the resolved command leaves every
 * other property — timeout, output caps, signal, streaming and background
 * handles — in the hands of the stock implementation. Only the command line
 * and the working directory change.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { ShellExecRequest, ShellExecSpec } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { DshellSshConnection } from './connection.js'
import { DeviceStore, type DeviceConnection } from './devices.js'
import { CredentialStore } from './credentials.js'
import { SecretVault, VaultLockedError } from './vault.js'
import type { DshellSshTranslate } from './host-locales.js'
import { trustedHostKey } from './host-key.js'
import { localHelperArtifact } from './connection.js'
import { deployHelper, helperPathFor } from './helper/install.js'
import { PROBE, installProbe } from './helper/target.js'
import type { DeviceHelperStatus } from '@nexus-aethra/dshell-std'
import { absoluteRemoteRoot, isUnder, mountFor } from './mount.js'
import { mountBase } from './paths.js'
import { quote, quoteDevicePath } from './shell-quote.js'
import { deviceTransport, type DeviceShell } from './transport/transport.js'

/**
 * Service name under which the router is published.
 *
 * The filesystem provider is loaded as its own plugin — it has to be, to take
 * the stock backend's place — and it resolves a call's session through this
 * router. A provided service is how two plugins in one package share a value
 * without either reaching into the other's instance.
 */
export const SSH_ROUTING_SERVICE = 'dshellSshRouting'

/**
 * How long a terminal will wait for a device session's assignment to appear.
 * The dialog records the assignment one round trip after creating the session,
 * so the wait only has to cover that gap; it ends as soon as the assignment
 * lands, and an unbound session in a mount directory pays it once at spawn.
 */
const PENDING_BIND_ATTEMPTS = 20
const PENDING_BIND_WAIT_MS = 50

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session→device assignments, published by the dshell-ssh plugin. */
    dshellSshRouting: SshRouter
  }
}

/**
 * The one method this module replaces, typed structurally: the concrete
 * executor's own `resolve` signature is all that matters here, and taking the
 * shape rather than an exported class keeps the seam working for any
 * `ctx.shell` provider (`bash-local`, `bash-sandbox`, the win32 rows).
 */
interface ShellExecutorShape {
  resolve(this: unknown, request: ShellExecRequest): ShellExecSpec
  /**
   * The argv this executor would run a resolved spec with.
   *
   * Optional on purpose: only the executors that build their argv FROM the
   * spec have one (`bash-local` hardcodes `['bash', '-c', command]`, which is
   * already the shape a device wants). Absent means there is nothing here to
   * replace — the executor's own argv is already the device's.
   */
  argv?(this: unknown, spec: ShellExecSpec): string[]
}

/** Where one session runs: the device, the directory on it, and its local mount. */
interface Assignment {
  readonly deviceId: string
  /** Session-level directory override; undefined uses the device's own. */
  readonly remoteRoot?: string | undefined
  /** Local directory standing in for that tree; undefined on pre-mount bindings. */
  readonly mount?: string | undefined
}

/** One session's assignment as the host reports it. */
export interface AssignmentView extends Assignment {
  readonly sessionId: string
}

/** Session → device assignments, durable because routing must survive a restart. */
class BindingStore {
  private loaded = false
  private entries = new Map<string, Assignment>()

  /** @param path - resolves the document path, read when it is first needed. */
  constructor(private readonly path: () => string) {}

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    this.entries = await this.read()
  }

  /**
   * Re-read the document over the cache.
   *
   * Every host on this machine shares one bindings document, so the in-memory
   * map is a cache of the last read or write, never the truth: a host that
   * answers from a stale cache mislabels sessions, and a host that writes one
   * deletes every binding another host recorded after its startup. Anything
   * that answers or mutates therefore refreshes first.
   */
  async refresh(): Promise<void> {
    this.loaded = true
    this.entries = await this.read()
  }

  private async read(): Promise<Map<string, Assignment>> {
    const entries = new Map<string, Assignment>()
    try {
      const parsed = JSON.parse(await readFile(this.path(), 'utf8')) as unknown
      if (typeof parsed !== 'object' || parsed === null) return entries
      for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
        // A bare string is the shape written before sessions could pick their
        // own remote directory; it still means "this device, its directory".
        if (typeof value === 'string' && value.length > 0) {
          entries.set(sessionId, { deviceId: value })
          continue
        }
        if (typeof value !== 'object' || value === null) continue
        const record = value as Record<string, unknown>
        const deviceId = record.deviceId
        if (typeof deviceId !== 'string' || deviceId.length === 0) continue
        const remoteRoot = record.remoteRoot
        const mount = record.mount
        entries.set(sessionId, {
          deviceId,
          ...typeof remoteRoot === 'string' && remoteRoot.length > 0 ? { remoteRoot } : {},
          ...typeof mount === 'string' && mount.length > 0 ? { mount } : {},
        })
      }
    } catch {
      // No assignments yet.
    }
    return entries
  }

  get(sessionId: string): Assignment | undefined {
    return this.entries.get(sessionId)
  }

  all(): readonly AssignmentView[] {
    return [...this.entries].map(([sessionId, entry]) => ({ sessionId, ...entry }))
  }

  /**
   * Assign or clear one session's device, durably.
   *
   * Read-modify-write: the change is applied to what is on disk NOW, so two
   * hosts binding different sessions keep each other's rows.
   *
   * @param sessionId - session to assign.
   * @param deviceId - device, or null to run locally again.
   * @param remoteRoot - session directory on that device; null clears the
   *   override so the device's own directory applies.
   * @param mount - local directory standing in for that tree; null omits it,
   *   which leaves the session with no remote file operations (only the shell
   *   path, which needs no mount).
   */
  async set(
    sessionId: string,
    deviceId: string | null,
    remoteRoot: string | null = null,
    mount: string | null = null,
  ): Promise<void> {
    const entries = await this.read()
    if (deviceId === null) entries.delete(sessionId)
    else {
      const override = remoteRoot === null || remoteRoot.trim() === '' ? {} : { remoteRoot: remoteRoot.trim() }
      const mounted = mount === null || mount.trim() === '' ? {} : { mount: mount.trim() }
      entries.set(sessionId, { deviceId, ...override, ...mounted })
    }
    this.entries = entries
    await this.write(entries)
  }

  /**
   * Give assignments the mounts they were written without, durably.
   *
   * Merged into what is on disk now, like {@link set}, because the startup
   * backfill that calls this runs in every host and must not trade rows.
   *
   * @param mounts - mount directory per session that lacks one.
   * @returns whether anything reached disk.
   */
  async adoptMounts(mounts: ReadonlyMap<string, string>): Promise<boolean> {
    if (mounts.size === 0) return false
    const entries = await this.read()
    let adopted = false
    for (const [sessionId, mount] of mounts) {
      const entry = entries.get(sessionId)
      if (entry === undefined || entry.mount !== undefined) continue
      entries.set(sessionId, { ...entry, mount })
      adopted = true
    }
    if (!adopted) return false
    this.entries = entries
    await this.write(entries)
    return true
  }

  /** Write the assignments down, through a temporary so a reader never sees half. */
  private async write(entries: Map<string, Assignment>): Promise<void> {
    await mkdir(dirname(this.path()), { recursive: true })
    const temporary = `${this.path()}.tmp`
    await writeFile(temporary, JSON.stringify(Object.fromEntries(entries), null, 2), 'utf8')
    await rename(temporary, this.path())
  }
}

/** Devices, their assignments, and the per-call decision they drive. */
export class SshRouter {
  private readonly devices: DeviceStore
  /** The group registry and the unlock state, shared with every reader. */
  readonly vault: SecretVault
  /** The credential library devices point at. */
  readonly credentials: CredentialStore
  private readonly bindings: BindingStore
  private connections = new Map<string, DeviceConnection>()
  /**
   * Why a device has no connection right now, by device id.
   *
   * Written by {@link refreshDevices} when it skips one — a credential whose
   * group is locked, usually — and read by the seams that refuse a session
   * bound to it. Remembered rather than recomputed because those seams are
   * synchronous, and a refusal that names the group is the whole difference
   * between "this machine is unreachable" and "unlock this group".
   */
  private unservable = new Map<string, { reason: string; groupId: string | undefined }>()
  /**
   * The device's absolute root, by device id, as the last answer about it said.
   *
   * A session's root is stored the way the reader typed it — `~` is the common
   * one — and the device is the only party that knows what its own `~` means.
   * The helper's handshake reports it, and the probe reports it too, but both are
   * answers that arrive over a connection: a helper that is not up *right now* is
   * not a device whose home is unknown. Remembering the answer is what keeps a
   * mapping's root an ABSOLUTE device path, which is the only spelling the
   * device's protocol accepts and the only one the containment check can
   * compare a path against. Without it the root flapped between `~` and
   * `/root`, and everything built on it flapped with it.
   */
  private readonly deviceRoots = new Map<string, string>()
  private ready: Promise<void>
  /**
   * This package's host copy, bound to the language service once it is
   * available (see `bindCopy`). Held on the router because its methods compose
   * refusals the user reads long after composition — the language is resolved
   * at call time, so a switch needs no re-binding.
   */
  private t!: DshellSshTranslate
  /**
   * Told when a device or an assignment changed, so anything cached about a
   * device — a resolved helper target, a live connection — can be dropped or
   * re-established. Assigned by the subprocess seam, which owns those caches;
   * absent in tests, where nothing needs invalidating.
   */
  onDeviceChanged: ((deviceId: string, event: 'saved' | 'removed' | 'bound') => void) | undefined

  /**
   * Told when one SESSION's assignment changed — bound to a device, unbound,
   * or pointed at a device whose own record changed.
   *
   * A separate hook from {@link onDeviceChanged} because that one is about a
   * DEVICE (its helper target, its live connection) and names no session,
   * while this one is about a SESSION and names the device it now runs on.
   * What the model is told about a session's world follows the assignment, so
   * the two have to be able to move together.
   */
  onAssignmentChanged: ((sessionId: string, deviceId: string | null) => void) | undefined

  /**
   * The device's verified helper connection, when one is up right now.
   *
   * Assigned by the subprocess seam along with the hook above, because that is
   * what owns the pool and its lifetime. The filesystem provider reads it to
   * decide which lane answers a call, and an absent answer is a decision, not a
   * failure: this device has no helper *at this moment*, so the assembled path
   * answers instead. Deliberately synchronous for the same reason — a caller
   * that waited for a connection that may never come would turn "no Node on
   * this device" into a hang.
   */
  helperConnection: ((deviceId: string) => DshellSshConnection | undefined) | undefined

  /**
   * @param root - resolves the device directory (`<data root>/dshell/ssh`).
   *
   * A RESOLVER rather than a path, so nothing here freezes a value that is
   * settled elsewhere: `apply` waits for dshell's data root before constructing
   * the router, and the resolver keeps that ordering visible at the point where
   * the path is actually used.
   */
  constructor(root: () => string) {
    // One vault instance for the process: the whole point of an unlock is that
    // the device store, the credential store and the card all see the same one.
    this.vault = new SecretVault(root)
    this.credentials = new CredentialStore(root, this.vault)
    this.devices = new DeviceStore(root, this.credentials)
    this.bindings = new BindingStore(() => join(root(), 'bindings.json'))
    // Eagerly, and deliberately: `targetForSession` below is synchronous
    // because `spawn`/`resolve` cannot await, so this cache has to be filled
    // before the first call that reads it. `apply` awaiting the settled data
    // root first is what makes that safe.
    this.ready = this.reload()
  }

  /**
   * The one-time load: the device document, the assignments, and the control
   * socket directory.
   *
   * @returns the load already in flight.
   */
  private ensureReady(): Promise<void> {
    return this.ready
  }

  /**
   * Bind this package's host dictionaries to the language service.
   * @param t - translator from `ctx.dshellHostCopy.bind(hostCopy)`.
   */
  bindCopy(t: DshellSshTranslate): void {
    this.t = t
  }

  /**
   * Resolves when the device and assignment caches are filled.
   *
   * The caches are filled asynchronously, and everything that reads them
   * synchronously — the seams inside a tool call, the per-agent view of "where
   * does this session run" — can run before they are. A caller that needs the
   * answers rather than an answer to "not yet" waits here.
   *
   * @returns the load promise; it rejects when the load failed.
   */
  whenReady(): Promise<void> {
    return this.ready
  }

  /**
   * One device's connection record from the routing cache.
   * @param deviceId - device to look up.
   * @returns the resolved connection, or undefined when it is not loaded.
   */
  deviceFor(deviceId: string): DeviceConnection | undefined {
    return this.connections.get(deviceId)
  }

  /** Every configured device. */
  async list() {
    await this.ensureReady()
    return await this.devices.list()
  }

  /**
   * One device's host and port, for a question about its trust rather than
   * about its configuration.
   *
   * @param deviceId - device to look up.
   * @returns the destination, or undefined when the device is unknown.
   */
  async destinationOf(deviceId: string): Promise<{ host: string; port: number } | undefined> {
    const views = await this.list()
    const view = views.find(candidate => candidate.id === deviceId)
    return view === undefined ? undefined : { host: view.host, port: view.port }
  }

  /** Every session→device assignment. */
  async assignments(): Promise<readonly AssignmentView[]> {
    await this.bindings.refresh()
    return this.bindings.all()
  }

  /**
   * The connection for one device, refreshing once before refusing.
   *
   * Every seam that needs a live connection comes through here so they all
   * refuse the same way: a device whose credential sits in a locked group is
   * refused with a {@link VaultLockedError} carrying that group, because it is
   * the one refusal with a way out — the route turns the group into a pointer at
   * its unlock box. Anything else is refused with the reason the last refresh
   * recorded.
   */
  private async connectionFor(deviceId: string): Promise<DeviceConnection> {
    const cached = this.connections.get(deviceId)
    if (cached !== undefined) return cached
    await this.refreshDevices()
    const fresh = this.connections.get(deviceId)
    if (fresh !== undefined) return fresh
    const stuck = this.unservable.get(deviceId)
    if (stuck?.groupId !== undefined) throw new VaultLockedError(stuck.reason, stuck.groupId)
    throw new Error(stuck?.reason ?? this.t('error.unknownDevice', { id: deviceId }))
  }

  /**
   * Assign a session to a device, or clear it with `null`.
   * @param sessionId - session to assign.
   * @param deviceId - device, or null to run locally again.
   * @param remoteRoot - directory to run in on that device; null uses the
   *   device's own `remoteRoot`.
   * @param mount - local directory standing in for that tree; null takes the
   *   tree's own ({@link mountPath}), because a binding without one routes only
   *   the shell and leaves every file operation on this machine.
   * @param createRemoteRoot - whether to make the session's directory exist on
   *   the device BEFORE the assignment becomes visible. Without this the binding
   *   is briefly routable while the remote directory is still missing, and the
   *   shell silently falls back to the login directory — which is exactly what a
   *   terminal that spawns the instant the binding lands must not do.
   */
  async bind(
    sessionId: string,
    deviceId: string | null,
    remoteRoot: string | null = null,
    mount: string | null = null,
    createRemoteRoot = false,
  ): Promise<void> {
    let assigned = mount
    if (deviceId !== null) {
      await this.connectionFor(deviceId)
      if (createRemoteRoot) await this.ensureRemoteRoot(deviceId, remoteRoot)
      const tree = assigned === null || assigned.trim().length === 0
        ? await this.mountPath(deviceId, remoteRoot)
        : assigned
      // Made to exist here rather than left to the session's creation: a
      // session that runs on a device is created in a directory of THIS
      // machine, and for one bound after its creation nothing else would ever
      // make the stand-in.
      await mkdir(tree, { recursive: true })
      assigned = tree
    }
    await this.bindings.set(sessionId, deviceId, remoteRoot, assigned)
    if (deviceId !== null) this.onDeviceChanged?.(deviceId, 'bound')
    this.onAssignmentChanged?.(sessionId, deviceId)
  }

  /**
   * Create or update a device, then refresh the routing cache.
   * @param input - submitted device.
   */
  async saveDevice(input: Parameters<DeviceStore['save']>[0]) {
    const view = await this.devices.save(input, this.t)
    await this.refreshDevices()
    this.onDeviceChanged?.(view.id, 'saved')
    this.notifyDeviceSessions(view.id)
    return view
  }

  /**
   * Remove a device; sessions assigned to it fall back to local execution.
   * @param deviceId - device to remove.
   */
  async removeDevice(deviceId: string): Promise<void> {
    await this.devices.remove(deviceId)
    await this.refreshDevices()
    this.onDeviceChanged?.(deviceId, 'removed')
    this.notifyDeviceSessions(deviceId)
  }

  /**
   * Tell the assignment hook about every session bound to one device.
   *
   * A device that was renamed, or removed, changes what the model is told
   * about the sessions that run on it: the device's name is part of that
   * contract, so the sessions move with the device rather than keeping a
   * description of a device that no longer answers.
   *
   * @param deviceId - the device whose sessions moved.
   */
  private notifyDeviceSessions(deviceId: string): void {
    if (this.onAssignmentChanged === undefined) return
    for (const assignment of this.bindings.all()) {
      if (assignment.deviceId === deviceId) this.onAssignmentChanged(assignment.sessionId, deviceId)
    }
  }

  /**
   * Deploy this build's helper to one device and report the resulting state.
   *
   * Three steps in order:
   *
   *   1. Probe — re-asks for `$HOME` and the device's Node, because a device
   *      whose answer changed since the last probe should be re-deployed
   *      against the new path rather than a stale one.
   *   2. Deploy — sends the bundle base64-encoded on stdin, with `mkdir`,
   *      `chmod 0700`, and a `sha256sum` verification on the device.
   *   3. Verify — the deploy reports the device's own digest; a mismatch
   *      against the artifact is a deployment failure.
   *
   * The result is what the device card renders verbatim, and what the next
   * connection's `hello` reply will independently check — the two checks are
   * the same, deliberately.
   *
   * @param deviceId - device to deploy to.
   */
  async installHelper(deviceId: string): Promise<DeviceHelperStatus> {
    const device = await this.connectionFor(deviceId)
    const artifact = localHelperArtifact()
    const probe = await this.probeDevice(device)
    // The device said where its home is, and a `~`-spelled session root is
    // expanded against it — so the answer is kept, whether or not the device
    // turns out to have a Node to run a helper with.
    this.noteDeviceRoot(deviceId, probe.home)
    let status: DeviceHelperStatus
    if (probe.node === undefined) {
      status = {
        state: 'absent',
        expected: artifact.hash,
        message: this.t('install.noNode'),
      }
    } else {
      const outcome = await deployHelper(device, artifact.path, artifact.hash, probe.home)
      status = outcome.onDevice === artifact.hash
        ? {
            state: 'present',
            onDevice: outcome.onDevice,
            expected: artifact.hash,
            path: outcome.path,
            message: outcome.message,
          }
        : {
            state: 'mismatch',
            onDevice: outcome.onDevice,
            expected: artifact.hash,
            path: outcome.path,
            // The digests the copy used to spell inline now travel on the
            // status fields and reach the reader through the card's tooltip.
            message: this.t('install.mismatch'),
          }
    }
    // Record the result against the device. The card reads its status off the
    // device view, so a check that is not written shows for exactly one
    // response and then vanishes — a redeploy reporting success, and a reload
    // showing nothing at all.
    await this.devices.setHelper(deviceId, status)
    return status
  }

  /**
   * Re-ask the device for its home and Node executable.
   *
   * A thin wrapper around the probe that returns the raw answer; callers that
   * need a {@link ResolvedTarget} use {@link HelperTargets.resolve} so the
   * per-device cache is hit. Used by {@link installHelper} when the answer
   * might have changed since the cache was populated.
   */
  private async probeDevice(device: DeviceConnection): Promise<{ home: string; node: string | undefined }> {
    const result = await deviceTransport().exec(device, PROBE, { graceMs: 10_000 })
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() === ''
        ? this.t('install.probeFailed', { code: String(result.exitCode ?? 'on a signal') })
        : result.stderr.trim())
    }
    const [home = '', node = ''] = result.stdout.trimEnd().split('\n')
    return {
      home: home.trim(),
      node: node.trim() === '' || !node.trim().startsWith('/') ? undefined : node.trim(),
    }
  }

  /**
   * Where one session runs, or undefined for local execution.
   *
   * Synchronous on purpose: it is read inside `spawn`/`resolve`, which cannot
   * await. The caches it reads are filled at load and on every mutation.
   *
   * @param sessionId - ambient agent id of the executing call.
   * @returns the connection, the remote directory and the local mount standing
   *   in for it; `mount` is undefined for a binding written before mounts, so
   *   only the shell path is routed for those.
   */
  targetForSession(
    sessionId: string,
  ): { device: DeviceConnection; remoteRoot: string; mount: string | undefined } | undefined {
    const assignment = this.bindings.get(sessionId)
    if (assignment === undefined) return undefined
    const device = this.connections.get(assignment.deviceId)
    if (device === undefined) return undefined
    // The device's own root: from the helper when one is up, and from what it
    // said the last time one was. The mapping's root has to be absolute — the
    // device's protocol admits nothing else, and the sandbox's containment
    // check compares against it — so it is never left as the `~` the reader
    // typed.
    const live = this.helperConnection?.(device.id)?.deviceRoot()
    if (live !== undefined) this.noteDeviceRoot(device.id, live)
    return {
      device,
      // The stored root is what the reader typed (`~` is the common one) and a
      // SHELL expands it for free; the helper's protocol refuses anything but an
      // absolute path, so the translation happens here — the one place a mapping
      // is made — against the root the device reported at its handshake.
      remoteRoot: absoluteRemoteRoot(
        assignment.remoteRoot ?? device.remoteRoot,
        this.deviceRoots.get(device.id),
      ),
      mount: assignment.mount,
    }
  }

  /**
   * Remember a device's absolute root.
   *
   * The device is the only party that knows what its own `~` means, so every
   * answer about its home is worth keeping: the mapping's root is built from
   * it, and a root that turned back into a `~` whenever a connection was not
   * up is a root the device cannot be asked about.
   *
   * @param deviceId - the device the root belongs to.
   * @param root - the device's absolute home directory.
   */
  noteDeviceRoot(deviceId: string, root: string): void {
    if (!root.startsWith('/')) return
    this.deviceRoots.set(deviceId, root)
  }

  /**
   * A device's absolute root, asking the device when it has not said yet.
   *
   * The device is the only party that knows what its own `~` means, so the
   * answer has to come from it: a session's root is stored the way the reader
   * typed it, and the mapping built from it has to be an absolute device path
   * — the device's protocol admits nothing else, and the containment check can
   * only compare a path against an absolute root.
   *
   * Asked once: the answer is remembered, so the second caller does not pay for
   * it again, and a device that cannot be reached is asked no more than once.
   *
   * @param deviceId - device to ask.
   * @returns the device's absolute root, or undefined when it cannot be asked.
   */
  async ensureDeviceRoot(deviceId: string): Promise<string | undefined> {
    const known = this.deviceRoots.get(deviceId)
    if (known !== undefined) return known
    const device = this.connections.get(deviceId)
    if (device === undefined) return undefined
    try {
      const probe = await this.probeDevice(device)
      this.noteDeviceRoot(deviceId, probe.home)
      return this.deviceRoots.get(deviceId)
    } catch (error) {
      // A device that cannot be reached has no root to give. The caller falls
      // back to what it had, which is the spelling the reader typed.
      return undefined
    }
  }

  /**
   * The raw assignment for one session, whether or not its device can be served.
   *
   * What separates "this session runs here" from "this session runs on a device
   * we cannot reach": {@link targetForSession} answers undefined for both, and
   * treating the second as the first is how a device session's file operations
   * end up on this machine. Every seam that would otherwise fall back to a local
   * implementation reads this first and refuses instead.
   *
   * Synchronous for the same reason {@link targetForSession} is.
   *
   * @param sessionId - ambient agent id of the executing call.
   * @returns the stored assignment, or undefined when the session is not bound.
   */
  assignmentForSession(sessionId: string): AssignmentView | undefined {
    const assignment = this.bindings.get(sessionId)
    return assignment === undefined ? undefined : { sessionId, ...assignment }
  }

  /**
   * Why a session bound to a device that cannot be served is refused rather than
   * run here.
   *
   * @param deviceId - the device the session is bound to.
   * @returns the refusal text, in the reader's language.
   */
  unservableMessage(deviceId: string): string {
    // What the last refresh recorded, when it skipped this device: a locked
    // group names itself, which is the refusal a reader can act on. Anything
    // else — a device that no longer exists — falls back to the plain answer.
    return this.unservable.get(deviceId)?.reason ?? this.t('route.noDevice', { id: deviceId })
  }

  /**
   * The spawn plan for one session's VISIBLE terminal, or undefined when the
   * session runs locally.
   *
   * Keyed by session identity, never by directory. A device tree's mount
   * directory is shared by every session bound to that device and root, so a
   * directory match cannot tell a bound session from an unbound one whose cwd
   * merely happens to be a mount path — and handing the latter a device shell
   * would run the user's terminal on a machine the session has no binding for.
   *
   * `sessionCwd` is unused for the decision and kept only so the signature
   * mirrors the shell/fs seams; a plan rather than a bare device, because the
   * ssh knowledge — which authentication, which trust decision, which remote
   * line — lives in this package and is not copied to the bridge. The plan is
   * an OPENER rather than a command line for the same reason: the bridge runs
   * the shell over the device transport's own channel, and nothing about that
   * is something it should have to spell.
   *
   * A session whose directory is a mount but which has no assignment is
   * REFUSED rather than given a local shell: the mount is an empty local
   * stand-in, so a local shell there is a dead end that looks like a working
   * terminal, and the user has no way to tell it apart from the device shell
   * they asked for. The failure is raised instead, and the view shows it.
   *
   * @param sessionId - session-backed agent id, the key bindings are written under.
   * @param sessionCwd - the session's own directory, consulted only to tell a
   *   mid-bind session (and a broken one) from a local one.
   * @returns the device shell opener, or undefined when the session is local.
   */
  async interactiveShellPlan(
    sessionId: string,
    sessionCwd?: string,
  ): Promise<DeviceShellPlan | undefined> {
    await this.bindings.refresh()
    let assignment = this.bindings.get(sessionId)
    // Creating a device session and recording its assignment are two round
    // trips, and the visible terminal can attach between them. A session whose
    // cwd is already a mount directory is therefore mid-bind rather than local,
    // so wait briefly for the assignment instead of handing it a local shell it
    // would keep for the rest of the session's life.
    if (assignment === undefined && sessionCwd !== undefined && isUnder(mountBase(), sessionCwd)) {
      for (let attempt = 0; attempt < PENDING_BIND_ATTEMPTS && assignment === undefined; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, PENDING_BIND_WAIT_MS))
        await this.bindings.refresh()
        assignment = this.bindings.get(sessionId)
      }
      if (assignment === undefined) throw new Error(unboundMountMessage(sessionCwd, this.t))
    }
    if (assignment === undefined) return undefined
    // The device cache is filled by the load this method can wait for, so an
    // unknown device here is a device that is GONE (deleted, or its document
    // unreadable) rather than one that has not been read yet. Handing the
    // session a local shell instead would give the reader a prompt on this
    // machine behind a device's name — the same silent split the mount refusal
    // above exists to prevent.
    await this.ensureReady()
    const device = this.connections.get(assignment.deviceId)
    if (device === undefined) {
      const stuck = this.unservable.get(assignment.deviceId)
      if (stuck?.groupId !== undefined) throw new VaultLockedError(stuck.reason, stuck.groupId)
      throw new Error(this.unservableMessage(assignment.deviceId))
    }
    const remoteRoot = assignment.remoteRoot ?? device.remoteRoot
    return deviceShellPlan(device, remoteRoot, this.t)
  }

  /**
   * The local mount directory for one device tree.
   * @param deviceId - device the tree belongs to.
   * @param remoteRoot - directory on that device; null uses the device's own.
   * @returns absolute local directory (not created here — the session's
   *   creation already creates its working directory).
   */
  async mountPath(deviceId: string, remoteRoot: string | null): Promise<string> {
    const device = await this.connectionFor(deviceId)
    const root = remoteRoot === null || remoteRoot.trim() === '' ? device.remoteRoot : remoteRoot.trim()
    return mountFor(deviceId, root)
  }

  /**
   * Connect once and report what answered, for the UI's Test action.
   *
   * With a `remoteRoot` the test also proves the session's directory can be
   * created, which is the other half of "can this session start here": a
   * device can answer ssh and still refuse `mkdir` (read-only home, missing
   * parent, no permission), and finding that out here keeps the new-session
   * dialog from creating a session that cannot work.
   *
   * The result also names the host key dshell trusts for the device, because
   * this action is where that trust is usually created: `accept-new` records an
   * unknown host's key without asking, so without saying so afterwards the one
   * decision the user could verify is also the one they never see. The trust is
   * read before connecting as well, so a key this connection just learned is
   * reported as first contact rather than as an established one.
   *
   * @param deviceId - device to connect to.
   * @param remoteRoot - session directory to also create; null checks nothing.
   * @returns the ready-to-show result line.
   */
  async test(deviceId: string, remoteRoot: string | null = null): Promise<string> {
    // Refreshed first so the answer reflects what is stored NOW, then resolved
    // through the seam every other connection goes through: a device whose
    // credential sits in a locked group is refused with that group's name —
    // the one refusal with a way out. Reading the map directly would answer
    // "unknown device" for a machine the reader can see in the panel.
    await this.refreshDevices()
    const device = await this.connectionFor(deviceId)
    const trustedBefore = trustedHostKey(device.host, device.port)
    const started = Date.now()
    const result = await deviceTransport().exec(
      device,
      'printf "%s|%s|%s" "$(hostname)" "$(id -un)" "$(uname -sr)"',
      { graceMs: 5_000 },
    )
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() !== ''
        ? result.stderr.trim()
        : this.t('test.exitCode', { code: String(result.exitCode ?? 'signal') }))
    }
    const [host, user, system] = result.stdout.trim().split('|')
    const line = this.t('test.connected', {
      user: user ?? '',
      host: host ?? device.host,
      system: system ?? this.t('test.unknownSystem'),
      ms: Date.now() - started,
    })
    const trusted = trustedHostKey(device.host, device.port)
    // Same order the session's own start uses: connect, then make the
    // directory. A refusal here throws with the device's own words.
    if (remoteRoot !== null) await this.ensureRemoteRoot(deviceId, remoteRoot)
    // Third stage: where the device stands on the helper. Deploying is its own
    // action, so this only reports — and records the answer, which is what
    // puts the state on the card without a deployment having been run.
    await this.surveyHelper(deviceId, device)
    return trusted === undefined
      ? line
      : `${line}\n${this.t(trustedBefore === undefined ? 'test.hostKeyFirst' : 'test.hostKeyTrusted', { fingerprint: trusted })}`
  }

  /**
   * Ask the device about its node and its helper, and record the answer.
   *
   * One exec — the same home/node line the runtime's own probe uses, plus the
   * digest of the file this build would deploy there. `test` and `install`
   * therefore agree by construction: both compare the device's copy against
   * this build's artifact rather than against a version string.
   *
   * A failed exec records nothing. The connection check above has already
   * reported the transport failure in its own words, and clearing a status
   * we could not re-read would turn "unknown" into "absent".
   * @param deviceId - device to survey.
   * @param device - the resolved connection.
   */
  private async surveyHelper(deviceId: string, device: DeviceConnection): Promise<void> {
    const artifact = localHelperArtifact()
    const result = await deviceTransport().exec(device, installProbe(artifact.hash), { graceMs: 10_000 })
    if (result.exitCode !== 0) return
    const [home = '', node = '', onDevice = ''] = result.stdout.trimEnd().split('\n')
    const homeDir = home.trim()
    // The device said where its home is; a session's `~`-spelled root is
    // expanded against it, and the answer is kept even when the device turns
    // out to have no Node — the assembled-command lane serves that device
    // perfectly well.
    if (homeDir.startsWith('/')) this.noteDeviceRoot(deviceId, homeDir)
    if (!homeDir.startsWith('/') || node.trim() === '') {
      await this.devices.setHelper(deviceId, {
        state: 'absent',
        expected: artifact.hash,
        message: this.t('install.noNode'),
      })
      return
    }
    const path = helperPathFor(homeDir, artifact.hash)
    const digest = onDevice.trim()
    if (digest === '') {
      await this.devices.setHelper(deviceId, {
        state: 'absent',
        expected: artifact.hash,
        path,
        message: this.t('test.helperAbsent'),
      })
      return
    }
    await this.devices.setHelper(deviceId, digest === artifact.hash
      ? {
          state: 'present',
          onDevice: digest,
          expected: artifact.hash,
          path,
          message: this.t('test.helperPresent'),
        }
      : {
          state: 'mismatch',
          onDevice: digest,
          expected: artifact.hash,
          path,
          message: this.t('install.mismatch'),
        })
  }

  /**
   * Create a session's remote directory, best effort.
   *
   * The local side already creates the session's own directory when the
   * session is created; this is its remote counterpart, so a directory the
   * user named actually exists on the device and the shell can start in it.
   * Failure is not fatal — the interactive shell falls back to the login
   * directory and says so — but a permissions problem still surfaces in the
   * route's error field when it happens here.
   *
   * @param deviceId - device to create the directory on.
   * @param remoteRoot - directory to create; null uses the device's own.
   */
  async ensureRemoteRoot(deviceId: string, remoteRoot: string | null): Promise<void> {
    const device = this.connections.get(deviceId) ?? (await this.refreshDevices(), this.connections.get(deviceId))
    if (device === undefined) throw new Error(this.t('error.unknownDevice', { id: deviceId }))
    const root = remoteRoot === null || remoteRoot.trim() === '' ? device.remoteRoot : remoteRoot.trim()
    if (root.trim() === '' || root.trim() === '~') return
    const result = await deviceTransport().exec(device, `mkdir -p -- ${quote(root)}`, { graceMs: 5_000 })
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() === '' ? this.t('mount.createFailed', { root }) : result.stderr.trim())
    }
  }

  /**
   * Lock one group, or every group, and forget what their keys opened.
   *
   * Two steps that are one operation: the vault drops the key, and the connection
   * map is rebuilt so nothing points at a secret the group can no longer open. A
   * caller that did only the first would leave a session bound to a device in this
   * group holding a connection that resolves to nothing — which fails as a refused
   * login rather than as a locked group.
   */
  async lockGroups(groupId?: string): Promise<void> {
    await this.vault.lock(groupId)
    await this.refreshDevices()
  }

  /**
   * Unlock one group and rebuild what its key can now open.
   *
   * The refresh is the point: a device in this group was skipped while it was
   * locked, and a session bound to it would keep being refused with the reason
   * recorded then — a refusal that outlived its own cause.
   */
  async unlockGroup(groupId: string, token: string): Promise<void> {
    await this.vault.unlock(groupId, token)
    await this.refreshDevices()
  }

  /**
   * Rebuild the connection map from what is stored.
   *
   * Tolerant by design. A device whose credential sits in a locked group has no
   * connection to build, and failing the whole refresh for it would let ONE
   * locked group block every device edit in the panel — the reader who locked a
   * group would find they can no longer add a machine — and, at start-up, take
   * the whole router down with it. Such a device is skipped instead, and the
   * reason is remembered: the seams that refuse a session bound to it are
   * synchronous, so they cannot ask again.
   */
  async refreshDevices(): Promise<void> {
    const views = await this.devices.list()
    const connections = new Map<string, DeviceConnection>()
    const unservable = new Map<string, { reason: string; groupId: string | undefined }>()
    for (const view of views) {
      try {
        const connection = await this.devices.connection(view.id)
        if (connection === undefined) {
          unservable.set(view.id, { reason: this.t('route.noDevice', { id: view.id }), groupId: undefined })
          continue
        }
        connections.set(view.id, connection)
      } catch (error) {
        unservable.set(view.id, {
          reason: error instanceof Error ? error.message : String(error),
          groupId: error instanceof VaultLockedError ? error.groupId : undefined,
        })
      }
    }
    this.connections = connections
    this.unservable = unservable
  }

  private async reload(): Promise<void> {
    // The old design kept a sealed secret on disk, because the external `ssh`
    // could only be handed a path to read. Nothing writes there any more, but an
    // installation upgraded from that design still has the directory — and a host
    // killed rather than stopped may have left plaintext in it. Swept once, here:
    // no later moment would know those files were there, and they are not this
    // process's to keep.
    await this.vault.sweepLegacyRunDir()
    await this.bindings.load()
    await this.refreshDevices()
    await this.adoptMounts()
  }

  /**
   * Give the assignments written before a bind derived its mount the mapping
   * their file operations need.
   *
   * Without one, a session that is visibly on a device — its shell answers from
   * there — reads and writes THIS machine's disk instead, because the file
   * seam refuses to guess a mapping that was never recorded. Those bindings are
   * on disk already and re-binding every one of them is not something a reader
   * can be asked to do, so the derivation that `bind` performs is repeated here
   * once, at load, against the devices it now knows.
   *
   * A device that is gone leaves its assignment alone: the shell path already
   * falls back for it, and inventing a directory name for an unknown device
   * would only add a mapping nothing can honour.
   */
  private async adoptMounts(): Promise<void> {
    const mounts = new Map<string, string>()
    for (const entry of this.bindings.all()) {
      if (entry.mount !== undefined) continue
      const device = this.connections.get(entry.deviceId)
      if (device === undefined) continue
      const root = entry.remoteRoot ?? device.remoteRoot
      const mount = mountFor(entry.deviceId, root.trim().length === 0 ? '~' : root)
      await mkdir(mount, { recursive: true })
      mounts.set(entry.sessionId, mount)
    }
    await this.bindings.adoptMounts(mounts)
  }
}

/** What a device shell needs before it can be opened. */
export interface DeviceShellWindow {
  readonly rows: number
  readonly cols: number
  /** `$TERM` on the device; the bridge names the terminal it is rendering. */
  readonly terminalType: string
}

/**
 * How the bridge opens one session's VISIBLE terminal on its device.
 *
 * An opener rather than a command line, because the bridge has no business
 * knowing how a device is reached — the connection, its credentials and its
 * trust decision are all this package's. It calls `open` with the window it
 * wants and gets a shell back; the shape it consumes is structural, so this
 * package never has to be a dependency of the bridge.
 */
export interface DeviceShellPlan {
  readonly kind: 'device'
  readonly open: (window: DeviceShellWindow) => Promise<DeviceShell>
}

/**
 * The command that puts the far shell into one directory.
 *
 * The root is a DEVICE path, so a `~` in it is the device's own spelling of
 * home — and the far shell is the only one that knows where home is. So the
 * tilde stays OUTSIDE the quotes: quoting the whole word asks for a
 * directory literally named `~`, which no machine has, and the shell lands
 * in the login directory claiming the configured root is missing (see
 * `quoteDevicePath`).
 *
 * A missing directory must not cost the user their terminal. Chaining with
 * `&&` would short-circuit `exec bash` and end the session on a typo, with
 * nothing on screen to explain it; the shell lands in the login directory
 * instead and says why.
 *
 * @param root - the device path to start in; empty means the login dir.
 * @param missing - the line to print when that directory is not there.
 * @returns the command to run before the shell takes over.
 */
export function deviceShellCd(root: string, missing: string): string {
  if (root === '') return ''
  return `cd ${quoteDevicePath(root)} 2>/dev/null || echo ${quote(missing)} >&2; `
}

/**
 * The plan that opens a device shell in one remote directory.
 *
 * `bash -l` (not `--norc`) on purpose: the user's real login shell is what they
 * expect to land in. The bridge overwrites PS1 and PROMPT_COMMAND right after
 * startup for its own settle marker, so the prompt looks the same on every
 * device regardless of the remote profile.
 *
 * @param device - device the session is bound to.
 * @param remoteCwd - directory the shell starts in; empty means the login dir.
 * @param t - this package's bound host copy, for the missing-directory line.
 * @returns the opener the bridge calls with its window.
 */
function deviceShellPlan(device: DeviceConnection, remoteCwd: string, t: DshellSshTranslate): DeviceShellPlan {
  const root = remoteCwd.trim()
  const cd = deviceShellCd(root, t('shell.missingRemoteDir', { root }))
  return {
    kind: 'device',
    open: async window => await deviceTransport().shell(
      device,
      `${cd}exec bash -l`,
      { rows: window.rows, cols: window.cols, term: window.terminalType },
    ),
  }
}

/**
 * Why a session that sits in a mount directory but has no assignment is
 * refused instead of being given a local shell.
 *
 * A mount directory is an empty local stand-in for a device tree, so a local
 * shell (or a local `bash` tool call) there produces a terminal that looks
 * alive and answers nothing. The refusal is the honest outcome, and the message
 * names the two situations that actually produce it.
 *
 * @param sessionCwd - the session's own directory, for the message.
 * @param t - this package's bound host copy.
 * @returns the refusal text.
 */
function unboundMountMessage(sessionCwd: string, t: DshellSshTranslate): string {
  return t('mount.unbound', { cwd: sessionCwd })
}

/**
 * Redirect a bound session's shell commands to its device.
 *
 * Only `resolve` is wrapped: it is the single funnel every caller passes
 * through before `run`/`start`, and it already carries the executor's own
 * defaults, so the rewrite cannot drift from the stock behaviour.
 *
 * The wrap is installed on the prototype that OWNS `resolve`, not on the
 * service object. A service is reachable through several access paths —
 * `ctx.shell` and `ctx.get('shell')` are not the same object once a preset
 * realm is involved — while the prototype holding the method is shared by all
 * of them, so one write there is what actually covers every caller. An
 * own-property wrap on one access path silently routes nothing.
 *
 * @param ctx - host context holding the shell service.
 * @param router - device assignments.
 * @param t - this package's bound host copy, for the mount refusal below.
 * @returns disposer restoring the original method.
 */
export function installShellRouting(ctx: Context, router: SshRouter, t: DshellSshTranslate): () => void {
  const shell = ctx.get('shell')
  if (shell === undefined) return () => {}
  // The seam goes on the PROTOTYPE, not on the service object. A service is
  // reached through more than one access path — `ctx.shell` and `ctx.get`
  // hand back different objects in a preset realm — and `resolve` is an
  // inherited method, so an own-property wrapper would only cover whichever
  // path happened to be used at install time. The prototype that owns
  // `resolve` is shared by every path, which makes it the one place where a
  // single write is guaranteed to be the funnel all callers pass through.
  let owner = Object.getPrototypeOf(shell) as Record<string, unknown> | null
  while (owner !== null && !Object.prototype.hasOwnProperty.call(owner, 'resolve')) {
    owner = Object.getPrototypeOf(owner) as Record<string, unknown> | null
  }
  if (owner === null) return () => {}
  const target = owner as unknown as ShellExecutorShape
  const original = target.resolve
  target.resolve = function resolve(this: unknown, request: ShellExecRequest): ShellExecSpec {
    const spec = original.call(this, request)
    const agent = ctx.agents.currentInitiator()
    const assignment = agent === undefined ? undefined : router.targetForSession(String(agent.id))
    if (assignment === undefined) {
      // A session bound to a device that cannot be served — deleted, or its
      // document unreadable — has no local half to fall back to: running the
      // command here would put a device session's work on this machine, under
      // this machine's permissions, while everything above the seam believes it
      // happened on the device.
      const bound = agent === undefined ? undefined : router.assignmentForSession(String(agent.id))
      if (bound !== undefined) throw new Error(router.unservableMessage(bound.deviceId))
      // A session whose directory is a mount belongs to a device even when the
      // assignment is missing — the device may have been deleted, or a bind may
      // have failed. Running the command here would execute it on this machine
      // inside an empty stand-in directory, so refuse in ssh's place instead.
      if (isUnder(mountBase(), spec.workdir)) throw new Error(unboundMountMessage(spec.workdir, t))
      return spec
    }
    ctx.logger.info(`dshell-ssh: session "${String(agent?.id)}" runs on device "${assignment.device.name}"`)
    // The command and the directory are deliberately left alone. Rewriting the
    // command into an `ssh … bash -lc` line is what this milestone removes, and
    // the workdir stays the session's own path — the mount standing in for the
    // device tree — because that is the path space every caller above this seam
    // speaks: a tool resolved its relative path against it. The translation to a
    // device directory happens in the subprocess seam, where the process
    // actually leaves, so there is one place that knows the mapping rather than
    // two that must agree about it.
    return {
      ...spec,
      // The session's access mode describes what may happen on THIS machine,
      // and nothing runs here any more: the command is served by a helper on the
      // device. Beyond being meaningless locally, an active policy would be
      // actively wrong — `SandboxBashExecutor` confines by wrapping `argv` in a
      // *host* runner program, and that wrapped argv would then be handed to a
      // device that does not have it. Confinement on the device is a later
      // commitment (upstream's `sandbox-ssh` is the model), so for now the
      // command runs there under the device's own policy and says so here.
      ...spec.sandboxPolicy === undefined
        ? {}
        : { sandboxPolicy: { ...spec.sandboxPolicy, mode: 'danger-full-access' } },
    }
  }
  // The argv seam, on the same terms as `resolve` above: the PROTOTYPE that
  // owns the method, so every path that reaches the executor reaches this.
  //
  // The command is the caller's and the DEVICE's shell runs it, but the argv
  // that leaves the host is built by the HOST's shell — and those are not the
  // same program. On a Windows host the executor builds
  // `[C:\…\powershell.exe, -NoLogo, …, -Command, <command>]`, and a device
  // cannot execute that: the path names a file on the host's disk, and the
  // flags are the host shell's. Every device-side command then died on the
  // device with an ENOENT that named a directory the device had never heard
  // of, which is a far worse report than the one the reader gets here.
  //
  // `argv` is the executor's own argv-level seam — the one a confining
  // subclass wraps through `ctx.sandbox.confine` — so replacing it is the
  // documented way to change WHICH shell runs a command, and it keeps the
  // executor's own lifecycle, deadline, environment and output handling
  // around the new argv.
  const argvOwner = findMethodOwner(shell, 'argv')
  if (argvOwner === null) return () => { target.resolve = original }
  const argvTarget = argvOwner as unknown as { argv: (spec: ShellExecSpec) => string[] }
  const originalArgv = argvTarget.argv
  argvTarget.argv = function argv(this: unknown, spec: ShellExecSpec): string[] {
    const agent = ctx.agents.currentInitiator()
    const assignment = agent === undefined ? undefined : router.targetForSession(String(agent.id))
    // No device for this session: the host's own argv is the right one, and
    // this is the whole of the stock behaviour.
    if (assignment === undefined) return originalArgv.call(this, spec)
    // The device's shell runs the caller's command. `bash -c` is the same
    // shape `bash-local` builds, so a POSIX host is unaffected by this and a
    // Windows host stops sending the device a path it cannot execute.
    return ['bash', '-c', spec.command]
  }
  return () => {
    target.resolve = original
    argvTarget.argv = originalArgv
  }
}

/**
 * The prototype that owns a method, or null when the object has none.
 *
 * @param service - the service object the method was reached through.
 * @param name - the method's name.
 * @returns the prototype holding it as an own property.
 */
function findMethodOwner(service: object, name: string): Record<string, unknown> | null {
  let owner = Object.getPrototypeOf(service) as Record<string, unknown> | null
  while (owner !== null && !Object.prototype.hasOwnProperty.call(owner, name)) {
    owner = Object.getPrototypeOf(owner) as Record<string, unknown> | null
  }
  return owner
}