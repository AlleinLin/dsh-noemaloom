/**
 * The device panel: what is running on the machine this session is bound to.
 *
 * Four pages, because a reader opens the panel for one question and the other
 * three lists are noise until asked for: 概览 (the machine and its load),
 * 进程, 容器, 监听端口.
 *
 * The list pages are TOOLS, not a readout: a machine with two hundred
 * processes and forty sockets cannot be read by scrolling, so each one can be
 * filtered by what the reader knows (a name, a port, an owner) and ordered by
 * any of its columns, with a second column breaking the first one's ties.
 * A row opens to show what the list cannot fit: the whole command line, the
 * owner, the state, how long it has been running.
 *
 * The heads and the rows are ONE grid: when they are two layouts, the columns
 * drift apart and a reader who aims at "CPU" sorts by memory.
 *
 * The load is NOT asked for again: the status chip polls it, the panel reads
 * the same answer, and two readers of one machine cost one round trip.
 *
 * What is drawn is decided elsewhere ({@link devicePanelView}): this file is
 * layout, and the decisions it would otherwise make are the ones that can be
 * wrong.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Input, SegmentedTabs, Tag, type SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the right-Sidebar SlotMap merge (the tab-body seat + its hooks).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { DshellForwardResponse, DshellForwardView } from '@nexus-aethra/dshell-std'
import { deviceDetailSeat } from './device-detail.js'
import { deviceForwardSeat, forwardFor, forwardLabel, readForwards } from './device-forward.js'
import { deviceMetricsSeat } from './device-metrics.js'
import {
  devicePanelView,
  filterContainerRows,
  filterPortRows,
  filterProcessRows,
  flipSort,
  nextSort,
  sortContainerRows,
  sortPortRows,
  sortProcessRows,
  type ContainerSortKey,
  type DevicePanelContainerRow,
  type DevicePanelPage,
  type DevicePanelPortRow,
  type DevicePanelProcessRow,
  type DevicePanelStat,
  type PortSortKey,
  type ProcessSortKey,
  type SortDirection,
  type SortKey,
} from './device-panel-view.js'
import { DeviceGlyph } from './device-definition.js'
import { DEVICE_NOTE_KEYS } from './locales.js'
import type {} from './locales.js'

/** The panel's composed props: the tab it draws, and its copy. */
export type DevicePanelProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'dshellMode'>

/**
 * The columns of each list, as ONE grid.
 *
 * The heads and the rows share it, so a column is where its head says it is
 * and a click on the head reaches the column it names.
 *
 * The numeric columns are wide enough for their head AND its direction
 * control: a head that has to be clipped is a head that cannot be read.
 */
const PROCESS_COLUMNS = '44px minmax(0, 1fr) 58px 58px'
const PORT_COLUMNS = '44px 48px minmax(0, 1fr) minmax(0, 110px) 72px'

/** The answer a panel draws before the host has said anything about forwards. */
const EMPTY_FORWARDS: DshellForwardResponse = { forwards: [] }
const CONTAINER_COLUMNS = 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, auto)'

/**
 * The room a head's direction control takes, and the gap before it.
 *
 * A right-aligned value lines up under its head's NAME, not under the control
 * that sits beside the name — so the value gives the control's room back.
 */
const HEAD_CONTROL = 21

/**
 * The direction a column joins the order in.
 *
 * A number reads best from the top down — the busiest process first — and a
 * name from the top up. A column that has never been sorted still has to
 * start somewhere, and this is where.
 */
