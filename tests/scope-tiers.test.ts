import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createAtomicStore } from '../src/domain/storage/index.js';
import { createDispatcher } from '../src/domain/operations/index.js';
import { registerDomainModules } from '../src/domain/index.js';
import { workspaceModules, workspaceStore } from '../src/domain/workspace-runtime.js';
import { memorySettings } from '../src/domain/memory/settings.js';
import { qualityQuery } from '../src/client/query-contracts.js';
import { globalFeatureRecords } from '../src/client/global-feature-view.js';
import type { DispatchContext, NexusModule, NexusServices } from '../src/ports/contracts.js';

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), 'nexus-scope-tiers-'));
  const root = await realpath(temporary);
  const a = join(root, 'a'), b = join(root, 'b');
  await mkdir(a); await mkdir(b);
  const store = createAtomicStore(join(root, 'store'));
  let externalCalls = 0;
  const unavailable = async (): Promise<never> => { externalCalls++; throw new Error('No external work in scope regressions'); };
  const base: Omit<NexusServices, 'invoke'> = {
    dataDir: join(root, 'data'), workspaceRoot: a, store, executor: { run: unavailable }, emit() {},
    host: { facts: async () => ({}), approve: async () => true, secret: async () => undefined,
      model: unavailable, spawn: unavailable, sessions: async action => {
        if (action === 'scope.workspaces') return { items: [
          { id: 'wa', path: a, title: 'A', sessionIds: ['a1', 'a2'] }, { id: 'wb', path: b, title: 'B', sessionIds: ['b1'] },
        ] };
        return unavailable();
      } },
  };
  const dispatcher = createDispatcher(base);
  await registerDomainModules(dispatcher.services, module => { dispatcher.register(module); });
  t.after(async () => {
    try { await dispatcher.dispose(); assert.equal(externalCalls, 0); }
    finally {
      if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith('nexus-scope-tiers-')) throw new Error('Unsafe fixture cleanup');
      await rm(temporary, { recursive: true, force: true });
    }
  });
  let sequence = 0;
  const contexts: Record<string, DispatchContext> = {
    global: { scopeLevel: 'global', workspaceRoot: a }, a: { scopeLevel: 'workspace', workspaceRoot: a, workspaceId: 'wa' },
    b: { scopeLevel: 'workspace', workspaceRoot: b, workspaceId: 'wb' },
    a1: { scopeLevel: 'session', workspaceRoot: a, workspaceId: 'wa', sessionId: 'a1' },
    a2: { scopeLevel: 'session', workspaceRoot: a, workspaceId: 'wa', sessionId: 'a2' },
  };
  const call = async (scope: string, domain: string, action: string, params: any = {}, revision?: number, requestId?: string) => dispatcher.dispatch(domain,
    { action, params, expectedRevision: revision, requestId: requestId ?? `scope-test-${++sequence}`, limit: 100 },
    { ...contexts[scope], actorId: 'owner', permissions: new Set([`${domain}.${action}`]) });
  const ok = async (...args: Parameters<typeof call>): Promise<any> => {
    const result = await call(...args);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result.data;
  };
  return { ...base, dispatcher, contexts, call, ok, a, b, store };
}

test('all three tiers and two workspaces persist independent task and graph state', async t => {
  const f = await fixture(t);
  const ids = new Map<string, string>();
  for (const scope of ['global', 'a', 'b', 'a1', 'a2']) {
    const graph = await f.ok(scope, 'graph', 'create', { title: `graph-${scope}` });
    ids.set(scope, graph.id);
    const todo = await f.ok(scope, 'workflow', 'todo/create', { content: `todo-${scope}` });
    assert.equal(todo.value.scope, scope.startsWith('a') && scope.length === 2 ? 'session' : scope === 'global' ? 'work' : 'project');
  }
  for (const scope of ids.keys()) {
    const list = await f.ok(scope, 'graph', 'list');
    assert.deepEqual(list.items.map((r: any) => r.id), [ids.get(scope)]);
    assert.equal((await f.ok(scope, 'workflow', 'todo/list')).items.length, 1);
    for (const [other, id] of ids) if (other !== scope) assert.equal((await f.call(scope, 'graph', 'get', { graphId: id })).ok, false);
  }
});

