import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusError, type NexusHost, type NexusModule, type NexusServices, type NexusStore, type StoredRecord } from '../src/ports/contracts.js';
import { createWorkflowModule } from '../src/domain/workflow/index.js';
import { Productivity } from '../src/domain/workflow/productivity.js';

class MemoryStore implements NexusStore {
  private readonly rows = new Map<string, StoredRecord>();
  async get<T>(collection: string, id: string) { return structuredClone(this.rows.get(`${collection}:${id}`)) as StoredRecord<T> | undefined; }
  async list<T>(collection: string) { return [...this.rows.entries()].filter(([key]) => key.startsWith(`${collection}:`)).map(([, row]) => structuredClone(row)) as StoredRecord<T>[]; }
  async put<T>(collection: string, id: string, value: T, expectedRevision = 0) {
    const key = `${collection}:${id}`, previous = this.rows.get(key);
    if (expectedRevision !== (previous?.revision ?? 0)) throw new NexusError('REVISION_CONFLICT', 'CAS conflict');
    const row: StoredRecord<T> = { id, revision: (previous?.revision ?? 0) + 1, value: structuredClone(value), updatedAt: new Date().toISOString() };
    this.rows.set(key, row); return structuredClone(row);
  }
  async remove(collection: string, id: string, expectedRevision?: number) {
    const key = `${collection}:${id}`, previous = this.rows.get(key);
    if (previous && expectedRevision !== undefined && expectedRevision !== previous.revision) throw new NexusError('REVISION_CONFLICT', 'CAS conflict');
    return this.rows.delete(key);
  }
}

function fixture(deliver?: (action: string, params: any) => Promise<any>) {
  const calls: Array<{ action: string; params: any }> = [];
  const host: NexusHost = {
    async facts() { return {}; },
    async model() { return { text: '' }; },
    async spawn() { throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', 'not used'); },
    async sessions(action, params) { calls.push({ action, params }); return deliver ? deliver(action, params) : { accepted: true, durable: true }; },
    async secret() { return undefined; },
    async approve() { return true; },
  };
  const modules = new Map<string, NexusModule>();
  const services: NexusServices = {
    store: new MemoryStore(), executor: { async run() { return { exitCode: 0, stdout: '', stderr: '', cancelled: false, durationMs: 0 }; } },
    host, dataDir: 'test-data', workspaceRoot: 'test-workspace', emit() {},
    async invoke(domain, request, context) { return modules.get(domain)!.dispatch(request, context); },
  };
  const workflow = createWorkflowModule(services); modules.set('workflow', workflow);
  return { workflow, services, calls };
}

test('prompt/schedule wakes the exact session through scheduled delivery with a stable identity', async () => {
  const f = fixture();
  try {
    const result = await f.workflow.dispatch({
      action: 'prompt/schedule',
      params: { sessionId: 'main-session', text: '继续检查测试结果', delayMinutes: 0.001 },
    }, { scopeLevel: 'session', sessionId: 'main-session', actorId: 'user' });
    const id = (result as StoredRecord<any>).id;
    assert.equal((result as StoredRecord<any>).value.status, 'scheduled');
    for (let i = 0; i < 30 && !f.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].action, 'scheduled.prompt');
    assert.equal(f.calls[0].params.requestId, id);
    assert.equal(f.calls[0].params.sessionId, 'main-session');
    assert.equal(f.calls[0].params.text, '继续检查测试结果');
    assert.equal((await f.services.store.get<any>('workflow-injections', id))?.value.status, 'completed');
  } finally { await f.workflow.dispose?.(); }
});

async function settle(f: ReturnType<typeof fixture>, id: string, status: string) {
  for (let i = 0; i < 100; i++) {
    const row = await f.services.store.get<any>('workflow-injections', id);
    if (row?.value.status === status) return row;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`plan did not reach ${status}`);
}

test('an unconfirmed native receipt stays visible and never claims delivery', async () => {
  const f = fixture(async () => ({ accepted: false, durable: false, state: 'unknown' }));
  try {
    const row: any = await f.workflow.dispatch({ action: 'prompt/schedule',
      params: { sessionId: 'child', text: 'continue', delayMinutes: 0.0001 } }, { sessionId: 'child' });
    const saved = await settle(f, row.id, 'unknown');
    assert.ok(saved.value.deliveryError);
    assert.equal(saved.value.deliveredAt, undefined);
    await assert.rejects(f.workflow.dispatch({ action: 'prompt/revoke', params: { id: row.id } }, { sessionId: 'child' }),
      { code: 'DELIVERY_ALREADY_STARTED' });
  } finally { await f.workflow.dispose?.(); }
});

