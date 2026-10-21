import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import { createNexusApi } from '../src/client/transport.js';
import { auxiliaryReadReport, createAuxiliarySettingsReader, AUXILIARY_READ_TIMEOUT_MS } from '../src/client/auxiliary-settings-reader.js';
import type { ClientContext, Data, NexusScope } from '../src/client/types.js';
import { auxiliaryCatalog, AUXILIARY_CATALOG_TIMEOUT_MS } from '../src/domain/insights/auxiliary.js';
import { createScopeModule, withScopePolicy } from '../src/domain/scope.js';
import { NexusError, type DispatchContext, type NexusRequest } from '../src/ports/contracts.js';
import { companionFixture, routes } from './companion-fixture.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function apiFor(call: ClientContext['connection']['rpc']['call']) {
  return createNexusApi({
    connection: { rpc: { call } }, slots: { inject() {}, register() {} }, effect() {},
  });
}
const scope: NexusScope = { level: 'global' };
function connectedFixture() {
  const f = companionFixture({ routes }), scopeModule = createScopeModule(f.services);
  const modules = {
    companion: withScopePolicy(f.module, f.services),
    scope: withScopePolicy(scopeModule, f.services),
  };
  const requests: Array<{ domain: string; action: string; scope: NexusScope; signal?: AbortSignal }> = [];
  const api = apiFor(async (_channel, _endpoint, raw, signal) => {
    const input = raw as { scope: NexusScope; payload: NexusRequest & { params: Data } };
    const { domain, ...params } = input.payload.params;
    requests.push({ domain, action: input.payload.action, scope: input.scope, signal });
    const context: DispatchContext = { actorId: 'connection-owner', scopeLevel: input.scope.level,
      workspaceId: input.scope.workspaceId, sessionId: input.scope.sessionId, signal,
      permissions: new Set([`${domain}.${input.payload.action}`]) };
    const value = await modules[domain as keyof typeof modules].dispatch({ ...input.payload, params }, context);
    return { ok: true, value: { ok: true, data: value } };
  });
  return { ...f, api, scopeModule, requests };
}

test('global saved settings return through the real client and scope policy while model enumeration and workspace discovery hang', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = connectedFixture(), hostCalls: string[] = [], nativeCatalog = deferred<unknown>();
  f.services.workspaceRoot = 'Z:/unavailable-work-machine-share';
  f.services.host.sessions = async action => {
    hostCalls.push(action);
    return action === 'models/list' ? nativeCatalog.promise : new Promise(() => {});
  };
  const before = structuredClone([...f.rows]), settings = createAuxiliarySettingsReader(f.api, 'settings', scope);
  const catalog = createAuxiliarySettingsReader(f.api, 'catalog', scope);
  const workspaces = createAuxiliarySettingsReader(f.api, 'workspaces', scope);
  t.after(() => { settings.cancel(); catalog.cancel(); workspaces.cancel(); f.api.dispose(); });
  const catalogRead = catalog.read(), workspaceRead = workspaces.read();
  const value = await settings.read();
  assert.deepEqual(value?.routes, routes);
  assert.equal(settings.getSnapshot().state, 'ready');
  assert.equal(catalog.getSnapshot().state, 'loading');
  assert.equal(workspaces.getSnapshot().state, 'loading');
  assert.equal(value?.local.scope, 'global');
  assert.equal(f.calls.length, 0, 'Reading settings must never invoke a model');
  await immediate();
  t.mock.timers.tick(AUXILIARY_CATALOG_TIMEOUT_MS);
  await catalogRead;
  assert.equal(catalog.getSnapshot().state, 'error');
  assert.equal(catalog.getSnapshot().diagnostic?.code, 'AUXILIARY_CATALOG_TIMEOUT');
  assert.equal(settings.getSnapshot().state, 'ready', 'Directory failure cannot retire already loaded settings');
  assert.deepEqual(settings.getSnapshot().value?.routes, routes);
  t.mock.timers.tick(AUXILIARY_READ_TIMEOUT_MS - AUXILIARY_CATALOG_TIMEOUT_MS);
  await workspaceRead;
  assert.equal(workspaces.getSnapshot().diagnostic?.code, 'nexus/auxiliary-workspaces-timeout');
  assert.deepEqual([...f.rows], before, 'Independent failed reads must not write or clear saved priorities');
  assert.equal(hostCalls.filter(action => action === 'models/list').length, 1);
});

