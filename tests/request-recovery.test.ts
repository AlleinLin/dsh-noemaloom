import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent';
import { apply as applyNativeRetry } from '@deepseek-ai/dsh-llm-retry';
import { Session, SessionId, SessionStore, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import { createUserMessage, ProviderRequestId, type ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-schedule';
// rc.5 declares this source in schedule's private runtime module, which its
// public declaration entry does not import. Match that native message shape.
declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap { schedule: { kind: 'schedule' } }
}
import { recordRecoveryDiagnostic, registerRequestRecovery } from '../src/host/request-recovery.js';
import type { HostContext } from '../src/host/types.js';
import { stepProgressServices } from './step-progress-fixture.js';
import { createScopeModule } from '../src/domain/scope.js';
import { REQUEST_RETRY_FEATURE } from '../src/shared/request-retry.js';
import { registerNativeCompactionBinding } from '../src/host/compaction-binding.js';

const normal = (maxRetries = 3): ResolvedRetryPolicy => ({
  mode: 'normal', maxRetries, retryableCodes: ['TRANSPORT', 'SERVER', 'RATE_LIMIT', 'TIMEOUT', 'EMPTY_RESPONSE'],
  initialDelayMs: 0, maxDelayMs: 100, jitterRatio: 0,
});
const transport = { code: 'TRANSPORT', message: 'sensitive provider body', status: 502, requestId: ProviderRequestId('provider-request-42') };

async function fixture(t: TestContext, native = false, settings = false, schedule = false) {
  const root = new Context();
  let ctx!: Context;
  let sessions!: SessionStore;
  let agents!: AgentRegistry;
  let projections!: SessionProjectionRegistry;
  let disposeRecovery!: () => void;
  const events: SessionEvent[] = [];
  const { services: scopeServices } = stepProgressServices();
  const scheduleCalls: Array<{ sessionId: string; request: any }> = [];
  const scheduleDeletes: Array<{ sessionId: string; id: string }> = [];
  const scheduleService = schedule ? {
    async create(sessionId: string, request: any) {
      scheduleCalls.push({ sessionId, request });
      return { id: `schedule-${scheduleCalls.length}` };
    },
    async delete(request: { sessionId: string; id: string }) {
      scheduleDeletes.push(request);
      return { id: request.id, deleted: true };
    },
    async catalog() { return []; },
  } : undefined;
  // ctx.get() deliberately exposes only active providers. The official host
  // services must finish activating before a consumer queries their presence.
  const servicesFiber = root.plugin({
    name: 'request-recovery-services',
    apply(owner: Context) {
      sessions = new SessionStore(owner);
      agents = new AgentRegistry(owner);
      projections = new SessionProjectionRegistry(owner);
      if (settings) owner.provide('nexus', { services: scopeServices } as any);
      if (scheduleService) owner.provide('schedule', scheduleService);
    },
  });
  await servicesFiber.await();
  assert.equal(servicesFiber.state, 2);
  const fiber = root.plugin({
    name: 'request-recovery-fixture',
    inject: ['sessions', 'agents', 'sessionProjections', ...(settings ? ['nexus'] : []), ...(schedule ? ['schedule'] : [])],
    apply(owner: Context) {
      ctx = owner;
      assert.ok(ctx.get('sessionProjections'), 'the recovery consumer must see an active official registry');
      ctx.on('session/event', (_session, event) => { events.push(event); });
      if (native) applyNativeRetry(ctx, {}, { random: () => 0.5 });
      disposeRecovery = registerRequestRecovery(ctx as unknown as HostContext);
    },
  });
  await fiber.await();
  assert.equal(fiber.state, 2);
  const id = SessionId('request-recovery-session');
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false,
  });
  const detachSession = sessions.enter(session);
  sessions.announce(session);
  const agent = { id, session, ctx, status: 'running' } as Agent;
  const detachAgent = agents.enter(agent, undefined);
  await agents.announce(agent, 'startup');
  session.append('step/start', { turn: 1, step: 1 });
  t.after(async () => {
    disposeRecovery();
    detachAgent();
    detachSession();
    await fiber.dispose();
    await servicesFiber.dispose();
  });
  const diagnostics = () => events.filter((event: any) => event.type === 'plugin:nexus/request-recovery')
    .map((event: any) => event.data);
  const recover = (failure = transport, retryPolicy: ResolvedRetryPolicy | undefined = normal(), signal = new AbortController().signal) => {
    const payload = { agent, turn: 1, step: 1, provider: 'fixture-provider', failure, retryPolicy, signal };
    return ctx.waterfall(scopeTarget(agent, agent), 'agent/request-error', payload, async () => undefined);
  };
  const configure = (defaults: Record<string, unknown>, sessionId?: string, expectedRevision = 0) => createScopeModule(scopeServices).dispatch({
    action: 'configure', params: { feature: REQUEST_RETRY_FEATURE, config: { defaults } }, expectedRevision,
  }, { actorId: 'connection-owner', permissions: new Set(['scope.configure']), scopeLevel: sessionId ? 'session' : 'global',
    ...(sessionId ? { sessionId, workspaceRoot: scopeServices.workspaceRoot } : {}) });
  return {
    ctx, agent, session, events, diagnostics, projections, recover, configure, scopeServices, scheduleCalls, scheduleDeletes, scheduleService,
    dispose: () => disposeRecovery(),
    restart() { disposeRecovery(); disposeRecovery = registerRequestRecovery(ctx as unknown as HostContext); },
    removeAgent() { detachAgent(); },
    removeSession() { detachSession(); },
  };
}

