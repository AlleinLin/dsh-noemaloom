import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryDiagnosticLabel, recoveryDiagnostics, recoveryRetryActive, recoveryStopReason, registerRecoveryDiagnostics } from '../src/client/RecoveryDiagnostics.js';
import type { ClientContext } from '../src/client/types.js';

function record(seq: number, data: Record<string, unknown> = {}, event: Record<string, unknown> = {}) {
  return { type: 'event', event: {
    type: 'plugin:nexus/request-recovery', ignorable: true, seq, time: 1000 + seq,
    data: {
      schemaVersion: 1, id: `record-${seq}`, at: '2026-10-20T10:00:00Z', sessionId: 'current',
      diagnosticCode: 'NX_GATEWAY_RATE_LIMIT', canonicalCode: 'RATE_LIMIT',
      phase: 'model-request', outcome: 'scheduled', retry: 2, maxRetries: 3, ...data,
    },
    ...event,
  } };
}

test('recovery diagnostics use only valid ignorable records belonging to the current session', () => {
  const entries = [
    record(1), record(2, { sessionId: 'other' }), record(3, { schemaVersion: 9 }),
    record(4, {}, { ignorable: false }), record(5, {}, { type: 'llm/retry' }),
    record(6, { diagnosticCode: 'invalid raw text' }), record(7, { retry: -1 }),
    { type: 'transient', event: record(8).event }, record(9, { outcome: 'unknown' }),
  ];
  assert.deepEqual(recoveryDiagnostics(entries, 'current').map(item => item.seq), [1]);
  assert.deepEqual(recoveryDiagnostics(entries, ''), []);
});

test('latest sequence wins for a repeated id and recent history is bounded', () => {
  const entries = [record(1, { id: 'same' }), record(2), record(3, { id: 'same', outcome: 'recovered' }), record(4)];
  const actual = recoveryDiagnostics(entries, 'current', 3);
  assert.deepEqual(actual.map(item => item.seq), [4, 3, 2]);
  assert.equal(actual[1].outcome, 'recovered');
  assert.equal(actual.filter(item => item.id === 'same').length, 1);
});

test('diagnostic copy comes from stable public error codes and optional metadata is validated', () => {
  const [actual] = recoveryDiagnostics([record(1, {
    message: 'provider payload and secret text', requestId: 'request-one', traceId: 'trace:two',
    status: 429, stopReason: 'NX_RETRY_EXHAUSTED',
  })], 'current');
  assert.equal(actual.message, '网关限流或容量不足');
  assert.equal(actual.requestId, 'request-one');
  assert.equal(actual.traceId, 'trace:two');
  assert.equal(actual.status, 429);
  assert.equal(recoveryStopReason(actual.stopReason), '自动重试次数已耗尽');
  const [invalid] = recoveryDiagnostics([record(2, { status: 9999, requestId: 'not a token\n', traceId: {}, maxRetries: Infinity })], 'current');
  assert.equal(invalid.status, undefined);
  assert.equal(invalid.requestId, undefined);
  assert.equal(invalid.traceId, undefined);
  assert.equal(invalid.maxRetries, undefined);
});

test('retry labels show the count while restored records remain historical and recovery stays neutral', () => {
  const [retry] = recoveryDiagnostics([record(1)], 'current');
  assert.equal(recoveryDiagnosticLabel(retry), '等待重试 2/3');
  assert.equal(recoveryDiagnosticLabel(retry, false), '重试记录 2/3');
  assert.equal(recoveryDiagnosticLabel({ ...retry, outcome: 'retry-started' }), '正在重试 2/3');
  assert.equal(recoveryDiagnosticLabel({ ...retry, outcome: 'recovered' }), '已恢复');
  assert.equal(recoveryDiagnosticLabel({ ...retry, outcome: 'stopped' }), '已停止');
  assert.equal(recoveryRetryActive(retry, [record(1)], true), true);
  assert.equal(recoveryRetryActive(retry, [record(1)], false), false);
  assert.equal(recoveryRetryActive(retry, [record(1), { type: 'event', event: { type: 'turn/start', seq: 2 } }], true), false);
  assert.equal(recoveryStopReason('constructor'), 'constructor');
});

test('registration contributes only the original current-session dock slot and cleanup removes it', () => {
  let registration: any, component: any;
  let removed = 0;
  const ctx = {
    slots: {
      inject(name: string, mount: () => () => void) { assert.equal(name, 'conversation.input.dock'); return mount(); },
      register(options: any, render: any) { registration = options; component = render; return () => { removed++; }; },
    },
  } as unknown as ClientContext;
  const stop = registerRecoveryDiagnostics(ctx);
  assert.equal(registration.name, 'conversation.input.dock');
  assert.equal(registration.id, 'nexus.request-recovery');
  assert.equal(registration.children, undefined);
  assert.equal(typeof component, 'function');
  stop();
  stop();
  assert.equal(removed, 1);
});
