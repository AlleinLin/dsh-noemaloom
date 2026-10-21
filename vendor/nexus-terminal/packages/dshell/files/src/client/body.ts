/**
 * The file navigator's body: one movable tree, rooted wherever the tab stands.
 *
 * The stock Files pane lists the session's working directory and nothing else.
 * This one keeps that tree — a directory still expands in place on a click, a
 * file still opens through the tab owner's `openResource` — and adds the two
 * things a directory browser needs to be walkable:
 *
 *  - a **root** that moves. Double-clicking a directory makes it the new root,
 *    the header's crumbs jump anywhere above it, and a `..` row at the top goes
 *    up one level. The session's own directory is only where the tab opens.
 *  - **history** per tab, with back and forward in the header. Every landing
 *    pushes an entry and drops what was ahead of it, the browser rule, so back
 *    then forward returns to exactly where the reader was.
 *
 * The walk is unbounded on purpose: the listing route reads through the
 * session's own filesystem seam, so a device-bound session walks the device
 * (`/etc` is the device's `/etc`), and a local one walks this machine.
 *
 * The body never awaits anything: it calls the injected face and draws the
 * store. Anything the store does not hold is a request the face has not made
 * yet — the single effect below turns that into exactly one listing.
 */

import { createElement, Fragment, useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  FileTypeIcon, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconFolderCloseMedium, IconFolderOpenMedium,
  IconRefreshOutlineMedium, IconRightUpOutlineMedium, classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the session standard props (`sessionId`, `useSessions`).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the right-Sidebar SlotMap merge (the tab-body seat + its hooks).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { DshellFileEntry } from '../protocol.js'
import { parentOf, pathSegments, sessionFileAddress } from './address.js'
import { installDirectoryDrag, type DirectoryDrag } from './drag.js'
import type { FilesInjected } from './face.js'
import { TRANSFER_KIND } from './transfer-definition.js'
import { TransferGlyph } from './transfer-glyph.js'
import type {} from './locales.js'
import * as styles from './styles.js'
import type { TreeState, createDshellFilesStore } from './store.js'

/** The body's composed props: the tab it draws, its store, its face, and its copy. */
export type FilesBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<ReturnType<typeof createDshellFilesStore>>
  & FilesInjected
  & PropsLocale<'dshellFiles'>

/** Natural, case-insensitive name order, so `file2` precedes `file10`. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Order one level's entries for display: directories first, then everything
 * else, each group by name.
 * @param entries - the listing as the route returned it.
 * @returns a new array, directories first, then by name within each group.
 */
export function orderEntries(entries: readonly DshellFileEntry[]): DshellFileEntry[] {
  return [...entries].sort((left, right) => {
    const group = Number(right.kind === 'directory') - Number(left.kind === 'directory')
    return group !== 0 ? group : byName.compare(left.name, right.name)
  })
}

/**
 * Row-hover treatment. Inline styles cannot express `:hover`, and a highlighted
 * row is most of what tells a reader which line the pointer is on, so one
 * packaged style element carries it. Scoped to the navigator's own data
 * attributes, so it cannot affect stock chrome.
 *
 * The rows' resting background lives here too rather than in `rowStyle`: a
 * stylesheet `:hover` rule cannot override an inline declaration, and with
 * `background: transparent` inline the highlight matched `:hover` and painted
 * nothing.
 */
function injectHoverCss(): () => void {
  const style = document.createElement('style')
  style.dataset.dshell = 'files-nav'
  style.textContent = [
    '[data-dshell-file-row] { background: transparent; }',
    '[data-dshell-file-row]:hover { background: rgba(127,127,127,.09); border-radius: 6px; }',
    '[data-dshell-file-row][aria-expanded="true"] { background: rgba(127,127,127,.06); border-radius: 6px; }',
    '[data-dshell-file-path]::-webkit-scrollbar { display: none; }',
  ].join('\n')
  document.head.appendChild(style)
  return () => { style.remove() }
}

/** One row a press can start a drag from, as the row knows itself. */
export interface TreePress {
  /** Absolute path in the tree's world. */
  readonly path: string
  readonly name: string
  readonly kind: DshellFileEntry['kind']
}

/**
 * What every level shares: the tree it draws and the gestures on it.
 *
 * Deliberately the same context for the navigator and for each of a transfer
 * tab's two panes — the drawing and the single-click/double-click contract are
 * identical, so only the handlers differ. `dragAll` is the one difference the
 * rows themselves need: the navigator drags directories (onto the terminal),
 * while a transfer pane drags files too (onto the other side).
 */
export interface TreeContext {
  readonly state: TreeState
  /** Single click on a directory: open or collapse it in place. */
  readonly onToggle: (path: string) => void
  /** Double click on a directory, or the `..` row: stand there. */
  readonly onEnter: (path: string) => void
  /** A file: hand it to the tab owner for a viewer to claim. Absent draws a dead row. */
  readonly onOpen?: ((path: string) => void) | undefined
  /** A press on a row, which becomes a drag if the pointer moves. */
  readonly onPress?: ((event: { readonly clientX: number; readonly clientY: number; readonly button: number }, pressed: TreePress) => void) | undefined
  /** Whether files are drag sources as well as directories. */
  readonly dragAll?: boolean | undefined
  readonly t: TranslateNS<'dshellFiles'>
}

/** One entry's row, and its children when it is an expanded directory. */
export function Entry({ parent, entry, tree }: { parent: string; entry: DshellFileEntry; tree: TreeContext }): ReactNode {
  const path = `${parent.replace(/[/\\]+$/u, '')}/${entry.name}`
  const draggable = entry.kind === 'directory' || tree.dragAll === true
  const onPress = tree.onPress === undefined || !draggable
    ? undefined
    : (event: ReactPointerEvent<HTMLButtonElement>): void => {
      tree.onPress?.(event, { path, name: entry.name, kind: entry.kind })
    }
  if (entry.kind === 'directory') {
    const expanded = tree.state.expanded.includes(path)
    return createElement('li', {
      key: entry.name,
      'data-dshell-file-entry': 'directory',
      'data-dshell-file-path': path,
      style: styles.dragSourceStyle,
    },
      createElement('button', {
        type: 'button',
        style: { ...styles.rowStyle, ...styles.dragSourceStyle },
        'data-dshell-file-row': 'directory',
        'aria-expanded': expanded,
        title: entry.name,
        onClick: () => { tree.onToggle(path) },
        onDoubleClick: () => { tree.onEnter(path) },
        // Not defaulted: this is still the row's click, and it must reach the
        // button when the pointer never moves far enough to be a drag.
        onPointerDown: onPress,
      },
        createElement('span', { style: styles.iconStyle },
          expanded
            ? createElement(IconFolderOpenMedium, { size: 16 })
            : createElement(IconFolderCloseMedium, { size: 16 })),
        createElement('span', { style: styles.nameStyle }, entry.name),
      ),
      expanded
        ? createElement('ul', { style: styles.levelStyle }, createElement(Level, { path, tree }))
        : null,
    )
  }
  if (entry.kind === 'file') {
    const open = tree.onOpen
    return createElement('li', {
      key: entry.name, 'data-dshell-file-entry': 'file', 'data-dshell-file-path': path,
    },
      createElement('button', {
        type: 'button',
        style: tree.dragAll === true ? { ...styles.rowStyle, ...styles.dragSourceStyle } : styles.rowStyle,
        'data-dshell-file-row': 'file',
        title: entry.name,
        ...open === undefined ? {} : { onClick: () => { open(path) }, onDoubleClick: () => { open(path) } },
        ...onPress === undefined ? {} : { onPointerDown: onPress },
      },
        createElement('span', { style: styles.iconStyle },
          createElement(FileTypeIcon, { kind: classifyFileType(entry.name), size: 16 })),
        createElement('span', { style: styles.nameStyle }, entry.name),
      ),
    )
  }
  return createElement('li', { key: entry.name, 'data-dshell-file-entry': 'other', 'data-dshell-file-path': path },
    createElement('span', {
      style: { ...styles.rowStyle, opacity: 0.5, cursor: 'default' },
      'data-dshell-file-row': 'other',
      title: tree.t('entry.other'),
    }, createElement('span', { style: styles.nameStyle }, entry.name)))
}

/** One directory's rows: its state while listing, its entries once listed. */
export function Level({ path, tree }: { path: string; tree: TreeContext }): ReactNode {
  const { state, t } = tree
  const level = state.levels[path]
  if (level === undefined || level.kind === 'loading') {
    return createElement('li', { style: styles.noteStyle, 'data-dshell-file-row': 'loading' }, t('loading'))
  }
  if (level.kind === 'failed') {
    return createElement('li', { style: styles.errorStyle, 'data-dshell-file-row': 'failed' },
      t('error.unavailable', { message: level.message }))
  }
  const entries = orderEntries(level.level.entries)
  const rows: ReactNode[] = entries.map(entry => createElement(Entry, { key: entry.name, parent: path, entry, tree }))
  if (entries.length === 0) {
    rows.push(createElement('li', { key: '__empty__', style: styles.noteStyle, 'data-dshell-file-row': 'empty' }, t('empty')))
  }
  if (level.level.truncated) {
    rows.push(createElement('li', { key: '__truncated__', style: styles.noteStyle, 'data-dshell-file-row': 'truncated' }, t('truncated')))
  }
  return createElement(Fragment, null, rows)
}

/** The file navigator's body. */
export function DshellFilesBody({
  useTabInfo, sessionId, useSessions, useStore, start, load, toggle, navigate, cd, back, forward, reload,
  transferAvailable, t,
}: FilesBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const { signal, actions: tabActions } = tab
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const state = useStore(store => store.byTab[tab.id])
  // The level the tab stands on, read here rather than at the draw so the drop
  // effect below can be declared with the other hooks, before any early return.
  const rootLevel = state === undefined ? undefined : state.levels[state.root]

  useEffect(injectHoverCss, [])

  useEffect(() => {
    // A bucket gone because the record aborted must not be re-seeded by a
    // component that has not unmounted yet.
    if (state !== undefined || cwd === undefined || signal.aborted) return
    start(tab.id, cwd, signal)
  }, [state, cwd, tab.id, signal, start])

  // Wherever the tab stands with nothing listed is one request. Landing,
  // stepping back or forward, and reloading all arrive here, so the store stays
  // the single source of truth for what is on screen.
  useEffect(() => {
    if (state === undefined || signal.aborted) return
    if (state.levels[state.root] !== undefined) return
    load(tab.id, state.root, signal)
  }, [state, tab.id, signal, load])

  // Dropping a directory on the terminal is the jump button by another gesture,
  // so it goes through the same call and needs the same capability. The handle
  // lives in a ref because the rows reach it through the render below.
  const dragRef = useRef<DirectoryDrag | undefined>(undefined)
  useEffect(() => {
    if (rootLevel === undefined || rootLevel.kind !== 'ready' || !rootLevel.level.canCd) {
      dragRef.current = undefined
      return undefined
    }
    const drag = installDirectoryDrag((path) => { cd(tab.id, path) })
    dragRef.current = drag
    return () => {
      dragRef.current = undefined
      drag.dispose()
    }
  }, [rootLevel, cd, tab.id])

  if (cwd === undefined) {
    return createElement('div', { style: styles.noteStyle, 'data-dshell-files-state': 'no-workspace' }, t('noWorkspace'))
  }
  if (state === undefined) return null

  const enter = (path: string): void => { navigate(tab.id, path) }
  const tree: TreeContext = {
    state,
    onToggle: (path) => { toggle(tab.id, path, state.levels[path] !== undefined, signal) },
    onEnter: enter,
    onOpen: (path) => { tabActions.openResource(sessionFileAddress(String(sessionId), path)) },
    // Only directories: dropping one on the terminal is the jump gesture. A
    // file has nowhere to land there, so its press stays an ordinary press.
    onPress: (event, pressed) => { if (pressed.kind === 'directory') dragRef.current?.begin(event, pressed.path) },
    t,
  }

  const atStart = state.history.index <= 0
  const atEnd = state.history.index >= state.history.stack.length - 1
  // The host says whether it can drive a shell at all; without one the button
  // is absent rather than dead.
  const canCd = rootLevel !== undefined && rootLevel.kind === 'ready' && rootLevel.level.canCd
  const segments = pathSegments(state.root)
  const crumbs = segments.flatMap((segment, index) => {
    const last = index === segments.length - 1
    const nodes: ReactNode[] = []
    // The root crumb IS a `/`, so a separator after it would double it.
    if (index >= 2) nodes.push(createElement('span', { key: `sep:${segment.path}`, style: styles.separatorStyle }, '/'))
    nodes.push(createElement('button', {
      key: segment.path,
      type: 'button',
      style: last ? styles.crumbCurrentStyle : styles.crumbStyle,
      disabled: last,
      title: segment.path,
      'data-dshell-file-crumb': last ? 'current' : 'ancestor',
      onClick: () => { if (!last) enter(segment.path) },
    }, segment.label))
    return nodes
  })

  const parent = parentOf(state.root)
  const rows: ReactNode[] = []
  if (state.notice !== undefined) {
    rows.push(createElement('li', {
      key: '__notice__', style: styles.errorStyle, 'data-dshell-file-row': 'refused',
    }, t('error.cd', { message: state.notice })))
  }
  if (parent !== undefined) {
    rows.push(createElement('li', {
      key: '__parent__',
      'data-dshell-file-entry': 'parent',
      'data-dshell-file-path': parent,
      style: styles.dragSourceStyle,
    },
      createElement('button', {
        type: 'button',
        style: { ...styles.rowStyle, ...styles.dragSourceStyle },
        'data-dshell-file-row': 'parent',
        title: `${t('parent')} · ${parent}`,
        onDoubleClick: () => { enter(parent) },
        onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
          tree.onPress?.(event, { path: parent, name: '..', kind: 'directory' })
        },
      },
        createElement('span', { style: styles.iconStyle }, createElement(IconFolderCloseMedium, { size: 16 })),
        createElement('span', { style: styles.parentNameStyle }, '..'),
      )))
  }
  rows.push(createElement(Level, { key: state.root, path: state.root, tree }))

  return createElement('div', {
    style: styles.rootStyle,
    'data-dshell-files-state': 'tree',
    'data-dshell-files-root': state.root,
  },
    createElement('div', { style: styles.headerStyle },
      createElement('button', {
        type: 'button',
        style: atStart ? styles.navButtonOffStyle : styles.navButtonStyle,
        disabled: atStart,
        'aria-label': t('back'),
        title: t('back'),
        'data-dshell-file-nav': 'back',
        onClick: () => { back(tab.id) },
      }, createElement(IconChevronLeftOutlineRegular, { size: 16 })),
      createElement('button', {
        type: 'button',
        style: atEnd ? styles.navButtonOffStyle : styles.navButtonStyle,
        disabled: atEnd,
        'aria-label': t('forward'),
        title: t('forward'),
        'data-dshell-file-nav': 'forward',
        onClick: () => { forward(tab.id) },
      }, createElement(IconChevronRightOutlineRegular, { size: 16 })),
      createElement('div', { style: styles.pathStyle, 'data-dshell-file-path': '', title: state.root }, crumbs),
      canCd
        ? createElement('button', {
          type: 'button',
          style: styles.navButtonStyle,
          'aria-label': t('cd'),
          title: t('cd'),
          'data-dshell-file-nav': 'cd',
          onClick: () => { cd(tab.id, state.root) },
        }, createElement(IconRightUpOutlineMedium, { size: 16 }))
        : null,
      createElement('button', {
        type: 'button',
        style: styles.navButtonStyle,
        'aria-label': t('reload'),
        title: t('reload'),
        'data-dshell-file-nav': 'reload',
        onClick: () => { reload(tab.id, state.root, signal) },
      }, createElement(IconRefreshOutlineMedium, { size: 16 })),
      // The way into the transfer view. Shown only where there is something to
      // transfer TO: a device session whose binding has a mount directory, with
      // this package's own transfer type registered in the composition.
      transferAvailable()
        ? createElement('button', {
          type: 'button',
          style: styles.navButtonStyle,
          'aria-label': t('transfer.open'),
          title: t('transfer.open'),
          'data-dshell-file-nav': 'transfer',
          onClick: () => { tabActions.openTab(TRANSFER_KIND) },
        }, createElement(TransferGlyph, { size: 16 }))
        : null,
    ),
    createElement('div', { style: styles.bodyStyle },
      createElement('ul', { style: styles.levelStyle }, rows),
    ),
  )
}
