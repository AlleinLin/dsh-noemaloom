import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDispatcher, redactSecrets } from '../src/domain/operations/index.js';
import { canonicalJson, createAtomicStore, sha256 } from '../src/domain/storage/index.js';
import { NexusError, type JsonRecord, type NexusHost, type NexusModule, type NexusServices } from '../src/ports/contracts.js';

async function fixture(t: { after(fn: () => Promise<unknown>): void }, approve?: NexusHost['approve']) {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-operations-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const approvals: { action: string; resource: string; details?: JsonRecord }[] = [];
  const host: NexusHost = {
    facts: async () => ({ version: 'test' }),
    model: async () => { throw new Error('model not configured'); },
    spawn: async () => { throw new Error('spawn not configured'); },
    sessions: async () => { throw new Error('sessions not configured'); },
    secret: async () => undefined,
    approve: async (action, resource, details) => {
      approvals.push({ action, resource, details });
      return approve ? approve(action, resource, details) : true;
    },
  };
  const events: unknown[] = [];
  const base: Omit<NexusServices, 'invoke'> = {
    store: createAtomicStore(directory),
    dataDir: directory,
    workspaceRoot: directory,
    host,
    executor: { run: async () => { throw new Error('executor not configured'); } },
    emit: (name, data) => { events.push({ name, data }); },
  };
  return { directory, base, approvals, events };
}

test('20 concurrent retries execute once and persisted receipts survive dispatcher restart', async (t) => {
  const { base, events } = await fixture(t);
  let executions = 0;
  const module: NexusModule = {
    id: 'memory',
    capabilities: [{ action: 'commit', description: '提交', mutating: true, permission: 'memory.write' }],
    dispatch: async () => ({ committed: true, id: `record-${++executions}`, effects: [{ kind: 'record_committed' }] }),
  };
  const dispatcher = createDispatcher(base, [module]);
  const context = { actorId: 'human-one', permissions: new Set(['memory.write']) };
  const results = await Promise.all(Array.from({ length: 20 }, () => dispatcher.dispatch('memory', {
    action: 'commit', requestId: 'intent-one', params: { z: 1, a: { y: 2, b: 3 } },
  }, context)));
  assert.equal(executions, 1);
  for (const result of results) {
    assert.equal(result.ok, true);
    assert.equal(result.evidenceLevel, 'persisted');
    assert.deepEqual(result, results[0]);
  }
  assert.equal(events.length, 1);
  const restarted = createDispatcher(base, [module]);
  const replayed = await restarted.dispatch('nexus_memory', {
    action: 'commit', requestId: 'intent-one', params: { a: { b: 3, y: 2 }, z: 1 },
  }, context);
  assert.deepEqual(replayed, results[0]);
  assert.equal(executions, 1);
});

test('same ID with a changed digest conflicts; actor and workspace scopes remain independent', async (t) => {
  const { base, directory } = await fixture(t);
  let count = 0;
  const dispatcher = createDispatcher(base, [{
    id: 'memory',
    capabilities: [{ action: 'commit', description: '提交', mutating: true }],
    dispatch: async () => ({ count: ++count }),
  }]);
  assert.equal((await dispatcher.dispatch('memory', { action: 'commit', requestId: 'same', params: { value: 1 } }, { actorId: 'a' })).ok, true);
  const conflict = await dispatcher.dispatch('memory', { action: 'commit', requestId: 'same', params: { value: 2 } }, { actorId: 'a' });
  assert.equal(conflict.error?.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await dispatcher.dispatch('memory', { action: 'commit', requestId: 'same', params: { value: 2 } }, { actorId: 'b' })).ok, true);
  assert.equal((await dispatcher.dispatch('memory', { action: 'commit', requestId: 'same', params: { value: 2 } }, {
    actorId: 'a', workspaceRoot: join(directory, 'other'),
  })).ok, true);
  assert.equal(count, 3);
});

