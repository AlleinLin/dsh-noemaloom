import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePlan } from '../src/domain/workflow/plan.js';
import {
  isWorkflowDraft, newWorkflowDraft, removeWorkflowEdge, removeWorkflowNode, updateWorkflowEdge,
  workflowConnectionError, workflowDeleteShortcut, workflowDraftFromPlan,
  workflowDraftKey, workflowModelOptions, workflowPlanPayload,
} from '../src/client/workflow-editor-model.js';

function pipeline() {
  const draft = newWorkflowDraft();
  draft.goal = '从调查结果生成报告';
  draft.nodes[0].prompt = '调查问题并输出依据';
  draft.nodes.push({ id: 'report', kind: 'synthesis', prompt: '根据上游结果输出报告', outputContracts: { json: true, requiredFields: ['summary'], nonEmpty: true } });
  draft.layout.report = { x: 480, y: 80 };
  draft.edges.push({ from: 'node-1', to: 'report', kind: 'data' });
  draft.requiredNodeIds = ['report'];
  return draft;
}

test('a canvas data edge compiles into both a real dependency and a bounded upstream result reference', () => {
  const payload = workflowPlanPayload(pipeline());
  assert.deepEqual(payload.edges, [{ from: 'node-1', to: 'report', kind: 'data' }]);
  assert.deepEqual(payload.nodes[1].inputRefs, ['node:node-1']);
  assert.deepEqual(payload.nodes[1].outputContracts, { json: true, requiredFields: ['summary'], nonEmpty: true });
  assert.deepEqual(payload.deliveryContract.requiredNodeIds, ['report']);
  const frozen = validatePlan(payload, { sessionId: 'session-A' });
  assert.equal(frozen.ownerSessionId, 'session-A');
  assert.equal(frozen.nodes[1].prompt, '根据上游结果输出报告');
});

test('the editor rejects cyclic wiring and does not advertise unsupported tool or manual data transport', () => {
  const draft = pipeline();
  assert.match(workflowConnectionError(draft, { from: 'report', to: 'node-1', kind: 'data' })!, /循环/);
  draft.nodes.push({ id: 'tool', kind: 'tool', domain: 'files', action: 'read' });
  assert.match(workflowConnectionError(draft, { from: 'report', to: 'tool', kind: 'data' })!, /数据流只能/);
  assert.equal(workflowConnectionError(draft, { from: 'report', to: 'tool', kind: 'dependency' }), undefined);
  draft.nodes.push({ id: 'manual', kind: 'manual' });
  assert.match(workflowConnectionError(draft, { from: 'manual', to: 'report', kind: 'data' })!, /人工节点/);
});

test('frozen plan roundtrip retains layout and transitive data inputs as visible wires', () => {
  const draft = pipeline();
  draft.nodes.push({ id: 'final', kind: 'synthesis', prompt: '交付结果', inputRefs: ['node:node-1'] });
  draft.layout.final = { x: 800, y: 200 };
  draft.edges.push({ from: 'report', to: 'final', kind: 'dependency' });
  const payload = workflowPlanPayload(draft);
  payload.nodes[2].inputRefs = ['node:node-1'];
  const plan = validatePlan(payload, { sessionId: 'session-A' });
  const restored = workflowDraftFromPlan({ ...plan, editor: { schemaVersion: 1, layout: draft.layout } });
  assert.deepEqual(restored.layout.final, { x: 800, y: 200 });
  assert.ok(restored.edges.some(edge => edge.from === 'node-1' && edge.to === 'final' && edge.kind === 'data'));
  assert.deepEqual(workflowPlanPayload(restored).nodes[2].inputRefs, ['node:node-1']);
});

test('draft keys isolate each workspace and conversation and never borrow another scope identity', () => {
  const keys = [
    workflowDraftKey({ level: 'global' }),
    workflowDraftKey({ level: 'workspace', workspaceId: 'A' }),
    workflowDraftKey({ level: 'workspace', workspaceId: 'B' }),
    workflowDraftKey({ level: 'session', sessionId: 'A' }),
    workflowDraftKey({ level: 'session', sessionId: 'B' }),
  ];
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys[0], workflowDraftKey({ level: 'global', workspaceId: 'unexpected', sessionId: 'unexpected' }));
  assert.throws(() => workflowDraftKey({ level: 'workspace' }), /请选择工作区/);
  assert.throws(() => workflowDraftKey({ level: 'session' }), /请打开一个会话/);
});

test('model choices preserve exact live provider/model aliases and only known effort levels', () => {
  assert.deepEqual(workflowModelOptions({ items: [
    { ref: { providerRouteId: 'provider/a', modelId: 'model:b' }, capabilities: { reasoningEffort: { state: 'declared', value: ['low', 'high'] } } },
    { ref: { providerRouteId: 'provider/a', modelId: 'model:other' }, capabilities: { reasoningEffort: { state: 'unknown', value: ['invented'] } } },
  ] }), [
    { key: JSON.stringify(['provider/a', 'model:b']), provider: 'provider/a', model: 'model:b', efforts: ['low', 'high'] },
    { key: JSON.stringify(['provider/a', 'model:other']), provider: 'provider/a', model: 'model:other', efforts: [] },
  ]);
});

test('incomplete drafts remain editable while corrupted stored nodes and coordinates are rejected', () => {
  assert.equal(isWorkflowDraft(newWorkflowDraft()), true);
  const prompt = newWorkflowDraft();
  (prompt.nodes[0] as any).prompt = { text: 'invalid' };
  assert.equal(isWorkflowDraft(prompt), false);
  const coordinate = newWorkflowDraft();
  coordinate.layout['node-1'].x = Number.POSITIVE_INFINITY;
  assert.equal(isWorkflowDraft(coordinate), false);
  const fields = newWorkflowDraft();
  (fields.nodes[0].outputContracts as any).requiredFields = 'summary';
  assert.equal(isWorkflowDraft(fields), false);
});

