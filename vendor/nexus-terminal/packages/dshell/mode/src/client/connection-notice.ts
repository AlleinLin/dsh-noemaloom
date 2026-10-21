/**
 * What a broken terminal connection looks like.
 *
 * A device session's terminal runs on the device, so "cannot connect" is not
 * an exception anywhere in this program — it is a channel that closes after
 * saying why. Which of two very different situations that is, only the
 * host can tell: a shell that HAD reached a prompt and then lost its link
 * deserves a marker appended to the output the user was reading, while a shell
 * that never came up has nothing to append to and deserves a screen of its
 * own. `ready` (host-reported) is that distinction, and {@link connectionView}
 * is the single place it becomes a presentation.
 *
 * Nothing here talks to the wire: the caller passes the facts plus the two
 * actions, so the rules stay in one readable function.
 */

import { createElement, useEffect, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PtyStreamState } from '@nexus-aethra/dshell-terminal-bridge/client'
import { useDshellTheme, type Theme } from './theme.js'

/** The bound translator of this package's namespace. */
type ModeTranslate = TranslateNS<'dshellMode'>

/** What the view should draw for one session's connection state. */
export type ConnectionView =
  | { kind: 'none' }
  /**
   * The intermediate screen: a device session's terminal is being established
   * (`connecting`) or never succeeded (`failed`). Drawn over the seat, because
   * there is nothing behind it worth reading.
   */
  | {
      kind: 'panel'
      /**
       * `unsupported` is not a failure to retry: the host machine has no shell
       * this terminal can run, so the screen says so and offers the one way
       * forward instead of a retry that cannot work.
       */
      phase: 'connecting' | 'failed' | 'unsupported' | 'hostKey'
    }
  /**
   * A line appended after the output: either the link is up but the shell has
   * not answered, or a working terminal's connection ended.
   */
  | { kind: 'notice'; tone: 'connecting' | 'failed' }

/** The session facts the decision needs. */
export interface ConnectionFacts {
  /** The wire state for the current session. */
  status: PtyStreamState['status']
  /** Whether this shell ever reached a prompt (host-reported). */
  ready: boolean
  /** Automatic reconnect attempts spent. */
  attempt: number
  /** Whether the session is bound to a device; local sessions never get a panel. */
  bound: boolean
  /**
   * Host-reported: this machine cannot host a local shell.
   *
   * Checked FIRST, before every other rule, because it outranks them: a Windows
   * host makes the retry button useless and the device name irrelevant, and the
   * reader's real question is not "why did it fail" but "what can I do instead".
   */
  localUnsupported: boolean
  /**
   * Host-reported: this failure is one the user can act on.
   *
   * `hostKey` is checked before every other rule and only for a bound session,
   * because it is the one failure where the retry button is not just useless but
   * misleading: the device will refuse again, identically, until the record is dropped
   * deliberately. `passphrase` does NOT get a screen of its own — the remedy is
   * re-entering a secret in the device form, and this panel has no business
   * being where that form lives.
   */
  failure: PtyStreamState['failure']
}

/**
 * Turn the wire state into the one thing to draw.
 *
 * Everything here turns on one fact: whether the session is BOUND to a device.
 * A bound session's terminal is a channel to a device — a handshake over a
 * network that takes seconds, that can stall, and that has a host on the far end
 * worth naming — so its startup is an event the user needs a screen for. A local
 * session's terminal is a fork of this very process, up in milliseconds, with
 * nothing to narrate and nobody to blame.
 *
 * The rules, in order:
 *  - a bound session that has never reached a prompt keeps the intermediate
 *    screen while it is connecting, and switches it to the failure form once
 *    the host says the shell is gone;
 *  - a bound session that HAD reached a prompt shows only the end-of-output
 *    marker, so the output the user was reading stays where it is;
 *  - a local session never gets the intermediate screen, and its first bind is
 *    not announced either — a notice flashing on every session switch is noise.
 *    A local RETRY is announced, because that only happens after something
 *    failed, and the notice is where the failure and its count stay readable.
 *
 * @param facts - the session's connection state.
 * @returns what to render.
 */
