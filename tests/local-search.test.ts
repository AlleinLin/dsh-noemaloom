import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createDispatcher } from '../src/domain/operations/index.js';
import { registerDomainModules } from '../src/domain/index.js';
import { createAtomicStore } from '../src/domain/storage/index.js';
import { NexusError, type DispatchContext, type JsonRecord, type NexusServices } from '../src/ports/contracts.js';

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), 'nexus-local-search-')), root = await realpath(temporary);
  const a = join(root, 'a'), b = join(root, 'b');
  await mkdir(a); await mkdir(b);
  let forbidden = 0, sequence = 0;
  const calls: Array<{ action: string; params: JsonRecord }> = [];
  const unavailable = async (): Promise<never> => { forbidden++; throw new Error('Local search must not use network, model or executor'); };
  const sessions = [
    { sessionId: 'a1', cwd: a, title: 'A one' }, { sessionId: 'a2', cwd: a, title: 'A two' },
    { sessionId: 'b1', cwd: b, title: 'B one' },
  ];
  let failSnapshot = false;
  const base: Omit<NexusServices, 'invoke'> = {
    workspaceRoot: a, dataDir: join(root, 'data'), store: createAtomicStore(join(root, 'store')),
    executor: { run: unavailable }, emit() {},
    host: {
      facts: async () => ({}), approve: async () => true, secret: unavailable, model: unavailable, spawn: unavailable,
      async sessions(action, params) {
        calls.push({ action, params });
        if (action === 'list') return sessions; // Includes foreign workspaces: adapter must filter.
        if (action === 'skills.list') return { items: [] };
        if (action !== 'snapshot') return unavailable();
        if (failSnapshot) throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', 'Fixture source is temporarily unavailable');
        const session = sessions.find(row => row.sessionId === params.sessionId);
        if (!session) throw new NexusError('NOT_FOUND', 'Fixture session not found');
        return { ...session, events: [
          { seq: 11, type: 'user/message', message: { content: [{ type: 'text', text: `needle user ${session.sessionId}` }] } },
          { seq: 19, type: 'assistant/message', data: { message: { content: [
            { type: 'text', text: `needle assistant ${session.sessionId}` },
            { type: 'reasoning', text: 'private-reasoning-only' },
          ] } } },
          { seq: 20, type: 'llm/stream', data: { text: 'private-stream-only' } },
        ] };
      },
    },
  };
  const dispatcher = createDispatcher(base);
  await registerDomainModules(dispatcher.services, module => { dispatcher.register(module); });
  t.after(async () => {
    try { await dispatcher.dispose(); assert.equal(forbidden, 0); }
    finally {
      if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith('nexus-local-search-')) throw new Error('Unsafe cleanup path');
      await rm(temporary, { recursive: true, force: true });
    }
  });
  const contexts: Record<string, DispatchContext> = {
    global: { scopeLevel: 'global', workspaceRoot: a },
    a: { scopeLevel: 'workspace', workspaceRoot: a, workspaceId: 'wa' },
    a1: { scopeLevel: 'session', workspaceRoot: a, workspaceId: 'wa', sessionId: 'a1' },
    a2: { scopeLevel: 'session', workspaceRoot: a, workspaceId: 'wa', sessionId: 'a2' },
    b: { scopeLevel: 'workspace', workspaceRoot: b, workspaceId: 'wb' },
  };
  const call = (scope: string, domain: string, action: string, params: JsonRecord = {}) =>
    dispatcher.dispatch(domain, { action, params, requestId: `local-search-${++sequence}`, limit: 100 }, {
      ...contexts[scope], actorId: 'owner', permissions: new Set([`${domain}.${action}`]),
    });
  const ok = async (...args: Parameters<typeof call>): Promise<any> => {
    const result = await call(...args);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result.data;
  };
  const search = (scope: string, type: string, query = 'needle') => ok(scope, 'search', 'query', { mode: 'local', type, query });
  return { a, b, calls, contexts, dispatcher, call, ok, search, failSnapshots: () => { failSnapshot = true; } };
}

