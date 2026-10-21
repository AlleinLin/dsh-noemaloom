/**
 * dshell raw PTY backend — the canvas phase.
 *
 * dsh's terminal-bash backend sanitizes all ANSI out of scrollback (a
 * documented line-oriented decision), which starves a real terminal
 * canvas. This backend owns the dshell main shells instead: a plain
 * node-pty bash with TERM=xterm-256color and a UTF-8 locale the shell can
 * actually render with (`shell-locale.ts` — the ambient `LC_ALL=C.UTF-8`
 * an agent sandbox leaves behind makes uutils' `ls` shell-escape every
 * non-ASCII filename), raw bytes retained and
 * streamed to the bridge verbatim (colors, cursor control, readline
 * redraws all reach the browser). The agent-facing surface
 * (`terminal_read`, send viewports, motd) is ANSI-stripped so tool
 * results stay clean text.
 *
 * A session bound to a device gets the same canvas over a DIFFERENT shell:
 * a pty channel on the device's own connection, opened by the SSH plugin
 * and consumed here structurally. The two shapes share every behaviour a
 * reader can see — settle, scrollback, resize, signals, exit reporting —
 * because that behaviour lives in one base class and only the four I/O
 * primitives (write, kill, resize, exit) differ between them.
 *
 * Send settle is ours: PROMPT_COMMAND prints the OSC 133;D marker before
 * every prompt, so a settled prompt is "marker seen and the stream is
 * quiet" — the ~60ms fast path — with a 350ms silence fallback and an
 * absolute timeout. No sanitizer, no dsh-side prompt-text dependency.
 */

import { StringDecoder } from 'node:string_decoder'
import type { Duplex } from 'node:stream'
import * as nodePty from 'node-pty'
import { TerminalError } from '@deepseek-ai/dsh-terminal'
import type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendRead,
  TerminalSendRequest,
  TerminalSendResult,
  TerminalSessionId,
  TerminalSessionStatus,
  TerminalSignal,
  TerminalSignalResult,
  TerminalWaitReason,
} from '@deepseek-ai/dsh-terminal'
import type { TerminalBackendSpawnSpec } from '@deepseek-ai/dsh-terminal'
import type { DshellTerminalBridgeHostTranslator } from './host-locales.js'
import { shellLocale } from './shell-locale.js'

/** Retention bounds for one raw session (mirrors dsh's own defaults). */
const RETAINED_MAX_BYTES = 4 * 1024 * 1024
const RETAINED_MAX_LINES = 10_000
/** One read/send result caps at this many bytes (tail kept). */
const MAX_RESULT_BYTES = 256 * 1024

/** Settle tuning: marker fast path, silence fallback, absolute bound. */
const PROMPT_QUIET_MS = 60
const SILENT_SETTLE_MS = 350
const SEND_TIMEOUT_MS = 15_000
const SETTLE_POLL_MS = 25

/** Prompt-end marker our PROMPT_COMMAND prints before every prompt. */
const PROMPT_MARKER = '\u001b]133;D;'
const MARKER_CARRY_CHARS = 64

/** Strip CSI/OSC/two-byte escape sequences and BEL for plain-text reads. */
const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '').replaceAll('\u0007', '')
}

/**
 * What a transport says when it cannot connect, matched loosely on purpose: a
 * refused connection, a stalled handshake, a name that does not resolve and a
 * key that was rejected all arrive as one of these lines.
 */
const SSH_DIAGNOSTIC =
  /(ssh:|kex_exchange_identification|Connection (?:refused|timed out|closed|reset)|Permission denied|Host key verification failed|Could not resolve hostname|No route to host|Network is unreachable|Operation timed out)/i

/**
 * A failure the reader has a way to DO something about, as opposed to one they
 * can only wait out.
 *
 * A device session's failures arrive as structured errors from the transport,
 * which is the difference between naming one and guessing at it: the old path
 * had to match English prose out of the ssh client's stderr, which reported a
 * non-English device's refused password as an unknown fault. Most failures need
 * nothing but a line to read — a refused connection is retried, a stalled
 * handshake is waited on. These two are different: both are a decision the user
 * has to make, and both are recoverable, which is exactly why they are named
 * here instead of being left for the reader to recognise in prose:
 *
 *  - `passphrase`: the stored secret for this device was refused. Nothing about
 *    the network is wrong, so retrying cannot help, and the user has to re-enter
 *    it.
 *  - `hostKey`: the device presented a different host key than the one this
 *    plugin recorded. That is what a reinstall looks like, and also what an
 *    interposed host looks like, so it is never resolved automatically.
 *
 * Anything else is undefined and keeps the existing presentation.
 */
