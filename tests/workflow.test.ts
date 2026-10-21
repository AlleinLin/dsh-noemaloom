import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentsModule, createWorkflowModule } from '../src/domain/workflow/index.js';
import { NexusError, type ChildActivation, type HostAttemptMetadata, type JsonRecord, type ModelRequest, type ModelResult, type NexusServices, type NexusStore, type StoredRecord } from '../src/ports/contracts.js';
import type { GateReviewMission, Run, TaskPlan } from '../src/domain/workflow/types.js';
import { WorkflowScheduler } from '../src/domain/workflow/scheduler.js';

class CasStore implements NexusStore {
  rows = new Map<string, StoredRecord>();
  async get<T>(c: string, id: string): Promise<StoredRecord<T> | undefined> { return structuredClone(this.rows.get(`${c}:${id}`)) as StoredRecord<T> | undefined; }
  async list<T>(c: string): Promise<StoredRecord<T>[]> { return [...this.rows.entries()].filter(([k]) => k.startsWith(`${c}:`)).map(([, v]) => structuredClone(v)) as StoredRecord<T>[]; }
  async put<T>(c: string, id: string, value: T, expectedRevision?: number): Promise<StoredRecord<T>> {
    const key = `${c}:${id}`, previous = this.rows.get(key);
    if (expectedRevision !== undefined && expectedRevision !== (previous?.revision ?? 0)) throw new NexusError('REVISION_CONFLICT', 'CAS conflict');
    const row = { id, revision: (previous?.revision ?? 0) + 1, value: structuredClone(value), updatedAt: new Date().toISOString() };
    this.rows.set(key, row); return structuredClone(row);
  }
  async remove(c: string, id: string, expected?: number): Promise<boolean> { const row = this.rows.get(`${c}:${id}`); if (row && expected !== undefined && expected !== row.revision) throw new NexusError('REVISION_CONFLICT', 'CAS conflict'); return this.rows.delete(`${c}:${id}`); }
}
function attemptMetadata(request: ModelRequest, attemptId = `${request.logicalCallId}:stream-1`): HostAttemptMetadata {
  return { logicalCallId: request.logicalCallId!, attemptId, runId: request.attemptPolicy!.runId, nodeId: request.attemptPolicy!.nodeId,
    sessionId: request.sessionId!, provider: request.provider ?? 'p', model: request.model ?? 'm', startedAt: new Date().toISOString(),
    inputBytes: Buffer.byteLength(request.prompt), maxOutputTokens: request.maxTokens ?? 4096,
    source: 'llm-runtime-stream', providerHttpAttempts: 'opaque' };
}
async function fixture(spawn?: (request: ModelRequest) => Promise<ChildActivation>, options: {
  manualAttempts?: boolean; facts?: JsonRecord; usage?: JsonRecord | null; text?: (request: ModelRequest) => string | Promise<string>;
} = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nexus-workflow-'));
  const modules = new Map<string, ReturnType<typeof createWorkflowModule>>();
  const calls: ModelRequest[] = [], disposed: string[] = [];
  const services: NexusServices = {
    store: new CasStore(), workspaceRoot, dataDir: workspaceRoot, emit() {},
    executor: { async run(command, args) { return { exitCode: command === 'fail' ? 1 : 0, stdout: args.join(' '), stderr: '', cancelled: false, durationMs: 5 }; } },
    host: {
      async facts() { return { capabilities: ['subagents', 'llm'], attemptPolicySupported: true, attemptBoundary: 'llm-runtime-stream', providerHttpAttempts: 'opaque', ...options.facts }; },
      async model(request) {
        const metadata = attemptMetadata(request);
        await request.attemptPolicy?.beforeAttempt(metadata);
        const usage = options.usage === null ? undefined : options.usage ?? { totalTokens: 10, cost: 0.01 };
        await request.attemptPolicy?.settleAttempt({ ...metadata, finishedAt: new Date().toISOString(), status: usage ? 'reported' : 'unreported', usage, usageRevision: 1 });
        return { text: options.text ? await options.text(request) : 'root response', evidence: { observedRoute: { provider: 'p', model: 'm' } } };
      },
      async spawn(request) {
        const metadata = attemptMetadata(request);
        if (!options.manualAttempts) await request.attemptPolicy?.beforeAttempt(metadata);
        calls.push(request);
        const id = `child-${calls.length}`;
        const usage = options.usage === null ? undefined : options.usage ?? { totalTokens: 10, cost: 0.01 };
        const handle = spawn ? await spawn(request) : { id,
          result: Promise.resolve().then(async (): Promise<ModelResult> => ({ text: options.text ? await options.text(request) : `result for ${request.role}`, usage, evidence: { observedRoute: { provider: request.provider ?? 'p', model: request.model ?? 'm' } } })),
          async dispose() { disposed.push(id); } };
        if (options.manualAttempts) return handle;
        return { ...handle, result: handle.result.then(async result => {
          await request.attemptPolicy?.settleAttempt({ ...metadata, finishedAt: new Date().toISOString(), status: result.usage ? 'reported' : 'unreported', usage: result.usage, usageRevision: 1 });
          return result;
        }, async error => {
          await request.attemptPolicy?.settleAttempt({ ...metadata, finishedAt: new Date().toISOString(), status: request.signal?.aborted ? 'cancelled' : 'failed', usageRevision: 1 });
          throw error;
        }) };
      },
      async sessions() { throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', 'Unavailable fixture service'); },
      async secret() { return undefined; }, async approve() { return true; },
    },
    async invoke(domain, request, context) { const mod = modules.get(domain); if (!mod) throw new NexusError('NOT_FOUND', 'Unknown domain'); return mod.dispatch(request, context); },
  };
  const workflow = createWorkflowModule(services), agents = createAgentsModule(services);
  modules.set('workflow', workflow); modules.set('agents', agents);
  return { services, workflow, agents, calls, disposed, async close() { await workflow.dispose?.(); await rm(workspaceRoot, { recursive: true, force: true }); } };
}
const scope = { sessionId: 'session-1', actorId: 'user' };
async function settle(f: Awaited<ReturnType<typeof fixture>>, id: string): Promise<Run> {
  for (let i = 0; i < 200; i++) {
    const row = await f.workflow.dispatch({ action: 'status', params: { runId: id } }, scope) as StoredRecord<Run>;
    if (row.value.finishedAt || ['effectUnknown', 'waiting'].includes(row.value.state)) return row.value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Run did not settle');
}
test('public workflow refuses DAG cycles before creating children', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.workflow.dispatch({ action: 'plan', params: { goal: 'cycle', nodes: [{ id: 'a', kind: 'agent', prompt: 'a', dependsOn: ['b'] }, { id: 'b', kind: 'agent', prompt: 'b', dependsOn: ['a'] }] } }, scope), (error: unknown) => error instanceof NexusError && error.code === 'INVALID_ARGUMENT' && JSON.stringify(error.details).includes('a'));
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('a timed-out tool keeps its request identity and write lease until its original durable receipt is read', async () => {
  const f = await fixture();
  const observed: { requestId?: string; context: unknown }[] = [];
  f.services.invoke = async (_domain, request, context) => {
    observed.push({ requestId: request.requestId, context });
    return new Promise(() => undefined);
  };
  try {
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'unknown external effect',
      nodes: [{ id: 'write', kind: 'tool', domain: 'fixture', action: 'write', writeClaims: ['out.txt'], timeoutMs: 25 }],
    } }, scope) as StoredRecord<TaskPlan>;
    const created = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    const run = await settle(f, created.id);
    assert.equal(run.state, 'effectUnknown');
    assert.equal(run.nodeRuns.write.state, 'effectUnknown');
    assert.equal(run.nodeRuns.write.execution?.state, 'unknown');
    assert.equal(observed[0].requestId, run.nodeRuns.write.execution?.requestId);
    assert.equal(observed.length, 1);
    await assert.rejects(f.workflow.dispatch({ action: 'retry', params: { runId: run.id } }, scope),
      (error: unknown) => error instanceof NexusError && error.code === 'PROCESS_EFFECT_UNKNOWN');
    const pool = await f.services.store.get<{ leases: { id: string; expiresAt: number }[] }>('workflow-coordination', 'global-pool');
    assert.equal(pool?.value.leases.length, 1);
    assert.equal(pool?.value.leases[0].expiresAt, Number.MAX_SAFE_INTEGER);
    await f.services.store.put('workflow-coordination', 'global-pool', {
      ...pool!.value, leases: pool!.value.leases.map(lease => ({ ...lease, expiresAt: 0 })),
    }, pool!.revision);
    const competingPlan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'competing write',
      nodes: [{ id: 'competing', kind: 'tool', domain: 'fixture', action: 'write', writeClaims: ['out.txt'], timeoutMs: 25 }],
    } }, scope) as StoredRecord<TaskPlan>;
    const competing = await f.workflow.dispatch({ action: 'run', params: { planId: competingPlan.id } }, scope) as StoredRecord<Run>;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(observed.length, 1, 'an expired unresolved write lease is not stolen by another run');
    await f.workflow.dispatch({ action: 'cancel', params: { runId: competing.id } }, scope);
    const stillUnknown = await f.workflow.dispatch({ action: 'reconcile', params: { runId: run.id } }, scope) as StoredRecord<Run>;
    assert.equal(stillUnknown.value.nodeRuns.write.state, 'effectUnknown', 'absence of a receipt is not evidence to replay');
    const reads: string[] = [];
    f.services.readReceipt = async (requestId, context) => {
      reads.push(requestId); assert.equal(context?.actorId, scope.actorId);
      return { ok: true, data: { exactOriginalResult: 'written once' } };
    };
    const recovered = await f.workflow.dispatch({ action: 'reconcile', params: { runId: run.id } }, scope) as StoredRecord<Run>;
    assert.equal(recovered.value.nodeRuns.write.state, 'succeeded');
    assert.equal(recovered.value.nodeRuns.write.execution?.state, 'settled');
    assert.ok(recovered.value.nodeRuns.write.resultRef);
    assert.deepEqual(reads, [observed[0].requestId]);
    assert.equal(observed.length, 1, 'receipt reconciliation cannot execute an absent or old intent');
    assert.equal((await f.services.store.get<{ leases: unknown[] }>('workflow-coordination', 'global-pool'))?.value.leases.length, 0);
  } finally { await f.close(); }
});

