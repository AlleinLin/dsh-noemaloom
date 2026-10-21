/**
 * The sidebar's terminal section: its own header, list, search and archive.
 *
 * dsh shows a session under the workspace it was created in, which made the
 * terminal look like an ordinary folder. The section instead sits BELOW the
 * workspace list and is dshell's own: it lists the terminal sessions, filters
 * them by title, archives them through dshell's own bit, and creates new ones
 * with a terminal-glyph button rather than a folder one. Underneath, the
 * sessions still belong to a workspace (dsh's grouping owns their lifetime),
 * but that workspace's own row is hidden so the section is the only place they
 * appear.
 *
 * The chrome follows dsh's own sidebar — its `--dsw-*` tokens, its 36px section
 * header, its 28px rows and its own icon artwork (`dsh-icons.ts`) — because a
 * surface mounted beside dsh's rows is only invisible when it is built from the
 * same measurements.
 *
 * Structure matters here, not just looks: every node is created ONCE and later
 * renders only update it (rows are keyed by session id). The session list ticks
 * on its own — activity, running state, the click that opens a session — and a
 * render that replaced the rows would swallow the click whose mousedown and
 * mouseup landed on two different nodes. For the same reason the row actions
 * run on `pointerdown`, which always lands on the node the reader pressed.
 */

import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TerminalModeClient } from './terminal-mode.js'
import type { CurrentSessionSeat, DeviceChoiceSeat } from './terminal-mode-switch.js'
import type { PipeSeat } from './status-card.js'
import { dshIcon, type DshIconName } from './dsh-icons.js'

/** The sidebar hole the workspace browser fills; our section sits after its region. */
const SIDEBAR_HOLE = '[data-slot="sidebar.workspaces"]'

/** Our section's marker. */
const MARKER = 'data-dshell-terminal-section'

const LABEL_PRIMARY = 'var(--dsw-alias-label-primary)'
const LABEL_TERTIARY = 'var(--dsw-alias-label-tertiary)'
const ROW_HOVER = 'var(--dsw-alias-interactive-bg-hover)'
const TOOL_HOVER = 'var(--dsw-alias-button-tool-bar-hover)'
const BORDER = 'var(--dsw-alias-border-l2)'
const RADIUS = 'var(--dsw-radius-md)'

/**
 * The place pill's metrics, copied from the one dshell puts on dsh's own
 * session rows (`dshell-ssh`'s `session-bind.ts`), so the two rows read as one
 * language. Ours carries no dropdown: the host refuses to move a session that
 * has history, and a session that has none answers the question on its
 * initialization page.
 */
const PLACE_CSS = 'display:inline-flex;align-items:center;max-width:96px;padding:1px 6px;box-sizing:border-box;' +
  'border-radius:4px;border:1px solid var(--dsw-border, transparent);background:transparent;flex:none;' +
  'font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'

/** The row menu's panel and items, on dsh's own menu tokens. */
const MENU_PANEL_CSS = 'position:absolute;top:100%;right:0;z-index:40;min-width:132px;padding:4px;border-radius:8px;' +
  'border:1px solid var(--dsw-border, transparent);background:var(--dsw-menu-bg, Canvas);' +
  'box-shadow:0 8px 24px rgb(0 0 0 / 0.18)'
const MENU_ITEM_CSS = 'display:flex;align-items:center;gap:6px;width:100%;padding:4px 8px;box-sizing:border-box;' +
  'border-radius:4px;border:none;background:transparent;color:inherit;font-size:12px;line-height:18px;' +
  'text-align:left;cursor:pointer'

