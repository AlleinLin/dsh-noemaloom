/**
 * dshell-buffer browser face: the pipe panel in the frame-wide overlay seat,
 * and the `dshellBuffer` service other client bundles open it through.
 *
 * The panel enters `shell.overlay` — the additive, click-through frame layer —
 * rather than replacing anything, so a composition that omits this package
 * simply has one fewer floating surface. The entry that opens it lives in
 * dshell-mode's terminal section header and reaches the service by injection,
 * which is the only collaboration path between client bundles.
 */

import { type Context } from '@deepseek-ai/cordis'
import { mainSessionId } from '@nexus-aethra/dshell-std'
// Type-only: pulls the renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-layout's SlotMap merge (the `shell.overlay` seat).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the locale service merge (ctx.locale) and this namespace's keys.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { en, zh } from './locales.js'
import { PipePanel } from './panel.js'
import { BufferClientService, type SessionSeat } from './service.js'

export const name = '@nexus-aethra/dshell-buffer/client'

export const inject = ['slots', 'locale'] as const

/** This package's copy namespace. */
const NS = 'dshellBuffer'

export type { BufferSnapshot, SessionSeat } from './service.js'
export type { PipePanelProps } from './panel.js'

/** A permanently empty list, for the frames before the sessions service arrives. */
const EMPTY_SESSIONS: ReturnType<SessionSeat['getSnapshot']> = { ids: [], byId: {}, current: undefined, archived: [] }

export function apply(ctx: Context): void {
  const t: TranslateNS<'dshellBuffer'> = ctx.locale.bind(NS)
  const buffer = new BufferClientService(ctx)
  void buffer.load()

  // The dictionaries are registered through an effect so a composition that
  // unloads this plugin takes its copy with it.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dshell-buffer: dictionaries')

  // The sessions service may be provided by a sibling row that activates after
  // this one, so it is resolved by injection rather than read once at apply
  // time. The seat is a stable facade over a mutable holder: the panel's props
  // never change identity, and the panel re-renders on whatever the live store
  // publishes.
  let sessions: ISessions | undefined
  ctx.inject(['sessions'], (sessionCtx) => {
    sessions = sessionCtx.get('sessions') as unknown as ISessions
  })
  /**
   * The workspace registry's client face, read structurally: it is where dsh
   * keeps its own archive set, and a composition without it archives nothing.
   */
  const workspaceRegistry = (): {
    list: {
      getSnapshot(): { readonly archivedSessionIds: readonly string[] }
      subscribe(listener: () => void): () => void
    }
  } | undefined => ctx.get('workspaces') as unknown as
    { list: { getSnapshot(): { readonly archivedSessionIds: readonly string[] }, subscribe(l: () => void): () => void } } | undefined
  /**
   * dshell's terminal-mode registry, also read structurally.
   *
   * It carries dshell's OWN archive bit — the 归档 the terminal section toggles,
   * which is a different thing from dsh's archive set above and the one most
   * terminal sessions are put away with. A pipe panel that honoured only one of
   * the two would still be cluttered by the other.
   */
  const terminalModes = (): {
    getSnapshot(): { readonly archived: readonly string[]; readonly sessions: readonly string[] }
    subscribe(listener: () => void): () => void
  } | undefined => ctx.get('dshellTerminalMode') as unknown as
    { getSnapshot(): { readonly archived: readonly string[]; readonly sessions: readonly string[] }, subscribe(l: () => void): () => void } | undefined

  /**
   * The slice built for the sources it was built from.
   *
   * A React store compares snapshots by identity, so the slice is cached against
   * the source snapshots rather than rebuilt per read: a fresh object every call
   * is an infinite render loop, not a slower one. Three stores feed it, so all
   * three references are the cache key.
   */
  let slicedFrom: readonly unknown[] | undefined
  let sliced: ReturnType<SessionSeat['getSnapshot']> = EMPTY_SESSIONS
  const sessionsSeat: SessionSeat = {
    // Built rather than forwarded: the seat is dshell's own slice of the list,
    // and the host's snapshot stopped carrying `current` in 0.1.6-alpha.2 —
    // which Session is on screen is a RETENTION count now (`mainSessionId`).
    getSnapshot: () => {
      const list = sessions?.list.getSnapshot()
      if (list === undefined) return EMPTY_SESSIONS
      // Read per call rather than captured: either registry may register after
      // this row, and a composition without one simply archives nothing.
      const archived = workspaceRegistry()?.list.getSnapshot().archivedSessionIds
      const modeSnapshot = terminalModes()?.getSnapshot()
      const ownArchived = modeSnapshot?.archived
      const terminals = modeSnapshot?.sessions
      if (slicedFrom !== undefined
        && slicedFrom[0] === list && slicedFrom[1] === archived
        && slicedFrom[2] === ownArchived && slicedFrom[3] === terminals) return sliced
      const held = mainSessionId(Object.values(list.byId))
      sliced = {
        ids: list.ids.map(String),
        byId: Object.fromEntries(Object.entries(list.byId).map(([id, row]) => [id, {
          displayTitle: row.displayTitle,
          cwd: row.cwd,
          running: row.running,
        }])),
        current: held === undefined ? undefined : String(held),
        archived: [...new Set([...(archived ?? []), ...(ownArchived ?? [])].map(String))],
        terminals: terminals?.map(String),
      }
      slicedFrom = [list, archived, ownArchived, terminals]
      return sliced
    },
    // Every store, because the panel draws from all of them: a session archived
    // (or unarchived) elsewhere has to reach this panel as it happens.
    subscribe: (listener) => {
      const offList = sessions?.list.subscribe(listener)
      const offArchive = workspaceRegistry()?.list.subscribe(listener)
      const offModes = terminalModes()?.subscribe(listener)
      return () => { offList?.(); offArchive?.(); offModes?.() }
    },
  }

  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'dshell-buffer',
      order: 100,
      label: () => t('panel.label'),
      locale: NS,
      inject: () => ({ buffer, sessions: sessionsSeat }),
    },
    PipePanel,
  ))
}
