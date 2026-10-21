import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { sessionTitles, sessionWorkspaceRoot } from '../src/host/session-metadata.js';
import { registerRpcRoute } from '../src/host/routes.js';
import { OperationController } from '../src/host/lifecycle.js';
import { validatePlan } from '../src/domain/workflow/plan.js';
import { createHostAdapter } from '../src/host/host-adapter.js';
import { createScopeModule } from '../src/domain/scope.js';

test('scope discovery and overview traverse the production host router into the native registry', async t => {
  const native = [
    { id: 'workspace-a', title: 'A', path: 'C:\\workspace-a', sessionIds: ['session-a'] },
    { id: 'workspace-b', title: 'B', path: 'C:\\workspace-b', sessionIds: [] },
  ];
  let reads = 0;
  const ctx: any = {
    get(name: string) { return name === 'workspaceRegistry' ? { list() { reads++; return native; } } : undefined; },
    on() { return () => {}; },
    effect(factory: () => unknown) { return factory(); },
  };
  const host = createHostAdapter(ctx, {}, 'C:\\profile-root', new AbortController().signal);
  t.after(() => host.dispose());
  const targets: any[] = [];
  const services: any = {
    host,
    async invoke(domain: string, request: any, scope: any) {
      targets.push({ domain, action: request.action, level: scope.scopeLevel, root: scope.workspaceRoot, sessionId: scope.sessionId });
      return { items: [] };
    },
  };
  host.connect(services);
  const scope = createScopeModule(services);
  assert.deepEqual(await scope.dispatch({ action: 'workspaces' }, { scopeLevel: 'global' }), { items: native });
  const overview: any = await scope.dispatch({ action: 'overview', params: { feature: 'engineering' } }, { scopeLevel: 'global' });
  assert.equal(reads, 2);
  assert.deepEqual(overview.items.map((row: any) => [row.id, row.counts.length]), [['workspace-a', 2], ['workspace-b', 1]]);
  assert.deepEqual(targets, [
    { domain: 'runtime', action: 'jobs.list', level: 'workspace', root: 'C:\\workspace-a', sessionId: undefined },
    { domain: 'runtime', action: 'jobs.list', level: 'session', root: 'C:\\workspace-a', sessionId: 'session-a' },
    { domain: 'runtime', action: 'jobs.list', level: 'workspace', root: 'C:\\workspace-b', sessionId: undefined },
  ]);
  assert.deepEqual(native[0].sessionIds, ['session-a']);
});

test('one incompatible title preserves every session identity and cancellation rejects the whole read', async () => {
  const signal = new AbortController().signal;
  const values = await sessionTitles({
    async readTitleSnapshots(ids) {
      assert.deepEqual(ids, ['one', 'legacy', 'untitled']);
      return [
        { status: 'fulfilled', value: { session: { id: 'one' }, title: { title: 'Native title' } } },
        { status: 'rejected', reason: new Error('legacy title cannot fold') },
        { status: 'fulfilled', value: { session: { id: 'untitled' } } },
      ];
    },
  }, ['one', 'legacy', 'untitled', 'one'], signal);
  assert.deepEqual([...values], [
    ['one', { title: 'Native title', titleStatus: 'available' }],
    ['legacy', { titleStatus: 'unavailable' }],
    ['untitled', { titleStatus: 'untitled' }],
  ]);
  const fallback = await sessionTitles({ async readTitle(id) { if (id === 'bad') throw new Error('bad'); return { title: id }; } }, ['good', 'bad'], signal);
  assert.equal(fallback.get('good')?.title, 'good');
  assert.equal(fallback.get('bad')?.titleStatus, 'unavailable');
  const controller = new AbortController();
  await assert.rejects(sessionTitles({ async readTitle() { controller.abort(); throw new Error('cancelled read'); } }, ['one'], controller.signal), { name: 'AbortError' });
});