const PROCESS_FALLBACK: Readonly<Record<ProcessSortKey, SortDirection>> = {
  cpu: 'desc',
  memory: 'desc',
  pid: 'asc',
  name: 'asc',
  user: 'asc',
  elapsed: 'desc',
}
const PORT_FALLBACK: Readonly<Record<PortSortKey, SortDirection>> = {
  port: 'asc',
  proto: 'asc',
  address: 'asc',
  process: 'asc',
}
const CONTAINER_FALLBACK: Readonly<Record<ContainerSortKey, SortDirection>> = {
  name: 'asc',
  image: 'asc',
  state: 'asc',
}

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flex: 1,
    overflow: 'hidden',
    fontSize: 13,
    lineHeight: 1.4,
  } as CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    height: 28,
    padding: '2px 8px',
    flex: '0 0 auto',
  } as CSSProperties,
  headerGlyph: {
    display: 'inline-flex',
    alignItems: 'center',
    color: 'var(--dsw-alias-label-secondary)',
  } as CSSProperties,
  headerSpacer: { flex: '1 1 auto' } as CSSProperties,
  iconButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    padding: 0,
    border: 'none',
    borderRadius: 5,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    opacity: 0.8,
  } as CSSProperties,
  pages: {
    padding: '8px 8px 4px',
    flex: '0 0 auto',
  } as CSSProperties,
  body: {
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    padding: '4px 8px 12px',
  } as CSSProperties,
  /** The machine block: the kind, the name, the endpoint. */
  machine: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    padding: '10px 0 14px',
  } as CSSProperties,
  machineTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  } as CSSProperties,
  /** The label above the name: small, tracked out, quiet. */
  eyebrow: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: 'var(--dsw-alias-label-tertiary)',
    opacity: 0.6,
  } as CSSProperties,
  /** The machine's name: the largest thing on the page, and it says so. */
  machineName: {
    fontSize: 20,
    fontWeight: 600,
    lineHeight: 1.15,
    letterSpacing: -0.4,
    color: 'var(--dsw-alias-label-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as CSSProperties,
  endpoint: {
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    fontSize: 12,
    color: 'var(--dsw-alias-label-tertiary)',
  } as CSSProperties,
  /** The load: three readouts, framed by the pane's hairlines. */
  load: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 8,
    padding: '13px 0 15px',
    borderTop: '0.5px solid var(--dsw-alias-border-l3)',
    borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
  } as CSSProperties,
  stat: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    minWidth: 0,
  } as CSSProperties,
  statLabel: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: 'var(--dsw-alias-label-tertiary)',
  } as CSSProperties,
  statValue: {
    fontSize: 16,
    fontWeight: 500,
    lineHeight: 1.2,
    color: 'var(--dsw-alias-label-primary)',
  } as CSSProperties,
  statDetail: {
    fontSize: 10,
    color: 'var(--dsw-alias-label-quaternary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as CSSProperties,
  /** A group of rows: a foldable header, then the rows themselves. */
  group: { marginTop: 10 } as CSSProperties,
  hint: {
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    fontSize: 10,
    letterSpacing: 0.4,
    color: 'var(--dsw-alias-label-quaternary)',
  } as CSSProperties,
  /** The filter line above a list. */
  filter: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 0 4px',
  } as CSSProperties,
  /** How many rows the list has, beside the filter that narrows it. */
  count: {
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    fontSize: 11,
    color: 'var(--dsw-alias-label-tertiary)',
    whiteSpace: 'nowrap',
  } as CSSProperties,
  /** The column heads: what the list can be ordered by. */
  heads: {
    display: 'grid',
    alignItems: 'center',
    gap: 8,
    padding: '2px 0 4px',
    fontSize: 10,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: 'var(--dsw-alias-label-quaternary)',
  } as CSSProperties,
  /** One head: the column's name and the control that turns it around. */
  headCell: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    minWidth: 0,
  } as CSSProperties,
  headCellRight: { justifyContent: 'flex-end' } as CSSProperties,
  /**
   * The column's NAME: clicking it sorts by this column.
   *
   * Its colour is not set here — the stylesheet owns the resting, sorted and
   * hovered states, because an inline colour cannot be hovered.
   */
  head: {
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    letterSpacing: 'inherit',
    textTransform: 'inherit',
    padding: 0,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as CSSProperties,
  headLabel: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } as CSSProperties,
  /** Which key this column is in the order, when there is more than one. */
  headRank: {
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    fontSize: 9,
    opacity: 0.75,
  } as CSSProperties,
  /**
   * The direction control: its own button, beside the name it belongs to.
   *
   * It is a button of its own because it answers a different question than
   * the name does — WHICH WAY — and it keeps the rest of the order.
   */
  headArrow: {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    width: 18,
    height: 14,
    padding: 0,
    border: 'none',
    borderRadius: 3,
    background: 'transparent',
    cursor: 'pointer',
  } as CSSProperties,
  /** One row of a list: flat, a hairline under it, 24px tall. */
  row: {
    display: 'grid',
    alignItems: 'center',
    gap: 8,
    minHeight: 24,
    padding: '2px 0',
    borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
    // A row is a button, not a paragraph: a drag across it should not paint
    // the text blue.
    userSelect: 'none',
  } as CSSProperties,
  rowOpen: {
    background: 'var(--dsw-alias-interactive-bg-hover)',
  } as CSSProperties,
  rowLast: {
    borderBottom: 'none',
  } as CSSProperties,
  mono: {
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    fontSize: 11,
  } as CSSProperties,
  cell: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as CSSProperties,
  number: {
    textAlign: 'right',
    // The value sits under its head's name, and the name has the direction
    // control beside it.
    paddingRight: HEAD_CONTROL,
  } as CSSProperties,
  dim: { color: 'var(--dsw-alias-label-tertiary)' } as CSSProperties,
  good: { color: 'var(--dsw-alias-state-business-primary)' } as CSSProperties,
  /** The process holding a socket: a link, because it leads somewhere. */
  holder: {
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    font: 'inherit',
    padding: 0,
    cursor: 'pointer',
    textAlign: 'right',
    paddingRight: HEAD_CONTROL,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as CSSProperties,
  /** The forward button on a port row: a small, quiet action. */
  forward: {
    border: '0.5px solid var(--dsw-alias-border-l3)',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    font: 'inherit',
    fontSize: 11,
    padding: '1px 6px',
    borderRadius: 3,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  } as CSSProperties,
  /** The same button, for a port that already has a forward. */
  forwardOn: {
    border: '0.5px solid var(--dsw-alias-border-l3)',
    background: 'transparent',
    color: 'var(--dsw-alias-state-business-primary)',
    font: 'inherit',
    fontSize: 11,
    padding: '1px 6px',
    borderRadius: 3,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  } as CSSProperties,
  /** The container's state, with the dot that says whether it is healthy. */
  stateWrap: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    justifyContent: 'flex-end',
    paddingRight: HEAD_CONTROL,
    minWidth: 0,
  } as CSSProperties,
  stateDot: {
    flex: '0 0 auto',
    width: 5,
    height: 5,
    borderRadius: 3,
    background: 'var(--dsw-alias-state-business-primary)',
  } as CSSProperties,
  /** The details a row opens to show. */
  details: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    padding: '2px 0 8px 22px',
    fontSize: 11,
    color: 'var(--dsw-alias-label-tertiary)',
  } as CSSProperties,
  detailLine: {
    display: 'flex',
    gap: 6,
    alignItems: 'baseline',
  } as CSSProperties,
  detailKey: {
    flex: '0 0 auto',
    minWidth: 52,
    color: 'var(--dsw-alias-label-quaternary)',
  } as CSSProperties,
  detailValue: {
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    color: 'var(--dsw-alias-label-secondary)',
    wordBreak: 'break-all',
  } as CSSProperties,
  note: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 6,
    fontSize: 12,
    color: 'var(--dsw-alias-label-secondary)',
    opacity: 0.7,
  } as CSSProperties,
  noteDot: {
    flex: '0 0 auto',
    marginTop: 6,
    width: 4,
    height: 4,
    borderRadius: 2,
    background: 'var(--dsw-alias-label-quaternary)',
  } as CSSProperties,
  empty: {
    padding: '8px 0',
    fontSize: 12,
    color: 'var(--dsw-alias-label-tertiary)',
    opacity: 0.6,
  } as CSSProperties,
  error: {
    padding: '6px 0',
    fontSize: 12,
    color: 'var(--dsw-alias-state-error-primary)',
  } as CSSProperties,
}

