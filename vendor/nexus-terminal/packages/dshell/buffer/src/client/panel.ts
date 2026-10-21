/**
 * The pipe dialog: a proper centered modal for the whole pipe feature, with
 * two views over the same data.
 *
 * - 列表 — every established pipe as a row; clicking one opens its detail
 *   (the requests that travelled it and the grants they carry), and a form
 *   creates a new pipe.
 * - 图 — sessions as draggable nodes and pipes as edges, drawn with React
 *   Flow (`pipe-graph`); dragging from one node to another creates a pipe,
 *   and a selected edge offers detail and release. The nodes are the
 *   sessions the reader came for — those already on a pipe, plus this one —
 *   and a header toggle swaps that for every session in dsh when a brand new
 *   pair has to be wired here.
 *
 * The panel keeps its old seat (`shell.overlay`) and its `open` flag in the
 * service; only the shape changed. Only the user can create a pipe, and this
 * dialog is the only place that happens, so the authority note stays.
 */

import {
  createElement, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type ReactElement,
} from 'react'
import {
  FileTypeIcon, IconChevronLeftOutlineRegular, IconFolderCloseMedium, IconRefreshOutlineMedium, classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { BufferGrant, BufferLink, BufferTicket, BufferUserEntry } from '../protocol.js'
import type { DshellBufferKey } from './locales.js'
import type { BufferClientService, SessionSeat } from './service.js'
import { PipeGraph, type GraphSession } from './pipe-graph.js'

const backdropStyle: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 40,
  background: 'rgba(0,0,0,.44)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  pointerEvents: 'auto',
}
const dialogStyle: CSSProperties = {
  width: 'min(920px, 92vw)',
  height: 'min(620px, 86vh)',
  display: 'flex', flexDirection: 'column',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 14,
  background: 'var(--dsw-alias-bg-layer-2)',
  boxShadow: '0 18px 50px rgba(0,0,0,.34)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  overflow: 'hidden',
}
const headerStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
  borderBottom: '0.5px solid var(--dsw-alias-border-l4)',
  flex: '0 0 auto',
}
const titleStyle: CSSProperties = { fontWeight: 600, fontSize: 14 }
const headerDimStyle: CSSProperties = { fontSize: 12, opacity: 0.55, flex: '1 1 auto' }
const tabRowStyle: CSSProperties = { display: 'flex', gap: 2, background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 8, padding: 2 }
const tabStyle: (active: boolean) => CSSProperties = active => ({
  border: 'none', background: active ? 'var(--dsw-alias-bg-layer-1)' : 'transparent',
  color: 'var(--dsw-alias-label-primary)', opacity: active ? 1 : 0.62,
  cursor: 'pointer', fontSize: 12, padding: '4px 12px', borderRadius: 6,
})
const smallButtonStyle: CSSProperties = {
  border: '0.5px solid var(--dsw-alias-border-l4)', background: 'transparent', color: 'inherit',
  cursor: 'pointer', fontSize: 12, opacity: 0.82, padding: '3px 10px', borderRadius: 6, flex: '0 0 auto',
}
const primaryStyle: CSSProperties = {
  ...smallButtonStyle,
  border: 'none', background: 'var(--dsw-static-deepseek-500, #4f6bed)', color: '#fff',
  opacity: 1, padding: '5px 14px',
}
const bodyStyle: CSSProperties = { flex: '1 1 auto', overflowY: 'auto', padding: '14px 16px 18px' }
const sectionTitleStyle: CSSProperties = { fontSize: 12, fontWeight: 600, opacity: 0.6, marginBottom: 6, marginTop: 14 }
const cardStyle: CSSProperties = {
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-module-platform)',
  padding: '8px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
const growStyle: CSSProperties = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const dimStyle: CSSProperties = { opacity: 0.62, fontSize: 12 }
const subStyle: CSSProperties = { ...dimStyle, whiteSpace: 'pre-wrap', lineHeight: '17px' }
const fieldStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--dsw-alias-bg-layer-3)',
  border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 8, color: 'inherit',
  padding: '6px 8px', fontSize: 12, outline: 'none',
  // No `colorScheme` hint: a select's own widget and its OS-drawn option list
  // follow the document's scheme, which the app sets on <html> from the theme
  // preference. Pinning it to dark left a black control in a light panel.
}
const errorStyle: CSSProperties = {
  margin: '0 16px 12px', padding: '7px 10px', borderRadius: 8, fontSize: 12,
  color: 'var(--dsw-alias-state-error-primary, #f87171)',
  background: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(248,113,113,.1))',
  flex: '0 0 auto',
}
const emptyStyle: CSSProperties = { ...dimStyle, padding: '2px 0' }
const clickableRowStyle: CSSProperties = {
  ...rowStyle, cursor: 'pointer', borderRadius: 6, padding: '2px 4px', margin: '0 -4px',
}
const backRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }

/** Ticket-state identifier → dictionary key. The identifier stays a protocol value. */
const TICKET_STATE_KEY: Record<BufferTicket['state'], DshellBufferKey> = {
  queued: 'ticket.state.queued',
  running: 'ticket.state.running',
  done: 'ticket.state.done',
  failed: 'ticket.state.failed',
  timeout: 'ticket.state.timeout',
  cancelled: 'ticket.state.cancelled',
}

