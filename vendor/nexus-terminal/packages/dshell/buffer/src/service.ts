/**
 * The buffer service: links, deferred requests, scoped grants, and the
 * watchdog that guarantees a requester is always woken.
 *
 * The shape of this feature is dictated by one dsh constraint: **a turn cannot
 * be suspended and resumed.** So "wait for the other agent" cannot be a blocked
 * tool call. Instead a delegation is a durable ticket plus a message; the
 * requester's turn ends naturally, and when the ticket settles the buffer
 * delivers a new message that reopens the requester's turn — the same
 * completion-delivery policy dsh's own job registry uses.
 *
 * Everything that can leave a requester stranded is closed here:
 *  - an unsettled ticket past its deadline is settled as `timeout` by the
 *    watchdog, and the requester is still woken;
 *  - a worker session that is disposed settles its running tickets as `failed`;
 *  - a cancelled ticket wakes the requester immediately;
 *  - every settlement path releases the ticket's grants, so a grant cannot
 *    outlive the work it was issued for.
 *
 * Grants are enforced by the tool that fronts this service, not by a seam:
 * the tool is the only door, so one check covers every access.
 */

import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
// Type-only: pulls the session-controller service merge (`ctx.sessionController`).
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'

// rc.2 dropped the catch-all `plugin` kind: a plugin-sourced message declares
// its own member of the merge-extensible source map.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dshell-buffer': { kind: 'dshell-buffer'; plugin: string; form: 'notice'; summary: string }
  }
}
// Type-only: pulls the shell service merge (`ctx.shell`), the byte-transport
// seam a cross-world transfer writes through.
import type {} from '@deepseek-ai/dsh-shell'
// Type-only: pulls the sandbox-policy service merge, so a granted write can be
// authorized against the GRANTER's own mode instead of the fail-safe default.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { Feasibility, type DeviceRoutingSeat } from './feasibility.js'
import type { DshellBufferHostTranslate } from './host-locales.js'
import { DEVICE_FS_SERVICE, type DeviceFsSeat } from '@nexus-aethra/dshell-std'
import {
  sessionLabel, renderRequestNotice, renderSettlementNotice, requestSummary, settlementSummary,
} from './notice.js'
import { isUnder, splitBufferPath } from './paths.js'
import type { PipeLine } from './prompt.js'
import {
  BUFFER_PLUGIN,
  SETTLED_STATES,
  type BufferArea,
  type BufferGrant,
  type BufferLink,
  type BufferListing,
  type BufferRight,
  type BufferState,
  type BufferTicket,
  type BufferTicketState,
  type BufferTransfer,
  type BufferUserEntry,
} from './protocol.js'
import { readDocument, writeDocument } from './store.js'

/** How long a ticket may stay unsettled before the watchdog settles it. */
export const DEFAULT_DEADLINE_MS = 10 * 60_000
/** Shortest deadline a caller may ask for; below this the watchdog races the worker. */
export const MIN_DEADLINE_MS = 30_000
/** Longest deadline a caller may ask for. */
export const MAX_DEADLINE_MS = 2 * 60 * 60_000
/** How often the watchdog looks for expired tickets. */
const WATCHDOG_INTERVAL_MS = 15_000
/** Bytes one transfer moves when the caller names no ceiling. */
export const DEFAULT_TRANSFER_BYTES = 8 * 1024 * 1024
/** Hard ceiling on one INLINE transfer: the payload rides stdin as base64. */
export const MAX_TRANSFER_BYTES = 32 * 1024 * 1024
/** Files above this size take the chunked path instead of one inline move. */
export const CHUNK_THRESHOLD_BYTES = MAX_TRANSFER_BYTES
/** Byte size of one relayed chunk: a read plus one base64 stdin write. */
export const CHUNK_BYTES = 16 * 1024 * 1024
/** Default ceiling for a chunked transfer's WHOLE size. */
export const DEFAULT_BIG_BYTES = 1024 * 1024 * 1024
/** Hard ceiling on a chunked transfer's whole size. */
export const MAX_BIG_BYTES = 4 * 1024 * 1024 * 1024

/** Entries one browser listing returns before it is reported truncated. */
const MAX_USER_ENTRIES = 1000
/** How long a settled transfer stays in the snapshot for progress surfaces. */
const TRANSFER_TAIL_MS = 15_000
/**
 * How long a session's hiding stays memory-only before the pipes are settled
 * for good. `session/disposed` fires at host shutdown too, and a shutdown must
 * never persist "every in-flight ticket failed"; twenty seconds separates a
 * reader's deletion from a process that is on its way out.
 */
const HIDE_GRACE_MS = 20_000

/** What one cross-world copy moved, and between which paths. */
export interface TransferOutcome {
  readonly bytes: number
  /** The source's path, as its own world spells it. */
  readonly source: string
  /** The destination's path, as its own world spells it. */
  readonly destination: string
  /** Chunked transfers only: how many relayed slices made the file. */
  readonly chunks?: number | undefined
}

/** One inline grant a delegation asks to create. */
export interface GrantRequest {
  readonly description: string
  readonly areas: readonly BufferArea[]
}

/** What a delegation carries. */
export interface DelegateInput {
  /** Target session; required unless `linkId` names the link. */
  readonly to?: string | undefined
  /** The link to send over; when omitted the service finds one between the pair. */
  readonly linkId?: string | undefined
  readonly subject: string
  readonly detail?: string | undefined
  /**
   * Areas to open to the target. An area already covered by a live grant of
   * this same pair is REUSED (its reference count rises) instead of being
   * granted twice, so repeating a delegation needs no id to point at.
   */
  readonly grants?: readonly GrantRequest[] | undefined
  readonly deadlineMs?: number | undefined
}

/** The mapping name an area takes when the caller names none: its own basename. */
function derivedMappingName(rawPath: string): string {
  const trimmed = rawPath.replace(/\/+$/u, '')
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  const cleaned = base.replace(/[\\/\0]/gu, '').replace(/^\.+$/u, '')
  return cleaned.length > 0 ? cleaned : 'mapped'
}

/** Whether a name is a single path segment, which is all a mapping name may be. */
function validMappingName(name: string): boolean {
  return name.length > 0 && !/[\\/\0]/u.test(name) && name !== '.' && name !== '..'
}

/** Whether two rights lists mean the same thing. */
function sameRights(a: readonly BufferRight[], b: readonly BufferRight[]): boolean {
  return a.length === b.length && a.every(right => b.includes(right))
}

/** The outcome of an admitted delegation. */
export interface DelegateOutcome {
  readonly ticket: BufferTicket
  /** The target agent's status at admission — `running` means the request queued. */
  readonly targetStatus: AgentStatus
  readonly grants: readonly BufferGrant[]
}

/** A ticket plus the grant operations a holder may perform on it. */
export interface GrantsForResult {
  readonly grants: readonly BufferGrant[]
}

export class BufferService {
  /** dshell-ssh's router when composed; read for where a peer runs. */
  private readonly routing: DeviceRoutingSeat | undefined
  /** dshell-ssh's byte-level device ops seat when composed; absent means the host-process paths. */
  private readonly deviceFs: DeviceFsSeat | undefined
  private links: BufferLink[] = []
  private tickets: BufferTicket[] = []
  private grants: BufferGrant[] = []
  /** Chunked transfers in flight (and the freshly settled), for progress UI. */
  private readonly transfers = new Map<string, BufferTransfer>()
  /**
   * Sessions deleted from dshell that dsh still lists until the next start (see
   * `detachSession`). Memory only: after a restart their logs are purged during
   * composition and dsh stops naming them, so there is nothing left to hide.
   */
  private readonly departed = new Set<string>()
  /** Sessions whose hiding is waiting out the grace before it is settled. */
  private readonly hides = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly feasibility: Feasibility
  /**
   * A context carrying `subprocess`, for the device probe only.
   *
   * The router the probe calls spawns `ssh` through that seam, and cordis
   * refuses a property the calling context did not inject — so the buffer
   * resolves a dedicated scope instead of making `subprocess` a hard
   * dependency of the whole plugin (a composition without dshell-ssh never
   * probes anything).
   */
  private probeCtx: Context | undefined
  /** Serializes persistence so two mutations cannot interleave a write. */
  private saveChain: Promise<void> = Promise.resolve()
  private watchdog: ReturnType<typeof setInterval> | undefined
  private disposed = false

