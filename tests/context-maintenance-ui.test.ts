import assert from 'node:assert/strict';
import test from 'node:test';
import { registerContextMaintenance, compactionOutcome } from '../src/client/ContextMaintenance.js';
import { registerRequestRetryButton } from '../src/client/RequestRetryButton.js';
import { registerDelayedMessageButton } from '../src/client/DelayedMessageButton.js';
import type { ClientContext, NexusApi } from '../src/client/types.js';

test('the subagent-only slash contribution and button share exact-session compression without submitting a prompt', async () => {
  const calls: any[] = [], commands: any[] = [], seats: any[] = [], cleanups: string[] = [];
  let finish!: (value: any) => void;
  const api = { call: async (domain: string, action: string, params: any, options: any) => {
    calls.push({ domain, action, params, options });
    if (action === 'maintenance/compact') return new Promise(resolve => { finish = resolve; });
    return { occupancyPercent: 97, windowTokens: 256000, occupiedTokens: 248320, thresholdPercent: 80 };
  } } as unknown as NexusApi;
  const bindings = new Set(['parent', 'child']);
  const sessions = { binding: (id: string) => bindings.has(id) ? { sessionId: id } : undefined,
    subagentAddress: (id: string) => id === 'child' ? { parentSessionId: 'parent', childId: 'child' } : undefined };
  const ctx = { sessions,
    slots: { inject: (_name: string, mount: () => any) => mount(),
      register: (definition: any, component: any) => { seats.push({ definition, component }); return () => cleanups.push('seat'); } },
    inject(_deps: string[], mount: (ctx: any) => any) { return mount({ commandUi: {
      register(command: any) { commands.push(command); return () => cleanups.push('command'); },
    } }); },
  } as unknown as ClientContext;
  const runtime = registerContextMaintenance(ctx, api);
  assert.equal(seats[0].definition.name, 'conversation.input.left');
  const command = commands[0];
  assert.equal(command.name, 'compact');
  assert.equal(command.available({ sessionId: 'parent' }), false, 'do not collide with the native parent command');
  assert.equal(command.available({ sessionId: 'child' }), true);
  assert.equal(command.available({ sessionId: 'unretained' }), false);
  command.ui.run({ sessionId: 'child' });
  await runtime.compact('child'); // a duplicate while running is ignored
  assert.equal(calls.filter(call => call.action === 'maintenance/compact').length, 1);
  assert.equal(runtime.state('parent').open, false);
  assert.equal(runtime.state('child').busy, true);
  finish({ committed: true, beforeTokens: 248320, afterTokens: 42000 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(runtime.state('child').busy, false);
  assert.equal(runtime.state('child').status?.thresholdPercent, 80);
  assert.ok(calls.every(call => call.domain === 'context' && call.options.scope.sessionId === 'child'));
  assert.match(compactionOutcome(runtime.state('child').result!), /已压缩/);
  bindings.delete('child');
  await runtime.compact('child');
  assert.equal(calls.filter(call => call.action === 'maintenance/compact').length, 1);
  runtime.dispose(); assert.deepEqual(cleanups, ['command', 'seat']);
});

test('unknown manual outcomes retain the original intent instead of replaying a different compaction', async () => {
  const ids: string[] = [];
  const api = { call: async (_domain: string, action: string, _params: any, options: any) => {
    if (action === 'maintenance/status') return {};
    ids.push(options.requestId);
    if (ids.length === 1) throw new Error('reply lost after the formal replacement');
    return { committed: true };
  } } as unknown as NexusApi;
  const ctx = { sessions: { binding: () => ({ sessionId: 'child' }) },
    slots: { inject: (_name: string, mount: () => any) => mount(), register: () => () => {} },
  } as unknown as ClientContext;
  const runtime = registerContextMaintenance(ctx, api);
  await runtime.compact('child'); await runtime.compact('child');
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
  assert.equal(runtime.state('child').requestId, undefined);
  assert.doesNotMatch(compactionOutcome({ committed: false, officialEffect: 'unknown' }), /已压缩/);
  runtime.dispose();
});

test('recovery keeps the exact child, suppresses duplicate clicks and retains a separate request id after a lost reply', async () => {
  const calls: any[] = [];
  let reject!: (reason: Error) => void;
  const api = { call: async (_domain: string, action: string, _params: any, options: any) => {
    calls.push({ action, options });
    if (action === 'maintenance/status') return { recovery: { state: 'resume-required', available: true } };
    if (action === 'maintenance/compact') return { officialEffect: 'unknown' };
    if (calls.filter(call => call.action === 'maintenance/resume').length === 1) {
      return new Promise((_resolve, rejectReply) => { reject = rejectReply; });
    }
    return { queued: true, idempotent: true };
  } } as unknown as NexusApi;
  const ctx = { sessions: { binding: (id: string) => id === 'child' ? { sessionId: id } : undefined },
    slots: { inject: (_name: string, mount: () => any) => mount(), register: () => () => {} },
  } as unknown as ClientContext;
  const runtime = registerContextMaintenance(ctx, api);
  await runtime.compact('child');
  const compactId = runtime.state('child').requestId;
  const pending = runtime.resume('child');
  await runtime.resume('child');
  assert.equal(calls.filter(call => call.action === 'maintenance/resume').length, 1);
  reject(new Error('reply lost'));
  await pending;
  const resumeId = runtime.state('child').resumeRequestId;
  assert.ok(resumeId); assert.notEqual(resumeId, compactId);
  await runtime.resume('child');
  const resumes = calls.filter(call => call.action === 'maintenance/resume');
  assert.deepEqual(resumes.map(call => call.options.requestId), [resumeId, resumeId]);
  assert.ok(resumes.every(call => call.options.scope.sessionId === 'child' && call.options.mutating));
  assert.equal(runtime.state('child').requestId, compactId);
  assert.equal(runtime.state('child').resumeRequestId, undefined);
  assert.match(compactionOutcome(runtime.state('child').result!), /已收到恢复操作/);
  await runtime.resume('unbound');
  runtime.dispose(); await runtime.resume('child');
  assert.equal(calls.filter(call => call.action === 'maintenance/resume').length, 2);
});

test('retry/freeze trigger is registered in the right input seat and keeps the exact session id', () => {
  const registrations: any[] = [];
  let disposed = false;
  const api = { dispose() { disposed = true; } } as unknown as NexusApi;
  const ctx = {
    slots: {
      inject(_name: string, mount: () => any) { return mount(); },
      register(definition: any, component: any) {
        registrations.push({ definition, component });
        return () => { disposed = true; };
      },
    },
  } as unknown as ClientContext;
  const cleanup = registerRequestRetryButton(ctx, api);
  assert.equal(registrations[0].definition.name, 'conversation.input.right');
  assert.equal(registrations[0].definition.id, 'noemaloom.request-retry');
  assert.equal(registrations[0].definition.order, 90);
  const element = registrations[0].component({ sessionId: 'child-session' });
  assert.equal(element.props.sessionId, 'child-session');
  assert.equal(element.props.api, api);
  cleanup();
  assert.equal(disposed, true);
});

test('delayed message trigger shares the right input seat used by main and subagent composers', () => {
  const registrations: any[] = [];
  const api = {} as NexusApi;
  const ctx = {
    slots: {
      inject(_name: string, mount: () => any) { return mount(); },
      register(definition: any, component: any) {
        registrations.push({ definition, component });
        return () => {};
      },
    },
  } as unknown as ClientContext;
  const cleanup = registerDelayedMessageButton(ctx, api);
  assert.equal(registrations[0].definition.name, 'conversation.input.right');
  assert.equal(registrations[0].definition.id, 'noemaloom.delayed-message');
  assert.equal(registrations[0].definition.order, 95);
  const element = registrations[0].component({ sessionId: 'child-session' });
  assert.equal(element.props.sessionId, 'child-session');
  assert.equal(element.props.api, api);
  cleanup();
});
