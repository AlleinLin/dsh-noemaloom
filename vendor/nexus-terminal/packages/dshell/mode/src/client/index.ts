import { type Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
// Type-only: pulls the sessions service merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the Conversation SlotMap (input.left / composer.dock seats).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer-owned slots service (ctx.slots) and the
// generic SlotMap interface that constrains the `inject` name string.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `sidebar.brand.*` SlotMap so `sidebar.brand.name` is
// accepted as a registration name string.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the settings SlotMap and the ctx.configForms merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the Plugins-panel SlotMap (`plugins.row.config`).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: pulls the locale service merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `ctx.inputTriggers` service merge; the named types are
// the frozen source contract (`CommandClaim`/`PickOutcome` re-exported there).
import type {
  ClientSessionContext,
  CommandClaim,
  InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { PtyStreamService } from '@nexus-aethra/dshell-terminal-bridge/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  DATA_DIR_FIELD, DEVICE_POLL_FIELD, DSHELL_ENTRY_ID, THEME_FIELD, readDataSettings, type DshellSettings,
} from '../settings.js'
import { type SshSeat } from './block-view.js'
import { createElement, type ReactElement } from 'react'
import { DshellTerminalView, type TerminalViewSeat } from './terminal-view.js'
import { injectTuiCss } from './tui-css.js'
import { applyTabLock } from './terminal-mode-lock.js'
import { toggledChoice, type TuiChoice } from './tui.js'
import { StatusCardBoundary, StatusChip, type PipeSeat, type PipeTicket, type StatusChipInjected, type StatusChipProps } from './status-card.js'
import { DshellLeftControls } from './controls.js'
import { createShellCompletion, ShellCompletionList } from './completion.js'
import { createCommandHints, ShellCommandHint } from './command-hint.js'
import { DshellModeConfigPage } from './config-page.js'
import { DSHELL_BUNDLE_NAME } from '@nexus-aethra/dshell-std'
import { adoptTheme, connectThemeSettings } from './theme.js'
import { adoptShellHelperSettings, connectShellHelperSettings } from './shell-settings.js'
import { adoptDevicePollSettings, connectDevicePollSettings } from './device-poll.js'
import { adoptDataDir, connectDataDirSettings } from './data-dir.js'
import { TerminalModeClient } from './terminal-mode.js'
import { useTerminalModeOn, type DeviceChoiceSeat } from './terminal-mode-switch.js'
import { mountTerminalSection } from './terminal-section.js'
import { DshellRenameDialog, requestRename } from './rename-dialog.js'
import type { PresetSeat } from './creation-panel.js'
import type { DshellModeKey } from './locales.js'
import { en, zh } from './locales.js'
import type { ModelChipFace, ModelDirectoryFace, SessionMode } from './types.js'

// The reference source the rename hop retains a session under. The map is
// merge-extensible, so a package names its own use rather than borrowing
// `workspaceOperation` — the counts are what tell a reader who is holding one.
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** One rename raised from the terminal section's rows. */
    dshellRename: unknown
  }
}

/** The pipe's state before (or without) a buffer service to read it from. */
const EMPTY_PIPE_STATE = { links: [], tickets: [], open: false } as const

/**
 * The device reading with no `dshell-ssh` in the composition: nothing bound, so
 * every terminal is local. One shared value because a store's `getSnapshot`
 * must return the same object until something actually changed.
 */
const NO_DEVICES: ReturnType<DeviceChoiceSeat['snapshot']> = { devices: [], bindings: [], lockedGroup: undefined }

export const name = '@nexus-aethra/dshell-mode/client'

export const inject = ['slots', 'locale', 'sessions', 'dshellPtyStream', 'modelDirectories', 'uiConversation', 'configForms'] as const

/** This package's copy namespace. */
const NS = 'dshellMode'

/** The slash command that hands the surface to the program on the terminal. */
const FULLSCREEN_COMMAND = 'fullscreen'

/**
 * The rows this source contributes to the `/` menu.
 *
 * `fullscreen` sits with the modes because it is the same kind of choice — how
 * the next keystroke is routed — and because a one-off control does not deserve
 * a place in the composer row (see `DshellLeftControls`).
 */
const MODE_MENU_ROWS: readonly { name: string; descriptionKey: DshellModeKey }[] = [
  { name: 'shell', descriptionKey: 'mode.menu.shell' },
  { name: 'agent', descriptionKey: 'mode.menu.agent' },
  { name: FULLSCREEN_COMMAND, descriptionKey: 'tui.enterTitle' },
]

/** Typed aliases → canonical mode. `/terminal` stays an accepted alias. */
const MODE_ALIASES = new Map<string, SessionMode>([
  ['shell', 'shell'],
  ['agent', 'agent'],
  ['terminal', 'shell'],
])

/**
 * The status chip, behind the boundary that keeps a fault in the card off the
 * terminal it floats over.
 *
 * The card projects state owned by four different services; a fault in any of
 * those projections must cost the reader the card and never the terminal. The
 * boundary was written for exactly that and then never wired in — so a thrown
 * render in the card took the whole panel with it.
 */
function BoundedStatusChip(props: StatusChipProps): ReactElement | null {
  return createElement(StatusCardBoundary, null, createElement(StatusChip, props))
}

/**
 * Hide one composer surface from stock sessions.
 *
 * The wrapper owns the only hook the gate needs, so the gated component keeps
 * its own hook order untouched and a session without the flag renders nothing
 * at all — no submit router, no completion list, no ghost hint.
 * @param Real - the surface, which receives the flag seat like everything else.
 * @returns the registration-ready component.
 */
function gated<S extends { modes: TerminalModeClient; sessionId: SessionId | undefined }>(
  Real: (props: S) => ReactElement | null,
): (props: S) => ReactElement | null {
  return function Gated(props: S) {
    // Real must render as a CHILD component: calling it as a function would
    // inline its hooks into this one, and the gate flipping would then change
    // this component's hook count (React #310).
    return useTerminalModeOn(props.modes, props.sessionId) ? createElement(Real, props) : null
  }
}

/**
 * Point one session's stored view preference at a view id, read-modify-write,
 * so the session opens on the terminal instead of dsh's chat fallback.
 *
 * The key and document shape are ui-conversation's own persistence format
 * (`dsh.conversation.<sessionId>`, a JSON object with a `view` member); the
 * store materializes from it after this write, which is what makes the choice
 * stick for a session the reader switches back into.
 * @param sessionId - session whose preference moves.
 * @param view - view id to prefer.
 */

