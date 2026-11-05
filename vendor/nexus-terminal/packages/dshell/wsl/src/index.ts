/**
 * dshell-wsl host face.
 *
 * This package is a device PROVIDER, not a device model: it owns the WSL2
 * distributions of this machine (detection, doors, the admin card) and
 * registers them into dshell-ssh's device registry. Nothing here stores a
 * row, dials a handshake, or deploys a helper — the model's owner does all of
 * that for provider devices exactly as it does for its own, which is why a
 * composition without this package loses nothing it ever had.
 */

import type { Context } from '@deepseek-ai/cordis'
import { DSHELL_DEVICE_REGISTRY } from '@nexus-aethra/dshell-std'
// Type-only: the provider contract is dshell-ssh's extension point (it speaks
// in node streams, which keep it out of the browser-compilable std). The
// runtime dependency runs the other way — ssh never imports this package.
import type { DshellDeviceProvider } from '@nexus-aethra/dshell-ssh'
import { WslDeviceProvider } from './provider.js'

export { decodeWslOutput, distroOf, isWslDevice, parseWslList, WSL_DEVICE_PREFIX, WSL_EXE, wslExecArgs } from './transport.js'
export type { WslDistro } from './transport.js'
export { WslDeviceProvider } from './provider.js'

export const name = '@nexus-aethra/dshell-wsl'

/** Required service: the device registry dshell-ssh publishes. */
export const inject = [DSHELL_DEVICE_REGISTRY] as const

export function apply(ctx: Context): void {
  const registry = ctx.get(DSHELL_DEVICE_REGISTRY) as {
    register(provider: DshellDeviceProvider): void
    unregister(provider: DshellDeviceProvider): void
  }
  const provider = new WslDeviceProvider()
  // Registered for this package's life: unloading the plugin takes its rows,
  // its doors and its refusals with it, and the device list answers without
  // them on the next read.
  ctx.effect(() => {
    registry.register(provider)
    return () => { registry.unregister(provider) }
  }, 'dshell-wsl: provider registration')
}
