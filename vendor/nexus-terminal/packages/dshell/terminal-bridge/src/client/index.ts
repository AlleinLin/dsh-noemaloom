/**
 * dshell-terminal-bridge browser face — Phase 3.
 *
 * Opens one ws against `/dshell/pty`, binds it to the current dsh
 * session, and relays wire frames (§ 5) into a capped per-connection
 * frame store that the Phase 4 xterm.js canvas will render. Rebinds on
 * session switches and reconnects with a fixed delay after drops.
 *
 * `window.__DSHELL_PTY__` is the Phase 3 acceptance handle: it drives
 * input and reads the relayed buffer from the console. Phase 4 replaces
 * the console relay with the canvas.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { mainSessionId } from '@nexus-aethra/dshell-std'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the sessions service merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the locale service merge (ctx.locale) and this namespace's keys.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { en, zh } from './locales.js'
import { sendLocaleReport } from './locale-report.js'
import {
  TIMELINE_LIMITS,
  loadTimeline,
  saveTimeline,
  segmentsOf,
  splitByTime,
  timelineBytes,
  type PtyTextSegment,
  type TimelineEntry,
} from './timeline.js'
import {
  openPtyChannel,
  resolvedTransport,
  setTransportPreference,
  type PtyChannel,
  type PtyTransport,
  type WireFrame,
} from './channel.js'

export type { PtyTextSegment, TimelineEntry } from './timeline.js'
export type { PtyTransport } from './channel.js'

export const name = '@nexus-aethra/dshell-terminal-bridge/client'

export const inject = ['sessions', 'locale'] as const

/** This package's copy namespace. */
const NS = 'dshellTerminalBridge'

/** One host-defined block: a shell stretch or one agent turn, in order. */
export interface PtyBlock {
  readonly seq: number
  readonly kind: 'shell' | 'agent'
  readonly turn?: number | undefined
  readonly commandId?: string | undefined
  readonly startedAt: number
  readonly endedAt?: number | undefined
  readonly text: string
}

/** One PTY output chunk with its arrival time. */
export interface PtyChunk {
  text: string
  time: number
  /** True for the bind replay (4.9 seeded tail) or a resync. */
  replay: boolean
  /**
   * On a replay, the host's own arrival timeline for this text: a replay is
   * one frame, so without it the whole scrollback would carry a single
   * timestamp and every shell region would collapse to one end of the
   * timeline.
   */
  timeline?: readonly { t: number; n: number }[]
}

/** What the host reported about a full-screen program on the terminal. */
export interface TuiReading {
  /** The program holding the terminal's foreground, or null for the shell. */
  readonly program: string | null
  /** Whether the alternate screen is in use. */
  readonly alt: boolean
  /** Whether the surface belongs to that program rather than to the timeline. */
  readonly active: boolean
}

export interface PtyStreamState {
  sessionId: string | undefined
  status: 'idle' | 'connecting' | 'open' | 'closed' | 'error'
  /** Bumped on every history change; read the text via {@link read}. */
  version: number
  /**
   * What the host last reported about a full-screen program on this terminal.
   *
   * Undefined until the host has something to say — a shell nobody has run a
   * program in never sends one, and the view reads undefined as "the timeline".
   */
  tui: TuiReading | undefined
  /** Why the shell (or the wire) ended, as the host reported it. */
  reason: string | undefined
  /** The last connection diagnostic the output held, when the host found one. */
  detail: string | undefined
  /**
   * Whether the bound shell ever reached a prompt.
   *
   * Host-reported, because only the host sees the shell's own output: the
   * difference between a connection that dropped and one that never came up is
   * invisible from the wire alone, and the two need opposite presentations
   * (a marker appended to a working terminal vs. a full failure screen).
   */
  ready: boolean
  /** Automatic reconnect attempts spent since this connection last worked. */
  attempt: number
  /** How many automatic attempts are allowed before the client stops. */
  maxAttempts: number
  /** True once the automatic budget is gone: only a manual retry remains. */
  exhausted: boolean
  /** When the current connection attempt started, for the view's elapsed count. */
  since: number
  /**
   * Host-reported: this machine cannot host a local shell at all.
   *
   * A separate fact from `reason` because the view has to CHOOSE a
   * presentation from it. A local session that merely failed gets a marker
   * appended to output the user was reading; one that failed because the
   * platform has no shell for it has no output to append to, and gets a screen
   * that names the way out (bind a device).
   */
  localUnsupported: boolean
  /**
   * Host-reported: the spawn was refused because the session's device draws its
   * credential from a locked vault group.
   *
   * Separate from `reason` for the same reason `localUnsupported` is: the view
   * has to CHOOSE a presentation. This is the one failure whose remedy is a
   * token the reader can type on the failure screen itself, and the one an
   * automatic retry cannot fix — the same refusal comes back until the group is
   * unlocked — so the retry budget is kept for the attempt after that.
   */
  lockedGroup: boolean
  /**
   * Host-reported: no shell was ever attempted for this session, because the
   * session has no live agent to run one.
   *
   * Separate from `status` for the same reason `lockedGroup` is: the view has
   * to CHOOSE a presentation. A session nobody has sent anything to is WAITING
   * — it is not a broken connection and it is not a failure the reader has to
   * act on — and a chip that read it as a failure announced a fault that had
   * not happened, then lost the fact that the session was simply waiting for
   * its first command.
   */
  noShell: boolean
  /**
   * Host-reported: this failure is one the user can act on.
   *
   * Separate from `reason` for the same reason `localUnsupported` is: the view
   * has to CHOOSE a presentation, and the message text alone does not say which
   * one. A wrong passphrase and a refused password are both "Permission denied"
   * to the reader, and they need opposite things.
   */
  failure: 'passphrase' | 'hostKey' | undefined
}

