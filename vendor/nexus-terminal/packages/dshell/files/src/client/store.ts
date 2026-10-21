/**
 * The navigator's view state: where each tab is standing, how it got there,
 * what it has already listed, and — for a transfer tab — the same three facts
 * for each of its two panes plus the copies it started.
 *
 * A Slot-standard exclusive store — one instance per session — bucketed by tab
 * id, because the right pane mounts only the active tab's body: switching tabs
 * unmounts the React tree, so anything held in `useState` would be lost, while
 * this store survives until the tab record itself goes away.
 *
 * Two tab types share the instance because they are the same subject seen twice
 * (files, and files moving between two machines), so the browser's own bucket
 * and the transfer's live side by side rather than in two stores that could
 * drift apart about which directory is on screen.
 *
 * Every path here is the canonical absolute path in the executing world's own
 * namespace, exactly as the route reported it.
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DshellFileEntry } from '../protocol.js'
import type { TransferJobView, TransferSetup, TransferSide } from '../transfer-protocol.js'

/** One directory's contents, as the route answered. */
export interface DirectoryLevel {
  /**
   * The directory's own canonical path, as the world that listed it spells it.
   *
   * Equal to the level's key for a session on this machine. A device session
   * differs: the tab asks in this machine's namespace (its working directory is
   * a local mount directory standing in for the device tree) and the device
   * answers with its own absolute path. That answer is what re-bases the tab,
   * so the `..` row walks the device's tree instead of the mount's parents,
   * which do not exist on the device.
   */
  readonly path: string
  readonly entries: readonly DshellFileEntry[]
  readonly truncated: boolean
  /**
   * Whether the host can send the session's shell into this directory.
   *
   * Optional because a transfer pane has no shell to send: the field is the
   * navigator's, and the level shape is shared so both tabs draw the same rows.
   * Absent reads as "cannot", which is what the navigator's button does with it.
   */
  readonly canCd?: boolean | undefined
}

/** What one directory level is doing right now. */
export type LevelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly level: DirectoryLevel }
  | { readonly kind: 'failed'; readonly message: string }

/** One tree on screen, whether it is the browser's or one of a transfer's two. */
export interface TreeState {
  /** The directory this tree is showing now. */
  readonly root: string
  /** Level state by absolute directory path; a path absent here was never asked for. */
  readonly levels: Record<string, LevelState>
  /** Expanded absolute directory paths (paths opened INSIDE the current root). */
  readonly expanded: readonly string[]
}

/** Where the browser tab is, and what it remembers. */
export interface FilesTabState extends TreeState {
  /** The session's own directory, where the tab opened. */
  readonly home: string
  /** Visited roots, oldest first, with the current position. */
  readonly history: { readonly stack: readonly string[]; readonly index: number }
  /**
   * Why the last shell jump failed, until the next reading clears it.
   *
   * A jump leaves no trace in the pane — the shell moves in the terminal, not
   * here — so a refused one has to say so somewhere the reader is already
   * looking, or the button would look dead.
   */
  readonly notice?: string | undefined
}

/** One transfer tab: two panes, what the host allows, and the copies started. */
export interface TransferTabState {
  /** What the route said about this session: both roots, the device, whether it can transfer. */
  readonly setup: TransferSetup
  /** One tree per side. The panes' roots are the setup's, and each moves on its own. */
  readonly panes: Record<TransferSide, TreeState>
  /** Copies this tab started, oldest first. */
  readonly jobs: readonly TransferJobView[]
}

/** Every tab's state. */
export interface FilesState {
  /** The browser tab's tree, by tab id. */
  byTab: Record<TabId, FilesTabState>
  /** The transfer tab's pair of trees, by tab id. */
  transfer: Record<TabId, TransferTabState>
}

