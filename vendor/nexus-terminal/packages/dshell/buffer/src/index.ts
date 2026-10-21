/**
 * dshell-buffer host face: the cross-session pipe.
 *
 * One service owns the whole feature — links the user established, the deferred
 * requests travelling over them, the scoped grants those requests carry, and
 * the watchdog that settles anything nobody settled. This entry point only
 * wires it up: the model-facing tool, the prompt section that teaches the
 * protocol, and the `/api` route the pipe panel talks to.
 *
 * `connection` is injected separately because a composition may mount this
 * package without a browser face; the service itself then still runs.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostCopy } from '@nexus-aethra/dshell-std'
import { hostCopy } from './host-locales.js'
import { renderBufferPrompt } from './prompt.js'
import { createBufferRoute } from './route.js'
import { BufferService } from './service.js'
import { registerBufferTool } from './tool.js'

export const name = '@nexus-aethra/dshell-buffer'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The host pipe service, so the session-deletion path can detach a
     * session's pipes. A distinct key from the client face's `dshellBuffer`
     * because this package compiles both halves in one program.
     */
    dshellBufferCore: BufferService
  }
}

export { DSHELL_BUFFER_PATH } from './protocol.js'
export type {
  BufferArea,
  BufferGrant,
  BufferLink,
  BufferReport,
  BufferRequest,
  BufferResponse,
  BufferRight,
  BufferState,
  BufferTicket,
  BufferTicketState,
} from './protocol.js'
export { BufferService } from './service.js'

/**
 * The section order the prompt paragraph takes: right after `TOOL_JOBS`, in the
 * run of tool-usage sections. A literal rather than `getSectionOrder` because
 * this is not one of dsh's reserved names.
 */
const PROMPT_ORDER = 1650

export function apply(ctx: Context): void {
  ctx.inject(['tools', 'systemPrompt', 'fs', 'sessionController', 'agents', 'dshellHostCopy'], (bufferCtx) => {
    // Structural read, the same one this package already uses for its own
    // `dshellBufferCore`: the Context accessor's declaration lives with the
    // PROVIDER (dshell-terminal-bridge), and a consumer's tsc program does not include
    // that package's source. The `inject` above is what guarantees it exists.
    const copy = bufferCtx.get('dshellHostCopy') as HostCopy
    // Bound once, read at call time by the notices and the route refusals, so
    // a language switch reaches the next message without a restart.
    const t = copy.bind(hostCopy)
    const service = new BufferService(bufferCtx, t)
    // Published for the session-deletion path: deleting a session must also
    // settle its tickets, revoke its grants and drop its pipes, and the
    // workspace package owns that path.
    bufferCtx.provide('dshellBufferCore', service)

    bufferCtx.effect(() => {
      service.start()
      return () => { service.dispose() }
    }, 'dshell-buffer: watchdog')

    bufferCtx.effect(() => registerBufferTool(bufferCtx, service), 'dshell-buffer: tool')

    // Assembled per turn WITH the agent, so the section can state this
    // session's live pipes (and where each peer runs) instead of describing
    // pipes in the abstract — see renderBufferPrompt.
    bufferCtx.effect(() => bufferCtx.systemPrompt.section({
      name: 'tool:dshell-buffer',
      order: PROMPT_ORDER,
      text: ({ agent }) => agent === undefined ? '' : renderBufferPrompt(service.promptPipes(String(agent.id))),
    }), 'dshell-buffer: prompt section')

    // The route needs the same service instance, so it is registered from
    // inside this injection rather than from a second `apply`-level inject.
    bufferCtx.inject(['connection'], (routeCtx) => {
      routeCtx.effect(
        () => routeCtx.connection.fetch.register(createBufferRoute({ service, ctx: routeCtx, t })),
        'dshell-buffer: pipe route',
      )
    })
  })
}

export default { name, apply }
