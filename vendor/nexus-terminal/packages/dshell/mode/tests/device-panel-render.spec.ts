/**
 * The device panel, rendered.
 *
 * The panel is a React tree with a real risk of not drawing at all — a prop
 * the primitives insist on, a page that forgets its panel id, a list that
 * throws on an empty answer. None of that shows up in a type check, and none
 * of it can be seen in a picture either, so the body is rendered here to
 * markup and the markup is checked: the four pages, the machine, the load,
 * the filter, the sortable columns, the three lists, and the notes.
 *
 * And one thing that DID happen: a column head that named its column `key`.
 * React reserves that name and eats it before the component is called, so
 * every head sorted by nothing at all and the order never moved. The guards
 * below are what that cost.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DshellDevicePanelBody, SortHead } from '../src/client/device-panel.js'
import { publishForwards } from '../src/client/device-forward.js'
import { devicePanelView, type DevicePanelPage } from '../src/client/device-panel-view.js'
import { DEVICE_NOTE_KEYS, zh } from '../src/client/locales.js'
import type { DshellDeviceDetailResponse } from '../src/device-detail-protocol.js'
import type { DshellDeviceMetrics } from '../src/device-metrics-protocol.js'

/** The copy the panel draws with. */
const t = (key: keyof typeof zh): string => zh[key]

/**
 * A device that reports one of everything.
 *
 * The processes come in the WRONG order for the panel's default order (busiest
 * first): the busiest one is second, so a panel that failed to sort would put
 * the quiet one on top and say so.
 */