test('local session search reads visible text and enforces both session and workspace identities without provider access', async t => {
  const f = await fixture(t);
  const current = await f.search('a1', 'session');
  assert.deepEqual(current.items.map((row: any) => row.seq), [11, 19]);
  assert.ok(current.items.every((row: any) => row.sessionId === 'a1'));
  assert.equal(current.complete, true); assert.equal(current.networkUsed, false);
  const limited = await f.ok('a1', 'search', 'query', { mode: 'local', type: 'session', query: 'needle', maxResults: 1 });
  assert.equal(limited.items.length, 1); assert.equal(limited.truncated, true); assert.equal(limited.complete, false);
  assert.equal(f.calls.some(call => call.action === 'list'), false, 'Current-session search must not enumerate other sessions');
  for (const query of ['private-reasoning-only', 'private-stream-only']) assert.deepEqual((await f.search('a1', 'session', query)).items, []);
  const workspace = await f.search('a', 'session');
  assert.deepEqual([...new Set(workspace.items.map((row: any) => row.sessionId))], ['a1', 'a2']);
  assert.equal(f.calls.some(call => call.action === 'snapshot' && call.params.sessionId === 'b1'), false);
  const wrongRoot = await f.dispatcher.dispatch('search', { action: 'query', params: { query: 'needle', mode: 'local', type: 'session' } },
    { ...f.contexts.a1, workspaceRoot: f.b });
  assert.equal(wrongRoot.error?.code, 'SCOPE_MISMATCH');
});

test('local search reaches real file, task and Markdown-memory executors with tier isolation', async t => {
  const f = await fixture(t);
  await writeFile(join(f.a, '中文.txt'), 'needle file A\n', 'utf8');
  await writeFile(join(f.b, 'foreign.txt'), 'needle file B\n', 'utf8');
  const files = await f.search('a1', 'file');
  assert.deepEqual(files.items.map((row: any) => row.path), ['中文.txt']);
  assert.match(files.items[0].snippet, /file A/);
  for (const scope of ['global', 'a', 'a1', 'a2', 'b']) {
    await f.ok(scope, 'workflow', 'todo/create', { content: `needle task ${scope}` });
    await f.ok(scope, 'memory', 'save', { record: { title: `needle ${scope}`, body: `needle memory ${scope}` } });
  }
  assert.deepEqual((await f.search('a1', 'task')).items.map((row: any) => row.title), ['needle task a1']);
  assert.deepEqual((await f.search('a2', 'task')).items.map((row: any) => row.title), ['needle task a2']);
  assert.deepEqual((await f.search('a', 'task')).items.map((row: any) => row.title), ['needle task a']);
  const memory = await f.search('a1', 'memory');
  assert.deepEqual(memory.items.map((row: any) => row.title).sort(), ['needle a', 'needle a1', 'needle global']);
  assert.equal(memory.coverage[0].boundedRanking, true);
  assert.equal(memory.complete, false, 'A ranked memory result is not an exhaustive search certificate');
  const globalFiles = await f.search('global', 'file');
  assert.deepEqual(globalFiles.items, []); assert.equal(globalFiles.coverage[0].state, 'skipped');
});

test('source errors, pagination, unsupported semantic mode and aborts never pretend to be a successful complete search', async t => {
  const f = await fixture(t);
  f.failSnapshots();
  assert.equal((await f.call('a1', 'search', 'query', { mode: 'local', type: 'session', query: 'needle' })).error?.code, 'HOST_CAPABILITY_UNAVAILABLE');
  const partial = await f.search('a1', 'all');
  assert.equal(partial.complete, false);
  assert.equal(partial.coverage.find((row: any) => row.type === 'session').code, 'HOST_CAPABILITY_UNAVAILABLE');
  assert.equal((await f.call('a1', 'search', 'query', { mode: 'semantic', query: 'needle' })).error?.code, 'SEARCH_MODE_UNAVAILABLE');
  for (const maxResults of [0, '8', 101]) assert.equal((await f.call('a1', 'search', 'query', { mode: 'local', query: 'needle', maxResults })).error?.code, 'INVALID_ARGUMENT');
  const aborted = await f.dispatcher.dispatch('search', { action: 'query', params: { mode: 'local', query: 'needle' } },
    { ...f.contexts.a1, signal: AbortSignal.abort(new NexusError('CANCELLED', 'Cancelled before search')) });
  assert.equal(aborted.ok, false);
});