/** Build a short rights label over the bound translator. */
function makeRightsLabel(t: TranslateNS<'dshellBuffer'>): (rights: readonly string[]) => string {
  return (rights) => {
    const parts: string[] = []
    if (rights.includes('read')) parts.push(t('rights.read'))
    if (rights.includes('write')) parts.push(t('rights.write'))
    return parts.length > 0 ? parts.join('/') : t('rights.none')
  }
}

/** Minutes until a deadline, floored at zero. */
function minutesLeft(deadlineAt: number): number {
  return Math.max(0, Math.ceil((deadlineAt - Date.now()) / 60_000))
}

/** The panel's props: the pipe state plus the session labels it renders peers by. */
export type PipePanelProps = {
  readonly buffer: BufferClientService
  /** Absent in a composition that mounts no sessions service; ids are shown raw. */
  readonly sessions?: SessionSeat | undefined
} & PropsLocale<'dshellBuffer'>

/** One label for a session id (title, without the cwd suffix). */
function shortLabel(seat: SessionSeat | undefined, id: string): string {
  return seat?.getSnapshot().byId[id]?.displayTitle ?? id.slice(0, 8)
}

/** One label with the world it stands in, the way list rows render peers. */
function labelFor(
  t: TranslateNS<'dshellBuffer'>,
  seat: SessionSeat | undefined,
  worlds: Readonly<Record<string, string>>,
  id: string,
): string {
  const row = seat?.getSnapshot().byId[id]
  const title = row?.displayTitle ?? id.slice(0, 8)
  // A bound session's cwd is the host-side stand-in; the world map names the
  // device root it actually runs in, which is what a peer label should say.
  const where = worlds[id] ?? row?.cwd
  return where === undefined ? title : t('session.withCwd', { title, cwd: where })
}

/** Stable stand-ins so a composition without a sessions service still has hooks. */
const noSessionsSnapshot = (): undefined => undefined
const noSessionsSubscribe = (): (() => void) => () => {}

type View = 'list' | 'graph'

/** The pipe dialog component. */
export function PipePanel(props: PipePanelProps): ReactElement | null {
  const snapshot = useSyncExternalStore(props.buffer.subscribe, props.buffer.getSnapshot)
  const sessions = props.sessions
  const t = props.t
  const sessionState = useSyncExternalStore<ReturnType<SessionSeat['getSnapshot']> | undefined>(
    sessions === undefined ? noSessionsSubscribe : sessions.subscribe,
    sessions === undefined ? noSessionsSnapshot : sessions.getSnapshot,
  )
  const [view, setView] = useState<View>('list')
  const [detailLink, setDetailLink] = useState<string | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  // The graph opens on the sessions a reader came to see — the ones already
  // wired to something, plus this session — because every session in dsh is
  // dozens of nodes and none of them is the question. Wiring a NEW pair needs
  // the whole list, so the toggle is one click away.
  const [showAll, setShowAll] = useState(false)

  // Every hook sits above the early return: this seat renders null while
  // closed and content once opened, and a hook that first runs on the open
  // render would change the hook count between renders — the exact mistake
  // that once took the whole status card down (React #310).
  //
  // Closing does not unmount this component — the slot keeps the instance and
  // only drops its DOM — so the view state survives a close. Opening again
  // therefore starts from the top: a detail page (possibly of a pipe released
  // since) or a half-typed form must not be what the reader lands on.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (snapshot.open && !wasOpen.current) {
      setDetailLink(undefined)
      setCreating(false)
      setView('list')
    }
    wasOpen.current = snapshot.open
  }, [snapshot.open])

  const graphSessions: GraphSession[] = useMemo(() => {
    // A session dshell deleted is still in dsh's list until the next start, so
    // it is filtered here — its pipes are already gone, and a node without
    // edges would read as a peer that is merely idle.
    const gone = new Set(snapshot.departed)
    const piped = new Set(snapshot.links.flatMap(link => [link.a, link.b]))
    if (sessionState === undefined) {
      // Without a sessions seat the nodes are the ids the links name.
      const ids = [...new Set(snapshot.links.flatMap(link => [link.a, link.b]))]
      return ids.filter(id => !gone.has(id))
        .map(id => ({ id, label: id.slice(0, 8), sub: undefined, active: false, current: false }))
    }
    // The feature serves terminal sessions (see SessionSeat.terminals): a plain
    // conversation is not a node, so the graph cannot invite wiring one. An
    // archived session is put away for the same reason — except, either way,
    // one that already holds a pipe keeps its node, so the pipe does not lose
    // an end.
    const archived = new Set(sessionState.archived ?? [])
    const terminals = sessionState.terminals === undefined ? undefined : new Set(sessionState.terminals)
    const serves = (id: string): boolean => terminals === undefined || terminals.has(id)
    const current = sessionState.current === undefined ? undefined : String(sessionState.current)
    const ids = [...new Set([...sessionState.ids.map(String), ...snapshot.links.flatMap(link => [link.a, link.b])])]
    return ids
      .filter(id => !gone.has(id)
        && (!archived.has(id) || piped.has(id))
        && (piped.has(id) || (serves(id) && (showAll || id === current))))
      .map(id => {
        const row = sessionState.byId[id]
        return {
          id,
          label: row?.displayTitle ?? id.slice(0, 8),
          sub: snapshot.worlds[id] ?? row?.cwd,
          active: row?.running === true,
          current: id === current,
        }
      })
  }, [sessionState, snapshot.links, snapshot.departed, snapshot.worlds, showAll])

  if (!snapshot.open) return null

  const close = (): void => { props.buffer.setOpen(false) }
  const openDetail = (linkId: string): void => { setDetailLink(linkId); setView('list') }

  return createElement('div', {
    style: backdropStyle,
    'data-dshell-panel': 'buffer',
    onClick: (event: { target: unknown; currentTarget: unknown }) => {
      if (event.target === event.currentTarget) close()
    },
  },
    createElement('div', { style: dialogStyle, onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation() } },
      createElement('div', { style: headerStyle },
        createElement('span', { style: titleStyle }, t('panel.title')),
        createElement('span', { style: headerDimStyle },
          t('panel.summary', {
            links: snapshot.links.length,
            open: snapshot.tickets.filter(ticket => ticket.state === 'queued' || ticket.state === 'running').length,
          })),
        createElement('div', { style: tabRowStyle },
          createElement('button', { style: tabStyle(view === 'list'), onClick: () => { setView('list') } }, t('tab.list')),
          createElement('button', { style: tabStyle(view === 'graph'), onClick: () => { setView('graph') } }, t('tab.graph')),
        ),
        view === 'graph'
          ? createElement('button', {
            style: { ...smallButtonStyle, opacity: showAll ? 1 : 0.82 },
            'aria-pressed': showAll,
            title: showAll ? t('graph.hideUnrelated') : t('graph.showAllTitle'),
            onClick: () => { setShowAll(!showAll) },
          }, showAll ? t('graph.onlyRelated') : t('graph.showAll'))
          : null,
        createElement('button', { style: smallButtonStyle, title: t('panel.close'), onClick: close }, t('panel.close')),
      ),
      view === 'graph'
        ? createElement('div', { style: { flex: '1 1 auto', minHeight: 0, position: 'relative' } },
          createElement(PipeGraph, {
            t,
            sessions: graphSessions,
            links: snapshot.links,
            tickets: snapshot.tickets,
            onConnect: (a, b) => {
              if (snapshot.links.some(link => (link.a === a && link.b === b) || (link.a === b && link.b === a))) return
              void props.buffer.link(a, b).catch(() => {})
            },
            onUnlink: linkId => { void props.buffer.unlink(linkId).catch(() => {}) },
            onOpenDetail: openDetail,
          }),
        )
        : detailLink === undefined
          ? createElement(ListPane, {
            snapshot, sessions, sessionState, t,
            creating, setCreating,
            onOpenDetail: openDetail,
            buffer: props.buffer,
          })
          : createElement(DetailPane, {
            snapshot, sessions, t,
            linkId: detailLink,
            onBack: () => { setDetailLink(undefined) },
            buffer: props.buffer,
          }),
      snapshot.error === undefined ? null : createElement('div', {
        style: errorStyle,
        onClick: () => { props.buffer.clearError() },
        title: t('error.clear'),
      }, snapshot.error),
    ),
  )
}

