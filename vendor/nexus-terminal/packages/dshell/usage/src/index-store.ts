/**
 * The usage index: one SQLite database holding per-day, per-route token
 * buckets, plus the per-session cursor that makes a rescan incremental.
 *
 * Node's built-in `node:sqlite` is the engine, the same choice
 * `@nexus-aethra/dshell-storage` makes for command history and for the same
 * reasons: no native dependency and no install script.
 *
 * Why a table and not the JSON document this could have been: the page asks
 * aggregate questions ("this route over these days", "every day for this
 * route") and a document would have to be parsed whole to answer any of them.
 * The buckets are stored UNSHIFTED, one row per (day, route), and the row is
 * added to on rescan rather than rewritten, which is what lets a rescan touch
 * only the sessions that grew.
 *
 * Writes are deliberately coarse. A scan accumulates its rows in memory and
 * calls {@link UsageStore.applyBatch} once, inside a single transaction: the
 * host must not write per model turn, per event, or per session — see
 * `scan.ts` for the policy that decides when a batch is worth flushing.
 *
 * Format — `PRAGMA user_version = 1`.
 *
 *   usage_bucket(day, provider, model, uncached_input, output, cache_read,
 *                cache_write, turns)
 *     PRIMARY KEY (day, provider, model)
 *       `day` is `YYYY-MM-DD` in the HOST's local time, decided at scan time so
 *       a query never has to guess a zone. Every deployment here has the
 *       browser and the host on one machine, and the response states the days
 *       it covers, so a reader can tell what the buckets mean.
 *   usage_cursor(session_id, seq)
 *     PRIMARY KEY (session_id)
 *       the highest event seq already counted for that session; absent means
 *       never scanned.
 *   usage_meta(key, value)
 *       `scannedAt`, the local day the index was last extended.
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { UsageBuckets, UsageDayRow, UsageKey, UsageSummary, UsageTotalRow } from './protocol.js'

const LAYOUT = 1

/** A bucket to add, and the session cursor it arrived with. */
export interface UsageBatch {
  readonly rows: readonly (UsageKey & UsageBuckets)[]
  readonly cursors: readonly { readonly sessionId: string; readonly seq: number }[]
  /** Local day the batch was taken; becomes the index's freshness stamp. */
  readonly scannedAt: string
}

const ZERO: UsageBuckets = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  turns: 0,
}

/** Open databases by absolute path, so one process holds one handle per file. */
const stores = new Map<string, UsageStore>()

/** One open index. */
export class UsageStore {
  readonly #db: DatabaseSync

  constructor(private readonly path: string) {
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec('PRAGMA synchronous = NORMAL')
    this.#migrate()
  }