test('defaults inherit live, local overrides apply to execution and reset restores inheritance', async t => {
  const f = await fixture(t);
  await f.ok('global', 'scope', 'configure', { feature: 'graph', config: { defaults: { create: { title: 'Global' } } } }, 0);
  assert.equal((await f.ok('a1', 'graph', 'create')).title, 'Global');
  await f.ok('a', 'scope', 'configure', { feature: 'graph', config: { defaults: { create: { title: 'Workspace' } } } }, 0);
  assert.equal((await f.ok('a1', 'graph', 'create')).title, 'Workspace');
  await f.ok('a1', 'scope', 'configure', { feature: 'graph', config: { defaults: { create: { title: 'Session' } } } }, 0);
  assert.equal((await f.ok('a1', 'graph', 'create')).title, 'Session');
  assert.equal((await f.ok('a2', 'graph', 'create')).title, 'Workspace');
  assert.equal((await f.ok('b', 'graph', 'create')).title, 'Global');
  const before = await f.ok('a1', 'scope', 'settings', { feature: 'graph' });
  await f.ok('a1', 'scope', 'reset', { feature: 'graph' }, before.local.revision);
  assert.equal((await f.ok('a1', 'graph', 'create')).title, 'Workspace');
  await f.ok('a', 'scope', 'configure', { feature: 'graph', config: { enabled: false } }, 1);
  assert.equal((await f.call('a1', 'graph', 'create')).ok, false);
  assert.equal((await f.call('b', 'graph', 'create')).ok, true);
});

test('template overrides and deletion never mutate the parent or sibling store', async t => {
  const f = await fixture(t);
  await f.store.put('agent-experts', 'template', { name: 'global' }, 0);
  const project = workspaceStore(f.store, f.a);
  const session = workspaceStore(f.store, f.a, 'a1');
  const sibling = workspaceStore(f.store, f.a, 'a2');
  assert.equal((await session.get<any>('agent-experts', 'template'))?.value.name, 'global');
  await project.put('agent-experts', 'template', { name: 'project' }, 1);
  await session.put('agent-experts', 'template', { name: 'session' }, 1);
  assert.equal((await sibling.get<any>('agent-experts', 'template'))?.value.name, 'project');
  await session.remove('agent-experts', 'template', 1);
  assert.equal(await session.get('agent-experts', 'template'), undefined);
  assert.equal((await session.list('agent-experts')).length, 0);
  assert.equal((await project.get<any>('agent-experts', 'template'))?.value.name, 'project');
  assert.equal((await f.store.get<any>('agent-experts', 'template'))?.value.name, 'global');
});

test('session graph references create private branches and retain the workspace original', async t => {
  const f = await fixture(t);
  const original = await f.ok('a', 'graph', 'create', { title: 'Project graph' });
  assert.equal((await f.ok('a1', 'graph', 'workspace.list')).items[0].id, original.id);
  const branch = await f.ok('a1', 'graph', 'workspace.attach', { graphId: original.id }, original.revision);
  assert.equal(branch.sourceGraphId, original.id);
  assert.equal(branch.ownerSessionId, 'a1');
  assert.notEqual(branch.id, original.id);
  assert.equal((await f.ok('a', 'graph', 'get', { graphId: original.id })).title, 'Project graph');
  assert.equal((await f.call('a2', 'graph', 'get', { graphId: branch.id })).ok, false);
  assert.equal((await f.call('a1', 'graph', 'session.prompt', { graphId: branch.id, sessionId: 'a2', prompt: 'should fail' })).ok, false);
  assert.equal((await f.call('a', 'graph', 'session.prompt', { graphId: original.id, sessionId: 'a1', prompt: 'should fail' })).ok, false);
});