/**
 * `/shell`, `/agent` and `/fullscreen` as first-class client commands. They are
 * NOT host commands: the per-session mode and full-screen stores live in this
 * browser module, so the handlers have to run here. The input-trigger pipeline
 * is the supported client-side entry — a source on `/` contributes menu rows and
 * claims `matchEnter` with a local `CommandClaim` whose `submit` flips the store
 * (no RPC, no durable command lifecycle to pollute the log). Typed args after a
 * shell switch run immediately (`/shell ls -la`). Plain draft text still routes
 * through the capture-phase composer listener; this source owns the slash forms
 * only.
 * @param deps - per-session stores, the main-shell sender, and the full-screen toggle.
 * @returns the trigger source for `ctx.inputTriggers.registerSource`.
 */
function modeSwitchSource(deps: {
  modeFor(sessionId: SessionId): SnapshotStore<SessionMode>
  /** Turn one session's composer the other way, durably. */
  setMode(sessionId: SessionId, next: SessionMode): void
  sendShell(text: string): void
  t: TranslateNS<'dshellMode'>
  isOn(sessionId: SessionId): boolean
  /** Flip one session's full-screen choice; reports whether it is now full. */
  toggleFullScreen(sessionId: SessionId): boolean
}): InputTriggerSource {
  const { t } = deps
  /** Resolve a typed/picked name to its canonical mode (`/terminal` → shell). */
  const canonicalOf = (rawName: string): SessionMode | undefined => {
    const canonical = rawName === 'terminal' ? 'shell' : rawName
    return MODE_ALIASES.has(canonical) ? canonical as SessionMode : undefined
  }
  const isKnown = (name: string): boolean => name === FULLSCREEN_COMMAND || canonicalOf(name) !== undefined
  /**
   * The rows on offer for one session.
   *
   * Full screen belongs to the terminal surface, so it is offered only while the
   * line is routed to the shell: in agent mode Enter sends to the model, and a
   * full-screen program would not be the thing the reader is looking at.
   */
  const rowsFor = (session: ClientSessionContext): readonly { name: string; descriptionKey: DshellModeKey }[] =>
    deps.modeFor(session.sessionId).getSnapshot() === 'shell'
      ? MODE_MENU_ROWS
      : MODE_MENU_ROWS.filter(row => row.name !== FULLSCREEN_COMMAND)
  const fullScreenClaim = (session: ClientSessionContext): { claim: CommandClaim } => ({
    claim: {
      name: FULLSCREEN_COMMAND,
      token: `/${FULLSCREEN_COMMAND}`,
      hint: t('mode.fullscreen.hint'),
      submit: async () => {
        const full = deps.toggleFullScreen(session.sessionId)
        return {
          kind: 'success',
          text: full ? t('mode.fullscreen.on') : t('mode.fullscreen.off'),
        }
      },
    },
  })
  const claimFor = (name: string, session: ClientSessionContext): { claim: CommandClaim } => {
    if (name === FULLSCREEN_COMMAND) return fullScreenClaim(session)
    const next = canonicalOf(name) as SessionMode
    return {
      claim: {
        // 0.1.6 made this required: the catalog name without its slash, which is
        // the key the composer's per-command copy (`hint.*`) is looked up under.
        name: next,
        token: `/${next}`,
        hint: t('mode.switch.hint'),
        submit: async (args) => {
          deps.setMode(session.sessionId, next)
          const rest = args.trim()
          if (next === 'shell' && rest.length > 0) deps.sendShell(rest)
          return {
            kind: 'success',
            text: next === 'shell'
              ? t('mode.switch.shell')
              : t('mode.switch.agent'),
          }
        },
      },
    }
  }
  return {
    trigger: '/',
    name: 'dshell',
    order: 50,
    showGroupTitle: true,
    candidates: async (_session, req) => {
      if (req.position !== 'leading') return []
      if (!deps.isOn(_session.sessionId)) return []
      const query = req.query.trim().toLowerCase()
      return rowsFor(_session)
        .filter(row => row.name.startsWith(query))
        .map(row => ({ name: row.name, description: t(row.descriptionKey), value: row.name }))
    },
    // A menu pick is the common path (typing `/agent` opens the menu, Enter
    // picks the highlighted row). Switching in `onPick` and replacing the
    // token with empty text makes that ONE keystroke with no leftover draft,
    // instead of the stock two-step "insert token, then submit" claim.
    onPick: (pick) => {
      const name = (pick.candidate.value ?? pick.candidate.name).toLowerCase()
      if (name === FULLSCREEN_COMMAND) {
        deps.toggleFullScreen(pick.session.sessionId)
        return { text: '' }
      }
      const next = canonicalOf(name)
      if (next === undefined) return undefined
      deps.setMode(pick.session.sessionId, next)
      return { text: '' }
    },
    // The no-menu path (pasted line, or menu already closed): claim and
    // submit so the composer clears through the normal settlement and the
    // switch reports a notice.
    matchEnter: async (session, line, _signal, envelope) => {
      const trimmed = line.trim()
      const ws = trimmed.search(/\s/)
      const token = ws === -1 ? trimmed : trimmed.slice(0, ws)
      const name = token.slice(1).toLowerCase()
      if (!isKnown(name)) return undefined
      if (!deps.isOn(session.sessionId)) return undefined
      if (envelope.attachments > 0) throw new Error(t('mode.attachmentsUnsupported', { name }))
      return claimFor(name, session)
    },
  }
}

