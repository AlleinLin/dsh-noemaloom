/**
 * dshell-terminal-bridge host face — design 4.2 (main shell ownership),
 * 4.9 (scrollback persistence), and § 5 (the /dshell/pty wire protocol).
 *
 * The bridge owns one `name: 'main'` PTY per dsh session, keyed by the
 * exact Agent (dsh terminals are owner-scoped; the agent calling
 * `terminal_open` with `name: 'main'` mints a second PTY, never this
 * one). A tail loop polls the backend scrollback for new content
 * (content prefix-diff — the stream mutates in place, line-index
 * cursors double-count it), appends deltas to the per-session PtyBuffer
 * (disk-backed, fixed memory window, 4.9), and fans them out to the
 * bound ws clients. Input frames are serialized through `startSend` —
 * one active send at a time, further input queued; Ctrl+C (`\x03`)
 * cancels the active send with SIGINT.
 *
 * The ws upgrade route reuses dsh's own auth
 * (`connection.requestRejection`), so the cookie/token gate matches the
 * rest of the app. Resize frames are accepted and ignored: dsh's PTY
 * backends fix rows/cols at spawn (§ 5).
 */

import { homedir, userInfo, hostname } from 'node:os'
import { readlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TerminalSendOperation, TerminalSessionId, TerminalSignal } from '@deepseek-ai/dsh-terminal'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the host connection service merge (ctx.connection,
// upgrade auth) and the agents service merge (ctx.agents) into the program.
import type {} from '@deepseek-ai/dsh-client-connection'
import { BlockLog, blockLogPath } from './blocks.js'
import { PtyBuffer } from './buffer.js'
import { closeHistoryStore } from '@nexus-aethra/dshell-storage'
import { HISTORY_STORE_FILENAME, DSHELL_HOME_ENV, type HistoryOutputSlice } from '@nexus-aethra/dshell-std'
import { CommandHistory, commandHistoryPath, forgetSessionHistory, MAX_COMMAND_HISTORY, type PersistedCommand } from './history.js'
import { hostCopy, type DshellTerminalBridgeHostTranslator } from './host-locales.js'
import { createHostCopy } from './host-copy.js'
import { createLocaleRoute } from './locale-route.js'
import { createDirsRoute } from './dirs-route.js'
import { DshellPtyBackend, LOCAL_SHELL_SUPPORTED, NoAgentError, classifyDeviceFailure, diagnosticTail, exitLabel, lockedVaultRefusal, noShellRefusal, type DshellPtySession, type DeviceShellPlan, type SshFailure } from './pty.js'
import { ForegroundState, foregroundProgram, watchForeground } from './foreground.js'
import { createPtyRoute } from './route.js'
import { createStreamRoutes } from './stream.js'
import { FetchSubscriber, WsSubscriber, type PtySubscriber } from './subscriber.js'
import {
  createSplitter, sanitizeTerminalText, sliceWindow, splitOutput, stripAnsi, trackInput,
  type CommandSplitterState, type TerminalCommandRecord,
} from './commands.js'

export { DEFAULT_PTY_BUFFER_OPTIONS, PtyBuffer } from './buffer.js'
export { sliceWindow, stripAnsi, sanitizeTerminalText, type TerminalCommandRecord } from './commands.js'
export { DSHELL_PTY_PATH } from './route.js'
export type { DshellPtyCommand, DshellPtyRequest, DshellPtyResponse } from './route.js'
export { MAX_COMMAND_HISTORY } from './history.js'
export type { PersistedCommand } from './history.js'

/**
 * Shell generation counter. A new record — a spawn, including one after the
 * previous shell died — takes the next value, so a cursor minted against an
 * older shell is always detectable as stale (a plain offset cannot be, since
 * a respawn's log seed restarts near zero).
 */
let nextShellGeneration = 1

/** Cursor state carried in the opaque token handed to agents. */
interface CursorState {
  readonly generation: number
  readonly offset: number
  readonly seq: number
}

/** Parse an opaque cursor token (`g<generation>:<offset>:<seq>`). */
function parseCursor(cursor: string | undefined): CursorState | undefined {
  if (cursor === undefined) return undefined
  const match = /^g(\d+):(\d+):(\d+)$/.exec(cursor.trim())
  if (match === null) return undefined
  return { generation: Number(match[1]), offset: Number(match[2]), seq: Number(match[3]) }
}

/** Format one cursor token. */
function formatCursor(state: CursorState): string {
  return `g${String(state.generation)}:${String(state.offset)}:${String(state.seq)}`
}

/** Incremental slice of one shell's activity since a cursor. */
export interface TerminalDelta {
  /** Opaque token to pass back on the next call. */
  readonly cursor: string
  /** The shell generation the delta belongs to. */
  readonly generation: number
  /** Sanitized output appended since the cursor. */
  readonly text: string
  /** Commands completed since the cursor (bounded by the retained history). */
  readonly commands: readonly TerminalCommandRecord[]
  /** Count of completed commands since the cursor. */
  readonly newCommandCount: number
  /** Older output fell out of the retained window before the cursor. */
  readonly dropped: boolean
  /** The cursor belonged to a previous shell generation (the shell respawned). */
  readonly cleared: boolean
}

/** Latest retained commands of one shell. */
export interface TerminalHistory {
  readonly cursor: string
  readonly generation: number
  readonly commands: readonly TerminalCommandRecord[]
}

/**
 * One command's output window, as an agent-facing read reports it.
 *
 * A flat shape rather than a union: a caller walks `stale` / `retained` and
 * reads the rest, which keeps the tool's rendering a straight line.
 */
export interface TerminalCommandOutput {
  /** Fresh session cursor, for the next call. */
  readonly cursor: string
  readonly generation: number
  /** The shell was replaced since the cursor: `seq` names a different command now. */
  readonly stale: boolean
  /** The medium has no output for this command (evicted, or pre-output layout). */
  readonly retained: boolean
  /** The command line, when its metadata is still retained. */
  readonly command: string | null
  readonly exitCode: number | null
  /** The slice itself; null unless `retained` and not `stale`. */
  readonly output: HistoryOutputSlice | null
}

export const name = '@nexus-aethra/dshell-terminal-bridge'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The bridge service instance (Service key `dshellTerminalBridge`). */
    dshellTerminalBridge: DshellTerminalBridge
  }
}

/**
 * dshell PTY log directory: `<data root>/dshell-pty`.
 *
 * The root is dshell's own when a data directory is configured, the harness's
 * otherwise (`DSHELL_HOME_ENV`, then `DSH_HOME`, then `~/.dsh`) — the same rule
 * `dshell-ssh` and `dshell-buffer` resolve their own trees with, so every
 * dshell dataset moves together or none does.
 */
export function ptyLogDir(): string {
  const home = process.env[DSHELL_HOME_ENV] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dshell-pty')
}

/** Default canvas size for a spawned main shell; the browser resizes it. */
const DEFAULT_PTY_COLS = 160
const DEFAULT_PTY_ROWS = 40

/** How long a PTY bind waits for its session's Agent before reporting failure. */
const AGENT_WAIT_MS = 4000
/** Poll interval while waiting for that Agent. */
const AGENT_WAIT_POLL_MS = 50

/** What every bridge-owned shell needs for the shared init handshake. */
interface ShellRecord {
  agent: Agent
  /** dsh session id this shell belongs to. */
  dshSessionId: string
  /** PTY id inside ctx.terminals (per boot). */
  ptyId: TerminalSessionId
  /** The backend's rich handle: raw output push, exit push, resize. */
  session: DshellPtySession
  buffer: PtyBuffer
  activeSend: TerminalSendOperation | undefined
  /** Init echo is scrubbed and output suppressed until the first settle. */
  initializing: boolean
  /**
   * Whether this shell ever reached a prompt.
   *
   * The init send settles only once the shell answers, so a record whose init
   * settled with the process still alive was a working terminal. It is what
   * tells "the connection dropped" apart from "it never came up": the client
   * shows the first as a marker at the end of the output and the second as a
   * full connecting/failure panel, and only the host can make that call.
   */
  ready: boolean
}

interface MainRecord extends ShellRecord {
  /** The host's block model for this session: the render order's source. */
  blocks: BlockLog
  /** Shell identity; every respawn takes a fresh value. */
  generation: number
  /** Bytes ever appended to the logical stream, independent of window trims. */
  absOffset: number
  /** Completed commands, oldest drop first. */
  commands: TerminalCommandRecord[]
  /** The same commands across boots: loaded at spawn, written as they close. */
  history: CommandHistory
  /** Input-line assembly + output/marker splitter for this shell. */
  splitter: CommandSplitterState
  inputQueue: string[]
  /**
   * What is drawing on this session's terminal: the poll's reading of the
   * foreground process group, and the screen the output has shown. A
   * full-screen program is not timeline content, and this is what decides it.
   */
  foreground: ForegroundState
  /** Push-subscription disposers, released in dropMain. */
  stopOutput: () => void
  stopExit: () => void
  /** Ends the foreground poll; released with the other two. */
  stopForeground: () => void
  /**
   * Set when the PTY exited or the dsh session was disposed. The record
   * stays in `mains` briefly so a reconnecting client can receive the
   * close frame in its bindClient sequence; `disposeRecord` removes it
   * after the grace. The diagnostic and readiness travel with it so a client
   * that binds after the death still gets the whole story.
   */
  dead?: { reason: string; detail?: string | undefined; ready: boolean; time: number; failure?: SshFailure | undefined }
  /** Pending dispose handle, kept so a rapid respawn can cancel it. */
  disposeTimer?: NodeJS.Timeout
}

