import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry, type AgentHandle } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { LlmAdapter, LlmRuntime, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { registerCompanionHook } from '../src/host/companion-hook.js';
import { OperationController } from '../src/host/lifecycle.js';
import { THOROUGH_PROMPT } from '../src/domain/insights/prompts.js';
import type { HostContext } from '../src/host/types.js';
import { companionFixture, deferred } from './companion-fixture.js';
import { createDispatcher } from '../src/domain/operations/index.js';

const route = { provider: 'native-companion-fixture', model: 'local-model', maxTokens: 32 };
class Adapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];
  async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls.push(request);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Native task completed.' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Native task completed.' } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('native gate fixture timed out')), 5000); })]); }
  finally { clearTimeout(timer!); }
}
async function nativeFixture(t: TestContext) {
  const root = new Context(), adapter = new Adapter(), f = companionFixture({ reflection: false });
  f.phase('ready-to-propose');
  const dataDir = await mkdtemp(join(tmpdir(), 'nexus-native-companion-'));
  const opened = deferred(), claimed: string[] = [], discarded: string[] = [];
  const dispatched: Array<{ action: string; requestId?: string; gateState?: string }> = [];
  const dispatcher = createDispatcher({ ...f.services, dataDir });
  dispatcher.register({ ...f.module, async dispatch(request, authority) {
    const observed: typeof dispatched[number] = { action: request.action, requestId: request.requestId };
    dispatched.push(observed);
    if (request.action === 'wait-gate') {
      const current: any = await f.module.dispatch({ action: 'get' }, authority);
      assert.equal(current.gate?.state, 'pending', 'the fixture opens only for an actual persisted pending gate');
      opened.resolve();
    }
    const result: any = await f.module.dispatch(request, authority);
    observed.gateState = result?.gate?.state;
    return result;
  } });
  const decision = { async resolve(choice: string) {
    const authority = { ...f.owner, workspaceRoot: handle?.agent.session.header.cwd ?? f.services.workspaceRoot,
      sessionId: 'native-companion-main', permissions: new Set(['companion.gate']) };
    const current = await dispatcher.services.invoke('companion', { action: 'get' }, authority) as any;
    return dispatcher.services.invoke('companion', { action: 'gate', requestId: `test-gate:${randomUUID()}`,
      params: { gateId: current.gate?.id, choice } }, authority);
  } };
  const fibers: any[] = [], controller = new OperationController();
  let ctx!: Context, handle: AgentHandle | undefined, remove: (() => void) | undefined;
  const services = root.plugin({ name: 'native-companion-services', apply(owner: Context) {
    new AgentRegistry(owner); new SessionStore(owner); new SessionProjectionRegistry(owner); new SystemPrompt(owner, { includeHarnessIdentity: false });
    const llm = new LlmRuntime(owner); llm.registerAdapter([route.provider], adapter);
  } });
  fibers.push(services); await services.await(); assert.equal(services.state, 2);
  const tools = root.plugin({ name: 'native-companion-tools', inject: ['systemPrompt'], apply(owner: Context) { new ToolRuntime(owner); } });
  fibers.push(tools); await tools.await(); assert.equal(tools.state, 2);
  const driver = root.plugin({ name: 'native-companion-driver', inject: ['agents', 'sessions', 'sessionProjections', 'llm', 'tools', 'systemPrompt'], apply(owner: Context) {
    ctx = owner; new AgentLoop(owner, AgentLoop.Config({ agents: [], maxParallelToolCalls: 1 }));
    remove = registerCompanionHook(owner as unknown as HostContext, dispatcher.services, controller);
    owner.on('agent/inbox/claimed', ({ message }) => { claimed.push(message.id); });
    owner.on('agent/inbox/discarded', ({ message }) => { discarded.push(message.id); });
  } });
  fibers.push(driver); await driver.await(); assert.equal(driver.state, 2);
  t.after(async () => {
    remove?.(); await handle?.dispose(); await controller.dispose(); await dispatcher.dispose();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir())); assert.ok(basename(dataDir).startsWith('nexus-native-companion-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  handle = await ctx.agents.create({ sessionId: SessionId('native-companion-main'), agentOptions: route });
  const agent = handle.agent;
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Research before proposing a plan.' }] }));
  await within(opened.promise);
  return { agent, adapter, claimed, discarded, decision, dispatched, store: f.store };
}
test('the real native driver includes the clicked four questions in its current request exactly once, claimed without cancellation', async t => {
  const h = await nativeFixture(t);
  assert.equal(h.adapter.calls.length, 0);
  const input = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: THOROUGH_PROMPT }] });
  h.agent.followup(input);
  const chosen: any = await h.decision.resolve('sent');
  assert.equal(chosen.gate?.state, 'sent', 'the owner decision must settle the actual pending gate');
  await within(h.agent.whenIdle());
  assert.equal(h.adapter.calls.length, 1, JSON.stringify({
    requests: h.adapter.calls.map(request => request.messages.map(message => ({
      id: message.id, role: message.role, questions: JSON.stringify(message).split(THOROUGH_PROMPT).length - 1,
    }))),
    claimed: h.claimed, nextTurn: h.agent.inbox.nextTurn.map(message => message.id),
    nextStep: h.agent.inbox.nextStep.map(message => message.id), dispatched: h.dispatched,
    boundaries: h.agent.session.snapshotEvents().filter(event =>
      ['turn/start', 'turn/end', 'agent/inbox/spliced', 'user/message'].includes(event.type)).map(event => {
      const data: any = event.data;
      return { seq: event.seq, type: event.type, turn: data.turn, reason: data.reason?.kind,
        id: (data.message ?? data).id, target: data.target, removedCount: data.removedCount,
        inserted: data.inserted?.map((message: any) => message.id), outcome: data.outcome };
    }),
  }));
  const text = JSON.stringify(h.adapter.calls[0].messages);
  assert.equal(text.split(THOROUGH_PROMPT).length - 1, 1);
  assert.equal(h.claimed.filter(id => id === input.id).length, 1);
  assert.equal(h.discarded.includes(input.id), false);
  const human = h.agent.session.snapshotEvents().filter(e => e.type === 'user/message');
  assert.equal(JSON.stringify(human).split(THOROUGH_PROMPT).length - 1, 1);
  assert.equal(h.agent.session.snapshotEvents().filter(e => e.type === 'turn/start').length, 1);
  assert.equal(h.agent.session.snapshotEvents().filter(e => e.type === 'turn/end').length, 1);
  assert.equal(h.agent.inbox.nextTurn.length + h.agent.inbox.nextStep.length, 0);
  assert.deepEqual(h.agent.session.snapshotEvents().filter(e => e.type === 'turn/end').map(e => (e.data as any).reason?.kind), ['completed']);
});
test('the real native driver continues after skip without synthesizing a four-question user message', async t => {
  const h = await nativeFixture(t); await h.decision.resolve('skipped'); await within(h.agent.whenIdle());
  assert.equal(h.adapter.calls.length, 1); assert.equal(h.discarded.length, 0);
  assert.equal(JSON.stringify(h.agent.session.snapshotEvents()).includes(THOROUGH_PROMPT), false);
});
test('automatic native pre-step and input invalidation cross the formal dispatcher with distinct persisted mutation identities', async t => {
  const h = await nativeFixture(t);
  const first = h.dispatched.find(r => r.action === 'observe');
  assert.ok(first?.requestId);
  assert.equal(h.adapter.calls.length, 0, 'a real persisted gate pauses the native provider admission');
  h.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue with the current evidence.' }] }));
  await within(h.agent.whenIdle());
  const automatic = h.dispatched.filter(r => ['observe', 'invalidate'].includes(r.action));
  assert.ok(automatic.filter(r => r.action === 'invalidate').length >= 2, 'initial and subsequent genuine inputs both enter invalidation');
  assert.equal(automatic.every(r => typeof r.requestId === 'string' && r.requestId.length > 0), true);
  assert.equal(new Set(automatic.map(r => r.requestId)).size, automatic.length);
  const receipts = await h.store.list<any>('__nexus_operation_receipts_v1');
  assert.ok(receipts.some(r => r.value.requestId === first.requestId && r.value.response?.ok === true));
  assert.ok(receipts.some(r => r.value.requestId.startsWith('companion-hook:invalidate:') && r.value.response?.ok === true));
});
test('a different genuine queued message releases the gate and retains native message order', async t => {
  const h = await nativeFixture(t);
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Actually inspect the tests first.' }] });
  h.agent.followup(message); await within(h.agent.whenIdle());
  assert.equal(h.discarded.length, 0); assert.equal(h.claimed.filter(id => id === message.id).length, 1);
  assert.equal(JSON.stringify(h.agent.session.snapshotEvents()).includes(THOROUGH_PROMPT), false);
});