/**
 * Mount the mode store and contribute dshell pieces as entries into the
 * stock composer slot hierarchy. The stock `InputBar` is the visible
 * composer (see dsh `ui-conversation/.../InputBar.tsx`); dshell adds
 * the mode chip to `conversation.input.left` and the block view to the
 * conversation's view cell.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  // Cast through unknown: the 'sessions' key collides across faces in one
  // tsc program (host SessionStore vs client ISessions); see terminal-bridge.
  const sessions = ctx.get('sessions') as unknown as ISessions
  const pty = ctx.get('dshellPtyStream') as PtyStreamService
  const t = ctx.locale.bind(NS)
  // The per-session terminal-mode flag: every dshell composer and view
  // contribution gates on it, so a stock session never sees dshell chrome.
  const modes = new TerminalModeClient(ctx)
  void modes.load()
  // The dictionaries are registered through an effect so a composition that
  // unloads this plugin takes its copy with it.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dshell-mode: dictionaries')
  // Shell-mode completion's shared state: the Tab interceptor in the composer's
  // left controls writes it, the overlay list reads it, both keep the shell's
  // directory through it (see completion.ts).
  const shellCompletion = createShellCompletion()
  // The command hint's store and its debounced history query. The left controls
  // offer drafts to it, the ghost beside the completion list reads it, and the
  // right arrow accepts a chunk of it (see command-hint.ts).
  const commandHints = createCommandHints()
  const uiConversation = ctx.get('uiConversation') as unknown as {
    imageUrl: (sessionId: SessionId, attachment: Parameters<MessageImageLoader>[0]) => Promise<string>
  }
  // The SSH plugin is a sibling row: present in the dshell bundle, absent in a
  // composition that omits it. The block view only needs its device face for
  // the connection screen, and a missing seat must leave the terminal intact —
  // hence deferred injection rather than a required dependency. The seat object
  // is built once so its identity is stable across renders (the view subscribes
  // to it), and it is structural, so this package needs no import of the SSH
  // bundle: only the runtime service key, which is what the cast pins down.
  const sshHost = ctx as unknown as {
    inject(keys: readonly string[], callback: (scope: {
      /**
       * The SSH client service, reduced to what the block view asks of it.
       *
       * Declared with the host-key members returning RECORDS, because that is
       * what the SSH plugin's service really returns — the seat the block view
       * sees is built below, and the reduction to plain fingerprints happens
       * there, once.
       */
      dshellSsh: {
        getSnapshot(): {
          devices: readonly { id: string; name: string }[]
          bindings: readonly { sessionId: string; deviceId: string }[]
          /** The group a locked refusal was about, published for the surfaces. */
          lockedGroup: { readonly id: string; readonly name: string } | undefined
        }
        bind(sessionId: string, deviceId: string | null): Promise<void>
        revealInSettings(): boolean
        revealUnlockForSession(sessionId: string): boolean
        requestUnlock(group: { readonly id: string; readonly name: string }): void
        lockedGroupForSession(sessionId: string): { readonly id: string; readonly name: string } | undefined
        unlock(groupId: string, token: string): Promise<void>
        bindingOf(sessionId: string): { deviceId: string } | undefined
        hostKeys(deviceId: string): Promise<readonly { fingerprint: string }[]>
        probeHostKey(deviceId: string): Promise<{ fingerprint: string } | undefined>
        revokeHostKey(deviceId: string): Promise<unknown>
        subscribe(listener: () => void): () => void
      }
    }) => void): unknown
  }
  // The sidebar's open/close state belongs to dsh's layout service, but
  // dshell must not change it from a bookmark click — the user owns
  // that toggle via the toolbar's "打开/收起侧边栏" button.
  // Navigation belongs to a VIEW OWNER since 0.1.6-alpha.2, and the sessions face
  // lost `openSubagent` with it: a surface that wants a conversation shown asks
  // `uiWorkspace`, which in this composition is dshell's own stand-in. Resolved
  // by key like the sibling seats, so a composition without one leaves those rows
  // inert instead of failing to load.
  const navigationHost = ctx as unknown as {
    inject(keys: readonly string[], callback: (scope: {
      uiWorkspace: { openSession(target: SessionTarget): void }
    }) => void): unknown
  }
  let openConversation: ((target: SessionTarget) => void) | undefined
  navigationHost.inject(['uiWorkspace'], (scope) => {
    openConversation = (target) => { scope.uiWorkspace.openSession(target) }
  })
  let sshSeat: SshSeat | undefined
  /**
   * Subscribers the SSH forwarder below took before the seat arrived.
   *
   * Same story as `deviceListeners`, one service over: `dshellSsh` is reached
   * through `inject`, which answers once the service is up — possibly after a
   * surface that reads it has already been built.
   */
  const sshListeners = new Set<() => void>()
  // The device seat is built ONCE: `useSyncExternalStore` demands a stable
  // `snapshot` identity AND a cached return value, so the projection of the
  // ssh service's own snapshot is memoized by that snapshot's identity.
  let deviceSeat: DeviceChoiceSeat | undefined
  /**
   * Subscribers the forwarder below took before the seat arrived.
   *
   * `dshellSsh` is reached through `inject`, which answers once the service is
   * up — possibly after a surface that reads devices has already been built. A
   * surface handed the seat variable itself would keep the `undefined` it was
   * given and call every session local, so the terminal section is handed a
   * forwarder instead: built once, reading through at call time, and relaying
   * the subscriptions it collected early.
   */
  const deviceListeners = new Set<() => void>()
  const deviceForward: DeviceChoiceSeat = {
    snapshot: () => deviceSeat?.snapshot() ?? NO_DEVICES,
    bind: async (sessionId, deviceId) => { await deviceSeat?.bind(sessionId, deviceId) },
    revealUnlock: group => deviceSeat?.revealUnlock(group) ?? false,
    subscribe: (listener) => {
      deviceListeners.add(listener)
      return () => { deviceListeners.delete(listener) }
    },
  }
  sshHost.inject(['dshellSsh'], (scope) => {
    const ssh = scope.dshellSsh
    let cachedRaw: unknown
    let cachedProjection: ReturnType<DeviceChoiceSeat['snapshot']> = {
      devices: [], bindings: [], lockedGroup: undefined,
    }
    deviceSeat = {
      snapshot: () => {
        const raw = ssh.getSnapshot()
        if (raw !== cachedRaw) {
          cachedRaw = raw
          cachedProjection = {
            devices: raw.devices.map(row => ({ id: row.id, name: row.name })),
            bindings: raw.bindings.map(row => ({ sessionId: row.sessionId, deviceId: row.deviceId })),
            lockedGroup: raw.lockedGroup,
          }
        }
        return cachedProjection
      },
      // The refusal travels to the caller: the creation page reports it, and
      // the session row's own button only needs the republish.
      bind: (sessionId: string, deviceId: string | null) => ssh.bind(sessionId, deviceId),
      // Same two steps as the session row: name the group, then open the panel
      // it lives in. The panel is what mounts the unlock box, so it has to be
      // open before the request means anything.
      revealUnlock: group => {
        ssh.requestUnlock(group)
        return ssh.revealInSettings()
      },
      subscribe: listener => ssh.subscribe(listener),
    }
    // Relay to whoever subscribed before the seat existed (see `deviceForward`).
    ssh.subscribe(() => { for (const listener of [...deviceListeners]) listener() })
    sshSeat = {
      bindingOf: sessionId => ssh.bindingOf(sessionId),
      devices: () => ssh.getSnapshot().devices.map(device => ({ id: device.id, name: device.name })),
      revealSettings: sessionId => ssh.revealUnlockForSession(sessionId),
      // The locked group and its token box: the failure screen reads the first
      // and takes the second, so a session whose group is locked can be opened
      // from where the reader is already looking.
      lockedGroupForSession: sessionId => ssh.lockedGroupForSession(sessionId),
      unlock: async (groupId, token) => { await ssh.unlock(groupId, token) },
      // Fingerprints only: the panel draws two strings, and reducing here means
      // the view never learns a host-key record exists.
      hostKeys: async deviceId => (await ssh.hostKeys(deviceId)).map(key => key.fingerprint),
      probeHostKey: async deviceId => (await ssh.probeHostKey(deviceId))?.fingerprint,
      revokeHostKey: async deviceId => { await ssh.revokeHostKey(deviceId) },
      subscribe: listener => ssh.subscribe(listener),
    }
    // Relay to whoever subscribed before the seat existed (see `sshForward`).
    ssh.subscribe(() => { for (const listener of [...sshListeners]) listener() })
  })
  /**
   * The SSH seat, forwarded.
   *
   * `sshSeat` is built inside the `inject` callback above, and that callback
   * answers once the SSH plugin's service is up — possibly after a surface
   * that reads it has already been built. A surface handed the variable
   * itself would keep the `undefined` it was given: the status chip would
   * have no way to the vault group that is holding a session's credential, and
   * the terminal view would subscribe to nothing.
   *
   * So the seat is handed over as a forwarder instead: built once, reading
   * through at call time, and relaying the subscriptions it collected early.
   * The same shape as `deviceForward` above, for the same reason.
   */
  const sshForward: SshSeat = {
    bindingOf: sessionId => sshSeat?.bindingOf(sessionId),
    devices: () => sshSeat?.devices() ?? [],
    revealSettings: sessionId => sshSeat?.revealSettings(sessionId) ?? false,
    lockedGroupForSession: sessionId => sshSeat?.lockedGroupForSession(sessionId),
    unlock: async (groupId, token) => { await sshSeat?.unlock(groupId, token) },
    hostKeys: async deviceId => await sshSeat?.hostKeys(deviceId) ?? [],
    probeHostKey: async deviceId => await sshSeat?.probeHostKey(deviceId),
    revokeHostKey: async deviceId => { await sshSeat?.revokeHostKey(deviceId) },
    subscribe: listener => {
      sshListeners.add(listener)
      return () => { sshListeners.delete(listener) }
    },
  }
  // The cross-session pipe is the same story one package over: reached by
  // service key, reduced to the reads the status card's pipe rows need. A
  // composition without `dshell-buffer` simply leaves those rows absent.
  //
  // The seat object is built NOW and forwards to the service whenever it
  // arrives, instead of being captured at the moment the service happens to be
  // available: a view registration memoizes its injected props per session
  // binding, so a seat filled in later would never reach the card that asked
  // for it. Subscribe is forwarded the same way, and subscribers already
  // waiting are woken when the service lands.
  type PipeService = {
    getSnapshot(): { links: readonly { id: string; a: string; b: string }[]; tickets: readonly PipeTicket[]; open: boolean }
    subscribe(listener: () => void): () => void
    load(): Promise<void>
    cancel(ticketId: string): Promise<void>
    setOpen(open: boolean): void
  }
  const pipeListeners = new Set<() => void>()
  let pipeService: PipeService | undefined
  const pipeSeat: PipeSeat = {
    getSnapshot: () => pipeService?.getSnapshot() ?? EMPTY_PIPE_STATE,
    available: () => pipeService !== undefined,
    subscribe: (listener) => {
      pipeListeners.add(listener)
      return () => { pipeListeners.delete(listener) }
    },
    load: async () => { await pipeService?.load() },
    cancel: async (ticketId) => { await pipeService?.cancel(ticketId) },
    setOpen: (open) => { pipeService?.setOpen(open) },
  }
  const pipeHost = ctx as unknown as {
    inject(keys: readonly string[], callback: (scope: { dshellBuffer: PipeService }) => unknown): unknown
  }
  pipeHost.inject(['dshellBuffer'], (scope) => {
    pipeService = scope.dshellBuffer
    // Read once AS SOON as the service exists. A card that mounted before it
    // arrived already spent its effect with no service behind the seat, and its
    // dependencies do not change when the service lands — so without this first
    // read the pipe would stay visibly empty until the next unrelated render.
    void pipeService.load()
    const stop = pipeService.subscribe(() => { for (const listener of [...pipeListeners]) listener() })
    for (const listener of [...pipeListeners]) listener()
    return () => {
      stop()
      pipeService = undefined
    }
  })
  // Cast: the modelDirectories merge lives in ui-model-selection's face,
  // which this package must not take as a dependency (the model chip here
  // reads the service read-only; the declarer stays ui-model-selection).
  const models = ctx.get('modelDirectories') as unknown as
    { directoryFor(sessionId: SessionId): ModelDirectoryFace }

  /**
   * One session's composer mode: a local store for the instant answer, seeded
   * from and written back to the identity table.
   *
   * The durable copy is the table's `mode` field, so the mode a reader left a
   * session in is the mode it comes back in — a reload used to start every
   * session at `shell` because the store was the only copy. Seeding is not
   * enough on its own: the table arrives over the network, and a store created
   * before it lands holds the default, so a publish adopts every value it
   * carries. Adoption is safe without tracking writes in flight because the
   * host's answer to a write republishes the table with that write already in
   * it — a publish that disagrees is a newer reading from somewhere else.
   */
  const modeStores = new Map<string, SnapshotStore<SessionMode>>()
  const modeFor = (sessionId: SessionId): SnapshotStore<SessionMode> => {
    const key = String(sessionId)
    let store = modeStores.get(key)
    if (store === undefined) {
      store = createSnapshotStore<SessionMode>(modes.modeOf(key))
      modeStores.set(key, store)
    }
    return store
  }
  const setSessionMode = (sessionId: SessionId, next: SessionMode): void => {
    const key = String(sessionId)
    modeFor(sessionId).set(next)
    void modes.setMode(key, next)
  }
  ctx.effect(() => {
    const adopt = (): void => {
      for (const [key, store] of modeStores) {
        const durable = modes.modeOf(key as SessionId)
        if (store.getSnapshot() !== durable) store.set(durable)
      }
    }
    adopt()
    return modes.subscribe(adopt)
  })

  // The reader's full-screen decisions, one per session and kept for the
  // page's life only. Unlike the mode, this one is deliberately not durable:
  // the choice belongs to the PROGRAM that was on screen (see `tui.ts`), so a
  // reload starts from the host's reading again rather than from a decision
  // made about a program that is no longer running. A view with no session yet
  // gets a store nothing ever writes.
  const noSessionTui = createSnapshotStore<TuiChoice | undefined>(undefined)
  const tuiStores = new Map<string, SnapshotStore<TuiChoice | undefined>>()
  const tuiFor = (sessionId: SessionId): SnapshotStore<TuiChoice | undefined> => {
    const key = String(sessionId)
    let store = tuiStores.get(key)
    if (store === undefined) {
      store = createSnapshotStore<TuiChoice | undefined>(undefined)
      tuiStores.set(key, store)
    }
    return store
  }

  /** Model chip face for one session; undefined while the session is unusable. */
  const modelSeat = (sessionId: SessionId): ModelChipFace | undefined => {
    try {
      const directory = models.directoryFor(sessionId)
      return {
        directory: directory.store,
        load: () => { directory.load().catch(() => { /* surfaced on the store */ }) },
        select: (selection) => directory.select(selection).then(() => true, () => false),
      }
    } catch {
      return undefined
    }
  }

  /** Send one line (or a bare Enter) to the bridge-owned main shell. */
  const sendShell = (text: string): void => {
    // A shell line is the session's start as much as a message is: the page
    // that offers the run location and the preset belongs to the moment before
    // either exists.
    const current = currentSession.get()
    if (current !== undefined) void modes.markStarted(String(current))
    pty.send(text.length === 0 ? '\r' : `${text}\r`)
  }

  // The durable half of the dshell settings — the palette, the shell-helper
  // switches and the data root, one entry config. rc.2 keys a config form by
  // the plugin's profile entry id and resolves the value through the entry's
  // exported schema, so this is the same document the Host settled its data
  // root from, seen from the browser: its value wins over the localStorage
  // pre-paint caches on arrival (another browser's change, or this user's
  // earlier session), and each local change is written back through it.
  // Writing is skipped while the Host reports the document unwritable — the
  // store has already moved, so the choice works for this browser until the
  // mirror next publishes, at which point the Host's value wins, the same
  // precedence the cache has everywhere else.
  const dshellSettings = ctx.configForms.get<DshellSettings>(DSHELL_ENTRY_ID)
  connectThemeSettings((id) => {
    if (!dshellSettings.getSnapshot().writable) return
    void dshellSettings.set(THEME_FIELD, id).catch(() => { /* the form republishes on failure */ })
  })
  connectShellHelperSettings((field, next) => {
    if (!dshellSettings.getSnapshot().writable) return
    void dshellSettings.set(field, next).catch(() => { /* the form republishes on failure */ })
  })
  connectDevicePollSettings((next) => {
    if (!dshellSettings.getSnapshot().writable) return
    void dshellSettings.set(DEVICE_POLL_FIELD, next).catch(() => { /* the form republishes on failure */ })
  })
  const syncSettings = (): void => {
    const snapshot = dshellSettings.getSnapshot()
    if (snapshot.status !== 'ready') return
    adoptTheme(snapshot.value?.theme)
    adoptShellHelperSettings(snapshot.value)
    adoptDevicePollSettings(snapshot.value)
    adoptDataDir(readDataSettings(snapshot.value))
  }
  ctx.effect(() => dshellSettings.subscribe(syncSettings), 'dshell-mode: dshell settings mirror')
  syncSettings()

  // Where dshell keeps its files is a section of the same document, written
  // through the same form: the Host reads it at apply (before it writes
  // anything), so a change is honest only for the next start, and the card says
  // so.
  connectDataDirSettings((next) => {
    if (!dshellSettings.getSnapshot().writable) return
    void dshellSettings.set(DATA_DIR_FIELD, next).catch(() => { /* the form republishes on failure */ })
  })

  // Inject once per page load: the rule that puts dsh's composer away while a
  // full-screen program owns the screen. The decision is per-session and
  // arrives later, as a body attribute.
  injectTuiCss()

  // dshell does not shadow the stock composer bar — the stock InputBar owns
  // the composer surface, so the user gets stock features out of the box:
  // the `/` | `@` trigger popup (commands / skills / files / sessions),
  // context-occupancy ring, model select, attachment surface, subagent bar,
  // and send / stop button. dshell contributes exactly one entry, gated on the
  // terminal-mode flag: the submit router, its legend, and the way into full
  // screen. The mode itself is switched through `/shell` and `/agent`, which
  // need no room in the row.
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    {
      // Own id so dshell can be addressed individually by future owners.
      id: 'dshell-terminal-controls',
      name: 'conversation.input.left',
      order: 100,
      locale: NS,
      inject: (sessionId: SessionId | undefined) => ({
        sessionId,
        mode: sessionId === undefined ? undefined : modeFor(sessionId),
        model: sessionId === undefined ? undefined : modelSeat(sessionId),
        sessions,
        pty,
        completion: shellCompletion,
        hints: commandHints,
        modes,
        setMode: (next: SessionMode) => {
          if (sessionId !== undefined) setSessionMode(sessionId, next)
        },
        submitShell: sendShell,
      }),
    },
    gated(DshellLeftControls),
  ))
  // `/shell`, `/agent` and `/fullscreen` live in the client-side slash pipeline,
  // not on `ctx.commands`: they flip browser state, which no host handler can
  // reach. The two mode forms also write the identity table, so the mode a
  // session was left in survives the page. Registered once; each session
  // controller polls it.
  //
  // The full-screen toggle is the same decision the composer's button used to
  // make, read from the same two places: the host's reading of what is on the
  // terminal, and the reader's decision about it (`tui.ts` — the choice belongs
  // to the PROGRAM, so the next program starts from the reading again).
  const toggleFullScreen = (sessionId: SessionId): boolean => {
    const store = tuiFor(sessionId)
    const next = toggledChoice(pty.state.getSnapshot().tui, store.getSnapshot())
    store.set(next)
    return next.full
  }
  ctx.inject(['inputTriggers'], (scope) => {
    scope.effect(
      () => scope.inputTriggers.registerSource(modeSwitchSource({
        modeFor, setMode: setSessionMode, sendShell, t, isOn: id => modes.isOn(id), toggleFullScreen,
      })),
      'dshell-mode: /shell + /agent + /fullscreen source',
    )
  })
  // dshell-mode's configuration is the `dshell-mode` row's page in the Plugins
  // panel: the panel draws a configure control on the row the bundle declares,
  // and the page opens beside the plugin it configures. A keyed slot takes the
  // row's key — `<bundle package>#<row id>` as the bundle's patch declares it —
  // rather than an id of its own.
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
    {
      name: 'plugins.row.config',
      key: `${DSHELL_BUNDLE_NAME}#dshell-mode`,
      locale: NS,
    },
    DshellModeConfigPage,
  ))
  // The session status chip, in dsh's own header-action band. One chip per
  // terminal session, reporting that session's work — the plan and its phase,
  // the AI terminal, its subagents and background jobs, its pipe requests and
  // buffer transfers. Nothing global lives here: the pipe panel keeps the
  // terminal section's own entry, and a stock session renders no chip at all
  // (the gate is the same one every dshell client surface uses).
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'dshell-status',
        // dsh's own job list sits at order 20 in this band; status reads after it.
        order: 30,
        locale: NS,
        inject: (): StatusChipInjected => ({
          pty,
          sessions,
          pipe: pipeSeat,
          openConversation,
          modes,
          // The vault group that is holding this session's credential, and the
          // way out of it. The chip is where the reader is when the terminal
          // says it cannot start, so this is where the way out belongs.
          ssh: sshForward,
        }),
      },
      gated(BoundedStatusChip),
    ),
  )
  /**
   * Name a session the host's own way.
   *
   * `rename` lives on the session face, so the row retains the session for the
   * one call — the same hop ui-workspace makes for its own rows, under a source
   * of ours so the reference counts name who was holding it.
   * @param sessionId - the session to name.
   * @param title - the raw title; the host normalizes what it accepts.
   */
  const renameSession = async (sessionId: SessionId, title: string): Promise<void> => {
    const result = await sessions.using(
      sessionId,
      { source: 'dshellRename' },
      reference => reference.binding.session.rename(title),
    )
    if (!result.ok) throw new Error(result.error.message)
  }
  // The terminal section's rename dialog. dsh's own answers a request raised
  // through a share ui-workspace keeps to itself, so a row outside its tree
  // registers its own overlay entry instead — dsh's Modal, dsh's rename field,
  // and the host's durable title, which is what every surface reads.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'dshell-terminal-rename',
      locale: NS,
      inject: () => ({ rename: renameSession }),
    },
    DshellRenameDialog,
  ))
  // The block view owns the stock `chat` cell no more. The integrated terminal
  // is an ADDITIVE `conversation.view` entry that exists only while the
  // CURRENT session opted in: a stock session keeps dsh's own tab strip and
  // renderer untouched, and an opted-in one gains 智能终端 beside 会话, with
  // the stored per-session view preference pointed at it so the session opens
  // on the terminal. Shadowing `chat` (the old approach) also forced the
  // bundle patch to disable dsh's `ui-chat` row, which took the stock
  // transcript, its stats pills and its child slots with it.
  // The framework's current session, not a guess: ui-session publishes the
  // binding source the conversation itself renders from, so the flag, the view
  // and the tab lock all speak about the session on screen.
  const currentSession = {
    get: (): SessionId | undefined => {
      const holder = ctx.get('uiSession') as unknown as {
        adapter?: { current?: { value?: { key?: SessionId } } }
      } | undefined
      return holder?.adapter?.current?.value?.key
    },
    subscribe: (listener: () => void): (() => void) => {
      const holder = ctx.get('uiSession') as unknown as {
        adapter?: { current?: { subscribe?: (l: () => void) => () => void } }
      } | undefined
      const source = holder?.adapter?.current
      return typeof source?.subscribe === 'function' ? source.subscribe(listener) : () => {}
    },
  }
  /** dsh's own default view id: taking it is what makes the terminal the view. */
  // The preset roster, reached through the remote face the same way this package
  // reaches every other host service; read structurally so a composition
  // without it leaves the page's preset group empty instead of failing.
  const remotePresets = (): {
    list(): Promise<{ ok: boolean; value?: { presets?: readonly Record<string, unknown>[] }; error?: { message?: string } }>
    select(sessionId: string, preset: string): Promise<{ ok: boolean; error?: { message?: string } }>
  } | undefined => {
    // The face is a service of its own (`remote.agentPresets`) as well as a
    // member of `remote`; ui-agent-preset injects the dotted key, so read that
    // first and fall back to the parent.
    const direct = ctx.get('remote.agentPresets') as unknown as {
      list(): Promise<{ ok: boolean; value?: { presets?: readonly Record<string, unknown>[] }; error?: { message?: string } }>
      select(sessionId: string, preset: string): Promise<{ ok: boolean; error?: { message?: string } }>
    } | undefined
    if (direct !== undefined) return direct
    return (ctx.get('remote') as unknown as {
      agentPresets?: {
        list(): Promise<{ ok: boolean; value?: { presets?: readonly Record<string, unknown>[] }; error?: { message?: string } }>
        select(sessionId: string, preset: string): Promise<{ ok: boolean; error?: { message?: string } }>
      }
    } | undefined)?.agentPresets
  }
  const presets: PresetSeat = {
    list: async () => {
      const face = remotePresets()
      if (face === undefined) return []
      const result = await face.list()
      if (!result.ok) throw new Error(result.error?.message ?? 'the preset roster is unavailable')
      return (result.value?.presets ?? []).map(row => ({
        id: String(row['id'] ?? row['name'] ?? ''),
        name: String(row['name'] ?? row['id'] ?? ''),
      })).filter(row => row.id.length > 0)
    },
    select: async (sessionId, id) => {
      const face = remotePresets()
      if (face === undefined) throw new Error('the preset service is not composed')
      const result = await face.select(sessionId, id)
      // A refusal is the answer, not a no-op: only a session that has not
      // started can take a preset, and the caller shows the host's reason.
      if (!result.ok) throw new Error(result.error?.message ?? 'the preset was refused')
    },
  }
  const TERMINAL_VIEW_ID = 'chat'
  let disposeView: (() => void) | undefined
  let viewSession: string | undefined
  // The workspace registry, read through `ctx.get` because a composition
  // without the workspace controller simply has no terminal workspace and the
  // rule below then opts nothing in.
  const workspaceSeat = ctx.get('workspaces') as unknown as {
    list: {
      getSnapshot(): {
        readonly items: readonly {
          readonly workspaceId: string
          readonly path: string
          readonly sessionIds: readonly SessionId[]
        }[]
      }
      subscribe(listener: () => void): () => void
    }
  } | undefined
  /**
   * The workspace whose sessions are terminal sessions by construction.
   *
   * Found by the id the section recorded when it adopted the directory, and
   * failing that by the directory itself: adoption is idempotent host-side, so
   * a recorded id can be stale while the path still names the same workspace.
   * @returns the workspace row, or undefined while the list has not arrived.
   */
  const terminalWorkspace = (): { readonly workspaceId: string; readonly sessionIds: readonly SessionId[] } | undefined => {
    const items = workspaceSeat?.list.getSnapshot().items ?? []
    const recorded = modes.getSnapshot().workspaceId
    const root = modes.root()
    return items.find(item => recorded !== undefined && item.workspaceId === recorded)
      ?? items.find(item => root.length > 0 && item.path === root)
  }
  ctx.effect(() => {
    const sync = (): void => {
      const current = currentSession.get()
      // A session inside the terminal section's own workspace is a terminal
      // session by construction: the sidebar carried that choice when it adopted
      // the directory, and dsh's own 新会话 targets whichever workspace is open.
      // Membership is the test, not the directory. Every terminal session runs
      // in the same one — and so can a stock conversation — so the cwd equality
      // this replaces silently converted any session that happened to start in
      // the home directory.
      if (current !== undefined && !modes.isOn(current)
        && terminalWorkspace()?.sessionIds.includes(current) === true) {
        const cwd = sessions.list.getSnapshot().byId[current]?.cwd
        void modes.set(String(current), true, { origin: 'workspace', ...cwd === undefined ? {} : { cwd } })
      }
      const wanted = current !== undefined && modes.isOn(current) ? String(current) : undefined
      // Re-assert the lock on every pass: the strip may have rendered after the
      // previous one, and this runs on session, flag and slot-ledger changes.
      const locked = wanted !== undefined
      applyTabLock(ctx, locked, t('view.terminal'))
      if (typeof requestAnimationFrame === 'function') {
        // React commits the strip after this listener returns; one frame later
        // the element the lock needs is in the document.
        requestAnimationFrame(() => { applyTabLock(ctx, locked, t('view.terminal')) })
      }
      if (wanted === viewSession) return
      disposeView?.()
      disposeView = undefined
      viewSession = wanted
      if (wanted === undefined) return
      disposeView = ctx.slots.register(
        {
          // The SAME id as dsh's chat view, one priority lower: rendering
          // resolves the shadowing winner, so an opted-in session renders the
          // terminal without writing any view preference — the per-session
          // selection store belongs to ui-conversation and cannot be reached
          // from here, and a preference written after it materialized is too
          // late (which is why a freshly created session used to open on the
          // stock conversation). The stock entry's tab is hidden by the lock.
          id: TERMINAL_VIEW_ID,
          name: 'conversation.view',
          priority: -1,
          order: 1,
          locale: NS,
          label: () => t('view.terminal'),
          inject: (sessionId: SessionId | undefined): TerminalViewSeat => ({
            sessionId,
            pty,
            sessions,
            ssh: sshForward,
            pipe: pipeSeat,
            // Attachments arrive as opaque refs; the conversation service owns the
            // only sanctioned way to turn one into a URL.
            loadImage: sessionId === undefined
              ? undefined
              : (attachment) => uiConversation.imageUrl(sessionId, attachment),
            openConversation,
            device: {
              snapshot: () => deviceSeat?.snapshot() ?? NO_DEVICES,
              bind: (id: string, deviceId: string | null) => deviceSeat?.bind(id, deviceId) ?? Promise.reject(new Error('dshell-ssh is not composed')),
              revealUnlock: group => deviceSeat?.revealUnlock(group) ?? false,
              subscribe: (listener: () => void) => deviceSeat?.subscribe(listener) ?? (() => {}),
            },
            presets,
            modes,
            tui: sessionId === undefined ? noSessionTui : tuiFor(sessionId),
          }),
        },
        DshellTerminalView,
      )
      // The Host titled this session when it opted in, so its summary is no
      // longer blank there; the browser's own fold only clears `blank` on a
      // turn/start, so without a list refresh the workspace would keep treating
      // this session as its reusable blank draft and `新会话` would keep
      // selecting it. Refreshing once, right after the opt-in, is what makes
      // `新会话` mint a new session again.
      void sessions.refresh().catch(() => { /* the next list read retries */ })
    }
    const disposeList = sessions.list.subscribe(sync)
    const disposeModes = modes.subscribe(sync)
    // The displayed session is what this whole effect is about, so the
    // framework's own binding is the primary trigger; the slot ledger is
    // watched too because the strip re-renders when entries change and the
    // chat tab must be re-hidden each time it does.
    const disposeCurrent = currentSession.subscribe(sync)
    // The workspace list decides membership, and it arrives after the session
    // list on a cold page: without this the first pass finds no workspace and
    // the session dsh just created stays a stock conversation.
    const disposeWorkspaces = workspaceSeat?.list.subscribe(sync)
    const disposeSlots = ctx.slots.subscribe('conversation.view', () => {
      applyTabLock(ctx, viewSession !== undefined, t('view.terminal'))
    })
    sync()
    return () => {
      disposeList()
      disposeModes()
      disposeCurrent()
      disposeWorkspaces?.()
      disposeSlots()
      disposeView?.()
      disposeView = undefined
      viewSession = undefined
      applyTabLock(ctx, false, t('view.terminal'))
    }
  }, 'dshell-mode: terminal view for opted-in sessions')

  /**
   * Bring a terminal session the browser merely RESTORED back to life.
   *
   * Revealing a Session does not materialize one: `sessions.retain` resolves an
   * address "without materializing a Session", and the stock composer asks for
   * an Agent only when a message is sent. dsh's own views never notice — a chat
   * transcript renders from the log, and the first send builds the Agent — but a
   * terminal binds its shell on sight, so a session restored by a reload (or by
   * a restart of the harness) had no Agent: the bind failed with "no live
   * agent", the retry budget was spent, and a line typed into the dead terminal
   * was swallowed.
   *
   * A failed bind is therefore the signal. The ask is `session.create` with an
   * explicit identity — what dsh's own workspace open does to reuse a blank
   * session — which RESUMES the persisted one, Agent included, instead of
   * starting a new session under the same id. Then the terminal gets a fresh
   * retry budget, because the failures it spent were not its own.
   *
   * One ask per session per outage: `asked` is cleared only once the shell is
   * up again, so a later failure (another restart) is repaired the same way.
   */
  ctx.effect(() => {
    const asked = new Set<string>()
    const review = (): void => {
      const current = currentSession.get()
      const sessionId = current === undefined || !modes.isOn(current) ? undefined : String(current)
      if (sessionId === undefined) {
        asked.clear()
        return
      }
      const state = pty.state.getSnapshot()
      if (state.sessionId !== sessionId) return
      // A live connection is the answer, and clears the record so a LATER
      // outage (another restart) is repaired the same way.
      if (state.status === 'open') {
        asked.delete(sessionId)
        return
      }
      // The failure report is what makes the ask worth making: a first bind
      // still in flight has no reason yet, and the retry loop keeps the status
      // at 'connecting' even once its budget is gone — which is exactly the
      // state this has to notice.
      if (state.reason === undefined) return
      if (asked.has(sessionId)) return
      // The Session's own directory is part of the ask — the Host refuses a
      // resume that names a different one. dsh's list is the authority on it;
      // the identity record is the fallback for the window before that list has
      // answered, which on a cold page is the window the failure lands in.
      const cwd = sessions.list.getSnapshot().byId[sessionId as SessionId]?.cwd
        ?? modes.record(sessionId)?.cwd
      if (cwd === undefined) return
      asked.add(sessionId)
      void (async () => {
        try {
          await sessions.create({ sessionId: sessionId as SessionId, cwd })
        } catch {
          // The list stays the authority on whether the Agent arrived, and the
          // terminal's own notice reports what the connection made of it.
        }
        const now = pty.state.getSnapshot()
        if (now.sessionId === sessionId && now.status !== 'open' && now.status !== 'connecting') {
          pty.reconnect()
        }
      })()
    }
    const disposePty = pty.state.subscribe(review)
    const disposeCurrent = currentSession.subscribe(review)
    const disposeList = sessions.list.subscribe(review)
    // The table decides both the gate (`isOn`) and the fallback directory, and
    // it arrives over the network after the first failure has already been
    // reported.
    const disposeModes = modes.subscribe(review)
    review()
    return () => {
      disposePty()
      disposeCurrent()
      disposeList()
      disposeModes()
    }
  }, 'dshell-mode: make a restored terminal session live')

  // The sidebar's terminal block: one icon in the 「工作区」 header row that
  // adopts dshell's terminal directory as a workspace and opens a session in
  // it. What makes those sessions terminal sessions is the record this package
  // writes for them — the button records `origin: 'section'` itself, and a
  // session dsh creates inside the same workspace is adopted by membership.
  // The distinction is visible in the sidebar, and no per-session switch is
  // needed to make it.
  ctx.effect(() => {
    const workspaces = ctx.get('workspaces') as unknown as {
      create(input: { path: string }): Promise<{ workspaceId: string }>
      list: {
        getSnapshot(): { items: readonly { workspaceId: string; path: string }[] }
        subscribe(listener: () => void): () => void
      }
    } | undefined
    if (workspaces === undefined) return () => {}
    try {
      return mountTerminalSection({
        modes,
        sessions,
        currentSession,
        workspaces,
        devices: deviceForward,
        pipe: pipeSeat,
        requestRename,
        openSession: (sessionId: SessionId) => { openConversation?.(sessionId as unknown as SessionTarget) },
        // `session.create` and not the workspace open: opening a workspace
        // reuses its blank draft, and a terminal session stays blank (it logs
        // no turn), so `+` would keep returning the session already on screen.
        // Bound, because `create` is a prototype method that reads `this`, and
        // re-stated because the contract brands the workspace id with a type
        // this package does not depend on.
        createSession: async (workspaceId: string) => {
          const createIn = sessions.create.bind(sessions) as unknown as (
            opts: { workspaceId: string },
          ) => Promise<SessionId>
          try {
            return await createIn({ workspaceId })
          } catch (error: unknown) {
            console.warn('dshell: could not create a terminal session', error)
            return undefined
          }
        },
        t,
      })
    } catch (error) {
      console.warn('dshell: mounting the terminal block button failed', error)
      return () => {}
    }
  }, 'dshell-mode: sidebar terminal block')
  // Shell-mode path completion's list. It rides the same floating layer inside
  // the composer card as dsh's own trigger menu (the one wildcard-free seat for
  // something that appears above the input line without pushing the layout);
  // the composer's Tab interceptor writes the state it reads.
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register(
    {
      name: 'conversation.input.overlay',
      id: 'dshell-completion',
      order: 10,
      locale: NS,
      inject: (sessionId: SessionId | undefined) => ({ completion: shellCompletion, modes, sessionId }),
    },
    gated(ShellCompletionList),
  ))
  // The command hint, in the same floating layer. The seat is a `list`, so a
  // second occupant is additive rather than a collision, and the two readings
  // stay separate components: the list floats above the card, the hint sits at
  // the caret. The left controls offer drafts to it and the right arrow accepts
  // one word of it (see command-hint.ts).
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register(
    {
      name: 'conversation.input.overlay',
      id: 'dshell-command-hint',
      order: 11,
      locale: NS,
      inject: (sessionId: SessionId | undefined) => ({ hints: commandHints, modes, sessionId }),
    },
    gated(ShellCommandHint),
  ))
  // The composer dock's stats pills are stock ui-chat's again: dshell no
  // longer disables that row, so re-registering the same readings here would
  // draw them twice.
}
