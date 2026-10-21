/**
 * What the `transfer` tab kind IS, as this package implements it.
 *
 * A page type with a kind of its own — NOT a takeover, and deliberately without
 * a guide entry. Both of those are load-bearing:
 *
 *  - the navigator's kind (`files`) belongs to dsh's shipped file tree, and this
 *    type is a second view rather than a re-implementation of that one, so it
 *    adds a kind instead of shadowing one;
 *  - the right pane seeds its default page from the SOLE guide entry's kind, so
 *    a second entry would move every session's default page onto the guide
 *    itself. The way in is the navigator's header button instead, which is also
 *    where the feature is discoverable — next to the tree it transfers from.
 */

import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.js'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const DSHELL_TRANSFER_ID = '@nexus-aethra/dshell-files/transfer'

/**
 * The tab kind the navigator's header button opens, and the one
 * `tabActions.openTab` is called with. Spelled once here so the button and the
 * registration cannot drift.
 */
export const TRANSFER_KIND = 'transfer'

/**
 * The transfer type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function dshellTransferDefinition(t: TranslateNS<'dshellFiles'>): SidebarRightTabDefinition {
  return {
    id: DSHELL_TRANSFER_ID,
    kind: TRANSFER_KIND,
    // The band that may take over a builtin kind; also the registry's default.
    priority: 'extension',
    title: () => t('transfer.label'),
  }
}
