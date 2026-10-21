/**
 * The SQLite command-history medium: one database per log directory, holding
 * every session's completed commands.
 *
 * Implements the {@link HistoryStore} contract from `@nexus-aethra/dshell-std`.
 * The engine is Node's built-in `node:sqlite`: no native dependency, no install
 * script, and FTS5 is present on both the host runtime and the packaged desktop
 * runtime (v24.17.0, verified with `sqlite_compileoption_used('ENABLE_FTS5')`),
 * which is what a later full-text search over history would need.
 *
 * Why a table instead of the per-session `.history.json` array this replaces:
 * that array has no index, so a read parsed the whole thing into memory and a
 * write rewrote it in full, and the only way to keep it bounded was to drop the
 * oldest commands at a fixed cap — lossy exactly where a query would want them.
 *
 * Format — `PRAGMA user_version = 3` as the contract declares. Layout 1 carried
 * a third index, `commands_at(at)`, for a cross-session time query that was
 * never built and that nothing read; layout 2 dropped it. Layout 3 adds
 * `command_output`: the per-command output an agent-facing reader addresses by
 * offset, so a long command can be read in slices instead of injected whole.
 * Older layouts are migrated in place, one step at a time; anything unknown is
 * rejected.
 *
 *   commands(session_id, seq, command, command_norm, exit_code, at)
 *     PRIMARY KEY (session_id, seq)
 *       the shell's own numbering, continued across restarts — `clearSession`
 *       deletes a whole session's rows when that session is deleted
 *   commands_session_prefix(session_id, command_norm)
 *   command_output(session_id, seq, output, bytes, dropped)
 *     PRIMARY KEY (session_id, seq)
 *       the retained tail of a command's output, beside the narrow table rather
 *       than in it: the prefix probe reads `commands` rows, and putting
 *       kilobytes of output on them would slow every search for no benefit
 *
 * Outputs are retained for the newest `MAX_STORED_OUTPUTS_PER_SESSION` commands
 * per session. The metadata itself is retained without limit, so evicting an
 * output loses the text, never the fact that the command ran.
 *
 * `command_norm` is the lower-cased command and exists for the prefix index:
 * prefix matching is case-insensitive by design, the way a shell's own history
 * search is. `command` keeps the original text, which is what gets shown and
 * what replaces the draft.
 *
 * Four measured facts shape the queries; each was confirmed with
 * `EXPLAIN QUERY PLAN` and timings against this exact schema at 200k commands
 * in one session:
 *
 * - `LIKE ?` with a bound prefix argument never uses the prefix index: SQLite
 *   refuses the LIKE optimization for a bound parameter, so with a session
 *   filter the plan degrades to `SEARCH … USING INDEX commands_session_prefix
 *   (session_id=?)` — the index serves the session term and every one of that
 *   session's rows is tested against the pattern. The range form
 *   `command_norm >= ? AND command_norm < ?` turns the prefix itself into an
 *   index seek.
 * - The range form alone is not enough, because the index is ordered by
 *   `command_norm` while "the newest matches" is ordered by `seq`: the plan
 *   gains `USE TEMP B-TREE FOR ORDER BY` and sorts *every* match, so a
 *   20k-match prefix cost 9.1 ms and a 10k-match one 4.7 ms. Scanning newest
 *   first instead — the primary key's `(session_id, seq)` order plus
 *   `ORDER BY seq DESC LIMIT` — lets SQLite stop as soon as enough matches are
 *   seen and cost 0.11 ms / 0.23 ms for the same answers. Its budget comes from
 *   {@link prefixScanBudget} and it falls back to the range seek, which is the
 *   cheap one for a sparse prefix (0.005 ms with no match).
 * - `PRAGMA synchronous = NORMAL` under WAL: history is best-effort by an
 *   existing contract ("losing a line of history must never cost the session
 *   anything"), and the session event log owns real durability.
 *
 * The composer's up-arrow gesture sends its draft here (the route maps the wire
 * request onto {@link HistoryStore.matchPrefix}), so the first-character filter
 * that used to run in `mode` — `commonPrefix(command, query) > 0`, which listed
 * `grep -r git .` for a draft of `git` — is gone. Strict prefix is the whole
 * matching rule now, in the store and in the client's fallback window.
 */

import { mkdirSync, openSync, closeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  HISTORY_STORE_SCHEMA_VERSION,
  HistoryStoreError,
  type HistoryRecord,
  type HistoryStore,
} from '@nexus-aethra/dshell-std'

/** The row shape `node:sqlite` hands back for the select statements below. */
interface CommandRow {
  readonly seq: number
  readonly command: string
  readonly exit_code: number | null
  readonly at: number
}

