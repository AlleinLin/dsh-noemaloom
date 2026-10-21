import { randomUUID } from 'node:crypto';
import { appendPluginRecord, SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { LlmRetryEventData } from '@deepseek-ai/dsh-llm-retry';
import { ProviderRequestId, type ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import { classifyFailure, ERROR_CODES, type FailureDiagnosis } from '../shared/error-codes.js';
import { nativeErrorIdentity } from './native-diagnostics.js';
import type { HostContext } from './types.js';

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
]);
const ABORT_RETRIES = 3;
const ALWAYS_FALLBACK_RETRIES = 5;

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
  if (count(facts.delayMs, 2_147_483_647)) data.delayMs = facts.delayMs;
  if (typeof facts.stopReason === 'string' && (STOP_REASONS.has(facts.stopReason)
    || /^OBSERVATION_[A-Z0-9_]{1,64}$/.test(facts.stopReason))) data.stopReason = facts.stopReason;
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
function policyKey(policy: ResolvedRetryPolicy): string {
  return policy.mode === 'always'
    ? JSON.stringify([policy.mode, policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio])
    : JSON.stringify([policy.mode, policy.maxRetries, [...policy.retryableCodes].sort(),
      policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio]);
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
function hardStop(failure: unknown): { stopReason: string; diagnosticCode: string; canonicalCode?: string } | undefined {
  const chain: any[] = failure && typeof failure === 'object' ? [failure] : [];
  const seen = new Set(chain);
  for (let i = 0; i < chain.length && chain.length < 6; i++) {
    for (const value of [chain[i].cause, chain[i].failure]) {
      if (value && typeof value === 'object' && !seen.has(value)) { seen.add(value); chain.push(value); }
    }
  }
  for (const value of chain) {
    const code = token(value.code, CODE) ?? '';
    const message = typeof value.message === 'string' && value.message.length <= 32_768 ? value.message : '';
    if (['AUTH', 'INVALID_CREDENTIAL', 'PERMISSION_DENIED', 'UNAUTHORIZED', 'FORBIDDEN', 'INVALID_API_KEY',
      'SUBSCRIPTION_REQUIRED', 'SUBSCRIPTION_EXPIRED', 'PAYMENT_REQUIRED'].includes(code)
      || [401, 402, 403].includes(value.status ?? value.statusCode)
      || /\b(?:invalid api[- ]?key|invalid credentials?|subscription (?:required|expired)|authentication failed)\b/i.test(message)) {
      return { stopReason: 'authorization-denied', diagnosticCode: 'NX_AUTH_DENIED', canonicalCode: code && code !== 'UNKNOWN' ? code : 'AUTH' };
    }
    if (/(?:^|_)(?:QUOTA|CREDIT|CREDITS|BALANCE)(?:_|$)/.test(code)
      || /\b(?:insufficient[_ ](?:quota|credits?|balance)|quota[_ ](?:exceeded|exhausted)|credit balance (?:is )?(?:low|exhausted))\b/i.test(message)) {
      return { stopReason: 'quota-denied', diagnosticCode: 'NX_AUTH_DENIED', canonicalCode: code && code !== 'UNKNOWN' ? code : 'QUOTA_EXCEEDED' };
    }
    if (code.includes('BUDGET') || ['POLICY_DENIED', 'APPROVAL_REQUIRED'].includes(code)) {
      return { stopReason: 'budget-denied', diagnosticCode: 'NX_POLICY_BLOCKED', canonicalCode: code };
    }
    if (code.startsWith('CTX_') || code === 'SESSION_DURABILITY_UNVERIFIED') {
      return { stopReason: 'not-retryable', diagnosticCode: 'NX_CONTEXT_MAINTENANCE', canonicalCode: code };
    }
    if (code === 'PARTIAL_EFFECT' || code.includes('PENDING_OPERATION')) {
      return { stopReason: 'not-retryable', diagnosticCode: 'NX_PENDING_EFFECT', canonicalCode: code };
    }
    if (['SESSION_DELETED', 'SESSION_NOT_FOUND', 'DELETED'].includes(code)) {
      return { stopReason: 'session-deleted', diagnosticCode: 'NX_CANCELLED', canonicalCode: code };
    }
    if (['AGENT_DISPOSED', 'DISPOSED', 'PLUGIN_DISPOSED'].includes(code)) {
      return { stopReason: code === 'PLUGIN_DISPOSED' ? 'plugin-disposed' : 'agent-disposed',
        diagnosticCode: 'NX_CANCELLED', canonicalCode: code };
    }
  }
}
function delay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(ready);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/** Recover only at the official same-turn seam; never synthesize user input. */
export function registerRequestRecovery(ctx: HostContext): () => void {
  const lifetime = new AbortController();
  const active = new Set<Promise<Decision>>();
  const waits = new Set<{ agent: RecoveryPayload['agent']; controller: AbortController }>();
  const disposedAgents = new WeakSet<object>();
  const disposedSessions = new WeakSet<object>();
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
      ...diagnosis, traceId, turn: payload.turn, step: payload.step, provider: payload.provider,
      source: 'observer', ...facts,
    });
  };
  const stateOf = (session: Session, key: string): any => {
    try { return projections?.stateOf?.(session, key); } catch { return undefined; }
  };
  const currentRetry = (payload: RecoveryPayload): number => stateOf(payload.agent.session, STATE)?.[stateKey(payload)]?.retry ?? 0;

  async function recover(payload: RecoveryPayload, next: () => Promise<Decision>): Promise<Decision> {
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
      const terminal = hardStop(payload.failure);
      if (terminal) {
        await diagnostic(payload, diagnosis, { ...terminal, outcome: 'stopped', retry: currentRetry(payload) });
        return undefined;
      }

      const unattributedAbort = diagnosis.diagnosticCode === 'NX_ABORT_UNATTRIBUTED';
      const policy = validPolicy(payload.retryPolicy) ? payload.retryPolicy : undefined;
      // Unattributed adapter aborts need an explicit finite cap, including when
      // the installed native policy is "always". They never become network errors.
      if (!unattributedAbort) {
        let decision: Decision;
        try { decision = await next(); } catch {
          return await stop(stopped() ?? 'recovery-handler-failed', 'NX_RECOVERY_FAILED');
        }
        // Native retry owns its wait and decision. Removing Nexus must not
        // cancel another plugin's recovery or change its signal/payload.
        const afterDelegate = signal.aborted ? signalStop(signal) : disposedSessions.has(agent.session) ? 'session-deleted'
          : disposedAgents.has(agent) ? 'agent-disposed' : undefined;
        if (afterDelegate) return await stop(afterDelegate, 'NX_CANCELLED');
        if (decision?.kind === 'retry') {
          const nativeRetry = policy
            ? stateOf(agent.session, 'llmRetry')?.[JSON.stringify([payload.provider, policyKey(policy)])]?.retry : undefined;
          await diagnostic(payload, diagnosis, { outcome: 'delegated', source: 'native-retry',
            retry: count(nativeRetry) ? nativeRetry : currentRetry(payload),
            ...(policy?.mode === 'normal' ? { maxRetries: policy.maxRetries } : {}) });
          return decision;
        }
        const native = stateOf(agent.session, 'llmRetry');
        if (native !== undefined) {
          if (!policy || policy.mode === 'normal' && policy.maxRetries === 0) {
            return await stop('retry-disabled', 'NX_RETRY_DISABLED', 'native-retry');
          }
          const previous = native[JSON.stringify([payload.provider, policyKey(policy)])]?.retry ?? 0;
          if (policy.mode === 'normal' && previous >= policy.maxRetries) {
            return await stop('retry-exhausted', 'NX_RETRY_EXHAUSTED', 'native-retry', previous, policy.maxRetries);
          }
          if (policy.mode === 'normal' && !policy.retryableCodes.includes(payload.failure.code)) {
            return await stop('not-retryable', diagnosis.diagnosticCode, 'native-retry', previous, policy.maxRetries);
          }
          if (policy.mode === 'normal' && Number.isFinite(payload.failure.providerRetryAfterMs)
            && payload.failure.providerRetryAfterMs! > policy.maxDelayMs) {
            return await stop('retry-delay-unsupported', 'NX_RETRY_DELAY_UNSUPPORTED', 'native-retry', previous, policy.maxRetries);
          }
          return await stop('native-retry-stopped', diagnosis.diagnosticCode, 'native-retry', previous);
        }
      }

      const beforeFallback = stopped();
      if (beforeFallback) return await stop(beforeFallback, 'NX_CANCELLED', 'nexus-fallback');
      if (!policy && !unattributedAbort) return await stop('retry-disabled', 'NX_RETRY_DISABLED', 'nexus-fallback');
      if (!stateReady || stateOf(agent.session, STATE) === undefined) {
        return await stop('recovery-state-unavailable', 'NX_RECOVERY_FAILED', 'nexus-fallback');
      }
      const maxRetries = unattributedAbort ? ABORT_RETRIES : policy!.mode === 'normal' ? policy!.maxRetries : ALWAYS_FALLBACK_RETRIES;
      if (maxRetries === 0) return await stop('retry-disabled', 'NX_RETRY_DISABLED', 'nexus-fallback', currentRetry(payload), maxRetries);
      if (!unattributedAbort && policy!.mode === 'normal' && !policy!.retryableCodes.includes(payload.failure.code)) {
        return await stop('not-retryable', diagnosis.diagnosticCode, 'nexus-fallback', currentRetry(payload), maxRetries);
      }
      const previous = currentRetry(payload);
      if (previous >= maxRetries) return await stop('retry-exhausted',
        unattributedAbort ? 'NX_ABORT_UNATTRIBUTED' : 'NX_RETRY_EXHAUSTED', 'nexus-fallback', previous, maxRetries);
      const backoff = policy ?? { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 };
      const retryAfter = payload.failure.providerRetryAfterMs;
      if (Number.isFinite(retryAfter) && retryAfter! > backoff.maxDelayMs) {
        return await stop('retry-delay-unsupported', 'NX_RETRY_DELAY_UNSUPPORTED', 'nexus-fallback', previous, maxRetries);
      }
      const retry = previous + 1;
      const localDelay = Math.min(backoff.initialDelayMs * 2 ** Math.min(previous, 1023), backoff.maxDelayMs);
      const delayMs = Math.round(Number.isFinite(retryAfter) && retryAfter! > 0 ? retryAfter!
        : Math.min(localDelay * (1 - backoff.jitterRatio + 2 * backoff.jitterRatio * Math.random()), backoff.maxDelayMs));
      const retryId = randomUUID() as LlmRetryEventData['retryId'];
      const beforeSchedule = stopped();
      if (beforeSchedule) return await stop(beforeSchedule, 'NX_CANCELLED');
      try {
        // The released event owns the durable count and native countdown UI.
        // Persist public diagnostic text, never the provider's original body.
        agent.session.append('llm/retry', {
          retryId, turn: payload.turn, step: payload.step, provider: payload.provider, mode: 'normal',
          policyKey: unattributedAbort ? 'nexus:unattributed-abort:v1' : policyKey(policy!),
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
      return stopped() ? await stop(stopped()!, 'NX_CANCELLED', 'nexus-fallback', retry, maxRetries) : { kind: 'retry' };
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
  listen('agent/request-error', (payload: RecoveryPayload, next: () => Promise<Decision>) => {
    const operation = recover(payload, next);
    active.add(operation);
    void operation.then(() => active.delete(operation), () => active.delete(operation));
    return operation;
  }, { prepend: true });
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
