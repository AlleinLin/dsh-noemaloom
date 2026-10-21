import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import NexusCompactionEngine from '../src/host/compaction.js';
import { readNativeCompactionDiagnostics } from '../src/host/native-diagnostics.js';
import { isNexusError, NexusError, type NexusStore, type StoredRecord } from '../src/ports/contracts.js';
import { NATIVE_OWNER_COLLECTION, type NativeLaneOwner } from '../src/domain/context/native-transactions.js';
import { hashObject, sha256 } from '../src/domain/context/cache.js';

class FixtureStore implements NexusStore {
  readonly rows = new Map<string, StoredRecord>();
  fail?: (collection: string, value: any) => boolean;
  async get<T>(collection: string, id: string): Promise<StoredRecord<T> | undefined> {
    const row = this.rows.get(`${collection}/${id}`);
    return row ? structuredClone(row) as StoredRecord<T> : undefined;
  }
  async list<T>(collection: string): Promise<StoredRecord<T>[]> {
    return [...this.rows].filter(([key]) => key.startsWith(`${collection}/`))
      .map(([, row]) => structuredClone(row) as StoredRecord<T>);
  }
  async put<T>(collection: string, id: string, value: T, expected?: number): Promise<StoredRecord<T>> {
    if (this.fail?.(collection, value)) throw new Error('private model text; api_key=must-not-escape');
    const row = this.rows.get(`${collection}/${id}`);
    if (expected !== undefined && (row?.revision ?? 0) !== expected) throw new NexusError('REVISION_CONFLICT', 'fixture CAS rejected');
    const next = { id, value: structuredClone(value), revision: (row?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    this.rows.set(`${collection}/${id}`, next);
    return structuredClone(next);
  }
  async remove(collection: string, id: string, expected?: number): Promise<boolean> {
    const row = this.rows.get(`${collection}/${id}`);
    if (expected !== undefined && row?.revision !== expected) throw new NexusError('REVISION_CONFLICT', 'fixture CAS rejected');
    return this.rows.delete(`${collection}/${id}`);
  }
}

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-native-owner-'));
  const store = new FixtureStore();
  const calls: string[] = [];
  const events: any[] = [];
  const notices: unknown[] = [];
  const agent = { id: 'fixture-session', session: { seq: 50, header: { cwd: dataDir },
    eventAt(seq: number) { return events.find(event => event.seq === seq); } } };
  let propose: () => Promise<any> = async () => ({ decision: 'wait' });
  let commit: () => Promise<any> = async () => ({ committed: true });
  let nudge = true;
  let flush = true;
  const services = {
    store, dataDir, workspaceRoot: dataDir,
    emit(_event: string, value: unknown) { notices.push(value); },
    async invoke(_domain: string, request: any) {
      calls.push(request.action);
      if (request.action === 'native/propose') return propose();
      if (request.action === 'native/commit' || request.action === 'native/import') return commit();
      if (request.action === 'native/abort') return { aborted: true };
      throw new Error(`unexpected action ${request.action}`);
    },
  };
  const context = {
    get(name: string) {
      if (name === 'nexus') return { services };
      if (name === 'sessions') return { async flush() { return flush; } };
      if (name === 'sessionQuery') return { async readSession() { return { events: structuredClone(events) }; } };
      throw new Error(`unexpected service ${name}`);
    },
  };
  const localRunning = new Map<string, string>();
  function engine(sharedRunning = true): any {
    // Exercise the real state machine without registering duplicate host
    // hooks or requiring any desktop/profile/model service in this fixture.
    const instance: any = Object.create(NexusCompactionEngine.prototype);
    Object.assign(instance, {
      nativeContext: context, runningLanes: sharedRunning ? localRunning : new Map(),
      pendingSummaries: new WeakMap(), officialOwners: new WeakMap(), nativeOverflowRetries: new WeakMap(),
      synchronize: async () => ({ nudge: { shouldInject: nudge } }),
    });
    return instance;
  }
  const first = engine();
  const key = hashObject({ sessionId: agent.id, purpose: 'main', lane: 'main', branchId: 'main',
    workspace: path.resolve(dataDir).toLowerCase() });
  const signal = () => new AbortController().signal;
  return {
    store, agent, calls, events, notices, services, first, engine, key, signal,
    setPropose(value: typeof propose) { propose = value; },
    setCommit(value: typeof commit) { commit = value; },
    setNudge(value: boolean) { nudge = value; },
    setFlush(value: boolean) { flush = value; },
    async owner() { return (await store.get<NativeLaneOwner>(NATIVE_OWNER_COLLECTION, key))!; },
    async seed(phase: NativeLaneOwner['phase'], extra: Partial<NativeLaneOwner> = {}) {
      const prior = await store.get(NATIVE_OWNER_COLLECTION, key);
      const now = new Date().toISOString();
      return store.put<NativeLaneOwner>(NATIVE_OWNER_COLLECTION, key, {
        schemaVersion: 1, sessionId: agent.id, sessionKey: key,
        operationId: 'previous-interrupted-operation', status: 'active', phase,
        kind: 'autonomous', startedThroughSeq: 20, startedAt: now, updatedAt: now, ...extra,
      }, prior?.revision ?? 0);
    },
    async expireCooldown() {
      const owner = await store.get<NativeLaneOwner>(NATIVE_OWNER_COLLECTION, key);
      if (owner) await store.put(NATIVE_OWNER_COLLECTION, key, { ...owner.value, auxiliaryRetryAfter: new Date(0).toISOString() }, owner.revision);
    },
    async close() { await rm(dataDir, { recursive: true, force: true }); },
  };
}

test('manual summary failure with a durable exact start/error-end releases maintenance and keeps the failed attempt diagnostic', async () => {
  const h = await fixture(), original = BasicCompactionEngine.prototype.compactNow;
  let calls = 0;
  BasicCompactionEngine.prototype.compactNow = async () => {
    calls++;
    h.events.push({ seq: 50, type: 'compaction/start', data: { compactionId: 'failed-manual' } },
      { seq: 51, type: 'compaction/end', data: { compactionId: 'failed-manual', error: { message: 'private provider failure' } } });
    h.agent.session.seq = 52;
    throw new Error('private provider failure');
  };
  try {
    await assert.rejects(h.first.compactNow(h.agent, h.signal()), HarnessError);
    const row = await h.owner();
    assert.equal(row.value.phase, 'official-failed');
    assert.equal(row.value.status, 'released');
    assert.equal(row.value.diagnostics?.at(-1)?.outcome, 'failed-before-replacement');
    assert.equal(row.value.diagnostics?.at(-1)?.auxiliaryEffect, 'unknown');
    BasicCompactionEngine.prototype.compactNow = async () => { calls++; return null; };
    assert.equal(await h.first.compactNow(h.agent, h.signal()), null);
    assert.equal(calls, 2, 'only a separate explicit command starts a new official attempt');
  } finally { BasicCompactionEngine.prototype.compactNow = original; await h.close(); }
});

test('legacy official owner recovers only a unique closed failed transaction and never replays it', async () => {
  const h = await fixture(), original = BasicCompactionEngine.prototype.compactNow;
  let calls = 0;
  BasicCompactionEngine.prototype.compactNow = async () => { calls++; return null; };
  try {
    await h.seed('official-started', { kind: 'manual-now' });
    h.events.push({ seq: 21, type: 'compaction/start', data: { compactionId: 'legacy-failed' } },
      { seq: 22, type: 'compaction/end', data: { compactionId: 'legacy-failed', error: { message: 'failed' } } });
    await h.first.compactNow(h.agent, h.signal());
    assert.equal(calls, 1);
    assert.equal((await h.owner()).value.diagnostics?.[0]?.outcome, 'failed-before-replacement');
    assert.equal(h.calls.includes('native/import'), false);
  } finally { BasicCompactionEngine.prototype.compactNow = original; await h.close(); }
});

test('an unmatched official start or two candidate transactions cannot be released from missing summaries', async () => {
  for (const ambiguous of [false, true]) {
    const h = await fixture();
    try {
      await h.seed('official-started', { kind: 'manual-now' });
      h.events.push({ seq: 21, type: 'compaction/start', data: { compactionId: 'unknown' } });
      if (ambiguous) h.events.push(
        { seq: 22, type: 'compaction/end', data: { compactionId: 'unknown', error: { message: 'failed' } } },
        { seq: 23, type: 'compaction/start', data: { compactionId: 'other' } });
      await assert.rejects(h.first.compactNow(h.agent, h.signal()),
        (error: unknown) => error instanceof HarnessError && error.code === 'CTX_NATIVE_RECONCILIATION_REQUIRED');
      assert.equal((await h.owner()).value.status, 'reconciliation-required');
      assert.deepEqual(h.calls, []);
    } finally { await h.close(); }
  }
});

test('summarize hook binds proposal to official transaction before a failed official return', async () => {
  const h = await fixture(), original = BasicCompactionEngine.prototype.compactRegion;
  BasicCompactionEngine.prototype.compactRegion = async function (_start: any, _end: any, agent: any) {
    h.events.push({ seq: 50, type: 'compaction/start', data: { compactionId: 'proposal-failure' } });
    agent.session.seq = 51;
    await (this as any).summarize({}, agent);
    assert.equal((await h.owner()).value.hostCompactionId, 'proposal-failure');
    h.events.push({ seq: 51, type: 'compaction/end', data: { compactionId: 'proposal-failure', error: { message: 'failed' } } });
    agent.session.seq = 52;
    throw new Error('official precommit failure');
  };
  try {
    h.setPropose(async () => ({ decision: 'compress', proposalId: 'prepared-proposal', sourceSeqs: [1, 2],
      startSeq: 1, endSeq: 2, summary: 'complete prepared summary' }));
    await assert.rejects(h.first.compactRanges(h.agent, { autonomous: true }, h.signal()), HarnessError);
    assert.equal((await h.owner()).value.phase, 'official-failed');
    assert.equal(h.calls.filter(action => action === 'native/propose').length, 1);
    assert.equal(h.calls.filter(action => action === 'native/abort').length, 1);
    assert.equal(h.calls.includes('native/commit'), false);
  } finally { BasicCompactionEngine.prototype.compactRegion = original; await h.close(); }
});

for (const code of ['CTX_DECISION_INVALID', 'CTX_RANGE_INVALID', 'CTX_NATIVE_NO_PROGRESS']) {
  test(`${code} finishes preparation and does not poison the next normal turn`, async () => {
    const h = await fixture();
    try {
      h.setPropose(async () => { throw new NexusError(code, 'fixture decision failure', { traceId: 'trace_decision_fixture' }); });
      assert.equal(await h.first.compactIfNeeded(h.agent, 'pressure', h.signal()), null);
      const failed = await h.owner();
      assert.equal(failed.value.status, 'released');
      assert.equal(failed.value.phase, 'preparation-failed');
      assert.equal(failed.value.errorCode, code);
      assert.equal(failed.value.diagnostics?.at(-1)?.officialEffect, 'not-started');
      assert.equal(failed.value.diagnostics?.at(-1)?.auxiliaryEffect, 'unknown');
      // The next turn continues; it does not automatically reissue the paid
      // auxiliary attempt that just returned an invalid result.
      assert.equal(await h.first.compactIfNeeded(h.agent, 'pressure', h.signal()), null);
      assert.deepEqual(h.calls, ['native/propose']);
      h.setPropose(async () => ({ decision: 'wait' }));
      await h.expireCooldown();
      assert.equal(await h.first.compactIfNeeded(h.agent, 'pressure', h.signal()), null);
      assert.deepEqual(h.calls, ['native/propose', 'native/propose']);
      assert.equal((await h.owner()).value.status, 'released');
    } finally { await h.close(); }
  });
}

test('cancelled auxiliary preparation is terminal, cancellation propagates and the next request is usable', async () => {
  const h = await fixture();
  try {
    const controller = new AbortController();
    h.setPropose(async () => {
      controller.abort();
      throw new DOMException('private cancellation detail', 'AbortError');
    });
    await assert.rejects(h.first.compactIfNeeded(h.agent, 'pressure', controller.signal),
      (error: unknown) => error instanceof HarnessError && error.code === 'CANCELLED' && /traceId=trace_/.test(error.message));
    assert.equal((await h.owner()).value.status, 'released');
    h.setPropose(async () => ({ decision: 'wait' }));
    // An explicit request is a new intent and bypasses only the auxiliary
    // cooldown, never the official-effect reconciliation guard.
    await h.first.compactRanges(h.agent, { autonomous: true }, h.signal());
    assert.equal((await h.owner()).value.status, 'released');
  } finally { await h.close(); }
});

test('a failed preparation receipt write leaves a recoverable owner rather than an official lock', async () => {
  const h = await fixture();
  try {
    h.setPropose(async () => { throw new Error('private model text; api_key=must-not-escape'); });
    h.store.fail = (collection, value) => collection === NATIVE_OWNER_COLLECTION && value.phase === 'preparation-failed';
    assert.equal(await h.first.compactIfNeeded(h.agent, 'pressure', h.signal()), null);
    assert.equal((await h.owner()).value.phase, 'decision-started');
    h.store.fail = undefined;
    assert.equal(await h.engine().compactIfNeeded(h.agent, 'pressure', h.signal()), null);
    const recovered = await h.owner();
    assert.equal(recovered.value.status, 'released');
    assert.equal(recovered.value.phase, 'preparation-abandoned');
    assert.equal(recovered.value.diagnostics?.at(-1)?.auxiliaryEffect, 'unknown');
    assert.equal(h.calls.length, 1, 'recovery never replays the auxiliary model call');
    assert.equal(JSON.stringify(await readNativeCompactionDiagnostics(h.services, h.agent.id)).includes('must-not-escape'), false);
  } finally { await h.close(); }
});

for (const phase of ['preparing', 'decision-started', 'proposal-prepared'] as const) {
  test(`restart abandons ${phase} using CAS and never replays its auxiliary call`, async () => {
    const h = await fixture();
    try {
      await h.seed(phase, phase === 'proposal-prepared' ? { proposalId: 'old-proposal' } : {});
      assert.equal(await h.first.compactIfNeeded(h.agent, 'pressure', h.signal()), null);
      const owner = await h.owner();
      assert.equal(owner.value.status, 'released');
      assert.equal(owner.value.phase, 'preparation-abandoned');
      assert.equal(owner.value.operationId, 'previous-interrupted-operation');
      assert.equal(owner.value.diagnostics?.at(-1)?.officialEffect, 'not-started');
      assert.deepEqual(h.calls, []);
    } finally { await h.close(); }
  });

  test(`manual compactNow recovers a legacy ${phase} owner before executing the new command`, async () => {
    const h = await fixture();
    const original = BasicCompactionEngine.prototype.compactNow;
    let officialCalls = 0;
    BasicCompactionEngine.prototype.compactNow = async () => {
      officialCalls++;
      return { compactionId: 'new-manual-command' } as any;
    };
    try {
      await h.seed(phase, { status: 'reconciliation-required',
        ...(phase === 'proposal-prepared' ? { proposalId: 'old-prepared-proposal' } : {}) });
      const result = await h.first.compactNow(h.agent, h.signal());
      assert.equal(result.compactionId, 'new-manual-command');
      assert.equal(officialCalls, 1, 'only the new explicit command is invoked');
      const owner = await h.owner();
      assert.equal(owner.value.status, 'released');
      assert.equal(owner.value.phase, 'context-committed');
      assert.equal(owner.value.diagnostics?.[0]?.outcome, 'abandoned-before-official');
      assert.notEqual(owner.value.operationId, 'previous-interrupted-operation');
      assert.deepEqual(h.calls, ['native/import'], 'the abandoned auxiliary request is never replayed');
    } finally {
      BasicCompactionEngine.prototype.compactNow = original;
      await h.close();
    }
  });
}

test('manual compactRegion and compactRanges pass through legacy preparation recovery', async () => {
  const h = await fixture();
  const original = BasicCompactionEngine.prototype.compactRegion;
  let officialCalls = 0;
  BasicCompactionEngine.prototype.compactRegion = async () => {
    officialCalls++;
    return { compactionId: 'new-manual-region' } as any;
  };
  try {
    await h.seed('decision-started', { status: 'reconciliation-required' });
    assert.equal((await h.first.compactRegion(2, 5, h.agent, h.signal())).compactionId, 'new-manual-region');
    assert.equal(officialCalls, 1);
    assert.equal((await h.owner()).value.phase, 'context-committed');
    await h.seed('proposal-prepared', { proposalId: 'another-abandoned-proposal' });
    const result = await h.first.compactRanges(h.agent, { autonomous: true }, h.signal());
    assert.equal(result.decision, 'wait');
    assert.equal((await h.owner()).value.status, 'released');
    assert.equal(officialCalls, 1);
    assert.deepEqual(h.calls, ['native/import', 'native/propose']);
  } finally {
    BasicCompactionEngine.prototype.compactRegion = original;
    await h.close();
  }
});

test('wait is a successful non-mutating result and does not retain the lane', async () => {
  const h = await fixture();
  try {
    assert.equal(await h.first.compactIfNeeded(h.agent, 'pressure', h.signal()), null);
    const owner = await h.owner();
    assert.equal(owner.value.status, 'released');
    assert.equal(owner.value.phase, 'preparing');
    assert.deepEqual(owner.value.diagnostics, []);
    assert.equal(await h.first.compactIfNeeded(h.agent, 'pressure', h.signal()), null);
    assert.equal(h.calls.length, 1);
  } finally { await h.close(); }
});

test('an unknown official effect stays locked even after an arbitrarily old timestamp', async () => {
  const h = await fixture();
  try {
    const previous = await h.seed('official-started', { proposalId: 'prepared-before-crash',
      startedAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z' });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(h.engine().compactIfNeeded(h.agent, 'pressure', h.signal()),
        (error: unknown) => error instanceof HarnessError && error.code === 'CTX_NATIVE_RECONCILIATION_REQUIRED'
          && /traceId=trace_/.test(error.message));
    }
    const owner = await h.owner();
    assert.equal(owner.value.operationId, previous.value.operationId);
    assert.equal(owner.value.status, 'reconciliation-required');
    assert.equal(owner.value.phase, 'official-started');
    assert.deepEqual(h.calls, []);
  } finally { await h.close(); }
});

test('an already replaced proposal recovers receipts without invoking a model or replacing again', async () => {
  const h = await fixture();
  try {
    h.setNudge(false);
    const summary = 'fixture exact summary';
    const sourceSeqs = [2, 5, 8];
    await h.seed('official-started', { proposalId: 'landed-proposal', sourceSeqs, summaryHash: sha256(summary) });
    h.events.push({
      type: 'compaction/summary', seq: 30,
      data: { compactionId: 'landed-host-operation', shadowedSeqs: sourceSeqs, summary: [{ type: 'text', text: summary }] },
    });
    let committed = 0;
    h.setCommit(async () => { committed++; return { committed: true }; });
    assert.equal(await h.first.compactIfNeeded(h.agent, 'pressure', h.signal()), null);
    assert.equal(await h.engine().compactIfNeeded(h.agent, 'pressure', h.signal()), null);
    assert.deepEqual(h.calls, ['native/commit']);
    assert.equal(committed, 1);
    assert.equal((await h.owner()).value.status, 'released');
  } finally { await h.close(); }
});

test('durability failure during receipt recovery keeps the official owner and trace', async () => {
  const h = await fixture();
  try {
    h.setFlush(false);
    await h.seed('official-flushed', { proposalId: 'awaiting-receipt', hostCompactionId: 'known-host-operation' });
    let thrown: HarnessError | undefined;
    try { await h.first.compactIfNeeded(h.agent, 'pressure', h.signal()); }
    catch (error) { assert.ok(error instanceof HarnessError); thrown = error; }
    assert.equal(thrown?.code, 'SESSION_DURABILITY_UNVERIFIED');
    const owner = await h.owner();
    assert.equal(owner.value.status, 'reconciliation-required');
    assert.equal(owner.value.phase, 'official-flushed');
    assert.ok(thrown?.message.includes(owner.value.traceId!));
    assert.deepEqual(h.calls, []);
  } finally { await h.close(); }
});

test('different compactor instances share the filesystem lease before admitting an auxiliary decision', async () => {
  const h = await fixture();
  try {
    let reached!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    h.setPropose(async () => { reached(); await pending; return { decision: 'wait' }; });
    const first = h.first.compactIfNeeded(h.agent, 'pressure', h.signal());
    await entered;
    // Separate local maps simulate separately bundled instances. The disk
    // lease must still prevent the second one from stealing a live decision.
    const second = h.engine(false).compactIfNeeded(h.agent, 'pressure', h.signal());
    release();
    await Promise.all([first, second]);
    assert.deepEqual(h.calls, ['native/propose']);
    assert.equal((await h.owner()).value.status, 'released');
  } finally { await h.close(); }
});

test('legacy preparation recovery fences its old CAS writer before any official invocation', async () => {
  const h = await fixture();
  try {
    const old = await h.seed('decision-started');
    await h.first.compactIfNeeded(h.agent, 'pressure', h.signal());
    await assert.rejects(h.store.put(NATIVE_OWNER_COLLECTION, h.key, {
      ...old.value, phase: 'official-started',
    }, old.revision), (error: unknown) => error instanceof NexusError && error.code === 'REVISION_CONFLICT');
    assert.equal((await h.owner()).value.phase, 'preparation-abandoned');
    assert.deepEqual(h.calls, []);
  } finally { await h.close(); }
});

test('diagnostic history is bounded and exports only the selected session and allowlisted fields', async () => {
  const h = await fixture();
  try {
    h.setPropose(async () => { throw new NexusError('CTX_DECISION_INVALID', 'private decision output', {
      traceId: 'trace_diagnostic_fixture', prompt: 'private user message', apiKey: 'fake-must-not-escape',
    }); });
    for (let i = 0; i < 20; i++) {
      await h.first.compactIfNeeded(h.agent, 'pressure', h.signal());
      await h.expireCooldown();
    }
    assert.equal((await h.owner()).value.diagnostics?.length, 16);
    const view = await readNativeCompactionDiagnostics(h.services, h.agent.id);
    assert.equal(view.lanes.length, 1);
    assert.equal((view.lanes[0].diagnostics as unknown[]).length, 16);
    for (const privateText of ['private decision output', 'private user message', 'must-not-escape']) {
      assert.equal(JSON.stringify(view).includes(privateText), false);
    }
    assert.deepEqual(await readNativeCompactionDiagnostics(h.services, 'another-session'), { schemaVersion: 1, lanes: [] });
  } finally { await h.close(); }
});

test('manual range rejection retains the domain code and exact validation reason without starting an official replacement', async () => {
  const h = await fixture();
  const validation = { blocksCreated: 0, errors: ['Total compressible content too small (306 chars, min 5000).'], warnings: [] };
  try {
    h.setPropose(async () => {
      throw new NexusError('CTX_NATIVE_NO_PROGRESS', '内核未接受范围，宿主未修改：306 chars, min 5000', validation);
    });
    await assert.rejects(h.first.compactRanges(h.agent, {
      ranges: [{ startRef: 'm00001', endRef: 'm00001', summary: 'summary' }],
    }, h.signal()), (error: unknown) => {
      assert.ok(isNexusError(error), 'the dispatcher must recognize the separate compaction bundle error');
      assert.equal(error.code, 'CTX_NATIVE_NO_PROGRESS');
      assert.match(error.message, /306 chars, min 5000/);
      assert.deepEqual((error.details as any).validation, validation);
      assert.equal((error.details as any).officialEffect, 'not-started');
      return true;
    });
    assert.deepEqual(h.calls, ['native/propose']);
    assert.equal((await h.owner()).value.status, 'released');
    assert.equal((await h.owner()).value.phase, 'preparation-failed');
  } finally { await h.close(); }
});