export type SshFailure = 'passphrase' | 'hostKey'

/**
 * The actionable failure one spawn rejection carries, if any.
 *
 * Read structurally off the error's `kind`, which the device transport sets
 * where the cause is known. Read structurally rather than imported because this
 * package composes without the SSH plugin: the field name is the one stable
 * thing a refusal carries across that boundary, the same way
 * {@link lockedVaultRefusal} reads a name.
 *
 * The order matters. A device whose host key changed makes the transport refuse
 * the connection outright, but a refused key can ALSO surface as an
 * authentication failure on a host that will not say which of the two it is —
 * and reading that as a bad passphrase would send the user to fix a secret that
 * is perfectly correct. Host key therefore wins.
 *
 * @param error - whatever the spawn plan or the transport rejected with.
 * @returns the failure kind, or undefined when it describes none.
 */
export function classifyDeviceFailure(error: unknown): SshFailure | undefined {
  const kind = (error as { kind?: unknown } | undefined)?.kind
  if (kind === 'hostKey') return 'hostKey'
  if (kind === 'auth') return 'passphrase'
  return undefined
}

/**
 * Whether a failed spawn is a vault group's lock rather than a connection.
 *
 * A session bound to a device whose credential is sealed in a locked group has
 * no shell to start, and the router refuses the spawn plan with a
 * `VaultLockedError` naming that group. Unlike every other spawn failure this
 * one has a way out the reader can take without leaving the terminal — the
 * group's token — and it is the one failure a retry cannot fix, so the client
 * has to be told which kind it got.
 *
 * Recognised by the error's name rather than by importing the SSH package: the
 * bridge must compose without it, and the name is the one stable thing the
 * refusal carries across that boundary.
 *
 * @param error - whatever the spawn plan rejected with.
 * @returns whether the refusal is a locked vault group.
 */
export function lockedVaultRefusal(error: unknown): boolean {
  return error instanceof Error && error.name === 'VaultLockedError'
}

/**
 * The failure of a session that has no live agent, so no shell was attempted.
 *
 * A session in agent mode owns no shell until it is asked to do something: the
 * bridge waits for the session's agent to materialize, and a session nobody has
 * sent anything to never gets one. The client has to be able to tell this apart
 * from a shell that failed to start, because the two need opposite
 * presentations — one is a session waiting, the other is a session in trouble —
 * and the message text alone says neither.
 *
 * @param sessionId - the session the bridge waited for.
 */
export class NoAgentError extends Error {
  constructor(sessionId: string) {
    super(`dshell-bridge: no live agent for session "${sessionId}"`)
    this.name = 'NoAgentError'
  }
}

/**
 * Whether a failure means no shell was ever attempted for this session.
 *
 * @param error - whatever the shell attempt rejected with.
 * @returns whether the session had no live agent to run a shell.
 */
export function noShellRefusal(error: unknown): boolean {
  return error instanceof NoAgentError
}

/**
 * The last connection diagnostic in a stretch of terminal output.
 *
 * A device session's terminal is a local `ssh` process, so "cannot connect"
 * arrives as that process's stderr — merged into the same PTY stream as
 * everything else, and gone once the session is torn down. When the shell dies
 * there is no structured error to read (node-pty reports an exit code only), so
 * the reason has to be recovered from the text. A line that does not look like
 * an ssh diagnostic is never returned: no match means no detail line, rather
 * than an arbitrary last line presented as the cause.
 *
 * @param text - raw terminal output, ANSI included.
 * @param maxChars - cap on the returned line, which is shown in a narrow banner.
 * @returns the diagnostic line, or undefined when the output has none.
 */
export function diagnosticTail(text: string, maxChars = 240): string | undefined {
  const lines = stripAnsi(text).split('\n')
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at]?.trim() ?? ''
    if (line === '' || !SSH_DIAGNOSTIC.test(line)) continue
    return line.length > maxChars ? line.slice(0, maxChars) : line
  }
  return undefined
}

