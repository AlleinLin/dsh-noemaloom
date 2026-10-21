/**
 * The transfer body: two file trees side by side — this machine and the device
 * the session runs on — with drag-and-drop copying between them.
 *
 * The trees are the navigator's own rows and levels, not a second drawing of a
 * file list: both tabs are the same subject (files), so the single-click to
 * expand, double-click to enter, crumb and reload gestures mean exactly what they
 * mean next door. What differs is what a drag DOES — here a pressed row becomes
 * a cross-machine copy rather than a shell jump — and that is the whole
 * behavioural surface of this file.
 *
 * A drop lands IN a directory: the row under the pointer when there is one, the
 * receiving pane's current directory otherwise. The host therefore never has to
 * decide whether a path named a file or a folder; it copies the entry into the
 * directory it is given.
 *
 * The body never awaits anything: it calls the injected face and draws the
 * store, exactly as the navigator's body does. The copies are rows under both
 * panes, each with its own progress and its own cancel, because a directory copy
 * is long enough that "nothing happened yet" would be the wrong story.
 */

import { createElement, useEffect, useRef, type ReactNode } from 'react'
import { IconRefreshOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the right-Sidebar SlotMap merge (the tab-body seat + its hooks).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TransferJobView, TransferSide } from '../transfer-protocol.js'
import { pathSegments } from './address.js'
import { Level, type TreeContext } from './body.js'
import type {} from './locales.js'
import * as base from './styles.js'
import { installTransferDrag, type TransferDrag } from './transfer-drag.js'
import type { TransferInjected } from './transfer-face.js'
import * as styles from './transfer-styles.js'
import type { createDshellFilesStore } from './store.js'

/** The two panes, in the order they are drawn: this machine on the left. */
const SIDES: readonly TransferSide[] = ['local', 'remote']

/** The body's composed props: the tab it draws, its store, its face, and its copy. */
export type TransferBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<ReturnType<typeof createDshellFilesStore>>
  & TransferInjected
  & PropsLocale<'dshellFiles'>

