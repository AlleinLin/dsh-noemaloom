/**
 * What the device panel shows, as data.
 *
 * The panel is a drawing, and a drawing is hard to argue about: the decisions
 * it makes — which machine, which rows, how many decimals, which number is
 * the big one — are the decisions that can be wrong. So they are lifted out of
 * the drawing into a pure function, and what is left is layout.
 *
 * The labels stay in the component: they are words, and the reader's language
 * is not known here. The NUMBERS are language-free, so they are decided here
 * and printed once.
 */

import type { DshellDeviceIdentity, DshellDeviceMetrics, DshellDeviceMetricsResponse } from '../device-metrics-protocol.js'
import type { DshellDeviceDetailResponse } from '../device-detail-protocol.js'
import type { DshellDeviceNoteCode } from '../device-detail-protocol.js'

/** The panel's four pages. */
export type DevicePanelPage = 'overview' | 'processes' | 'containers' | 'ports'

/** The machine a page is about. */
export interface DevicePanelMachine {
  /** Whether the session runs on a device or on this machine. */
  readonly onDevice: boolean
  /** The name the reader gave the device; absent for this machine. */
  readonly name: string | undefined
  /** `user@host:port` for a device; absent for this machine. */
  readonly endpoint: string | undefined
}

/** One readout of the load: the big number, and the smaller fact beside it. */
export interface DevicePanelStat {
  /** What the readout is called, as a locale key the component resolves. */
  readonly label: 'device.load.cpu' | 'device.load.memory' | 'device.load.load1'
  /** The number the panel prints large. */
  readonly value: string
  /** The smaller fact under it — the machine's size, so a share means something. */
  readonly detail: string | undefined
}

/** One process row. */
export interface DevicePanelProcessRow {
  readonly pid: number
  readonly ppid: number
  /** The command name, without its arguments. */
  readonly command: string
  /** The whole command line, arguments and all. */
  readonly args: string
  /** The owner of the process. */
  readonly user: string
  /** The process state, `ps` style. */
  readonly state: string
  /** How long the process has been alive, in seconds; undefined when unknown. */
  readonly elapsedSeconds: number | undefined
  /** Share of one core, in percent. */
  readonly cpu: number
  /** Share of the machine's memory, in percent. */
  readonly memory: number
}

/** One container row. */
export interface DevicePanelContainerRow {
  readonly name: string
  readonly image: string
  readonly state: string
}

/** One listening socket row. */
export interface DevicePanelPortRow {
  readonly proto: string
  readonly port: number
  readonly address: string
  /** The name of the process holding the socket. */
  readonly processName: string
  /** The pid of the process holding the socket. */
  readonly processPid: number | undefined
}

/**
 * How a list is ordered.
 *
 * The keys are in order: the first is the one that decides, the second breaks
 * its ties, and so on. That is what "sort by CPU, then by memory" means, and
 * it is why the keys are a list and not a single field.
 */
export type ProcessSortKey = 'cpu' | 'memory' | 'pid' | 'name' | 'user' | 'elapsed'
export type PortSortKey = 'port' | 'proto' | 'address' | 'process'
export type ContainerSortKey = 'name' | 'image' | 'state'

/** The direction one key is sorted in. */
export type SortDirection = 'asc' | 'desc'

/** One key, with the direction it is sorted in. */
export interface SortKey<K extends string> {
  readonly key: K
  readonly direction: SortDirection
}

/** The transport a port list is narrowed to. */
export type PortProtocol = 'all' | 'tcp' | 'udp'

/** Everything the panel draws, decided. */
export interface DevicePanelView {
  /** Which machine the session runs on. */
  readonly machine: DevicePanelMachine
  /** The load, as three readouts. */
  readonly load: readonly DevicePanelStat[]
  /** The busiest processes. */
  readonly processes: readonly DevicePanelProcessRow[]
  /** The containers the runtime reports. */
  readonly containers: readonly DevicePanelContainerRow[]
  /** The sockets the machine is listening on. */
  readonly ports: readonly DevicePanelPortRow[]
  /** What could not be read, and why. */
  readonly notes: readonly DshellDeviceNoteCode[]
  /** Why there is no snapshot at all, when the host said so. */
  readonly error: string | undefined
}

/**
 * The load, as the panel prints it.
 *
 * The three readouts are SHARES, because shares are comparable: a percentage
 * of one machine says nothing about how much of it there is, so the machine's
 * size rides along underneath. The load average is already a share of itself
 * and needs no second line.
 */
