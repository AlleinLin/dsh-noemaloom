import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTONOMY_COLLECTION, AUTONOMY_HOOK_ACTOR, createAutonomyModule, type AutonomyPlan,
} from '../src/domain/autonomy/index.js';
import { parsePlan, validatePlan } from '../src/domain/autonomy/types.js';
import { workspaceIdentity } from '../src/domain/workspace-runtime.js';
import {
  NexusError, type DispatchContext, type JsonRecord, type ModelRequest, type NexusServices, type NexusStore, type StoredRecord,
} from '../src/ports/contracts.js';

const plan = {
  objective: '修复导入并验证',
  steps: [
    { id: 'repair', title: '修复', description: '检查并修复导入', dependsOn: [], acceptance: ['导入路径正确'] },
    { id: 'verify', title: '验证', description: '检查修复后的行为', dependsOn: ['repair'], acceptance: ['验证结果通过'] },
  ],
};
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const rows = new Map<string, StoredRecord>();
  rows.set('scope-settings/global/auxiliary', { id: 'global/auxiliary', revision: 1, updatedAt: '', value: { defaults: { routes: [{ provider: 'mock', model: 'fake' }] } } });
  const store: NexusStore = {
    async get<T>(collection: string, id: string) { return structuredClone(rows.get(`${collection}/${id}`)) as StoredRecord<T> | undefined; },
    async list<T>(collection: string) {
      return [...rows].filter(([key]) => key.startsWith(`${collection}/`)).map(([, row]) => structuredClone(row)) as StoredRecord<T>[];
    },
    async put<T>(collection: string, id: string, value: T, revision?: number) {
      const key = `${collection}/${id}`, previous = rows.get(key);
      if (revision !== undefined && revision !== (previous?.revision ?? 0)) throw new NexusError('REVISION_CONFLICT', 'stale revision');
      const row = { id, value: structuredClone(value), revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
      rows.set(key, row); return structuredClone(row);
    },
    async remove(collection, id) { return rows.delete(`${collection}/${id}`); },
  };
  const context: DispatchContext = { scopeLevel: 'session', sessionId: 'main', workspaceRoot: 'D:/fixture/a' };
  const key = `${workspaceIdentity(context.workspaceRoot!)}/${context.sessionId}`;
  const modelRequests: ModelRequest[] = [], deliveries: JsonRecord[] = [], actions: string[] = [];
  const activations = new Map<string, any>();
  let nativeSeq = 2, sequence = 0, uncertain = false, lookup: any = { found: false };
  let pending = { nextTurn: 0, nextStep: 0 }, lastTurnReason: any = { kind: 'completed' };
  let lines: any[] = [{ seq: 0, kind: 'user/message', text: '修复导入' }];
  let truncated = false, wrongSurface = false, verdictOverride: string | undefined;
  let modelGate: ReturnType<typeof deferred> | undefined, deliveryGate: ReturnType<typeof deferred> | undefined;
  let modelStarted = deferred<ModelRequest>(), deliveryStarted = deferred<JsonRecord>();
  let rejectModel = false;
  const services = {
    store, workspaceRoot: context.workspaceRoot, dataDir: 'D:/fixture/data', emit() {},
    host: {
      async model(request: ModelRequest) {
        modelRequests.push(request); modelStarted.resolve(request);
        assert.equal(request.allowChildren, false); assert.equal(request.readOnly, true);
        if (modelGate) await modelGate.promise;
        if (rejectModel) throw new Error('mock provider failure');
        return { text: request.role === 'autonomous-plan' ? JSON.stringify(plan)
          : verdictOverride ?? JSON.stringify({ verdict: 'completed', evidenceRefs: [JSON.parse(request.prompt).events[0].seq] }) };
      },
      async sessions(action: string, params: JsonRecord) {
        if (action === 'models/list') return { items: [{ provider: 'mock', model: 'fake', capabilities: { reasoningEffort: { state: 'declared', value: [] } } }] };
        actions.push(action);
        if (action === 'status') return { sessionId: context.sessionId, live: true, state: 'idle',
          pending, seq: nativeSeq, lastTurnReason };
        if (action === 'analysis.surface') return { sessionId: wrongSurface ? 'other' : params.sessionId,
          status: 'idle', throughSeq: nativeSeq, lines: lines.filter(line => line.seq > Number(params.sinceSeq)), truncated };
        if (action === 'activation/status') return structuredClone(activations.get(String(params.activationId)) ?? {
          activationId: params.activationId, sessionId: params.sessionId, state: 'unknown', terminal: false,
        });
        if (action === 'activation.lookup') return { sessionId: params.sessionId, requestId: params.requestId, ...lookup };
        if (action === 'continue') {
          deliveryStarted.resolve(params);
          if (deliveryGate) await deliveryGate.promise;
          if ((params.admissionSignal as AbortSignal).aborted) throw new NexusError('AUTONOMY_APPROVAL_REVOKED', 'revoked before native admission');
          deliveries.push(params);
          if (uncertain) return { accepted: false, durable: true };
          const activationId = `a${deliveries.length}`, messageSeq = ++nativeSeq;
          activations.set(activationId, { activationId, sessionId: params.sessionId, state: 'queued', terminal: false,
            evidence: { messageSeq } });
          return { accepted: true, durable: true, activationId };
        }
        throw new Error(`Unexpected native call: ${action}`);
      },
    },
  } as unknown as NexusServices;
  const module = createAutonomyModule(services);
  const read = () => module.dispatch({ action: 'get' }, context) as Promise<any>;
  const ownerContext = (action: string) => ({ ...context, actorId: 'connection-owner', permissions: new Set([`autonomy.${action}`]) });
  const owner = async (action: string, params: JsonRecord = {}, revision?: number) => module.dispatch({
    action, requestId: `human:${++sequence}`, expectedRevision: revision ?? (await read()).revision, params,
  }, ownerContext(action)) as Promise<any>;
  const internal = (action: string, params: JsonRecord = {}) => module.dispatch({ action, params }, {
    ...context, actorId: AUTONOMY_HOOK_ACTOR, permissions: new Set([`autonomy.${action}`]),
  }) as Promise<any>;
  const age = async () => {
    const row = await store.get<AutonomyPlan>(AUTONOMY_COLLECTION, key);
    if (row) await store.put(AUTONOMY_COLLECTION, key, { ...row.value, monitor: { ...row.value.monitor, lastCallAt: 0 } }, row.revision);
  };
  const complete = (activationId: string, kind = 'assistant/message', isError?: boolean) => {
    const activation = activations.get(activationId), seq = ++nativeSeq;
    lines = [...lines, { seq, kind, text: '已检查导入和验证结果，验收通过', ...(isError !== undefined ? { isError } : {}) }];
    const turnEndSeq = ++nativeSeq;
    activations.set(activationId, { ...activation, state: 'succeeded', terminal: true,
      evidence: { ...activation.evidence, turnEndSeq, reason: { kind: 'completed' } } });
    lines.push({ seq: turnEndSeq, kind: 'turn/end', text: 'completed' });
  };
  return {
    module, services, context, store, key, modelRequests, deliveries, activations, actions,
    read, owner, ownerContext, internal, age, complete,
    uncertain: () => { uncertain = true; }, lookup: (value: any) => { lookup = value; },
    pending: (value: typeof pending) => { pending = value; },
    stopped: () => { lastTurnReason = { kind: 'aborted', reason: { kind: 'user' } }; },
    surface: (value: any[]) => { lines = value; },
    truncated: () => { truncated = true; }, wrongSurface: () => { wrongSurface = true; },
    verdict: (text: string) => { verdictOverride = text; }, failModel: () => { rejectModel = true; },
    blockModel() { modelGate = deferred(); modelStarted = deferred(); return { started: modelStarted.promise,
      release: () => { modelGate!.resolve(undefined); modelGate = undefined; } }; },
    blockDelivery() { deliveryGate = deferred(); deliveryStarted = deferred(); return { started: deliveryStarted.promise,
      release: () => { deliveryGate!.resolve(undefined); deliveryGate = undefined; } }; },
  };
}

