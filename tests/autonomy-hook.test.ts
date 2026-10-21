import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { registerAutonomyHook } from '../src/host/autonomy-hook.js';
import { OperationController } from '../src/host/lifecycle.js';
import { hostAuthority } from '../src/host/host-adapter.js';
import { workspaceIdentity } from '../src/domain/workspace-runtime.js';
import type { DispatchContext, NexusRequest, NexusServices } from '../src/ports/contracts.js';
import type { HostContext } from '../src/host/types.js';

async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const callbacks = new Map<string, Set<(...args: any[]) => any>>();
  const agents = new Map<string, any>(), calls: Array<{ request: NexusRequest; context: DispatchContext }> = [];
  const controller = new OperationController();
  let deferOnce = false;
  const ctx = {
    get(name: string) { return name === 'agents' ? agents : undefined; },
    on(name: string, callback: (...args: any[]) => any) {
      if (!callbacks.has(name)) callbacks.set(name, new Set());
      callbacks.get(name)!.add(callback);
      return () => callbacks.get(name)?.delete(callback);
    }, logger: { warn() {} },
  } as unknown as HostContext;
  const services = {
    workspaceRoot: 'D:/fixture/a',
    async invoke(domain: string, request: NexusRequest, context: DispatchContext) {
      assert.equal(domain, 'autonomy');
      assert.equal(context.actorId, 'nexus-autonomy-hook');
      assert.equal(hostAuthority.getStore(), context);
      assert.deepEqual([...context.permissions!], [`autonomy.${request.action}`]);
      calls.push({ request, context });
      if (deferOnce && request.action === 'on-event' && request.params?.kind === 'observe') {
        deferOnce = false; return { deferred: true, reason: 'cooldown', retryAfterMs: 60_000, revision: 2 };
      }
      return request.action === 'list' ? { items: [] } : { status: 'proposed', revision: 1 };
    },
  } as unknown as NexusServices;
  const remove = registerAutonomyHook(ctx, services, controller);
  t.after(async () => { remove(); await controller.dispose(); });
  const session = (id: string, origin = 'human', cwd = services.workspaceRoot) => {
    const nativeSession = { id, header: { origin, cwd }, seq: 12, firstLiveSeq: 10 };
    const agent = { id, session: nativeSession, status: 'idle', cancel() { assert.fail('native user turn must never be cancelled'); } };
    agents.set(id, agent); return agent;
  };
  const emit = (name: string, ...args: any[]) => { for (const callback of callbacks.get(name) ?? []) callback(...args); };
  return { calls, session, emit, remove, defer: () => { deferOnce = true; } };
}

test('hook reads restart state once, excludes child/plugin/history, and admits new human input immediately', async t => {
  const f = fixture(t); await flush();
  assert.deepEqual(f.calls.map(call => call.request.action), ['list']);
  const main = f.session('main'), child = f.session('child', 'subagent');
  f.emit('agent/inbox/inserted', { agent: child, message: { id: 'child-input', source: { kind: 'user' } } });
  f.emit('agent/inbox/inserted', { agent: main, message: { id: 'plugin-input', source: { kind: 'nexus' } } });
  f.emit('session/event', main.session, { type: 'user/message', seq: 9, data: { id: 'old-human', source: { kind: 'user' } } });
  t.mock.timers.tick(8000); await flush();
  assert.equal(f.calls.length, 1);
  f.emit('agent/inbox/inserted', { agent: main, message: { id: 'human-live', source: { kind: 'user' } } });
  await flush();
  const admission = f.calls.at(-1)!;
  assert.equal(admission.request.action, 'on-event'); assert.equal(admission.request.params?.kind, 'user');
  assert.equal(admission.request.params?.messageId, 'human-live'); assert.equal(admission.request.params?.seq, 12);
  assert.equal(f.calls.some(call => call.request.params?.kind === 'observe'), false);
  f.emit('session/event', main.session, { type: 'user/message', seq: 12,
    data: { message: { id: 'human-live', source: { kind: 'user' } } } });
  await flush();
  assert.equal(f.calls.filter(call => call.request.params?.kind === 'user').length, 1);
  t.mock.timers.tick(8000); await flush();
  assert.equal(f.calls.filter(call => call.request.params?.kind === 'observe').length, 1);
});

test('new inbox admission aborts old observers without cancelling a native turn', async t => {
  const f = fixture(t), main = f.session('main'); await flush();
  f.emit('agent/inbox/inserted', { agent: main, message: { id: 'first', source: { kind: 'user' } } });
  await flush();
  const first = f.calls.find(call => call.request.params?.messageId === 'first')!;
  assert.equal(first.context.signal?.aborted, false);
  main.session.seq++;
  f.emit('agent/inbox/inserted', { agent: main, message: { id: 'second', source: { kind: 'user' } } });
  assert.equal(first.context.signal?.aborted, true);
  await flush();
  assert.equal(f.calls.filter(call => call.request.params?.kind === 'user').length, 2);
});

test('approving an already idle session schedules a tick without requiring another native event', async t => {
  const f = fixture(t); f.session('main'); await flush();
  f.emit('nexus/event', { event: 'autonomy/updated', data: { sessionId: 'main', status: 'approved', revision: 3 } });
  await flush(); assert.equal(f.calls.filter(call => call.request.action === 'tick').length, 0);
  t.mock.timers.tick(100); await flush();
  assert.equal(f.calls.filter(call => call.request.action === 'tick').length, 1);
});

test('cooldown deferral schedules a bounded observation retry', async t => {
  const f = fixture(t), main = f.session('main'); await flush(); f.defer();
  f.emit('agent/inbox/inserted', { agent: main, message: { id: 'human', source: { kind: 'user' } } });
  await flush(); t.mock.timers.tick(8000); await flush();
  assert.equal(f.calls.filter(call => call.request.params?.kind === 'observe').length, 1);
  t.mock.timers.tick(60_100); await flush();
  assert.equal(f.calls.filter(call => call.request.params?.kind === 'observe').length, 2);
});

test('scope updates abort only affected workspace observers and disposal removes scheduled work', async t => {
  const f = fixture(t), main = f.session('main'), other = f.session('other', 'human', 'D:/fixture/b'); await flush();
  for (const agent of [main, other]) {
    f.emit('agent/inbox/inserted', { agent, message: { id: `${agent.id}-human`, source: { kind: 'user' } } });
  }
  await flush();
  const mainCall = f.calls.find(call => call.context.sessionId === 'main')!;
  const otherCall = f.calls.find(call => call.context.sessionId === 'other')!;
  f.emit('nexus/event', { event: 'scope/updated', data: { feature: 'autonomy', level: 'workspace', workspace: workspaceIdentity('D:/fixture/a') } });
  assert.equal(mainCall.context.signal?.aborted, true); assert.equal(otherCall.context.signal?.aborted, false);
  t.mock.timers.tick(100); await flush();
  assert.equal(f.calls.filter(call => call.request.action === 'tick' && call.context.sessionId === 'main').length, 1);
  f.emit('agent/disposed', { agent: other });
  assert.equal(otherCall.context.signal?.aborted, true);
  const count = f.calls.length; f.remove();
  t.mock.timers.tick(100_000); await flush();
  assert.equal(f.calls.length, count);
});