test('editing a frozen plan retains optional dependencies and final verification contracts', () => {
  const payload = workflowPlanPayload(pipeline());
  payload.edges[0].optional = true;
  payload.deliveryContract.checks = [{ kind: 'artifact', artifactId: 'required-proof', nonEmpty: true }];
  payload.authorizationRefs = ['approval:original-plan'];
  const plan = validatePlan(payload, { sessionId: 'session-A' });
  const compiled = workflowPlanPayload(workflowDraftFromPlan(plan));
  assert.equal(compiled.edges[0].optional, true);
  assert.deepEqual(compiled.deliveryContract.checks, payload.deliveryContract.checks);
  assert.deepEqual(compiled.authorizationRefs, ['approval:original-plan']);
});

test('removing a node clears its wires, references and process/result contracts without mutating the draft', () => {
  const draft = pipeline();
  draft.nodes[1].inputRefs = ['node:node-1', 'artifact:kept'];
  draft.nodes[1].dependsOn = ['node-1'];
  draft.nodes[1].checks = [
    { kind: 'independence', authorNodeIds: ['node-1'], reviewerNodeIds: ['report'] },
    { kind: 'artifact', artifactId: 'kept' },
  ];
  draft.paramsText['node-1'] = '{"obsolete":true}';
  draft.checksText['node-1'] = '[{"kind":"artifact"}]';
  draft.checksText.report = JSON.stringify(draft.nodes[1].checks);
  draft.deliveryChecks = [{ kind: 'independence', subjectNodeId: 'node-1' }, { kind: 'artifact', artifactId: 'kept' }];
  draft.requiredNodeIds = ['node-1', 'report'];
  const next = removeWorkflowNode(draft, 'node-1');
  assert.deepEqual(next.nodes.map(node => node.id), ['report']);
  assert.deepEqual(next.edges, []);
  assert.deepEqual(next.nodes[0].inputRefs, ['artifact:kept']);
  assert.deepEqual(next.nodes[0].dependsOn, []);
  assert.deepEqual(next.nodes[0].checks, [{ kind: 'artifact', artifactId: 'kept' }]);
  assert.deepEqual(JSON.parse(next.checksText.report), next.nodes[0].checks);
  assert.deepEqual(next.deliveryChecks, [{ kind: 'artifact', artifactId: 'kept' }]);
  assert.deepEqual(next.requiredNodeIds, ['report']);
  assert.equal('node-1' in next.layout, false);
  assert.equal('node-1' in next.paramsText, false);
  assert.equal('node-1' in next.checksText, false);
  assert.equal(draft.nodes.length, 2);
  assert.equal(draft.edges.length, 1);
  assert.equal(removeWorkflowNode(draft, 'missing'), draft);
});

test('the last node can be removed and the empty draft survives reload until a replacement is added', () => {
  const next = removeWorkflowNode(newWorkflowDraft(), 'node-1');
  assert.equal(isWorkflowDraft(JSON.parse(JSON.stringify(next))), true);
  assert.deepEqual(next.nodes, []);
  assert.deepEqual(next.requiredNodeIds, []);
  assert.throws(() => workflowPlanPayload(next), /1–64/);
});

test('editing or deleting a wire changes real plan inputs and validates the new edge kind', () => {
  const draft = pipeline();
  draft.nodes[1].inputRefs = ['node:node-1', 'artifact:kept'];
  draft.nodes[1].dependsOn = ['node-1'];
  const changed = updateWorkflowEdge(draft, 'node-1:report', { kind: 'dependency', optional: true });
  assert.deepEqual(changed.edges, [{ from: 'node-1', to: 'report', kind: 'dependency', optional: true }]);
  assert.deepEqual(workflowPlanPayload(changed).nodes[1].inputRefs, ['artifact:kept']);
  const data = updateWorkflowEdge(changed, 'node-1:report', { kind: 'data' });
  assert.deepEqual(data.edges, [{ from: 'node-1', to: 'report', kind: 'data' }]);
  assert.deepEqual(workflowPlanPayload(data).nodes[1].inputRefs, ['artifact:kept', 'node:node-1']);
  const removed = removeWorkflowEdge(draft, 'node-1:report');
  assert.deepEqual(removed.edges, []);
  assert.deepEqual(removed.nodes[1].dependsOn, []);
  assert.deepEqual(workflowPlanPayload(removed).nodes[1].inputRefs, ['artifact:kept']);
  draft.nodes[1].kind = 'tool';
  draft.edges[0].kind = 'dependency';
  assert.throws(() => updateWorkflowEdge(draft, 'node-1:report', { kind: 'data' }), /数据流只能/);
  assert.equal(draft.edges[0].kind, 'dependency');
});

test('canvas deletion shortcuts do not consume text editing, composition or modified keys', () => {
  assert.equal(workflowDeleteShortcut({ key: 'Delete' }, false), true);
  assert.equal(workflowDeleteShortcut({ key: 'Backspace' }, false), true);
  assert.equal(workflowDeleteShortcut({ key: 'Delete' }, true), false);
  for (const flag of ['isComposing', 'defaultPrevented', 'ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
    assert.equal(workflowDeleteShortcut({ key: 'Delete', [flag]: true }, false), false, flag);
  }
  assert.equal(workflowDeleteShortcut({ key: 'Enter' }, false), false);
});
