import { randomUUID } from 'node:crypto';
import { appendPluginRecord, SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { LlmRetryEventData } from '@deepseek-ai/dsh-llm-retry';
import { ProviderRequestId, type ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import { classifyFailure, ERROR_CODES, type FailureDiagnosis } from '../shared/error-codes.js';
import { nativeErrorIdentity, nativeFailureFacts } from './native-diagnostics.js';
import type { HostContext } from './types.js';
import { nativeCompactionFor } from './compaction-binding.js';
import { effectiveSettings } from '../domain/scope.js';
import { boundedRead } from '../shared/bounded-read.js';
import { REQUEST_RETRY_FEATURE, requestRetryDelay, resolveRequestRetryOptions, type RequestRetryOptions } from '../shared/request-retry.js';

const RECORD = 'plugin:nexus/request-recovery';
const STATE = 'nexusRequestRecovery';
const CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const TOKEN = /^[a-zA-Z0-9._:/-]{1,160}$/;
const TRACE = /^trace_[a-zA-Z0-9_-]{1,96}$/;
const ERROR_NAME = /^[A-Za-z_$][A-Za-z0-9_.$-]{0,79}$/;
const STACK_FRAME = /^(?:[A-Za-z0-9_.$<>\[\]-]+@)?[A-Za-z0-9_.$<>\[\]-]+\.(?:[cm]?[jt]s|[jt]sx):[1-9][0-9]*:[1-9][0-9]*$/;
const ABORT_SOURCES = new Set(['user', 'parent', 'hook', 'disposed', 'plugin', 'unattributed', 'active']);
const TERMINAL_KINDS = new Set(['stop', 'tool-calls', 'max-tokens', 'error', 'aborted']);
const OUTCOMES = new Set(['delegated', 'scheduled', 'retry-started', 'stopped', 'recovered', 'failed', 'deferred']);
const STOP_REASONS = new Set([
  'retry-exhausted', 'retry-disabled', 'retry-delay-unsupported', 'not-retryable',
  'signal-aborted', 'user-cancelled', 'parent-cancelled', 'hook-cancelled',
  'agent-disposed', 'plugin-disposed', 'authorization-denied', 'quota-denied',
  'budget-denied', 'session-deleted', 'recovery-handler-failed',
  'recovery-state-unavailable', 'recovery-record-failed', 'native-retry-stopped',
  'context-compactor-unavailable', 'context-compacted', 'no-proven-context-reduction', 'no-safe-bounded-range', 'summary-model-declined-safe-range',
  'retry-settings-unavailable',
]);

export interface RequestRecoveryDiagnostic {
  schemaVersion: 1;
  id: string;
  at: string;
  sessionId: string;
  diagnosticCode: string;
  canonicalCode: string;
  phase: string;
  outcome: 'delegated' | 'scheduled' | 'retry-started' | 'stopped' | 'recovered' | 'failed' | 'deferred';
  retry: number;
  turn?: number;
  step?: number;
  maxRetries?: number;
  delayMs?: number;
  stopReason?: string;
  status?: number;
  requestId?: string;
  provider?: string;
  traceId?: string;
  source?: 'native-retry' | 'nexus-fallback' | 'observer';
  attemptId?: string;
  logicalCallId?: string;
  model?: string;
  signalAborted?: boolean;
  errorName?: string;
  causeCodes?: string[];
  stackFrames?: string[];
  abortSource?: 'user' | 'parent' | 'hook' | 'disposed' | 'plugin' | 'unattributed' | 'active';
  terminalKind?: 'stop' | 'tool-calls' | 'max-tokens' | 'error' | 'aborted';
  terminalObserved?: boolean;
  tailElapsedMs?: number;
  beforeTokens?: number;
  afterTokens?: number;
  hostCompactionId?: string;
  maintenanceCode?: string;
  providerRetryAfterMs?: number;
}
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:nexus/request-recovery': RequestRecoveryDiagnostic;
  }
}
interface RetryEntry { retry: number; retryId: string }
type RecoveryState = Record<string, RetryEntry>;
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { nexusRequestRecovery: RecoveryState }
}
interface RecoveryPayload {
  agent: { id: string; session: Session };
  turn: number;
  step: number;
  provider: string;
  failure: { code: string; message: string; providerRetryAfterMs?: number };
  retryPolicy?: ResolvedRetryPolicy;
  signal: AbortSignal;
  recoveryStage?: 'preparation';
}
type Decision = { kind: 'retry' } | undefined;