  /**
   * @param ctx - the plugin's context, inside the injection that guarantees
   *   every service this one reads.
   * @param t - this package's host copy, bound to the language the user's
   *   screen is in. Read at call time by the notices and the refusals a panel
   *   action can trigger, so a language switch reaches the next one without a
   *   restart (see `index.ts`).
   */
  constructor(private readonly ctx: Context, private readonly t: DshellBufferHostTranslate) {
    const document = readDocument()
    this.links = [...document.links]
    this.tickets = [...document.tickets]
    this.grants = [...document.grants]
    // Before anyone can address a path: name every live area that predates the
    // mapping (see migrateMappings). Persisted right away, so the migration is
    // a one-time step rather than a per-boot rewrite.
    if (this.migrateMappings()) void this.save()
    // Structural, optional: a composition without dshell-ssh has no device to
    // probe, and this package must not depend on that bundle.
    const routing = this.ctx.get('dshellSshRouting') as unknown as DeviceRoutingSeat | undefined
    this.routing = routing
    // Same for the byte-level device ops seat (M3b); a composition without
    // dshell-ssh reports `undefined`, and the relay falls back to the same
    // in-process path it always used.
    this.deviceFs = this.ctx.get(DEVICE_FS_SERVICE) as unknown as DeviceFsSeat | undefined
    this.feasibility = new Feasibility(this.ctx, routing)
    this.ctx.inject(['subprocess'], (probeCtx) => { this.probeCtx = probeCtx })
  }

  // ---------------------------------------------------------------- lifecycle

  /** Start the watchdog and subscribe to worker disappearance. */
  start(): void {
    if (this.watchdog !== undefined) return
    this.watchdog = setInterval(() => { void this.sweep() }, WATCHDOG_INTERVAL_MS)
    this.watchdog.unref?.()
    this.ctx.on('agent/disposed', ({ agent }) => { void this.onAgentDisposed(String(agent.id)) })
    // dsh disposes a Session both when the reader deletes it and when the host
    // goes down, and only the first orphans anything. The hiding is therefore
    // immediate and memory-only, while the settlement waits out the grace: a
    // shutdown never lives that long, a deletion does. Whatever the grace
    // missed — a deletion inside a restart's blind window, state written
    // before this path existed — the boot reconciliation settles.
    this.ctx.on('session/disposed', (session: { id: SessionId }) => { this.hideSession(String(session.id)) })
    void this.reconcile()
  }

  /** Stop the watchdog. State stays on disk for the next start. */
  dispose(): void {
    this.disposed = true
    if (this.watchdog !== undefined) {
      clearInterval(this.watchdog)
      this.watchdog = undefined
    }
  }

  // ------------------------------------------------------------------- reads

  /** The whole state, for the pipe UI and the tool's listings. */
  snapshot(): BufferState {
    return {
      links: [...this.links],
      tickets: [...this.tickets],
      grants: [...this.grants],
      transfers: [...this.transfers.values()],
      departed: [...this.departed],
      worlds: this.worlds(),
    }
  }

  /**
   * Where each pipe endpoint stands, in its own world's spelling.
   *
   * A bound session's header cwd is the directory it was created in on this
   * machine — the mount's stand-in — while its shell and file tools answer
   * from the device. Labeling the peer with the stand-in reads as "this pipe
   * ends in /home/reader" for a peer that lives elsewhere, so the panel takes
   * the device root the assignment names (the same knowledge `promptPipes`
   * already puts in the agent-facing lines) and falls back to the cwd only
   * where no binding exists.
   */
  private worlds(): Record<string, string> {
    const worlds: Record<string, string> = {}
    for (const link of this.links) {
      for (const sessionId of [link.a, link.b]) {
        if (sessionId in worlds) continue
        const assignment = this.routing?.assignmentForSession?.(sessionId)
        if (assignment === undefined) continue
        const named = assignment.remoteRoot?.trim() ?? ''
        const root = named.length > 0 && named !== '~'
          ? named
          : this.routing?.deviceFor?.(assignment.deviceId)?.remoteRoot?.trim() ?? named
        if (root.length > 0) worlds[sessionId] = root
      }
    }
    return worlds
  }

  /**
   * This session's live pipes, for the standing prompt: the model should not
   * have to probe to learn that a pipe exists, nor guess whether a peer is the
   * machine the user just named. A peer with no device binding is this machine;
   * one with a binding names its device and the directory it runs in.
   */
  promptPipes(sessionId: string): readonly PipeLine[] {
    return this.linksFor(sessionId).map(link => {
      const peer = this.peerOf(link, sessionId)
      const target = this.routing?.targetForSession(peer)
      const device = target === undefined ? undefined : target.device
      const where = device === undefined
        ? '运行在本机'
        : `运行在设备「${device.name ?? device.id}」`
          + (target?.remoteRoot === undefined ? '' : `，工作目录 ${target.remoteRoot}`)
      return { linkId: link.id, peer: this.labelOf(peer), where, purpose: link.description }
    })
  }

  /** Links one session is an end of. */
  linksFor(sessionId: string): readonly BufferLink[] {
    return this.links.filter(link => link.a === sessionId || link.b === sessionId)
  }

  /** The grants the caller currently holds: live, referenced, not revoked. */
  private heldGrants(callerId: string): readonly BufferGrant[] {
    return this.grants.filter(grant =>
      grant.to === callerId && grant.revokedAt === undefined && grant.count > 0)
  }

  /**
   * Resolve a buffer path — `mappedName/rest` — against the grants the caller
   * holds. The mapped name selects the grant and area; the rest is the
   * area-relative path the authorize path already understands. Ambiguity (the
   * same name mapped on two pipes) is refused rather than guessed.
   *
   * The split itself lives in {@link splitBufferPath}, which guarantees the
   * rest is relative: stripping the name must consume the separator too, or
   * `/name/file` reaches the containment test as the absolute `/file` and every
   * subpath under a mapped directory is refused as a path escape.
   */
  resolveBufferPath(callerId: string, bufferPath: string): { grantId: string; path: string } {
    const address = splitBufferPath(bufferPath)
    if (address === undefined) throw new Error('缓冲区根 `/` 下没有文件，映射目录挂在其下一层；用 action=ls 查看缓冲区结构')
    const { name, rest } = address
    const matches: { grantId: string }[] = []
    for (const grant of this.heldGrants(callerId)) {
      for (const area of grant.areas) {
        if (area.as !== undefined && area.as === name) matches.push({ grantId: grant.id })
      }
    }
    if (matches.length === 0) {
      throw new Error(`缓冲区里没有映射「${name}」；用 action=ls 查看当前缓冲区结构`)
    }
    if (matches.length > 1) {
      throw new Error(`「${name}」这个映射名在本会话的缓冲区里出现了多次；请让用户整理对应管道的授权`)
    }
    return { grantId: matches[0].grantId, path: rest.length === 0 ? '.' : rest }
  }

  /** The buffer namespace roots the caller holds: mapped areas, rights, origin. */
  bufferTree(callerId: string): string {
    const lines: string[] = []
    for (const grant of this.heldGrants(callerId)) {
      for (const area of grant.areas) {
        if (area.as === undefined) continue
        const rights = area.rights.includes('write') ? '读写' : '只读'
        lines.push(`/${area.as}  ← ${this.labelOf(grant.from)} 的 ${area.path}（${rights}）`)
      }
    }
    if (lines.length === 0) {
      return '当前缓冲区为空：根 `/` 下还没有映射。委派任务时在 grants 的 areas 里给出目录或文件，对方就能按映射路径取用它们。'
    }
    return `缓冲区结构（缓冲路径 → 真实来源；根为 \`/\`）：\n${lines.join('\n')}`
      + '\n映射的是文件就直接用 /名字；映射的是目录，它的内容在 /名字/… 下面；用 ls 逐个确认。'
  }

  /** Tickets one session is an end of. */
  ticketsFor(sessionId: string, direction: 'in' | 'out' | 'both'): readonly BufferTicket[] {
    return this.tickets.filter(ticket =>
      direction === 'in' ? ticket.to === sessionId
        : direction === 'out' ? ticket.from === sessionId
          : ticket.from === sessionId || ticket.to === sessionId)
  }

  /** Grants addressed TO a session — the ones it may exercise. */
  grantsFor(sessionId: string): readonly BufferGrant[] {
    return this.grants.filter(grant => grant.to === sessionId && grant.revokedAt === undefined)
  }

  /** Grants a session ISSUED. */
  grantsIssuedBy(sessionId: string): readonly BufferGrant[] {
    return this.grants.filter(grant => grant.from === sessionId)
  }

  /** The other end of a link, from one side. */
  peerOf(link: BufferLink, sessionId: string): string {
    return link.a === sessionId ? link.b : link.a
  }

  /** A readable label for a session, for message text and tool output. */
  label(sessionId: string): string {
    return this.labelOf(sessionId)
  }

  // ------------------------------------------------------ user-facing changes

  /** Connect two sessions. Called by the pipe UI; no tool exposes this. */
  async createLink(a: string, b: string, label?: string, description?: string): Promise<BufferLink> {
    if (a === b) throw new Error(this.t('error.linkSelf'))
    await this.requireTerminals(a, b)
    const existing = this.links.find(link =>
      (link.a === a && link.b === b) || (link.a === b && link.b === a))
    if (existing !== undefined) throw new Error(this.t('error.linkExists'))
    const link: BufferLink = {
      id: newId('link'),
      a, b,
      ...text(label) === undefined ? {} : { label: text(label) as string },
      ...text(description) === undefined ? {} : { description: text(description) as string },
      createdAt: Date.now(),
    }
    this.links.push(link)
    await this.save()
    return link
  }

