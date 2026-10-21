import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ObservationOutbox, type ObservationKind } from '../src/host/observation-outbox.js';
import type { JsonRecord } from '../src/ports/contracts.js';

interface Dispatch {
  kind: ObservationKind;
  facts: JsonRecord;
  dispatchId: string;
}
type Execute = (kind: ObservationKind, facts: JsonRecord, dispatchId: string) => Promise<void>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        // These waits include atomic filesystem writes. Keep the executor's
        // 20 ms deadline below intact, but allow a loaded Windows filesystem
        // to finish receipt persistence before the test's outer watchdog.
        timer = setTimeout(() => reject(new Error('Observation wait did not reach its deadline')), 5_000);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-observation-outbox-'));
  const directory = join(root, 'receipts');
  const outboxes: ObservationOutbox[] = [];
  const warnings: Array<{ code: string; facts?: JsonRecord }> = [];
  t.after(async () => {
    for (const outbox of outboxes) await outbox.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return {
    directory,
    warnings,
    create(execute: Execute, deadlineMs?: number) {
      const outbox = new ObservationOutbox(
        () => directory, execute, (code, facts) => { warnings.push({ code, facts }); }, deadlineMs,
      );
      outboxes.push(outbox);
      return outbox;
    },
  };
}

async function receipts(directory: string) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.json'));
  return Promise.all(names.map(async name => {
    const text = await readFile(join(directory, name), 'utf8');
    const value = JSON.parse(text) as { version: number; kind: ObservationKind; facts: JsonRecord };
    return { name, text, value };
  }));
}

function facts(overrides: JsonRecord = {}): JsonRecord {
  return {
    attemptId: 'attempt-original', logicalCallId: 'call-original', sessionId: 'session-original',
    provider: 'local-provider', model: 'local-model', usageRevision: 1,
    usage: { inputTokens: 11, outputTokens: 5 }, status: 'reported',
    ...overrides,
  };
}

test('failed accounting persists and retries with stable attempt IDs and a fresh dispatch ID', async t => {
  const h = await fixture(t);
  const calls: Dispatch[] = [];
  let available = false;
  const outbox = h.create(async (kind, payload, dispatchId) => {
    calls.push({ kind, facts: payload, dispatchId });
    if (!available) throw new Error('accounting temporarily unavailable');
  });
  const original = facts();
  await outbox.observe('usage', original);

  const pending = await receipts(h.directory);
  assert.equal(pending.length, 1);
  assert.match(pending[0].name, /^[a-f0-9]{64}\.json$/);
  assert.deepEqual(pending[0].value, { version: 1, kind: 'usage', facts: original });
  assert.equal(calls.length, 1);
  assert.ok(h.warnings.some(item => item.code === 'OBSERVATION_DEFERRED'));

  available = true;
  await Promise.all([outbox.retry(), outbox.retry()]);
  await outbox.retry();

  assert.equal(calls.length, 2, 'one recovery pass must issue only an accounting retry');
  assert.deepEqual(calls.map(call => call.kind), ['usage', 'usage']);
  assert.deepEqual(calls[1].facts, original);
  assert.match(calls[0].dispatchId, /^observation:/);
  assert.match(calls[1].dispatchId, /^observation-recovery:/);
  assert.notEqual(calls[0].dispatchId, calls[1].dispatchId);
  assert.deepEqual(await readdir(h.directory), []);
});