/** Browser render-buffer cap per session: the canvas replays from this store. */
const HISTORY_MAX_BYTES = 256 * 1024
const HISTORY_MAX_FRAMES = 1000

/**
 * The agent's own shell, as the task card's panel sees it.
 *
 * A separate store from {@link PtyStreamState} because it is a separate stream
 * with a separate lifetime: the user's terminal is bound for as long as a
 * session is open, while this one is watched by an optional panel and its shell
 * may not exist at all.
 */
export interface AgentStreamState {
  /** The session whose agent shell this is. */
  sessionId: string | undefined
  /** Wire state of the panel's own socket. */
  status: 'idle' | 'connecting' | 'open' | 'closed' | 'error'
  /** Whether the agent actually has a shell (spawned and not dead). */
  live: boolean
  /** Whether that shell reached its first prompt. */
  ready: boolean
  /** Why the shell ended, or why the socket failed. */
  reason: string | undefined
  /** The connection diagnostic the shell's output held, when there was one. */
  detail: string | undefined
  /** Bumped whenever the text or the state changes; read text via {@link agentText}. */
  version: number
}

/**
 * Automatic reconnect budget, and the backoff between attempts.
 *
 * Bounded on purpose. An unbounded retry loop is indistinguishable from a hang
 * — the view would sit in "connecting" forever against a host that is simply
 * gone — so after this many attempts the client stops and hands the decision
 * back to the user, who gets a button and a stated reason.
 */
const MAX_AUTO_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 1000

/**
 * Drop `count` characters from the front of a history's arrival timeline,
 * splitting the entry that straddles the cut.
 */
function dropTimeline(history: SessionHistory, count: number): void {
  let remaining = count
  while (remaining > 0 && history.timeline.length > 0) {
    const head = history.timeline[0]
    if (head === undefined) return
    if (head.n <= remaining) {
      remaining -= head.n
      history.timeline.shift()
      history.recorded -= head.n
    } else {
      head.n -= remaining
      history.recorded -= remaining
      remaining = 0
    }
  }
}

/** Debounce before a changed timeline is written back to localStorage. */
const TIMELINE_SAVE_DELAY_MS = 500

interface SessionHistory {
  chunks: PtyChunk[]
  bytes: number
  /** Arrival timeline of live frames, oldest first (see the storage block). */
  timeline: TimelineEntry[]
  /** Bytes the timeline accounts for. */
  recorded: number
  /** Debounced localStorage write. */
  saveTimer: ReturnType<typeof setTimeout> | undefined
}

/** Client face of the PTY wire: one ws, per-session frame histories. */
export class PtyStreamService extends Service {
  readonly state = createSnapshotStore<PtyStreamState>({
    sessionId: undefined,
    status: 'idle',
    version: 0,
    tui: undefined,
    reason: undefined,
    detail: undefined,
    ready: false,
    attempt: 0,
    maxAttempts: MAX_AUTO_ATTEMPTS,
    exhausted: false,
    since: Date.now(),
    localUnsupported: false,
    lockedGroup: false,
    noShell: false,
    failure: undefined,
  })

  /** OS identity from the server's `info` frame (bash prompt material). */
  readonly host = createSnapshotStore<{ user: string; host: string; home: string }>({
    user: '',
    host: '',
    home: '',
  })

  /**
   * The agent's own shell: whether it exists, and what it has printed.
   *
   * Read by the task card, which shows the state in its summary and the text in
   * its expandable panel. Kept apart from the main stream so a session whose
   * agent never touches a terminal carries no state for it at all.
   */
  readonly agent = createSnapshotStore<AgentStreamState>({
    sessionId: undefined,
    status: 'idle',
    live: false,
    ready: false,
    reason: undefined,
    detail: undefined,
    version: 0,
  })

