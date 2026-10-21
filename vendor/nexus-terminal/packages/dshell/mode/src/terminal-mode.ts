/**
 * The terminal-session identity table: host half.
 *
 * One record per terminal session, keyed by the dsh session id, in a JSON
 * document under the data root. The record is the whole of dshell's durable
 * knowledge about the session — dsh's own header carries the cwd and the title
 * and survives on its own, but nothing in it says "this session is a terminal",
 * and a plugin cannot add a field to it (see `terminal-mode-protocol.ts` for
 * the three doors that are closed).
 *
 * Three properties are load-bearing, and each one is a hole this table closes:
 *
 * - The write is a temp file plus `rename`, so a crash mid-write cannot leave a
 *   truncated document. The previous whole-file `writeFile` could, and the read
 *   path answered an unparsable document with an empty one — every terminal
 *   session lost its identity at once, silently. A document that fails to parse
 *   is now kept aside and reported instead of being replaced.
 * - Every mutation runs on one serialized chain, so two toggles in flight cannot
 *   each read the document, change one field, and write the whole thing back.
 * - The table is registered in the data root's move list, so choosing a
 *   different data directory carries it.
 *
 * Reconciliation is what keeps the table from growing forever: it is checked
 * against dsh's own session catalog at start-up, and a record whose session is
 * gone moves to `orphans` rather than being deleted. Orphans are not restored
 * and not shown; they survive exactly one reconciliation, which is the window
 * in which a catalog read that answered too little can be corrected by the next
 * start-up instead of having destroyed the identity.
 *
 * The registry is a service so sibling host packages (the bridge, the context
 * window) can gate on it without importing this package, and a fetch route so
 * the browser half mirrors it the same way the device registry does.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import {
  DSHELL_TERMINAL_MODE_PATH, DSHELL_TERMINAL_MODE_SERVICE,
  type TerminalComposerMode, type TerminalModeRequest, type TerminalModeResponse,
  type TerminalSessionOrigin, type TerminalSessionRecord,
} from './terminal-mode-protocol.js'

/** The document's on-disk shape. */
interface TerminalModeDocument {
  readonly version: 2
  readonly records: readonly TerminalSessionRecord[]
  readonly orphans: readonly TerminalSessionRecord[]
  readonly workspaceId?: string
  readonly folded?: boolean
}

/** The id-list document this table replaced, read only to adopt it. */
interface LegacyDocument {
  readonly sessions?: readonly string[]
  readonly archived?: readonly string[]
  readonly started?: readonly string[]
  readonly workspaceId?: string
  readonly folded?: boolean
}

/** What the registry needs from the rest of the host. */
export interface TerminalModeRegistryDeps {
  /**
   * The session ids dsh still has, persisted ones included. Undefined — or a
   * call that throws — means "this deployment cannot answer", and reconciliation
   * is skipped rather than guessing that every session is gone.
   */
  readonly catalog?: () => Promise<readonly string[] | undefined>
  /** Called with the ids one reconciliation moved out of the table. */
  readonly onOrphan?: (sessionIds: readonly string[]) => void
}

/** Whether a value is one of the two composer modes. */
function isMode(value: unknown): value is TerminalComposerMode {
  return value === 'shell' || value === 'agent'
}

/** Whether a value is one of the recorded origins. */
function isOrigin(value: unknown): value is TerminalSessionOrigin {
  return value === 'section' || value === 'workspace' || value === 'legacy'
}

/**
 * One record with the archive bit removed.
 *
 * Absence is the off state — a record never carries `archived: false` — so
 * clearing the bit drops the key. Writing a falsy one instead would survive the
 * round trip as a field that says nothing, and `readRecord` would keep it.
 * @param record - the record to copy.
 * @returns the copy, unarchived.
 */
function unarchived(record: TerminalSessionRecord): TerminalSessionRecord {
  const { archived: _archived, ...rest } = record
  return rest
}

/** One record read back from the document, with every field checked. */
function readRecord(value: unknown): TerminalSessionRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0) return undefined
  if (!isOrigin(raw.origin) || typeof raw.createdAt !== 'number') return undefined
  return {
    sessionId: raw.sessionId,
    origin: raw.origin,
    createdAt: raw.createdAt,
    ...typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {},
    ...typeof raw.title === 'string' ? { title: raw.title } : {},
    ...raw.archived === true ? { archived: true } : {},
    ...raw.started === true ? { started: true } : {},
    ...isMode(raw.mode) ? { mode: raw.mode } : {},
  }
}