test('catalog retries share the original hung enumeration, accept its eventual result, and observe a late rejection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = connectedFixture(), native = deferred<unknown>();
  let enumerations = 0;
  const originalSessions = f.services.host.sessions;
  f.services.host.sessions = async action => { assert.equal(action, 'models/list'); enumerations++; return native.promise; };
  const reader = createAuxiliarySettingsReader(f.api, 'catalog', scope);
  t.after(() => { reader.cancel(); f.api.dispose(); });
  let reading = reader.read();
  await immediate();
  t.mock.timers.tick(AUXILIARY_CATALOG_TIMEOUT_MS); await reading;
  assert.equal(reader.getSnapshot().state, 'error');
  reading = reader.read();
  await immediate();
  assert.equal(enumerations, 1, 'Retry must reuse the outstanding native enumeration');
  native.resolve(await originalSessions('models/list', {}));
  await reading;
  assert.equal(reader.getSnapshot().state, 'ready');
  assert.equal(reader.getSnapshot().value?.items.length, 2);

  const late = deferred<unknown>();
  f.services.host.sessions = async () => late.promise;
  reading = reader.read();
  await immediate();
  t.mock.timers.tick(AUXILIARY_CATALOG_TIMEOUT_MS); await reading;
  late.reject(new Error('late failed provider metadata'));
  await immediate();
  assert.equal(reader.getSnapshot().diagnostic?.code, 'AUXILIARY_CATALOG_TIMEOUT');
});

test('cancelling one catalog reader cannot abort another reader sharing the native enumeration', async () => {
  const f = connectedFixture(), native = deferred<unknown>(), one = new AbortController(), two = new AbortController();
  const original = f.services.host.sessions;
  let enumerations = 0;
  f.services.host.sessions = async () => { enumerations++; return native.promise; };
  try {
    const first = auxiliaryCatalog(f.services, one.signal), second = auxiliaryCatalog(f.services, two.signal);
    const cancelled = assert.rejects(first, error => error instanceof NexusError && error.code === 'CANCELLED');
    await immediate(); one.abort(); await cancelled;
    assert.equal(two.signal.aborted, false);
    native.resolve(await original('models/list', {}));
    assert.equal((await second).length, 2);
    assert.equal(enumerations, 1);
    assert.equal(f.calls.length, 0);
  } finally { one.abort(); two.abort(); f.api.dispose(); }
});

test('catalog failure does not block saving existing priorities, reorder/removal or explicit empty overrides', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = connectedFixture(), original = f.services.host.sessions;
  let enumerations = 0;
  f.services.host.sessions = async action => {
    if (action === 'models/list') { enumerations++; return new Promise(() => {}); }
    return original(action, {});
  };
  t.after(() => f.api.dispose());
  const configure = (defaults: Data, revision: number) => f.api.call('scope', 'configure', {
    feature: 'auxiliary', config: { defaults },
  }, { scope, mutating: true, revision });
  await configure({ routes, suggestions: false }, 1);
  let current: any = await f.dispatch('settings', {}, { scopeLevel: 'global' });
  assert.deepEqual(current.routes, routes); assert.equal(current.suggestions, false);
  await configure({ routes: [routes[1], routes[0]], suggestions: false }, 2);
  current = await f.dispatch('settings', {}, { scopeLevel: 'global' });
  assert.deepEqual(current.routes, [routes[1], routes[0]]);
  await configure({ routes: [routes[0]] }, 3);
  assert.equal(enumerations, 0);

  const unchanged = structuredClone([...f.rows]);
  const adding = configure({ routes: [routes[0], { provider: 'local', model: 'unknown' }] }, 4);
  const rejected = assert.rejects(adding, error => (error as any).code === 'AUXILIARY_CATALOG_TIMEOUT');
  await immediate();
  t.mock.timers.tick(AUXILIARY_CATALOG_TIMEOUT_MS); await rejected;
  assert.deepEqual([...f.rows], unchanged, 'Failed validation must not replace the existing priority list');
  await configure({ routes: [] }, 4);
  assert.deepEqual((await f.dispatch('settings', {}, { scopeLevel: 'global' })).routes, []);
  assert.equal(enumerations, 1, 'Clearing explicitly selected routes needs no model directory');
});

