/**
 * The device panel's chip title: the machine glyph before the type's label.
 *
 * Registered under `sidebar.right.pane.tab.title`; without it the chip would
 * show the registry's captured text — the same label — and the glyph is the
 * reason to register at all, since the pane's chip is otherwise bare.
 */

import { createElement, Fragment, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the right-Sidebar SlotMap merge (the title seat).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { DeviceGlyph } from './device-definition.js'

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook.
 * @returns the machine glyph followed by the tab's title text.
 */
export function DshellDeviceTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return createElement(Fragment, null,
    createElement(DeviceGlyph, { size: 16 }),
    tab.title,
  )
}