/**
 * The agent's own shell.
 *
 * The user's main shell and the agent's shell are two PTYs owned by the same
 * session Agent, so a command the agent runs and a command the user types no
 * longer take turns in one foreground: each has its own line discipline, its
 * own settle and its own Ctrl+C. That is what makes the two sides genuinely
 * parallel instead of mutually blocking, and it is the only arrangement in
 * which "the terminal stays usable while the agent works" can hold — one PTY
 * has exactly one foreground job.
 *
 * It is spawned lazily, on the agent's first need for a terminal, so a session
 * that never runs a shell pays for nothing (a device session would otherwise
 * open a second ssh connection for nobody).
 */
interface AgentRecord extends ShellRecord {
  /** Shell identity; a replaced shell takes a fresh value. */
  generation: number
  /** Push-subscription disposers, released on death. */
  stopOutput: () => void
  stopExit: () => void
  /**
   * Settles when the init handshake finished.
   *
   * The id handed to the agent is only safe to send into once init has settled:
   * the backend rejects a second concurrent send with `SEND_ACTIVE`, and an
   * agent that got the id and immediately ran a command would race its own
   * shell's startup and lose.
   */
  readonly initSettled: Promise<void>
  dead?: { reason: string; detail?: string | undefined; ready: boolean; time: number; failure?: SshFailure | undefined }
  /** Pending dispose handle, kept so a rapid respawn can cancel it. */
  disposeTimer?: NodeJS.Timeout
}

/**
 * One decoded control frame from a client — the ws path and the fetch-stream
 * path run the same shape through the same handler.
 *
 * Every field is optional and re-checked with `typeof` where it is used: the
 * ws frame is whatever JSON arrived on the socket, and the stream frame is
 * whatever JSON arrived in a POST body, so this is a convenience view of
 * untrusted input, not a guarantee about it.
 */
interface ClientFrame {
  kind?: string
  stream?: string
  sessionId?: string
  text?: string
  signal?: string
  cols?: number
  rows?: number
}

export class DshellTerminalBridge extends Service {
  static inject = ['terminals', 'agents'] as const

  private readonly mains = new Map<Agent, MainRecord>()
  private readonly pendingMain = new Map<Agent, Promise<MainRecord>>()
  /**
   * The grid each session's view last asked for, kept per dsh session id.
   *
   * A resize can arrive before the session's main shell exists (the view
   * measures on mount, the bind is still spawning) and before the client is
   * registered as bound, so it is remembered here and applied at spawn; a
   * request that is only applied when a shell happens to exist is a request
   * the session never sees, and the PTY then keeps the backend's default
   * columns forever — the shell wraps and pads its output to that width while
   * the view renders at its own.
   */
  private readonly pendingSizes = new Map<string, { cols: number; rows: number }>()
  private readonly clients = new Map<string, Set<PtySubscriber>>()
  private readonly boundSession = new Map<PtySubscriber, string>()
  /** The agent-owned shells, keyed by the same Agent as their main shell. */
  private readonly agents = new Map<Agent, AgentRecord>()
  private readonly pendingAgents = new Map<Agent, Promise<AgentRecord>>()
  /**
   * Watchers of one session's agent shell — the task card's terminal panel.
   *
   * A separate subscriber set from `clients` on purpose: this stream is
   * read-only, has no input or signal frames, and a view that never opens the
   * panel costs the host nothing.
   */
  private readonly agentClients = new Map<string, Set<PtySubscriber>>()
  /** Sessions the subscribers on {@link agentClients} are bound to. */
  private readonly agentBound = new Map<PtySubscriber, string>()
  /**
   * Frame-stream subscribers by the client id their two halves share.
   *
   * The ws path needs no such index — the socket IS the identity — but a
   * stream's upstream POSTs are separate requests, so the id its GET opened
   * with is the only way back to its subscriber.
   */
  private readonly streams = new Map<string, FetchSubscriber>()
  /**
   * Columns the panel last asked for, applied when the agent shell spawns.
   *
   * Only the width: the agent's shell is spawned at the backend's row count and
   * keeps it, because rows decide how much a full-screen program can draw while
   * the panel is a short window that scrolls.
   */
  private readonly agentCols = new Map<string, number>()
  /** OS identity for the bash prompt; safe for embedding inside PS1 quotes. */
  readonly promptUser = safeShellWord(userInfo().username)
  readonly promptHost = safeShellWord(hostname())

  /**
   * This package's host copy, bound to the language the browser reported.
   *
   * The service is this package's own: `apply` provides it before this class is
   * plugged, so the accessor is a plain read. It is bound once and read at call
   * time, so a language switch reaches the next spawn-failure panel or route
   * refusal without re-binding.
   */
  private readonly t: DshellTerminalBridgeHostTranslator = this.ctx.dshellHostCopy.bind(hostCopy)

  /** The backend's rich handle (raw push, exit push, resize) for its sessions. */
  private readonly backend = new DshellPtyBackend(DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS, this.t, ({ sessionId, cwd }) => {
    // A session bound to a device runs that device's shell, so the user's own
    // terminal is not a local shell stranded in an empty mount directory. The
    // router is reached through the service the SSH plugin publishes, asked
    // lazily because that plugin may load after this one; a composition
    // without it returns undefined and the local shell is used as before.
    // Answered by session identity: the mount directory is shared by every
    // session bound to that device tree, so directory alone cannot tell a
    // bound session from an unbound one that inherited the path.
    if (sessionId === undefined) return undefined
    const routing = this.ctx.get('dshellSshRouting') as
      | {
        interactiveShellPlan(
          sessionId: string,
          sessionCwd: string | undefined,
        ): Promise<DeviceShellPlan | undefined>
      }
      | undefined
    return routing?.interactiveShellPlan(sessionId, cwd)
  }, (owner, sessionId) => {
    // An unnamed spawn through dshell's backend is another plugin creating a
    // shell for this agent — dsh's persistent-bash when the bundle points its
    // backendType here. Claim it as the agent's shell so every path the model
    // can run commands through (its `bash` tool, terminal_send) lands on the
    // one terminal the user can watch.
    void this.claimForeignAgent(owner, sessionId)
  })

  constructor(ctx: Context) {
    super(ctx, 'dshellTerminalBridge')
    ctx.effect(() => this.ctx.terminals.registerBackend(this.backend), 'dshell-bridge: raw pty backend')
    ctx.effect(() => () => {
      this.backend.dispose()
      void this.disposeAll()
    }, 'dshell-bridge: teardown')
    // Turn boundaries come from the session itself, so a block is cut exactly
    // where the agent took over and where it handed the terminal back.
    ctx.on('session/event', (session: Session, event: { type?: string; data?: unknown; time?: number }) => {
      const sessionId = String(session.id)
      const record = this.recordFor(sessionId)
      if (record === undefined) return
      const data = (event.data ?? {}) as { turn?: number; commandId?: string }
      if (event.type === 'turn/start') {
        record.blocks.startTurn(data.turn)
        this.broadcast(sessionId, { kind: 'blocks', blocks: record.blocks.snapshot() })
      } else if (event.type === 'turn/end') {
        record.blocks.endTurn()
        this.broadcast(sessionId, { kind: 'blocks', blocks: record.blocks.snapshot() })
      } else if (event.type === 'command/run') {
        // A slash command (/permission, /model, …) is not a turn — no
        // turn/start fires — but it is still a stretch of the session that
        // must claim its place in the block timeline. Without this cut the
        // command's marker falls back to tail insertion while every later
        // PTY byte keeps appending to the still-open shell region, so the
        // marker renders permanently below output that came after it.
        record.blocks.startTurn(undefined, event.time, data.commandId)
        this.broadcast(sessionId, { kind: 'blocks', blocks: record.blocks.snapshot() })
      } else if (event.type === 'command/done') {
        record.blocks.endTurn()
        this.broadcast(sessionId, { kind: 'blocks', blocks: record.blocks.snapshot() })
      }
    }, { global: true })
    // Session dispose (sidebar delete, host-side cleanup) → mark the
    // session's main PTY dead so the bindClient sequence can forward the
    // close frame and the dispose timer frees the node-pty.
    ctx.on('session/disposed', (session: Session) => {
      const sessionId = String(session.id)
      for (const record of this.mains.values()) {
        if (record.dshSessionId !== sessionId) continue
        this.markDead(record, 'session closed')
        const set = this.clients.get(sessionId)
        if (set !== undefined) {
          // Through dropSubscriber, not just the set: a stream subscriber is
          // also indexed by its client id, and leaving that entry behind would
          // keep a closed body reachable from a later POST.
          for (const client of [...set]) {
            client.close(1000, 'session closed')
            this.dropSubscriber(client)
          }
          this.clients.delete(sessionId)
        }
      }
      // The agent's shell goes with the session for the same reason, and its
      // panel sockets are closed the same way: nothing can watch a session
      // that no longer exists.
      const agentRecord = this.agentRecordFor(sessionId)
      if (agentRecord !== undefined) this.markAgentDead(agentRecord, 'session closed')
      const watching = this.agentClients.get(sessionId)
      if (watching !== undefined) {
        for (const client of [...watching]) {
          client.close(1000, 'session closed')
          this.dropSubscriber(client)
        }
        this.agentClients.delete(sessionId)
      }
    })
    // The frame stream and the history read sit on the shared API channel, so
    // they exist wherever `connection` does. That is deliberate: the desktop
    // shell composes `connection` without `webServer`, so an upgrade route
    // cannot serve it, while a Response body can.
    ctx.inject(['connection'], (connectionCtx) => {
      // The composer's up-arrow history — the read side of the same subject.
      connectionCtx.effect(
        () => connectionCtx.connection.fetch.register(createPtyRoute(this, this.t)),
        'dshell-bridge: history route',
      )
      for (const route of createStreamRoutes(this)) {
        connectionCtx.effect(
          () => connectionCtx.connection.fetch.register(route),
          `dshell-bridge: ${route.path}`,
        )
      }
    })
    ctx.inject(['webServer', 'connection'], (webCtx) => {
      const wss = new WebSocketServer({ noServer: true })
      const route: WebUpgradeRoute = {
        path: '/dshell/pty',
        handler: (req, socket, head) => {
          const rejection = webCtx.connection.requestRejection(req)
          if (rejection !== undefined) {
            rejectUpgrade(socket, rejection)
            return
          }
          wss.handleUpgrade(req as never, socket as never, head, (client) => { this.attachClient(client) })
        },
      }
      webCtx.effect(() => webCtx.webServer.registerUpgrade(route), 'dshell-bridge: /dshell/pty')
    })
  }

