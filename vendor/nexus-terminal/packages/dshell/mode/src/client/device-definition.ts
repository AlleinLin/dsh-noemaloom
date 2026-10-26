/**
 * What the device panel IS, as this package implements it.
 *
 * A tab kind of its own, next to the file browser rather than inside it: the
 * two answer different questions about the same machine — "what can I read"
 * and "what is running there" — and the second one is the seed of the third
 * (a port forward needs the ports).
 *
 * The guide entry is not decoration. The right pane seeds its default page
 * from the sole guide entry's kind, so a type that contributes none would
 * leave the pane opening the guide page instead of the panel. It is also the
 * card the reader sees on that guide page, and the one place dshell's own
 * surfaces are discoverable from.
 */

import { createElement } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.js'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const DSHELL_DEVICE_PANEL_ID = '@nexus-aethra/dshell-mode/device'

/** The tab kind this package registers. */
export const DEVICE_KIND = 'device'

/**
 * A server glyph, drawn here rather than borrowed.
 *
 * dsh's primitives carry no machine glyph, and the panel is the one surface
 * that is ABOUT a machine — so it draws one, in the same 1px stroke the
 * sidebar's own icons use.
 */
export function DeviceGlyph({ size, className }: IconProps): ReturnType<typeof createElement> {
  return createElement(
    'svg',
    { width: size ?? 20, height: size ?? 20, viewBox: '0 0 20 20', fill: 'none', className },
    createElement('rect', { x: 2.5, y: 3, width: 15, height: 5.5, rx: 1.5, stroke: 'currentColor', strokeWidth: 1 }),
    createElement('rect', { x: 2.5, y: 11.5, width: 15, height: 5.5, rx: 1.5, stroke: 'currentColor', strokeWidth: 1 }),
    createElement('circle', { cx: 6, cy: 5.75, r: 0.9, fill: 'currentColor' }),
    createElement('circle', { cx: 6, cy: 14.25, r: 0.9, fill: 'currentColor' }),
  )
}

/**
 * The device panel's registry definition, as this package implements it.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function dshellDeviceDefinition(t: TranslateNS<'dshellMode'>): SidebarRightTabDefinition {
  return {
    id: DSHELL_DEVICE_PANEL_ID,
    kind: DEVICE_KIND,
    // The band that may take over a builtin kind; also the registry's default.
    priority: 'extension',
    title: () => t('device.type.label'),
    guide: [{
      id: 'device',
      order: 20,
      title: () => t('device.guide.title'),
      description: () => t('device.guide.description'),
      icon: DeviceGlyph,
    }],
  }
}
