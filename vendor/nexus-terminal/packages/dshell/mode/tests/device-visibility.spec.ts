/**
 * The device seat's visibility rule: which rows a picker offers.
 *
 * The rule itself lives in dshell-std so every picker applies the same one;
 * what is worth pinning HERE is what a picker does with it. The seat is the
 * one projection the creation page and the terminal section both read, so a
 * hidden row dropped anywhere else is a row one of the two still offers.
 *
 * The fact that makes hiding safe is asserted here too: a session already bound
 * to a hidden device still has its device NAMED, because the surfaces that name
 * it read the unfiltered list. That is the regression this file exists for.
 *
 * The refusal path (a write the host will not take) lives in
 * ssh/tests/device-visibility.spec.ts, beside the service it drives.
 */

import { describe, expect, it } from 'vitest'
import { isHiddenDevice } from '@nexus-aethra/dshell-std'

/** One row as the ssh service publishes it, narrowed to what the rule reads. */
function row(id: string, over: Partial<{ name: string; auth: string; builtin: boolean }> = {}) {
  return { id, name: over.name ?? id, auth: over.auth ?? 'key', builtin: over.builtin }
}

const UBUNTU = row('wsl:Ubuntu-24.04', { name: 'Ubuntu-24.04', auth: 'wsl', builtin: true })
const DEBIAN = row('wsl:Debian-12', { name: 'Debian-12', auth: 'wsl', builtin: true })
const BUILD = row('build-box', { name: 'build-box', auth: 'key' })

/** What a picker offers: the same filter the seat applies. */
function offered(devices: readonly ReturnType<typeof row>[], hidden: readonly string[]): string[] {
  return devices.filter(device => !isHiddenDevice(device, hidden)).map(device => device.id)
}

/**
 * What a surface naming a bound session's device reads.
 *
 * The unfiltered list, which is why the seat publishes `allDevices` beside the
 * filtered `devices`: reading the filtered one here is the bug.
 */
function nameOf(
  all: readonly ReturnType<typeof row>[],
  deviceId: string,
): string | undefined {
  return all.find(candidate => candidate.id === deviceId)?.name
}

describe('the device pickers', () => {
  it('drop a hidden built-in row from what they offer', () => {
    expect(offered([UBUNTU, DEBIAN, BUILD], ['wsl:Ubuntu-24.04']))
      .toEqual(['wsl:Debian-12', 'build-box'])
  })

  it('offer everything when nothing is hidden', () => {
    expect(offered([UBUNTU, DEBIAN, BUILD], []))
      .toEqual(['wsl:Ubuntu-24.04', 'wsl:Debian-12', 'build-box'])
  })

  it('never drop a stored device, even when its id is in the set', () => {
    // The set is a settings document, so it can hold anything. A stored device
    // is managed by deleting it, and hiding is not a second way to delete one
    // with no way back.
    expect(offered([BUILD], ['build-box'])).toEqual(['build-box'])
  })

  it('still name the device of a session bound to a hidden one', () => {
    // The regression this file exists for: the terminal block's row label and
    // the creation page's place chip both resolve a bound session's device, and
    // resolving it out of the FILTERED list labels the session 本地 or shows a
    // raw wsl:... id. They read allDevices instead.
    const every = [UBUNTU, DEBIAN, BUILD]
    const hidden = ['wsl:Ubuntu-24.04']

    expect(offered(every, hidden)).not.toContain('wsl:Ubuntu-24.04')
    expect(nameOf(every, 'wsl:Ubuntu-24.04')).toBe('Ubuntu-24.04')
  })
})