test('plans require bounded steps, existing dependencies and an acyclic graph', () => {
  assert.deepEqual(parsePlan(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``), plan);
  assert.throws(() => validatePlan({ ...plan, steps: [...plan.steps, plan.steps[0]] }));
  assert.throws(() => validatePlan({ ...plan, steps: [{ ...plan.steps[0], dependsOn: ['missing'] }] }));
  assert.throws(() => validatePlan({ ...plan, steps: plan.steps.map((step, i) => ({ ...step, dependsOn: [plan.steps[1 - i].id] })) }));
  assert.throws(() => validatePlan({ ...plan, steps: [{ ...plan.steps[0], acceptance: [] }] }));
});

test('a proposal never sends; exact approval advances dependencies using activation-bound evidence', async () => {
  const f = fixture();
  const proposal = await f.owner('propose');
  assert.equal(proposal.status, 'proposed'); assert.equal(f.deliveries.length, 0);
  await f.internal('tick'); assert.equal(f.deliveries.length, 0);
  const approved = await f.owner('approve');
  assert.equal(approved.approvedRevision, approved.planRevision);
  assert.notEqual(approved.approvedRevision, approved.revision);
  await Promise.all([f.internal('tick'), f.internal('tick'), f.internal('tick')]);
  assert.equal(f.deliveries.length, 1);
  assert.equal((f.deliveries[0].source as any).stepId, 'repair');
  assert.equal(f.deliveries[0].requireIdleEmpty, true);
  assert.ok(f.deliveries[0].admissionSignal instanceof AbortSignal);
  f.complete('a1'); await f.age();
  const next = await f.internal('tick');
  assert.equal(next.progress.completed, 1); assert.equal(f.deliveries.length, 2);
  assert.equal((f.deliveries[1].source as any).stepId, 'verify');
  f.complete('a2'); await f.age();
  const done = await f.internal('tick');
  assert.equal(done.status, 'completed'); assert.equal(done.progress.completed, 2);
  assert.deepEqual(done.evidence.map((e: any) => e.activationId), ['a1', 'a2']);
  assert.ok(done.evidence.every((e: any) => e.inference === true));
  assert.equal(f.actions.some(action => /cancel|abort|spawn/.test(action)), false);
});

