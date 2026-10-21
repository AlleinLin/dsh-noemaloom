import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { HarnessError, LlmError, isHarnessError } from '@deepseek-ai/dsh-llm';
import { isNexusError, NexusError } from '../src/ports/contracts.js';
import { nativeErrorIdentity, nativeFailureFacts, toHarnessError, toNativeLlmError } from '../src/host/native-diagnostics.js';
import { createDispatcher } from '../src/domain/operations/index.js';
import { createAtomicStore } from '../src/domain/storage/index.js';

test('separate bundle errors preserve domain code, trace and the public HarnessError identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-native-error-'));
  try {
    const foreign = vm.runInNewContext(`new (class NexusError extends Error {
      [Symbol.for('dsh-nexus.error.v1')] = true;
      code = 'CTX_DECISION_INVALID';
      details = {traceId: 'trace_foreign_decision'};
    })('invalid auxiliary JSON')`) as Error;
    assert.equal(foreign instanceof NexusError, false);
    assert.equal(isNexusError(foreign), true);
    const dispatcher = createDispatcher({
      store: createAtomicStore(root), dataDir: root, workspaceRoot: root, emit() {},
      executor: { async run() { throw new Error('not permitted'); } },
      host: {
        async facts() { return {}; },
        async model() { throw new Error('not permitted'); },
        async spawn() { throw new Error('not permitted'); },
        async sessions() { return {}; },
        async secret() { return undefined; },
        async approve() { return true; },
      },
    }, [{
      id: 'context', capabilities: [{ action: 'read', description: 'fixture read' }],
      async dispatch() { throw foreign; },
    }]);
    const response = await dispatcher.dispatch('context', { action: 'read' });
    assert.equal(response.error?.code, 'CTX_DECISION_INVALID');
    let wrapped: unknown;
    try { await dispatcher.services.invoke('context', { action: 'read' }); }
    catch (error) { wrapped = error; }
    assert.ok(isNexusError(wrapped));
    const hostError = toHarnessError(wrapped);
    assert.equal(isHarnessError(hostError), true);
    assert.ok(hostError instanceof HarnessError);
    assert.equal(hostError.code, 'CTX_DECISION_INVALID');
    assert.ok(hostError.message.includes(hostError.traceId));
    assert.equal(hostError.message.includes('UNKNOWN'), false);
    await dispatcher.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('raw exception bodies stay private while repeated diagnostics use the same trace', () => {
  const error = new Error('private user message / model output; api_key=must-not-escape');
  const identity = nativeErrorIdentity(error);
  assert.equal(nativeErrorIdentity(error).traceId, identity.traceId);
  const host = toHarnessError(error);
  assert.equal(host.traceId, identity.traceId);
  assert.equal(host.code, 'INTERNAL');
  for (const privateText of ['private user message', 'model output', 'must-not-escape']) {
    assert.equal(host.message.includes(privateText), false);
    assert.equal(JSON.stringify(host).includes(privateText), false);
  }
});

test('native aborts retain the public cancellation code and trace survives serialized failure messages', () => {
  const original = new DOMException('private cancellation reason', 'AbortError');
  const host = toHarnessError(original, { signalAborted: true, phase: 'context-admission' });
  assert.equal(host.code, 'CANCELLED');
  assert.match(host.message, /traceId=trace_/);
  assert.equal(nativeErrorIdentity({ message: host.message }).traceId, host.traceId);
  assert.doesNotMatch(host.message, /private cancellation reason/);
});

test('model boundary uses the concrete LlmError that the native turn driver serializes', () => {
  for (const code of ['BUDGET_EXCEEDED', 'CTX_PREPARATION_FAILED', 'INTERNAL']) {
    const original = new NexusError(code, 'private stack / input text');
    const wrapped = toNativeLlmError(original, { phase: 'llm-stream-middleware' });
    assert.ok(wrapped instanceof LlmError);
    assert.ok(wrapped instanceof HarnessError);
    assert.equal(wrapped.failure.code, code);
    assert.match(wrapped.failure.message, /traceId=trace_/);
    assert.doesNotMatch(wrapped.failure.message, /private stack|input text/);
    assert.equal(nativeErrorIdentity({ message: wrapped.failure.message }).traceId, wrapped.traceId);
  }
  const unclassified = toNativeLlmError(new HarnessError('private provider body', 'UNKNOWN'));
  assert.equal(unclassified.failure.code, 'UNCLASSIFIED_FAILURE');
  assert.match(unclassified.failure.message, /NX_UNKNOWN_FAILURE/);
  assert.doesNotMatch(unclassified.failure.message, /private provider body/);
});

test('native wrappers preserve hard cause codes over a Harness abort or transport code', () => {
  for (const [code, diagnostic] of [
    ['CTX_PREPARATION_FAILED', 'NX_CONTEXT_MAINTENANCE'],
    ['SESSION_DURABILITY_UNVERIFIED', 'NX_CONTEXT_MAINTENANCE'],
    ['PARTIAL_EFFECT', 'NX_PENDING_EFFECT'],
    ['PENDING_OPERATION', 'NX_PENDING_EFFECT'],
    ['BUDGET_EXCEEDED', 'NX_POLICY_BLOCKED'],
    ['APPROVAL_REQUIRED', 'NX_POLICY_BLOCKED'],
    ['POLICY_DENIED', 'NX_POLICY_BLOCKED'],
    ['AUTH', 'NX_AUTH_DENIED'],
    ['QUOTA_EXCEEDED', 'NX_AUTH_DENIED'],
  ] as const) {
    for (const wrapperCode of ['ABORTED', 'TRANSPORT']) {
      const original = Object.assign(new HarnessError('private wrapper body', wrapperCode), {
        cause: new NexusError(code, 'private hard failure body'),
      });
      const harness = toHarnessError(original);
      const native = toNativeLlmError(original);
      assert.equal(harness.code, code);
      assert.equal(native.failure.code, code);
      assert.equal(toNativeLlmError(native).failure.code, code);
      assert.ok(native.failure.message.includes(`[${diagnostic}]`));
      assert.equal(native.traceId, harness.traceId);
      assert.doesNotMatch(native.failure.message, /private wrapper body|private hard failure body/);
    }
  }
});

test('an abort wrapper retains a nested authorization status through native wrapping', () => {
  const original = Object.assign(new HarnessError('private wrapper body', 'ABORTED'), {
    cause: Object.assign(new Error('private denied body'), { status: 403 }),
  });
  assert.equal(toHarnessError(original).code, 'AUTH');
  const native = toNativeLlmError(original);
  assert.equal(native.failure.code, 'AUTH');
  assert.equal(native.failure.status, 403);
  assert.equal(toNativeLlmError(native).failure.code, 'AUTH');
  assert.match(native.failure.message, /NX_AUTH_DENIED/);
  assert.doesNotMatch(native.failure.message, /private wrapper body|private denied body/);
});

test('a real cancellation signal retains existing wrapper identity despite a hard cause', () => {
  for (const wrapperCode of ['ABORTED', 'TRANSPORT']) {
    for (const code of ['BUDGET_EXCEEDED', 'AUTH', 'QUOTA_EXCEEDED']) {
      const original = Object.assign(new HarnessError('private wrapper body', wrapperCode), {
        cause: new NexusError(code, 'private hard failure body'),
      });
      const context = { signalAborted: true };
      assert.equal(toHarnessError(original, context).code, wrapperCode);
      const native = toNativeLlmError(original, context);
      assert.equal(native.failure.code, wrapperCode);
      assert.match(native.failure.message, /NX_CANCELLED/);
    }
  }
  const original = Object.assign(new DOMException('private cancellation reason', 'AbortError'), {
    cause: new NexusError('BUDGET_EXCEEDED', 'private hard failure body'),
  });
  assert.equal(toNativeLlmError(original, { signalAborted: true }).failure.code, 'CANCELLED');
});

test('repeated native LlmError wrapping preserves its positive provider retry hint', () => {
  const original = new LlmError('private provider body', 'RATE_LIMIT', { status: 429, providerRetryAfterMs: 1_250 });
  const first = toNativeLlmError(original);
  const second = toNativeLlmError(first);
  assert.equal(first.failure.providerRetryAfterMs, 1_250);
  assert.equal(second.failure.providerRetryAfterMs, 1_250);
  assert.equal(second.failure.status, 429);
  assert.equal(second.traceId, first.traceId);
  assert.doesNotMatch(second.failure.message, /private provider body/);
});

test('zero retry hints survive Harness wrapping but follow the positive-only native constructor contract', () => {
  for (const original of [
    Object.assign(new HarnessError('private provider body', 'RATE_LIMIT'), { providerRetryAfterMs: 0 }),
    { code: 'RATE_LIMIT', failure: { providerRetryAfterMs: 0 } },
  ]) {
    const harness = toHarnessError(original) as HarnessError & { providerRetryAfterMs?: number };
    assert.equal(harness.providerRetryAfterMs, 0);
    const native = toNativeLlmError(harness);
    assert.equal(native.failure.providerRetryAfterMs, undefined);
    assert.equal(toNativeLlmError(native).failure.providerRetryAfterMs, undefined);
  }
});

test('invalid retry hints are omitted while a valid native failure hint remains available', () => {
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, '1250', null]) {
    for (const original of [{ providerRetryAfterMs: invalid }, { failure: { providerRetryAfterMs: invalid } }]) {
      const harness = toHarnessError(original) as HarnessError & { providerRetryAfterMs?: number };
      assert.equal(harness.providerRetryAfterMs, undefined);
      assert.equal(toNativeLlmError(original).failure.providerRetryAfterMs, undefined);
    }
    const original = Object.assign(new LlmError('private provider body', 'RATE_LIMIT', { providerRetryAfterMs: 1_250 }),
      { providerRetryAfterMs: invalid });
    assert.equal(toNativeLlmError(original).failure.providerRetryAfterMs, 1_250);
  }
});

