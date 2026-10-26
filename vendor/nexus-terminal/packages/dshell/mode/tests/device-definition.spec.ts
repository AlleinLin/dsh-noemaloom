/**
 * The panel's registry definition: the tab kind, and the card on the start page.
 *
 * The card is not decoration. The right pane's default page is a summary of
 * the types that contributed a guide entry, so a type that contributes none
 * is a type the reader never finds. And the guide page IS where dshell's own
 * surfaces are discoverable from — which is where the reader asked for this
 * one to live.
 */

import { describe, expect, it } from 'vitest'
import { DEVICE_KIND, DSHELL_DEVICE_PANEL_ID, dshellDeviceDefinition } from '../src/client/device-definition.js'
import { en, zh } from '../src/client/locales.js'

/** The locale binding the registry hands the definition. */
const t = (key: keyof typeof zh): string => zh[key]

describe('the device panel as a registry type', () => {
  it('is a kind of its own, so it takes nothing from dsh', () => {
    const definition = dshellDeviceDefinition(t)

    // A kind dsh already ships would be TAKEN over by an extension, and the
    // shipped pane would disappear for every session — including the ones
    // that have no device.
    expect(definition.kind).toBe(DEVICE_KIND)
    expect(DEVICE_KIND).not.toBe('files')
    expect(definition.priority).toBe('extension')
    expect(definition.id).toBe(DSHELL_DEVICE_PANEL_ID)
  })

  it('contributes the card the start page lists', () => {
    const definition = dshellDeviceDefinition(t)

    expect(definition.guide).toHaveLength(1)
    const card = definition.guide?.[0]
    expect(card?.id).toBe('device')
    expect(card?.title()).toBe(zh['device.guide.title'])
    expect(card?.description()).toBe(zh['device.guide.description'])
    // The card is drawn with the panel's own glyph, so the start page shows
    // the machine the panel is about.
    expect(card?.icon).toBeDefined()
  })

  it('names itself in the reader\'s language', () => {
    const definition = dshellDeviceDefinition(t)

    expect(definition.title()).toBe(zh['device.type.label'])
    expect(en['device.type.label']).not.toBe(zh['device.type.label'])
  })
})
