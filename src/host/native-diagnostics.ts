import { randomUUID } from 'node:crypto';
import { HarnessError, LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm';
import { isNexusError } from '../ports/contracts.js';
import { classifyFailure, type FailureContext } from '../shared/error-codes.js';


const CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const TRACE = /^trace_[a-zA-Z0-9_-]{1,96}$/;
const TRACES = Symbol.for('dsh-nexus.error-traces.v1');
const traceRuntime = globalThis as typeof globalThis & { [TRACES]?: WeakMap<object, string> };
const traces = traceRuntime[TRACES] ??= new WeakMap<object, string>();

/** Only routable codes and correlation IDs cross the diagnostic boundary. */
export function nativeErrorIdentity(error: unknown, fallback = 'CTX_PREPARATION_FAILED'): { code: string; traceId: string } {
  const known = isNexusError(error);
  const host = error instanceof HarnessError;
  const code = (known || host) && CODE.test(error.code) ? error.code
    : error instanceof Error && error.name === 'AbortError' ? 'CANCELLED' : fallback;
  const details = known && error.details && typeof error.details === 'object'
    ? error.details as Record<string, unknown> : undefined;
  const publicTrace = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    && /^\[NX_[A-Z_]+\]/.test(error.message)
    ? /(?:；诊断=|traceId=)(trace_[a-zA-Z0-9_-]{1,96})(?:$|[；\s])/.exec(error.message)?.[1] : undefined;
  const candidate = details?.traceId ?? (host ? (error as HarnessError & { traceId?: string }).traceId : undefined) ?? publicTrace;
  let traceId = typeof candidate === 'string' && TRACE.test(candidate) ? candidate
    : error && typeof error === 'object' ? traces.get(error) : undefined;
  traceId ??= `trace_${randomUUID()}`;
  if (error && typeof error === 'object') traces.set(error, traceId);
  return { code, traceId };
}

/**
 * Use at native host boundaries. DSH getErrorCode recognizes its public
 * HarnessError, not a bundled NexusError or a duck-typed {code} object.
 * The message carries the trace because the native turn UI renders it.
 */
export function toHarnessError(error: unknown, context: FailureContext = {}): HarnessError & { traceId: string } {
  const identity = nativeErrorIdentity(error, 'INTERNAL');
  const diagnosis = classifyFailure(error, context);
  const hardFailure = !context.signalAborted && ['NX_CONTEXT_MAINTENANCE', 'NX_PENDING_EFFECT', 'NX_POLICY_BLOCKED', 'NX_AUTH_DENIED']
    .includes(diagnosis.diagnosticCode);
  const code = hardFailure ? diagnosis.canonicalCode
    : isNexusError(error) || error instanceof HarnessError || identity.code === 'CANCELLED'
      ? identity.code : diagnosis.canonicalCode === 'UNKNOWN' ? identity.code : diagnosis.canonicalCode;
  const message = `[${diagnosis.diagnosticCode}] ${diagnosis.message}；阶段=${diagnosis.phase}；traceId=${identity.traceId}`;
  const retryAfterMs = [error, error && typeof error === 'object' && 'failure' in error ? error.failure : undefined]
    .map(value => value && typeof value === 'object' && 'providerRetryAfterMs' in value ? value.providerRetryAfterMs : undefined)
    .find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return Object.assign(new HarnessError(message, code), {
    traceId: identity.traceId, diagnosticCode: diagnosis.diagnosticCode, phase: diagnosis.phase,
    ...(diagnosis.status ? { status: diagnosis.status } : {}),
    ...(diagnosis.requestId ? { requestId: diagnosis.requestId } : {}),
    ...(retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs }),
  });
}

/**
 * The native turn driver preserves only LlmError.failure in turn/end. A plain
 * HarnessError is otherwise reduced to UNKNOWN even when its code is valid.
 */