export function connectionView(facts: ConnectionFacts): ConnectionView {
  const { status, ready, attempt, bound, localUnsupported, failure } = facts
  // Only for a LOCAL session: a device session runs its shell on the device,
  // so the host platform is not what stands between the reader and a prompt.
  if (localUnsupported && !bound && status !== 'idle') return { kind: 'panel', phase: 'unsupported' }
  // A changed host key needs a decision, and only a device can present one. It
  // outranks the failed-connection form because that form's answer — retry — is
  // precisely what cannot work here.
  if (bound && failure === 'hostKey' && status !== 'idle') return { kind: 'panel', phase: 'hostKey' }
  if (status === 'idle') return { kind: 'none' }
  if (status === 'connecting') {
    if (bound) {
      // Never answered: this is the handshake the intermediate screen exists
      // for. Already answered once: the user was reading output, so say it at
      // the end of that output instead of covering it — and say "connecting",
      // not "exited", because a rebind of a live shell is not a death.
      return ready
        ? { kind: 'notice', tone: 'connecting' }
        : { kind: 'panel', phase: 'connecting' }
    }
    return attempt > 0 ? { kind: 'notice', tone: 'connecting' } : { kind: 'none' }
  }
  if (status === 'open') {
    // The wire is up but the shell has not answered: a device that accepts the
    // connection and then stalls — the usual shape of a half-dead host, or of
    // a dead device link. A local shell that has
    // not answered yet is simply still starting.
    return bound && !ready ? { kind: 'notice', tone: 'connecting' } : { kind: 'none' }
  }
  // closed | error
  if (bound && !ready) return { kind: 'panel', phase: 'failed' }
  return { kind: 'notice', tone: 'failed' }
}

/** Whole seconds since `from`, re-rendered once a second while mounted. */
function useElapsed(from: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [from])
  return Math.max(0, Math.floor((now - from) / 1000))
}

/** A button that reads as part of the terminal rather than of a dialog. */
function actionStyle(theme: Theme, primary: boolean): CSSProperties {
  return {
    fontFamily: 'inherit',
    fontSize: 12,
    lineHeight: 1.4,
    padding: '4px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    border: `1px solid ${primary ? theme.accentBorder : theme.borderStrong}`,
    background: primary ? theme.accentFaint : 'transparent',
    color: primary ? theme.accentText : theme.muted,
  }
}

/** The diagnostic line, set apart so it reads as the machine's words. */
function detailStyle(theme: Theme): CSSProperties {
  return {
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 1.5,
    color: theme.muted,
    wordBreak: 'break-all',
    borderLeft: `2px solid ${theme.danger}`,
    paddingLeft: 8,
  }
}

/** The actions a connection failure offers. */
interface ConnectionActions {
  /** Try the connection again now, on a fresh retry budget. */
  onRetry: () => void
  /**
   * Open the device settings. Returns false when the shell's settings entry
   * could not be found, in which case the component states the path in words
   * instead of leaving a button that does nothing.
   */
  onSettings?: (() => boolean) | undefined
}

/**
 * The "go to settings" button, plus the hint to show when it cannot reach the
 * panel. Hooks are unconditional: the caller always renders both slots.
 */
function useSettingsLink(
  t: ModeTranslate,
  theme: Theme,
  onSettings: (() => boolean) | undefined,
  sessionKey: string | undefined,
  primary = false,
): { node: ReactElement | null; hint: string | undefined } {
  const [hint, setHint] = useState<string | undefined>(undefined)
  // A different session's failure is a different situation.
  useEffect(() => { setHint(undefined) }, [sessionKey])
  const node = onSettings === undefined
    ? null
    : createElement('button', {
      type: 'button',
      style: actionStyle(theme, primary),
      onClick: () => {
        if (onSettings() !== true) setHint(t('connection.settingsHint'))
      },
    }, t('connection.goSettings'))
  return { node, hint }
}

