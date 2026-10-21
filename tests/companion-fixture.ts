import assert from 'node:assert/strict';
import { NexusError, type NexusServices, type NexusStore, type StoredRecord } from '../src/ports/contracts.js';
import { createCompanionModule } from '../src/domain/insights/companion.js';

export const routes = [{ provider: 'local', model: 'first' }, { provider: 'local', model: 'second' }];
export function companionFixture(defaults: Record<string, any> = {}) {
  const rows = new Map<string, StoredRecord>(), calls: any[] = [];
  const store: NexusStore = {
    async get<T>(collection: string, id: string) { return structuredClone(rows.get(`${collection}/${id}`)) as StoredRecord<T> | undefined; },
    async list<T>(collection: string) { return [...rows].filter(([key]) => key.startsWith(`${collection}/`)).map(([, row]) => structuredClone(row)) as StoredRecord<T>[]; },
    async put<T>(collection: string, id: string, value: T, revision?: number) {
      const key = `${collection}/${id}`, old = rows.get(key);
      if (revision !== undefined && revision !== (old?.revision ?? 0)) throw new NexusError('REVISION_CONFLICT', 'fixture CAS conflict');
      const row = { id, value: structuredClone(value), revision: (old?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
      rows.set(key, row); return structuredClone(row);
    },
    async remove(collection, id) { return rows.delete(`${collection}/${id}`); },
  };
  rows.set('scope-settings/global/auxiliary', { id: 'global/auxiliary', revision: 1, updatedAt: '', value: {
    defaults: { routes: routes.slice(0, 1), minIntervalMs: 10000, ...defaults },
  } });
  let seq = 1, phase = 'preplanning', note = true;
  const packets = (sessionId: string) => [{ sessionId, status: 'running', events: [
    { seq: 0, type: 'user/message', data: { message: { id: `${sessionId}-human`, source: { kind: 'user' }, content: [{ type: 'text', text: '研究并制定可靠方案' }] } } },
    { seq, type: 'tool/result', data: { message: { content: [{ type: 'text', text: `调研证据${seq}` }] } } },
  ] }];
  let produce: ((request: any) => Promise<any>) | undefined;
  const services = {
    store, workspaceRoot: 'D:/fixture/companion', dataDir: 'D:/fixture/data', emit() {},
    host: {
      async sessions(action: string, params: any) {
        if (action === 'models/list') return { items: routes.map((route, index) => ({ ...route, highestReasoningEffort: index ? null : 'high',
          capabilities: { reasoningEffort: { state: 'declared', value: index ? [] : ['low', 'high'] } } })) };
        assert.equal(action, 'companion.surface'); return { packets: packets(params.sessionId), unavailable: [] };
      },
      async model(request: any) {
        calls.push(request); if (produce) return produce(request);
        return { provider: request.provider, model: request.model, text: request.role === 'companion-reflection' ? '用户可能需要先明确可验证的成功标准。'
          : request.role === 'companion-context' ? `完整摘要 ${request.prompt.match(/"sessionId":"([^"]+)"/)?.[1] ?? 'main'}#1`
          : JSON.stringify({ phase, researchComplete: phase === 'ready-to-propose', proposalStarted: false,
            phaseEvidence: [`${request.sessionId}#${seq}`], reflection: null, taskSummary: '可靠方案',
            note: note ? { topic: `验证-${request.sessionId}`, text: '请明确独立验收标准', explanation: '工具完成尚不等于验收通过', evidenceRefs: [`${request.sessionId}#${seq}`] } : null }) };
      },
    },
  } as unknown as NexusServices;
  const module = createCompanionModule(services);
  const context = { scopeLevel: 'session' as const, sessionId: 'main', workspaceRoot: services.workspaceRoot, actorId: 'nexus-companion-hook' };
  const dispatch = (action: string, params: any = {}, ctx: any = context) => module.dispatch({ action, params }, ctx) as Promise<any>;
  const owner = { ...context, actorId: 'connection-owner' };
  return { module, services, store, rows, calls, context, owner, dispatch,
    seq: (next: number) => { seq = next; }, phase: (next: string) => { phase = next; }, note: (next: boolean) => { note = next; },
    produce: (next?: (request: any) => Promise<any>) => { produce = next; } };
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
