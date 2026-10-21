/**
 * The usage page's client face: the locale dictionaries and the Settings
 * navigation row that mounts the page.
 *
 * `settings.section` is the seat dsh's own Plugins page uses, so this page is a
 * peer of it rather than a tab inside it — the charts want the full settings
 * column, and a reader looking for "what did this cost" looks in the
 * navigation, not under a plugin list.
 */

import { type Context } from '@deepseek-ai/cordis'
// Type-only: pulls the locale service merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the settings SlotMap so `settings.section` is an accepted
// registration name.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { en, zh } from './locales.js'
import { UsageSection } from './page.js'
import { watchUsageNavIcon } from './nav-icon.js'

/** The locale namespace, matching the key `locales.ts` declares. */
const NS = 'dshellUsage'

export const name = '@nexus-aethra/dshell-usage/client'

export const inject = ['slots', 'locale'] as const

export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  // Registered through an effect so a composition that unloads this plugin
  // takes its copy with it.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dshell-usage: dictionaries')
  // Ordered after the Plugins page (15) so the navigation reads
  // sessions → plugins → usage, and named with its own id so it is added beside
  // the shipped entries rather than replacing one.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'usage',
    order: 40,
    label: () => t('nav'),
    locale: NS,
  }, UsageSection))
  // The row's own icon, because this seat carries none: dsh draws a generic
  // gear for any section id it does not ship (see nav-icon.ts).
  ctx.effect(() => watchUsageNavIcon(() => t('nav')), 'dshell-usage: navigation icon')
}
