import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { createHostAdapter, hostAuthority } from '../src/host/host-adapter.js';
import { registerNativeCompactionBinding } from '../src/host/compaction-binding.js';
import { createContextModule } from '../src/domain/context/index.js';
import type { HostContext } from '../src/host/types.js';
import type { NexusServices } from '../src/ports/contracts.js';
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import { contextMaintenance } from '../src/host/context-maintenance.js';

test('manual UI compaction addresses the bound child, reads while running, and never cancels it or guesses a parent', async t => {
  const root = new Context(), signal = new AbortController().signal;
  const child = { id: `manual-child-${randomUUID()}`, status: 'running', ctx: root };
  const calls: any[] = [];
  let host: ReturnType<typeof createHostAdapter>;
  const fiber = root.plugin({ name: 'manual-maintenance-host', apply(ctx: Context) {
    ctx.provide('agents', { get: (id: string) => id === child.id ? child : undefined } as any);
    host = createHostAdapter(ctx as unknown as HostContext, {}, process.cwd(), signal);
    registerNativeCompactionBinding(ctx as unknown as HostContext, {
      async compactRanges() { throw new Error('UI must use an idempotent self-maintenance intent'); },
      async contextStatus(agent: any) { calls.push({ agent, action: 'status' }); return { thresholdPercent: 80 }; },
      async selfCompaction(agent: any, args: any) { calls.push({ agent, ...args }); return { committed: true }; },
    }).bind(child);
  } }); await fiber.await();
  t.after(async () => { await host.dispose(); await fiber.dispose(); });
  const run = (action: string, sessionId = child.id, actorId = 'connection-owner') =>
    hostAuthority.run({ sessionId, actorId, signal }, () => host.sessions(action, { sessionId, requestId: 'stable-intent' }));
  assert.deepEqual(await run('context.maintenance/status'), { thresholdPercent: 80 });
  await assert.rejects(run('context.maintenance/compact'), { code: 'CTX_NATIVE_BUSY' });
  assert.equal(child.status, 'running');
  child.status = 'idle';
  assert.deepEqual(await run('context.maintenance/compact'), { committed: true });
  assert.equal(calls[1].agent, child); assert.equal(calls[1].requestId, 'stable-intent');
  await assert.rejects(run('context.maintenance/compact', child.id, 'native-tool'), { code: 'PERMISSION_DENIED' });
  await assert.rejects(run('context.maintenance/compact', 'unrelated'), { code: 'SESSION_NOT_LIVE' });
  assert.equal(calls.length, 2);
});

test('the production context domain sends a fresh child directly to the native seam before a kernel record exists', async () => {
  const calls: any[] = [];
  const module = createContextModule({
    workspaceRoot: process.cwd(),
    store: { get() { throw new Error('Fresh manual maintenance must not require a prior context record'); } },
    host: { async sessions(action: string, params: any) { calls.push({ action, params }); return { committed: true }; } },
  } as unknown as NexusServices);
  const ctx = { sessionId: 'fresh-child', scopeLevel: 'session' as const, actorId: 'connection-owner' };
  assert.deepEqual(await module.dispatch({ action: 'maintenance/compact', requestId: 'fresh-intent' }, ctx), { committed: true });
  assert.deepEqual(calls, [{ action: 'context.maintenance/compact', params: { sessionId: 'fresh-child', requestId: 'fresh-intent' } }]);
  await assert.rejects(module.dispatch({ action: 'maintenance/compact', requestId: 'forged' }, { ...ctx, actorId: 'native-tool' }),
    { code: 'PERMISSION_DENIED' });
});