  /**
   * Refuse a pipe whose ends are not both dshell terminal sessions.
   *
   * The pipe feature serves terminal sessions: those are the sessions a reader
   * works in — a shell, or an agent on a device — and wiring a plain dsh
   * conversation to something reads as an offer the rest of dshell cannot keep
   * (the file pane, the device routing and the section all key off that
   * identity). Enforced here rather than in the panel because the panel is a
   * filter a route call walks around.
   *
   * Read structurally: a composition without dshell-mode has no such registry,
   * and then nothing can tell — the check is skipped rather than refusing
   * every pipe. The registry's own load is awaited first, because an unloaded
   * table knows no session and would refuse a legitimate one.
   */
  private async requireTerminals(a: string, b: string): Promise<void> {
    const registry = this.ctx.get('dshellTerminalMode') as unknown as {
      load?(): Promise<void>
      isOn(sessionId: string): boolean
    } | undefined
    if (registry === undefined) return
    await registry.load?.()
    for (const [id, other] of [[a, b], [b, a]] as const) {
      if (!registry.isOn(id)) {
        throw new Error(this.t('error.notTerminal', { id, peer: this.labelOf(other) }))
      }
    }
  }

  /**
   * Name a pipe, say what it is for, or clear either.
   *
   * Both ends may write: this is the pair's shared note about their own
   * relationship, and the point is that the peer's model reads it before
   * deciding whether a request belongs there. `by` is the session doing the
   * writing — a tool call passes its calling session, and the panel passes
   * nothing, which is what makes "the user wrote this" distinguishable from
   * "an agent wrote this" in the panel.
   *
   * A field given as an empty (or whitespace-only) string is CLEARED, not
   * stored blank, because every reader treats absent and empty alike and a
   * stored blank would only make the document noisier.
   *
   * @param linkId - the pipe to annotate.
   * @param note - the fields to write; an omitted field is left alone.
   * @param by - the writing session when an agent writes; absent for the user.
   * @returns the updated link.
   */
  async annotateLink(
    linkId: string,
    note: { readonly label?: string | undefined; readonly description?: string | undefined },
    by?: string,
  ): Promise<BufferLink> {
    const link = this.links.find(candidate => candidate.id === linkId)
    if (link === undefined) throw new Error(this.t('error.unknownLink', { id: linkId }))
    if (by !== undefined && link.a !== by && link.b !== by) {
      throw new Error(this.t('error.notAnEndpoint', { id: linkId }))
    }
    const updated: BufferLink = {
      ...link,
      ...note.label === undefined ? {} : text(note.label) === undefined
        ? { label: undefined }
        : { label: text(note.label) as string },
      ...note.description === undefined ? {} : text(note.description) === undefined
        ? { description: undefined }
        : { description: text(note.description) as string },
      ...by === undefined ? { annotatedBy: undefined } : { annotatedBy: by },
    }
    this.links = this.links.map(candidate => candidate.id === linkId ? updated : candidate)
    await this.save()
    return updated
  }

  /** Remove a link. Outstanding tickets keep running; no new delegation may use it. */
  async removeLink(linkId: string): Promise<void> {
    const at = this.links.findIndex(link => link.id === linkId)
    if (at < 0) throw new Error(this.t('error.noLink', { id: linkId }))
    this.links.splice(at, 1)
    await this.save()
  }

  /**
   * Revoke a grant immediately, whoever issued it.
   *
   * This is the manual escape hatch next to the reference count: a grant the
   * user no longer wants can be dropped without waiting for its tickets, and
   * the tool's check reads `revokedAt`, so the door closes at once.
   */
  async revokeGrant(grantId: string): Promise<void> {
    const grant = this.requireGrant(grantId)
    if (grant.revokedAt !== undefined) return
    grant.revokedAt = Date.now()
    grant.count = 0
    await this.save()
  }

  // ------------------------------------------------------------------ detach

  /**
   * One session's disposal, as dsh reports it: hide it from the pipe UI at
   * once, and settle its pipes once the disposal has outlived the grace.
   *
   * The split is the whole point. `session/disposed` is also how a host
   * shutdown says goodbye to every loaded session, and settling on that would
   * persist "every in-flight ticket failed" on each restart; only a disposal
   * that outlives the grace is a deletion.
   *
   * @param sessionId - the disposed session.
   */
  private hideSession(sessionId: string): void {
    this.departed.add(sessionId)
    if (this.disposed || this.hides.has(sessionId)) return
    const timer = setTimeout(() => {
      this.hides.delete(sessionId)
      void this.detachSession(sessionId)
    }, HIDE_GRACE_MS)
    timer.unref?.()
    this.hides.set(sessionId, timer)
  }

  /**
   * Settle the pipes of every session dsh's catalog no longer lists.
   *
   * Covers what the grace path never saw: a deletion that landed inside a
   * restart's blind window, and state written before that path existed. The
   * catalog is the same cold listing dsh's own sidebar is built from, so a
   * session merely not opened since the last start is still in it and is left
   * alone; a catalog that is absent or throws is an unanswered question and
   * changes nothing.
   */
  async reconcile(): Promise<void> {
    const query = this.ctx.get('sessionQuery') as unknown as {
      listSessions(signal?: AbortSignal): Promise<readonly { header: { id: string } }[]>
    } | undefined
    if (query === undefined) return
    let known: Set<string>
    try {
      known = new Set((await query.listSessions()).map(record => record.header.id))
    } catch {
      return
    }
    const referenced = new Set<string>()
    for (const link of this.links) { referenced.add(link.a); referenced.add(link.b) }
    for (const ticket of this.tickets) { referenced.add(ticket.from); referenced.add(ticket.to) }
    for (const grant of this.grants) { referenced.add(grant.from); referenced.add(grant.to) }
    for (const sessionId of referenced) {
      if (!known.has(sessionId) && !this.hides.has(sessionId)) await this.detachSession(sessionId)
    }
  }

  /**
   * A session is gone: settle every unsettled ticket it participates in,
   * revoke every grant it holds or issued, drop its pipes, and remember that
   * the pipe UI must not draw it any more.
   *
   * Two callers, neither of them the deletion route itself: {@link hideSession}
   * once a disposal has survived the grace, and {@link reconcile} for whatever
   * the grace never saw. {@link onAgentDisposed} covers the narrower case of
   * tickets whose agent disappeared mid-flight.
   *
   * The id is remembered because dsh still lists it: a deleted-but-loaded
   * session stays in `ctx.sessions` until the next start (dsh cannot tear one
   * down), so a UI that draws a node per listed session would keep an orphan
   * node whose pipes are already gone.
   */
  async detachSession(sessionId: string): Promise<void> {
    if (this.disposed) return
    this.departed.add(sessionId)
    const live = this.tickets.filter(ticket =>
      (ticket.from === sessionId || ticket.to === sessionId)
      && !SETTLED_STATES.includes(ticket.state))
    for (const ticket of live) {
      await this.settle(
        ticket,
        ticket.from === sessionId ? 'cancelled' : 'failed',
        undefined,
        ticket.from === sessionId
          ? `发起会话 ${short(sessionId)} 已删除`
          : `承接会话 ${short(sessionId)} 已删除`,
      )
    }
    let changed = false
    for (const grant of this.grants) {
      if ((grant.from === sessionId || grant.to === sessionId) && grant.revokedAt === undefined) {
        grant.revokedAt = Date.now()
        grant.count = 0
        changed = true
      }
    }
    const linksBefore = this.links.length
    this.links = this.links.filter(link => link.a !== sessionId && link.b !== sessionId)
    if (changed || this.links.length !== linksBefore) await this.save()
  }

