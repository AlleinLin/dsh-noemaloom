/**
 * What the device panel shows, and what it does with what the reader asks.
 *
 * The panel is a strip with long lists in it, so the two questions a reader
 * actually has are "which one of these do I want" and "what order do I want
 * them in". Both are decided here — in pure functions — because both are
 * decisions that can be wrong, and neither can be checked by looking at a
 * picture.
 */

import { describe, expect, it } from 'vitest'
import type { DshellDeviceDetailResponse } from '../src/device-detail-protocol.js'
import type { DshellDeviceMetrics } from '../src/device-metrics-protocol.js'
import {
  devicePanelView,
  filterPortRows,
  filterProcessRows,
  flipSort,
  nextSort,
  sortPortRows,
  sortProcessRows,
  type DevicePanelPortRow,
  type DevicePanelProcessRow,
} from '../src/client/device-panel-view.js'
import { DEVICE_NOTE_KEYS, en, zh } from '../src/client/locales.js'

/** A device that reports one of everything. */
const DETAIL: DshellDeviceDetailResponse = {
  detail: {
    device: { kind: 'device', name: 'build-box', endpoint: 'dev@10.0.0.9:22' },
    processes: [
      { pid: 4211, ppid: 1, cpu: 12.5, memory: 3.4, command: 'node', user: 'root', state: 'S', elapsedSeconds: 1200, args: 'node server.js' },
      { pid: 4212, ppid: 4211, cpu: 0.5, memory: 0.2, command: 'bash', user: 'dev', state: 'R', elapsedSeconds: 60, args: 'bash' },
    ],
    containers: [
      { id: '9f2ab1', image: 'nginx:latest', name: 'web', state: 'Up 3 hours' },
    ],
    ports: [
      { proto: 'tcp', port: 22, address: '0.0.0.0', processName: 'sshd', processPid: 812 },
      { proto: 'tcp', port: 8080, address: '127.0.0.1', processName: 'nginx', processPid: 4242 },
    ],
    notes: [],
    at: 1_700_000_000_000,
  },
}

/** The load the status chip's seat already holds. */
const METRICS: DshellDeviceMetrics = {
  device: { kind: 'device', name: 'build-box', endpoint: 'dev@10.0.0.9:22' },
  cpu: { used: 0.25, cores: 8, load1: 1.5 },
  memory: { total: 16 * 1024 ** 3, used: 4 * 1024 ** 3 },
  at: 1_700_000_000_000,
}

/** The rows, as the panel sees them. */
function processRows(): readonly DevicePanelProcessRow[] {
  return devicePanelView(DETAIL, METRICS)?.processes ?? []
}

/** The ports, as the panel sees them. */
function portRows(): readonly DevicePanelPortRow[] {
  return devicePanelView(DETAIL, METRICS)?.ports ?? []
}

describe('a device answer', () => {
  it('names the machine it describes', () => {
    const view = devicePanelView(DETAIL, undefined)

    expect(view?.machine).toEqual({
      onDevice: true,
      name: 'build-box',
      endpoint: 'dev@10.0.0.9:22',
    })
  })

  it('keeps what the list cannot show, for the row that opens', () => {
    const rows = processRows()

    expect(rows[0]).toEqual({
      pid: 4211,
      ppid: 1,
      command: 'node',
      args: 'node server.js',
      user: 'root',
      state: 'S',
      elapsedSeconds: 1200,
      cpu: 12.5,
      memory: 3.4,
    })
  })

  it('lists the processes with their pid and their two shares', () => {
    const rows = processRows()

    expect(rows).toHaveLength(2)
    expect(rows[0]?.pid).toBe(4211)
    expect(rows[0]?.cpu).toBe(12.5)
    expect(rows[0]?.memory).toBe(3.4)
  })

  it('lists the containers and the ports', () => {
    const view = devicePanelView(DETAIL, undefined)

    expect(view?.containers).toEqual([
      { name: 'web', image: 'nginx:latest', state: 'Up 3 hours' },
    ])
    expect(view?.ports).toEqual([
      { proto: 'tcp', port: 22, address: '0.0.0.0', processName: 'sshd', processPid: 812 },
      { proto: 'tcp', port: 8080, address: '127.0.0.1', processName: 'nginx', processPid: 4242 },
    ])
  })

  it('says what it could not read', () => {
    const view = devicePanelView({
      detail: { ...DETAIL.detail!, notes: ['no-container-runtime'] },
    }, undefined)

    expect(view?.notes).toEqual(['no-container-runtime'])
  })
})

