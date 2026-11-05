/**
 * The device-provider registry's capabilities: what a kind says about itself,
 * what the registry answers when nobody says anything, and what a composition
 * without providers gets.
 *
 * The registry is the one place a device kind's facts live, so these specs
 * hold it to three promises. A provider's answer is taken at its word: a kind
 * that says it carries no helper is reported as carrying no helper, and a
 * kind that declines a seam refuses in the provider's own words. A device no
 * provider claims is an SSH device, and the registry answers for it exactly as
 * it did before providers existed. And a registry with no providers at all is
 * unchanged — the same rows, the same doors, the same capabilities — so a
 * composition that leaves the provider's package out loses only the kind, not
 * this package's behaviour.
 *
 * The provider here is a fake: it names a kind of its own and says what that
 * kind can do. Nothing about it belongs to any real device kind, which is the
 * point — the registry must work for a kind this package has never heard of.
 */

import { describe, expect, it } from 'vitest'
import {
  DshellDeviceRegistry,
  type DshellDeviceProvider,
  type DshellDeviceSeam,
  type DeviceDoors,
} from '../src/registry.js'
import type { DeviceConnection, DeviceView } from '@nexus-aethra/dshell-std'

/** The prefix the fake provider claims its devices under. */
const OWNED = 'fake:'

/** One of the fake provider's devices. */
function ownedConnection(id: string): DeviceConnection {
  return {
    id,
    name: id.slice(OWNED.length),
    host: 'fake-host',
    port: 0,
    user: '',
    remoteRoot: '~',
    auth: 'key',
    kind: 'fake',
    secret: undefined,
  }
}

/** The fake provider's options: which capabilities it claims. */
interface FakeOptions {
  readonly helper?: boolean
  readonly reachable?: boolean
  readonly forwards?: boolean
  /** Words per seam, when the provider words them itself. */
  readonly words?: Partial<Record<DshellDeviceSeam, string>>
}

/**
 * A provider for a kind of its own.
 *
 * Carries only what the specs ask of it: the rows it contributes, the doors
 * that answer for its devices, and the capabilities it declares.
 */
class FakeProvider implements DshellDeviceProvider {
  readonly helper?: boolean
  readonly reachable?: boolean
  readonly forwards?: boolean
  private readonly words: Partial<Record<DshellDeviceSeam, string>>

  constructor(options: FakeOptions = {}) {
    // Assigned only when the option was given: an optional property that is
    // PRESENT and undefined is not the same as one that is absent, and the
    // registry reads the difference.
    if (options.helper !== undefined) this.helper = options.helper
    if (options.reachable !== undefined) this.reachable = options.reachable
    if (options.forwards !== undefined) this.forwards = options.forwards
    this.words = options.words ?? {}
  }

  async rows(): Promise<readonly DeviceView[]> {
    return [{
      id: `${OWNED}one`,
      name: 'one',
      host: 'fake-host',
      port: 0,
      user: '',
      remoteRoot: '~',
      auth: 'key',
      builtin: true,
      hasSecret: false,
      hasPassphrase: false,
    }]
  }

  async connection(deviceId: string): Promise<DeviceConnection | undefined> {
    return deviceId.startsWith(OWNED) ? ownedConnection(deviceId) : undefined
  }

  owns(deviceId: string): boolean {
    return deviceId.startsWith(OWNED)
  }

  doors(): DeviceDoors | undefined {
    return undefined
  }

  refusal(deviceId: string): string | undefined {
    if (!this.owns(deviceId)) return undefined
    // A kind that declines forwards names its reason; one that does not
    // decline them says nothing at all.
    return this.forwards === false ? 'this kind does not forward ports' : undefined
  }

  refusalFor(deviceId: string, seam: DshellDeviceSeam): string | undefined {
    if (!this.owns(deviceId)) return undefined
    return this.words[seam]
  }
}

