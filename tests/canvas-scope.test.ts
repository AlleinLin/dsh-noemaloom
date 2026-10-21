import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCanvasScope } from '../src/host/canvas-scope.js';
import { createCanvasOriginalState } from '../src/host/canvas-original-state.js';
import type { CanvasScope } from '../src/host/canvas-scope.js';
import type { HostContext } from '../src/host/types.js';

function fixture() {
  const profileDirectory = join(tmpdir(), `nexus-canvas-scope-empty-${randomUUID()}`);
  const headers = [
    { id: 'a-root', cwd: 'D:\\same-path' },
    { id: 'a-child', parentSession: 'a-root', cwd: 'D:\\same-path' },
    { id: 'a-grandchild', parentSession: 'a-child', cwd: 'D:\\another-path' },
    { id: 'a-sibling', cwd: 'D:\\same-path' },
    { id: 'b-root', cwd: 'D:\\same-path' },
    { id: 'b-child', parentSession: 'b-root', cwd: 'D:\\same-path' },
    { id: 'ungrouped', cwd: 'D:\\same-path' },
  ];
  const workspaces = [
    { id: 'workspace-a', title: 'A', path: 'D:\\same-path', sessionIds: ['a-root', 'a-sibling'] },
    { id: 'workspace-b', title: 'B', path: 'D:\\same-path', sessionIds: ['b-root'] },
  ];
  const ctx = {
    get(name: string) {
      if (name === 'sessionQuery') return { listSessions: async () => headers.map(header => ({ header })) };
      if (name === 'workspaceRegistry') return { list: () => workspaces };
      if (name === 'profileContext') return { dir: profileDirectory };
      throw new Error(`Unexpected capability: ${name}`);
    },
  } as unknown as HostContext;
  const scope = (level: string, id: string) => resolveCanvasScope(ctx,
    new URL(`http://localhost/thoughtdag/api/sessions?${new URLSearchParams({ nexusLevel: level, nexusId: id })}`));
  return { headers, workspaces, ctx, scope };
}

test('canvas tiers use native identities even when workspaces have the same disk path', async () => {
  const f = fixture();
  const global = await f.scope('global', 'global');
  const workspace = await f.scope('workspace', 'workspace-a');
  const session = await f.scope('session', 'a-root');
  assert.deepEqual([...global.sessionIds].sort(), f.headers.map(header => header.id).sort());
  assert.deepEqual([...workspace.sessionIds].sort(), ['a-child', 'a-grandchild', 'a-root', 'a-sibling']);
  assert.deepEqual([...session.sessionIds].sort(), ['a-child', 'a-grandchild', 'a-root']);
  for (const outsider of ['b-root', 'b-child', 'ungrouped']) {
    assert.equal(workspace.sessionIds.has(outsider), false, `workspace excludes ${outsider}`);
    assert.equal(session.sessionIds.has(outsider), false, `session excludes ${outsider}`);
  }
  assert.equal(session.sessionIds.has('a-sibling'), false, 'a sibling never enters a root-session canvas');
  assert.equal(new Set([global.key, workspace.key, session.key]).size, 3, 'each tier has independent durable graph storage');
});

test('opening a descendant canvas includes its descendants but never ancestors or siblings', async () => {
  const f = fixture();
  assert.deepEqual([...(await f.scope('session', 'a-child')).sessionIds].sort(), ['a-child', 'a-grandchild']);
  assert.deepEqual([...(await f.scope('workspace', 'workspace-b')).sessionIds].sort(), ['b-child', 'b-root']);
  f.headers.push({ id: 'late-child', parentSession: 'a-grandchild', cwd: 'D:\\elsewhere' });
  assert.equal((await f.scope('session', 'a-root')).sessionIds.has('late-child'), true,
    'new native descendants are discovered on later requests');
});

test('scope resolution rechecks native membership after a move or deletion', async () => {
  const f = fixture();
  assert.equal((await f.scope('workspace', 'workspace-a')).sessionIds.has('a-sibling'), true);
  f.workspaces[0].sessionIds = ['a-root'];
  f.workspaces[1].sessionIds.push('a-sibling');
  assert.equal((await f.scope('workspace', 'workspace-a')).sessionIds.has('a-sibling'), false);
  assert.equal((await f.scope('workspace', 'workspace-b')).sessionIds.has('a-sibling'), true);
  f.headers.splice(f.headers.findIndex(header => header.id === 'a-root'), 1);
  await assert.rejects(f.scope('session', 'a-root'), /会话不存在/);
  f.workspaces.splice(0, 1);
  await assert.rejects(f.scope('workspace', 'workspace-a'), /工作区不存在/);
});