test('a new outbox recovers usage and context receipts without issuing another model attempt', async t => {
  const h = await fixture(t);
  const initialCalls: Dispatch[] = [];
  const first = h.create(async (kind, payload, dispatchId) => {
    initialCalls.push({ kind, facts: payload, dispatchId });
    throw new Error('projection offline');
  });
  const usage = facts();
  const context = facts({ planId: 'plan-original', purpose: 'main', lane: 'main', completion: 'final' });
  await first.observe('usage', usage);
  await first.observe('context', context);
  assert.equal((await receipts(h.directory)).length, 2);
  await first.dispose();

  const recoveredCalls: Dispatch[] = [];
  const restarted = h.create(async (kind, payload, dispatchId) => {
    recoveredCalls.push({ kind, facts: payload, dispatchId });
  });
  await restarted.start();
  await restarted.retry();
  await restarted.retry();

  assert.equal(recoveredCalls.length, 2);
  assert.deepEqual(
    recoveredCalls.map(call => call.kind).sort(), ['context', 'usage'],
    'the recovery executor receives only usage.record/context.complete work',
  );
  for (const call of recoveredCalls) {
    assert.equal(call.facts.attemptId, usage.attemptId);
    assert.equal(call.facts.logicalCallId, usage.logicalCallId);
    assert.deepEqual(call.facts, call.kind === 'usage' ? usage : context);
    assert.match(call.dispatchId, /^observation-recovery:/);
    assert.ok(initialCalls.every(initial => initial.dispatchId !== call.dispatchId));
  }
  assert.deepEqual(await readdir(h.directory), []);
});

for (const kind of ['usage', 'context'] as const) {
  test(`concurrent ${kind} observations for the same attempt share one accounting execution`, async t => {
    const h = await fixture(t);
    const entered = deferred();
    const release = deferred();
    const calls: Dispatch[] = [];
    const outbox = h.create(async (operation, payload, dispatchId) => {
      calls.push({ kind: operation, facts: payload, dispatchId });
      entered.resolve();
      await release.promise;
    });
    const original = facts(kind === 'context' ? { planId: 'plan-original', completion: 'final' } : {});
    const first = outbox.observe(kind, original);
    const second = outbox.observe(kind, { ...original });
    try {
      await entered.promise;
      assert.equal(calls.length, 1);
    } finally {
      release.resolve();
      await Promise.all([first, second]);
    }
    await outbox.retry();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].facts.attemptId, original.attemptId);
    assert.equal(calls[0].facts.logicalCallId, original.logicalCallId);
  });
}

test('a newer usage revision waits for recovery and is recorded with its own facts', async t => {
  const h = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const calls: Dispatch[] = [];
  let offline = true;
  const outbox = h.create(async (kind, payload, dispatchId) => {
    calls.push({ kind, facts: payload, dispatchId });
    if (offline) throw new Error('projection offline');
    if (payload.usageRevision === 1) {
      entered.resolve();
      await release.promise;
    }
  });
  const original = facts();
  const revised = facts({ usageRevision: 2, usage: { inputTokens: 11, outputTokens: 13 } });
  await outbox.observe('usage', original);
  offline = false;
  const recovering = outbox.retry();
  let observing: Promise<void> | undefined;
  try {
    await entered.promise;
    observing = outbox.observe('usage', revised);
    await nextTurn();
    assert.equal(calls.length, 2, 'the newer revision must wait for the active recovery execution');
    release.resolve();
    await Promise.all([recovering, observing]);
  } finally {
    release.resolve();
    await Promise.all([recovering, ...(observing ? [observing] : [])]);
  }
  await outbox.retry();

  assert.deepEqual(calls.map(call => call.facts.usageRevision), [1, 1, 2]);
  assert.deepEqual(calls[2].facts, revised, 'joining an older execution must not discard revised usage');
  assert.equal(new Set(calls.map(call => call.dispatchId)).size, 3);
  assert.deepEqual(await readdir(h.directory), []);
});

test('dispose waits for an active failed observation to persist its receipt', async t => {
  const h = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const calls: Dispatch[] = [];
  const outbox = h.create(async (kind, payload, dispatchId) => {
    calls.push({ kind, facts: payload, dispatchId });
    entered.resolve();
    await release.promise;
    throw new Error('projection failed during shutdown');
  });
  const original = facts();
  const observing = outbox.observe('usage', original);
  await entered.promise;
  let disposed = false;
  const stopping = outbox.dispose().then(() => { disposed = true; });
  try {
    await nextTurn();
    assert.equal(disposed, false, 'shutdown must wait while an accounting execution is active');
    release.resolve();
    await stopping;
    const pending = await receipts(h.directory);
    assert.equal(pending.length, 1, 'the failed observation must be durable when dispose resolves');
    assert.deepEqual(pending[0].value, { version: 1, kind: 'usage', facts: original });
  } finally {
    release.resolve();
    await Promise.all([observing, stopping]);
  }
  await outbox.retry();
  assert.equal(calls.length, 1, 'shutdown preserves the receipt for recovery by a later instance');
  assert.ok(!h.warnings.some(item => item.code === 'OBSERVATION_RECEIPT_UNSAVED'));
});