  /**
   * The session's live Agent, waiting briefly for it to materialize.
   *
   * A PTY bind can legitimately arrive before the session has an agent: the
   * browser opens a session and binds its shell in the same tick, while the
   * host is still composing the agent, and a session SWITCH publishes the new
   * current session one tick before anything is built for it. Throwing on
   * `undefined` turned that ordinary race into a connection error: the client
   * drew a "reconnecting (1/3)" line, spent a retry attempt, and waited out a
   * backoff before opening the shell it was always going to get. Waiting for
   * the agent here is both quieter and faster than letting the client retry.
   * @param dshSessionId - the session whose agent to resolve.
   * @returns the live agent.
   * @throws when none appears within {@link AGENT_WAIT_MS}.
   */
  private async awaitAgent(dshSessionId: string): Promise<Agent> {
    const deadline = Date.now() + AGENT_WAIT_MS
    for (;;) {
      const agent = this.ctx.get('agents')?.get(dshSessionId as SessionId)
      if (agent !== undefined) return agent
      if (Date.now() >= deadline) {
        throw new NoAgentError(dshSessionId)
      }
      await new Promise(resolve => { setTimeout(resolve, AGENT_WAIT_POLL_MS) })
    }
  }

  /**
   * The bridge-owned `main` PTY for one dsh session, spawning it lazily.
   * The PtyBuffer seeds from the persisted log tail (4.9) and the tail
   * loop starts streaming backend scrollback into buffer and clients.
   */
  async ensureMainShell(dshSessionId: string): Promise<MainRecord> {
    const agent = await this.awaitAgent(dshSessionId)
    const existing = this.mains.get(agent)
    if (existing !== undefined && existing.dead === undefined) return existing
    if (existing !== undefined) {
      // A dead record blocks the owner's name reservation; force-release
      // it inline so the spawn below doesn't collide on "name main exists".
      if (existing.disposeTimer !== undefined) clearTimeout(existing.disposeTimer)
      await this.disposeRecord(existing)
      void this.ctx.terminals.kill(agent, existing.ptyId, 'dshell: replace dead').catch(() => {})
    }
    const pending = this.pendingMain.get(agent)
    if (pending !== undefined) return await pending
    const promise = this.spawnMain(agent, dshSessionId)
    this.pendingMain.set(agent, promise)
    try {
      return await promise
    } finally {
      this.pendingMain.delete(agent)
    }
  }

  /**
   * Replace a session's live shell so a new spawn plan takes effect.
   *
   * An assignment can land after the session's terminal has already spawned —
   * the creation page records a device one round trip after the session exists
   * — and a shell cannot change which machine it runs on. Without this the
   * reader keeps a local shell behind a device's name: the exact split the
   * spawn-plan seam exists to prevent. The replacement is an ordinary respawn,
   * so the scrollback is seeded from the persisted log, and attached clients
   * learn about it the way they learn about any other shell death.
   *
   * @param dshSessionId - the session whose shell to replace.
   */
  async respawnMain(dshSessionId: string): Promise<void> {
    const existing = this.recordFor(dshSessionId)
    // No shell yet: nothing to replace — the next attach asks for a plan and
    // gets the new one. An already-dead record is on its way out already.
    if (existing === undefined || existing.dead !== undefined) return
    this.markDead(existing, 'spawn plan changed')
    await this.ensureMainShell(dshSessionId)
  }

  /** The live main record for a dsh session, if one exists. */
  private recordFor(dshSessionId: string): MainRecord | undefined {
    for (const record of this.mains.values()) if (record.dshSessionId === dshSessionId) return record
    return undefined
  }

  private async spawnMain(agent: Agent, dshSessionId: string): Promise<MainRecord> {
    const cwd = agent.session?.header?.cwd
    const spawned = await this.ctx.terminals.spawn(agent, {
      type: this.backend.type,
      name: 'main',
      ...(cwd === undefined || cwd === '' ? {} : { cwd }),
    })
    const session = this.backend.session(spawned.sessionId)
    if (session === undefined) {
      throw new Error(`dshell-bridge: backend session missing after spawn (${String(spawned.sessionId)})`)
    }
    const logPath = join(ptyLogDir(), `${dshSessionId}.log`)
    const buffer = await PtyBuffer.open(logPath)
    const blocks = new BlockLog(blockLogPath(logPath))
    await blocks.load()
    // The shell's history outlives the shell: a restart respawns bash, and
    // without this the up-arrow list would start empty while the view replays a
    // scrollback full of commands.
    const history = new CommandHistory(dshSessionId, commandHistoryPath(logPath))
    await history.load()
    if (blocks.snapshot().length === 0 && buffer.text().length > 0) {
      // First run after this log was introduced (or after a clear): the
      // seeded history has no block yet, so give it the shell block it was.
      blocks.append(buffer.text(), Date.now())
    }
    const splitter = createSplitter()
    const carried = history.list()
    // Continue the numbering after the carried commands: `seq` orders history
    // and pairs new output with it, so a restart must not mint a second
    // sequence that starts over at 1.
    splitter.seq = carried.reduce((max, command) => Math.max(max, command.seq), 0)
    const record: MainRecord = {
      agent,
      dshSessionId,
      ptyId: spawned.sessionId,
      session,
      buffer,
      blocks,
      generation: nextShellGeneration++,
      // The seeded log tail is history the previous shell already produced;
      // starting the cursor at its end keeps a respawn from replaying it.
      absOffset: Buffer.byteLength(buffer.text(), 'utf8'),
      // The commands a previous shell ran, with the output dropped: bytes of
      // past output live in the PTY and block logs, and a look-back that says
      // "this is what was run" is what history is for.
      commands: carried.map(command => ({ ...command, output: '' })),
      history,
      splitter,
      activeSend: undefined,
      inputQueue: [],
      foreground: new ForegroundState(),
      initializing: true,
      ready: false,
      stopOutput: () => {},
      stopExit: () => {},
      stopForeground: () => {},
    }
    // Start at the grid the view asked for, not the backend's default: the
    // shell's first prompt decides where every later line wraps, and the view
    // is already sized when a session is opened or restored.
    const requested = this.pendingSizes.get(dshSessionId)
    if (requested !== undefined) session.resize(requested.cols, requested.rows)
    this.mains.set(agent, record)
    // A device session's shell runs on the device, so it has no local process
    // to watch — reading one would call every device session a full-screen
    // program. The bytes still carry the alternate screen, so that signal keeps
    // working there, and the manual toggle covers the rest.
    if (!session.redirected && session.pid !== undefined) {
      record.stopForeground = watchForeground(session.pid, (program) => {
        if (record.dead !== undefined) return
        if (!record.foreground.setProgram(program)) return
        this.broadcast(record.dshSessionId, { kind: 'tui', ...record.foreground.snapshot })
      })
    }
    // Raw ANSI push: every output byte lands in the persisted buffer and on
    // the wire untouched — the canvas renders it natively. Suppressed while
    // the init echo is pending so a fresh session opens on a clean slate.
    // The same bytes feed the command splitter (OSC 133;D closes a record).
    record.stopOutput = session.onOutput((chunk) => {
      if (record.initializing) return
      // The reading comes FIRST, because a chunk that proves a program is
      // painting the screen is exactly the chunk that must not enter the
      // timeline. A program the poll has not named yet is read here on the
      // spot rather than waited for, so the boundary lands on the right chunk.
      let changed = record.foreground.feed(chunk)
      if (record.foreground.probing) {
        const program = foregroundProgram(session.pid)
        if (program !== undefined) changed = record.foreground.setProgram(program) || changed
      }
      if (changed) this.broadcast(record.dshSessionId, { kind: 'tui', ...record.foreground.snapshot })
      record.buffer.append(chunk)
      record.absOffset += Buffer.byteLength(chunk, 'utf8')
      if (record.foreground.snapshot.active) {
        // A full-screen program is not timeline content. Its repaints would
        // land in the block log as a wall of half-drawn screens, and that log
        // is what the timeline renders from the moment this mode ends. The
        // raw buffer keeps every byte, which is what lets a reconnect replay
        // the screen; the block log and the command splitter see none of it,
        // because a full-screen app runs no command lines.
        this.broadcast(record.dshSessionId, { kind: 'output', chunk, time: Date.now() })
        return
      }
      const opened = record.blocks.tailSeq
      const block = record.blocks.append(chunk)
      if (block.seq === opened) {
        this.broadcast(record.dshSessionId, { kind: 'block-text', seq: block.seq, text: chunk })
      } else {
        // This chunk started a block. The client merges `block-text` into a
        // block it already has, so a new one must be announced with a full
        // snapshot — otherwise output that arrives before the session's first
        // turn is dropped from the timeline and the view stays empty.
        this.broadcast(record.dshSessionId, { kind: 'blocks', blocks: record.blocks.snapshot() })
      }
      const closed = splitOutput(record.splitter, chunk, Date.now())
      if (closed.length > 0) {
        // The window keeps the display form only: `stored` carries the store's
        // longer tail (up to 64 KiB per record), and 200 of those in memory is
        // the one thing this cache must not become.
        record.commands.push(...closed.map(command => ({
          seq: command.seq,
          command: command.command,
          exitCode: command.exitCode,
          output: command.output,
          at: command.at,
        })))
        if (record.commands.length > MAX_COMMAND_HISTORY) {
          record.commands.splice(0, record.commands.length - MAX_COMMAND_HISTORY)
        }
        // The line, its outcome, and the output a reader can page through: the
        // output no longer lives only in the PTY and block logs.
        record.history.append(
          closed.map(command => ({
            seq: command.seq,
            command: command.command,
            exitCode: command.exitCode,
            at: command.at,
          })),
          closed.flatMap(command => command.stored === undefined
            ? []
            : [{ seq: command.seq, ...command.stored }]),
        )
      }
      this.broadcast(record.dshSessionId, { kind: 'output', chunk, time: Date.now() })
    })
    record.stopExit = session.onExit((status) => {
      this.markDead(record, status.kind === 'exited' ? exitLabel(status) : status.kind)
    })
    // Replace the stock `dsh> ` prompt with a bash-style `user@host:path$`
    // cue once the shell is ready; PS1 and PROMPT_COMMAND are rewritten in
    // one line so no render window can clobber it, and the backend's fast
    // settle keys off the marker this PROMPT_COMMAND prints.
    this.runInit(record, frame => { this.broadcast(record.dshSessionId, frame) }, {
      afterRestore: () => {
        record.absOffset = Buffer.byteLength(record.buffer.text(), 'utf8')
        this.pump(record)
      },
    })
    return record
  }