/** Props of the intermediate screen. */
export interface ConnectionPanelProps extends ConnectionActions {
  /** Device display name, when the session is bound to one; undefined otherwise. */
  device: string | undefined
  /** `connecting` while the shell has not answered; `failed` once it cannot. */
  phase: 'connecting' | 'failed' | 'unsupported' | 'hostKey'
  /** Why it failed, as the host reported it. */
  reason: string | undefined
  /** The connection diagnostic found in the terminal output, if any. */
  detail: string | undefined
  /** When the current attempt started, for the elapsed counter. */
  since: number
  /** Automatic attempts spent, and the budget they come from. */
  attempt: number
  maxAttempts: number
  /** Whether the automatic retries are spent, so the failure reads as final. */
  exhausted: boolean
  /** Identifies the session, so a switch clears the settings hint. */
  sessionKey: string | undefined
  /** The bound translator for this package's copy. */
  t: ModeTranslate
  /**
   * `hostKey` only: what this plugin currently trusts, and what the device
   * claims instead.
   *
   * Both are fetched when this screen mounts, not before, because the scan opens
   * a connection to the very host whose identity is in question — it is only
   * worth paying for once the reader is already looking at the answer.
   */
  hostKeys?: HostKeyFacts | undefined
  /**
   * The vault group whose lock refused this spawn, when that is the cause.
   *
   * The one failure whose remedy is on this screen: the session's credential is
   * sealed in that group, the group is locked, and its token is the only thing
   * that opens it. Offered here rather than only in the settings panel because
   * the reader is already here, and a session that cannot start is not the
   * moment to send them hunting for a panel.
   */
  lockedGroup?: { readonly id: string; readonly name: string } | undefined
  /** Unlock {@link lockedGroup} with the token typed on this screen. */
  onUnlock?: ((token: string) => Promise<void>) | undefined
}

/** The two fingerprints a changed host key has to be judged against. */
export interface HostKeyFacts {
  /** What this plugin recorded, which the device refused. */
  trusted: readonly string[]
  /**
   * What the device presents now.
   *
   * Unauthenticated: it came from the same channel that is under suspicion, so
   * it is shown for COMPARISON against a fingerprint the reader obtained some
   * other way, and never as something to accept on sight.
   */
  claimed: string | undefined
  /** True once both sides are known; false while either is still loading. */
  ready: boolean
}

/**
 * Two fingerprints side by side, so the comparison the screen is asking for is
 * the comparison the eye actually makes.
 *
 * @param t - this package's bound copy, for the two labels.
 * @param theme - the resolved theme.
 * @param facts - the two sides; nothing is drawn until both are known.
 * @returns the pair, or null while it is still loading.
 */
function fingerprintPair(t: ModeTranslate, theme: Theme, facts: HostKeyFacts | undefined): ReactElement | null {
  if (facts === undefined || !facts.ready) return null
  const box = (label: string, value: string): ReactElement => createElement('div', {
    style: { flex: '1 1 150px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 },
  },
    createElement('span', { style: { fontSize: 11, color: theme.muted } }, label),
    createElement('span', {
      style: { fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', color: theme.text },
    }, value),
  )
  return createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 2 } },
    box(t('connection.hostKey.trusted'), facts.trusted[0] ?? t('connection.hostKey.none')),
    box(t('connection.hostKey.claimed'), facts.claimed ?? t('connection.hostKey.none')),
  )
}

/**
 * The token box for a spawn a locked vault group refused.
 *
 * The refusal names the group and nothing else can change the answer, so the
 * box that takes its token belongs on the failure screen rather than in the
 * settings panel the reader would otherwise have to find. A wrong token is
 * answered by the host and shown beside the box — a guess that half-worked
 * would look like a success and then fail as a refused password on the device
 * — and a successful unlock reconnects through the caller's retry, so the
 * terminal comes up on its own once the door opens.
 *
 * Exported for the failure screen's tests: it takes the theme as a prop, so it
 * renders without the store hook the panel around it reads.
 */