test('Nexus owns exactly one retry without running another native or downstream retry', async t => {
  const h = await fixture(t, true, true);
  await h.configure({ mode: 'inherit' });
  let downstream = 0;
  h.ctx.on('agent/request-error', async (_payload, next) => { downstream++; return next(); });
  assert.deepEqual(await h.recover(), { kind: 'retry' });
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 1);
  assert.equal(h.events.filter(event => event.type === 'llm/retry-started').length, 1);
  assert.equal(downstream, 0, 'one recovery owner prevents nested waits');
  assert.equal(h.diagnostics().at(-1).outcome, 'retry-started');
  assert.equal(h.diagnostics().at(-1).source, 'nexus-fallback');
  assert.equal(h.diagnostics().at(-1).retry, 1);
});

test('custom scope policy owns one same-step retry even with the native retry plugin installed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await fixture(t, true, true);
  await h.configure({ mode: 'custom', maxRetries: 2, algorithm: 'linear', initialDelayMs: 1000, maxDelayMs: 10_000, jitterRatio: 0 });
  for (const expected of [1000, 2000]) {
    const pending = h.recover();
    for (let i = 0; i < 80; i++) await Promise.resolve();
    const scheduled = h.events.filter(event => event.type === 'llm/retry').at(-1)!;
    assert.equal((scheduled.data as any).delayMs, expected);
    assert.equal((scheduled.data as any).maxRetries, 2);
    t.mock.timers.tick(expected);
    assert.deepEqual(await pending, { kind: 'retry' });
  }
  assert.equal(await h.recover(), undefined);
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 2, 'no native and Nexus duplicate timers');
  assert.equal(h.diagnostics().at(-1).diagnosticCode, 'NX_RETRY_EXHAUSTED');
  h.session.append('step/start', { turn: 1, step: 2 });
  await h.configure({ mode: 'disabled' }, h.agent.id);
  assert.equal(await h.recover(), undefined);
  assert.equal(h.diagnostics().at(-1).stopReason, 'retry-disabled');
});

test('all failed requests use the selected budget, including old PI opt-out settings', async t => {
  const h = await fixture(t, true, true);
  const config = { mode: 'custom', maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0, retryOpaqueProviderErrors: false };
  const opaque = { code: 'PI_AI_ERROR', message: 'unknown provider SDK failure' } as any;
  await h.configure(config);
  assert.deepEqual(await h.recover(opaque), { kind: 'retry' });
  h.restart();
  assert.deepEqual(await h.recover(opaque), { kind: 'retry' });
  assert.equal(await h.recover(opaque), undefined);
  assert.equal(h.diagnostics().at(-1).canonicalCode, 'PI_AI_ERROR');
  assert.equal(h.diagnostics().at(-1).retry, 2);
  assert.equal(h.diagnostics().at(-1).stopReason, 'retry-exhausted');
  let step = 1;
  for (const failure of [
    { ...opaque, status: 403 }, { ...opaque, status: 400 }, { code: 'INTERNAL', message: 'local bug' },
    { code: 'PARTIAL_EFFECT', message: 'unknown effects' }, { code: 'CTX_NATIVE_BUSY', message: 'maintenance' },
    { code: 'UNKNOWN', message: 'unclassified' }, { code: 'INSUFFICIENT_QUOTA', message: 'quota' },
    { code: 'BUDGET_EXCEEDED', message: 'budget admission remains authoritative' },
  ]) {
    h.session.append('step/start', { turn: 2, step: ++step });
    assert.deepEqual(await h.recover(failure as any), { kind: 'retry' }, failure.code);
  }
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 10);
});

test('default PI retries survive all 64 capped waits, reload and the native error allowlist', async t => {
  const h = await fixture(t, true, true);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failure = { code: 'PI_AI_ERROR', message: 'provider stream failed' } as any;
  for (let previous = 0; previous < 64; previous++) {
    if (previous === 32) h.restart();
    const pending = h.recover(failure, normal(1));
    for (let i = 0; i < 80; i++) await Promise.resolve();
    const records = h.events.filter(event => event.type === 'llm/retry');
    assert.equal(records.length, previous + 1);
    const record = records.at(-1)!.data;
    assert.equal(record.mode, 'normal');
    if (record.mode !== 'normal') throw new Error('Expected bounded recovery');
    assert.equal(record.retry, previous + 1);
    assert.equal(record.maxRetries, 64);
    const base = Math.min(500 * 2 ** previous, 30_000);
    assert.ok(record.delayMs >= base * 0.9 - 1 && record.delayMs <= Math.min(base * 1.1 + 1, 30_000));
    t.mock.timers.tick(record.delayMs);
    assert.deepEqual(await pending, { kind: 'retry' });
  }
  assert.equal(await h.recover(failure), undefined);
  assert.equal(h.diagnostics().at(-1).stopReason, 'retry-exhausted');
  assert.equal(h.diagnostics().at(-1).maxRetries, 64);
  assert.equal(h.events.filter(event => event.type === 'llm/retry-started').length, 64);
});

test('legacy inherit mode uses provider timing without its error allowlist or one-retry cap', async t => {
  const h = await fixture(t, true, true);
  await h.configure({ mode: 'inherit', maxRetries: 2, retryOpaqueProviderErrors: false });
  const failure = { code: 'PI_AI_ERROR', message: 'opaque' } as any;
  for (let i = 0; i < 2; i++) assert.deepEqual(await h.recover(failure, normal(1)), { kind: 'retry' });
  assert.equal(await h.recover(failure, normal(1)), undefined);
  assert.deepEqual(h.events.filter(event => event.type === 'llm/retry').map(event => event.data.delayMs), [0, 0]);
  assert.equal(h.diagnostics().at(-1).retry, 2);
});

