import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CONTEXT_CAPABILITIES } from '../src/domain/context/index.js';
import { createDispatcher, type Dispatcher, type NexusResponse } from '../src/domain/operations/index.js';
import { createAtomicStore } from '../src/domain/storage/index.js';
import { installExecutionPolicy } from '../src/host/execution-policy.js';
import { OperationController } from '../src/host/lifecycle.js';
import { registerRpcRoute } from '../src/host/routes.js';
import type { HostContext } from '../src/host/types.js';
import type { JsonRecord, NexusModule, NexusRequest, NexusServices } from '../src/ports/contracts.js';

const RECEIPTS = '__nexus_operation_receipts_v1';
const EFFECTS = 'context.operation-policy-effects';
const actions = ['handoff', 'recover'] as const;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-context-policy-'));
  const dispatchers: Dispatcher[] = [];
  const ownDispatcher = (dispatcher: Dispatcher) => { dispatchers.push(dispatcher); return dispatcher; };
  t.after(async () => {
    const disposed = await Promise.allSettled(dispatchers.map(dispatcher => dispatcher.dispose()));
    await rm(directory, { recursive: true, force: true });
    for (const result of disposed) if (result.status === 'rejected') throw result.reason;
  });
  let approved = false;
  const approvals: Array<{ permission: string; resource: string; details?: JsonRecord }> = [];
  const calls: NexusRequest[] = [];
  const events: Array<{ name: string; data: unknown }> = [];
  const base: Omit<NexusServices, 'invoke'> = {
    store: createAtomicStore(directory), dataDir: directory, workspaceRoot: directory,
    executor: { run: async () => { throw new Error('executor not configured'); } },
    host: {
      facts: async () => ({ version: 'test' }),
      model: async () => { throw new Error('model not configured'); },
      spawn: async () => { throw new Error('spawn not configured'); },
      sessions: async () => { throw new Error('sessions not configured'); },
      secret: async () => undefined,
      approve: async (permission, resource, details) => {
        approvals.push({ permission, resource, details });
        return approved;
      },
    },
    emit: (name, data) => { events.push({ name, data }); },
  };
  // Exercise the production metadata and every policy consumer without
  // constructing an unrelated compression state or running its algorithms.
  const module: NexusModule = {
    id: 'context', capabilities: CONTEXT_CAPABILITIES,
    dispatch: async request => {
      calls.push(request);
      await base.store.put(EFFECTS, request.action, {
        action: request.action, requestId: request.requestId,
      }, 0);
      return { effects: [{ kind: 'context-operation', action: request.action }] };
    },
  };
  const dispatcher = ownDispatcher(createDispatcher(base, [module]));
  return { base, module, dispatcher, ownDispatcher, approvals, calls, events, approve: () => { approved = true; } };
}