test('a cold native child is inspected without activation and explicitly compacted with a prompt-free disposable native handle', async () => {
  const id = 'cold-maintenance-child', events: any[] = [], signal = new AbortController().signal;
  const original = Session.create(SessionId(id), [], { version: 4, id: SessionId(id), createdAt: Date.now(), isSeeded: false,
    cwd: process.cwd(), origin: 'subagent', parentSession: SessionId('parent') });
  const originalEvents = original.snapshotEvents();
  const calls: any[] = [];
  const maintenance = {
    async contextStatus(agent: any) { calls.push({ action: 'status', agent }); return { occupiedTokens: 250000, thresholdPercent: 80 }; },
    async selfCompaction(agent: any, args: any) { calls.push({ action: 'compact', agent, args }); return { committed: true }; },
  };
  const agents = {
    get: () => undefined,
    async resume(options: any) {
      calls.push({ action: 'resume', options });
      return { agent: { id, session: original, options: options.agentOptions, status: 'idle' },
        async dispose() { calls.push({ action: 'dispose' }); } };
    },
  };
  const ctx = { get(name: string) { return { agents, nexusCompactionMaintenance: maintenance,
    sessionQuery: { async readSession() { return { session: original.header, events }; } },
    sessionProjections: { stateOf() { return { pending: { provider: 'fixture', model: 'large' } }; } },
  }[name]; } } as unknown as HostContext;
  await contextMaintenance(ctx, id, 'status', undefined, signal, 'connection-owner');
  assert.deepEqual(calls.map(call => call.action), ['status'], 'status never resumes, submits or changes history');
  assert.deepEqual(calls[0].agent.options, { provider: 'fixture', model: 'large' });
  assert.deepEqual(await contextMaintenance(ctx, id, 'compact', 'cold-intent', signal, 'connection-owner'),
    { committed: true, maintenanceOnly: true });
  assert.deepEqual(calls.map(call => call.action), ['status', 'resume', 'compact', 'dispose']);
  assert.equal(calls[1].options.resumeSessionId, id);
  assert.equal(calls[2].args.requestId, 'cold-intent');
  assert.deepEqual(events, []); assert.deepEqual(original.snapshotEvents(), originalEvents);
  await assert.rejects(contextMaintenance(ctx, id, 'status', undefined, signal, 'native-tool'), { code: 'PERMISSION_DENIED' });
});

test('a native persistence ownership race refuses cold compaction without retrying, cancelling or submitting a prompt', async () => {
  let resumes = 0, compactions = 0;
  const id = 'cold-child-lock', original = Session.create(SessionId(id), [], {
    version: 4, id: SessionId(id), createdAt: Date.now(), isSeeded: false, origin: 'subagent', cwd: process.cwd(),
  });
  const ctx = { get(name: string) { return {
    agents: { get() {}, async resume() { resumes++; throw new Error('native writer already held'); } },
    sessionQuery: { async readSession() { return { session: original.header, events: [] }; } },
    nexusCompactionMaintenance: { async contextStatus() {}, async selfCompaction() { compactions++; } },
  }[name]; } } as unknown as HostContext;
  await assert.rejects(contextMaintenance(ctx, id, 'compact', 'race-intent', new AbortController().signal, 'connection-owner'),
    { code: 'CTX_NATIVE_BUSY' });
  assert.equal(resumes, 1); assert.equal(compactions, 0);
});

test('cold forked subagents preserve the exact native inherited cut and never guess a missing boundary', async () => {
  const id = SessionId('cold-fork-child'), inheritedEventCount = 1;
  const session = Session.create(id, [{ type: 'session/end-seed', seq: 0, time: 1, data: {} }] as any, {
    version: 4, id, createdAt: 1, isSeeded: true, origin: 'subagent', cwd: process.cwd(), parentSession: SessionId('fork-parent'),
  }, SessionLogOffset(inheritedEventCount));
  const events = session.snapshotEvents();
  let includeBoundary = true, reads = 0;
  const ctx = { get(name: string) { return {
    agents: { get() {} }, sessions: { messageProjections: [] },
    sessionQuery: { async readSession() { return { session: session.header, events, ...(includeBoundary ? { inheritedEventCount } : {}) }; } },
    nexusCompactionMaintenance: { async selfCompaction() {}, async contextStatus(agent: any) {
      reads++; return { inherited: agent.session.inheritedEventCount, isSeeded: agent.session.header.isSeeded };
    } },
  }[name]; } } as unknown as HostContext;
  assert.deepEqual(await contextMaintenance(ctx, id, 'status', undefined, new AbortController().signal, 'connection-owner'),
    { inherited: 1, isSeeded: true });
  includeBoundary = false;
  await assert.rejects(contextMaintenance(ctx, id, 'status', undefined, new AbortController().signal, 'connection-owner'),
    { code: 'HOST_CONTRACT_UNSUPPORTED' });
  assert.equal(reads, 1); assert.deepEqual(session.snapshotEvents(), events);
});