/** node-pty reports numeric signals; map the common ones to their names. */
function exitSignalName(signal: number | undefined): NodeJS.Signals | null {
  switch (signal) {
    case undefined:
    case 0:
      return null
    case 1:
      return 'SIGHUP'
    case 2:
      return 'SIGINT'
    case 3:
      return 'SIGQUIT'
    case 9:
      return 'SIGKILL'
    case 15:
      return 'SIGTERM'
    case 20:
    case 24:
      return 'SIGTSTP'
    default:
      return null
  }
}

/**
 * How a dead PTY is named to the user: the signal that killed it, else its
 * exit code.
 *
 * node-pty reports a killed process as `exitCode: 0, signal: 9`, so listing
 * both would read as a clean exit; the signal is the true story.
 *
 * @param status - the `exited` status of a terminal session.
 * @returns a short human-readable cause.
 */
export function exitLabel(status: Extract<TerminalSessionStatus, { kind: 'exited' }>): string {
  if (status.signal !== null) return `signal ${status.signal}`
  return `exit code ${status.exitCode === null ? 'unknown' : String(status.exitCode)}`
}

/** Cap to the newest `maxBytes` UTF-8 bytes without splitting a codepoint. */
function utf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return { text, truncated: false }
  let start = bytes.length - maxBytes
  while (start < bytes.length && (bytes[start]! & 0b1100_0000) === 0b1000_0000) start++
  return { text: bytes.subarray(start).toString('utf8'), truncated: true }
}

/** Push-based rich session the bridge consumes for the canvas wire. */
export interface DshellPtySession extends TerminalBackendSession {
  /** Subscribe to raw ANSI output chunks (the bridge is the sole consumer). */
  onOutput(listener: (chunk: string) => void): () => void
  /** Subscribe to process exit. */
  onExit(listener: (status: TerminalSessionStatus) => void): () => void
  /** Resize the pty (the browser canvas drives this). */
  resize(cols: number, rows: number): void
  /**
   * Top-level process id, or 0 when this session has no local process.
   *
   * A local shell has one; a device session does not — its process runs on the
   * device, so there is no local pid to watch a foreground program through or to
   * read a working directory from. Every reader that wants a real one is behind
   * a `redirected` check for exactly that reason, and 0 is a pid no process on
   * this machine can have.
   */
  readonly pid: number
  /**
   * The actionable failure this session ended with, when it ended with one.
   *
   * Read structurally off the transport's error by the session that can see it;
   * a local shell never sets it.
   */
  readonly failure: SshFailure | undefined
  /**
   * Whether the spawn plan sent this shell somewhere else.
   *
   * A device session's shell runs on the device, so nothing local — no working
   * directory, no foreground process — describes where the user actually is.
   */
  readonly redirected: boolean
}

class RawSendOperation implements TerminalSendOperation {
  private readonly resolvers = Promise.withResolvers<TerminalSendResult>()
  private finished = false
  private cancelled = false
  private viewport = ''

  constructor(private readonly onCancel: () => void) {}

  get done(): Promise<TerminalSendResult> {
    return this.resolvers.promise
  }

  get settled(): boolean {
    return this.finished
  }

  get cancelRequested(): boolean {
    return this.cancelled
  }

  append(text: string): void {
    if (!this.finished) this.viewport += text
  }

  settle(waitReason: TerminalWaitReason, status: TerminalSessionStatus): void {
    if (this.finished) return
    this.finished = true
    const bounded = utf8Tail(stripAnsi(this.viewport), MAX_RESULT_BYTES)
    this.resolvers.resolve({
      viewport: bounded.text,
      waitReason,
      sessionStatus: status,
      truncated: bounded.truncated,
    })
  }

  fail(error: unknown): void {
    if (this.finished) return
    this.finished = true
    this.resolvers.reject(error)
  }

  readOutput(): TerminalSendRead {
    const delta = this.viewport
    this.viewport = ''
    return { delta, truncated: false }
  }

  cancel(): boolean {
    if (this.finished) return false
    this.cancelled = true
    this.onCancel()
    return true
  }
}

/**
 * A shell running on a device, as this package consumes it.
 *
 * Declared here rather than imported from the SSH plugin, because this package
 * composes without it: the plugin publishes a plan and this interface is the
 * structural half of that contract, the same way the router is reached by
 * service name.
 */
