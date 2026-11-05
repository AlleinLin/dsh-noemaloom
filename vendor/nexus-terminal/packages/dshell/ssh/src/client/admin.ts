/**
 * The dshell 管理台: one settings page for everything the suite configures.
 *
 * The page itself is deliberately thin — a heading, one line of direction,
 * and the card list, which is a child seat ('dshell.admin.card') this
 * registration declares and renders. The cards come from whichever packages
 * are composed in, each registered into the seat by its own plugin: the
 * device surface here, the terminal and data-root cards in dshell-mode. That
 * is the reason the seat exists at all — the alternative is one package
 * importing another's components, and every edge to dshell-ssh is a runtime
 * seat, never a build-time import.
 *
 * The same augmentation is declared in dshell-mode (both halves must see the
 * seat to type-check their side of it); interface merging accepts identical
 * members, and the twin declaration carries a pointer back here.
 */

import { createElement, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * One card of the dshell 管理台 (the `dshell` settings section's page).
     * The page renders the entries in `order` as a stacked card list; each
     * entry draws its own card chrome, heading and internals. The owning
     * page and its children declaration live in dshell-ssh's client.
     */
    'dshell.admin.card': {
      kind: 'list'
      scope: 'root'
      owner: DshellAdminCardOwnerProps
    }
  }
}

/** Owner share of the admin console's card list; the page supplies nothing. */
export interface DshellAdminCardOwnerProps {
  /** Marker field: the card list's owner props are intentionally empty. */
  children?: never
}

/** The stack the cards sit in; the settings section's own card list. */
const stackStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
}

/** The one line of direction, set above the cards. */
const introStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.6,
  opacity: 0.72,
}

/**
 * The 管理台's page: the frame the settings section mounts, drawing every
 * card the composed packages contributed to the child seat.
 *
 * @param props - the locale seat and the framework's child-seat renderer,
 *   which the registration's `children` declaration authorizes.
 */
export function DshellAdminPage(
  { renderSlot, t }: PropsLocale<'dshellSsh'> & {
    readonly renderSlot: (name: 'dshell.admin.card', owner: DshellAdminCardOwnerProps & object) => ReactNode
  },
): ReactElement {
  return createElement('div', { style: stackStyle },
    createElement('div', { style: introStyle }, t('admin.intro')),
    renderSlot('dshell.admin.card', {}),
  )
}