test('explicitly moving a descendant overrides workspace ancestry while session lineage remains visible', async () => {
  const f = fixture();
  f.workspaces[1].sessionIds.push('a-child');
  assert.deepEqual([...(await f.scope('workspace', 'workspace-a')).sessionIds].sort(), ['a-root', 'a-sibling'],
    'the previous workspace cannot pull an explicitly moved child or its implicit descendants back in');
  assert.deepEqual([...(await f.scope('workspace', 'workspace-b')).sessionIds].sort(),
    ['a-child', 'a-grandchild', 'b-child', 'b-root']);
  assert.deepEqual([...(await f.scope('session', 'a-root')).sessionIds].sort(),
    ['a-child', 'a-grandchild', 'a-root'], 'session analysis continues to represent native lineage');
  f.workspaces[1].sessionIds = ['b-root'];
  assert.equal((await f.scope('workspace', 'workspace-a')).sessionIds.has('a-child'), true,
    'ungrouped descendants follow their native parent again on the next request');
});

test('invalid scopes and browser supplied paths cannot become graph identities', async () => {
  const f = fixture();
  for (const [level, id] of [
    ['', ''], ['SESSION', 'a-root'], ['session', ''], ['workspace', ''], ['global', 'workspace-a'],
    ['workspace', 'D:\\same-path'], ['workspace', '..\\workspace-a'], ['session', 'unknown'],
  ]) await assert.rejects(f.scope(level, id), `${level}:${id}`);
  const normal = await f.scope('session', 'a-root');
  const forgedPath = await resolveCanvasScope(f.ctx,
    new URL('http://localhost/synapse/api/workspaces?nexusLevel=session&nexusId=a-root&cwd=D%3A%5Cprivate&workspaceId=workspace-b'));
  assert.equal(forgedPath.key, normal.key);
  assert.deepEqual([...forgedPath.sessionIds].sort(), [...normal.sessionIds].sort(),
    'extra browser path/workspace fields cannot widen native scope');
});

test('cycles and reordered archived headers cannot hang or widen descendant traversal', async () => {
  const f = fixture();
  f.headers.push(
    { id: 'cycle-a', parentSession: 'cycle-b', cwd: '' },
    { id: 'cycle-b', parentSession: 'cycle-a', cwd: '' },
  );
  f.headers.reverse();
  assert.deepEqual([...(await f.scope('session', 'a-root')).sessionIds].sort(), ['a-child', 'a-grandchild', 'a-root']);
  assert.deepEqual([...(await f.scope('session', 'cycle-a')).sessionIds].sort(), ['cycle-a', 'cycle-b']);
  const first = await f.scope('workspace', 'workspace-a');
  f.headers.reverse();
  assert.equal((await f.scope('workspace', 'workspace-a')).key, first.key, 'storage identity is stable across archive order');
});

test('original provider registrations remain isolated through overlapping request lifetimes', async () => {
  const requests = new AsyncLocalStorage<CanvasScope>();
  const current = () => {
    const value = requests.getStore();
    if (!value) throw new Error('no request');
    return value;
  };
  const state = createCanvasOriginalState(current);
  const f = fixture();
  const a = await f.scope('workspace', 'workspace-a');
  const b = await f.scope('session', 'a-root');
  let releaseA!: () => Promise<void>;
  let releaseB!: () => Promise<void>;
  requests.run(a, () => { releaseA = state.acquire(a); state.providers = ['workspace provider']; });
  requests.run(b, () => { releaseB = state.acquire(b); state.providers = ['session provider']; });
  await Promise.all([
    requests.run(a, async () => {
      await Promise.resolve();
      assert.deepEqual(state.providers, ['workspace provider']);
      assert.equal(state.scopeKey, a.key);
      await releaseA();
    }),
    requests.run(b, async () => {
      await Promise.resolve();
      assert.deepEqual(state.providers, ['session provider']);
      assert.equal(state.scopeKey, b.key);
      await releaseB();
    }),
  ]);
  state.dispose();
});

test('provider cache is bounded, protects active requests, and releases idempotently', async () => {
  const f = fixture();
  const a = await f.scope('global', 'global');
  const b = await f.scope('workspace', 'workspace-a');
  const c = await f.scope('session', 'a-root');
  let selected = a;
  const state = createCanvasOriginalState(() => selected, 2);
  const releaseA = state.acquire(a);
  state.providers = ['a'];
  selected = b;
  const releaseB = state.acquire(b);
  state.providers = ['b'];
  assert.throws(() => state.acquire(c), /正在处理其他范围/, 'active scopes cannot be evicted');
  await releaseA();
  await releaseA();
  selected = c;
  const releaseC = state.acquire(c);
  state.providers = ['c'];
  selected = b;
  assert.deepEqual(state.providers, ['b'], 'the other active registration survives eviction');
  await releaseB();
  await releaseC();
  state.dispose();
  assert.throws(() => state.acquire(a), /已卸载/);
  assert.throws(() => state.providers, /未就绪/);
});