/** What the section needs from the rest of the composition. */
export interface TerminalSectionDeps {
  readonly modes: TerminalModeClient
  readonly sessions: ISessions
  readonly currentSession: CurrentSessionSeat
  readonly workspaces: {
    create(input: { path: string }): Promise<{ workspaceId: string }>
    /** The adopted workspaces, so the section can find its own by path. */
    list: {
      getSnapshot(): { readonly items: readonly { readonly workspaceId: string; readonly path: string }[] }
      subscribe(listener: () => void): () => void
    }
  }
  /**
   * The device seat, so a row can say where its shell runs. Undefined in a
   * composition without `dshell-ssh`, where every terminal is local and the pill
   * says so.
   */
  readonly devices: DeviceChoiceSeat | undefined
  /**
   * The cross-session pipe's face, for the header's entry button. The panel it
   * opens is frame-wide rather than this section's, but the section is the only
   * chrome dshell owns in the sidebar, and an entry that lives nowhere is an
   * entry the reader cannot find. Undefined in a composition without
   * `dshell-buffer`; the button then does not render at all.
   */
  readonly pipe: PipeSeat | undefined
  readonly openSession: (sessionId: SessionId) => void
  /** Mint a session in a workspace, bypassing dsh's blank-draft reuse. */
  readonly createSession: (workspaceId: string) => Promise<SessionId | undefined>
  /** Ask for the rename dialog, seeded with the row's current title. */
  readonly requestRename: (sessionId: SessionId, currentTitle: string) => void
  readonly t: TranslateNS<'dshellMode'>
}

/** One session's row, kept across renders by session id. */
interface Row {
  readonly root: HTMLElement
  readonly title: HTMLElement
  readonly place: HTMLElement
  readonly toggle: HTMLButtonElement
  readonly menu: HTMLButtonElement
  readonly menuPanel: HTMLElement
  readonly menuRename: HTMLButtonElement
  readonly menuArchive: HTMLButtonElement
}

/**
 * Mount the terminal section until the returned disposer runs.
 * @param deps - the services the section drives.
 * @returns the disposer.
 */
