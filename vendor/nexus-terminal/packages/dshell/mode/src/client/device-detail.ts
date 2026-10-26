/**
 * The device detail seat: one snapshot per session, shared.
 *
 * The panel is the only reader today, but the snapshot is expensive: on a
 * device it is ONE ssh round trip that asks for the process list, the
 * container list and the socket list at once. Two readers of the same session
 * must therefore cost one round trip, not two — so the answers live in a
 * module-level table, the readers are refcounted, and one timer drives them
 * all.
 *
 * The cadence is the reader's own setting (the same one the status chip uses),
 * because the question being asked is the same: how often is it worth a round
 * trip to a machine that is not this one.
 */

import { DSHELL_DEVICE_DETAIL_PATH, type DshellDeviceDetailResponse } from '../device-detail-protocol.js'
import { devicePollStore } from './device-poll.js'

/** The read side, stable enough for `useSyncExternalStore`. */
export interface DeviceDetailSeat {
  /** The last answer for one session, or undefined when it was never read. */
  getSnapshot(sessionId: string): DshellDeviceDetailResponse | undefined
  subscribe(listener: () => void): () => void
  /** Report one session until the returned function is called. */
  watch(sessionId: string): () => void
  /** Ask again now, outside the cadence. */
  refresh(sessionId: string): void
}

/** One session's polling state. */
interface Watch {
  /** How many readers want this session; the last one out stops the poll. */
  readers: number
  /** When the last request left, so the cadence is measured from the ask. */
  fetchedAt: number
}

const answers = new Map<string, DshellDeviceDetailResponse>()
const watchers = new Map<string, Watch>()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

function publish(sessionId: string, answer: DshellDeviceDetailResponse): void {
  answers.set(sessionId, answer)
  for (const listener of [...listeners]) listener()
}

async function fetchOne(sessionId: string): Promise<void> {
  try {
    const response = await fetch(
      `${DSHELL_DEVICE_DETAIL_PATH}?session=${encodeURIComponent(sessionId)}`,
      { credentials: 'include' },
    )
    const body = await response.json() as DshellDeviceDetailResponse
    publish(sessionId, body)
  } catch {
    // A host that did not answer is said out loud rather than hidden behind the
    // last snapshot: a stale process list reads like a live one, and a reader
    // acting on it would act on the past.
    publish(sessionId, { error: '主机没有回答' })
  }
}

function tick(): void {
  const now = Date.now()
  const cadence = devicePollStore.getSnapshot()
  for (const [sessionId, watch] of watchers) {
    if (now - watch.fetchedAt < cadence) continue
    watch.fetchedAt = now
    void fetchOne(sessionId)
  }
}

function armTimer(): void {
  if (timer !== undefined) clearInterval(timer)
  timer = setInterval(tick, devicePollStore.getSnapshot())
}

function stopTimerIfIdle(): void {
  if (watchers.size > 0 || timer === undefined) return
  clearInterval(timer)
  timer = undefined
}

// One subscription for the life of the page, NOT one per arming: the arming is
// what a change has to reach, so subscribing inside it would make the handler
// re-enter the only thing that calls it.
devicePollStore.subscribe(() => {
  if (watchers.size > 0) armTimer()
})

/** The one seat the client hands to the panel. */
export const deviceDetailSeat: DeviceDetailSeat = {
  getSnapshot: (sessionId) => answers.get(sessionId),
  subscribe(listener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  watch(sessionId) {
    const existing = watchers.get(sessionId)
    if (existing !== undefined) {
      existing.readers += 1
      return () => {
        const watch = watchers.get(sessionId)
        if (watch === undefined) return
        watch.readers -= 1
        if (watch.readers > 0) return
        watchers.delete(sessionId)
        stopTimerIfIdle()
      }
    }
    // Stamped before the read, not after: the cadence is measured from when
    // the request left, and a watch that started at t=0 with a slow answer
    // would otherwise be polled again the instant it landed.
    watchers.set(sessionId, { readers: 1, fetchedAt: Date.now() })
    armTimer()
    void fetchOne(sessionId)
    return () => {
      watchers.delete(sessionId)
      stopTimerIfIdle()
    }
  },
  refresh(sessionId) {
    const watch = watchers.get(sessionId)
    if (watch !== undefined) watch.fetchedAt = Date.now()
    void fetchOne(sessionId)
  },
}
