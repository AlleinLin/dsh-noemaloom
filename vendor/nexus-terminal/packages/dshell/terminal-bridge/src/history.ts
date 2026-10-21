/**
 * The command history a session's shell keeps across boots.
 *
 * The bridge's in-memory records are per boot: a restart respawns the shell and
 * the composer's up-arrow list would start empty even though the terminal view
 * replays its own scrollback from disk. This is that missing half — the command
 * lines, their exit status and their time.
 *
 * The durable form is `history-store.ts`: one SQLite database for the whole
 * harness home, keyed by session. This class is the facade the bridge drives —
 * a bounded in-memory window for the keystroke path (unchanged from the JSON
 * days, so the up-arrow gesture costs no query) over a store that keeps every
 * command and can answer prefix matches.
 *
 * A store that cannot be opened degrades instead of failing: the class falls
 * back to the legacy per-session `.history.json` beside the PTY log, which is
 * also where an upgrading installation's history is read from exactly once.
 * History is a convenience; losing it must never cost the session anything.
 */

import { existsSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { openHistoryStore } from '@nexus-aethra/dshell-storage'
import { HISTORY_STORE_FILENAME, type HistoryOutputRecord, type HistoryOutputSlice, type HistoryRecord, type HistoryStore } from '@nexus-aethra/dshell-std'
import { writePrivate } from './private-file.js'

/** Completed commands retained per session; the live array's cap too. */
export const MAX_COMMAND_HISTORY = 200

/** How long writes coalesce before touching the disk (legacy JSON path only). */
const SAVE_DELAY_MS = 400

/** One recorded command — the std storage contract's shape, under its old name. */
export type PersistedCommand = HistoryRecord

/** Where one session's history lives: beside its PTY log. */
export function commandHistoryPath(logPath: string): string {
  return `${logPath}.history.json`
}

/**
 * Where the durable store lives: one database per log directory, shared by every
 * session under it. Sitting beside the logs (rather than per session) is what
 * makes cross-session queries possible later without a second path convention.
 */
export function historyStorePath(logPath: string): string {
  return join(dirname(logPath), HISTORY_STORE_FILENAME)
}

/**
 * Drop one session's stored history without needing a live shell record.
 *
 * `CommandHistory.clear` is the in-record path; this is the one a session
 * deletion uses when there is no record to ask — a session deleted before its
 * terminal was ever opened. A store that was never created is left uncreated
 * rather than opened only to delete nothing from it, and a store that cannot be
 * opened keeps whatever it holds: the session is going away regardless.
 */
export function forgetSessionHistory(logPath: string, sessionId: string): void {
  const path = historyStorePath(logPath)
  if (!existsSync(path)) return
  try {
    openHistoryStore(path).clearSession(sessionId)
  }
  catch {
    // Best effort, like an append: history must never cost the session.
  }
}

/** One entry as written; anything malformed is dropped rather than trusted. */
function asCommand(value: unknown): PersistedCommand | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as { seq?: unknown; command?: unknown; exitCode?: unknown; at?: unknown }
  if (typeof raw.command !== 'string' || raw.command.trim().length === 0) return undefined
  return {
    seq: typeof raw.seq === 'number' && Number.isFinite(raw.seq) ? raw.seq : 0,
    command: raw.command,
    exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0,
  }
}

/**
 * The retained command list of one session, loaded at spawn and kept in sync.
 *
 * `sessionId` is the store key; `path` is the legacy JSON file, which is read
 * once to seed the store and written only when the store is unusable.
 */
export class CommandHistory {
  private entries: PersistedCommand[] = []
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private store: HistoryStore | undefined

  constructor(
    private readonly sessionId: string,
    private readonly path: string | undefined,
  ) {}

  /**
   * Load what the previous shell left, preferring the store over the file.
   *
   * A store that opens takes over: its newest `MAX_COMMAND_HISTORY` commands
   * fill the window, and a legacy file for a session the store has never seen
   * is imported first (idempotent by `(session_id, seq)`, so a crash mid-import
   * is not a problem). A store that cannot be opened leaves this instance
   * reading and writing the legacy file exactly as before.
   */
  async load(): Promise<void> {
    if (this.path === undefined) return
    try {
      this.store = openHistoryStore(historyStorePath(this.path))
    }
    catch {
      // Unusable store (read-only home, a foreign layout version, no sqlite):
      // stay on the file rather than losing history altogether.
      this.store = undefined
    }
    if (this.store === undefined) {
      await this.loadFile()
      return
    }
    if (this.store.count(this.sessionId) === 0) await this.importFile()
    this.entries = this.store.recent(this.sessionId, MAX_COMMAND_HISTORY)
  }

