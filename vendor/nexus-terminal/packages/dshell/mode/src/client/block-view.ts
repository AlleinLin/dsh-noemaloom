/**
 * The block view: one scrolling column that alternates shell regions with
 * agent task blocks.
 *
 * A shell region is everything the terminal printed between two tasks, drawn
 * by a real terminal (see `block-terminal`) and carrying no chrome of its own:
 * the prompt, the command echoes and their output are exactly what the shell
 * produced. A task is a card — header, a two-line preview folded, every row
 * expanded, and its closing line. Regions and cards sort on one timeline, so
 * the interleaving the reader saw is preserved.
 *
 * The seat mirrors the canvas's view shell: the slot area is absolutely
 * positioned over the content column, so the seat fills it and the inner
 * column owns the scrolling. Without that the column grows to content height
 * and the composer paints over its tail.
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type {
  ISessions,
  SessionEventLikeEntry,
  SessionEventSource,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { PtyStreamService } from '@nexus-aethra/dshell-terminal-bridge/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { clearStream, createFold, foldEvent, noteLiveChunk, type BlockFold } from './blocks.js'
import { AgentBlock, UserBubble } from './agent-block.js'
import { assembleTimeline, type ViewItem } from './block-model.js'
import { createSpanTerminal, SPAN_FONT, SPAN_FONT_SIZE, SPAN_LINE_HEIGHT } from './block-terminal.js'
import {
  ConnectionNotice, ConnectionPanel, connectionView, type HostKeyFacts,
} from './connection-notice.js'
import {
  injectTodoCardCss, setTodoPanelSuppressed,
  type PipeSeat, type TodoItem,
} from './status-card.js'
import { publishSessionStatus } from './session-status.js'
import { BookmarkRail, bookmarksOf } from './bookmark-rail.js'
import { useDshellTheme } from './theme.js'

/**
 * The device half of a session, as the SSH plugin publishes it.
 *
 * Structural on purpose: this package must not depend on the SSH plugin's
 * bundle, and a composition without it passes nothing — the terminal then has
 * no device story to tell, while the end-of-output marker (which is about the
 * shell itself) still works.
 */
export interface SshSeat {
  /** The session's assignment, when it has one. */
  bindingOf(sessionId: string): { deviceId: string } | undefined
  /** Registered devices, for naming the one a session runs on. */
  devices(): readonly { id: string; name: string }[]
  /**
   * Open the SSH settings card for one session; false when the entry could not
   * be found. A session whose device's credential sits in a locked group lands
   * with that group's unlock box already open.
   */
  revealSettings(sessionId: string): boolean
  /**
   * The vault group one session's device draws its credential from, when that
   * group is locked.
   *
   * What turns a spawn the host refused into a door the reader can open without
   * leaving the terminal: the group is named from the session's own binding, so
   * the token box on the failure screen is about the group that is actually
   * stopping this session.
   */
  lockedGroupForSession(sessionId: string): { readonly id: string; readonly name: string } | undefined
  /**
   * Unlock one vault group with its token.
   *
   * Throws when the token does not open it — the caller shows that beside the
   * box it was typed into, because a guess that half-worked would look like a
   * success and then fail as a refused password on the device.
   */
  unlock(groupId: string, token: string): Promise<void>
  /** What this plugin currently trusts for one device, by fingerprint. */
  hostKeys(deviceId: string): Promise<readonly string[]>
  /**
   * What one device's host presents now.
   *
   * Unauthenticated — offered so the reader can compare it against the trusted
   * fingerprint they already hold, never to be trusted on sight.
   */
  probeHostKey(deviceId: string): Promise<string | undefined>
  /**
   * Drop what is recorded for one device, so the next connection trusts
   * whatever it presents. Resolves once the record is gone.
   */
  revokeHostKey(deviceId: string): Promise<void>
  subscribe(listener: () => void): () => void
}

/**
 * One session's incremental fold.
 *
 * The fold is advanced by the event window's changes rather than rebuilt from
 * the window on every revision: a turn streams many deltas, and re-folding all
 * of history for each of them is what makes the view stall.
 */