test('custom waits remain cancellable even when Retry-After exceeds the algorithm cap', async t => {
  const h = await fixture(t, true, true);
  await h.configure({ mode: 'custom', maxRetries: 8, algorithm: 'fixed', initialDelayMs: 60_000, maxDelayMs: 90_000, jitterRatio: 0 });
  const controller = new AbortController();
  const pending = h.recover(transport, normal(1), controller.signal);
  for (let i = 0; i < 80; i++) await Promise.resolve();
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 1);
  controller.abort({ kind: 'user' });
  assert.equal(await pending, undefined);
  assert.equal(h.diagnostics().at(-1).stopReason, 'user-cancelled');
  h.session.append('step/start', { turn: 2, step: 1 });
  const nextController = new AbortController();
  const nextWait = h.recover({ ...transport, providerRetryAfterMs: 90_001 } as any, normal(), nextController.signal);
  for (let i = 0; i < 80; i++) await Promise.resolve();
  assert.equal(h.events.filter(event => event.type === 'llm/retry').at(-1)!.data.delayMs, 90_001);
  nextController.abort({ kind: 'parent' });
  assert.equal(await nextWait, undefined);
  assert.equal(h.diagnostics().at(-1).stopReason, 'parent-cancelled');
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 2);
});

test('subscription and quota failures freeze the session for the configured hours before retry', async t => {
  const h = await fixture(t, true, true);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  await h.configure({ mode: 'custom', maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0, freezeRetryHours: 5 });
  const pending = h.recover({ code: 'INSUFFICIENT_QUOTA', message: 'subscription quota exhausted' } as any, normal(1));
  for (let i = 0; i < 80; i++) await Promise.resolve();
  const scheduled = h.events.filter(event => event.type === 'llm/retry').at(-1)!.data as any;
  assert.equal(scheduled.delayMs, 18_000_000);
  assert.equal(scheduled.freezeRetryHours, 5);
  assert.equal(h.diagnostics().at(-1).freezeRetryHours, 5);
  t.mock.timers.tick(18_000_000);
  assert.deepEqual(await pending, { kind: 'retry' });
});

test('freeze waits register a durable Host schedule wake without exposing its marker to the model', async t => {
  const h = await fixture(t, true, true, true);
  t.mock.timers.enable({ apis: ['Date'] });
  const removed: string[] = [];
  (h.agent as any).inbox = { remove(id: string) { removed.push(id); return true; } };
  await h.configure({ mode: 'custom', maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0, freezeRetryHours: 5 });
  const pending = h.recover({ code: 'INSUFFICIENT_QUOTA', message: 'subscription quota exhausted' } as any, normal(1));
  for (let i = 0; i < 80; i++) await Promise.resolve();
  assert.equal(h.scheduleCalls.length, 1);
  assert.equal(h.scheduleCalls[0].request.title, 'Nexus 自动重试唤醒');
  assert.equal(h.scheduleCalls[0].request.after_seconds, 18_000);
  assert.match(h.scheduleCalls[0].request.prompt, /^NEXUS_INTERNAL_RETRY_WAKE:/);
  const marker = h.scheduleCalls[0].request.prompt;
  t.mock.timers.tick(18_000_000);
  const message = createUserMessage({ source: { kind: 'schedule' }, content: [{ type: 'text', text: marker }] });
  h.ctx.emit?.('agent/inbox/inserted', {
    agent: h.agent,
    message,
  });
  assert.deepEqual(await pending, { kind: 'retry' });
  assert.equal(h.scheduleDeletes.length, 1);
  assert.deepEqual(removed, [message.id]);
  assert.equal(h.diagnostics().findLast(item => item.outcome === 'scheduled')?.wakeMode, 'host-schedule');
});

test('provider Retry-After can extend a freeze and cancellation removes the Host wake without a retry', async t => {
  const h = await fixture(t, true, true, true);
  await h.configure({ freezeRetryHours: 5 });
  const controller = new AbortController();
  const pending = h.recover({ code: 'RATE_LIMIT', providerRetryAfterMs: 21_600_000 } as any, normal(), controller.signal);
  for (let i = 0; i < 120; i++) await Promise.resolve();
  assert.equal(h.scheduleCalls[0].request.after_seconds, 21_600);
  controller.abort({ kind: 'user' });
  assert.equal(await pending, undefined);
  assert.equal(h.scheduleDeletes.length, 1);
  assert.equal(h.events.filter(event => event.type === 'llm/retry-started').length, 0);
  assert.equal(h.diagnostics().at(-1).stopReason, 'user-cancelled');
});

test('a Host refusal for a delegated child uses the process timer and keeps the freeze deadline', async t => {
  const h = await fixture(t, true, true, true);
  h.scheduleService!.create = async () => { throw Object.assign(new Error('delegated Session'), { code: 'subagent_session' }); };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  await h.configure({ freezeRetryHours: 5 });
  const pending = h.recover({ code: 'RATE_LIMIT' } as any);
  for (let i = 0; i < 120; i++) await Promise.resolve();
  assert.equal(h.diagnostics().at(-1).wakeMode, 'process-timer');
  t.mock.timers.tick(17_999_999);
  assert.equal(h.events.filter(event => event.type === 'llm/retry-started').length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { kind: 'retry' });
});

