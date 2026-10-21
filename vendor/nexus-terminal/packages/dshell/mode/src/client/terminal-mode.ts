/**
 * The browser half of the terminal-session identity table: a mirror of the
 * host's records, plus the write path the section and the composer use.
 *
 * The mirror is a service so every dshell client registration gates on one
 * reading instead of fetching for itself; a mutation resolves to a POST and the
 * host's answer republishes the whole table, which is what wakes the view-tab
 * and composer registrations that wait on it.
 *
 * The id arrays beside `records` are derived, not a second copy of the truth:
 * membership, the archive bit and the started bit are read as sets in far more
 * places than the rest of a record is, and deriving them here keeps those reads
 * one `includes` instead of a `find` at every call site.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import {
  DSHELL_TERMINAL_MODE_PATH,
  type TerminalComposerMode, type TerminalModeRequest, type TerminalModeResponse,
  type TerminalSessionOrigin, type TerminalSessionRecord,
} from '../terminal-mode-protocol.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Mirror of the host's terminal-session identity table. */
    dshellTerminalMode: TerminalModeClient
  }
}

/** The committed table as the browser sees it. */
export interface TerminalModeSnapshot {
  /** Every terminal session's record, oldest first. */
  readonly records: readonly TerminalSessionRecord[]
  /** The recorded ids, oldest first; derived from `records`. */
  readonly sessions: readonly string[]
  /** The ids carrying dshell's own archive bit; derived from `records`. */
  readonly archived: readonly string[]
  /** The ids that have taken their first input; derived from `records`. */
  readonly started: readonly string[]
  /** The workspace the section was adopted as, once known. */
  readonly workspaceId: string | undefined
  /** Whether the reader folded the section down to the sidebar's foot. */
  readonly folded: boolean
  /** The directory a terminal session is created in; empty until answered. */
  readonly root: string
  /** Whether the host has answered at least once. */
  readonly loaded: boolean
}

const EMPTY: TerminalModeSnapshot = { records: [], sessions: [], archived: [], started: [], workspaceId: undefined, folded: false, root: '', loaded: false }

/** What turning a session on records about it. */
export interface TerminalSessionFacts {
  /** How the session came to be a terminal session. */
  readonly origin?: TerminalSessionOrigin
  /** The directory its shell runs in. */
  readonly cwd?: string
  /** The name to list it under. */
  readonly title?: string
}

/** Mirror of the host's terminal-session table with its mutation path. */
export class TerminalModeClient extends Service {
  private snapshot: TerminalModeSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context) {
    super(ctx, 'dshellTerminalMode')
  }

  getSnapshot = (): TerminalModeSnapshot => this.snapshot

  /** Whether one session is a terminal session. */
  isOn(sessionId: string): boolean {
    return this.snapshot.sessions.includes(sessionId)
  }

  /** One session's record, when the table holds it. */
  record(sessionId: string): TerminalSessionRecord | undefined {
    return this.snapshot.records.find(record => record.sessionId === sessionId)
  }

  /** The persisted way one session's composer reads Enter; `shell` by default. */
  modeOf(sessionId: string): TerminalComposerMode {
    return this.record(sessionId)?.mode ?? 'shell'
  }

  /** The directory a terminal session is created in (the terminal section's path). */
  root(): string {
    return this.snapshot.root
  }

  /** Whether this terminal session is archived in dshell's own bit. */
  isArchived(sessionId: string): boolean {
    return this.snapshot.archived.includes(sessionId)
  }

  /** Remember which workspace the section lives in. */
  async useWorkspace(workspaceId: string): Promise<void> {
    await this.send({ action: 'workspace', workspaceId })
  }

  /** Set dshell's archive bit for one terminal session. */
  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    await this.send({ action: 'archive', sessionId, archived })
  }

  /** Fold or unfold the section. */
  async setFolded(folded: boolean): Promise<void> {
    await this.send({ action: 'fold', folded })
  }

  /** Record that a session took its first input. */
  async markStarted(sessionId: string): Promise<void> {
    await this.send({ action: 'start', sessionId })
  }

  /** Persist which way one session's composer reads Enter. */
  async setMode(sessionId: string, mode: TerminalComposerMode): Promise<void> {
    await this.send({ action: 'mode', sessionId, mode })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Read the committed table once; safe to call again after a transport loss. */
  async load(): Promise<void> {
    await this.send(undefined)
  }

  /**
   * Turn a session into a terminal session or back; resolves once the host
   * commits it.
   * @param sessionId - the dsh session id.
   * @param on - whether the session runs the integrated terminal.
   * @param facts - what the record should say about it; ignored when turning off.
   */
  async set(sessionId: string, on: boolean, facts: TerminalSessionFacts = {}): Promise<void> {
    await this.send({
      action: 'set', sessionId, on,
      ...facts.origin === undefined ? {} : { origin: facts.origin },
      ...facts.cwd === undefined ? {} : { cwd: facts.cwd },
      ...facts.title === undefined ? {} : { title: facts.title },
    })
  }

  private async send(request: TerminalModeRequest | undefined): Promise<void> {
    try {
      const response = await fetch(DSHELL_TERMINAL_MODE_PATH, {
        method: request === undefined ? 'GET' : 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        ...request === undefined ? {} : { body: JSON.stringify(request) },
      })
      const body = await response.json() as TerminalModeResponse
      this.publish(body)
    } catch {
      // A unreachable host leaves the last committed table on screen; the next
      // mutation or load retries.
    }
  }

  private publish(body: TerminalModeResponse): void {
    const records = body.records
    this.snapshot = {
      records,
      sessions: records.map(record => record.sessionId),
      archived: records.filter(record => record.archived === true).map(record => record.sessionId),
      started: records.filter(record => record.started === true).map(record => record.sessionId),
      workspaceId: body.workspaceId,
      folded: body.folded,
      root: body.root,
      loaded: true,
    }
    for (const listener of [...this.listeners]) listener()
  }
}