function token(value: unknown, pattern = TOKEN): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}
function count(value: unknown, max = 10_000): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
}
function boundedStrings(value: unknown, maxItems: number, pattern: RegExp, maxLength = Infinity): string[] | undefined {
  if (!Array.isArray(value)) return;
  const length = value.length;
  if (length > maxItems) return;
  const copy: string[] = [];
  for (let index = 0; index < length; index++) {
    const item = value[index];
    if (typeof item !== 'string' || item.length > maxLength || !pattern.test(item)) return;
    copy.push(item);
  }
  return copy;
}
function liveSession(ctx: HostContext, sessionId: string): Session | undefined {
  // These are official live registries; never recover a detached Session from a
  // log snapshot or cache, and never create a session merely to write a record.
  try {
    const session = ctx.get('agents')?.get?.(sessionId)?.session;
    if (session?.id === sessionId) return session;
  } catch { /* The live-session registry remains an independent fallback. */ }
  try {
    const session = ctx.get('sessions')?.get?.(SessionId(sessionId));
    return session?.id === sessionId ? session : undefined;
  } catch { return undefined; }
}
function safeLog(ctx: HostContext, data: RequestRecoveryDiagnostic): void {
  try { ctx.logger?.warn('Nexus request recovery diagnostic', data); } catch { /* Observational only. */ }
}
function sanitize(sessionId: string, facts: Record<string, unknown>): RequestRecoveryDiagnostic {
  const diagnosticCode = typeof facts.diagnosticCode === 'string' && Object.hasOwn(ERROR_CODES, facts.diagnosticCode)
    ? facts.diagnosticCode : 'NX_UNKNOWN_FAILURE';
  const defaultOutcome = diagnosticCode === 'NX_STREAM_TAIL_RECOVERED' ? 'recovered'
    : diagnosticCode === 'NX_OBSERVATION_DEFERRED' ? 'deferred' : 'failed';
  const defaultCanonical = diagnosticCode === 'NX_STREAM_TAIL_RECOVERED' ? 'STREAM_TAIL_RECOVERED'
    : diagnosticCode === 'NX_OBSERVATION_DEFERRED' ? 'OBSERVATION_DEFERRED' : 'UNCLASSIFIED_FAILURE';
  const data: RequestRecoveryDiagnostic = {
    schemaVersion: 1, id: `recovery_${randomUUID()}`, at: new Date().toISOString(), sessionId,
    diagnosticCode, canonicalCode: token(facts.canonicalCode, CODE) ?? defaultCanonical,
    phase: token(facts.phase) ?? 'request-error',
    outcome: OUTCOMES.has(String(facts.outcome)) ? facts.outcome as RequestRecoveryDiagnostic['outcome'] : defaultOutcome,
    retry: count(facts.retry) ? facts.retry : 0,
  };
  for (const key of ['turn', 'step', 'maxRetries'] as const) {
    const value = facts[key];
    if (count(value, key === 'maxRetries' ? 10_000 : Number.MAX_SAFE_INTEGER)) data[key] = value;
  }
  if (count(facts.delayMs, Number.MAX_SAFE_INTEGER)) data.delayMs = facts.delayMs;
  if (typeof facts.providerRetryAfterMs === 'number' && Number.isFinite(facts.providerRetryAfterMs)
      && facts.providerRetryAfterMs >= 0 && facts.providerRetryAfterMs <= Number.MAX_SAFE_INTEGER) data.providerRetryAfterMs = facts.providerRetryAfterMs;
  for (const key of ['beforeTokens', 'afterTokens'] as const) {
    if (count(facts[key], Number.MAX_SAFE_INTEGER)) data[key] = facts[key] as number;
  }
  const hostCompactionId = token(facts.hostCompactionId);
  if (hostCompactionId) data.hostCompactionId = hostCompactionId;
  const maintenanceCode = token(facts.maintenanceCode, CODE);
  if (maintenanceCode) data.maintenanceCode = maintenanceCode;
  if (typeof facts.stopReason === 'string' && (STOP_REASONS.has(facts.stopReason)
    || /^(?:OBSERVATION_|CTX_)[A-Z0-9_]{1,64}$/.test(facts.stopReason))) data.stopReason = facts.stopReason;
  if (Number.isInteger(facts.status) && Number(facts.status) >= 100 && Number(facts.status) <= 599) data.status = Number(facts.status);
  for (const key of ['requestId', 'provider', 'attemptId', 'logicalCallId', 'model'] as const) {
    const value = token(facts[key]);
    if (value) data[key] = value;
  }
  data.traceId = token(facts.traceId, TRACE) ?? `trace_${randomUUID()}`;
  if (['native-retry', 'nexus-fallback', 'observer'].includes(String(facts.source))) {
    data.source = facts.source as RequestRecoveryDiagnostic['source'];
  }
  if (typeof facts.signalAborted === 'boolean') data.signalAborted = facts.signalAborted;
  const errorName = token(facts.errorName, ERROR_NAME);
  if (errorName) data.errorName = errorName;
  const causeCodes = boundedStrings(facts.causeCodes, 6, CODE);
  if (causeCodes) data.causeCodes = causeCodes;
  const stackFrames = boundedStrings(facts.stackFrames, 8, STACK_FRAME, 180);
  if (stackFrames) data.stackFrames = stackFrames;
  if (typeof facts.abortSource === 'string' && ABORT_SOURCES.has(facts.abortSource)) data.abortSource = facts.abortSource as RequestRecoveryDiagnostic['abortSource'];
  if (typeof facts.terminalKind === 'string' && TERMINAL_KINDS.has(facts.terminalKind)) data.terminalKind = facts.terminalKind as RequestRecoveryDiagnostic['terminalKind'];
  if (typeof facts.terminalObserved === 'boolean') data.terminalObserved = facts.terminalObserved;
  if (typeof facts.tailElapsedMs === 'number' && Number.isFinite(facts.tailElapsedMs)
    && facts.tailElapsedMs >= 0 && facts.tailElapsedMs <= 86_400_000) data.tailElapsedMs = facts.tailElapsedMs;
  return data;
}

