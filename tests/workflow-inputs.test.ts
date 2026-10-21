import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePlan } from '../src/domain/workflow/plan.js';
import { resolveWorkflowInputs } from '../src/domain/workflow/inputs.js';
import { digest } from '../src/domain/workflow/util.js';
import type { ArtifactRef, Run, TaskNode } from '../src/domain/workflow/types.js';
import { NexusError, type JsonRecord, type NexusStore, type StoredRecord } from '../src/ports/contracts.js';

const context = { sessionId: 'scope-session' };
function definition(extra: JsonRecord = {}): JsonRecord {
  return {
    goal: 'graph inputs',
    nodes: [
      { id: 'source', kind: 'agent', prompt: 'source' },
      { id: 'middle', kind: 'prompt', prompt: 'middle', dependsOn: ['source'] },
      { id: 'sink', kind: 'synthesis', prompt: 'sink', dependsOn: ['middle'], inputRefs: ['node:source'] },
    ],
    ...extra,
  };
}
class InputStore implements NexusStore {
  rows = new Map<string, StoredRecord>();
  async get<T>(collection: string, id: string): Promise<StoredRecord<T> | undefined> {
    const row = this.rows.get(`${collection}/${id}`);
    return row ? structuredClone(row) as StoredRecord<T> : undefined;
  }
  async put<T>(collection: string, id: string, value: T): Promise<StoredRecord<T>> {
    const row = { id, value: structuredClone(value), revision: 1, updatedAt: new Date().toISOString() };
    this.rows.set(`${collection}/${id}`, row);
    return structuredClone(row);
  }
  async list<T>(): Promise<StoredRecord<T>[]> { return []; }
  async remove(): Promise<boolean> { return false; }
}
async function fixture(content = 'exact upstream result') {
  const plan = validatePlan(definition(), context);
  const store = new InputStore();
  const artifact: ArtifactRef = { id: 'artifact-source', nodeId: 'source', hash: digest(content),
    bytes: Buffer.byteLength(content), mediaType: 'text/plain' };
  const run: Run = {
    schemaVersion: 1, id: 'run-this-scope', planId: plan.id, planRevision: 1, planHash: plan.hash,
    planSnapshot: plan, ownerSessionId: plan.ownerSessionId, initiator: 'user', state: 'running',
    startedAt: new Date().toISOString(), hostCapabilitySnapshot: {}, routeSnapshot: {},
    nodeRuns: Object.fromEntries(plan.nodes.map(node => [node.id, {
      id: node.id, actorId: `actor-${node.id}`, state: node.id === 'source' ? 'succeeded' : 'queued',
      attempt: node.id === 'source' ? 1 : 0, idempotencyKey: `run:${node.id}`, evidenceRefs: [],
      ...(node.id === 'source' ? { resultRef: artifact } : {}),
    }])),
    artifacts: [artifact], paused: false, cancellationRequested: false, events: [],
    usage: { attempts: [], modelCalls: 0, inputBytes: 0, outputBytes: 0, totalTokens: null,
      cost: null, complete: false, computeMs: 0, wallMs: 0 },
  };
  await store.put('workflow-artifacts', artifact.id, { runId: run.id, nodeId: 'source', content, hash: artifact.hash });
  return { store, run, artifact, sink: plan.nodes.find(node => node.id === 'sink')! };
}
const code = (expected: string) => (error: unknown) => error instanceof NexusError && error.code === expected;

test('editor layout is detached, bounded and preserved in the frozen plan hash', () => {
  const editor = { schemaVersion: 1, layout: { source: { x: 0, y: 20000 }, sink: { x: 333.5, y: 42 } } };
  const plan = validatePlan(definition({ editor }), context);
  assert.deepEqual(plan.editor, editor);
  assert.notEqual(plan.editor, editor);
  assert.notEqual(plan.editor!.layout.source, editor.layout.source);
  assert.equal(plan.hash, digest({ ...plan, hash: undefined }));
  const originalHash = plan.hash;
  editor.layout.source.x = 99;
  assert.equal(plan.editor!.layout.source.x, 0);
  plan.editor!.layout.source.x = 1;
  assert.notEqual(digest({ ...plan, hash: undefined }), originalHash);
});

test('editor rejects nonfinite coordinates, foreign nodes, extra fields and oversized layouts', () => {
  for (const editor of [
    { schemaVersion: 1, layout: { source: { x: NaN, y: 0 } } },
    { schemaVersion: 1, layout: { source: { x: Infinity, y: 0 } } },
    { schemaVersion: 1, layout: { source: { x: -1, y: 0 } } },
    { schemaVersion: 1, layout: { source: { x: 20001, y: 0 } } },
    { schemaVersion: 1, layout: { source: { x: '1', y: 0 } } },
    { schemaVersion: 1, layout: { missing: { x: 1, y: 0 } } },
    { schemaVersion: 1, layout: { source: { x: 1, y: 0, command: 'must not execute' } } },
    { schemaVersion: 1, layout: {}, executable: true },
    { schemaVersion: 2, layout: {} },
    { schemaVersion: 1, layout: Array.from({ length: 65 }, (_, i) => ({ x: i, y: 0 })) },
  ]) assert.throws(() => validatePlan(definition({ editor }), context), code('INVALID_ARGUMENT'));
});