test('native scope resolves trusted live/persisted headers and rejects missing directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-native-workspace-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('nexus-native-workspace-'));
    await rm(root, { recursive: true, force: true });
  });
  const signal = new AbortController().signal;
  const canonical = await realpath(root);
  let queries = 0;
  const ctx: any = { get: (name: string) => name === 'sessions'
    ? { get: (id: string) => id === 'live' ? { header: { id, cwd: root } } : undefined }
    : name === 'sessionQuery' ? { async listSessions() { queries++; return [{ header: { id: 'persisted', cwd: root } }, { header: { id: 'missing', cwd: join(root, 'absent') } }, { header: { id: 'no-cwd' } }]; } }
    : name === 'workspaceRegistry' ? { list: () => [{ id: 'native-workspace', title: 'Native', path: root, sessionIds: ['live', 'persisted'] }] } : undefined };
  assert.equal(await sessionWorkspaceRoot(ctx, 'live', signal), canonical);
  assert.equal(queries, 0);
  assert.equal(await sessionWorkspaceRoot(ctx, 'persisted', signal), canonical);
  await assert.rejects(sessionWorkspaceRoot(ctx, 'unknown', signal), { code: 'NOT_FOUND' });
  await assert.rejects(sessionWorkspaceRoot(ctx, 'missing', signal), { code: 'INVALID_WORKSPACE' });
  await assert.rejects(sessionWorkspaceRoot(ctx, 'no-cwd', signal), { code: 'INVALID_WORKSPACE' });

  let route: any, received: any;
  ctx.connection = { fetch: { register(value: any) { route = value; return async () => {}; } } };
  const dispatcher: any = {
    services: { workspaceRoot: join(root, 'wrong-profile-root') },
    capabilities: () => [{ action: 'list', mutating: false }],
    async dispatch(_domain: string, _payload: any, context: any) { received = context; return { ok: true, data: { cwd: context.workspaceRoot } }; },
  };
  const controller = new OperationController();
  controller.setRouteDisposer(registerRpcRoute(ctx, dispatcher, controller, 65536));
  t.after(() => controller.dispose());
  const request = (scope: any) => new Request('http://fixture.invalid/api/nexus/rpc', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'native-root', method: 'nexus/rpc', payload: {
      protocolVersion: 1, method: 'nexus.query', scope, payload: { action: 'list', params: { domain: 'files' } },
    } }),
  });
  const response = await (await route.fetch(request({ sessionId: 'persisted' }))).json();
  assert.equal(response.result.value.ok, true);
  assert.equal(received.workspaceRoot, canonical);
  assert.equal(received.sessionId, 'persisted');
  const project = await (await route.fetch(request({ level: 'workspace', workspaceId: 'native-workspace' }))).json();
  assert.equal(project.result.value.ok, true);
  assert.equal(received.workspaceRoot, canonical);
  assert.equal(received.sessionId, undefined);
  assert.equal(received.scopeLevel, 'workspace');
  const global = await (await route.fetch(request({ level: 'global' }))).json();
  assert.equal(global.result.value.ok, true);
  assert.equal(received.scopeLevel, 'global');
  assert.equal((await (await route.fetch(request({ level: 'workspace', workspaceId: 'unknown' }))).json()).result.value.error.code, 'NOT_FOUND');
  assert.equal((await (await route.fetch(request({ level: 'global', sessionId: 'live' }))).json()).result.ok, false);
  const spoof = await (await route.fetch(request({ sessionId: 'live', workspaceRoot: 'untrusted-root' }))).json();
  assert.equal(spoof.result.ok, false);
  const unknown = await (await route.fetch(request({ sessionId: 'unknown' }))).json();
  assert.equal(unknown.result.value.error.code, 'NOT_FOUND');
  const plan = validatePlan({ goal: 'Use the selected native workspace', nodes: [{ id: 'work', kind: 'agent', prompt: 'work' }] }, { sessionId: 'persisted', workspaceRoot: canonical });
  assert.equal(plan.nodes[0].cwd, canonical, 'Scheduled model work must retain the native cwd even when later resumed');
});