test('new direct user input invalidates approval and native stop cannot auto-resume', async () => {
  const f = fixture(); await f.owner('propose'); await f.owner('approve');
  await f.internal('on-event', { kind: 'user', seq: 3, messageId: 'human-2' });
  const changed = await f.read();
  assert.equal(changed.approvedRevision, undefined); assert.equal(changed.reason, 'new-user-input');
  await f.internal('tick'); assert.equal(f.deliveries.length, 0);
  await assert.rejects(f.owner('resume'), (error: any) => error.code === 'AUTONOMY_APPROVAL_REQUIRED');
  await f.owner('edit', plan); await f.owner('approve'); f.stopped();
  assert.equal((await f.internal('tick')).reason, 'native-stopped');
  await f.internal('tick'); assert.equal(f.deliveries.length, 0);
  await f.owner('resume'); await f.internal('tick');
  assert.equal(f.deliveries.length, 1);
  f.activations.set('a1', { activationId: 'a1', sessionId: 'main', terminal: true, state: 'cancelled',
    evidence: { reason: { kind: 'aborted', reason: { kind: 'user' } } } });
  assert.equal((await f.internal('tick')).status, 'paused');
  await f.internal('tick'); assert.equal(f.deliveries.length, 1);
});

test('restoring an approved plan fences it for review without models or delivery', async () => {
  const f = fixture(); await f.owner('propose'); await f.owner('approve');
  await f.module.dispose?.();
  const restored = createAutonomyModule(f.services);
  const state: any = await restored.dispatch({ action: 'get' }, f.context);
  assert.equal(state.status, 'needs-review'); assert.equal(state.reason, 'host-restarted');
  await restored.dispatch({ action: 'tick' }, { ...f.context, actorId: AUTONOMY_HOOK_ACTOR, permissions: new Set(['autonomy.tick']) });
  assert.equal(f.deliveries.length, 0); assert.equal(f.modelRequests.length, 1);
  await restored.dispose?.();
});

test('unknown native delivery never replays and only formal lookup can clear or bind it', async () => {
  const f = fixture(); await f.owner('propose'); await f.owner('approve'); f.uncertain();
  const unknown = await f.internal('tick');
  assert.equal(unknown.status, 'needs-review'); assert.equal(unknown.delivery.state, 'unknown');
  await f.internal('tick'); await f.internal('tick');
  assert.equal(f.deliveries.length, 1);
  await assert.rejects(f.owner('edit', plan), (error: any) => error.code === 'AUTONOMY_EFFECT_UNVERIFIED');
  assert.equal((await f.owner('reconcile')).reason, 'delivery-unknown');
  f.lookup({ found: true, noDelivery: true, terminal: true, state: 'not-sent', reason: 'untrusted-guess' });
  assert.ok((await f.owner('reconcile')).delivery);
  f.lookup({ found: true, noDelivery: true, terminal: true, state: 'not-sent', reason: 'AUTONOMY_APPROVAL_REVOKED' });
  const cleared = await f.owner('reconcile');
  assert.equal(cleared.status, 'proposed'); assert.equal(cleared.delivery, undefined); assert.equal(cleared.approvedRevision, undefined);
  await f.internal('tick'); assert.equal(f.deliveries.length, 1);
});