describe('DshellDeviceRegistry capabilities', () => {
  it('reports a kind that declares no helper as having no helper', () => {
    const registry = new DshellDeviceRegistry()
    registry.register(new FakeProvider({ helper: false, reachable: false }))
    expect(registry.usesHelper(`${OWNED}one`)).toBe(false)
    expect(registry.isReachable(`${OWNED}one`)).toBe(false)
  })

  it('reports a kind that declares both capabilities as having them', () => {
    const registry = new DshellDeviceRegistry()
    registry.register(new FakeProvider({ helper: true, reachable: true }))
    expect(registry.usesHelper(`${OWNED}one`)).toBe(true)
    expect(registry.isReachable(`${OWNED}one`)).toBe(true)
  })

  it('defaults both capabilities to true for a provider that says nothing', () => {
    // A provider that only contributes rows and doors is an SSH kind, and
    // every SSH behaviour it had before the capabilities existed must survive.
    const registry = new DshellDeviceRegistry()
    registry.register(new FakeProvider())
    expect(registry.usesHelper(`${OWNED}one`)).toBe(true)
    expect(registry.isReachable(`${OWNED}one`)).toBe(true)
  })

  it('defaults both capabilities to true for a device no provider claims', () => {
    const registry = new DshellDeviceRegistry()
    registry.register(new FakeProvider({ helper: false, reachable: false }))
    // Not this provider's id: the stored devices this package dials itself.
    expect(registry.usesHelper('stored-device')).toBe(true)
    expect(registry.isReachable('stored-device')).toBe(true)
  })

  it('falls back to the defaults once the provider is unregistered', () => {
    const registry = new DshellDeviceRegistry()
    const provider = new FakeProvider({ helper: false, reachable: false })
    registry.register(provider)
    expect(registry.usesHelper(`${OWNED}one`)).toBe(false)
    registry.unregister(provider)
    expect(registry.usesHelper(`${OWNED}one`)).toBe(true)
    expect(registry.isReachable(`${OWNED}one`)).toBe(true)
  })

  it('takes the answer from the provider that owns the id', () => {
    const registry = new DshellDeviceRegistry()
    registry.register(new FakeProvider({ helper: true, reachable: true }))
    registry.register(new FakeProvider({ helper: false, reachable: false }))
    // The first provider that claims the id answers for it.
    expect(registry.usesHelper(`${OWNED}one`)).toBe(true)
    expect(registry.isReachable(`${OWNED}one`)).toBe(true)
  })
})

describe('DshellDeviceRegistry seam refusals', () => {
  it('refuses a declined seam in the provider\'s own words', () => {
    const registry = new DshellDeviceRegistry()
    registry.register(new FakeProvider({
      helper: false,
      reachable: false,
      words: { helper: 'this kind never carries a helper', dial: 'this kind is not dialled' },
    }))
    expect(registry.refusalFor(`${OWNED}one`, 'helper')).toBe('this kind never carries a helper')
    expect(registry.refusalFor(`${OWNED}one`, 'dial')).toBe('this kind is not dialled')
  })

  it('answers a served seam with undefined', () => {
    const registry = new DshellDeviceRegistry()
    registry.register(new FakeProvider({ helper: true, reachable: true }))
    expect(registry.refusalFor(`${OWNED}one`, 'helper')).toBeUndefined()
    expect(registry.refusalFor(`${OWNED}one`, 'dial')).toBeUndefined()
    expect(registry.refusalFor(`${OWNED}one`, 'forward')).toBeUndefined()
  })

  it('falls back to a neutral sentence that names no kind', () => {
    const registry = new DshellDeviceRegistry()
    registry.register(new FakeProvider({ helper: false, reachable: false }))
    const helper = registry.refusalFor(`${OWNED}one`, 'helper')
    expect(helper).toBeDefined()
    // The neutral sentence says what the seam cannot do; only a provider can
    // say why, and this one has not.
    expect(helper).toContain('helper')
    expect(helper).not.toContain('fake')
  })

  it('uses the general refusal for the forward seam', () => {
    const registry = new DshellDeviceRegistry()
    registry.register(new FakeProvider({ forwards: false }))
    expect(registry.forwardsAllowed(`${OWNED}one`)).toBe(false)
    expect(registry.refusalFor(`${OWNED}one`, 'forward')).toBe('this kind does not forward ports')
  })
})

describe('DshellDeviceRegistry without providers', () => {
  it('is empty in every way a composition without a provider can see it', async () => {
    const registry = new DshellDeviceRegistry()
    expect(registry.providers()).toEqual([])
    expect(await registry.rows()).toEqual([])
    expect(await registry.connection('anything')).toBeUndefined()
    expect(registry.owns('anything')).toBe(false)
    expect(registry.doorsFor(ownedConnection('anything'))).toBeUndefined()
    expect(registry.forwardsAllowed('anything')).toBe(true)
    expect(registry.refusal('anything')).toBeUndefined()
    expect(await registry.probeTargets()).toEqual([])
  })

  it('answers the capabilities as an SSH device does', () => {
    const registry = new DshellDeviceRegistry()
    expect(registry.usesHelper('anything')).toBe(true)
    expect(registry.isReachable('anything')).toBe(true)
  })

  it('refuses no seam', () => {
    const registry = new DshellDeviceRegistry()
    expect(registry.refusalFor('anything', 'helper')).toBeUndefined()
    expect(registry.refusalFor('anything', 'dial')).toBeUndefined()
    expect(registry.refusalFor('anything', 'forward')).toBeUndefined()
  })
})
