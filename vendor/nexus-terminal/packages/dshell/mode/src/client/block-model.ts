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
    // it), so consume every block that carries this turn.
    for (const block of fold.blocks) {
      const matches = host.turn === undefined
        ? host.commandId !== undefined && block.commandId === host.commandId
        : block.turn === host.turn
      if (!matches || used.has(block.key)) continue
      used.add(block.key)
      const item = agentItemOf(block)
      if (item !== undefined) items.push(item)
    }
  }
  // Tasks the host has no block for — history from before the block log
  // existed — are older than what it does have, so they slot in by time
  // rather than collecting at one end.
  for (const block of fold.blocks) {
    if (used.has(block.key)) continue
    used.add(block.key)
    const node = agentItemOf(block)
    if (node === undefined) continue
    const at = items.findIndex(item => item.time > block.startedAt)
    if (at < 0) items.push(node)
    else items.splice(at, 0, node)
  }
  return items
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