test('a stalled Schedule create cannot hold recovery and a late committed reminder is deleted', async t => {
  const h = await fixture(t, true, true, true);
  let finishCreate!: (value: { id: string }) => void;
  h.scheduleService!.create = () => new Promise(resolve => { finishCreate = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  await h.configure({ freezeRetryHours: 5 });
  const pending = h.recover({ code: 'RATE_LIMIT' } as any);
  for (let i = 0; i < 120; i++) await Promise.resolve();
  t.mock.timers.tick(2000);
  for (let i = 0; i < 120; i++) await Promise.resolve();
  assert.equal(h.diagnostics().at(-1).wakeMode, 'process-timer');
  finishCreate({ id: 'late-schedule' });
  for (let i = 0; i < 120; i++) await Promise.resolve();
  assert.deepEqual(h.scheduleDeletes, [{ sessionId: h.agent.id, id: 'late-schedule' }]);
  t.mock.timers.tick(17_998_000);
  assert.deepEqual(await pending, { kind: 'retry' });
});

test('ordinary transport recovery does not create a subscription wake task', async t => {
  const h = await fixture(t, true, true, true);
  await h.configure({ freezeRetryHours: 5, initialDelayMs: 0, maxDelayMs: 0 });
  assert.deepEqual(await h.recover(), { kind: 'retry' });
  assert.equal(h.scheduleCalls.length, 0);
});

test('the scope budget controls exhaustion even when the native plugin has a different limit', async t => {
  const h = await fixture(t, true, true);
  await h.configure({ mode: 'inherit', maxRetries: 1 });
  assert.deepEqual(await h.recover(transport, normal(1)), { kind: 'retry' });
  assert.equal(await h.recover(transport, normal(1)), undefined);
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 1);
  assert.equal(h.diagnostics().at(-1).diagnosticCode, 'NX_RETRY_EXHAUSTED');
  assert.equal(h.diagnostics().at(-1).retry, 1);
  h.session.append('step/start', { turn: 1, step: 1 });
  const controller = new AbortController();
  const pending = h.recover({ ...transport, providerRetryAfterMs: 2_147_483_648 } as any, normal(), controller.signal);
  for (let i = 0; i < 80; i++) await Promise.resolve();
  assert.equal(h.events.filter(event => event.type === 'llm/retry').at(-1)!.data.delayMs, 2_147_483_648);
  controller.abort({ kind: 'user' });
  assert.equal(await pending, undefined);
  assert.equal(h.diagnostics().at(-1).stopReason, 'user-cancelled');
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 2);
});

test('fallback count survives adapter reload through the official projection', async t => {
  const h = await fixture(t, false, true);
  await h.configure({ mode: 'inherit', maxRetries: 2 });
  assert.deepEqual(await h.recover(transport, normal(2)), { kind: 'retry' });
  h.restart();
  assert.deepEqual(await h.recover(transport, normal(2)), { kind: 'retry' });
  assert.equal(await h.recover(transport, normal(2)), undefined);
  const retries = h.events.filter(event => event.type === 'llm/retry');
  assert.deepEqual(retries.map(event => event.data.retry), [1, 2]);
  assert.equal(retries[0].data.retryId, retries[1].data.retryId);
  assert.equal(h.diagnostics().at(-1).diagnosticCode, 'NX_RETRY_EXHAUSTED');
  assert.equal(JSON.stringify(retries).includes('sensitive provider body'), false);
  assert.equal(h.diagnostics().at(-1).requestId, 'provider-request-42');
  assert.equal(h.diagnostics().at(-1).status, 502);
  h.session.append('step/start', { turn: 2, step: 1 });
  assert.deepEqual(await h.recover(transport, normal(2)), { kind: 'retry' });
});

test('unattributed Abort and exact UNKNOWN cancellation use the same configured budget with their diagnosis intact', async t => {
  const h = await fixture(t, true, true);
  await h.configure({ mode: 'inherit', maxRetries: 4 });
  const always: ResolvedRetryPolicy = { mode: 'always', initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
  for (const failure of [
    { code: 'ABORTED', message: 'The operation was aborted.' },
    { code: 'UNKNOWN', message: '操作已取消。' },
  ]) {
    h.session.append('step/start', { turn: 1, step: 1 });
    const before = h.events.filter(event => event.type === 'llm/retry').length;
    for (let attempt = 0; attempt < 4; attempt++) assert.deepEqual(await h.recover(failure as any, always), { kind: 'retry' });
    assert.equal(await h.recover(failure as any, always), undefined);
    assert.equal(h.events.filter(event => event.type === 'llm/retry').length - before, 4);
    const last = h.diagnostics().at(-1);
    assert.equal(last.diagnosticCode, 'NX_ABORT_UNATTRIBUTED');
    assert.equal(last.canonicalCode, 'ABORTED');
    assert.equal(last.stopReason, 'retry-exhausted');
    assert.equal(last.maxRetries, 4);
    assert.equal(h.diagnostics().some(item => item.diagnosticCode === 'NX_NETWORK_TRANSPORT'), false);
  }
});

test('provider lifecycle error codes cannot impersonate an actual disposed agent or deleted session', async t => {
  const h = await fixture(t, true, true);
  await h.configure({ mode: 'inherit' });
  const always: ResolvedRetryPolicy = { mode: 'always', initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
  let downstream = 0;
  h.ctx.on('agent/request-error', async () => { downstream++; return { kind: 'retry' }; });
  for (const code of ['SESSION_DELETED', 'SESSION_NOT_FOUND', 'AGENT_DISPOSED', 'PLUGIN_DISPOSED', 'ABORTED', 'CANCELLED']) {
    assert.deepEqual(await h.recover({ code, message: 'hidden' } as any, always), { kind: 'retry' });
    assert.equal(h.diagnostics().at(-1).outcome, 'retry-started');
  }
  assert.equal(downstream, 0);
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 6);
});

test('explicit cancellation records its actual origin and starts no retry', async t => {
  const h = await fixture(t, true);
  for (const [kind, stopReason] of [
    ['user', 'user-cancelled'], ['parent', 'parent-cancelled'],
    ['hook', 'hook-cancelled'], ['disposed', 'agent-disposed'],
  ]) {
    const controller = new AbortController();
    controller.abort({ kind, reason: 'never persist this raw reason' });
    assert.equal(await h.recover(transport, normal(), controller.signal), undefined);
    assert.equal(h.diagnostics().at(-1).stopReason, stopReason);
    assert.equal(h.diagnostics().at(-1).diagnosticCode, 'NX_CANCELLED');
  }
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 0);
});

