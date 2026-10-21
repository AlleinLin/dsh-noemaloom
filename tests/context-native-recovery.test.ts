import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContextModule } from '../src/domain/context/index.js';
import { createContextArchive } from '../src/domain/context/archive.js';
import type { ContextArchiveHead } from '../src/domain/context/archive-types.js';
import type { ContextSession } from '../src/domain/context/types.js';
import { NexusError, type JsonRecord, type ModelRequest, type NexusModule, type NexusServices, type NexusStore, type StoredRecord } from '../src/ports/contracts.js';
import { nativeToCore, type NativeSurfaceNode } from '../src/adapters/upstream/billion/native.js';

/** Detached storage makes a successful archive CAS distinguishable from a
 * later failed proposal receipt; shared references cannot fake persistence. */
class ReceiptFailureStore implements NexusStore {
  private readonly values = new Map<string, StoredRecord>();
  failNextPut?: (collection: string, id: string, value: unknown) => boolean;
  private key(collection: string, id: string) { return `${collection}/${id}`; }
  async get<T>(collection: string, id: string) {
    const value = this.values.get(this.key(collection, id));
    return value ? structuredClone(value) as StoredRecord<T> : undefined;
  }
  async put<T>(collection: string, id: string, value: T, expected?: number) {
    if (this.failNextPut?.(collection, id, value)) {
      this.failNextPut = undefined;
      throw new Error('INJECTED_FINAL_NATIVE_RECEIPT_FAILURE');
    }
    const previous = await this.get(collection, id);
    if (expected !== undefined && expected !== (previous?.revision ?? 0)) throw new NexusError('REVISION_CONFLICT', 'REVISION_CONFLICT');
    const stored = { id, value: structuredClone(value), revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    this.values.set(this.key(collection, id), stored);
    return structuredClone(stored);
  }
  async list<T>(collection: string) {
    return [...this.values.entries()].filter(([key]) => key.startsWith(`${collection}/`))
      .map(([, value]) => structuredClone(value)) as StoredRecord<T>[];
  }
  async remove(collection: string, id: string, expected?: number) {
    const previous = await this.get(collection, id);
    if (expected !== undefined && previous?.revision !== expected) throw new NexusError('REVISION_CONFLICT', 'REVISION_CONFLICT');
    return this.values.delete(this.key(collection, id));
  }
}

const route = { providerId: 'native-recovery-fixture', modelId: 'native-recovery-model', protocol: 'openai' };
const policy = {
  compress: { minCompressRange: 0, minSummaryLength: 0, maxSummaryLength: 20000 },
  preserveRecentMessages: 0, preserveRecentTokens: 0,
  tiers: { enabled: true, tier2Trigger: 2, tier3Trigger: 3 },
};
const nodes = (): NativeSurfaceNode[] => Array.from({ length: 8 }, (_, seq) => ({
  seq, message: {
    id: `native-recovery-${seq}`, role: seq % 2 === 0 ? 'user' : 'assistant',
    source: seq % 2 === 0 ? { kind: 'user' } : { kind: 'model', provider: route.providerId, model: route.modelId },
    content: [{ type: 'text', text: `Exact native source ${seq}; retained-source-${seq}; ` + 'durable detail '.repeat(50) }],
  },
}));
const preamble = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';

function sourceEvents(input: NativeSurfaceNode[]): JsonRecord[] {
  return input.map(({ seq, message }) => ({
    type: `${message.role}/message`, seq, time: 1700000000000 + seq, surfaceOp: 'append',
    data: message.role === 'user' ? message : { message },
  }));
}

/** Canonical start/summary/replacement/end proof, independent of the proposal
 * store. A caller-provided success flag is deliberately insufficient. */
function official(compactionId: string, summary: string, sourceSeqs: number[], startSeq = 100) {
  assert.ok(sourceSeqs.length > 0);
  const lifecycle = { compactionId, turn: null };
  const checkpoint: NativeSurfaceNode = {
    seq: startSeq + 2,
    message: {
      id: `${compactionId}-checkpoint`, role: 'user',
      source: { kind: 'compact-checkpoint', compactionId },
      content: [
        { type: 'text', text: `${preamble}\n\n<compacted-summary>` },
        { type: 'text', text: summary },
        { type: 'text', text: '</compacted-summary>' },
      ],
    },
  };
  const events: JsonRecord[] = [
    { type: 'compaction/start', seq: startSeq, time: 1700000000000 + startSeq, data: lifecycle },
    { type: 'compaction/summary', seq: startSeq + 1, time: 1700000000001 + startSeq, data: {
      compactionId, summary: [{ type: 'text', text: summary }],
      shadowedRange: { start: sourceSeqs[0], end: sourceSeqs.at(-1)! }, shadowedSeqs: sourceSeqs,
      shadowedTokenCount: 600, provider: route.providerId, model: route.modelId,
    } },
    { type: 'user/message', seq: checkpoint.seq, time: 1700000000002 + startSeq, data: checkpoint.message,
      surfaceOp: { op: 'replace', startSeq: sourceSeqs[0], endSeq: sourceSeqs.at(-1)! },
      sourceEventSeqs: [startSeq, startSeq + 1, ...sourceSeqs] },
    { type: 'compaction/end', seq: startSeq + 3, time: 1700000000003 + startSeq, data: lifecycle },
  ];
  return { events, checkpoint };
}

async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-native-recovery-fixture-'));
  const store = new ReceiptFailureStore();
  const modelCalls: ModelRequest[] = [];
  let modelResponse: string | undefined;
  let hostEvents: JsonRecord[] = [];
  let module: NexusModule;
  const services: NexusServices = {
    store, dataDir: root, workspaceRoot: root, emit() {},
    executor: { async run() { throw new Error('No subprocess permitted in native recovery fixture'); } },
    host: {
      async facts() { return {}; },
      async model(request) {
        modelCalls.push(request);
        if (modelResponse !== undefined) return { text: modelResponse };
        throw new Error('No paid model decision expected');
      },
      async spawn() { throw new Error('No child execution expected'); },
      async sessions(action) {
        assert.equal(action, 'snapshot', 'native proof must come from authoritative session events');
        return { events: structuredClone(hostEvents) };
      },
      async secret() { return undefined; }, async approve() { return true; },
    },
    async invoke(domain, request, ctx) {
      assert.equal(domain, 'context');
      return module.dispatch(request, ctx);
    },
  };
  module = createContextModule(services);
  const dispatch = (action: string, params: JsonRecord = {}) =>
    module.dispatch({ action, params: { sessionId: 'native-recovery-session', ...params } });
  return {
    store, modelCalls, dispatch,
    setModelResponse(text: string) { modelResponse = text; },
    native(action: string, params: JsonRecord = {}) {
      return module.dispatch({ action, params: { sessionId: 'native-recovery-session', ...params } },
        { actorId: 'native-compaction-owner' });
    },
    setEvents(events: JsonRecord[]) { hostEvents = structuredClone(events); },
    async head() {
      const rows = await store.list<ContextArchiveHead>('context.sessions');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.value.schemaVersion, 2, 'regression must exercise the indexed archive');
      return rows[0]!;
    },
    async full() {
      const rows = await store.list<ContextArchiveHead>('context.sessions');
      assert.equal(rows.length, 1);
      return (await createContextArchive(store).loadFull(rows[0]!)).session;
    },
    async restart() { await module.dispose?.(); module = createContextModule(services); },
    async close() { await module.dispose?.(); await rm(root, { recursive: true, force: true }); },
  };
}
type Fixture = Awaited<ReturnType<typeof harness>>;

