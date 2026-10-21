/**
 * The device readout's browser half: one poller for the whole frame.
 *
 * The chip is rendered once per terminal session, so a reader with three
 * sessions open would otherwise have three pollers — and on a device session
 * each poll is an `ssh` round trip that spawns a shell. So the polling lives
 * here, keyed by session and shared: the seats are refcounted, one timer drives
 * them all, and two chips watching the same session cost one request.
 *
 * The cadence follows what a poll costs. A local session is answered from
 * `/proc` in the host process, so it is cheap enough to keep moving at the
 * chip's own tempo; a device is asked over ssh and gets the slower tick the
 * pipe's state already uses. Nothing is polled for a session no chip is
 * watching, which is what keeps an idle frame free.
 */

import type { DshellDeviceMetrics, DshellDeviceMetricsResponse } from '../device-metrics-protocol.js'
import { DSHELL_DEVICE_METRICS_PATH } from '../device-metrics-protocol.js'
import { devicePollStore } from './device-poll.js'

/** The read side, stable enough for `useSyncExternalStore`. */
export interface DeviceMetricsSeat {
  getSnapshot(): ReadonlyMap<string, DshellDeviceMetricsResponse>
  subscribe(listener: () => void): () => void
  /** Report one session until the returned function is called. */
  watch(sessionId: string): () => void
}

/** One session's polling state. */
interface Watch {
  /** How many chips are showing it; the last one out stops the poll. */
  readers: number
  lastAnswer: DshellDeviceMetricsResponse | undefined
  /** When this session was last fetched, to hold a device to its slower tick. */
  fetchedAt: number
}

let snapshot: ReadonlyMap<string, DshellDeviceMetricsResponse> = new Map()
const watchers = new Map<string, Watch>()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

/** True when two answers would draw the same row, so a poll can stay quiet. */
function sameAnswer(
  left: DshellDeviceMetricsResponse | undefined,
  right: DshellDeviceMetricsResponse | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.error !== right.error) return false
  const a = left.metrics
  const b = right.metrics
  if (a === undefined || b === undefined) return a === b
  return a.at === b.at && a.device.kind === b.device.kind && a.device.name === b.device.name
}

function publish(sessionId: string, answer: DshellDeviceMetricsResponse): void {
  const watch = watchers.get(sessionId)
  if (watch !== undefined && sameAnswer(watch.lastAnswer, answer)) return
  if (watch !== undefined) watch.lastAnswer = answer
  snapshot = new Map(snapshot).set(sessionId, answer)
  for (const listener of [...listeners]) listener()
}

async function fetchOne(sessionId: string): Promise<void> {
  try {
    const response = await fetch(
      `${DSHELL_DEVICE_METRICS_PATH}?session=${encodeURIComponent(sessionId)}`,
      { credentials: 'include' },
    )
    const body = await response.json() as DshellDeviceMetricsResponse
    // The host answers a refusal with a 4xx and a reason, which is a real
    // answer here — "the device is unreachable" is the row's content, not a
    // transport failure. Only a body that is not the shape we asked for is.
    publish(sessionId, body.metrics === undefined && body.error === undefined
      ? { error: 'host returned no reading' }
      : body)
  } catch {
    // A host that did not answer leaves the last reading on screen. Reporting a
    // failure every tick would make a laptop waking from sleep look like a
    // broken device, and the row's staleness already says the number is old.
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

/**
 * Arm the one timer, at whatever interval is currently chosen.
 *
 * Re-armed rather than mutated: a browser offers no way to change an interval's
 * period, and a reader who moves the slider from 5s to 30s must not have to
 * reload for the next tick to land at the new cadence. The chosen interval is
 * read here rather than captured, so the arming below and the tick above can
 * never disagree about it.
 */
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

/** The one seat the client hands to every chip. */
export const deviceMetricsSeat: DeviceMetricsSeat = {
  getSnapshot: () => snapshot,
  subscribe(listener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  watch(sessionId) {
    const existing = watchers.get(sessionId)
    if (existing !== undefined) {
      existing.readers += 1
    } else {
      // Stamped before the read, not after: the cadence is measured from when
      // the request left, and a watch that started at t=0 with a slow answer
      // would otherwise be polled again the instant it landed — which on a
      // device is a second ssh round trip back to back.
      watchers.set(sessionId, { readers: 1, lastAnswer: undefined, fetchedAt: Date.now() })
      // Read once on the way in rather than waiting a full tick: the row
      // appears the moment the chip does, and a local reading costs a file
      // read rather than a subprocess.
      void fetchOne(sessionId)
    }
    armTimer()
    let released = false
    return () => {
      if (released) return
      released = true
      const watch = watchers.get(sessionId)
      if (watch === undefined) return
      watch.readers -= 1
      if (watch.readers > 0) return
      watchers.delete(sessionId)
      snapshot = new Map([...snapshot].filter(([key]) => key !== sessionId))
      for (const listener of [...listeners]) listener()
      stopTimerIfIdle()
    }
  },
}

/**
 * A busy share as the row prints it.
 *
 * Whole percent, because a header is read at a glance and `0.134` is not. The
 * dash is deliberate: a platform with no CPU counter must say so rather than
 * show a confident zero.
 */
export function cpuPercent(cpu: DshellDeviceMetrics['cpu']): string {
  return cpu.used === undefined ? '—' : `${String(Math.round(cpu.used * 100))}%`
}

/**
 * A byte count as the row prints it.
 *
 * GB above a gigabyte, because below that the interesting boundary is the
 * megabyte and the number stops being about load.
 */
export function memoryAmount(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${String(Math.round(bytes / 1024 ** 2))} MB`
}

/** `used / total`, the form both figures are comparable in. */
export function memoryPair(memory: DshellDeviceMetrics['memory']): string {
  return `${memoryAmount(memory.used)} / ${memoryAmount(memory.total)}`
}