/** Props shared by the two list-side panes. */
interface ListSideProps {
  readonly snapshot: ReturnType<BufferClientService['getSnapshot']>
  readonly buffer: BufferClientService
  readonly sessions?: SessionSeat | undefined
  readonly t: TranslateNS<'dshellBuffer'>
}

/** The list view: established pipes (click → detail), the create form. */
function ListPane(props: ListSideProps & {
  readonly sessionState: ReturnType<SessionSeat['getSnapshot']> | undefined
  readonly creating: boolean
  readonly setCreating: (next: boolean) => void
  readonly onOpenDetail: (linkId: string) => void
}): ReactElement {
  const { snapshot, sessions, sessionState, t } = props
  const [left, setLeft] = useState('')
  const [right, setRight] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const seat = sessions
  // A deleted session is still in dsh's list until the next start, but nothing
  // may be piped to it any more, so it is not offered as an endpoint either.
  // Neither is an archived one (put away), nor one this feature does not serve
  // at all: a pipe joins dshell's terminal sessions, and offering a plain
  // conversation would be an offer the rest of dshell cannot keep.
  const gone = new Set(snapshot.departed)
  const archived = new Set(sessionState?.archived ?? [])
  const terminals = sessionState?.terminals === undefined ? undefined : new Set(sessionState.terminals)
  const sessionIds = sessionState === undefined
    ? []
    : sessionState.ids.map(String).filter(id => !gone.has(id) && !archived.has(id)
      && (terminals === undefined || terminals.has(id)))

  // Seed the two pickers once the list is known: the current session on the
  // left, the first other session on the right. Never overwrites a choice.
  useEffect(() => {
    if (sessionState === undefined) return
    const current = sessionState.current === undefined ? undefined : String(sessionState.current)
    if (left === '' && current !== undefined && sessionIds.includes(current)) {
      setLeft(current)
    }
    if (right === '') {
      const other = sessionIds.find(id => id !== current)
      if (other !== undefined) setRight(other)
    }
  }, [sessionState, sessionIds, left, right])

  // A pick is re-checked against the current list rather than trusted from the
  // state that seeded it: a session can be deleted while this form is open, and
  // its picker value would otherwise outlive the option and still submit — the
  // orphan edge this panel's filtering exists to prevent.
  const picksValid = sessionIds.includes(left) && sessionIds.includes(right) && left !== right

  const create = (): void => {
    if (!picksValid) return
    void props.buffer.link(left, right, label, description).then(() => {
      setLabel('')
      setDescription('')
      props.setCreating(false)
    }).catch(() => {})
  }

  return createElement('div', { style: bodyStyle },
    createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 } },
      createElement('div', { style: { ...sectionTitleStyle, marginTop: 0, marginBottom: 0 } },
        t('links.heading', { count: snapshot.links.length })),
      createElement('button', {
        style: props.creating ? smallButtonStyle : primaryStyle,
        onClick: () => { props.setCreating(!props.creating) },
      }, props.creating ? t('links.collapse') : t('links.create')),
    ),
    props.creating ? createElement('div', { style: cardStyle },
      sessionIds.length === 0
        ? createElement('div', { style: emptyStyle }, t('form.noTerminals'))
        : createElement('div', { style: rowStyle },
          sessionSelect(left, setLeft, sessionIds, id => labelFor(t, seat, snapshot.worlds, id)),
          createElement('span', { style: dimStyle }, '↔'),
          sessionSelect(right, setRight, sessionIds, id => labelFor(t, seat, snapshot.worlds, id)),
        ),
      createElement('input', {
        style: fieldStyle,
        placeholder: t('form.labelPlaceholder'),
        value: label,
        onChange: (event: { target: { value: string } }) => { setLabel(event.target.value) },
      }),
      createElement('input', {
        style: fieldStyle,
        placeholder: t('form.descriptionPlaceholder'),
        value: description,
        onChange: (event: { target: { value: string } }) => { setDescription(event.target.value) },
      }),
      createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
        createElement('div', { style: dimStyle }, t('form.authorityNote')),
        createElement('button', {
          style: primaryStyle,
          disabled: !picksValid,
          onClick: create,
        }, t('form.submit')),
      ),
    ) : null,
    snapshot.links.length === 0
      ? createElement('div', { style: { ...emptyStyle, marginTop: 12 } },
        props.creating ? '' : t('links.empty'))
      : createElement('div', { style: cardStyle },
        snapshot.links.map(link => {
          const open = openCountOf(snapshot.tickets, link.id)
          return createElement('div', {
            key: link.id,
            style: clickableRowStyle,
            title: t('links.rowTitle'),
            onClick: () => { props.onOpenDetail(link.id) },
          },
            createElement('span', { style: { ...growStyle, fontWeight: 500 } },
              `${labelFor(t, seat, snapshot.worlds, link.a)} ↔ ${labelFor(t, seat, snapshot.worlds, link.b)}`
              + (link.label === undefined ? '' : ` · ${link.label}`)),
            link.description === undefined ? null : createElement('span', {
              style: { ...dimStyle, flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              title: link.description,
            }, link.description),
            open > 0 ? createElement('span', { style: dimStyle }, t('links.open', { count: open })) : null,
            createElement('button', {
              style: smallButtonStyle,
              onClick: (event: { stopPropagation: () => void }) => {
                event.stopPropagation()
                void props.buffer.unlink(link.id).catch(() => {})
              },
            }, t('action.release')),
          )
        })),
  )
}