export interface DeviceShellHandle {
  /** The shell's stdin and stdout, as one duplex channel of raw bytes. */
  readonly stream: Duplex
  /** Settles with the shell's exit status; never rejects. */
  readonly done: Promise<{ exitCode: number | null; signal: string | null }>
  /** Resize the remote terminal. */
  setWindow(rows: number, cols: number): void
  /** End the shell. */
  close(): void
}

/** What the backend needs before it can open one device shell. */
export interface DeviceShellWindow {
  readonly rows: number
  readonly cols: number
  /** `$TERM` on the device; this package names the terminal it renders. */
  readonly terminalType: string
}

/**
 * How the backend opens one session's VISIBLE terminal on its device.
 *
 * An opener rather than a command line: the device's address, its credentials
 * and its trust decision belong to the SSH plugin, and copying any of them here
 * would be a second place that has to agree about them.
 */
export interface DeviceShellPlan {
  readonly kind: 'device'
  readonly open: (window: DeviceShellWindow) => Promise<DeviceShellHandle>
}

/** What the backend knows about the session whose terminal it is about to spawn. */
export interface PtySpawnQuery {
  /** Session-backed agent identity: the key a binding is written under. */
  readonly sessionId: string | undefined
  /** The session's own directory, which for a bound session IS its device mount. */
  readonly cwd: string | undefined
}

/**
 * How the backend asks whether a session's terminal should run somewhere else.
 *
 * Answered by session identity, with the directory as context. Directory alone
 * cannot identify the caller: one device tree's mount directory is shared by
 * every session bound to that device and root, and a session that merely
 * inherited a mount path as its cwd (an unbound session) would then borrow a
 * device shell it has no binding for. The bridge supplies this; keeping it a
 * plain function here means this package does not depend on the SSH plugin, and
 * a composition without it simply gets local shells.
 */
export type PtySpawnPlanResolver = (
  query: PtySpawnQuery,
) => DeviceShellPlan | undefined | Promise<DeviceShellPlan | undefined>

/** The default local interactive shell, unchanged from before this seam existed. */
const LOCAL_SHELL = { argv: ['/bin/bash', '--noprofile', '--norc', '-i'] } as const

/**
 * Whether THIS machine can host the local shell at all.
 *
 * `/bin/bash` is the one program in the whole suite that has no Windows
 * spelling, and dshell's terminal is that program's output — so on Windows a
 * local session has nothing to show and the honest move is to say so rather than
 * let a spawn fail with ENOENT. A session BOUND to a device is unaffected: its
 * shell runs on the far machine, and Windows is a perfectly good place to reach
 * a device from.
 *
 * Not probed for a Windows POSIX shell (Git Bash, WSL): that would be a
 * different product decision — the completion oracle, the POSIX quoting and the
 * AI's own terminal tools all assume the shell speaks POSIX, and finding
 * `/bin/bash` on a Windows host is not the same as dshell being able to use it.
 * The refusal below is the cheaper, more honest half.
 */
export const LOCAL_SHELL_SUPPORTED = process.platform !== 'win32'

/** Why a local session cannot run here, when it cannot. */
export const LOCAL_SHELL_UNSUPPORTED_REASON =
  'dshell 的集成终端需要一个 POSIX shell；这台机器是 Windows，本地起不了。绑一台设备就能用。'

/**
 * Everything a raw shell session is, apart from how its bytes travel.
 *
 * The local shell and the device shell differ in exactly four operations —
 * writing input, signalling the process, resizing the window, and the hard kill
 * that ends a close — and in nothing a reader can observe. Settle, scrollback
 * trimming, the prompt marker, the exit status and the ANSI-stripped reads are
 * therefore written once, here, and both subclasses only answer the four.
 */
abstract class RawSessionBase implements DshellPtySession {
  motd = ''
  readonly pid: number
  readonly redirected: boolean

  protected readonly decoder = new StringDecoder('utf8')
  private retained = ''
  private retainedTruncated = false
  private readonly outputListeners = new Set<(chunk: string) => void>()
  private readonly exitListeners = new Set<(status: TerminalSessionStatus) => void>()
  private statusValue: TerminalSessionStatus = { kind: 'running' }
  private active: RawSendOperation | undefined
  private markerCarry = ''
  private lastOutputAt = Date.now()
  private markerAt = 0
  private settleTimer: NodeJS.Timeout | undefined
  protected closed = false
  /**
   * Why a shell that never started did not start.
   *
   * Set by a subclass whose transport refused before the shell existed; it is
   * the last moment that reason is knowable, so it is kept for the failure
   * `initialize` raises.
   */
  protected startupDetail: string | undefined

