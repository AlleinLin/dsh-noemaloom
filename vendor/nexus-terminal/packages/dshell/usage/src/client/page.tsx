/**
 * The usage page: one settings entry that charts what every model has cost.
 *
 * Everything on it comes from one host endpoint. `summary` reads the index,
 * `scan` extends it first — the host owns both the session events and the
 * index, so the browser asks for a rebuild rather than performing one.
 *
 * The two charts answer different questions and neither is derivable from the
 * other: the stacked area shows how the total moved over time and which route
 * moved it, and the pie shows what share each route holds across the whole
 * window. Both are hand-rolled SVG — the client bundle inlines its imports, and
 * a charting library would be the largest thing in it by an order of magnitude.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { DSHELL_USAGE_PATH } from '@nexus-aethra/dshell-std'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsageResponse, UsageSummary, UsageTotalRow } from '../protocol.js'
import { HEAT_LEVELS, heatmapColumns, heatmapTruncated } from './heatmap.js'

/** A fixed palette: a route keeps its colour as the window changes. */
const PALETTE = [
  '#5B8FF9', '#61DDAA', '#F6BD16', '#7262FD', '#78D3F8',
  '#9661BC', '#F6903D', '#008685', '#F08BB4', '#E8684A',
]

const RANGES = [
  { days: 7, key: 'range.7' },
  { days: 30, key: 'range.30' },
  { days: null, key: 'range.all' },
] as const

/** Compact token counts: the axis and the table both read better rounded. */
const counts = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

/** Rough sizes; the page is a settings column, not a full viewport. */
const CURVE = { width: 720, height: 200, padLeft: 56, padRight: 12, padTop: 12, padBottom: 24 }
const PIE = { size: 200, radius: 88, inner: 52 }
/** The heatmap's grid geometry: a fixed half-year block at settings scale. */
const HEAT = { cell: 13, gap: 3, weeks: 26 }
/** The heatmap's shades, from "a little" to "the busiest day", tinted like the first curve. */
const HEAT_SHADES = ['#5B8FF9', '#4a78e0', '#3c62c4', '#2f4da6']

/** Every bucket summed — the measure both charts and the table sort on. */
function total(buckets: { uncachedInputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }): number {
  return buckets.uncachedInputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens
}

/** One model's curve: the path across the days, and a point at each day. */
function linePoints(values: readonly number[], xs: readonly number[], y: (value: number) => number): string {
  return values.map((value, index) => `${String(xs[index])},${String(y(value))}`).join(' ')
}

/**
 * One ring segment.
 *
 * A segment covering the whole circle needs its own spelling: its start and end
 * points coincide, and an arc between coincident points draws nothing — which
 * is exactly what a reader with one model would see. The full turn is two half
 * turns, outer and inner wound in opposite directions so the middle stays open.
 */
function ringPath(start: number, end: number): string {
  const { size, radius, inner } = PIE
  const cx = size / 2
  const cy = size / 2
  const at = (r: number, angle: number): [number, number] => [
    cx + r * Math.cos(angle),
    cy + r * Math.sin(angle),
  ]
  if (end - start >= Math.PI * 2 - 1e-6) {
    const outer = `M${String(cx)},${String(cy - radius)}`
      + ` A${String(radius)},${String(radius)} 0 1 1 ${String(cx)},${String(cy + radius)}`
      + ` A${String(radius)},${String(radius)} 0 1 1 ${String(cx)},${String(cy - radius)} Z`
    const hole = `M${String(cx)},${String(cy - inner)}`
      + ` A${String(inner)},${String(inner)} 0 1 0 ${String(cx)},${String(cy + inner)}`
      + ` A${String(inner)},${String(inner)} 0 1 0 ${String(cx)},${String(cy - inner)} Z`
    return `${outer} ${hole}`
  }
  const [ox1, oy1] = at(radius, start)
  const [ox2, oy2] = at(radius, end)
  const [ix2, iy2] = at(inner, end)
  const [ix1, iy1] = at(inner, start)
  const large = end - start > Math.PI ? 1 : 0
  return `M${String(ox1)},${String(oy1)}`
    + ` A${String(radius)},${String(radius)} 0 ${String(large)} 1 ${String(ox2)},${String(oy2)}`
    + ` L${String(ix2)},${String(iy2)}`
    + ` A${String(inner)},${String(inner)} 0 ${String(large)} 0 ${String(ix1)},${String(iy1)} Z`
}