test('an observation waits for every earlier input invalidation even when a cancelled invalidation settles late', async t => {
  const f = companionFixture(), entered = deferred(), release = deferred();
  const callbacks = new Map<string, (...args: any[]) => any>(), actions: string[] = [];
  const controller = new OperationController();
  let invalidations = 0;
  const services = { ...f.services, async invoke(_domain: string, request: any) {
    if (request.action === 'invalidate') {
      const index = ++invalidations;
      actions.push(`invalidate:${index}:start`);
      // Deliberately ignore cancellation until the write settles. An already
      // admitted durable write cannot be assumed to disappear on abort.
      if (index === 1) { entered.resolve(); await release.promise; }
      actions.push(`invalidate:${index}:end`);
      return {};
    }
    actions.push(request.action);
    return {};
  } };
  const ctx = { on(name: string, callback: (...args: any[]) => any) {
    callbacks.set(name, callback);
    return () => callbacks.delete(name);
  } } as unknown as HostContext;
  const stop = registerCompanionHook(ctx, services, controller);
  t.after(async () => { release.resolve(); stop(); await controller.dispose(); });
  const agent = { id: 'test-invalidation-barrier',
    session: { id: 'test-invalidation-barrier', header: {} },
    inbox: { nextTurn: [], nextStep: [] } };
  const inserted = callbacks.get('agent/inbox/inserted')!;
  inserted({ agent, message: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Initial task' }] }) });
  await entered.promise;
  inserted({ agent, message: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Updated task' }] }) });
  const accepted = { kind: 'enter', messages: [] };
  const preStep = callbacks.get('agent/pre-step')!({
    agent, messages: [], signal: new AbortController().signal, turn: 1,
  }, async () => accepted);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(actions, ['invalidate:1:start'], 'later invalidation and observe cannot overtake the first admitted write');
  release.resolve();
  assert.equal(await preStep, accepted);
  assert.deepEqual(actions, ['invalidate:1:start', 'invalidate:1:end', 'invalidate:2:start', 'invalidate:2:end', 'observe']);
});