interface FoldState {
  readonly sessionId: string
  fold: BlockFold
  /** Highest durable seq folded, so an append never re-folds history. */
  watermark: number
  /** The session's current task list, tracked as `todo/write` events fold. */
  todos: readonly TodoItem[]
  /** Prompt ids whose durable `user/message` has already been folded. */
  readonly submitted: Set<string>
  /**
   * Requests the host has taken into a turn but not yet written to the log.
   *
   * `agent/inbox/spliced` carries the message the moment the host admits it —
   * ten seconds before the durable `user/message` on a slow route — so the
   * request can be on screen while the model is still starting up. Keyed by
   * prompt id, and dropped when the durable row arrives.
   */
  readonly inbox: Map<string, { time: number; text: string }>
}

/** Text of a spliced inbox entry's content blocks. */
function textOfContent(content: readonly unknown[] | undefined): string {
  const parts: string[] = []
  for (const block of content ?? []) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n').trim()
}

/**
 * Fold one window entry into the fold: a live chunk updates the open block's
 * streaming line, a durable event folds normally (once — the watermark makes a
 * replayed entry a no-op).
 * @returns whether the call changed anything visible.
 */
function advance(state: FoldState, entry: SessionEventLikeEntry, t: TranslateNS<'dshellMode'>): boolean {
  if (entry.type === 'transient') return noteLiveChunk(state.fold.open, entry.event)
  if (entry.event.seq <= state.watermark) return false
  state.watermark = entry.event.seq
  const event = entry.event
  // The task list is tracked here rather than derived from the window, which
  // the view no longer keeps: a new turn clears it, `todo/write` sets it.
  if (event.type === 'turn/start') state.todos = []
  else if (event.type === 'todo/write') state.todos = [...event.data.todos]
  if (event.type === 'agent/inbox/spliced') {
    // The host admits a prompt into the turn here, with its content and prompt
    // id, long before it is durable. Everything not yet in the log is held as
    // a not-yet-durable bubble; the durable event retires it below.
    const inserted = (event.data as { inserted?: readonly unknown[] }).inserted ?? []
    for (const raw of inserted) {
      if (typeof raw !== 'object' || raw === null) continue
      const entry = raw as {
        id?: unknown
        role?: unknown
        source?: { kind?: unknown; rpcId?: unknown }
        content?: readonly unknown[]
      }
      if (entry.role !== 'user' || entry.source?.kind !== 'user') continue
      const rpcId = entry.source.rpcId ?? entry.id
      if (typeof rpcId !== 'string') continue
      const text = textOfContent(entry.content)
      if (text.length > 0) state.inbox.set(rpcId, { time: event.time, text })
    }
  }
  if (event.type === 'user/message') {
    // The prompt id the reader's own submission carried: it is how the
    // not-yet-durable bubble on screen knows its message has landed.
    const rpcId = (event.data.source as { rpcId?: unknown }).rpcId
    if (typeof rpcId === 'string') {
      state.submitted.add(rpcId)
      state.inbox.delete(rpcId)
    }
  }
  foldEvent(state.fold, event, t)
  return true
}

/** A shell region: a plain terminal, no header and no frame of its own. */
function ShellRegion(props: {
  item: Extract<ViewItem, { kind: 'shell' }>
  theme: import('./theme.js').Theme
}): ReactElement {
  const host = useRef<HTMLDivElement | null>(null)
  const handle = useRef<ReturnType<typeof createSpanTerminal> | undefined>(undefined)
  useEffect(() => {
    const el = host.current
    if (el === null) return
    handle.current = createSpanTerminal(el, props.theme, props.item.text)
    const observer = new ResizeObserver(() => { handle.current?.fit() })
    observer.observe(el)
    return () => { observer.disconnect(); handle.current?.dispose(); handle.current = undefined }
  }, [props.theme])
  // Output that arrived after mount is appended in place.
  useEffect(() => { handle.current?.update(props.item.text) }, [props.item.text])
  return createElement('div', {
    ref: host,
    'data-dshell-shell-region': '',
    // Font size and line height belong to the terminal; setting them here too
    // would fight it, and every region renders at the one size regardless of
    // the grid it needs.
    style: {
      fontFamily: SPAN_FONT,
      // A region whose grid is wider than the column keeps its text size and
      // scrolls instead, so this is where the rest becomes reachable.
      overflowX: 'auto',
    },
  })
}

