import type { NexusServices } from '../../ports/contracts.js';
import { NATIVE_DIAGNOSTIC_LIMIT, NATIVE_OWNER_COLLECTION, type NativeLaneOwner, type NativeOperationDiagnostic } from './native-transactions.js';

const CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const TRACE = /^trace_[a-zA-Z0-9_-]{1,96}$/;
const ID = /^[a-zA-Z0-9_-]{1,160}$/;
const PHASES = new Set(['preparing', 'decision-started', 'proposal-prepared', 'preparation-failed', 'preparation-abandoned',
  'official-started', 'official-flushed', 'official-failed', 'context-committed']);
const OUTCOMES = new Set(['failed-before-official', 'abandoned-before-official', 'failed-before-replacement', 'reconciliation-required', 'reconciled']);
function timestamp(value: unknown): string | null {
  const at = typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}
function diagnostic(value: NativeOperationDiagnostic): NativeOperationDiagnostic | undefined {
  const at = timestamp(value?.at);
  if (!value || !CODE.test(value.code) || !TRACE.test(value.traceId) || !ID.test(value.operationId)
      || !at || !PHASES.has(value.phase) || !OUTCOMES.has(value.outcome)
      || !['not-started', 'completed', 'unknown'].includes(value.auxiliaryEffect)
      || !['not-started', 'unknown', 'committed'].includes(value.officialEffect)) return undefined;
  // Rebuild from the allowlist even when loading older/untrusted stored data.
  return {
    at, operationId: value.operationId, traceId: value.traceId, code: value.code,
    ...(typeof value.previousCode === 'string' && CODE.test(value.previousCode) ? { previousCode: value.previousCode } : {}),
    phase: value.phase, outcome: value.outcome,
    auxiliaryEffect: value.auxiliaryEffect, officialEffect: value.officialEffect,
  };
}

/** Caller must authorize the selected session before exposing this read. */
export async function readNativeCompactionDiagnostics(
  services: Pick<NexusServices, 'store'>, sessionId: string, sessionKey?: string,
): Promise<{ schemaVersion: 1; lanes: Record<string, unknown>[] }> {
  const rows = await services.store.list<NativeLaneOwner>(NATIVE_OWNER_COLLECTION);
  return {
    schemaVersion: 1,
    lanes: rows.filter(row => row.value.sessionId === sessionId && (!sessionKey || row.value.sessionKey === sessionKey)).slice(0, 16).map(row => {
      const value = row.value;
      return {
        revision: row.revision,
        status: ['active', 'reconciliation-required', 'released'].includes(value.status) ? value.status : 'unknown',
        phase: PHASES.has(value.phase) ? value.phase : 'unknown',
        kind: ['autonomous', 'explicit-ranges', 'manual-now', 'manual-region'].includes(value.kind) ? value.kind : 'unknown',
        ...(ID.test(value.operationId) ? { operationId: value.operationId } : {}),
        ...(typeof value.traceId === 'string' && TRACE.test(value.traceId) ? { traceId: value.traceId } : {}),
        ...(typeof value.errorCode === 'string' && CODE.test(value.errorCode) ? { code: value.errorCode } : {}),
        hasProposal: Boolean(value.proposalId), hasOfficialReceipt: Boolean(value.hostCompactionId),
        startedThroughSeq: Number.isSafeInteger(value.startedThroughSeq) ? value.startedThroughSeq : null,
        auxiliaryRetryAfter: timestamp(value.auxiliaryRetryAfter),
        diagnostics: (Array.isArray(value.diagnostics) ? value.diagnostics : []).slice(-NATIVE_DIAGNOSTIC_LIMIT)
          .map(diagnostic).filter(Boolean),
      };
    }),
  };
}
