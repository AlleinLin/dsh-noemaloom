/**
 * The scan: walk every session's durable log, count the token usage each model
 * turn reported, and add it to the index.
 *
 * Where the numbers come from. dsh attaches provider-reported accounting to the
 * `assistant/message` event itself — `data.usage` — and the same event's
 * `data.message.source` names the route that produced it. Usage and route
 * therefore travel together on one event and nothing has to be paired up or
 * inferred, which is what makes a scan over history as reliable as one over a
 * live session.
 *
 * Incremental by session. The index keeps the highest seq counted for each
 * session, and a session whose log has not grown is skipped after a cheap
 * metadata listing rather than a full read. A session that has grown is read
 * whole and filtered down to the events past its cursor, so a rescan costs one
 * decode per touched session and nothing for the rest.
 *
 * Writes are batched, never per event and never per session. A scan accumulates
 * its rows in memory and hands them to the store once, and {@link UsageScanner.schedule}
 * coalesces concurrent callers behind a single flight plus a minimum interval,
 * so a page opened repeatedly still produces at most one transaction per
 * interval rather than one per open.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { UsageBuckets, UsageKey } from './protocol.js'
import { localDay, type UsageStore } from './index-store.js'

/**
 * The slice of `ctx.sessionQuery` a scan uses, typed structurally so this
 * package does not depend on the query engine's full surface.
 */
export interface UsageSessionQuery {
  listSessions: (signal?: AbortSignal) => Promise<readonly { header: { id: string } }[]>
  listEvents: (sessionId: string) => Promise<readonly { seq: number }[]>
  readSession: (sessionId: string) => Promise<{ events: readonly SessionEvent[] }>
}

/** Scan pacing. Both are deliberate: the host must not write per turn. */
export interface UsageScanPolicy {
  /** Triggers inside this window share one scan. */
  readonly minIntervalMs: number
  /** How long a scan will wait for a burst of triggers to settle. */
  readonly debounceMs: number
}

/** Defaults: a page can be reopened freely without a second disk write. */
export const DEFAULT_SCAN_POLICY: UsageScanPolicy = { minIntervalMs: 30_000, debounceMs: 400 }

/** One counted turn, before it is folded into a bucket. */
interface CountedTurn extends UsageBuckets {
  readonly day: string
  readonly provider: string
  readonly model: string
}

/** The route and usage one `assistant/message` carries, or undefined. */
export function usageOf(event: SessionEvent): CountedTurn | undefined {
  const data = (event as { data?: unknown }).data as
    | { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }, message?: { source?: { provider?: string, model?: string } } }
    | undefined
  const usage = data?.usage
  if (usage === undefined) return undefined
  const source = data?.message?.source
  // A turn with no route is not attributable, and an unattributed turn would
  // silently land in a bucket named after nothing.
  if (typeof source?.provider !== 'string' || typeof source.model !== 'string') return undefined
  const time = (event as { time?: number }).time
  return {
    day: localDay(new Date(typeof time === 'number' ? time : Date.now())),
    provider: source.provider,
    model: source.model,
    uncachedInputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    turns: 1,
  }
}

/** The mutable accumulator a fold adds into. */
type UsageAccumulator = {
  day: string
  provider: string
  model: string
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  turns: number
}

/** Fold counted turns into one row per (day, route). */
export function foldTurns(turns: readonly CountedTurn[]): (UsageKey & UsageBuckets)[] {
  const folded = new Map<string, UsageAccumulator>()
  for (const turn of turns) {
    const key = `${turn.day}\u0000${turn.provider}\u0000${turn.model}`
    const running = folded.get(key)
    if (running === undefined) {
      folded.set(key, {
        day: turn.day,
        provider: turn.provider,
        model: turn.model,
        uncachedInputTokens: turn.uncachedInputTokens,
        outputTokens: turn.outputTokens,
        cacheReadTokens: turn.cacheReadTokens,
        cacheWriteTokens: turn.cacheWriteTokens,
        turns: turn.turns,
      })
      continue
    }
    running.uncachedInputTokens += turn.uncachedInputTokens
    running.outputTokens += turn.outputTokens
    running.cacheReadTokens += turn.cacheReadTokens
    running.cacheWriteTokens += turn.cacheWriteTokens
    running.turns += turn.turns
  }
  return [...folded.values()]
}