test('data edges declare actual input bindings; dependency edges only order nodes', () => {
  const plan = validatePlan({
    goal: 'data edge',
    nodes: [{ id: 'source', kind: 'agent', prompt: 'source' },
      { id: 'sink', kind: 'prompt', prompt: 'sink' },
      { id: 'ordered', kind: 'prompt', prompt: 'ordered' }],
    edges: [{ from: 'source', to: 'sink', kind: 'data' }, { from: 'source', to: 'ordered', kind: 'dependency' }],
  }, context);
  assert.deepEqual(plan.nodes.find(node => node.id === 'sink')!.inputRefs, ['node:source']);
  assert.equal(plan.nodes.find(node => node.id === 'ordered')!.inputRefs, undefined);
});

test('node references must exist on an upstream path and target a supported data consumer', () => {
  for (const nodes of [
    [{ id: 'source', kind: 'agent', prompt: 'source' }, { id: 'sink', kind: 'agent', prompt: 'sink', inputRefs: ['node:missing'] }],
    [{ id: 'source', kind: 'agent', prompt: 'source' }, { id: 'sink', kind: 'agent', prompt: 'sink', inputRefs: ['node:source'] }],
    [{ id: 'source', kind: 'agent', prompt: 'source', inputRefs: ['node:source'] }],
    [{ id: 'source', kind: 'agent', prompt: 'source' }, { id: 'sink', kind: 'tool', domain: 'files', action: 'read', dependsOn: ['source'], inputRefs: ['node:source'] }],
    [{ id: 'source', kind: 'agent', prompt: 'source' }, { id: 'sink', kind: 'agent', prompt: 'sink', dependsOn: ['source'], inputRefs: ['node:'] }],
  ]) assert.throws(() => validatePlan({ goal: 'reject invalid reference', nodes }, context), code('INVALID_ARGUMENT'));
});

test('same-run completed upstream results resolve across a transitive dependency path without truncation', async () => {
  const content = 'x'.repeat(14000) + 'END-OF-UPSTREAM';
  const f = await fixture(content);
  const inputs = await resolveWorkflowInputs(f, f.run, f.sink);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].binding, 'node:source');
  assert.equal(inputs[0].ref.id, f.artifact.id);
  assert.equal(inputs[0].content, content);
});

test('pending, failed and missing-result upstream nodes cannot feed a downstream model', async () => {
  for (const state of ['running', 'failed', 'cancelled', 'effectUnknown'] as const) {
    const f = await fixture();
    f.run.nodeRuns.source.state = state;
    await assert.rejects(resolveWorkflowInputs(f, f.run, f.sink), code('DEPENDENCY_FAILED'));
  }
  const f = await fixture();
  delete f.run.nodeRuns.source.resultRef;
  await assert.rejects(resolveWorkflowInputs(f, f.run, f.sink), code('DEPENDENCY_FAILED'));
});

test('cross-run artifacts, forged source identities and changed dependency paths are rejected', async () => {
  const foreign = await fixture();
  await foreign.store.put('workflow-artifacts', foreign.artifact.id, {
    runId: 'run-another-workspace', nodeId: 'source', content: 'exact upstream result', hash: foreign.artifact.hash,
  });
  await assert.rejects(resolveWorkflowInputs(foreign, foreign.run, foreign.sink), code('SCOPE_MISMATCH'));
  const wrongNode = await fixture();
  wrongNode.run.nodeRuns.source.resultRef!.nodeId = 'another-node';
  await assert.rejects(resolveWorkflowInputs(wrongNode, wrongNode.run, wrongNode.sink), code('DEPENDENCY_FAILED'));
  const unrelated = await fixture();
  unrelated.run.planSnapshot.edges = [];
  await assert.rejects(resolveWorkflowInputs(unrelated, unrelated.run, unrelated.sink), code('SCOPE_MISMATCH'));
});

test('raw artifact inputs also require membership in the selected run', async () => {
  const f = await fixture();
  const sink: TaskNode = { ...f.sink, inputRefs: ['artifact-from-another-run'] };
  await f.store.put('workflow-artifacts', 'artifact-from-another-run', {
    runId: 'foreign-run', nodeId: 'source', content: 'must not disclose', hash: digest('must not disclose'),
  });
  await assert.rejects(resolveWorkflowInputs(f, f.run, sink), code('SCOPE_MISMATCH'));
});

test('hash, byte length and input budgets are checked before resolving model input', async () => {
  const changed = await fixture();
  await changed.store.put('workflow-artifacts', changed.artifact.id, {
    runId: changed.run.id, nodeId: 'source', content: 'mutated result', hash: digest('mutated result'),
  });
  await assert.rejects(resolveWorkflowInputs(changed, changed.run, changed.sink), code('EVIDENCE_MISMATCH'));
  const oversized = await fixture('x'.repeat(1000));
  oversized.run.planSnapshot.budgets.maxInputBytes = 100;
  await assert.rejects(resolveWorkflowInputs(oversized, oversized.run, oversized.sink), code('BUDGET_EXHAUSTED'));
});
