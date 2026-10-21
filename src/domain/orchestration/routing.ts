import { NexusError } from '../../ports/contracts.js';
import type { CandidateEvaluation, ModelCandidate, ModelRef, RouteDecision, RouteSelectionInput,
  ScoringWeights, RoleModelPolicy } from './types.js';
import { clamp, finiteNumber, isExpired, modelKey, policyHash } from './util.js';

/** Exact matching only. Unlike the upstream CLI, no substring, latest-date or fuzzy model fallback. */
export function resolveModelReference(reference: string | ModelRef, models: readonly ModelCandidate[]): ModelCandidate {
  let matches: ModelCandidate[];
  if (typeof reference === 'string') {
    const exact = models.filter(candidate => reference === modelKey(candidate.ref) ||
      reference === `${candidate.ref.providerRouteId}/${candidate.ref.modelId}`);
    matches = exact.length ? exact : models.filter(candidate => reference === candidate.ref.modelId);
  } else matches = models.filter(candidate => modelKey(candidate.ref) === modelKey(reference));
  const unique = [...new Map(matches.map(candidate => [modelKey(candidate.ref), candidate])).values()];
  if (unique.length > 1) throw new NexusError('MODEL_BINDING_AMBIGUOUS', '模型引用匹配多个完整身份，请选择明确的 route、endpoint 和账户。', {
    candidates: unique.map(candidate => candidate.ref), nextAction: 'select-canonical-model-reference',
  });
  if (unique.length === 0) throw new NexusError('MODEL_BINDING_NOT_FOUND', '宿主模型目录中没有该精确模型引用。', {
    reference, nextAction: 'refresh-host-model-directory',
  });
  return unique[0]!;
}

function effortResult(candidate: ModelCandidate, policy: RoleModelPolicy, now: string):
  Pick<CandidateEvaluation, 'effortStatus' | 'effortResolved'> & { reason?: string } {
  if (!policy.effort?.requested || policy.effort.mode === 'inherit') return { effortStatus: 'inherited-only' };
  const fact = candidate.capabilities.reasoningEffort;
  if (!fact || fact.state === 'unknown' || isExpired(fact.expiresAt, now)) {
    return { effortStatus: 'unknown', reason: policy.effort.mode === 'best-supported' ? undefined : 'EFFORT_UNKNOWN' };
  }
  if (fact.state === 'unsupported' || !Array.isArray(fact.value) || fact.value.length === 0) {
    return { effortStatus: 'unsupported', reason: policy.effort.mode === 'best-supported' ? undefined : 'EFFORT_UNSUPPORTED' };
  }
  const available = fact.value as readonly string[];
  const requested = policy.effort.requested;
  if (available.includes(requested)) return { effortStatus: 'selectable', effortResolved: requested };
  if (policy.effort.mode === 'exact') return { effortStatus: 'unsupported', reason: 'EFFORT_UNSUPPORTED' };
  const levels = policy.effort.orderedLevels;
  if (!levels || !levels.includes(requested)) {
    return { effortStatus: 'unknown', reason: policy.effort.mode === 'at-least' ? 'EFFORT_ORDER_UNKNOWN' : undefined };
  }
  const requestedIndex = levels.indexOf(requested);
  const supported = available.filter(level => levels.includes(level));
  const adequate = supported.filter(level => levels.indexOf(level) >= requestedIndex)
    .sort((a, b) => levels.indexOf(a) - levels.indexOf(b));
  if (adequate[0]) return { effortStatus: 'selectable', effortResolved: adequate[0] };
  if (policy.effort.mode === 'at-least') return { effortStatus: 'unsupported', reason: 'EFFORT_UNSUPPORTED' };
  const lower = supported.sort((a, b) => levels.indexOf(b) - levels.indexOf(a))[0];
  return lower ? { effortStatus: 'selectable', effortResolved: lower } : { effortStatus: 'unknown' };
}

