/**
 * The transfer tab's chip title: the exchange glyph before the type's label.
 *
 * Registered under `sidebar.right.pane.tab.title`; without it the chip would
 * show the registry's captured text, which is the same label — the glyph is the
 * reason to register at all, and it is what tells the two file tabs apart.
 */

import { createElement, Fragment, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the right-Sidebar SlotMap merge (the title seat).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { TransferGlyph } from './transfer-glyph.js'

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook.
 * @returns the exchange glyph followed by the tab's title text.
 */
export function DshellTransferTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return createElement(Fragment, null,
    createElement(TransferGlyph, { size: 16 }),
    tab.title,
  )
}