/** The detail view for one pipe: its tickets, live grants between the pair. */
function DetailPane(props: ListSideProps & {
  readonly linkId: string
  readonly onBack: () => void
}): ReactElement {
  const { snapshot, sessions, t } = props
  const link = snapshot.links.find(candidate => candidate.id === props.linkId)
  if (link === undefined) {
    return createElement('div', { style: bodyStyle },
      createElement('div', { style: backRowStyle },
        createElement('button', { style: smallButtonStyle, onClick: props.onBack }, t('action.back'))),
      createElement('div', { style: emptyStyle }, t('detail.gone')))
  }
  const seats = new Set([link.a, link.b])
  const tickets = snapshot.tickets.filter(ticket => ticket.linkId === link.id)
  const open = tickets.filter(ticket => ticket.state === 'queued' || ticket.state === 'running')
  const settled = tickets.filter(ticket => ticket.state !== 'queued' && ticket.state !== 'running').reverse()
  const grants = snapshot.grants.filter(grant => grant.revokedAt === undefined && (seats.has(grant.from) && seats.has(grant.to)))

  return createElement('div', { style: bodyStyle },
    createElement('div', { style: backRowStyle },
      createElement('button', { style: smallButtonStyle, onClick: props.onBack }, t('action.back')),
      createElement('span', { style: { fontWeight: 600 } },
        `${labelFor(t, sessions, snapshot.worlds, link.a)} ↔ ${labelFor(t, sessions, snapshot.worlds, link.b)}`),
      link.label === undefined ? null : createElement('span', { style: dimStyle }, link.label),
      createElement('span', { style: { flex: '1 1 auto' } }),
      createElement('button', {
        style: smallButtonStyle,
        onClick: () => { void props.buffer.unlink(link.id).catch(() => {}) },
      }, t('action.releasePipe')),
    ),
    createElement(PipeNote, { link, sessions, buffer: props.buffer, t }),
    createElement(BufferBrowser, { buffer: props.buffer, linkId: link.id, sessions, t }),
    createElement('div', { style: sectionTitleStyle }, t('detail.activeRequests', { count: open.length })),
    open.length === 0
      ? createElement('div', { style: emptyStyle }, t('detail.noActiveRequests'))
      : createElement('div', { style: cardStyle }, open.map(ticket => ticketRow(ticket, props.buffer, sessions, true, t))),
    settled.length === 0 ? null : createElement('div', null,
      createElement('div', { style: sectionTitleStyle }, t('detail.settled', { count: settled.length })),
      createElement('div', { style: cardStyle }, settled.map(ticket => ticketRow(ticket, props.buffer, sessions, false, t)))),
    createElement('div', { style: sectionTitleStyle }, t('detail.grants', { count: grants.length })),
    grants.length === 0
      ? createElement('div', { style: emptyStyle }, t('detail.noGrants'))
      : createElement('div', { style: cardStyle }, grants.map(grant => grantRow(grant, sessions, t))),
  )
}