test('cancelling a tool that ignores cancellation preserves unknown effects and blocks retry', async () => {
  const f = await fixture();
  let accepted = false;
  f.services.invoke = async () => { accepted = true; return new Promise(() => undefined); };
  try {
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'cancel tool safely',
      nodes: [{ id: 'tool', kind: 'tool', domain: 'fixture', action: 'mutate', timeoutMs: 10000 }],
    } }, scope) as StoredRecord<TaskPlan>;
    const created = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    for (let i = 0; !accepted && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(accepted, true);
    const cancelled = await f.workflow.dispatch({ action: 'cancel', params: { runId: created.id } }, scope) as StoredRecord<Run>;
    assert.equal(cancelled.value.state, 'effectUnknown');
    assert.equal(cancelled.value.nodeRuns.tool.state, 'effectUnknown');
    assert.equal(cancelled.value.finishedAt, undefined);
  } finally { await f.close(); }
});

test('restart does not requeue legacy running tools without activation or an execution intent', async () => {
  const f = await fixture();
  try {
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'legacy restart',
      nodes: [{ id: 'old', kind: 'manual' }],
    } }, scope) as StoredRecord<TaskPlan>;
    const created = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    await settle(f, created.id);
    await f.workflow.dispose?.();
    const row = (await f.services.store.get<Run>('workflow-runs', created.id))!;
    row.value.state = 'running'; row.value.nodeRuns.old.state = 'running'; row.value.nodeRuns.old.execution = undefined;
    await f.services.store.put('workflow-runs', row.id, row.value, row.revision);
    const restarted = new WorkflowScheduler(f.services);
    await restarted.initialize();
    assert.equal((await restarted.get(row.id)).value.nodeRuns.old.state, 'effectUnknown');
    await assert.rejects(restarted.resume(row.id, scope),
      (error: unknown) => error instanceof NexusError && error.code === 'PROCESS_EFFECT_UNKNOWN');
    assert.equal(f.calls.length, 0);
    await restarted.dispose();
  } finally { await f.close(); }
});

