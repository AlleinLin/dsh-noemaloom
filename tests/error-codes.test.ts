import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, isRecoverableStreamTail } from '../src/shared/error-codes.js';
import { annotateNativeFailure, toHarnessError } from '../src/host/native-diagnostics.js';
import { NexusError } from '../src/ports/contracts.js';

test('network causes survive reduced provider failures without leaking raw bodies', () => {
  for (const error of [
    new Error('fetch failed', { cause: Object.assign(new Error('private'), { code: 'ECONNRESET' }) }),
    { code: 'UNKNOWN', message: 'ECONNRESET api_key=private' },
    { code: 'UNKNOWN', message: 'fetch failed' },
  ]) {
    const diagnosis = classifyFailure(error);
    assert.equal(diagnosis.canonicalCode, 'TRANSPORT');
    assert.equal(diagnosis.retryable, true);
    const visible = annotateNativeFailure(error);
    assert.equal(visible.code, 'TRANSPORT');
    assert.equal(JSON.stringify(visible).includes('private'), false);
  }
});

test('authorization wins over nested overload; timeout and retry hints retain public metadata', () => {
  const denied = { code: 'AUTH', status: 403, message: 'private 429 engine overload', cause: { code: 'RATE_LIMIT' } };
  assert.equal(classifyFailure(denied).diagnosticCode, 'NX_AUTH_DENIED');
  assert.equal(classifyFailure(denied).retryable, false);
  const quota = classifyFailure({ code: 'RATE_LIMIT', status: 429, message: 'insufficient_quota; private account' });
  assert.equal(quota.canonicalCode, 'QUOTA_EXCEEDED');
  assert.equal(quota.retryable, false);
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: 'subscription does not have access to model' }).canonicalCode, 'AUTH');
  const snapshot = annotateNativeFailure({ code: 'TIMEOUT', status: 504, requestId: 'req_123', providerRetryAfterMs: 12000 });
  assert.equal(snapshot.code, 'TIMEOUT');
  assert.equal(snapshot.status, 504);
  assert.equal(snapshot.requestId, 'req_123');
  assert.equal(snapshot.providerRetryAfterMs, 12000);
});

test('an unrequested abort is never mislabeled as user cancellation or transport', () => {
  for (const error of [new DOMException('hidden', 'AbortError'), { code: 'UNKNOWN', message: '操作已取消。' }]) {
    assert.equal(classifyFailure(error).diagnosticCode, 'NX_ABORT_UNATTRIBUTED');
    assert.equal(classifyFailure(error).retryable, false);
    assert.equal(isRecoverableStreamTail(error), true);
    assert.equal(isRecoverableStreamTail(error, { signalAborted: true }), false);
  }
  assert.equal(classifyFailure(new Error(), { signalAborted: true }).diagnosticCode, 'NX_CANCELLED');
});

test('policy and unknown side effects remain strict even after a successful model terminal', () => {
  for (const code of ['BUDGET_EXCEEDED', 'PARTIAL_EFFECT', 'CTX_PREPARATION_FAILED', 'PERMISSION_DENIED',
    'AUTONOMY_EFFECT_UNVERIFIED', 'AUTONOMY_APPROVAL_REQUIRED']) {
    const error = new NexusError(code, 'private ECONNRESET');
    assert.equal(isRecoverableStreamTail(error), false);
    assert.equal(toHarnessError(error).code, code);
  }
  const unknown = annotateNativeFailure(new Error('private prompt'));
  assert.equal(unknown.code, 'UNCLASSIFIED_FAILURE');
  assert.match(unknown.message, /NX_UNKNOWN_FAILURE/);
  assert.equal(unknown.message.includes('private prompt'), false);
});

test('nested policy and uncertain-effect causes survive abort and transport wrappers', () => {
  const cases = [
    ['BUDGET_EXCEEDED', 'NX_POLICY_BLOCKED'],
    ['AUTONOMY_APPROVAL_REQUIRED', 'NX_POLICY_BLOCKED'],
    ['CTX_PREPARATION_FAILED', 'NX_CONTEXT_MAINTENANCE'],
    ['SESSION_DURABILITY_UNVERIFIED', 'NX_CONTEXT_MAINTENANCE'],
    ['PARTIAL_EFFECT', 'NX_PENDING_EFFECT'],
    ['AUTONOMY_EFFECT_UNVERIFIED', 'NX_PENDING_EFFECT'],
  ];
  for (const [code, diagnosticCode] of cases) {
    for (const wrapper of ['ABORTED', 'TRANSPORT', 'UNKNOWN']) {
      const error = { code: wrapper, name: 'AbortError', cause: { failure: { code } } };
      const diagnosis = classifyFailure(error);
      assert.equal(diagnosis.canonicalCode, code);
      assert.equal(diagnosis.diagnosticCode, diagnosticCode);
      assert.equal(diagnosis.retryable, false);
      assert.equal(isRecoverableStreamTail(error), false);
      assert.equal(classifyFailure(error, { signalAborted: true }).diagnosticCode, 'NX_CANCELLED');
    }
  }
});
