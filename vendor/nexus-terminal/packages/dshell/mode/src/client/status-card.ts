/**
 * The session status chip.
 *
 * dsh docks its `TodoPanel` at the bottom of the conversation, where it lies
 * across the transcript and covers the last lines of output. For a terminal
 * that is the wrong place: the reader is watching the tail of the stream. The
 * status therefore lives in the session header instead, as one chip beside
 * dsh's own header actions, and the docked panel is suppressed while a terminal
 * session is on screen.
 *
 * It is an *integrated status list*, not a task panel and not a terminal
 * window: one row per thing worth knowing about this session's work — the plan
 * and the phase it is in, the AI's own terminal, the subagents it spawned, the
 * background jobs, this session's pipe requests and buffer transfers, a broken
 * terminal link. The chip carries the newest thing that is happening, so a
 * glance is enough; opening it shows those rows, and a row's detail (the task
 * list, the live terminal, the children) opens only when that row is clicked.
 *
 * Everything here is *session-scoped* and a *projection* of state owned
 * elsewhere — the fold's tasks, the bridge's agent stream, dsh's session list,
 * the buffer's pipe state — so the chip never becomes a second source of truth,
 * and the pipe panel itself stays reachable from the terminal section's own
 * entry rather than from here.
 */

import { Component, createElement, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import { IconChevronDownOutlineRegular, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SPAN_FONT } from './block-terminal.js'
import type { PtyStreamService } from '@nexus-aethra/dshell-terminal-bridge/client'
import type { DshellModeKey } from './locales.js'
import { useDshellTheme, type Theme } from './theme.js'
import type { TerminalModeClient } from './terminal-mode.js'
import { sessionStatusSeat } from './session-status.js'
import { cpuPercent, deviceMetricsSeat, memoryAmount } from './device-metrics.js'
import type { SshSeat } from './block-view.js'

/**
 * What the chip says about a session's terminal link.
 *
 * `none` is nothing to say, `connecting` is a handshake in flight, `waiting`
 * is a session that owns no shell yet, `locked` is a credential the reader can
 * unlock, and `broken` is a failure.
 */
export type LinkView = 'none' | 'connecting' | 'waiting' | 'locked' | 'broken'

/** The facts a link's presentation is chosen from. */
export interface LinkFacts {
  /** The host's own link state. */
  status: 'idle' | 'connecting' | 'open' | 'closed' | 'error'
  /** Whether the bound shell ever reached a prompt. */
  ready: boolean
  /** The host never attempted a shell: the session has no live agent. */
  noShell: boolean
  /** The spawn was refused because the credential's vault group is locked. */
  lockedGroup: boolean
}

/**
 * Which presentation a terminal link gets.
 *
 * The link's own state is not enough, and the host says why: a session that
 * owns no shell yet reports a closed link exactly as a shell that died does,
 * and a locked credential reports the same closed link as an unreachable
 * device. The three need opposite things — nothing, a token, a retry — so the
 * host marks the first two structurally and this reads the marks.
 *
 * @param facts - the link's facts.
 * @returns what to show about it.
 */
export function linkView(facts: LinkFacts): LinkView {
  if (facts.status === 'idle' || facts.status === 'open') return 'none'
  if (facts.status === 'connecting') return 'connecting'
  // The lock outranks everything else: a retry brings back the same refusal,
  // and the token is the only thing that changes it.
  if (facts.lockedGroup) return 'locked'
  // No shell was ever attempted, so nothing failed. The session is waiting for
  // its first command, and saying so beats announcing a fault that had not
  // happened.
  if (facts.noShell) return 'waiting'
  return 'broken'
}

/** One item of the session's task list, as the `todo/write` event carries it. */
export interface TodoItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

const STATUS_GLYPH: Record<TodoItem['status'], string> = {
  completed: '✓',
  in_progress: '◐',
  pending: '○',
}

/** One background job, as the session store's `jobsBySession` mirror carries it. */
interface JobView {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  readonly detail?: string | undefined
  readonly startedAt: number
  readonly finishedAt?: number | undefined
}

/** Job status identifier → dictionary key. The identifier stays a wire value. */
const JOB_STATUS_KEY: Record<JobView['status'], DshellModeKey> = {
  running: 'status.job.running',
  stopping: 'status.job.stopping',
  completed: 'status.job.completed',
  killed: 'status.job.killed',
  failed: 'status.job.failed',
}

function jobLive(job: JobView): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

/** Elapsed time in at most two units; the same shape dsh's own widget shows. */
function jobDuration(t: PropsLocale<'dshellMode'>['t'], job: JobView, now: number): string {
  const total = Math.max(0, Math.floor(((job.finishedAt ?? now) - job.startedAt) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  return hours > 0 ? t('duration.hoursMinutes', { hours, minutes })
    : minutes > 0 ? t('duration.minutesSeconds', { minutes, seconds })
      : t('duration.seconds', { seconds })
}

/**
 * The cross-session pipe, as `dshell-buffer` publishes it.
 *
 * Structural on purpose: this package must not depend on the buffer plugin's
 * bundle, and a composition without it passes nothing — the pipe rows then
 * simply never appear.
 */
/** The pipe state slice the chip reads — links, tickets, in-flight transfers. */
export interface PipeState {
  readonly links: readonly {
    readonly id: string
    readonly a: string
    readonly b: string
    /** The name a human or the agent gave the link; absent when unnamed. */
    readonly label?: string | undefined
  }[]
  readonly tickets: readonly PipeTicket[]
  /**
   * Whether the frame-wide pipe panel is on screen. The card ignores it; the
   * terminal section's entry button reads it to show its own pressed state, and
   * a panel closed from inside itself has to be visible on the button too.
   */
  readonly open?: boolean | undefined
  /** Chunked buffer transfers in flight (and the freshly settled). */
  readonly transfers?: readonly {
    readonly id: string
    readonly sessionId: string
    readonly label: string
    readonly bytesDone: number
    readonly bytesTotal: number
    readonly startedAt: number
    readonly finishedAt?: number | undefined
    readonly error?: string | undefined
  }[]
}

export interface PipeSeat {
  getSnapshot(): PipeState
  subscribe(listener: () => void): () => void
  /**
   * Whether a buffer service is behind the seat right now.
   *
   * The seat exists in every composition so its consumers can be unconditional,
   * and a composition without `dshell-buffer` answers every call with nothing —
   * which is indistinguishable from "no pipes yet". An entry button has to tell
   * the two apart, or it offers a panel that can never open.
   */
  available(): boolean
  /** Re-read the committed pipe state from the host. */
  load(): Promise<void>
  /** Withdraw an outstanding ticket. */
  cancel(ticketId: string): Promise<void>
  /** Open the pipe panel (the frame-wide overlay). */
  setOpen(open: boolean): void
}

/** One deferred request, reduced to what a status row shows. */
export interface PipeTicket {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly subject: string
  readonly state: 'queued' | 'running' | 'done' | 'failed' | 'timeout' | 'cancelled'
  readonly createdAt: number
  readonly deadlineAt: number
  readonly reports: readonly { readonly time: number; readonly text: string }[]
}

/** The card renders without a pipe in a composition that has no buffer. */
const EMPTY_PIPE_STATE: PipeState = { links: [], tickets: [] }
const getEmptyPipeState = (): PipeState => EMPTY_PIPE_STATE
const NO_PIPE_SUBSCRIBE = (): (() => void) => () => {}

/** A session whose view has not folded anything yet. */
const EMPTY_TODOS: readonly TodoItem[] = []

/** Ticket states that are still running; everything else is settled. */
const SETTLED: readonly PipeTicket['state'][] = ['done', 'failed', 'timeout', 'cancelled']

/** How a ticket's state reads in a row. The state identifier stays a wire value. */
const STATE_KEY: Record<PipeTicket['state'], DshellModeKey> = {
  queued: 'status.ticket.queued',
  running: 'status.ticket.running',
  done: 'status.ticket.done',
  failed: 'status.ticket.failed',
  timeout: 'status.ticket.timeout',
  cancelled: 'status.ticket.cancelled',
}

/** How long a ticket has left before the host's watchdog settles it. */
function remaining(t: PropsLocale<'dshellMode'>['t'], deadlineAt: number): string {
  const left = deadlineAt - Date.now()
  if (!Number.isFinite(left)) return ''
  if (left <= 0) return t('status.remaining.expired')
  const minutes = Math.floor(left / 60_000)
  return minutes >= 1
    ? t('status.remaining.minutes', { minutes })
    : t('status.remaining.seconds', { seconds: Math.max(1, Math.round(left / 1000)) })
}

/** How often the card re-reads the pipe while this session has one. */
const PIPE_POLL_MS = 5000

/** Suppress the docked panel for as long as a terminal session owns the surface. */
export function setTodoPanelSuppressed(suppressed: boolean): void {
  if (typeof document === 'undefined') return
  if (suppressed) document.body.dataset.dshellTodoFloating = ''
  else delete document.body.dataset.dshellTodoFloating
}

/** Injected once per page: the docked panel yields to the floating card. */
export function injectTodoCardCss(): void {
  if (typeof document === 'undefined' || document.getElementById('dshell-todo-card-css') !== null) return
  const style = document.createElement('style')
  style.id = 'dshell-todo-card-css'
  style.textContent = 'body[data-dshell-todo-floating] [data-testid="todo-panel"]{display:none !important;}'
  document.head.append(style)
}

/** One row of the card: a status line, and the detail behind it. */
interface StatusRow {
  readonly id: string
  /** Leading glyph, in the row's own column. */
  readonly glyph: string
  /** What this row is about (`任务`, `AI 终端`, …). */
  readonly label: string
  /** The one-line value, already formatted. */
  readonly value: string
  /** Accent when the row reports live work. */
  readonly active: boolean
  /** Detail body, rendered only while the row is open. */
  readonly detail?: ReactNode
}

/** One clickable row: glyph, label, value, and the detail it opens. */
function Row(props: {
  row: StatusRow
  open: boolean
  theme: Theme
  onToggle: () => void
  onClose: () => void
}): ReactElement {
  const { row, open, theme, onToggle, onClose } = props
  return createElement('div', { 'data-dshell-status-row': row.id },
    createElement('div', {
      onClick: () => {
        if (open) onClose()
        else onToggle()
      },
      style: {
        display: 'flex',
        gap: '7px',
        alignItems: 'baseline',
        padding: '5px 7px',
        borderRadius: '6px',
        cursor: 'pointer',
        background: open ? theme.accentFaint : 'transparent',
      },
    },
      createElement('span', {
        style: { width: '13px', flex: '0 0 auto', color: row.active ? theme.accentText : theme.muted },
      }, row.glyph),
      createElement('span', { style: { color: theme.text, flex: '0 0 auto' } }, row.label),
      createElement('span', {
        style: {
          color: row.active ? theme.accentText : theme.muted,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto',
        },
      }, row.value),
      createElement('span', { style: { color: theme.muted, flex: '0 0 auto', opacity: 0.8 } }, open ? '▾' : '▸'),
    ),
    open && row.detail !== undefined
      ? createElement('div', {
        'data-dshell-status-detail': row.id,
        style: { padding: '2px 7px 8px 27px', display: 'grid', gap: '3px' },
      }, row.detail)
      : null,
  )
}

/**
 * One line inside a detail body.
 */
function line(text: string, theme: Theme, extra: CSSProperties = {}): ReactElement {
  return createElement('div', {
    key: text,
    style: {
      color: theme.muted, fontSize: 11.5, lineHeight: '16px',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...extra,
    },
  }, text)
}

/**
 * The load ramp: cool to hot, in one continuous scale.
 *
 * Deliberately NOT in the palette table. Every ink there carries a meaning the
 * reader must act on (a failure, a warning, an accent) and each one is checked
 * for text contrast against both surfaces. This is a scale rather than an ink —
 * it answers "how loaded", not "is this wrong" — and it has to be the SAME four
 * hues in every palette, because the reader who learned that orange means hot
 * on one palette must not have to learn it again on the next. The light and
 * dark halves are the same hues stepped for their own ground, exactly as the
 * ANSI vocabulary is.
 */
const LOAD_RAMP: Record<'light' | 'dark', readonly [string, string, string, string]> = {
  dark: ['#4ade80', '#facc15', '#fb923c', '#f87171'],
  light: ['#16a34a', '#ca8a04', '#ea580c', '#dc2626'],
}

/**
 * The ramp as one gradient, plus the stops that place each hue.
 *
 * The stops are where a load stops being comfortable and starts being worth
 * watching: under half is room to work, two thirds is where a machine starts
 * making you wait, and the top eighth is the region where the bar is red from
 * its edge to its end.
 */
function loadGradient(mode: 'light' | 'dark'): string {
  const [good, caution, hot, danger] = LOAD_RAMP[mode]
  return `linear-gradient(90deg, ${good} 0%, ${caution} 50%, ${hot} 75%, ${danger} 100%)`
}

/**
 * One figure with its bar under it, full width.
 *
 * The bar carries the whole ramp and is clipped to the share that is used, so
 * the colour at the bar's edge IS the colour for that load — a rising meter
 * walks the reader up the scale instead of jumping between bands. The unused
 * remainder shows the same gradient at a tenth of its strength, so the track
 * still reads as "how far could this go" rather than as an empty groove.
 */
function Meter(props: {
  label: string
  value: string
  /** The share the bar is filled to; undefined where there is no counter. */
  fraction: number | undefined
  theme: Theme
}): ReactElement {
  const { label, value, fraction, theme } = props
  const ramp = loadGradient(theme.mode)
  return createElement('div', {
    'data-dshell-meter': label,
    style: { display: 'grid', gap: 4, minWidth: 0 },
  },
    createElement('div', {
      style: {
        display: 'flex', gap: 8, alignItems: 'baseline', justifyContent: 'space-between',
        fontSize: 11.5, lineHeight: '15px', whiteSpace: 'nowrap',
      },
    },
      createElement('span', { style: { color: theme.muted } }, label),
      createElement('span', {
        style: {
          color: fraction === undefined ? theme.muted : theme.text,
          fontSize: 13, fontVariantNumeric: 'tabular-nums',
        },
      }, value),
    ),
    createElement('div', {
      style: {
        position: 'relative', height: 5, borderRadius: 3, overflow: 'hidden',
        background: theme.border,
      },
    },
      createElement('div', {
        style: { position: 'absolute', inset: 0, background: ramp, opacity: 0.16 },
      }),
      fraction === undefined ? null : createElement('div', {
        style: {
          position: 'absolute', inset: 0, background: ramp,
          // Clipping rather than sizing: a width would squeeze the gradient
          // into the filled part and paint every non-zero load with the ramp's
          // hot end.
          clipPath: `inset(0 ${String(Math.round((1 - Math.min(1, Math.max(0, fraction))) * 100))}% 0 0)`,
          transition: 'clip-path .4s ease',
        },
      }),
    ),
  )
}

/**
 * Containment for the card.
 *
 * The card projects state owned by four different services, and a fault in any
 * of those projections must cost the reader the card — never the terminal it
 * floats over. A thrown render here is caught, reported in place, and dropped on
 * the next clean render.
 */
export class StatusCardBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) }
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return createElement('pre', {
        'data-dshell-status-error': '',
        style: {
          position: 'absolute', top: 8, right: 12, zIndex: 5, maxWidth: 'min(560px, 70%)',
          maxHeight: '40vh', overflow: 'auto', margin: 0, padding: '6px 9px',
          borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-2)',
          color: 'var(--dsw-alias-state-error-primary)', fontSize: 11, whiteSpace: 'pre-wrap',
        },
      }, this.state.error)
    }
    return this.props.children
  }
}