  /** The retained commands, oldest first. */
  list(): readonly PersistedCommand[] {
    return this.entries
  }

  /**
   * The newest commands whose line starts with `draft` (case-insensitively),
   * oldest first.
   *
   * The store answers whenever it is open, and that is the point of this
   * method: the window is only the newest `MAX_COMMAND_HISTORY` commands, so a
   * window filter could never surface an older match. The window is the
   * fallback for an unusable store, under the same strict prefix.
   */
  match(draft: string, limit: number): readonly PersistedCommand[] {
    if (limit <= 0) return []
    const norm = draft.toLowerCase()
    if (this.store !== undefined) {
      try {
        return this.store.matchPrefix(this.sessionId, norm, limit)
      }
      catch {
        // Best effort, as an append is: fall through to the window.
      }
    }
    const matched = norm.length === 0
      ? this.entries
      : this.entries.filter(command => command.command.toLowerCase().startsWith(norm))
    return matched.slice(-limit)
  }

  /** Add closed commands, newest last, and persist them. */
  append(commands: readonly PersistedCommand[], outputs?: readonly HistoryOutputRecord[]): void {
    if (commands.length === 0 && (outputs?.length ?? 0) === 0) return
    this.entries.push(...commands)
    this.trim()
    if (this.store !== undefined) {
      try {
        this.store.append(this.sessionId, commands, outputs)
      }
      catch {
        // Best effort, as the file write was: a failed insert must not take the
        // shell down, and the next append retries the same way.
      }
      return
    }
    this.schedule()
  }

  /**
   * A window onto one command's stored output.
   *
   * Answers only when the store is open: without one there is nothing to page
   * through, and the caller falls back to the in-memory window's display text.
   */
  output(seq: number, offset: number, limit: number): HistoryOutputSlice | undefined {
    if (this.store === undefined) return undefined
    try {
      return this.store.readOutput(this.sessionId, seq, offset, limit)
    }
    catch {
      // Best effort, as every other store call is.
      return undefined
    }
  }

  /**
   * Drop everything — the session-deletion path: the session is going away for
   * good, so the store must not keep handing its commands to a later query and
   * the legacy file must not resurrect them at a boot that follows.
   *
   * The delete is immediate rather than debounced: deletion happens at
   * teardown, where a pending timer would race the process exit it is part of.
   */
  clear(): void {
    this.entries = []
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    if (this.store !== undefined) {
      try {
        this.store.clearSession(this.sessionId)
      }
      catch {
        // Same best-effort contract as an append.
      }
      // The legacy file is deleted, not emptied, and synchronously: leaving it
      // behind — even for a moment, or past a process exit right here — would
      // let a later boot's import hand the cleared commands back.
      if (this.path !== undefined) {
        try {
          rmSync(this.path, { force: true })
        }
        catch {
          // Same best-effort contract: a clear that cannot unlink a stale file
          // still cleared the store, which is the copy that is read.
        }
      }
      return
    }
    this.schedule()
  }

  /** Write now, cancelling any pending debounce (teardown path). */
  async flush(): Promise<void> {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    if (this.store !== undefined) return
    await this.save()
  }

  /** Read the legacy file; a missing or broken one starts empty. */
  private async loadFile(): Promise<void> {
    if (this.path === undefined) return
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!Array.isArray(parsed)) return
      for (const value of parsed) {
        const command = asCommand(value)
        if (command !== undefined) this.entries.push(command)
      }
      this.trim()
    } catch {
      // No history yet (or an unreadable one): an empty list is a valid start.
    }
  }

  /** Seed the store from the legacy file, once per session. */
  private async importFile(): Promise<void> {
    if (this.path === undefined || this.store === undefined) return
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.path, 'utf8'))
    }
    catch {
      return
    }
    if (!Array.isArray(parsed)) return
    const commands = parsed.map(asCommand).filter((command): command is PersistedCommand => command !== undefined)
    if (commands.length === 0) return
    try {
      this.store.append(this.sessionId, commands)
    }
    catch {
      // Leave the file in place: the next boot retries the import.
    }
  }

  private trim(): void {
    if (this.entries.length > MAX_COMMAND_HISTORY) {
      this.entries.splice(0, this.entries.length - MAX_COMMAND_HISTORY)
    }
  }

  private schedule(): void {
    if (this.path === undefined || this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.save()
    }, SAVE_DELAY_MS)
  }

  private async save(): Promise<void> {
    if (this.path === undefined) return
    await writePrivate(this.path, JSON.stringify(this.entries))
      .catch(() => { /* best effort: history outlives nothing if the write fails */ })
  }
}
