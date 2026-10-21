import type { DispatchContext, NexusServices } from '../ports/contracts.js';
import { AUTONOMY_HOOK_ACTOR } from '../domain/autonomy/index.js';
import type { HostContext } from './types.js';
import type { OperationController } from './lifecycle.js';
import { hostAuthority } from './host-adapter.js';
import { workspaceIdentity } from '../domain/workspace-runtime.js';

interface Lane {
  session: any; controller: AbortController; notices: Promise<unknown>;
  timer?: ReturnType<typeof setTimeout>; seen: Set<string>;
}

/** Live observations never wait inside native hooks, create user messages, or
 * cancel the native driver. Only the approved domain can ask its bridge to send. */
export function registerAutonomyHook(ctx: HostContext, services: NexusServices, controller: OperationController): () => void {
  const lanes = new Map<string, Lane>(), removers: Array<() => void> = [];
  let disposed = false;
  const warn = (error: any) => { try { ctx.logger?.warn('Nexus autonomy observation paused', error?.code ?? 'AUTONOMY_FAILED'); } catch { /* Observational. */ } };
  const permitted = (session: any) => session?.id && session.header?.origin !== 'subagent';
  const laneOf = (session: any): Lane => {
    let lane = lanes.get(session.id);
    if (!lane || lane.session !== session) {
      lane?.controller.abort();
      if (lane?.timer) clearTimeout(lane.timer);
      lane = { session, controller: new AbortController(), notices: Promise.resolve(), seen: new Set() };
      lanes.set(session.id, lane);
    }
    return lane;
  };
  const context = (lane: Lane, action: string, signal: AbortSignal): DispatchContext => ({
    scopeLevel: 'session', workspaceRoot: lane.session.header.cwd ?? services.workspaceRoot,
    sessionId: lane.session.id, actorId: AUTONOMY_HOOK_ACTOR, signal, permissions: new Set([`autonomy.${action}`]),
  });
  async function invoke(lane: Lane, action: string, params: Record<string, unknown>, id: string) {
    if (disposed || lanes.get(lane.session.id) !== lane) return;
    return controller.run(lane.controller.signal, signal => {
      const authority = context(lane, action, signal);
      return hostAuthority.run(authority, () => services.invoke('autonomy', {
        action, requestId: `autonomy-hook:${lane.session.id}:${id}`, params,
      }, authority));
    });
  }
  function schedule(lane: Lane, action: 'on-event' | 'tick', params: Record<string, unknown>, id: string, ms: number) {
    if (disposed) return;
    if (lane.timer) clearTimeout(lane.timer);
    lane.timer = setTimeout(() => {
      lane.timer = undefined;
      void lane.notices.catch(() => undefined).then(() => invoke(lane, action, params, id)).then((result: any) => {
        if (!disposed && result?.deferred && Number.isFinite(result.retryAfterMs) && result.retryAfterMs > 0 && !lane.timer) {
          schedule(lane, action, params, `${id}:cooldown:${result.revision ?? 0}`, Math.min(3_600_000, result.retryAfterMs + 100));
        }
      }).catch(warn);
    }, ms);
    lane.timer.unref?.();
  }
  function input(session: any, message: any, seq: number) {
    message = message?.message ?? message;
    if (!permitted(session) || message?.source?.kind !== 'user') return;
    const lane = laneOf(session), id = typeof message.id === 'string' ? message.id : `event-${seq}`;
    if (!lane.seen.has(id)) {
      lane.seen.add(id);
      if (lane.seen.size > 64) lane.seen.delete(lane.seen.values().next().value!);
      // Invalidate observations immediately at inbox admission, before the
      // queued human message can become model-visible on a later step.
      lane.controller.abort();
      lane.controller = new AbortController();
      lane.notices = lane.notices.catch(() => undefined).then(() =>
        invoke(lane, 'on-event', { kind: 'user', seq, messageId: id }, `user:${id}`));
      void lane.notices.catch(warn);
    }
    schedule(lane, 'on-event', { kind: 'observe' }, `observe:${id}:${seq}`, 8000);
  }
  const listen = (name: string, callback: (...args: any[]) => any) => {
    const remove = ctx.on(name, callback); if (typeof remove === 'function') removers.push(remove);
  };
  listen('agent/inbox/inserted', ({ agent, message }: any) => input(agent.session, message, Number(agent.session.seq)));
  listen('session/event', (session: any, event: any) => {
    if (!permitted(session) || !Number.isSafeInteger(event.seq) || !Number.isSafeInteger(session.firstLiveSeq)
      || event.seq < session.firstLiveSeq) return;
    if (event.type === 'user/message') { input(session, event.data, event.seq); return; }
    if (event.type !== 'turn/end') return;
    const lane = lanes.get(session.id);
    if (!lane) return;
    const reason = event.data?.reason?.kind ?? 'unknown';
    if (reason !== 'completed') {
      lane.controller.abort();
      lane.controller = new AbortController();
    }
    // A non-human producer never causes a new proposal. Existing approved
    // plans can still inspect only their own message-bound activation.
    void lane.notices.catch(() => undefined).then(() => invoke(lane, 'on-event',
      { kind: 'turn-end', reason }, `turn-end:${event.seq}`)).catch(warn);
    schedule(lane, 'tick', {}, `turn-tick:${event.seq}`, 1600);
  });
  listen('agent/status', ({ agent, status }: any) => {
    if (status !== 'idle' || !permitted(agent.session)) return;
    const lane = lanes.get(agent.id);
    if (lane) schedule(lane, 'tick', {}, `idle:${agent.session.seq}`, 100);
  });
  listen('nexus/event', ({ event, data }: any) => {
    if (event === 'scope/updated' && data?.feature === 'autonomy') {
      for (const lane of lanes.values()) {
        const matches = data.level === 'global' || data.workspace === workspaceIdentity(lane.session.header.cwd ?? services.workspaceRoot)
          && (data.level === 'workspace' || data.level === 'session' && data.sessionId === lane.session.id);
        if (!matches) continue;
        lane.controller.abort(); lane.controller = new AbortController();
        schedule(lane, 'tick', {}, `config:${lane.session.seq}`, 100);
      }
      return;
    }
    if (event !== 'autonomy/updated' || data?.status !== 'approved') return;
    let agent: any;
    try { agent = ctx.get('agents')?.get?.(data.sessionId); } catch { return; }
    if (!agent || !permitted(agent.session)) return;
    const lane = laneOf(agent.session);
    schedule(lane, 'tick', {}, `approval:${data.revision}`, 100);
  });
  listen('agent/disposed', ({ agent }: any) => {
    const lane = lanes.get(agent.id);
    if (!lane || lane.session !== agent.session) return;
    lane.controller.abort(); if (lane.timer) clearTimeout(lane.timer); lanes.delete(agent.id);
  });
  // Reading initializes the domain's persisted restart fence, without planning
  // from restored history or sending any continuation.
  void controller.run(undefined, signal => {
    const authority: DispatchContext = { scopeLevel: 'global', actorId: AUTONOMY_HOOK_ACTOR, signal, permissions: new Set(['autonomy.list']) };
    return hostAuthority.run(authority, () => services.invoke('autonomy', { action: 'list' }, authority));
  }).catch(warn);
  return () => {
    disposed = true;
    for (const remove of removers.reverse()) { try { remove(); } catch { /* Drain other listeners too. */ } }
    for (const lane of lanes.values()) { lane.controller.abort(); if (lane.timer) clearTimeout(lane.timer); }
    lanes.clear();
  };
}
