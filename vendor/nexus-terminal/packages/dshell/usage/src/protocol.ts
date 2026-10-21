/**
 * The usage index's wire and storage shapes.
 *
 * One request type and one response type, because the page both reads the
 * aggregate and asks for a scan through the same endpoint — the scan belongs to
 * the host, which is where the session events already are.
 */

/** What the browser can ask of the usage endpoint. */
export interface UsageRequest {
  /** `scan` extends the index first, then answers with the same summary. */
  readonly action: 'summary' | 'scan'
  /** Window length in days, or null for everything on record. */
  readonly days: number | null
}

/**
 * The four buckets a provider reports, kept apart rather than summed.
 *
 * They are not interchangeable: a cache read is what makes a long session
 * affordable and a cache write is what made it expensive, so a single "total"
 * hides the only number a reader can act on.
 */
export interface UsageBuckets {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** Model turns that reported these buckets — one per assistant step. */
  readonly turns: number
}

/** One day's usage for one route, as the curve reads it. */
export interface UsageDayRow extends UsageBuckets {
  /** `YYYY-MM-DD` in the host's own local time. */
  readonly day: string
  readonly provider: string
  readonly model: string
}

/** One route's total across the requested window, as the pie and table read it. */
export interface UsageTotalRow extends UsageBuckets {
  readonly provider: string
  readonly model: string
}

/** One day's total, for the calendar. One entry per recorded day, oldest first. */
export interface UsageHeatDay {
  readonly day: string
  /** Every bucket summed across every route that day. */
  readonly total: number
  readonly turns: number
}

/** What the page renders, in one response. */
export interface UsageSummary {
  /** Whether a scan has ever completed. False renders the empty state. */
  readonly built: boolean
  /** The window the rows cover, or null for everything on record. */
  readonly days: number | null
  /** The local day the index was last extended, for the page's freshness line. */
  readonly scannedAt: string | null
  /**
   * The host's own today, `YYYY-MM-DD`.
   *
   * The calendar anchors on it (its newest cell is this day), and the browser
   * does not compute it: the days in the index are HOST-local, and a reader on
   * another machine or in another timezone would otherwise draw the last day in
   * the wrong corner.
   */
  readonly today: string
  /** Distinct local days present, oldest first, so the curve has its x-axis. */
  readonly daysList: readonly string[]
  /** Routes present in the window, so the pie and the table agree. */
  readonly models: readonly string[]
  readonly byDay: readonly UsageDayRow[]
  readonly totals: readonly UsageTotalRow[]
  /**
   * Day totals over ALL time, whatever `days` the charts were asked for.
   *
   * The calendar is a rhythm rather than a window: it answers "which days do I
   * burn tokens on", so it keeps its own span while the range chips move the
   * charts, and it does not shrink to two squares when the reader picks 7 days.
   */
  readonly heat: readonly UsageHeatDay[]
  /**
   * What the scan that produced this answer did, present only on a `scan`
   * action. The page reports these numbers, so they come from the scan itself
   * and not from anything the page can count on the summary — the two are
   * different quantities and only one of them is "how many sessions".
   */
  readonly scanned?: UsageScanReport
}

/** One scan's own counts. */
export interface UsageScanReport {
  /** Sessions the query engine listed, whether or not they were read. */
  readonly sessions: number
  /** Sessions whose logs were decoded, because they had grown. */
  readonly read: number
  /** Model turns counted from those logs. */
  readonly turns: number
  /**
   * Sessions whose log could not be decoded — a refusal by dsh's own migration
   * or a damaged file. Their usage is missing from the totals, so the page says
   * so instead of presenting a partial number as the whole.
   */
  readonly skipped: number
  /** Why the first skipped session was skipped; absent when nothing was. */
  readonly skipReason?: string
}

/** A summary response, or a refusal the page renders verbatim. */
export type UsageResponse = UsageSummary | { readonly error: string }

/** The composite key a bucket is stored under. */
export interface UsageKey {
  readonly day: string
  readonly provider: string
  readonly model: string
}
