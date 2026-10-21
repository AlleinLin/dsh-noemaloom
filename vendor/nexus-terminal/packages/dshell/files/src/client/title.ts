/**
 * The navigator's chip title: the folder sheet before the type's label.
 *
 * Registered under `sidebar.right.pane.tab.title`; without it the chip would
 * show the registry's captured text, which is the same label — the glyph is the
 * reason to register at all, since the pane's chip is otherwise bare.
 */

import { createElement, Fragment, type ReactNode } from 'react'
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the right-Sidebar SlotMap merge (the title seat).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook.
 * @returns the folder sheet followed by the tab's title text.
 */
export function DshellFilesTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return createElement(Fragment, null,
    createElement(FileTypeIcon, { kind: 'folder', size: 16 }),
    tab.title,
  )
}