/**
 * How many of a session's newest commands a prefix search scans before it hands
 * over to the range seek.
 *
 * The budget is the point where the two paths cost the same, and that is
 * solvable: a draft whose matches have density `d` makes the scan read
 * `limit / d` rows while the range seek reads — and sorts — `d * N`. Setting
 * them equal gives `budget = sqrt(limit * N * b/a)`, where `b/a` is the measured
 * cost ratio between sorting one match and reading one row
 * ({@link PREFIX_SCAN_BIAS}).
 *
 * A constant cannot do that job. 5000 is the measured optimum at 200k rows in
 * one session (the formula gives ~5.4k there), but at 8k rows it scans 4.3k
 * rows the range seek would never have needed, and at 2M rows it is too small
 * to keep a mid-density prefix off the sort.
 *
 * `newestSeq` is the session's own command counter, which continues across
 * restarts, so it stands in for N without another query — and it over-counts
 * after a deletion, which only widens the budget. Widening is harmless: the
 * scan is bounded by the table, not by the budget, so a budget larger than the
 * session simply reads the whole session.
 */
function prefixScanBudget(limit: number, newestSeq: number): number {
  // `max(newestSeq, limit)` keeps a brand-new shell's first search honest: a
  // budget below `limit` could never satisfy the scan's early exit.
  const atCrossing = Math.sqrt(limit * Math.max(newestSeq, limit) * PREFIX_SCAN_BIAS)
  return Math.max(Math.ceil(atCrossing), MIN_PREFIX_SCAN_BUDGET)
}

/** Measured `b/a`: sorting one match costs about as much as 2.5 row reads. */
const PREFIX_SCAN_BIAS = 2.5

/** Floor for a tiny session, where the formula would drop below useful. */
const MIN_PREFIX_SCAN_BUDGET = 200

/** How many commands' outputs one session keeps; older outputs are evicted. */
const MAX_STORED_OUTPUTS_PER_SESSION = 1_000

/**
 * The exclusive upper bound of every string starting with `prefix`.
 *
 * Returns undefined when no bound exists (a prefix of only U+FFFF units), which
 * the caller answers with an open-ended range.
 */
function prefixUpperBound(prefix: string): string | undefined {
  let end = prefix.length
  while (end > 0 && prefix.charCodeAt(end - 1) === 0xffff) end -= 1
  if (end === 0) return undefined
  const last = prefix.charCodeAt(end - 1)
  return prefix.slice(0, end - 1) + String.fromCharCode(last + 1)
}