test('permission metadata cannot be bypassed by RPC params or internal invoke', async (t) => {
  const { base, approvals } = await fixture(t, async () => false);
  const dispatcher = createDispatcher(base);
  let executed = false;
  dispatcher.register({
    id: 'files',
    capabilities: [{ action: 'edit', description: '编辑文件', mutating: true, permission: 'files.write' }],
    dispatch: async () => { executed = true; return { edited: true }; },
  });
  dispatcher.register({
    id: 'quality',
    capabilities: [{ action: 'check', description: '检查' }],
    dispatch: async () => dispatcher.services.invoke('files', {
      action: 'edit', requestId: 'nested-write', params: { permissions: ['files.write'], approved: true },
    }),
  });
  const denied = await dispatcher.dispatch('quality', { action: 'check' }, { actorId: 'human', sessionId: 'live-session' });
  assert.equal(denied.error?.code, 'PERMISSION_DENIED');
  assert.equal(executed, false);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].details?.sessionId, 'live-session');
  assert.equal(approvals[0].details?.actorId, 'human');
  const allowed = await dispatcher.dispatch('files', { action: 'edit', requestId: 'verified-write' }, {
    actorId: 'human', permissions: new Set(['files.write']),
  });
  assert.equal(allowed.ok, true);
  assert.equal(executed, true);
  assert.equal(approvals.length, 1);
});

test('write requires requestId; queries are optional, catalog paginates, registrations cannot reduce frozen rights', async (t) => {
  const { base } = await fixture(t, async () => false);
  const capabilities = [
    { action: 'write', description: '写', mutating: true, permission: 'right.write' },
    { action: 'read', description: '读' },
  ];
  const dispatcher = createDispatcher(base, [{ id: 'sample', capabilities, dispatch: async () => ({ value: 1 }) }]);
  assert.equal((await dispatcher.dispatch('sample', { action: 'write' })).error?.code, 'INVALID_ARGUMENT');
  capabilities[0].mutating = false;
  capabilities[0].permission = '';
  assert.equal((await dispatcher.dispatch('sample', { action: 'write', requestId: 'denied' })).error?.code, 'PERMISSION_DENIED');
  assert.equal((await dispatcher.dispatch('sample', { action: 'read' })).ok, true);
  const page = await dispatcher.dispatch('catalog', { action: 'capabilities', limit: 1 });
  assert.equal(page.ok, true);
  assert.equal(page.page.truncated, true);
  assert.ok(page.page.nextCursor);
  const next = await dispatcher.dispatch('catalog', { action: 'capabilities', limit: 1, cursor: page.page.nextCursor });
  assert.equal(next.ok, true);
  assert.notDeepEqual(next.data, page.data);
  assert.equal((await dispatcher.dispatch('catalog', { action: 'read', target: { id: 'sample.write' } })).ok, true);
});

test('unknown errors hide details; known errors redact secrets and failed mutation is also idempotent', async (t) => {
  const { base } = await fixture(t);
  let attempts = 0;
  const dispatcher = createDispatcher(base, [{
    id: 'test',
    capabilities: [
      { action: 'known', description: '已知错误', mutating: true },
      { action: 'unknown', description: '未知错误' },
    ],
    dispatch: async (request) => {
      if (request.action === 'unknown') throw new Error('Authorization: Bearer completely-private');
      attempts += 1;
      throw new NexusError('UPSTREAM_UNAVAILABLE', 'provider api_key=private-key https://example.com/x?credential=hidden', {
        authorization: 'Bearer test-hidden-token',
        url: 'https://user:pass@example.com/private?unrecognized=hidden-value',
        nested: { apiKey: 'private-key' },
      });
    },
  }]);
  const first = await dispatcher.dispatch('test', { action: 'known', requestId: 'failed-intent' });
  const second = await dispatcher.dispatch('test', { action: 'known', requestId: 'failed-intent' });
  assert.equal(first.ok, false);
  assert.equal(first.error?.code, 'UPSTREAM_UNAVAILABLE');
  assert.deepEqual(second, first);
  assert.equal(attempts, 1);
  assert.ok(first.receipt);
  for (const secret of ['private-key', 'test-hidden-token', 'hidden-value', 'user:pass']) {
    assert.equal(JSON.stringify(first).includes(secret), false);
  }
  const unknown = await dispatcher.dispatch('test', { action: 'unknown' });
  assert.equal(unknown.error?.code, 'INTERNAL');
  assert.equal(JSON.stringify(unknown).includes('completely-private'), false);
});