  private readonly histories = new Map<string, SessionHistory>()
  /** Per-session block lists, exactly as the host ordered them. The stored
   * copy is mutable because a live block grows by deltas. */
  private readonly blockLists = new Map<string, {
    seq: number
    kind: 'shell' | 'agent'
    turn?: number | undefined
    startedAt: number
    endedAt?: number | undefined
    text: string
  }[]>()
  private readonly chunkListeners = new Set<(sessionId: string, chunk: PtyChunk) => void>()
  private channel: PtyChannel | undefined
  /** The session the current channel was opened (or is connecting) for. */
  private channelSession: string | undefined
  private desiredId: string | undefined
  private boundId: string | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * The grid the view last asked for.
   *
   * Kept because the request can arrive before the socket is up (the view
   * measures on mount, the socket may still be connecting) and because a
   * reconnected or newly spawned shell must not start at the backend's default
   * size. Without this the PTY keeps whatever size it was spawned with, so the
   * shell wraps and pads its output to a width the view does not have.
   */
  private desiredSize: { cols: number; rows: number } | undefined
  /** Automatic attempts spent since this connection last carried output. */
  private attempt = 0
  /** Per-session text of the agent shell, capped like the main history. */
  private readonly agentChunks = new Map<string, PtyChunk[]>()
  private readonly agentBytes = new Map<string, number>()
  private agentChannel: PtyChannel | undefined
  private agentChannelSession: string | undefined
  /** The panel's requested width, replayed when the socket (re)opens. */
  private agentCols: number | undefined
  /** A reopen was asked for before the socket finished opening. */
  private agentSpawnRequested = false

  /** This package's copy, read at call time so a language switch is picked up. */
  private readonly t: TranslateNS<typeof NS>

  constructor(ctx: Context) {
    super(ctx, 'dshellPtyStream')
    this.t = ctx.locale.bind(NS)
  }

  /** The persisted-and-live PTY text of one session (oldest first). */
  read(dshSessionId: string): string {
    const history = this.histories.get(dshSessionId)
    if (history === undefined) return ''
    let text = ''
    for (const chunk of history.chunks) text += chunk.text
    return text
  }

  /** The session's host-defined blocks, in render order. */
  blocks(dshSessionId: string): readonly PtyBlock[] {
    return this.blockLists.get(dshSessionId) ?? []
  }

  /** The session's timed chunk list — the canvas merge's PTY side (4.4). */
  chunks(dshSessionId: string): readonly PtyChunk[] {
    return this.histories.get(dshSessionId)?.chunks ?? []
  }

  /**
   * The session's PTY text cut at wall-clock boundaries: piece i is what the
   * terminal printed before the i-th boundary, and the final piece is
   * everything after the last one. The block view uses the task starts as
   * boundaries, so each shell stretch lands between the tasks it sat between.
   * @param dshSessionId - the session whose text to cut.
   * @param boundaries - ascending epoch-ms cuts.
   * @returns `boundaries.length + 1` pieces, oldest first.
   */
  slices(dshSessionId: string, boundaries: readonly number[]): readonly { text: string; time: number }[] {
    const history = this.histories.get(dshSessionId)
    if (history === undefined) return []
    return splitByTime(this.read(dshSessionId), history.timeline, history.chunks, boundaries)
  }

  /**
   * The session's PTY text as timed segments. A bind replay arrives as one
   * frame, so a rebuild that used chunk timestamps would place the whole
   * scrollback at the moment of the bind; this slices it back with the
   * arrival times recorded per live frame.
   * @param dshSessionId - the session whose stream to slice.
   * @returns oldest-first segments; a session with no recorded timeline falls
   *   back to its chunks, which is what a fresh browser sees.
   */
  segments(dshSessionId: string): readonly PtyTextSegment[] {
    const history = this.histories.get(dshSessionId)
    if (history === undefined) return []
    if (history.timeline.length === 0) {
      return history.chunks.filter(chunk => chunk.text.length > 0).map(chunk => ({ text: chunk.text, time: chunk.time }))
    }
    return segmentsOf(this.read(dshSessionId), history.timeline)
  }


  /**
   * Retry the bound session's connection now, from the user's button.
   *
   * The automatic loop has a budget; this spends a fresh one, which is the
   * whole point of the button existing — including the case where the budget
   * ran out hours ago.
   */
  reconnect(): void {
    const id = this.desiredId
    if (id === undefined) return
    this.clearRetryTimer()
    this.attempt = 0
    // A reconnect is a FRESH attempt: whatever the last one was refused for
    // may have been fixed since — a group the reader has just unlocked, most
    // of all. Leaving the old refusal in place would keep the chip saying
    // "locked" after the lock is gone.
    this.patch({ attempt: 0, exhausted: false, lockedGroup: false })
    this.performReconnect(id)
  }

