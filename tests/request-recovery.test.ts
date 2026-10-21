import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent';
import { apply as applyNativeRetry } from '@deepseek-ai/dsh-llm-retry';
import { Session, SessionId, SessionStore, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import { ProviderRequestId, type ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm';
import { recordRecoveryDiagnostic, registerRequestRecovery } from '../src/host/request-recovery.js';
import type { HostContext } from '../src/host/types.js';

const normal = (maxRetries = 3): ResolvedRetryPolicy => ({
  mode: 'normal', maxRetries, retryableCodes: ['TRANSPORT', 'SERVER', 'RATE_LIMIT', 'TIMEOUT', 'EMPTY_RESPONSE'],
  initialDelayMs: 0, maxDelayMs: 100, jitterRatio: 0,
});
const transport = { code: 'TRANSPORT', message: 'sensitive provider body', status: 502, requestId: ProviderRequestId('provider-request-42') };

async function fixture(t: TestContext, native = false) {
  const root = new Context();
  let ctx!: Context;
  let sessions!: SessionStore;
  let agents!: AgentRegistry;
  let projections!: SessionProjectionRegistry;
  let disposeRecovery!: () => void;
  const events: SessionEvent[] = [];
  // ctx.get() deliberately exposes only active providers. The official host
  // services must finish activating before a consumer queries their presence.
  const servicesFiber = root.plugin({
    name: 'request-recovery-services',
    apply(owner: Context) {
      sessions = new SessionStore(owner);
      agents = new AgentRegistry(owner);
      projections = new SessionProjectionRegistry(owner);
    },
  });
  await servicesFiber.await();
  assert.equal(servicesFiber.state, 2);
  const fiber = root.plugin({
    name: 'request-recovery-fixture',
    inject: ['sessions', 'agents', 'sessionProjections'],
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
  return {
    ctx, agent, session, events, diagnostics, projections, recover,
    dispose: () => disposeRecovery(),
    restart() { disposeRecovery(); disposeRecovery = registerRequestRecovery(ctx as unknown as HostContext); },
    removeAgent() { detachAgent(); },
    removeSession() { detachSession(); },
  };
}

test('the prepended adapter delegates exactly one native retry and never adds its own', async t => {
  const h = await fixture(t, true);
  let downstream = 0;
  h.ctx.on('agent/request-error', async (_payload, next) => { downstream++; return next(); });
  assert.deepEqual(await h.recover(), { kind: 'retry' });
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 1);
  assert.equal(h.events.filter(event => event.type === 'llm/retry-started').length, 1);
  assert.equal(downstream, 0, 'native normal retry owns the recovery decision');
  assert.equal(h.diagnostics().at(-1).outcome, 'delegated');
  assert.equal(h.diagnostics().at(-1).source, 'native-retry');
  assert.equal(h.diagnostics().at(-1).retry, 1);
});

test('native exhaustion and unsupported provider wait are explicit without extra fallback', async t => {
  const h = await fixture(t, true);
  assert.deepEqual(await h.recover(transport, normal(1)), { kind: 'retry' });
  assert.equal(await h.recover(transport, normal(1)), undefined);
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 1);
  assert.equal(h.diagnostics().at(-1).diagnosticCode, 'NX_RETRY_EXHAUSTED');
  assert.equal(h.diagnostics().at(-1).retry, 1);
  h.session.append('step/start', { turn: 1, step: 1 });
  assert.equal(await h.recover({ ...transport, providerRetryAfterMs: 101 } as any), undefined);
  assert.equal(h.diagnostics().at(-1).diagnosticCode, 'NX_RETRY_DELAY_UNSUPPORTED');
  assert.equal(h.diagnostics().at(-1).stopReason, 'retry-delay-unsupported');
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 1);
});

test('fallback count survives adapter reload through the official projection', async t => {
  const h = await fixture(t);
  assert.deepEqual(await h.recover(transport, normal(2)), { kind: 'retry' });
  h.restart();
  assert.deepEqual(await h.recover(transport, normal(2)), { kind: 'retry' });
  assert.equal(await h.recover(transport, normal(2)), undefined);
  const retries = h.events.filter(event => event.type === 'llm/retry');
  assert.deepEqual(retries.map(event => event.data.retry), [1, 2]);
  assert.equal(h.diagnostics().at(-1).diagnosticCode, 'NX_RETRY_EXHAUSTED');
  assert.equal(JSON.stringify(retries).includes('sensitive provider body'), false);
  assert.equal(h.diagnostics().at(-1).requestId, 'provider-request-42');
  assert.equal(h.diagnostics().at(-1).status, 502);
  h.session.append('step/start', { turn: 2, step: 1 });
  assert.deepEqual(await h.recover(transport, normal(2)), { kind: 'retry' });
});

test('unattributed Abort and exact UNKNOWN cancellation retry three times with their diagnosis intact', async t => {
  const h = await fixture(t, true);
  const always: ResolvedRetryPolicy = { mode: 'always', initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
  for (const failure of [
    { code: 'ABORTED', message: 'The operation was aborted.' },
    { code: 'UNKNOWN', message: '操作已取消。' },
  ]) {
    h.session.append('step/start', { turn: 1, step: 1 });
    const before = h.events.filter(event => event.type === 'llm/retry').length;
    for (let attempt = 0; attempt < 3; attempt++) assert.deepEqual(await h.recover(failure as any, always), { kind: 'retry' });
    assert.equal(await h.recover(failure as any, always), undefined);
    assert.equal(h.events.filter(event => event.type === 'llm/retry').length - before, 3);
    const last = h.diagnostics().at(-1);
    assert.equal(last.diagnosticCode, 'NX_ABORT_UNATTRIBUTED');
    assert.equal(last.canonicalCode, 'ABORTED');
    assert.equal(last.stopReason, 'retry-exhausted');
    assert.equal(last.maxRetries, 3);
    assert.equal(h.diagnostics().some(item => item.diagnosticCode === 'NX_NETWORK_TRANSPORT'), false);
  }
});

test('credential, subscription, quota, budget and delete failures veto native always policy', async t => {
  const h = await fixture(t, true);
  const always: ResolvedRetryPolicy = { mode: 'always', initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
  let downstream = 0;
  h.ctx.on('agent/request-error', async () => { downstream++; return { kind: 'retry' }; });
  for (const [code, stopReason] of [
    ['AUTH', 'authorization-denied'], ['INVALID_API_KEY', 'authorization-denied'],
    ['SUBSCRIPTION_REQUIRED', 'authorization-denied'], ['INSUFFICIENT_QUOTA', 'quota-denied'],
    ['BUDGET_EXCEEDED', 'budget-denied'], ['SESSION_DELETED', 'session-deleted'],
    ['CTX_PREPARATION_FAILED', 'not-retryable'], ['PARTIAL_EFFECT', 'not-retryable'],
    ['SESSION_DURABILITY_UNVERIFIED', 'not-retryable'], ['PENDING_OPERATION', 'not-retryable'],
  ]) {
    assert.equal(await h.recover({ code, message: 'hidden' } as any, always), undefined);
    assert.equal(h.diagnostics().at(-1).stopReason, stopReason);
  }
  assert.equal(downstream, 0);
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 0);
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
      const h = await fixture(sub);
      const controller = new AbortController();
      const policy = { ...normal(), initialDelayMs: 60_000, maxDelayMs: 60_000 };
      const pending = h.recover(transport, policy, controller.signal);
      // No timer advances or real wait: settle the diagnostic microtasks before
      // cancellation, so cancellation also covers the cancellable-delay seam.
      for (let i = 0; i < 8; i++) await Promise.resolve();
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

test('unloading Nexus preserves a delegated native wait and its eventual recovery decision', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await fixture(t, true);
  const controller = new AbortController();
  const pending = h.recover(transport, { ...normal(), initialDelayMs: 60_000, maxDelayMs: 60_000 }, controller.signal);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  let settled = false;
  void pending.then(() => { settled = true; });
  h.dispose();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(settled, false, 'Nexus cannot cancel the native retry owner');
  t.mock.timers.tick(60_000);
  assert.deepEqual(await pending, { kind: 'retry' });
  assert.equal(controller.signal.aborted, false);
  assert.equal(h.events.filter(event => event.type === 'llm/retry-started').length, 1);
  assert.equal(h.diagnostics().at(-1).retry, 1);
});

test('a throwing downstream recovery remains the original provider failure with no fallback', async t => {
  const h = await fixture(t);
  h.ctx.on('agent/request-error', async () => { throw new Error('private plugin failure'); });
  assert.equal(await h.recover(), undefined);
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 0);
  assert.equal(h.diagnostics().at(-1).diagnosticCode, 'NX_RECOVERY_FAILED');
  assert.equal(h.diagnostics().at(-1).canonicalCode, 'TRANSPORT');
  assert.equal(JSON.stringify(h.diagnostics()).includes('private plugin failure'), false);
});

test('normal policy eligibility and bounded always fallback stop without inventing a network failure', async t => {
  const h = await fixture(t);
  assert.equal(await h.recover({ code: 'UNKNOWN', message: 'arbitrary unknown' } as any), undefined);
  assert.equal(h.diagnostics().at(-1).stopReason, 'not-retryable');
  assert.equal(await h.recover(transport, normal(0)), undefined);
  assert.equal(h.diagnostics().at(-1).diagnosticCode, 'NX_RETRY_DISABLED');
  const always: ResolvedRetryPolicy = { mode: 'always', initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
  for (let i = 0; i < 5; i++) assert.deepEqual(await h.recover(transport, always), { kind: 'retry' });
  assert.equal(await h.recover(transport, always), undefined);
  assert.equal(h.diagnostics().at(-1).maxRetries, 5);
  assert.equal(h.events.filter(event => event.type === 'llm/retry').length, 5);
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