/** The page body. */
export function UsageSection({ t }: PropsLocale<'dshellUsage'>): ReactElement {
  const [days, setDays] = useState<number | null>(7)
  const [summary, setSummary] = useState<UsageSummary | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | undefined>(undefined)
  /** Sessions the last scan had to skip, so the page can say the totals are partial. */
  const [skipped, setSkipped] = useState<{ count: number, reason: string | undefined } | undefined>(undefined)

  const ask = useCallback(async (action: 'summary' | 'scan', window: number | null): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const response = await fetch(DSHELL_USAGE_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, days: window }),
      })
      const body = await response.json() as UsageResponse
      if ('error' in body) throw new Error(body.error)
      setSummary(body)
      // The counts come from the scan's own report: how many sessions exist,
      // how many of them needed decoding, and how many turns were counted are
      // three different numbers, and none of them is derivable from the rows
      // the page is about to draw.
      setNote(action === 'scan' && body.scanned !== undefined
        ? t('state.scanned', {
            sessions: counts.format(body.scanned.sessions),
            read: counts.format(body.scanned.read),
            turns: counts.format(body.scanned.turns),
          })
        : undefined)
      // A scan that skipped a session produced partial totals, and a reader who
      // is not told reads the number as the whole. The reason travels with it.
      setSkipped(body.scanned !== undefined && body.scanned.skipped > 0
        ? { count: body.scanned.skipped, reason: body.scanned.skipReason }
        : undefined)
    }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
    finally {
      setBusy(false)
    }
  }, [t])

  // Opening the page extends the index once — the host coalesces a burst of
  // opens behind its own interval — and a later window change only re-reads,
  // because the window is a query argument rather than a filter over one big
  // payload. Without that first scan a reader who never presses 「重新聚合」
  // would read a frozen index, which is what the page did before.
  const firstOpen = useRef(true)
  useEffect(() => {
    const action = firstOpen.current ? 'scan' : 'summary'
    firstOpen.current = false
    void ask(action, days)
  }, [ask, days])

  const curve = useMemo(() => {
    if (summary === undefined) return undefined
    const daysList = summary.daysList
    const models = summary.models
    if (daysList.length === 0 || models.length === 0) return undefined
    const span = CURVE.width - CURVE.padLeft - CURVE.padRight
    // A lone day has no interval to interpolate along, so it sits in the middle
    // of the plot rather than at its left edge.
    const xs = daysList.length === 1
      ? [CURVE.padLeft + span / 2]
      : daysList.map((_, index) => CURVE.padLeft + (index * span) / (daysList.length - 1))
    const seriesValues = models.map(model => daysList.map(day => summary.byDay
      .filter(row => row.day === day && `${row.provider}/${row.model}` === model)
      .reduce((sum, row) => sum + total(row), 0)))
    // Scaled to the highest single value, not to a stacked total: these are
    // separate curves, so each one has to be readable on its own.
    const max = Math.max(1, ...seriesValues.flat())
    const y = (value: number): number => CURVE.height - CURVE.padBottom
      - (value / max) * (CURVE.height - CURVE.padTop - CURVE.padBottom)
    return {
      xs,
      y,
      max,
      daysList,
      series: models.map((model, index) => ({
        model,
        color: PALETTE[index % PALETTE.length]!,
        points: linePoints(seriesValues[index]!, xs, y),
        markers: seriesValues[index]!.map((value, position) => ({ x: xs[position]!, y: y(value) })),
      })),
    }
  }, [summary])

  const pie = useMemo(() => {
    if (summary === undefined) return undefined
    const rows: UsageTotalRow[] = [...summary.totals]
    const sum = rows.reduce((carry, row) => carry + total(row), 0)
    if (sum === 0) return undefined
    let angle = -Math.PI / 2
    return {
      sum,
      slices: rows.map((row, index) => {
        const share = total(row) / sum
        const start = angle
        const end = angle + share * Math.PI * 2
        angle = end
        return { row, color: PALETTE[index % PALETTE.length]!, share, path: ringPath(start, end) }
      }),
    }
  }, [summary])

  /** The window's headline numbers: what the two charts are shares and shapes of. */
  const headline = useMemo(() => {
    if (summary === undefined) return undefined
    const sums = summary.totals.reduce((carry, row) => ({
      uncachedInputTokens: carry.uncachedInputTokens + row.uncachedInputTokens,
      outputTokens: carry.outputTokens + row.outputTokens,
      cacheReadTokens: carry.cacheReadTokens + row.cacheReadTokens,
      cacheWriteTokens: carry.cacheWriteTokens + row.cacheWriteTokens,
      turns: carry.turns + row.turns,
    }), { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 })
    const billed = sums.uncachedInputTokens + sums.cacheReadTokens
    return {
      ...sums,
      total: total(sums),
      // A hit rate is the one number that says whether the cache is working;
      // it is read over the input side only, which is where a cache read lands.
      hitRate: billed === 0 ? undefined : sums.cacheReadTokens / billed,
    }
  }, [summary])

  /** The calendar grid: a fixed rectangle of weeks, newest day at the bottom right. */
  const heat = useMemo(() => {
    if (summary === undefined || summary.heat.length === 0) return undefined
    const columns = heatmapColumns(summary.heat, HEAT.weeks, summary.today)
    if (columns.length === 0) return undefined
    return {
      columns,
      truncated: heatmapTruncated(summary.heat, HEAT.weeks, summary.today),
      busiest: Math.max(...summary.heat.map(day => day.total)),
    }
  }, [summary])

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '4px 2px' }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{t('title')}</h2>
        <p style={{ margin: 0, opacity: 0.7, lineHeight: 1.6 }}>{t('subtitle')}</p>
      </header>

      {heat !== undefined && (
        <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <figcaption style={{ opacity: 0.8 }}>{t('chart.heatmap')}</figcaption>
          {/* One row per day, filled top to bottom then the next column, so the
              newest day is always the bottom-right cell. */}
          <div style={{ display: 'flex', gap: HEAT.gap, overflowX: 'auto' }}>
            {heat.columns.map((column, index) => (
              <div key={`column-${String(index)}`} style={{ display: 'grid', gridTemplateRows: `repeat(7, ${String(HEAT.cell)}px)`, gap: HEAT.gap }}>
                {column.map((cell, slot) => cell === undefined
                  ? <span key={`empty-${String(slot)}`} style={{ width: HEAT.cell, height: HEAT.cell, borderRadius: 3, background: 'currentColor', opacity: 0.06 }} />
                  : (
                      <span
                        key={cell.day}
                        title={t('chart.heatmapDay', {
                          day: cell.day,
                          total: counts.format(cell.total),
                          turns: counts.format(cell.turns),
                        })}
                        style={{
                          width: HEAT.cell, height: HEAT.cell, borderRadius: 3,
                          background: cell.level === 0 ? 'currentColor' : HEAT_SHADES[cell.level - 1],
                          opacity: cell.level === 0 ? 0.06 : 0.35 + (cell.level / HEAT_LEVELS) * 0.65,
                        }}
                      />
                    ))}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, opacity: 0.7 }}>
            <span>{t('chart.heatmapLess')}</span>
            {[0, 1, 2, 3, 4].map(level => (
              <span key={String(level)} style={{
                width: HEAT.cell, height: HEAT.cell, borderRadius: 3,
                background: level === 0 ? 'currentColor' : HEAT_SHADES[level - 1],
                opacity: level === 0 ? 0.06 : 0.35 + (level / HEAT_LEVELS) * 0.65,
              }} />
            ))}
            <span>{t('chart.heatmapMore')}</span>
            <span style={{ marginLeft: 6, opacity: 0.8 }}>
              {t('chart.heatmapPeak', { total: counts.format(heat.busiest) })}
            </span>
            {heat.truncated ? <span style={{ opacity: 0.8 }}>· {t('chart.heatmapTruncated')}</span> : null}
          </div>
        </figure>
      )}


      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ opacity: 0.7 }}>{t('range.label')}</span>
        {RANGES.map(range => (
          <button
            key={range.key}
            type="button"
            onClick={() => { setDays(range.days) }}
            /* Selection is stated with weight, edge and emphasis rather than an
               inverted fill: an inverted fill needs a surface colour that reads
               against it, and inventing one goes dark-on-dark in a theme this
               page does not own. */
            style={{
              padding: '4px 12px',
              borderRadius: 999,
              cursor: 'pointer',
              border: days === range.days ? '1.5px solid currentColor' : '1px solid currentColor',
              background: 'transparent',
              color: 'inherit',
              fontWeight: days === range.days ? 600 : 400,
              opacity: days === range.days ? 1 : 0.55,
            }}
          >
            {t(range.key)}
          </button>
        ))}
        <button
          type="button"
          disabled={busy}
          onClick={() => { void ask('scan', days) }}
          style={{ marginLeft: 'auto', padding: '4px 14px', borderRadius: 6, cursor: busy ? 'default' : 'pointer' }}
        >
          {busy ? t('rebuild.busy') : t('rebuild')}
        </button>
      </div>

      {summary?.scannedAt != null && (
        <div style={{ opacity: 0.6, fontSize: 12 }}>
          {t('state.freshness', { day: summary.scannedAt })}
          {note === undefined ? '' : ` · ${note}`}
        </div>
      )}

      {skipped !== undefined && (
        <div
          style={{
            fontSize: 12, lineHeight: 1.6, padding: '6px 10px', borderRadius: 8,
            color: 'var(--dsw-alias-state-warning-primary, #b45309)',
            background: 'var(--dsw-alias-interactive-bg-hover-warning, rgba(245,158,11,.12))',
          }}
          title={skipped.reason}
        >
          {t('state.skipped', { count: counts.format(skipped.count) })}
          {skipped.reason === undefined ? null : (
            <span style={{ opacity: 0.7 }}> · {shorten(skipped.reason, 120)}</span>
          )}
        </div>
      )}

      {error !== undefined && (
        <div style={{ color: 'var(--dsh-danger, #c0392b)', fontSize: 13 }}>{t('state.error', { reason: error })}</div>
      )}

      {summary === undefined && error === undefined && <div style={{ opacity: 0.6 }}>{t('state.loading')}</div>}

      {headline !== undefined && headline.turns > 0 && (
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          {([
            ['summary.total', counts.format(headline.total)],
            ['summary.uncached', counts.format(headline.uncachedInputTokens)],
            ['summary.output', counts.format(headline.outputTokens)],
            ['summary.cacheRead', counts.format(headline.cacheReadTokens)],
            ['summary.turns', counts.format(headline.turns)],
            ...headline.hitRate === undefined
              ? []
              : [['summary.hitRate', `${(headline.hitRate * 100).toFixed(1)}%`] as const],
          ] as const).map(([key, value]) => (
            <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 11, opacity: 0.6 }}>{t(key)}</span>
              <span style={{ fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
            </div>
          ))}
        </div>
      )}

      {summary !== undefined && curve === undefined && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <strong>{t('state.empty.title')}</strong>
          <span style={{ opacity: 0.7 }}>{t('state.empty.body')}</span>
        </div>
      )}

      {curve !== undefined && (
        <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <figcaption style={{ opacity: 0.8 }}>{t('chart.curve')}</figcaption>
          <svg viewBox={`0 0 ${String(CURVE.width)} ${String(CURVE.height)}`} style={{ width: '100%', height: 'auto' }} role="img">
            {[0, 0.5, 1].map(fraction => {
              const value = curve.max * fraction
              return (
                <g key={fraction}>
                  <line
                    x1={CURVE.padLeft} x2={CURVE.width - CURVE.padRight}
                    y1={curve.y(value)} y2={curve.y(value)}
                    stroke="currentColor" strokeOpacity={0.15} strokeDasharray={fraction === 0 ? undefined : '3 3'}
                  />
                  <text x={CURVE.padLeft - 8} y={curve.y(value) + 4} textAnchor="end" fontSize={10} fill="currentColor" fillOpacity={0.6}>
                    {counts.format(value)}
                  </text>
                </g>
              )
            })}
            {curve.series.map(series => (
              <g key={series.model}>
                <polyline points={series.points} fill="none" stroke={series.color} strokeWidth={2} strokeLinejoin="round" />
                {series.markers.map((marker, position) => (
                  <circle key={`${series.model}-${String(position)}`} cx={marker.x} cy={marker.y} r={3} fill={series.color} />
                ))}
              </g>
            ))}
            {curve.daysList.map((day, index) => (
              index % Math.ceil(curve.daysList.length / 8) === 0
                ? (
                    <text key={day} x={curve.xs[index]} y={CURVE.height - 6} textAnchor="middle" fontSize={10} fill="currentColor" fillOpacity={0.6}>
                      {day.slice(5)}
                    </text>
                  )
                : null
            ))}
          </svg>
          <Legend series={curve.series} />
        </figure>
      )}

      {pie !== undefined && (
        <figure style={{ margin: 0, display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <figcaption style={{ opacity: 0.8, alignSelf: 'flex-start' }}>{t('chart.pie')}</figcaption>
          <svg viewBox={`0 0 ${String(PIE.size)} ${String(PIE.size)}`} style={{ width: PIE.size, height: PIE.size }} role="img">
            {pie.slices.map(slice => (
              <path
                key={`${slice.row.provider}/${slice.row.model}`}
                d={slice.path}
                fill={slice.color}
                fillOpacity={0.85}
                fillRule="evenodd"
              />
            ))}
            {/* The hole is the point of a ring: it holds the number the slices
                are shares of, so the reader does not have to add them up. */}
            <text x={PIE.size / 2} y={PIE.size / 2 - 2} textAnchor="middle" fontSize={16} fill="currentColor">
              {counts.format(pie.sum)}
            </text>
            <text x={PIE.size / 2} y={PIE.size / 2 + 14} textAnchor="middle" fontSize={10} fill="currentColor" fillOpacity={0.6}>
              tok
            </text>
          </svg>
          <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ opacity: 0.7 }}>
                <th style={cellStyle('left')}>{t('table.model')}</th>
                <th style={cellStyle('right')}>{t('table.total')}</th>
                <th style={cellStyle('right')}>{t('table.turns')}</th>
              </tr>
            </thead>
            <tbody>
              {pie.slices.map(slice => (
                <tr key={`${slice.row.provider}/${slice.row.model}`}>
                  <td style={cellStyle('left')}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: slice.color, marginRight: 6 }} />
                    {slice.row.model}
                    <span style={{ opacity: 0.5, marginLeft: 6 }}>{slice.row.provider}</span>
                  </td>
                  <td style={cellStyle('right')}>{counts.format(total(slice.row))} <span style={{ opacity: 0.5 }}>({(slice.share * 100).toFixed(1)}%)</span></td>
                  <td style={cellStyle('right')}>{counts.format(slice.row.turns)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </figure>
      )}

      {pie !== undefined && (
        <details>
          <summary style={{ cursor: 'pointer', opacity: 0.8 }}>{t('table.title')}</summary>
          <table style={{ borderCollapse: 'collapse', fontSize: 13, marginTop: 10, width: '100%' }}>
            <thead>
              <tr style={{ opacity: 0.7 }}>
                <th style={cellStyle('left')}>{t('table.model')}</th>
                <th style={cellStyle('right')}>{t('table.input')}</th>
                <th style={cellStyle('right')}>{t('table.output')}</th>
                <th style={cellStyle('right')}>{t('table.cacheRead')}</th>
                <th style={cellStyle('right')}>{t('table.cacheWrite')}</th>
                <th style={cellStyle('right')}>{t('table.turns')}</th>
                <th style={cellStyle('right')}>{t('table.total')}</th>
              </tr>
            </thead>
            <tbody>
              {summary?.totals.map((row, index) => (
                <tr key={`${row.provider}/${row.model}`}>
                  <td style={cellStyle('left')}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: PALETTE[index % PALETTE.length], marginRight: 6 }} />
                    {row.model}
                    <span style={{ opacity: 0.5, marginLeft: 6 }}>{row.provider}</span>
                  </td>
                  <td style={cellStyle('right')}>{counts.format(row.uncachedInputTokens)}</td>
                  <td style={cellStyle('right')}>{counts.format(row.outputTokens)}</td>
                  <td style={cellStyle('right')}>{counts.format(row.cacheReadTokens)}</td>
                  <td style={cellStyle('right')}>{counts.format(row.cacheWriteTokens)}</td>
                  <td style={cellStyle('right')}>{counts.format(row.turns)}</td>
                  <td style={cellStyle('right')}>{counts.format(total(row))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  )
}

/** The curve's colour key, in the order the lines are drawn. */
function Legend({ series }: { series: readonly { model: string, color: string }[] }): ReactElement {
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12 }}>
      {series.map(entry => (
        <span key={entry.model} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: entry.color }} />
          {entry.model}
        </span>
      ))}
    </div>
  )
}

/** One table cell's alignment and padding, so the two tables match. */
function cellStyle(align: 'left' | 'right'): { textAlign: 'left' | 'right', padding: string } {
  return { textAlign: align, padding: '3px 10px 3px 0' }
}

/**
 * Shorten a host error for a one-line note.
 *
 * A refusal names the session, the reason and the log path — useful, and far too
 * long to sit in a settings line; the full text stays in the note's `title`.
 */
function shorten(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
