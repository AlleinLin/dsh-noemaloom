/**
 * The fold's status projection, published for surfaces outside the view.
 *
 * The task list and the phase in flight are derived while the transcript is
 * folded, which happens inside the block view. The session-header status chip is
 * a separate surface and cannot reach into that component, so the view pushes
 * the two facts here: one entry per session, replaced wholesale, and a listener
 * set a reader subscribes through `useSyncExternalStore`.
 *
 * This stays a *projection*. Nothing reads it to decide behaviour — it only
 * reports what the fold already showed the reader.
 */

import type { TodoItem } from './status-card.js'

/** What the fold knows about one session's work. */
export interface SessionStatus {
  readonly todos: readonly TodoItem[]
  readonly activity: string | undefined
}

const EMPTY: SessionStatus = { todos: [], activity: undefined }

let snapshot: ReadonlyMap<string, SessionStatus> = new Map()
const listeners = new Set<() => void>()

function same(left: SessionStatus, right: SessionStatus): boolean {
  if (left.activity !== right.activity) return false
  if (left.todos.length !== right.todos.length) return false
  return left.todos.every((item, index) => {
    const other = right.todos[index]
    return other !== undefined && other.content === item.content && other.status === item.status
  })
}

/** Record one session's fold-derived status; a no-op when nothing changed. */
export function publishSessionStatus(sessionId: string, next: SessionStatus): void {
  const current = snapshot.get(sessionId)
  if (current !== undefined && same(current, next)) return
  snapshot = new Map(snapshot).set(sessionId, next)
  for (const listener of listeners) listener()
}

/** The read side: a stable seat object the header chip can subscribe through. */
export const sessionStatusSeat = {
  getSnapshot: (): ReadonlyMap<string, SessionStatus> => snapshot,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  /** One session's status, or an empty record before its view has folded anything. */
  read(sessionId: string | undefined): SessionStatus {
    return sessionId === undefined ? EMPTY : snapshot.get(sessionId) ?? EMPTY
  },
}