  /** Switch the connection to one session (undefined disconnects). */
  bind(dshSessionId: string | undefined): void {
    this.desiredId = dshSessionId
    if (dshSessionId === undefined) {
      this.closeChannel()
      return
    }
    // Idempotent while the channel for this session is still connecting or
    // open: sessions.list churns several times around a session switch and
    // a redundant open would leave two live carriers feeding one history.
    const channel = this.channel
    if (channel !== undefined && this.channelSession === dshSessionId
      && channel.status !== 'closed') return
    this.openChannel(dshSessionId)
  }

  /** The carrier the live main connection is using, if there is one. */
  carrier(): 'ws' | 'stream' | undefined {
    return this.channel?.transport
  }

  /**
   * Choose the carrier and re-open both streams on it.
   *
   * `auto` is the default and asks the page what it can reach; the explicit
   * values exist so the stream path can be exercised from a browser (where ws
   * would otherwise always win) and so a shell whose stream path misbehaves has
   * a way back without a code change.
   * @param preference - the carrier to use from now on.
   */
  useTransport(preference: PtyTransport): void {
    setTransportPreference(preference)
    const main = this.desiredId
    if (main !== undefined) {
      this.closeChannel()
      this.openChannel(main)
    }
    const agent = this.agent.getSnapshot().sessionId
    if (agent !== undefined) {
      this.closeAgentChannel()
      this.openAgentChannel(agent)
    }
  }

  /** The carrier this page will use for the next connection. */
  transportInUse(): 'ws' | 'stream' {
    return resolvedTransport()
  }

  /** Forward one input chunk to the bound main PTY. */
  send(text: string): void {
    if (this.boundId === undefined || this.channel?.status !== 'open') return
    this.channel.send({ kind: 'input', sessionId: this.boundId, text })
  }