/** The faces the session-header status chip reads. */
export interface StatusChipInjected {
  /** The agent-terminal and terminal-link streams, owned by the bridge. */
  pty: PtyStreamService
  /** dsh's session list: running state, titles, subagent children, job mirror. */
  sessions: ISessions
  /** The cross-session pipe's face; absent in a composition without it. */
  pipe?: PipeSeat | undefined
  /** Show a conversation the reader picked (a subagent's); absent with no view owner. */
  openConversation?: ((target: SessionTarget) => void) | undefined
  /** The terminal-mode seat: the chip is gated on it, so a stock session has none. */
  modes: TerminalModeClient
  /**
   * The SSH plugin's face; absent in a composition without it.
   *
   * Read for one thing only: the vault group whose lock is refusing this
   * session's terminal. The chip is where the reader is when the terminal says
   * it cannot start, so this is where the way out belongs.
   */
  ssh?: SshSeat | undefined
}

/** Full props of the session-header status chip. */
export type StatusChipProps = PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'dshellMode'> & StatusChipInjected

/** The session status chip: one line in the header, integrated status rows behind it. */
export function StatusChip(props: StatusChipProps): ReactElement | null {
  const { sessionId, pty, sessions, pipe, openConversation, modes, ssh, t } = props
  const theme = useDshellTheme()
  // Subscribed before anything else: hooks cannot be conditional, and the state
  // they carry is what decides what the chip says at all.
  const agent = useSyncExternalStore(pty.agent.subscribe, pty.agent.getSnapshot)
  const link = useSyncExternalStore(pty.state.subscribe, pty.state.getSnapshot)
  const list = useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot)
  const pipeState = useSyncExternalStore(
    pipe?.subscribe ?? NO_PIPE_SUBSCRIBE,
    pipe?.getSnapshot ?? getEmptyPipeState,
  )
  // The task list and the phase in flight are folded by the block view, which
  // publishes them for surfaces outside itself — this chip reads that
  // projection instead of folding the transcript a second time.
  const statusMap = useSyncExternalStore(sessionStatusSeat.subscribe, sessionStatusSeat.getSnapshot)
  const status = sessionId === undefined ? undefined : statusMap.get(String(sessionId))
  // The machine this session runs on. Watched, not fetched per chip: the seat
  // is shared across the frame, so a reader with five sessions open pays five
  // polls rather than five polls per render — and on a device each of those is
  // an ssh round trip, which is why the seat slows its cadence there.
  const modeState = useSyncExternalStore(modes.subscribe, modes.getSnapshot)
  const metricsMap = useSyncExternalStore(deviceMetricsSeat.subscribe, deviceMetricsSeat.getSnapshot)
  const metrics = sessionId === undefined ? undefined : metricsMap.get(sessionId)
  // The readout waits for the session's first input. Until then the device is
  // still the reader's to choose — the creation screen offers 本机 or a device
  // right here — so any machine named now would be the one they are about to
  // decline, and polling for it costs a round trip per tick to learn nothing.
  const started = sessionId !== undefined && modeState.started.includes(sessionId)
  useEffect(() => {
    if (sessionId === undefined || !started) return
    return deviceMetricsSeat.watch(sessionId)
  }, [sessionId, started])
  const todos = status?.todos ?? EMPTY_TODOS
  const activity = status?.activity
  const [open, setOpen] = useState(false)
  const [openRow, setOpenRow] = useState<string | undefined>(undefined)
  // Why the way out could not be opened, when it could not be.
  const [unlockHint, setUnlockHint] = useState<string | undefined>(undefined)
  const root = useRef<HTMLDivElement | null>(null)
  useDismissOnOutsidePointer(root, open, setOpen)

  // Where the menu lands. The chip sits mid-band, so an edge-anchored sheet
  // runs off the viewport (a right-anchored 420px menu on a chip at x=305 in a
  // 935px window lands at x=-57) and would cover the band it belongs to. The
  // menu is therefore placed in fixed coordinates: clamped horizontally into
  // the viewport, opened below the chip, and flipped above it when the room
  // below is too small to read anything in.
  const [placement, setPlacement] = useState<{
    left: number; width: number; maxHeight: number; top?: number; bottom?: number
  } | null>(null)
  const measure = (): void => {
    const el = root.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    const width = Math.min(520, Math.max(280, innerWidth - 24))
    const left = Math.max(12, Math.min(rect.left, innerWidth - 12 - width))
    const below = innerHeight - rect.bottom - 17
    const above = rect.top - 17
    setPlacement(below < 240 && above > below
      ? { left, width, bottom: innerHeight - rect.top + 5, maxHeight: Math.min(480, above) }
      : { left, width, top: rect.bottom + 5, maxHeight: Math.min(480, below) })
  }
  useEffect(() => {
    if (!open) return
    measure()
    const onMove = (): void => { measure() }
    addEventListener('resize', onMove)
    addEventListener('scroll', onMove, true)
    return () => {
      removeEventListener('resize', onMove)
      removeEventListener('scroll', onMove, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `measure` reads only refs and state below
  }, [open, openRow])
  // The clock behind live job durations: it runs only while the jobs row is
  // expanded and something is still running, so an idle session costs nothing.
  const [now, setNow] = useState(() => Date.now())

  // Every hook runs before the card can return nothing: the card is absent on
  // most renders and present while work is in flight, and a hook that appears
  // only in the second case is a hook-count change React rejects outright.
  //
  // The subagent catalog is fetched on demand — dsh serves it while a menu is
  // consuming it, so the row announces itself and asks for the catalog when the
  // reader opens it. Both calls are optional on the service: a build without
  // the subagent half simply never fills this row, and a throw inside an effect
  // would take the whole view down with it.
  useEffect(() => {
    if (sessionId === undefined) return
    if (openRow !== 'agents') return
    // rc.2 serves the subagent catalog inside the session projections: opening
    // the row asks for a fresh projection, and the list store pushes the rows.
    void sessions.refreshProjections(sessionId as SessionId).catch(() => {
      // A host without the projection half leaves the row at its count line.
    })
  }, [openRow, sessionId, sessions])

  // The pipe's state is pulled, not pushed, and its own poll only runs while
  // the panel is open. The card therefore reads it itself — once at mount, then
  // only while this session actually has a pipe: a composition or a session
  // without one costs a single request.
  const pipeActive = pipeState.links.length > 0 || pipeState.tickets.length > 0
  useEffect(() => {
    if (pipe === undefined) return
    void pipe.load()
    if (!pipeActive) return
    const timer = setInterval(() => { void pipe.load() }, PIPE_POLL_MS)
    return () => { clearInterval(timer) }
  }, [pipe, pipeActive])

  const agentHere = sessionId !== undefined && agent.sessionId === sessionId
  const live = agentHere && agent.live
  const dead = agentHere && agent.reason !== undefined
  // Every list field is read defensively: the store's shape is dsh's, and a
  // field it has not populated yet must degrade to "nothing to report" — a
  // throw here would take the whole view down with the card.
  const byId = list.byId ?? {}
  // Whether a turn is running comes from the session list, not from the fold:
  // a turn that died with the host leaves a permanently "running" block behind,
  // and a status line that keeps claiming work is worse than no status line.
  const running = sessionId !== undefined && byId[sessionId as SessionId]?.running === true
  const linkHere = sessionId !== undefined && link.sessionId === sessionId
  // The link's presentation, in one place.
  //
  // The host's own state is not enough: a session that owns no shell yet and
  // a shell that died both report a closed link, and a locked credential
  // reports the same one as an unreachable device. The three need opposite
  // things — nothing, a token, a retry — so the host marks the first two
  // structurally and this reads the marks.
  const linkState = linkHere
    ? linkView({
      status: link.status,
      ready: link.ready,
      noShell: link.noShell,
      lockedGroup: link.lockedGroup,
    })
    : 'none'
  const linkConnecting = linkState === 'connecting'
  const linkLocked = linkState === 'locked'
  const linkBroken = linkState === 'broken'
  // 'waiting' — a session that owns no shell yet — is deliberately not a
  // branch below: there is nothing to say about it and nothing to offer, so it
  // falls through to the idle line like any other quiet session.
  //
  // The group that is holding this session's credential, named from the
  // session's own binding.
  //
  // The token is not typed here. The SSH card owns that box, and the seat's
  // own job is to land the reader IN it — on the group that is actually
  // stopping this session — so the chip's job is to point at the door rather
  // than to build a second one beside it.
  const lockedGroup = linkLocked && sessionId !== undefined
    ? ssh?.lockedGroupForSession(sessionId)
    : undefined
  const openUnlock = (): void => {
    if (ssh === undefined || sessionId === undefined) return
    setUnlockHint(undefined)
    if (ssh.revealSettings(sessionId) !== true) setUnlockHint(t('status.unlockUnavailable'))
  }
  const children = sessionId === undefined
    ? []
    : Object.values(byId).filter(row => row.parentId === sessionId && row.origin === 'subagent')
  const runningChildren = children.filter(entry => entry.running === true).length

  // This session's chunked buffer transfers. One progresses per tick of the
  // card; the poll that feeds it lives on the pipe service (it keeps its own
  // 1s cadence while anything is in flight).
  const transfersHere = (pipeState.transfers ?? []).filter(entry => entry.sessionId === sessionId)
  const liveTransfers = transfersHere.filter(entry => entry.finishedAt === undefined)
  const transferPct = (entry: (typeof transfersHere)[number]): number => {
    const total = Math.max(1, entry.bytesTotal)
    return Math.min(100, Math.round((entry.bytesDone / total) * 100))
  }

  // This session's background jobs, from the same store mirror dsh's header
  // widget reads. Live jobs first in start order, then settled newest-first —
  // the ordering a reader would ask for.
  const jobs = sessionId !== undefined
    ? ((list as { jobsBySession?: Partial<Record<SessionId, readonly JobView[]>> }).jobsBySession?.[sessionId as SessionId] ?? [])
    : []
  const liveJobs = jobs.filter(jobLive)
  const sortedJobs = [...jobs].sort((left, right) => {
    const liveLeft = jobLive(left)
    if (liveLeft !== jobLive(right)) return liveLeft ? -1 : 1
    if (liveLeft) return left.startedAt - right.startedAt
    return ((right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt))
      || left.startedAt - right.startedAt
  })
  useEffect(() => {
    if (openRow !== 'jobs' || liveJobs.length === 0) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [openRow, liveJobs.length])

  const done = todos.filter(item => item.status === 'completed').length
  const activeTodo = todos.find(item => item.status === 'in_progress')
  const pendingTodo = todos.find(item => item.status === 'pending')

  // The pipe's effect on this session, computed before the head line because
  // it is part of that line. A ticket the current session *asked for* and did
  // not get an answer to is a breakpoint: the agent delegated, ended its turn
  // on purpose and is parked until the reply reopens it, which is a state the
  // reader must see — otherwise the session looks idle while it is waiting.
  // Work another session handed *to* this one is the pipe's other half.
  const peerTitle = (id: string): string => byId[id as SessionId]?.displayTitle ?? id.slice(0, 12)
  const waiting = pipeState.tickets.filter(ticket =>
    ticket.from === sessionId && !SETTLED.includes(ticket.state))
  const owed = pipeState.tickets.filter(ticket =>
    ticket.to === sessionId && !SETTLED.includes(ticket.state))
  // This session's established pipes. They are reported even while nothing is
  // in flight: which other session a terminal is wired to is a fact about the
  // session, and the header is where a reader looks up the session.
  const linksHere = sessionId === undefined
    ? []
    : pipeState.links.filter(entry => entry.a === sessionId || entry.b === sessionId)

  // The one line the collapsed card shows: the newest thing that is happening,
  // in the order a reader would ask about it — the phase of a written plan
  // first, since it is short and is what the reader last saw the agent do. A
  // quiet session says so and stays openable: the card is the session's status
  // surface, and its rows are worth reaching even when nothing is running.
  const headline =
    running ? `◐ ${activeTodo?.content ?? activity ?? t('status.working')}`
      : waiting.length > 0 ? `⏸ ${t('status.waiting', { peer: peerTitle(waiting[0]?.to ?? '') })}`
        : activeTodo !== undefined ? `◐ ${activeTodo.content}`
          : owed.length > 0 ? `⇄ ${t('status.owed', { count: owed.length })}`
            : live ? `▚ ${t('status.terminalRunning')}`
              : runningChildren > 0 ? `⎇ ${t('status.agentsRunning', { count: runningChildren })}`
                : liveTransfers.length > 0 ? `⇅ ${t('status.transferring', { pct: transferPct(liveTransfers[0]) })}`
                  : liveJobs.length > 0 ? `⟳ ${t('status.jobsRunning', { count: liveJobs.length })}`
                  : pendingTodo !== undefined ? `○ ${pendingTodo.content}`
                    : dead ? t('status.terminalEnded')
                      : linkLocked ? t('status.linkLocked')
                        : linkBroken ? t('status.linkBroken')
                          : linksHere.length > 0
                            ? `${t('status.idle')} · ${t('status.chip.links', { count: linksHere.length })}`
                            : t('status.idle')
  // The two figures the header carries. CPU is a share of all cores and memory
  // a share of physical memory — same denominator idea, so the two bars can be
  // read against each other rather than each against its own unit.
  const reading = started ? metrics?.metrics : undefined
  const cpuFraction = reading?.cpu.used
  const memoryFraction = reading === undefined || reading.memory.total <= 0
    ? undefined
    : Math.min(1, reading.memory.used / reading.memory.total)
  const idle = !running && activeTodo === undefined && !live && runningChildren === 0
    && pendingTodo === undefined && !dead && !linkBroken && !linkLocked
    && waiting.length === 0 && owed.length === 0
    && liveJobs.length === 0 && liveTransfers.length === 0

  const rows: StatusRow[] = []
  if (todos.length > 0) {
    const phase = activeTodo?.content ?? pendingTodo?.content
    rows.push({
      id: 'plan', glyph: '◐', label: t('status.plan'), active: activeTodo !== undefined,
      value: `${String(done)}/${String(todos.length)}${phase === undefined ? '' : ` · ${phase}`}`,
      detail: createElement('div', { style: { display: 'grid', gap: '3px' } },
        ...todos.map(item => createElement('div', {
          key: item.content,
          style: {
            display: 'grid', gridTemplateColumns: '14px 1fr', gap: '6px',
            color: item.status === 'completed' ? theme.muted : theme.text,
            textDecoration: item.status === 'completed' ? 'line-through' : 'none',
            whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: '17px',
          },
        },
          createElement('span', { style: { opacity: 0.8 } }, STATUS_GLYPH[item.status]),
          createElement('span', null, item.content),
        )),
      ),
    })
  }
  if (children.length > 0 || runningChildren > 0) {
    rows.push({
      id: 'agents', glyph: '⎇', label: t('status.agents'), active: runningChildren > 0,
      value: children.length === 0
        ? t('status.loading')
        : `${t('status.agents.count', { count: children.length })}${runningChildren === 0 ? '' : t('status.agents.running', { count: runningChildren })}`,
      detail: children.length === 0
        ? line(t('status.noAgents'), theme)
        : createElement('div', { style: { display: 'grid', gap: '2px' } },
          ...children.map(entry => createElement('div', {
            key: String(entry.id),
            onClick: () => {
              // `openSubagent` left the sessions face in 0.1.6-alpha.2: navigation
              // belongs to a view owner, which `openConversation` reaches.
              const address = sessions.subagentAddress(entry.id)
              if (address !== undefined) openConversation?.(address)
            },
            style: {
              display: 'grid', gridTemplateColumns: '10px 1fr', gap: '6px',
              color: theme.text, fontSize: 11.5, lineHeight: '17px', cursor: 'pointer',
            },
          },
            createElement('span', {
              style: { color: entry.running === true ? theme.accent : theme.borderStrong },
            }, '●'),
            createElement('span', {
              style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, entry.displayTitle || String(entry.id)),
          )),
        ),
    })
  }
  if (jobs.length > 0) {
    rows.push({
      id: 'jobs', glyph: '⟳', label: t('status.jobs'), active: liveJobs.length > 0,
      value: liveJobs.length > 0 ? t('status.jobs.live', { count: liveJobs.length }) : t('status.jobs.count', { count: jobs.length }),
      detail: createElement('div', { style: { display: 'grid', gap: '2px' } },
        ...sortedJobs.map(job => {
          const live = jobLive(job)
          const statusLabel = t(JOB_STATUS_KEY[job.status])
          return createElement('div', {
            key: job.id,
            style: { display: 'grid', gridTemplateColumns: '10px 1fr auto', gap: '6px', alignItems: 'baseline' },
          },
            createElement('span', {
              style: { color: live ? theme.accent : job.status === 'failed' ? theme.danger : theme.borderStrong },
            }, '●'),
            createElement('span', {
              title: job.label,
              style: {
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                color: live ? theme.text : theme.muted, fontSize: 11.5, lineHeight: '17px',
              },
            }, `${job.kind} · ${job.label}`),
            createElement('span', {
              title: job.detail ?? statusLabel,
              style: { color: theme.muted, fontSize: 11, whiteSpace: 'nowrap' },
            }, `${job.detail ?? statusLabel} · ${jobDuration(t, job, now)}`),
          )
        }),
      ),
    })
  }
  if (transfersHere.length > 0) {
    rows.push({
      id: 'transfers', glyph: '⇅', label: t('status.transfers'),
      active: liveTransfers.length > 0,
      value: liveTransfers.length > 0
        ? t('status.transfers.live', { count: liveTransfers.length, pct: transferPct(liveTransfers[0]) })
        : t('status.transfers.done'),
      detail: createElement('div', { style: { display: 'grid', gap: '5px' } },
        ...transfersHere.map(entry => {
          const pct = transferPct(entry)
          const live = entry.finishedAt === undefined
          return createElement('div', { key: entry.id, style: { display: 'grid', gap: '2px' } },
            createElement('div', {
              title: entry.label,
              style: {
                display: 'flex', justifyContent: 'space-between', gap: 8,
                color: entry.error !== undefined ? theme.danger : live ? theme.text : theme.muted,
                fontSize: 11.5, lineHeight: '16px',
              },
            },
              createElement('span', {
                style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, entry.label),
              createElement('span', { style: { flex: '0 0 auto', opacity: 0.75 } },
                entry.error !== undefined ? t('status.failed') : `${String(pct)}%`),
            ),
            createElement('div', {
              style: {
                height: 3, borderRadius: 2, overflow: 'hidden',
                background: theme.border,
              },
            },
              createElement('div', {
                style: {
                  height: '100%', width: `${String(pct)}%`,
                  background: entry.error !== undefined ? theme.danger : theme.accent,
                  transition: 'width .4s ease',
                },
              })),
            entry.error !== undefined
              ? line(entry.error, theme)
              : null,
          )
        }),
      ),
    })
  }
  // The pipe rows. A breakpoint is the wait for an answer (the agent ended its
  // turn on purpose); a pipe task is work another session handed to this one.
  if (linksHere.length > 0) {
    rows.push({
      id: 'pipes', glyph: '⇄', label: t('status.pipe.links'),
      active: waiting.length > 0 || owed.length > 0,
      value: t('status.pipe.links.value', { count: linksHere.length }),
      detail: createElement('div', { style: { display: 'grid', gap: '3px' } },
        ...linksHere.map(entry => {
          const peer = peerTitle(entry.a === sessionId ? entry.b : entry.a)
          return createElement('div', {
            key: entry.id,
            style: {
              display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px', alignItems: 'baseline',
              color: theme.text, fontSize: 11.5, lineHeight: '16px',
            },
          },
            createElement('span', {
              title: entry.label ?? peer,
              style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, entry.label === undefined || entry.label.length === 0 ? peer : `${peer} · ${entry.label}`),
            createElement('span', { style: { color: theme.muted, flex: '0 0 auto' } }, '⇄'),
          )
        }),
      ),
    })
  }
  if (waiting.length > 0) {
    rows.push({
      id: 'breakpoint', glyph: '⏸', label: t('status.breakpoint'), active: true,
      value: `${t('status.waiting', { peer: peerTitle(waiting[0]?.to ?? '') })}${waiting.length > 1 ? t('status.breakpoint.more', { count: waiting.length }) : ''}`,
      detail: createElement('div', { style: { display: 'grid', gap: '3px' } },
        line(t('status.breakpoint.detail'), theme),
        ...waiting.map(ticket => createElement('div', {
          key: ticket.id,
          style: { display: 'grid', gap: '1px', marginTop: '2px' },
        },
          createElement('div', {
            style: { color: theme.text, fontSize: 11.5, lineHeight: '16px', whiteSpace: 'pre-wrap' },
          }, t('status.breakpoint.to', { peer: peerTitle(ticket.to), subject: ticket.subject })),
          createElement('div', {
            style: { display: 'flex', gap: '8px', color: theme.muted, fontSize: 11 },
          },
            createElement('span', null, `${t(STATE_KEY[ticket.state])} · ${remaining(t, ticket.deadlineAt)}`),
            ticket.reports.length === 0 ? null : createElement('span', null, t('status.reports', { count: ticket.reports.length })),
            createElement('span', {
              onClick: (event: { stopPropagation: () => void }) => {
                event.stopPropagation()
                void pipe?.cancel(ticket.id)
              },
              style: { color: theme.accentText, textDecoration: 'underline', cursor: 'pointer' },
            }, t('status.withdraw')),
          ),
        )),
      ),
    })
  }
  if (owed.length > 0) {
    rows.push({
      id: 'pipe', glyph: '⇄', label: t('status.pipe'), active: true,
      value: t('status.pipe.value', { count: owed.length, peer: peerTitle(owed[0]?.from ?? '') }),
      detail: createElement('div', { style: { display: 'grid', gap: '3px' } },
        ...owed.map(ticket => createElement('div', {
          key: ticket.id,
          style: { display: 'grid', gap: '1px', marginTop: '2px' },
        },
          createElement('div', {
            style: { color: theme.text, fontSize: 11.5, lineHeight: '16px', whiteSpace: 'pre-wrap' },
          }, t('status.pipe.from', { peer: peerTitle(ticket.from), subject: ticket.subject })),
          createElement('div', { style: { color: theme.muted, fontSize: 11 } },
            `${t(STATE_KEY[ticket.state])} · ${remaining(t, ticket.deadlineAt)}`),
        )),
      ),
    })
  }
  if (linkBroken || linkLocked || linkConnecting) {
    rows.push({
      id: 'link', glyph: '⚡', label: t('status.link'), active: false,
      value: linkLocked
        ? t('status.linkLocked')
        : linkBroken ? t('status.disconnected') : t('status.connecting'),
      detail: createElement('div', { style: { display: 'grid', gap: '3px' } },
        line(link.reason ?? '', theme),
        link.detail === undefined ? null : line(link.detail, theme),
        lockedGroup === undefined ? null : line(t('status.lockedGroup', { name: lockedGroup.name }), theme),
        // The way out, and the only one: a retry brings back the same refusal.
        // The token box lives in the SSH card, and the seat lands the reader in
        // it — on the group that is actually stopping this session.
        // The locked branch offers BOTH ways out. The token is typed in the
        // SSH card, so unlocking is a step the reader takes THERE — and when
        // they come back, the only thing this chip can offer is the retry that
        // uses the key they just entered. A chip that offers only the door
        // leaves a reader who unlocked standing in front of a locked chip.
        linkLocked
          ? createElement('div', { style: { display: 'flex', gap: '12px' } },
            createElement('div', {
              onClick: openUnlock,
              style: { color: theme.accentText, textDecoration: 'underline', cursor: 'pointer', fontSize: 11.5 },
            }, t('status.unlock')),
            createElement('div', {
              onClick: () => { pty.reconnect() },
              style: { color: theme.accentText, textDecoration: 'underline', cursor: 'pointer', fontSize: 11.5 },
            }, t('status.reconnect')))
          : createElement('div', {
            onClick: () => { pty.reconnect() },
            style: { color: theme.accentText, textDecoration: 'underline', cursor: 'pointer', fontSize: 11.5 },
          }, t('status.reconnect')),
        unlockHint === undefined ? null : line(unlockHint, theme),
      ),
    })
  }

  return createElement('div', {
    ref: root,
    'data-dshell-status-chip': '',
    style: { position: 'relative', display: 'inline-flex' },
  },
    // The chip: dsh's own header-action metrics, so it reads as part of the band.
    createElement('button', {
      type: 'button',
      'data-dshell-status-head': '',
      'aria-expanded': open,
      'aria-label': t('status.chip.aria'),
      title: headline,
      onClick: () => {
        setOpen(!open)
        if (open) setOpenRow(undefined)
      },
      style: {
        display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 28, padding: '3px 6px 3px 2px',
        border: 0, borderRadius: 'var(--dsw-radius-sm)', background: 'transparent',
        color: open ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-tertiary)',
        fontSize: 12, lineHeight: '18px', cursor: 'pointer', fontFamily: SPAN_FONT, maxWidth: 380,
      },
    },
      createElement('span', {
        'data-dshell-status-dot': '',
        style: {
          flex: 'none', fontSize: 8, lineHeight: '18px',
          color: idle ? 'var(--dsw-alias-label-quaternary, currentColor)' : theme.accent,
          opacity: idle ? 0.55 : 1,
        },
      }, '●'),
      createElement('span', {
        style: {
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          // dsh's own header buttons are centred, and a centred status line no
          // longer lines up with the panel it opens.
          textAlign: 'left', minWidth: 0, flex: '1 1 auto',
        },
      }, headline),
      createElement('span', {
        style: {
          flex: 'none', display: 'inline-flex', alignItems: 'center',
          transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms ease',
        },
      }, createElement(IconChevronDownOutlineRegular, { size: 12 })),
    ),
    open && placement !== null
      ? createElement('div', {
        'data-dshell-status-menu': '',
        style: {
          position: 'fixed', left: placement.left, maxHeight: placement.maxHeight,
          ...(placement.top === undefined ? { bottom: placement.bottom } : { top: placement.top }),
          zIndex: 100,
          boxSizing: 'border-box', display: 'grid', gap: 1, padding: 3,
          width: placement.width, overflow: 'auto',
          borderRadius: 'var(--dsw-radius-lg)', background: 'var(--dsw-specific-menu)',
          backdropFilter: 'var(--dsw-menu-backdrop-filter)',
          boxShadow: '0 6px 20px rgba(0,0,0,.35)',
          fontFamily: SPAN_FONT, fontSize: 12.5, color: theme.muted,
        },
      },
        ...(reading === undefined ? [] : [createElement('div', {
          'data-dshell-meters': '',
          style: { display: 'grid', gap: 7, padding: '7px 9px 10px' },
        },
          // The machine is named only when it is NOT this one: on the default
          // path the name is noise between the two figures, and the pair reads
          // as one scale. On a device it is the fact that changes what the
          // numbers mean, so it takes the room.
          reading.device.kind === 'device'
            ? createElement('div', {
              style: {
                fontSize: 11, lineHeight: '15px', color: theme.muted,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, t('status.resources.device', {
              name: reading.device.name ?? reading.device.endpoint ?? '',
            }))
            : null,
          createElement(Meter, {
            theme,
            label: t('status.resources.cpu'),
            value: cpuPercent(reading.cpu),
            fraction: cpuFraction,
          }),
          createElement(Meter, {
            theme,
            label: t('status.resources.memory'),
            value: cpuPercent({
              used: memoryFraction, cores: reading.cpu.cores, load1: reading.cpu.load1,
            }),
            fraction: memoryFraction,
          }),
          line(
            `${t('status.resources.cores', { cores: String(reading.cpu.cores) })}`
            + (reading.cpu.load1 === undefined || reading.cpu.load1 === 0
              ? ''
              : `  ·  ${t('status.resources.load', { load: reading.cpu.load1.toFixed(2) })}`)
            + `  ·  ${t('status.resources.used', {
              used: memoryAmount(reading.memory.used),
              total: memoryAmount(reading.memory.total),
            })}`,
            theme,
          ),
          createElement('div', { style: { height: 1, background: theme.border } }),
        )]),
        ...rows.map(row => createElement(Row, {
          key: row.id,
          row,
          theme,
          open: openRow === row.id,
          onToggle: () => { setOpenRow(row.id) },
          onClose: () => { setOpenRow(undefined) },
        })),
      )
      : null,
  )
}
