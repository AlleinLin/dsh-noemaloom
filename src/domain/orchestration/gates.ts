import type { ActorEvidence, CheckPolicy, CheckReceipt, Finding, GatePolicy, GateVerdict } from './types.js';
import { modelKey, policyHash } from './util.js';

export function validateIndependence(candidate: ActorEvidence, previous: readonly ActorEvidence[],
  options: { requireDifferentModel?: boolean; blind?: boolean } = {}):
  { valid: boolean; level: 'actor-independent' | 'cross-model-independent' | 'unavailable'; reasons: string[] } {
  const reasons: string[] = [];
  if (!candidate.actorId || !candidate.contextLineageId) reasons.push('ACTOR_IDENTITY_MISSING');
  if (previous.some(actor => actor.actorId === candidate.actorId)) reasons.push('INDEPENDENCE_ACTOR_COLLISION');
  if (previous.some(actor => actor.contextLineageId === candidate.contextLineageId) || candidate.inheritedFullHistory) reasons.push('CONTEXT_LINEAGE_LEAK');
  if (options.blind !== false && candidate.inputRefs.some(input => ['author-claim', 'prior-verdict', 'reviewer-reasoning'].includes(input.kind))) reasons.push('BLIND_CONTEXT_CONTAINS_CONCLUSIONS');
  const distinctModel = Boolean(candidate.model && previous.every(actor => actor.model && modelKey(actor.model) !== modelKey(candidate.model!)));
  if (options.requireDifferentModel && !distinctModel) reasons.push('INDEPENDENCE_MODEL_UNAVAILABLE');
  return { valid: !reasons.length, level: reasons.length ? 'unavailable' : distinctModel ? 'cross-model-independent' : 'actor-independent', reasons };
}

function checkReceipt(check: CheckPolicy, receipt: CheckReceipt | undefined): {
  status: 'pass' | 'fail' | 'blocked' | 'inconclusive'; reasons: string[];
} {
  if (!receipt) return { status: 'blocked', reasons: [`CHECK_RECEIPT_MISSING:${check.id}`] };
  if (receipt.kind !== check.kind) return { status: 'fail', reasons: [`CHECK_RECEIPT_KIND_MISMATCH:${check.id}`] };
  if (!receipt.receiptRef || !receipt.evidenceRefs.length) return { status: 'inconclusive', reasons: [`GATE_EVIDENCE_MISSING:${check.id}`] };
  if (check.kind === 'command') {
    if (receipt.source !== 'executor') return { status: 'fail', reasons: [`COMMAND_NOT_EXECUTED:${check.id}`] };
    if (receipt.cancelled) return { status: 'blocked', reasons: [`COMMAND_CANCELLED:${check.id}`] };
    if (receipt.exitCode === null || receipt.exitCode === undefined) return { status: 'inconclusive', reasons: [`EXIT_CODE_UNKNOWN:${check.id}`] };
    if (receipt.exitCode !== (check.expectedExit ?? 0)) return { status: 'fail', reasons: [`COMMAND_EXIT_FAILED:${check.id}:${receipt.exitCode}`] };
    if (receipt.childResultValid !== true) return { status: 'inconclusive', reasons: [`CHILD_RESULT_INVALID:${check.id}`] };
    if (receipt.sampled !== true) return { status: 'inconclusive', reasons: [`TEST_EXECUTION_NOT_SAMPLED:${check.id}`] };
  } else if (check.kind === 'artifact') {
    if (receipt.source !== 'artifact-store') return { status: 'fail', reasons: [`ARTIFACT_NOT_OBSERVED:${check.id}`] };
    if (!receipt.exists) return { status: 'fail', reasons: [`ARTIFACT_MISSING:${check.id}`] };
    if (check.nonEmpty && !(receipt.byteLength && receipt.byteLength > 0)) return { status: 'fail', reasons: [`ARTIFACT_EMPTY:${check.id}`] };
    if (!receipt.contentHash || receipt.formatValid !== true) return { status: 'inconclusive', reasons: [`ARTIFACT_CONTENT_UNVERIFIED:${check.id}`] };
    if (check.expectedHash && receipt.contentHash !== check.expectedHash) return { status: 'fail', reasons: [`ARTIFACT_HASH_MISMATCH:${check.id}`] };
  } else if (check.kind === 'metric') {
    if (receipt.source !== 'oracle') return { status: 'fail', reasons: [`METRIC_NOT_ORACLE:${check.id}`] };
    if (!check.metric || !check.datasetRef || receipt.datasetRef !== check.datasetRef ||
      receipt.observedMetric === undefined || !Number.isFinite(receipt.observedMetric)) return { status: 'inconclusive', reasons: [`METRIC_ORACLE_INCOMPLETE:${check.id}`] };
    const value = receipt.observedMetric, target = check.metric.threshold, tolerance = check.metric.tolerance ?? 0;
    const pass = check.metric.operator === '>=' ? value >= target - tolerance :
      check.metric.operator === '<=' ? value <= target + tolerance :
      check.metric.operator === '>' ? value > target : check.metric.operator === '<' ? value < target : Math.abs(value - target) <= tolerance;
    if (!pass) return { status: 'fail', reasons: [`METRIC_THRESHOLD_FAILED:${check.id}`] };
  } else {
    // Model review is evidence only when the real actor has a concrete receipt and raw evidence.
    if (receipt.conclusion !== 'pass') return { status: receipt.conclusion ?? 'inconclusive', reasons: [`CHECK_CONCLUSION:${check.id}:${receipt.conclusion ?? 'unknown'}`] };
  }
  return { status: 'pass', reasons: [] };
}