async function sync(h: Fixture, input: NativeSurfaceNode[], extra: JsonRecord = {}) {
  const plan = await h.native('native/sync', {
    nodes: input, route, windowTokens: 100000, outputReserveTokens: 1000, ...extra,
  }) as JsonRecord;
  await h.dispatch('policy', { config: policy });
  return plan;
}
async function propose(h: Fixture, startRef = 'm00001', endRef = 'm00002') {
  return await h.native('native/propose', { ranges: [{
    startRef, endRef, summary: 'Durable official fold with exact original source references and independently verified history.',
  }] }) as JsonRecord;
}
async function complete(h: Fixture, plan: JsonRecord, suffix: string) {
  return h.dispatch('complete', {
    planId: plan.planId, logicalCallId: `native-logical-${suffix}`, attemptId: `native-attempt-${suffix}`,
    usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 60, completion_tokens: 8 },
  });
}
function stableKernel(session: ContextSession) {
  return {
    state: session.state, originals: session.originals, liveMessageIds: session.liveMessageIds,
    folds: session.folds, epochs: session.epochs, accepted: session.accepted,
  };
}

test('native receipt recovery recognizes a historical commit after a later prepare advances the kernel', async () => {
  const h = await harness();
  try {
    const input = nodes();
    await sync(h, input);
    const proposal = await propose(h);
    const hostCompactionId = 'historical-native-commit';
    const transaction = official(hostCompactionId, proposal.summary as string, proposal.sourceSeqs as number[]);
    h.setEvents([...sourceEvents(input), ...transaction.events]);
    h.store.failNextPut = (collection, id, value) => collection === 'context.nativeProposals'
      && id === proposal.proposalId && (value as JsonRecord).status === 'committed';
    await assert.rejects(h.native('native/commit', { proposalId: proposal.proposalId, hostCompactionId }));
    assert.equal(h.store.failNextPut, undefined, 'the injected failure must reach the final proposal receipt');
    const committedHead = await h.head();
    const committed = await h.full();
    assert.equal(committed.state.blocks.length, 1, 'the official fold already crossed its durable CAS');
    assert.equal(committed.state.stats.compressionCount, 1);
    const pending = await h.store.get<JsonRecord>('context.nativeProposals', proposal.proposalId as string);
    assert.ok(pending);
    assert.notEqual(pending.value.status, 'committed');

    const appended: NativeSurfaceNode = { seq: 200, message: {
      id: 'native-after-historical-commit', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'Later exact source must survive receipt reconciliation without losing its permanent ref.' }],
    } };
    const advancedPlan = await h.dispatch('prepare', {
      messages: nativeToCore([...input, appended]), system: '', route, windowTokens: 100000,
      outputReserveTokens: 1000, config: policy, renderTags: 'none',
    }) as JsonRecord;
    await complete(h, advancedPlan, 'advanced');
    const stillPending = await h.store.get<JsonRecord>('context.nativeProposals', proposal.proposalId as string);
    assert.ok(stillPending);
    assert.equal(stillPending.value.status, 'prepared',
      'ordinary prepare/complete must leave historical native finalization for native reconciliation');
    const advancedHead = await h.head();
    const advanced = await h.full();
    assert.notEqual(advancedHead.value.kernelRoot, committedHead.value.kernelRoot);
    assert.ok(advancedHead.value.stateGeneration > committedHead.value.stateGeneration);
    assert.equal(advancedHead.value.originalCount, committedHead.value.originalCount + 1);
    const appendedCore = nativeToCore([appended])[0]!;
    const appendedRef = advanced.state.messageRefs.byRaw[appendedCore.id];
    assert.ok(appendedRef, 'later prepare must allocate a permanent ref');
    assert.deepEqual(advanced.state.lastPassIds, nativeToCore([...input, appended]).map(message => message.id));

    await h.restart();
    const recovered = await h.dispatch('recover') as JsonRecord;
    assert.equal(recovered.integrity, 'verified');
    assert.ok(!(recovered.nativeProposals as JsonRecord[]).some(result => result.status === 'requires-reconciliation'));
    const receipt = await h.store.get<JsonRecord>('context.nativeProposals', proposal.proposalId as string);
    assert.equal(receipt?.value.status, 'committed');
    assert.equal(receipt?.value.hostCompactionId, hostCompactionId);
    assert.equal(receipt?.value.replacementMessageId, transaction.checkpoint.message.id);
    const after = await h.full();
    const afterHead = await h.head();
    assert.deepEqual(stableKernel(after), stableKernel(advanced), 'historical receipt repair must not reinstall its older candidate state');
    assert.equal(afterHead.value.kernelRoot, advancedHead.value.kernelRoot);
    assert.equal(afterHead.value.stateGeneration, advancedHead.value.stateGeneration);
    assert.equal(afterHead.value.nextMessageRef, advancedHead.value.nextMessageRef);
    assert.equal((await h.dispatch('retrieve', { ref: appendedRef }) as JsonRecord).text, appendedCore.text);
    assert.equal((await h.native('native/commit', { proposalId: proposal.proposalId, hostCompactionId }) as JsonRecord).idempotent, true);
    assert.equal(h.modelCalls.length, 0, 'historical reconciliation must not repeat a model decision');
  } finally { await h.close(); }
});

