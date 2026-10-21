import type { NexusServices } from '../ports/contracts.js';
import type { HostContext } from './types.js';
import type { OperationController } from './lifecycle.js';
import { hostAuthority } from './host-adapter.js';
import { isHumanInputMessage } from '../shared/step-pause.js';

/** Coalesce phase changes; no render-driven requests and no historical replay.
 * Tool deltas and reasoning tokens never trigger auxiliary model calls. */
export function registerInsightsHook(ctx: HostContext, services: NexusServices, controller: OperationController): () => void {
  const queued = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;
  const stop = ctx.on('session/event', (session: any, event: any) => {
    if (event.seq < session.firstLiveSeq || !['turn/end', 'user/message'].includes(event.type)) return;
    if (event.type === 'user/message' && !isHumanInputMessage(event.data?.message ?? event.data)) return;
    const old = queued.get(session.id);
    if (old) clearTimeout(old);
    const run = (retry = false) => {
      queued.delete(session.id);
      if (disposed) return;
      void controller.run(undefined, signal => {
        const context = { scopeLevel: 'session' as const, sessionId: session.id, workspaceRoot: session.header.cwd ?? services.workspaceRoot,
          actorId: 'nexus-insights-hook', signal, permissions: new Set(['insights.on-event']) };
        return hostAuthority.run(context, () => services.invoke('insights', {
          action: 'on-event', requestId: `insights-event:${session.id}:${event.seq}${retry ? ':after-cooldown' : ''}`, params: {},
        }, context));
      }).then((result: any) => {
        if (!disposed && !retry && !queued.has(session.id) && result?.state === 'deferred' && result.reason === 'cooldown' && result.retryAfterMs > 0) {
          const follow = setTimeout(() => run(true), Math.min(300000, result.retryAfterMs + 100));
          follow.unref?.(); queued.set(session.id, follow);
        }
      }).catch(error => ctx.logger?.warn('Nexus task analysis deferred', error?.code ?? 'INTERNAL'));
    };
    const timer = setTimeout(() => run(), event.type === 'turn/end' ? 1500 : 8000);
    timer.unref?.();
    queued.set(session.id, timer);
  });
  return () => { disposed = true; if (typeof stop === 'function') stop(); for (const timer of queued.values()) clearTimeout(timer); queued.clear(); };
}