describe('a session that runs on this machine', () => {
  it('says so, and names no device', () => {
    const view = devicePanelView({
      detail: {
        device: { kind: 'local' },
        processes: [],
        containers: [],
        ports: [],
        notes: ['processes-unreported'],
        at: 1_700_000_000_000,
      },
    }, undefined)

    expect(view?.machine.onDevice).toBe(false)
    expect(view?.machine.name).toBeUndefined()
    expect(view?.machine.endpoint).toBeUndefined()
  })
})

describe('a host that could not answer', () => {
  it('carries the reason instead of empty rows', () => {
    const view = devicePanelView({ error: '会话绑定的设备当前不可达' }, undefined)

    expect(view?.error).toBe('会话绑定的设备当前不可达')
    expect(view?.processes).toEqual([])
    expect(view?.notes).toEqual([])
  })
})

describe('an answer that has not arrived yet', () => {
  it('is nothing to draw', () => {
    expect(devicePanelView(undefined, undefined)).toBeUndefined()
  })
})

describe('the load', () => {
  it('is read from the seat the chip already keeps', () => {
    const view = devicePanelView(DETAIL, METRICS)

    // The three readouts are SHARES, and the machine's size rides along
    // underneath: a percentage of one machine says nothing about how much of
    // it there is.
    expect(view?.load).toEqual([
      { label: 'device.load.cpu', value: '25%', detail: '8' },
      { label: 'device.load.memory', value: '25%', detail: '4.0 / 16.0 GB' },
      { label: 'device.load.load1', value: '1.50', detail: undefined },
    ])
  })

  it('is drawn as not known when the chip has no reading yet', () => {
    const view = devicePanelView(DETAIL, undefined)

    expect(view?.load).toEqual([
      { label: 'device.load.cpu', value: '—', detail: undefined },
      { label: 'device.load.memory', value: '—', detail: undefined },
      { label: 'device.load.load1', value: '—', detail: undefined },
    ])
  })
})

describe('what the reader typed', () => {
  it('narrows the processes by the command name', () => {
    const rows = filterProcessRows(processRows(), 'node')

    expect(rows).toHaveLength(1)
    expect(rows[0]?.pid).toBe(4211)
  })

  it('narrows the processes by the whole command line', () => {
    // Two instances of the same command differ only in their arguments, and
    // the arguments are where the difference is.
    const rows = filterProcessRows(processRows(), 'server.js')

    expect(rows).toHaveLength(1)
    expect(rows[0]?.pid).toBe(4211)
  })

  it('narrows the processes by the owner and by the pid', () => {
    expect(filterProcessRows(processRows(), 'dev')).toHaveLength(1)
    expect(filterProcessRows(processRows(), '4212')[0]?.pid).toBe(4212)
  })

  it('ignores the case', () => {
    expect(filterProcessRows(processRows(), 'NODE')).toHaveLength(1)
  })

  it('keeps everything when nothing was typed', () => {
    expect(filterProcessRows(processRows(), '  ')).toHaveLength(2)
  })

  it('narrows the ports by the port, the address and the holder', () => {
    expect(filterPortRows(portRows(), '8080')).toHaveLength(1)
    expect(filterPortRows(portRows(), '127.0.0.1')).toHaveLength(1)
    expect(filterPortRows(portRows(), 'sshd')).toHaveLength(1)
  })

  it('narrows the ports by the transport, because readers type it', () => {
    const rows: DevicePanelPortRow[] = [
      { proto: 'tcp', port: 22, address: '0.0.0.0', processName: 'sshd', processPid: 1 },
      { proto: 'udp', port: 53, address: '0.0.0.0', processName: 'resolved', processPid: 2 },
    ]

    expect(filterPortRows(rows, 'tcp')).toHaveLength(1)
    expect(filterPortRows(rows, 'udp')).toHaveLength(1)
  })

  it('narrows the ports to one transport when the reader asks', () => {
    const rows: DevicePanelPortRow[] = [
      { proto: 'tcp', port: 22, address: '0.0.0.0', processName: 'sshd', processPid: 1 },
      { proto: 'udp', port: 53, address: '0.0.0.0', processName: 'resolved', processPid: 2 },
    ]

    expect(filterPortRows(rows, '', 'tcp')).toHaveLength(1)
    expect(filterPortRows(rows, '', 'udp')).toHaveLength(1)
    expect(filterPortRows(rows, '', 'all')).toHaveLength(2)
  })
})