  /**
   * Queue the prompt-rewrite init and wipe its setup echo from the scrollback.
   *
   * Shared by both shells: the user's and the agent's get the same prompt and
   * the same settle marker, so one settle implementation and one backend
   * contract cover them. What differs is only who hears about it (`deliver`)
   * and what the owner must fix up once the seeded scrollback is restored.
   * @param record - the shell being initialized.
   * @param deliver - publishes one frame to that shell's watchers.
   * @param options - `cdTo` is an already-quoted directory for the new shell to
   *   start in (the agent's fork), `afterRestore` runs once the seeded history
   *   is back in the buffer.
   */
  private runInit(
    record: ShellRecord,
    deliver: (frame: Record<string, unknown>) => void,
    options: {
      cdTo?: string | undefined
      afterRestore?: (() => void) | undefined
    } = {},
  ): void {
    // The scrollback a respawn owes the client: the window already holds the
    // seeded log tail, so snapshot it before the init echo lands. Restoring
    // the snapshot (below) is the whole point of the persisted log — seeding
    // it and then truncating would erase the previous shell's output for good.
    const seeded = record.buffer.text()
    // ONE line: the PROMPT_COMMAND re-asserts PS1 from a dedicated variable
    // on every prompt render, so the prompt survives any clobber and the
    // settle marker stays live. Real ESC bytes are safe on this backend.
    const cd = options.cdTo === undefined ? '' : `cd ${options.cdTo} 2>/dev/null; `
    const init = [
      `${cd}export DSHELL_PS1='\\u@\\h:\\w\\$ '; export PS1="$DSHELL_PS1"; export PROMPT_COMMAND='printf "\\033]133;D;%s\\007" "$?"; PS1="$DSHELL_PS1"'`,
      'clear',
      '',
    ].join('\n')
    const operation = this.ctx.terminals.startSend(record.agent, record.ptyId, { text: init, submit: false })
    record.activeSend = operation
    void operation.done.then((result) => {
      // The init send settles only once the shell answers (marker seen and
      // quiet), so a settle with the process still alive means this shell is a
      // working terminal — the fact the client needs to tell "connection
      // dropped" apart from "never connected".
      record.ready = result.sessionStatus.kind !== 'exited'
      record.activeSend = undefined
      record.initializing = false
      // Clients already bound need this the moment it happens: until the
      // shell has answered, they show a connecting state rather than an empty
      // terminal, and only this frame ends it.
      deliver({ kind: 'ready', ready: record.ready })
      // The init echo (export line + clear) never deserves screen space, but
      // the seeded scrollback does: reset the log to the snapshot instead of
      // to nothing, and hand that same text back to every client, which
      // replaces its own history from a replay chunk.
      const restore = (): void => {
        record.buffer.append(seeded)
        deliver({
          kind: 'output',
          chunk: seeded,
          time: Date.now(),
          replay: true,
          timeline: record.buffer.timelineEntries().map(entry => [entry.t, entry.n]),
        })
        // The init script already ended with an empty line, which readline
        // echoed and ran the new PROMPT_COMMAND through — the shell is at a
        // fresh prompt with no need for another Enter press. Pushing another
        // `\n` would add another empty echo row, and over many respawns that
        // is exactly the blank block the user sees growing on every reconnect.
        options.afterRestore?.()
      }
      void record.buffer.truncate().then(restore).catch((error: unknown) => {
        // The log reset is a cache operation, and the host treats an
        // unhandled rejection as fatal — a respawn must never take the
        // desktop app down with it. The client still gets its scrollback.
        console.warn('dshell: pty log reset failed:', error)
        restore()
      })
    }, () => {
      record.activeSend = undefined
      record.initializing = false
      options.afterRestore?.()
    })
  }

  /**
   * The agent's own shell for one session, spawning it lazily.
   *
   * Lazy on purpose: a session that never asks for a terminal pays nothing, and
   * a device session does not open a second ssh connection for a panel nobody
   * opened. The record is keyed by the same Agent as the main shell — the two
   * are two named PTYs under one owner, addressable separately.
   */
  async ensureAgentShell(dshSessionId: string): Promise<AgentRecord> {
    const agent = await this.awaitAgent(dshSessionId)
    const existing = this.agents.get(agent)
    if (existing !== undefined && existing.dead === undefined) return existing
    if (existing !== undefined) {
      // A dead record still holds the owner's "agent" name reservation, so the
      // respawn below would collide; release it inline first.
      if (existing.disposeTimer !== undefined) clearTimeout(existing.disposeTimer)
      await this.disposeAgentRecord(existing)
      void this.ctx.terminals.kill(agent, existing.ptyId, 'dshell: replace dead agent shell').catch(() => {})
    }
    const pending = this.pendingAgents.get(agent)
    if (pending !== undefined) return await pending
    const promise = this.spawnAgent(agent, dshSessionId)
    this.pendingAgents.set(agent, promise)
    try {
      return await promise
    } finally {
      this.pendingAgents.delete(agent)
    }
  }

  /**
   * The addressable id of the agent's own shell.
   *
   * What the model-facing tool hands the agent, so `terminal_send` lands in a
   * shell the agent owns rather than in the one the user is typing into. The
   * id is only returned once init has settled: the backend rejects a send that
   * overlaps another (`SEND_ACTIVE`), and the agent's next act is a send.
   * @param dshSessionId - the session whose agent shell to spawn (lazily).
   * @returns the PTY id inside `ctx.terminals`.
   */
  async agentTerminalId(dshSessionId: string): Promise<TerminalSessionId> {
    const record = await this.ensureAgentShell(dshSessionId)
    await record.initSettled
    return record.ptyId
  }

  private async spawnAgent(agent: Agent, dshSessionId: string): Promise<AgentRecord> {
    const cwd = agent.session?.header?.cwd
    const spawned = await this.ctx.terminals.spawn(agent, {
      type: this.backend.type,
      name: 'agent',
      ...(cwd === undefined || cwd === '' ? {} : { cwd }),
    })
    const session = this.backend.session(spawned.sessionId)
    if (session === undefined) {
      throw new Error(`dshell-bridge: backend session missing after agent spawn (${String(spawned.sessionId)})`)
    }
    // The width the panel already asked for, if any: a shell spawned wider than
    // the panel wraps its output where the panel does not, and nothing would
    // re-wrap it afterwards.
    const cols = this.agentCols.get(dshSessionId)
    if (cols !== undefined) session.resize(cols, DEFAULT_PTY_ROWS)
    const logPath = join(ptyLogDir(), `${dshSessionId}.agent.log`)
    const buffer = await PtyBuffer.open(logPath)
    const settled = Promise.withResolvers<void>()
    const record: AgentRecord = {
      agent,
      dshSessionId,
      ptyId: spawned.sessionId,
      session,
      buffer,
      generation: nextShellGeneration++,
      activeSend: undefined,
      initializing: true,
      ready: false,
      stopOutput: () => {},
      stopExit: () => {},
      initSettled: settled.promise,
    }
    this.agents.set(agent, record)
    record.stopOutput = session.onOutput((chunk) => {
      // The init echo is the bridge's own setup, not the agent's work: the
      // panel opens on the fork's prompt, not on an export line.
      if (record.initializing) return
      record.buffer.append(chunk)
      this.broadcastAgent(record.dshSessionId, { kind: 'output', chunk, time: Date.now() })
    })
    record.stopExit = session.onExit((status) => {
      this.markAgentDead(record, status.kind === 'exited' ? exitLabel(status) : status.kind)
    })
    // The agent's shell forks the user's: it opens in the directory the user's
    // own shell is sitting in, so "look at what I am looking at" needs no path
    // in a prompt. Best effort — a shell in the middle of a command reports no
    // directory, and the fork simply stays in the session's own.
    const fork = forkDirWord(this.mains.get(agent))
    this.runInit(record, frame => { this.broadcastAgent(record.dshSessionId, frame) }, {
      cdTo: fork,
      afterRestore: () => { settled.resolve() },
    })
    return record
  }