/** What one session contributed, for the caller's log line. */
export interface ScanOutcome {
  readonly sessions: number
  readonly read: number
  readonly turns: number
  /** Sessions whose log could not be decoded, so their usage is not counted. */
  readonly skipped: number
  /** Why the first skipped session was skipped; absent when nothing was. */
  readonly skipReason: string | undefined
  readonly written: boolean
}

/** Serialises scans and holds the write-behind window. */
export class UsageScanner {
  #inFlight: Promise<ScanOutcome> | undefined
  #lastFinishedAt = 0
  #timer: NodeJS.Timeout | undefined

  constructor(
    private readonly store: UsageStore,
    private readonly query: UsageSessionQuery,
    private readonly policy: UsageScanPolicy = DEFAULT_SCAN_POLICY,
  ) {}

  /**
   * Ask for a scan, without waiting for one that is already running.
   *
   * A caller inside the minimum interval is answered with what the last scan
   * did, so the page never blocks on a second pass it does not need.
   */
  async schedule(): Promise<ScanOutcome> {
    if (this.#inFlight !== undefined) return await this.#inFlight
    const since = Date.now() - this.#lastFinishedAt
    if (since < this.policy.minIntervalMs) {
      return { sessions: 0, read: 0, turns: 0, skipped: 0, skipReason: undefined, written: false }
    }
    if (this.policy.debounceMs > 0) {
      await new Promise<void>((settle) => {
        if (this.#timer !== undefined) clearTimeout(this.#timer)
        this.#timer = setTimeout(() => { this.#timer = undefined; settle() }, this.policy.debounceMs)
      })
    }
    if (this.#inFlight !== undefined) return await this.#inFlight
    this.#inFlight = this.#run().finally(() => {
      this.#inFlight = undefined
      this.#lastFinishedAt = Date.now()
    })
    return await this.#inFlight
  }

  /** Scan now, ignoring pacing. The page's explicit rebuild action. */
  async rescan(): Promise<ScanOutcome> {
    return await this.#run()
  }

  /** Stop a waiting trigger; the plugin's teardown path. */
  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
  }

  async #run(): Promise<ScanOutcome> {
    const cursors = this.store.cursors()
    const sessions = await this.query.listSessions()
    const counted: CountedTurn[] = []
    const advanced: { sessionId: string; seq: number }[] = []
    let read = 0
    let skipped = 0
    let skipReason: string | undefined
    for (const session of sessions) {
      const id = String(session.header.id)
      const cursor = cursors.get(id)
      // One unreadable log must not cost the reader every other session's
      // usage. A session whose event list or log cannot be decoded is counted
      // as skipped and left WITHOUT advancing its cursor, so a later scan
      // visits it again — the log is not ours to repair, and a refusal is
      // usually a fact about that one artifact (a log dsh cannot migrate, a
      // half-written file) rather than about the index. The first reason is
      // carried out so the page can say why the totals are partial.
      let maxSeq: number
      let full: { events: readonly SessionEvent[] }
      try {
        const events = await this.query.listEvents(id)
        maxSeq = events.reduce((highest, event) => Math.max(highest, event.seq), 0)
        if (cursor !== undefined && maxSeq <= cursor) continue
        // A log that shrank means the persisted session was replaced rather than
        // appended to; its cursor no longer describes it, so it is read afresh
        // and its earlier contribution is left where it is — an index of what was
        // spent cannot be un-spent by a rewrite.
        full = await this.query.readSession(id)
      } catch (error) {
        skipped += 1
        skipReason ??= error instanceof Error ? error.message : String(error)
        continue
      }
      read += 1
      for (const event of full.events) {
        if (cursor !== undefined && event.seq <= cursor) continue
        const turn = usageOf(event)
        if (turn !== undefined) counted.push(turn)
      }
      advanced.push({ sessionId: id, seq: maxSeq })
    }
    const rows = foldTurns(counted)
    const scannedAt = localDay(new Date())
    // The one write: this scan's rows, its cursors, and the freshness stamp in
    // a single transaction. An empty scan still advances nothing.
    if (rows.length > 0 || advanced.length > 0) {
      this.store.applyBatch({ rows, cursors: advanced, scannedAt })
    }
    return {
      sessions: sessions.length, read, turns: counted.length, skipped, skipReason,
      written: rows.length > 0 || advanced.length > 0,
    }
  }
}
