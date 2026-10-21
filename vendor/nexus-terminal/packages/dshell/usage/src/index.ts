/**
 * dshell usage: the durable per-model token index and the settings page that
 * charts it.
 *
 * The host half is small on purpose. It owns one SQLite index under dshell's
 * data root, one scanner over `ctx.sessionQuery`, and one route; everything the
 * reader sees is folded from the same three. The page lives in `./client`.
 *
 * Nothing here subscribes to turns. A scan is requested — by the page on open,
 * or by the reader's rebuild action — and the scanner coalesces repeated
 * requests behind a minimum interval, so a host with a busy agent still writes
 * to disk at most once per window instead of once per model turn.
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { DSHELL_DATA_ROOT_SERVICE, type DshellDataRootSeat } from '@nexus-aethra/dshell-std'
import { closeUsageStore, openUsageStore, type UsageStore } from './index-store.js'
import { createUsageRoute } from './route.js'
import { UsageScanner, type UsageSessionQuery } from './scan.js'

export type * from './protocol.js'

/** The one service this package cannot compose without. */
export const inject = [DSHELL_DATA_ROOT_SERVICE] as const

/** The index file's name under `<data root>/usage/`. */
const INDEX_FILE = 'usage.sqlite'

export function apply(ctx: Context): void {
  void (async () => {
    const plan = await (ctx.get(DSHELL_DATA_ROOT_SERVICE) as DshellDataRootSeat).settled
    const path = join(plan.root, 'usage', INDEX_FILE)
    const store: UsageStore = openUsageStore(path)
    ctx.effect(() => () => { closeUsageStore(path) }, 'dshell-usage: close the index')

    // The scanner is built once the query engine is up, and the route is
    // registered from the same injection: both need it, and neither can be
    // constructed before it exists.
    ctx.inject(['sessionQuery', 'connection'], (usageCtx) => {
      const query = usageCtx.get('sessionQuery') as unknown as UsageSessionQuery
      const scanner = new UsageScanner(store, query)
      usageCtx.effect(() => () => { scanner.dispose() }, 'dshell-usage: stop the scanner')
      usageCtx.effect(
        () => usageCtx.connection.fetch.register(createUsageRoute({ store, scanner })),
        'dshell-usage: usage route',
      )
      console.info(`dshell-usage: index at ${path}`)
    })
  })()
}