  /**
   * @param id - session id inside `ctx.terminals`.
   * @param pid - the local process id, when this session has one.
   * @param redirected - whether the shell runs somewhere other than here.
   * @param t - bound host translator for the spawn-failure copy a reader sees.
   */
  readonly failure: SshFailure | undefined = undefined

  constructor(
    readonly id: TerminalSessionId,
    pid: number,
    redirected: boolean,
    private readonly t: DshellTerminalBridgeHostTranslator,
  ) {
    this.pid = pid
    this.redirected = redirected
  }

  /** Write bytes to the shell's stdin. */
  protected abstract write(text: string): void

  /** Signal the shell's process tree. */
  protected abstract killTree(signal: NodeJS.Signals | TerminalSignal): void

  /** Resize the shell's window. */
  abstract resize(cols: number, rows: number): void

  /** End the shell without asking, for the close() fallback. */
  protected abstract hardKill(): void

  /** Capture the first prompt as the motd (dsh's startup contract). */
  async initialize(signal?: AbortSignal): Promise<void> {
    const operation = this.startSend({ text: '', submit: false })
    const result = await operation.done
    signal?.throwIfAborted()
    if (result.waitReason === 'session_exit' || result.waitReason === 'timeout') {
      // Carry the diagnostic out with the failure: this is the last moment the
      // session exists, and the output that says WHY (the transport's own
      // refusal, or the shell's stderr) is about to be discarded with it.
      // Without this a failed device session reports only "the shell exited",
      // which names neither the host nor the cause.
      const status = result.sessionStatus
      // "before its first prompt", not "during startup": this same failure is
      // what a respawn after a dropped connection produces, where nothing is
      // starting up — it is the NEW shell that never got to a prompt. The head
      // is host copy the connection panel renders, so it comes from the bound
      // translator; the exit label and the diagnostic inside it are data.
      const head = result.waitReason === 'session_exit'
        ? this.t('spawn.exitBeforePrompt', {
            exit: status.kind === 'exited' ? ` (${exitLabel(status)})` : '',
          })
        : this.t('spawn.startupTimeout')
      const detail = this.startupDetail ?? diagnosticTail(this.retained)
      throw new Error(detail === undefined ? head : this.t('spawn.withDetail', { head, detail }))
    }
    this.motd = result.viewport
  }

  startSend(request: TerminalSendRequest): TerminalSendOperation {
    if (this.closed) throw new TerminalError('PTY session is closing', 'NO_SESSION')
    if (this.statusValue.kind === 'exited') throw new TerminalError('PTY session has exited', 'NO_SESSION')
    if (this.active !== undefined) {
      throw new TerminalError('PTY session already has an active send', 'SEND_ACTIVE')
    }
    const operation = new RawSendOperation(() => {
      // Cancel = SIGINT to the foreground group, via the line discipline.
      if (this.statusValue.kind === 'running') this.write('\u0003')
    })
    this.active = operation
    const input = `${request.text}${request.submit ? '\r' : ''}`
    if (input.length > 0 && !operation.cancelRequested) {
      this.write(input)
    }
    this.scheduleSettle(operation, input.length > 0)
    return operation
  }

  read(request: TerminalReadRequest): TerminalReadResult {
    const lines = this.retained.length === 0 ? [] : this.retained.split('\n')
    const totalLines = lines.length
    const offset = request.offset ?? 0
    const count = request.count ?? 500
    if (offset >= totalLines) {
      return { text: '', totalLines, lineBegin: offset, lineEnd: offset, truncated: this.retainedTruncated }
    }
    const end = totalLines - offset
    const start = Math.max(0, end - count)
    const bounded = utf8Tail(stripAnsi(lines.slice(start, end).join('\n')), MAX_RESULT_BYTES)
    return {
      text: bounded.text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + (bounded.text.length === 0 ? 0 : bounded.text.split('\n').length),
      truncated: this.retainedTruncated || bounded.truncated,
    }
  }