function loadStats(metrics: DshellDeviceMetrics | undefined): readonly DevicePanelStat[] {
  if (metrics === undefined) {
    return [
      { label: 'device.load.cpu', value: '—', detail: undefined },
      { label: 'device.load.memory', value: '—', detail: undefined },
      { label: 'device.load.load1', value: '—', detail: undefined },
    ]
  }
  const memoryTotal = metrics.memory.total
  const memoryPercent = memoryTotal > 0 ? Math.round(metrics.memory.used / memoryTotal * 100) : undefined
  return [
    {
      label: 'device.load.cpu',
      value: metrics.cpu.used === undefined ? '—' : `${String(Math.round(metrics.cpu.used * 100))}%`,
      // The core COUNT, without its unit: "核" is a word, and this module does
      // not know the reader's language.
      detail: String(metrics.cpu.cores),
    },
    {
      label: 'device.load.memory',
      value: memoryPercent === undefined ? '—' : `${String(memoryPercent)}%`,
      detail: `${(metrics.memory.used / 1024 ** 3).toFixed(1)} / ${(metrics.memory.total / 1024 ** 3).toFixed(1)} GB`,
    },
    {
      label: 'device.load.load1',
      value: metrics.cpu.load1 === undefined ? '—' : metrics.cpu.load1.toFixed(2),
      detail: undefined,
    },
  ]
}

/**
 * The panel's content, for one session's answer.
 *
 * @param answer - what the host said about the session's machine.
 * @param metrics - the load the chip's seat already holds, if any.
 * @returns the rows to draw, or undefined when nothing has been said yet.
 */
export function devicePanelView(
  answer: DshellDeviceDetailResponse | undefined,
  metrics: DshellDeviceMetrics | undefined,
): DevicePanelView | undefined {
  if (answer === undefined) return undefined
  const detail = answer.detail
  if (detail === undefined) {
    return {
      machine: { onDevice: false, name: undefined, endpoint: undefined },
      load: loadStats(metrics),
      processes: [],
      containers: [],
      ports: [],
      notes: [],
      error: answer.error,
    }
  }
  const machine: DevicePanelMachine = {
    onDevice: detail.device.kind === 'device',
    name: detail.device.name,
    endpoint: detail.device.endpoint,
  }
  return {
    machine,
    load: loadStats(metrics),
    processes: detail.processes.map(process => ({
      pid: process.pid,
      ppid: process.ppid,
      command: process.command,
      args: process.args ?? process.command,
      user: process.user ?? '',
      state: process.state ?? '',
      elapsedSeconds: process.elapsedSeconds,
      cpu: process.cpu,
      memory: process.memory,
    })),
    containers: detail.containers.map(container => ({
      name: container.name,
      image: container.image,
      state: container.state,
    })),
    ports: detail.ports.map(port => ({
      proto: port.proto,
      port: port.port,
      address: port.address,
      processName: port.processName ?? '',
      processPid: port.processPid,
    })),
    notes: detail.notes,
    error: answer.error,
  }
}

/** Whether a process row matches what the reader typed. */
function processMatches(row: DevicePanelProcessRow, needle: string): boolean {
  if (needle === '') return true
  return row.command.toLowerCase().includes(needle)
    || row.args.toLowerCase().includes(needle)
    || row.user.toLowerCase().includes(needle)
    || String(row.pid) === needle
}

/**
 * The processes that match what the reader typed.
 *
 * The needle is matched against the command name, the whole command line, the
 * owner and the pid: a reader looking for "that node" is looking for a name
 * AND a line of arguments, and a reader looking for pid 812 is looking for a
 * number, not for a word.
 */
export function filterProcessRows(
  rows: readonly DevicePanelProcessRow[],
  query: string,
): readonly DevicePanelProcessRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return rows
  return rows.filter(row => processMatches(row, needle))
}

/** Whether a port row matches what the reader typed. */
function portMatches(row: DevicePanelPortRow, needle: string): boolean {
  if (needle === '') return true
  return row.address.toLowerCase().includes(needle)
    || row.processName.toLowerCase().includes(needle)
    // The transport is part of what a reader types ("tcp", "udp"), so it is
    // part of what they can find.
    || row.proto.toLowerCase().includes(needle)
    || String(row.port) === needle
    || String(row.processPid ?? '') === needle
}

/**
 * The ports that match what the reader typed, and the transport they asked
 * for.
 */
export function filterPortRows(
  rows: readonly DevicePanelPortRow[],
  query: string,
  protocol: PortProtocol = 'all',
): readonly DevicePanelPortRow[] {
  const needle = query.trim().toLowerCase()
  return rows.filter(row => {
    if (protocol !== 'all' && row.proto !== protocol) return false
    return portMatches(row, needle)
  })
}

/** The value one key sorts by, and how bigger is better. */
function processOrderValue(row: DevicePanelProcessRow, key: ProcessSortKey): number | string {
  switch (key) {
    case 'cpu': return row.cpu
    case 'memory': return row.memory
    case 'pid': return row.pid
    case 'elapsed': return row.elapsedSeconds ?? -1
    case 'name': return row.command.toLowerCase()
    case 'user': return row.user.toLowerCase()
    default: return 0
  }
}

/** The value one key sorts by, and how bigger is better. */
function portOrderValue(row: DevicePanelPortRow, key: PortSortKey): number | string {
  switch (key) {
    case 'port': return row.port
    case 'proto': return row.proto
    case 'address': return row.address
    case 'process': return row.processName.toLowerCase()
    default: return 0
  }
}

