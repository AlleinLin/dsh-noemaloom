/**
 * The storage contract: what a dshell store *is*, with no medium attached.
 *
 * dshell has one durable store for shell history today and a reason to expect
 * more (agent-facing records that want indexes). The split that keeps that from
 * becoming each feature's private file format:
 *
 *   - **the contract** lives here — the record shape, the store surface, the
 *     on-disk naming and layout version, and the failure vocabulary;
 *   - **the medium** lives in `@nexus-aethra/dshell-storage` (`node:sqlite`);
 *   - **a feature** only calls the store, and never names a file, a pragma or a
 *     schema.
 *
 * Nothing here may import a Node builtin: `std` is inlined into client bundles,
 * so this file has to stay an isomorphic declaration. The engine is host-only
 * for exactly that reason — `node:sqlite` cannot cross into a browser bundle.
 */

/** File name of the shared database inside a log directory. */
export const HISTORY_STORE_FILENAME = 'history.sqlite'

/**
 * Physical layout version of the history database, stamped in
 * `PRAGMA user_version`.
 *
 * The engine migrates the layouts it knows: 1 dropped `commands_at(at)`, an
 * index for a cross-session time query that was never built and that nothing
 * read; 2 added `command_output`, the per-command output the agent-facing read
 * tool addresses by offset. A database stamped with anything else is rejected:
 * this code is the only producer, and history is a convenience the user may
 * lose without losing a session.
 */
export const HISTORY_STORE_SCHEMA_VERSION = 3

/** Why a store could not be used; the caller decides whether to fall back. */
export type HistoryStoreErrorCode = 'open-failed' | 'version-mismatch'

/** A store that cannot be opened, or was written by another layout. */
export class HistoryStoreError extends Error {
  constructor(readonly code: HistoryStoreErrorCode, message: string) {
    super(message)
    this.name = 'HistoryStoreError'
  }
}

/**
 * One completed command, as stored.
 *
 * The shape every producer already had; it is a contract now because both the
 * writer (the terminal bridge) and the readers (the history route, and later an
 * agent-facing query) have to agree on it without importing each other.
 */
export interface HistoryRecord {
  /** Monotonic within the shell generation that produced it. */
  readonly seq: number
  /** The line as the user ran it; this is what a caller shows and re-applies. */
  readonly command: string
  /** The shell's exit status, or null when it never reported one. */
  readonly exitCode: number | null
  /** Epoch ms the command finished. */
  readonly at: number
}

/**
 * One command's output, as stored.
 *
 * Output is kept as a single contiguous tail: a command that produced more than
 * the medium retains keeps its *end* (where an error explains itself) and says
 * how much is missing from the front. Offsets are therefore relative to
 * {@link text}, and {@link dropped} is what a reader must be told before it
 * trusts offset 0 to be the beginning of anything.
 */
export interface HistoryOutput {
  /** Retained output, truncated from the front — no marker text of its own. */
  readonly text: string
  /** Total bytes the command produced, before any truncation. */
  readonly bytes: number
  /** Bytes missing from the front of {@link text}. */
  readonly dropped: number
}

/** One command's output plus the seq it belongs to, as written. */
export interface HistoryOutputRecord extends HistoryOutput {
  readonly seq: number
}

/** A window onto one stored command output. */
export interface HistoryOutputSlice extends HistoryOutput {
  /** Where {@link text} starts inside the retained output. */
  readonly offset: number
  /** Bytes of retained output in total, so a caller can page to the end. */
  readonly total: number
  /** The window ends before the retained output does. */
  readonly truncated: boolean
}

/**
 * The durable history of every session under one store.
 *
 * Deliberately small and query-shaped rather than a generic KV: the two things
 * the feature needs — the newest N of one session, and the commands sharing a
 * prefix with what the user has typed — are exactly the two operations a medium
 * can index for. A `loadAll`-style surface would put the whole history in memory
 * on every read, which is the problem this store exists to remove.
 *
 * `sessionId` is the caller's own session identity; a store keys rows by it.
 */
export interface HistoryStore {
  /** Absolute path of the backing medium, for diagnostics. */
  readonly path: string
  /**
   * Insert a batch; an already-stored `(session, seq)` is left as it is.
   *
   * `outputs` are the matching outputs for the same batch, when the caller has
   * them: a command's line and its output are written together so a reader can
   * never see one landed and the other lost. The medium may retain fewer
   * outputs than commands (see {@link readOutput}); an omitted output is simply
   * one no reader can fetch.
   */
  append(
    sessionId: string,
    commands: readonly HistoryRecord[],
    outputs?: readonly HistoryOutputRecord[] | undefined,
  ): void
  /** The newest `limit` commands of one session, oldest first. */
  recent(sessionId: string, limit: number): HistoryRecord[]
  /**
   * Commands that *start with* `draft`, case-insensitively — the newest `limit`
   * of them, in timeline order.
   *
   * Timeline order (oldest first) is the same convention as {@link recent}, so a
   * caller filters a history without reordering it: the shell's own gesture
   * shows the newest command at the bottom and walks upward into the past.
   *
   * Strict prefix on purpose: every match shares the whole draft, so there is
   * no "longer prefix" left to rank by — recency is the only meaningful order,
   * and one range query answers it. An empty draft has no prefix at all, so it
   * answers as {@link recent}.
   *
   * Fuzzy ranking (a draft of `g` listing `git …` above `grep …`) is a different
   * query: the caller ranks a bounded candidate set by shared-prefix length.
   */
  matchPrefix(sessionId: string, draft: string, limit: number): HistoryRecord[]
  /**
   * One command's output, `limit` bytes from `offset` into the retained text.
   *
   * Answers `undefined` when the medium has no output for that `(session, seq)`
   * — never written, already evicted, or written before the layout that added
   * outputs. Callers report that as "not retained" rather than as empty output.
   *
   * `limit <= 0` answers nothing and a negative `offset` reads as 0, so a caller
   * cannot page backwards out of the retained window.
   */
  readOutput(sessionId: string, seq: number, offset: number, limit: number): HistoryOutputSlice | undefined
  /** Drop one session's history — the session itself is gone. */
  clearSession(sessionId: string): void
  /** How many commands one session has stored. */
  count(sessionId: string): number
  /** Release the medium. Idempotent. */
  close(): void
}