/** The block view seat: the whole content column above the composer. */
export function BlockView(props: {
  pty: PtyStreamService
  sessions: ISessions
  sessionId: SessionId | undefined
  /** Turns an attachment ref into a URL (the conversation service's loader). */
  loadImage: MessageImageLoader | undefined
  /** The SSH plugin's device face; absent in a composition without it. */
  ssh?: SshSeat | undefined
  /** The cross-session pipe's face; absent in a composition without it. */
  pipe?: PipeSeat | undefined
  /**
   * Show a conversation the reader picked — a subagent's, today. Absent in a
   * composition with no view owner, which leaves those rows inert.
   */
  openConversation?: ((target: SessionTarget) => void) | undefined
} & PropsLocale<'dshellMode'>): ReactElement {
  const { t } = props
  const theme = useDshellTheme()
  const seat = useRef<HTMLDivElement | null>(null)
  const probe = useRef<HTMLSpanElement | null>(null)
  const scroll = useRef<HTMLDivElement | null>(null)
  const foldRef = useRef<FoldState | undefined>(undefined)
  /** Messages sent but not yet durable: rendered below the fold's items. */
  const pendingRef = useRef<readonly { key: string; rpcId: string; time: number; text: string }[]>([])
  const [version, setVersion] = useState(0)
  const frame = useRef<number | undefined>(undefined)
  /**
   * Fallback timer for the frame throttle.
   *
   * `requestAnimationFrame` is gated on the page being composited: an IAB tab
   * that is not the foreground window can sit with its RAFs queued indefinitely
   * (Chromium throttles to 1Hz, Firefox pauses outright), which strands any
   * coalesced repaint on `frame.current` and leaves the column showing nothing
   * — the fold populates, the queue grows, but no setVersion ever fires. The
   * timer is the backstop: it always runs and clears `frame.current` when the
   * frame does, so neither half can leave the other waiting forever.
   */
  const fallback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const id = props.sessionId === undefined ? undefined : String(props.sessionId)

  // One render per animation frame at most, with a short-interval fallback for
  // when RAF is throttled. A streaming turn publishes a delta per token and a
  // printing shell a chunk per write; rendering either one per event is what
  // makes the column feel stuck.
  const repaint = useCallback((): void => {
    if (frame.current !== undefined) return
    if (typeof requestAnimationFrame !== 'function') {
      setVersion(value => value + 1)
      return
    }
    let frameId: number
    const flush = (): void => {
      if (frame.current !== frameId) return
      frame.current = undefined
      if (fallback.current !== undefined) { clearTimeout(fallback.current); fallback.current = undefined }
      setVersion(value => value + 1)
    }
    frame.current = frameId = requestAnimationFrame(flush)
    // 200ms is short enough that a quick scroll or a 'Enter' press becomes
    // visible before the user notices, and long enough that a busy stream
    // still coalesces dozens of deltas into one render. The fallback never
    // beats RAF in the foreground (16ms < 200ms), so it only ever matters
    // when the frame is being held.
    fallback.current = setTimeout(flush, 200)
  }, [])
  useEffect(() => () => {
    if (frame.current !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame.current)
    frame.current = undefined
    if (fallback.current !== undefined) { clearTimeout(fallback.current); fallback.current = undefined }
  }, [])

  // The binding (and its event window) materializes shortly after a session
  // opens; retry until it lands, and drop it when the session closes.
  useEffect(() => {
    foldRef.current = undefined
    repaint()
    if (props.sessionId === undefined) return
    const sessionId = props.sessionId
    let bound: SessionEventSource | undefined
    const state: FoldState = {
      sessionId: String(sessionId),
      fold: createFold(),
      watermark: 0,
      todos: [],
      submitted: new Set<string>(),
      inbox: new Map<string, { time: number; text: string }>(),
    }
    // A window-wide rebuild: the initial snapshot, and any mutation that
    // rewrites what came before (a re-baseline or a history prepend).
    const rebuild = (entries: readonly SessionEventLikeEntry[]): void => {
      state.fold = createFold()
      state.watermark = 0
      state.todos = []
      for (const entry of entries) advance(state, entry, t)
      foldRef.current = state
      repaint()
    }
    const accept = (): void => {
      const window = bound?.getSnapshot()
      if (window === undefined) return
      if (window.change.kind === 'replace' || window.change.kind === 'prepend') {
        rebuild(window.entries)
        return
      }
      if (window.change.kind === 'settle-assistant') {
        // The attempt is over: its partial line goes, and the durable message
        // that supersedes it arrives with this very change (never as an
        // append), so it has to be folded here or the answer is lost.
        let changed = clearStream(state.fold.open)
        if (window.change.entry !== undefined) changed = advance(state, window.change.entry, t) || changed
        if (changed) repaint()
        return
      }
      for (const entry of window.change.entries) advance(state, entry, t)
      repaint()
    }
    const tryBind = (): boolean => {
      try {
        const binding = props.sessions.binding(sessionId)
        if (binding === undefined) return false
        bound = binding.eventSource
        rebuild(bound.getSnapshot().entries)
        return true
      } catch {
        return false
      }
    }
    if (!tryBind()) {
      const timer = setInterval(() => { if (tryBind()) clearInterval(timer) }, 500)
      return () => { clearInterval(timer) }
    }
    const unsubscribe = bound?.subscribe(accept)
    // The session snapshot's own view of what the reader has sent: the local
    // submission echo (before the host admits the prompt) and the host queue
    // (once it is admitted). Both are keyed by prompt id and retire on their
    // own; the folded inbox splice and the durable row in the memo cover the
    // rest of the path.
    const face = props.sessions.binding(sessionId)?.session
    let pendingKey = ''
    const readPending = (): void => {
      const snapshot = face?.getSnapshot()
      if (snapshot === undefined) return
      const folded = foldRef.current?.submitted
      const claimed = new Set(foldRef.current?.inbox.keys() ?? [])
      // A rejected prompt never becomes durable: drop its optimistic bubbles
      // instead of leaving a message on screen the agent never received.
      if (snapshot.promptError !== null) foldRef.current?.inbox.clear()
        // ONE list since 0.1.6-alpha.2: the host queue was folded into the local
        // echoes, each carrying the placement it is heading for, so the two
        // sources this used to merge — and de-duplicate by rpc id — are one.
        const entries = snapshot.pendingSubmissions
          .map(entry => ({ rpcId: String(entry.requestId), text: entry.text, time: entry.time }))
        .filter(entry => entry.text.length > 0)
        .filter(entry => !claimed.has(entry.rpcId) && !folded?.has(entry.rpcId))
      const key = entries.map(entry => `${entry.rpcId}\u0000${entry.text}`).join('\u0001')
      if (key === pendingKey) return
      pendingKey = key
      pendingRef.current = entries.map(entry => ({ ...entry, key: `pending:${entry.rpcId}` }))
      repaint()
    }
    const unsubscribePending = face?.subscribe(readPending)
    readPending()
    return () => { unsubscribe?.(); unsubscribePending?.() }
  }, [props.sessions, props.sessionId, repaint])

  // PTY history changes bump the service's version; re-slice the regions.
  useEffect(() => props.pty.state.subscribe(() => { repaint() }), [props.pty, repaint])

  // The device mirror changes on a bind, a device deletion, or a test; the
  // connection screen names the device, so it re-renders with it.
  const { ssh } = props
  useEffect(() => ssh?.subscribe(() => { repaint() }), [ssh, repaint])

  // Keep the PTY's cell grid in step with the column while this tab is active:
  // the shell wraps and pads its own output to the PTY's width, so that width
  // has to be the one the regions render at. Measured from the scroll
  // container's content box — the regions are its children, so this is their
  // width too, minus the padding and any scrollbar that changes it.
  useEffect(() => {
    const el = seat.current
    const box = scroll.current
    if (el === null || box === null) return
    const sync = (): void => {
      const metrics = probe.current?.getBoundingClientRect()
      if (metrics === undefined || metrics.width <= 0) return
      const cellWidth = metrics.width / 40
      if (el.clientHeight <= 0) return
      const style = getComputedStyle(box)
      const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
      const content = box.clientWidth - (Number.isFinite(padding) ? padding : 0)
      if (content <= 0) return
      const cols = Math.min(500, Math.max(20, Math.floor(content / cellWidth)))
      const rows = Math.min(300, Math.max(6, Math.floor(el.clientHeight / SPAN_LINE_HEIGHT)))
      props.pty.resize(cols, rows)
    }
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    // A scrollbar appearing narrows the content box without resizing the seat.
    observer.observe(box)
    sync()
    return () => { observer.disconnect() }
  }, [props.pty, id])

  // The docked task panel lies across the transcript; the floating card takes
  // over while this view is on screen, and hands it back on unmount.
  useEffect(() => {
    injectTodoCardCss()
    setTodoPanelSuppressed(true)
    return () => { setTodoPanelSuppressed(false) }
  }, [])

  // Follow this session's agent terminal while the view is mounted: the card
  // reports whether the agent has a shell (and can open one on request), which
  // it cannot know without a subscription. Watching is not spawning — the host
  // only replays, and the agent's shell appears when the agent first uses it.
  useEffect(() => {
    props.pty.watchAgent(id)
    return () => { props.pty.watchAgent(undefined) }
  }, [props.pty, id])

  const items = useMemo(() => {
    const state = foldRef.current
    // The fold lags a session switch by one render (the binding effect runs
    // after paint), so never pair the new session's blocks with the old fold.
    if (id === undefined || state === undefined || state.sessionId !== id) return []
    // The host cut the stream into blocks as the bytes arrived, so the order
    // is exact by construction — no reconstruction from timestamps.
    // `version` ticks on both a fold change and a PTY output change.
    const items = assembleTimeline(props.pty.blocks(id), state.fold)
    // A just-sent message has no durable row yet, so it trails the fold —
    // soonest first: the host's admitted requests, then the local echo. When
    // its durable event lands, the fold drops it from here.
    const inbox = [...state.inbox].map(([rpcId, entry]) => ({
      key: `inbox:${rpcId}`,
      rpcId,
      time: entry.time,
      text: entry.text,
    }))
    const claimed = new Set(inbox.map(entry => entry.rpcId))
    const extras = [
      ...inbox,
      ...pendingRef.current.filter(entry => !claimed.has(entry.rpcId) && !state.submitted.has(entry.rpcId)),
    ].filter(entry => entry.text.length > 0)
    return extras.length === 0
      ? items
      : [...items, ...extras.map(entry => ({ kind: 'pending' as const, key: entry.key, time: entry.time, text: entry.text }))]
  }, [version, id, props.pty])

  const todos = useMemo<readonly TodoItem[]>(() => {
    const state = foldRef.current
    return id !== undefined && state !== undefined && state.sessionId === id ? state.todos : []
  }, [version, id])

  // What the agent is doing right now, for the status card's one-line head:
  // the newest block the fold still holds open is the turn in flight, and its
  // title is the phase (a todo item) the reader last saw. The card decides
  // whether a turn is actually running — see there.
  const activity = useMemo(() => {
    const state = foldRef.current
    if (id === undefined || state === undefined || state.sessionId !== id) return undefined
    for (let index = state.fold.blocks.length - 1; index >= 0; index -= 1) {
      const block = state.fold.blocks[index]
      if (block?.status === 'running') return block.title.length > 0 ? block.title : undefined
    }
    return undefined
  }, [version, id])

  // Hand the two fold-derived facts to the session header's status chip: that
  // surface sits outside this view and folds nothing itself.
  useEffect(() => {
    if (id === undefined) return
    publishSessionStatus(String(id), { todos, activity })
  }, [id, todos, activity])

  // The right-edge bookmark rail: one tick per agent turn in this session.
  // `bookmarksOf` reads the same fold the column renders, so the strip stays
  // in step with the cards — every turn that appears below also appears on
  // the rail. Empty when the session has not had an agent yet, in which case
  // the rail returns null and the surface looks exactly as it did before.
  const bookmarks = useMemo(() => {
    const state = foldRef.current
    return id !== undefined && state !== undefined && state.sessionId === id
      ? bookmarksOf(state.fold.blocks, t('bookmark.empty'))
      : []
  }, [version, id, t])
  // A jump unsticks the tail-pin so a fresh turn does not drag the reader
  // back to the bottom while they are still reading an earlier block.
  const handleJump = useCallback((): void => { pinned.current = false }, [])

  // How this session's terminal is doing. The wire state belongs to the
  // session it names, so a switch mid-render reads as "nothing yet" rather
  // than as the previous session's failure.
  //
  // The DEVICE BINDING is a property of the session, not of the wire, so it is
  // read without that gate: whether this is an ssh session decides which
  // connection UI the session is even eligible for, and that answer must not
  // depend on the PTY having caught up. Only the wire facts are gated, and a
  // stale `status` reads as `idle` — which draws nothing either way.
  const pty = props.pty.state.getSnapshot()
  const current = pty.sessionId === id
  const binding = id === undefined ? undefined : ssh?.bindingOf(id)
  const device = binding === undefined
    ? undefined
    : ssh?.devices().find(candidate => candidate.id === binding.deviceId)?.name ?? binding.deviceId
  const connection = connectionView({
    status: current ? pty.status : 'idle',
    ready: pty.ready,
    attempt: pty.attempt,
    bound: binding !== undefined,
    localUnsupported: current && pty.localUnsupported,
    failure: current ? pty.failure : undefined,
  })
  const retry = useCallback((): void => { props.pty.reconnect() }, [props.pty])
  // The session goes with the request: a refusal about a locked group should
  // land the reader in THAT group's unlock box, not merely beside the vault.
  const openSettings = ssh === undefined || id === undefined
    ? undefined
    : (): boolean => ssh.revealSettings(id)
  // A spawn the host refused for a locked group is the one failure with a door
  // on the failure screen itself: the group is named from this session's own
  // binding, and its token is taken here. The host's marker says the refusal
  // WAS the lock — without it an unrelated failure on a session whose group
  // happens to be locked would offer a token that cannot help.
  const lockedGroup = connection.kind === 'panel' && connection.phase === 'failed'
    && current && pty.lockedGroup && id !== undefined
    ? ssh?.lockedGroupForSession(id)
    : undefined
  const unlock = useCallback(async (token: string): Promise<void> => {
    if (lockedGroup === undefined || ssh === undefined) return
    await ssh.unlock(lockedGroup.id, token)
    // The host rebuilt this device's connection with the new key, so the retry
    // that could not have worked a moment ago is now the connection coming up.
    props.pty.reconnect()
  }, [lockedGroup, props.pty, ssh])

  // Both fingerprints for the changed-key screen, fetched only while it is up:
  // the scan opens a connection to the host under suspicion, so it is not worth
  // paying for on a terminal that is working.
  const deviceId = binding?.deviceId
  const [hostKeys, setHostKeys] = useState<HostKeyFacts | undefined>(undefined)
  useEffect(() => {
    if (connection.kind !== 'panel' || connection.phase !== 'hostKey' || ssh === undefined || deviceId === undefined) {
      setHostKeys(undefined)
      return
    }
    let live = true
    void Promise.all([ssh.hostKeys(deviceId), ssh.probeHostKey(deviceId)])
      .then(([trusted, claimed]) => {
        if (live) setHostKeys({ trusted, claimed, ready: true })
      })
      .catch(() => {
        // A refusal here leaves the screen standing on its own wording, which is
        // the point: the reader must not read "both unknown" as "nothing to see".
        if (live) setHostKeys({ trusted: [], claimed: undefined, ready: true })
      })
    return () => { live = false }
  }, [connection.kind === 'panel' ? connection.phase : '', deviceId, ssh])

  // Trust-and-reconnect is revoke THEN reconnect, never a relaxed check: the
  // next connection still goes through the normal path and records whatever the
  // device presents, so the decision stays the user's and not the flag's.
  const trustAnyway = useCallback((): void => {
    if (ssh === undefined || deviceId === undefined) return
    void ssh.revokeHostKey(deviceId).then(() => { props.pty.reconnect() })
  }, [deviceId, props.pty, ssh])

  // Follow the tail unless the reader has scrolled away.
  const pinned = useRef(true)
  useEffect(() => {
    const el = scroll.current
    if (el !== null && pinned.current) el.scrollTop = el.scrollHeight
  })

  return createElement('div', {
    ref: seat,
    'data-dshell-terminal-view': 'blocks',
    // The seat is the view area's flex child. Its only child is absolutely
    // positioned, so the seat contributes no intrinsic height: the view area
    // keeps its own height (clear of the composer) instead of growing to the
    // column's content. Without that, `flex: 1 0 auto` on the view area makes
    // the whole page scroll and the composer lands on top of the content.
    style: {
      position: 'relative',
      flex: '1 1 auto',
      minHeight: 0,
      minWidth: 0,
      overflow: 'hidden',
      background: theme.bg,
    },
  },
    createElement('span', {
      ref: probe,
      style: {
        position: 'absolute', visibility: 'hidden', whiteSpace: 'pre',
        font: `${String(SPAN_FONT_SIZE)}px ${SPAN_FONT}`,
      },
    }, 'W'.repeat(40)),
    createElement('div', {
      ref: scroll,
      'data-dshell-block-view': '',
      onScroll: () => {
        const el = scroll.current
        if (el === null) return
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      },
      style: {
        position: 'absolute',
        inset: 0,
        overflowY: 'auto',
        // The status lives in the session header now, so the column keeps its
        // own top padding: nothing floats over the terminal's first line.
        padding: '10px 10px 2px',
      },
    },
      ...items.flatMap((item, index) => {
        const previous = items[index - 1]
        // A hairline only where a shell stretch ends and a task begins: enough
        // to see the boundary without boxing either of them in. A pending
        // bubble belongs to the task it was sent to, so it draws none.
        const divider = previous !== undefined && (previous.kind === 'shell') !== (item.kind === 'shell')
          ? [createElement('div', {
              key: `${item.key}:sep`,
              style: { height: 1, background: theme.border, margin: '12px 0' },
            })]
          : []
        // The key is the item alone: including the output version remounted
        // every region on every chunk, which threw away its terminal (and the
        // incremental append path with it) instead of appending to it.
        const node = item.kind === 'shell'
          ? createElement(ShellRegion, { key: item.key, item, theme })
          : item.kind === 'command'
            ? createElement('div', {
              key: item.key,
              style: {
                fontFamily: SPAN_FONT,
                fontSize: 12,
                color: theme.muted,
                opacity: 0.85,
                margin: '6px 2px',
                whiteSpace: 'pre-wrap',
              },
            }, `▸ ${item.text}`)
            : item.kind === 'pending'
            ? createElement(UserBubble, { key: item.key, text: item.text, loadImage: props.loadImage, theme, t })
            : createElement(AgentBlock, { key: item.key, block: item.block, theme, loadImage: props.loadImage, t })
        return [...divider, node]
      }),
      // The connection marker closes the output, where the shell stopped. It
      // scrolls with the content and disappears when the shell is back.
      connection.kind === 'notice'
        ? createElement(ConnectionNotice, {
          key: 'connection',
          tone: connection.tone,
          device,
          reason: pty.reason,
          detail: pty.detail,
          attempt: pty.attempt,
          maxAttempts: pty.maxAttempts,
          exhausted: pty.exhausted,
          since: pty.since,
          sessionKey: id,
          onRetry: retry,
          ...openSettings === undefined ? {} : { onSettings: openSettings },
          t,
        })
        : null,
    ),
    // The intermediate screen is the seat's own overlay: a device session that
    // never came up has nothing behind it worth reading.
    connection.kind === 'panel'
      ? createElement(ConnectionPanel, {
        key: 'connection-panel',
        phase: connection.phase,
        device,
        reason: pty.reason,
        detail: pty.detail,
        since: pty.since,
        attempt: pty.attempt,
        maxAttempts: pty.maxAttempts,
        exhausted: pty.exhausted,
        sessionKey: id,
        // On the changed-key screen the retry IS the revoke, so it is the
        // caller's composed action rather than the plain reconnect.
        onRetry: connection.phase === 'hostKey' ? trustAnyway : retry,
        ...connection.phase === 'hostKey' ? { hostKeys } : {},
        ...lockedGroup === undefined ? {} : { lockedGroup, onUnlock: unlock },
        ...openSettings === undefined ? {} : { onSettings: openSettings },
        t,
      })
      : null,
    // The right-edge bookmark rail sits on top of the column at zIndex 2 —
    // below the connection panel (3) but above the scroll container, so it
    // can scroll with the content when the column moves while keeping its
    // own hover area interactive. It is null when there are no agent turns.
    createElement(BookmarkRail, {
      bookmarks,
      scrollContainer: scroll.current,
      onJump: handleJump,
      t,
    }),
  )
}