  /** The agent shell record for one session — live, dead, or not spawned. */
  private agentRecordFor(dshSessionId: string): AgentRecord | undefined {
    for (const record of this.agents.values()) if (record.dshSessionId === dshSessionId) return record
    return undefined
  }

  /**
   * Adopt a shell another plugin spawned through dshell's backend as the
   * agent's own.
   *
   * Only sessions of agents dshell already knows (they have a main shell) are
   * claimed, and only when no agent record exists yet — the bridge's own
   * spawns carry names and never reach the hook, and a claimed shell makes
   * later `dshell_get_agent_terminal` calls reuse it, so `bash`, `terminal_send`
   * and the watched panel all converge on this one PTY. No init runs here:
   * the creator (persistent bash) has already configured the shell to its own
   * protocol, and injected setup bytes would corrupt its marker parsing. The
   * record simply attaches pushes and announces the shell as live.
   */
  private async claimForeignAgent(owner: unknown, sessionId: TerminalSessionId): Promise<void> {
    if (!(owner instanceof Object) || !('id' in owner)) return
    const agent = owner as Agent
    if (!this.mains.has(agent) || this.agents.has(agent)) return
    const session = this.backend.session(sessionId)
    if (session === undefined) return
    const dshSessionId = String(this.mains.get(agent)?.dshSessionId ?? agent.id)
    const logPath = join(ptyLogDir(), `${dshSessionId}.agent.log`)
    const buffer = await PtyBuffer.open(logPath)
    if (this.agents.has(agent)) return
    const settled = Promise.withResolvers<void>()
    const record: AgentRecord = {
      agent,
      dshSessionId,
      ptyId: sessionId,
      session,
      buffer,
      generation: nextShellGeneration++,
      activeSend: undefined,
      initializing: false,
      ready: true,
      stopOutput: () => {},
      stopExit: () => {},
      initSettled: settled.promise,
    }
    this.agents.set(agent, record)
    record.stopOutput = session.onOutput((chunk) => {
      record.buffer.append(chunk)
      this.broadcastAgent(record.dshSessionId, { kind: 'output', chunk, time: Date.now() })
    })
    record.stopExit = session.onExit((status) => {
      this.markAgentDead(record, status.kind === 'exited' ? exitLabel(status) : status.kind)
    })
    settled.resolve()
    // Announce the claimed shell so an open status card flips to 运行中
    // without waiting for its next poll — there is no poll; this is the push.
    this.broadcastAgent(record.dshSessionId, {
      kind: 'agent-info', stream: 'agent', live: true, ready: true,
    })
  }

  /**
   * Ensure the session has a *live* main record. If the existing one is
   * dead, ensureMainShell forces a release-and-respawn inline so the
   * returned record is always usable (Phase 9 hardening — feeds,
   * signals, clears must never operate on a dying PTY).
   */
  private ensureLiveMain(dshSessionId: string): Promise<MainRecord> {
    return this.ensureMainShell(dshSessionId)
  }

  /**
   * Where a session's own shell stands, read from the OS.
   *
   * The composer's path completion needs the shell's CURRENT directory, and a
   * shell's directory is process state with no channel back over the PTY: a
   * `cd` typed into it, or one the file navigator feeds, moves a process and
   * says nothing to anyone. This is the way to actually ask — the PTY is a
   * child process of this one, so its cwd is a symlink away.
   *
   * Deliberately not spawning: a session without a shell answers undefined
   * rather than getting one created to answer a question about it. A session
   * whose plan redirected it elsewhere (a device session's `ssh`) answers
   * undefined too — that process's cwd is this machine's, not the device's.
   *
   * @param dshSessionId - the session whose shell to look at.
   * @returns the shell's directory, or undefined when there is nothing to read.
   */
  shellCwd(dshSessionId: string): string | undefined {
    const record = this.recordFor(dshSessionId)
    const session = record?.session
    if (session === undefined || session.redirected || session.pid === undefined) return undefined
    try {
      return readlinkSync(`/proc/${String(session.pid)}/cwd`)
    } catch {
      // The shell died between the lookup and the read, or this is not Linux.
      return undefined
    }
  }

  /** Feed one input chunk to the main PTY (Ctrl+C, `\x03`, cancels the active send). */
  feed(dshSessionId: string, text: string): void {
    void this.ensureLiveMain(dshSessionId).then((record) => {
      // The input side of the command splitter: assemble the line that Enter
      // will queue, so the next `133;D` marker can pair command ↔ output.
      trackInput(record.splitter, text)
      if (text === '\u0003' && record.activeSend !== undefined) {
        record.activeSend.cancel()
        return
      }
      record.inputQueue.push(text)
      this.pump(record)
    }, (error: unknown) => {
      console.warn('dshell-bridge: input dropped:', error)
    })
  }

  /**
   * Drop one session's main shell and everything dshell stored for it: kill the
   * PTY and release its scrollback window, timeline and block log, and drop its
   * command history. Used when the session is deleted while still loaded — dsh
   * keeps the session object alive, but everything dshell allocated for it can
   * go now instead of at the next start.
   *
   * Also called for a session with no record at all, so it must not assume one:
   * a session deleted before its terminal was ever opened still has stored
   * history, and the store is reachable by path. Never spawns.
   */
  releaseSession(dshSessionId: string): void {
    const record = this.recordFor(dshSessionId)
    if (record !== undefined) {
      this.markDead(record, 'session deleted')
      // Drop the in-memory window and the legacy file synchronously: teardown
      // is the one place a deferred write would race the process exit.
      record.history.clear()
    }
    // Ask the store by path as well. With no record the call above never ran,
    // and a store this session's facade could not open must still not keep rows
    // nobody will ever look at again.
    forgetSessionHistory(join(ptyLogDir(), `${dshSessionId}.log`), dshSessionId)
    const agentRecord = this.agentRecordFor(dshSessionId)
    if (agentRecord !== undefined) this.markAgentDead(agentRecord, 'session deleted')
  }

  /** The live main record for one session, or undefined. Never spawns. */
  private liveRecord(dshSessionId: string): MainRecord | undefined {
    const agent = this.ctx.get('agents')?.get(dshSessionId as SessionId)
    if (agent === undefined) return undefined
    const record = this.mains.get(agent)
    if (record === undefined || record.dead !== undefined) return undefined
    return record
  }

  /** Cursor at the current head of one record. */
  private headCursor(record: MainRecord): CursorState {
    return {
      generation: record.generation,
      offset: record.absOffset,
      seq: record.commands.at(-1)?.seq ?? 0,
    }
  }

  /**
   * Incremental slice of one session's main-shell activity since a cursor —
   * the context-management read. Output is sanitized for the model; commands
   * closed since the cursor come back structured. Never spawns a shell.
   * @param dshSessionId - the dsh session whose main record to read.
   * @param cursor - token from a previous call; omitted means "nothing yet",
   *   which reports `cleared: false` and returns the whole retained window.
   * @returns the delta, or undefined when there is no live main shell.
   */
  since(dshSessionId: string, cursor?: string): TerminalDelta | undefined {
    const record = this.liveRecord(dshSessionId)
    if (record === undefined) return undefined
    const head = this.headCursor(record)
    const parsed = parseCursor(cursor)
    // A cursor from an older shell generation means the shell was replaced or
    // cleared: report the reset and restart from the new head rather than
    // replaying the seeded scrollback as if it were new.
    if (parsed !== undefined && parsed.generation !== record.generation) {
      return {
        cursor: formatCursor(head),
        generation: record.generation,
        text: '',
        commands: [],
        newCommandCount: 0,
        dropped: false,
        cleared: true,
      }
    }
    const windowText = record.buffer.text()
    const windowStart = record.absOffset - Buffer.byteLength(windowText, 'utf8')
    // No cursor at all means "nothing has been delivered yet": the whole
    // retained window is the first delta, so the model starts out knowing
    // what the terminal already shows.
    const slice = sliceWindow(windowText, record.absOffset, parsed?.offset ?? windowStart)
    const commands = record.commands.filter(command => command.seq > (parsed?.seq ?? 0))
    return {
      cursor: formatCursor(head),
      generation: record.generation,
      text: sanitizeTerminalText(slice.text),
      commands,
      newCommandCount: commands.length,
      dropped: slice.dropped || (parsed === undefined && windowStart > 0),
      cleared: false,
    }
  }

  /**
   * The latest retained commands of one session's main shell (no cursor) —
   * what an agent asks for when it wants to look back rather than catch up.
   * @param dshSessionId - the dsh session whose main record to read.
   * @param limit - newest-commands cap.
   * @returns the commands plus the cursor at the head, or undefined when no
   *   live main shell exists.
   */
  history(dshSessionId: string, limit: number): TerminalHistory | undefined {
    const record = this.liveRecord(dshSessionId)
    if (record === undefined) return undefined
    const commands = limit >= record.commands.length
      ? record.commands
      : record.commands.slice(record.commands.length - Math.max(0, limit))
    return {
      cursor: formatCursor(this.headCursor(record)),
      generation: record.generation,
      commands,
    }
  }

