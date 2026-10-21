/**
 * Agent task blocks: the fold that turns a session event window into one
 * collapsible block per task (or supervised phase), and its renderers.
 */

import type {
  AssistantLiveChunkEvent,
  SessionEventLike,
  SessionEventLikeEntry,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { sanitizeRowText, sessionRowsOf, type SessionRow } from './session-rows.js'

/** The bound translator of this package's namespace. */
type ModeTranslate = TranslateNS<'dshellMode'>

export const BLOCK_LINES = 3

/**
 * The attempt currently writing into a block, accumulated from the client-only
 * live chunks (`assistant/live-chunk`).
 *
 * Held apart from `rows` on purpose: rows are durable session events, while
 * this is a partial line the model is still producing. It is displayed after
 * them and dropped the moment the durable message arrives, so the reader never
 * sees the same text twice.
 *
 * Keyed by `attemptId` because a retry reuses the same turn and step: text
 * accumulated for one attempt must never be shown as another's.
 */
export interface LiveStream {
  /** The attempt these chunks belong to. */
  readonly attemptId: string
  /** The turn the attempt belongs to. */
  readonly turn: number
  /** The step the attempt belongs to. */
  readonly step: number
  /** Answer text so far (`text-delta`). */
  text: string
  /** Thinking so far (`reasoning-delta`). */
  reasoning: string
  /** Timestamp of the newest chunk, for the row's time. */
  time: number
}

/** The mutable live stream of one block, created on the first visible chunk. */
type MutableStream = { -readonly [K in keyof LiveStream]: LiveStream[K] }

/** One agent task or supervised phase, folded into a collapsible block. */
export interface TurnBlock {
  /** Stable identity for collapse state and the clicked-line table. */
  readonly key: string
  /** Turn number, once `turn/start` names it. */
  turn: number | undefined
  /** Slash-command identity shared with its host timeline carrier. */
  commandId?: string
  /** Header title: the in-progress todo item, else the request's first line. */
  title: string
  status: 'running' | 'done' | 'aborted' | 'failed'
  /** The block's rows, oldest first. */
  readonly rows: SessionRow[]
  /** The attempt streaming into this block right now; dropped at settlement. */
  stream: MutableStream | undefined
  /** Timeline anchor: when the block opened. */
  readonly startedAt: number
  /** `step/start` count and summed tokens, for the closing notice. */
  steps: number
  tokens: number
  /** The closing line, once the turn ends; the block view draws it inline. */
  notice: { readonly time: number; readonly text: string } | undefined
  /** `turn:step` pairs already counted, so any carrier can report a step. */
  readonly seen: Set<string>
}

/** Record the (turn, step) an event belongs to, for the block's step count. */
export function noteStep(block: TurnBlock, event: SessionEventLike): void {
  const data = event.data as { turn?: number; step?: number }
  if (typeof data.turn !== 'number' || typeof data.step !== 'number') return
  const key = `${String(data.turn)}:${String(data.step)}`
  if (block.seen.has(key)) return
  block.seen.add(key)
  block.steps = block.seen.size
}

/** One item of the merged canvas timeline. */
export type TimelineItem =
  | { readonly kind: 'pty'; readonly time: number; readonly order: number; readonly text: string }
  | { readonly kind: 'block'; readonly time: number; readonly order: number; readonly block: TurnBlock }
  | { readonly kind: 'notice'; readonly time: number; readonly order: number; readonly text: string }

/** Incremental fold of the session window into task blocks. */
export interface BlockFold {
  readonly toolNames: Map<string, string>
  readonly blocks: TurnBlock[]
  readonly notices: { readonly time: number; readonly text: string }[]
  open: TurnBlock | undefined
  /** Monotonic key suffix; two blocks may share a start time. */
  seq: number
  /** The todo item the open block is working on. */
  phase: string | undefined
  /**
   * Prompt ids the host parked in the running turn's next-step inbox, oldest
   * first, and the ids that have left it because the turn picked them up.
   *
   * A prompt admitted into a RUNNING turn is an interjection, not a new
   * request, and the durable `user/message` carries no marker of its own to say
   * which it was. The splices say it: dsh's own client reconstructs steering
   * identity from exactly these events (ui-chat's `SteeringHistory`), which is
   * what keeps this view's shape the same as the trajectory's.
   */
  readonly nextStep: string[]
  readonly steering: Set<string>
}

export function createFold(): BlockFold {
  return {
    toolNames: new Map(), blocks: [], notices: [], open: undefined, seq: 0, phase: undefined,
    nextStep: [], steering: new Set(),
  }
}

export function emptyBlock(key: string, time: number, title: string): TurnBlock {
  return {
    key, turn: undefined, title, status: 'running', rows: [], stream: undefined,
    startedAt: time, steps: 0, tokens: 0, seen: new Set(), notice: undefined,
  }
}

/** Open a new block, appending it to the fold. */
export function openBlock(fold: BlockFold, time: number, title: string): TurnBlock {
  fold.seq += 1
  const block = emptyBlock(`block:${String(time)}:${String(fold.seq)}`, time, title)
  fold.blocks.push(block)
  fold.open = block
  return block
}

/** Highest durable seq a window holds, so appends never replay the window. */
export function maxSeq(entries: readonly SessionEventLikeEntry[]): number {
  let max = 0
  for (const entry of entries) if (entry.type === 'event' && entry.event.seq > max) max = entry.event.seq
  return max
}

/** Last element satisfying the predicate, without ES2023's findLast. */
export function findLast<T>(items: readonly T[], match: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && match(item)) return item
  }
  return undefined
}