test('fallback waits cancel immediately on user stop, parent stop, disposal and unload', async t => {
  for (const action of ['user', 'parent', 'agent', 'session', 'plugin']) {
    await t.test(action, async sub => {
      const h = await fixture(sub, false, true);
      await h.configure({ mode: 'inherit' });
      const controller = new AbortController();
      const policy = { ...normal(), initialDelayMs: 60_000, maxDelayMs: 60_000 };
      const pending = h.recover(transport, policy, controller.signal);
      // No timer advances or real wait: settle the diagnostic microtasks before
      // cancellation, so cancellation also covers the cancellable-delay seam.
      for (let i = 0; i < 80; i++) await Promise.resolve();
      assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 1);
      if (action === 'plugin') h.dispose();
      else if (action === 'agent') h.removeAgent();
      else if (action === 'session') h.removeSession();
      else controller.abort({ kind: action });
      assert.equal(await pending, undefined);
      assert.equal(h.events.filter(event => event.type === 'llm/retry-started').length, 0);
      if (action === 'user' || action === 'parent' || action === 'plugin') {
        assert.equal(h.diagnostics().at(-1).stopReason,
          action === 'plugin' ? 'plugin-disposed' : `${action}-cancelled`);
      }
    });
  }
});

test('unloading Nexus cancels its sole recovery wait without cancelling the original agent signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await fixture(t, true, true);
  await h.configure({ mode: 'inherit' });
  const controller = new AbortController();
  const pending = h.recover(transport, { ...normal(), initialDelayMs: 60_000, maxDelayMs: 60_000 }, controller.signal);
  for (let i = 0; i < 80; i++) await Promise.resolve();
  h.dispose();
  assert.equal(await pending, undefined);
  t.mock.timers.tick(60_000);
  assert.equal(controller.signal.aborted, false);
  assert.equal(h.events.filter(event => event.type === 'llm/retry-started').length, 0);
  assert.equal(h.diagnostics().at(-1).retry, 1);
});

test('a broken downstream recovery cannot prevent the unified retry', async t => {
  const h = await fixture(t, false, true);
  await h.configure({ mode: 'inherit' });
  h.ctx.on('agent/request-error', async () => { throw new Error('private plugin failure'); });
  assert.deepEqual(await h.recover(), { kind: 'retry' });
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 1);
  assert.equal(h.diagnostics().at(-1).outcome, 'retry-started');
  assert.equal(h.diagnostics().at(-1).canonicalCode, 'TRANSPORT');
  assert.equal(JSON.stringify(h.diagnostics()).includes('private plugin failure'), false);
});

test('neither a native error allowlist nor its disabled policy can veto scoped recovery', async t => {
  const h = await fixture(t, true, true);
  await h.configure({ mode: 'inherit', maxRetries: 7 });
  assert.deepEqual(await h.recover({ code: 'UNKNOWN', message: 'arbitrary unknown' } as any), { kind: 'retry' });
  assert.equal(h.diagnostics().at(-1).diagnosticCode, 'NX_UNKNOWN_FAILURE');
  assert.deepEqual(await h.recover(transport, normal(0)), { kind: 'retry' });
  const always: ResolvedRetryPolicy = { mode: 'always', initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
  for (let i = 0; i < 5; i++) assert.deepEqual(await h.recover(transport, always), { kind: 'retry' });
  assert.equal(await h.recover(transport, always), undefined);
  assert.equal(h.diagnostics().at(-1).maxRetries, 7);
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 7);
});

test('missing settings services still select the default 64-attempt policy', async t => {
  const h = await fixture(t, true);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = h.recover({ code: 'PI_AI_ERROR', message: 'opaque' } as any);
  for (let i = 0; i < 80; i++) await Promise.resolve();
  const scheduled = h.events.find(event => event.type === 'llm/retry')!.data;
  assert.equal(scheduled.mode, 'normal');
  if (scheduled.mode !== 'normal') throw new Error('Expected bounded recovery');
  assert.equal(scheduled.maxRetries, 64);
  assert.ok(scheduled.delayMs >= 450 && scheduled.delayMs <= 550);
  t.mock.timers.tick(scheduled.delayMs);
  assert.deepEqual(await pending, { kind: 'retry' });
});

