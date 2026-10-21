/**
 * The browser half's device state: one snapshot of the registry plus the
 * session assignments, refreshed from the route after every mutation.
 *
 * Other dshell client plugins (the session picker) reach this through the
 * `dshellSsh` service rather than by importing the module, which is the only
 * collaboration path between client bundles.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { DSHELL_BUNDLE_NAME } from '@nexus-aethra/dshell-std'
import {
  DSHELL_SSH_PATH, type CredentialInput, type CredentialView, type DeviceBinding, type DeviceHelperStatus, type DeviceInput, type DeviceView, type VaultGroupView,
  type SshKeyFile, type TrustedHostKey, type SshRequest, type SshResponse,
} from '../protocol.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Device registry mirror provided by dshell-ssh's browser half. */
    dshellSsh: SshClientService
  }
}

/** What the UI renders from. */
export interface SshSnapshot {
  readonly devices: readonly DeviceView[]
  readonly bindings: readonly DeviceBinding[]
  /** Result line of the last successful connection test. */
  readonly testResult: string | undefined
  /** Helper deployment status from the last install, when one was requested. */
  readonly helper: DeviceHelperStatus | undefined
  /** The vault's groups, with their lock state. */
  readonly groups: readonly VaultGroupView[]
  /** The stored credentials, in creation order. */
  readonly credentials: readonly CredentialView[]
  /** The last refusal or transport failure, shown until the next call. */
  readonly error: string | undefined
  /**
   * The vault group a locked refusal is about, when the last one was.
   *
   * Set by the host alongside such an error, and by the reader asking to be
   * taken to a group. The vault panel consumes it — expanding that group's
   * unlock box — and clears it, so it is a request rather than a fact.
   */
  readonly lockedGroup: { readonly id: string; readonly name: string } | undefined
  /** Whether the host has answered at least once. */
  readonly loaded: boolean
}

const EMPTY: SshSnapshot = {
  devices: [], bindings: [], testResult: undefined, helper: undefined,
  groups: [], credentials: [], error: undefined, lockedGroup: undefined, loaded: false,
}

/** The stock shell's names for the plugins panel, in both shipped languages. */
const PANEL_LABELS = ['插件', 'Plugins']

/** This plugin's row inside the bundle's page, by the package name it shows. */
const SSH_ROW_NAME = '@nexus-aethra/dshell-ssh'

/** How long to keep looking for the plugins panel's next hop, and how often. */
const REVEAL_ATTEMPTS = 40
const REVEAL_STEP_MS = 50

/**
 * Click the innermost element whose text carries `needle`, waiting for it.
 *
 * The plugins panel offers no handles of its own — a row is a styled element
 * whose click handler sits on it — so a row is found by its text and clicked
 * directly; the click bubbles, which is what reaches the handler. The innermost
 * match is the row rather than one of the lists that contains it, which would
 * also contain every other row.
 *
 * Waiting matters: each hop of the path mounts on a frame after the click that
 * asked for it, so looking once would find nothing and give up.
 */
function revealRow(needle: string, then: () => void, attempts = REVEAL_ATTEMPTS): void {
  const candidates = [...document.querySelectorAll<HTMLElement>('button, [role="button"], li, div')]
    .filter(element => (element.textContent ?? '').includes(needle))
  if (candidates.length > 0) {
    candidates.reduce((best, candidate) =>
      candidate.querySelectorAll('*').length < best.querySelectorAll('*').length ? candidate : best).click()
    then()
    return
  }
  if (attempts <= 0) return
  window.setTimeout(() => { revealRow(needle, then, attempts - 1) }, REVEAL_STEP_MS)
}