/** First line of a row's text, trimmed — the block title fallback. */
export function firstLineOf(text: string): string {
  const line = sanitizeRowText(text).split('\n')[0] ?? ''
  return line.trim().length > 0 ? line.trim() : text.trim()
}

/** Tokens one assistant message reported, if any. */
export function usageTokens(event: SessionEventLike): number {
  if (event.type !== 'assistant/message') return 0
  const usage = (event.data as { usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } }).usage
  if (usage === undefined) return 0
  return usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
}

/** Status a turn-end reason maps to. */
export function statusOfReason(reason: { kind: string }): TurnBlock['status'] {
  if (reason.kind === 'completed') return 'done'
  if (reason.kind === 'aborted' || reason.kind === 'interrupted') return 'aborted'
  return 'failed'
}

/**
 * One-line closing notice for a finished block.
 * @param block - the block that just closed.
 * @param reason - its turn-end reason.
 * @param time - the closing event's timestamp; not the fold's wall clock, so a
 *   replayed session shows when the turn actually ended.
 * @param t - the bound translator for the notice copy.
 */
export function noticeOf(block: TurnBlock, reason: { kind: string; error?: { message?: string } }, time: number, t: ModeTranslate): string {
  const at = new Date(time).toTimeString().slice(0, 5)
  const facts = [t('notice.steps', { count: block.steps })]
  if (block.tokens > 0) facts.push(`${(block.tokens / 1000).toFixed(1)}k tok`)
  facts.push(at)
  if (block.status === 'done') return t('notice.done', { facts: facts.join(' · ') })
  if (block.status === 'aborted') return t('notice.aborted', { at })
  const detail = reason.error?.message ?? (reason.kind === 'max-tokens' ? t('notice.maxTokens') : reason.kind)
  return t('notice.failed', { detail, at })
}

/**
 * Append one client-only live chunk to a block's streaming line.
 *
 * Only text and reasoning deltas are visible; `block-start`, `block-end`,
 * `usage` and `finish` carry no new prose and are ignored. A chunk belonging to
 * a different attempt than the one on record starts a fresh accumulation, so a
 * retry never inherits the abandoned attempt's half-written text.
 * @param block - the block the model is writing into, if one is open.
 * @param event - the transient live-chunk event.
 * @returns whether anything visible changed (the caller repaints only then).
 */
export function noteLiveChunk(block: TurnBlock | undefined, event: AssistantLiveChunkEvent): boolean {
  if (block === undefined) return false
  const chunk = event.data.chunk
  if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return false
  const attemptId = String(event.data.attemptId)
  if (block.stream === undefined || block.stream.attemptId !== attemptId) {
    block.stream = {
      attemptId,
      turn: event.data.turn,
      step: event.data.step,
      text: '',
      reasoning: '',
      time: event.time,
    }
  }
  if (chunk.type === 'text-delta') block.stream.text += chunk.text
  else block.stream.reasoning += chunk.text
  block.stream.time = event.time
  return chunk.text.length > 0
}