/**
 * Row-hover treatment, and the states of the column heads.
 *
 * Inline styles cannot express `:hover`, and a highlighted row is most of
 * what tells a reader which line the pointer is on — so one packaged style
 * element carries it, scoped to this panel's own data attributes so it cannot
 * affect stock chrome. The rows' resting background lives here too: a
 * stylesheet `:hover` rule cannot override an inline declaration.
 *
 * The heads live here for the same reason, and for one more: the colour of a
 * head says whether the column is sorted and whether the pointer is on it, and
 * an inline colour cannot be either.
 */
function injectHoverCss(): () => void {
  const style = document.createElement('style')
  style.dataset.dshell = 'device-panel'
  style.textContent = [
    '[data-dshell-device-row] { background: transparent; transition: background 100ms ease; }',
    '[data-dshell-device-row]:hover { background: var(--dsw-alias-interactive-bg-hover); }',
    // A column's name: quiet until it is used, brighter when it is sorted,
    // brightest when the pointer is on it.
    '[data-dshell-device-head] { color: var(--dsw-alias-label-quaternary); transition: color 100ms ease; }',
    '[data-dshell-device-head][data-sorted="true"] { color: var(--dsw-alias-label-secondary); }',
    '[data-dshell-device-head]:hover { color: var(--dsw-alias-label-primary); }',
    // The direction control: always there, so every column reads as sortable,
    // and unmistakable when it is the one that is doing the sorting.
    '[data-dshell-device-arrow] { color: var(--dsw-alias-label-quaternary); opacity: 0.4; transition: opacity 100ms ease, color 100ms ease; }',
    '[data-dshell-device-arrow][data-sorted="true"] { color: var(--dsw-alias-label-primary); opacity: 1; }',
    '[data-dshell-device-arrow]:hover { opacity: 1; color: var(--dsw-alias-label-primary); }',
  ].join('\n')
  document.head.appendChild(style)
  return () => { style.remove() }
}

/** One readout of the load: a label, a number, the fact underneath. */
function Stat({ stat, t }: { stat: DevicePanelStat; t: DevicePanelProps['t'] }): ReactNode {
  return (
    <div style={styles.stat}>
      <span style={styles.statLabel}>{t(stat.label)}</span>
      <span style={styles.statValue}>{stat.value}</span>
      {stat.detail === undefined
        ? null
        : (
          <span style={styles.statDetail}>
            {stat.label === 'device.load.cpu' ? `${stat.detail} ${t('device.load.cores')}` : stat.detail}
          </span>
        )}
    </div>
  )
}

/** A search glyph for the filter line. */
function SearchGlyph(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round">
      <circle cx="6.6" cy="6.6" r="4.6" />
      <path d="M10.2 10.2L14 14" />
    </svg>
  )
}