test('settings read failures retain the last known policy, including explicit disable', async t => {
  const h = await fixture(t, true, true);
  await h.configure({ mode: 'inherit', maxRetries: 2 });
  assert.deepEqual(await h.recover(), { kind: 'retry' });
  const get = h.scopeServices.store.get;
  h.scopeServices.store.get = async () => { throw new Error('private storage outage'); };
  assert.deepEqual(await h.recover(), { kind: 'retry' });
  assert.ok(h.diagnostics().some(item => item.phase === 'retry-settings' && item.outcome === 'deferred'));
  h.scopeServices.store.get = get;
  await h.configure({ mode: 'disabled' }, undefined, 1);
  assert.equal(await h.recover(), undefined);
  h.scopeServices.store.get = async () => { throw new Error('private storage outage'); };
  assert.equal(await h.recover(), undefined);
  assert.equal(h.diagnostics().at(-1).stopReason, 'retry-disabled');
  h.scopeServices.store = undefined as any;
  assert.equal(await h.recover(), undefined, 'temporary absence of the whole settings service preserves known disable');
  assert.equal(h.diagnostics().at(-1).stopReason, 'retry-disabled');
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 2);
});

test('overflow recovery retries its safe stage under one durable budget before allowing a changed request', async t => {
  const h = await fixture(t, true, true);
  await h.configure({ mode: 'inherit', maxRetries: 5 });
  const seen: any[] = [];
  const binding = registerNativeCompactionBinding(h.ctx as unknown as HostContext, {
    async compactRanges() { throw new Error('not a manual compaction'); },
    async recoverOverflow(payload, managed) {
      seen.push(managed);
      assert.equal(payload.agent, h.agent);
      if (seen.length === 1) throw new Error('transient recovery handler failure');
      return seen.length < 4 ? undefined : { kind: 'retry' };
    },
  });
  binding.bind(h.agent); t.after(binding.dispose);
  assert.deepEqual(await h.recover({ code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' } as any), { kind: 'retry' });
  assert.deepEqual(seen.map(item => item.retry), [1, 2, 3, 4]);
  assert.ok(seen.every(item => item.maxRetries === 5));
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 4);
  h.restart();
  assert.deepEqual(await h.recover(), { kind: 'retry' });
  assert.equal(await h.recover(), undefined);
  assert.equal(h.diagnostics().at(-1).retry, 5, 'recovery phases and provider resends share one budget');
});

test('policy changes retain one shared budget but own distinct retry IDs and contiguous attempts', async t => {
  const h = await fixture(t, true, true);
  const policyA = { mode: 'custom', maxRetries: 6, initialDelayMs: 0, maxDelayMs: 0, algorithm: 'fixed' };
  const policyB = { ...policyA, algorithm: 'linear' };
  await h.configure(policyA);
  assert.deepEqual(await h.recover(), { kind: 'retry' });
  assert.deepEqual(await h.recover(), { kind: 'retry' });
  await h.configure(policyB, undefined, 1);
  assert.deepEqual(await h.recover(), { kind: 'retry' });
  h.restart();
  assert.deepEqual(await h.recover(), { kind: 'retry' });
  await h.configure(policyA, undefined, 2);
  assert.deepEqual(await h.recover(), { kind: 'retry' });
  assert.deepEqual(await h.recover(), { kind: 'retry' });
  assert.equal(await h.recover(), undefined);
  const scheduled = h.events.filter(event => event.type === 'llm/retry');
  assert.deepEqual(scheduled.map(event => event.data.retry), [1, 2, 1, 2, 3, 4]);
  assert.equal(scheduled[0].data.retryId, scheduled[4].data.retryId, 'returning to the original policy resumes its chain');
  assert.notEqual(scheduled[0].data.retryId, scheduled[2].data.retryId);
  assert.equal(scheduled[2].data.retryId, scheduled[3].data.retryId, 'reload restores the policy chain');
  assert.equal(h.diagnostics().at(-1).retry, 6, 'policy changes cannot replenish the budget');
  assert.equal(h.diagnostics().at(-1).stopReason, 'retry-exhausted');
  const started = h.events.filter(event => event.type === 'llm/retry-started');
  assert.deepEqual(started.map(event => [event.data.retryId, event.data.retry]),
    scheduled.map(event => [event.data.retryId, event.data.retry]));
});

test('an earlier native policy consumes the shared budget without numbering a new fallback policy from two', async t => {
  const h = await fixture(t, false, true);
  await h.configure({ mode: 'custom', maxRetries: 3, initialDelayMs: 0, maxDelayMs: 0 });
  h.session.append('llm/retry', {
    retryId: 'prior-native-policy' as any, turn: 1, step: 1, provider: 'fixture-provider',
    mode: 'normal', policyKey: 'native-policy', retry: 1, maxRetries: 3, delayMs: 0, failure: transport,
  });
  h.restart();
  assert.deepEqual(await h.recover(), { kind: 'retry' });
  assert.deepEqual(await h.recover(), { kind: 'retry' });
  assert.equal(await h.recover(), undefined);
  const records = h.events.filter(event => event.type === 'llm/retry');
  assert.deepEqual(records.map(event => event.data.retry), [1, 1, 2]);
  assert.notEqual(records[0].data.retryId, records[1].data.retryId);
  assert.equal(records[1].data.retryId, records[2].data.retryId);
  assert.equal(h.diagnostics().at(-1).retry, 3);
});

test('unavailable overflow compaction exhausts recovery without authorizing an unchanged oversized request', async t => {
  const h = await fixture(t, true, true);
  await h.configure({ mode: 'inherit', maxRetries: 3 });
  assert.equal(await h.recover({ code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' } as any), undefined);
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 3);
  assert.equal(h.diagnostics().at(-1).stopReason, 'retry-exhausted');
  assert.ok(h.diagnostics().some(item => item.stopReason === 'context-compactor-unavailable' && item.outcome === 'deferred'));
});

test('helper writes only bounded allowlisted facts and defaults recovered/deferred outcomes', async t => {
  const h = await fixture(t);
  await recordRecoveryDiagnostic(h.ctx as unknown as HostContext, h.agent.id, {
    diagnosticCode: 'NX_STREAM_TAIL_RECOVERED', phase: 'provider-stream-tail', canonicalCode: 'TRANSPORT',
    requestId: 'request-42', status: 502, traceId: 'trace_safe-42',
    attemptId: 'attempt_safe-42', logicalCallId: 'host-call:session:42', provider: 'fixture-provider',
    prompt: 'secret prompt', body: 'secret body', stack: 'secret stack', arbitrary: { credential: 'secret' },
    retry: -1, maxRetries: Infinity, stopReason: 'secret raw body',
  });
  const record = h.diagnostics().at(-1);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.outcome, 'recovered');
  assert.equal(record.retry, 0);
  assert.equal(record.maxRetries, undefined);
  assert.equal(record.stopReason, undefined);
  assert.equal(record.attemptId, 'attempt_safe-42');
  assert.equal(record.requestId, 'request-42');
  assert.equal(record.traceId, 'trace_safe-42');
  assert.equal(record.sessionId, h.agent.id);
  assert.equal(JSON.stringify(record).includes('secret'), false);
  assert.equal((h.events.at(-1) as any).ignorable, true);
  await recordRecoveryDiagnostic(h.ctx as unknown as HostContext, h.agent.id, {
    diagnosticCode: 'NX_OBSERVATION_DEFERRED', phase: 'accounting-observation',
    stopReason: 'OBSERVATION_WRITE_FAILED', requestId: 'bad\nrequest', status: 1000,
  });
  assert.equal(h.diagnostics().at(-1).outcome, 'deferred');
  assert.equal(h.diagnostics().at(-1).canonicalCode, 'OBSERVATION_DEFERRED');
  assert.match(h.diagnostics().at(-1).traceId, /^trace_[a-zA-Z0-9_-]{1,96}$/);
  assert.equal(h.diagnostics().at(-1).requestId, undefined);
  assert.equal(h.diagnostics().at(-1).status, undefined);
  assert.equal(h.diagnostics().at(-1).stopReason, 'OBSERVATION_WRITE_FAILED');
});

test('helper can observe an append and falls back from agent lookup without reentering publication', async t => {
  const h = await fixture(t);
  let recorded: Promise<void> | undefined;
  h.ctx.on('session/event', (_session, event) => {
    if (event.type === 'step/end') recorded = recordRecoveryDiagnostic({
      get: (name: string) => {
        if (name === 'agents') throw new Error('agent registry unavailable');
        return h.ctx.get(name);
      },
    } as unknown as HostContext, h.agent.id, { diagnosticCode: 'NX_OBSERVATION_DEFERRED', phase: 'accounting-observation' });
  });
  h.session.append('step/end', { turn: 1, step: 1 });
  await recorded;
  assert.equal(h.diagnostics().at(-1).outcome, 'deferred');
});

test('bounded native failure facts survive the formal ignorable plugin-record export without raw errors', async t => {
  const h = await fixture(t);
  const causeCodes = ['ABORTED', 'TRANSPORT', 'UNKNOWN'];
  const stackFrames = [
    'consumeStream@attempt-policy.ts:251:19', 'index.js:1022:8',
    'Agent.$run[step]@agent-loop.js:1001:4', '<anonymous>@index.js:15:2',
    'render@view.tsx:7:3', 'view.jsx:8:2', 'dispatch@entry.mjs:9:5', 'entry.cjs:10:6',
  ];
  await recordRecoveryDiagnostic(h.ctx as unknown as HostContext, h.agent.id, {
    diagnosticCode: 'NX_STREAM_TAIL_RECOVERED', phase: 'provider-stream-tail',
    errorName: 'AbortError', causeCodes, stackFrames, abortSource: 'unattributed',
    terminalKind: 'tool-calls', terminalObserved: true, tailElapsedMs: 25_933.5,
    error: { message: 'secret error body', stack: 'C:\\private\\customer\\secret.ts:123:4' },
  });
  const record = h.diagnostics().at(-1);
  const exported = JSON.parse(JSON.stringify(h.session.snapshotEvents().find((event: any) =>
    event.type === 'plugin:nexus/request-recovery' && event.data.id === record.id)));
  assert.equal(exported.ignorable, true);
  assert.equal(exported.data.errorName, 'AbortError');
  assert.deepEqual(exported.data.causeCodes, causeCodes);
  assert.deepEqual(exported.data.stackFrames, stackFrames);
  assert.equal(exported.data.abortSource, 'unattributed');
  assert.equal(exported.data.terminalKind, 'tool-calls');
  assert.equal(exported.data.terminalObserved, true);
  assert.equal(exported.data.tailElapsedMs, 25_933.5);
  assert.equal(JSON.stringify(exported).includes('secret'), false);
  causeCodes.push('MUTATED');
  stackFrames.push('mutated.js:1:1');
  assert.deepEqual(record.causeCodes, ['ABORTED', 'TRANSPORT', 'UNKNOWN']);
  assert.equal(record.stackFrames.length, 8);
});

test('diagnostic stack facts reject paths, raw stack syntax, arbitrary text and oversized arrays', async t => {
  const h = await fixture(t);
  const unsafeFrames = [
    'consume@C:\\Users\\Private\\secret.ts:123:4',
    'consume@/home/private/secret.js:123:4',
    'consume@file:///home/private/secret.js:123:4',
    'consume@..\\private\\secret.ts:123:4',
    'at consume (index.js:123:4)',
    'consume @index.js:123:4',
    'secret provider response body',
    'index.js:123:4\nsecret body',
    'index.js:0:4',
    'index.js:1:0',
    `${'F'.repeat(170)}@index.js:123:4`,
  ];
  for (const frame of unsafeFrames) {
    await recordRecoveryDiagnostic(h.ctx as unknown as HostContext, h.agent.id, {
      diagnosticCode: 'NX_ABORT_UNATTRIBUTED', phase: 'provider-stream-tail',
      stackFrames: ['safe.js:1:1', frame], causeCodes: ['ABORTED', 'secret provider text'],
      errorName: 'AbortError: secret body',
    });
    const record = h.diagnostics().at(-1);
    assert.equal(record.stackFrames, undefined, frame);
    assert.equal(record.causeCodes, undefined);
    assert.equal(record.errorName, undefined);
    assert.equal(JSON.stringify(record).includes('secret'), false);
  }
  await recordRecoveryDiagnostic(h.ctx as unknown as HostContext, h.agent.id, {
    diagnosticCode: 'NX_ABORT_UNATTRIBUTED', phase: 'provider-stream-tail',
    stackFrames: Array(9).fill('safe.js:1:1'), causeCodes: Array(7).fill('ABORTED'),
    errorName: 'A'.repeat(81),
  });
  assert.equal(h.diagnostics().at(-1).stackFrames, undefined);
  assert.equal(h.diagnostics().at(-1).causeCodes, undefined);
  assert.equal(h.diagnostics().at(-1).errorName, undefined);
  for (const invalid of [Array(1), ['ABORTED', 1], ['UNKNOWN', 'lowercase'], ['UNKNOWN', 'A'.repeat(97)]]) {
    await recordRecoveryDiagnostic(h.ctx as unknown as HostContext, h.agent.id, {
      diagnosticCode: 'NX_ABORT_UNATTRIBUTED', phase: 'provider-stream-tail',
      causeCodes: invalid, stackFrames: invalid,
    });
    assert.equal(h.diagnostics().at(-1).causeCodes, undefined);
    assert.equal(h.diagnostics().at(-1).stackFrames, undefined);
  }
});

test('diagnostic optional enums, terminal observation and tail timing accept only their exact bounded types', async t => {
  const h = await fixture(t);
  for (const [abortSource, terminalKind, terminalObserved, tailElapsedMs] of [
    ['user', 'stop', false, 0], ['parent', 'tool-calls', true, 1.5], ['hook', 'max-tokens', false, 100],
    ['disposed', 'error', true, 86_400_000], ['plugin', 'aborted', false, 20],
    ['unattributed', 'error', true, 200], ['active', 'stop', false, 0],
  ] as const) {
    await recordRecoveryDiagnostic(h.ctx as unknown as HostContext, h.agent.id, {
      diagnosticCode: 'NX_ABORT_UNATTRIBUTED', phase: 'provider-stream-tail',
      abortSource, terminalKind, terminalObserved, tailElapsedMs,
    });
    const record = h.diagnostics().at(-1);
    assert.equal(record.abortSource, abortSource);
    assert.equal(record.terminalKind, terminalKind);
    assert.equal(record.terminalObserved, terminalObserved);
    assert.equal(record.tailElapsedMs, tailElapsedMs);
  }
  for (const tailElapsedMs of [-1, Infinity, NaN, 86_400_001, '25933']) {
    await recordRecoveryDiagnostic(h.ctx as unknown as HostContext, h.agent.id, {
      diagnosticCode: 'NX_ABORT_UNATTRIBUTED', phase: 'provider-stream-tail',
      abortSource: 'secret origin', terminalKind: 'success', terminalObserved: 'true', tailElapsedMs,
    });
    const record = h.diagnostics().at(-1);
    assert.equal(record.abortSource, undefined);
    assert.equal(record.terminalKind, undefined);
    assert.equal(record.terminalObserved, undefined);
    assert.equal(record.tailElapsedMs, undefined);
  }
});

test('append, missing-session and logger failures never escape the diagnostic helper', async () => {
  const unavailable = { get() { throw new Error('unavailable'); }, logger: { warn() { throw new Error('broken logger'); } } } as unknown as HostContext;
  await assert.doesNotReject(recordRecoveryDiagnostic(unavailable, 'session-a', {
    diagnosticCode: 'NX_RECOVERY_FAILED', phase: 'request-error',
  }));
  const fakeSession = { id: 'session-a' };
  const broken = { get: () => ({ get: () => ({ session: fakeSession }) }), logger: unavailable.logger } as unknown as HostContext;
  await assert.doesNotReject(recordRecoveryDiagnostic(broken, 'session-a', {
    diagnosticCode: 'NX_RECOVERY_FAILED', phase: 'request-error',
  }));
  await assert.doesNotReject(recordRecoveryDiagnostic(unavailable, 'session-a', new Proxy({} as any, {
    get() { throw new Error('hostile fact accessor'); },
  })));
});