test('changing a saved reasoning effort requires successful directory validation and leaves the saved route intact on failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = connectedFixture();
  await f.store.put('scope-settings', 'global/auxiliary', { defaults: {
    routes: [{ ...routes[0], reasoningEffort: 'high' }],
  } }, 1);
  let enumerations = 0;
  f.services.host.sessions = async () => { enumerations++; return new Promise(() => {}); };
  t.after(() => f.api.dispose());
  await f.api.call('scope', 'configure', { feature: 'auxiliary', config: {
    defaults: { routes: [{ ...routes[0], reasoningEffort: 'high' }], reflection: false },
  } }, { scope, mutating: true, revision: 2 });
  assert.equal(enumerations, 0);
  const saving = f.api.call('scope', 'configure', { feature: 'auxiliary', config: {
    defaults: { routes: [{ ...routes[0], reasoningEffort: 'low' }] },
  } }, { scope, mutating: true, revision: 3 });
  const rejected = assert.rejects(saving, error => (error as any).code === 'AUXILIARY_CATALOG_TIMEOUT');
  await immediate();
  t.mock.timers.tick(AUXILIARY_CATALOG_TIMEOUT_MS); await rejected;
  const saved = await f.dispatch('settings', {}, { scopeLevel: 'global' });
  assert.equal(saved.routes[0].reasoningEffort, 'high');
  assert.equal(saved.local.revision, 3);
});

test('invalid or failed host model metadata is an explicit error and never an empty catalog success', async () => {
  const f = connectedFixture();
  try {
    for (const result of [undefined, {}, { items: null }, { items: [{ provider: 'local', model: 'first',
      capabilities: { reasoningEffort: { state: 'declared', value: 'high' } } }] }]) {
      f.services.host.sessions = async () => result;
      await assert.rejects(auxiliaryCatalog(f.services), error => error instanceof NexusError && error.code === 'AUXILIARY_CATALOG_INVALID');
    }
    f.services.host.sessions = async () => { throw new NexusError('DEPENDENCY_MISSING', 'DSH llm.listModels 服务不可用'); };
    const reader = createAuxiliarySettingsReader(f.api, 'catalog', scope);
    await reader.read();
    assert.equal(reader.getSnapshot().diagnostic?.code, 'DEPENDENCY_MISSING');
    assert.match(reader.getSnapshot().message ?? '', /同一版本 Nexus/);
    assert.deepEqual((await f.dispatch('settings', {}, { scopeLevel: 'global' })).routes, routes);
  } finally { f.api.dispose(); }
});

test('an RPC that ignores cancellation reaches a finite error, aborts only its read signal and permits explicit retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = companionFixture(), saved = await f.dispatch('settings', {}, { scopeLevel: 'global' });
  let calls = 0, firstSignal: AbortSignal | undefined;
  const api = apiFor(async (_channel, _endpoint, _raw, signal) => {
    calls++;
    if (calls === 1) { firstSignal = signal; return new Promise(() => {}); }
    return { ok: true, value: { ok: true, data: saved } };
  });
  const reader = createAuxiliarySettingsReader(api, 'settings', scope);
  t.after(() => { reader.cancel(); api.dispose(); });
  const reading = reader.read();
  await immediate();
  t.mock.timers.tick(AUXILIARY_READ_TIMEOUT_MS); await reading;
  assert.equal(reader.getSnapshot().state, 'error');
  assert.equal(reader.getSnapshot().diagnostic?.code, 'nexus/auxiliary-settings-timeout');
  assert.equal(firstSignal?.aborted, true);
  await reader.read();
  assert.equal(reader.getSnapshot().state, 'ready');
  assert.deepEqual(reader.getSnapshot().value?.routes, routes.slice(0, 1));
});

