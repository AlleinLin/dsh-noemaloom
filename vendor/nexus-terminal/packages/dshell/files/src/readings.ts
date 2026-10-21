/**
 * What a completion read out of its world, kept for a moment so a keystroke
 * does not pay for it twice.
 *
 * The completion path asks its world for two kinds of thing: a directory's
 * children, and what the session's own shell would complete. Both are answers
 * about the world rather than facts this process owns, and both cost a round
 * trip that a DEVICE pays with a process of its own — `ssh` behind the
 * harness's local subprocess runner, measured at roughly 0.4 s per call, against
 * a 23 ms network round trip. A Tab that asked for a directory every time was
 * three of those calls: over a second on a device, six milliseconds locally.
 *
 * So a reading is remembered briefly, and the two things that make remembering
 * it honest live here rather than at the call sites:
 *
 *  - **A short freshness window, and a longer usability window.** A listing is
 *    the one answer a reader compares against what is on their screen, so a
 *    reading is FRESH for seconds ({@link DEFAULT_READING_TTL_MS}); between that
 *    and {@link DEFAULT_READING_STALE_MS} it is still served, but the refresh it
 *    needs is started behind the answer rather than in front of the reader. That
 *    is what keeps a Tab instant after a long pause — waiting for a device to
 *    re-list a directory the reader may not have changed is the wait this feature
 *    exists to remove — while a second Tab a moment later sees the new listing.
 *    Past the stale window the answer is not served at all: by then it is a claim
 *    about a world nobody has looked at for a minute.
 *  - **One reader per key.** A warm and the Tab it was warming for are seconds
 *    apart at most, and two in-flight reads of one key would be two device calls
 *    for one answer. {@link ReadingCache.read} therefore hands the second caller
 *    the first caller's promise — including the background one.
 *
 * The key is the caller's: this class never interprets one. What makes a key
 * correct is that it carries everything the answer depends on — for a directory
 * reading that includes the WORLD (two sessions on this machine share their
 * answers; a session on a device is another machine with other files), which is
 * exactly the mistake the oracle's cache made once.
 */

/** One directory reading, in the two shapes the completion path distinguishes. */
export type DirectoryReading =
  | { readonly ok: true; readonly dir: string; readonly children: readonly ReadingChild[] }
  | { readonly ok: false; readonly dir: string; readonly note: 'noDirectory' | 'notDirectory' }

/**
 * The little of a directory entry a completion needs.
 *
 * Structural rather than `FsDirEntry` so a spec can build one without the
 * filesystem seam, and so the cache cannot drift into holding something the
 * completion path does not read.
 */
export interface ReadingChild {
  readonly name: string
  readonly type: string
  readonly size?: number | undefined
}

/** How long a reading is served WITHOUT going back to the world for it. */
export const DEFAULT_READING_TTL_MS = 3_000

/**
 * How long a reading may still answer, with its refresh started behind it.
 *
 * Past this the entry is a claim about a world nobody has looked at for a
 * minute, and the caller waits for a real read instead.
 */
export const DEFAULT_READING_STALE_MS = 60_000

/** A clock, injected so a spec can move time. */
export type ReadingClock = () => number

/**
 * One worker per key: the second caller waits for the first instead of starting
 * a second job.
 *
 * Used for every slow answer this feature warms — a directory read, a shell
 * probe — because a warm and the keystroke it was warming for overlap constantly,
 * and the whole point is that the keystroke does not pay for the work twice.
 */
export class SingleFlight<T> {
  private readonly inFlight = new Map<string, Promise<T>>()

  /**
   * @param key - what the work is for; equal keys share one run.
   * @param produce - how to do it, called only when nobody else is doing it.
   * @returns the shared result. A rejection is shared with the callers that
   *   joined and then forgotten, so the next ask tries again.
   */
  join(key: string, produce: () => Promise<T>): Promise<T> {
    const started = this.inFlight.get(key)
    if (started !== undefined) return started
    const promise = produce().then(
      (value) => {
        this.inFlight.delete(key)
        return value
      },
      (error: unknown) => {
        this.inFlight.delete(key)
        throw error
      },
    )
    this.inFlight.set(key, promise)
    return promise
  }