/** Count a link's unsettled tickets. */
function openCountOf(tickets: readonly BufferTicket[], linkId: string): number {
  return tickets.filter(ticket => ticket.linkId === linkId
    && (ticket.state === 'queued' || ticket.state === 'running')).length
}

/**
 * The pipe's name and purpose, editable in place.
 *
 * Both ends write this text — the peer's agent through `action="describe"` —
 * so the editor is seeded from the link but never clobbers a draft being typed:
 * a local draft wins while it exists and is dropped after a save, which lets
 * the panel's poll refresh the text whenever nobody is editing. When an agent
 * wrote it, it says so: a peer's words must not read as the reader's own.
 */
function PipeNote(props: {
  readonly link: BufferLink
  readonly sessions?: SessionSeat | undefined
  readonly buffer: BufferClientService
  readonly t: TranslateNS<'dshellBuffer'>
}): ReactElement {
  const { link, t } = props
  const [draft, setDraft] = useState<{ label: string; description: string } | undefined>(undefined)
  const shown = draft ?? { label: link.label ?? '', description: link.description ?? '' }
  const save = (): void => {
    void props.buffer.annotate(link.id, shown.label, shown.description)
      .then(() => { setDraft(undefined) })
      .catch(() => {})
  }
  return createElement('div', { style: { ...cardStyle, marginBottom: 12 } },
    createElement('div', { style: rowStyle },
      createElement('span', { style: { ...dimStyle, flex: '0 0 auto' } }, t('detail.nameLabel')),
      createElement('input', {
        style: { ...fieldStyle, flex: '1 1 auto' },
        placeholder: t('detail.namePlaceholder'),
        value: shown.label,
        'data-dshell-pipe-note': 'label',
        onChange: (event: { target: { value: string } }) => { setDraft({ ...shown, label: event.target.value }) },
      }),
      createElement('button', {
        style: primaryStyle,
        'data-dshell-pipe-note': 'save',
        onClick: save,
      }, t('detail.noteSave')),
    ),
    createElement('input', {
      style: fieldStyle,
      placeholder: t('detail.purposePlaceholder'),
      value: shown.description,
      'data-dshell-pipe-note': 'description',
      onChange: (event: { target: { value: string } }) => { setDraft({ ...shown, description: event.target.value }) },
      onKeyDown: (event: { key: string }) => { if (event.key === 'Enter') save() },
    }),
    link.annotatedBy === undefined ? null : createElement('span', { style: dimStyle, 'data-dshell-pipe-note': 'by' },
      t('detail.noteBy', { who: shortLabel(props.sessions, link.annotatedBy) })),
  )
}

/** One `<select>` of session ids. */
function sessionSelect(
  value: string,
  onChange: (next: string) => void,
  ids: readonly string[],
  label: (id: string) => string,
): ReactElement {
  return createElement('select', {
    style: fieldStyle,
    value,
    onChange: (event: { target: { value: string } }) => { onChange(event.target.value) },
  }, ids.map(id => createElement('option', { key: id, value: id }, label(id))))
}

/** One ticket row; `cancellable` adds the withdraw button. */
function ticketRow(
  ticket: BufferTicket,
  buffer: BufferClientService,
  sessions: SessionSeat | undefined,
  cancellable: boolean,
  t: TranslateNS<'dshellBuffer'>,
): ReactElement {
  const tail = ticket.result ?? ticket.error ?? ticket.reports[ticket.reports.length - 1]?.text
  const unsettled = ticket.state === 'queued' || ticket.state === 'running'
  return createElement('div', { key: ticket.id, style: { ...rowStyle, alignItems: 'flex-start' } },
    createElement('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
      createElement('span', { style: growStyle },
        `${t(TICKET_STATE_KEY[ticket.state])} · ${shortLabel(sessions, ticket.from)} → ${shortLabel(sessions, ticket.to)} · ${ticket.subject}`),
      unsettled
        ? createElement('span', { style: dimStyle }, t('ticket.expires', { minutes: minutesLeft(ticket.deadlineAt), id: ticket.id }))
        : createElement('span', { style: dimStyle }, ticket.id),
      tail === undefined ? null : createElement('span', { style: subStyle }, tail),
    ),
    cancellable
      ? createElement('button', {
        style: smallButtonStyle,
        onClick: () => { void buffer.cancel(ticket.id).catch(() => {}) },
      }, t('action.cancel'))
      : null,
  )
}

