import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, failureMetadata, isRecoverableStreamTail, mustStopAfterAuxiliaryFailure } from '../src/shared/error-codes.js';
import { annotateNativeFailure, toHarnessError, toNativeLlmError } from '../src/host/native-diagnostics.js';
import { NexusError } from '../src/ports/contracts.js';
import { LlmError } from '@deepseek-ai/dsh-llm';

test('PI_AI_ERROR is an opaque provider failure and does not imply a confirmed internal or network fault', () => {
  const opaque = classifyFailure({ code: 'PI_AI_ERROR', message: 'opaque SDK failure' }, { phase: 'provider-response' });
  assert.equal(opaque.diagnosticCode, 'NX_PROVIDER_FAILURE');
  assert.equal(opaque.canonicalCode, 'PI_AI_ERROR');
  assert.equal(opaque.category, 'provider');
  assert.equal(opaque.retryable, false);
  const confirmed = annotateNativeFailure({ code: 'PI_AI_ERROR', status: 429, requestId: 'public-request' });
  assert.equal(confirmed.code, 'RATE_LIMIT');
  assert.equal(confirmed.requestId, 'public-request');
});

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

test('exact provider rate aliases normalize without treating local lease admission as a gateway retry', () => {
  for (const code of ['RATE_LIMITED', 'RATE_LIMIT_EXCEEDED', 'TOO_MANY_REQUESTS']) {
    const error = new LlmError('private provider response', code);
    assert.equal(classifyFailure(error).canonicalCode, 'RATE_LIMIT');
    assert.equal(classifyFailure(error).diagnosticCode, 'NX_GATEWAY_RATE_LIMIT');
    assert.equal(classifyFailure(error).retryable, true);
    assert.equal(toHarnessError(error).code, 'RATE_LIMIT');
    assert.equal(toNativeLlmError(error).failure.code, 'RATE_LIMIT');
  }
  const local = new NexusError('RATE_LIMITED', 'Local lease unavailable', { retryAfterMs: 1000 });
  assert.equal(classifyFailure(local).retryable, false);
  assert.equal(classifyFailure(local).diagnosticCode, 'NX_INTERNAL_FAILURE');
  assert.equal(toHarnessError(local).code, 'RATE_LIMITED');
  assert.equal(classifyFailure({ code: 'RATE_LIMITED', status: 429 }).canonicalCode, 'RATE_LIMIT');
  assert.equal(classifyFailure({ code: 'RATE_LIMITED' }, { provenance: 'local-admission' }).retryable, false);
});

test('sanitized auxiliary causes cross context wrappers while authority and unknown effects still stop', () => {
  const error = new NexusError('CTX_SUMMARY_MODEL_UNAVAILABLE', 'safe wrapper', {
    failure: { code: 'RATE_LIMIT', causeCodes: ['RATE_LIMITED'], status: 429,
      requestId: 'req_public', providerRetryAfterMs: 75000, body: 'private api_key' },
  });
  const metadata = failureMetadata(error), native = toNativeLlmError(error);
  assert.equal(classifyFailure(error).canonicalCode, 'CTX_SUMMARY_MODEL_UNAVAILABLE');
  assert.equal(native.failure.code, 'CTX_SUMMARY_MODEL_UNAVAILABLE');
  assert.equal(native.failure.status, 429);
  assert.equal(native.failure.providerRetryAfterMs, 75000);
  assert.ok(metadata.causeCodes.includes('RATE_LIMITED'));
  assert.equal(JSON.stringify(metadata).includes('private'), false);
  assert.equal(mustStopAfterAuxiliaryFailure(error), false);
  for (const code of ['BUDGET_EXCEEDED', 'PERMISSION_DENIED', 'PARTIAL_EFFECT', 'ABORTED']) {
    assert.equal(mustStopAfterAuxiliaryFailure(new NexusError('CTX_SUMMARY_MODEL_UNAVAILABLE', 'safe', {
      failure: { code },
    })), true, code);
  }
  for (const code of ['AUTH', 'QUOTA_EXCEEDED']) {
    assert.equal(mustStopAfterAuxiliaryFailure(new LlmError('Local optional provider failure', code, { status: 403 })), false);
  }
  const providerDenied = new NexusError('PERMISSION_DENIED', 'Local provider denial', { provenance: 'provider', status: 403 });
  assert.equal(mustStopAfterAuxiliaryFailure(providerDenied), false);
  const authorityDenied = new NexusError('PERMISSION_DENIED', 'Native permission denial');
  assert.equal(mustStopAfterAuxiliaryFailure(new NexusError('CTX_PREPARATION_FAILED', 'safe', failureMetadata(authorityDenied))), true);
  assert.equal(mustStopAfterAuxiliaryFailure(new NexusError('CTX_NATIVE_OPERATION_FAILED', 'safe', { officialEffect: 'unknown' })), true);
  const controller = new AbortController(); controller.abort({ kind: 'user' });
  assert.equal(mustStopAfterAuxiliaryFailure(error, controller.signal), true);
  assert.equal(toNativeLlmError(error, { signalAborted: true }).failure.code, 'CTX_SUMMARY_MODEL_UNAVAILABLE');
  assert.equal(toNativeLlmError(new Error('Unknown cancellation source'), { signalAborted: true }).failure.code, 'ABORTED');
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

test('provider overflow codes survive nested causes and JSON bodies without generic transport retry', () => {
  for (const cause of [
    { cause: { code: 'CONTEXT_WINDOW_EXCEEDED' } },
    { response: { body: JSON.stringify({ error: { code: 'context_length_exceeded', message: 'private body' } }) } },
    { error: { data: { type: 'max_context_length_exceeded' } } },
    { body: { error: { type: 'prompt_too_long' } } },
  ]) {
    const failure = { code: 'TRANSPORT', ...cause };
    const diagnosis = classifyFailure(failure);
    assert.equal(diagnosis.canonicalCode, 'CONTEXT_WINDOW_EXCEEDED');
    assert.equal(diagnosis.diagnosticCode, 'NX_CONTEXT_WINDOW_EXCEEDED');
    assert.equal(diagnosis.retryable, false);
    assert.equal(isRecoverableStreamTail(failure), false);
    assert.equal(annotateNativeFailure(failure).code, 'CONTEXT_WINDOW_EXCEEDED');
    assert.equal(JSON.stringify(annotateNativeFailure(failure)).includes('private body'), false);
  }
  assert.equal(classifyFailure({ code: 'CTX_NATIVE_RECONCILIATION_REQUIRED',
    cause: { code: 'CONTEXT_WINDOW_EXCEEDED' } }).canonicalCode, 'CTX_NATIVE_RECONCILIATION_REQUIRED');
});