/** Read a record array, dropping entries that are not records. */
function readRecords(value: unknown): TerminalSessionRecord[] {
  if (!Array.isArray(value)) return []
  const records: TerminalSessionRecord[] = []
  for (const item of value) {
    const record = readRecord(item)
    if (record !== undefined && !records.some(known => known.sessionId === record.sessionId)) {
      records.push(record)
    }
  }
  return records
}

/** The identity table, durable across host restarts and mirrored to every browser. */
export class TerminalModeRegistry {
  private records: TerminalSessionRecord[] = []
  private orphans: TerminalSessionRecord[] = []
  private workspace: string | undefined
  private foldedState = false
  private readonly listeners = new Set<() => void>()
  private loaded: Promise<void> | undefined
  /** The tail of the mutation chain; every write runs after the one before. */
  private chain: Promise<void> = Promise.resolve()

  /**
   * @param file - the durable identity document.
   * @param root - the directory terminal sessions are created in (the terminal
   *   section's workspace path); reported to the browser, which adopts it.
   * @param deps - the session catalog reconciliation reads, and its reporter.
   */
  constructor(
    private readonly file: string,
    readonly root: string,
    private readonly deps: TerminalModeRegistryDeps = {},
  ) {}

  /** The service key the registry is provided under. */
  static readonly service = DSHELL_TERMINAL_MODE_SERVICE

  /** Whether one session is a terminal session. */
  isOn(sessionId: string): boolean {
    return this.records.some(record => record.sessionId === sessionId)
  }

  /** Every record, oldest first. */
  list(): readonly TerminalSessionRecord[] {
    return this.records
  }

  /** One session's record, when the table holds it. */
  record(sessionId: string): TerminalSessionRecord | undefined {
    return this.records.find(record => record.sessionId === sessionId)
  }

  /** The recorded terminal-session ids, oldest first. */
  snapshot(): readonly string[] {
    return this.records.map(record => record.sessionId)
  }

  /** The workspace the terminal section was adopted as, once known. */
  get workspaceId(): string | undefined {
    return this.workspace
  }

  /** Whether the reader folded the section down to the sidebar's foot. */
  get folded(): boolean {
    return this.foldedState
  }

  /**
   * Record or drop one session's identity; resolves once the document holds it.
   * @param sessionId - the dsh session id.
   * @param on - whether the session is a terminal session.
   * @param facts - the origin and, when known, the cwd and title; an existing
   *   record keeps the facts it already has.
   */
  async set(
    sessionId: string,
    on: boolean,
    facts: { origin?: TerminalSessionOrigin, cwd?: string, title?: string } = {},
  ): Promise<void> {
    await this.mutate(() => {
      if (!on) {
        this.records = this.records.filter(record => record.sessionId !== sessionId)
        return true
      }
      const existing = this.record(sessionId)
      const cwd = facts.cwd ?? existing?.cwd
      const title = facts.title ?? existing?.title
      this.records = [
        ...this.records.filter(record => record.sessionId !== sessionId),
        {
          sessionId,
          origin: facts.origin ?? existing?.origin ?? 'legacy',
          createdAt: existing?.createdAt ?? Date.now(),
          ...cwd === undefined ? {} : { cwd },
          ...title === undefined ? {} : { title },
          ...existing?.archived === true ? { archived: true } : {},
          ...existing?.started === true ? { started: true } : {},
          ...existing?.mode === undefined ? {} : { mode: existing.mode },
        },
      ]
      return true
    })
  }