  /** Bring an older layout forward, or refuse one this build does not know. */
  #migrate(): void {
    const row = this.#db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    const version = row?.user_version ?? 0
    if (version === LAYOUT) return
    if (version !== 0) {
      // Forward-only: a newer layout read by an older build would silently
      // drop the columns it does not know, so it stops instead.
      throw new Error(`dshell usage: index at ${this.path} has layout ${String(version)}, this build writes ${String(LAYOUT)}`)
    }
    this.#db.exec(`
      CREATE TABLE usage_bucket (
        day TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        uncached_input INTEGER NOT NULL DEFAULT 0,
        output INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, provider, model)
      );
      CREATE TABLE usage_cursor (
        session_id TEXT NOT NULL PRIMARY KEY,
        seq INTEGER NOT NULL
      );
      CREATE TABLE usage_meta (
        key TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
      PRAGMA user_version = ${String(LAYOUT)};
    `)
  }

  /** The highest seq already counted for one session, or undefined. */
  cursorFor(sessionId: string): number | undefined {
    const row = this.#db.prepare('SELECT seq FROM usage_cursor WHERE session_id = ?').get(sessionId) as { seq: number } | undefined
    return row?.seq
  }

  /** Every cursor, so a scan can decide what to read without a query per session. */
  cursors(): Map<string, number> {
    const rows = this.#db.prepare('SELECT session_id, seq FROM usage_cursor').all() as { session_id: string; seq: number }[]
    return new Map(rows.map(row => [row.session_id, row.seq]))
  }

  /**
   * Add one scan's rows and advance its cursors, in one transaction.
   *
   * Additive on purpose: a rescan hands over only what it newly counted, so the
   * statement can never overwrite a bucket it did not read.
   */
  applyBatch(batch: UsageBatch): void {
    if (batch.rows.length === 0 && batch.cursors.length === 0) return
    const bucket = this.#db.prepare(`
      INSERT INTO usage_bucket (day, provider, model, uncached_input, output, cache_read, cache_write, turns)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (day, provider, model) DO UPDATE SET
        uncached_input = uncached_input + excluded.uncached_input,
        output = output + excluded.output,
        cache_read = cache_read + excluded.cache_read,
        cache_write = cache_write + excluded.cache_write,
        turns = turns + excluded.turns
    `)
    const cursor = this.#db.prepare(`
      INSERT INTO usage_cursor (session_id, seq) VALUES (?, ?)
      ON CONFLICT (session_id) DO UPDATE SET seq = excluded.seq
    `)
    const meta = this.#db.prepare(`
      INSERT INTO usage_meta (key, value) VALUES ('scannedAt', ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `)
    this.#db.exec('BEGIN')
    try {
      for (const row of batch.rows) {
        bucket.run(
          row.day, row.provider, row.model,
          row.uncachedInputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens, row.turns,
        )
      }
      for (const entry of batch.cursors) cursor.run(entry.sessionId, entry.seq)
      meta.run(batch.scannedAt)
      this.#db.exec('COMMIT')
    }
    catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * The aggregate the page renders, over one window.
   *
   * @param days - Window length in days, or null for everything on record.
   * @returns Day rows for the curve, route totals for the pie and table, and
   *   the two axis lists both need so the page never derives its own.
   */
  summary(days: number | null): UsageSummary {
    const bound = days === null ? undefined : localDay(new Date(Date.now() - days * 86_400_000))
    const where = bound === undefined ? '' : 'WHERE day >= ?'
    const args = bound === undefined ? [] : [bound]
    const dayRows = this.#db.prepare(`
      SELECT day, provider, model, uncached_input, output, cache_read, cache_write, turns
      FROM usage_bucket ${where}
      ORDER BY day, provider, model
    `).all(...args) as Record<string, string | number>[]
    const byDay: UsageDayRow[] = dayRows.map(row => ({
      day: String(row.day),
      provider: String(row.provider),
      model: String(row.model),
      uncachedInputTokens: Number(row.uncached_input),
      outputTokens: Number(row.output),
      cacheReadTokens: Number(row.cache_read),
      cacheWriteTokens: Number(row.cache_write),
      turns: Number(row.turns),
    }))
    const totals = new Map<string, UsageTotalRow>()
    for (const row of byDay) {
      const key = `${row.provider}\u0000${row.model}`
      const running = totals.get(key) ?? { provider: row.provider, model: row.model, ...ZERO }
      totals.set(key, {
        provider: row.provider,
        model: row.model,
        uncachedInputTokens: running.uncachedInputTokens + row.uncachedInputTokens,
        outputTokens: running.outputTokens + row.outputTokens,
        cacheReadTokens: running.cacheReadTokens + row.cacheReadTokens,
        cacheWriteTokens: running.cacheWriteTokens + row.cacheWriteTokens,
        turns: running.turns + row.turns,
      })
    }
    const totalsList = [...totals.values()].sort((left, right) => total(right) - total(left))
    // The calendar reads ALL time, whatever window the charts are showing: a
    // rhythm question ("which days do I burn tokens on") is not the same
    // question as "what did this week cost", and re-shaping the calendar every
    // time the reader moves the range would answer neither.
    const heat = (this.#db.prepare(`
      SELECT day, sum(uncached_input + output + cache_read + cache_write) AS total, sum(turns) AS turns
      FROM usage_bucket GROUP BY day ORDER BY day
    `).all() as { day: string, total: number, turns: number }[]).map(row => ({
      day: String(row.day),
      total: Number(row.total),
      turns: Number(row.turns),
    }))
    const scanned = this.#db.prepare('SELECT value FROM usage_meta WHERE key = ?').get('scannedAt') as { value: string } | undefined
    const built = this.#db.prepare('SELECT count(*) AS n FROM usage_cursor').get() as { n: number } | undefined
    return {
      built: (built?.n ?? 0) > 0,
      days,
      scannedAt: scanned?.value ?? null,
      today: localDay(new Date()),
      daysList: [...new Set(byDay.map(row => row.day))].sort(),
      models: totalsList.map(row => routeName(row)),
      byDay,
      totals: totalsList,
      heat,
    }
  }

  close(): void {
    this.#db.close()
  }
}

/** Every bucket summed — the pie's measure and the table's sort key. */
export function total(buckets: UsageBuckets): number {
  return buckets.uncachedInputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens
}

/** How a route is named in the UI and in the response's `models` list. */
export function routeName(route: { provider: string; model: string }): string {
  return `${route.provider}/${route.model}`
}

/** `YYYY-MM-DD` in the host's local time. */
export function localDay(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${String(at.getFullYear())}-${month}-${day}`
}

/** Open (or reuse) the index at one path. */
export function openUsageStore(path: string): UsageStore {
  const key = path === ':memory:' ? path : resolve(path)
  const existing = stores.get(key)
  if (existing !== undefined) return existing
  if (key !== ':memory:') mkdirSync(dirname(key), { recursive: true })
  const store = new UsageStore(key)
  stores.set(key, store)
  return store
}

/** Close and forget one path's index; the plugin's teardown path. */
export function closeUsageStore(path: string): void {
  const key = path === ':memory:' ? path : resolve(path)
  stores.get(key)?.close()
  stores.delete(key)
}