test('missing backends keep exact failure codes and safe trace diagnostics, then recover on explicit retry', async () => {
  const f = companionFixture(), saved = await f.dispatch('settings', {}, { scopeLevel: 'global' });
  let failed = true;
  const api = apiFor(async () => failed ? { ok: true, value: { ok: false, traceId: 'trace-fixture', error: {
    code: 'NOT_FOUND', message: '此领域动作未注册 private-provider-message',
    phase: 'connection-rpc', diagnosticCode: 'NX_FIXTURE', details: { credential: 'test-secret-must-not-copy' },
  } } } : { ok: true, value: { ok: true, data: saved } });
  const reader = createAuxiliarySettingsReader(api, 'settings', scope);
  try {
    await reader.read();
    const state = reader.getSnapshot(), report = auxiliaryReadReport(state, 'error');
    assert.equal(state.state, 'error');
    assert.equal(state.diagnostic?.code, 'NOT_FOUND');
    assert.match(state.message ?? '', /此领域动作未注册/);
    assert.match(state.message ?? '', /同一版本 Nexus/);
    assert.deepEqual(JSON.parse(report).scope, scope);
    assert.equal(JSON.parse(report).traceId, 'trace-fixture');
    assert.equal(JSON.parse(report).phase, 'connection-rpc');
    assert.equal(JSON.parse(report).catalogState, 'error');
    assert.equal(typeof JSON.parse(report).elapsedMs, 'number');
    assert.doesNotMatch(report, /credential|test-secret|private-provider-message|defaults|routes/);
    failed = false; await reader.read();
    assert.equal(reader.getSnapshot().state, 'ready');
  } finally { reader.cancel(); api.dispose(); }
});

test('retired scope reads and superseded retries cannot publish late settings or errors', async () => {
  const f = companionFixture(), saved = await f.dispatch('settings', {}, { scopeLevel: 'global' });
  const retired = deferred<any>(), superseded = deferred<any>();
  let requests = 0;
  const api = apiFor(async () => {
    requests++;
    if (requests === 1) return retired.promise;
    if (requests === 2) return superseded.promise;
    return { ok: true, value: { ok: true, data: { ...saved, routes: [routes[1]] } } };
  });
  const a = createAuxiliarySettingsReader(api, 'settings', { level: 'session', sessionId: 'A' });
  const b = createAuxiliarySettingsReader(api, 'settings', { level: 'session', sessionId: 'B' });
  let aUpdates = 0, bUpdates = 0;
  const removeA = a.subscribe(() => aUpdates++), removeB = b.subscribe(() => bUpdates++);
  try {
    const aRead = a.read(); await immediate(); a.cancel();
    const oldB = b.read(); await immediate();
    await b.read();
    const updates = [aUpdates, bUpdates], bState = b.getSnapshot();
    retired.resolve({ ok: true, value: { ok: true, data: saved } });
    superseded.reject(new Error('old scope/attempt failed late'));
    await Promise.all([aRead, oldB]); await immediate();
    assert.deepEqual([aUpdates, bUpdates], updates);
    assert.equal(b.getSnapshot(), bState);
    assert.deepEqual(bState.value?.routes, [routes[1]]);
    assert.equal(a.getSnapshot().value, undefined);
  } finally { removeA(); removeB(); a.cancel(); b.cancel(); api.dispose(); }
});

test('malformed saved settings fail visibly and never synthesize writable defaults or empty priorities', async () => {
  const f = companionFixture(), saved = await f.dispatch('settings', {}, { scopeLevel: 'global' });
  let result: any = { catalog: [], local: null };
  const api = apiFor(async () => ({ ok: true, value: { ok: true, data: result } }));
  const reader = createAuxiliarySettingsReader(api, 'settings', scope);
  try {
    await reader.read();
    assert.equal(reader.getSnapshot().state, 'error');
    assert.equal(reader.getSnapshot().diagnostic?.code, 'nexus/auxiliary-invalid-response');
    assert.equal(reader.getSnapshot().value, undefined);
    result = { ...saved, local: { ...saved.local, config: { defaults: { routes: 'corrupt-local-priorities' } } } };
    await reader.read();
    assert.equal(reader.getSnapshot().state, 'error');
    assert.equal(reader.getSnapshot().diagnostic?.code, 'nexus/auxiliary-invalid-response');
    assert.equal(reader.getSnapshot().value, undefined);
  } finally { reader.cancel(); api.dispose(); }
});