test('shared operation request ids are independent across session identities', async t => {
  const f = await fixture(t);
  const first = await f.ok('a1', 'graph', 'create', { title: 'same request' }, undefined, 'shared-request');
  const second = await f.ok('a2', 'graph', 'create', { title: 'same request' }, undefined, 'shared-request');
  assert.notEqual(first.id, second.id);
  assert.equal((await f.ok('a1', 'graph', 'create', { title: 'same request' }, undefined, 'shared-request')).id, first.id);
});

test('memory tiers share readable parent knowledge while keeping writes and settings local', async t => {
  const f = await fixture(t);
  for (const scope of ['global', 'a', 'a1', 'a2', 'b']) {
    await f.ok(scope, 'memory', 'save', { record: { title: scope, body: `memory-${scope}` } });
  }
  const titles = async (scope: string) => (await f.ok(scope, 'memory', 'list')).items.map((r: any) => r.title).sort();
  assert.deepEqual(await titles('global'), ['global']);
  assert.deepEqual(await titles('a'), ['a', 'global']);
  assert.deepEqual(await titles('a1'), ['a', 'a1', 'global']);
  assert.deepEqual(await titles('a2'), ['a', 'a2', 'global']);
  assert.deepEqual(await titles('b'), ['b', 'global']);
  assert.deepEqual((await f.ok('a1', 'memory', 'list', { scope: 'session' })).items.map((r: any) => r.title), ['a1']);
  const project = (await f.ok('a', 'memory', 'list')).items.find((r: any) => r.title === 'a');
  assert.equal((await f.call('a1', 'memory', 'update', { record: { id: project.id, title: 'bad', body: 'bad' } }, project.revision)).ok, false);
  await f.ok('global', 'memory', 'configure', { autoInject: true });
  await f.ok('a', 'memory', 'configure', { captureEnabled: true });
  await f.ok('a1', 'memory', 'configure', { autoInject: false });
  assert.equal((await memorySettings(f.dispatcher.services, f.a, f.contexts.a1)).autoInject, false);
  assert.equal((await memorySettings(f.dispatcher.services, f.a, f.contexts.a2)).autoInject, true);
  assert.equal((await memorySettings(f.dispatcher.services, f.a, f.contexts.a1)).captureEnabled, true);
});

test('usage and context enforce session/workspace boundaries at the shared service', async t => {
  const f = await fixture(t);
  for (const scope of ['a1', 'a2', 'b']) {
    await f.ok(scope, 'usage', 'record', { logicalCallId: scope, attemptId: scope, sessionId: scope === 'b' ? 'b1' : scope, usage: { input_tokens: 10, output_tokens: 2 } });
  }
  assert.equal((await f.ok('global', 'usage', 'list')).items.length, 3);
  assert.equal((await f.ok('a', 'usage', 'list')).items.length, 2);
  assert.equal((await f.ok('a1', 'usage', 'list')).items.length, 1);
  assert.equal((await f.call('a1', 'usage', 'list', { sessionId: 'a2' })).ok, false);
  assert.equal((await f.call('a1', 'context', 'status', { sessionId: 'a2' })).ok, false);
  const empty = await f.ok('a1', 'context', 'wire/diff');
  assert.equal(empty.state, 'not-observed');
  assert.equal(empty.cacheHitProven, false);
  assert.equal((await f.call('a1', 'context', 'wire/diff', { wireId: 'nonexistent' })).ok, false);
});

test('every quality/review tab uses a registered read contract and succeeds on an empty workspace', async t => {
  const f = await fixture(t);
  for (const review of [false, true]) for (const tab of ['runs', 'coverage', 'rules', 'workflow']) {
    const query = qualityQuery(review, tab);
    const capability = f.dispatcher.capabilities(query.domain).find(c => c.action === query.action);
    assert.ok(capability);
    assert.notEqual(capability.mutating, true);
    await f.ok('a1', query.domain, query.action, query.params);
  }
});

