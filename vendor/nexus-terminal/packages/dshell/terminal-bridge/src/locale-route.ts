/**
 * The locale report route: the browser tells the host which language it
 * actually resolved.
 *
 * dsh's language setting is a browser-side service; the host never sees the
 * locale a face is rendering in, which is why host-composed text drifted out of
 * language the moment the user switched. This route closes that: the browser
 * face posts the active locale on boot and on every change, and
 * `ctx.dshellHostCopy` prefers that report over the durable preference.
 *
 * It carries a preference, not a payload: no session, no authorization beyond
 * dsh's own connection gate, and an unrecognized id is ignored rather than
 * rejected — a newer face reporting a language this host has no dictionary for
 * must not break the host's copy.
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { DSHELL_LOCALE_PATH, type HostCopyReport } from '@nexus-aethra/dshell-std'
import type { HostCopyService } from './host-copy.js'

/** JSON response in the shape the browser face parses. */
function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Bind the report route to the host copy service.
 * @param copy - the service holding the reported locale.
 * @returns the route the host's connection layer can register.
 */
export function createLocaleRoute(copy: HostCopyService): ConnectionFetchRoute {
  return {
    path: DSHELL_LOCALE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      // The refusal is not user-visible: the only caller is dshell's own
      // reporter, which ignores the answer. Kept terse and in English for that
      // reason — there is no reader to translate for.
      if (request.method !== 'POST') return respond({ error: 'locale report expects POST' }, 405)
      try {
        const input = await request.json() as HostCopyReport
        copy.report(input.locale)
        return respond({ locale: copy.locale() })
      } catch {
        return respond({ locale: copy.locale() })
      }
    },
  }
}
