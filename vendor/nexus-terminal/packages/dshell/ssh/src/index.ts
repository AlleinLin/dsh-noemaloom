/**
 * dshell-ssh host face.
 *
 * A session can be assigned to a device; every shell command that session's
 * agent then runs executes on that device instead of this machine. The three
 * pieces are the device registry (name, host, port, user, remote directory and
 * private key), the durable session assignment, and the seam that acts on it
 * (`ctx.shell.resolve`, see router.ts).
 *
 * Scope, stated where it is decided: this routes the harness's *shell*
 * commands. Tools that reach the filesystem directly (read/write/edit) and the
 * ripgrep-backed search tools (glob/grep) still act locally, and so does the
 * visible dshell terminal; each needs its own seam (`ctx.fs`, `ctx.subprocess`,
 * the PTY backend) and is not claimed here.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { DshellDataRootSeat, HostCopy } from '@nexus-aethra/dshell-std'
import { DSHELL_DATA_ROOT_SERVICE } from '@nexus-aethra/dshell-std'
// Type-only: pulls the host agent service merge (ctx.agents.currentInitiator).
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: pulls the host connection merge (ctx.connection.fetch).
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the settings service merge (optional ctx.settings).
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: pulls the shell and subprocess service merges.
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-subprocess'
import DshellFsPlugin from './fs-routing.js'
import { hostCopy } from './host-locales.js'
import { sshDeviceRoot } from './paths.js'
import { createSshRoute } from './route.js'
import { Forwarder } from './forward/forwarder.js'
import { createForwardRoute } from './forward/route.js'
import { installForwardTool } from './forward/tool.js'
import { deviceTransport } from './transport/transport.js'
import { installShellRouting, SSH_ROUTING_SERVICE, SshRouter } from './router.js'
import { installSpawnRouting } from './spawn-routing.js'
import { installDeviceDialect } from './device-dialect.js'

export const name = '@nexus-aethra/dshell-ssh'

export { DSHELL_SSH_PATH, type DeviceView, type SshResponse } from './protocol.js'
export { harnessHome, mountBase, sshDeviceRoot } from './paths.js'
export { SSH_ROUTING_SERVICE } from './router.js'
export { DEVICE_SHELL_TOOL } from './device-dialect.js'
export { isUnder, mappingFor, mountFor, toMountPath, toRemotePath, type MountMapping } from './mount.js'
export type { SshSettings } from './ssh-settings.js'
export { Config } from './ssh-settings.js'

/**
 * Required service: dshell's settled data root.
 *
 * This package builds its device registry during composition AND fills the
 * synchronous routing cache, so it must not resolve a path before the root is
 * known — and the root comes from a SETTING, readable only by a package that
 * waits for the settings service. Declaring the dependency is what makes the
 * order a fact rather than a race (see `std/data-root.ts`): this apply does not
 * start until `dshell-mode` has published its decision.
 */
export const inject = [DSHELL_DATA_ROOT_SERVICE] as const

export function apply(ctx: Context): void {
  // rc.2 takes this plugin's configuration from the `Config` this entry
  // exports; the settings page dispatches the device card from that entry, so
  // there is nothing to register here.
  // The device registry is the one place in this package that READS a path
  // during composition (`SshRouter`'s constructor fills the routing cache that
  // the synchronous `targetForSession` reads). The service above is already
  // settled by the time this runs; the plan is awaited rather than read so the
  // ordering survives any future async step in the settlement. Everything else
  // here resolves paths at call time, which needs no ordering at all.
  void (async () => {
    const plan = await (ctx.get(DSHELL_DATA_ROOT_SERVICE) as DshellDataRootSeat).settled
    const router = new SshRouter(() => sshDeviceRoot())
    // Published so the filesystem provider — loaded as its own plugin, in place
    // of the stock backend — can resolve a call's session without this module
    // handing it anything directly.
    ctx.provide(SSH_ROUTING_SERVICE, router)
    // Bind host copy as soon as its provider is up: this package's host methods
    // compose user-visible refusals, and the translator resolves the language at
    // call time, so a switch needs no re-binding.
    ctx.inject(['dshellHostCopy'], (copyCtx) => {
      const copy = copyCtx.get('dshellHostCopy') as HostCopy
      router.bindCopy(copy.bind(hostCopy))
    })
    installRouting(ctx, router)
    if (plan.source !== 'harness') {
      // Only worth a line when the root is not the harness's own: the default
      // deployment says nothing (dshell-mode reports the choice).
      console.info(`dshell-ssh: devices are read from ${plan.root}`)
    }
  })()
}