export function mountTerminalSection(deps: TerminalSectionDeps): () => void {
  if (typeof document === 'undefined') return () => {}
  const root = document.createElement('div')
  root.setAttribute(MARKER, '')
  // No horizontal padding on the container: dsh's own section header carries its
  // 4px inset and its rows run full-bleed, so matching that keeps our label and
  // hover band on exactly the same x as the workspace section's.
  root.style.cssText = 'display:flex;flex-direction:column;padding:0 0 4px;box-sizing:border-box'
  let searching = false
  let showArchived = false
  let query = ''
  let busy = false

  /** Swap an icon button's artwork, creating the svg on first use. */
  const setIcon = (button: HTMLButtonElement, name: DshIconName, size = 14): void => {
    const svg = button.querySelector('svg')
    if (svg === null) button.append(dshIcon(name, size))
    else svg.replaceWith(dshIcon(name, size))
  }

  /** One icon control: 24px box, dsh's toolbar hover, 14px artwork. */
  const iconButton = (name: DshIconName, title: string, onClick: () => void, size = 14): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.title = title
    button.setAttribute('aria-label', title)
    button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;' +
      `padding:0;border:none;border-radius:${RADIUS};background:transparent;cursor:pointer;color:${LABEL_TERTIARY};flex:none`
    button.append(dshIcon(name, size))
    button.addEventListener('mouseenter', () => { button.style.background = TOOL_HOVER; button.style.color = LABEL_PRIMARY })
    button.addEventListener('mouseleave', () => { button.style.background = 'transparent'; button.style.color = LABEL_TERTIARY })
    button.addEventListener('pointerdown', (event) => { event.stopPropagation() })
    button.addEventListener('click', (event) => { event.stopPropagation(); onClick() })
    return button
  }

  /**
   * Create the workspace if needed, then mint a session in it and open it. The
   * session is born unstarted, and its initialization page asks where it runs
   * and which preset it uses — so nothing is asked here.
   *
   * The session is minted DIRECTLY rather than through dsh's workspace open,
   * which reuses the workspace's blank draft (`reuseOrCreateBlank`): a terminal
   * session logs no turn, so it stays `blank` for as long as it is used as a
   * shell, and every press of this button would land the reader back in the
   * session already on screen.
   */
  const start = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      const path = deps.modes.root()
      if (path.length === 0) return
      // Resolved by path every time: adoption is idempotent host-side, and the
      // recorded id may be stale (the terminal root is a setting that can move).
      const workspaceId = (await deps.workspaces.create({ path })).workspaceId
      if (deps.modes.getSnapshot().workspaceId !== workspaceId) await deps.modes.useWorkspace(workspaceId)
      const sessionId = await deps.createSession(workspaceId)
      if (sessionId === undefined) return
      // Recorded here rather than left to the view's own rule: this button is
      // the one choice in the flow that is unambiguous, and the record says so.
      await deps.modes.set(String(sessionId), true, { origin: 'section', cwd: path })
      deps.openSession(sessionId)
    } catch (error) {
      console.warn('dshell: could not open a terminal session', error)
    } finally {
      busy = false
    }
  }

  // ---- the chrome, built once ----
  const header = document.createElement('div')
  header.style.cssText = 'display:flex;align-items:center;gap:4px;height:36px;padding-left:4px;' +
    'margin-bottom:4px;box-sizing:border-box;overflow:hidden'
  /**
   * The pipe panel's entry, first in the bar.
   *
   * It stays visible when the section is folded, unlike the list's own tools:
   * the panel is frame-wide and this is its only entry, so folding the terminal
   * list must not put the pipes out of reach.
   */
  const pipeButton = iconButton('link', deps.t('block.pipe'), () => {
    const pipe = deps.pipe
    if (pipe === undefined) return
    pipe.setOpen(!pipe.getSnapshot().open)
  })
  // Registered after `iconButton`'s own handlers, so it has the last word on the
  // colour: an open panel keeps the button lit after the pointer leaves.
  pipeButton.addEventListener('mouseleave', () => {
    pipeButton.style.color = deps.pipe?.getSnapshot().open === true ? LABEL_PRIMARY : LABEL_TERTIARY
  })
  const foldButton = iconButton('chevronDown', deps.t('block.fold'), () => {
    void deps.modes.setFolded(!deps.modes.getSnapshot().folded)
  })
  const labelEl = document.createElement('span')
  labelEl.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
    `color:${LABEL_TERTIARY};font-size:12px;line-height:20px;cursor:pointer`
  labelEl.addEventListener('click', () => { void deps.modes.setFolded(!deps.modes.getSnapshot().folded) })
  const searchButton = iconButton('search', deps.t('block.search'), () => {
    searching = !searching
    if (!searching) query = ''
    render()
  })
  const archiveButton = iconButton('filter', deps.t('block.archived'), () => { showArchived = !showArchived; render() })
  const createButton = iconButton('code', deps.t('block.create'), () => { void start() })
  header.append(pipeButton, foldButton, labelEl, searchButton, archiveButton, createButton)

  const searchInput = document.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = deps.t('block.searchPlaceholder')
  searchInput.style.cssText = 'margin:0 4px 4px;height:28px;padding:0 8px;box-sizing:border-box;' +
    `border:1px solid ${BORDER};border-radius:${RADIUS};background:transparent;color:${LABEL_PRIMARY};` +
    'font-size:13px;line-height:20px;outline:none'
  searchInput.addEventListener('input', () => { query = searchInput.value; render() })

  const emptyEl = document.createElement('div')
  emptyEl.textContent = deps.t('block.empty')
  emptyEl.style.cssText = `padding:0 8px;color:${LABEL_TERTIARY};font-size:12px;line-height:20px`

  const listEl = document.createElement('div')
  listEl.style.cssText = 'display:flex;flex-direction:column'

  root.append(header, searchInput, emptyEl, listEl)

  const rows = new Map<string, Row>()

  /**
   * The row whose menu is open, and the call that takes it down.
   *
   * One at a time for the whole section, which is what a menu is: opening a
   * second row's closes the first, and a press anywhere outside does too.
   */
  let openMenuRow: HTMLElement | undefined
  let closeMenu: (() => void) | undefined

  /** One session's row; its listeners are bound once, to this session's id. */
  const createRow = (id: string): Row => {
    const rowEl = document.createElement('div')
    rowEl.style.cssText = 'display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;box-sizing:border-box;' +
      `border-radius:${RADIUS};cursor:pointer;color:${LABEL_PRIMARY}`
    const mark = dshIcon('whaleTail', 16)
    mark.style.color = LABEL_TERTIARY
    mark.style.flex = 'none'
    const titleEl = document.createElement('span')
    titleEl.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px'
    // dsh's own gesture for a rename is a double-click on the row's title.
    titleEl.addEventListener('dblclick', (event) => {
      event.stopPropagation()
      event.preventDefault()
      deps.requestRename(id as SessionId, titleEl.textContent ?? id)
    })
    const place = document.createElement('span')
    place.style.cssText = PLACE_CSS
    place.style.color = LABEL_TERTIARY
    const toggle = iconButton('archive', deps.t('block.archiveOne'), () => { /* handled on pointerdown */ })
    toggle.style.opacity = '0'
    // pointerdown, so the action lands before any re-render the store's tick
    // would cause, and stopPropagation keeps it off the row's own action.
    toggle.addEventListener('pointerdown', (event) => {
      event.stopPropagation()
      const archivedNow = deps.modes.getSnapshot().archived.includes(id)
      void deps.modes.setArchived(id, !archivedNow)
    })

    const menuWrap = document.createElement('div')
    menuWrap.style.cssText = 'position:relative;display:inline-flex;flex:none'
    const menu = iconButton('more', deps.t('row.actions'), () => {
      if (openMenuRow === rowEl) { closeMenu?.(); return }
      closeMenu?.()
      menuPanel.style.display = 'block'
      const away = (event: PointerEvent): void => {
        if (event.target instanceof Node && menuPanel.contains(event.target)) return
        closeMenu?.()
      }
      document.addEventListener('pointerdown', away)
      openMenuRow = rowEl
      closeMenu = (): void => {
        document.removeEventListener('pointerdown', away)
        menuPanel.style.display = 'none'
        openMenuRow = undefined
        closeMenu = undefined
      }
    })
    menu.style.opacity = '0'
    const menuPanel = document.createElement('div')
    menuPanel.style.cssText = MENU_PANEL_CSS
    menuPanel.style.display = 'none'
    menuPanel.setAttribute('role', 'menu')
    const menuItem = (icon: DshIconName, label: string, onClick: () => void): HTMLButtonElement => {
      const item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      item.style.cssText = MENU_ITEM_CSS
      const artwork = dshIcon(icon, 14)
      artwork.style.flex = 'none'
      artwork.style.color = LABEL_TERTIARY
      const caption = document.createElement('span')
      caption.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      caption.textContent = label
      item.append(artwork, caption)
      item.addEventListener('mouseenter', () => { item.style.background = ROW_HOVER })
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent' })
      item.addEventListener('pointerdown', (event) => { event.stopPropagation() })
      item.addEventListener('click', (event) => { event.stopPropagation(); closeMenu?.(); onClick() })
      return item
    }
    const menuRename = menuItem('edit', deps.t('row.rename'), () => {
      deps.requestRename(id as SessionId, titleEl.textContent ?? id)
    })
    const menuArchive = menuItem('archive', deps.t('row.archive'), () => {
      const archivedNow = deps.modes.getSnapshot().archived.includes(id)
      void deps.modes.setArchived(id, !archivedNow)
    })
    menuPanel.append(menuRename, menuArchive)
    menuWrap.append(menu, menuPanel)

    rowEl.addEventListener('mouseenter', () => {
      rowEl.style.background = ROW_HOVER
      toggle.style.opacity = '1'
      menu.style.opacity = '1'
    })
    rowEl.addEventListener('mouseleave', () => {
      if (id !== deps.currentSession.get()) rowEl.style.background = 'transparent'
      toggle.style.opacity = '0'
      menu.style.opacity = '0'
    })
    rowEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      // A press that starts on one of the row's own controls belongs to that
      // control, wherever the button's own handlers sit in the propagation
      // order: opening the session is the row's action, never the archive's.
      const target = event.target
      if (target instanceof HTMLElement && target.closest('button') !== null) return
      deps.openSession(id as SessionId)
    })
    rowEl.append(mark, titleEl, place, toggle, menuWrap)
    return { root: rowEl, title: titleEl, place, toggle, menu, menuPanel, menuRename, menuArchive }
  }

  /** Whether dsh's sidebar is in its 36px rail state. */
  const isRail = (): boolean => (root.parentElement?.className ?? '').toString().includes('_collapsed')

  /** Hide one element outright, leaving the rest of the tree alone. */
  const hide = (element: Element | null): void => {
    if (element instanceof HTMLElement && element.style.display !== 'none') element.style.display = 'none'
  }

  /**
   * Isolate the terminal sessions from dsh's own tree.
   *
   * dsh groups a workspace's sessions inside one `groupSection`, together with
   * the "expand the remaining N sessions" affordance — so hiding the workspace
   * row alone leaves both the rows and that count behind (a reader sees
   * "其余 2 个会话" for sessions that are supposed to live elsewhere). Our own
   * workspaces therefore hide as a whole GROUP: the current root, any earlier
   * root under the harness home, and the recorded one. A user's workspace is
   * never hidden as a group — a terminal session that happens to live in one
   * hides only its own row.
   */
  const isolate = (): void => {
    const flag = deps.modes.getSnapshot()
    const items = deps.workspaces.list.getSnapshot().items
    const path = deps.modes.root()
    if (path.length > 0) {
      const match = items.find(item => item.path === path)
      if (match !== undefined && flag.workspaceId !== match.workspaceId) void deps.modes.useWorkspace(match.workspaceId)
    }
    const ours = new Set<string>()
    for (const item of items) {
      if (item.path === path || item.path.includes('/.dsh/')) ours.add(item.workspaceId)
    }
    if (flag.workspaceId !== undefined) ours.add(flag.workspaceId)
    for (const workspaceId of ours) {
      const row = document.querySelector(`[data-row-key="workspace:${workspaceId}"]`)
      const group = row?.closest('[class*="_groupSection"]') ?? row
      if (group !== null && group !== undefined) hide(group)
      // The group may not be mounted (a collapsed or virtualized region); the
      // overflow control carries its own key either way.
      hide(document.querySelector(`[data-row-key="overflow:${workspaceId}"]`))
    }
    for (const id of flag.sessions) hide(document.querySelector(`[data-row-key="session:${id}"]`))
  }

  /** Update every node in place; nothing is rebuilt that already exists. */
  const render = (): void => {
    // dsh's sidebar hides its rows in the rail state and shows icons instead;
    // a full section beside a 36px rail would be the loudest thing on screen.
    const rail = isRail()
    root.style.display = rail ? 'none' : 'flex'
    if (rail) return
    // The section's home follows its fold state: unfolded it sits under the
    // workspace list, folded it docks at the sidebar's foot.
    attach()

    // The pipe entry is not one of the list's tools: it survives the fold, and
    // it disappears only when no buffer service is behind the seat (a
    // composition without `dshell-buffer`, or the frames before it lands).
    const pipe = deps.pipe
    pipeButton.style.display = pipe === undefined || !pipe.available() ? 'none' : 'inline-flex'
    pipeButton.style.color = pipe?.getSnapshot().open === true ? LABEL_PRIMARY : LABEL_TERTIARY

    const list = deps.sessions.list.getSnapshot()
    const flag = deps.modes.getSnapshot()
    const folded = flag.folded
    const current = deps.currentSession.get()
    // The rows are OUR set of terminal sessions, not dsh's list: dsh hides the
    // sessions archived in its own registry, and our archive bit is a separate
    // thing, so a session archived there must still appear here. The summary is
    // used for its title and recency when the list happens to carry it.
    /**
     * The name one row shows.
     *
     * dsh's durable title first, because that is also where a rename by the
     * reader lands; then the name dshell recorded when it named the session,
     * which is what a session shows while dsh has not projected a title for it;
     * only then dsh's own display fallback, whose last resort is the bare id.
     * @param id - the session id.
     * @returns the name to show.
     */
    const titleOf = (id: string): string => {
      const summary = list.byId[id as SessionId]
      return summary?.title
        ?? flag.records.find(record => record.sessionId === id)?.title
        ?? summary?.displayTitle
        ?? id
    }
    /**
     * Where one session's shell runs, in the words the pill shows.
     *
     * Read from dshell-ssh's own bindings, so the answer is the same one the
     * pill on dsh's native row gives. A session that was never bound — or any
     * session in a composition without the ssh plugin — runs here.
     * @param id - the session id.
     * @returns the device's name, or the local label.
     */
    const placeOf = (id: string): string => {
      const snapshot = deps.devices?.snapshot()
      const binding = snapshot?.bindings.find(row => row.sessionId === id)
      const device = binding === undefined || snapshot === undefined
        ? undefined
        : snapshot.devices.find(row => row.id === binding.deviceId)
      return device?.name ?? deps.t('block.local')
    }
    const desired = [...flag.sessions]
      .filter(id => showArchived || !flag.archived.includes(id))
      .filter(id => query.length === 0 || titleOf(id).toLowerCase().includes(query.toLowerCase()))
      .sort((left, right) => (list.byId[right as SessionId]?.updatedAt ?? 0) - (list.byId[left as SessionId]?.updatedAt ?? 0))

    setIcon(foldButton, folded ? 'chevronUp' : 'chevronDown')
    labelEl.textContent = folded && desired.length > 0
      ? `${deps.t('block.section')} (${desired.length})`
      : deps.t('block.section')
    searchButton.style.display = folded ? 'none' : 'inline-flex'
    archiveButton.style.display = folded ? 'none' : 'inline-flex'
    archiveButton.style.color = showArchived ? LABEL_PRIMARY : LABEL_TERTIARY
    searchInput.style.display = !folded && searching ? 'block' : 'none'
    if (document.activeElement !== searchInput) searchInput.value = query

    if (folded) {
      for (const row of rows.values()) row.root.remove()
      rows.clear()
      emptyEl.style.display = 'none'
      isolate()
      return
    }

    const alive = new Set<string>()
    for (const id of desired) {
      alive.add(id)
      let row = rows.get(id)
      if (row === undefined) {
        row = createRow(id)
        rows.set(id, row)
      }
      row.title.textContent = titleOf(id)
      const place = placeOf(id)
      row.place.textContent = place
      row.place.title = deps.t('block.place', { place })
      const archived = flag.archived.includes(id)
      setIcon(row.toggle, archived ? 'unarchive' : 'archive')
      setIcon(row.menuArchive, archived ? 'unarchive' : 'archive')
      const archiveLabel = row.menuArchive.querySelector('span')
      if (archiveLabel !== null) archiveLabel.textContent = deps.t(archived ? 'row.unarchive' : 'row.archive')
      row.root.style.background = id === current ? ROW_HOVER : 'transparent'
      listEl.append(row.root)
    }
    for (const [id, row] of [...rows]) {
      if (alive.has(id)) continue
      // A menu hanging off a row that is going must not outlive it, or its
      // document listener would keep a removed node alive.
      if (openMenuRow === row.root) closeMenu?.()
      row.root.remove()
      rows.delete(id)
    }
    emptyEl.style.display = desired.length === 0 ? 'block' : 'none'
    isolate()
  }

  const attach = (): boolean => {
    const hole = document.querySelector(SIDEBAR_HOLE)
    const region = hole?.closest('[class*="_regionArea"]') ?? hole
    if (region === null || region === undefined) return false
    if (deps.modes.getSnapshot().folded) {
      // Docked at the foot: the last thing above the sidebar's own footer.
      const foot = document.querySelector('[class*="_footArea"]')
      const parent = foot?.parentElement ?? null
      if (foot !== null && parent !== null) {
        if (root.parentElement !== parent || foot.previousElementSibling !== root) parent.insertBefore(root, foot)
        return true
      }
    }
    if (root.previousElementSibling !== region) region.after(root)
    return true
  }

  const disposers = [
    deps.sessions.list.subscribe(render),
    deps.workspaces.list.subscribe(() => { render() }),
    deps.modes.subscribe(render),
    deps.currentSession.subscribe(render),
    // A binding made or dropped on the initialization page changes what the
    // pill says, and the ssh service republishes when it does.
    deps.devices?.subscribe(render) ?? (() => {}),
    // The pipe panel opened or closed — from this button, from the panel's own
    // close, or from a status card — and the entry button lights to match.
    deps.pipe?.subscribe(render) ?? (() => {}),
  ]
  attach()
  render()
  // Re-render only when something the section depends on actually moved: the
  // sidebar's rail state, or our own node falling out of the document.
  let lastRail: boolean | undefined
  const observer = new MutationObserver(() => {
    const rail = isRail()
    if (rail === lastRail && root.isConnected) return
    lastRail = rail
    if (!root.isConnected) attach()
    render()
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
  // Narrow and cheap: only an inserted session row can un-hide a terminal one,
  // so this watches insertions and touches nothing else.
  const rowObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue
        if (node.matches('[data-row-key]') || node.querySelector('[data-row-key]') !== null) {
          isolate()
          return
        }
      }
    }
  })
  rowObserver.observe(document.body, { childList: true, subtree: true })
  return () => {
    closeMenu?.()
    observer.disconnect()
    rowObserver.disconnect()
    for (const dispose of disposers) dispose()
    root.remove()
  }
}