/** A byte count a person can read. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit] as string}`
}

/** The last segment of a POSIX path. */
function lastSegment(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  const cut = trimmed.lastIndexOf('/')
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

/** How far a copy has come, as a fraction for the bar. */
function progressOf(job: TransferJobView): number {
  if (job.totalBytes !== undefined && job.totalBytes > 0) return Math.min(1, job.bytes / job.totalBytes)
  if (job.totalFiles !== undefined && job.totalFiles > 0) return Math.min(1, job.files / job.totalFiles)
  return job.state === 'done' ? 1 : 0
}

/** One pane: its own tree, its own header, and the drop area the drag finds. */
function Pane({
  side, label, tree, path, onReload, t,
}: {
  readonly side: TransferSide
  readonly label: string
  readonly tree: TreeContext
  readonly path: string
  readonly onReload: () => void
  readonly t: TreeContext['t']
}): ReactNode {
  const segments = pathSegments(path)
  const crumbs = segments.flatMap((segment, index) => {
    const last = index === segments.length - 1
    const nodes: ReactNode[] = []
    // The root crumb IS a `/`, so a separator after it would double it.
    if (index >= 2) nodes.push(createElement('span', { key: `sep:${segment.path}`, style: base.separatorStyle }, '/'))
    nodes.push(createElement('button', {
      key: segment.path,
      type: 'button',
      style: last ? base.crumbCurrentStyle : base.crumbStyle,
      disabled: last,
      title: segment.path,
      'data-dshell-transfer-crumb': last ? 'current' : 'ancestor',
      onClick: () => { if (!last) tree.onEnter(segment.path) },
    }, segment.label))
    return nodes
  })
  return createElement('div', {
    style: styles.paneStyle,
    'data-transfer-pane': side,
    'data-transfer-root': path,
  },
    // The crumb line IS the way up: every ancestor is a button, so a pane needs
    // no separate up control and the header stays one label and one reload.
    createElement('div', { style: styles.paneHeaderStyle },
      createElement('span', { style: styles.paneLabelStyle, title: label, 'data-transfer-label': side }, label),
      createElement('button', {
        type: 'button',
        style: base.navButtonStyle,
        'aria-label': t('reload'),
        title: t('reload'),
        'data-dshell-transfer-nav': `${side}:reload`,
        onClick: onReload,
      }, createElement(IconRefreshOutlineMedium, { size: 16 })),
    ),
    createElement('div', { style: styles.panePathStyle, 'data-dshell-transfer-path': side }, crumbs),
    createElement('div', { style: styles.paneBodyStyle },
      createElement('ul', { style: base.levelStyle }, createElement(Level, { path, tree }))),
  )
}

/** The copy state's own key, spelled per state so the lookup stays typed. */
const STATE_KEY = {
  walking: 'transfer.state.walking',
  copying: 'transfer.state.copying',
  done: 'transfer.state.done',
  failed: 'transfer.state.failed',
  cancelled: 'transfer.state.cancelled',
} as const

/** One copy's line: what is moving, how far, and what the reader can do about it. */
function Job({
  job, name, direction, t, onCancel, onOverwrite, onDismiss,
}: {
  readonly job: TransferJobView
  readonly name: string
  readonly direction: string
  readonly t: TreeContext['t']
  readonly onCancel: () => void
  readonly onOverwrite: () => void
  readonly onDismiss: () => void
}): ReactNode {
  const running = job.state === 'walking' || job.state === 'copying'
  const fraction = progressOf(job)
  const counts = job.totalFiles === undefined
    ? undefined
    : t('transfer.counts', { done: String(job.files), total: String(job.totalFiles) })
  return createElement('div', {
    style: styles.jobRowStyle,
    'data-dshell-transfer-job': job.state,
    title: job.fromPath,
  },
    createElement('span', { style: styles.jobNameStyle }, name),
    createElement('span', { style: styles.jobArrowStyle, title: direction }, '→'),
    job.error !== undefined
      ? createElement('span', { style: styles.jobErrorStyle }, job.error)
      : createElement('span', { style: styles.jobStateStyle }, t(STATE_KEY[job.state])),
    running
      ? createElement('span', { style: styles.jobProgressStyle },
        createElement('span', { style: { ...styles.jobBarStyle, width: `${String(Math.round(fraction * 100))}%` } }))
      : null,
    job.state === 'copying' || job.state === 'done'
      ? createElement('span', { style: styles.jobStateStyle }, formatBytes(job.bytes))
      : null,
    counts !== undefined && running
      ? createElement('span', { style: styles.jobStateStyle }, counts)
      : null,
    job.skipped > 0
      ? createElement('span', { style: styles.jobStateStyle }, t('transfer.skipped', { count: String(job.skipped) }))
      : null,
    running && job.chunksTotal !== undefined && job.chunksTotal > 0
      ? createElement('span', { style: styles.jobStateStyle },
        t('transfer.chunks', { done: String(job.chunksDone ?? 0), total: String(job.chunksTotal) }))
      : null,
    running
      ? createElement('button', {
        type: 'button',
        style: styles.jobButtonStyle,
        'data-dshell-transfer-action': `cancel:${job.id}`,
        onClick: onCancel,
      }, t('transfer.cancel'))
      : null,
    !running && job.conflict === true
      ? createElement('button', {
        type: 'button',
        style: styles.jobButtonStyle,
        'data-dshell-transfer-action': `overwrite:${job.id}`,
        onClick: onOverwrite,
      }, t('transfer.overwrite'))
      : null,
    running
      ? null
      : createElement('button', {
        type: 'button',
        style: styles.jobButtonStyle,
        'data-dshell-transfer-action': `dismiss:${job.id}`,
        onClick: onDismiss,
      }, t('transfer.dismiss')),
  )
}

/** The transfer body. */
export function DshellTransferBody({
  useTabInfo, useStore, start, load, toggle, navigate, reload, drop, overwrite, cancel, dismiss, t,
}: TransferBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const { signal } = tab
  const state = useStore(store => store.transfer[tab.id])

  useEffect(() => {
    // A bucket gone because the record aborted must not be re-seeded by a
    // component that has not unmounted yet.
    if (state !== undefined || signal.aborted) return
    start(tab.id, signal)
  }, [state, tab.id, signal, start])

  // Both roots are listed once, through one effect, so a fresh tab makes exactly
  // one request per side. A level marked `loading` counts as asked for, which is
  // what keeps a second pass from racing the first.
  useEffect(() => {
    if (state === undefined || signal.aborted || !state.setup.canTransfer) return
    for (const side of SIDES) {
      if (side === 'remote' && state.setup.remoteRoot === undefined) continue
      const pane = state.panes[side]
      if (pane.levels[pane.root] !== undefined) continue
      load(tab.id, side, pane.root, signal)
    }
  }, [state, tab.id, signal, load])

  // The drag is installed once and reads its own dataset from the DOM, so the
  // rows only have to start it. It lives in a ref because the rows reach it
  // through the render below.
  const dragRef = useRef<TransferDrag | undefined>(undefined)
  useEffect(() => {
    const drag = installTransferDrag((item, hit) => {
      drop(tab.id, { from: item.side, fromPath: item.path, to: hit.side, toDir: hit.dir }, signal)
    })
    dragRef.current = drag
    return () => {
      dragRef.current = undefined
      drag.dispose()
    }
  }, [drop, tab.id, signal])

  if (state === undefined) {
    return createElement('div', { style: base.noteStyle, 'data-dshell-transfer-state': 'loading' }, t('transfer.preparing'))
  }
  if (!state.setup.canTransfer) {
    return createElement('div', {
      style: styles.hintStyle,
      'data-dshell-transfer-state': 'blocked',
    }, state.setup.reason ?? t('transfer.blocked'))
  }

  const labelFor = (side: TransferSide): string =>
    side === 'local' ? t('transfer.local') : (state.setup.device?.name ?? t('transfer.remote'))

  const panes = SIDES.map((side) => {
    const pane = state.panes[side]
    const tree: TreeContext = {
      state: pane,
      onToggle: (path) => { toggle(tab.id, side, path, pane.levels[path] !== undefined, signal) },
      onEnter: (path) => { navigate(tab.id, side, path) },
      // Every row drags here, files included: a transfer moves files, and a
      // folder drags as itself.
      onPress: (event, pressed) => { dragRef.current?.begin(event, { ...pressed, side }) },
      dragAll: true,
      t,
    }
    return createElement(Pane, {
      key: side,
      side,
      label: labelFor(side),
      tree,
      path: pane.root,
      onReload: () => { reload(tab.id, side, pane.root, signal) },
      t,
    })  })

  const jobs = [...state.jobs].reverse()
  return createElement('div', { style: styles.rootStyle, 'data-dshell-transfer-state': 'ready' },
    createElement('div', { style: styles.headerStyle },
      createElement('span', { style: styles.titleStyle }, t('transfer.label')),
      createElement('button', {
        type: 'button',
        style: base.navButtonStyle,
        'aria-label': t('transfer.reload'),
        title: t('transfer.reload'),
        'data-dshell-transfer-nav': 'reload',
        onClick: () => { for (const side of SIDES) reload(tab.id, side, state.panes[side].root, signal) },
      }, createElement(IconRefreshOutlineMedium, { size: 16 })),
    ),
    createElement('div', { style: styles.panesStyle }, panes),
    createElement('div', { style: styles.jobsStyle, 'data-dshell-transfer-jobs': '' },
      jobs.length === 0
        ? createElement('div', { style: styles.hintStyle }, t('transfer.hint'))
        : jobs.map(job => createElement('div', { key: job.id }, Job({
          job,
          name: lastSegment(job.fromPath),
          direction: `${labelFor(job.from)} → ${labelFor(job.to)}`,
          t,
          onCancel: () => { cancel(tab.id, job.id) },
          onOverwrite: () => { overwrite(tab.id, job.id, signal) },
          onDismiss: () => { dismiss(tab.id, job.id) },
        }))),
    ),
  )
}