  /**
   * The newest commands of one session's main shell whose line starts with
   * `draft`, oldest first — the composer's up-arrow answer, and the one read
   * that is not bounded by the in-memory window: the durable store answers
   * whenever it is open, so a command older than the window is still findable.
   *
   * Never spawns, like `history`: a session without a live shell answers
   * undefined rather than getting one created to answer a question about it.
   * @param dshSessionId - the dsh session whose main record to read.
   * @param draft - the line being typed; empty lists plain history.
   * @param limit - how many matching commands to answer with, newest first.
   * @returns the matching commands, oldest first, or undefined when no live
   *   main shell exists. A match carries the line, its exit status and its time;
   *   the output stays in the PTY and block logs.
   */
  matchHistory(dshSessionId: string, draft: string, limit: number): readonly PersistedCommand[] | undefined {
    const record = this.liveRecord(dshSessionId)
    if (record === undefined) return undefined
    return record.history.match(draft, limit)
  }

  /**
   * One command's output, `limit` bytes from `offset` into the retained tail —
   * the read that lets a long command be looked at in slices instead of
   * injected whole.
   *
   * `cursor` pins the shell generation: after a respawn the same `seq` names a
   * different command, so a cursor from the previous shell answers `stale`
   * rather than a wrong slice. The bytes come from the durable store when it is
   * open, so this reaches across boots and past the in-memory window; without
   * one the window's display text answers instead. Never spawns.
   *
   * @param dshSessionId - the dsh session whose main shell to read.
   * @param cursor - a cursor the caller was handed; omitted means "not asking
   *   about a specific shell generation", which is only safe on a first call.
   * @param seq - the command whose output to read.
   * @param offset - byte offset into the retained output.
   * @param limit - how many bytes to return.
   * @returns the window, or undefined when no live main shell exists.
   */
  commandOutput(
    dshSessionId: string,
    cursor: string | undefined,
    seq: number,
    offset: number,
    limit: number,
  ): TerminalCommandOutput | undefined {
    const record = this.liveRecord(dshSessionId)
    if (record === undefined) return undefined
    const head = formatCursor(this.headCursor(record))
    const parsed = parseCursor(cursor)
    if (parsed !== undefined && parsed.generation !== record.generation) {
      return { cursor: head, generation: record.generation, stale: true, retained: false, command: null, exitCode: null, output: null }
    }
    const known = record.commands.find(command => command.seq === seq)
    const output = record.history.output(seq, offset, limit) ?? windowOutput(known, offset, limit)
    return {
      cursor: head,
      generation: record.generation,
      stale: false,
      retained: output !== null,
      command: known?.command ?? null,
      exitCode: known?.exitCode ?? null,
      output,
    }
  }

  /** Deliver a foreground signal to the main PTY. */
  async signal(dshSessionId: string, signal: TerminalSignal): Promise<void> {
    const record = await this.ensureMainShell(dshSessionId)
    await this.ctx.terminals.signal(record.agent, record.ptyId, signal)
  }

  /** Serialize queued input through the exclusive `startSend` slot. */
  private pump(record: MainRecord): void {
    // A dead PTY can never settle a send, and `startSend` on it throws — which
    // the catch below would turn into an unbreakable 100ms retry loop.
    if (record.dead !== undefined) return
    if (record.activeSend !== undefined || record.inputQueue.length === 0) return
    const text = record.inputQueue.join('')
    record.inputQueue.length = 0
    try {
      const operation = this.ctx.terminals.startSend(record.agent, record.ptyId, { text, submit: false })
      record.activeSend = operation
      void operation.done.then(() => {
        record.activeSend = undefined
        this.pump(record)
      }, () => {
        record.activeSend = undefined
        this.pump(record)
      })
    } catch {
      // The slot was taken (e.g. the agent's own terminal_send on main):
      // re-queue and retry shortly instead of dropping keystrokes.
      record.inputQueue.unshift(text)
      setTimeout(() => { this.pump(record) }, 100)
    }
  }

  /**
   * Mark a record dead: stop listeners, broadcast the close frame, and
   * schedule disposal so a reconnecting client still receives the frame
   * in its bindClient push sequence (Phase 9 hardening).
   *
   * The frame carries everything the client needs to explain the death: the
   * cause, the last connection diagnostic the output holds (a device session's
   * ssh stderr is the only place "Connection refused" exists), and whether the
   * shell had ever reached a prompt.
   */
  private markDead(record: MainRecord, reason: string): void {
    if (record.dead !== undefined) return
    const text = record.buffer.text()
    const detail = diagnosticTail(text)
    record.dead = { reason, detail, ready: record.ready, time: Date.now(), failure: record.session.failure }
    record.stopOutput()
    record.stopExit()
    record.stopForeground()
    record.stopOutput = () => {}
    record.stopExit = () => {}
    record.stopForeground = () => {}
    // Queued keystrokes have nowhere to go, and a pump that keeps retrying a
    // dead PTY is an endless 100ms loop. Dropping them is what the shell's
    // death means anyway.
    record.inputQueue.length = 0
    this.broadcast(record.dshSessionId, {
      kind: 'closed',
      reason,
      detail,
      ready: record.ready,
      failure: record.session.failure,
    })
    // Release the dsh-side name reservation NOW so a same-tick respawn
    // (via ensureLiveMain) doesn't collide with the still-resident owner.
    // A PTY can outlive its context — teardown kills the child, and this exit
    // callback then fires into a stopped context, where demanding the service
    // throws and an exit handler must never take the host down with it.
    try {
      void this.ctx.terminals.kill(record.agent, record.ptyId, 'dshell: dead').catch(() => {})
    } catch {
      // Context already gone; the reservation dies with it.
    }
    record.disposeTimer = setTimeout(() => { void this.disposeRecord(record) }, 200)
  }

  /** Drop a dead record from `mains` and release its PtyBuffer. */
  private async disposeRecord(record: MainRecord): Promise<void> {
    delete record.disposeTimer
    this.mains.delete(record.agent)
    // The debounced write would otherwise die with the process; the last
    // commands belong on disk.
    await record.history.flush().catch(() => {})
    await record.buffer.close().catch(() => {})
  }

  /**
   * Mark the agent's shell dead: stop listening and tell its panel.
   *
   * Unlike the main shell there is no dispose timer. A dead main shell has to
   * leave quickly — its name holds the next respawn back — while a dead agent
   * shell is worth keeping: it is the record of what the agent did, and the
   * panel that opens hours later must be able to say the shell ended and why,
   * not pretend none ever existed. The next `ensureAgentShell` replaces it.
   */
  private markAgentDead(record: AgentRecord, reason: string): void {
    if (record.dead !== undefined) return
    const text = record.buffer.text()
    record.dead = {
      reason,
      detail: diagnosticTail(text),
      ready: record.ready,
      time: Date.now(),
      failure: record.session.failure,
    }
    record.stopOutput()
    record.stopExit()
    record.stopOutput = () => {}
    record.stopExit = () => {}
    this.broadcastAgent(record.dshSessionId, {
      kind: 'closed',
      reason,
      detail: record.dead.detail,
      ready: record.ready,
      failure: record.dead.failure,
    })
    void this.ctx.terminals.kill(record.agent, record.ptyId, 'dshell: agent shell dead').catch(() => {})
  }

  /** Drop the agent record, releasing its buffer's file handle. */
  private async disposeAgentRecord(record: AgentRecord): Promise<void> {
    delete record.disposeTimer
    this.agents.delete(record.agent)
    await record.buffer.close().catch(() => {})
  }

  private async disposeAll(): Promise<void> {
    for (const record of [...this.mains.values()]) {
      if (record.disposeTimer !== undefined) clearTimeout(record.disposeTimer)
      record.stopOutput()
      record.stopExit()
      record.stopForeground()
      await record.history.flush().catch(() => {})
      await record.buffer.close().catch(() => {})
    }
    for (const record of [...this.agents.values()]) {
      if (record.disposeTimer !== undefined) clearTimeout(record.disposeTimer)
      record.stopOutput()
      record.stopExit()
      await record.buffer.close().catch(() => {})
    }
    this.mains.clear()
    this.agents.clear()
    // One shared database per log directory: closed once, after the last session
    // that could write to it. Closing per record would pull the handle out from
    // under the sessions still alive.
    closeHistoryStore(join(ptyLogDir(), HISTORY_STORE_FILENAME))
    for (const client of this.streams.values()) client.close(1000, 'bridge disposed')
    this.streams.clear()
    this.clients.clear()
    this.boundSession.clear()
    this.agentClients.clear()
    this.agentBound.clear()
  }

  /**
   * Bind one fetch stream to one session — the GET's own bind.
   *
   * The stream replaces any subscriber this client id already had: a client
   * that reconnects opens a new GET before its old body is known to be gone,
   * and keeping both would push every frame twice into whichever one is still
   * being read.
   * @param clientId - the id both halves of this client's stream carry.
   * @param dshSessionId - the session whose frames it wants.
   * @param stream - the user's main shell, or the agent panel's.
   * @param controller - the response body the frames are written to.
   */
  attachStream(
    clientId: string,
    dshSessionId: string,
    stream: 'main' | 'agent',
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    if (this.streams.has(clientId)) this.detachStream(clientId)
    const client = new FetchSubscriber(clientId, controller)
    this.streams.set(clientId, client)
    if (stream === 'agent') this.bindAgent(client, dshSessionId)
    else this.bindClient(client, dshSessionId)
  }