test('an executor which never settles has a durable receipt and cannot hold dispose indefinitely', async t => {
  const h = await fixture(t);
  const entered = deferred();
  const calls: Dispatch[] = [];
  const outbox = h.create(async (kind, payload, dispatchId) => {
    calls.push({ kind, facts: payload, dispatchId });
    entered.resolve();
    await new Promise<void>(() => {}); // Deliberately ignores cooperative cancellation.
  }, 20);
  const original = facts();
  const observing = outbox.observe('usage', original);
  await within(entered.promise);
  await within(outbox.dispose());
  await observing;

  assert.equal(calls.length, 1);
  assert.deepEqual((await receipts(h.directory)).map(item => item.value), [
    { version: 1, kind: 'usage', facts: original },
  ]);
  assert.equal(outbox.status().activeObservations, 0);
  assert.equal(outbox.status().pendingReceipts, 1);
  assert.ok(h.warnings.some(item => item.code === 'OBSERVATION_DEFERRED'));
  assert.ok(!h.warnings.some(item => item.code === 'OBSERVATION_RECEIPT_UNSAVED'));
  await outbox.retry();
  assert.equal(calls.length, 1);
});

test('repeated observe and recovery waits reuse a timed-out original accounting execution', async t => {
  const h = await fixture(t);
  const calls: Dispatch[] = [];
  const outbox = h.create(async (kind, payload, dispatchId) => {
    calls.push({ kind, facts: payload, dispatchId });
    await new Promise<void>(() => {});
  }, 20);
  const original = facts();
  await within(outbox.observe('usage', original));
  await within(Promise.all([
    outbox.observe('usage', { ...original }), outbox.retry(), outbox.retry(),
  ]));
  await within(outbox.retry());

  assert.equal(calls.length, 1, 'deadline expiry cannot release the unknown accounting effect for another dispatch');
  assert.deepEqual(calls[0].facts, original);
  assert.equal((await receipts(h.directory)).length, 1);
  assert.equal(outbox.status().activeObservations, 0);
  await within(outbox.dispose());
});

test('a recovery executor which ignores its signal cannot hold replay or dispose indefinitely', async t => {
  const h = await fixture(t);
  const entered = deferred();
  const calls: Dispatch[] = [];
  let recovering = false;
  const outbox = h.create(async (kind, payload, dispatchId) => {
    calls.push({ kind, facts: payload, dispatchId });
    if (!recovering) throw new Error('initial accounting unavailable');
    entered.resolve();
    await new Promise<void>(() => {});
  }, 20);
  await outbox.observe('usage', facts());
  recovering = true;
  const replay = outbox.retry();
  await within(entered.promise);
  await within(outbox.dispose());
  await replay;

  assert.equal(calls.length, 2);
  assert.match(calls[1].dispatchId, /^observation-recovery:/);
  assert.equal((await receipts(h.directory)).length, 1);
  await outbox.retry();
  assert.equal(calls.length, 2, 'shutdown preserves the same unfinished accounting for later recovery');
});

