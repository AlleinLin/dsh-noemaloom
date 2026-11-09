/**
 * The block view's timeline model.
 *
 * A block is a *stretch of the session*, not a single command: the view
 * alternates shell regions with agent tasks. Everything the terminal printed
 * while no task was running belongs to one shell region — prompt, commands and
 * output in stream order, exactly the terminal's own design, with no synthetic
 * per-command chrome. A task starts a block; the shell output that follows it
 * opens the next region.
 *
 * Regions are cut from the PTY arrival segments, so the split happens at the
 * task boundaries the reader actually saw, not at the commands inside a
 * region.
 */

import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { sanitizeRowText } from './session-rows.js'
import type { PtyBlock } from '@nexus-aethra/dshell-terminal-bridge/client'
import type { TurnBlock } from './blocks.js'
import type { TodoItem } from './status-card.js'

/** One rendered element of the view. */
export type ViewItem =
  | { readonly kind: 'shell'; readonly key: string; readonly time: number; readonly text: string }
  | { readonly kind: 'agent'; readonly key: string; readonly time: number; readonly block: TurnBlock }
  /**
   * A turn that carried no model work at all — a slash command such as
   * `/permission default`, which submits a real turn whose only rows are the
   * command echo and its outcome. Drawn as one quiet line instead of a task
   * card, which would read as a fake agent turn.
   */
  | { readonly kind: 'command'; readonly key: string; readonly time: number; readonly text: string }
  /**
   * A message the reader just sent, shown from the session's local submission
   * echo. It exists only until the durable event arrives, so the request is on
   * screen the moment it is sent instead of when the model first answers.
   */
  | { readonly kind: 'pending'; readonly key: string; readonly time: number; readonly text: string }

/** Whether a shell region holds anything a reader would see. */
function visible(text: string): boolean {
  return sanitizeRowText(text).replace(/\s/gu, '').length > 0
}

/**
 * The timeline item one folded block becomes, or undefined when the block
 * carries nothing to show.
 *
 * Two cases collapse: a turn whose rows are all command echoes (a slash command
 * — it becomes one line, not a card), and a closed turn with no rows, no steps
 * and no tokens at all (an aborted submission — it becomes nothing). Everything
 * else is a task card.
 */
export function agentItemOf(block: TurnBlock): ViewItem | undefined {
  if (block.rows.length > 0 && block.steps === 0 && block.stream === undefined
    && block.rows.every(row => row.role === 'command')) {
    // The first row is the command as it was typed; a slash marks it as the
    // dsh command it was rather than a shell line the reader never ran.
    const [head, ...rest] = block.rows.map(row => row.text)
    return {
      kind: 'command',
      key: block.key,
      time: block.startedAt,
      text: [`/${head ?? ''}`, ...rest].join(' · '),
    }
  }
  if (block.rows.length === 0 && block.stream === undefined && block.steps === 0
    && block.tokens === 0 && block.status !== 'running') {
    return undefined
  }
  return { kind: 'agent', key: block.key, time: block.startedAt, block }
}

/**
 * Merge the shell stream with the agent task blocks.
 *
 * Each PTY segment is assigned to the region that was current when it arrived:
 * the count of task blocks that had already started. Segments sharing a region
 * are contiguous in the stream, so concatenating them rebuilds that stretch of
 * terminal output verbatim.
 * @param hostBlocks - the host's ordered shell, turn and command carriers.
 * @param fold - the folded agent and command blocks, in start order.
 * @returns the items in display order: region, task, region, task, … region.
 */
export function assembleTimeline(
  hostBlocks: readonly PtyBlock[],
  fold: { readonly blocks: readonly TurnBlock[] },
): ViewItem[] {
  // One pass over the folded blocks, indexed by the two identities a host
  // carrier can name. The previous shape scanned every folded block for every
  // host carrier, which is quadratic in the two counts — and this function
  // runs on every PTY frame, so the product of a long session's block count
  // and a busy shell's frame count is what a reader feels as a freeze.
  const byTurn = new Map<number, TurnBlock[]>()
  const byCommand = new Map<string, TurnBlock[]>()
  for (const block of fold.blocks) {
    if (block.turn !== undefined) {
      const bucket = byTurn.get(block.turn)
      if (bucket === undefined) byTurn.set(block.turn, [block])
      else bucket.push(block)
    }
    if (block.commandId !== undefined) {
      const bucket = byCommand.get(block.commandId)
      if (bucket === undefined) byCommand.set(block.commandId, [block])
      else bucket.push(block)
    }
  }

  const items: ViewItem[] = []
  const used = new Set<string>()
  for (const host of hostBlocks) {
    if (host.kind === 'shell') {
      if (visible(host.text)) {
        items.push({ kind: 'shell', key: `shell:${String(host.seq)}`, time: host.startedAt, text: host.text })
      }
      continue
    }
    // One turn can fold into several blocks (a supervised phase change splits
    // it), so every block that carries this carrier's identity is consumed.
    const matched = host.turn === undefined
      ? (host.commandId === undefined ? undefined : byCommand.get(host.commandId))
      : byTurn.get(host.turn)
    if (matched === undefined) continue
    for (const block of matched) {
      if (used.has(block.key)) continue
      used.add(block.key)
      const item = agentItemOf(block)
      if (item !== undefined) items.push(item)
    }
  }
  // Tasks the host has no block for — history from before the block log
  // existed — are older than what it does have, so they slot in by time
  // rather than collecting at one end.
  //
  // Placed by a stable sort, not by inserting each one into the array: the
  // insertion was O(items) per block, so a session with many unmatched blocks
  // paid a quadratic number of element moves on every frame.
  const orphans: { item: ViewItem; order: number }[] = []
  let order = 0
  for (const block of fold.blocks) {
    const at = order
    order += 1
    if (used.has(block.key)) continue
    used.add(block.key)
    const node = agentItemOf(block)
    if (node === undefined) continue
    orphans.push({ item: node, order: at })
  }
  if (orphans.length === 0) return items
  orphans.sort((left, right) => left.item.time - right.item.time || left.order - right.order)
  // The orphan goes before the first item that starts LATER than it, which is
  // the placement the insertion produced.
  const merged: ViewItem[] = []
  let cursor = 0
  for (const item of items) {
    // The orphan goes BEFORE the first item that starts strictly later than
    // it. An item at the SAME time stays ahead of it, which is what placing
    // the orphan by insertion produced.
    while (cursor < orphans.length && (orphans[cursor]?.item.time ?? Infinity) < item.time) {
      const orphan = orphans[cursor]
      if (orphan !== undefined) merged.push(orphan.item)
      cursor += 1
    }
    merged.push(item)
  }
  for (; cursor < orphans.length; cursor += 1) {
    const orphan = orphans[cursor]
    if (orphan !== undefined) merged.push(orphan.item)
  }
  return merged
}

/**
 * The session's current task list, from its own `todo/write` events. A new
 * turn clears it, matching the lifetime of dsh's `todos` projection.
 * @param entries - the session event window.
 * @returns the items, or an empty list when no plan is active.
 */
export function todosOf(entries: readonly SessionEventLikeEntry[]): TodoItem[] {
  let todos: TodoItem[] = []
  for (const entry of entries) {
    if (entry.type !== 'event') continue
    if (entry.event.type === 'turn/start') { todos = []; continue }
    if (entry.event.type === 'todo/write') {
      const data = entry.event.data as { todos?: readonly TodoItem[] }
      todos = [...(data.todos ?? [])]
    }
  }
  return todos
}
