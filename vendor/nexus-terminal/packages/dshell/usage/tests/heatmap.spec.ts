/**
 * The heatmap's arithmetic: which cell holds which day, how the rectangle is
 * filled, and how a token count becomes a shade.
 *
 * The rule the reader sees is the corner one — the newest day must sit at the
 * bottom right — and that is exactly what a weekday-aligned grid gets wrong, so
 * it is pinned here rather than eyeballed in a browser.
 */

import { describe, expect, it } from 'vitest'
import { HEAT_LEVELS, HEAT_ROWS, heatmapColumns, heatmapTruncated } from '../src/client/heatmap.js'

/** One day's sum, as the host returns it. */
const day = (date: string, total: number, turns = 1): { day: string, total: number, turns: number } =>
  ({ day: date, total, turns })

/** Every cell of a grid, flattened in reading order, with the day it holds. */
function cells(days: readonly { day: string, total: number, turns: number }[], weeks: number, anchor: string) {
  return heatmapColumns(days, weeks, anchor).flat()
}

describe('heatmapColumns', () => {
  it('always draws a full rectangle, whatever the history', () => {
    const columns = heatmapColumns([day('2026-09-28', 5)], 4, '2026-09-28')
    expect(columns).toHaveLength(4)
    expect(columns.every(column => column.length === HEAT_ROWS)).toBe(true)
  })

  it('puts the newest day in the bottom-right corner', () => {
    const columns = heatmapColumns([day('2026-09-28', 5), day('2026-09-27', 3)], 4, '2026-09-28')
    const last = columns[columns.length - 1]!
    expect(last[HEAT_ROWS - 1]?.day).toBe('2026-09-28')
    // One day back from the anchor is the cell above it, not another column.
    expect(last[HEAT_ROWS - 2]?.day).toBe('2026-09-27')
  })

  it('keeps earlier days one cell up and then one column left', () => {
    const columns = heatmapColumns([day('2026-09-21', 1)], 4, '2026-09-28')
    // Seven days back from the anchor is the same row, one column to the left.
    const previous = columns[columns.length - 2]!
    expect(previous[HEAT_ROWS - 1]?.day).toBe('2026-09-21')
  })

  it('has no future: the anchor is the last day there is', () => {
    const flat = cells([day('2026-09-28', 1)], 2, '2026-09-28')
    expect(flat.every(cell => cell === undefined || cell.day <= '2026-09-28')).toBe(true)
  })

  it('shades by the busiest day and never exceeds the level count', () => {
    const flat = cells([day('2026-09-28', 100), day('2026-09-27', 1)], 2, '2026-09-28')
      .filter(cell => cell !== undefined)
    expect(flat.find(cell => cell.day === '2026-09-28')?.level).toBe(HEAT_LEVELS)
    expect(flat.find(cell => cell.day === '2026-09-27')?.level).toBe(1)
    expect(flat.every(cell => cell.level <= HEAT_LEVELS)).toBe(true)
  })

  it('draws nothing without days', () => {
    // A grid with no data is still a rectangle; the page hides it instead.
    expect(cells([], 2, '2026-09-28').every(cell => cell === undefined)).toBe(true)
  })
})

describe('heatmapTruncated', () => {
  it('reports history that fell off the left edge', () => {
    // Four weeks hold 28 cells: the anchor and the 27 days before it, so
    // 2026-09-01 is inside and 2026-08-31 is one day too old.
    expect(heatmapTruncated([day('2026-09-01', 1), day('2026-09-28', 1)], 4, '2026-09-28')).toBe(false)
    expect(heatmapTruncated([day('2026-08-31', 1), day('2026-09-28', 1)], 4, '2026-09-28')).toBe(true)
    expect(heatmapTruncated([], 4, '2026-09-28')).toBe(false)
  })
})