export function LockedDoor(props: {
  group: { readonly id: string; readonly name: string }
  theme: Theme
  onUnlock: (token: string) => Promise<void>
  t: ModeTranslate
}): ReactElement {
  const { group, theme, onUnlock, t } = props
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const submit = (): void => {
    if (token === '' || busy) return
    setBusy(true)
    void onUnlock(token).then(() => {
      // The panel goes away with the shell coming up behind it, so the box is
      // only reset on the way out here.
      setBusy(false)
    }, (reason: unknown) => {
      setBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    createElement('div', { style: { color: theme.muted, lineHeight: 1.5 } },
      t('connection.locked.detail', { name: group.name })),
    createElement('div', { style: { display: 'flex', gap: 8 } },
      createElement('input', {
        type: 'password',
        value: token,
        placeholder: t('connection.locked.placeholder'),
        autoComplete: 'new-password',
        disabled: busy,
        onChange: (event: ChangeEvent<HTMLInputElement>) => { setToken(event.target.value) },
        onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          submit()
        },
        style: {
          flex: '1 1 auto', minWidth: 0, fontFamily: 'inherit', fontSize: 13,
          padding: '4px 10px', borderRadius: 6,
          border: `1px solid ${theme.borderStrong}`,
          background: 'transparent', color: theme.text,
        },
      }),
      createElement('button', {
        type: 'button',
        disabled: token === '' || busy,
        style: { ...actionStyle(theme, true), opacity: token === '' || busy ? 0.5 : 1 },
        onClick: submit,
      }, t('connection.locked.unlock')),
    ),
    error === undefined
      ? null
      : createElement('div', { style: { fontSize: 11, color: theme.danger } }, error),
  )
}

/**
 * The intermediate screen for a device session that is not up.
 *
 * Deliberately centred and opaque: what it covers is either nothing or a
 * single diagnostic line, and the user needs to know this is not a terminal yet
 * rather than read a prompt-less black area. A retry is always offered, since
 * the two ways out are "the network came back" and "the device needs fixing".
 */
export function ConnectionPanel(props: ConnectionPanelProps): ReactElement {
  const theme = useDshellTheme()
  const { t } = props
  const seconds = useElapsed(props.since)
  const unsupported = props.phase === 'unsupported'
  const hostKey = props.phase === 'hostKey'
  // Primary on the unsupported screen, where it is the only way forward.
  const settings = useSettingsLink(t, theme, props.onSettings, props.sessionKey, unsupported)
  const failed = props.phase === 'failed'
  const address = props.device === undefined ? t('connection.device') : props.device
  // A host-key screen shows the fingerprints instead: the diagnostic line is
  // the transport's own refusal, which states the problem and nothing the
  // reader can use.
  // The locked door is the same idea one step further: it says the same thing
  // in a form the reader can act on, so the refusal text stands down.
  const locked = props.lockedGroup !== undefined && props.onUnlock !== undefined
    ? { group: props.lockedGroup, onUnlock: props.onUnlock }
    : undefined
  const detail = failed || hostKey ? props.detail ?? props.reason : undefined
  const progress = props.attempt > 0
    ? t('connection.reconnecting', { attempt: props.attempt, max: props.maxAttempts })
    : t('connection.waited', { seconds })
  return createElement('div', {
    'data-dshell-connection-panel': props.phase,
    style: {
      position: 'absolute',
      inset: 0,
      zIndex: 3,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
      background: 'rgba(6, 6, 9, 0.72)',
    },
  },
    createElement('div', {
      style: {
        width: '100%',
        maxWidth: 460,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '18px 20px',
        borderRadius: 10,
        border: `1px solid ${failed || hostKey ? theme.danger : theme.borderStrong}`,
        background: theme.menuBg,
        color: theme.text,
        fontSize: 13,
      },
    },
      createElement('div', {
        style: { fontSize: 14, fontWeight: 600, color: failed || hostKey ? theme.danger : theme.text },
      }, unsupported
        ? t('connection.panel.unsupported')
        : hostKey
          ? t('connection.panel.hostKey', { address })
          : failed
            ? t('connection.panel.failed', { address })
            : t('connection.panel.connecting', { address })),
      createElement('div', { style: { color: theme.muted, lineHeight: 1.5 } },
        unsupported
          ? t('connection.panel.unsupported.detail')
          : hostKey
            ? t('connection.panel.hostKey.detail')
            : failed
              ? props.exhausted
                ? t('connection.retriesFailed', { max: props.maxAttempts })
                : t('connection.notEstablished')
              : progress),
      fingerprintPair(t, theme, props.hostKeys),
      locked === undefined
        ? null
        : createElement(LockedDoor, {
          group: locked.group, theme, onUnlock: locked.onUnlock, t,
        }),
      detail === undefined || detail === '' || locked !== undefined
        ? null
        : createElement('div', { style: detailStyle(theme) }, detail),
      settings.hint === undefined
        ? null
        : createElement('div', { style: { fontSize: 11, color: theme.muted } }, settings.hint),
      // No retry on the unsupported screen: binding a device is the only action
      // that can change the outcome, and a retry button beside it would only
      // invite the reader to press the thing that cannot work. The host-key
      // screen's action is REVOKE-then-reconnect, for the same reason — and
      // that button is supplied by the caller, because only it holds the device
      // id the revoke needs.
      createElement('div', { style: { display: 'flex', gap: 8, marginTop: 2 } },
        unsupported || hostKey
          ? null
          : createElement('button', {
            type: 'button',
            style: actionStyle(theme, true),
            onClick: props.onRetry,
          }, t('connection.retry')),
        hostKey ? createElement('button', {
          type: 'button',
          style: actionStyle(theme, true),
          onClick: props.onRetry,
        }, t('connection.hostKey.trustAnyway')) : null,
        settings.node,
      ),
    ),
  )
}

/** Props of the end-of-output marker. */
export interface ConnectionNoticeProps extends ConnectionActions {
  /** `connecting` while the shell has not answered; `failed` once it ended. */
  tone: 'connecting' | 'failed'
  /** Device display name, when the session is bound to one; undefined otherwise. */
  device: string | undefined
  /** Why it ended, as the host reported it. */
  reason: string | undefined
  /** The connection diagnostic found in the terminal output, if any. */
  detail: string | undefined
  /** Automatic attempts spent, the budget, and whether it is gone. */
  attempt: number
  maxAttempts: number
  exhausted: boolean
  /** When the current attempt started, for the elapsed counter. */
  since: number
  /** Identifies the session, so a switch clears the settings hint. */
  sessionKey: string | undefined
  /** The bound translator for this package's copy. */
  t: ModeTranslate
}

/**
 * The marker drawn after the last line of a terminal whose connection ended.
 *
 * It is a live element, not output: it sits where the shell stopped and
 * disappears once the shell is back, which is the honest reading — the marker
 * describes the connection, not the session. The scrollback behind it belongs
 * to the host, so a successful reconnect continues from exactly this point.
 */
export function ConnectionNotice(props: ConnectionNoticeProps): ReactElement {
  const theme = useDshellTheme()
  const { t } = props
  const seconds = useElapsed(props.since)
  const settings = useSettingsLink(t, theme, props.onSettings, props.sessionKey)
  const lost = props.tone === 'failed'
  const title = lost
    ? `${props.device === undefined ? t('connection.notice.terminalExited') : t('connection.notice.disconnected')}${props.reason === undefined ? '' : ` · ${props.reason}`}`
    : t('connection.notice.connecting', {
      device: props.device === undefined ? '' : ` ${props.device}`,
      seconds,
    })
  // Retrying is a state, not a message: while an attempt is in flight say so,
  // and once the budget is gone say that, rather than leaving "connecting" up
  // forever.
  const progress = props.attempt > 0
    ? t('connection.reconnecting', { attempt: props.attempt, max: props.maxAttempts })
    : undefined
  const stopped = lost && props.exhausted
  return createElement('div', {
    'data-dshell-connection-notice': props.tone,
    style: {
      margin: '10px 0 4px',
      padding: '8px 10px',
      borderRadius: 6,
      border: `1px solid ${lost ? theme.danger : theme.borderStrong}`,
      borderLeft: `2px solid ${lost ? theme.danger : theme.accentBorder}`,
      background: lost ? theme.dangerFaint : theme.accentFaint,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      fontSize: 12,
      color: theme.text,
    },
  },
    createElement('div', {
      style: { color: lost ? theme.danger : theme.text, fontWeight: lost ? 500 : 400 },
    }, title),
    props.detail === undefined || props.detail === ''
      ? null
      : createElement('div', { style: detailStyle(theme) }, props.detail),
    stopped
      ? createElement('div', { style: { color: theme.danger } },
        t('connection.reconnectStopped', { max: props.maxAttempts }))
      : progress === undefined
        ? null
        : createElement('div', { style: { color: theme.muted } }, progress),
    settings.hint === undefined
      ? null
      : createElement('div', { style: { fontSize: 11, color: theme.muted } }, settings.hint),
    createElement('div', { style: { display: 'flex', gap: 8 } },
      createElement('button', {
        type: 'button',
        style: actionStyle(theme, true),
        onClick: props.onRetry,
      }, props.device === undefined ? t('connection.reopenTerminal') : t('connection.retry')),
      settings.node,
    ),
  )
}
