/**
 * The port forward route: what a reader asks for, and what the forwarder says.
 *
 * It is a route of its own rather than a branch of the device route, because
 * the device route is about the DEVICE (what it is, how it is reached, what it
 * holds) and this is about the READER's machine (a socket in front of a port
 * there). The device route answers "what does the reader know about this
 * device"; this one answers "what can the reader open on this machine".
 *
 * The request names a SESSION, never a device: the session is what decides
 * which device is meant, the same rule every other session-scoped route here
 * follows. A session that runs on this machine has no device, and the route
 * says so rather than guessing a one.
 *
 * The forwarder is reached through a seat rather than imported, because the
 * forwarder lives with the transport and the route lives with the plugin body,
 * and the plugin body is what knows when the host is unloading.
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type {
  DshellForwardRequest, DshellForwardResponse, DshellForwardView,
} from '@nexus-aethra/dshell-std'
import { DSHELL_SSH_FORWARD_PATH } from '@nexus-aethra/dshell-std'
import type { DeviceConnection } from '../devices.js'
import type { SshRouter } from '../router.js'

/**
 * The forwarder, as the route sees it.
 *
 * Structural on purpose: the route does not need the forwarder's whole class,
 * and a route that imported the class would bind this route to this one
 * implementation of it.
 */
export interface ForwardSeat {
  /** Every forward this host holds. */
  list(): readonly DshellForwardView[]
  /** The forwards of one session. */
  listSession(sessionId: string): readonly DshellForwardView[]
  /** Open a forward, and say whether it is usable. */
  open(request: {
    readonly sessionId: string
    readonly device: DeviceConnection
    readonly devicePort: number
    readonly localPort: number
    readonly localAddress: string
  }): Promise<{ readonly view: DshellForwardView; readonly ok: boolean }>
  /** Stop one forward; whether there was one to stop. */
  stop(sessionId: string, localPort: number): boolean
}

/** What the route needs from the plugin that owns it. */
export interface ForwardRouteDeps {
  /** The forwarder the route drives. */
  readonly forwarder: ForwardSeat
  /** The device router, which says which device a session is on. */
  readonly router: SshRouter
  /** The address on the reader's own machine to listen on. */
  readonly localAddress?: string | undefined
}

/** The address a forward listens on when the route is not told otherwise. */
const DEFAULT_LOCAL_ADDRESS = '127.0.0.1'

/** JSON response in the shape the browser face parses. */
function respond(body: DshellForwardResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * The forward route.
 *
 * @param deps - the forwarder and the router.
 * @returns the route the host mounts.
 */
export function createForwardRoute(deps: ForwardRouteDeps): ConnectionFetchRoute {
  const handle = async (request: Request): Promise<DshellForwardResponse> => {
    const input = request.method === 'GET'
      ? { op: 'list' } as const
      : await request.json() as DshellForwardRequest
    switch (input.op) {
      case 'list':
        return { forwards: input.sessionId === undefined ? deps.forwarder.list() : deps.forwarder.listSession(input.sessionId) }
      case 'open': {
        // The SESSION decides the device, never the other way round: the same
        // rule every other session-scoped route here follows, and the reason a
        // request cannot name a device the reader has no session for.
        const target = deps.router.targetForSession(input.sessionId)
        if (target === undefined) {
          return {
            forwards: deps.forwarder.listSession(input.sessionId),
            error: 'this session does not run on a device',
          }
        }
        const opened = await deps.forwarder.open({
          sessionId: input.sessionId,
          device: target.device,
          devicePort: input.devicePort,
          localPort: input.localPort ?? 0,
          localAddress: deps.localAddress ?? DEFAULT_LOCAL_ADDRESS,
        })
        return {
          forwards: deps.forwarder.listSession(input.sessionId),
          forward: opened.view,
          error: opened.view.status === 'failed' ? opened.view.error : undefined,
        }
      }
      case 'stop': {
        const stopped = deps.forwarder.stop(input.sessionId, input.localPort)
        return {
          forwards: deps.forwarder.listSession(input.sessionId),
          error: stopped ? undefined : 'no such forward',
        }
      }
    }
  }

  return {
    path: DSHELL_SSH_FORWARD_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      try {
        return respond(await handle(request))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return respond({ forwards: [], error: reason }, 500)
      }
    },
  }
}