test('failure origin retains safe call sites and abort kind without error text or absolute paths', () => {
  const original = Object.assign(new DOMException('private prompt secret-token', 'AbortError'), {
    cause: Object.assign(new Error('private body'), { code: 'ECONNRESET' }),
  });
  Object.defineProperty(original, 'stack', { value: [
    'AbortError: private prompt secret-token',
    '    at HostAttemptTracker.observe (D:\\private-user\\project\\attempt-policy.ts:257:13)',
    '    at async wrapper (file:///C:/private-user/plugin/index.js:82:7)',
    '    at bad function with private text (D:\\private-user\\secret.ts:1:1)',
  ].join('\n') });
  const controller = new AbortController();
  const live = nativeFailureFacts(original, controller.signal);
  assert.equal(live.errorName, 'AbortError');
  assert.equal(live.abortSource, 'active');
  assert.deepEqual(live.causeCodes, ['ECONNRESET']);
  assert.ok((live.stackFrames as string[]).includes('HostAttemptTracker.observe@attempt-policy.ts:257:13'));
  assert.ok((live.stackFrames as string[]).includes('wrapper@index.js:82:7'));
  controller.abort({ kind: 'parent', reason: 'private cancel text' });
  const facts = nativeFailureFacts(original, controller.signal);
  assert.equal(facts.abortSource, 'parent');
  for (const text of ['private', 'secret-token', 'C:', 'D:', 'cancel text']) {
    assert.equal(JSON.stringify(facts).includes(text), false);
  }
});