  async signal(signal: TerminalSignal): Promise<TerminalSignalResult> {
    // The pty line discipline delivers SIGINT/SIGTSTP from control chars to
    // the true foreground group; other signals target the shell's group. A
    // device session has no local group, so those go to the channel instead.
    if (signal === 'SIGINT') this.write('\u0003')
    else if (signal === 'SIGTSTP') this.write('\u001a')
    else this.killTree(signal)
    return { delivered: true, targetPgid: this.pid }
  }

  status(): TerminalSessionStatus {
    return this.statusValue
  }

  async close(reason: string): Promise<void> {
    void reason
    if (this.closed) return
    this.closed = true
    if (this.statusValue.kind === 'running') {
      this.killTree('SIGTERM')
      // Give the process tree half a second to exit before the hard kill.
      await new Promise<void>((resolve) => {
        const deadline = setTimeout(resolve, 500)
        const onExit = (): void => { clearTimeout(deadline); this.exitListeners.delete(onExit); resolve() }
        this.exitListeners.add(onExit)
      })
      if (this.statusValue.kind === 'running') this.hardKill()
    } else {
      this.hardKill()
    }
  }

  onOutput(listener: (chunk: string) => void): () => void {
    this.outputListeners.add(listener)
    return () => { this.outputListeners.delete(listener) }
  }

  onExit(listener: (status: TerminalSessionStatus) => void): () => void {
    this.exitListeners.add(listener)
    if (this.statusValue.kind === 'exited') listener(this.statusValue)
    return () => { this.exitListeners.delete(listener) }
  }

  /** Latest raw output snapshot (the bridge seeds nothing from this; its buffer owns history). */
  snapshot(): string {
    return this.retained
  }

  protected onData(text: string): void {
    if (text.length === 0) return
    this.lastOutputAt = Date.now()
    this.retained += text
    this.trimRetained()
    this.trackMarker(text)
    for (const listener of [...this.outputListeners]) listener(text)
    this.active?.append(text)
  }

  /** Record the exit the transport reported, and settle anything waiting on it. */
  protected exited(status: TerminalSessionStatus): void {
    this.statusValue = status
    this.settleActive('session_exit')
    for (const listener of [...this.exitListeners]) listener(status)
  }

  private trimRetained(): void {
    for (;;) {
      if (this.retained.length === 0) return
      const lines = this.retained.split('\n')
      const overLines = lines.length > RETAINED_MAX_LINES
      const overBytes = Buffer.byteLength(this.retained) > RETAINED_MAX_BYTES
      if (!overLines && !overBytes) return
      const drop = overLines ? lines.length - RETAINED_MAX_LINES : 1
      this.retained = lines.slice(drop).join('\n')
      this.retainedTruncated = true
    }
  }

  /** Marker scan with a small carry so sequences split across chunks match. */
  private trackMarker(chunk: string): void {
    const combined = this.markerCarry + chunk
    if (combined.includes(PROMPT_MARKER)) this.markerAt = Date.now()
    this.markerCarry = combined.slice(-MARKER_CARRY_CHARS)
  }

  private scheduleSettle(operation: RawSendOperation, wroteInput: boolean): void {
    void wroteInput
    const startedAt = Date.now()
    const tick = (): void => {
      if (this.active !== operation || operation.settled || this.closed) return
      if (this.statusValue.kind === 'exited') {
        this.settleActive('session_exit')
        return
      }
      const now = Date.now()
      const quietFor = now - this.lastOutputAt
      const sinceMarker = now - this.markerAt
      // Fast path: our PROMPT_COMMAND's end-of-command marker landed and
      // the stream stayed quiet — the prompt is up and bash owns stdin.
      if (this.markerAt > 0 && sinceMarker < 1000 && quietFor >= PROMPT_QUIET_MS) {
        this.settleActive('stdin_read')
        return
      }
      if (quietFor >= SILENT_SETTLE_MS) {
        this.settleActive('inferred_idle')
        return
      }
      if (now - startedAt >= SEND_TIMEOUT_MS) {
        this.settleActive('timeout')
        return
      }
      this.settleTimer = setTimeout(tick, SETTLE_POLL_MS)
    }
    this.settleTimer = setTimeout(tick, SETTLE_POLL_MS)
  }

