/**
 * The transfer route: one exact `/api` endpoint behind dsh's trust and
 * authentication fence, a sibling of the file navigator's route.
 *
 * A separate path rather than another action on that route, because the subject
 * is different: this one names TWO execution worlds and starts work that
 * outlives the request. `copy` answers with a job immediately and the view polls
 * it, so a long directory copy has a progress line and a cancel button instead
 * of a request that hangs.
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { TransferRequest, TransferResponse } from './transfer-protocol.js'
import { DSHELL_TRANSFER_PATH } from './transfer-protocol.js'
import type { TransferEngine } from './transfer.js'

/** JSON response in the shape the browser face parses. */
function respond(body: TransferResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Bind the route to the transfer engine. */
export function createTransferRoute(engine: TransferEngine): ConnectionFetchRoute {
  const handle = async (request: Request): Promise<TransferResponse> => {
    if (request.method === 'GET') return { error: '文件传输只接受 POST' }
    const input = await request.json() as TransferRequest
    switch (input.action) {
      case 'state':
        return { setup: await engine.setup(input.sessionId) }
      case 'list':
        return { listing: await engine.list(input.sessionId, input.side, input.path) }
      case 'copy':
        return {
          job: engine.start({
            sessionId: input.sessionId,
            from: input.from,
            to: input.to,
            fromPath: input.fromPath,
            toDir: input.toDir,
            overwrite: input.overwrite === true,
          }),
        }
      case 'job': {
        const job = engine.get(input.jobId)
        return job === undefined ? { error: '这次传输的记录已经不在了。' } : { job }
      }
      case 'cancel': {
        const job = engine.cancel(input.jobId)
        return job === undefined ? { error: '这次传输的记录已经不在了。' } : { job }
      }
      default:
        return { error: '未知操作' }
    }
  }

  return {
    path: DSHELL_TRANSFER_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return respond(await handle(request))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return respond({ error: reason }, 400)
      }
    },
  }
}
