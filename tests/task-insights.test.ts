import test from 'node:test';
import assert from 'node:assert/strict';
import { createInsightsModule } from '../src/domain/insights/index.js';
import { analysisSurface } from '../src/domain/insights/surface.js';
import type { NexusServices, NexusStore, StoredRecord } from '../src/ports/contracts.js';

function fixture() {
  const rows = new Map<string, StoredRecord>();
  rows.set('scope-settings/global/auxiliary', { id: 'global/auxiliary', revision: 1, updatedAt: '', value: { defaults: { routes: [{ provider: 'mock', model: 'fake' }] } } });
  const store: NexusStore = {
    async get<T>(c: string, id: string) { return structuredClone(rows.get(`${c}/${id}`)) as StoredRecord<T> | undefined; },
    async list<T>(c: string) { return [...rows].filter(([k]) => k.startsWith(`${c}/`)).map(([, v]) => structuredClone(v)) as StoredRecord<T>[]; },
    async put<T>(c: string, id: string, value: T, revision?: number) {
      const key = `${c}/${id}`, old = rows.get(key);
      assert.equal(revision ?? old?.revision ?? 0, old?.revision ?? 0);
      const r = { id, value: structuredClone(value), revision: (old?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
      rows.set(key, r); return structuredClone(r);
    }, async remove(c, id) { return rows.delete(`${c}/${id}`); },
  };
  let calls = 0, fail = false, seq = 1;
  let release: (() => void) | undefined;
  let block = false;
  const services = {
    store, workspaceRoot: 'D:/fixture/a', dataDir: 'D:/fixture/data', emit() {},
    host: {
      async sessions(action: string, p: any) {
        if (action === 'models/list') return { items: [{ provider: 'mock', model: 'fake', capabilities: { reasoningEffort: { state: 'declared', value: [] } } }] };
        if (action === 'analysis.roster') return [p.sessionId, 'child'];
        return { sessionId: p.sessionId, status: 'running', throughSeq: seq, lines: seq <= p.sinceSeq ? [] : [{ seq, kind: 'user/message', text: '修复导入并验证' }], truncated: false };
      },
      async model(request: any) {
        calls++; assert.equal(request.allowChildren, false); assert.equal(request.readOnly, true);
        if (block) await new Promise<void>(resolve => { release = resolve; });
        if (fail) throw new Error('interrupted provider');
        return { text: JSON.stringify({ goal: '修复导入', currentWork: '检查读取路径', plan: ['读取', '修复', '验证'], nextStep: '修复路径', blockers: [], evidenceRefs: [seq] }), provider: 'mock', model: 'fake' };
      },
    },
  } as unknown as NexusServices;
  const module = createInsightsModule(services);
  const context = { scopeLevel: 'session' as const, sessionId: 'main', workspaceRoot: services.workspaceRoot };
  return { module, services, context, calls: () => calls, fail: (value: boolean) => { fail = value; }, seq: (value: number) => { seq = value; }, block: () => { block = true; }, release: () => release?.() };
}
test('analysis surface omits reasoning/tool arguments, scrubs secrets and bounds incremental input', () => {
  const result = analysisSurface('s', [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'old' }] } },
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'password=hidden' }] } } },
    { seq: 2, type: 'tool/call', data: { name: 'read', arguments: '{"secret":"hide"}' } },
  ], 'running', 0);
  assert.equal(result.lines.length, 2); assert.equal(result.throughSeq, 2);
  assert.doesNotMatch(JSON.stringify(result), /private|hidden|hide|old/);
});
test('analysis distinguishes native tool errors and excludes nested plugin input from user evidence', () => {
  const result = analysisSurface('s', [
    { seq: 0, type: 'user/message', data: { message: { source: { kind: 'nexus' }, content: [{ type: 'text', text: 'injected autonomous instruction' }] } } },
    { seq: 1, type: 'tool/result', data: { message: { isError: true, content: [{ type: 'text', text: 'private result' }] } } },
    { seq: 2, type: 'tool/result', data: { message: { isError: false } } },
  ], 'idle');
  assert.equal(result.lines.length, 2);
  assert.match(result.lines[0].text, /失败/);
  assert.match(result.lines[1].text, /验收状态未确认/);
  assert.doesNotMatch(JSON.stringify(result), /private result|injected autonomous/);
});
test('reads never call models; same input is cached and session/workspace data stays isolated', async () => {
  const f = fixture();
  assert.equal((await f.module.dispatch({ action: 'get' }, f.context) as any).state, 'empty');
  assert.equal(f.calls(), 0);
  await f.module.dispatch({ action: 'analyze' }, f.context);
  await f.module.dispatch({ action: 'analyze' }, f.context);
  assert.equal(f.calls(), 1);
  assert.equal((await f.module.dispatch({ action: 'get' }, { ...f.context, workspaceRoot: 'D:/fixture/b' }) as any).state, 'empty');
  assert.equal((await f.module.dispatch({ action: 'list' }, { ...f.context, sessionId: 'other' }) as any).items.length, 0);
  const result: any = await f.module.dispatch({ action: 'get' }, f.context);
  assert.equal(result.automaticExecution, false); assert.equal(result.summary.nextStep, '修复路径');
});
test('automatic failures have durable states and never replay the same model decision', async () => {
  const f = fixture(); f.fail(true);
  await f.module.dispatch({ action: 'analyze' }, f.context);
  f.fail(false);
  const same: any = await f.module.dispatch({ action: 'analyze' }, f.context);
  assert.equal(same.state, 'failed'); assert.equal(f.calls(), 1);
  await f.module.dispatch({ action: 'analyze', params: { retry: true } }, f.context);
  assert.equal(f.calls(), 2);
});
test('automatic calls obey inherited disable and current-lane cooldown', async () => {
  const f = fixture();
  await f.services.store.put('scope-settings', 'global/insights', { defaults: { automatic: false } }, 0);
  const hook = { ...f.context, actorId: 'nexus-insights-hook' };
  assert.equal((await f.module.dispatch({ action: 'on-event' }, hook) as any).state, 'disabled');
  assert.equal(f.calls(), 0);
  await f.services.store.put('scope-settings', 'global/insights', { defaults: { automatic: true } }, 1);
  await f.module.dispatch({ action: 'on-event' }, hook); f.seq(2);
  assert.equal((await f.module.dispatch({ action: 'on-event' }, hook) as any).state, 'deferred');
  assert.equal(f.calls(), 1);
  await assert.rejects(f.module.dispatch({ action: 'on-event' }, f.context), /宿主/);
});
test('concurrent reads of analysis intent coalesce and in-flight model completion preserves user edits', async () => {
  const f = fixture(); f.block();
  const first = f.module.dispatch({ action: 'analyze' }, f.context);
  const second = f.module.dispatch({ action: 'analyze' }, f.context);
  while (f.calls() === 0) await new Promise(resolve => setTimeout(resolve, 0));
  await f.module.dispatch({ action: 'edit', params: { manual: { goal: '人工目标' } } }, f.context);
  f.release(); await Promise.all([first, second]);
  assert.equal(f.calls(), 1);
  assert.equal((await f.module.dispatch({ action: 'get' }, f.context) as any).summary.goal, '人工目标');
  await f.module.dispose?.();
});