  /**
   * Hand one control frame from a stream client's POST to the same code the ws
   * path runs.
   *
   * `bind` is a no-op here: the GET that created this subscriber already
   * carried the session and stream, and running the ws bind again would push a
   * second snapshot to a client that just got one.
   * @param clientId - the stream client the frame claims to be.
   * @param frame - the decoded control frame.
   */
  handleStreamFrame(clientId: string, frame: unknown): void {
    const client = this.streams.get(clientId)
    if (client === undefined) return
    if (typeof frame !== 'object' || frame === null) return
    const fields = frame as ClientFrame
    if (fields.kind === 'bind') return
    this.handleClientFrame(client, fields)
  }

  /** The stream is gone (consumer cancelled, or the HTTP client disconnected). */
  detachStream(clientId: string): void {
    const client = this.streams.get(clientId)
    if (client === undefined) return
    this.streams.delete(clientId)
    this.dropSubscriber(client)
  }

  private attachClient(socket: WebSocket): void {
    const client = new WsSubscriber(socket)
    socket.on('message', (data: unknown) => {
      let frame: ClientFrame
      try {
        frame = JSON.parse(String(data)) as ClientFrame
      } catch {
        return
      }
      this.handleClientFrame(client, frame)
    })
    socket.on('close', () => { this.dropSubscriber(client) })
  }

  /** Route one decoded control frame from one subscriber. */
  private handleClientFrame(client: PtySubscriber, frame: ClientFrame): void {
    if (frame.kind === 'bind' && typeof frame.sessionId === 'string') {
      // The task card's panel opens a stream of its own for the agent's
      // shell; the main stream and the agent stream never share one.
      if (frame.stream === 'agent') this.bindAgent(client, frame.sessionId)
      else this.bindClient(client, frame.sessionId)
      return
    }
    const agentSession = this.agentBound.get(client)
    if (agentSession !== undefined) {
      if (frame.kind === 'agent-open') this.openAgentFor(client, agentSession)
      else if (frame.kind === 'resize' && typeof frame.cols === 'number') this.resizeAgent(agentSession, frame.cols)
      return
    }
    const bound = this.boundSession.get(client)
    // Handled before the bound check on purpose: the view sends its grid the
    // moment its seat is laid out, which can be before this client finished
    // binding (and before the shell it names was spawned).
    if (frame.kind === 'resize' && typeof frame.cols === 'number' && typeof frame.rows === 'number') {
      const session = bound ?? frame.sessionId
      if (session === undefined) return
      if (bound !== undefined && frame.sessionId !== undefined && frame.sessionId !== bound) return
      const cols = Math.max(1, Math.floor(frame.cols))
      const rows = Math.max(1, Math.floor(frame.rows))
      this.pendingSizes.set(session, { cols, rows })
      const resizeAgent = this.ctx.get('agents')?.get(session as SessionId)
      const resizeRecord = resizeAgent === undefined ? undefined : this.mains.get(resizeAgent)
      resizeRecord?.session.resize(cols, rows)
      return
    }
    // A retry, from the client's automatic loop or its button. Handled
    // before the bound check because the client may be the one that knows
    // the shell is gone (its own carrier survived the PTY's death).
    if (frame.kind === 'reconnect') {
      const session = bound ?? frame.sessionId
      if (session === undefined) return
      if (bound !== undefined && frame.sessionId !== undefined && frame.sessionId !== bound) return
      this.reconnectClient(client, session)
      return
    }
    if (bound === undefined || (frame.sessionId !== undefined && frame.sessionId !== bound)) return
    if (frame.kind === 'input' && typeof frame.text === 'string') {
      this.feed(bound, frame.text)
      return
    }
    if (frame.kind === 'signal' && typeof frame.signal === 'string') {
      if (frame.signal === 'SIGINT' || frame.signal === 'SIGTERM' || frame.signal === 'SIGTSTP') {
        void this.signal(bound, frame.signal).catch((error: unknown) => {
          console.warn('dshell-bridge: signal failed:', error)
        })
      }
      return
    }
  }

  /** Forget one subscriber: it left every session it was watching. */
  private dropSubscriber(client: PtySubscriber): void {
    const agentSession = this.agentBound.get(client)
    if (agentSession !== undefined) {
      this.agentBound.delete(client)
      const watching = this.agentClients.get(agentSession)
      watching?.delete(client)
      if (watching !== undefined && watching.size === 0) this.agentClients.delete(agentSession)
    }
    const bound = this.boundSession.get(client)
    this.boundSession.delete(client)
    if (bound !== undefined) {
      const set = this.clients.get(bound)
      set?.delete(client)
      if (set !== undefined && set.size === 0) this.clients.delete(bound)
    }
    // A stream subscriber is also indexed by its client id; leaving that entry
    // behind would let a later POST resolve to a carrier nobody reads.
    if (client instanceof FetchSubscriber) this.streams.delete(client.clientId)
  }

  /**
   * Subscribe one socket to a session's agent shell and tell it the state.
   *
   * Subscribing is not spawning: the panel may open against a session whose
   * agent has never touched a terminal, and that is a state to report, not a
   * reason to start a second shell. `agent-open` is the frame that asks for
   * one.
   */
  private bindAgent(client: PtySubscriber, dshSessionId: string): void {
    let set = this.agentClients.get(dshSessionId)
    if (set === undefined) {
      set = new Set()
      this.agentClients.set(dshSessionId, set)
    }
    set.add(client)
    this.agentBound.set(client, dshSessionId)
    this.pushAgentSnapshot(client, dshSessionId)
  }

  /** Spawn the agent's shell on the panel's request, then report it. */
  private openAgentFor(client: PtySubscriber, dshSessionId: string): void {
    void this.ensureAgentShell(dshSessionId).then(() => {
      this.pushAgentSnapshot(client, dshSessionId)
    }, (error: unknown) => {
      this.sendFrame(client, {
        kind: 'error',
        stream: 'agent',
        message: this.describeSpawnError(error),
        sessionId: dshSessionId,
        // Structured, because the client has to CHOOSE a presentation from it:
        // a machine that cannot host a local shell needs a screen of its own,
        // and reading that out of the message text would be a guess.
        ...LOCAL_SHELL_SUPPORTED ? {} : { localUnsupported: true },
      })
    })
  }

  /**
   * Apply the panel's width to the agent's shell.
   *
   * Only the columns: the panel is a short window onto a full-height terminal,
   * so it scrolls rather than shrinking the rows a full-screen program may
   * draw. A request that arrives before the shell exists is remembered and
   * applied at spawn.
   */
  private resizeAgent(dshSessionId: string, cols: number): void {
    const width = Math.max(20, Math.min(500, Math.floor(cols)))
    this.agentCols.set(dshSessionId, width)
    const record = this.agentRecordFor(dshSessionId)
    if (record === undefined || record.dead !== undefined) return
    record.session.resize(width, DEFAULT_PTY_ROWS)
  }

  /** Hand one panel client the agent shell's existence, state and scrollback. */
  private pushAgentSnapshot(client: PtySubscriber, dshSessionId: string): void {
    const record = this.agentRecordFor(dshSessionId)
    this.sendFrame(client, {
      kind: 'agent-info',
      stream: 'agent',
      live: record !== undefined && record.dead === undefined,
      ready: record?.ready ?? false,
      ...record?.dead === undefined
        ? {}
        : { reason: record.dead.reason, detail: record.dead.detail, failure: record.dead.failure },
    })
    if (record !== undefined) {
      this.sendFrame(client, {
        kind: 'output',
        stream: 'agent',
        chunk: record.initializing ? '' : record.buffer.text(),
        time: Date.now(),
        replay: true,
      })
    }
  }

  private bindClient(client: PtySubscriber, dshSessionId: string): void {
    // Stash the dead reason BEFORE ensureMainShell swaps in a replacement,
    // so the close frame can be forwarded to a freshly reconnected client.
    const agent = this.ctx.get('agents')?.get(dshSessionId as SessionId)
    const priorDead = agent === undefined ? undefined : this.mains.get(agent)?.dead
    this.attachToSession(client, dshSessionId, priorDead)
  }

  /**
   * Bind one client to a session and hand it that session's current state.
   *
   * A failure to start the shell does NOT close the socket any more. The
   * failure is almost always the device (unreachable host, refused key) or a
   * session whose agent has not materialized, and those are exactly what a
   * retry is for; closing would discard the connection the retry needs and
   * leave the client reconnecting into the same wall. The error frame says
   * what happened and the client decides whether to try again.
   */
  private attachToSession(
    client: PtySubscriber,
    dshSessionId: string,
    priorDead?: { reason: string; detail?: string | undefined; ready: boolean; failure?: SshFailure | undefined },
  ): void {
    void this.ensureMainShell(dshSessionId).then((record) => {
      this.adopt(client, dshSessionId)
      if (priorDead !== undefined) {
        this.sendFrame(client, {
          kind: 'closed',
          reason: priorDead.reason,
          detail: priorDead.detail,
          ready: priorDead.ready,
          failure: priorDead.failure,
        })
      }
      this.pushSnapshot(client, record)
    }, (error: unknown) => {
      // Stay bound: the client's retry is a frame on this very socket.
      this.adopt(client, dshSessionId)
      this.sendFrame(client, {
        kind: 'error',
        message: this.describeSpawnError(error),
        sessionId: dshSessionId,
        // Structured, because the client has to CHOOSE a presentation from it: a
        // machine that cannot host a local shell needs a screen of its own, and
        // reading that out of the message text would be a guess.
        ...LOCAL_SHELL_SUPPORTED ? {} : { localUnsupported: true },
        // A locked vault group is the other one: the shell was never attempted,
        // the token is the way out, and a retry would only repeat the refusal.
        ...lockedVaultRefusal(error) ? { lockedGroup: true } : {},
        // And the third: the session has no live agent, so no shell was
        // attempted at all. Nothing is broken and nothing is waiting on a
        // token — the session simply has not been asked to do anything yet.
        ...noShellRefusal(error) ? { noShell: true } : {},
        // A device whose credential or host key was refused: the message alone
        // does not say which of the two the reader can act on.
        ...classifyDeviceFailure(error) === undefined ? {} : { failure: classifyDeviceFailure(error) },
      })
    })
  }

