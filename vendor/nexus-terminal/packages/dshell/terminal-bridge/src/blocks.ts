/**
 * Block log — the host's block model for one session.
 *
 * The bridge is the only party that knows, at the moment bytes arrive, which
 * block they belong to: it sees every append, and it sees the session's turn
 * boundaries. Deciding there is what makes ordering exact — a browser
 * reconstructing blocks from a replay has to guess, and a replay carries one
 * timestamp for the whole retained window.
 *
 * A block is a stretch of the session, not a command: everything the terminal
 * printed while no turn was running is one shell block, and each turn is one
 * agent block. The list is append-only with a monotonic sequence, so a client
 * can page it and can apply live deltas without re-reading history.
 */

import { readFile } from 'node:fs/promises'
import { writePrivate } from './private-file.js'

/** One stretch of the session: a shell run between turns, or one turn. */
export interface PtyBlock {
  /** Monotonic position in the list; the client's cursor. */
  readonly seq: number
  readonly kind: 'shell' | 'agent'
  /** Turn number for an agent block, so its content can be found by turn. */
  turn?: number | undefined
  /** Slash-command identity; absent in older persisted carriers. */
  readonly commandId?: string | undefined
  /** Epoch ms the block opened. */
  readonly startedAt: number
  /** Epoch ms the block closed; absent while it is open. */
  endedAt?: number | undefined
  /** Terminal output belonging to this block. */
  text: string
}

/** Blocks kept in memory and on disk; older ones drop from the front. */
const MAX_BLOCKS = 400
/** Total characters retained across all blocks. */
const MAX_CHARS = 512 * 1024

/** Where a session's block log is persisted, beside its PTY log. */
export function blockLogPath(logPath: string): string {
  return `${logPath}.blocks.json`
}

/** Append-only list of blocks for one session. */
export class BlockLog {
  private blocks: PtyBlock[] = []
  private nextSeq = 1
  private saveTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly path: string | undefined) {}

  /** Load a persisted log; a missing or malformed file starts empty. */
  async load(): Promise<void> {
    if (this.path === undefined) return
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!Array.isArray(parsed)) return
      for (const item of parsed) {
        const block = asBlock(item)
        if (block !== undefined) {
          this.blocks.push(block)
          this.nextSeq = Math.max(this.nextSeq, block.seq + 1)
        }
      }
      this.trim()
    } catch {
      // No log yet: the first block opens on the first byte.
    }
  }

  /**
   * Sequence number of the newest block, or undefined when there is none.
   *
   * A cheap way for the owner to notice that an append OPENED a block rather
   * than extended one: the client can only merge a `block-text` frame into a
   * block it already knows, so the frame that starts a block has to be
   * preceded by a fresh snapshot.
   */
  get tailSeq(): number | undefined {
    return this.blocks.at(-1)?.seq
  }

  /**
   * Append terminal output to the open block, opening a shell block if the
   * list is empty or the previous one has closed.
   *
   * A turn's agent block never absorbs main-PTY bytes: while a turn runs, the
   * agent's own commands execute on its private PTY and never pass through
   * this log, so every byte arriving here during a turn is the user's
   * parallel shell work. It closes the turn's carrier block and opens a shell
   * block for the user's output — otherwise the bytes would land in a block
   * whose display content comes from the session fold and the user's `ls`
   * would execute perfectly and render nowhere.
   * @param text - the bytes as they arrived.
   * @param time - their arrival time.
   * @returns the block they landed in.
   */
  append(text: string, time: number = Date.now()): PtyBlock {
    if (text.length === 0) return this.open('shell', undefined, time)
    let current = this.blocks.at(-1)
    if (current !== undefined && current.kind === 'agent' && current.endedAt === undefined) {
      current.endedAt = time
      current = undefined
    }
    if (current === undefined || current.endedAt !== undefined) current = this.open('shell', undefined, time)
    current.text += text
    this.scheduleSave()
    return current
  }

  /**
   * A turn started: close whatever was open and open the agent block.
   * @param turn - the turn number the session reported.
   * @param time - when it started.
   * @param commandId - slash-command identity when no turn is opened.
   */
  startTurn(turn: number | undefined, time: number = Date.now(), commandId?: string): PtyBlock {
    const current = this.blocks.at(-1)
    if (current !== undefined && current.endedAt === undefined) current.endedAt = time
    return this.open('agent', turn, time, commandId)
  }

  /** A turn ended: close the agent block; the next output opens a shell one. */
  endTurn(time: number = Date.now()): void {
    const current = this.blocks.at(-1)
    if (current !== undefined && current.kind === 'agent' && current.endedAt === undefined) current.endedAt = time
    this.scheduleSave()
  }

  /** The retained blocks, oldest first. */
  snapshot(): readonly PtyBlock[] {
    return this.blocks
  }

  /** Write the log out without waiting for the debounce. */
  async flush(): Promise<void> {
    if (this.saveTimer !== undefined) { clearTimeout(this.saveTimer); this.saveTimer = undefined }
    await this.save()
  }

  private open(kind: PtyBlock['kind'], turn: number | undefined, time: number, commandId?: string): PtyBlock {
    const block: PtyBlock = {
      seq: this.nextSeq++, kind, turn, startedAt: time, text: '',
      ...commandId === undefined ? {} : { commandId },
    }
    this.blocks.push(block)
    this.trim()
    this.scheduleSave()
    return block
  }

  /** Keep the newest blocks under both caps. */
  private trim(): void {
    while (this.blocks.length > MAX_BLOCKS) this.blocks.shift()
    let chars = this.blocks.reduce((sum, block) => sum + block.text.length, 0)
    while (chars > MAX_CHARS && this.blocks.length > 1) {
      const dropped = this.blocks.shift()
      chars -= dropped?.text.length ?? 0
    }
  }

  private scheduleSave(): void {
    if (this.path === undefined || this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.save()
    }, 500)
  }

  private async save(): Promise<void> {
    if (this.path === undefined) return
    // An open block's text is worth persisting too: a restart should resume
    // the block the terminal was in the middle of, not lose it.
    await writePrivate(this.path, JSON.stringify(this.blocks)).catch(() => { /* best effort */ })
  }
}

/** Validate one persisted entry. */
function asBlock(value: unknown): PtyBlock | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.seq !== 'number' || typeof record.startedAt !== 'number') return undefined
  if (record.kind !== 'shell' && record.kind !== 'agent') return undefined
  const block: PtyBlock = {
    seq: record.seq,
    kind: record.kind,
    startedAt: record.startedAt,
    text: typeof record.text === 'string' ? record.text : '',
  }
  if (typeof record.turn === 'number') block.turn = record.turn
  if (typeof record.endedAt === 'number') block.endedAt = record.endedAt
  return typeof record.commandId === 'string' ? { ...block, commandId: record.commandId } : block
}