for (const suspension of ['prepared-return', 'input-read'] as const) {
  test(`a stale prepared worker suspended at ${suspension} cannot send or settle a resumed successor attempt`, async () => {
    const f = await fixture(), oldScheduler = new WorkflowScheduler(f.services), successor = new WorkflowScheduler(f.services);
    let releaseOld!: () => void, releaseSuccessor!: () => void;
    let reachedOld!: () => void, reachedSuccessor!: () => void;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const successorGate = new Promise<void>(resolve => { releaseSuccessor = resolve; });
    const oldReached = new Promise<void>(resolve => { reachedOld = resolve; });
    const successorReached = new Promise<void>(resolve => { reachedSuccessor = resolve; });
    let pausedOld = false, pausedSuccessor = false, toolExecutions = 0;
    const originalGet = f.services.store.get.bind(f.services.store);
    const originalPut = f.services.store.put.bind(f.services.store);
    f.services.store.get = async <T>(collection: string, id: string): Promise<StoredRecord<T> | undefined> => {
      const result = await originalGet<T>(collection, id);
      if (suspension === 'input-read' && collection === 'workflow-artifacts' && !pausedOld) {
        pausedOld = true; reachedOld(); await oldGate;
      }
      return result;
    };
    f.services.store.put = async <T>(collection: string, id: string, value: T, revision?: number): Promise<StoredRecord<T>> => {
      const result = await originalPut(collection, id, value, revision);
      const runtime = collection === 'workflow-runs' ? (value as Run).nodeRuns.sink : undefined;
      if (runtime?.state === 'starting' && runtime.execution?.state === 'prepared') {
        if (runtime.attempt === 1 && suspension === 'prepared-return' && !pausedOld) {
          pausedOld = true; reachedOld(); await oldGate;
        } else if (runtime.attempt === 2 && !pausedSuccessor) {
          pausedSuccessor = true; reachedSuccessor(); await successorGate;
        }
      }
      return result;
    };
    f.services.invoke = async () => { toolExecutions++; return { exactResult: 'one external operation' }; };
    try {
      const nodes = suspension === 'input-read'
        ? [{ id: 'source', kind: 'tool', domain: 'fixture', action: 'produce' },
          { id: 'sink', kind: 'prompt', prompt: 'consume frozen input', dependsOn: ['source'], inputRefs: ['node:source'] }]
        : [{ id: 'sink', kind: 'tool', domain: 'fixture', action: 'write' }];
      const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'fence successor execution', nodes } }, scope) as StoredRecord<TaskPlan>;
      const created = await oldScheduler.start(plan.id, `fenced-${suspension}`, scope);
      const checkpoint = async (ready: Promise<void>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Expected workflow suspension checkpoint was not reached')), 3000); })]);
        } finally { if (timer) clearTimeout(timer); }
      };
      await checkpoint(oldReached);
      const oldDone = (oldScheduler as any).active.get(`${created.id}:sink`).done as Promise<void>;
      await successor.initialize();
      await successor.resume(created.id, scope);
      await checkpoint(successorReached);
      releaseOld();
      await oldDone;
      const pending = (await successor.get(created.id, scope)).value.nodeRuns.sink;
      assert.equal(pending.attempt, 2);
      assert.equal(pending.state, 'starting');
      assert.equal(pending.execution?.state, 'prepared', 'the stale worker cannot start or settle attempt 2');
      assert.equal(f.calls.length, 0, 'the old worker cannot send a model request');
      assert.equal(toolExecutions, suspension === 'input-read' ? 1 : 0);
      releaseSuccessor();
      const finished = await settle(f, created.id);
      assert.equal(finished.state, 'succeeded');
      assert.equal(finished.nodeRuns.sink.attempt, 2);
      assert.equal(f.calls.length, suspension === 'input-read' ? 1 : 0);
      assert.equal(toolExecutions, 1);
    } finally {
      releaseOld(); releaseSuccessor();
      await oldScheduler.dispose(); await successor.dispose(); await f.close();
    }
  });
}

