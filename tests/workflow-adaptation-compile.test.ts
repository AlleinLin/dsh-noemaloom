import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NexusError, type NexusServices, type NexusStore, type StoredRecord } from '../src/ports/contracts.js';
import type { Adaptation, AdaptationApplication } from '../src/domain/orchestration/index.js';
import { OrchestrationService } from '../src/domain/workflow/orchestration-service.js';
import { compilePlanAdaptations, persistAdaptationApplications, saveCompiledPlan, type AdaptationSnapshot } from '../src/domain/workflow/adaptation-compiler.js';
import { validatePlan } from '../src/domain/workflow/plan.js';
import { digest } from '../src/domain/workflow/util.js';
import type { Run, TaskPlan } from '../src/domain/workflow/types.js';

class Store implements NexusStore {
  rows = new Map<string, StoredRecord>();
  reads: string[] = [];
  lists: string[] = [];
  async get<T>(collection: string, id: string): Promise<StoredRecord<T> | undefined> {
    this.reads.push(`${collection}:${id}`);
    return structuredClone(this.rows.get(`${collection}:${id}`)) as StoredRecord<T> | undefined;
  }
  async list<T>(collection: string): Promise<StoredRecord<T>[]> {
    this.lists.push(collection);
    return [...this.rows.entries()].filter(([key]) => key.startsWith(`${collection}:`))
      .map(([, row]) => structuredClone(row)) as StoredRecord<T>[];
  }
  async put<T>(collection: string, id: string, value: T, expected?: number): Promise<StoredRecord<T>> {
    const key = `${collection}:${id}`, previous = this.rows.get(key);
    if (expected !== undefined && expected !== (previous?.revision ?? 0)) throw new NexusError('REVISION_CONFLICT', 'CAS');
    const row = { id, revision: (previous?.revision ?? 0) + 1, value: structuredClone(value), updatedAt: '2026-10-20T00:00:00Z' };
    this.rows.set(key, row); return structuredClone(row);
  }
  async remove(collection: string, id: string): Promise<boolean> { return this.rows.delete(`${collection}:${id}`); }
}
const context = { sessionId: 'compile-session', actorId: 'compile-owner' };
const rule = (overrides: Partial<Adaptation> = {}): Adaptation => ({
  id: 'method-lint', revision: 1, kind: 'skill', scope: 'user', scopeId: context.actorId,
  canonicalName: 'lint', status: 'trial', author: 'learned', content: 'Retain literal --required when collecting lint evidence.',
  sourceEvidenceRefs: ['run-evidence:lint'], triggers: ['role:implementer'], exclusions: [],
  expectedBenefit: 'Keep required command flags', risks: ['Local evidence only'], regressionCases: ['required-flag'],
  replacements: [], commandSignatures: ['lint --required'], requiredTokens: ['--required'], modifies: [], ...overrides,
});
async function fixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nexus-adaptation-compile-')), store = new Store();
  let modelCalls = 0;
  const services: NexusServices = {
    store, workspaceRoot, dataDir: workspaceRoot, emit() {},
    executor: { async run() { throw new Error('compile must not execute commands'); } },
    host: {
      async facts() { return { capabilities: ['subagents', 'llm'], inheritAvailable: true, agentOptionsSupported: true }; },
      async sessions(action) { if (action === 'models/list') return []; throw new Error('unexpected session action'); },
      async model() { modelCalls++; throw new Error('compile must not call models'); },
      async spawn() { modelCalls++; throw new Error('compile must not spawn models'); },
      async secret() { return undefined; }, async approve() { throw new Error('compile must not request effects'); },
    },
    async invoke() { throw new Error('compile must not dispatch effects'); },
  };
  const orchestration = new OrchestrationService(services);
  return { services, store, orchestration, modelCalls: () => modelCalls,
    async close() { await rm(workspaceRoot, { recursive: true, force: true }); } };
}
function plan(root: string) {
  return validatePlan({ goal: 'Lint the declared change', nodes: [
    { id: 'implement', kind: 'agent', role: 'implementer', prompt: 'Implement only the requested change', writeClaims: [root] },
    { id: 'review', kind: 'agent', role: 'reviewer', prompt: 'Review the candidate independently', writeClaims: [], dependsOn: ['implement'] },
  ] }, { ...context, workspaceRoot: root });
}
function runSnapshot(value: TaskPlan): Run {
  return {
    schemaVersion: 1, id: 'frozen-run', planId: value.id, planRevision: 1, planHash: value.hash,
    planSnapshot: structuredClone(value), ownerSessionId: value.ownerSessionId, initiator: context.actorId,
    state: 'queued', startedAt: '2026-10-20T00:00:00Z', hostCapabilitySnapshot: {}, routeSnapshot: {},
    nodeRuns: Object.fromEntries(value.nodes.map(node => [node.id, { id: node.id, actorId: `actor:${node.id}`,
      state: 'queued' as const, attempt: 0, idempotencyKey: `run:${node.id}`, evidenceRefs: [] }])),
    usage: { attempts: [], modelCalls: 0, inputBytes: 0, outputBytes: 0, totalTokens: null, cost: null, complete: false, computeMs: 0, wallMs: 0 },
    events: [], artifacts: [], paused: false, cancellationRequested: false,
  };
}
test('MMR-068 public plan compile off preserves exact baseline nodes and never scans adaptations', async () => {
  const f = await fixture();
  try {
    await f.store.put('orchestration-adaptations', 'invalid-unused', { content: 'malformed and must not be loaded' }, 0);
    const value = plan(f.services.workspaceRoot), before = structuredClone(value);
    await compilePlanAdaptations(f.services, value, {}, context);
    assert.deepEqual(value, before);
    assert.equal(f.store.lists.includes('orchestration-adaptations'), false);
    f.store.reads = [];
    await compilePlanAdaptations(f.services, value, { adaptations: { enabled: false } }, context);
    assert.deepEqual(f.store.reads, []);
    assert.equal(f.modelCalls(), 0);
  } finally { await f.close(); }
});
test('MMR-063/070 applied method version is frozen on the plan and generated applications cannot be caller invented', async () => {
  const f = await fixture();
  try {
    await f.orchestration.adaptations({ action: 'adaptations/settings', params: { enabled: true, projectTrusted: true, holdoutPercent: 0 } }, context);
    const initial = rule(); await f.store.put('orchestration-adaptations', initial.id, initial, 0);
    const value = plan(f.services.workspaceRoot), baseline = structuredClone(value);
    await compilePlanAdaptations(f.services, value, {}, context); await saveCompiledPlan(f.services, value);
    assert.match(value.nodes[0].prompt!, /Retain literal --required/);
    assert.equal(value.nodes[1].prompt, baseline.nodes[1].prompt);
    assert.deepEqual(value.nodes.map(node => node.role), baseline.nodes.map(node => node.role));
    assert.deepEqual(value.edges, baseline.edges);
    assert.deepEqual(value.budgets, baseline.budgets);
    assert.deepEqual(value.deliveryContract, baseline.deliveryContract);
    await f.store.put('orchestration-adaptations', initial.id, rule({ revision: 2, content: 'NEW CONTENT --required' }), 1);
    const run = runSnapshot(value); await f.store.put('workflow-runs', run.id, run, 0);
    await persistAdaptationApplications(f.services, run); await persistAdaptationApplications(f.services, run);
    const apps = await f.store.list<AdaptationApplication>('orchestration-applications');
    assert.equal(apps.length, 1); assert.equal(apps[0].value.revision, 1);
    assert.equal(apps[0].value.inputSnapshotHash, value.hash);
    assert.equal((value.provenance.adaptationSnapshot as unknown as AdaptationSnapshot).rules[0].adaptation.content, initial.content);
    await assert.rejects(f.orchestration.adaptations({ action: 'adaptations/application', params: { record: apps[0].value } }, context),
      (error: unknown) => error instanceof NexusError && error.code === 'AUTHORIZATION_REQUIRED');
    const forged = structuredClone(run); forged.planSnapshot.provenance.adaptationSnapshot = { rules: [] };
    await assert.rejects(persistAdaptationApplications(f.services, forged));
    assert.equal(f.modelCalls(), 0);
  } finally { await f.close(); }
});
test('MMR-069/071 trial holdouts, exclusions and trusted project scope are enforced during actual compilation', async () => {
  const f = await fixture();
  try {
    await f.orchestration.adaptations({ action: 'adaptations/settings', params: { enabled: true, projectTrusted: false, holdoutPercent: 100 } }, context);
    for (const item of [
      rule(), rule({ id: 'explicit', protectedPreference: true, content: 'Explicit preference --required' }),
      rule({ id: 'excluded', exclusions: ['goal:lint'] }),
      rule({ id: 'project', scope: 'project', scopeId: digest(f.services.workspaceRoot) }),
      rule({ id: 'other-user', scopeId: 'private-other-user' }),
      rule({ id: 'protected', modifies: ['protected-gates'], content: 'Attempted protected mutation --required' }),
    ]) await f.store.put('orchestration-adaptations', item.id, item, 0);
    const value = plan(f.services.workspaceRoot);
    await compilePlanAdaptations(f.services, value, {}, context); await saveCompiledPlan(f.services, value);
    assert.match(value.nodes[0].prompt!, /Explicit preference --required/);
    assert.doesNotMatch(value.nodes[0].prompt!, /Retain literal|Attempted protected/);
    const run = runSnapshot(value); await persistAdaptationApplications(f.services, run);
    const apps = (await f.store.list<AdaptationApplication>('orchestration-applications')).map(row => row.value);
    assert.deepEqual(apps.map(item => [item.adaptationId, item.holdout]).sort(), [['explicit', false], ['method-lint', true]]);
    assert.equal(f.modelCalls(), 0);
  } finally { await f.close(); }
});
test('MMR-083/085 generated leaf is private, discoverable and compiles to one implementation in the shared TaskPlan', async () => {
  const f = await fixture();
  try {
    const generated = await f.orchestration.blueprints({ action: 'blueprints/generate', params: { input: {
      axes: { deliverableKind: 'docs', acceptanceKind: 'receipts', targetLocus: 'in-repo' },
      mission: 'Document the declared API using source references', inputs: ['source:api'],
      ownedPaths: [f.services.workspaceRoot], acceptanceCriteria: ['All described exports have source references'], harnessRef: 'host',
    } } }, context) as StoredRecord<{ hash: string }>;
    const listed = await f.orchestration.blueprints({ action: 'blueprints/leaves/list' }, context) as { id: string }[];
    assert.equal(listed[0].id, generated.id);
    await assert.rejects(f.orchestration.blueprints({ action: 'blueprints/leaves/get', params: { leafId: generated.id } },
      { ...context, sessionId: 'private-other-session' }), (error: unknown) => error instanceof NexusError && error.code === 'SCOPE_MISMATCH');
    const result = await f.orchestration.blueprints({ action: 'blueprints/compile_leaf', params: {
      leafId: generated.id, leafHash: generated.value.hash, goal: 'Write API docs only',
      oracles: Object.fromEntries(['G1', 'G4', 'G5', 'G6', 'goal-check'].map(id =>
        [id, [{ id: `actual:${id}`, kind: 'command', command: 'authorized-check', args: [id] }]])),
    } }, context) as { plan: StoredRecord<TaskPlan> };
    const value = result.plan.value;
    assert.equal(value.nodes.filter(node => node.role === 'implementer').length, 1);
    assert.match(value.nodes.find(node => node.role === 'implementer')!.prompt!, /All described exports have source references/);
    assert.deepEqual(value.nodes.find(node => node.role === 'implementer')!.writeClaims, [f.services.workspaceRoot]);
    assert.ok(value.nodes.some(node => node.orchestration?.gateId === 'G5'));
    assert.ok(value.nodes.some(node => node.orchestration?.gateId === 'G6'));
    assert.ok(value.provenance.generatedLeafSnapshot);
    assert.equal(f.modelCalls(), 0);
  } finally { await f.close(); }
});
test('MMR-084 generated metric policy refuses an oracle for another dataset or weaker threshold', async () => {
  const f = await fixture();
  try {
    const generated = await f.orchestration.blueprints({ action: 'blueprints/generate', params: { input: {
      axes: { deliverableKind: 'ml-eval', acceptanceKind: 'metric-threshold', targetLocus: 'in-repo' },
      mission: 'Evaluate fixed F1', inputs: ['dataset:fixed'], ownedPaths: [f.services.workspaceRoot],
      acceptanceCriteria: ['F1 >= 0.9'], harnessRef: 'host', datasetRef: 'dataset:fixed',
      oracleChecks: [{ id: 'f1', kind: 'metric', required: true, datasetRef: 'dataset:fixed', metric: { operator: '>=', threshold: 0.9, tolerance: 0.01 } }],
    } } }, context) as StoredRecord;
    const oracles = Object.fromEntries(['G1', 'G4', 'G5', 'goal-check'].map(id =>
      [id, [{ id: `actual:${id}`, kind: 'command', command: 'authorized-check' }]]));
    await assert.rejects(f.orchestration.blueprints({ action: 'blueprints/compile_leaf', params: {
      leafId: generated.id, goal: 'Evaluate fixed F1', oracles: { ...oracles,
        G6: [{ id: 'f1', kind: 'metric', path: 'actual.json', jsonPath: 'f1', min: 0.1, datasetRef: 'dataset:other' }] },
    } }, context), (error: unknown) => error instanceof NexusError && error.code === 'EVIDENCE_MISMATCH');
    assert.equal(f.modelCalls(), 0);
  } finally { await f.close(); }
});
test('MMR-085 generation attempts and failure diagnostics are server owned, bounded and request-idempotent', async () => {
  const f = await fixture();
  try {
    const input = { axes: { deliverableKind: 'ml-eval', acceptanceKind: 'metric-threshold', targetLocus: 'in-repo' },
      mission: 'Incomplete metric contract', inputs: ['dataset:missing'], ownedPaths: [f.services.workspaceRoot],
      acceptanceCriteria: ['F1 must meet a threshold'], harnessRef: 'host' };
    let generationId = '';
    await assert.rejects(f.orchestration.blueprints({ action: 'blueprints/generate', requestId: 'first-generation-request', params: { input } }, context),
      (error: unknown) => {
        if (!(error instanceof NexusError) || error.code !== 'GENERATED_LEAF_REGENERATE') return false;
        generationId = (error.details as { generationId: string }).generationId;
        return Boolean(generationId);
      });
    await assert.rejects(f.orchestration.blueprints({ action: 'blueprints/generate', requestId: 'first-generation-request', params: { input } }, context));
    const first = await f.orchestration.blueprints({ action: 'blueprints/leaves/generation', params: { generationId } }, context) as { attempts: number };
    assert.equal(first.attempts, 1, 'retrying the same request does not consume the sole regeneration');
    await assert.rejects(f.orchestration.blueprints({ action: 'blueprints/generate', params: { generationId, input, generationAttempt: 1 } }, context),
      (error: unknown) => error instanceof NexusError && error.code === 'REVISION_CONFLICT');
    await assert.rejects(f.orchestration.blueprints({ action: 'blueprints/generate', requestId: 'second-generation-request',
      params: { generationId, input, generationAttempt: 2 } }, context),
    (error: unknown) => error instanceof NexusError && error.code === 'OUT_OF_SCOPE');
    await assert.rejects(f.orchestration.blueprints({ action: 'blueprints/generate', params: { generationId, input } }, context),
      (error: unknown) => error instanceof NexusError && error.code === 'OUT_OF_SCOPE');
    const final = await f.orchestration.blueprints({ action: 'blueprints/leaves/generation', params: { generationId } }, context) as { attempts: number; diagnostics: unknown[] };
    assert.equal(final.attempts, 2); assert.equal(final.diagnostics.length, 2);
    assert.equal(f.modelCalls(), 0, 'descriptor generation is a typed compiler, not an unmetered model call');
  } finally { await f.close(); }
});