export interface GateEvaluationInput {
  policy: GatePolicy;
  nodeId: string;
  actor: ActorEvidence;
  priorActors?: ActorEvidence[];
  requireDifferentModel?: boolean;
  routeDecisionId: string;
  candidateSnapshotHash: string;
  contractHash: string;
  receipts: CheckReceipt[];
  findings?: Finding[];
  now: string;
  unresolvedRequiredConstraints?: string[];
}
/** Host-side, evidence-derived verdict; no model string or subprocess exit alone can manufacture PASS. */
export function evaluateGate(input: GateEvaluationInput): GateVerdict {
  const reasons: string[] = [];
  const statuses: GateVerdict['verdict'][] = [];
  if (!input.candidateSnapshotHash || !input.contractHash || !input.routeDecisionId) {
    reasons.push('GATE_SNAPSHOT_IDENTITY_MISSING'); statuses.push('blocked');
  }
  if (input.unresolvedRequiredConstraints?.length) {
    reasons.push(...input.unresolvedRequiredConstraints.map(item => `CONTRACT_UNRESOLVED:${item}`)); statuses.push('blocked');
  }
  if (!input.actor.inputRefs.some(ref => ref.kind === 'mission')) {
    reasons.push('ACTOR_MISSION_INPUT_MISSING'); statuses.push('blocked');
  }
  if (input.policy.independent) {
    if (!input.priorActors?.length) { reasons.push('INDEPENDENCE_BASELINE_MISSING'); statuses.push('blocked'); }
    else {
      const result = validateIndependence(input.actor, input.priorActors, { requireDifferentModel: input.requireDifferentModel });
      reasons.push(...result.reasons); if (!result.valid) statuses.push('blocked');
    }
  }
  const receipts = input.receipts.filter(receipt => {
    if (receipt.candidateSnapshotHash !== input.candidateSnapshotHash || receipt.contractHash !== input.contractHash) {
      reasons.push(`STALE_EVIDENCE:${receipt.checkId}`); return false;
    }
    return true;
  });
  const requiredChecks = input.policy.checks.filter(check => check.required);
  for (const check of requiredChecks) {
    const matching = receipts.filter(receipt => receipt.checkId === check.id);
    // Contradictory failures are preserved rather than last-write or majority overwritten.
    const candidates = matching.map(receipt => checkReceipt(check, receipt));
    const result = candidates.find(candidate => candidate.status === 'fail') ??
      candidates.find(candidate => candidate.status === 'blocked') ??
      candidates.find(candidate => candidate.status === 'inconclusive') ?? candidates[0] ??
      checkReceipt(check, undefined);
    statuses.push(result.status); reasons.push(...result.reasons);
  }
  if (!requiredChecks.length) { reasons.push('GATE_CHECKS_EMPTY_UNVERIFIED'); statuses.push('inconclusive'); }
  for (const level of input.policy.requiredEvidenceLevels) {
    const satisfied = level === 'structural'
      ? receipts.some(receipt => receipt.source === 'artifact-store' && receipt.exists && receipt.contentHash)
      : level === 'observed'
        ? receipts.some(receipt => ['executor', 'artifact-store', 'oracle'].includes(receipt.source) && receipt.evidenceRefs.length > 0)
        : receipts.some(receipt => receipt.source === 'oracle' && receipt.evidenceRefs.length > 0);
    if (!satisfied) { statuses.push('inconclusive'); reasons.push(`EVIDENCE_LEVEL_MISSING:${level}`); }
  }
  const findings = input.findings ?? [];
  if (findings.some(finding => !finding.resolved && finding.priority <= 1)) { statuses.push('fail'); reasons.push('UNRESOLVED_HIGH_PRIORITY_FINDING'); }
  const verdict = statuses.includes('fail') ? 'fail' : statuses.includes('blocked') ? 'blocked' :
    statuses.includes('inconclusive') || statuses.length === 0 ? 'inconclusive' : 'pass';
  return { gateId: input.policy.gateId, nodeId: input.nodeId, actorId: input.actor.actorId,
    contextLineageId: input.actor.contextLineageId, routeDecisionId: input.routeDecisionId, verdict,
    verificationStatus: verdict === 'pass' ? 'verified' : requiredChecks.length ? 'unverified' : 'not_applicable',
    candidateSnapshotHash: input.candidateSnapshotHash, contractHash: input.contractHash,
    evidenceRefs: [...new Set(receipts.flatMap(receipt => receipt.evidenceRefs))],
    commandReceipts: receipts.filter(receipt => receipt.kind === 'command').map(receipt => receipt.receiptRef),
    artifactHashes: [...new Set(receipts.map(receipt => receipt.contentHash).filter((hash): hash is string => Boolean(hash)))],
    findings, reasons, createdAt: input.now, judgeVersion: 'nexus-evidence-policy/1' };
}