test('lookup of accepted delivery binds its exact identity and waits for explicit resume', async () => {
  const f = fixture(); await f.owner('propose'); await f.owner('approve'); f.uncertain(); await f.internal('tick');
  f.lookup({ found: true, accepted: true, durable: true, activationId: 'native-existing' });
  const reconciled = await f.owner('reconcile');
  assert.equal(reconciled.status, 'paused'); assert.equal(reconciled.delivery.activationId, 'native-existing');
  await f.internal('tick'); assert.equal(f.deliveries.length, 1);
  await f.owner('resume'); await f.internal('tick');
  assert.equal(f.deliveries.length, 1);
});

test('owner pause revokes a continuation while native intent persistence is pending', async () => {
  const f = fixture(); await f.owner('propose'); await f.owner('approve');
  const gate = f.blockDelivery(), tick = f.internal('tick');
  const params = await gate.started;
  const paused = await f.owner('pause');
  assert.equal(paused.status, 'paused'); assert.equal((params.admissionSignal as AbortSignal).aborted, true);
  gate.release(); await tick;
  assert.equal(f.deliveries.length, 0); assert.equal((await f.read()).status, 'paused');
  assert.equal(f.actions.some(action => /cancel|abort/.test(action)), false);
});

test('busy inbox and missing formal status sequence prevent native admission', async () => {
  const f = fixture(); await f.owner('propose'); await f.owner('approve');
  f.pending({ nextTurn: 1, nextStep: 0 });
  assert.equal((await f.internal('tick')).reason, 'native-busy'); assert.equal(f.deliveries.length, 0);
  f.pending({ nextTurn: 0, nextStep: 1 });
  await f.internal('tick'); assert.equal(f.deliveries.length, 0);
});

for (const scenario of ['error-tool', 'unknown-tool', 'turn-end-only', 'truncated', 'wrong-session', 'fake-ref', 'wrong-activation'] as const) {
  test(`completion cannot be inferred from ${scenario}`, async () => {
    const f = fixture(); await f.owner('propose'); await f.owner('approve'); await f.internal('tick');
    f.complete('a1', scenario.endsWith('tool') ? 'tool/result' : 'assistant/message', scenario === 'error-tool' ? true : undefined);
    if (scenario === 'turn-end-only') f.surface([{ seq: 5, kind: 'turn/end', text: 'completed' }]);
    if (scenario === 'truncated') f.truncated();
    if (scenario === 'wrong-session') f.wrongSurface();
    if (scenario === 'fake-ref') f.verdict(JSON.stringify({ verdict: 'completed', evidenceRefs: [99999] }));
    if (scenario === 'wrong-activation') f.activations.get('a1').activationId = 'unrelated';
    await f.age();
    const result = await f.internal('tick');
    assert.ok(['paused', 'needs-review'].includes(result.status));
    assert.equal(result.progress.completed, 0); assert.equal(f.deliveries.length, 1);
  });
}

test('formal nonerror tool receipt remains an inference and must pass the verifier', async () => {
  const f = fixture(); await f.owner('propose'); await f.owner('approve'); await f.internal('tick');
  f.complete('a1', 'tool/result', false); await f.age();
  const result = await f.internal('tick');
  assert.equal(result.progress.completed, 1);
  const prompt = JSON.parse(f.modelRequests.at(-1)!.prompt);
  assert.equal(prompt.events[0].isError, false); assert.equal(result.evidence[0].inference, true);
});

test('planning caches unchanged input, uses bounded readonly calls, and manual retry keeps the daily hard limit', async () => {
  const f = fixture();
  await f.store.put('scope-settings', 'global/autonomy', { defaults: { maxCallsPerDay: 2.9, maxOutputTokens: 900.8 } }, 0);
  await f.owner('propose'); await f.owner('propose');
  assert.equal(f.modelRequests.length, 1); assert.equal(f.modelRequests[0].maxTokens, 900);
  await f.owner('propose', { retry: true }); assert.equal(f.modelRequests.length, 2);
  const held = await f.owner('propose', { retry: true });
  assert.equal(held.reason, 'daily-budget'); assert.equal(held.deferred, true); assert.ok(held.retryAfterMs > 0);
  assert.equal(f.modelRequests.length, 2);
  const state = await f.read(); assert.equal(state.budget.remainingCalls, 0);
  assert.ok(Date.parse(state.budget.nextCallAt) > Date.now());
  const settings: any = await f.module.dispatch({ action: 'settings' }, f.context);
  assert.equal(settings.maxCallsPerDay, 2); assert.equal(settings.budget.callsToday, 2);
});

