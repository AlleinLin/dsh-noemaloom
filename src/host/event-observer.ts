import { nativeErrorIdentity } from './native-diagnostics.js';
import type { HostContext } from './types.js';

/** Domain receipts own completion; optional invalidation listeners cannot veto it. */
export function createEventObserver(ctx: HostContext, remotes: Array<{ publish(event: string, data: unknown): unknown }>) {
  let nextDiagnosticAt = 0;
  const warn = (error: unknown) => {
    if (Date.now() < nextDiagnosticAt) return;
    nextDiagnosticAt = Date.now() + 30_000;
    try { ctx.logger?.warn('Nexus event observation deferred', nativeErrorIdentity(error, 'EVENT_OBSERVATION_FAILED')); }
    catch { /* Diagnostic listeners have no authority over a domain receipt. */ }
  };
  const observe = (action: () => unknown) => {
    try { void Promise.resolve(action()).catch(warn); } catch (error) { warn(error); }
  };
  return (event: string, data: unknown): void => {
    observe(() => {
      // Cordis emit ignores listener promises. parallel runs every listener
      // and exposes its aggregate rejection so this boundary can contain it.
      const parallel = (ctx as any).parallel;
      return typeof parallel === 'function' ? parallel.call(ctx, 'nexus/event', { event, data })
        : ctx.emit?.('nexus/event', { event, data });
    });
    for (const remote of remotes) observe(() => remote.publish(event, data));
  };
}