/** Cold-cache and retry reservation; missing price components stay unknown. */
export function estimateColdCost(candidate: ModelCandidate, input: Pick<RouteSelectionInput,
  'inputTokens' | 'maxOutputTokens' | 'toolSchemaTokens' | 'retriesReserved'>): number | null {
  const price = candidate.price;
  if (!price || price.input === null || price.output === null || !Number.isFinite(price.unit) || price.unit <= 0 ||
    !Number.isFinite(price.input) || !Number.isFinite(price.output) || price.input < 0 || price.output < 0) return null;
  // An explicitly enabled cache-write mode can add provider charges; unknown cache write is not free.
  const cacheModes = candidate.capabilities.cacheModes?.value;
  const explicitWrite = Array.isArray(cacheModes) && cacheModes.includes('explicit-write');
  if (explicitWrite && (price.cacheWrite === null || !Number.isFinite(price.cacheWrite) || price.cacheWrite < 0)) return null;
  const count = 1 + Math.max(0, input.retriesReserved ?? 0);
  const inputCount = input.inputTokens + (input.toolSchemaTokens ?? 0);
  return ((inputCount * price.input + input.maxOutputTokens * price.output +
    (explicitWrite ? inputCount * (price.cacheWrite ?? 0) : 0)) / price.unit) * count;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  quality: 0.3, capability: 0.15, cache: 0.1, cost: 0.12,
  latency: 0.08, uncertainty: 0.1, switch: 0.05, failure: 0.1,
};

function evaluateCandidate(candidate: ModelCandidate, input: RouteSelectionInput): CandidateEvaluation {
  const reasons: string[] = [];
  const key = modelKey(candidate.ref);
  if (!candidate.authorized) reasons.push('ENDPOINT_UNAUTHORIZED');
  if (candidate.credentialState === 'unavailable' || !candidate.credentialState && !candidate.credentialAvailable) reasons.push('CREDENTIAL_UNAVAILABLE');
  if (isExpired(candidate.expiresAt, input.now)) reasons.push('MODEL_FACTS_EXPIRED');
  if (candidate.health === 'open-circuit') reasons.push('ENDPOINT_CIRCUIT_OPEN');
  if (input.allowedRegions && (!candidate.ref.region || !input.allowedRegions.includes(candidate.ref.region))) reasons.push('DATA_REGION_CONFLICT');
  if (!candidate.executorIds.some(id => input.allowedExecutorIds.includes(id))) reasons.push('EXECUTOR_INCOMPATIBLE');
  if (input.excludedModelKeys?.includes(key)) reasons.push('INDEPENDENCE_MODEL_COLLISION');
  if (candidate.contextLineageIds?.some(id => input.excludedContextLineageIds?.includes(id))) reasons.push('CONTEXT_LINEAGE_LEAK');
  let verifiedRules = 0;
  for (const rule of input.policy.minCapabilities) {
    const fact = candidate.capabilities[rule.capability];
    if (!fact || fact.state === 'unknown' || fact.value === undefined || isExpired(fact.expiresAt, input.now)) {
      reasons.push(`CAPABILITY_UNKNOWN:${rule.capability}`);
      continue;
    }
    if (fact.state === 'unsupported' || fact.value === false) {
      reasons.push(`CAPABILITY_UNSUPPORTED:${rule.capability}`);
      continue;
    }
    if (rule.requireVerified && fact.state !== 'verified') reasons.push(`CAPABILITY_UNVERIFIED:${rule.capability}`);
    if (rule.minimum !== undefined && (typeof fact.value !== 'number' || !Number.isFinite(fact.value) || fact.value < rule.minimum)) reasons.push(`CAPABILITY_INSUFFICIENT:${rule.capability}`);
    if (rule.includes !== undefined && (!Array.isArray(fact.value) || !fact.value.includes(rule.includes))) reasons.push(`CAPABILITY_MISMATCH:${rule.capability}`);
    if (fact.state === 'verified') verifiedRules++;
  }
  const contextRequired = input.inputTokens + input.maxOutputTokens + (input.toolSchemaTokens ?? 0);
  const window = candidate.capabilities.contextWindow;
  if (!window || window.state === 'unknown' || isExpired(window.expiresAt, input.now) || typeof window.value !== 'number' || !Number.isFinite(window.value)) reasons.push('CONTEXT_WINDOW_UNKNOWN');
  else if (window.state === 'unsupported' || window.value < contextRequired) reasons.push('CONTEXT_BUDGET_EXCEEDED');
  const output = candidate.capabilities.maxOutputTokens;
  if (output && output.state !== 'unknown' && typeof output.value === 'number' && output.value < input.maxOutputTokens) reasons.push('MAX_OUTPUT_EXCEEDED');
  const effort = effortResult(candidate, input.policy, input.now);
  if (effort.reason) reasons.push(effort.reason);
  const cost = estimateColdCost(candidate, input);
  if (cost === null && (input.unknownCostPolicy.mode === 'block' || !input.unknownCostPolicy.maxExposure ||
    !Number.isFinite(input.unknownCostPolicy.maxExposure) || input.unknownCostPolicy.maxExposure <= 0)) reasons.push('PRICE_UNKNOWN');
  if (input.remainingBudget) {
    if (candidate.price?.currency !== input.remainingBudget.currency) reasons.push('BUDGET_CURRENCY_UNKNOWN');
    const exposure = cost ?? input.unknownCostPolicy.maxExposure;
    if (exposure === undefined || exposure > input.remainingBudget.amount) reasons.push('BUDGET_INSUFFICIENT');
  }
  const weights = { ...DEFAULT_WEIGHTS, ...input.weights };
  const qualityKnown = candidate.quality && candidate.quality.samples > 0 && candidate.quality.datasetVersion;
  const uncertainty = [!qualityKnown, candidate.latencyP95Ms === undefined, candidate.cacheReuseEstimate === undefined,
    candidate.failureRisk === undefined, cost === null, candidate.health === 'unknown',
    candidate.credentialState === 'unknown'].filter(Boolean).length / 7;
  const features = {
    quality: qualityKnown ? clamp(finiteNumber(candidate.quality!.lowerBound, 0.2)) : 0.2,
    capability: input.policy.minCapabilities.length ? verifiedRules / input.policy.minCapabilities.length : 1,
    cache: clamp(finiteNumber(candidate.cacheReuseEstimate, 0)),
    cost: cost === null ? 1 : clamp(cost / Math.max(0.000001, input.normalization?.maxCost ?? 1)),
    latency: clamp(finiteNumber(candidate.latencyP95Ms, input.normalization?.maxLatencyMs ?? 60000) /
      Math.max(1, input.normalization?.maxLatencyMs ?? 60000)),
    uncertainty,
    switch: input.currentAffinity && !isExpired(input.currentAffinity.expiresAt, input.now) &&
      modelKey(input.currentAffinity.model) !== key ? 1 : 0,
    failure: clamp(finiteNumber(candidate.failureRisk, candidate.health === 'degraded' ? 0.6 : 0.2)),
  };
  const score = features.quality * weights.quality + features.capability * weights.capability + features.cache * weights.cache -
    features.cost * weights.cost - features.latency * weights.latency - features.uncertainty * weights.uncertainty -
    features.switch * weights.switch - features.failure * weights.failure;
  return { key, feasible: reasons.length === 0, reasons, score: reasons.length ? null : score,
    knownCostUpperBound: cost, currency: candidate.price?.currency, effortStatus: effort.effortStatus,
    effortResolved: effort.effortResolved, features };
}