/**
 * Wire the seam that acts on a session's assignment.
 * @param ctx - host context.
 * @param router - the device router.
 */
function installRouting(ctx: Context, router: SshRouter): void {
  // `ctx.fs` for device-bound sessions. The composition disables the stock
  // `fs-sandbox` row, because a service name has exactly one provider.
  ctx.plugin(DshellFsPlugin)
  // Routing waits for both services: the shell executor is what gets wrapped,
  // and the agent registry is how the wrapped call learns whose session it is.
  ctx.inject(['shell', 'agents', 'dshellHostCopy'], (routingCtx) => {
    const copy = routingCtx.get('dshellHostCopy') as HostCopy
    routingCtx.effect(
      () => installShellRouting(routingCtx, router, copy.bind(hostCopy)),
      'dshell-ssh: shell routing',
    )
  })
  // `glob`/`grep` spawn ripgrep directly rather than going through `ctx.fs`,
  // so their routing lives on the subprocess seam.
  ctx.inject(['agents', 'subprocess'], (spawnCtx) => {
    spawnCtx.effect(
      () => installSpawnRouting(spawnCtx, router),
      'dshell-ssh: search routing',
    )
  })
  // The connection test spawns `ssh` through the harness's own process
  // primitive, so that context needs the subprocess service injected.
  ctx.inject(['connection', 'subprocess', 'dshellHostCopy'], (connectionCtx) => {
    const copy = connectionCtx.get('dshellHostCopy') as HostCopy
    connectionCtx.effect(
      () => connectionCtx.connection.fetch.register(createSshRoute({ router, ctx: connectionCtx, t: copy.bind(hostCopy) })),
      'dshell-ssh: device route',
    )
  })
  // The forwarder: a socket on this machine in front of a port on the
  // device. It rides the pooled connection the transport already holds, so
  // it needs no service of its own.
  ctx.inject(['connection'], (forwardCtx) => {
    const forwarder = new Forwarder(deviceTransport())
    forwardCtx.effect(
      () => forwardCtx.connection.fetch.register(createForwardRoute({ forwarder, router })),
      'dshell-ssh: forward route',
    )
    // Every forward is a socket this host opened, so the host closing has
    // to close them: a listener left behind would keep a port bound after
    // the session that asked for it is gone.
    forwardCtx.effect(
      () => () => { forwarder.stopAll() },
      'dshell-ssh: forward teardown',
    )
  })
  // The contract a bound session's agent sees: the DEVICE's shell, not the
  // host's. It needs the tool registry (to shadow the host's shell tool in the
  // agent's own scope) and the agent registry (to know which agents exist and
  // which session each one belongs to).
  ctx.inject(['tools', 'agents'], (dialectCtx) => {
    dialectCtx.effect(
      () => installDeviceDialect(dialectCtx, router),
      'dshell-ssh: device dialect',
    )
  })
  // The forward tool: what the MODEL can ask for, beside the panel that lets
  // the READER ask for one. Both drive the same forwarder, so a forward one
  // of them opened is one the other can see.
  ctx.inject(['tools', 'agents', 'connection'], (toolCtx) => {
    const forwarder = new Forwarder(deviceTransport())
    toolCtx.effect(
      () => installForwardTool(toolCtx, { forwarder, router }),
      'dshell-ssh: forward tool',
    )
  })
}

export default { name, inject, apply }