  /**
   * Resize the bound main PTY (the raw backend honors cols/rows).
   *
   * The request is remembered as well as sent: this can run before the socket
   * is open, and the size has to be replayed when it is, or the PTY keeps the
   * backend's default grid for the session's whole life.
   */
  resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return
    this.desiredSize = { cols, rows }
    this.flushSize()
  }

  /** Send the remembered grid, if the bound socket can carry it. */
  private flushSize(): void {
    if (this.boundId === undefined || this.desiredSize === undefined) return
    if (this.channel?.status !== 'open') return
    this.channel.send({ kind: 'resize', sessionId: this.boundId, ...this.desiredSize })
  }

  /**
   * Spend one automatic reconnect attempt, or stop when the budget is gone.
   *
   * Only the session the UI still wants is retried, and only one timer runs at
   * a time: a superseded socket's death must not start a loop for a session
   * nobody is looking at. When the budget runs out the state says so
   * (`exhausted`), which is what turns the view's marker into a manual button
   * instead of an endless "connecting".
   */
  private scheduleRetry(): void {
    const id = this.desiredId
    if (id === undefined) return
    if (this.reconnectTimer !== undefined) return
    if (this.attempt >= MAX_AUTO_ATTEMPTS) {
      this.patch({ exhausted: true, attempt: this.attempt })
      return
    }
    this.attempt += 1
    this.patch({
      attempt: this.attempt,
      maxAttempts: MAX_AUTO_ATTEMPTS,
      exhausted: false,
      status: 'connecting',
      since: Date.now(),
    })
    const delay = RETRY_BASE_DELAY_MS * 2 ** (this.attempt - 1)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      const current = this.desiredId
      if (current !== undefined) this.performReconnect(current)
    }, delay)
  }

  /**
   * One reconnect attempt, by whichever layer is actually broken: a live
   * socket means the session's shell is what died, so the host is asked to
   * replace it; a dead socket means the wire itself is gone, so it is reopened.
   */
  private performReconnect(id: string): void {
    const channel = this.channel
    if (channel !== undefined && this.channelSession === id) {
      if (channel.status === 'connecting') return
      if (channel.status === 'open' && this.boundId === id) {
        this.patch({ status: 'connecting', since: Date.now() })
        channel.send({ kind: 'reconnect', sessionId: id })
        return
      }
    }
    this.openChannel(id)
  }

  /**
   * A live shell answered: the connection works, so the budget and the failure
   * report both go. Called on every non-replay output frame — the one signal
   * that means the shell is truly there.
   */
  private resetRetry(): void {
    this.clearRetryTimer()
    if (this.attempt === 0 && !this.state.getSnapshot().exhausted
      && this.state.getSnapshot().reason === undefined) return
    this.attempt = 0
    this.patch({ attempt: 0, exhausted: false, reason: undefined, detail: undefined, lockedGroup: false, noShell: false })
  }

  private clearRetryTimer(): void {
    if (this.reconnectTimer === undefined) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  /**
   * Subscribe to every ingested chunk, tagged with its session — the
   * canvas renderer streams frames into the xterm buffer incrementally.
   */
  onChunk(listener: (sessionId: string, chunk: PtyChunk) => void): () => void {
    this.chunkListeners.add(listener)
    return () => { this.chunkListeners.delete(listener) }
  }

  /** Deliver a foreground signal to the bound main PTY. */
  sendSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGTSTP'): void {
    if (this.boundId === undefined || this.channel?.status !== 'open') return
    this.channel.send({ kind: 'signal', sessionId: this.boundId, signal })
  }

  /**
   * Watch one session's agent shell (undefined stops watching).
   *
   * Subscribing is not spawning: the panel learns whether the agent has a
   * terminal, and only {@link openAgentTerminal} asks the host to make one.
   * The socket is idempotent per session, so a re-render never reconnects.
   */
  watchAgent(dshSessionId: string | undefined): void {
    if (dshSessionId === undefined) {
      this.closeAgentChannel()
      return
    }
    const channel = this.agentChannel
    if (channel !== undefined && this.agentChannelSession === dshSessionId
      && channel.status !== 'closed') return
    this.openAgentChannel(dshSessionId)
  }

  /** The agent shell's text for one session (oldest first, capped). */
  agentText(dshSessionId: string): string {
    const chunks = this.agentChunks.get(dshSessionId)
    if (chunks === undefined) return ''
    let text = ''
    for (const chunk of chunks) text += chunk.text
    return text
  }

  /**
   * Ask the host for the agent's shell now — the panel's "open it" action.
   *
   * The agent itself spawns this shell the first time it runs a command, so
   * this exists for the reader who wants to watch before the agent gets there
   * (and for a shell that died and has to be replaced).
   */
  openAgentTerminal(): void {
    const id = this.agent.getSnapshot().sessionId
    if (id === undefined) return
    this.watchAgent(id)
    const channel = this.agentChannel
    if (channel === undefined) return
    if (channel.status === 'open') channel.send({ kind: 'agent-open', sessionId: id })
    else this.agentSpawnRequested = true
  }

  /**
   * Tell the host how wide the panel is, so the agent's shell wraps there.
   *
   * Only the width: the agent's shell keeps a full terminal's rows and the
   * panel is a scrolling window onto them.
   */
  resizeAgent(cols: number): void {
    if (cols <= 0) return
    this.agentCols = Math.floor(cols)
    const channel = this.agentChannel
    if (channel?.status !== 'open') return
    channel.send({ kind: 'resize', cols: this.agentCols })
  }

  /** Close the panel's channel; the main stream is untouched. */
  private closeAgentChannel(): void {
    this.agentChannel?.dispose()
    this.agentChannel = undefined
    this.agentChannelSession = undefined
    this.agentSpawnRequested = false
  }

  private openAgentChannel(dshSessionId: string): void {
    this.closeAgentChannel()
    const previous = this.agent.getSnapshot()
    const sameSession = previous.sessionId === dshSessionId
    this.agent.set({
      sessionId: dshSessionId,
      status: 'connecting',
      // A reconnect to the same session keeps what is known about its shell;
      // a different session starts from nothing.
      live: sameSession && previous.live,
      ready: sameSession && previous.ready,
      reason: undefined,
      detail: undefined,
      version: previous.version,
    })
    let channel: PtyChannel
    channel = openPtyChannel({
      sessionId: dshSessionId,
      stream: 'agent',
      handlers: {
        onOpen: () => {
          // The stream carrier already bound this panel through its GET; the
          // frame is what the ws carrier needs, and the host treats it as a
          // no-op on the other path.
          channel.send({ kind: 'bind', sessionId: dshSessionId, stream: 'agent' })
          this.patchAgent({ status: 'open' })
          if (this.agentCols !== undefined) channel.send({ kind: 'resize', cols: this.agentCols })
          if (this.agentSpawnRequested) {
            this.agentSpawnRequested = false
            channel.send({ kind: 'agent-open', sessionId: dshSessionId })
          }
        },
        onFrame: (frame) => {
          if (this.agentChannel !== channel) return
          this.ingestAgentFrame(dshSessionId, frame)
        },
        onClose: () => {
          if (this.agentChannel !== channel) return
          this.agentChannel = undefined
          this.agentChannelSession = undefined
          const reason = this.agent.getSnapshot().reason ?? this.t('disconnect')
          this.patchAgent({ status: 'closed', reason })
        },
        onError: () => {
          if (this.agentChannel !== channel) return
          this.patchAgent({ status: 'error' })
        },
      },
    })
    this.agentChannel = channel
    this.agentChannelSession = dshSessionId
  }

  /** Fold one agent-stream frame into the panel's state and text. */
  private ingestAgentFrame(dshSessionId: string, frame: WireFrame): void {
    if (frame.kind === 'output' && typeof frame.chunk === 'string') {
    const chunk: PtyChunk = { text: frame.chunk, time: frame.time ?? Date.now(), replay: frame.replay === true }
    if (chunk.replay) {
      this.agentChunks.set(dshSessionId, [chunk])
      this.agentBytes.set(dshSessionId, chunk.text.length)
    } else {
      const chunks = [...(this.agentChunks.get(dshSessionId) ?? []), chunk]
      let bytes = (this.agentBytes.get(dshSessionId) ?? 0) + chunk.text.length
      while (bytes > HISTORY_MAX_BYTES || chunks.length > HISTORY_MAX_FRAMES) {
        const dropped = chunks[0]
        if (dropped === undefined || chunks.length === 1) break
        chunks.shift()
        bytes -= dropped.text.length
      }
      this.agentChunks.set(dshSessionId, chunks)
      this.agentBytes.set(dshSessionId, bytes)
    }
    this.patchAgent({ status: 'open', live: true, version: this.agent.getSnapshot().version + 1 })
    return
    }
    if (frame.kind === 'agent-info') {
    this.patchAgent({
      live: frame.live === true,
      ready: frame.ready === true,
      reason: typeof frame.reason === 'string' ? frame.reason : undefined,
      detail: typeof frame.detail === 'string' ? frame.detail : undefined,
      version: this.agent.getSnapshot().version + 1,
    })
    return
    }
    if (frame.kind === 'ready') {
    this.patchAgent({ ready: frame.ready !== false })
    return
    }
    if (frame.kind === 'closed') {
    this.patchAgent({
      status: 'closed',
      live: false,
      ready: frame.ready === true,
      reason: typeof frame.reason === 'string' ? frame.reason : undefined,
      detail: typeof frame.detail === 'string' ? frame.detail : undefined,
      version: this.agent.getSnapshot().version + 1,
    })
    return
    }
    if (frame.kind === 'error') {
      this.patchAgent({
        status: 'error',
        reason: typeof frame.message === 'string' ? frame.message : undefined,
        detail: undefined,
      })
    }
  }

  private patchAgent(patch: Partial<AgentStreamState>): void {
    this.agent.set({ ...this.agent.getSnapshot(), ...patch })
  }

  private openChannel(dshSessionId: string): void {
    this.closeChannel()
    if (this.state.getSnapshot().sessionId !== dshSessionId) {
      // A different session starts from a clean slate: the retry budget, the
      // failure report and the readiness all belong to the session that earned
      // them, and carrying them over would show session B's view the state of
      // session A.
      this.attempt = 0
      this.patch({
        sessionId: dshSessionId,
        status: 'connecting',
        // A different session has its own terminal, so the previous one's
        // reading is not about this one. The bind's own snapshot fills it in.
        tui: undefined,
        reason: undefined,
        detail: undefined,
        ready: false,
        attempt: 0,
        maxAttempts: MAX_AUTO_ATTEMPTS,
        exhausted: false,
        since: Date.now(),
        // A new session has not failed yet, whatever the last one did.
        localUnsupported: false,
        lockedGroup: false,
        noShell: false,
        failure: undefined,
      })
    } else {
      this.patch({ sessionId: dshSessionId, status: 'connecting', since: Date.now() })
    }
    let channel: PtyChannel
    channel = openPtyChannel({
      sessionId: dshSessionId,
      stream: 'main',
      handlers: {
        onOpen: () => {
          // The stream carrier already bound this connection through its GET;
          // the frame is what the ws carrier needs, and the host treats it as
          // a no-op on the other path.
          channel.send({ kind: 'bind', sessionId: dshSessionId })
          this.boundId = dshSessionId
          this.patch({ status: 'connecting' })
          // Replay the grid this session's view already asked for: a request
          // made while the carrier was still connecting was remembered, not
          // lost, and the shell about to be spawned must start at it.
          this.flushSize()
        },
        onFrame: (frame) => {
          // A superseded channel (handover already moved on) must never feed
          // history: its carrier may still deliver while it winds down.
          if (this.channel !== channel) return
          this.ingestMainFrame(dshSessionId, frame)
        },
        onClose: () => {
          // Only the current channel owns teardown and reconnection; a
          // superseded carrier's close (handover or deliberate disconnect)
          // must not clear live state or schedule a reconnect.
          if (this.channel !== channel) return
          this.channel = undefined
          this.channelSession = undefined
          this.boundId = undefined
          if (this.desiredId === undefined) return
          const reason = this.state.getSnapshot().reason ?? this.t('disconnect')
          this.patch({ status: 'closed', reason })
          this.scheduleRetry()
        },
        onError: () => {
          if (this.channel !== channel) return
          this.patch({ status: 'error' })
        },
      },
    })
    this.channel = channel
    this.channelSession = dshSessionId
  }

  /** Fold one main-stream frame into the session's state and history. */
  private ingestMainFrame(dshSessionId: string, frame: WireFrame): void {
    if (frame.kind === 'output' && typeof frame.chunk === 'string') {
      this.boundId = dshSessionId
      if (frame.replay !== true) this.resetRetry()
      this.patch({ status: 'open' })
      this.ingest(dshSessionId, {
        text: frame.chunk,
        time: frame.time ?? Date.now(),
        replay: frame.replay === true,
        ...(Array.isArray(frame.timeline)
          ? { timeline: frame.timeline.map(pair => ({ t: pair[0], n: pair[1] })) }
          : {}),
      })
      if (frame.replay !== true) console.debug('[dshell-pty]', frame.chunk)
      return
    }
    if (frame.kind === 'blocks' && Array.isArray(frame.blocks)) {
      const sessionId = this.boundId
      if (sessionId !== undefined) {
        this.blockLists.set(sessionId, frame.blocks.map(block => ({ ...block })))
        this.patch({ version: this.state.getSnapshot().version + 1 })
      }
      return
    }
    if (frame.kind === 'block-text' && typeof frame.seq === 'number' && typeof frame.text === 'string') {
      const sessionId = this.boundId
      const list = sessionId === undefined ? undefined : this.blockLists.get(sessionId)
      const block = list?.find(candidate => candidate.seq === frame.seq)
      if (block !== undefined) {
        block.text += frame.text
        this.patch({ version: this.state.getSnapshot().version + 1 })
      }
      return
    }
    if (frame.kind === 'tui') {
      this.patch({
        tui: {
          program: typeof frame.program === 'string' ? frame.program : null,
          alt: frame.alt === true,
          active: frame.active === true,
        },
      })
      return
    }
    if (frame.kind === 'info') {
      this.host.set({
        user: typeof frame.user === 'string' ? frame.user : '',
        host: typeof frame.host === 'string' ? frame.host : '',
        home: typeof frame.home === 'string' ? frame.home : '',
      })
      if (typeof frame.ready === 'boolean') this.patch({ ready: frame.ready })
      return
    }
    if (frame.kind === 'ready') {
      // The shell reached its prompt. Until this arrives the view shows a
      // connecting state rather than an empty terminal.
      this.patch({ ready: frame.ready !== false })
      return
    }
    if (frame.kind === 'closed') {
      // Kept, not just logged: this is what the end-of-terminal marker says,
      // and what tells "the link dropped" apart from "it never came up".
      this.patch({
        status: 'closed',
        reason: typeof frame.reason === 'string' ? frame.reason : undefined,
        detail: typeof frame.detail === 'string' ? frame.detail : undefined,
        failure: frame.failure,
        ...typeof frame.ready === 'boolean' ? { ready: frame.ready } : {},
      })
      this.scheduleRetry()
      return
    }
    if (frame.kind === 'error') {
      if (frame.localUnsupported === true) this.patch({ localUnsupported: true })
      this.patch({
        status: 'error',
        reason: typeof frame.message === 'string' ? frame.message : undefined,
        detail: undefined,
        lockedGroup: frame.lockedGroup === true,
        noShell: frame.noShell === true,
        failure: frame.failure,
      })
      // A locked group is not a transport failure: the identical refusal comes
      // back until the reader unlocks it, so the budget is kept for the retry
      // that follows the unlock rather than spent on repetitions of it.
      if (frame.lockedGroup !== true) this.scheduleRetry()
    }
  }

  private closeChannel(): void {
    this.channel?.dispose()
    this.channel = undefined
    this.channelSession = undefined
    this.boundId = undefined
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
  }

  /** Ingest one wire chunk into the session's history (replay resets it). */
  private ingest(dshSessionId: string, chunk: PtyChunk): void {
    const history = this.historyFor(dshSessionId)
    if (chunk.replay) {
      history.chunks = [chunk]
      history.bytes = chunk.text.length
      if (chunk.timeline !== undefined && chunk.timeline.length > 0) {
        // The host watched every frame, so its timeline is authoritative for
        // the text it just shipped.
        history.timeline = chunk.timeline.map(entry => ({ t: entry.t, n: entry.n }))
        history.recorded = timelineBytes(history.timeline)
      } else if (history.recorded !== chunk.text.length) {
        // No timeline came with the replay and the one we hold describes a
        // different text: keeping it would time offsets by the wrong frame.
        history.timeline = []
        history.recorded = 0
      }
    } else {
      history.chunks = [...history.chunks, chunk]
      history.bytes += chunk.text.length
      while (history.bytes > HISTORY_MAX_BYTES || history.chunks.length > HISTORY_MAX_FRAMES) {
        const dropped = history.chunks[0]
        if (dropped === undefined || history.chunks.length === 1) break
        history.chunks = history.chunks.slice(1)
        history.bytes -= dropped.text.length
        // A dropped chunk's bytes leave the text, so its arrival entry must
        // leave the timeline: the two are sliced against each other.
        dropTimeline(history, dropped.text.length)
      }
      history.timeline.push({ t: chunk.time, n: chunk.text.length })
      history.recorded += chunk.text.length
      while (history.timeline.length > TIMELINE_LIMITS.entries || history.recorded > TIMELINE_LIMITS.bytes) {
        const dropped = history.timeline.shift()
        if (dropped === undefined) break
        history.recorded -= dropped.n
      }
    }
    this.scheduleTimelineSave(dshSessionId, history)
    this.patch({ version: this.state.getSnapshot().version + 1 })
    for (const listener of [...this.chunkListeners]) listener(dshSessionId, chunk)
  }

  /** The per-session history, seeding the arrival timeline from storage once. */
  private historyFor(dshSessionId: string): SessionHistory {
    const existing = this.histories.get(dshSessionId)
    if (existing !== undefined) return existing
    const timeline = loadTimeline(dshSessionId)
    const history: SessionHistory = {
      chunks: [],
      bytes: 0,
      timeline,
      recorded: timelineBytes(timeline),
      saveTimer: undefined,
    }
    this.histories.set(dshSessionId, history)
    return history
  }

  /** Coalesce timeline writes: a chatty shell would otherwise serialize per frame. */
  private scheduleTimelineSave(dshSessionId: string, history: SessionHistory): void {
    if (history.saveTimer !== undefined) return
    history.saveTimer = setTimeout(() => {
      history.saveTimer = undefined
      saveTimeline(dshSessionId, history.timeline)
    }, TIMELINE_SAVE_DELAY_MS)
  }

  private patch(patch: Partial<PtyStreamState>): void {
    this.state.set({ ...this.state.getSnapshot(), ...patch })
  }
}

