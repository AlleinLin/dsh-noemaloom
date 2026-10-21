import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createThoughtdagSessionController, expandThoughtdagOrigins, ThoughtdagOriginRepository,
  type ThoughtdagOrigin, type ThoughtdagSessionHeader,
} from '../src/host/thoughtdag-session-controller.js';
import type { CanvasScope } from '../src/host/canvas-scope.js';

const scope = (level: CanvasScope['level'] = 'session', id = 'root'): CanvasScope =>
  ({ key: `${level}:${id}`, level, id, sessionIds: new Set([id]) });
const origin = (sessionId: string, sourceSessionId = 'root'): ThoughtdagOrigin => ({
  schemaVersion: 1, sessionId, sourceSessionId, scopeLevel: 'session', scopeId: sourceSessionId,
  workspaceId: 'wa', createdAt: 1,
});

test('ThoughtDAG origin metadata survives reopening and concurrent immutable publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-td-origin-'));
  try {
    const repo = new ThoughtdagOriginRepository(directory);
    await Promise.all([repo.record(origin('child-a')), repo.record(origin('child-b')), repo.record(origin('child-a'))]);
    const reopened = new ThoughtdagOriginRepository(directory);
    assert.deepEqual((await reopened.list()).map(item => item.sessionId).sort(), ['child-a', 'child-b']);
    assert.deepEqual(await reopened.get('child-a'), origin('child-a'));
    const detached = await reopened.list();
    detached[0].scopeId = 'caller-mutation';
    assert.equal((await reopened.list()).some(item => item.scopeId === 'caller-mutation'), false);
    await reopened.record(origin('child-c'));
    assert.equal((await reopened.list()).some(item => item.sessionId === 'child-c'), true,
      'same-instance creation invalidates the short metadata cache immediately');
    await assert.rejects(repo.record({ ...origin('child-a'), createdAt: 2 }), /其他来源/);
    assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
    assert.equal(await repo.get('../../outside'), undefined, 'native ids never become filesystem paths');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session canvas creates an empty native conversation in its actual workspace and preset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-td-create-'));
  try {
    const selected = scope();
    const calls: unknown[] = [];
    const target = {
      async create(input: unknown) { calls.push(input); return { sessionId: 'fresh', agentPreset: 'coding' }; },
      async fork() { throw new Error('fresh compiled context must not inherit a parent log'); },
    };
    const repo = new ThoughtdagOriginRepository(directory);
    const controller = createThoughtdagSessionController(target, {
      currentScope: () => selected, assertSession() {}, origins: repo, now: () => 123,
      headers: async () => [{ id: 'root', cwd: 'D:\\trusted', agentPreset: 'coding' }],
      workspaces: () => [{ id: 'wa', sessionIds: ['root'] }, { id: 'wb', sessionIds: ['outsider'] }],
    });
    const result = await controller.create({ sessionId: 'root', workspaceId: 'wb', cwd: 'D:\\foreign', agentPreset: 'unsafe' });
    assert.deepEqual(calls, [{ workspaceId: 'wa', agentPreset: 'coding' }]);
    assert.equal(result.sessionId, 'fresh');
    assert.equal(selected.sessionIds.has('fresh'), true);
    assert.deepEqual(await repo.get('fresh'), { ...origin('fresh'), createdAt: 123 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('ungrouped session uses only its native cwd while global creation normalizes workspace exclusivity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-td-location-'));
  try {
    let selected = scope();
    const calls: unknown[] = [];
    const controller = createThoughtdagSessionController({
      async create(input: unknown) { calls.push(input); return { sessionId: `fresh-${calls.length}` }; },
    }, {
      currentScope: () => selected, assertSession() {}, origins: new ThoughtdagOriginRepository(directory),
      headers: async () => [{ id: 'root', cwd: 'D:\\trusted' }], workspaces: () => [{ id: 'wa', sessionIds: [] }],
    });
    await controller.create({ cwd: 'D:\\foreign' });
    selected = scope('global', 'global');
    await controller.create({ workspaceId: 'wa', cwd: 'D:\\foreign', sessionId: 'reuse-me', agentPreset: 'coding' });
    selected = scope('workspace', 'wa');
    await controller.create({ workspaceId: 'foreign', cwd: 'D:\\foreign' });
    assert.deepEqual(calls, [{ cwd: 'D:\\trusted' }, { workspaceId: 'wa', agentPreset: 'coding' }, { workspaceId: 'wa' }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('origin persistence failure leaves the new session out of the active scope', async () => {
  const selected = scope();
  let creates = 0;
  const repo = new ThoughtdagOriginRepository(join(tmpdir(), 'unused-thoughtdag-origin'));
  repo.record = async () => { throw new Error('fixture disk unavailable'); };
  const controller = createThoughtdagSessionController({
    async create() { creates++; return { sessionId: 'created-but-not-admitted' }; },
  }, {
    currentScope: () => selected, assertSession() {}, origins: repo,
    headers: async () => [{ id: 'root', cwd: 'D:\\trusted' }], workspaces: () => [],
  });
  await assert.rejects(controller.create(), /disk unavailable/);
  assert.equal(creates, 1, 'no automatic create replay');
  assert.equal(selected.sessionIds.has('created-but-not-admitted'), false);
});

test('explicit native fork boundaries and session checks remain intact', async () => {
  const selected = scope();
  const calls: unknown[] = [];
  const controller = createThoughtdagSessionController({
    async fork(input: unknown) { calls.push(input); return { sessionId: 'native-fork' }; },
    prompt(input: unknown) { calls.push(input); return 'accepted'; },
  }, {
    currentScope: () => selected,
    assertSession(id) { if (!selected.sessionIds.has(id)) throw new Error('foreign session'); },
    origins: new ThoughtdagOriginRepository(join(tmpdir(), 'unused-thoughtdag-origin')),
    headers: async () => [], workspaces: () => [],
  });
  await controller.fork({ sessionId: 'root', atSeq: 17 });
  assert.deepEqual(calls, [{ sessionId: 'root', atSeq: 17 }]);
  assert.equal(controller.prompt({ sessionId: 'native-fork' }), 'accepted');
  await assert.rejects(controller.fork({ sessionId: 'foreign' }), /foreign session/);
  assert.throws(() => controller.prompt({ sessionId: 'foreign' }), /foreign session/);
});

test('fresh graph descendants recover from metadata and explicit workspace moves override graph lineage', () => {
  const headers: ThoughtdagSessionHeader[] = [
    { id: 'root', cwd: 'D:\\same' }, { id: 'fresh', cwd: 'D:\\same' }, { id: 'grandchild', cwd: 'D:\\same' },
    { id: 'other-root', cwd: 'D:\\same' }, { id: 'foreign', cwd: 'D:\\same' },
  ];
  const workspaces = [{ id: 'wa', sessionIds: ['root', 'fresh', 'grandchild'] }, { id: 'wb', sessionIds: ['other-root', 'foreign'] }];
  const origins = [origin('grandchild', 'fresh'), origin('foreign', 'other-root'), origin('fresh')];
  const expand = () => {
    const sessionIds = new Set(['root']);
    expandThoughtdagOrigins({ sessionIds, headers, workspaces, origins });
    return [...sessionIds].sort();
  };
  assert.deepEqual(expand(), ['fresh', 'grandchild', 'root']);
  workspaces[0].sessionIds = ['root', 'grandchild'];
  workspaces[1].sessionIds.push('fresh');
  assert.deepEqual(expand(), ['root'], 'a moved graph child cannot pull itself or descendants back into the source scope');
  workspaces[0].sessionIds = ['grandchild'];
  workspaces[1].sessionIds.push('root');
  assert.deepEqual(expand(), ['fresh', 'root'], 'moving the source together allows its current workspace child, but not a child left elsewhere');
  headers.splice(headers.findIndex(header => header.id === 'fresh'), 1);
  assert.deepEqual(expand(), ['root'], 'deleted native sessions cannot be resurrected by metadata');
});
