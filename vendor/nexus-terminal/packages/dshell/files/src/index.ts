/**
 * dshell-files host face: the directory listing the file navigator reads, the
 * one command it can send, and the two-world file transfer the transfer view
 * drives.
 *
 * The navigator's half is the visible feature; this half exists because the walk
 * needs a data source that is not fenced to the session's working directory —
 * dsh's own `workspaceFiles.list` refuses anything above it, while the
 * filesystem seam itself reads wherever the session's world reaches.
 *
 * The shell jump is the second half of the same idea: the pane can show a
 * device's `/etc`, and the session's shell can go there, because both read the
 * session's own execution world rather than this machine's.
 *
 * The transfer route is a third subject with a second world: it reads through
 * `ctx.fs` and writes through `ctx.shell`, each inside the side's own initiator
 * boundary, so the same two seams already reach this machine and the device (see
 * `transfer.ts` for why no new transport was needed).
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the host connection merge (ctx.connection.fetch).
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the host agent service merge (ctx.agents.withInitiator).
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
// Type-only: pulls the shell service merge (ctx.shell), the byte-write seam.
import type {} from '@deepseek-ai/dsh-shell'
// Type-only: pulls the terminal bridge's service merge (ctx.dshellTerminalBridge).
import type { DshellTerminalBridge } from '@nexus-aethra/dshell-terminal-bridge'
import { DEVICE_FS_SERVICE, type DeviceFsSeat } from '@nexus-aethra/dshell-std'
import { createFilesRoute } from './route.js'
import { TransferEngine, type TransferRoutingSeat } from './transfer.js'
import { createTransferRoute } from './transfer-route.js'

export const name = '@nexus-aethra/dshell-files'

export { DSHELL_FILES_PATH } from './protocol.js'
export type {
  DshellCompletion, DshellCompletionCandidate, DshellFileEntry, DshellFileKind, DshellFilesListing,
  DshellFilesRequest, DshellFilesResponse,
} from './protocol.js'
export { DSHELL_TRANSFER_PATH } from './transfer-protocol.js'
export type {
  TransferEntry, TransferJobState, TransferJobView, TransferListing, TransferRequest, TransferResponse,
  TransferSetup, TransferSide,
} from './transfer-protocol.js'

export function apply(ctx: Context): void {
  // `fs` is injected, not merely imported: Cordis refuses a property access on a
  // context whose scope never declared the service, and the listing reads the
  // seam through the scope handed to the route.
  ctx.inject(['connection', 'agents', 'sessionController', 'fs'], (routeCtx) => {
    // The terminal bridge is genuinely optional — it is what makes the jump
    // button possible, not what makes the pane work — so it gets its own scope
    // that simply never runs in a composition without it.
    let bridge: DshellTerminalBridge | undefined
    routeCtx.inject(['dshellTerminalBridge'], (terminalCtx) => {
      bridge = terminalCtx.dshellTerminalBridge
    })
    // The device router is optional and read structurally: the composer's
    // completion needs it only to resolve `~` against a device session's own
    // home, and a composition without dshell-ssh simply uses this machine's.
    const routing = (): TransferRoutingSeat | undefined =>
      routeCtx.get('dshellSshRouting') as unknown as TransferRoutingSeat | undefined
    routeCtx.effect(
      () => routeCtx.connection.fetch.register(createFilesRoute(routeCtx, () => bridge, routing)),
      'dshell-files: listing route',
    )

    // The transfer route needs one more seam than the navigator does: the shell,
    // which is how bytes reach a world (`ctx.fs` has no byte write). The device
    // router is optional and read structurally through a getter — a composition
    // without dshell-ssh then has no remote side to offer, which the view says.
    // The byte-level device ops are also optional; the engine falls back to its
    // in-process paths when the seat reports no device for the ambient call.
    routeCtx.inject(['shell'], (shellCtx) => {
      const engine = new TransferEngine(
        shellCtx,
        () => shellCtx.get('dshellSshRouting') as unknown as TransferRoutingSeat | undefined,
        () => shellCtx.get(DEVICE_FS_SERVICE) as unknown as DeviceFsSeat | undefined,
      )
      shellCtx.effect(
        () => shellCtx.connection.fetch.register(createTransferRoute(engine)),
        'dshell-files: transfer route',
      )
    })
  })
}

export default { name, apply }