  /**
   * Undo {@link hideSession}'s hiding when the deletion is cancelled.
   *
   * Within the grace this also withdraws the pending settlement, so a
   * cancelled deletion leaves the session's pipes exactly as they were; after
   * the grace the pipes are already cut and re-linking is a new gesture.
   *
   * @param sessionId - the session whose scheduled deletion was cancelled.
   */
  restoreSession(sessionId: string): void {
    this.departed.delete(sessionId)
    const timer = this.hides.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.hides.delete(sessionId)
    }
  }

  // -------------------------------------------------------------- delegation

  /**
   * Admit one deferred request.
   *
   * The pre-flight runs first and its refusal is the tool's error: a target
   * that cannot take the work is reported now rather than discovered by a
   * watchdog ten minutes later.
   *
   * @param callerId - the requesting session, from the tool's calling agent.
   * @param input - what to ask and what to expose.
   * @returns the ticket, the target's status at admission, and the grants held.
   */
  async delegate(callerId: string, input: DelegateInput): Promise<DelegateOutcome> {
    const subject = input.subject.trim()
    if (subject.length === 0) throw new Error('subject 不能为空')
    const link = this.resolveLink(callerId, input)
    const targetId = this.peerOf(link, callerId)

    const feasible = await this.feasibility.resolveTarget(targetId, this.probeCtx)
    if (!feasible.ok) throw new Error(feasible.reason)

    const deadlineMs = clampDeadline(input.deadlineMs)
    // Grants: an area this pair already covers is REUSED rather than granted
    // twice — that is what the buffer path is for, and it is why no id ever
    // needs to travel: repeating a delegation re-holds the same authorization.
    const taken = this.mappingNamesFor(targetId)
    const held: BufferGrant[] = []
    const reused = new Set<string>()
    for (const request of input.grants ?? []) {
      const fresh: BufferArea[] = []
      for (const area of request.areas) {
        const existing = this.reusableGrant(callerId, targetId, area)
        if (existing !== undefined) {
          if (!reused.has(existing.id)) {
            existing.count += 1
            reused.add(existing.id)
          }
          if (!held.includes(existing)) held.push(existing)
          continue
        }
        fresh.push(area)
      }
      if (fresh.length > 0) {
        held.push(this.newGrant(callerId, targetId, { description: request.description, areas: fresh }, taken))
      }
    }
    const ticket: BufferTicket = {
      id: newId('ticket'),
      linkId: link.id,
      from: callerId,
      to: targetId,
      subject,
      ...input.detail === undefined || input.detail.trim().length === 0 ? {} : { detail: input.detail.trim() },
      state: 'queued',
      grantIds: held.map(grant => grant.id),
      createdAt: Date.now(),
      deadlineAt: Date.now() + deadlineMs,
      reports: [],
    }
    this.tickets.push(ticket)
    await this.save()

    // Deliver LAST: a delivery failure must not lose the ticket, and the
    // requester needs the ticket id even if the target cannot be reached.
    const text = renderRequestNotice(this.t, ticket, this.labelOf(callerId), held)
    const delivered = await this.deliver(targetId, text, requestSummary(this.t, ticket, this.labelOf(callerId)))
    if (!delivered.ok) {
      await this.settle(ticket, 'failed', undefined, `投递失败：${delivered.reason}`)
      throw new Error(delivered.reason)
    }
    return { ticket, targetStatus: feasible.status, grants: held }
  }

  /** Cancel an outstanding ticket. Either end may do it. */
  async cancel(ticketId: string, callerId: string): Promise<void> {
    const ticket = this.requireTicket(ticketId)
    if (ticket.from !== callerId && ticket.to !== callerId) {
      throw new Error(`ticket ${ticketId} 与本会话无关`)
    }
    if (SETTLED_STATES.includes(ticket.state)) return
    await this.settle(ticket, 'cancelled', undefined, `由 ${short(callerId)} 取消`)
  }

  /**
   * Cancel an outstanding ticket on the user's authority.
   *
   * The pipe UI is not a session, so it cannot be an end of the ticket; the
   * user is the one who created the link and may always withdraw the work it
   * carries.
   */
  async cancelByUser(ticketId: string): Promise<void> {
    const ticket = this.requireTicket(ticketId)
    if (SETTLED_STATES.includes(ticket.state)) return
    await this.settle(ticket, 'cancelled', undefined, '由用户取消')
  }

  // ------------------------------------------------------------------ worker

  /** Mark a ticket as being worked on. */
  async claim(ticketId: string, callerId: string): Promise<void> {
    const ticket = this.requireWorkerTicket(ticketId, callerId)
    if (ticket.state === 'running') return
    if (ticket.state !== 'queued') throw new Error(`ticket ${ticketId} 已结算（${ticket.state}）`)
    ticket.state = 'running'
    ticket.startedAt = Date.now()
    await this.save()
  }

  /** File a progress (or blocked) report the requester can see. */
  async report(ticketId: string, callerId: string, text: string, blocked: boolean): Promise<void> {
    const ticket = this.requireWorkerTicket(ticketId, callerId)
    if (ticket.state !== 'queued' && ticket.state !== 'running') {
      throw new Error(`ticket ${ticketId} 已结算（${ticket.state}）`)
    }
    if (ticket.state === 'queued') {
      ticket.state = 'running'
      ticket.startedAt = Date.now()
    }
    ticket.reports.push({ time: Date.now(), text: text.trim(), kind: blocked ? 'blocked' : 'progress' })
    await this.save()
  }

  /** Settle a ticket as done, with the worker's result. */
  async finish(ticketId: string, callerId: string, result: string): Promise<void> {
    await this.settleWorker(ticketId, callerId, 'done', result, undefined)
  }

  /** Settle a ticket as failed, with the worker's reason. */
  async fail(ticketId: string, callerId: string, error: string): Promise<void> {
    await this.settleWorker(ticketId, callerId, 'failed', undefined, error)
  }

  private async settleWorker(
    ticketId: string,
    callerId: string,
    state: 'done' | 'failed',
    result: string | undefined,
    error: string | undefined,
  ): Promise<void> {
    const ticket = this.requireWorkerTicket(ticketId, callerId)
    if (SETTLED_STATES.includes(ticket.state)) {
      throw new Error(`ticket ${ticketId} 已结算（${ticket.state}）`)
    }
    await this.settle(ticket, state, result, error)
  }

  // ----------------------------------------------------------- granted files

  /**
   * Read a file inside a granted area, as the granter. Text only — binary
   * content has no line semantics, use download for it. `offset` is a 1-based
   * line number; `limit` caps the returned lines, so a huge file pages.
   */
  async readGranted(
    callerId: string,
    grantId: string,
    path: string,
    options?: { readonly offset?: number | undefined; readonly limit?: number | undefined },
    signal?: AbortSignal,
  ): Promise<string> {
    const access = await this.authorize(callerId, grantId, path, 'read', signal)
    const body = await this.ctx.agents.withInitiator(
      access.granter,
      () => this.ctx.fs.readText(access.target, signal),
    )
    const offset = Math.max(1, options?.offset ?? 1)
    const limit = options?.limit
    if (offset === 1 && limit === undefined) return body
    const lines = body.split('\n')
    const start = Math.min(offset, Math.max(1, lines.length)) - 1
    const slice = limit === undefined ? lines.slice(start) : lines.slice(start, start + limit)
    const head = `共 ${String(lines.length)} 行 · 显示 ${String(start + 1)}-${String(start + slice.length)} 行`
    return `${head}\n${slice.map((text, index) => `${String(start + index + 1)}| ${text}`).join('\n')}`
  }

  /**
   * Replace strings inside a granted file, in the granter's world, in place —
   * no whole-file round trip through the model. `old_string` must appear at
   * least once and, without `replaceAll`, exactly once.
   */
  async editGranted(
    callerId: string,
    grantId: string,
    path: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
    signal?: AbortSignal,
  ): Promise<{ replacements: number; fromLength: number; toLength: number }> {
    if (oldString.length === 0) throw new Error('old_string 不能为空')
    const access = await this.authorize(callerId, grantId, path, 'write', signal)
    const body = await this.ctx.agents.withInitiator(
      access.granter,
      () => this.ctx.fs.readText(access.target, signal),
    )
    const count = body.split(oldString).length - 1
    if (count === 0) throw new Error('old_string 在文件中没有出现，编辑拒绝')
    if (!replaceAll && count > 1) {
      throw new Error(`old_string 出现了 ${String(count)} 次；补充更多上下文使其唯一，或改用 replace_all`)
    }
    const next = replaceAll ? body.split(oldString).join(newString) : body.replace(oldString, newString)
    const policy = this.ctx.get('sandboxPolicy')?.resolve({ session: access.granter.session })
    await this.ctx.agents.withInitiator(
      access.granter,
      () => this.ctx.fs.writeText(access.target, next, undefined, signal, policy),
    )
    return { replacements: count, fromLength: oldString.length, toLength: newString.length }
  }

  /** List a directory inside a granted area, as the granter. */
  async listGranted(callerId: string, grantId: string, path: string, signal?: AbortSignal): Promise<string> {
    const access = await this.authorize(callerId, grantId, path, 'read', signal)
    // A FILE grant is legal: the area itself is the file, and listing it names
    // the file instead of failing on a directory operation.
    const info = await this.ctx.agents.withInitiator(
      access.granter,
      () => this.ctx.fs.stat(access.target, signal),
    )
    if (info !== undefined && info.type !== 'directory') {
      const name = access.target.displayPath.split('/').pop() ?? access.target.displayPath
      return `- ${name}（${info.size === undefined ? '未知大小' : String(info.size) + ' 字节'}）——这个映射本身就是一个文件：用 read 读取它，或用 download 把它取到你的世界。`
    }
    const entries = await this.ctx.agents.withInitiator(
      access.granter,
      () => this.ctx.fs.listDir(access.target, signal),
    )
    if (entries.length === 0) return `${path} 下没有条目。`
    return entries
      .map(entry => `${entry.type === 'directory' ? 'd' : entry.type === 'file' ? '-' : '?'} ${entry.name}`)
      .join('\n')
  }

  /**
   * One listing for the pipe detail page's buffer browser — the USER walking
   * the namespace, not an agent. With no grant id the answer is the pipe's
   * mapped roots (every live grant between the pair, both directions, `as`
   * areas only); with one, it is that grant's directory read through the same
   * containment test the tool uses. The user may browse grants whose reference
   * count has not yet drained even though no agent could exercise them —
   * "live" here is `revokedAt === undefined`, matching the grants the detail
   * page already renders.
   */
  async userListing(linkId: string, grantId?: string, relPath?: string): Promise<BufferListing> {
    const link = this.links.find(candidate => candidate.id === linkId)
    if (link === undefined) throw new Error(this.t('error.noLink', { id: linkId }))
    const live = this.grants.filter(grant => grant.revokedAt === undefined
      && ((grant.from === link.a && grant.to === link.b) || (grant.from === link.b && grant.to === link.a)))

    if (grantId === undefined || grantId.trim().length === 0) {
      const entries: BufferUserEntry[] = []
      for (const grant of live) {
        for (const area of grant.areas) {
          if (area.as === undefined) continue
          entries.push({
            name: area.as,
            kind: 'directory',
            as: area.as,
            grantId: grant.id,
            rights: [...area.rights],
            from: grant.from,
            to: grant.to,
            origin: area.path,
          })
        }
      }
      entries.sort((x, y) => x.name.localeCompare(y.name))
      return { path: '/', entries, truncated: false }
    }

    const grant = live.find(candidate => candidate.id === grantId)
    if (grant === undefined) throw new Error(this.t('error.grantNotOnLink'))
    const access = await this.authorizeInGrant(
      grant, relPath === undefined || relPath.trim().length === 0 ? '.' : relPath.trim(), 'read',
    )
    const info = await this.ctx.agents.withInitiator(
      access.granter,
      () => this.ctx.fs.stat(access.target),
    )
    if (info !== undefined && info.type !== 'directory') {
      const name = access.target.displayPath.split('/').pop() ?? access.target.displayPath
      return {
        path: access.target.displayPath,
        entries: [{ name, kind: 'file', ...info.size === undefined ? {} : { size: info.size } }],
        truncated: false,
      }
    }
    const children = await this.ctx.agents.withInitiator(
      access.granter,
      () => this.ctx.fs.listDir(access.target),
    )
    const entries: BufferUserEntry[] = children.slice(0, MAX_USER_ENTRIES).map(child => ({
      name: child.name,
      kind: child.type === 'directory' ? 'directory' : child.type === 'file' ? 'file' : 'other',
      ...child.size === undefined ? {} : { size: child.size },
    }))
    entries.sort((x, y) => {
      if (x.kind !== y.kind) return x.kind === 'directory' ? -1 : 1
      return x.name.localeCompare(y.name)
    })
    return {
      path: access.target.displayPath,
      entries,
      truncated: children.length > MAX_USER_ENTRIES,
    }
  }

  /**
   * Copy one file between the granted area's execution world and this
   * session's own.
   *
   * This is the one operation that crosses worlds rather than reaching into
   * one: the source is read through `ctx.fs` as its owner, and the destination
   * is written through the shell seam as ITS owner, so a grantee on a device
   * and a granter on this machine (or the reverse) never learn more about each
   * other than the bytes moved. `path` is always the grant-side path and
   * `dest` the caller-side one; `side` says which end is the source.
   *
   * @param callerId - the session exercising the grant.
   * @param grantId - the grant, which supplies the path's scope and the right.
   * @param path - path relative to a granted area root.
   * @param dest - path in the caller's own world; omitted means the same
   *   relative path, which is what "the corresponding location" means here.
   * @param side - `from` reads the granted area (needs read), `to` writes it
   *   (needs write).
   * @param maxBytes - size ceiling override, clamped by the service.
   * @returns what moved where, in bytes.
   */
  /**
   * Download: copy one file from a granted area into this session's own world.
   * `dest` is the full destination file path HERE — the point of a download is
   * choosing where it lands. Large files relay in chunks automatically.
   */
  async download(
    callerId: string,
    grantId: string,
    path: string,
    dest: string | undefined,
    maxBytes: number | undefined,
    signal?: AbortSignal,
  ): Promise<TransferOutcome> {
    const access = await this.authorize(callerId, grantId, path, 'read', signal)
    const caller = await this.callerAgent(callerId)
    const callerPath = dest === undefined || dest.trim().length === 0 ? path : dest.trim()
    const destination = await this.ctx.agents.withInitiator(
      caller,
      () => this.ctx.fs.resolve(callerPath, this.resolveOptions(caller, signal)),
    )
    return await this.moveFile(callerId, access.target, destination, access.granter, caller, maxBytes, signal)
  }

  /**
   * Upload: copy one file from this session's world into a granted area.
   * `src` is the local source file path; `path` names the buffer destination —
   * the mapped area decides which real directory receives it.
   */
  async upload(
    callerId: string,
    grantId: string,
    path: string,
    src: string,
    maxBytes: number | undefined,
    signal?: AbortSignal,
  ): Promise<TransferOutcome> {
    const access = await this.authorize(callerId, grantId, path, 'write', signal)
    const caller = await this.callerAgent(callerId)
    const source = await this.ctx.agents.withInitiator(
      caller,
      () => this.ctx.fs.resolve(src.trim(), this.resolveOptions(caller, signal)),
    )
    return await this.moveFile(callerId, source, access.target, caller, access.granter, maxBytes, signal)
  }

  /** The calling session's live agent, or a refusal. */
  private async callerAgent(callerId: string): Promise<Agent> {
    const resolved = await this.ctx.sessionController.resolveAgent(SessionId(callerId))
    if ('error' in resolved) throw new Error(`本会话不可用：${resolved.error.code}`)
    return resolved.agent
  }

  /**
   * Move one file between two worlds: inline below the stdin ceiling, a
   * chunked relay above it. The ceiling the caller names applies to the WHOLE
   * file either way; each mode just has its own defaults and hard cap.
   */
  private async moveFile(
    callerId: string,
    source: FsTarget,
    destination: FsTarget,
    sourceWorld: Agent,
    destinationWorld: Agent,
    maxBytes: number | undefined,
    signal?: AbortSignal,
  ): Promise<TransferOutcome> {

    const info = await this.ctx.agents.withInitiator(sourceWorld, () => this.ctx.fs.stat(source, signal))
    if (info === undefined) throw new Error(`源文件不存在：${source.displayPath}`)
    if (info.type !== 'file') throw new Error(`源不是普通文件：${source.displayPath}（${info.type}）`)

    // Dispatch by size: one inline move up to the stdin ceiling, a chunked
    // relay above it. With no ceiling named, any file the inline path can
    // carry just goes (the 8 MiB default predates the chunked path and would
    // otherwise refuse 8-32 MiB files that need no relay at all); a named
    // ceiling applies to the WHOLE file in either mode.
    const big = info.size !== undefined && info.size > CHUNK_THRESHOLD_BYTES
    const cap = big
      ? clampBig(maxBytes)
      : maxBytes === undefined ? MAX_TRANSFER_BYTES : clampTransfer(maxBytes)
    if (info.size !== undefined && info.size > cap) {
      throw new Error(
        `源文件 ${fmtBytes(info.size)}，超过本次上限 ${fmtBytes(cap)}；`
        + (big
          ? `分块传输默认上限 ${fmtBytes(DEFAULT_BIG_BYTES)}，硬上限 ${fmtBytes(MAX_BIG_BYTES)}，可用 max_bytes 提高。`
          : `inline 上限 ${fmtBytes(MAX_TRANSFER_BYTES)}；更大的文件会自动走分块传输。`),
      )
    }
    if (big) {
      return await this.transferChunked(callerId, source, destination, sourceWorld, destinationWorld, info.size, signal)
    }

    const bytes = await this.ctx.agents.withInitiator(
      sourceWorld,
      () => this.ctx.fs.readBytes(source, signal, cap),
    )
    await this.writeBytesAs(destinationWorld, destination, bytes, signal)
    return {
      bytes: bytes.byteLength,
      source: source.displayPath,
      destination: destination.displayPath,
    }
  }

  /**
   * Relay one oversized file in chunks.
   *
   * The two worlds share no filesystem, so the file moves through the harness
   * in bounded pieces: the source world `split`s it into {@link CHUNK_BYTES}
   * slices under a scratch directory, every slice is read as bytes and written
   * into the destination world's scratch directory through the same
   * base64-over-stdin path the inline move uses, and the destination world
   * `cat`s the slices back together. Both ends checksum the whole file and the
   * transfer refuses to report success on a mismatch; the scratch directories
   * are cleaned on success and left in place on failure for inspection.
   */
  private async transferChunked(
    callerId: string,
    source: FsTarget,
    destination: FsTarget,
    sourceWorld: Agent,
    destinationWorld: Agent,
    total: number | undefined,
    signal?: AbortSignal,
  ): Promise<TransferOutcome> {
    const size = Math.max(0, total ?? 0)
    const chunksTotal = Math.max(1, Math.ceil(size / CHUNK_BYTES))
    const id = newId('xfer')
    const record: BufferTransfer = {
      id,
      sessionId: callerId,
      label: `${source.displayPath} → ${destination.displayPath}`,
      bytesDone: 0,
      bytesTotal: size,
      chunksDone: 0,
      chunksTotal,
      startedAt: Date.now(),
      finishedAt: undefined,
      error: undefined,
    }
    this.transfers.set(id, record)
    // A staging directory lives INSIDE the world that needs one, not in /tmp:
    // the reassembly runs through that world's sandboxed shell, and a
    // 工作区内修改 policy refuses writes outside the workspace.
    //
    // The path is spelled in the world's OWN namespace — its process path — and
    // not in this machine's. A device-bound session's cwd is a local MOUNT
    // directory standing in for the device tree, so a command carrying that
    // spelling would build the scratch at a path the device never had, while
    // `ctx.fs`, translating the same string, would look for it under the
    // device's own root: the slices and the reader would name two different
    // directories and the transfer would die on the chunk count. For a local
    // session this is the path itself (no change), and for a device one it is
    // the device's path — the same spelling the file-side paths already use
    // (`processPath`, as in `writeBytesAs`).
    const scratchOf = async (world: Agent): Promise<string> => {
      const cwd = world.session.header.cwd
      const local = `${(cwd ?? '/tmp').replace(/\/+$/u, '')}/.dshell-xfer-${id.slice(5)}`
      return await this.ctx.agents.withInitiator(world, async () => {
        const target = await this.ctx.fs.resolve(local, this.resolveOptions(world, signal))
        return this.ctx.fs.processPath(target)
      })
    }
    try {
      // The two worlds share no filesystem, so the file moves through the
      // harness in bounded pieces: the source world reads each chunk at an
      // offset (ctx.fs.readByteRange), the destination world receives each
      // chunk's bytes, and the destination world lands the assembled file
      // with one deviceFs.writeBytes (which the helper stages atomically).
      // No scratch parts on either side, no split / cat / sha256sum scripts.
      const destinationPath = this.ctx.fs.processPath(destination)
      const destinationOps = this.deviceOpsFor(destinationWorld)
      // Only a destination with no byte-level ops stages parts on disk; a
      // helper takes the assembled file in one atomic write, and the source
      // never stages at all — its chunks are read at offsets.
      const destinationScratch = destinationOps === undefined ? await scratchOf(destinationWorld) : ''
      let bytesDone = 0
      const buffers: Buffer[] = []
      let total = 0
      for (let index = 0; index < chunksTotal; index += 1) {
        signal?.throwIfAborted()
        const length = Math.min(CHUNK_BYTES, size - index * CHUNK_BYTES)
        const chunk = await this.ctx.agents.withInitiator(
          sourceWorld,
          async () => await this.ctx.fs.readByteRange(
            source,
            { offset: index * CHUNK_BYTES, length },
            signal,
          ),
        )
        bytesDone += chunk.byteLength
        this.transfers.set(id, { ...record, bytesDone, chunksDone: index + 1 })
        if (destinationOps !== undefined) {
          buffers.push(Buffer.from(chunk))
          total += chunk.byteLength
        } else {
          await this.writeBytesAs(
            destinationWorld,
            await this.ctx.fs.resolve(`${destinationScratch}/p${String(index).padStart(4, '0')}`,
              this.resolveOptions(destinationWorld, signal)),
            chunk,
            signal,
          )
        }
      }
      // Land the assembled file in the destination world, then verify.
      if (destinationOps !== undefined) {
        const assembled = Buffer.concat(buffers, total)
        if (assembled.byteLength !== size) {
          throw new Error(`分块重组字节数 ${String(assembled.byteLength)} 与期望 ${String(size)} 不一致。`)
        }
        await destinationOps.mkdir([posixDirname(destinationPath)], true)
        await destinationOps.writeBytes(destinationPath, assembled, signal)
        const destinationSha = await destinationOps.sha256(destinationPath, signal)
        const sourcePath = this.ctx.fs.processPath(source)
        const sourceSha = await this.sha256AcrossWorld(sourceWorld, sourcePath, signal)
        if (sourceSha === '' || destinationSha !== sourceSha) {
          throw new Error(
            `分块传输校验不一致：源 ${sourceSha || '未知'}，目标 ${destinationSha || '未知'}。`,
          )
        }
        // The destination's atomic staging left a clean publish; nothing to
        // clean up. The source world had no scratch either.
      } else {
        // Two hosts: cat the staging parts on the destination and verify.
        await this.execAs(
          destinationWorld,
          `mkdir -p -- ${quote(posixDirname(destinationPath))} && cat ${quote(destinationScratch)}/p* > ${quote(destinationPath)}`
          + ` && sha256sum ${quote(destinationPath)} > ${quote(destinationScratch + '/sum')}`,
          signal,
        )
        const sumOf = (text: string): string =>
          text.split('\n').map(line => line.trim()).find(line => line.length > 0)?.split(/\s+/u)[0] ?? ''
        const destinationSha = sumOf(await this.readWorldFile(destinationWorld, `${destinationScratch}/sum`, signal))
        // The source's digest is asked of the source's own world: the
        // destination cannot compute it, and no scratch file of the source's
        // holds it — the chunks were read at offsets, never split on disk.
        const sourceSha = await this.sha256AcrossWorld(sourceWorld, this.ctx.fs.processPath(source), signal)
        if (sourceSha === '' || destinationSha !== sourceSha) {
          throw new Error(`分块传输校验不一致：源 ${sourceSha || '未知'}，目标 ${destinationSha || '未知'}。中间数据保留在 ${destinationScratch}`)
        }
        await this.execAs(destinationWorld, `rm -rf -- ${quote(destinationScratch)}`, signal)
      }
      const finished: BufferTransfer = { ...record, bytesDone: size, chunksDone: chunksTotal, finishedAt: Date.now() }
      this.transfers.set(id, finished)
      this.pruneTransfer(id)
      return {
        bytes: size,
        source: source.displayPath,
        destination: destination.displayPath,
        chunks: chunksTotal,
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.transfers.set(id, { ...record, finishedAt: Date.now(), error: reason })
      this.pruneTransfer(id)
      throw error
    }
  }

  /** Convenience: resolve an absolute scratch path as one world and read it. */
  private async readWorldFile(world: Agent, path: string, signal?: AbortSignal): Promise<string> {
    return await this.ctx.agents.withInitiator(
      world,
      async () => await this.ctx.fs.readText(
        await this.ctx.fs.resolve(path, this.resolveOptions(world, signal)),
        signal,
      ),
    )
  }

  /**
   * Run one shell command AS one world, fenced by that world's own policy.
   * @param stdin - text to write to the command's stdin before closing it; the
   *   base64 lane of {@link writeBytesAs} is its only caller.
   */
  private async execAs(world: Agent, command: string, signal?: AbortSignal, stdin?: string): Promise<void> {
    const shell = this.ctx.get('shell')
    if (shell === undefined) {
      throw new Error('本次组合没有 shell 服务，无法执行跨世界传输')
    }
    const cwd = world.session.header.cwd
    const policy = this.ctx.get('sandboxPolicy')?.resolve({ session: world.session })
    const spec = this.ctx.agents.withInitiator(world, () => shell.resolve({
      command,
      ...cwd === undefined ? {} : { workdir: cwd },
      ...policy === undefined ? {} : { sandboxPolicy: policy },
      ...signal === undefined ? {} : { signal },
    }))
    const result = await (await shell.execute({ ...spec, stdin })).result()
    if (result.exitCode !== 0) {
      const detail = result.stderr.text.trim()
      throw new Error(
        `命令执行失败：${detail.length > 0 ? detail : `退出码 ${String(result.exitCode ?? result.signal ?? 'unknown')}`}`)
    }
  }

  /** Drop a settled transfer from the snapshot after progress surfaces catch it. */
  private pruneTransfer(id: string): void {
    const timer = setTimeout(() => { this.transfers.delete(id) }, TRANSFER_TAIL_MS)
    timer.unref?.()
  }

  /**
   * The whole-file SHA-256 of one path in one world, via `deviceFs` when the
   * world is a device session and via the host `sha256sum` otherwise.
   */
  private async sha256AcrossWorld(world: Agent, path: string, signal?: AbortSignal): Promise<string> {
    const ops = this.deviceOpsFor(world)
    if (ops !== undefined) return await ops.sha256(path, signal)
    return await this.sha256sumInWorld(world, path, signal)
  }

  /** Run `sha256sum` on one path inside one world. */
  private async sha256sumInWorld(world: Agent, path: string, signal?: AbortSignal): Promise<string> {
    const shell = this.ctx.get('shell')
    if (shell === undefined) {
      throw new Error('本次组合没有 shell 服务，无法计算远端文件的校验和')
    }
    const cwd = world.session.header.cwd
    const policy = this.ctx.get('sandboxPolicy')?.resolve({ session: world.session })
    const spec = this.ctx.agents.withInitiator(world, () => shell.resolve({
      command: `sha256sum -- ${quote(path)}`,
      ...cwd === undefined ? {} : { workdir: cwd },
      ...policy === undefined ? {} : { sandboxPolicy: policy },
      ...signal === undefined ? {} : { signal },
    }))
    const result = await (await shell.execute(spec)).result()
    if (result.exitCode !== 0) return ''
    return (result.stdout.text.trim().split(/\s+/u)[0] ?? '')
  }

  /**
   * Write bytes into ONE session's execution world.
   *
   * Three lanes, and the world decides which:
   *
   *  - a device with its helper up takes the bytes through
   *    `ctx.deviceFs.writeBytes`, which stages atomically and creates missing
   *    parents;
   *  - a device with NO helper takes them through the shell seam, which routes
   *    to that device anyway, as base64 on stdin decoded there. This lane is
   *    the reason the fallback below is not simply `node:fs`: `processPath`
   *    spells a DEVICE path, and writing that spelling on this machine would
   *    create it here — the one thing a device session must never do.
   *  - a session that runs here writes here.
   *
   * A session bound to a device that cannot be served never reaches any of the
   * three: `deviceOpsFor` refuses on the way past.
   */
  private async writeBytesAs(world: Agent, target: FsTarget, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    const path = this.ctx.fs.processPath(target)
    const ops = this.deviceOpsFor(world)
    if (ops !== undefined) {
      await ops.mkdir([posixDirname(path)], true)
      await ops.writeBytes(path, bytes, signal)
      return
    }
    if (this.routing?.targetForSession(String(world.id)) !== undefined) {
      await this.execAs(
        world,
        `mkdir -p -- ${quote(posixDirname(path))} && base64 -d > ${quote(path)}`,
        signal,
        Buffer.from(bytes).toString('base64'),
      )
      return
    }
    const { promises: fs } = await import('node:fs')
    await fs.mkdir(posixDirname(path), { recursive: true })
    await fs.writeFile(path, bytes, { signal })
  }

  /**
   * The byte-level device ops for one session world, scoped to its initiator.
   *
   * The seat reads the ambient initiator on every call, so wrapping the
   * lookup in `withInitiator(world, ...)` is what makes the right device
   * answer. Returns `undefined` for a host world or for a device world
   * without a helper up; the caller falls back to its in-process path.
   */
  private deviceOpsFor(world: Agent): import('@nexus-aethra/dshell-std').DeviceFsOps | undefined {
    if (this.deviceFs === undefined) return undefined
    return this.ctx.agents.withInitiator(world, () => this.deviceFs!.forInitiator())
  }

  /** The fs resolution options for one session: its cwd and the call's signal. */
  private resolveOptions(agent: Agent, signal?: AbortSignal): { cwd?: string; signal?: AbortSignal } {
    const cwd = agent.session.header.cwd
    return {
      ...cwd === undefined ? {} : { cwd },
      ...signal === undefined ? {} : { signal },
    }
  }

  /**
   * Join a relative request onto a canonical root, keeping the root's own
   * separator style (the root may be a device path).
   *
   * An absolute request is a refusal, translated at the throw site because the
   * panel's buffer browser reaches this through `authorizeInGrant` and the
   * refusal's text is folded into what it renders.
   */
  private joinRelative(root: FsTarget, path: string): string {
    const base = String(root.targetKey).replace(/[/\\]+$/u, '')
    if (path.length === 0 || path === '.' || path === './') return base
    if (path.startsWith('/') || /^[A-Za-z]:[/\\]/u.test(path)) {
      throw new Error(this.t('error.absolutePath', { path }))
    }
    return `${base}/${path.replace(/^\.\//u, '')}`
  }

  /**
   * Resolve a request against a grant's areas.
   *
   * The area root and the requested path are both resolved **as the granter**,
   * so a device-bound granter's tree is read over its own SSH route and a local
   * granter's tree on this machine — the caller never learns which, and never
   * needs to. Containment is then checked on the canonical targets, so `..` and
   * symlinks in the request cannot escape the area.
   *
   * @returns the granter agent, the resolved target, and the area it matched.
   */
  private async authorize(
    callerId: string,
    grantId: string,
    path: string,
    right: BufferRight,
    signal?: AbortSignal,
  ): Promise<{ granter: Agent; target: FsTarget; area: BufferArea }> {
    const grant = this.requireGrant(grantId)
    if (grant.revokedAt !== undefined) throw new Error('这条缓冲路径已失效：对应的授权已回收')
    if (grant.to !== callerId) throw new Error('这条缓冲路径不属于本会话')
    if (grant.count <= 0) throw new Error('这条缓冲路径已失效：授权随任务结算回收了')
    return await this.authorizeInGrant(grant, path, right, signal)
  }

  /**
   * The containment test for one area of one grant, with no view-side checks —
   * the caller (session authorize above, or the user's browser below) has
   * already decided this grant may be exercised at all.
   */
  private async authorizeInGrant(
    grant: BufferGrant,
    path: string,
    right: BufferRight,
    signal?: AbortSignal,
  ): Promise<{ granter: Agent; target: FsTarget; area: BufferArea }> {
    const areas = grant.areas.filter(area => area.rights.includes(right))
    if (areas.length === 0) throw new Error(this.t('error.grantMissingRight', { right }))
    const resolved = await this.ctx.sessionController.resolveAgent(SessionId(grant.from))
    if ('error' in resolved) throw new Error(this.t('error.granterUnavailable', { code: resolved.error.code }))
    const granter = resolved.agent
    // Built conditionally: `exactOptionalPropertyTypes` treats an explicit
    // `undefined` as a value, and the resolution options are optional keys.
    const options = this.resolveOptions(granter, signal)
    const rejections: string[] = []
    for (const area of areas) {
      try {
        const rootTarget = await this.ctx.agents.withInitiator(
          granter,
          () => this.ctx.fs.resolve(area.path, options),
        )
        const fileTarget = await this.ctx.agents.withInitiator(
          granter,
          () => this.ctx.fs.resolve(this.joinRelative(rootTarget, path), options),
        )
        if (!isUnder(String(rootTarget.targetKey), String(fileTarget.targetKey))) {
          rejections.push(this.t('error.areaOutOfBounds', { path: area.path }))
          continue
        }
        return { granter, target: fileTarget, area }
      } catch (error) {
        rejections.push(this.t('error.areaRejected', {
          path: area.path,
          reason: error instanceof Error ? error.message : String(error),
        }))
      }
    }
    throw new Error(this.t('error.outOfScope', {
      path,
      reasons: rejections.join(this.t('error.reasonSeparator')),
    }))
  }

  // --------------------------------------------------------------- internals

  /**
   * Create a grant for one delegation, born with one reference (the ticket it
   * is issued for).
   *
   * Every area gets a mapping name here, and only here: the caller's `as` when
   * it named one, the path's own last segment otherwise, suffixed to stay
   * unique among the names the GRANTEE already holds. The name is what the two
   * sessions exchange — an authorization's id stays inside this service.
   */
  private newGrant(from: string, to: string, request: GrantRequest, taken: Set<string>): BufferGrant {
    if (request.areas.length === 0) throw new Error('授权至少要包含一个目录或文件')
    const areas = request.areas.map(area => {
      const preferred = area.as !== undefined && validMappingName(area.as)
        ? area.as
        : derivedMappingName(area.path)
      const name = this.uniqueMappingName(preferred, taken)
      taken.add(name)
      return { path: area.path, rights: [...area.rights], as: name }
    })
    const grant: BufferGrant = {
      id: newId('grant'),
      from,
      to,
      description: request.description.trim(),
      areas,
      count: 1,
      createdAt: Date.now(),
    }
    this.grants.push(grant)
    return grant
  }

  /**
   * Every mapping name live on one grantee's side, from every live grant.
   *
   * The names share one namespace per GRANTEE, not per pipe: addressing a
   * buffer path searches every grant the session holds, so a name may appear
   * only once across all of them.
   */
  private mappingNamesFor(grantee: string): Set<string> {
    const taken = new Set<string>()
    for (const grant of this.grants) {
      if (grant.revokedAt !== undefined || grant.to !== grantee) continue
      for (const area of grant.areas) if (area.as !== undefined) taken.add(area.as)
    }
    return taken
  }

  /** One free name on the grantee's side; `-2`, `-3` … on collision. */
  private uniqueMappingName(preferred: string, taken: Set<string>): string {
    if (!taken.has(preferred)) return preferred
    for (let index = 2; ; index += 1) {
      const candidate = `${preferred}-${String(index)}`
      if (!taken.has(candidate)) return candidate
    }
  }

  /** A live grant of this exact pair whose area already covers this path and rights. */
  private reusableGrant(from: string, to: string, area: BufferArea): BufferGrant | undefined {
    return this.grants.find(grant => grant.revokedAt === undefined
      && grant.from === from && grant.to === to
      && grant.areas.some(candidate => candidate.path === area.path && sameRights(candidate.rights, area.rights)))
  }

  /**
   * Give every live area a mapping name, once, at load.
   *
   * State written before the delegation schema offered `as` holds live grants
   * whose areas have no name, and an unnamed area is invisible to every
   * buffer path. Naming them here is the migration; it happens before any
   * request can see the state, so no live authorization is ever unreachable.
   */
  private migrateMappings(): boolean {
    const sets = new Map<string, Set<string>>()
    const takenFor = (grantee: string): Set<string> => {
      const cached = sets.get(grantee)
      if (cached !== undefined) return cached
      const set = this.mappingNamesFor(grantee)
      sets.set(grantee, set)
      return set
    }
    let changed = false
    for (let index = 0; index < this.grants.length; index += 1) {
      const grant = this.grants[index] as BufferGrant
      if (grant.revokedAt !== undefined || grant.areas.every(area => area.as !== undefined)) continue
      const taken = takenFor(grant.to)
      const areas = grant.areas.map(area => {
        if (area.as !== undefined) return area
        const name = this.uniqueMappingName(derivedMappingName(area.path), taken)
        taken.add(name)
        changed = true
        return { path: area.path, rights: [...area.rights], as: name }
      })
      this.grants[index] = { ...grant, areas }
    }
    return changed
  }

  /** Settle a ticket, release its grants and wake the requester exactly once. */
  private async settle(
    ticket: BufferTicket,
    state: BufferTicketState,
    result: string | undefined,
    error: string | undefined,
  ): Promise<void> {
    if (state === 'queued' || state === 'running') throw new Error(`不能结算到 ${state}`)
    if (SETTLED_STATES.includes(ticket.state)) return
    ticket.state = state
    ticket.settledAt = Date.now()
    if (result !== undefined) ticket.result = result
    if (error !== undefined) ticket.error = error
    for (const grantId of ticket.grantIds) this.releaseGrant(grantId)
    await this.save()
    await this.wake(ticket)
  }

  /** Drop one reference; reaching zero revokes the grant at once. */
  private releaseGrant(grantId: string): void {
    const grant = this.grants.find(candidate => candidate.id === grantId)
    if (grant === undefined || grant.revokedAt !== undefined) return
    grant.count = Math.max(0, grant.count - 1)
    if (grant.count === 0) grant.revokedAt = Date.now()
  }

  /** Deliver the settlement notice to the requester. */
  private async wake(ticket: BufferTicket): Promise<void> {
    const text = renderSettlementNotice(this.t, ticket, this.labelOf(ticket.to))
    await this.deliver(ticket.from, text, settlementSummary(this.t, ticket, this.labelOf(ticket.to)))
  }

  /**
   * Hand one message to a session.
   *
   * Delivery mirrors dsh's job registry: an idle agent is woken with a new
   * turn, a running one is injected so the message parks at its next step
   * (a notice must not be lost, and it must not interrupt a step in flight).
   *
   * @returns whether the message was admitted.
   */
  private async deliver(
    sessionId: string,
    text: string,
    summary: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const resolved = await this.ctx.sessionController.resolveAgent(SessionId(sessionId))
      if ('error' in resolved) return { ok: false, reason: `目标会话不可用：${resolved.error.code}` }
      const agent = resolved.agent
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'dshell-buffer', plugin: BUFFER_PLUGIN, form: 'notice', summary },
      })
      if (agent.status === 'idle') agent.followup(message)
      else agent.inject(message)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** A worker session went away: settle its live tickets so nobody waits on it. */
  private async onAgentDisposed(sessionId: string): Promise<void> {
    if (this.disposed) return
    const orphaned = this.tickets.filter(ticket =>
      ticket.to === sessionId && (ticket.state === 'queued' || ticket.state === 'running'))
    for (const ticket of orphaned) {
      await this.settle(ticket, 'failed', undefined, `承接会话 ${short(sessionId)} 已关闭`)
    }
    // The requester going away ends its requests too: nothing can be woken
    // any more, and the worker should not keep spending on a dead ticket.
    const requested = this.tickets.filter(ticket =>
      ticket.from === sessionId && (ticket.state === 'queued' || ticket.state === 'running'))
    for (const ticket of requested) {
      await this.settle(ticket, 'cancelled', undefined, `发起会话 ${short(sessionId)} 已关闭`)
    }
  }

  /** Settle tickets nobody resolved in time. */
  private async sweep(): Promise<void> {
    if (this.disposed) return
    const now = Date.now()
    const expired = this.tickets.filter(ticket =>
      (ticket.state === 'queued' || ticket.state === 'running') && now >= ticket.deadlineAt)
    for (const ticket of expired) {
      await this.settle(ticket, 'timeout', undefined, '超过了委派时给定的期限')
    }
  }

  /** Find the link a delegation travels over. */
  private resolveLink(callerId: string, input: DelegateInput): BufferLink {
    if (input.linkId !== undefined) {
      const link = this.links.find(candidate => candidate.id === input.linkId)
      if (link === undefined) throw new Error(`没有这个管道：${input.linkId}`)
      if (link.a !== callerId && link.b !== callerId) throw new Error(`管道 ${input.linkId} 与本会话无关`)
      return link
    }
    const to = input.to?.trim()
    if (to === undefined || to.length === 0) throw new Error('需要 to 或 link_id 指定目标会话')
    if (to === callerId) throw new Error('不能把请求委派给自己')
    const link = this.links.find(candidate =>
      (candidate.a === callerId && candidate.b === to) || (candidate.a === to && candidate.b === callerId))
    if (link === undefined) {
      throw new Error(`本会话与 ${short(to)} 之间还没有管道；请在「管道」页面里先建立连接`)
    }
    return link
  }

  private requireGrant(grantId: string): BufferGrant {
    const grant = this.grants.find(candidate => candidate.id === grantId)
    if (grant === undefined) throw new Error(this.t('error.grantMissing'))
    return grant
  }

  private requireTicket(ticketId: string): BufferTicket {
    const ticket = this.tickets.find(candidate => candidate.id === ticketId)
    if (ticket === undefined) throw new Error(this.t('error.noTicket', { id: ticketId }))
    return ticket
  }

  private requireWorkerTicket(ticketId: string, callerId: string): BufferTicket {
    const ticket = this.requireTicket(ticketId)
    if (ticket.to !== callerId) throw new Error(`ticket ${ticketId} 不是发给本会话的`)
    return ticket
  }

  /** A readable handle for a session in message text. */
  private labelOf(sessionId: string): string {
    const link = this.links.find(candidate => candidate.a === sessionId || candidate.b === sessionId)
    return sessionLabel(sessionId, link?.label, undefined)
  }

  /** Persist, serialized so two mutations cannot interleave their writes. */
  private save(): Promise<void> {
    const next = this.saveChain.then(() => {
      writeDocument({
        version: 1,
        links: this.links,
        tickets: this.tickets,
        grants: this.grants,
      })
    })
    this.saveChain = next.catch(() => { /* the next write retries the document */ })
    return next
  }
}