export function aggregateCompletion(input: {
  requiredGateIds: string[];
  verdicts: GateVerdict[];
  candidateSnapshotHash: string;
  contractHash: string;
  requiredGoals: string[];
  verifiedGoals: string[];
  unresolvedFindings: Finding[];
  activeChildIds: string[];
  uncollectedChildIds: string[];
  effectUnknown: boolean;
  cancelled?: boolean;
  partialAllowed?: boolean;
}): { outcome: 'success' | 'partial' | 'blocked' | 'failed' | 'cancelled'; coverage: { total: number; verified: number; ratio: number | null }; reasons: string[] } {
  const reasons: string[] = [];
  const current = input.verdicts.filter(verdict => verdict.candidateSnapshotHash === input.candidateSnapshotHash &&
    verdict.contractHash === input.contractHash && !('stale' in verdict && verdict.stale === true));
  for (const gateId of input.requiredGateIds) {
    const gateVerdicts = current.filter(verdict => verdict.gateId === gateId);
    if (!gateVerdicts.length) reasons.push(`REQUIRED_GATE_MISSING:${gateId}`);
    else if (gateVerdicts.some(verdict => verdict.verdict !== 'pass')) reasons.push(`REQUIRED_GATE_NOT_PASSED:${gateId}`);
  }
  const missingGoals = input.requiredGoals.filter(goal => !input.verifiedGoals.includes(goal));
  reasons.push(...missingGoals.map(goal => `GOAL_UNVERIFIED:${goal}`));
  if (input.activeChildIds.length) reasons.push('ACTIVE_DESCENDANTS_REMAIN');
  if (input.uncollectedChildIds.length) reasons.push('UNCOLLECTED_CHILDREN_REMAIN');
  if (input.effectUnknown) reasons.push('EFFECT_UNKNOWN');
  if ([...input.unresolvedFindings, ...current.flatMap(verdict => verdict.findings)].some(finding => !finding.resolved && finding.priority <= 1)) reasons.push('UNRESOLVED_HIGH_PRIORITY_FINDING');
  const hardFailure = current.some(verdict => verdict.verdict === 'fail') || reasons.includes('UNRESOLVED_HIGH_PRIORITY_FINDING');
  const allGoals = [...new Set(input.requiredGoals)], verified = allGoals.filter(goal => input.verifiedGoals.includes(goal)).length;
  const coverage = { total: allGoals.length, verified, ratio: allGoals.length ? verified / allGoals.length : null };
  const outstandingEffects = input.activeChildIds.length || input.uncollectedChildIds.length || input.effectUnknown;
  const outcome = input.cancelled ? (outstandingEffects ? 'blocked' : 'cancelled') : !reasons.length ? 'success' :
    hardFailure ? 'failed' : input.partialAllowed && verified > 0 && !outstandingEffects ? 'partial' : 'blocked';
  return { outcome, coverage, reasons };
}

export function failureFingerprint(input: { contractHash: string; candidateSnapshotHash: string; failureCode: string;
  checkId: string; evidenceHashes: readonly string[] }): string {
  return policyHash({ ...input, evidenceHashes: [...new Set(input.evidenceHashes)].sort() });
}
export function assessRepairProgress(input: {
  previousFingerprint?: string; nextFingerprint: string; repairRoundsUsed: number; maxRepairRounds: number;
  modelCallsUsed: number; maxModelCalls: number | null; deadlineExceeded: boolean;
}): { action: 'repair' | 'stop'; reason: string } {
  if (input.previousFingerprint === input.nextFingerprint) return { action: 'stop', reason: 'NO_PROGRESS_FINGERPRINT' };
  if (input.repairRoundsUsed >= input.maxRepairRounds) return { action: 'stop', reason: 'REPAIR_BUDGET_EXHAUSTED' };
  if (input.maxModelCalls !== null && input.modelCallsUsed >= input.maxModelCalls) return { action: 'stop', reason: 'MODEL_CALL_BUDGET_EXHAUSTED' };
  if (input.deadlineExceeded) return { action: 'stop', reason: 'DEADLINE_EXCEEDED' };
  return { action: 'repair', reason: 'BOUNDED_REPAIR_ALLOWED' };
}

export function invalidateDependentEvidence(failedNodeId: string, edges: readonly { from: string; to: string; kind?: string }[],
  verdicts: readonly (GateVerdict & { stale?: boolean })[]): (GateVerdict & { stale?: boolean })[] {
  const stale = new Set([failedNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) if (edge.kind !== 'failure' && stale.has(edge.from) && !stale.has(edge.to)) {
      stale.add(edge.to); changed = true;
    }
  }
  return verdicts.map(verdict => stale.has(verdict.nodeId) ? { ...verdict, stale: true } : { ...verdict });
}