/** Create the database file owner-only before SQLite opens it by path. */
function createFilePrivate(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    // Command history routinely contains secrets typed on a command line, and
    // the surrounding log directory is group- and world-readable by default.
    closeSync(openSync(path, 'wx', 0o600))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** The output table's DDL, shared by the fresh and the migrating paths. */
const OUTPUT_TABLE = `
  CREATE TABLE IF NOT EXISTS command_output (
    session_id TEXT    NOT NULL,
    seq        INTEGER NOT NULL,
    output     TEXT    NOT NULL,
    bytes      INTEGER NOT NULL,
    dropped    INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
  );`

/** Apply pragmas and the schema, migrating every known older layout. */
function initSchema(db: DatabaseSync, path: string): void {
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const version = Number(row?.user_version ?? 0)
  if (version === HISTORY_STORE_SCHEMA_VERSION) return
  if (version !== 0 && version !== 1 && version !== 2) {
    throw new HistoryStoreError('version-mismatch', `${path} carries history layout ${String(version)}, expected ${String(HISTORY_STORE_SCHEMA_VERSION)}`)
  }
  // Step through the layouts rather than jumping: each migration is the whole
  // difference between two versions, so an old file lands on the current shape
  // with nothing skipped.
  if (version === 1) {
    // Layout 1 carried `commands_at(at)` for a cross-session time query that was
    // never built: nothing selected by it, so dropping it is the whole step.
    db.exec('DROP INDEX IF EXISTS commands_at')
  }
  db.exec(version === 0
    ? `
      CREATE TABLE commands (
        session_id   TEXT    NOT NULL,
        seq          INTEGER NOT NULL,
        command      TEXT    NOT NULL,
        command_norm TEXT    NOT NULL,
        exit_code    INTEGER,
        at           INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX commands_session_prefix ON commands (session_id, command_norm);
      ${OUTPUT_TABLE}
    `
    // Layout 2 has the commands table already; the output table is the whole
    // step. `IF NOT EXISTS` makes 1 → 3 and 2 → 3 the same statement.
    : OUTPUT_TABLE)
  db.exec(`PRAGMA user_version = ${String(HISTORY_STORE_SCHEMA_VERSION)}`)
}

/** Map a database row to the contract's record shape. */
function toRecord(row: CommandRow): HistoryRecord {
  return {
    seq: Number(row.seq),
    command: String(row.command),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    at: Number(row.at),
  }
}

/**
 * Reinterpret `node:sqlite`'s `Record<string, SQLOutputValue>` rows as the
 * column shape the select statements above project. The driver types every row
 * as a generic record because it cannot know the projection; the statements are
 * written next to this function, so the shape is true by construction.
 */
function asRows(values: readonly unknown[]): CommandRow[] {
  return values as unknown as CommandRow[]
}

/** Open the database at `path` and prepare its statements. */
function openStore(path: string): HistoryStore {
  let db: DatabaseSync
  try {
    if (path !== ':memory:') createFilePrivate(path)
    db = new DatabaseSync(path)
    initSchema(db, path)
  }
  catch (error) {
    if (error instanceof HistoryStoreError) throw error
    throw new HistoryStoreError('open-failed', `${path}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO commands (session_id, seq, command, command_norm, exit_code, at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const newest = db.prepare(`
    SELECT seq, command, exit_code, at FROM commands
    WHERE session_id = ? ORDER BY seq DESC LIMIT ?
  `)
  const band = db.prepare(`
    SELECT seq, command, exit_code, at FROM commands
    WHERE session_id = ? AND command_norm >= ? AND command_norm < ?
    ORDER BY seq DESC LIMIT ?
  `)
  const bandOpen = db.prepare(`
    SELECT seq, command, exit_code, at FROM commands
    WHERE session_id = ? AND command_norm >= ?
    ORDER BY seq DESC LIMIT ?
  `)
  // The newest-first variants: `seq > ?` keeps the primary key's
  // `(session_id, seq)` order usable, so ORDER BY seq DESC needs no sort and
  // LIMIT stops the scan early.
  const bounded = db.prepare(`
    SELECT seq, command, exit_code, at FROM commands
    WHERE session_id = ? AND seq > ? AND command_norm >= ? AND command_norm < ?
    ORDER BY seq DESC LIMIT ?
  `)
  const boundedOpen = db.prepare(`
    SELECT seq, command, exit_code, at FROM commands
    WHERE session_id = ? AND seq > ? AND command_norm >= ?
    ORDER BY seq DESC LIMIT ?
  `)
  const head = db.prepare('SELECT max(seq) AS s FROM commands WHERE session_id = ?')
  const drop = db.prepare('DELETE FROM commands WHERE session_id = ?')
  const tally = db.prepare('SELECT count(*) AS n FROM commands WHERE session_id = ?')
  const insertOutput = db.prepare(`
    INSERT OR REPLACE INTO command_output (session_id, seq, output, bytes, dropped)
    VALUES (?, ?, ?, ?, ?)
  `)
  const readOutputRow = db.prepare(`
    SELECT output, bytes, dropped FROM command_output WHERE session_id = ? AND seq = ?
  `)
  const dropOutputs = db.prepare('DELETE FROM command_output WHERE session_id = ?')
  const pruneOutputs = db.prepare('DELETE FROM command_output WHERE session_id = ? AND seq <= ?')
  let closed = false

  return {
    path,

    append(sessionId, commands, outputs) {
      if (closed || (commands.length === 0 && (outputs?.length ?? 0) === 0)) return
      // One transaction per batch: the caller hands over a burst of finished
      // commands, and WAL makes the group barely more expensive than one row.
      // Lines and outputs share it so a reader never sees one landed alone.
      db.exec('BEGIN')
      try {
        for (const item of commands) {
          insert.run(sessionId, item.seq, item.command, item.command.toLowerCase(), item.exitCode, item.at)
        }
        for (const item of outputs ?? []) {
          insertOutput.run(sessionId, item.seq, item.text, item.bytes, item.dropped)
        }
        // Evict the oldest outputs past the per-session retention. The `seq` of
        // the newest row in this batch is the high-water mark; everything at or
        // below the window's floor goes, in one indexed range delete.
        const newest = commands.reduce((max, item) => Math.max(max, item.seq), 0)
        const floor = newest - MAX_STORED_OUTPUTS_PER_SESSION
        if (floor > 0) pruneOutputs.run(sessionId, floor)
        db.exec('COMMIT')
      }
      catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    readOutput(sessionId, seq, offset, limit) {
      if (closed || limit <= 0) return undefined
      const row = readOutputRow.get(sessionId, seq) as
        | { output?: unknown; bytes?: unknown; dropped?: unknown }
        | undefined
      if (row === undefined || typeof row.output !== 'string') return undefined
      const bytes = Buffer.from(row.output, 'utf8')
      const total = bytes.length
      // Snap both edges to UTF-8 character boundaries, so paging with a
      // byte `limit` never hands back half a character at a seam.
      let from = Math.min(Math.max(0, Math.trunc(offset)), total)
      while (from < total && (bytes[from]! & 0b1100_0000) === 0b1000_0000) from += 1
      let end = Math.min(from + Math.max(0, Math.trunc(limit)), total)
      while (end > from && end < total && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1
      return {
        text: bytes.subarray(from, end).toString('utf8'),
        bytes: Number(row.bytes ?? total),
        dropped: Number(row.dropped ?? 0),
        offset: from,
        total,
        truncated: end < total,
      }
    },

    recent(sessionId, limit) {
      if (closed || limit <= 0) return []
      // The statement orders newest-first so LIMIT keeps the newest; the shell
      // wants them oldest-first, which is a reverse of a bounded array.
      return asRows(newest.all(sessionId, limit)).map(toRecord).reverse()
    },

    matchPrefix(sessionId, draft, limit) {
      if (closed || limit <= 0) return []
      const norm = draft.toLowerCase()
      if (norm.length === 0) return this.recent(sessionId, limit)
      // Strict prefix, not a descending probe: under `startsWith` every match
      // shares the whole draft, so "longest shared prefix" has nothing to rank —
      // recency is the only meaningful order. (Ranking by partial overlap would
      // be fuzzy matching, where `grep` deserves to sit below `git` for a draft
      // of `g`; that is a different query and belongs with the caller, over a
      // bounded candidate set.)
      const upper = prefixUpperBound(norm)
      // Newest-first first: the answer is the newest `limit` matches, and the
      // primary key's order is already the order they are wanted in, so the scan
      // can stop the moment it has enough. `limit` matches inside the newest
      // budget *are* the newest `limit` matches, which is why this path needs no
      // tie-break with the range query below.
      const newestSeq = (head.get(sessionId) as { s?: number | null } | undefined)?.s ?? null
      if (newestSeq !== null) {
        const floor = newestSeq - prefixScanBudget(limit, newestSeq)
        const scanned = asRows(upper === undefined
          ? boundedOpen.all(sessionId, floor, norm, limit)
          : bounded.all(sessionId, floor, norm, upper, limit))
        if (scanned.length >= limit) return scanned.map(toRecord).reverse()
      }
      // Sparse or absent prefix: the range seek answers from the index, and with
      // few matches the sort the plan adds costs nothing.
      return asRows(upper === undefined
        ? bandOpen.all(sessionId, norm, limit)
        : band.all(sessionId, norm, upper, limit)).map(toRecord).reverse()
    },

    clearSession(sessionId) {
      if (closed) return
      drop.run(sessionId)
      dropOutputs.run(sessionId)
    },

    count(sessionId) {
      if (closed) return 0
      const row = tally.get(sessionId) as { n?: number } | undefined
      return Number(row?.n ?? 0)
    },

    close() {
      if (closed) return
      closed = true
      stores.delete(path)
      try {
        // Standard practice before closing: let the planner keep statistics it
        // has gathered (and gather them now if the shapes changed), then fold
        // the write-ahead log back so teardown leaves no sidecar beside the
        // log directory. Both are best-effort — closing is the job.
        db.exec('PRAGMA optimize')
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      }
      catch {
        // An unavailable optimization is not a failed close.
      }
      try {
        db.close()
      }
      catch {
        // Closing a handle whose file is already gone is not a caller problem.
      }
    },
  }
}

/** Open stores by path, so every session in one process shares a handle. */
const stores = new Map<string, HistoryStore>()

/**
 * Open (or reuse) the store for one database path.
 *
 * Sessions in one process share a single handle: a per-session connection would
 * multiply file handles and turn concurrent writes into lock contention for no
 * benefit, since `node:sqlite` is synchronous.
 * @param path - Database file path, or `:memory:` for a throwaway store.
 * @returns The shared store.
 * @throws {HistoryStoreError} when the file cannot be opened or its layout differs.
 */
export function openHistoryStore(path: string): HistoryStore {
  const key = path === ':memory:' ? path : resolve(path)
  const existing = stores.get(key)
  if (existing !== undefined) return existing
  const store = openStore(key)
  stores.set(key, store)
  return store
}

/** Close and forget one path's store; the bridge teardown path. */
export function closeHistoryStore(path: string): void {
  const key = path === ':memory:' ? path : resolve(path)
  stores.get(key)?.close()
}