const DETAIL: DshellDeviceDetailResponse = {
  detail: {
    device: { kind: 'device', name: 'build-box', endpoint: 'dev@10.0.0.9:22' },
    processes: [
      { pid: 4212, ppid: 4211, cpu: 0.5, memory: 0.2, command: 'bash', user: 'dev', state: 'R', elapsedSeconds: 60, args: 'bash' },
      { pid: 4211, ppid: 1, cpu: 12.5, memory: 3.4, command: 'node', user: 'root', state: 'S', elapsedSeconds: 1200, args: 'node server.js --port 8080' },
    ],
    containers: [
      { id: '9f2ab1', image: 'nginx:latest', name: 'web', state: 'Up 3 hours' },
    ],
    ports: [
      { proto: 'tcp', port: 22, address: '0.0.0.0', processName: 'sshd', processPid: 812 },
      { proto: 'tcp', port: 8080, address: '127.0.0.1', processName: 'nginx', processPid: 4242 },
    ],
    notes: ['no-container-runtime'],
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

/** The panel, drawn on one page. */
function draw(page: DevicePanelPage): string {
  return renderToStaticMarkup(createElement(DshellDevicePanelBody, {
    sessionId: 's-device',
    view: devicePanelView(DETAIL, METRICS),
    page,
    onPage: () => {},
    onRefresh: () => {},
    t,
  }))
}

describe('the device panel', () => {
  it('offers a forward on every port', () => {
    // The forward button is the way to reach a port from this machine, so
    // every port row carries one.
    const html = draw('ports')

    expect(html).toContain('data-dshell-device-forward="port"')
    expect(html).toContain('转发')
  })

  it('draws the four pages, and the machine on the overview', () => {
    const html = draw('overview')

    expect(html).toContain('概览')
    expect(html).toContain('进程')
    expect(html).toContain('容器')
    expect(html).toContain('端口')
    // The machine block: the name is the largest thing on the page.
    expect(html).toContain('build-box')
    expect(html).toContain('dev@10.0.0.9:22')
  })

  it('draws the load as three numbers, with the machine\'s size under them', () => {
    const html = draw('overview')

    expect(html).toContain('25%')
    expect(html).toContain('8 核')
    expect(html).toContain('1.50')
  })

  it('does not repeat the three lists the top bar already offers', () => {
    const html = draw('overview')

    // The counts live on the pages themselves; the overview is the machine and
    // its load, and a third copy of the navigation is noise.
    expect(html).not.toContain('进程 2')
    expect(html).not.toContain('容器 1')
    expect(html).not.toContain('监听端口 2')
  })

  it('does not fold the list away — the page IS the list', () => {
    const html = draw('processes')

    // Once the reader is on the device's detail page, the list is what they
    // came for; a control that hides it only costs a click. The fold headers
    // are the only thing that draws `aria-expanded`.
    expect(html).not.toContain('aria-expanded')
    expect(html).toContain('4211')
    expect(html).toContain('4212')
  })

  it('prints the count beside the filter that narrows the list', () => {
    const html = draw('processes')

    // The count is the list's size, and it belongs next to the filter that
    // changes it.
    expect(html).toContain('data-dshell-device-count="processes"')
    expect(html).toMatch(/data-dshell-device-count="processes"[^>]*>2</u)
  })

  it('draws the heads and the rows on ONE grid, so the columns line up', () => {
    // When the heads and the rows are two layouts, the columns drift apart and
    // a reader who aims at "CPU" sorts by memory.
    const html = draw('processes')
    const columns = '44px minmax(0, 1fr) 58px 58px'
    const times = html.split(columns).length - 1

    // Once for the heads, once for the row, once for the other row.
    expect(times).toBeGreaterThanOrEqual(3)
  })

  it('draws a filter and sortable columns on the process list', () => {
    const html = draw('processes')

    expect(html).toContain('筛选')
    expect(html).toContain('PID')
    expect(html).toContain('命令')
    expect(html).toContain('CPU')
    expect(html).toContain('内存')
    expect(html).toContain('4211')
    expect(html).toContain('node')
    expect(html).toContain('12.5%')
  })

  it('orders the list by what the reader asked for', () => {
    const html = draw('processes')

    // The busiest process comes first, even though the host reported it
    // second: the panel's order is a decision, and this is it.
    expect(html.indexOf('4211')).toBeLessThan(html.indexOf('4212'))
  })

  it('gives every column its own name and its own direction control', () => {
    const html = draw('processes')

    // The control is a button of its own: it answers "which way", which is
    // not the question the name answers.
    for (const column of ['pid', 'name', 'cpu', 'memory']) {
      expect(html).toContain(`data-dshell-device-head="${column}"`)
      expect(html).toContain(`data-dshell-device-arrow="${column}"`)
    }
  })

  it('draws sortable columns on the container list too', () => {
    const html = draw('containers')

    expect(html).toContain('名称')
    expect(html).toContain('镜像')
    expect(html).toContain('状态')
    expect(html).toContain('web')
    expect(html).toContain('nginx:latest')
  })

  it('draws the port list with the process that holds each port', () => {
    const html = draw('ports')

    expect(html).toContain('占用')
    expect(html).toContain('8080')
    expect(html).toContain('127.0.0.1')
    expect(html).toContain('nginx')
  })

  it('says what it could not read, under a status heading', () => {
    const html = draw('overview')

    expect(html).toContain('运行状态')
    // The sentence itself is the dictionary's business; the panel only has to
    // put it on the page.
    expect(html).toContain(zh[DEVICE_NOTE_KEYS['no-container-runtime']])
  })

  it('draws nothing but a waiting line before the host answers', () => {
    const html = renderToStaticMarkup(createElement(DshellDevicePanelBody, {
      view: undefined,
      page: 'overview',
      onPage: () => {},
      onRefresh: () => {},
      t,
    }))

    expect(html).toContain('正在读取设备')
  })
})

describe('a column head', () => {
  it('asks to sort by the column it belongs to', () => {
    const asked: [string, boolean][] = []
    const tree = SortHead({
      label: 'CPU',
      sorts: [{ key: 'cpu', direction: 'desc' }],
      column: 'cpu',
      onSort: (column, shift) => { asked.push([column, shift]) },
      onFlip: () => {},
      align: 'right',
      fallback: 'desc',
      t,
    }) as ReactElement<{ children: readonly ReactElement<{ onClick?: (event: { shiftKey: boolean }) => void }>[] }>

    const name = tree.props.children[0]
    name?.props.onClick?.({ shiftKey: false })

    expect(asked).toEqual([['cpu', false]])
  })

  it('asks to turn the column around, on its own', () => {
    const flipped: string[] = []
    const tree = SortHead({
      label: '内存',
      sorts: [{ key: 'cpu', direction: 'desc' }],
      column: 'memory',
      onSort: () => {},
      onFlip: (column) => { flipped.push(column) },
      fallback: 'desc',
      t,
    }) as ReactElement<{ children: readonly ReactElement<{ onClick?: () => void }>[] }>

    const control = tree.props.children[1]
    control?.props.onClick?.()

    expect(flipped).toEqual(['memory'])
  })

  it('is never handed a column called `key`', () => {
    // React reserves `key` and takes it out of the props before the component
    // is called: the head would receive nothing, every column would sort by
    // nothing, and the order would never move.
    const source = readFileSync(
      fileURLToPath(new URL('../src/client/device-panel.tsx', import.meta.url)),
      'utf8',
    )
    // A usage carries an arrow function, and an arrow function has a `>` in
    // it, so the tag is matched to the end of its line.
    const usages = source.match(/<SortHead\b[^\n]*\/>/gu) ?? []

    expect(usages.length).toBeGreaterThan(0)
    for (const usage of usages) {
      expect(usage).not.toMatch(/\bkey=/u)
      expect(usage).toMatch(/\bcolumn="[a-z]+"/u)
    }
  })

  it('watches both readings it draws', () => {
    // The panel reads the detail seat AND the load seat, and it has to keep
    // both fresh: the seats are refcounted, so watching one costs nothing the
    // status chip is not already paying. A panel that reads without watching
    // draws whatever the last reader left behind - and on a session whose chip
    // is not on screen, that is a dash that never fills in.
    const source = readFileSync(
      fileURLToPath(new URL('../src/client/device-panel.tsx', import.meta.url)),
      'utf8',
    )

    expect(source).toMatch(/deviceDetailSeat\.watch\(sessionId\)/u)
    expect(source).toMatch(/deviceMetricsSeat\.watch\(sessionId\)/u)
  })
})