/** Proposes a route/cache lease; the scheduler must persist/acquire it inside its reservation transaction. */
export function selectRoute(input: RouteSelectionInput): RouteDecision {
  if (!Number.isFinite(Date.parse(input.now))) throw new NexusError('INVALID_ARGUMENT', '路由需要有效的冻结时间。');
  for (const count of [input.inputTokens, input.maxOutputTokens, input.toolSchemaTokens ?? 0, input.retriesReserved ?? 0]) {
    if (!Number.isFinite(count) || count < 0) throw new NexusError('INVALID_ARGUMENT', 'Token 和重试预留必须为非负有限数。');
  }
  const expiresAt = new Date(Date.parse(input.now) + Math.max(1, input.leaseDurationMs ?? 300000)).toISOString();
  const inherit = (): RouteDecision => {
    if (!input.inheritAvailable) throw new NexusError('HOST_AGENT_OPTIONS_UNAVAILABLE', '宿主当前模型不可继承执行。');
    if (input.policy.minCapabilities.some(rule => rule.capability !== 'text' || rule.requireVerified || rule.minimum !== undefined || rule.includes !== undefined)) {
      throw new NexusError('CAPABILITY_UNKNOWN', '继承路径缺少任务必需能力的可核验目录事实。');
    }
    if (input.policy.effort?.mode === 'exact' || input.policy.effort?.mode === 'at-least') {
      throw new NexusError('EFFORT_UNSUPPORTED', '继承路径不能保证指定的 reasoning effort。');
    }
    if (input.policy.strictPool && input.inheritedModel && !input.approvedPool.some(ref => modelKey(ref) === modelKey(input.inheritedModel!))) {
      throw new NexusError('ROUTE_POOL_EMPTY', '继承模型不在严格批准池内。');
    }
    const decision = { id: input.id, nodeId: input.nodeId, nodeAttempt: input.nodeAttempt, policyHash: input.policyHash,
      requestedRole: input.roleId, mode: 'inherit' as const, selectedModel: input.inheritedModel,
      selectedExecutorId: input.allowedExecutorIds[0] ?? 'host-inherit', candidateFacts: [], effortStatus: 'inherited-only' as const,
      capabilitySnapshotRef: input.capabilitySnapshotRef, cachePartitionRef: 'inherit-unknown',
      cacheAffinityLeaseId: '', lease: null, reasonCodes: ['HOST_MODEL_INHERITED', 'OBSERVED_ROUTE_UNKNOWN'],
      excludedCandidates: [], authorizationRef: input.authorizationRef, expiresAt };
    return { ...decision, decisionHash: policyHash(decision) };
  };
  if (input.policy.mode === 'inherit') return inherit();
  if (!input.hostSupportsAgentOptions) {
    throw new NexusError('HOST_AGENT_OPTIONS_UNAVAILABLE', '宿主只允许继承模型，不能声称已按指定 route 切换。', { nextAction: 'choose-inherit' });
  }
  const approved = new Set(input.approvedPool.map(modelKey));
  const candidates: ModelCandidate[] = [];
  const referenceErrors: { reference: string | ModelRef; code: string }[] = [];
  for (const reference of input.policy.candidates) {
    try {
      const candidate = resolveModelReference(reference, input.catalog);
      if (!candidates.some(item => modelKey(item.ref) === modelKey(candidate.ref))) candidates.push(candidate);
    } catch (error) {
      if (!(error instanceof NexusError)) throw error;
      if (error.code === 'MODEL_BINDING_AMBIGUOUS') throw error;
      referenceErrors.push({ reference, code: error.code });
      if (input.policy.mode === 'pinned' && !input.policy.fallback?.allowPinnedSwitch) {
        throw new NexusError('PINNED_MODEL_UNAVAILABLE', '固定模型不可用；当前策略没有允许替换。', { reference, cause: error.code });
      }
    }
  }
  const evaluations = candidates.map(candidate => {
    const evaluation = evaluateCandidate(candidate, input);
    if (input.policy.strictPool && !approved.has(evaluation.key)) {
      evaluation.reasons.push('OUTSIDE_APPROVED_POOL'); evaluation.feasible = false; evaluation.score = null;
    }
    return evaluation;
  });
  const feasible = evaluations.filter(item => item.feasible);
  if (input.policy.mode === 'pinned' && !evaluations[0]?.feasible && !input.policy.fallback?.allowPinnedSwitch) {
    throw new NexusError('PINNED_MODEL_UNAVAILABLE', '固定模型未通过硬条件；没有隐式切换。', { evaluations, referenceErrors });
  }
  if (!feasible.length) throw new NexusError('ROUTE_POOL_EMPTY', '没有模型同时满足批准池、能力、权限、独立性和预算。', {
    evaluations, referenceErrors, nextAction: 'review-excluded-candidates',
  });
  const pinnedReferenceMissing = input.policy.mode === 'pinned' && input.policy.candidates[0] !== undefined &&
    referenceErrors.some(error => error.reference === input.policy.candidates[0]);
  const reasons = [input.policy.mode === 'pinned' && !pinnedReferenceMissing ? 'PINNED_EXACT' :
    input.policy.mode === 'ordered' ? 'ORDERED_FIRST_FEASIBLE' : input.policy.mode === 'scored' ? 'VERSIONED_SCORE' : 'EXPLICIT_PINNED_FALLBACK'];
  let selected = feasible[0]!;
  if (input.policy.mode === 'scored') {
    const order = new Map(candidates.map((candidate, index) => [modelKey(candidate.ref), index]));
    selected = [...feasible].sort((a, b) => (b.score! - a.score!) ||
      (order.get(a.key)! - order.get(b.key)!) || a.key.localeCompare(b.key))[0]!;
    if (input.currentAffinity && !isExpired(input.currentAffinity.expiresAt, input.now)) {
      const current = feasible.find(item => item.key === modelKey(input.currentAffinity!.model));
      if (current && selected.score! - current.score! < Math.max(0, input.hysteresisThreshold ?? 0.03)) {
        selected = current; reasons.push('CACHE_AFFINITY_HYSTERESIS');
      }
    }
  }
  if (input.policy.mode === 'pinned' && (pinnedReferenceMissing || selected !== evaluations[0]) &&
    !reasons.includes('EXPLICIT_PINNED_FALLBACK')) reasons.push('EXPLICIT_PINNED_FALLBACK');
  const candidate = candidates.find(item => modelKey(item.ref) === selected.key)!;
  if (candidate.credentialState === 'unknown') reasons.push('CREDENTIAL_AUTHENTICATION_ON_CALL_REQUIRED');
  const partition = policyHash({ model: candidate.ref, ...input.cache });
  const reusableLease = input.currentAffinity && input.currentAffinity.partitionId === partition &&
    modelKey(input.currentAffinity.model) === selected.key && !isExpired(input.currentAffinity.expiresAt, input.now)
    ? input.currentAffinity : undefined;
  const lease = reusableLease ?? { id: `route-lease:${input.id}`, model: candidate.ref, partitionId: partition, expiresAt, nodeId: input.nodeId };
  const decision = {
    id: input.id, nodeId: input.nodeId, nodeAttempt: input.nodeAttempt, policyHash: input.policyHash,
    requestedRole: input.roleId, mode: 'selected' as const, selectedModel: candidate.ref,
    selectedExecutorId: input.allowedExecutorIds.find(id => candidate.executorIds.includes(id))!,
    candidateFacts: evaluations, effortRequested: input.policy.effort?.requested, effortResolved: selected.effortResolved,
    effortStatus: selected.effortStatus, capabilitySnapshotRef: input.capabilitySnapshotRef, priceQuoteRef: candidate.price?.id,
    cachePartitionRef: partition, cacheAffinityLeaseId: lease.id, lease, reasonCodes: reasons,
    excludedCandidates: evaluations.filter(item => !item.feasible), authorizationRef: input.authorizationRef, expiresAt: lease.expiresAt,
  };
  return { ...decision, decisionHash: policyHash(decision) };
}

