import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusError, type NexusHost, type NexusModule, type NexusServices, type NexusStore, type StoredRecord } from '../src/ports/contracts.js';
import { createWorkflowModule } from '../src/domain/workflow/index.js';

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

function fixture() {
  const calls: Array<{ action: string; params: any }> = [];
  const host: NexusHost = {
    async facts() { return {}; },
    async model() { return { text: '' }; },
    async spawn() { throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', 'not used'); },
    async sessions(action, params) { calls.push({ action, params }); return { accepted: true, injectionId: params.injectionId }; },
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

test('prompt/schedule durably injects fixed text after the configured delay', async () => {
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
    assert.equal(f.calls[0].action, 'inject');
    assert.equal(f.calls[0].params.sessionId, 'main-session');
    assert.equal(f.calls[0].params.text, '继续检查测试结果');
    assert.equal((await f.services.store.get<any>('workflow-injections', id))?.value.status, 'completed');
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
