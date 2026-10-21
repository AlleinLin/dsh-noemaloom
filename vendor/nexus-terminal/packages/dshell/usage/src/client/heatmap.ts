/**
 * The heatmap's layout: a fixed calendar rectangle of day cells.
 *
 * The grid is filled the way a page is read — top to bottom, then the next
 * column — so the newest day always sits in the BOTTOM-RIGHT corner. That is
 * the shape a reader expects from a "last 26 weeks" block, and it is why the
 * cells are not weekday-aligned: aligning columns to weeks would leave the most
 * recent day wherever its weekday happened to fall, which reads as a hole in the
 * corner rather than as "this is now".
 *
 * Pure and separate from the page for the same reason the fold is separate from
 * the store: the interesting part is date arithmetic (which day a cell holds,
 * which cells the history actually covers, how a token count becomes a shade),
 * and that is testable without a browser while a chart is not.
 *
 * Days are the host's own `YYYY-MM-DD` local days, and the anchor is the host's
 * today — the index bucketed by LOCAL day when it scanned, so the grid reads
 * them as local dates too, or a bucket would slide across a cell boundary near
 * midnight.
 */

/** How many shades a non-empty day can take, above "nothing recorded". */
export const HEAT_LEVELS = 4

/** The shape of the grid: columns of a week, however many weeks fit. */
export const HEAT_ROWS = 7

/** One day's sum, as the host returns it. */
export interface HeatDay {
  /** `YYYY-MM-DD`, the host's local day. */
  readonly day: string
  /** Every bucket summed, the same measure the charts use. */
  readonly total: number
  readonly turns: number
}

/** One day in the grid, with the shade it is drawn in. */
export interface HeatCell extends HeatDay {
  /** 0 for a day with nothing recorded, else 1…{@link HEAT_LEVELS}. */
  readonly level: number
}

/**
 * One column of the grid, top to bottom.
 *
 * A cell is `undefined` when the day is out of reach: before the history, or
 * after the anchor (a grid ending today has no future in it).
 */
export type HeatColumn = readonly (HeatCell | undefined)[]

/** The local date of a `YYYY-MM-DD` label, at local midnight. */
function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00`)
}

/** The `YYYY-MM-DD` label of a local date, the way the index spells days. */
function labelOf(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Lay the recorded days out in a full rectangle of `weeks` columns.
 *
 * The newest cell is the anchor: the last column's bottom cell holds the anchor
 * day, and every earlier cell steps back one day, so the grid reads oldest at
 * the top-left and newest at the bottom-right. The rectangle is always full —
 * cells the history does not reach are present but empty — because a grid that
 * grew and shrank with the data would move the corner as the history changed.
 *
 * @param days - one entry per recorded day, any order.
 * @param weeks - how many columns to draw.
 * @param anchor - the host's today, `YYYY-MM-DD`; the bottom-right cell.
 * @returns the columns, left to right.
 */
export function heatmapColumns(days: readonly HeatDay[], weeks: number, anchor: string): readonly HeatColumn[] {
  const byDay = new Map(days.map(day => [day.day, day]))
  const max = Math.max(1, ...days.map(day => day.total))
  const end = dateOf(anchor)
  const columns: HeatColumn[] = []
  for (let column = 0; column < weeks; column += 1) {
    const cells: (HeatCell | undefined)[] = []
    for (let row = 0; row < HEAT_ROWS; row += 1) {
      // Counted back from the anchor, so the loop's last cell is the anchor
      // itself however many columns the grid has.
      const back = (weeks - 1 - column) * HEAT_ROWS + (HEAT_ROWS - 1 - row)
      const date = new Date(end)
      date.setDate(date.getDate() - back)
      const label = labelOf(date)
      if (date.getTime() > end.getTime()) { cells.push(undefined); continue }
      const recorded = byDay.get(label)
      cells.push(recorded === undefined
        ? undefined
        : {
            ...recorded,
            level: recorded.total === 0
              ? 0
              : Math.min(HEAT_LEVELS, 1 + Math.floor((recorded.total / max) * (HEAT_LEVELS - 1))),
          })
    }
    columns.push(cells)
  }
  return columns
}

/**
 * Whether the history reaches further back than the grid draws.
 *
 * @param days - the same days handed to {@link heatmapColumns}.
 * @param weeks - the same width.
 * @param anchor - the same anchor.
 * @returns whether any recorded day fell off the left edge.
 */
export function heatmapTruncated(days: readonly HeatDay[], weeks: number, anchor: string): boolean {
  if (days.length === 0) return false
  const oldest = days.reduce((earliest, day) => (day.day < earliest ? day.day : earliest), days[0]!.day)
  const start = dateOf(anchor)
  start.setDate(start.getDate() - (weeks * HEAT_ROWS - 1))
  return dateOf(oldest).getTime() < start.getTime()
}