/** One live grant with its revoke button. */
function grantRow(grant: BufferGrant, sessions: SessionSeat | undefined, t: TranslateNS<'dshellBuffer'>): ReactElement {
  const rightsLabel = makeRightsLabel(t)
  return createElement('div', { key: grant.id, style: { ...rowStyle, alignItems: 'flex-start' } },
    createElement('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
      createElement('span', { style: growStyle }, `${shortLabel(sessions, grant.from)} → ${shortLabel(sessions, grant.to)} · ${t('grant.remaining', { count: grant.count })}`),
      grant.description.trim().length === 0 ? null : createElement('span', { style: subStyle }, grant.description),
      ...grant.areas.map((area, index) => createElement('span', {
        key: `${grant.id}:${String(index)}`,
        style: dimStyle,
      }, area.as === undefined
        ? t('grant.areaUnmapped', { path: area.path, rights: rightsLabel(area.rights) })
        : t('grant.areaMapped', { as: area.as, path: area.path, rights: rightsLabel(area.rights) }))),
    ),
  )
}

// --------------------------------------------------------------------------
// The buffer browser: the pipe detail page's view over the namespace.

/** Where in the namespace the browser currently stands. */
interface BrowserLocation {
  /** The mapped root descended into; absent means standing at `/`. */
  readonly root: BufferUserEntry | undefined
  /** Directory below that root, area-relative; empty means the root itself. */
  readonly rel: string
  readonly entries: readonly BufferUserEntry[]
  readonly truncated: boolean
  /** The real path the server listed, shown as provenance once inside. */
  readonly realPath: string | undefined
}

/**
 * The browser draws its walk the way the file navigator does — a quiet row of
 * controls and a crumb strip over plain rows on the background — because that
 * is the list the reader already knows: the same 13px rows, the same 16px file
 * and folder icons, the same hover highlight, the same `..` row for going up.
 * Two lists over different worlds should not ask for two different habits.
 */
const browserNavStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 2, padding: '0 0 2px', minWidth: 0,
}
const navButtonStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto',
  border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
  padding: 3, borderRadius: 5, opacity: 0.8,
}
const navButtonOffStyle: CSSProperties = { ...navButtonStyle, opacity: 0.28, cursor: 'default' }
/** The crumb strip: one line, scrolled rather than wrapped when it runs long. */
const crumbStripStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', flex: '1 1 auto', minWidth: 0,
  overflowX: 'auto', whiteSpace: 'nowrap', fontSize: 12, scrollbarWidth: 'none',
}
const crumbStyle: CSSProperties = {
  flex: '0 0 auto', border: 'none', background: 'transparent', color: 'inherit',
  cursor: 'pointer', font: 'inherit', fontSize: 12, padding: '1px 3px',
  borderRadius: 4, opacity: 0.72,
}
const crumbCurrentStyle: CSSProperties = {
  ...crumbStyle, opacity: 1, cursor: 'default', fontWeight: 600,
}
const crumbSeparatorStyle: CSSProperties = { flex: '0 0 auto', opacity: 0.4, margin: '0 1px' }
const browserListStyle: CSSProperties = { listStyle: 'none', margin: 0, padding: 0 }
const browserRowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, width: '100%', boxSizing: 'border-box',
  // No `background` here on purpose: the resting colour and the hover highlight
  // both live in `injectBrowserCss`, because an inline declaration would win
  // over its `:hover` rule and leave the highlight painted but invisible.
  border: 'none', color: 'inherit', cursor: 'pointer',
  textAlign: 'left', font: 'inherit', fontSize: 13, padding: '4px 8px',
  // The file navigator's rows are 28px because its name sits in the sidebar's
  // 20px line box; the dialog's own line box is shorter, so the same padding
  // gives a 24px row. Matching the measure keeps the two lists feeling alike.
  lineHeight: '20px',
}
/** A row the reader cannot act on: the same shape, no pointer affordance. */
const browserIdleRowStyle: CSSProperties = { ...browserRowStyle, cursor: 'default' }
const rowIconStyle: CSSProperties = { flex: '0 0 auto', display: 'flex' }
const rowNameStyle: CSSProperties = {
  flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
/** The `..` row: the same shape as a folder row, monospaced so it reads as a token. */
const parentNameStyle: CSSProperties = {
  ...rowNameStyle, fontFamily: 'monospace', letterSpacing: 1, opacity: 0.85,
}
const rowMetaStyle: CSSProperties = {
  ...dimStyle, flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
  whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
}
const sizeStyle: CSSProperties = { ...rowMetaStyle, flex: '0 0 auto' }
/** Notes line up under the names, not under the icons. */
const noteStyle: CSSProperties = { padding: '3px 10px 4px 30px', fontSize: 12, opacity: 0.5 }
const browserErrorStyle: CSSProperties = {
  padding: '3px 10px 4px 30px', fontSize: 12, color: '#f87171',
}

/**
 * Row-hover treatment, the same one the file navigator installs: inline styles
 * cannot express `:hover`, and a highlighted row is most of what tells a
 * reader which line the pointer is on. Scoped to this browser's own data
 * attributes, so it cannot affect stock chrome.
 */
function injectBrowserCss(): () => void {
  const style = document.createElement('style')
  style.dataset.dshell = 'buffer-browser'
  style.textContent = [
    '[data-dshell-buffer-row] { background: transparent; }',
    '[data-dshell-buffer-row]:hover { background: rgba(127,127,127,.09); border-radius: 6px; }',
    '[data-dshell-buffer-crumbs]::-webkit-scrollbar { display: none; }',
  ].join('\n')
  document.head.appendChild(style)
  return () => { style.remove() }
}

/**
 * Walk the pipe's buffer namespace: at `/` the mapped roots (with rights and
 * origin), below one root its directories, as the same view the two agents'
 * `ls` answers from. Read-only: the browser is for looking, every mutation
 * stays a tool call.
 */
function BufferBrowser(props: {
  readonly buffer: BufferClientService
  readonly linkId: string
  readonly sessions?: SessionSeat | undefined
  readonly t: TranslateNS<'dshellBuffer'>
}): ReactElement {
  const t = props.t
  const rightsLabel = makeRightsLabel(t)
  const [location, setLocation] = useState<BrowserLocation | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  // Races one-liner: only the newest request may land, so a slow deep listing
  // cannot overwrite the view the user has since navigated away from.
  const seq = useRef(0)
  // The one treatment inline styles cannot carry (see injectBrowserCss).
  useEffect(() => injectBrowserCss(), [])

  useEffect(() => {
    // A new pipe's detail starts at `/`; the old view must not leak through.
    const mine = ++seq.current
    setLocation(undefined)
    setError(undefined)
    setLoading(true)
    props.buffer.listBuffer(props.linkId).then(listing => {
      if (seq.current !== mine) return
      setLocation({ root: undefined, rel: '', entries: listing.entries, truncated: listing.truncated, realPath: '/' })
    }).catch(reason => {
      if (seq.current !== mine) return
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (seq.current === mine) setLoading(false)
    })
  }, [props.buffer, props.linkId])

  /** List one directory below a mapped root. */
  const open = (root: BufferUserEntry, rel: string): void => {
    const mine = ++seq.current
    setLoading(true)
    setError(undefined)
    props.buffer.listBuffer(props.linkId, root.grantId, rel === '' ? '.' : rel).then(listing => {
      if (seq.current !== mine) return
      setLocation({ root, rel, entries: listing.entries, truncated: listing.truncated, realPath: listing.path })
    }).catch(reason => {
      if (seq.current !== mine) return
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (seq.current === mine) setLoading(false)
    })
  }

  const back = (): void => {
    const current = location
    if (current === undefined || current.root === undefined) return
    if (current.rel === '') {
      const mine = ++seq.current
      setLoading(true)
      props.buffer.listBuffer(props.linkId).then(listing => {
        if (seq.current !== mine) return
        setLocation({ root: undefined, rel: '', entries: listing.entries, truncated: listing.truncated, realPath: '/' })
      }).catch(() => {}).finally(() => { if (seq.current === mine) setLoading(false) })
      return
    }
    open(current.root, current.rel.split('/').slice(0, -1).join(''))
  }

  const refresh = (): void => {
    const current = location
    if (current === undefined) return
    if (current.root === undefined) {
      const mine = ++seq.current
      setLoading(true)
      props.buffer.listBuffer(props.linkId).then(listing => {
        if (seq.current !== mine) return
        setLocation({ root: undefined, rel: '', entries: listing.entries, truncated: listing.truncated, realPath: '/' })
      }).catch(reason => {
        if (seq.current !== mine) return
        setError(reason instanceof Error ? reason.message : String(reason))
      }).finally(() => { if (seq.current === mine) setLoading(false) })
    } else {
      open(current.root, current.rel)
    }
  }

  const root = location?.root
  const relSegments = location === undefined || location.rel === '' ? [] : location.rel.split('/')
  const atNamespaceRoot = root === undefined
  /** Jump to one crumb's directory: `/`, a mapped root, or a directory below it. */
  const goto = (target: BufferUserEntry, rel: string): void => {
    if (target.grantId === undefined) return
    open(target, rel)
  }
  // The crumbs read like the file list's: the namespace root is itself a `/`,
  // so the separator starts after it rather than doubling it.
  const crumbs: ReactElement[] = [    createElement('button', {
      key: '__root__', type: 'button', style: atNamespaceRoot ? crumbCurrentStyle : crumbStyle,
      disabled: atNamespaceRoot, title: t('browser.rootTitle'), 'data-dshell-buffer-crumb': 'namespace',
      onClick: () => { back() },
    }, '/'),
  ]
  if (root !== undefined) {
    crumbs.push(createElement('button', {
      key: '__area__', type: 'button', style: relSegments.length === 0 ? crumbCurrentStyle : crumbStyle,
      disabled: relSegments.length === 0, title: root.origin ?? root.name, 'data-dshell-buffer-crumb': 'area',
      onClick: () => { goto(root, '') },
    }, root.name))
    relSegments.forEach((segment, index) => {
      const last = index === relSegments.length - 1
      const rel = relSegments.slice(0, index + 1).join('/')
      crumbs.push(createElement('span', { key: `sep:${rel}`, style: crumbSeparatorStyle }, '/'))
      crumbs.push(createElement('button', {
        key: rel, type: 'button', style: last ? crumbCurrentStyle : crumbStyle,
        disabled: last, title: rel, 'data-dshell-buffer-crumb': last ? 'current' : 'ancestor',
        onClick: () => { goto(root, rel) },
      }, segment))
    })
  }

  return createElement('div', null,
    createElement('div', { style: sectionTitleStyle }, t('browser.heading')),
    createElement('div', null,
      createElement('div', { style: browserNavStyle },
        createElement('button', {
          type: 'button',
          style: atNamespaceRoot || loading ? navButtonOffStyle : navButtonStyle,
          disabled: atNamespaceRoot || loading,
          title: atNamespaceRoot ? t('browser.atRoot') : t('browser.up'),
          'data-dshell-buffer-nav': 'up',
          onClick: back,
        }, createElement(IconChevronLeftOutlineRegular, { size: 14 })),
        createElement('button', {
          type: 'button',
          style: loading ? navButtonOffStyle : navButtonStyle,
          disabled: loading,
          title: t('browser.refresh'),
          'data-dshell-buffer-nav': 'refresh',
          onClick: refresh,
        }, createElement(IconRefreshOutlineMedium, { size: 16 })),
        createElement('div', {
          style: crumbStripStyle,
          'data-dshell-buffer-crumbs': '',
          // The real path is provenance, not navigation: it is what the two
          // agents' own `ls` answers, and it belongs on hover rather than
          // taking a line of its own.
          title: location?.realPath ?? '/',
        }, crumbs),
      ),
      error === undefined ? null : createElement('div', { style: browserErrorStyle, 'data-dshell-buffer-note': 'error' }, error),
      loading && location === undefined ? createElement('div', { style: noteStyle, 'data-dshell-buffer-note': 'loading' }, t('browser.loading')) : null,
      !loading && location === undefined && error === undefined
        ? createElement('div', { style: noteStyle, 'data-dshell-buffer-note': 'empty' },
          t('browser.empty'))
        : null,
      location === undefined ? null : createElement('ul', { style: browserListStyle },
        ...(atNamespaceRoot ? [] : [createElement('li', { key: '__up__', style: browserListStyle },
          createElement('button', {
            type: 'button', style: browserRowStyle, 'data-dshell-buffer-row': 'parent',
            'data-dshell-buffer-entry': 'parent', title: t('browser.up'),
            onClick: back, onDoubleClick: back,
          },
            createElement('span', { style: rowIconStyle }, createElement(IconFolderCloseMedium, { size: 16 })),
            createElement('span', { style: parentNameStyle }, '..'),
          ),
        )]),
        ...location.entries.map(entry => {
          const isRoot = entry.grantId !== undefined
          const childRel = location.rel === '' ? entry.name : `${location.rel}/${entry.name}`
          const enterable = isRoot || entry.kind === 'directory'
          const meta = isRoot
            ? `← ${entry.origin ?? ''} · ${rightsLabel(entry.rights ?? [])} · ${shortLabel(props.sessions, entry.from ?? '')} → ${shortLabel(props.sessions, entry.to ?? '')}`
            : entry.size === undefined ? undefined : fmtSize(entry.size)
          return createElement('li', {
            key: `${entry.grantId ?? ''}:${entry.name}`,
            style: browserListStyle,
            'data-dshell-buffer-entry': isRoot ? 'area' : entry.kind,
          },
            createElement('button', {
              type: 'button',
              style: enterable ? browserRowStyle : entry.kind === 'other' ? { ...browserIdleRowStyle, opacity: 0.5 } : browserIdleRowStyle,
              'data-dshell-buffer-row': isRoot ? 'area' : entry.kind,
              title: isRoot
                ? t('browser.areaTitle', { name: entry.name, origin: entry.origin ?? '', rights: rightsLabel(entry.rights ?? []) })
                : entry.name,
              ...enterable
                ? {
                  onClick: () => { if (isRoot) open(entry, ''); else if (root !== undefined) open(root, childRel) },
                  // The file list enters a directory on a double click; here a
                  // single click already does, so both gestures land the same way.
                  onDoubleClick: () => { if (isRoot) open(entry, ''); else if (root !== undefined) open(root, childRel) },
                }
                : {},
            },
              // 'other' is the one kind the file navigator draws without an
              // icon too: it is neither a directory nor a file to open.
              entry.kind === 'other' && !isRoot
                ? null
                : createElement('span', { style: rowIconStyle },
                  isRoot || entry.kind === 'directory'
                    ? createElement(IconFolderCloseMedium, { size: 16 })
                    : createElement(FileTypeIcon, { kind: classifyFileType(entry.name), size: 16 })),
              createElement('span', { style: rowNameStyle }, entry.name),
              meta === undefined ? null : createElement('span', { style: isRoot ? rowMetaStyle : sizeStyle }, meta),
            ),
          )
        }),
        location.entries.length === 0
          ? createElement('li', { style: noteStyle, 'data-dshell-buffer-note': 'empty-dir' }, t('browser.emptyDir'))
          : null,
        location.truncated
          ? createElement('li', { style: noteStyle, 'data-dshell-buffer-note': 'truncated' }, t('browser.truncated'))
          : null,
      ),
    ),
  )
}

/** One compact byte count for the browser's file rows. */
function fmtSize(size: number): string {
  if (size < 1024) return `${String(size)} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}