/**
 * A column head that sorts.
 *
 * TWO controls, because they answer two different questions. The NAME asks
 * "sort by this column" and replaces the order; the CONTROL asks "which way",
 * and turns this column around WITHOUT throwing away the tie-break the reader
 * set up beside it.
 *
 * The column's key is NOT called `key`. React reserves that name, eats it out
 * of the props before the component is ever called, and hands the component
 * nothing — which is how every head came to sort by nothing at all, and how
 * four heads could end up wearing the same "1" badge.
 *
 * @param props - the column, the order it is in, and what to ask for.
 * @returns the head: a name and a direction control.
 */
export function SortHead<K extends string>({ label, sorts, column, onSort, onFlip, align, fallback, t }: {
  label: string
  /** The order as it is now: the first key decides, the rest break its ties. */
  sorts: readonly SortKey<K>[]
  /** The column this head belongs to. NOT `key` — React would eat that. */
  column: K
  /** The reader asked for this column to decide. */
  onSort: (column: K, shift: boolean) => void
  /** The reader asked for this column to turn around. */
  onFlip: (column: K) => void
  /** Which way the values sit in the column. */
  align?: 'right' | undefined
  /** The direction this column joins the order in. */
  fallback: SortDirection
  /** The reader's copy. */
  t: DevicePanelProps['t']
}): ReactNode {
  const index = sorts.findIndex(entry => entry.key === column)
  const entry = index === -1 ? undefined : sorts[index]
  const sorted = entry !== undefined
  const direction = entry?.direction ?? fallback
  // The rank is only worth printing when there is a rank to be: one key is
  // always the first one, and saying so is noise.
  const rank = sorts.length > 1 && sorted ? String(index + 1) : undefined
  return (
    <div
      style={{
        ...styles.headCell,
        ...(align === 'right' ? styles.headCellRight : {}),
      }}
    >
      <button
        type="button"
        data-dshell-device-head={column}
        data-sorted={sorted ? 'true' : 'false'}
        style={styles.head}
        title={t('device.head.sort', { column: label })}
        onClick={(event) => { onSort(column, event.shiftKey) }}
      >
        <span style={styles.headLabel}>{label}</span>
      </button>
      <button
        type="button"
        data-dshell-device-arrow={column}
        data-sorted={sorted ? 'true' : 'false'}
        style={styles.headArrow}
        title={t('device.head.flip', { column: label })}
        aria-label={t('device.head.flip', { column: label })}
        onClick={() => { onFlip(column) }}
      >
        {rank === undefined ? null : <span style={styles.headRank}>{rank}</span>}
        <svg width="7" height="7" viewBox="0 0 8 8" aria-hidden="true" focusable="false">
          <path
            d={direction === 'asc' ? 'M4 1 L7 6.5 L1 6.5 Z' : 'M4 7 L7 1.5 L1 1.5 Z'}
            fill="currentColor"
          />
        </svg>
      </button>
    </div>
  )
}

/**
 * How many rows a list has, printed beside the filter that narrows it.
 *
 * A filter hides rows, and a reader who cannot see how many are left cannot
 * tell a short list from a narrow one — so when the two differ, both are said.
 */
function countText(shown: number, total: number, t: DevicePanelProps['t']): string {
  return shown === total ? String(total) : t('device.list.count', { shown, total })
}

/** How long a process has been running, in the reader's language. */
function elapsedText(seconds: number | undefined, t: DevicePanelProps['t']): string {
  if (seconds === undefined) return '—'
  if (seconds < 60) return t('device.process.elapsed.seconds', { seconds })
  if (seconds < 3600) return t('device.process.elapsed.minutes', { minutes: Math.floor(seconds / 60) })
  if (seconds < 86_400) return t('device.process.elapsed.hours', { hours: Math.floor(seconds / 3600) })
  return t('device.process.elapsed.days', { days: Math.floor(seconds / 86_400) })
}

/** A row of the process list: pid, command, and the two shares. */
function ProcessRow({ row, open, onOpen, last, t }: {
  row: DevicePanelProcessRow
  open: boolean
  onOpen: (pid: number) => void
  last: boolean
  t: DevicePanelProps['t']
}): ReactNode {
  return (
    <>
      <div
        data-dshell-device-row="process"
        style={{
          ...styles.row,
          gridTemplateColumns: PROCESS_COLUMNS,
          ...(open ? styles.rowOpen : {}),
          ...(last ? styles.rowLast : {}),
        }}
        onClick={() => { onOpen(row.pid) }}
      >
        <span style={{ ...styles.mono, ...styles.dim, ...styles.cell }}>{String(row.pid)}</span>
        <span style={styles.cell}>{row.command}</span>
        <span style={{ ...styles.mono, ...styles.number }}>{`${row.cpu.toFixed(1)}%`}</span>
        <span style={{ ...styles.mono, ...styles.number, ...styles.dim }}>{`${row.memory.toFixed(1)}%`}</span>
      </div>
      {open
        ? (
          <div style={styles.details}>
            <div style={styles.detailLine}>
              <span style={styles.detailKey}>{t('device.process.detail.user')}</span>
              <span style={styles.detailValue}>{row.user === '' ? '—' : row.user}</span>
            </div>
            <div style={styles.detailLine}>
              <span style={styles.detailKey}>{t('device.process.detail.state')}</span>
              <span style={styles.detailValue}>{row.state === '' ? '—' : row.state}</span>
            </div>
            <div style={styles.detailLine}>
              <span style={styles.detailKey}>{t('device.process.detail.elapsed')}</span>
              <span style={styles.detailValue}>{elapsedText(row.elapsedSeconds, t)}</span>
            </div>
            <div style={styles.detailLine}>
              <span style={styles.detailKey}>{t('device.process.detail.ppid')}</span>
              <span style={styles.detailValue}>{String(row.ppid)}</span>
            </div>
            <div style={styles.detailLine}>
              <span style={styles.detailKey}>{t('device.process.detail.args')}</span>
              <span style={styles.detailValue}>{row.args}</span>
            </div>
          </div>
        )
        : null}
    </>
  )
}