test('actual native auxiliary decisions reject invalid JSON shapes and invalid ranges without changing the accepted kernel', async () => {
  for (const [text, expectedCode] of [
    ['{invalid json', 'CTX_DECISION_INVALID'],
    ['null', 'CTX_DECISION_INVALID'],
    ['[]', 'CTX_DECISION_INVALID'],
    ['"compress"', 'CTX_DECISION_INVALID'],
    ['{"decision":"unknown"}', 'CTX_DECISION_INVALID'],
    ['{"decision":"compress","content":[{"startId":"m00001","endId":"m00002"}]}', 'CTX_RANGE_INVALID'],
  ] as const) {
    const h = await harness();
    try {
      const input = nodes();
      h.setEvents(sourceEvents(input));
      await sync(h, input);
      const before = await h.head();
      h.setModelResponse(text);
      await assert.rejects(h.native('native/propose', { force: true }),
        (error: unknown) => error instanceof NexusError && error.code === expectedCode);
      const after = await h.head();
      assert.equal(after.value.kernelRoot, before.value.kernelRoot);
      assert.equal(after.value.stateGeneration, before.value.stateGeneration);
      assert.deepEqual(await h.store.list('context.nativeProposals'), []);
      assert.equal(h.modelCalls.length, 1, 'one auxiliary observation is never silently replayed');
    } finally { await h.close(); }
  }
});