  /** Set dshell's own archive bit for one terminal session. */
  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    await this.mutate(() => this.patch(sessionId, current => archived
      ? { ...current, archived: true }
      : unarchived(current)))
  }

  /**
   * Record that a session has started. Its initialization page is over at that
   * point: the run location and the preset were what that page was for, and the
   * host refuses to change them once history exists.
   */
  async markStarted(sessionId: string): Promise<void> {
    await this.mutate(() => this.patch(sessionId, current => ({ ...current, started: true })))
  }

  /** Persist which way one session's composer reads Enter. */
  async setMode(sessionId: string, mode: TerminalComposerMode): Promise<void> {
    await this.mutate(() => this.patch(sessionId, current => ({ ...current, mode })))
  }

  /** Name a terminal session, so its row never falls back to the bare id. */
  async setTitle(sessionId: string, title: string): Promise<void> {
    await this.mutate(() => this.patch(sessionId, current => ({ ...current, title })))
  }

  /** Remember (once) which workspace the terminal section lives in. */
  async useWorkspace(workspaceId: string): Promise<void> {
    await this.mutate(() => {
      if (this.workspace === workspaceId) return false
      this.workspace = workspaceId
      return true
    })
  }

  /** Fold or unfold the section. */
  async setFolded(folded: boolean): Promise<void> {
    await this.mutate(() => {
      if (this.foldedState === folded) return false
      this.foldedState = folded
      return true
    })
  }

  /**
   * Drop the records whose session dsh no longer has.
   *
   * Skipped when the catalog cannot answer: an empty answer and no answer are
   * different facts, and only the first one means the sessions are gone.
   * @returns the ids moved out of the table.
   */
  async reconcile(): Promise<readonly string[]> {
    const catalog = this.deps.catalog
    if (catalog === undefined) return []
    let answered: readonly string[] | undefined
    try {
      answered = await catalog()
    } catch {
      // A catalog that failed says nothing about which sessions exist.
      return []
    }
    if (answered === undefined) return []
    const known = new Set(answered)
    const moved: TerminalSessionRecord[] = []
    await this.mutate(() => {
      const gone = this.records.filter(record => !known.has(record.sessionId))
      if (gone.length === 0) {
        // The previous orphans had their one chance to be contradicted and were
        // not: those sessions really are gone.
        if (this.orphans.length === 0) return false
        this.orphans = []
        return true
      }
      this.records = this.records.filter(record => known.has(record.sessionId))
      this.orphans = gone
      moved.push(...gone)
      return true
    })
    const ids = moved.map(record => record.sessionId)
    if (ids.length > 0) this.deps.onOrphan?.(ids)
    return ids
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Read the document once; a missing file is an empty table. */
  async load(): Promise<void> {
    this.loaded ??= (async () => {
      let raw: string
      try {
        raw = await readFile(this.file, 'utf8')
      } catch {
        // First run: nothing to read is an empty table, not a failure.
        return
      }
      try {
        this.adopt(JSON.parse(raw) as TerminalModeDocument | LegacyDocument)
      } catch (error) {
        // The document is kept, not replaced: the next write would otherwise
        // finish what the crash started and every identity would be gone with
        // no trace of what was lost.
        await rename(this.file, `${this.file}.unreadable`).catch(() => {})
        throw new Error(`dshell: the terminal-session table at ${this.file} could not be read and was set aside: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    return this.loaded
  }

  /** Take the parsed document, adopting an id-list document on the way. */
  private adopt(parsed: TerminalModeDocument | LegacyDocument): void {
    this.workspace = typeof parsed.workspaceId === 'string' ? parsed.workspaceId : undefined
    this.foldedState = parsed.folded === true
    if ((parsed as TerminalModeDocument).version === 2) {
      const current = parsed as TerminalModeDocument
      this.records = readRecords(current.records)
      this.orphans = readRecords(current.orphans)
      return
    }
    // The id-list document this table replaced: every id becomes a record with
    // no facts, which is exactly as much as that document knew.
    const legacy = parsed as LegacyDocument
    const archived = Array.isArray(legacy.archived) ? legacy.archived : []
    const started = Array.isArray(legacy.started) ? legacy.started : []
    const createdAt = Date.now()
    this.records = (Array.isArray(legacy.sessions) ? legacy.sessions : [])
      .filter((id): id is string => typeof id === 'string')
      .map(sessionId => ({
        sessionId,
        origin: 'legacy' as const,
        createdAt,
        ...archived.includes(sessionId) ? { archived: true as const } : {},
        ...started.includes(sessionId) ? { started: true as const } : {},
      }))
    this.orphans = []
  }

  /**
   * Run one mutation on the chain, then write the document if it changed.
   * @param work - the change; returns whether the document differs.
   */
  private async mutate(work: () => boolean): Promise<void> {
    let changed = false
    const step = async (): Promise<void> => {
      // Read before changing: a mutation that ran against an unloaded table
      // would write back only its own field. A document that failed to parse
      // was already set aside by `load`, so an empty table is then the truth.
      await this.load().catch(() => {})
      changed = work() === true
      // The write is inside the chain, not after it: two mutations in flight
      // would otherwise share one temp name and the second rename would find
      // nothing to move.
      if (changed) await this.persist()
    }
    // Both arms run the step: a mutation that threw must not wedge the ones
    // queued behind it, and its own error still reaches its caller.
    const run = this.chain.then(step, step)
    this.chain = run.then(() => undefined, () => undefined)
    await run
    if (!changed) return
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * Rewrite one record; an absent record is not created.
   * @param sessionId - the record to change.
   * @param next - the record as it should read; a write is skipped when it is
   *   the same as the one on disk.
   * @returns whether the document differs.
   */
  private patch(
    sessionId: string,
    next: (current: TerminalSessionRecord) => TerminalSessionRecord,
  ): boolean {
    const index = this.records.findIndex(record => record.sessionId === sessionId)
    if (index < 0) return false
    const current = this.records[index]!
    const updated = next(current)
    if (JSON.stringify(updated) === JSON.stringify(current)) return false
    this.records = [...this.records.slice(0, index), updated, ...this.records.slice(index + 1)]
    return true
  }

  /** Write the document atomically: a reader sees the old one or the new one. */
  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const body: TerminalModeDocument = {
      version: 2,
      records: this.records,
      orphans: this.orphans,
      ...this.workspace === undefined ? {} : { workspaceId: this.workspace },
      folded: this.foldedState,
    }
    // The pid keeps two hosts sharing one data root from writing one temp file.
    const temporary = `${this.file}.${String(process.pid)}.tmp`
    await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
    await rename(temporary, this.file)
  }
}

/** The route's JSON response shape. */
function respond(body: TerminalModeResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** What starting a session does beyond recording it. */
export interface TerminalModeRouteDeps {
  /**
   * Called when one session takes its first input. The host uses it to name the
   * session: a terminal session logs no turn of its own, so without an event it
   * stays dsh's reusable BLANK session and the workspace's "新会话" would keep
   * selecting it instead of minting a new one. Seeding here rather than at
   * opt-in keeps the session blank for as long as its initialization page is
   * up — the host only lets a not-yet-started session take a preset.
   */
  readonly onStart?: (sessionId: string) => void
}

/** Bind the route to one registry. */
export function createTerminalModeRoute(
  registry: TerminalModeRegistry,
  deps: TerminalModeRouteDeps = {},
): ConnectionFetchRoute {
  return {
    path: DSHELL_TERMINAL_MODE_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const state = (): TerminalModeResponse => ({
        records: registry.list(),
        workspaceId: registry.workspaceId,
        folded: registry.folded,
        root: registry.root,
      })
      try {
        if (request.method === 'POST') {
          const input = await request.json() as TerminalModeRequest
          if (input.action === 'set' && typeof input.sessionId === 'string') {
            await registry.set(input.sessionId, input.on === true, {
              ...input.origin === undefined ? {} : { origin: input.origin },
              ...input.cwd === undefined ? {} : { cwd: input.cwd },
              ...input.title === undefined ? {} : { title: input.title },
            })
          } else if (input.action === 'workspace' && typeof input.workspaceId === 'string') {
            await registry.useWorkspace(input.workspaceId)
          } else if (input.action === 'archive' && typeof input.sessionId === 'string') {
            await registry.setArchived(input.sessionId, input.archived === true)
          } else if (input.action === 'fold') {
            await registry.setFolded(input.folded === true)
          } else if (input.action === 'start' && typeof input.sessionId === 'string') {
            await registry.markStarted(input.sessionId)
            deps.onStart?.(input.sessionId)
          } else if (input.action === 'mode' && typeof input.sessionId === 'string' && isMode(input.mode)) {
            await registry.setMode(input.sessionId, input.mode)
          } else if (input.action === 'title' && typeof input.sessionId === 'string' && typeof input.title === 'string') {
            await registry.setTitle(input.sessionId, input.title)
          } else {
            return respond(state(), 400)
          }
        }
        return respond(state())
      } catch {
        return respond(state(), 400)
      }
    },
  }
}