export function toNativeLlmError(error: unknown, context: FailureContext = {}): LlmError & { traceId: string } {
  const wrapped = toHarnessError(error, context) as ReturnType<typeof toHarnessError> & {
    status?: number; requestId?: string; providerRetryAfterMs?: number;
  };
  return Object.assign(new LlmError(wrapped.message,
    wrapped.code === 'UNKNOWN' ? 'UNCLASSIFIED_FAILURE' : wrapped.code, {
    ...(wrapped.status ? { status: wrapped.status } : {}),
    ...(wrapped.requestId ? { requestId: ProviderRequestId(wrapped.requestId) } : {}),
    ...(wrapped.providerRetryAfterMs && wrapped.providerRetryAfterMs > 0
      ? { providerRetryAfterMs: wrapped.providerRetryAfterMs } : {}),
  }), { traceId: wrapped.traceId });
}

/** Record call sites and cancellation identity without error bodies or paths. */
export function nativeFailureFacts(error: unknown, signal?: AbortSignal): Record<string, unknown> {
  try {
    const chain: any[] = [];
    const seen = new Set<object>();
    const visit = (value: any) => {
      if (!value || typeof value !== 'object' || seen.has(value) || chain.length >= 6) return;
      seen.add(value); chain.push(value);
    };
    visit(error);
    for (let i = 0; i < chain.length; i++) {
      visit(chain[i].cause); visit(chain[i].failure);
    }
    const causeCodes = [...new Set(chain.map(item => item.code)
      .filter(value => typeof value === 'string' && CODE.test(value)))];
    const errorName = typeof chain[0]?.name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(chain[0].name)
      ? chain[0].name : undefined;
    const stackFrames: string[] = [];
    for (const item of chain) {
      if (typeof item.stack !== 'string') continue;
      // Skip the first line, which is the private error message.
      for (const line of item.stack.slice(0, 16_384).split('\n').slice(1, 17)) {
        const frame = /^\s*at\s+(?:(?:async\s+)?([A-Za-z0-9_.$<>\[\]-]{1,96})\s+\()?(.+):(\d{1,9}):(\d{1,9})\)?$/.exec(line);
        if (!frame) continue;
        const file = frame[2]!.replaceAll('\\', '/').split('/').at(-1)!;
        if (!/^[A-Za-z0-9_.$-]{1,64}$/.test(file)) continue;
        const safe = `${frame[1] ? `${frame[1]}@` : ''}${file}:${frame[3]}:${frame[4]}`;
        if (safe.length <= 180 && !stackFrames.includes(safe)) stackFrames.push(safe);
        if (stackFrames.length === 8) break;
      }
      if (stackFrames.length === 8) break;
    }
    const kind = signal?.reason?.kind;
    const abortSource = !signal?.aborted ? 'active'
      : ['user', 'parent', 'hook', 'disposed', 'plugin'].includes(kind) ? kind : 'unattributed';
    return { ...(errorName ? { errorName } : {}), causeCodes, stackFrames, abortSource };
  } catch { return {}; }
}

/** The host snapshots only its released failure fields; put diagnostic identity in the visible message. */
export function annotateNativeFailure(failure: any, context: FailureContext = {}) {
  const diagnosis = classifyFailure(failure, context);
  const { traceId } = nativeErrorIdentity(failure, diagnosis.canonicalCode);
  return {
    code: diagnosis.canonicalCode === 'UNKNOWN' ? 'UNCLASSIFIED_FAILURE' : diagnosis.canonicalCode,
    message: `[${diagnosis.diagnosticCode}] ${diagnosis.message}；阶段=${diagnosis.phase}；诊断=${traceId}`,
    ...(diagnosis.status ? { status: diagnosis.status } : {}),
    ...(diagnosis.requestId ? { requestId: diagnosis.requestId } : {}),
    ...(Number.isFinite(failure?.providerRetryAfterMs) && failure.providerRetryAfterMs >= 0
      ? { providerRetryAfterMs: failure.providerRetryAfterMs } : {}),
    ...(Number.isSafeInteger(failure?.offloadImages) && failure.offloadImages >= 0 ? { offloadImages: failure.offloadImages } : {}),
  };
}

export { readNativeCompactionDiagnostics } from '../domain/context/diagnostics.js';