test('a newer revision remains queued behind the real timed-out operation without overlap', async t => {
  const h = await fixture(t);
  const entered = deferred();
  const secondEntered = deferred();
  const release = deferred();
  const calls: Dispatch[] = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  const outbox = h.create(async (kind, payload, dispatchId) => {
    calls.push({ kind, facts: payload, dispatchId });
    maximumInFlight = Math.max(maximumInFlight, ++inFlight);
    try {
      if (payload.usageRevision === 1) { entered.resolve(); await release.promise; }
      else secondEntered.resolve();
    } finally { inFlight--; }
  }, 20);
  const original = facts();
  const revised = facts({ usageRevision: 2, usage: { inputTokens: 11, outputTokens: 13 } });
  const first = outbox.observe('usage', original);
  await within(entered.promise);
  const second = outbox.observe('usage', revised);
  // Rejoining an older fingerprint must find its original bounded wait even
  // while a different revision occupies the tail of the execution queue.
  const rejoined = outbox.observe('usage', { ...original });
  try {
    await within(Promise.all([first, second, rejoined]));
    await within(outbox.retry());
    assert.equal(calls.length, 1, 'expiry of either wait cannot start the queued revision');
    assert.deepEqual((await receipts(h.directory))[0].value.facts, revised);
    release.resolve();
    await within(secondEntered.promise);
    await nextTurn();
    assert.deepEqual(calls.map(call => call.facts.usageRevision), [1, 2]);
    assert.deepEqual(calls[1].facts, revised);
    assert.equal(maximumInFlight, 1);
    assert.equal(new Set(calls.map(call => call.dispatchId)).size, 2);
  } finally {
    release.resolve();
    await Promise.all([first, second, rejoined]);
  }
});

test('dispose prevents a queued revision from starting after an unfinished executor eventually settles', async t => {
  const h = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const calls: Dispatch[] = [];
  const outbox = h.create(async (kind, payload, dispatchId) => {
    calls.push({ kind, facts: payload, dispatchId });
    if (payload.usageRevision === 1) { entered.resolve(); await release.promise; }
  }, 20);
  const first = outbox.observe('usage', facts());
  await within(entered.promise);
  const revised = facts({ usageRevision: 2, usage: { inputTokens: 11, outputTokens: 13 } });
  const second = outbox.observe('usage', revised);
  try {
    await within(outbox.dispose());
    assert.equal(calls.length, 1);
    assert.deepEqual((await receipts(h.directory))[0].value.facts, revised);
    release.resolve();
    await nextTurn();
    await nextTurn();
    assert.equal(calls.length, 1, 'late original settlement cannot start work in a disposed outbox');
  } finally {
    release.resolve();
    await Promise.all([first, second]);
  }
});

test('a transient outbox directory failure does not poison later receipt persistence', async t => {
  const h = await fixture(t);
  await writeFile(h.directory, 'temporary filesystem obstruction');
  const outbox = h.create(async () => { throw new Error('projection offline'); });
  await outbox.start();
  assert.ok(h.warnings.some(item => item.code === 'OBSERVATION_OUTBOX_UNAVAILABLE'));

  await rm(h.directory);
  await outbox.observe('usage', facts());

  const pending = await receipts(h.directory);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].value.facts.attemptId, 'attempt-original');
  assert.ok(!h.warnings.some(item => item.code === 'OBSERVATION_RECEIPT_UNSAVED'));
});

test('persisted receipts contain accounting metadata and numeric usage without prompts or secrets', async t => {
  const h = await fixture(t);
  const secret = 'outbox-secret-must-not-survive';
  const prompt = 'outbox-private-prompt-must-not-survive';
  const original = facts({
    prompt, system: prompt, messages: [{ role: 'user', content: prompt }],
    toolArguments: { secret }, tools: [{ name: 'private-tool', description: prompt }],
    credentials: { apiKey: secret }, authorization: `Bearer ${secret}`, error: secret,
    usage: {
      inputTokens: 11, outputTokens: 5, cached: { readTokens: 3, text: secret },
      privateText: prompt, apiKey: secret, negative: -1, infinite: Infinity,
      values: [secret, 17],
    },
  });
  const outbox = h.create(async () => { throw new Error(secret); });
  await outbox.observe('usage', original);

  const pending = await receipts(h.directory);
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].value.facts, facts({
    usage: { inputTokens: 11, outputTokens: 5, cached: { readTokens: 3 } },
  }));
  assert.ok(!pending[0].text.includes(secret));
  assert.ok(!pending[0].text.includes(prompt));
  assert.ok(!JSON.stringify(h.warnings).includes(secret));
  assert.ok(!JSON.stringify(h.warnings).includes(prompt));
  assert.deepEqual(await readdir(h.directory), [pending[0].name], 'atomic writes leave no temporary receipt');
});