test('actual native wait is a non-mutating terminal auxiliary result', async () => {
  const h = await harness();
  try {
    const input = nodes();
    h.setEvents(sourceEvents(input));
    await sync(h, input);
    const before = await h.head();
    h.setModelResponse('{"decision":"wait"}');
    const result = await h.native('native/propose', { force: true }) as JsonRecord;
    assert.equal(result.decision, 'wait');
    assert.equal(result.nativeApplied, false);
    assert.equal((await h.head()).value.kernelRoot, before.value.kernelRoot);
    assert.deepEqual(await h.store.list('context.nativeProposals'), []);
    assert.equal(h.modelCalls.length, 1);
  } finally { await h.close(); }
});

test('head-only complete advances CAS without invalidating a prepared native kernel pin', async () => {
  const h = await harness();
  try {
    const input = nodes();
    const synced = await sync(h, input);
    const proposal = await propose(h);
    const prepared = await h.store.get<JsonRecord>('context.nativeProposals', proposal.proposalId as string);
    assert.ok(prepared?.value.baseKernelPin, 'exercise the indexed semantic pin rather than a full-state hash');
    const before = await h.head();
    await complete(h, synced, 'head-only');
    const after = await h.head();
    assert.ok(after.revision > before.revision, 'complete must actually cross another header CAS');
    assert.equal(after.value.kernelRoot, before.value.kernelRoot);
    assert.equal(after.value.stateGeneration, before.value.stateGeneration);
    assert.deepEqual(after.value.kernel, before.value.kernel);
    assert.deepEqual(after.value.session.epochs, before.value.session.epochs);
    assert.deepEqual((await h.store.get<JsonRecord>('context.nativeProposals', proposal.proposalId as string))?.value.baseKernelPin,
      prepared.value.baseKernelPin);
    const hostCompactionId = 'native-after-head-only-complete';
    const transaction = official(hostCompactionId, proposal.summary as string, proposal.sourceSeqs as number[]);
    h.setEvents([...sourceEvents(input), ...transaction.events]);
    const committed = await h.native('native/commit', { proposalId: proposal.proposalId, hostCompactionId }) as JsonRecord;
    assert.equal(committed.committed, true);
    assert.equal((await h.full()).state.blocks.length, 1);
    assert.equal(h.modelCalls.length, 0);
  } finally { await h.close(); }
});

