/**
 * The bridge's HTTP face: one read of a session's shell history.
 *
 * The shell's own history is already recorded here — the command splitter pairs
 * every submitted line with its output and exit status, and the record list is
 * what the agent's terminal tool reads back. The composer needs the same list
 * for its up-arrow gesture, and it cannot get it from anywhere else: the
 * terminal's scrollback is a rendered stream, while these records are the lines
 * the user actually ran.
 *
 * The request carries the composer's draft, and the answer is the *newest*
 * commands starting with it (oldest first, so the list's bottom row stays the
 * newest match). Searching here rather than in the browser is what makes the
 * query cost independent of how much history exists: the bridge answers from
 * the durable store's index, so the rows the composer may match are not limited
 * to the ones it was sent — and the response stays bounded by `limit`.
 *
 * Read-only on purpose, and never spawning: a session without a live shell
 * answers with no commands rather than getting one created to answer a
 * question about it.
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { DSHELL_PTY_PATH, type DshellPtyCommand, type DshellPtyRequest, type DshellPtyResponse } from '@nexus-aethra/dshell-std'
import type { DshellTerminalBridgeHostTranslator } from './host-locales.js'
import type { DshellTerminalBridge } from './index.js'

// The wire contract lives in the shared standard layer and is re-exported here,
// so the bridge's own public surface (and every existing importer) is unchanged
// while there is exactly one declaration of it.
export { DSHELL_PTY_PATH }
export type { DshellPtyCommand, DshellPtyRequest, DshellPtyResponse }

/**
 * Commands one answer carries, as a bound on the response — not a mirror of the
 * bridge's retention. The store holds every command and answers a newest-match
 * query, so a caller asking for a prefix works over the whole history; this only
 * keeps one reply from growing with it.
 */
const MAX_HISTORY = 200

/** JSON response in the shape the browser face parses. */
function respond(body: DshellPtyResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Bind the history route to a bridge.
 * @param bridge - the service holding each session's command records.
 * @param t - the bridge's host copy, bound to the language the browser
 *   reported: the refusals below travel to the browser as `error`, so they
 *   must read in the language on screen.
 * @returns the route the host's connection layer can register.
 */
export function createPtyRoute(
  bridge: DshellTerminalBridge,
  t: DshellTerminalBridgeHostTranslator,
): ConnectionFetchRoute {
  return {
    path: DSHELL_PTY_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        if (request.method === 'GET') return respond({ error: t('route.postOnly') }, 400)
        const input = await request.json() as DshellPtyRequest
        if (input.action !== 'history') return respond({ error: t('route.unknownAction') }, 400)
        const limit = Math.max(1, Math.min(input.limit ?? MAX_HISTORY, MAX_HISTORY))
        const draft = input.draft ?? ''
        // A blank command is a tracked line that never assembled into one (the
        // splitter says so with ''), and offering it as history would be noise.
        const commands = (bridge.matchHistory(input.sessionId, draft, limit) ?? [])
          .filter(command => command.command.trim().length > 0)
          .map(command => ({
            command: command.command,
            exitCode: command.exitCode,
            at: command.at,
          }))
        return respond({ commands })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return respond({ error: reason }, 400)
      }
    },
  }
}