describe('the order the reader asked for', () => {
  it('puts the biggest first when the key is a share', () => {
    const rows = sortProcessRows(processRows(), [{ key: 'cpu', direction: 'desc' }])

    expect(rows[0]?.pid).toBe(4211)
  })

  it('breaks the first key\'s ties with the second', () => {
    const rows: DevicePanelProcessRow[] = [
      { pid: 1, ppid: 0, command: 'a', args: '', user: 'root', state: '', elapsedSeconds: undefined, cpu: 5, memory: 1 },
      { pid: 2, ppid: 0, command: 'b', args: '', user: 'root', state: '', elapsedSeconds: undefined, cpu: 5, memory: 9 },
      { pid: 3, ppid: 0, command: 'c', args: '', user: 'root', state: '', elapsedSeconds: undefined, cpu: 5, memory: 3 },
    ]
    const ordered = sortProcessRows(rows, [{ key: 'cpu', direction: 'desc' }, { key: 'memory', direction: 'desc' }])

    expect(ordered.map(row => row.pid)).toEqual([2, 3, 1])
  })

  it('sorts the ports by their number', () => {
    const rows = sortPortRows(portRows(), [{ key: 'port', direction: 'asc' }])

    expect(rows.map(row => row.port)).toEqual([22, 8080])
  })

  it('puts a process that has not been around long enough to say at the bottom', () => {
    const rows: DevicePanelProcessRow[] = [
      { pid: 1, ppid: 0, command: 'a', args: '', user: 'root', state: '', elapsedSeconds: undefined, cpu: 0, memory: 0 },
      { pid: 2, ppid: 0, command: 'b', args: '', user: 'root', state: '', elapsedSeconds: 600, cpu: 0, memory: 0 },
    ]
    const ordered = sortProcessRows(rows, [{ key: 'elapsed', direction: 'desc' }])

    expect(ordered.map(row => row.pid)).toEqual([2, 1])
  })
})

describe('what clicking a column head does', () => {
  it('makes that column the one that decides', () => {
    const keys = nextSort([{ key: 'cpu', direction: 'desc' }], 'memory', false)

    expect(keys[0]?.key).toBe('memory')
  })

  it('flips the direction of the column that already decides', () => {
    const keys = nextSort([{ key: 'cpu', direction: 'desc' }], 'cpu', false)

    expect(keys[0]?.key).toBe('cpu')
    expect(keys[0]?.direction).toBe('asc')
  })

  it('adds a second key behind the first, so it only breaks the ties', () => {
    const keys = nextSort([{ key: 'cpu', direction: 'desc' }], 'memory', true)

    expect(keys.map(entry => entry.key)).toEqual(['cpu', 'memory'])
  })

  it('drops the keys it replaces when a new one takes the front', () => {
    const keys = nextSort(
      [{ key: 'cpu', direction: 'desc' }, { key: 'memory', direction: 'desc' }],
      'pid',
      false,
    )

    expect(keys.map(entry => entry.key)).toEqual(['pid'])
  })

  it('keeps at most three keys', () => {
    let keys: readonly { key: 'cpu' | 'memory' | 'pid' | 'name'; direction: 'asc' | 'desc' }[] = []
    keys = nextSort(keys, 'cpu', true)
    keys = nextSort(keys, 'memory', true)
    keys = nextSort(keys, 'pid', true)
    keys = nextSort(keys, 'name', true)

    expect(keys).toHaveLength(3)
    expect(keys.map(entry => entry.key)).toEqual(['memory', 'pid', 'name'])
  })
})