  private settleActive(waitReason: TerminalWaitReason): void {
    const operation = this.active
    if (operation === undefined) return
    if (this.settleTimer !== undefined) {
      clearTimeout(this.settleTimer)
      this.settleTimer = undefined
    }
    this.active = undefined
    operation.settle(waitReason, this.statusValue)
  }
}

/** The local interactive shell: a node-pty child of this process. */
class LocalRawSession extends RawSessionBase {
  private readonly pty: nodePty.IPty

  constructor(
    id: TerminalSessionId,
    cwd: string | undefined,
    cols: number,
    rows: number,
    t: DshellTerminalBridgeHostTranslator,
    plan: { argv: readonly string[]; env?: Record<string, string> | undefined },
    /**
     * A real UTF-8 locale to run under, resolved from the ambient one when
     * that is a C-family name (`shellLocale`); undefined leaves it alone.
     */
    locale: string | undefined = undefined,
  ) {
    super(id, 0, false, t)
    const [file, ...args] = plan.argv
    if (file === undefined) throw new Error('dshell PTY: spawn plan has no program')
    this.pty = nodePty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      ...(cwd === undefined || cwd === '' ? {} : { cwd }),
      env: {
        ...process.env,
        ...(locale === undefined ? {} : { LC_ALL: locale }),
        TERM: 'xterm-256color',
        ...plan.env,
      } as Record<string, string>,
    })
    ;(this as { pid: number }).pid = this.pty.pid
    this.pty.onData((data: string) => { this.onData(this.decoder.write(data)) })
    this.pty.onExit(({ exitCode, signal }) => {
      this.exited({ kind: 'exited', exitCode, signal: exitSignalName(signal) })
    })
  }

  protected write(text: string): void {
    this.pty.write(text)
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.pty.resize(cols, rows)
  }

  protected hardKill(): void {
    this.pty.kill()
  }

  protected killTree(signal: NodeJS.Signals | TerminalSignal): void {
    const pid = this.pid
    if (pid === undefined) return
    try { process.kill(-pid, signal as NodeJS.Signals) } catch { /* already gone */ }
    try { process.kill(pid, signal as NodeJS.Signals) } catch { /* already gone */ }
  }
}

/**
 * A device session's shell: a pty channel on the device's own connection.
 *
 * There is no local process and no local pid — the shell is the device's — so
 * everything the base can observe locally is answered from the channel instead:
 * its output, its exit status, its window. The connection itself is opened by
 * the plan, which is why a refusal arrives here as a rejected promise rather
 * than as a dead child: it is recorded as the startup detail and the session
 * ends, so `initialize` reports it exactly as it reports a local shell that
 * died before its first prompt.
 */
class DeviceShellSession extends RawSessionBase {
  private shell: DeviceShellHandle | undefined

  constructor(
    id: TerminalSessionId,
    cols: number,
    rows: number,
    t: DshellTerminalBridgeHostTranslator,
    private readonly plan: DeviceShellPlan,
  ) {
    super(id, 0, true, t)
    void this.open(cols, rows)
  }

  /** Open the device shell, or record why it could not be opened. */
  private async open(cols: number, rows: number): Promise<void> {
    let shell: DeviceShellHandle
    try {
      shell = await this.plan.open({ rows, cols, terminalType: 'xterm-256color' })
    } catch (error) {
      this.startupDetail = error instanceof Error ? error.message : String(error)
      // Structured, because the reader has to CHOOSE a presentation from it: a
      // refused secret and a changed host key are both fixable, and only one of
      // them is fixable by re-entering the secret.
      ;(this as { failure: SshFailure | undefined }).failure = classifyDeviceFailure(error)
      this.exited({ kind: 'exited', exitCode: null, signal: null })
      return
    }
    if (this.closed) {
      shell.close()
      return
    }
    this.shell = shell
    // A channel's bytes are Buffers, so the decoder lives here rather than in
    // the base: node-pty hands over strings that are already decoded.
    shell.stream.on('data', (chunk: Buffer) => { this.onData(this.decoder.write(chunk)) })
    shell.stream.on('error', () => undefined)
    void shell.done.then((outcome) => {
      this.exited({
        kind: 'exited',
        exitCode: outcome.exitCode,
        signal: outcome.signal as NodeJS.Signals | null,
      })
    })
  }

  protected write(text: string): void {
    this.shell?.stream.write(text)
  }