test('verification shares the daily budget and automatic planning returns a cooldown retry', async () => {
  const f = fixture();
  await f.store.put('scope-settings', 'global/autonomy', { defaults: { maxCallsPerDay: 1 } }, 0);
  await f.owner('propose'); await f.owner('approve'); await f.internal('tick'); f.complete('a1'); await f.age();
  assert.equal((await f.internal('tick')).reason, 'daily-budget'); assert.equal(f.modelRequests.length, 1);
  const other = fixture(); await other.owner('propose');
  await other.internal('on-event', { kind: 'user', seq: 8, messageId: 'changed' });
  other.surface([{ seq: 8, kind: 'user/message', text: '另一个任务' }]);
  const held = await other.internal('on-event', { kind: 'observe' });
  assert.equal(held.reason, 'cooldown'); assert.ok(held.retryAfterMs > 0); assert.equal(other.modelRequests.length, 1);
});

test('new user input discards an in-flight proposal without leaving a started monitor', async () => {
  const f = fixture(), gate = f.blockModel(), proposal = f.owner('propose');
  const request = await gate.started;
  await f.internal('on-event', { kind: 'user', seq: 3, messageId: 'human-new' });
  assert.equal(request.signal!.aborted, true);
  assert.notEqual((await f.read()).monitor.state, 'started');
  gate.release(); await proposal;
  const result = await f.read();
  assert.equal(result.userEpoch, 1); assert.equal(result.steps.length, 0); assert.equal(result.reason, 'new-user-input');
  await f.age(); f.surface([{ seq: 3, kind: 'user/message', text: '新的目标' }]);
  assert.equal((await f.internal('on-event', { kind: 'observe' })).status, 'proposed');
  assert.equal(f.modelRequests.length, 2);
});

test('owner pause discards an in-flight proposal and suppresses automatic re-proposal', async () => {
  const f = fixture(), gate = f.blockModel(), proposal = f.owner('propose');
  const request = await gate.started;
  await f.owner('pause'); assert.equal(request.signal!.aborted, true);
  gate.release(); await proposal;
  assert.equal((await f.read()).monitor.state, 'unknown');
  await f.internal('on-event', { kind: 'turn-end', reason: 'completed' });
  assert.equal(f.modelRequests.length, 1);
  await f.owner('propose', { retry: true });
  assert.equal(f.modelRequests.length, 2);
});

test('owner, exact permission, request ID and storage revision cannot be spoofed in params', async () => {
  const f = fixture(); const current = await f.owner('propose');
  await assert.rejects(f.module.dispatch({ action: 'approve', expectedRevision: current.revision, requestId: 'spoof',
    params: { actorId: 'connection-owner' } }, f.context), (error: any) => error.code === 'PERMISSION_DENIED');
  await assert.rejects(f.module.dispatch({ action: 'approve', expectedRevision: current.revision, requestId: 'wrong-permission' },
    { ...f.context, actorId: 'connection-owner', permissions: new Set(['autonomy.*']) }), (error: any) => error.code === 'PERMISSION_DENIED');
  await assert.rejects(f.module.dispatch({ action: 'approve', expectedRevision: current.revision }, f.ownerContext('approve')),
    (error: any) => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(f.owner('approve', {}, current.revision - 1), (error: any) => error.code === 'REVISION_CONFLICT');
  await assert.rejects(f.owner('approve', { native: true }), (error: any) => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(f.module.dispatch({ action: 'tick' }, f.context), (error: any) => error.code === 'PERMISSION_DENIED');
  assert.equal(f.deliveries.length, 0);
  for (const action of ['propose', 'approve', 'edit', 'resume', 'reconcile']) {
    const capability = f.module.capabilities.find(item => item.action === action)!;
    assert.equal(capability.mutating, true); assert.equal(capability.schema!.additionalProperties, false);
    assert.doesNotMatch(JSON.stringify(capability.schema), /native|admissionSignal|bypass/);
  }
});

test('reads use cache only and isolate workspace/session plans', async () => {
  const f = fixture(); await f.owner('propose'); const actions = f.actions.length, calls = f.modelRequests.length;
  await f.read(); await f.module.dispatch({ action: 'settings' }, f.context);
  const elsewhere: any = await f.module.dispatch({ action: 'get' }, { ...f.context, workspaceRoot: 'D:/fixture/b' });
  assert.equal(elsewhere.status, 'empty');
  const list: any = await f.module.dispatch({ action: 'list' }, { ...f.context, sessionId: 'other' });
  assert.equal(list.items.length, 0);
  assert.equal(f.actions.length, actions); assert.equal(f.modelRequests.length, calls);
});