test('empty native surface sources retain their payload and participate in the exact commit proof', async () => {
  const h = await harness();
  try {
    const input = nodes().map((node, index) => ({ ...node, seq: index * 2 + 10 }));
    const empty: NativeSurfaceNode = { seq: 11, message: {
      id: 'official-empty-source', role: 'assistant', source: { kind: 'model', provider: route.providerId, model: route.modelId },
      content: [],
    } };
    const surface = [input[0]!, empty, ...input.slice(1)];
    const surfaceSeqs = surface.map(node => node.seq);
    // Empty official messages remain ordinary synchronized sources with
    // stable refs even when they do not contribute renderable content.
    await sync(h, surface, { surfaceSeqs });
    const proposal = await propose(h, 'm00001', 'm00003');
    assert.deepEqual(proposal.sourceSeqs, [10, 11, 12]);
    assert.equal(proposal.startSeq, 10);
    assert.equal(proposal.endSeq, 12);

    const hostCompactionId = 'native-with-empty-official-source';
    const incomplete = official(hostCompactionId, proposal.summary as string, [10, 12]);
    h.setEvents([...sourceEvents(surface), ...incomplete.events]);
    await assert.rejects(h.native('native/commit', { proposalId: proposal.proposalId, hostCompactionId }),
      (error: unknown) => (error as { code?: string }).code === 'CTX_NATIVE_COMMIT_UNPROVEN');
    assert.equal((await h.full()).state.blocks.length, 0, 'an omitted empty source is still an incomplete official proof');

    const exact = official(hostCompactionId, proposal.summary as string, [10, 11, 12]);
    h.setEvents([...sourceEvents(surface), ...exact.events]);
    assert.equal((await h.native('native/commit', { proposalId: proposal.proposalId, hostCompactionId }) as JsonRecord).committed, true);
    const receipt = await h.store.get<JsonRecord>('context.nativeProposals', proposal.proposalId as string);
    assert.deepEqual(receipt?.value.sourceSeqs, [10, 11, 12]);
    assert.equal((await h.full()).state.blocks.length, 1);
    await h.restart();
    const restored = await h.dispatch('retrieve', { ref: 'm00002' }) as JsonRecord;
    assert.deepEqual((restored.originalMessage as JsonRecord).nativeMessage, empty.message,
      'empty native payloads remain exact and retrievable after folding and restart');
    assert.equal(h.modelCalls.length, 0);
  } finally { await h.close(); }
});

test('native abort preserves an officially started proposal whose outcome remains unknown', async () => {
  for (const hostCompactionId of [undefined, 'owned-official-operation-without-terminal-failure']) {
    const h = await harness();
    try {
      const input = nodes();
      await sync(h, input);
      const proposal = await propose(h);
      const prepared = await h.store.get<JsonRecord>('context.nativeProposals', proposal.proposalId as string);
      assert.ok(prepared);
      assert.equal(prepared.value.status, 'prepared');
      const head = await h.head();
      const existingOwner = await h.store.get<JsonRecord>('context.nativeOwners', head.value.key);
      const now = new Date().toISOString();
      const owner = await h.store.put('context.nativeOwners', head.value.key, {
        schemaVersion: 1, sessionKey: head.value.key, sessionId: head.value.session.sessionId,
        operationId: `unknown-abort-${hostCompactionId ?? 'missing-host-id'}`,
        status: 'active', phase: 'official-started', kind: 'explicit-ranges',
        startedThroughSeq: input.at(-1)!.seq, proposalId: proposal.proposalId,
        ...(hostCompactionId === undefined ? {} : { hostCompactionId }),
        sourceSeqs: proposal.sourceSeqs, startedAt: now, updatedAt: now,
      }, existingOwner?.revision ?? 0);
      const pendingStart: JsonRecord[] = hostCompactionId === undefined ? [] : [{
        type: 'compaction/start', seq: 90, time: 1700000000090,
        data: { compactionId: hostCompactionId, turn: null },
      }];
      // Reading the authoritative snapshot succeeds, but neither absence of
      // the owned terminal event nor another operation's error proves failure.
      h.setEvents([...sourceEvents(input), ...pendingStart, {
        type: 'compaction/end', seq: 91, time: 1700000000091,
        data: { compactionId: 'unrelated-failed-compaction', turn: null, error: 'Unrelated operation failed' },
      }]);
      await assert.rejects(h.native('native/abort', {
        proposalId: proposal.proposalId, reason: 'The caller cannot establish the official outcome',
      }), (error: unknown) => (error as { code?: string }).code === 'PARTIAL_EFFECT');
      const afterProposal = await h.store.get<JsonRecord>('context.nativeProposals', proposal.proposalId as string);
      assert.equal(afterProposal?.value.status, 'prepared');
      assert.deepEqual(afterProposal, prepared, 'unknown effects cannot retire or rewrite the prepared proposal');
      const afterOwner = await h.store.get<JsonRecord>('context.nativeOwners', head.value.key);
      assert.equal(afterOwner?.value.status, 'active');
      assert.deepEqual(afterOwner, owner, 'unknown official work must keep its owner lease for reconciliation');
      const afterHead = await h.head();
      assert.equal(afterHead.value.kernelRoot, head.value.kernelRoot);
      assert.equal(afterHead.value.blockCount, 0);
      assert.equal(h.modelCalls.length, 0);
    } finally { await h.close(); }
  }
});
