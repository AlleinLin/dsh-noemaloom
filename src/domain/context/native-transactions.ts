import { NexusError } from '../../ports/contracts.js';
import { hashObject } from './cache.js';

/**
 * A proposal pins kernel/surface semantics, not the mutable header's CAS
 * revision. Completing a model observation may change that revision without
 * changing any of these values.
 */
export interface NativeKernelPin {
  kernelRoot: string;
  stateGeneration: number;
  surfaceHash: string;
  epochsHash: string;
}

export function createNativeKernelPin(input: {
  kernelRoot: string;
  stateGeneration: number;
  surfaceHash: string;
  epochs: unknown;
}): NativeKernelPin {
  nonempty(input.kernelRoot, 'kernelRoot');
  nonempty(input.surfaceHash, 'surfaceHash');
  generation(input.stateGeneration);
  return Object.freeze({ kernelRoot: input.kernelRoot, stateGeneration: input.stateGeneration,
    surfaceHash: input.surfaceHash, epochsHash: hashObject(input.epochs) });
}

export function assertNativeKernelPin(expected: NativeKernelPin, actual: NativeKernelPin): void {
  if (expected.kernelRoot !== actual.kernelRoot || expected.stateGeneration !== actual.stateGeneration
      || expected.surfaceHash !== actual.surfaceHash || expected.epochsHash !== actual.epochsHash) {
    throw new NexusError('REVISION_CONFLICT', '原生提案准备后内核、表层或接受的世代已变化，不能覆盖新状态', {
      expected, actual,
    });
  }
}

/** The header CAS publishes this anchor together with its new immutable root. */
export interface NativeCommitAnchor {
  txId: string;
  kernelRoot: string;
  stateGeneration: number;
  proposalId?: string;
  hostCompactionId?: string;
  /** Hash of the independently verified canonical official transaction. */
  officialProofHash?: string;
}

export interface NativeFinalization extends NativeCommitAnchor {
  beforeKernelRoot: string;
  kind: 'native-official-compaction' | 'host-manual-import' | 'context-state';
}

export interface NativeOutboxHead {
  pendingFinalizations?: readonly NativeFinalization[];
}

export interface NativeCommitReceipt extends NativeCommitAnchor {
  schemaVersion: 2;
  status: 'committed';
  proofHash: string;
}

/**
 * Invoke only after the canonical host proof (for native mutations) and the
 * context header CAS succeed. A receipt is evidence about a historical CAS;
 * it does not replace officialCompaction's host-event validation.
 */
export function createNativeCommitReceipt(anchor: NativeCommitAnchor): NativeCommitReceipt {
  validateAnchor(anchor);
  const body = { schemaVersion: 2 as const, status: 'committed' as const, ...copyAnchor(anchor) };
  return { ...body, proofHash: hashObject(body) };
}

export function verifyNativeCommitReceipt(receipt: NativeCommitReceipt): void {
  validateAnchor(receipt);
  const body = { schemaVersion: 2 as const, status: 'committed' as const, ...copyAnchor(receipt) };
  if (receipt.schemaVersion !== 2 || receipt.status !== 'committed' || receipt.proofHash !== hashObject(body)) {
    throw new NexusError('CTX_TRANSACTION_PROOF_CORRUPT', '原生历史提交收据完整性失败');
  }
}

export function findNativeFinalization(head: NativeOutboxHead, txId: string): NativeFinalization | undefined {
  nonempty(txId, 'txId');
  return head.pendingFinalizations?.find(entry => entry.txId === txId);
}

/**
 * Stage in the same header value that publishes kernelRoot. Never persist an
 * outbox entry separately and then claim the state CAS has happened.
 * Drain a failed finalization before admitting another mutation.
 */
export function queueNativeFinalization<T extends NativeOutboxHead>(
  head: T, entry: NativeFinalization, maximum = 1,
): T & { pendingFinalizations: NativeFinalization[] } {
  validateAnchor(entry);
  nonempty(entry.beforeKernelRoot, 'beforeKernelRoot');
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new NexusError('INVALID_ARGUMENT', '提交收据队列限额必须为正整数');
  }
  const pending = [...(head.pendingFinalizations ?? [])];
  const existing = pending.find(candidate => candidate.txId === entry.txId);
  if (existing) {
    if (hashObject(existing) !== hashObject(entry)) conflict(entry.txId);
    return { ...head, pendingFinalizations: pending };
  }
  if (pending.length >= maximum) {
    throw new NexusError('CTX_FINALIZATION_REQUIRED', '上一状态已提交但收据未完成；先对账后再修改该 lane', {
      pendingTransactionIds: pending.map(candidate => candidate.txId),
    });
  }
  return { ...head, pendingFinalizations: [...pending, { ...entry }] };
}

/** Write the verified receipt first, then CAS the returned smaller header. */
export function acknowledgeNativeFinalization<T extends NativeOutboxHead>(
  head: T, receipt: NativeCommitReceipt,
): T & { pendingFinalizations: NativeFinalization[] } {
  verifyNativeCommitReceipt(receipt);
  const entry = findNativeFinalization(head, receipt.txId);
  if (entry && !sameAnchor(entry, receipt)) conflict(receipt.txId);
  return { ...head, pendingFinalizations: (head.pendingFinalizations ?? []).filter(candidate => candidate.txId !== receipt.txId) };
}

