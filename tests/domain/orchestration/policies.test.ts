import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { aggregateCompletion, assessRepairProgress, checkAdaptationCapacity, classifyTaskShape,
  createHandoffManifest, decideFallback, evaluateAdaptationPromotion, evaluateGate, failureFingerprint,
  generateFrameworkLeaf, guardAdaptation, isTrialHoldout, modelKey, resolveModelReference, selectAdaptations,
  selectRoute, validateBlueprint, validateGeneratedLeaf, validateIndependence } from '../../../src/domain/orchestration/index.js';
import type { Adaptation, ActorEvidence, GatePolicy, ModelCandidate, ModelRef, RouteSelectionInput,
  TaskShape, WorkflowBlueprint } from '../../../src/domain/orchestration/index.js';

const now = '2026-10-19T10:00:00.000Z';
const ref = (providerRouteId: string, credentialScopeId = 'account-a'): ModelRef => ({
  providerRouteId, modelId: 'same-model', endpointIdentity: `endpoint:${providerRouteId}`, protocol: 'fixture-v1', credentialScopeId,
});
function candidate(provider: string, overrides: Partial<ModelCandidate> = {}): ModelCandidate {
  return { ref: ref(provider), capabilities: {
    text: { state: 'verified', value: true, source: 'fixture' },
    contextWindow: { state: 'verified', value: 32000, source: 'fixture' },
    reasoningEffort: { state: 'verified', value: ['low', 'high'], source: 'fixture' },
  }, executorIds: ['host-spawn'], authorized: true, credentialAvailable: true, health: 'healthy',
  price: { id: 'fixture-price', currency: 'USD', input: 1, output: 2, cacheRead: null, cacheWrite: null,
    unit: 1000000, effectiveAt: now, source: 'fixture' },
  quality: { lowerBound: 0.7, samples: 30, datasetVersion: 'suite1' }, latencyP95Ms: 100,
  cacheReuseEstimate: 0.4, failureRisk: 0.05, ...overrides };
}
function routing(catalog = [candidate('a'), candidate('b')]): RouteSelectionInput {
  return { id: 'decision-1', nodeId: 'node-1', nodeAttempt: 1, roleId: 'implementer',
    policy: { mode: 'scored', candidates: catalog.map(model => model.ref), strictPool: true,
      minCapabilities: [{ capability: 'text' }] },
    catalog, approvedPool: catalog.map(model => model.ref), inheritAvailable: true, hostSupportsAgentOptions: true,
    allowedExecutorIds: ['host-spawn'], inputTokens: 1000, maxOutputTokens: 1000,
    unknownCostPolicy: { mode: 'block' }, authorizationRef: 'authorization-1', capabilitySnapshotRef: 'facts-1',
    policyHash: 'policy-1', cache: { promptEpoch: '1', toolSurfaceEpoch: '1', rendererVersion: '1', namespace: 'n1' }, now };
}
const actor = (id: string, provider = 'a'): ActorEvidence => ({
  actorId: id, contextLineageId: `lineage:${id}`, model: ref(provider),
  inputRefs: [{ ref: 'mission', kind: 'mission' }, { ref: 'raw', kind: 'raw-evidence' }],
});
const gate: GatePolicy = { gateId: 'G6', kind: 'independent-verification', scope: 'lane',
  requiredRoles: ['verifier'], checks: [{ id: 'actual-test', kind: 'command', required: true }],
  requiredEvidenceLevels: ['observed'], onFail: 'block', maxLoops: 2, protected: true, independent: true };

