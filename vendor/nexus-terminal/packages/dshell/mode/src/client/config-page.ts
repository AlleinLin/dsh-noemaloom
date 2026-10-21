/**
 * dshell-mode's configuration, as the Plugins panel asks for it.
 *
 * The row this bundle declares (`dshell-mode`) carries a configure control on
 * the bundle's page, and this is the page it opens: the terminal palette and
 * the composer's shell helpers, then where dshell keeps its own files. Both
 * were cards of the Plugins settings section, which is the older model — the
 * panel is where a reader manages a plugin now, so its configuration lives
 * with it rather than in a tab of the settings dialog.
 *
 * The two cards keep their own chrome and their own write-at-click behaviour
 * (there is no form here and no save button: a palette applies the moment it is
 * picked, a switch on its click), so this page is only their container — the
 * shape the settings section used to provide.
 */

import { createElement, type CSSProperties, type ReactElement } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.js'
import { DshellSettingsCard } from './settings-card.js'
import { DshellDataCard } from './data-card.js'

/** The stack the two cards sit in; the settings section's own card list. */
const listStyle: CSSProperties = {
  listStyle: 'none', margin: 0, padding: 0,
  display: 'flex', flexDirection: 'column', gap: 10,
}

/**
 * One view of this plugin's configuration.
 *
 * @param props - the locale seat, plus the `view` the panel asks for: a row
 *   whose package carries no description falls back to `summary`, which is one
 *   line rather than the whole page.
 * @returns the page, or that one-line summary.
 */
export function DshellModeConfigPage(
  { t, view }: PropsLocale<'dshellMode'> & { readonly view?: 'summary' | 'page' },
): ReactElement {
  if (view === 'summary') return createElement('span', null, t('config.summary'))
  return createElement('ul', { style: listStyle },
    createElement(DshellSettingsCard, { t }),
    createElement(DshellDataCard, { t }),
  )
}