/**
 * `verifiedReachableCommit` must come from the archive's immutable commit-chain
 * traversal rooted at the accepted header, never an unreferenced candidate.
 * The latest state/hash being different cannot prove an older CAS was absent.
 */
export function classifyNativeCommit(input: {
  expected: NativeCommitAnchor;
  head: NativeOutboxHead;
  receipt?: NativeCommitReceipt;
  verifiedReachableCommit?: NativeCommitAnchor;
}): { status: 'landed' | 'unproven'; evidence: 'header-outbox' | 'committed-receipt' | 'reachable-history' | 'none' } {
  validateAnchor(input.expected);
  const pending = findNativeFinalization(input.head, input.expected.txId);
  if (pending) {
    if (!sameAnchor(pending, input.expected)) conflict(input.expected.txId);
    return { status: 'landed', evidence: 'header-outbox' };
  }
  if (input.receipt) {
    verifyNativeCommitReceipt(input.receipt);
    if (!sameAnchor(input.receipt, input.expected)) conflict(input.expected.txId);
    return { status: 'landed', evidence: 'committed-receipt' };
  }
  if (input.verifiedReachableCommit) {
    validateAnchor(input.verifiedReachableCommit);
    if (!sameAnchor(input.verifiedReachableCommit, input.expected)) conflict(input.expected.txId);
    return { status: 'landed', evidence: 'reachable-history' };
  }
  return { status: 'unproven', evidence: 'none' };
}

/** Small CAS record shared by all compactor instances for one context lane. */
export const NATIVE_OWNER_COLLECTION = 'context.nativeOwners';
export const NATIVE_DIAGNOSTIC_LIMIT = 16;
export interface NativeOperationDiagnostic {
  at: string;
  operationId: string;
  traceId: string;
  code: string;
  previousCode?: string;
  phase: NativeLaneOwner['phase'];
  outcome: 'failed-before-official' | 'abandoned-before-official' | 'failed-before-replacement' | 'reconciliation-required' | 'reconciled';
  /** A failed auxiliary call may have been billed. It is never replayed. */
  auxiliaryEffect: 'not-started' | 'completed' | 'unknown';
  officialEffect: 'not-started' | 'unknown' | 'committed';
}
export interface NativeLaneOwner {
  schemaVersion: 1;
  sessionKey: string;
  sessionId: string;
  operationId: string;
  status: 'active' | 'reconciliation-required' | 'released';
  phase: 'preparing' | 'decision-started' | 'proposal-prepared' | 'preparation-failed' | 'preparation-abandoned'
    | 'official-started' | 'official-flushed' | 'official-failed' | 'context-committed';
  kind: 'autonomous' | 'explicit-ranges' | 'manual-now' | 'manual-region';
  startedThroughSeq: number;
  proposalId?: string;
  hostCompactionId?: string;
  officialStartSeq?: number;
  sourceSeqs?: number[];
  summaryHash?: string;
  errorCode?: string;
  traceId?: string;
  /** New writers hold the cross-process lease until their async work settles. */
  leaseProtocol?: 1;
  diagnostics?: NativeOperationDiagnostic[];
  consecutivePreparationFailures?: number;
  /** Suppresses new auxiliary admissions; never releases an official owner. */
  auxiliaryRetryAfter?: string;
  startedAt: string;
  updatedAt: string;
}

export function beforeOfficialPhase(phase: NativeLaneOwner['phase']): boolean {
  return ['preparing', 'decision-started', 'proposal-prepared', 'preparation-failed', 'preparation-abandoned'].includes(phase);
}

export function appendNativeDiagnostic(
  owner: NativeLaneOwner, diagnostic: NativeOperationDiagnostic,
): NativeOperationDiagnostic[] {
  return [...(owner.diagnostics ?? []), diagnostic].slice(-NATIVE_DIAGNOSTIC_LIMIT);
}

function copyAnchor(anchor: NativeCommitAnchor): NativeCommitAnchor {
  return { txId: anchor.txId, kernelRoot: anchor.kernelRoot, stateGeneration: anchor.stateGeneration,
    ...(anchor.proposalId === undefined ? {} : { proposalId: anchor.proposalId }),
    ...(anchor.hostCompactionId === undefined ? {} : { hostCompactionId: anchor.hostCompactionId }),
    ...(anchor.officialProofHash === undefined ? {} : { officialProofHash: anchor.officialProofHash }) };
}
function sameAnchor(left: NativeCommitAnchor, right: NativeCommitAnchor): boolean {
  return hashObject(copyAnchor(left)) === hashObject(copyAnchor(right));
}
function validateAnchor(anchor: NativeCommitAnchor): void {
  nonempty(anchor.txId, 'txId');
  nonempty(anchor.kernelRoot, 'kernelRoot');
  generation(anchor.stateGeneration);
  for (const key of ['proposalId', 'hostCompactionId', 'officialProofHash'] as const) {
    if (anchor[key] !== undefined) nonempty(anchor[key]!, key);
  }
}
function generation(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new NexusError('INVALID_ARGUMENT', 'stateGeneration 必须为非负安全整数');
}
function nonempty(value: string, name: string): void {
  if (typeof value !== 'string' || !value) throw new NexusError('INVALID_ARGUMENT', `${name} 必须为非空字符串`);
}
function conflict(txId: string): never {
  throw new NexusError('CTX_TRANSACTION_PROOF_CONFLICT', '同一事务的历史提交证明与候选 root 不一致', { txId });
}