  /**
   * Replace one session's dead shell on behalf of one client — its retry
   * button or its automatic retry loop — then hand that client the new state.
   *
   * The old scrollback is not lost: a respawn seeds its buffer from the
   * persisted log, so the replay carries the history the client already had,
   * with the new shell's prompt appended after it.
   */
  private reconnectClient(client: PtySubscriber, dshSessionId: string): void {
    void this.ensureMainShell(dshSessionId).then((record) => {
      this.adopt(client, dshSessionId)
      this.pushSnapshot(client, record)
    }, (error: unknown) => {
      this.sendFrame(client, {
        kind: 'error',
        message: this.describeSpawnError(error),
        sessionId: dshSessionId,
        ...LOCAL_SHELL_SUPPORTED ? {} : { localUnsupported: true },
        ...lockedVaultRefusal(error) ? { lockedGroup: true } : {},
        ...noShellRefusal(error) ? { noShell: true } : {},
        ...classifyDeviceFailure(error) === undefined ? {} : { failure: classifyDeviceFailure(error) },
      })
    })
  }

  /**
   * The honest text of a failed spawn for the wire.
   *
   * `String(error)` would prefix "Error: ", and an Error with no message would
   * ship an empty line; the client shows this verbatim in its connection panel,
   * so it has to be a sentence either way. A real message (the PTY's own
   * localized failure, or a `dshell-bridge: …` diagnostic that is a contract,
   * not copy) passes through unchanged; only the empty-message fallback is
   * composed here.
   */
  private describeSpawnError(error: unknown): string {
    const text = (error instanceof Error ? error.message : String(error)).trim()
    return text === '' ? this.t('spawn.failed') : text
  }

  /** Register one client as a subscriber of one session. */
  private adopt(client: PtySubscriber, dshSessionId: string): void {
    // A carrier that died while the shell was spawning must not be adopted:
    // the snapshot below would be written to nobody, and the entry would keep
    // the id in `clients` until some later frame admitted it was gone.
    if (!client.open) return
    let set = this.clients.get(dshSessionId)
    if (set === undefined) {
      set = new Set()
      this.clients.set(dshSessionId, set)
    }
    set.add(client)
    this.boundSession.set(client, dshSessionId)
  }

  /** Hand one client the session's identity, scrollback and block order. */
  private pushSnapshot(client: PtySubscriber, record: MainRecord): void {
    // `ready` rides the info frame so a client that binds (or re-binds) after
    // the fact still knows whether this shell ever reached a prompt.
    this.sendFrame(client, {
      kind: 'info',
      user: this.promptUser,
      host: this.promptHost,
      home: homedir(),
      ready: record.ready,
    })
    this.sendFrame(client, {
      kind: 'output',
      chunk: record.initializing ? '' : record.buffer.text(),
      time: Date.now(),
      replay: true,
      timeline: record.buffer.timelineEntries().map(entry => [entry.t, entry.n]),
    })
    // The host owns block order; the client renders this list as given.
    this.sendFrame(client, { kind: 'blocks', blocks: record.blocks.snapshot() })
    // A client that binds while a program owns the terminal has to know the
    // surface is that program's, not the timeline's — and one that re-binds
    // after the program ended must not be left in a mode nothing will take it
    // out of. Sent unconditionally, because "nothing is running" is an answer.
    this.sendFrame(client, { kind: 'tui', ...record.foreground.snapshot })
  }

  /** Send a single frame to one subscriber; tolerates a closing carrier. */
  private sendFrame(client: PtySubscriber, payload: Record<string, unknown>): void {
    if (!client.open) return
    client.send(JSON.stringify(payload))
  }

  private broadcast(dshSessionId: string, frame: Record<string, unknown>): void {
    const set = this.clients.get(dshSessionId)
    if (set === undefined) return
    const data = JSON.stringify(frame)
    for (const client of set) {
      if (client.open) client.send(data)
    }
  }

  /** Fan one frame out to the panels watching a session's agent shell. */
  private broadcastAgent(dshSessionId: string, frame: Record<string, unknown>): void {
    const set = this.agentClients.get(dshSessionId)
    if (set === undefined) return
    const data = JSON.stringify({ stream: 'agent', ...frame })
    for (const client of set) {
      if (client.open) client.send(data)
    }
  }
}

/** Defensive escape: drop chars that would let a quoted $PS1 leak out. */
function safeShellWord(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** One POSIX shell word, quoted so any character inside stays literal. */
function shellQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`
}

/**
 * The directory the *user's* shell is sitting in, as a shell word.
 *
 * The prompt dshell installs is `user@host:dir$`, printed by the shell itself
 * on every prompt render, so when the user's shell is idle its scrollback ends
 * in that directory. Nothing else reports a terminal's working directory —
 * there is no cwd channel on this wire — and this is what lets the agent's
 * shell open where the user is looking instead of in the session's original
 * directory, which is the closest thing to a fork of their shell that the
 * model of a PTY allows.
 *
 * `~` is rebuilt as `"$HOME"` because a tilde inside quotes would not expand;
 * the rest of the path is single-quoted verbatim. Best effort by design: a
 * shell in the middle of a command ends in output, not in a prompt, and then
 * this returns nothing and the caller leaves the new shell where it spawned.
 * @param record - the user's main record, when one exists.
 * @returns the quoted directory, or undefined when the tail is not a prompt.
 */
function forkDirWord(record: MainRecord | undefined): string | undefined {
  if (record === undefined) return undefined
  const stripped = stripAnsi(record.buffer.text())
  const lines = stripped.split('\n')
  let tail = ''
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? ''
    if (line.length > 0) { tail = line; break }
  }
  // `user@host:dir$` (or `#` for a root shell) — the prompt this bridge
  // installs, matched at the very end of the line.
  const match = /@[^:@\s]*:([^$#\n]*)[$#]\s*$/.exec(tail)
  const dir = match?.[1]?.trim()
  if (dir === undefined || dir.length === 0) return undefined
  if (dir === '~') return '"$HOME"'
  if (dir.startsWith('~/')) return `"$HOME"/${shellQuote(dir.slice(2))}`
  if (!dir.startsWith('/')) return undefined
  return shellQuote(dir)
}

/**
 * One command's display text sliced for a reader — the fallback when the store
 * is unavailable.
 *
 * The window's text is the *preview* form: capped at 16 KiB and carrying its own
 * truncation marker, so `bytes` here is what was retained rather than what the
 * command produced, and `dropped` is unknown. That is exactly why the store is
 * preferred whenever it is open.
 */
function windowOutput(
  record: TerminalCommandRecord | undefined,
  offset: number,
  limit: number,
): HistoryOutputSlice | null {
  if (record === undefined || limit <= 0) return null
  const bytes = Buffer.from(record.output, 'utf8')
  const total = bytes.length
  let from = Math.min(Math.max(0, Math.trunc(offset)), total)
  let end = Math.min(from + Math.max(0, Math.trunc(limit)), total)
  // Snap to UTF-8 character boundaries, so a byte-offset page never returns
  // half a character at a seam.
  while (from < total && (bytes[from]! & 0b1100_0000) === 0b1000_0000) from += 1
  while (end > from && end < total && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1
  return {
    text: bytes.subarray(from, end).toString('utf8'),
    bytes: total,
    dropped: 0,
    offset: from,
    total,
    truncated: end < total,
  }
}

/** Reject one unauthenticated upgrade with dsh's status semantics. */
function rejectUpgrade(socket: Duplex, status: 401 | 403): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
  const body = reason.toLowerCase()
  socket.end([
    `HTTP/1.1 ${String(status)} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}

export function apply(ctx: Context): void {
  // The host's copy direction, provided here because this is the earliest
  // package in the graph that every writer of host copy can wait for.
  // dshell-mode looks like the natural owner — it owns the presentation
  // surfaces — but it WAITS for this package's PTY service
  // (`dshellTerminalBridge`), so a provider it owned would deadlock the
  // profile's activation: mode pending on the bridge, the bridge pending on
  // mode. The dependency edge already points this way, so the service lives at
  // the far end of it.
  const copy = createHostCopy(ctx)
  ctx.provide('dshellHostCopy', copy)
  // The browser reports the language it resolved (boot and every change);
  // host-composed text can then match the screen instead of guessing.
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(
      () => connectionCtx.connection.fetch.register(createLocaleRoute(copy)),
      'dshell-bridge: locale report route',
    )
    // The settings card's folder picker lists THIS machine's directories: the
    // card cannot call a native dialog (a page has no host file system) and the
    // harness is not necessarily the machine drawing it — see the route's own
    // header for why it belongs beside the locale report.
    connectionCtx.effect(
      () => connectionCtx.connection.fetch.register(createDirsRoute()),
      'dshell-bridge: directory browser route',
    )
  })
  ctx.plugin(DshellTerminalBridge)
}

export default { name, apply }