/** No raw error/body/prompt is retained; diagnostics must never own a failure. */
export async function recordRecoveryDiagnostic(
  ctx: HostContext,
  sessionId: string,
  facts: { diagnosticCode: string; phase: string; [key: string]: unknown },
): Promise<void> {
  try {
    if (!token(sessionId)) return;
    const data = sanitize(sessionId, facts);
    // A caller may be observing session/event. Leave its synchronous append
    // publication before writing our ignorable, non-surface plugin record.
    await Promise.resolve();
    const session = liveSession(ctx, sessionId);
    if (!session) { safeLog(ctx, data); return; }
    try { appendPluginRecord(session, RECORD, data); }
    catch { safeLog(ctx, data); }
  } catch { /* Includes hostile getters, unavailable services and broken logging. */ }
}

function stateKey(payload: Pick<RecoveryPayload, 'turn' | 'step' | 'provider'>): string {
  return JSON.stringify([payload.turn, payload.step, payload.provider]);
}
function foldRecovery(state: RecoveryState, event: SessionEvent): RecoveryState {
  if (event.type === 'step/start' || event.type === 'turn/end') return {};
  if (event.type !== 'llm/retry') return state;
  const data = event.data;
  if (!count(data.turn, Number.MAX_SAFE_INTEGER) || !count(data.step, Number.MAX_SAFE_INTEGER)
    || typeof data.provider !== 'string' || !token(data.retryId)) return state;
  const key = stateKey(data);
  const previous = state[key]?.retry ?? 0;
  return { ...state, [key]: { retry: Math.min(previous + 1, 10_000), retryId: data.retryId } };
}
function validPolicy(policy: ResolvedRetryPolicy | undefined): policy is ResolvedRetryPolicy {
  if (!policy || !['normal', 'always'].includes(policy.mode)) return false;
  if (![policy.initialDelayMs, policy.maxDelayMs].every(value => Number.isFinite(value) && value >= 0 && value <= 2_147_483_647)
    || !Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) return false;
  return policy.mode === 'always' || count(policy.maxRetries) && Array.isArray(policy.retryableCodes)
    && policy.retryableCodes.every(code => Boolean(token(code, CODE)));
}
function signalStop(signal: AbortSignal): string {
  const kind = signal.reason?.kind;
  if (kind === 'user') return 'user-cancelled';
  if (kind === 'parent') return 'parent-cancelled';
  if (kind === 'disposed') return 'agent-disposed';
  if (kind === 'hook') return 'hook-cancelled';
  return 'signal-aborted';
}
function delay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let remaining = delayMs;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(ready);
    };
    const onAbort = () => finish(false);
    const schedule = () => {
      // Node clamps larger delays to 1ms. Split long provider waits instead of
      // accidentally flooding the provider or stopping recovery altogether.
      const part = Math.min(remaining, 2_147_483_647);
      timer = setTimeout(() => {
        remaining -= part;
        if (remaining > 0) schedule(); else finish(true);
      }, part);
    };
    schedule();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function configuredRetry(ctx: HostContext, agent: RecoveryPayload['agent'], signal: AbortSignal,
  lastKnown?: RequestRetryOptions): Promise<RequestRetryOptions> {
  const services = ctx.get('nexus')?.services;
  if (!services?.store) {
    if (lastKnown) throw new Error('retry settings service unavailable');
    return resolveRequestRetryOptions({});
  }
  const root = agent.session.header.cwd ?? services.workspaceRoot;
  const settings = await boundedRead(() => effectiveSettings(services.store, root,
    { scopeLevel: 'session', sessionId: agent.id, workspaceRoot: root }, REQUEST_RETRY_FEATURE), {
    signal, timeoutMs: 2000, timeout: () => new Error('retry settings unavailable'),
    cancelled: () => new Error('retry settings cancelled'),
  });
  return resolveRequestRetryOptions(settings.effective);
}