test('saved quality rule defaults enter frozen plans and explicit empty selections override inheritance', async t => {
  const f = await fixture(t);
  await f.ok('a', 'scope', 'configure', { feature: 'quality', config: { defaults: { plan: { ruleIds: ['hlt.ts.no-debugger'] } } } }, 0);
  const params = { mode: 'full', paths: [], layers: ['syntax'] };
  const inherited = await f.ok('a1', 'quality', 'plan', params);
  assert.deepEqual(inherited.ruleIds, ['hlt.ts.no-debugger']);
  await f.ok('a1', 'scope', 'configure', { feature: 'quality', config: { defaults: { plan: { ruleIds: [] } } } }, 0);
  assert.deepEqual((await f.ok('a1', 'quality', 'plan', params)).ruleIds, []);
  assert.deepEqual((await f.ok('a2', 'quality', 'plan', { ...params, ruleIds: [] })).ruleIds, []);
  assert.equal(qualityQuery(true, 'rules').domain, 'scope');
  assert.deepEqual(qualityQuery(true, 'rules').params, { feature: 'review' });
});

test('global overview reads scope summaries without invoking models or changing records', async t => {
  const f = await fixture(t);
  await f.ok('a1', 'graph', 'create', { title: 'one' });
  const summary = await f.ok('global', 'scope', 'overview', { feature: 'graph' });
  assert.equal(summary.items.length, 2);
  assert.equal(summary.items[0].counts.find((r: any) => r.sessionId === 'a1').count, 1);
  assert.equal((await f.call('a1', 'scope', 'overview', { feature: 'graph' })).ok, false);
});

test('global feature tables read actual scoped records and retain equal IDs from different sessions', async t => {
  const f = await fixture(t);
  const graph = await f.ok('a1', 'graph', 'create', { title: 'session graph' });
  const summary = await f.ok('global', 'scope', 'overview', { feature: 'graph' });
  assert.equal(summary.items[0].counts.find((r: any) => r.sessionId === 'a1').items, undefined);
  const detailed = await f.ok('global', 'scope', 'overview', { feature: 'graph', includeRecords: true });
  assert.equal(detailed.items[0].counts.find((r: any) => r.sessionId === 'a1').items[0].id, graph.id);
  for (const scope of ['a', 'a1', 'a2', 'b']) {
    const view = f.contexts[scope];
    await workspaceStore(f.store, view.workspaceRoot!, view.sessionId).put('quality.runs', 'equal-id',
      { id: 'equal-id', status: 'passed', verification: 'passed', summary: scope }, 0);
  }
  const quality = await f.ok('global', 'scope', 'overview', { feature: 'quality', includeRecords: true });
  const records = globalFeatureRecords(quality);
  assert.equal(records.length, 4);
  assert.equal(new Set(records.map(r => r.id)).size, 4);
  assert.deepEqual(records.map(r => r.summary).sort(), ['a', 'a1', 'a2', 'b']);
  assert.deepEqual(records.filter(r => r.sessionId).map(r => r.sessionId).sort(), ['a1', 'a2']);
  assert.equal((await f.ok('a1', 'graph', 'list')).items.length, 1);
});

test('runtime disposal visits every module and tier in reverse registration order', async t => {
  const f = await fixture(t);
  const disposed: string[] = [];
  const factories = ['one', 'two', 'three'].map(id => (services: NexusServices): NexusModule => ({
    id, capabilities: [{ action: 'read', description: 'read' }],
    dispatch: async () => services.dataDir,
    dispose: () => { disposed.push(`${services.dataDir}/${id}`); },
  }));
  const modules = await workspaceModules(f.dispatcher.services, factories);
  await modules[0].dispatch({ action: 'read' }, f.contexts.a1);
  await modules[1].dispatch({ action: 'read' }, f.contexts.b);
  for (const module of [...modules].reverse()) await module.dispose?.();
  assert.equal(disposed.length, 9);
  assert.equal(new Set(disposed).size, 9);
});
