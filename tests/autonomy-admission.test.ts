import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionBridge } from '../src/host/session-bridge.js';
import { createScopeModule, withScopePolicy } from '../src/domain/scope.js';
import { NexusError, type NexusServices, type NexusStore, type StoredRecord } from '../src/ports/contracts.js';

function fixture() {
  const rows = new Map<string, StoredRecord>();
  let beforePut = () => {};
  const store: NexusStore = {
    async get<T>(c: string, id: string) { return structuredClone(rows.get(`${c}/${id}`)) as StoredRecord<T> | undefined; },
    async list<T>(c: string) { return [...rows].filter(([k]) => k.startsWith(`${c}/`)).map(([, r]) => structuredClone(r)) as StoredRecord<T>[]; },
    async put<T>(c: string, id: string, value: T, expected?: number) {
      const key = `${c}/${id}`, old = rows.get(key);
      if (expected !== undefined && expected !== (old?.revision ?? 0)) throw new NexusError('REVISION_CONFLICT', 'changed');
      const row = { id, value: structuredClone(value), revision: (old?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
      rows.set(key, row); beforePut(); return structuredClone(row);
    },
    async remove(c, id) { return rows.delete(`${c}/${id}`); },
  };
  const services = { store, workspaceRoot: 'C:/synthetic', dataDir: 'C:/synthetic/data', emit() {} } as unknown as NexusServices;
  return { store, services, beforePut(fn: () => void) { beforePut = fn; } };
}

test('a user delivery during autonomous intent persistence prevents enqueue and produces a recoverable not-sent receipt', async () => {
  const f = fixture();
  let deliveries = 0;
  const session = { id: 's', seq: 0 };
  const agent = { id: 's', status: 'idle', session, inbox: { nextTurn: [] as unknown[], nextStep: [] },
    followup() { deliveries++; } };
  const ctx: any = { get(name: string) {
    if (name === 'agents') return { get: () => agent };
    if (name === 'sessionQuery') return { async readSession() { return { session: { id: 's' }, inheritedEventCount: 0, events: [] }; } };
  } };
  const bridge = createSessionBridge(ctx, {}, f.services.workspaceRoot, new AbortController().signal, () => f.services);
  f.beforePut(() => { agent.status = 'running'; agent.inbox.nextTurn.push({ user: true }); });
  const params = { sessionId: 's', text: 'approved step', requestId: 'plan-1-step-1', requireIdleEmpty: true, expectedSessionSeq: 0 };
  await assert.rejects(bridge.dispatch('continue', params), { code: 'AUTONOMY_SESSION_CHANGED' });
  assert.equal(deliveries, 0);
  agent.status = 'idle'; agent.inbox.nextTurn.length = 0;
  const receipt: any = await bridge.dispatch('continue', params);
  assert.equal(receipt.idempotent, true);
  assert.equal(receipt.accepted, false);
  const lookup: any = await bridge.dispatch('activation.lookup', { sessionId: 's', requestId: params.requestId });
  assert.equal(lookup.found, true);
  assert.equal(lookup.requestId, params.requestId);
  assert.equal(lookup.noDelivery, true);
  assert.equal(lookup.state, 'not-sent');
  assert.equal(lookup.reason, 'AUTONOMY_SESSION_CHANGED');
  assert.equal(deliveries, 0);
  await bridge.dispose();
});

test('models cannot alter autonomous policy; disabling a layer still permits status and pause', async () => {
  const f = fixture(), scope = createScopeModule(f.services);
  for (const actorId of ['native-tool', 'remote:owner', 'nexus-autonomy-hook']) {
    await assert.rejects(scope.dispatch({ action: 'configure', params: { feature: 'autonomy', config: { enabled: false } } },
      { scopeLevel: 'global', actorId, permissions: new Set(['scope.configure']) }), { code: 'PERMISSION_DENIED' });
  }
  await scope.dispatch({ action: 'configure', expectedRevision: 0,
    params: { feature: 'autonomy', config: { enabled: false } } },
  { scopeLevel: 'global', actorId: 'connection-owner', permissions: new Set(['scope.configure']) });
  const policy = withScopePolicy({ id: 'autonomy', capabilities: [], async dispatch(r) { return r.action; } }, f.services);
  assert.equal(await policy.dispatch({ action: 'pause' }, { scopeLevel: 'global' }), 'pause');
  assert.equal(await policy.dispatch({ action: 'get' }, { scopeLevel: 'global' }), 'get');
  await assert.rejects(policy.dispatch({ action: 'approve' }, { scopeLevel: 'global' }), { code: 'PERMISSION_DENIED' });
});

test('revoking approval during intent persistence prevents enqueue even when the native session did not change', async () => {
  const f = fixture(), admission = new AbortController();
  let deliveries = 0;
  const agent = { id: 's', status: 'idle', session: { id: 's', seq: 0 }, inbox: { nextTurn: [], nextStep: [] },
    followup() { deliveries++; } };
  const bridge = createSessionBridge({ get: () => ({ get: () => agent }) } as any, {}, f.services.workspaceRoot,
    new AbortController().signal, () => f.services);
  f.beforePut(() => admission.abort());
  await assert.rejects(bridge.dispatch('continue', {
    sessionId: 's', text: 'approved step', requestId: 'revoked-plan', requireIdleEmpty: true,
    expectedSessionSeq: 0, admissionSignal: admission.signal,
  }), { code: 'AUTONOMY_APPROVAL_REVOKED' });
  assert.equal(deliveries, 0);
  const lookup: any = await bridge.dispatch('activation.lookup', { sessionId: 's', requestId: 'revoked-plan' });
  assert.equal(lookup.noDelivery, true);
  assert.equal(lookup.reason, 'AUTONOMY_APPROVAL_REVOKED');
  await bridge.dispose();
});

test('an uncertain native enqueue is never treated as not-sent and lookup cannot replay it', async () => {
  const f = fixture();
  let deliveries = 0;
  const agent = { id: 's', status: 'idle', session: { id: 's', seq: 0 }, inbox: { nextTurn: [], nextStep: [] },
    followup() { deliveries++; throw new Error('uncertain after enqueue'); } };
  const ctx: any = { get(name: string) {
    if (name === 'agents') return { get: () => agent };
    if (name === 'sessionQuery') return { async readSession() { return { session: { id: 's' }, inheritedEventCount: 0, events: [] }; } };
  } };
  const bridge = createSessionBridge(ctx, {}, f.services.workspaceRoot, new AbortController().signal, () => f.services);
  const params = { sessionId: 's', requestId: 'uncertain-send', text: 'approved step', requireIdleEmpty: true, expectedSessionSeq: 0 };
  await assert.rejects(bridge.dispatch('continue', params), /uncertain/);
  const lookup: any = await bridge.dispatch('activation.lookup', params);
  assert.equal(lookup.state, 'unknown');
  assert.equal(lookup.noDelivery, undefined);
  assert.equal(lookup.terminal, false);
  assert.equal((await bridge.dispatch('continue', params) as any).accepted, false);
  assert.equal(deliveries, 1);
  await bridge.dispose();
});
