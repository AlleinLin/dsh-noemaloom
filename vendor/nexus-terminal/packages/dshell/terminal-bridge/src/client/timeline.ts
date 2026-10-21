/**
 * PTY arrival timeline.
 *
 * A bind replay delivers the whole retained scrollback as ONE frame, so its
 * text has a single timestamp and a rebuild cannot place it between the
 * session's task blocks — the shell history collapses to the end of the
 * timeline. Recording `(time, length)` per live frame, persisted per session,
 * lets a rebuild slice that text back into its original pieces.
 *
 * The functions here are pure reads over a timeline + text pair; the owning
 * service does the mutate/trim/save bookkeeping.
 */

const TIMELINE_STORAGE_PREFIX = 'dshell.pty.timeline.'
const TIMELINE_MAX_ENTRIES = 2000
const TIMELINE_MAX_BYTES = 256 * 1024

/** One live frame's arrival time and character count. */
export interface TimelineEntry {
  t: number
  n: number
}

/** One timed slice of a session's PTY text, for timeline placement. */
export interface PtyTextSegment {
  readonly text: string
  readonly time: number
}

/** Minimal chunk shape the timeline needs to fall back on. */
export interface TimedChunk {
  readonly text: string
  readonly time: number
}

/** Entry/byte caps past which the oldest live frames are forgotten. */
export const TIMELINE_LIMITS = { entries: TIMELINE_MAX_ENTRIES, bytes: TIMELINE_MAX_BYTES } as const

function timelineKey(sessionId: string): string {
  return `${TIMELINE_STORAGE_PREFIX}${sessionId}`
}

/** Read a session's persisted arrival timeline; anything malformed reads empty. */
export function loadTimeline(sessionId: string): TimelineEntry[] {
  try {
    const raw = window.localStorage.getItem(timelineKey(sessionId))
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const entries: TimelineEntry[] = []
    for (const item of parsed) {
      if (!Array.isArray(item)) continue
      const [t, n] = item as [unknown, unknown]
      if (typeof t === 'number' && typeof n === 'number' && n > 0) entries.push({ t, n })
    }
    return entries
  } catch {
    return []
  }
}

/** Persist a session's arrival timeline; storage failure only costs interleaving. */
export function saveTimeline(sessionId: string, entries: readonly TimelineEntry[]): void {
  try {
    const pairs = entries.map(entry => [entry.t, entry.n])
    window.localStorage.setItem(timelineKey(sessionId), JSON.stringify(pairs))
  } catch {
    // Storage full or unavailable: the timeline is an optimization.
  }
}

/** Characters a timeline accounts for. */
export function timelineBytes(entries: readonly TimelineEntry[]): number {
  let total = 0
  for (const entry of entries) total += entry.n
  return total
}

/**
 * The session's PTY text as timed segments, oldest first. With no recorded
 * timeline the raw chunks are already timed, so they are returned as-is.
 * @param text - the session's current text.
 * @param timeline - its persisted arrival timeline.
 * @returns the segments, covering the whole text.
 */
export function segmentsOf(text: string, timeline: readonly TimelineEntry[]): readonly PtyTextSegment[] {
  if (timeline.length === 0) return []
  if (text.length === 0) return []
  const segments: PtyTextSegment[] = []
  let end = text.length
  for (let index = timeline.length - 1; index >= 0 && end > 0; index -= 1) {
    const entry = timeline[index]
    if (entry === undefined) continue
    const start = Math.max(0, end - entry.n)
    segments.push({ text: text.slice(start, end), time: entry.t })
    end = start
  }
  if (end > 0) {
    // Bytes older than the recorded timeline (evicted, or a stream this
    // browser never watched): one segment at the oldest time we know.
    segments.push({ text: text.slice(0, end), time: timeline[0]?.t ?? 0 })
  }
  return segments.reverse()
}

/**
 * Arrival time of a byte offset, resolved the same way {@link segmentsOf}
 * slices text: walk the newest entries backwards until the offset's slice is
 * found. Offsets older than the timeline (or a stream with no timeline at all)
 * report the oldest time known.
 * @param timeline - the persisted arrival timeline.
 * @param chunks - the raw chunks, used when no timeline was recorded.
 * @param textLength - the current text length, precomputed by the caller.
 * @param offset - the byte offset to time.
 * @returns epoch milliseconds.
 */
export function timeAt(
  timeline: readonly TimelineEntry[],
  chunks: readonly TimedChunk[],
  textLength: number,
  offset: number,
): number {
  if (timeline.length === 0) {
    let end = textLength
    for (let index = chunks.length - 1; index >= 0; index -= 1) {
      const chunk = chunks[index]
      if (chunk === undefined) continue
      const start = Math.max(0, end - chunk.text.length)
      if (offset >= start) return chunk.time
      end = start
    }
    return 0
  }
  let end = textLength
  for (let index = timeline.length - 1; index >= 0 && end > 0; index -= 1) {
    const entry = timeline[index]
    if (entry === undefined) continue
    const start = Math.max(0, end - entry.n)
    if (offset >= start) return entry.t
    end = start
  }
  return timeline[0]?.t ?? 0
}

/**
 * Cut the text at wall-clock boundaries, so a shell stretch that spans several
 * agent tasks is split between them instead of being lumped at one end.
 *
 * Bytes older than the recorded timeline have no per-frame time (a replay
 * delivers them as one frame), so they form the first piece — the reader still
 * sees them before the tasks that came after.
 * @param text - the session's current text.
 * @param timeline - the persisted arrival timeline.
 * @param chunks - the raw chunks, used when no timeline was recorded.
 * @param boundaries - ascending epoch-ms cuts, one per task start.
 * @returns `boundaries.length + 1` pieces, oldest first.
 */
export function splitByTime(
  text: string,
  timeline: readonly TimelineEntry[],
  chunks: readonly TimedChunk[],
  boundaries: readonly number[],
): { text: string; time: number }[] {
  const frameTimes = timeline.length > 0
    ? { offset: Math.max(0, text.length - timelineBytes(timeline)), lengths: timeline.map(entry => entry.n), times: timeline.map(entry => entry.t) }
    : { offset: 0, lengths: chunks.map(chunk => chunk.text.length), times: chunks.map(chunk => chunk.time) }
  const cuts: number[] = []
  let floor = frameTimes.offset
  for (const boundary of boundaries) {
    let cut = text.length
    let seen = floor
    for (const [index, time] of frameTimes.times.entries()) {
      if (time >= boundary) { cut = seen; break }
      seen += frameTimes.lengths[index] ?? 0
    }
    cut = Math.max(floor, Math.min(text.length, cut))
    cuts.push(cut)
    floor = cut
  }
  const pieces: { text: string; time: number }[] = []
  let start = 0
  for (const [index, cut] of cuts.entries()) {
    pieces.push({ text: text.slice(start, cut), time: index === 0 ? 0 : (boundaries[index - 1] ?? 0) })
    start = cut
  }
  pieces.push({ text: text.slice(start), time: boundaries.at(-1) ?? 0 })
  return pieces
}