test('receipt normalization preserves redaction and treats prototype-shaped keys as inert own data', async (t) => {
  const { base } = await fixture(t);
  const diagnostics = JSON.parse('{"__proto__":{"nexusPolluted":true,"apiKey":"dummy-prototype-key"},"constructor":{"prototype":{"nexusPolluted":true,"password":"dummy-constructor-password"}},"effects":[{"__proto__":{"nexusPolluted":true},"authorization":"Bearer dummy-effect-token"}]}') as JsonRecord;
  const redacted = redactSecrets(diagnostics) as JsonRecord;
  assert.equal(Object.hasOwn(redacted, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(redacted)?.nexusPolluted, undefined);
  assert.equal((redacted.__proto__ as JsonRecord).apiKey, '[REDACTED]');
  let executions = 0;
  const module: NexusModule = {
    id: 'test',
    capabilities: [{ action: 'diagnostic', description: '脱敏诊断', mutating: true }],
    dispatch: async () => {
      executions += 1;
      throw new NexusError('UPSTREAM_UNAVAILABLE', 'provider unavailable', diagnostics);
    },
  };
  const dispatcher = createDispatcher(base, [module]);
  const request = { action: 'diagnostic', requestId: 'prototype-shaped-diagnostic' };
  const first = await dispatcher.dispatch('test', request);
  assert.equal(first.ok, false);
  const details = first.error!.details as JsonRecord;
  assert.equal(Object.getPrototypeOf(details), Object.prototype);
  assert.equal(Object.hasOwn(details, '__proto__'), true);
  assert.equal((details.__proto__ as JsonRecord).nexusPolluted, true);
  assert.equal(({} as JsonRecord).nexusPolluted, undefined);
  for (const secret of ['dummy-prototype-key', 'dummy-constructor-password', 'dummy-effect-token']) {
    assert.equal(JSON.stringify(first).includes(secret), false);
  }
  assert.deepEqual(await dispatcher.readReceipt(request.requestId), first);
  const restarted = createDispatcher(base, [module]);
  assert.deepEqual(await restarted.dispatch('test', request), first);
  assert.equal(executions, 1);
  assert.equal(({} as JsonRecord).nexusPolluted, undefined);
});

test('interrupted durable intent blocks automatic replay of an effect with unknown outcome', async (t) => {
  const { base, directory } = await fixture(t);
  const requestId = 'interrupted';
  const actorId = 'human';
  const scopeDigest = sha256(canonicalJson({ actorId, workspace: await realpath(directory) }));
  const id = sha256(canonicalJson({ scope: scopeDigest, requestId }));
  const requestDigest = sha256(canonicalJson({
    domain: 'runtime',
    request: { action: 'send', target: {}, params: {}, cursor: null, limit: 20 },
  }));
  await base.store.put('__nexus_operation_receipts_v1', id, {
    schemaVersion: 1, requestId, requestDigest, scopeDigest, state: 'started',
    startedAt: new Date().toISOString(), traceId: 'prior-process-trace',
  }, 0);
  let executed = false;
  const dispatcher = createDispatcher(base, [{
    id: 'runtime',
    capabilities: [{ action: 'send', description: '外部效果', mutating: true }],
    dispatch: async () => { executed = true; return { sent: true }; },
  }]);
  const response = await dispatcher.dispatch('runtime', { action: 'send', requestId }, { actorId });
  assert.equal(response.error?.code, 'PARTIAL_EFFECT');
  assert.equal(executed, false);
  assert.equal((response.error?.effects as { automaticReplay: boolean }).automaticReplay, false);
  const scoped = await dispatcher.dispatch('runtime', { action: 'send', requestId }, { actorId, scopeLevel: 'session', sessionId: 'new-session' });
  assert.equal(scoped.error?.code, 'PARTIAL_EFFECT', 'Legacy receipt without session identity must also prevent replay after the scope upgrade');
  assert.equal(executed, false);
});

test('failure to persist final receipt never advertises success or repeats side effects', async (t) => {
  const { base } = await fixture(t);
  const durable = base.store;
  let receiptWrites = 0;
  base.store = {
    get: durable.get.bind(durable),
    list: durable.list.bind(durable),
    remove: durable.remove.bind(durable),
    put: async (collection, id, value, revision) => {
      if (collection === '__nexus_operation_receipts_v1' && ++receiptWrites === 2) throw new Error('simulated fsync failure');
      return durable.put(collection, id, value, revision);
    },
  };
  let executed = 0;
  const dispatcher = createDispatcher(base, [{
    id: 'test',
    capabilities: [{ action: 'effect', description: '有真实效果', mutating: true }],
    dispatch: async () => ({ applied: ++executed }),
  }]);
  const first = await dispatcher.dispatch('test', { action: 'effect', requestId: 'disk-failure' });
  const retried = await dispatcher.dispatch('test', { action: 'effect', requestId: 'disk-failure' });
  assert.equal(first.error?.code, 'PARTIAL_EFFECT');
  assert.equal(retried.error?.code, 'PARTIAL_EFFECT');
  assert.equal(executed, 1);
});

test('nested mutation reusing its parent requestId fails promptly instead of waiting on its own lease', async (t) => {
  const { base } = await fixture(t);
  const dispatcher = createDispatcher(base);
  dispatcher.register({
    id: 'workflow',
    capabilities: [{ action: 'run', description: '运行', mutating: true }],
    dispatch: async (request) => dispatcher.services.invoke('runtime', { action: 'write', requestId: request.requestId }),
  });
  let effects = 0;
  dispatcher.register({
    id: 'runtime',
    capabilities: [{ action: 'write', description: '写', mutating: true }],
    dispatch: async () => ({ effects: ++effects }),
  });
  const result = await dispatcher.dispatch('workflow', { action: 'run', requestId: 'parent-intent' });
  assert.equal(result.error?.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(effects, 0);
});

test('internal missing child requestIds derive independent durable intents only under an authorized mutating parent', async (t) => {
  const { base } = await fixture(t);
  const dispatcher = createDispatcher(base);
  let effects = 0;
  dispatcher.register({
    id: 'workflow', capabilities: [{ action: 'run', description: 'parent', mutating: true }],
    dispatch: async () => {
      const first = await dispatcher.services.invoke('runtime', { action: 'write', params: { item: 'same' } });
      const second = await dispatcher.services.invoke('runtime', { action: 'write', params: { item: 'same' } });
      return { first, second };
    },
  });
  dispatcher.register({
    id: 'runtime', capabilities: [{ action: 'write', description: 'child', mutating: true }],
    dispatch: async request => ({ requestId: request.requestId, effect: ++effects }),
  });
  await assert.rejects(dispatcher.services.invoke('runtime', { action: 'write' }), { code: 'INVALID_ARGUMENT' });
  const first = await dispatcher.dispatch('workflow', { action: 'run', requestId: 'parent-derived' });
  const repeated = await dispatcher.dispatch('workflow', { action: 'run', requestId: 'parent-derived' });
  assert.equal(first.ok, true);
  assert.equal(effects, 2);
  const data = first.data as any;
  assert.match(data.first.requestId, /^child_[a-f0-9]{64}$/);
  assert.notEqual(data.first.requestId, data.second.requestId);
  assert.deepEqual(repeated.data, first.data);
});

test('derived child intent does not inherit authorization for another domain', async (t) => {
  const { base } = await fixture(t);
  base.host.approve = async () => false;
  const dispatcher = createDispatcher(base);
  let effects = 0;
  dispatcher.register({
    id: 'workflow', capabilities: [{ action: 'run', description: 'parent', mutating: true }],
    dispatch: async () => dispatcher.services.invoke('runtime', { action: 'write' }),
  });
  dispatcher.register({
    id: 'runtime', capabilities: [{ action: 'write', description: 'child', mutating: true }],
    dispatch: async () => ++effects,
  });
  const result = await dispatcher.dispatch('workflow', { action: 'run', requestId: 'no-cross-domain-grant' },
    { permissions: new Set(['workflow.run']) });
  assert.equal(result.error?.code, 'PERMISSION_DENIED');
  assert.equal(effects, 0);
});
