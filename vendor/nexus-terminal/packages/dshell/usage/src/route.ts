/**
 * The usage route: one exact `/api` endpoint behind dsh's existing trust and
 * authentication fence, mirroring the pipe and files routes' shape.
 *
 * Both halves of the feature go through it. Reading is the common case; the
 * scan is offered here too because it is the host that owns the session events
 * and the index, so the browser asks for one rather than doing one.
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { DSHELL_USAGE_PATH } from '@nexus-aethra/dshell-std'
import type { UsageRequest, UsageResponse } from './protocol.js'
import type { UsageStore } from './index-store.js'
import type { UsageScanner } from './scan.js'

/** What the route needs from the plugin that owns it. */
export interface UsageRouteDeps {
  readonly store: UsageStore
  readonly scanner: UsageScanner
}

/** JSON response in the shape the page parses. */
function respond(body: UsageResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** The window a request asks for, clamped so a hostile number cannot ask for a century. */
function windowOf(days: unknown): number | null {
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return null
  return Math.min(Math.trunc(days), 3650)
}

/** Bind the route to the index and the scanner. */
export function createUsageRoute(deps: UsageRouteDeps): ConnectionFetchRoute {
  const answer = async (request: Request): Promise<UsageResponse> => {
    if (request.method === 'GET') return deps.store.summary(null)
    const input = await request.json() as UsageRequest
    const days = windowOf(input.days)
    if (input.action === 'scan') {
      const outcome = await deps.scanner.rescan()
      // A rebuild is what the reader is waiting for, so the summary that
      // answers it is read after the scan, not before — and it carries the
      // scan's own counts, which the page reports.
      return {
        ...deps.store.summary(days),
        scanned: {
          sessions: outcome.sessions,
          read: outcome.read,
          turns: outcome.turns,
          skipped: outcome.skipped,
          ...outcome.skipReason === undefined ? {} : { skipReason: outcome.skipReason },
        },
      }
    }
    return deps.store.summary(days)
  }

  return {
    path: DSHELL_USAGE_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return respond(await answer(request))
      }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return respond({ error: reason }, 400)
      }
    },
  }
}