export interface FallbackContext {
  policy: NonNullable<RoleModelPolicy['fallback']>;
  mode: RoleModelPolicy['mode'];
  errorCode: string;
  accepted: boolean;
  providerRequestId?: string;
  effectsObserved: boolean;
  attempts: number;
}
export function decideFallback(input: FallbackContext): { action: 'reconcile' | 'retry' | 'next-candidate' | 'block'; reason: string } {
  if (input.accepted || input.providerRequestId || input.effectsObserved) return { action: 'reconcile', reason: 'ATTEMPT_MAY_ALREADY_HAVE_EFFECTS' };
  if (['401', '403', 'AUTHENTICATION_FAILED', 'PERMISSION_DENIED', 'CREDENTIAL_REVOKED'].includes(input.errorCode)) return { action: 'block', reason: 'NO_CREDENTIAL_ESCALATION' };
  if (input.attempts >= input.policy.maxRetries) return { action: 'block', reason: 'RETRY_BUDGET_EXHAUSTED' };
  if (input.errorCode === '429' || input.errorCode === 'RATE_LIMITED') return { action: 'retry', reason: 'SAME_AUTHORIZATION_BUCKET_BACKOFF' };
  if (!input.policy.retryableCodes.includes(input.errorCode)) return { action: 'block', reason: 'ERROR_NOT_ALLOWLISTED' };
  if (input.mode === 'pinned' && !input.policy.allowPinnedSwitch) return { action: 'block', reason: 'PINNED_FALLBACK_NOT_AUTHORIZED' };
  return { action: 'next-candidate', reason: 'BEFORE_ACCEPTANCE_EXPLICIT_FALLBACK' };
}