/**
 * Drop a block's streaming line: the durable message that supersedes it has
 * arrived (or the turn ended), so keeping it would show the text twice.
 * @param block - the block to clear.
 * @returns whether a stream was actually dropped.
 */
export function clearStream(block: TurnBlock | undefined): boolean {
  if (block === undefined || block.stream === undefined) return false
  block.stream = undefined
  return true
}

/** Identity of each entry one inbox splice inserted. */
function splicedIds(inserted: readonly unknown[]): string[] {
  const ids: string[] = []
  for (const raw of inserted) {
    if (typeof raw !== 'object' || raw === null) continue
    const id = (raw as { id?: unknown }).id
    if (typeof id === 'string') ids.push(id)
  }
  return ids
}

/**
 * Follow one validated inbox splice for the steering mirror.
 *
 * A prompt starts in the next-turn queue and is moved to the running turn's
 * next-step list when the reader interjects. Cancelled means it went back to
 * the queue; any other removal from that list is the turn taking it, and the
 * ids it took are the ones the durable messages will carry.
 */
function noteSplice(fold: BlockFold, data: unknown): void {
  const splice = data as {
    target?: unknown
    start?: unknown
    removedCount?: unknown
    inserted?: readonly unknown[]
    outcome?: unknown
  }
  if (splice.target !== 'next-step') return
  const start = typeof splice.start === 'number' ? splice.start : 0
  const count = typeof splice.removedCount === 'number' ? splice.removedCount : 0
  const removed = fold.nextStep.splice(start, count, ...splicedIds(splice.inserted ?? []))
  if (splice.outcome === 'canceled') return
  for (const id of removed) fold.steering.add(id)
}

/** Whether this message was claimed from the running turn's next-step inbox. */
function claimedByTurn(fold: BlockFold, data: { id?: unknown; source?: { kind?: unknown } }): boolean {
  return typeof data.id === 'string' && fold.steering.delete(data.id) && data.source?.kind === 'user'
}

/**
 * Fold one durable event into the block model. Blocks open on a user request
 * or a turn start, split on a supervised phase change (a new in-progress todo
 * item), and close on `turn/end`. Every other event contributes rows.
 * @param fold - the mutable fold state.
 * @param event - the durable session event, in seq order.
 * @param t - the bound translator for the row and notice copy.
 */