test('workflow data bindings pass the complete successful upstream result while dependency-only nodes receive no data', async () => {
  const tail = 'COMPLETE-UPSTREAM-TAIL';
  const f = await fixture(undefined, { text: request => request.role === 'producer'
    ? JSON.stringify({ value: 'x'.repeat(14000) + tail })
    : request.role === 'consumer' ? JSON.stringify({ combined: request.prompt.includes(tail) }) : 'middle complete' });
  try {
    const plan = await f.workflow.dispatch({ action: 'plan', params: {
      goal: 'source to synthesis with real artifacts',
      nodes: [
        { id: 'source', kind: 'agent', role: 'producer', prompt: 'produce', outputContracts: { json: true, requiredFields: ['value'] } },
        { id: 'middle', kind: 'prompt', role: 'middle', prompt: 'order only', dependsOn: ['source'] },
        { id: 'sink', kind: 'synthesis', role: 'consumer', prompt: 'combine full source', dependsOn: ['middle'],
          inputRefs: ['node:source'], outputContracts: { json: true, requiredFields: ['combined'] } },
      ],
      editor: { schemaVersion: 1, layout: { source: { x: 0, y: 0 }, middle: { x: 300, y: 0 }, sink: { x: 600, y: 0 } } },
    } }, scope) as StoredRecord<TaskPlan>;
    assert.equal(plan.value.editor?.layout.sink.x, 600);
    const created = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    const run = await settle(f, created.id);
    assert.equal(run.state, 'succeeded');
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls.find(call => call.role === 'middle')!.prompt.includes(tail), false);
    assert.equal(f.calls.find(call => call.role === 'consumer')!.prompt.includes(tail), true);
    assert.ok(run.nodeRuns.source.resultRef);
    assert.ok(run.nodeRuns.sink.resultRef);
    assert.equal(run.planSnapshot.editor?.layout.sink.x, 600);
  } finally { await f.close(); }
});
test('one Run executes ready peers, waits dependencies, disposes every exact handle and reuses idempotent result', async () => {
  const f = await fixture();
  try {
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'parallel analysis then synthesis', nodes: [{ id: 'a', kind: 'agent', role: 'author', prompt: 'a' }, { id: 'b', kind: 'agent', role: 'analyst', prompt: 'b' }, { id: 'c', kind: 'agent', role: 'synthesis', prompt: 'c', dependsOn: ['a', 'b'] }] } }, scope) as StoredRecord<TaskPlan>;
    const one = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id, idempotencyKey: 'once' } }, scope) as StoredRecord<Run>;
    const two = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id, idempotencyKey: 'once' } }, scope) as StoredRecord<Run>;
    assert.equal(one.id, two.id);
    const run = await settle(f, one.id);
    assert.equal(run.state, 'succeeded');
    assert.equal(f.calls.length, 3); assert.equal(f.disposed.length, 3);
    assert.equal(run.usage.modelCalls, 3); assert.equal(run.usage.totalTokens, 30); assert.equal(run.usage.cost, 0.03);
    assert.deepEqual(run.events.map(e => e.seq), Array.from({ length: run.events.length }, (_, i) => i + 1));
    const start = run.events.find(e => e.nodeId === 'c' && e.type === 'node.starting')!;
    assert.ok(run.events.filter(e => ['a', 'b'].includes(e.nodeId ?? '') && e.type === 'node.succeeded').every(e => e.seq < start.seq));
  } finally { await f.close(); }
});
test('empty/fixed-PASS gate is unverified and failed real oracle blocks dependent work', async () => {
  const f = await fixture();
  try {
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'verify actual results', nodes: [{ id: 'gate', kind: 'gate', checks: [] }, { id: 'later', kind: 'agent', prompt: 'must not run', dependsOn: ['gate'] }] } }, scope) as StoredRecord<TaskPlan>;
    const started = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    const run = await settle(f, started.id);
    assert.equal(run.state, 'failed'); assert.equal(run.nodeRuns.gate.state, 'failed'); assert.equal(run.nodeRuns.later.state, 'blocked'); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('file/command oracles inspect actual bytes and command receipts', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.services.workspaceRoot, 'delivery.json'), JSON.stringify({ metric: 0.93 }));
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'typed metric oracle', nodes: [{ id: 'verify', kind: 'gate', checks: [{ kind: 'command', command: 'ok', args: ['real-args'] }, { kind: 'metric', path: 'delivery.json', jsonPath: 'metric', min: 0.9 }] }] } }, scope) as StoredRecord<TaskPlan>;
    const started = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    assert.equal((await settle(f, started.id)).state, 'succeeded');
  } finally { await f.close(); }
});
test('model-call budget rejects work before a second host spawn and records every physical attempt', async () => {
  const f = await fixture();
  try {
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'bounded', budgets: { maxModelCalls: 1, maxConcurrent: 1 }, nodes: [{ id: 'a', kind: 'agent', prompt: 'a' }, { id: 'b', kind: 'agent', prompt: 'b', dependsOn: ['a'] }] } }, scope) as StoredRecord<TaskPlan>;
    const start = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    const run = await settle(f, start.id);
    assert.equal(f.calls.length, 1); assert.equal(run.nodeRuns.b.error?.code, 'BUDGET_EXHAUSTED'); assert.equal(run.usage.attempts.length, 1);
  } finally { await f.close(); }
});
test('one activation with two runtime attempts cannot bypass maxModelCalls and its exact handle is disposed', async () => {
  let physicalSends = 0, exactDisposals = 0;
  const f = await fixture(async request => ({
    id: 'multi-attempt-activation',
    result: Promise.resolve().then(async () => {
      for (const sequence of [1, 2]) {
        const metadata = attemptMetadata(request, `physical-${sequence}`);
        await request.attemptPolicy!.beforeAttempt(metadata);
        physicalSends++;
        await request.attemptPolicy!.settleAttempt({ ...metadata, finishedAt: new Date().toISOString(), status: 'reported', usage: { totalTokens: 10 }, usageRevision: 1 });
      }
      return { text: 'must not report success' };
    }),
    async dispose() { exactDisposals++; },
  }), { manualAttempts: true });
  try {
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'bound every stream', budgets: { maxModelCalls: 1 }, nodes: [{ id: 'a', kind: 'agent', prompt: 'two internal steps' }] } }, scope) as StoredRecord<TaskPlan>;
    const started = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    const run = await settle(f, started.id);
    assert.equal(physicalSends, 1); assert.equal(exactDisposals, 1);
    assert.equal(run.state, 'failed'); assert.equal(run.nodeRuns.a.error?.code, 'BUDGET_EXHAUSTED');
    assert.equal(run.usage.modelCalls, 1); assert.equal(run.usage.attempts.length, 1);
    assert.equal(run.usage.attempts[0].nodeId, 'a'); assert.equal(run.usage.attempts[0].source, 'llm-runtime-stream');
    assert.equal(run.usage.cost, null);
  } finally { await f.close(); }
});
test('parallel admissions share the last Run budget slot without overselling it', async () => {
  const f = await fixture();
  try {
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'race one remaining stream slot', budgets: { maxModelCalls: 1, maxConcurrent: 2 }, nodes: [{ id: 'a', kind: 'agent', prompt: 'a' }, { id: 'b', kind: 'agent', prompt: 'b' }] } }, scope) as StoredRecord<TaskPlan>;
    const started = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    const run = await settle(f, started.id);
    assert.equal(f.calls.length, 1); assert.equal(run.usage.modelCalls, 1);
    assert.equal(Object.values(run.nodeRuns).filter(node => node.error?.code === 'BUDGET_EXHAUSTED').length, 1);
  } finally { await f.close(); }
});
test('revised usage updates the same attempt and unreported attempts preserve unknown totals', async () => {
  const f = await fixture(async request => ({
    id: 'revised-usage',
    result: Promise.resolve().then(async () => {
      const metadata = attemptMetadata(request);
      await request.attemptPolicy!.beforeAttempt(metadata);
      await request.attemptPolicy!.settleAttempt({ ...metadata, finishedAt: new Date().toISOString(), status: 'reported', usage: { totalTokens: 10, cost: 0.01 }, usageRevision: 1 });
      const revision = { ...metadata, finishedAt: new Date().toISOString(), status: 'reported' as const, usage: { totalTokens: 20, cost: 0.02 }, usageRevision: 2 };
      await request.attemptPolicy!.settleAttempt(revision);
      await request.attemptPolicy!.settleAttempt(revision);
      const unknown = attemptMetadata(request, 'unknown-attempt');
      await request.attemptPolicy!.beforeAttempt(unknown);
      await request.attemptPolicy!.settleAttempt({ ...unknown, finishedAt: new Date().toISOString(), status: 'unreported', usageRevision: 1 });
      return { text: 'completed with honest unknown usage' };
    }),
    async dispose() {},
  }), { manualAttempts: true });
  try {
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'usage revisions', nodes: [{ id: 'a', kind: 'agent', prompt: 'a' }] } }, scope) as StoredRecord<TaskPlan>;
    const started = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    const run = await settle(f, started.id);
    assert.equal(run.state, 'succeeded'); assert.equal(run.usage.modelCalls, 2); assert.equal(run.usage.attempts.length, 2);
    assert.equal(run.usage.attempts[0].usage?.totalTokens, 20); assert.equal(run.usage.attempts[0].usage?.cost, 0.02);
    assert.equal(run.usage.totalTokens, null); assert.equal(run.usage.cost, null); assert.equal(run.usage.complete, false);
  } finally { await f.close(); }
});
for (const dimension of ['maxCost', 'maxTokens'] as const) test(`hard ${dimension} rejects unknown upper bounds before dispatch`, async () => {
  const f = await fixture();
  try {
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'do not invent a hard upper bound', budgets: { [dimension]: 100 }, nodes: [{ id: 'a', kind: 'agent', prompt: 'a' }] } }, scope) as StoredRecord<TaskPlan>;
    const started = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    const run = await settle(f, started.id);
    assert.equal(f.calls.length, 0); assert.equal(run.usage.modelCalls, 0); assert.equal(run.nodeRuns.a.error?.code, 'HOST_CAPABILITY_UNAVAILABLE');
  } finally { await f.close(); }
});
test('advisory unknown cost stays unknown and unsupported hosts can still compile plans', async () => {
  const f = await fixture(undefined, { usage: null });
  try {
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'advisory price', budgets: { maxCost: 1, hardOrAdvisory: 'advisory' }, nodes: [{ id: 'a', kind: 'agent', prompt: 'a' }] } }, scope) as StoredRecord<TaskPlan>;
    const started = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    const run = await settle(f, started.id);
    assert.equal(run.state, 'succeeded'); assert.equal(run.usage.cost, null); assert.equal(run.usage.totalTokens, null);
  } finally { await f.close(); }
  const unsupported = await fixture(undefined, { facts: { attemptPolicySupported: false } });
  try {
    const plan = await unsupported.workflow.dispatch({ action: 'plan', params: { goal: 'compile without dispatch', nodes: [{ id: 'a', kind: 'agent', prompt: 'a' }] } }, scope) as StoredRecord<TaskPlan>;
    assert.equal(plan.value.nodes.length, 1); assert.equal(unsupported.calls.length, 0);
    const started = await unsupported.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    const run = await settle(unsupported, started.id);
    assert.equal(run.nodeRuns.a.error?.code, 'HOST_CAPABILITY_UNAVAILABLE'); assert.equal(unsupported.calls.length, 0);
  } finally { await unsupported.close(); }
});
test('a result usage field cannot replace missing physical callbacks and session spawn cannot escape them', async () => {
  const f = await fixture(undefined, { manualAttempts: true });
  try {
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'reject synthetic observation', nodes: [{ id: 'a', kind: 'agent', prompt: 'a' }] } }, scope) as StoredRecord<TaskPlan>;
    const started = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    const run = await settle(f, started.id);
    assert.equal(run.nodeRuns.a.error?.code, 'MODEL_PROTOCOL_INVALID');
    assert.equal(run.usage.modelCalls, 0); assert.equal(run.usage.attempts.length, 0); assert.equal(run.usage.cost, null);
    const sessionPlan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'no untracked persistent session execution', nodes: [{ id: 'session', kind: 'session', action: 'spawn', prompt: 'bypass?' }] } }, scope) as StoredRecord<TaskPlan>;
    const sessionStart = await f.workflow.dispatch({ action: 'run', params: { planId: sessionPlan.id } }, scope) as StoredRecord<Run>;
    const sessionRun = await settle(f, sessionStart.id);
    assert.equal(sessionRun.nodeRuns.session.error?.code, 'HOST_CAPABILITY_UNAVAILABLE');
    assert.deepEqual(sessionRun.nodeRuns.session.error?.details, { action: 'spawn' });
  } finally { await f.close(); }
});
test('exclusive metric thresholds do not silently become inclusive', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.services.workspaceRoot, 'metric.json'), '{"score":0.9}');
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'strict threshold', nodes: [{ id: 'gate', kind: 'gate', checks: [{ kind: 'metric', path: 'metric.json', jsonPath: 'score', min: 0.9, minExclusive: true }] }] } }, scope) as StoredRecord<TaskPlan>;
    const started = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    assert.equal((await settle(f, started.id)).state, 'failed');
  } finally { await f.close(); }
});
function reportFor(request: ModelRequest, overrides: JsonRecord = {}): JsonRecord {
  const line = request.prompt.split('\n').find(line => line.startsWith('{"schemaVersion":1,"runId":'));
  assert.ok(line, 'scheduler appends the host-frozen review mission');
  const mission = JSON.parse(line) as GateReviewMission;
  return { schemaVersion: 1, missionHash: mission.missionHash, candidateSnapshotHash: mission.candidateSnapshotHash, contractHash: mission.contractHash,
    subjectNodeIds: mission.subjectNodeIds, verdict: 'pass',
    reviewedArtifacts: mission.expectedArtifacts.map(({ ref, hash }) => ({ ref, hash })), reviewedOracleIds: mission.oracleIds, findings: [], ...overrides };
}
for (const scenario of ['pass', 'fail', 'p1', 'plain-pass', 'forged-subject', 'forged-coverage', 'self-resolved'] as const) {
  test(`independent gate consumes the actual ${scenario} reviewer report while its command oracle passes`, async () => {
    const f = await fixture(undefined, { text(request) {
      if (request.role !== 'reviewer') return 'implementation artifact';
      if (scenario === 'plain-pass') return 'PASS';
      const report = reportFor(request);
      const firstRef = (report.reviewedArtifacts as { ref: string }[])[0].ref;
      if (scenario === 'fail') report.verdict = 'fail';
      if (scenario === 'p1' || scenario === 'self-resolved') report.findings = [{ id: 'bug', priority: 1, trigger: 'candidate drops required data', evidenceRefs: [firstRef], ...(scenario === 'self-resolved' ? { resolved: true } : {}) }];
      if (scenario === 'forged-subject') report.subjectNodeIds = ['reviewer'];
      if (scenario === 'forged-coverage') report.reviewedArtifacts = [];
      return JSON.stringify(report);
    } });
    try {
      await writeFile(join(f.services.workspaceRoot, 'candidate.ts'), 'export const candidate = 1;\n');
      const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'author then independent review', nodes: [
        { id: 'author', kind: 'agent', role: 'implementer', prompt: 'implement candidate', writeClaims: ['candidate.ts'] },
        { id: 'reviewer', kind: 'agent', role: 'reviewer', prompt: 'review the candidate', dependsOn: ['author'] },
        { id: 'gate', kind: 'gate', dependsOn: ['reviewer'], checks: [
          { id: 'real-command', kind: 'command', command: 'ok', args: ['actual oracle'] },
          { id: 'independent-actor', kind: 'independence', authorNodeIds: ['author'], subjectNodeId: 'reviewer' },
        ] },
      ] } }, scope) as StoredRecord<TaskPlan>;
      const started = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
      const run = await settle(f, started.id);
      assert.equal(run.state, scenario === 'pass' ? 'succeeded' : 'failed');
      assert.equal(run.nodeRuns.gate.state, scenario === 'pass' ? 'succeeded' : 'failed');
      const evidence = run.nodeRuns.reviewer.reviewEvidence!;
      assert.deepEqual(evidence.mission.subjectNodeIds, ['author']);
      assert.notEqual(evidence.mission.reviewerActorId, run.nodeRuns.author.actorId);
      assert.ok(evidence.reportRef.id); assert.ok(run.artifacts.some(artifact => artifact.id === evidence.reportRef.id));
      const verdict = run.events.find(event => event.type === 'gate.verdict')!.data as { verdict: { verdict: string; findings: { priority: number }[] } };
      assert.equal(verdict.verdict.verdict === 'pass', scenario === 'pass');
      if (scenario === 'p1') assert.equal(verdict.verdict.findings[0].priority, 1);
    } finally { await f.close(); }
  });
}
test('a passing review cannot attest a candidate that changed after its frozen mission', async () => {
  let candidatePath = '';
  const f = await fixture(undefined, { async text(request) {
    if (request.role !== 'verifier') return 'author artifact';
    const report = reportFor(request);
    await writeFile(candidatePath, 'export const candidate = 2;\n');
    return JSON.stringify(report);
  } });
  try {
    candidatePath = join(f.services.workspaceRoot, 'candidate.ts');
    await writeFile(candidatePath, 'export const candidate = 1;\n');
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'reject stale candidate approval', nodes: [
      { id: 'author', kind: 'agent', role: 'implementer', prompt: 'a', writeClaims: ['candidate.ts'] },
      { id: 'verify', kind: 'agent', role: 'verifier', prompt: 'verify', dependsOn: ['author'] },
      { id: 'gate', kind: 'gate', dependsOn: ['verify'], checks: [
        { id: 'oracle', kind: 'command', command: 'ok', args: [] },
        { kind: 'independence', authorNodeIds: ['author'], subjectNodeId: 'verify' },
      ] },
    ] } }, scope) as StoredRecord<TaskPlan>;
    const started = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    const run = await settle(f, started.id);
    assert.equal(run.state, 'failed');
    assert.ok(JSON.stringify(run.nodeRuns.gate.error?.details).includes('REVIEW_CANDIDATE_OR_CONTRACT_CHANGED'));
  } finally { await f.close(); }
});
test('final delivery rejects candidate changes made by an authorized node after its independent gate passed', async () => {
  let candidatePath = '';
  const f = await fixture(undefined, { async text(request) {
    if (request.role === 'reviewer') return JSON.stringify(reportFor(request));
    if (request.role === 'post-review-editor') {
      await writeFile(candidatePath, 'export const candidate = 2;\n');
      return 'authorized later edit completed';
    }
    return 'author artifact';
  } });
  try {
    candidatePath = join(f.services.workspaceRoot, 'candidate.ts');
    await writeFile(candidatePath, 'export const candidate = 1;\n');
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'verify the delivered candidate is still the reviewed candidate',
      deliveryContract: { requiredNodeIds: ['gate', 'mutation'], requireIndependentVerification: true },
      nodes: [
        { id: 'author', kind: 'agent', role: 'implementer', prompt: 'a', writeClaims: ['candidate.ts'] },
        { id: 'reviewer', kind: 'agent', role: 'reviewer', prompt: 'review', dependsOn: ['author'] },
        { id: 'gate', kind: 'gate', dependsOn: ['reviewer'], checks: [
          { id: 'oracle', kind: 'command', command: 'ok', args: [] },
          { kind: 'independence', authorNodeIds: ['author'], subjectNodeId: 'reviewer' },
        ] },
        { id: 'mutation', kind: 'agent', role: 'post-review-editor', prompt: 'make an authorized later edit', writeClaims: ['candidate.ts'], dependsOn: ['gate'] },
      ] } }, scope) as StoredRecord<TaskPlan>;
    const started = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    const run = await settle(f, started.id);
    assert.equal(run.nodeRuns.gate.state, 'succeeded');
    assert.equal(run.nodeRuns.mutation.state, 'succeeded');
    assert.equal((run.events.find(event => event.type === 'gate.verdict')!.data as { verdict: { verdict: string } }).verdict.verdict, 'pass');
    assert.equal(run.state, 'failed');
    assert.equal(run.nodeRuns.reviewer.reviewEvidence?.valid, false);
    assert.ok(run.nodeRuns.reviewer.reviewEvidence?.reasons.includes('REVIEW_CANDIDATE_OR_CONTRACT_CHANGED'));
    assert.ok(run.events.some(event => event.type === 'delivery.review-checked' && event.nodeId === 'reviewer' && event.reason === 'needs-review'));
  } finally { await f.close(); }
});
test('shared ownership is serialized at compile time without losing either node', async () => {
  const f = await fixture();
  try {
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'same lockfile', nodes: [{ id: 'a', kind: 'agent', prompt: 'a', writeClaims: ['package-lock.json'] }, { id: 'b', kind: 'agent', prompt: 'b', writeClaims: ['package-lock.json'] }] } }, scope) as StoredRecord<TaskPlan>;
    assert.equal(plan.value.nodes.length, 2); assert.ok(plan.value.edges.some(e => e.from === 'a' && e.to === 'b' && e.kind === 'ownership'));
  } finally { await f.close(); }
});
test('todo invalid calendar date and missing prompt binding are rejected; overdue order is stable', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.workflow.dispatch({ action: 'todo/create', params: { content: 'bad date', due: '2026-02-30' } }, scope), (error: unknown) => error instanceof NexusError && error.code === 'INVALID_ARGUMENT');
    await f.workflow.dispatch({ action: 'todo/create', params: { content: 'future', due: '2026-10-30' } }, scope);
    await f.workflow.dispatch({ action: 'todo/create', params: { content: 'overdue', due: '2026-10-01' } }, scope);
    const list = await f.workflow.dispatch({ action: 'todo/list', params: { today: '2026-10-19' } }, scope) as { items: StoredRecord<{ content: string }>[] };
    assert.equal(list.items[0].value.content, 'overdue');
    const prompt = await f.workflow.dispatch({ action: 'prompt/create', params: { name: 'fixture', content: 'Hello {{name}}' } }, scope) as StoredRecord;
    await assert.rejects(f.workflow.dispatch({ action: 'prompt/apply', params: { templateId: prompt.id, bindings: {} } }, scope), (error: unknown) => error instanceof NexusError && error.code === 'INVALID_ARGUMENT');
  } finally { await f.close(); }
});
test('full Agency catalog remains expandable and expert persona retrieval is separate from listing', async () => {
  const f = await fixture();
  try {
    const list = await f.agents.dispatch({ action: 'list', params: { limit: 1 } }, scope) as { total: number; categories: string[]; items: { id: string; body?: string }[] };
    assert.ok(list.total >= 331); assert.ok(list.categories.length >= 22); assert.equal(list.items[0].body, undefined);
    const expert = await f.agents.dispatch({ action: 'get', params: { id: list.items[0].id } }, scope) as { translations: Record<string, { body: string }> };
    assert.ok(Object.values(expert.translations).some(t => t.body.length > 100));
  } finally { await f.close(); }
});
test('cancel waits exact activation dispose and never substitutes abort-only success', async () => {
  let disposeCalls = 0;
  let resolveChild: ((value: { text: string }) => void) | undefined;
  const f = await fixture(async () => ({
    id: 'owned-activation',
    result: new Promise(resolve => { resolveChild = resolve; }),
    async dispose() { disposeCalls++; resolveChild?.({ text: 'cancel settled' }); },
  }));
  try {
    const plan = await f.workflow.dispatch({ action: 'plan', params: { goal: 'cancel owned child', nodes: [{ id: 'owned', kind: 'agent', prompt: 'wait' }] } }, scope) as StoredRecord<TaskPlan>;
    const start = await f.workflow.dispatch({ action: 'run', params: { planId: plan.id } }, scope) as StoredRecord<Run>;
    for (let i = 0; i < 100 && !resolveChild; i++) await new Promise(resolve => setTimeout(resolve, 2));
    const cancelled = await f.workflow.dispatch({ action: 'cancel', params: { runId: start.id } }, scope) as StoredRecord<Run>;
    assert.equal(disposeCalls, 1);
    assert.equal(cancelled.value.state, 'cancelled');
    assert.equal(cancelled.value.nodeRuns.owned.state, 'cancelled');
    assert.ok(cancelled.value.events.some(e => e.type === 'cancel.requested'));
  } finally { await f.close(); }
});
test('room messages need runtime permission, preserve source, and presence is never execution evidence', async () => {
  const f = await fixture();
  try {
    const room = await f.agents.dispatch({ action: 'room/create', params: { name: 'coordination' } }, scope) as StoredRecord;
    await assert.rejects(f.agents.dispatch({ action: 'room/send', params: { roomId: room.id, nodeId: 'n', body: 'hello', authorized: true } }, scope), (error: unknown) => error instanceof NexusError && error.code === 'AUTHORIZATION_REQUIRED');
    const message = await f.agents.dispatch({ action: 'room/send', params: { roomId: room.id, nodeId: 'n', body: 'hello', idempotencyKey: 'once' } }, { ...scope, permissions: new Set(['agents:message']) }) as StoredRecord<{ source: string; delivery: string; executionConfirmed: boolean }>;
    assert.equal(message.value.source, 'plugin:dsh-nexus'); assert.equal(message.value.delivery, 'accepted'); assert.equal(message.value.executionConfirmed, false);
    const presence = await f.agents.dispatch({ action: 'room/presence', params: { roomId: room.id } }, scope) as { executionConfirmed: boolean }[];
    assert.ok(presence.every(p => p.executionConfirmed === false));
  } finally { await f.close(); }
});