/** A short, readable, collision-resistant id for a link, ticket or grant. */
function newId(prefix: string): string {
  const random = globalThis.crypto.randomUUID().replace(/-/gu, '').slice(0, 10)
  return `${prefix}_${random}`
}

/**
 * One optional text field, normalized: `undefined` for absent or blank.
 *
 * Absent and blank are the same fact for every reader of a pipe's name or
 * purpose, so they are the same value here rather than two states to test for.
 */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/** First 8 characters of a session id, for message text. */
function short(sessionId: string): string {
  return sessionId.slice(0, 8)
}

/** Clamp a caller-supplied deadline into the range the watchdog can honour. */
function clampDeadline(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_DEADLINE_MS
  return Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, Math.floor(requested)))
}

/** Clamp a caller-supplied transfer ceiling. */
function clampTransfer(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_TRANSFER_BYTES
  return Math.min(MAX_TRANSFER_BYTES, Math.max(1, Math.floor(requested)))
}

/** Clamp a chunked transfer's WHOLE-size ceiling. */
function clampBig(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_BIG_BYTES
  return Math.min(MAX_BIG_BYTES, Math.max(CHUNK_BYTES, Math.floor(requested)))
}

/** Human-readable byte count for error text. */
function fmtBytes(size: number): string {
  return size >= 1024 * 1024 * 1024
    ? `${(size / (1024 * 1024 * 1024)).toFixed(1)} GiB`
    : `${Math.max(1, Math.round(size / (1024 * 1024)))} MiB`
}

/**
 * The directory part of a POSIX path, without `node:path`.
 *
 * Both execution worlds in this composition are POSIX (this machine and the
 * device), and a device path must not be run through a local path module that
 * would rewrite its separators.
 */
function posixDirname(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  const cut = trimmed.lastIndexOf('/')
  if (cut < 0) return '.'
  return cut === 0 ? '/' : trimmed.slice(0, cut)
}

/** Single-quote one shell argument so the destination shell reads it literally. */
function quote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`
}