for (const action of actions) {
  test(`context ${action} is rejected by the query carrier and read-only tool guard`, async t => {
    const f = await fixture(t);
    type Guard = (execution: { agent: { id: string }; name: string; arguments: { action: string } }) => string | undefined;
    const captured: {
      guard?: Guard;
      route?: Parameters<HostContext['connection']['fetch']['register']>[0];
    } = {};
    const ctx: HostContext = {
      get: name => name === 'tools' ? {
        guard(callback: Guard) { captured.guard = callback; return () => { delete captured.guard; }; },
      } : undefined,
      on: () => () => {},
      effect: () => {},
      provide: () => () => {},
      connection: { fetch: {
        register(value) { captured.route = value; return async () => { delete captured.route; }; },
      } },
    };
    const disposePolicy = installExecutionPolicy(ctx, new Map([
      ['reviewer', { readOnly: true, allowChildren: false }],
    ]), domain => f.dispatcher.capabilities(domain));
    t.after(disposePolicy);
    assert.ok(captured.guard);
    assert.match(captured.guard({ agent: { id: 'reviewer' }, name: 'nexus_context', arguments: { action } })!, /read-only/);
    assert.equal(captured.guard({ agent: { id: 'reviewer' }, name: 'nexus_context', arguments: { action: 'status' } }), undefined);

    const controller = new OperationController();
    controller.setRouteDisposer(registerRpcRoute(ctx, f.dispatcher, controller, 64 * 1024));
    t.after(() => controller.dispose());
    assert.ok(captured.route);
    const response = await captured.route.fetch(new Request('http://fixture.invalid/api/nexus/rpc', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: `context-${action}-query`, method: 'nexus/rpc',
        payload: {
          protocolVersion: 1, method: 'nexus.query', scope: { sessionId: 'policy-session' },
          payload: { action, requestId: `query-${action}`, params: {
            domain: 'context', sessionId: 'policy-session',
            ...(action === 'handoff' ? { toFile: 'handoff.md' } : {}),
          } },
        },
      }),
    }));
    assert.equal(response.status, 200);
    const envelope = await response.json() as { result: { ok: boolean; value: NexusResponse } };
    assert.equal(envelope.result.ok, true);
    assert.equal(envelope.result.value.ok, false);
    assert.equal(envelope.result.value.error?.code, 'PERMISSION_DENIED');
    assert.equal(f.calls.length, 0);
    assert.equal(f.approvals.length, 0);
    assert.deepEqual(await f.base.store.list(EFFECTS), []);
    assert.deepEqual(await f.base.store.list(RECEIPTS), []);
    assert.deepEqual(f.events, []);
  });

  test(`context ${action} requires an approved intent and retries one durable effect`, async t => {
    const f = await fixture(t);
    const context = { actorId: 'human', sessionId: 'policy-session' };
    const request: NexusRequest = {
      action, requestId: `intent-${action}`, params: {
        sessionId: 'policy-session', ...(action === 'handoff' ? { toFile: 'handoff.md' } : {}),
      },
    };
    const { requestId: _requestId, ...withoutIntent } = request;
    const missingIntent = await f.dispatcher.dispatch('context', withoutIntent, context);
    assert.equal(missingIntent.error?.code, 'INVALID_ARGUMENT');
    assert.equal(f.approvals.length, 0);

    const denied = await f.dispatcher.dispatch('context', request, context);
    assert.equal(denied.error?.code, 'PERMISSION_DENIED');
    assert.equal(f.approvals.length, 1);
    assert.equal(f.approvals[0].permission, `nexus:context:${action}`);
    assert.match(f.approvals[0].resource, /#context\/\*$/);
    assert.deepEqual(f.approvals[0].details, {
      domain: 'context', action, sessionId: 'policy-session', actorId: 'human', requestId: request.requestId,
    });
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await f.base.store.list(EFFECTS), []);
    assert.deepEqual(await f.base.store.list(RECEIPTS), []);
    assert.deepEqual(f.events, []);

    f.approve();
    const results = await Promise.all(Array.from({ length: 8 }, () => f.dispatcher.dispatch('context', request, context)));
    const first = results[0];
    assert.equal(first.ok, true);
    assert.equal(first.evidenceLevel, 'persisted');
    assert.equal(first.receipt?.outcome, 'succeeded');
    assert.equal(first.receipt?.requestId, request.requestId);
    for (const result of results) assert.deepEqual(result, first);
    assert.equal(f.calls.length, 1);
    const effects = await f.base.store.list(EFFECTS);
    assert.equal(effects.length, 1);
    assert.deepEqual(effects[0].value, { action, requestId: request.requestId });
    const receipts = await f.base.store.list<JsonRecord>(RECEIPTS);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].value.state, 'finished');
    assert.deepEqual(receipts[0].value.response, first);
    assert.deepEqual(f.events, [{
      name: 'nexus.operation.committed',
      data: {
        receiptId: first.receipt!.id, domain: 'context', action, requestId: request.requestId,
        traceId: first.traceId, ok: true, operationId: null,
      },
    }]);

    const restarted = f.ownDispatcher(createDispatcher({ ...f.base, store: createAtomicStore(f.base.dataDir) }, [f.module]));
    assert.deepEqual(await restarted.readReceipt(request.requestId!, context), first);
    assert.deepEqual(await restarted.dispatch('context', request, context), first);
    assert.equal(f.calls.length, 1);
    assert.equal((await f.base.store.list(EFFECTS)).length, 1);
    assert.equal(f.events.length, 1);
  });
}