/** A row of the container list: name, image, and the runtime's own word. */
function ContainerRow({ row, last }: {
  row: DevicePanelContainerRow
  last: boolean
}): ReactNode {
  return (
    <div
      data-dshell-device-row="container"
      style={{
        ...styles.row,
        gridTemplateColumns: CONTAINER_COLUMNS,
        ...(last ? styles.rowLast : {}),
      }}
    >
      <span style={{ ...styles.cell, fontWeight: 500 }}>{row.name}</span>
      <span style={{ ...styles.mono, ...styles.dim, ...styles.cell }}>{row.image}</span>
      <span style={styles.stateWrap}>
        <span style={styles.stateDot} />
        <span style={{ ...styles.mono, ...styles.good }}>{row.state}</span>
      </span>
    </div>
  )
}

/**
 * A row of the port list: the transport, the port, and who holds it.
 *
 * The holder is a LINK, not a word: the first question about a port is who
 * holds it, and the process list is where the answer is read.
 *
 * The forward button is the last column: it is the way to reach this port from
 * this machine, and it says which it is — a port that already has a forward
 * names the local port it landed on, and one that does not offers to open one.
 */
function PortRow({ row, last, onHold, forward, onForward, t }: {
  row: DevicePanelPortRow
  last: boolean
  onHold: (name: string) => void
  /** The forward that already carries this port, if there is one. */
  forward: DshellForwardView | undefined
  /** Open a forward for this port, or stop the one that carries it. */
  onForward: (row: DevicePanelPortRow, forward: DshellForwardView | undefined) => void
  /** The reader's copy. */
  t: DevicePanelProps['t']
}): ReactNode {
  return (
    <div
      data-dshell-device-row="port"
      style={{
        ...styles.row,
        gridTemplateColumns: PORT_COLUMNS,
        ...(last ? styles.rowLast : {}),
      }}
    >
      <span style={{ ...styles.mono, ...styles.dim }}>{row.proto}</span>
      <span style={{ ...styles.mono }}>{String(row.port)}</span>
      <span style={{ ...styles.mono, ...styles.dim, ...styles.cell }}>{row.address}</span>
      {row.processName === ''
        ? <span style={{ ...styles.mono, ...styles.cell, textAlign: 'right', opacity: 0.5 }}>—</span>
        : (
          <button
            type="button"
            style={{ ...styles.holder, ...styles.mono }}
            onClick={() => { onHold(row.processName) }}
          >
            {row.processName}
          </button>
        )}
      <button
        type="button"
        data-dshell-device-forward="port"
        style={forward === undefined ? styles.forward : styles.forwardOn}
        onClick={() => { onForward(row, forward) }}
      >
        {forwardLabel(forward, t('device.forward.open'))}
      </button>
    </div>
  )
}

/** What the panel's body needs, so it can be drawn without a browser. */
export interface DevicePanelBodyProps {
  /** The session the panel is about; a forward belongs to one. */
  readonly sessionId: string
  /** What the host said about the session's machine. */
  readonly view: import('./device-panel-view.js').DevicePanelView | undefined
  /** The page on screen. */
  readonly page: DevicePanelPage
  /** A page was asked for. */
  readonly onPage: (page: DevicePanelPage) => void
  /** Ask the host again, now. */
  readonly onRefresh: () => void
  /** The reader's copy. */
  readonly t: DevicePanelProps['t']
}

/**
 * The panel's body: the drawing, with everything it draws already decided.
 * @param props - the view, the state, and the copy.
 * @returns the panel's content.
 */