  /** Whether a run for `key` is on the wire. */
  has(key: string): boolean {
    return this.inFlight.has(key)
  }
}

/** One cache of readings, keyed by whatever the caller says the answer depends on. */
export class ReadingCache {
  private readonly entries = new Map<string, { at: number; reading: DirectoryReading }>()
  private readonly flight = new SingleFlight<DirectoryReading>()

  constructor(
    private readonly ttlMs: number = DEFAULT_READING_TTL_MS,
    private readonly now: ReadingClock = () => Date.now(),
    private readonly staleMs: number = DEFAULT_READING_STALE_MS,
  ) {}

  /**
   * The reading for `key`, if this side has one worth answering with.
   *
   * @param key - what the reading depends on, spelled by the caller.
   * @returns the reading, or undefined when this side must go and read. A
   *   reading past its freshness window is still returned: the caller that only
   *   wants to answer from memory (see the route's fast pass) should answer with
   *   what it has, and the caller that may read goes through {@link read} instead
   *   and gets its refresh.
   */
  peek(key: string): DirectoryReading | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (this.now() - entry.at > this.staleMs) {
      this.entries.delete(key)
      return undefined
    }
    return entry.reading
  }

  /** Whether what {@link peek} would answer with is still fresh. */
  fresh(key: string): boolean {
    const entry = this.entries.get(key)
    return entry !== undefined && this.now() - entry.at <= this.ttlMs
  }

  /**
   * The reading for `key`, reading it if this side does not have it.
   *
   * A reading that is no longer fresh but still usable is returned AT ONCE, with
   * the read that replaces it started behind the answer: the reader gets their
   * list now and the next Tab gets the truth. A second caller for the same key
   * joins whatever read is already in flight instead of starting another — which
   * is the whole point of a warm, and why the background refresh is shared too.
   *
   * @param key - as {@link peek}.
   * @param produce - how to read it. A failure is NOT cached: a world that could
   *   not answer may answer next time, and remembering a rejection would turn
   *   one unlucky moment into a permanent one.
   */
  async read(key: string, produce: () => Promise<DirectoryReading>): Promise<DirectoryReading> {
    const cached = this.peek(key)
    if (cached !== undefined && this.fresh(key)) return cached
    if (cached !== undefined) {
      // Nothing is waiting on this one, so nothing may see it fail — and the host
      // treats an unhandled rejection as fatal. A world that stopped answering
      // between two Tabs (a device whose credential group is locked, say) costs
      // the reader the refresh, never the process.
      void this.refresh(key, produce).catch(() => undefined)
      return cached
    }
    return await this.refresh(key, produce)
  }

  /** Read `key` and remember it; shared with anyone else who asks meanwhile. */
  private refresh(key: string, produce: () => Promise<DirectoryReading>): Promise<DirectoryReading> {
    return this.flight.join(key, async () => {
      const reading = await produce()
      this.entries.set(key, { at: this.now(), reading })
      return reading
    })
  }

  /** Forget one key — what a `cd` does to the directory it left. */
  forget(key: string): void {
    this.entries.delete(key)
  }

  /** Whether a read for `key` is on the wire. */
  reading(key: string): boolean {
    return this.flight.has(key)
  }

  /** How many readings are held. For specs and for a sanity check, not for policy. */
  get size(): number {
    return this.entries.size
  }
}

/**
 * The key for one directory reading.
 *
 * The base directory is part of it because a relative path means a different
 * place under a different base, and the world is part of it because the same
 * path is a different directory on a device. Both are the caller's strings, kept
 * verbatim: a key that reinterpreted them would be the second copy of the
 * resolution rule this route exists to avoid.
 */
export function readingKey(world: string, path: string, base: string | undefined): string {
  return `${world}\u0000${path}\u0000${base ?? ''}`
}