/**
 * Order the rows by a list of keys.
 *
 * The first key decides; the next ones break its ties. A number sorts by its
 * value and a string by its text, and a missing value sorts as the smallest
 * one — a process that has not been around long enough to say is at the
 * bottom, not the top.
 */
function orderBy<K extends string, R>(
  rows: readonly R[],
  keys: readonly SortKey<K>[],
  value: (row: R, key: K) => number | string,
): readonly R[] {
  if (keys.length === 0) return rows
  return [...rows].sort((left, right) => {
    for (const { key, direction } of keys) {
      const a = value(left, key)
      const b = value(right, key)
      if (a === b) continue
      const less = a < b
      return direction === 'asc' ? (less ? -1 : 1) : (less ? 1 : -1)
    }
    return 0
  })
}

/** The processes, ordered the way the reader asked. */
export function sortProcessRows(
  rows: readonly DevicePanelProcessRow[],
  keys: readonly SortKey<ProcessSortKey>[],
): readonly DevicePanelProcessRow[] {
  return orderBy(rows, keys, processOrderValue)
}

/** The ports, ordered the way the reader asked. */
export function sortPortRows(
  rows: readonly DevicePanelPortRow[],
  keys: readonly SortKey<PortSortKey>[],
): readonly DevicePanelPortRow[] {
  return orderBy(rows, keys, portOrderValue)
}

/** The value one key sorts by, and how bigger is better. */
function containerOrderValue(row: DevicePanelContainerRow, key: ContainerSortKey): string {
  switch (key) {
    case 'image': return row.image.toLowerCase()
    case 'state': return row.state.toLowerCase()
    default: return row.name.toLowerCase()
  }
}

/** The containers, ordered the way the reader asked. */
export function sortContainerRows(
  rows: readonly DevicePanelContainerRow[],
  keys: readonly SortKey<ContainerSortKey>[],
): readonly DevicePanelContainerRow[] {
  return orderBy(rows, keys, containerOrderValue)
}

/** The containers that match what the reader typed. */
export function filterContainerRows(
  rows: readonly DevicePanelContainerRow[],
  query: string,
): readonly DevicePanelContainerRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return rows
  return rows.filter(row => row.name.toLowerCase().includes(needle)
    || row.image.toLowerCase().includes(needle)
    || row.state.toLowerCase().includes(needle))
}

/**
 * What clicking a column header does.
 *
 * A plain click makes that column the one that decides — the way a table
 * behaves when you click a head. Holding shift puts the column AFTER the ones
 * already there, so it only breaks their ties, and that is how a second
 * column is added. At most three keys are kept: past that the order stops
 * being something a reader can hold in their head.
 */
export function nextSort<K extends string>(
  keys: readonly SortKey<K>[],
  key: K,
  shift: boolean,
): readonly SortKey<K>[] {
  const current = keys.find(entry => entry.key === key)
  const flipped: SortKey<K> = current === undefined
    ? { key, direction: 'desc' }
    : { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
  const rest = keys.filter(entry => entry.key !== key)
  if (shift) {
    const appended = [...rest, flipped]
    return appended.length > 3 ? appended.slice(appended.length - 3) : appended
  }
  return [flipped]
}

/**
 * What the direction control does: turn ONE column around, and leave the rest
 * of the order alone.
 *
 * This is deliberately not {@link nextSort}: clicking a column's NAME replaces
 * the whole order, because the reader is choosing a new question ("sort by
 * this"), while clicking the ARROW answers a different one ("which way?"), and
 * the tie-break the reader set up a moment ago is not what they asked to throw
 * away.
 *
 * A column that is not sorted yet becomes the primary key — the reader pointed
 * at it — and every other key keeps its place behind it.
 *
 * @param keys - the order as it is now.
 * @param key - the column the control belongs to.
 * @param fallback - the direction a column starts in when it joins the order.
 * @returns the new order.
 */
export function flipSort<K extends string>(
  keys: readonly SortKey<K>[],
  key: K,
  fallback: SortDirection = 'asc',
): readonly SortKey<K>[] {
  const current = keys.find(entry => entry.key === key)
  if (current === undefined) {
    // The same cap as the name click: past three keys the order stops being
    // something a reader can hold in their head.
    return [{ key, direction: fallback }, ...keys].slice(0, 3) as readonly SortKey<K>[]
  }
  return keys.map(entry => entry.key === key
    ? { key, direction: entry.direction === 'asc' ? 'desc' : 'asc' }
    : entry)
}

/** The load reading of one session, as the seat holds it. */
export function metricsOf(answer: DshellDeviceMetricsResponse | undefined): DshellDeviceMetrics | undefined {
  return answer?.metrics
}

/** The identity of the machine, as the panel prints it. */
export function machineIdentity(device: DshellDeviceIdentity): DevicePanelMachine {
  return {
    onDevice: device.kind === 'device',
    name: device.name,
    endpoint: device.endpoint,
  }
}
