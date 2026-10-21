/**
 * `ctx.deviceFs`, made available to anything outside the policy fence of
 * `ctx.fs`.
 *
 * The transfer and buffer relays need byte-level ops that `ctx.fs`
 * deliberately does not expose (`mkdir` / `remove` / `rename` / `sha256` /
 * `copy`): the seam's contract is "you read / write text through `ctx.fs`",
 * and the relays transfer arbitrary bytes. The seat is published here so a
 * caller does not have to depend on `dshell-ssh`'s internals — the public
 * shape is `DeviceFsOps`, defined in `@nexus-aethra/dshell-std`.
 *
 * The seat is constructed exactly once per composition, alongside the
 * `DshellFileSystem` it complements. Both providers read the same routing
 * table on the same call (ambient initiator), so a transfer that asked for
 * `ctx.fs` and one that asked for `ctx.deviceFs` for the same session reach
 * the same device, by construction.
 *
 * The wrapped ops are NOT a per-call cache: a fresh `RemoteFileSystem` is
 * built every time `forInitiator` is called, because the helper connection
 * may have come up (or gone away) between calls and the constructor asks the
 * router for the live connection. A relay asks once at the top of its
 * function and passes the result down, so this is fine in practice.
 */

import type { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import {
  DEVICE_FS_SERVICE,
  type DeviceFsOps,
  type DeviceFsSeat,
} from '@nexus-aethra/dshell-std'
import type { DshellSshTranslate } from './host-locales.js'
import { mappingFor } from './mount.js'
import { RemoteFileSystem } from './remote-fs.js'
import { SSH_ROUTING_SERVICE } from './router.js'

/** The base-class config the relay's filesystem backend took; carried verbatim so the remote half uses the same caps. */
type RemoteFileSystemConfig = ConstructorParameters<typeof SandboxedFileSystem>[1]

/**
 * The byte-level ops that the seat surfaces.
 *
 * Wraps a `RemoteFileSystem` because the seam's richer return types
 * (`{ version } | undefined` on writes, `{ destination, sourceSha256, bytes }`
 * on copies) are not the public contract — `DeviceFsOps.writeBytes` returns
 * `void` because the transfer engine does not care about file versions, and
 * `DeviceFsOps.copy` returns `{ destination, sourceSha256, bytes }` without
 * a `version` field because the engine treats the destination as a path, not
 * a versioned handle.
 *
 * One adapter per call site: `forInitiator` constructs a new
 * `RemoteFileSystem` every time, and the wrapping here is just six method
 * arrows.
 */
export class DeviceFsAdapter implements DeviceFsOps {
  constructor(private readonly remote: RemoteFileSystem) {}

  async writeBytes(remote: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.remote.writeBytes(remote, bytes, signal)
  }

  async mkdir(paths: readonly string[], recursive: boolean, signal?: AbortSignal): Promise<void> {
    await this.remote.mkdir(paths, recursive, signal)
  }

  async remove(path: string, force: boolean, signal?: AbortSignal): Promise<void> {
    await this.remote.remove(path, force, signal)
  }

  async rename(from: string, to: string, overwrite: boolean, signal?: AbortSignal): Promise<void> {
    await this.remote.rename(from, to, overwrite, signal)
  }

  async sha256(path: string, signal?: AbortSignal): Promise<string> {
    return await this.remote.sha256(path, signal)
  }

  async copy(
    source: string,
    destination: string,
    overwrite: boolean,
    expectedSha256: string | undefined,
    onProgress: (written: number, totalBytes: number) => void,
    signal: AbortSignal,
  ): Promise<{ destination: string; sourceSha256: string; bytes: number }> {
    const outcome = await this.remote.copy(source, destination, overwrite, expectedSha256, onProgress, signal)
    return {
      destination: destination,
      sourceSha256: outcome.sourceSha256,
      bytes: outcome.bytes,
    }
  }
}

/**
 * The byte-level device-ops seat for this dshell instance.
 *
 * The shape is `DeviceFsSeat` from dshell-std. The implementation is the only
 * place that talks to the SSH routing table on this side of the policy fence.
 */
export class DshellDeviceFsProvider implements DeviceFsSeat {
  constructor(
    private readonly ctx: Context,
    private readonly config: RemoteFileSystemConfig,
    private readonly t: DshellSshTranslate,
  ) {}

  /**
   * The device ops for the ambient call's session.
   *
   * Returns `undefined` when the session runs on this machine, and REFUSES when
   * it is bound to a device nothing can serve: `undefined` reads as "operate
   * locally" at every call site, which for a device session would put its bytes
   * on this machine (the rule `DshellFileSystem.route` states at length).
   *
   * The lookup mirrors `DshellFileSystem.remote()`: same ambient initiator,
   * same routing table, same mapping. Two callers that asked at the same
   * instant for the same session reach the same device; the lookup itself
   * is cheap and not cached, because the device's helper connection may have
   * come up between calls.
   */
  forInitiator(): DeviceFsOps | undefined {
    const agent = this.ctx.agents.currentInitiator()
    if (agent === undefined) return undefined
    const routing = this.ctx[SSH_ROUTING_SERVICE]
    const sessionId = String(agent.id)
    const target = routing.targetForSession(sessionId)
    const mapping = target === undefined ? undefined : mappingFor(target, agent.session.header.cwd)
    if (target === undefined || mapping === undefined) {
      const bound = routing.assignmentForSession(sessionId)
      if (bound === undefined) return undefined
      throw new Error(routing.unservableMessage(bound.deviceId))
    }
    const remote = new RemoteFileSystem({
      ctx: this.ctx,
      device: target.device,
      mapping,
      diffBasisMaxBytes: this.config.diffBasisMaxBytes ?? 0,
      t: this.t,
      connection: routing.helperConnection?.(target.device.id),
    })
    return new DeviceFsAdapter(remote)
  }
}

/**
 * Compose-side wrapper that publishes the seat under
 * {@link DEVICE_FS_SERVICE}.
 *
 * Run from `fs-routing.ts`'s apply, after the router has settled and the host
 * copy is bound: those are the two pieces the seat needs. Services that
 * depend on `ctx.deviceFs` declare it in `inject`; the loader wires the
 * order.
 */
export function installDeviceFs(ctx: Context, config: RemoteFileSystemConfig, t: DshellSshTranslate): void {
  ctx.inject(['agents', SSH_ROUTING_SERVICE, 'dshellHostCopy'], (seatCtx) => {
    seatCtx.provide(DEVICE_FS_SERVICE, new DshellDeviceFsProvider(seatCtx, config, t))
  })
}