/** Phase 3 acceptance handle: drive and inspect the PTY wire from the console. */
export interface DshellPtyDebug {
  session(): string | undefined
  status(): PtyStreamState['status']
  /** The whole connection state, for inspecting retries and failures. */
  state(): PtyStreamState
  /** The agent shell's panel state and text. */
  agent(): AgentStreamState
  agentText(): string
  /** Ask the host for the agent's shell now (the panel's "open" action). */
  openAgent(): void
  send(text: string): void
  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGTSTP'): void
  /** Retry the connection now, exactly like the view's button. */
  reconnect(): void
  /** The carrier the live main connection is using, if there is one. */
  carrier(): 'ws' | 'stream' | undefined
  /** The carrier the next connection would use on this page. */
  transport(): 'ws' | 'stream'
  /** Switch carriers now (`auto` returns to capability detection). */
  useTransport(preference: PtyTransport): void
  text(): string
}

declare global {
  interface Window {
    __DSHELL_PTY__?: DshellPtyDebug
  }
}

/**
 * Mount the wire client and follow the current session.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  // Cast through unknown: the 'sessions' key collides across faces in this
  // package's single tsc program (host SessionStore from dsh-session vs
  // client ISessions) and skipLibCheck hides the conflict, so the merged
  // type is not the client face here. Same cast dsh's own ui-workspace
  // applies at runtime typing.
  const sessions = ctx.get('sessions') as unknown as ISessions
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dshell-bridge: dictionaries')
  // Tell the host which language this browser actually resolved, so the text the
  // HOST writes — route refusals, device errors, the request a peer's model
  // reads — matches the screen. dsh's locale service is browser-side only, so
  // this report is the host's only exact signal; the durable preference is the
  // fallback the host uses before the first report lands. The route lives in
  // this package's host half, beside the service it feeds.
  ctx.effect(() => {
    const report = (): void => { void sendLocaleReport(ctx.locale.getSnapshot().active) }
    const dispose = ctx.locale.subscribe(report)
    report()
    return dispose
  }, 'dshell-bridge: report the locale to the host')
  const stream = new PtyStreamService(ctx)

  const reconcile = (): void => {
    // Bind the held Session, by the host's retention rule: the list carries
    // no `current` field from 0.1.6-alpha.2 on (see `mainSessionId`).
    stream.bind(mainSessionId(Object.values(sessions.list.getSnapshot().byId)))
  }
  ctx.effect(() => {
    const dispose = sessions.list.subscribe(reconcile)
    reconcile()
    return dispose
  }, 'dshell-bridge: follow current session')

  window.__DSHELL_PTY__ = {
    session: () => stream.state.getSnapshot().sessionId,
    status: () => stream.state.getSnapshot().status,
    state: () => stream.state.getSnapshot(),
    agent: () => stream.agent.getSnapshot(),
    agentText: () => {
      const sessionId = stream.agent.getSnapshot().sessionId
      return sessionId === undefined ? '' : stream.agentText(sessionId)
    },
    openAgent: () => { stream.openAgentTerminal() },
    send: (text) => { stream.send(text) },
    signal: (signal) => { stream.sendSignal(signal) },
    reconnect: () => { stream.reconnect() },
    carrier: () => stream.carrier(),
    transport: () => stream.transportInUse(),
    useTransport: (preference) => { stream.useTransport(preference) },
    text(): string {
    const sessionId = stream.state.getSnapshot().sessionId
    return sessionId === undefined ? '' : stream.read(sessionId)
  },
  }
}