test('waiting for a native parent cannot leak into prompt-template turn injection', async () => {
  const f = fixture(async action => {
    assert.equal(action, 'scheduled.prompt');
    return { state: 'waiting', accepted: false, deliveryError: 'parent unavailable' };
  });
  try {
    const row: any = await f.workflow.dispatch({ action: 'prompt/schedule',
      params: { sessionId: 'child', text: 'continue', delayMinutes: 0.0001 } }, { sessionId: 'child' });
    await settle(f, row.id, 'queued');
    await f.workflow.dispatch({ action: 'prompt/on-turn', params: { sessionId: 'child', turn: 1 } }, { sessionId: 'child', actorId: 'nexus-workflow-hook' });
    await f.workflow.dispatch({ action: 'prompt/tick', params: { id: row.id, turn: 2 } }, { sessionId: 'child' });
    assert.equal(f.calls.length, 1);
    await f.workflow.dispatch({ action: 'prompt/revoke', params: { id: row.id } }, { sessionId: 'child' });
    assert.equal((await f.services.store.get<any>('workflow-injections', row.id))?.value.status, 'revoked');
  } finally { await f.workflow.dispose?.(); }
});

test('restart reconciles interrupted delivering plans with their original identity', async () => {
  const f = fixture();
  for (const status of ['delivering', 'queued', 'unknown']) {
    await f.services.store.put('workflow-injections', status, {
      id: status, sessionId: 'child', body: status, delayMinutes: 5, schedule: 'delay',
      dueAt: new Date(Date.now() - 100).toISOString(), status, attempts: 1,
    }, 0);
  }
  const restarted = new Productivity(f.services);
  try {
    await restarted.initialize();
    for (const status of ['delivering', 'queued', 'unknown']) await settle(f, status, 'completed');
    assert.deepEqual(f.calls.map(call => call.params.requestId).sort(), ['delivering', 'queued', 'unknown']);
  } finally { restarted.dispose(); await f.workflow.dispose?.(); }
});

test('legacy unsent plans migrate, but previously attempted plans without native identity cannot replay', async () => {
  const f = fixture();
  for (const [id, status, attempts] of [['old-unsent', 'scheduled', 0], ['old-unknown', 'delivering', 1], ['old-queued', 'queued', 2]] as const) {
    await f.services.store.put('workflow-injections', id, {
      id, status, attempts, sessionId: 'child', body: id, dueAt: new Date(Date.now() - 1).toISOString(), delayMinutes: 1,
    }, 0);
  }
  const restarted = new Productivity(f.services);
  try {
    await restarted.initialize();
    await settle(f, 'old-unsent', 'completed');
    for (const id of ['old-unknown', 'old-queued']) {
      const row = await settle(f, id, 'failed');
      assert.match(row.value.deliveryError, /旧版计划/);
    }
    assert.deepEqual(f.calls.map(call => call.params.requestId), ['old-unsent']);
  } finally { restarted.dispose(); await f.workflow.dispose?.(); }
});

test('permanent child rejection is visible and completed receipts require durability', async () => {
  for (const response of [
    { state: 'failed', accepted: false, deliveryError: 'one-shot child cannot continue' },
    { state: 'accepted', accepted: true, durable: false },
  ]) {
    const f = fixture(async () => response);
    try {
      const row: any = await f.workflow.dispatch({ action: 'prompt/schedule',
        params: { sessionId: 'child', text: 'continue', delayMinutes: 0.0001 } }, { sessionId: 'child' });
      const saved = await settle(f, row.id, response.state === 'failed' ? 'failed' : 'unknown');
      assert.equal(saved.value.deliveredAt, undefined);
    } finally { await f.workflow.dispose?.(); }
  }
});

test('cancelled and not-yet-due plans cannot send on a new turn or after runtime restart', async () => {
  const f = fixture();
  try {
    const row: any = await f.workflow.dispatch({ action: 'prompt/schedule',
      params: { sessionId: 'child', text: 'not yet', delayMinutes: 300 } }, { sessionId: 'child' });
    await f.workflow.dispatch({ action: 'prompt/on-turn', params: { sessionId: 'child', turn: 1 } }, { sessionId: 'child', actorId: 'nexus-workflow-hook' });
    assert.equal(f.calls.length, 0);
    await f.workflow.dispatch({ action: 'prompt/revoke', params: { id: row.id } }, { sessionId: 'child' });
    const restarted = new Productivity(f.services);
    await restarted.initialize();
    restarted.dispose();
    assert.equal(f.calls.length, 0);
  } finally { await f.workflow.dispose?.(); }
});

test('prompt/schedule rejects cross-session sends without explicit messaging permission', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.workflow.dispatch({
      action: 'prompt/schedule',
      params: { sessionId: 'other-session', text: '不应发送', delayMinutes: 5 },
    }, { scopeLevel: 'session', sessionId: 'main-session', actorId: 'user' }), (error: unknown) =>
      error instanceof NexusError && error.code === 'AUTHORIZATION_REQUIRED');
    assert.equal(f.calls.length, 0);
  } finally { await f.workflow.dispose?.(); }
});