  resize(cols: number, rows: number): void {
    this.shell?.setWindow(rows, cols)
  }

  protected hardKill(): void {
    this.shell?.close()
  }

  protected killTree(_signal: NodeJS.Signals | TerminalSignal): void {
    // There is no local tree to signal. The channel close below is what the
    // device reads as the session going away, and sshd hangs up the shell's
    // process group for it — the same outcome a local kill produced.
    this.shell?.close()
  }
}

/**
 * Backend providing raw dshell main-shell sessions.
 *
 * The type is `shell` — the name dsh's persistent shell tools resolve by
 * default (`backendType` defaults to `'shell'`) — so a composition whose
 * persistent shell group sits OUTSIDE an `isolate: terminals` realm resolves
 * this backend, and the bridge's claim hook then owns its spawns as the
 * agent's watched terminal. Stock presets isolate the realm (their backend is
 * their own, deliberately invisible to the host), which is respected here
 * rather than worked around.
 */
export class DshellPtyBackend implements TerminalBackend {
  readonly type = 'shell'

  private readonly sessions = new Map<TerminalSessionId, DshellPtySession>()
  private disposed = false

  constructor(
    private readonly cols: number,
    private readonly rows: number,
    /** Bound host translator for the spawn-failure copy a reader sees. */
    private readonly t: DshellTerminalBridgeHostTranslator,
    /** Optional redirect: a session whose cwd is a device mount gets that device's shell. */
    private readonly planFor: PtySpawnPlanResolver | undefined = undefined,
    /**
     * Optional claim hook for spawns dshell did not issue itself. Bridge
     * spawns always carry a name (`main` / `agent`); an unnamed spawn through
     * this backend — dsh's persistent-bash pointed here via `backendType`, or
     * a `terminal_open` — is another party creating the agent's shell inside
     * dshell's world, and the bridge is told so it can attach the agent
     * stream (status card, watch panel) to it instead of leaving it invisible.
     */
    private readonly onForeign: ((owner: unknown, sessionId: TerminalSessionId) => void) | undefined = undefined,
  ) {}

  /** The rich handle for a session this backend spawned (bridge wiring). */
  session(id: TerminalSessionId): DshellPtySession | undefined {
    return this.sessions.get(id)
  }

  async spawn(spec: TerminalBackendSpawnSpec): Promise<TerminalBackendSession> {
    if (this.disposed) throw new TerminalError('dshell PTY backend is disposing', 'NO_SESSION')
    spec.signal?.throwIfAborted()
    // Awaited: a device session's assignment can still be in flight while the
    // terminal attaches, and the resolver is allowed to wait for it.
    const plan = await this.planFor?.({
      sessionId: spec.owner?.id === undefined ? undefined : String(spec.owner.id),
      cwd: spec.cwd,
    })
    // Checked against the RESOLVED plan, so a device session — whose shell is
    // the device's — is never refused for being on a Windows host.
    if (plan === undefined && !LOCAL_SHELL_SUPPORTED) {
      throw new TerminalError(LOCAL_SHELL_UNSUPPORTED_REASON, 'NO_SESSION')
    }
    const session = plan === undefined
      ? new LocalRawSession(
        spec.sessionId as TerminalSessionId,
        spec.cwd,
        this.cols,
        this.rows,
        this.t,
        LOCAL_SHELL,
        await shellLocale(),
      )
      : new DeviceShellSession(spec.sessionId as TerminalSessionId, this.cols, this.rows, this.t, plan)
    this.sessions.set(spec.sessionId as TerminalSessionId, session)
    // Unnamed spawns are other plugins creating shells in dshell's world; the
    // bridge may want to claim them as the agent's shell. Fired after the
    // session is registered so the claimant can look it up immediately.
    if (spec.name === undefined) {
      this.onForeign?.(spec.owner, session.id as TerminalSessionId)
    }
    try {
      await session.initialize(spec.signal)
      return session
    } catch (error) {
      this.sessions.delete(session.id)
      await session.close('dshell PTY startup failed').catch(() => {})
      throw error
    }
  }

  /** Release every session's pty (service teardown). */
  dispose(): void {
    this.disposed = true
    for (const session of this.sessions.values()) {
      void session.close('dshell PTY backend disposed').catch(() => {})
    }
    this.sessions.clear()
  }
}
