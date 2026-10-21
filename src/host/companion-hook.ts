import type { DispatchContext, NexusServices } from '../ports/contracts.js';
import { randomUUID } from 'node:crypto';
import type { HostContext } from './types.js';
import type { OperationController } from './lifecycle.js';
import { hostAuthority } from './host-adapter.js';
import { auxiliarySettings } from '../domain/insights/auxiliary.js';
import { workspaceIdentity } from '../domain/workspace-runtime.js';
import { THOROUGH_PROMPT } from '../domain/insights/companion.js';

/** Auxiliary failures never enter main-agent recovery, mutate its messages,
 * or dispose its activation. Each lane owns its cancellation lifetime. */
export function registerCompanionHook(ctx: HostContext, services: NexusServices, controller: OperationController): () => void {
  const lanes = new Map<string, { session: any; controller: AbortController; invalidating?: Promise<void>; timer?: ReturnType<typeof setTimeout>; active: boolean; inputId?: string; inputArrived?: () => void }>();
  const removers: Array<() => void> = [];
  let disposed = false;
  const laneOf = (session: any) => {
    let lane = lanes.get(session.id);
    if (!lane || lane.session !== session) {
      lane?.controller.abort(); if (lane?.timer) clearTimeout(lane.timer);
      lane = { session, controller: new AbortController(), active: false }; lanes.set(session.id, lane);
    }
    return lane;
  };
  const context = (lane: ReturnType<typeof laneOf>, action: string, signal: AbortSignal): DispatchContext => ({
    scopeLevel: 'session', sessionId: lane.session.id, workspaceRoot: lane.session.header.cwd ?? services.workspaceRoot,
    actorId: 'nexus-companion-hook', permissions: new Set([`companion.${action}`]), signal,
  });
  async function invoke(lane: ReturnType<typeof laneOf>, action: string, params: Record<string, unknown> = {}, turnSignal?: AbortSignal) {
    if (disposed) return;
    // Capture the preceding invalidation before a new invalidate installs its
    // own promise. Durable dispatcher leases can otherwise let observe pass
    // an earlier input's invalidation, which then clears a newly opened gate.
    const invalidating = lane.invalidating;
    return controller.run(AbortSignal.any([lane.controller.signal, ...(turnSignal ? [turnSignal] : [])]), async signal => {
      await invalidating;
      signal.throwIfAborted();
      const authority = context(lane, action, signal);
      // Native callbacks have no dispatcher parent intent to supply a child ID.
      // Each admission must also avoid replaying an older observe receipt.
      return hostAuthority.run(authority, () => services.invoke('companion', {
        action, params, requestId: `companion-hook:${action}:${randomUUID()}`,
      }, authority));
    });
  }
  const warn = (error: any) => { try { ctx.logger?.warn('Nexus independent companion unavailable; main task continues', error?.code ?? 'AUXILIARY_FAILED'); } catch {} };
  const listen = (name: string, callback: (...args: any[]) => any) => { const remove = ctx.on(name, callback); if (typeof remove === 'function') removers.push(remove); };
  const eligible = (session: any) => session?.id && session.header?.origin !== 'subagent';
  function invalidate(lane: ReturnType<typeof laneOf>) {
    lane.controller.abort(); lane.controller = new AbortController();
    if (lane.timer) clearTimeout(lane.timer); lane.timer = undefined;
    lane.invalidating = invoke(lane, 'invalidate').then(() => undefined, warn);
  }
  listen('agent/inbox/inserted', ({ agent, message }: any) => {
    if (!eligible(agent.session) || message?.source?.kind !== 'user') return;
    const lane = laneOf(agent.session);
    const text = (message.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    if (lane.active && text === THOROUGH_PROMPT) { lane.inputId = message.id; lane.inputArrived?.(); return; }
    invalidate(lane);
  });
  listen('agent/pre-step', async ({ agent, messages, signal, turn }: any, next: () => Promise<any>) => {
    const accepted = await next();
    if (accepted.kind !== 'enter' || !eligible(agent.session) || signal.aborted || disposed) return accepted;
    const lane = laneOf(agent.session);
    try {
      lane.active = true;
      const result: any = await invoke(lane, 'observe', { admitted: accepted.messages ?? messages }, signal);
      if (result?.gate?.state === 'pending' && !signal.aborted) {
        // claim(next-turn) is the official driver's durable consumption verb;
        // splice/remove would record cancellation and must never stand in for it.
        if (agent.inbox.nextTurn.some((m: any) => m.id !== lane.inputId) || agent.inbox.nextStep.length || typeof agent.inbox.claim !== 'function') {
          await invoke(lane, 'invalidate');
        } else {
          const choice: any = await invoke(lane, 'wait-gate', {}, signal);
          if (choice?.gate?.state === 'sent' && !lane.inputId && !signal.aborted) {
            await new Promise<void>(resolve => {
              const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); lane.inputArrived = undefined; resolve(); };
              const timer = setTimeout(done, 10000); lane.inputArrived = done;
              signal.addEventListener('abort', done, { once: true }); if (lane.inputId || signal.aborted) done();
            });
          }
          if (choice?.gate?.state === 'sent' && lane.inputId && !signal.aborted
            && agent.inbox.nextTurn.length === 1 && agent.inbox.nextTurn[0]?.id === lane.inputId && !agent.inbox.nextStep.length) {
            const batch = agent.inbox.claim('next-turn', turn);
            return { ...accepted, messages: [...accepted.messages, ...batch] };
          }
        }
      }
    } catch (error) { warn(error); }
    finally { lane.active = false; lane.inputId = undefined; lane.inputArrived = undefined; }
    return accepted;
  });
  listen('session/event', (session: any, event: any) => {
    if (!eligible(session) || event.seq < session.firstLiveSeq) return;
    const lane = lanes.get(session.id); if (!lane) return;
    if (event.type === 'turn/end' && event.data?.reason?.kind !== 'completed') { invalidate(lane); return; }
    if (event.type !== 'turn/end' || lane.active) return;
    const timer = setTimeout(() => { lane.timer = undefined; void invoke(lane, 'observe', { checkpoint: 'turn-end' }).catch(warn); }, 500);
    timer.unref?.(); if (lane.timer) clearTimeout(lane.timer); lane.timer = timer;
  });
  listen('agent/status', ({ agent, status }: any) => {
    if (!eligible(agent.session) || status !== 'running') return;
    const lane = laneOf(agent.session);
    void auxiliarySettings(services, context(lane, 'settings', lane.controller.signal)).then(config => {
      if (disposed || lane.controller.signal.aborted || !config.enabled || lane.timer) return;
      const check = () => {
        lane.timer = undefined;
        if (disposed || lane.controller.signal.aborted || agent.status !== 'running') return;
        void (lane.active ? Promise.resolve() : invoke(lane, 'observe')).catch(warn).finally(() => {
          if (!disposed && !lane.controller.signal.aborted && agent.status === 'running') { lane.timer = setTimeout(check, config.minIntervalMs); lane.timer.unref?.(); }
        });
      };
      lane.timer = setTimeout(check, config.minIntervalMs); lane.timer.unref?.();
    }).catch(warn);
  });
  listen('nexus/event', ({ event, data }: any) => {
    if (event !== 'scope/updated' || data?.feature !== 'auxiliary') return;
    for (const lane of lanes.values()) {
      if (data.level === 'global' || data.workspace === workspaceIdentity(lane.session.header.cwd ?? services.workspaceRoot)
        && (data.level === 'workspace' || data.sessionId === lane.session.id)) invalidate(lane);
    }
  });
  listen('agent/disposed', ({ agent }: any) => {
    const lane = lanes.get(agent.id); if (!lane || lane.session !== agent.session) return;
    invalidate(lane); lanes.delete(agent.id);
  });
  return () => { disposed = true; for (const stop of removers.reverse()) stop(); for (const lane of lanes.values()) { lane.controller.abort(); if (lane.timer) clearTimeout(lane.timer); } lanes.clear(); };
}