/** The store's write set; every action names the tab it writes. */
type FilesActions = {
  seed: (draft: FilesState, tabId: TabId, home: string) => void
  loading: (draft: FilesState, tabId: TabId, path: string) => void
  loaded: (draft: FilesState, tabId: TabId, path: string, level: DirectoryLevel) => void
  failed: (draft: FilesState, tabId: TabId, path: string, message: string) => void
  toggled: (draft: FilesState, tabId: TabId, path: string) => void
  /** Stand on a directory, recording it in history. */
  navigated: (draft: FilesState, tabId: TabId, path: string) => void
  /** Record why a shell jump was refused, for the pane to show. */
  refused: (draft: FilesState, tabId: TabId, message: string) => void
  back: (draft: FilesState, tabId: TabId) => void
  forward: (draft: FilesState, tabId: TabId) => void
  /** Drop every cached level; the current root is listed again after. */
  reset: (draft: FilesState, tabId: TabId) => void
  /** Forget one tab's navigator, for a tab record that is gone. */
  forget: (draft: FilesState, tabId: TabId) => void
  /** Open one transfer tab on its two roots, with nothing listed yet. */
  transferSeeded: (draft: FilesState, tabId: TabId, setup: TransferSetup) => void
  transferLoading: (draft: FilesState, tabId: TabId, side: TransferSide, path: string) => void
  transferLoaded: (draft: FilesState, tabId: TabId, side: TransferSide, path: string, level: DirectoryLevel) => void
  transferFailed: (draft: FilesState, tabId: TabId, side: TransferSide, path: string, message: string) => void
  transferToggled: (draft: FilesState, tabId: TabId, side: TransferSide, path: string) => void
  /** Stand one transfer pane on a directory; no history, the panes are shallow. */
  transferNavigated: (draft: FilesState, tabId: TabId, side: TransferSide, path: string) => void
  /** Drop one pane's cached levels; its current root is listed again after. */
  transferReset: (draft: FilesState, tabId: TabId, side: TransferSide) => void
  /** Add a copy to the tab's list. */
  jobStarted: (draft: FilesState, tabId: TabId, job: TransferJobView) => void
  /** Replace a copy's view with a newer one. */
  jobUpdated: (draft: FilesState, tabId: TabId, job: TransferJobView) => void
  /** Drop a copy's row. */
  jobDismissed: (draft: FilesState, tabId: TabId, jobId: string) => void
  /** Forget one transfer tab, for a tab record that is gone. */
  transferForget: (draft: FilesState, tabId: TabId) => void
}

/**
 * One browser tab's bucket, which every writer after `seed` relies on: the face
 * only dispatches while the record's signal is live, and `forget` runs on its
 * abort.
 * @param state - the draft.
 * @param tabId - the tab being written.
 * @returns the tab's navigator.
 */
function bucket(state: FilesState, tabId: TabId): FilesTabState {
  const tab = state.byTab[tabId]
  if (tab === undefined) throw new Error(`dshell-files: no navigator for tab "${tabId}"`)
  return tab
}

/** One transfer tab's bucket, with the same lifetime rule as {@link bucket}. */
function transferBucket(state: FilesState, tabId: TabId): TransferTabState {
  const tab = state.transfer[tabId]
  if (tab === undefined) throw new Error(`dshell-files: no transfer state for tab "${tabId}"`)
  return tab
}

/**
 * Land one browser tab on a directory: the root moves, the position is recorded,
 * and anything ahead of it in history is dropped — the browser rule.
 * @param state - the draft.
 * @param tabId - the tab being written.
 * @param path - the directory to stand on.
 */
function standOn(state: FilesState, tabId: TabId, path: string): void {
  const tab = bucket(state, tabId)
  const stack = [...tab.history.stack.slice(0, tab.history.index + 1), path]
  state.byTab[tabId] = {
    ...tab,
    root: path,
    history: { stack, index: stack.length - 1 },
    expanded: [path],
    notice: undefined,
  }
}

/**
 * Record one directory's contents in one tree, re-basing the tree when the world
 * spells the listed directory differently than the tree asked for.
 *
 * The re-basing is what lets a `..` row and a crumb speak the DEVICE's namespace
 * for a device session, whose mount directory is answered as the device's own
 * path. It applies to a transfer pane exactly as it does to the browser tab.
 * @param tree - the tree being written.
 * @param asked - the path the caller asked for.
 * @param level - the listing the route answered.
 * @returns the tree's next state, and whether the root moved.
 */
