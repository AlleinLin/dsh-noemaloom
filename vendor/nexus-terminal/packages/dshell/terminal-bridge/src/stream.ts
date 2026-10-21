/**
 * The bridge's transport-neutral face: the same frames the `/dshell/pty`
 * upgrade carries, over routes on the shared API channel.
 *
 * Why both exist. The ws path is the browser's fast path — one socket, no
 * per-frame request, authenticated by the same cookie the rest of the app uses.
 * It needs `webServer`, though, and the desktop shell composes `connection`
 * without it (its transport is a framed byte pipe behind the `dsh-app://`
 * scheme, so there is no port to upgrade). A `connection.fetch` route is
 * reachable from every composition that has `connection`, which is why the
 * desktop shell can host a terminal at all.
 *
 * Two routes, not one, because a route is selected by exact path: the
 * downstream half is a long-lived GET whose body is newline-delimited JSON, and
 * the upstream half is a POST per control frame. They share the client's own
 * `clientId` — an HTTP stream has no socket to key on, so identity travels
 * explicitly. Everything below the carrier (spawning, buffering, block order,
 * reconnects) is the bridge's existing code, untouched.
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { DSHELL_STREAM_PATH, DSHELL_STREAM_SEND_PATH } from '@nexus-aethra/dshell-std'
import type { DshellTerminalBridge } from './index.js'

/** Frames one POST body may carry; a control frame is a handful of bytes. */
const MAX_CONTROL_BYTES = 64 * 1024

/** Response of a POST that the bridge accepted (or knowingly dropped). */
function accepted(): Response {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

/** Response of a POST the bridge could not read. */
function rejected(message: string): Response {
  return new Response(message, {
    status: 400,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * The downstream half: subscribe this response body to one session's frames.
 *
 * The GET carries what a ws would have sent as its first frame — the session
 * and which of its two shells to watch — because there is no socket to bind
 * later. Query parameters survive the desktop pipe and the browser alike, so
 * both carriers bind the same way.
 */
function downstream(bridge: DshellTerminalBridge, request: Request): Response {
  const url = new URL(request.url)
  const clientId = url.searchParams.get('clientId')
  const sessionId = url.searchParams.get('sessionId')
  const agent = url.searchParams.get('stream') === 'agent'
  if (clientId === null || clientId === '' || sessionId === null || sessionId === '') {
    return rejected('clientId and sessionId are required')
  }
  let detached = false
  const detach = (): void => {
    if (detached) return
    detached = true
    bridge.detachStream(clientId)
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      bridge.attachStream(clientId, sessionId, agent ? 'agent' : 'main', controller)
      // A browser abort (tab close, navigation) surfaces as request abort; the
      // cancel callback covers a consumer that stops reading instead.
      request.signal.addEventListener('abort', detach, { once: true })
    },
    cancel: detach,
  }, {
    // Bytes, not chunks: the subscriber's own guard measures how far behind it
    // is allowed to fall, and a chatty shell emits thousands of tiny frames.
    size: chunk => chunk.byteLength,
    highWaterMark: 1024 * 1024,
  })
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-store',
      // Proxies that buffer would turn a live terminal into a long silence.
      'x-accel-buffering': 'no',
    },
  })
}

/**
 * The upstream half: hand one control frame to the bridge.
 *
 * A POST for a `clientId` whose stream is gone is not an error — the client may
 * have sent it in the same tick its stream died, and the frame's subject (a
 * keystroke, a resize) is meaningless without it. Answering 204 keeps that
 * ordinary race out of the console; the bridge drops it either way.
 */
async function upstream(bridge: DshellTerminalBridge, request: Request): Promise<Response> {
  let raw: string
  try {
    raw = await request.text()
  } catch {
    return rejected('body could not be read')
  }
  if (raw.length > MAX_CONTROL_BYTES) return rejected('control frame is too large')
  let frame: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return rejected('body is not a frame object')
    }
    frame = parsed as Record<string, unknown>
  } catch {
    return rejected('body is not JSON')
  }
  const clientId = typeof frame.clientId === 'string' ? frame.clientId : undefined
  if (clientId === undefined) return rejected('clientId is required')
  bridge.handleStreamFrame(clientId, frame)
  return accepted()
}

/**
 * Build the two routes the connection layer registers.
 * @param bridge - the service that owns the shells and their subscribers.
 * @returns downstream GET first, then the upstream POST.
 */
export function createStreamRoutes(bridge: DshellTerminalBridge): readonly ConnectionFetchRoute[] {
  return [
    {
      path: DSHELL_STREAM_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => Promise.resolve(downstream(bridge, request)),
    },
    {
      path: DSHELL_STREAM_SEND_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => upstream(bridge, request),
    },
  ]
}