/** Device registry mirror plus its mutations. */
export class SshClientService extends Service {
  private snapshot: SshSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context) {
    super(ctx, 'dshellSsh')
  }

  getSnapshot = (): SshSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The device one session runs on, or undefined for local execution. */
  deviceOf(sessionId: string): DeviceView | undefined {
    const binding = this.bindingOf(sessionId)
    return binding === undefined
      ? undefined
      : this.snapshot.devices.find(device => device.id === binding.deviceId)
  }

  /** One session's assignment, including any directory override. */
  bindingOf(sessionId: string): DeviceBinding | undefined {
    return this.snapshot.bindings.find(entry => entry.sessionId === sessionId)
  }

  /**
   * Whether a directory is one of this plugin's mount directories.
   *
   * A mount directory stands in for a device tree and every execution seam
   * resolves it back to the device, so it must never become the working
   * directory of a session that is NOT bound to that device. The new-session
   * dialog asks before it reuses a previous session's directory as the local
   * continuity default — that directory can be a mount, and inheriting one is
   * exactly how a "local" session ends up with a remote terminal.
   *
   * @param path - absolute directory to test.
   * @returns whether the path is a mount directory of a current assignment.
   */
  isMountPath(path: string): boolean {
    return this.snapshot.bindings.some(entry => entry.mount === path)
  }

  /**
   * Take the user to this plugin's card in the plugins panel.
   *
   * There is no service for opening that panel: its open state and its selected
   * row are component-local viewing state inside the stock shell, so the only
   * way in is the shell's own controls. Which controls depends on the dsh
   * version — older builds open the panel as a dialog, and the ones in force
   * here mount it as a main-area view behind the sidebar's 插件 nav row, with
   * the config page one level down (bundle row, then this plugin's row). Both
   * paths end at the same place: this plugin's card, scrolled into view. The
   * `data-dshell-card` hook is what makes the landing point exact rather than
   * "somewhere in the plugins tab".
   *
   * Best-effort by nature: it depends on stock control labels and on the bundle
   * row being present. A false return tells the caller to describe the path in
   * words instead.
   *
   * @returns whether the panel was reached.
   */
  revealInSettings(): boolean {
    // The page-shaped panel: a sidebar nav row, then the bundle that carries
    // this plugin, then this plugin's own row. Each hop mounts on a later frame
    // than the click that asked for it, so each is waited for rather than
    // assumed.
    const nav = [...document.querySelectorAll<HTMLElement>('button')]
      .find(candidate => PANEL_LABELS.includes(candidate.getAttribute('aria-label')?.trim() ?? '')
        || PANEL_LABELS.includes(candidate.textContent?.trim() ?? ''))
    if (nav !== undefined) {
      nav.click()
      revealRow(DSHELL_BUNDLE_NAME, () => revealRow(SSH_ROW_NAME, () => {
        window.requestAnimationFrame(() => {
          document.querySelector('[data-dshell-card="ssh"]')?.scrollIntoView({ block: 'center' })
        })
      }))
      return true
    }
    // The dialog-shaped panel of older dsh: one trigger, then the section.
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"][aria-expanded]')
    if (trigger === null) return false
    trigger.click()
    window.requestAnimationFrame(() => {
      const section = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find(candidate => PANEL_LABELS.includes(candidate.textContent?.trim() ?? ''))
      section?.click()
      window.requestAnimationFrame(() => {
        document.querySelector('[data-dshell-card="ssh"]')?.scrollIntoView({ block: 'center' })
      })
    })
    return true
  }

  /** Read the registry. */
  async load(): Promise<void> {
    await this.send({ action: 'list' })
  }

  /** Create or update a device. */
  async save(device: DeviceInput): Promise<void> {
    await this.send({ action: 'save', device })
  }

  /** Remove a device and its stored key. */
  async remove(deviceId: string): Promise<void> {
    await this.send({ action: 'delete', deviceId })
  }

  /**
   * Open one connection and report what answered.
   *
   * Throws on refusal: the caller is usually the new-session dialog, which
   * must not create a session it cannot bind. The same failure is published on
   * the snapshot for the settings card, which shows it instead of throwing.
   *
   * @param deviceId - device to connect to.
   * @param remoteRoot - session directory to also prove creatable.
   */
  async test(deviceId: string, remoteRoot: string | null = null): Promise<void> {
    await this.send({ action: 'test', deviceId, remoteRoot }, { strict: true })
  }

  /** Deploy this build's helper to one device, content-addressed by digest.
   *
   * The reply carries the resulting {@link DeviceHelperStatus}, which the
   * snapshot publishes so the device card can show the deployment's outcome
   * (success, mismatch, no node) and the helper's on-device path.
   */
  async install(deviceId: string): Promise<void> {
    await this.send({ action: 'install', deviceId }, { strict: true })
  }

  /**
   * The private keys in the harness user's `~/.ssh`, for the form's picker.
   *
   * Returned rather than published: this is a property of the home directory,
   * not of the device registry, and putting it on the snapshot would make every
   * unrelated re-render depend on a filesystem read.
   *
   * @returns the keys, empty when there is no `~/.ssh` or nothing in it.
   */
  async listKeys(): Promise<readonly SshKeyFile[]> {
    return (await this.send({ action: 'listKeys' })).keys ?? []
  }

  /**
   * One listed key's contents.
   *
   * @param path - a path from {@link listKeys}.
   * @returns the key text, or undefined when the host refuses the path.
   */
  async readKey(path: string): Promise<string | undefined> {
    return (await this.send({ action: 'readKey', path })).keyBody
  }

  /**
   * What this plugin currently trusts for one device.
   *
   * @param deviceId - device to ask about.
   * @returns the recorded host keys, empty when the device has never connected.
   */
  async hostKeys(deviceId: string): Promise<readonly TrustedHostKey[]> {
    return (await this.send({ action: 'hostKeys', deviceId })).hostKeys ?? []
  }

  /**
   * Drop what is recorded for one device, so the next connection trusts whatever
   * it presents.
   *
   * Deliberately separate from "trust the new one": revoking is the half of the
   * decision a user can take from a trusted channel, and the trust itself only
   * happens on the connection that follows.
   *
   * @param deviceId - device whose record to drop.
   * @returns the keys still recorded afterwards.
   */
  async revokeHostKey(deviceId: string): Promise<readonly TrustedHostKey[]> {
    return (await this.send({ action: 'revokeHostKey', deviceId })).hostKeys ?? []
  }

  /**
   * Create a group.
   *
   * @param name - display name.
   * @param token - the group's token, or null for a PLAIN, unencrypted group.
   */
  async createGroup(name: string, token: string | null): Promise<void> {
    await this.send({ action: 'vaultCreateGroup', name, token }, { strict: true })
  }

  /** Rename a group. Its secrets' shape does not change. */
  async renameGroup(groupId: string, name: string): Promise<void> {
    await this.send({ action: 'vaultRenameGroup', groupId, name }, { strict: true })
  }

  /** Remove a group. Refused while it still holds credentials. */
  async deleteGroup(groupId: string): Promise<void> {
    await this.send({ action: 'vaultDeleteGroup', groupId }, { strict: true })
  }

  /**
   * Unlock a group.
   *
   * Throws on a wrong token, which is the whole reason for using an
   * authenticated cipher: a guess that half-worked would look like a success and
   * then fail as a refused password on a remote host.
   */
  async unlock(groupId: string, token: string): Promise<void> {
    await this.send({ action: 'vaultUnlock', groupId, token }, { strict: true })
  }

  /** Lock one group, or every group when `groupId` is absent. */
  async lock(groupId?: string): Promise<void> {
    await this.send(groupId === undefined
      ? { action: 'vaultLock' }
      : { action: 'vaultLock', groupId })
  }

  /**
   * Ask the vault panel to open one group's unlock box.
   *
   * What a surface that cannot unlock anything itself — a device row whose
   * credential turned out to be locked — offers instead of a dead-end error.
   * The request lives as long as the refusal it belongs to, so the reader can
   * press it again after scrolling away.
   */
  requestUnlock(group: { readonly id: string; readonly name: string }): void {
    this.publish({ ...this.snapshot, lockedGroup: group })
  }

  /**
   * The group one session's device draws its credential from, when that group is
   * locked.
   *
   * Read straight off the snapshot — the chain is device → credential → group,
   * and every link of it is already published. A session whose device's
   * credential cannot be opened has no shell to start, and this is what names
   * the group to open for it.
   */
  lockedGroupForSession(sessionId: string): { readonly id: string; readonly name: string } | undefined {
    const deviceId = this.snapshot.bindings.find(row => row.sessionId === sessionId)?.deviceId
    if (deviceId === undefined) return undefined
    const credentialId = this.snapshot.devices.find(row => row.id === deviceId)?.credentialId
    if (credentialId === undefined) return undefined
    const groupId = this.snapshot.credentials.find(row => row.id === credentialId)?.group
    if (groupId === undefined) return undefined
    const group = this.snapshot.groups.find(row => row.id === groupId)
    return group?.sealed === true && group.locked ? { id: group.id, name: group.name } : undefined
  }

  /**
   * The locked group holding one DEVICE's credential, when there is one.
   *
   * Read from the current state rather than from the last refusal: a refusal is
   * a moment, and the group stays locked after any other call has answered. A
   * button whose target came from the refusal would vanish the moment the
   * reader touched the vault — which is where they are going.
   */
  lockedGroupForDevice(deviceId: string): { readonly id: string; readonly name: string } | undefined {
    const credentialId = this.snapshot.devices.find(row => row.id === deviceId)?.credentialId
    if (credentialId === undefined) return undefined
    const groupId = this.snapshot.credentials.find(row => row.id === credentialId)?.group
    if (groupId === undefined) return undefined
    const group = this.snapshot.groups.find(row => row.id === groupId)
    return group?.sealed === true && group.locked ? { id: group.id, name: group.name } : undefined
  }

  /**
   * Take the user to this plugin's card, with one session's locked group's
   * unlock box already open.
   *
   * The plain {@link revealInSettings} lands the reader beside the vault; this
   * lands them IN it, on the group that is actually stopping their session —
   * which is the difference between a door and a description of one.
   */
  revealUnlockForSession(sessionId: string): boolean {
    const locked = this.lockedGroupForSession(sessionId)
    if (locked !== undefined) this.requestUnlock(locked)
    return this.revealInSettings()
  }

  /**
   * Move a group to token-protected, or off it, re-sealing its credentials.
   *
   * Both directions rewrap in the same request. A policy that applied only to
   * future writes would leave the group half-encrypted with no way to see which
   * rows were the old ones.
   */
  async setToken(groupId: string, token: string): Promise<void> {
    await this.send({ action: 'vaultSetToken', groupId, token }, { strict: true })
  }

  async clearToken(groupId: string): Promise<void> {
    await this.send({ action: 'vaultClearToken', groupId }, { strict: true })
  }

  /** Create or update one credential. */
  async saveCredential(credential: CredentialInput): Promise<void> {
    await this.send({ action: 'credentialSave', credential }, { strict: true })
  }

  /** Remove one credential. Refused while a device still uses it. */
  async deleteCredential(credentialId: string): Promise<void> {
    await this.send({ action: 'credentialDelete', credentialId }, { strict: true })
  }

  /**
   * What one device's host presents right now.
   *
   * Unauthenticated: this is for showing beside the trusted fingerprint so the
   * user can compare them somewhere else, never for trusting.
   *
   * @param deviceId - device to scan.
   * @returns the offered key, or undefined when the host answered nothing.
   */
  async probeHostKey(deviceId: string): Promise<TrustedHostKey | undefined> {
    return (await this.send({ action: 'probeHostKey', deviceId })).probe
  }

  /**
   * Assign a session to a device, or pass null to run it locally.
   *
   * Throws on refusal. A session that stayed unbound while its directory is a
   * device mount is worse than a visible error: nothing routes its commands,
   * so they would run on this machine inside an empty stand-in directory. The
   * dialog keeps itself open on a throw instead of closing over that state.
   *
   * @param remoteRoot - directory to run in on that device; null uses the
   *   device's own.
   * @param mount - local mount directory for that tree; null keeps the
   *   session's file operations local.
   */
  async bind(
    sessionId: string,
    deviceId: string | null,
    remoteRoot: string | null = null,
    mount: string | null = null,
  ): Promise<void> {
    await this.send({ action: 'bind', sessionId, deviceId, remoteRoot, mount }, { strict: true })
  }

  /**
   * The local mount directory for one device tree. The rule lives host-side
   * (it depends on `$DSH_HOME`), so ask rather than deriving it here.
   * @param deviceId - device the tree belongs to.
   * @param remoteRoot - directory on that device; null uses the device's own.
   * @returns the absolute local directory, or undefined if the host refused.
   */
  async mountFor(deviceId: string, remoteRoot: string | null): Promise<string | undefined> {
    const body = await this.send({ action: 'mount', deviceId, remoteRoot }, { strict: true })
    return body.mountPath
  }

  /** Clear the last result line. */
  clearResult(): void {
    if (this.snapshot.testResult === undefined && this.snapshot.error === undefined) return
    this.publish({ ...this.snapshot, testResult: undefined, error: undefined })
  }

  /**
   * One route call. The refusal is always published on the snapshot so a view
   * that renders from it (the settings card) sees it; `strict` additionally
   * throws it, for callers whose flow must not continue — creating a session
   * that was never bound, or closing the dialog that reported the problem.
   * @param request - request body; `list` travels as a GET.
   * @param options - `strict` rethrows the refusal after publishing it.
   * @returns the response body, or a body synthesized from a transport failure.
   */
  private async send(request: SshRequest, options?: { strict?: boolean }): Promise<SshResponse> {
    const strict = options?.strict === true
    let body: SshResponse
    try {
      const response = await fetch(DSHELL_SSH_PATH, {
        method: request.action === 'list' ? 'GET' : 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        ...request.action === 'list' ? {} : { body: JSON.stringify(request) },
      })
      body = await response.json() as SshResponse
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.publish({ ...this.snapshot, error: reason })
      if (strict) throw new Error(reason)
      return { devices: this.snapshot.devices, bindings: this.snapshot.bindings, error: reason }
    }
    this.publish({
      devices: body.devices,
      bindings: body.bindings,
      testResult: body.testResult,
      helper: body.helper,
      // Carried forward when the reply says nothing about the vault, so a device
      // call that knows nothing about groups never blanks the list out from under
      // the panel that is showing it.
      groups: body.groups ?? this.snapshot.groups,
      credentials: body.credentials ?? this.snapshot.credentials,
      error: body.error,
      // Same rule, with one difference: a locked group is answered by EVERY
      // reply that carries the vault face, and the panel consumes it, so it is
      // never carried forward. A refusal that outlived its own reply would
      // re-open an unlock box the reader has already used.
      lockedGroup: body.lockedGroup,
      loaded: true,
    })
    if (strict && body.error !== undefined) throw new Error(body.error)
    return body
  }

  private publish(snapshot: SshSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