export function DshellDevicePanelBody({ sessionId, view, page, onPage, onRefresh, t }: DevicePanelBodyProps): ReactNode {
  // The rows' hover lives in a stylesheet, because inline styles cannot say
  // `:hover`.
  useEffect(injectHoverCss, [])

  // What the reader typed, and how the lists are ordered. Both live here
  // rather than in the host: the host's job is to say what the machine is
  // doing, and the reader's questions are the reader's.
  const [processQuery, setProcessQuery] = useState('')
  const [processSort, setProcessSort] = useState<readonly SortKey<ProcessSortKey>[]>([{ key: 'cpu', direction: 'desc' }])
  const [portQuery, setPortQuery] = useState('')
  const [portSort, setPortSort] = useState<readonly SortKey<PortSortKey>[]>([{ key: 'port', direction: 'asc' }])
  const [containerQuery, setContainerQuery] = useState('')
  const [containerSort, setContainerSort] = useState<readonly SortKey<ContainerSortKey>[]>([{ key: 'name', direction: 'asc' }])
  const [expandedPid, setExpandedPid] = useState<number | undefined>(undefined)

  // The forwards of this session: what the host holds open on this machine.
  // They are read when the ports page is on screen, because a forward is
  // something the reader asks for ON that page — and a reader who never
  // opens the page should not pay for the request.
  const forwardSubscribe = useCallback((listener: () => void) => deviceForwardSeat.subscribe(listener), [])
  const forwardSnapshot = useCallback(() => deviceForwardSeat.getSnapshot(sessionId), [sessionId])
  // The server draws the panel before any answer has arrived, and a panel
  // drawn then must still be a panel: an EMPTY answer, not a missing one.
  const forwardServerSnapshot = useCallback(() => EMPTY_FORWARDS, [])
  const forwardState = useSyncExternalStore(forwardSubscribe, forwardSnapshot, forwardServerSnapshot)
  const forwards = forwardState?.forwards ?? []
  useEffect(() => {
    if (page !== 'ports') return
    void readForwards(sessionId)
  }, [page, sessionId])

  /** Open a forward for one port, or stop the one that carries it. */
  const onForward = useCallback((row: DevicePanelPortRow, forward: DshellForwardView | undefined) => {
    if (forward === undefined) {
      void deviceForwardSeat.open(sessionId, row.port)
      return
    }
    void deviceForwardSeat.stop(sessionId, forward.localPort)
  }, [sessionId])

  const pages = useMemo<readonly [SegmentedTab<DevicePanelPage>, ...SegmentedTab<DevicePanelPage>[]]>(() => ([
    { id: 'overview', value: 'overview', label: t('device.page.overview'), panelId: 'dshell-device-page-overview' },
    { id: 'processes', value: 'processes', label: t('device.page.processes'), panelId: 'dshell-device-page-processes' },
    { id: 'containers', value: 'containers', label: t('device.page.containers'), panelId: 'dshell-device-page-containers' },
    { id: 'ports', value: 'ports', label: t('device.page.ports'), panelId: 'dshell-device-page-ports' },
  ]), [t])

  const processes = view?.processes ?? []
  const containers = view?.containers ?? []
  const ports = view?.ports ?? []
  const notes = view?.notes ?? []

  const shownProcesses = useMemo(
    () => sortProcessRows(filterProcessRows(processes, processQuery), processSort),
    [processes, processQuery, processSort],
  )
  const shownPorts = useMemo(
    () => sortPortRows(filterPortRows(ports, portQuery, 'all'), portSort),
    [ports, portQuery, portSort],
  )
  const shownContainers = useMemo(
    () => sortContainerRows(filterContainerRows(containers, containerQuery), containerSort),
    [containers, containerQuery, containerSort],
  )

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.headerGlyph}><DeviceGlyph size={16} /></span>
        <span style={styles.headerSpacer} />
        <button
          type="button"
          style={styles.iconButton}
          title={t('device.refresh')}
          aria-label={t('device.refresh')}
          onClick={() => { onRefresh() }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89" strokeLinecap="round" />
            <path d="M13.5 2.5V5H11" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div style={styles.pages}>
        <SegmentedTabs items={pages} value={page} onChange={onPage} label={t('device.title')} />
      </div>

      <div style={styles.body}>
        {view?.error !== undefined
          ? <div style={styles.error}>{view.error}</div>
          : null}

        {view === undefined
          ? <div style={styles.empty}>{t('device.pending')}</div>
          : (
            <>
              {page === 'overview'
                ? (
                  <div id="dshell-device-page-overview">
                    <div style={styles.machine}>
                      <div style={styles.machineTop}>
                        <span style={styles.eyebrow}>{t('device.section.machine')}</span>
                        <Tag tone="outline">
                          {view.machine.onDevice ? t('device.machine.device') : t('device.machine.local')}
                        </Tag>
                      </div>
                      <div style={styles.machineName}>{view.machine.name ?? t('device.machine.local')}</div>
                      {view.machine.endpoint === undefined
                        ? null
                        : <div style={styles.endpoint}>{view.machine.endpoint}</div>}
                    </div>

                    <div style={styles.load}>
                      {view.load.map(stat => <Stat key={stat.label} stat={stat} t={t} />)}
                    </div>

                    {notes.length === 0
                      ? null
                      : (
                        <div style={styles.group}>
                          <div style={styles.eyebrow}>{t('device.section.status')}</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0 0' }}>
                            {notes.map(note => (
                              <div key={note} style={styles.note}>
                                <span style={styles.noteDot} />
                                <span>{t(DEVICE_NOTE_KEYS[note])}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                  </div>
                )
                : null}

              {page === 'processes'
                ? (
                  <div id="dshell-device-page-processes" style={styles.group}>
                    <div style={styles.filter}>
                      <Input
                        icon={<SearchGlyph />}
                        value={processQuery}
                        placeholder={t('device.filter.placeholder')}
                        aria-label={t('device.filter.placeholder')}
                        onChange={(event) => { setProcessQuery(event.target.value) }}
                      />
                      <span data-dshell-device-count="processes" style={styles.count}>{countText(shownProcesses.length, processes.length, t)}</span>
                    </div>
                    <div style={{ ...styles.heads, gridTemplateColumns: PROCESS_COLUMNS }}>
                      <SortHead label={t('device.column.pid')} sorts={processSort} column="pid" fallback={PROCESS_FALLBACK.pid} onSort={(column, shift) => { setProcessSort(sorts => nextSort(sorts, column, shift)) }} onFlip={(column) => { setProcessSort(sorts => flipSort(sorts, column, PROCESS_FALLBACK[column])) }} t={t} />
                      <SortHead label={t('device.column.command')} sorts={processSort} column="name" fallback={PROCESS_FALLBACK.name} onSort={(column, shift) => { setProcessSort(sorts => nextSort(sorts, column, shift)) }} onFlip={(column) => { setProcessSort(sorts => flipSort(sorts, column, PROCESS_FALLBACK[column])) }} t={t} />
                      <SortHead label={t('device.column.cpu')} sorts={processSort} column="cpu" fallback={PROCESS_FALLBACK.cpu} align="right" onSort={(column, shift) => { setProcessSort(sorts => nextSort(sorts, column, shift)) }} onFlip={(column) => { setProcessSort(sorts => flipSort(sorts, column, PROCESS_FALLBACK[column])) }} t={t} />
                      <SortHead label={t('device.column.memory')} sorts={processSort} column="memory" fallback={PROCESS_FALLBACK.memory} align="right" onSort={(column, shift) => { setProcessSort(sorts => nextSort(sorts, column, shift)) }} onFlip={(column) => { setProcessSort(sorts => flipSort(sorts, column, PROCESS_FALLBACK[column])) }} t={t} />
                    </div>
                    {shownProcesses.length === 0
                      ? <div style={styles.empty}>{t('device.list.empty')}</div>
                      : shownProcesses.map((row, index) => (
                        <ProcessRow
                          key={String(row.pid)}
                          row={row}
                          open={expandedPid === row.pid}
                          onOpen={(pid) => { setExpandedPid(current => current === pid ? undefined : pid) }}
                          last={index === shownProcesses.length - 1}
                          t={t}
                        />
                      ))}
                  </div>
                )
                : null}

              {page === 'containers'
                ? (
                  <div id="dshell-device-page-containers" style={styles.group}>
                    <div style={styles.filter}>
                      <Input
                        icon={<SearchGlyph />}
                        value={containerQuery}
                        placeholder={t('device.filter.placeholder')}
                        aria-label={t('device.filter.placeholder')}
                        onChange={(event) => { setContainerQuery(event.target.value) }}
                      />
                      <span data-dshell-device-count="containers" style={styles.count}>{countText(shownContainers.length, containers.length, t)}</span>
                    </div>
                    <div style={{ ...styles.heads, gridTemplateColumns: CONTAINER_COLUMNS }}>
                      <SortHead label={t('device.column.name')} sorts={containerSort} column="name" fallback={CONTAINER_FALLBACK.name} onSort={(column, shift) => { setContainerSort(sorts => nextSort(sorts, column, shift)) }} onFlip={(column) => { setContainerSort(sorts => flipSort(sorts, column, CONTAINER_FALLBACK[column])) }} t={t} />
                      <SortHead label={t('device.column.image')} sorts={containerSort} column="image" fallback={CONTAINER_FALLBACK.image} onSort={(column, shift) => { setContainerSort(sorts => nextSort(sorts, column, shift)) }} onFlip={(column) => { setContainerSort(sorts => flipSort(sorts, column, CONTAINER_FALLBACK[column])) }} t={t} />
                      <SortHead label={t('device.column.state')} sorts={containerSort} column="state" fallback={CONTAINER_FALLBACK.state} align="right" onSort={(column, shift) => { setContainerSort(sorts => nextSort(sorts, column, shift)) }} onFlip={(column) => { setContainerSort(sorts => flipSort(sorts, column, CONTAINER_FALLBACK[column])) }} t={t} />
                    </div>
                    {shownContainers.length === 0
                      ? <div style={styles.empty}>{t('device.list.empty')}</div>
                      : shownContainers.map((container, index) => (
                        <ContainerRow
                          key={container.name}
                          row={container}
                          last={index === shownContainers.length - 1}
                        />
                      ))}
                  </div>
                )
                : null}

              {page === 'ports'
                ? (
                  <div id="dshell-device-page-ports" style={styles.group}>
                    <div style={styles.filter}>
                      <Input
                        icon={<SearchGlyph />}
                        value={portQuery}
                        placeholder={t('device.filter.placeholder')}
                        aria-label={t('device.filter.placeholder')}
                        onChange={(event) => { setPortQuery(event.target.value) }}
                      />
                      <span data-dshell-device-count="ports" style={styles.count}>{countText(shownPorts.length, ports.length, t)}</span>
                    </div>
                    <div style={{ ...styles.heads, gridTemplateColumns: PORT_COLUMNS }}>
                      <SortHead label={t('device.column.proto')} sorts={portSort} column="proto" fallback={PORT_FALLBACK.proto} onSort={(column, shift) => { setPortSort(sorts => nextSort(sorts, column, shift)) }} onFlip={(column) => { setPortSort(sorts => flipSort(sorts, column, PORT_FALLBACK[column])) }} t={t} />
                      <SortHead label={t('device.column.port')} sorts={portSort} column="port" fallback={PORT_FALLBACK.port} onSort={(column, shift) => { setPortSort(sorts => nextSort(sorts, column, shift)) }} onFlip={(column) => { setPortSort(sorts => flipSort(sorts, column, PORT_FALLBACK[column])) }} t={t} />
                      <SortHead label={t('device.column.address')} sorts={portSort} column="address" fallback={PORT_FALLBACK.address} onSort={(column, shift) => { setPortSort(sorts => nextSort(sorts, column, shift)) }} onFlip={(column) => { setPortSort(sorts => flipSort(sorts, column, PORT_FALLBACK[column])) }} t={t} />
                      <SortHead label={t('device.column.process')} sorts={portSort} column="process" fallback={PORT_FALLBACK.process} align="right" onSort={(column, shift) => { setPortSort(sorts => nextSort(sorts, column, shift)) }} onFlip={(column) => { setPortSort(sorts => flipSort(sorts, column, PORT_FALLBACK[column])) }} t={t} />
                      <span style={{ ...styles.mono, ...styles.dim, textAlign: 'right' }}>{t('device.column.forward')}</span>
                    </div>
                    {shownPorts.length === 0
                      ? <div style={styles.empty}>{t('device.list.empty')}</div>
                      : shownPorts.map((row, index) => (
                        <PortRow
                          key={`${row.proto}-${String(row.port)}-${row.address}`}
                          row={row}
                          last={index === shownPorts.length - 1}
                          forward={forwardFor(forwards, row.port)}
                          onForward={onForward}
                          t={t}
                          onHold={(name) => {
                            // The first question about a port is who holds
                            // it, and the process list is where the answer
                            // is read: so the holder leads there, with the
                            // list already narrowed to it.
                            setProcessQuery(name)
                            setExpandedPid(undefined)
                            onPage('processes')
                          }}
                        />
                      ))}
                  </div>
                )
                : null}
            </>
          )}
      </div>
    </div>
  )
}

/**
 * The device panel: the seats, the state, and the body.
 * @param props - the tab's runtime props, the session it belongs to, and its copy.
 * @returns the panel.
 */
export function DshellDevicePanel({ sessionId, t }: DevicePanelProps): ReactNode {
  const subscribe = useCallback((listener: () => void) => deviceDetailSeat.subscribe(listener), [])
  const snapshot = useCallback(() => deviceDetailSeat.getSnapshot(sessionId), [sessionId])
  const answer = useSyncExternalStore(subscribe, snapshot)

  const metrics = useSyncExternalStore(
    deviceMetricsSeat.subscribe,
    useCallback(() => deviceMetricsSeat.getSnapshot().get(sessionId), [sessionId]),
  )

  // The poll follows the reader's own cadence, and only while the panel is on
  // screen: an idle frame must not spend a round trip on a machine that is not
  // this one.
  useEffect(() => deviceDetailSeat.watch(sessionId), [sessionId])

  const [page, setPage] = useState<DevicePanelPage>('overview')

  /**
   * The load is watched too, and only on the page that shows it.
   *
   * The seat is refcounted, so the status chip and this panel cost ONE poll
   * between them — but a poll is an `ssh` round trip on a device, and the
   * panel reads the seat without watching it, the load was only ever as fresh
   * as whatever else happened to be watching. Open the panel on a session
   * whose chip is not on screen, and the load stayed a dash forever.
   */
  useEffect(
    () => (page === 'overview' ? deviceMetricsSeat.watch(sessionId) : undefined),
    [sessionId, page],
  )

  const view = devicePanelView(answer, metrics?.metrics)

  return (
    <DshellDevicePanelBody
      // The key resets the reader's filters and ordering when the session
      // changes: they are answers to a question about ONE machine.
      key={sessionId}
      sessionId={sessionId}
      view={view}
      page={page}
      onPage={setPage}
      onRefresh={() => { deviceDetailSeat.refresh(sessionId) }}
      t={t}
    />
  )
}