export function foldEvent(fold: BlockFold, event: SessionEventLike, t: ModeTranslate): void {
  const time = event.time
  // Read and consume the inbox splices first: they are what tells a message
  // that steered the running turn from one that opened a turn of its own.
  if (event.type === 'agent/inbox/spliced') {
    noteSplice(fold, event.data)
    return
  }
  const steering = event.type === 'user/message'
    && claimedByTurn(fold, event.data as { id?: unknown; source?: { kind?: unknown } })
  if (event.type === 'turn/start') {
    const turn = event.data.turn
    const block = fold.open
    if (block === undefined) openBlock(fold, time, '').turn = turn
    else if (block.turn === undefined) block.turn = turn
    else if (block.turn !== turn) openBlock(fold, time, '').turn = turn
    return
  }
  if (event.type === 'step/start') {
    if (fold.open !== undefined) noteStep(fold.open, event)
    return
  }
  if (event.type === 'todo/write') {
    const todos = event.data.todos
    const active = todos.find(todo => todo.status === 'in_progress')?.content
      ?? todos.find(todo => todo.status === 'pending')?.content
    if (active === undefined || active === fold.phase) return
    fold.phase = active
    // A supervised phase change closes the running block and pushes a new one;
    // a first plan (nothing rendered yet) just titles the open block. The new
    // block carries the turn forward: phase blocks belong to the same turn,
    // and a block left with no turn number can never be matched by the
    // turn's own end — it would stay "running" after the turn is over.
    const carried = fold.open?.turn
    if (fold.open !== undefined && fold.open.rows.length > 0) {
      fold.open.status = 'done'
      fold.open = undefined
    }
    const block = fold.open ?? openBlock(fold, time, active)
    if (block.turn === undefined && carried !== undefined) block.turn = carried
    block.title = active
    return
  }
  if (event.type === 'turn/end') {
    const turn = event.data.turn
    // A second request can open a new block while an earlier turn is still
    // running, so closers match on the turn they name, not on the open block.
    const block = fold.open !== undefined && (fold.open.turn === undefined || fold.open.turn === turn)
      ? fold.open
      : findLast(fold.blocks, candidate => candidate.turn === turn && candidate.status === 'running')
    if (block === undefined) return
    block.status = statusOfReason(event.data.reason)
    // The turn is over: whatever the transient rows had accumulated is either
    // superseded by the durable message below or was never completed.
    clearStream(block)
    if (block === fold.open) {
      fold.open = undefined
      fold.phase = undefined
    }
    // A phased turn is several blocks wearing one turn number: every other
    // still-running block carrying this turn ends with it. Left open, the
    // earliest one (the reader's message) would tick 已工作 forever after the
    // host has settled — the "agent stopped but still running" split.
    const endStatus = statusOfReason(event.data.reason)
    for (const candidate of fold.blocks) {
      if (candidate !== block && candidate.status === 'running' && candidate.turn === turn) {
        candidate.status = endStatus
      }
    }
    const text = noticeOf(block, event.data.reason as { kind: string; error?: { message?: string } }, time, t)
    // The block view draws the notice with its block; the canvas keeps the
    // flat notice list because it interleaves them as timeline items.
    block.notice = { time, text }
    fold.notices.push({ time, text })
    return
  }
  const rows = sessionRowsOf(event, fold.toolNames, t)
  if (rows.length === 0) return
  if (event.type === 'command/run') {
    // A new command closes the previous command's block: each switch reads as
    // its own line in order, not as one ever-growing merged marker at the
    // tail. An open real turn (non-command rows) is left alone — its rows
    // belong to the task, and the command's outcome folds into it.
    const open = fold.open
    if (open === undefined || open.rows.every(row => row.role === 'command')) {
      if (open !== undefined) { open.status = 'done'; fold.open = undefined }
      const block = openBlock(fold, time, '')
      block.commandId = String(event.data.commandId)
      block.rows.push(...rows)
      noteStep(block, event)
      return
    }
  }
  if (event.type === 'command/done') {
    // A command block closes here, at its own outcome. Left open it would be
    // adopted by the next turn/start (its turn is still undefined), which
    // splits the reader's real message across a phantom running block and a
    // second card.
    const open = fold.open
    if (open !== undefined && open.rows.every(row => row.role === 'command')) {
      open.rows.push(...rows)
      noteStep(open, event)
      open.status = 'done'
      fold.open = undefined
      return
    }
  }
  if (event.type === 'user/message') {
    const title = firstLineOf(rows[0]?.text ?? '')
    // An interjection continues the task it steered: it is appended where it
    // arrived — which is before the answer it produced — and the card keeps its
    // title, its turn and its running state. A card of its own would carry no
    // turn number, so it would be placed among the shell regions by timestamp
    // rather than by turn and adopted by whichever turn starts next, while
    // dsh's trajectory keeps the message inside the turn it steered: the two
    // views of one session would disagree about its shape.
    if (steering && fold.open !== undefined) {
      fold.open.rows.push(...rows.map(row => ({ ...row, steering: true as const, label: t('row.steering') })))
      noteStep(fold.open, event)
      return
    }
    // `turn/start` usually opens the block first; a request adopts that empty
    // block instead of leaving a stray running one behind.
    const open = fold.open
    if (open !== undefined && open.rows.length === 0) {
      open.title = title
      open.rows.push(...rows)
      noteStep(open, event)
      return
    }
    fold.open = undefined
    fold.phase = undefined
    const block = openBlock(fold, time, title)
    block.rows.push(...rows)
    noteStep(block, event)
    return
  }
  const block = fold.open ?? openBlock(fold, time, '')
  // The durable message is the authoritative text of the attempt that was
  // streaming, so the partial line it supersedes goes away here rather than
  // waiting for the turn to end.
  if (event.type === 'assistant/message') clearStream(block)
  block.rows.push(...rows)
  noteStep(block, event)
  block.tokens += usageTokens(event)
}