/** Recover only at the official same-turn seam; never synthesize user input. */
export function registerRequestRecovery(ctx: HostContext): () => void {
  const lifetime = new AbortController();
  const active = new Set<Promise<Decision>>();
  const waits = new Set<{ agent: RecoveryPayload['agent']; controller: AbortController }>();
  const disposedAgents = new WeakSet<object>();
  const disposedSessions = new WeakSet<object>();
  const configuredPolicies = new WeakMap<object, RequestRetryOptions>();
  const removers: Array<() => void> = [];
  let projections: any;
  let stateReady = false;
  try {
    projections = ctx.get('sessionProjections');
    if (typeof projections?.register === 'function') {
      const remove = projections.register({
        key: STATE, stateVersion: 1,
        stateSchema: z.record(z.string(), z.object({ retry: z.number().int().min(0).max(10_000), retryId: z.string().max(160) })),
        init: () => ({}), apply: foldRecovery,
      });
      if (typeof remove === 'function') removers.push(remove);
      stateReady = true;
    }
  } catch { /* A missing durable counter disables only the fallback executor. */ }

  const diagnostic = (payload: RecoveryPayload, diagnosis: FailureDiagnosis, facts: Record<string, unknown>) => {
    let traceId: string | undefined;
    try { traceId = nativeErrorIdentity(payload.failure, diagnosis.canonicalCode).traceId; } catch { /* Helper mints a safe fallback. */ }
    return recordRecoveryDiagnostic(ctx, String(payload.agent.id), {
      ...diagnosis, ...nativeFailureFacts(payload.failure, payload.signal),
      providerRetryAfterMs: payload.failure.providerRetryAfterMs,
      traceId, turn: payload.turn, step: payload.step, provider: payload.provider,
      source: 'observer', ...facts,
    });
  };
  const stateOf = (session: Session, key: string): any => {
    try { return projections?.stateOf?.(session, key); } catch { return undefined; }
  };
  const currentRetry = (payload: RecoveryPayload): number => stateOf(payload.agent.session, STATE)?.[stateKey(payload)]?.retry ?? 0;

  async function recover(payload: RecoveryPayload): Promise<Decision> {
    const { agent, signal } = payload;
    const local = { agent, controller: new AbortController() };
    waits.add(local);
    const fused = AbortSignal.any([signal, lifetime.signal, local.controller.signal]);
    const stopped = () => signal.aborted ? signalStop(signal) : lifetime.signal.aborted ? 'plugin-disposed'
      : disposedSessions.has(agent.session) ? 'session-deleted'
      : disposedAgents.has(agent) || local.controller.signal.aborted ? 'agent-disposed' : undefined;
    const diagnosis = classifyFailure(payload.failure, { phase: 'request-error', signalAborted: signal.aborted });
    const stop = async (stopReason: string, diagnosticCode = diagnosis.diagnosticCode, source = 'observer', retry = currentRetry(payload), maxRetries?: number) => {
      await diagnostic(payload, diagnosis, { diagnosticCode, outcome: 'stopped', stopReason, source, retry,
        ...(maxRetries === undefined ? {} : { maxRetries }) });
      return undefined;
    };
    try {
      const initialStop = stopped();
      if (initialStop) return await stop(initialStop, 'NX_CANCELLED');
      const unattributedAbort = diagnosis.diagnosticCode === 'NX_ABORT_UNATTRIBUTED';
      const policy = validPolicy(payload.retryPolicy) ? payload.retryPolicy : undefined;
      let configured: RequestRetryOptions;
      try {
        configured = await configuredRetry(ctx, agent, fused, configuredPolicies.get(agent));
        configuredPolicies.set(agent, configured);
      }
      catch {
        if (stopped()) return await stop(stopped()!, 'NX_CANCELLED');
        configured = configuredPolicies.get(agent) ?? resolveRequestRetryOptions({});
        await diagnostic(payload, diagnosis, { diagnosticCode: 'NX_RECOVERY_FAILED', phase: 'retry-settings',
          outcome: 'deferred', stopReason: 'retry-settings-unavailable', retry: currentRetry(payload),
          maxRetries: configured.maxRetries });
      }
      if (configured.mode === 'disabled') return await stop('retry-disabled', 'NX_RETRY_DISABLED', 'nexus-fallback');
      // Older profiles may explicitly select "inherit". Inherit timing hints,
      // not the adapter's error allowlist: PI/UNKNOWN must not stop at retry 0.
      const custom = configured.mode === 'inherit' ? { ...configured,
          algorithm: 'exponential' as const, multiplier: 2,
          initialDelayMs: policy?.initialDelayMs ?? configured.initialDelayMs,
          maxDelayMs: policy?.maxDelayMs ?? configured.maxDelayMs,
          jitterRatio: policy?.jitterRatio ?? configured.jitterRatio,
        } : configured;
      // Only the native signal and live lifecycle events can cancel recovery.
      // A provider's ABORTED/DELETED/DISPOSED code is still a failed request
      // when the real agent remains alive. Permission/budget admission runs
      // again on an actual attempt; this policy adds no authority.
      const beforeFallback = stopped();
      if (beforeFallback) return await stop(beforeFallback, 'NX_CANCELLED', 'nexus-fallback');
      if (!stateReady || stateOf(agent.session, STATE) === undefined) {
        return await stop('recovery-state-unavailable', 'NX_RECOVERY_FAILED', 'nexus-fallback');
      }
      const maxRetries = custom.maxRetries;
      if (maxRetries === 0) return await stop('retry-disabled', 'NX_RETRY_DISABLED', 'nexus-fallback', currentRetry(payload), maxRetries);
      // One durable budget owns provider retries and overflow recovery phases.
      // Reattempting maintenance never authorizes replaying a pending effect.
      while (true) {
        const previous = currentRetry(payload);
        if (previous >= maxRetries) return await stop('retry-exhausted',
          unattributedAbort ? 'NX_ABORT_UNATTRIBUTED' : 'NX_RETRY_EXHAUSTED', 'nexus-fallback', previous, maxRetries);
        const retryAfter = payload.failure.providerRetryAfterMs;
        const delayMs = requestRetryDelay(custom, previous, retryAfter);
        if (delayMs === undefined) {
          return await stop('retry-delay-unsupported', 'NX_RETRY_DELAY_UNSUPPORTED', 'nexus-fallback', previous, maxRetries);
        }
        const retry = previous + 1;
        const retryId = randomUUID() as LlmRetryEventData['retryId'];
        const beforeSchedule = stopped();
        if (beforeSchedule) return await stop(beforeSchedule, 'NX_CANCELLED');
        try {
          // The released event owns the durable count and native countdown UI.
          // Persist public diagnostic text, never the provider's original body.
          agent.session.append('llm/retry', {
            retryId, turn: payload.turn, step: payload.step, provider: payload.provider, mode: 'normal',
            policyKey: `nexus:custom:${JSON.stringify(custom)}`,
            retry, maxRetries, delayMs,
            failure: { code: diagnosis.canonicalCode, message: `[${diagnosis.diagnosticCode}] ${diagnosis.message}`,
              ...(diagnosis.status === undefined ? {} : { status: diagnosis.status }),
              ...(diagnosis.requestId ? { requestId: ProviderRequestId(diagnosis.requestId) } : {}) },
          });
        } catch { return await stop('recovery-record-failed', 'NX_RECOVERY_FAILED', 'nexus-fallback', previous, maxRetries); }
        if (currentRetry(payload) <= previous) {
          return await stop('recovery-state-unavailable', 'NX_RECOVERY_FAILED', 'nexus-fallback', previous, maxRetries);
        }
        await diagnostic(payload, diagnosis, { outcome: 'scheduled', source: 'nexus-fallback', retry, maxRetries, delayMs });
        if (!await delay(delayMs, fused)) return await stop(stopped() ?? 'signal-aborted', 'NX_CANCELLED', 'nexus-fallback', retry, maxRetries);
        const afterWait = stopped();
        if (afterWait) return await stop(afterWait, 'NX_CANCELLED', 'nexus-fallback', retry, maxRetries);
        try { agent.session.append('llm/retry-started', { retryId, turn: payload.turn, step: payload.step, retry }); }
        catch { return await stop('recovery-record-failed', 'NX_RECOVERY_FAILED', 'nexus-fallback', retry, maxRetries); }
        await diagnostic(payload, diagnosis, { outcome: 'retry-started', source: 'nexus-fallback', retry, maxRetries });
        if (diagnosis.canonicalCode === 'CONTEXT_WINDOW_EXCEEDED' && payload.recoveryStage !== 'preparation') {
          // Retry the safe recovery stage, not the unchanged oversized request.
          // The live compactor reconciles any previous formal operation first.
          let decision: Decision;
          const compactor = nativeCompactionFor(agent);
          try {
            decision = await compactor?.recoverOverflow?.({ ...payload, signal: fused }, { retry, maxRetries });
          } catch {
            await diagnostic(payload, diagnosis, { diagnosticCode: 'NX_RECOVERY_FAILED',
              phase: 'context-overflow-recovery', outcome: 'deferred', retry, maxRetries,
              stopReason: 'recovery-handler-failed' });
          }
          if (stopped()) return await stop(stopped()!, 'NX_CANCELLED', 'nexus-fallback', retry, maxRetries);
          if (decision?.kind !== 'retry') {
            await diagnostic(payload, diagnosis, { phase: 'context-overflow-recovery', outcome: 'deferred',
              retry, maxRetries, stopReason: compactor?.recoverOverflow ? 'no-proven-context-reduction' : 'context-compactor-unavailable' });
            continue;
          }
        }
        return stopped() ? await stop(stopped()!, 'NX_CANCELLED', 'nexus-fallback', retry, maxRetries) : { kind: 'retry' };
      }
    } catch {
      await diagnostic(payload, diagnosis, { diagnosticCode: 'NX_RECOVERY_FAILED', outcome: 'failed',
        stopReason: 'recovery-handler-failed', retry: currentRetry(payload) });
      return undefined;
    } finally { waits.delete(local); }
  }

  const listen = (name: string, callback: (...args: any[]) => any, options?: any) => {
    const remove = ctx.on(name, callback, options);
    if (typeof remove === 'function') removers.push(remove);
  };
  listen('agent/disposed', ({ agent }: RecoveryPayload) => {
    disposedAgents.add(agent);
    for (const wait of waits) if (wait.agent === agent) wait.controller.abort();
  });
  listen('session/disposed', (session: Session) => {
    disposedSessions.add(session);
    for (const wait of waits) if (wait.agent.session === session) wait.controller.abort();
  });
  const trackRecovery = (payload: RecoveryPayload) => {
    const operation = recover(payload);
    active.add(operation);
    void operation.then(() => active.delete(operation), () => active.delete(operation));
    return operation;
  };
  listen('agent/request-error', trackRecovery, { prepend: true });
  const dispose = () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    for (const remove of removers.reverse()) {
      try { remove(); } catch { /* Every listener and projection gets a cleanup attempt. */ }
    }
  };
  ctx.effect(() => async () => { dispose(); await Promise.allSettled([...active]); }, 'nexus: request recovery');
  return dispose;
}
