import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmError, createUserMessage } from '@deepseek-ai/dsh-llm';
import { registerMemoryHooks } from '../src/host/hooks.js';
import { OperationController } from '../src/host/lifecycle.js';
import { NexusError, type NexusServices } from '../src/ports/contracts.js';
import type { HostContext } from '../src/host/types.js';

function fixture(options: { readError?: unknown; readPending?: Promise<void>; recallError?: unknown; injectError?: unknown } = {}) {
  const hooks = new Map<string, (...args: any[]) => any>(), controller = new OperationController();
  let injected = 0, recalled = 0;
  const services = {
    workspaceRoot: 'D:/memory-fixture', signal: controller.controller.signal,
    store: {
      async get(collection: string) { return collection === 'memory-settings' ? { value: { autoInject: true } } : undefined; },
      async put(_collection: string, id: string, value: unknown) { return { id, value, revision: 1 }; },
    },
    emit() { throw new Error('Optional diagnostics listener unavailable'); },
    async invoke(_domain: string, request: any) {
      if (request.action === 'recall') { recalled++; if (options.recallError) throw options.recallError; return { items: [{ id: 'fact', body: 'Verified local fact' }] }; }
      if (request.action === 'handoff') return { items: [{ id: 'local-file', body: 'Local handoff', reference: { locator: { path: 'MEMORY.md' } } }] };
      if (request.action === 'snapshot') return {};
      throw new Error('Unexpected memory fixture action');
    },
  } as unknown as NexusServices;
  const ctx = {
    on(name: string, handler: (...args: any[]) => any) { hooks.set(name, handler); return () => {}; },
    get() { return { async readSession() { await options.readPending; if (options.readError) throw options.readError; return { events: [] }; } }; },
    logger: { warn() { throw new Error('Optional logger unavailable'); } },
  } as unknown as HostContext;
  const agent = { id: 'memory-fixture', session: { id: 'memory-fixture', header: { cwd: services.workspaceRoot } },
    async inject() { injected++; if (options.injectError) throw options.injectError; } };
  registerMemoryHooks(ctx, services, controller);
  const payload = { agent, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue local task' }] })],
    turn: 1, signal: new AbortController().signal };
  return { agent, payload, hooks, controller, get injected() { return injected; }, get recalled() { return recalled; } };
}

test('optional memory snapshot failure cannot veto startup or replay preparation during cooldown', async t => {
  const f = fixture({ readError: new Error('Local optional memory read unavailable') }); t.after(() => f.controller.dispose());
  await f.hooks.get('agent/created')!({ agent: f.agent });
  await f.hooks.get('agent/created')!({ agent: f.agent });
  const accepted = { kind: 'enter', messages: f.payload.messages };
  let calls = 0;
  assert.equal(await f.hooks.get('agent/pre-step')!(f.payload, async () => { calls++; return accepted; }), accepted);
  assert.equal(calls, 1); assert.equal(f.injected, 0); assert.equal(f.recalled, 0);
});

test('optional provider recall failure continues once, while a native downstream error is preserved', async t => {
  const f = fixture({ recallError: new LlmError('Local provider credential failure', 'AUTH', { status: 403 }) });
  t.after(() => f.controller.dispose());
  const accepted = { kind: 'enter', messages: f.payload.messages };
  let calls = 0;
  assert.equal(await f.hooks.get('agent/pre-step')!(f.payload, async () => { calls++; return accepted; }), accepted);
  const native = new NexusError('PARTIAL_EFFECT', 'Unknown native tool effect');
  await assert.rejects(f.hooks.get('agent/pre-step')!(f.payload, async () => { calls++; throw native; }), error => error === native);
  assert.equal(calls, 2); assert.equal(f.recalled, 1);
});

test('memory preparation keeps host permission, budget, cancellation and unknown effects authoritative', async t => {
  for (const code of ['PERMISSION_DENIED', 'BUDGET_EXCEEDED', 'PARTIAL_EFFECT', 'ABORTED']) {
    const error = new NexusError(code, 'Local authoritative stop'), f = fixture({ recallError: error });
    t.after(() => f.controller.dispose());
    let calls = 0;
    await assert.rejects(f.hooks.get('agent/pre-step')!(f.payload, async () => { calls++; }), actual => actual === error);
    assert.equal(calls, 0, code);
  }
});

test('native memory injection failure is neither swallowed nor replayed', async t => {
  const error = new NexusError('PARTIAL_EFFECT', 'Native injection effect unverified'), f = fixture({ injectError: error });
  t.after(() => f.controller.dispose());
  await assert.rejects(f.hooks.get('agent/created')!({ agent: f.agent }), actual => actual === error);
  await f.hooks.get('agent/created')!({ agent: f.agent });
  assert.equal(f.injected, 1);
});

test('timed out memory preparation cannot inject its late result into a continuing request', async t => {
  let release!: () => void;
  const f = fixture({ readPending: new Promise<void>(resolve => { release = resolve; }) });
  t.after(() => f.controller.dispose());
  await f.hooks.get('agent/created')!({ agent: f.agent });
  const accepted = { kind: 'enter', messages: f.payload.messages };
  assert.equal(await f.hooks.get('agent/pre-step')!(f.payload, async () => accepted), accepted);
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.injected, 0);
  assert.equal(accepted.messages.length, 1);
});
