/**
 * Native pre-step adapter for dsh-step-pause (MIT). No pause, send, retry or
 * replay primitive is introduced. The original driver owns all continuation.
 * See notices/step-pause/ and docs/step-progress.md.
 */
import { isAbsolute } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { effectiveSettings } from '../domain/scope.js';
import type { NexusServices } from '../ports/contracts.js';
import { boundedRead } from '../shared/bounded-read.js';
import { STEP_PAUSE_FEATURE, renderStepPausePrompt, resolveStepPauseOptions } from '../shared/step-pause.js';
import { NEXUS_SOURCE } from './source.js';
import type { HostContext } from './types.js';

export const STEP_PAUSE_READ_TIMEOUT_MS = 1500;
interface Position { session: object; turn: number; lastInjectedStep: number; reports: number }

export function registerStepPauseHook(ctx: HostContext, services: NexusServices): () => void {
  const states = new WeakMap<object, Position>(), retired = new WeakSet<object>();
  const lifetime = new AbortController(), removers: Array<() => void> = [];
  const warn = (code: string) => {
    // Diagnostics never include a custom prompt, workspace path or session body.
    try { ctx.logger?.warn('Nexus step progress skipped; native task continues', code); } catch {}
  };
  const listen = (name: string, callback: (...args: any[]) => any, options?: any) => {
    const remove = ctx.on(name, callback, options);
    if (typeof remove === 'function') removers.push(remove);
  };
  listen('agent/disposed', ({ agent }: any) => { if (agent && typeof agent === 'object') { retired.add(agent); states.delete(agent); } });
  listen('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
    // Do not catch native admission errors or call the waterfall twice.
    const accepted = await next();
    if (accepted?.kind !== 'enter' || !Array.isArray(accepted.messages)
      || lifetime.signal.aborted || services.signal?.aborted || payload?.signal?.aborted) return accepted;
    try {
      const { agent, turn, step, signal } = payload;
      const session = agent?.session, id = session?.id, root = session?.header?.cwd;
      if (!agent || typeof agent !== 'object' || retired.has(agent) || agent.id !== id
        || typeof id !== 'string' || !id || typeof root !== 'string' || !isAbsolute(root)
        || !Number.isSafeInteger(turn) || turn < 1 || !Number.isSafeInteger(step) || step < 2
        || !signal || typeof signal.addEventListener !== 'function') return accepted;
      const registry = ctx.get('agents');
      if (typeof registry?.get !== 'function' || registry.get(id) !== agent) { warn('STEP_PROGRESS_IDENTITY_UNAVAILABLE'); return accepted; }
      const old = states.get(agent);
      if (old && old.session === session && (old.turn > turn || old.turn === turn && old.lastInjectedStep >= step)) return accepted;
      const ownedSignal = AbortSignal.any([signal, lifetime.signal, ...(services.signal ? [services.signal] : [])]);
      const settings = await boundedRead(() => effectiveSettings(services.store, root,
        { scopeLevel: 'session', sessionId: id, workspaceRoot: root }, STEP_PAUSE_FEATURE), {
        signal: ownedSignal, timeoutMs: STEP_PAUSE_READ_TIMEOUT_MS,
        timeout: () => Object.assign(new Error('step progress settings timed out'), { code: 'STEP_PROGRESS_SETTINGS_TIMEOUT' }),
        cancelled: () => Object.assign(new Error('step progress cancelled'), { code: 'STEP_PROGRESS_CANCELLED' }),
      });
      if (ownedSignal.aborted || retired.has(agent) || agent.session !== session
        || ctx.get('agents')?.get?.(id) !== agent || session.header?.cwd !== root) return accepted;
      const options = resolveStepPauseOptions(settings.effective);
      if (!options.enabled || step % options.everyNSteps !== 0) return accepted;
      if (options.mainAgentOnly) {
        if (session.header?.origin === 'subagent' || Number(session.header?.delegationDepth) > 0) return accepted;
        // Runtime identity is independent of persisted parentSession/fork lineage.
        if (typeof registry.roots !== 'function' || !registry.roots().includes(agent)) return accepted;
      }
      let state = states.get(agent);
      if (!state || state.session !== session || state.turn < turn) state = { session, turn, lastInjectedStep: 0, reports: 0 };
      if (state.turn !== turn || state.lastInjectedStep >= step
        || options.maxReportsPerTurn > 0 && state.reports >= options.maxReportsPerTurn) return accepted;
      const text = renderStepPausePrompt(options.prompt, { step, every: options.everyNSteps, turn });
      const meta = { producer: NEXUS_SOURCE, purpose: 'step-progress', sessionId: id, turn, step };
      // User kind is opt-in debug visibility, matching upstream; the default
      // retains a producer source so autonomy/companion do not see human input.
      const source = options.showPromptInChat ? { kind: 'user' as const, meta }
        : { kind: NEXUS_SOURCE, meta };
      const notice = createUserMessage({ content: [{ type: 'text', text }], source });
      const decorated = { ...accepted, messages: [...accepted.messages, notice] };
      state.lastInjectedStep = step; state.reports++;
      states.set(agent, state);
      return decorated;
    } catch (error) {
      if (!payload?.signal?.aborted && !lifetime.signal.aborted && !services.signal?.aborted) {
        warn(typeof (error as any)?.code === 'string' ? (error as any).code : 'STEP_PROGRESS_DECORATION_FAILED');
      }
      return accepted;
    }
  }, { prepend: true });
  return () => {
    lifetime.abort();
    for (const remove of removers.reverse()) { try { remove(); } catch { warn('STEP_PROGRESS_UNREGISTER_FAILED'); } }
    removers.length = 0;
  };
}