test('MMR-001 canonical ambiguity includes account and endpoint, never first match', () => {
  assert.throws(() => resolveModelReference('same-model', [candidate('a'), candidate('b')]),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'MODEL_BINDING_AMBIGUOUS');
  const account = candidate('a', { ref: ref('a', 'account-b') });
  assert.throws(() => resolveModelReference('a/same-model', [candidate('a'), account]));
  assert.equal(resolveModelReference(modelKey(account.ref), [candidate('a'), account]).ref.credentialScopeId, 'account-b');
});
test('MMR-003/004 hard unknown capability and price are not supported/free', () => {
  const input = routing([candidate('a', { price: undefined })]);
  assert.throws(() => selectRoute(input));
  input.unknownCostPolicy = { mode: 'bounded', maxExposure: 1 };
  const decision = selectRoute(input);
  assert.equal(decision.candidateFacts[0]!.knownCostUpperBound, null);
  input.policy.minCapabilities.push({ capability: 'image' });
  assert.throws(() => selectRoute(input));
});
test('MMR-005/006 pinned never silently switches and strict pool excludes inherited model', () => {
  const input = routing([candidate('a', { credentialAvailable: false }), candidate('b')]);
  input.policy.mode = 'pinned';
  assert.throws(() => selectRoute(input), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PINNED_MODEL_UNAVAILABLE');
  input.policy.fallback = { allowPinnedSwitch: true, maxRetries: 1, retryableCodes: ['MODEL_UNAVAILABLE'] };
  assert.equal(selectRoute(input).selectedModel!.providerRouteId, 'b');
  const strict = routing();
  strict.approvedPool = [strict.catalog[1]!.ref];
  strict.inheritedModel = strict.catalog[0]!.ref;
  assert.equal(selectRoute(strict).selectedModel!.providerRouteId, 'b');
});
test('MMR-009/010 scores tie stably and lease hysteresis retains a feasible route', () => {
  const input = routing();
  assert.equal(selectRoute(input).selectedModel!.providerRouteId, 'a');
  input.currentAffinity = { id: 'existing', model: input.catalog[1]!.ref, partitionId: 'old', expiresAt: '2026-10-20T00:00:00Z' };
  input.hysteresisThreshold = 1;
  const selected = selectRoute(input);
  assert.equal(selected.selectedModel!.providerRouteId, 'b');
  assert.ok(selected.reasonCodes.includes('CACHE_AFFINITY_HYSTERESIS'));
});
test('MMR-011/012 effort exact blocks and acceptance always reconciles', () => {
  const input = routing([candidate('a')]);
  input.policy.effort = { mode: 'exact', requested: 'ultra' };
  assert.throws(() => selectRoute(input));
  const fallback = { allowPinnedSwitch: true, maxRetries: 2, retryableCodes: ['MODEL_UNAVAILABLE'] };
  assert.equal(decideFallback({ policy: fallback, mode: 'scored', errorCode: '401', accepted: false, effectsObserved: false, attempts: 0 }).action, 'block');
  assert.equal(decideFallback({ policy: fallback, mode: 'scored', errorCode: 'MODEL_UNAVAILABLE', accepted: true, effectsObserved: false, attempts: 0 }).action, 'reconcile');
});
test('MMR-025/026/027 shape follows ownership and shared resources', () => {
  const shape: TaskShape = { executionRequested: true, fullySpecified: false, designFork: false, lowImpact: false,
    surfaces: [{ id: 'a', paths: ['D:/repo/src/a'], resources: [], validated: true, ready: true }], dependencies: [] };
  assert.equal(classifyTaskShape(shape).tier, 'T1');
  shape.surfaces.push({ id: 'b', paths: ['D:/repo/src/b'], resources: [], validated: true, ready: true });
  assert.equal(classifyTaskShape(shape).tier, 'T3');
  shape.surfaces[0]!.resources = ['lockfile']; shape.surfaces[1]!.resources = ['lockfile'];
  assert.equal(classifyTaskShape(shape).tier, 'T2');
  shape.allowAgents = false;
  assert.equal(classifyTaskShape(shape).allowSpawn, false);
  assert.equal(classifyTaskShape(shape).assuranceGaps.length, 1);
});
test('MMR-037/038/045 empty checks and receipt-only fake PASS never pass', () => {
  const base = { nodeId: 'n', actor: actor('v'), priorActors: [actor('author'), actor('review')],
    routeDecisionId: 'route', candidateSnapshotHash: 'snapshot', contractHash: 'contract', now };
  assert.equal(evaluateGate({ ...base, policy: { ...gate, checks: [] }, receipts: [] }).verdict, 'inconclusive');
  const receipt = { checkId: 'actual-test', kind: 'command' as const, source: 'executor' as const, receiptRef: 'receipt',
    candidateSnapshotHash: 'snapshot', contractHash: 'contract', exitCode: 0, evidenceRefs: ['stdout'] };
  assert.equal(evaluateGate({ ...base, policy: gate, receipts: [receipt] }).verdict, 'inconclusive');
  assert.equal(evaluateGate({ ...base, policy: gate, receipts: [{ ...receipt, childResultValid: true, sampled: true }] }).verdict, 'pass');
  assert.equal(evaluateGate({ ...base, policy: gate, receipts: [{ ...receipt, childResultValid: true, sampled: true, exitCode: 1 }] }).verdict, 'fail');
  const artifactGate = { ...gate, checks: [{ id: 'artifact', kind: 'artifact' as const, required: true, nonEmpty: true }] };
  assert.equal(evaluateGate({ ...base, policy: artifactGate, receipts: [{ ...receipt, checkId: 'artifact', kind: 'artifact',
    source: 'artifact-store', exists: true, byteLength: 0, contentHash: 'hash', formatValid: true }] }).verdict, 'fail');
});
test('MMR-039..043 independent actor, fresh context and model facts are machine checked', () => {
  const author = actor('author'), reviewer = actor('reviewer');
  assert.equal(validateIndependence(author, [author]).valid, false);
  assert.equal(validateIndependence({ ...reviewer, inheritedFullHistory: true }, [author]).valid, false);
  assert.equal(validateIndependence({ ...reviewer, inputRefs: [{ ref: 'previous', kind: 'prior-verdict' }] }, [author]).valid, false);
  assert.equal(validateIndependence(reviewer, [author]).level, 'actor-independent');
  assert.equal(validateIndependence(reviewer, [author], { requireDifferentModel: true }).valid, false);
  assert.equal(validateIndependence(actor('reviewer', 'b'), [author], { requireDifferentModel: true }).level, 'cross-model-independent');
});
test('MMR-044/048 completion rejects any failed gate or live/unknown effects', () => {
  const input = { requiredGateIds: [], verdicts: [], candidateSnapshotHash: 's', contractHash: 'c',
    requiredGoals: ['g'], verifiedGoals: ['g'], unresolvedFindings: [], activeChildIds: ['active'], uncollectedChildIds: [], effectUnknown: false };
  assert.equal(aggregateCompletion(input).outcome, 'blocked');
  assert.equal(aggregateCompletion({ ...input, activeChildIds: [], effectUnknown: true }).outcome, 'blocked');
  assert.equal(aggregateCompletion({ ...input, activeChildIds: [] }).outcome, 'success');
});
test('MMR-046 failure fingerprint is evidence-bound and stops repeat repair', () => {
  const fingerprint = failureFingerprint({ contractHash: 'c', candidateSnapshotHash: 's', failureCode: 'X', checkId: 'test', evidenceHashes: ['h'] });
  assert.equal(assessRepairProgress({ previousFingerprint: fingerprint, nextFingerprint: fingerprint, repairRoundsUsed: 0,
    maxRepairRounds: 2, modelCallsUsed: 1, maxModelCalls: 60, deadlineExceeded: false }).reason, 'NO_PROGRESS_FINGERPRINT');
});
test('MMR-050/051 credential identity separates partitions and cross-provider excludes thinking', () => {
  const a = routing([candidate('a')]), b = routing([candidate('a', { ref: ref('a', 'account-b') })]);
  assert.notEqual(selectRoute(a).cachePartitionRef, selectRoute(b).cachePartitionRef);
  const manifest = createHandoffManifest({ from: ref('a'), to: ref('b'), fromPartition: 'pa', toPartition: 'pb',
    missionRef: 'mission', contractRef: 'contract', checkpointRef: 'checkpoint', artifactRefs: ['artifact'],
    unresolved: [], authorizationRefs: ['auth'], maxSummaryBytes: 200, allowSameProtocolContinuity: true,
    blocks: [{ id: 'summary', kind: 'summary', content: 'Minimum verified semantics', version: '1', sourceHash: 'h1' },
      { id: 'thinking', kind: 'signed-thinking', content: 'opaque', version: '1', sourceHash: 'h2' }] });
  assert.equal(manifest.blocks.length, 1); assert.equal(manifest.excludedContent[0]!.id, 'thinking');
});
const adaptation = (): Adaptation => ({
  id: 'skill1', revision: 1, kind: 'skill', scope: 'user', scopeId: 'u', canonicalName: 'lint',
  status: 'trial', author: 'learned', content: 'tool --required', sourceEvidenceRefs: ['e'], triggers: ['lint'],
  exclusions: [], expectedBenefit: 'Retain explicit flag', risks: [], regressionCases: ['required-flag'],
  replacements: [], commandSignatures: ['tool --required'], requiredTokens: ['--required'], modifies: [],
});
test('MMR-068 off never invokes loader; explicit preference is never held out', () => {
  const result = selectAdaptations({ activation: { explicit: 'off' }, load: () => { throw new Error('must never scan'); },
    sessionId: 's', turnId: 't', scope: { kind: 'user', id: 'u' } });
  assert.equal(result.baselineUnchanged, true);
  assert.equal(isTrialHoldout({ ...adaptation(), protectedPreference: true }, { sessionId: 's', turnId: 't', holdoutPercent: 100 }), false);
});
test('MMR-069/070 adaptation cannot change protected gates or remove command flag', () => {
  const options = { trustedProject: true, currentScope: { kind: 'user' as const, id: 'u' } };
  assert.equal(guardAdaptation({ ...adaptation(), modifies: ['protected-gates'] }, options).accepted, false);
  assert.equal(guardAdaptation({ ...adaptation(), revision: 2, content: 'tool', requiredTokens: [] },
    { ...options, previous: adaptation() }).accepted, false);
});
test('MMR-071/072 zero samples unknown; revisions dedupe and 3 helped promotes only once', () => {
  const value = adaptation();
  assert.equal(evaluateAdaptationPromotion({ adaptation: value, applications: [], evaluations: [], regressionPassed: true }).successRate, null);
  const applications = [1, 2, 3].map(id => ({ id: `${id}`, adaptationId: value.id, revision: 1, runId: `run${id}`,
    nodeId: 'n', appliedAt: now, inputSnapshotHash: 'h', holdout: false, decisionRef: 'd' }));
  const evaluations = applications.map(application => ({ applicationId: application.id, revision: 1,
    outcome: 'helped' as const, evidenceRefs: ['e'], completedTask: true }));
  const input = { adaptation: value, applications, evaluations: [...evaluations, evaluations[0]!], regressionPassed: true };
  assert.equal(evaluateAdaptationPromotion(input).helped, 3);
  assert.equal(evaluateAdaptationPromotion(input).action, 'promote');
  assert.equal(evaluateAdaptationPromotion({ ...input, alreadyPromoted: true }).action, 'already-active');
});
test('MMR-073 capacity requests replace/retire without deleting user assets', () => {
  const current = Array.from({ length: 30 }, (_, index) => ({ ...adaptation(), id: `old${index}`, canonicalName: `old${index}` }));
  current.push({ ...adaptation(), id: 'user', author: 'user' });
  const before = structuredClone(current);
  const result = checkAdaptationCapacity({ current, candidate: adaptation() });
  assert.equal(result.allowed, false);
  assert.equal(result.action, 'propose-replace-retire'); assert.deepEqual(result.protectedIds, ['user']);
  assert.deepEqual(current, before, 'capacity planning preserves all user/learned content and revisions');
});
test('MMR-073 capacity keeps learned updates ahead of replacement plans', () => {
  const current = Array.from({ length: 30 }, (_, index) => ({ ...adaptation(), id: `old${index}`, canonicalName: `old${index}` }));
  const value = current[0]!;
  assert.deepEqual(checkAdaptationCapacity({ current, candidate: { ...value, revision: 2, content: 'tool --required --verified' } }),
    { allowed: true, action: 'update', protectedIds: [] });
  assert.equal(checkAdaptationCapacity({ current, candidate: { ...value, id: 'duplicate-proposal' } }).action, 'update',
    'same learned canonical name and command signature identifies the existing entry to update');
});
test('MMR-073 learned candidates cannot reuse a user asset identity below capacity', () => {
  const user: Adaptation = { ...adaptation(), id: 'user', author: 'user' };
  const before = structuredClone(user);
  const result = checkAdaptationCapacity({ current: [user], candidate: { ...adaptation(), id: user.id, revision: 2 } });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.protectedIds, [user.id]);
  assert.deepEqual(user, before);
});
test('MMR-073 retired or quarantined matches do not bypass a full learned scope', () => {
  const current = Array.from({ length: 30 }, (_, index) => ({ ...adaptation(), id: `old${index}`, canonicalName: `old${index}` }));
  for (const status of ['retired', 'quarantined'] as const) {
    const dormant: Adaptation = { ...adaptation(), status };
    const result = checkAdaptationCapacity({ current: [...current, dormant], candidate: { ...adaptation(), revision: 2 } });
    assert.equal(result.allowed, false);
    assert.equal(result.action, 'propose-replace-retire');
  }
});
test('MMR-073 only live learned skills in the candidate scope consume capacity', () => {
  const current: Adaptation[] = [
    ...Array.from({ length: 30 }, (_, index) => ({ ...adaptation(), id: `other${index}`, scopeId: 'other', canonicalName: `other${index}` })),
    { ...adaptation(), id: 'retired', canonicalName: 'retired', status: 'retired' },
    { ...adaptation(), id: 'quarantined', canonicalName: 'quarantined', status: 'quarantined' },
    { ...adaptation(), id: 'user', canonicalName: 'handwritten', author: 'user' },
  ];
  assert.deepEqual(checkAdaptationCapacity({ current, candidate: adaptation() }),
    { allowed: true, action: 'insert', protectedIds: ['user'] });
  const full = Array.from({ length: 30 }, (_, index) => ({ ...adaptation(), id: `old${index}`, canonicalName: `old${index}` }));
  assert.equal(checkAdaptationCapacity({ current: full, candidate: { ...adaptation(), author: 'user' } }).allowed, true,
    'learned capacity does not evict or block explicit user assets');
});
test('MMR-085 generated leaf rejects unknown gates/metric dataset and limits regeneration', () => {
  const leaf = generateFrameworkLeaf({ axes: { deliverableKind: 'ml-eval', acceptanceKind: 'metric-threshold', targetLocus: 'in-repo' },
    mission: 'F1 target', inputs: ['data'], ownedPaths: ['D:/repo/eval'], acceptanceCriteria: ['F1 >= threshold'], harnessRef: 'host' });
  assert.equal(validateGeneratedLeaf(leaf, 1).status, 'regenerate');
  assert.equal(validateGeneratedLeaf(leaf, 2).status, 'OUT_OF_SCOPE');
  assert.equal(validateGeneratedLeaf({ ...leaf, datasetRef: 'fixed-data', gates: ['unknown'] }, 2).valid, false);
});
test('MMR-066 protected gate removal is rejected even when graph remains a DAG', () => {
  const blueprint: WorkflowBlueprint = { schemaVersion: 1, id: 'b', revision: 1, nodes: [{ id: 'done', kind: 'complete', ref: 'complete' }],
    roles: [], gates: [], edges: [], protectedInvariants: ['authorization', 'budget', 'idempotency', 'cancellation',
      'credentials', 'evidence', 'no-recursive-fleet'], budgets: { maxConcurrent: 4, maxNodes: 24, maxDepth: 4,
      maxModelCalls: 60, maxRetries: 2, maxRepairRounds: 2 }, sourceRefs: [], releaseEligible: true };
  assert.equal(validateBlueprint(blueprint).valid, false);
  assert.ok(validateBlueprint(blueprint).issues.some(issue => issue.code === 'PROTECTED_GATE_REMOVED'));
});