function listed(tree: TreeState, asked: string, level: DirectoryLevel): TreeState {
  if (asked !== tree.root || level.path === asked) {
    const levels = { ...tree.levels }
    levels[asked] = { kind: 'ready', level }
    return { ...tree, levels }
  }
  const levels = { ...tree.levels }
  delete levels[asked]
  levels[level.path] = { kind: 'ready', level }
  return { ...tree, root: level.path, levels, expanded: [level.path] }
}

/**
 * Declare the navigator's store.
 *
 * A factory rather than a shared handle: the registration declares it as an
 * exclusive store, so the framework mints one instance per session.
 * @returns the store handle to declare on the registration.
 */
export function createDshellFilesStore(): EngineStoreHandle<FilesState, FilesActions> {
  return defineStore({
    init: (): FilesState => ({ byTab: {}, transfer: {} }),
    actions: {
      /**
       * Open one tab on the session's directory, with nothing listed yet.
       *
       * Seeding does not list: the body lists the root through one effect, so a
       * fresh tab makes exactly one request instead of racing two.
       */
      seed: (d, tabId: TabId, home: string) => {
        d.byTab[tabId] = { home, root: home, history: { stack: [home], index: 0 }, levels: {}, expanded: [home] }
      },
      /** Mark one directory as being listed. */
      loading: (d, tabId: TabId, path: string) => {
        bucket(d, tabId).levels[path] = { kind: 'loading' }
      },
      /** Record one directory's contents, re-basing the tab when the world spells it differently. */
      loaded: (d, tabId: TabId, path: string, level: DirectoryLevel) => {
        const tab = bucket(d, tabId)
        const next = listed(tab, path, level)
        // The root moved onto the world's own spelling: history's current
        // position moves with it, or a later back/forward would land on the
        // mount directory again.
        const history = next.root === tab.root
          ? tab.history
          : { stack: tab.history.stack.map((entry, index) => index === tab.history.index ? next.root : entry), index: tab.history.index }
        d.byTab[tabId] = { ...next, home: tab.home, history, notice: undefined }
      },
      /** Record why one directory could not be listed. */
      failed: (d, tabId: TabId, path: string, message: string) => {
        bucket(d, tabId).levels[path] = { kind: 'failed', message }
      },
      /**
       * Open a collapsed directory, or collapse an open one.
       *
       * A collapsed level keeps what it loaded, so reopening it draws at once.
       */
      toggled: (d, tabId: TabId, path: string) => {
        const tab = bucket(d, tabId)
        const at = tab.expanded.indexOf(path)
        const expanded = [...tab.expanded]
        if (at >= 0) expanded.splice(at, 1)
        else expanded.push(path)
        d.byTab[tabId] = { ...tab, expanded }
      },
      /** Stand on a directory, recording it in history. */
      navigated: (d, tabId: TabId, path: string) => {
        standOn(d, tabId, path)
      },
      /** Record why a shell jump was refused. */
      refused: (d, tabId: TabId, message: string) => {
        d.byTab[tabId] = { ...bucket(d, tabId), notice: message }
      },
      /** Step one entry back in history. */
      back: (d, tabId: TabId) => {
        const tab = bucket(d, tabId)
        if (tab.history.index <= 0) return
        const index = tab.history.index - 1
        const root = tab.history.stack[index] as string
        d.byTab[tabId] = { ...tab, root, history: { ...tab.history, index }, expanded: [root] }
      },
      /** Step one entry forward in history. */
      forward: (d, tabId: TabId) => {
        const tab = bucket(d, tabId)
        if (tab.history.index >= tab.history.stack.length - 1) return
        const index = tab.history.index + 1
        const root = tab.history.stack[index] as string
        d.byTab[tabId] = { ...tab, root, history: { ...tab.history, index }, expanded: [root] }
      },
      /** Drop every cached level, keeping where the tab stands. */
      reset: (d, tabId: TabId) => {
        const tab = bucket(d, tabId)
        d.byTab[tabId] = { ...tab, levels: {} }
      },
      /** Forget one tab's navigator, for a tab record that is gone. */
      forget: (d, tabId: TabId) => {
        d.byTab = Object.fromEntries(Object.entries(d.byTab).filter(([id]) => id !== tabId))
      },
      /**
       * Open one transfer tab on its two roots, with nothing listed yet.
       *
       * The roots come from the host's own answer rather than from the client's
       * guess: the local side is this machine's home and the device side is the
       * session's directory ON THE DEVICE, and only the host knows both.
       */
      transferSeeded: (d, tabId: TabId, setup: TransferSetup) => {
        const local = setup.localRoot
        const remote = setup.remoteRoot ?? setup.localRoot
        d.transfer[tabId] = {
          setup,
          panes: {
            local: { root: local, levels: {}, expanded: [local] },
            remote: { root: remote, levels: {}, expanded: [remote] },
          },
          jobs: [],
        }
      },
      /** Mark one pane's directory as being listed. */
      transferLoading: (d, tabId: TabId, side: TransferSide, path: string) => {
        transferBucket(d, tabId).panes[side].levels[path] = { kind: 'loading' }
      },
      /** Record one pane's listing, re-basing that pane's root onto the world's spelling. */
      transferLoaded: (d, tabId: TabId, side: TransferSide, path: string, level: DirectoryLevel) => {
        const tab = transferBucket(d, tabId)
        const pane = listed(tab.panes[side], path, level)
        d.transfer[tabId] = { ...tab, panes: { ...tab.panes, [side]: pane } }
      },
      /** Record why one pane's directory could not be listed. */
      transferFailed: (d, tabId: TabId, side: TransferSide, path: string, message: string) => {
        transferBucket(d, tabId).panes[side].levels[path] = { kind: 'failed', message }
      },
      /** Open or collapse a directory inside one pane. */
      transferToggled: (d, tabId: TabId, side: TransferSide, path: string) => {
        const tab = transferBucket(d, tabId)
        const pane = tab.panes[side]
        const at = pane.expanded.indexOf(path)
        const expanded = [...pane.expanded]
        if (at >= 0) expanded.splice(at, 1)
        else expanded.push(path)
        d.transfer[tabId] = { ...tab, panes: { ...tab.panes, [side]: { ...pane, expanded } } }
      },
      /** Stand one pane on a directory. */
      transferNavigated: (d, tabId: TabId, side: TransferSide, path: string) => {
        const tab = transferBucket(d, tabId)
        d.transfer[tabId] = {
          ...tab,
          panes: { ...tab.panes, [side]: { ...tab.panes[side], root: path, expanded: [path] } },
        }
      },
      /** Drop one pane's cached levels, keeping where it stands. */
      transferReset: (d, tabId: TabId, side: TransferSide) => {
        const tab = transferBucket(d, tabId)
        d.transfer[tabId] = {
          ...tab,
          panes: { ...tab.panes, [side]: { ...tab.panes[side], levels: {} } },
        }
      },
      /** Add a copy to the tab's list. */
      jobStarted: (d, tabId: TabId, job: TransferJobView) => {
        const tab = transferBucket(d, tabId)
        d.transfer[tabId] = { ...tab, jobs: [...tab.jobs, job] }
      },
      /** Replace a copy's view with a newer one. */
      jobUpdated: (d, tabId: TabId, job: TransferJobView) => {
        const tab = transferBucket(d, tabId)
        if (!tab.jobs.some(entry => entry.id === job.id)) return
        d.transfer[tabId] = { ...tab, jobs: tab.jobs.map(entry => entry.id === job.id ? job : entry) }
      },
      /** Drop a copy's row. */
      jobDismissed: (d, tabId: TabId, jobId: string) => {
        const tab = transferBucket(d, tabId)
        d.transfer[tabId] = { ...tab, jobs: tab.jobs.filter(entry => entry.id !== jobId) }
      },
      /** Forget one transfer tab, for a tab record that is gone. */
      transferForget: (d, tabId: TabId) => {
        d.transfer = Object.fromEntries(Object.entries(d.transfer).filter(([id]) => id !== tabId))
      },
    },
  })
}