describe('what clicking a direction control does', () => {
  it('turns that column around', () => {
    const keys = flipSort([{ key: 'cpu', direction: 'desc' }], 'cpu', 'desc')

    expect(keys[0]?.key).toBe('cpu')
    expect(keys[0]?.direction).toBe('asc')
  })

  it('leaves the other columns where they are', () => {
    // The reader pointed at a direction, not at a new question: the tie-break
    // they set up is not what they asked to throw away.
    const keys = flipSort(
      [{ key: 'cpu', direction: 'desc' }, { key: 'memory', direction: 'desc' }],
      'cpu',
      'desc',
    )

    expect(keys.map(entry => entry.key)).toEqual(['cpu', 'memory'])
    expect(keys[1]?.direction).toBe('desc')
  })

  it('puts a column that was not sorted yet at the front, keeping the rest', () => {
    const keys = flipSort([{ key: 'cpu', direction: 'desc' }], 'memory', 'desc')

    expect(keys.map(entry => entry.key)).toEqual(['memory', 'cpu'])
    expect(keys[0]?.direction).toBe('desc')
  })

  it('keeps at most three keys', () => {
    const keys = flipSort(
      [{ key: 'cpu', direction: 'desc' }, { key: 'memory', direction: 'desc' }, { key: 'pid', direction: 'asc' }],
      'name',
      'asc',
    )

    expect(keys).toHaveLength(3)
    expect(keys.map(entry => entry.key)).toEqual(['name', 'cpu', 'memory'])
  })
})

describe('a note the host can send', () => {
  it('has a sentence in every language', () => {
    // A note the host can send but no dictionary can say would be drawn as
    // nothing at all, and a reader would read that as "there was nothing to
    // report" — the exact lie the notes exist to prevent.
    const codes: DshellDeviceNoteCode[] = [
      'no-ps',
      'no-container-runtime',
      'no-socket-tool',
      'processes-unreported',
      'containers-unreported',
      'ports-unreported',
    ]
    for (const code of codes) {
      const key = DEVICE_NOTE_KEYS[code]
      expect(key, code).toBeDefined()
      expect(zh[key], code).not.toBe('')
      expect(en[key], code).not.toBe('')
    }
  })
})

describe('the pages the panel is cut into', () => {
  it('all have a name in every language', () => {
    // The four pages are the panel's whole shape: a name that is missing in
    // one language is a tab with no label in it.
    const keys = [
      'device.page.overview',
      'device.page.processes',
      'device.page.containers',
      'device.page.ports',
      'device.section.status',
      'device.filter.placeholder',
      'device.column.pid',
      'device.column.command',
      'device.column.cpu',
      'device.column.memory',
      'device.column.proto',
      'device.column.port',
      'device.column.address',
      'device.column.process',
      'device.process.detail.user',
      'device.process.detail.state',
      'device.process.detail.elapsed',
      'device.process.detail.ppid',
      'device.process.detail.args',
      'device.process.elapsed.seconds',
      'device.process.elapsed.minutes',
      'device.process.elapsed.hours',
      'device.process.elapsed.days',
    ] as const
    for (const key of keys) {
      expect(zh[key], key).not.toBe('')
      expect(en[key], key).not.toBe('')
    }
  })
})
