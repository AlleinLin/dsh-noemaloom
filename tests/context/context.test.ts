import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContextModule } from '../../src/domain/context/index.js';
import { compareBytes, normalizePhysicalUsage, planFold } from '../../src/domain/context/cache.js';
import type { ContextSession } from '../../src/domain/context/types.js';
import { createContextArchive } from '../../src/domain/context/archive.js';
import type { ContextArchiveHead } from '../../src/domain/context/archive-types.js';
import { NexusError, type NexusServices, type NexusStore, type StoredRecord, type JsonRecord, type ModelRequest, type NexusModule } from '../../src/ports/contracts.js';
import { defaultConfig, parseStoredPlaceholder, type CoreMessage } from '../../vendor/acp-kernel/src/index.js';
import { nativeToCore, coreToNative, nativeSpan, type NativeSurfaceNode } from '../../src/adapters/upstream/billion/native.js';
import { beginContextRequest, contextRequestState } from '../../src/domain/context/request-lifecycle.js';
import { randomUUID } from 'node:crypto';
import { contextPolicyDto } from '../../src/domain/context/policy-dto.js';
import { createDispatcher } from '../../src/domain/operations/index.js';
import { canonicalJson as storageJson } from '../../src/domain/storage/canonical.js';

/** Test-only store: returns detached values so persistence cannot pass through
 * accidental object reference sharing. The production store has its own tests. */
class MemoryStore implements NexusStore {
  values = new Map<string, StoredRecord>();
  reads: { collection: string; id: string }[] = [];
  failNextPut?: (collection: string, id: string, value: unknown) => boolean;
  key(collection: string, id: string) { return `${collection}/${id}`; }
  async get<T>(collection: string, id: string) {
    this.reads.push({ collection, id });
    const r = this.values.get(this.key(collection, id));
    return r ? structuredClone(r) as StoredRecord<T> : undefined;
  }
  async put<T>(collection: string, id: string, value: T, expected?: number) {
    if (this.failNextPut?.(collection, id, value)) {
      this.failNextPut = undefined;
      throw new Error('INJECTED_CONTEXT_RECEIPT_FAILURE');
    }
    const previous = await this.get(collection, id);
    if (expected !== undefined && expected !== (previous?.revision ?? 0)) throw new NexusError('REVISION_CONFLICT', 'REVISION_CONFLICT');
    const result = { id, value: structuredClone(value), revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    this.values.set(this.key(collection, id), result);
    return structuredClone(result);
  }
  async list<T>(collection: string) {
    return [...this.values.entries()].filter(([k]) => k.startsWith(`${collection}/`)).map(([, r]) => structuredClone(r)) as StoredRecord<T>[];
  }
  async remove(collection: string, id: string, expected?: number) {
    const previous = await this.get(collection, id);
    if (expected !== undefined && previous?.revision !== expected) throw new NexusError('REVISION_CONFLICT', 'REVISION_CONFLICT');
    return this.values.delete(this.key(collection, id));
  }
}
async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-context-fixture-'));
  const store = new MemoryStore();
  const calls: ModelRequest[] = [];
  const sessionCalls: { action: string; params: JsonRecord }[] = [];
  let decision = '{"decision":"wait","reason":"still needed"}';
  let hostEvents: JsonRecord[] = [];
  let restoredMessages = 0;
  let restoreHook: (() => Promise<void>) | undefined;
  let module: NexusModule;
  const services: NexusServices = {
    store, dataDir: root, workspaceRoot: root, emit() {},
    executor: { async run() { throw new Error('No subprocess needed in context fixture'); } },
    host: {
      async facts() { return {}; }, async model(request) { calls.push(request); return { text: decision, usage: { prompt_tokens: 200, completion_tokens: 80, prompt_cache_hit_tokens: 100 } }; },
      async spawn() { throw new Error('No child execution in fixture'); },
      async sessions(action, params) {
        sessionCalls.push({ action, params: structuredClone(params) });
        if (action === 'context.restore') {
          await restoreHook?.();
          const messageId = `fixture-restored-${++restoredMessages}`;
          const seq = Math.max(-1, ...hostEvents.map(event => Number(event.seq))) + 1;
          hostEvents.push({ type: 'user/message', seq, time: 1700000000000 + seq,
            surfaceOp: 'append', data: {
              id: messageId, role: 'user', content: [{ type: 'text', text: params.text }],
              source: { kind: 'nexus-context-retrieval', requestId: params.requestId },
            } });
          return { sessionId: params.sessionId, messageId, durable: true };
        }
        return { events: hostEvents };
      },
      async secret() { return undefined; }, async approve() { return true; },
    },
    async invoke(domain, request, ctx) { if (domain !== 'context') throw new Error(`Unexpected ${domain}`); return module.dispatch(request, ctx); },
  };
  module = createContextModule(services);
  const dispatch = (action: string, params: JsonRecord = {}, sessionId = 'session') => module.dispatch({
    action, params: { sessionId, ...params },
  });
  return { root, store, calls, sessionCalls, services, dispatch,
    native(action: string, params: JsonRecord = {}) {
      return module.dispatch({ action, params: { sessionId: 'session', ...params } }, { actorId: 'native-compaction-owner' });
    },
    tool(action: string, params: JsonRecord = {}) {
      return module.dispatch({ action, params: { sessionId: 'session', ...params } }, { actorId: 'native-tool' });
    },
    setHostEvents(events: JsonRecord[]) { hostEvents = events; },
    getHostEvents() { return structuredClone(hostEvents); },
    setRestoreHook(hook: () => Promise<void>) { restoreHook = hook; },
    setDecision(text: string) { decision = text; },
    restart() { module = createContextModule(services); },
    async close() { await module.dispose?.(); await rm(root, { recursive: true, force: true }); },
  };
}
const messages = (): CoreMessage[] => Array.from({ length: 14 }, (_, i) => ({
  id: `source-${i}`, role: i % 2 === 0 ? 'user' : 'assistant', contentType: 'text',
  text: `Exact fact ${i}: unique-needle-${i}; path C:/project/file-${i}.ts; emoji 🧭; 中文原文。 ` + 'details '.repeat(100),
}));
const fixturePolicy = {
  compress: { minCompressRange: 0, minSummaryLength: 0, maxSummaryLength: 20000 },
  preserveRecentMessages: 0, preserveRecentTokens: 0,
  tiers: { enabled: true, tier2Trigger: 2, tier3Trigger: 3 },
};
const route = { providerId: 'fixture-provider', modelId: 'fixture-model', protocol: 'openai' };
async function prepare(h: Awaited<ReturnType<typeof harness>>, input = messages(), extra: JsonRecord = {}) {
  return await h.dispatch('prepare', { messages: input, system: 'stable persona', route,
    windowTokens: 100000, outputReserveTokens: 1000, config: fixturePolicy, ...extra }) as JsonRecord;
}
async function finish(h: Awaited<ReturnType<typeof harness>>, plan: JsonRecord, id: string, usage?: JsonRecord) {
  return h.dispatch('complete', { planId: plan.planId, logicalCallId: `logical-${id}`, attemptId: `attempt-${id}`, usage });
}
/** Explicit test inspection expands the committed archive. Product normal
 * requests never perform this full read; assertions still inspect all sources. */
async function storedSessions(h: Awaited<ReturnType<typeof harness>>) {
  const repository = createContextArchive(h.store);
  const rows = await h.store.list<ContextSession | ContextArchiveHead>('context.sessions');
  return Promise.all(rows.map(async row => row.value.schemaVersion === 2
    ? { ...row, value: (await repository.loadFull(row as StoredRecord<ContextArchiveHead>)).session }
    : row as StoredRecord<ContextSession>));
}

test('policy DTO exposes policy data while keeping executable protection predicates inside the kernel', () => {
  const cfg = defaultConfig(100000);
  cfg.isMessageProtected = message => message.role === 'system';
  cfg.isCompressTool = name => name === 'compress';
  cfg.isToolProtected = name => name === 'protected-tool';
  cfg.messagePathOf = () => 'durable/system';
  const dto = contextPolicyDto(cfg)!;
  for (const callback of ['isMessageProtected', 'isCompressTool', 'isToolProtected', 'messagePathOf']) {
    assert.equal(Object.hasOwn(dto, callback), false);
  }
  assert.deepEqual(dto.tiers, cfg.tiers);
  assert.equal(dto.modelContextLimit, 100000);
  assert.doesNotThrow(() => storageJson(dto));
  assert.equal(cfg.isMessageProtected({ id: 'system', role: 'system', contentType: 'text' }), true);
  assert.equal(cfg.isCompressTool('compress'), true);
  assert.equal(cfg.isToolProtected('protected-tool'), true);
  assert.equal(cfg.messagePathOf({ id: 'system', role: 'system', contentType: 'text' }), 'durable/system');
  dto.tiers!.tier2Trigger = 17;
  assert.notEqual(cfg.tiers.tier2Trigger, 17, 'editing the public DTO cannot alter the executing policy');
});

test('native status and policy read/write cross the actual dispatcher JSON boundary without exporting predicates', async () => {
  const h = await harness();
  const dispatcher = createDispatcher(h.services);
  dispatcher.register(createContextModule(dispatcher.services));
  try {
    const unobserved = await dispatcher.dispatch('context', { action: 'status', params: { sessionId: 'session' } });
    assert.equal(unobserved.ok, true);
    await h.native('native/sync', { nodes: [], route, windowTokens: 1, outputReserveTokens: 0 });
    const empty = await dispatcher.dispatch('context', { action: 'status', params: { sessionId: 'session' } });
    assert.equal(empty.ok, true, JSON.stringify(empty.error));
    const emptyUsage = ((empty.data as JsonRecord).report as JsonRecord).contextUsage;
    assert.equal(typeof emptyUsage, 'number');
    assert.equal(Number.isFinite(emptyUsage) && Number(emptyUsage) >= 0, true,
      'no source messages still counts the stable tool preamble, and usage stays finite');
    await h.native('native/sync', {
      nodes: [
        { seq: 0, message: { id: 'protected-head', role: 'system', source: { kind: 'system' },
          content: [{ type: 'text', text: 'native system state must stay protected' }] } },
        { seq: 1, message: { id: 'question', role: 'user', source: { kind: 'user' },
          content: [{ type: 'text', text: 'current question' }] } },
      ],
      route, windowTokens: 100000, outputReserveTokens: 1000,
    });
    const read = await dispatcher.dispatch('context', { action: 'policy/get', params: { sessionId: 'session' } });
    assert.equal(read.ok, true, JSON.stringify(read.error));
    assert.equal(((read.data as JsonRecord).config as JsonRecord).modelContextLimit, 99000);
    assert.doesNotThrow(() => storageJson(read));
    const changed = await dispatcher.dispatch('context', {
      action: 'policy', requestId: 'serializable-policy-update',
      params: { sessionId: 'session', config: { preserveRecentMessages: 0, preserveRecentTokens: 0 } },
    }, { actorId: 'fixture-owner', permissions: new Set(['context.policy']) });
    assert.equal(changed.ok, true, JSON.stringify(changed.error));
    assert.equal(changed.receipt?.outcome, 'succeeded');
    assert.doesNotThrow(() => storageJson(changed));
    const status = await dispatcher.dispatch('context', { action: 'status', params: { sessionId: 'session' } });
    assert.equal(status.ok, true, JSON.stringify(status.error));
    assert.equal((((status.data as JsonRecord).refs as JsonRecord).byRaw as JsonRecord)['dsh:protected-head#0'], 'BLOCKED',
      'removing executable fields from RPC does not weaken native message protection');
    assert.doesNotThrow(() => storageJson(status));
    await h.dispatch('rules', { operation: 'add', text: 'Keep the original source' });
    const listed = await dispatcher.dispatch('context', { action: 'rules/list', params: { sessionId: 'session' } });
    assert.equal(listed.ok, true, JSON.stringify(listed.error));
    assert.ok(JSON.stringify(listed.data).includes('Keep the original source'));
    const ref = Object.keys(((status.data as JsonRecord).refs as JsonRecord).byRef as JsonRecord)[0];
    const peek = await dispatcher.dispatch('context', { action: 'decompress/peek', params: { sessionId: 'session', ref, full: true } });
    assert.equal(peek.ok, true, JSON.stringify(peek.error));
    assert.equal((peek.data as JsonRecord).mode, 'peek');
    assert.equal((peek.data as JsonRecord).projectionChanged, false);
    const escalation = await dispatcher.dispatch('context', { action: 'decompress/peek',
      params: { sessionId: 'session', ref, mode: 'expand' } });
    assert.equal(escalation.ok, false, 'Read-only aliases must reject write-mode parameters');
    assert.equal(h.sessionCalls.filter(call => call.action === 'context.restore').length, 0);
  } finally { await dispatcher.dispose(); await h.close(); }
});

test('recovery releases a settled auxiliary maintenance plan after complete fails without replaying or inventing usage', async () => {
  const h = await harness(), request = beginContextRequest(h.root);
  try {
    const plan = await prepare(h, messages(), { requestOwner: request.owner });
    h.store.failNextPut = collection => collection === 'context.observations';
    await assert.rejects(finish(h, plan, 'failed-observation'), /INJECTED_CONTEXT_RECEIPT_FAILURE/);
    assert.equal((await storedSessions(h))[0].value.inFlight.length, 1);
    request.end();
    const recovered = await h.dispatch('recover') as JsonRecord;
    assert.deepEqual(recovered.inFlight, []);
    assert.equal((recovered.requestRecoveries as JsonRecord[])[0].outcome, 'unknown');
    assert.equal(h.calls.length, 0);
    assert.equal((await h.store.list('context.observations')).length, 0, 'unknown usage is not replaced by a fabricated success sample');
    assert.equal((await h.store.get<JsonRecord>('context.requestOutcomes', String(plan.planId)))?.value.replayed, false);
    const next = await prepare(h, messages(), { route: { ...route, modelId: 'new-known-model' } });
    assert.ok(next.planId, 'the failed observation no longer blocks accepting the next route epoch');
  } finally { request.end(); await h.close(); }
});

test('recovery cannot release an active same-instance or other-live-process request and keeps unowned legacy plans unproven', async () => {
  for (const kind of ['same', 'other-process', 'legacy'] as const) {
    const h = await harness(), request = beginContextRequest(h.root);
    try {
      const owner = kind === 'other-process' ? { ...request.owner, pid: process.ppid, processInstanceId: randomUUID() } : request.owner;
      const plan = await prepare(h, messages(), kind === 'legacy' ? {} : { requestOwner: owner });
      const recovered = await h.dispatch('recover') as JsonRecord;
      assert.deepEqual(recovered.inFlight, [plan.planId]);
      assert.equal((recovered.requestRecoveries as JsonRecord[])[0].status, kind === 'legacy' ? 'unproven' : 'active');
      await assert.rejects(h.dispatch('request/release', { planId: plan.planId }),
        (error: unknown) => error instanceof NexusError && error.code === 'CTX_REQUEST_IN_FLIGHT');
      assert.equal(contextRequestState(h.root, owner), 'active');
      assert.equal(h.calls.length, 0);
    } finally { request.end(); await h.close(); }
  }
});

test('a recycled current PID cannot retain an auxiliary plan from an earlier process instance', async () => {
  const h = await harness(), request = beginContextRequest(h.root);
  try {
    const owner = { ...request.owner, processInstanceId: randomUUID() };
    const plan = await prepare(h, messages(), { requestOwner: request.owner });
    const persisted = (await h.store.get<any>('context.plans', String(plan.planId)))!;
    await h.store.put('context.plans', persisted.id, { ...persisted.value, requestOwner: owner }, persisted.revision);
    assert.equal(contextRequestState(h.root, owner), 'ended');
    const recovered = await h.dispatch('recover') as JsonRecord;
    assert.deepEqual(recovered.inFlight, []);
    assert.equal((recovered.requestRecoveries as JsonRecord[])[0].outcome, 'unknown');
    assert.equal(h.calls.length, 0);
    assert.equal((await h.store.get<JsonRecord>('context.requestOutcomes', String(plan.planId)))?.value.replayed, false);
  } finally { request.end(); await h.close(); }
});

test('normalized physical usage preserves missing, validates buckets and supports provider semantics', () => {
  assert.equal(normalizePhysicalUsage(undefined).cacheReadTokens, null);
  assert.equal(normalizePhysicalUsage(undefined).state, 'missing');
  assert.equal(normalizePhysicalUsage({ prompt_tokens: 1000, completion_tokens: 30 }).state, 'ambiguous');
  assert.deepEqual(
    [normalizePhysicalUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 }).totalInputTokens,
      normalizePhysicalUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 }).uncachedInputTokens], [1000, 400]);
  const a = normalizePhysicalUsage({ input_tokens: 100, cache_read_input_tokens: 700, cache_creation_input_tokens: 200, output_tokens: 40 }, 'anthropic');
  assert.equal(a.totalInputTokens, 1000);
  assert.equal(a.uncachedInputTokens, 100);
  assert.equal(a.cacheReadTokens, 700);
  const dsh = normalizePhysicalUsage({ inputTokens: 100, cacheReadTokens: 700, cacheWriteTokens: 200, outputTokens: 40 });
  assert.equal(dsh.totalInputTokens, 1000);
  assert.equal(dsh.uncachedInputTokens, 100);
  assert.equal(normalizePhysicalUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 20 }).state, 'invalid');
  assert.equal(normalizePhysicalUsage({ prompt_tokens: -1 }).state, 'invalid');
});

test('public context diagnostics is scoped to the selected workspace lane and exports metadata only', async () => {
  const h = await harness();
  try {
    await prepare(h);
    const current = (await storedSessions(h))[0].value;
    const owner = { schemaVersion: 1, sessionId: 'session', sessionKey: current.key,
      operationId: 'diagnostic-operation', status: 'reconciliation-required', phase: 'official-started',
      kind: 'manual-now', startedThroughSeq: 3, traceId: 'trace_diagnostic', errorCode: 'CTX_NATIVE_OPERATION_FAILED',
      privateText: 'must-never-export-this-body', diagnostics: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await h.store.put('context.nativeOwners', current.key, owner, 0);
    await h.store.put('context.nativeOwners', 'foreign-workspace-key', { ...owner, sessionKey: 'foreign-workspace-key' }, 0);
    const result = await h.dispatch('diagnostics') as { lanes: JsonRecord[] };
    assert.equal(result.lanes.length, 1);
    assert.equal(result.lanes[0].code, 'CTX_NATIVE_OPERATION_FAILED');
    assert.equal(result.lanes[0].traceId, 'trace_diagnostic');
    assert.equal(JSON.stringify(result).includes('must-never-export-this-body'), false);
    const direct = createContextModule(h.services);
    await assert.rejects(direct.dispatch({ action: 'diagnostics', params: { sessionId: 'foreign-session' } },
      { scopeLevel: 'session', sessionId: 'session' }),
    (error: unknown) => error instanceof NexusError && error.code === 'PERMISSION_DENIED');
    await direct.dispose?.();
  } finally { await h.close(); }
});

test('same static epoch and projection replay keeps byte-identical prefix; actual wire has an independent sequence', async () => {
  const h = await harness();
  try {
    const first = await prepare(h);
    await h.dispatch('wire/record', { planId: first.planId, serialized: '{"messages":["first"]}' });
    await finish(h, first, '1');
    const second = await prepare(h);
    assert.deepEqual(second.epochs, first.epochs);
    const projection = await h.dispatch('wire/diff', { wireId: second.wireId }) as JsonRecord;
    assert.equal((projection.current as JsonRecord).firstDifference, null);
    await h.dispatch('wire/record', { planId: second.planId, serialized: '{"messages":["first"]}' });
    const wire = await h.dispatch('wire/diff') as JsonRecord;
    assert.equal((wire.current as JsonRecord).stage, 'actual-wire');
    assert.equal((wire.current as JsonRecord).firstDifference, null);
    assert.equal((wire.current as JsonRecord).serialized, undefined);
  } finally { await h.close(); }
});

test('T1/T2/T3 use real kernel lineage and exact originals survive restart, search and restore', async () => {
  const h = await harness();
  try {
    const raw = messages();
    const p = await prepare(h, raw);
    await finish(h, p, 'seed');
    for (const [a, b] of [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12]]) {
      const result = await h.dispatch('compress', { ranges: [{ startRef: `m${String(a).padStart(5, '0')}`,
        endRef: `m${String(b).padStart(5, '0')}`, summary: `Durable summary for facts ${a}-${b} with exact source references` }] }) as JsonRecord;
      assert.equal(result.blocksCreated, 1);
    }
    for (const [a, b] of [[1, 2], [3, 4], [5, 6]]) {
      const result = await h.dispatch('compress', { ranges: [{ startRef: `b${a}`, endRef: `b${b}`,
        summary: `Distilled exact decisions ${a}-${b}` }] }) as JsonRecord;
      assert.equal(result.blocksCreated, 1);
    }
    const final = await h.dispatch('compress', { ranges: [{ startRef: 'b7', endRef: 'b9',
      summary: 'Tier three decisions; original source facts remain addressable by permanent refs.' }] }) as JsonRecord;
    assert.equal(final.blocksCreated, 1);
    h.restart();
    const status = await h.dispatch('status') as JsonRecord;
    const blocks = status.blocks as { tier: number; directBlockIds: string[]; active: boolean }[];
    assert.equal(blocks.at(-1)!.tier, 3);
    assert.equal(blocks.at(-1)!.directBlockIds.length, 3);
    const original = await h.dispatch('retrieve', { ref: 'm00002' }) as JsonRecord;
    assert.equal(original.text, raw[1].text);
    const search = await h.dispatch('search', { query: 'unique-needle-1', algorithm: 'substring' }) as JsonRecord;
    assert.ok((search.results as JsonRecord[]).some(r => r.ref === 'm00002'));
    const before = await h.dispatch('epochs') as JsonRecord;
    const recovered = await h.dispatch('decompress', { blockId: 'b10', mode: 'peek', full: true }) as JsonRecord;
    assert.equal((recovered.messages as CoreMessage[])[1].text, raw[1].text);
    assert.deepEqual((await h.dispatch('epochs') as JsonRecord).epochs, before.epochs);
    const file = await h.dispatch('decompress', { blockId: 'b10', mode: 'file', full: true }) as JsonRecord;
    assert.ok((await readFile((file.export as JsonRecord).path as string, 'utf8')).includes(raw[1].text!));
    assert.equal((await h.dispatch('recover') as JsonRecord).integrity, 'verified');
  } finally { await h.close(); }
});

test('session lanes and purposes isolate compression and physical samples; retries update one observation', async () => {
  const h = await harness();
  try {
    const p = await prepare(h);
    await finish(h, p, 'one', { prompt_tokens: 100, prompt_cache_hit_tokens: 70, completion_tokens: 5 });
    await finish(h, p, 'one', { prompt_tokens: 100, prompt_cache_hit_tokens: 70, completion_tokens: 5 });
    await finish(h, p, 'one'); // Non-usage tail cannot erase final sample.
    const aux = await h.dispatch('prepare', { sessionId: 'session', purpose: 'title', messages: [messages()[0]],
      system: 'title persona', route, windowTokens: 100000, outputReserveTokens: 1000 }) as JsonRecord;
    assert.notEqual(aux.sessionKey, p.sessionKey);
    assert.equal((await h.dispatch('cache/report') as JsonRecord).cacheReadShare, .7);
    assert.equal((await h.dispatch('cache/report') as JsonRecord).observations instanceof Array, true);
    assert.equal(((await h.dispatch('cache/report') as JsonRecord).observations as unknown[]).length, 1);
    const titleStatus = await h.dispatch('status', { purpose: 'title' }) as JsonRecord;
    assert.equal((titleStatus.blocks as unknown[]).length, 0);
  } finally { await h.close(); }
});

test('real autonomous controller can wait and compress; malformed response never fabricates success', async () => {
  const h = await harness();
  try {
    const p = await prepare(h);
    await finish(h, p, 'seed');
    const waited = await h.dispatch('decide', { force: true }) as JsonRecord;
    assert.equal(waited.decision, 'wait');
    assert.equal(h.calls.length, 1);
    h.setDecision('{"decision":"compress","content":[{"startId":"m00001","endId":"m00002","summary":"Exact consumed decisions with recovery references.","topic":"fixture"}]}');
    const compressed = await h.dispatch('decide', { force: true }) as JsonRecord;
    assert.equal((compressed.applied as JsonRecord).blocksCreated, 1);
    h.setDecision('not valid JSON');
    await assert.rejects(h.dispatch('decide', { force: true }), /有效 JSON/);
    assert.equal(h.calls.length, 3);
    assert.ok(h.calls.every(c => c.logicalCallId && c.attemptId && c.role === 'compression-auxiliary'));
  } finally { await h.close(); }
});

test('edits allocate a new source version; corruption fails exact recovery instead of returning guessed text', async () => {
  const h = await harness();
  try {
    const raw = messages();
    const p = await prepare(h, raw); await finish(h, p, '1');
    const edited = raw.map(m => ({ ...m })); edited[1].text = 'Corrected fact with another exact version';
    const p2 = await prepare(h, edited); await finish(h, p2, '2');
    const p3 = await prepare(h, edited); await finish(h, p3, '3');
    const statuses = await storedSessions(h);
    assert.equal(statuses[0].value.originals.length, raw.length + 1);
    assert.equal((await h.dispatch('retrieve', { ref: 'm00002' }) as JsonRecord).text, raw[1].text);
    const objects = await h.store.list<{ value: CoreMessage }>('context.objects');
    const damaged = objects.find(r => r.value.value.id === raw[0].id)!;
    await h.store.put('context.objects', damaged.id, { ...damaged.value, value: { ...damaged.value.value, text: 'corruption' } }, damaged.revision);
    await assert.rejects(h.dispatch('recover'), /完整性/);
  } finally { await h.close(); }
});

test('epoch changes wait for in-flight leases and route changes cannot borrow old warm state', async () => {
  const h = await harness();
  try {
    const p = await prepare(h);
    await h.dispatch('epochs', { operation: 'stage', system: 'new persona' });
    await assert.rejects(h.dispatch('epochs', { operation: 'commit' }), /发送中的/);
    await assert.rejects(prepare(h, messages(), { route: { ...route, modelId: 'different' } }), /切换路由/);
    await finish(h, p, 'old');
    await h.dispatch('epochs', { operation: 'commit' });
    const next = await prepare(h, messages(), { system: 'new persona', route: { ...route, modelId: 'different' } });
    assert.ok(((next.epochs as JsonRecord).routeEpoch as number) > ((p.epochs as JsonRecord).routeEpoch as number));
  } finally { await h.close(); }
});

test('economics never fills context to target, unknown remains discretion, hard-window safety wins', () => {
  const unknown = planFold({ contextTokens: 1000, hardWindowTokens: 10000, outputReserveTokens: 100,
    removableTokens: 500, summaryTokens: 50 });
  assert.equal(unknown.decision, 'model-discretion');
  assert.equal(unknown.estimatedOneTimeCost, null);
  assert.equal(planFold({ contextTokens: 9900, hardWindowTokens: 10000, outputReserveTokens: 100,
    removableTokens: 500, summaryTokens: 50 }).decision, 'compress-required');
  assert.equal(compareBytes('中文a', '中文b').prefixBytes, Buffer.byteLength('中文'));
});

const nativeNodes = (): NativeSurfaceNode[] => Array.from({ length: 8 }, (_, i) => ({
  seq: i, message: { id: `native-${i}`, role: i % 2 === 0 ? 'user' : 'assistant',
    source: i % 2 === 0 ? { kind: 'user' } : { kind: 'model', provider: 'fixture', model: 'fixture' },
    content: [{ type: 'text', text: `Native exact source ${i}; unique-native-${i}; ` + 'consumed detail '.repeat(50) }] },
}));

const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';

function nativeSourceEvents(nodes: NativeSurfaceNode[]): JsonRecord[] {
  return nodes.map(({ seq, message }) => ({
    type: message.role === 'user' ? 'user/message' : `${message.role}/message`,
    seq, time: 1700000000000 + seq, surfaceOp: 'append',
    data: message.role === 'user' ? message : { message },
  }));
}

/** The pinned official backend frames the summary in three content segments
 * and correlates the replacement with both transaction markers and sources. */
function officialCompaction(input: {
  compactionId: string; summary: string; sourceSeqs: number[]; startSeq: number;
  checkpointId?: string; sourceCommandId?: string; turn?: number | null;
}) {
  const { compactionId, summary, sourceSeqs, startSeq } = input;
  assert.ok(sourceSeqs.length > 0);
  const command = input.sourceCommandId === undefined ? {} : { sourceCommandId: input.sourceCommandId };
  const lifecycle = { compactionId, ...command, turn: input.turn ?? null };
  const checkpoint: NativeSurfaceNode = {
    seq: startSeq + 2,
    message: {
      id: input.checkpointId ?? `${compactionId}-checkpoint`, role: 'user',
      source: { kind: 'compact-checkpoint', compactionId, ...command },
      content: [
        { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>` },
        { type: 'text', text: summary },
        { type: 'text', text: '</compacted-summary>' },
      ],
    },
  };
  const events: JsonRecord[] = [
    { type: 'compaction/start', seq: startSeq, time: 1700000000000 + startSeq, data: lifecycle },
    { type: 'compaction/summary', seq: startSeq + 1, time: 1700000000001 + startSeq, data: {
      compactionId, ...command, summary: [{ type: 'text', text: summary }],
      shadowedRange: { start: sourceSeqs[0], end: sourceSeqs.at(-1)! },
      shadowedSeqs: sourceSeqs, shadowedTokenCount: 600,
      provider: route.providerId, model: route.modelId,
    } },
    { type: 'user/message', seq: checkpoint.seq, time: 1700000000002 + startSeq,
      data: checkpoint.message,
      surfaceOp: { op: 'replace', startSeq: sourceSeqs[0], endSeq: sourceSeqs.at(-1)! },
      sourceEventSeqs: [startSeq, startSeq + 1, ...sourceSeqs] },
    { type: 'compaction/end', seq: startSeq + 3, time: 1700000000003 + startSeq, data: lifecycle },
  ];
  return { events, checkpoint };
}

test('native conversion retains tool JSON bytes, source, replay state and opaque media; seqs follow surface order', () => {
  const nodes: NativeSurfaceNode[] = [
    { seq: 80, message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'x', replayState: { signature: 'opaque' } },
      content: [{ type: 'reasoning', text: 'private reasoning shape' }, { type: 'tool-call', id: 'call', name: 'shell', arguments: '{ "key" : 1 }' }] } },
    { seq: 4, message: { id: 'b', role: 'tool', toolCallId: 'call', source: { kind: 'tool', callId: 'call' },
      content: [{ type: 'text', text: 'result' }, { type: 'image', image: { attachmentId: 'immutable-image' } }] } },
  ];
  const core = nativeToCore(nodes);
  assert.equal(core[1].text, '{ "key" : 1 }');
  assert.deepEqual(coreToNative(core), nodes.map(n => n.message));
  assert.equal(core.at(-1)!.nativeProtected, true);
  const span = nativeSpan(core, core.map(m => m.id));
  assert.equal(span.startSeq, 80);
  assert.equal(span.endSeq, 4);
  assert.deepEqual(span.sourceSeqs, [80, 4]);
  assert.throws(() => nativeSpan(core, [core[0].id]), /完整消息/);
});

test('native proposal never activates kernel before exact authoritative official commit; fabricated PASS rejected', async () => {
  const h = await harness();
  try {
    const nodes = nativeNodes();
    await assert.rejects(h.dispatch('native/sync', { nodes, route, windowTokens: 100000 }), /内部适配器/);
    await h.native('native/sync', { nodes, route, windowTokens: 100000, outputReserveTokens: 1000 });
    await h.dispatch('policy', { config: fixturePolicy });
    const proposal = await h.native('native/propose', { ranges: [{ startRef: 'm00001', endRef: 'm00002',
      summary: 'Exact consumed facts from the first two native messages; original source retained.' }] }) as JsonRecord;
    assert.equal((await h.dispatch('status') as JsonRecord).blocks instanceof Array, true);
    assert.equal(((await h.dispatch('status') as JsonRecord).blocks as unknown[]).length, 0);
    await assert.rejects(h.native('native/commit', { proposalId: proposal.proposalId, hostCompactionId: 'forged' }), /官方压缩替换/);
    const transaction = officialCompaction({ compactionId: 'official-c1', summary: proposal.summary as string,
      sourceSeqs: proposal.sourceSeqs as number[], startSeq: nodes.length });
    h.setHostEvents([...nativeSourceEvents(nodes), ...transaction.events]);
    const committed = await h.native('native/commit', { proposalId: proposal.proposalId, hostCompactionId: 'official-c1' }) as JsonRecord;
    assert.equal(committed.committed, true);
    assert.equal(((await h.dispatch('status') as JsonRecord).blocks as unknown[]).length, 1);
    assert.equal((await h.dispatch('retrieve', { ref: 'm00002' }) as JsonRecord).text, nodes[1].message.content[0].text);
    assert.equal((await h.native('native/commit', { proposalId: proposal.proposalId, hostCompactionId: 'official-c1' }) as JsonRecord).idempotent, true);
  } finally { await h.close(); }
});

test('official manual compaction imports exact original sources and is idempotent without inventing model calls', async () => {
  const h = await harness();
  try {
    const nodes = nativeNodes();
    await h.native('native/sync', { nodes, route, windowTokens: 100000, outputReserveTokens: 1000 });
    const text = 'Official user-requested manual summary with persistent exact recovery.';
    const transaction = officialCompaction({ compactionId: 'manual-c1', summary: text,
      sourceSeqs: [0, 1], startSeq: nodes.length, sourceCommandId: 'manual-command-c1' });
    h.setHostEvents([...nativeSourceEvents(nodes), ...transaction.events]);
    const imported = await h.native('native/import', { hostCompactionId: 'manual-c1' }) as JsonRecord;
    assert.equal(imported.imported, true);
    assert.equal((await h.dispatch('retrieve', { ref: 'm00002' }) as JsonRecord).text, nodes[1].message.content[0].text);
    assert.equal((await h.native('native/import', { hostCompactionId: 'manual-c1' }) as JsonRecord).idempotent, true);
    assert.equal(((await h.dispatch('status') as JsonRecord).blocks as unknown[]).length, 1);
    assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

for (const action of ['native/commit', 'native/import'] as const) {
  for (const corruption of ['body', 'source-id', 'source-kind', 'missing-start', 'source-event-seqs'] as const) {
    test(`${action} rejects authoritative checkpoint with invalid ${corruption}`, async () => {
      const h = await harness();
      try {
        const nodes = nativeNodes();
        await h.native('native/sync', { nodes, route, windowTokens: 100000, outputReserveTokens: 1000 });
        await h.dispatch('policy', { config: fixturePolicy });
        const proposal = action === 'native/commit'
          ? await h.native('native/propose', { ranges: [{ startRef: 'm00001', endRef: 'm00002',
            summary: 'Exact source facts for a strict official checkpoint.' }] }) as JsonRecord : undefined;
        const hostCompactionId = `strict-${action.replace('/', '-')}-${corruption}`;
        const transaction = officialCompaction({
          compactionId: hostCompactionId,
          summary: (proposal?.summary ?? 'Exact source facts for a strict official checkpoint.') as string,
          sourceSeqs: (proposal?.sourceSeqs ?? [0, 1]) as number[], startSeq: nodes.length,
        });
        let events = [...nativeSourceEvents(nodes), ...transaction.events];
        const replacement = events.find(event => event.seq === transaction.checkpoint.seq)!;
        const checkpoint = replacement.data as JsonRecord;
        if (corruption === 'body') (checkpoint.content as JsonRecord[])[1].text = 'Different checkpoint body.';
        else if (corruption === 'source-id') (checkpoint.source as JsonRecord).compactionId = 'another-transaction';
        else if (corruption === 'source-kind') (checkpoint.source as JsonRecord).kind = 'compaction';
        else if (corruption === 'source-event-seqs') replacement.sourceEventSeqs = [transaction.checkpoint.seq];
        else events = events.filter(event => event.type !== 'compaction/start');
        h.setHostEvents(events);
        await assert.rejects(h.native(action, { hostCompactionId,
          ...(proposal ? { proposalId: proposal.proposalId } : {}) }),
          (error: unknown) => (error as { code?: string }).code === 'CTX_NATIVE_COMMIT_UNPROVEN');
        assert.equal(((await h.dispatch('status') as JsonRecord).blocks as unknown[]).length, 0);
        assert.equal(h.calls.length, 0);
      } finally { await h.close(); }
    });
  }
}

test('native commit recovers an already persisted kernel state after its final proposal receipt fails', async () => {
  const h = await harness();
  try {
    const nodes = nativeNodes();
    await h.native('native/sync', { nodes, route, windowTokens: 100000, outputReserveTokens: 1000 });
    await h.dispatch('policy', { config: fixturePolicy });
    const proposal = await h.native('native/propose', { ranges: [{ startRef: 'm00001', endRef: 'm00002',
      summary: 'One durable fold; recovering its receipt must preserve its exact original sources.' }] }) as JsonRecord;
    const hostCompactionId = 'receipt-interrupted-c1';
    const transaction = officialCompaction({ compactionId: hostCompactionId, summary: proposal.summary as string,
      sourceSeqs: proposal.sourceSeqs as number[], startSeq: nodes.length });
    h.setHostEvents([...nativeSourceEvents(nodes), ...transaction.events]);
    h.store.failNextPut = (collection, id, value) => collection === 'context.nativeProposals'
      && id === proposal.proposalId && (value as JsonRecord).status === 'committed';
    await assert.rejects(h.native('native/commit', { proposalId: proposal.proposalId, hostCompactionId }));
    assert.equal(h.store.failNextPut, undefined, 'the failure must occur at the final proposal receipt');
    const afterFailure = (await storedSessions(h))[0].value;
    assert.equal(afterFailure.state.blocks.length, 1, 'the kernel state has already committed');
    assert.equal(afterFailure.state.stats.compressionCount, 1);
    assert.equal(afterFailure.folds.length, 1);
    const stableEffects = {
      compressionEpoch: afterFailure.epochs.compressionEpoch,
      stats: afterFailure.state.stats, folds: afterFailure.folds,
    };
    const pending = await h.store.get<JsonRecord>('context.nativeProposals', proposal.proposalId as string);
    assert.ok(pending);
    assert.notEqual(pending.value.status, 'committed');
    assert.notEqual(pending.value.status, 'aborted', 'a landed official replacement remains recoverable');
    h.restart();
    const recovered = await h.dispatch('recover') as JsonRecord;
    assert.equal(recovered.integrity, 'verified');
    const receipt = await h.store.get<JsonRecord>('context.nativeProposals', proposal.proposalId as string);
    assert.equal(receipt?.value.status, 'committed');
    assert.equal(receipt?.value.hostCompactionId, hostCompactionId);
    assert.equal(receipt?.value.replacementMessageId, transaction.checkpoint.message.id);
    const afterRecovery = (await storedSessions(h))[0].value;
    assert.equal(afterRecovery.state.blocks.length, 1);
    assert.deepEqual({
      compressionEpoch: afterRecovery.epochs.compressionEpoch,
      stats: afterRecovery.state.stats, folds: afterRecovery.folds,
    }, stableEffects);
    assert.equal((await h.native('native/commit', {
      proposalId: proposal.proposalId, hostCompactionId,
    }) as JsonRecord).idempotent, true);
    assert.equal((await h.dispatch('retrieve', { ref: 'm00002' }) as JsonRecord).text, nodes[1].message.content[0].text);
    assert.equal(h.calls.length, 0, 'receipt recovery never repeats the paid summary decision');
  } finally { await h.close(); }
});

test('importing only a later official checkpoint recursively imports its missing ancestor and all exact leaf sources', async () => {
  const h = await harness();
  try {
    const nodes = nativeNodes();
    const c1 = officialCompaction({ compactionId: 'ancestor-c1',
      summary: 'First official checkpoint covering the first two original messages.',
      sourceSeqs: [0, 1], startSeq: nodes.length });
    const c2 = officialCompaction({ compactionId: 'ancestor-c2',
      summary: 'Second official checkpoint includes the earlier checkpoint and the next original message.',
      sourceSeqs: [c1.checkpoint.seq, 2], startSeq: nodes.length + c1.events.length });
    h.setHostEvents([...nativeSourceEvents(nodes), ...c1.events, ...c2.events]);
    // The plugin first sees the final surface. Neither ancestor leaf nor its
    // receipt has previously passed through Nexus ingestion.
    await h.native('native/sync', { nodes: [c2.checkpoint, ...nodes.slice(3)],
      route, windowTokens: 100000, outputReserveTokens: 1000 });
    const imported = await h.native('native/import', { hostCompactionId: 'ancestor-c2' }) as JsonRecord;
    assert.equal(imported.imported, true);
    const receipts = await h.store.list<JsonRecord>('context.nativeProposals');
    const first = receipts.find(receipt => receipt.value.hostCompactionId === 'ancestor-c1');
    const second = receipts.find(receipt => receipt.value.hostCompactionId === 'ancestor-c2');
    assert.equal(first?.value.status, 'committed');
    assert.equal(second?.value.status, 'committed');
    const status = await h.dispatch('status') as JsonRecord;
    const blocks = status.blocks as { blockId: string; tier: number; active: boolean; directBlockIds: string[] }[];
    assert.equal(blocks.length, 2);
    const parent = blocks.find(block => block.blockId === imported.blockId)!;
    assert.deepEqual(parent.directBlockIds, [first!.value.blockId]);
    assert.equal(parent.tier, 2);
    assert.equal(blocks.find(block => block.blockId === first!.value.blockId)!.active, false);
    const recovered = await h.dispatch('decompress', { blockId: imported.blockId, mode: 'peek', full: true }) as JsonRecord;
    assert.deepEqual(new Set((recovered.messages as CoreMessage[]).map(message => message.text)),
      new Set(nodes.slice(0, 3).map(node => node.message.content[0].text)));
    for (const node of nodes.slice(0, 3)) {
      const exact = await h.dispatch('retrieve', { ref: node.message.id }) as JsonRecord;
      assert.equal(exact.text, node.message.content[0].text);
      assert.deepEqual(exact.nativeMessage, node.message);
    }
    h.restart();
    assert.equal((await h.native('native/import', { hostCompactionId: 'ancestor-c2' }) as JsonRecord).idempotent, true);
    assert.equal(((await h.dispatch('status') as JsonRecord).blocks as unknown[]).length, 2);
    assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test('external CCR storage preserves exact retrieval and stable replay without folding a tiny tool result', async () => {
  const h = await harness();
  try {
    const largeText = 'Exact original tool output; 中文; emoji 🧭; ' + 'line of output\n'.repeat(500);
    const raw: CoreMessage[] = [
      { id: 'ccr-call-large', role: 'assistant', contentType: 'tool-call', toolCallId: 'call-large',
        toolName: 'bash', text: '{ "command" : "cat large-output.txt" }' },
      { id: 'ccr-result-large', role: 'tool', contentType: 'tool-result', toolCallId: 'call-large',
        toolName: 'bash', text: largeText },
      { id: 'ccr-call-tiny', role: 'assistant', contentType: 'tool-call', toolCallId: 'call-tiny',
        toolName: 'bash', text: '{ "command" : "printf ok" }' },
      { id: 'ccr-result-tiny', role: 'tool', contentType: 'tool-result', toolCallId: 'call-tiny',
        toolName: 'bash', text: 'ok' },
      { id: 'ccr-tail', role: 'user', contentType: 'text', text: 'Continue using the exact tool result when needed.' },
    ];
    const extra = { renderTags: 'none', config: { ...fixturePolicy,
      ccr: { enabled: true, minToolTokens: 100, toolName: 'acp_retrieve', excludeTools: [], maxHeadChars: 48 } } };
    const first = await prepare(h, raw, extra);
    const firstView = first.messages as CoreMessage[];
    const placeholder = firstView.find(message => message.id === 'ccr-result-large')!.text!;
    const parsed = parseStoredPlaceholder(placeholder);
    assert.ok(parsed, 'the large result must use a real kernel CCR placeholder');
    assert.equal(firstView.find(message => message.id === 'ccr-result-tiny')!.text, 'ok');
    await finish(h, first, 'external-ccr-first');
    const stored = (await storedSessions(h))[0].value;
    assert.deepEqual(stored.contentStore.byHash, {}, 'mutable session envelopes contain no original CCR bodies');
    assert.equal(stored.contentStore.byRef[parsed.ref].rawId, 'ccr-result-large');
    const tinyRef = stored.state.messageRefs.byRaw['ccr-result-tiny'];
    assert.equal(stored.contentStore.byRef[tinyRef], undefined, 'below-threshold tool output is not marked stored');
    const external = await h.store.list<{ hash: string; text: string }>('context.contents');
    assert.ok(external.some(record => record.value.text === largeText));
    h.restart();
    const second = await prepare(h, raw, extra);
    const secondView = second.messages as CoreMessage[];
    assert.equal(secondView.find(message => message.id === 'ccr-result-large')!.text, placeholder,
      'retransmitted raw bytes replay the exact arrival placeholder after restart');
    assert.equal(secondView.find(message => message.id === 'ccr-result-tiny')!.text, 'ok',
      'the second turn must not acquire a placeholder solely from incidental original persistence');
    await finish(h, second, 'external-ccr-second');
    const beforeRetrieval = (await storedSessions(h))[0].value;
    const source = beforeRetrieval.originals.find(original => original.id === 'ccr-result-large')!;
    h.store.reads.length = 0;
    const exact = await h.dispatch('retrieve', { ref: parsed.ref }) as JsonRecord;
    assert.equal(exact.text, largeText);
    assert.equal(exact.exact, true);
    assert.deepEqual(exact.originalMessage, raw[1]);
    assert.deepEqual(h.store.reads.filter(read => read.collection === 'context.objects').map(read => read.id),
      [source.objectId], 'one requested ref reads only its own original object');
    const afterRetrieval = (await storedSessions(h))[0].value;
    assert.deepEqual(afterRetrieval.contentStore.byHash, {});
    assert.deepEqual(afterRetrieval.state, beforeRetrieval.state, 'exact retrieval does not mutate the prior context projection');
    const stats = (await h.dispatch('status') as JsonRecord).contentStore as JsonRecord;
    assert.ok(Number(stats.uniqueContents) >= 1);
    assert.ok(Number(stats.totalChars) >= largeText.length);
  } finally { await h.close(); }
});

test('native tools deliver inline and expanded originals at the tool tail while preserving the committed checkpoint', async () => {
  const h = await harness();
  try {
    const nodes = nativeNodes();
    await h.native('native/sync', { nodes, route, windowTokens: 100000, outputReserveTokens: 1000 });
    const transaction = officialCompaction({ compactionId: 'native-tool-restore',
      summary: 'Official checkpoint remains in its existing prefix position during source retrieval.',
      sourceSeqs: [0, 1], startSeq: nodes.length });
    h.setHostEvents([...nativeSourceEvents(nodes), ...transaction.events]);
    const imported = await h.native('native/import', { hostCompactionId: 'native-tool-restore' }) as JsonRecord;
    const originalLog = h.getHostEvents();
    const stateBeforePeek = (await storedSessions(h))[0].value.state;
    const peek = await h.tool('decompress', { blockId: imported.blockId, mode: 'peek', full: true }) as JsonRecord;
    assert.equal(peek.projectionChanged, false);
    assert.deepEqual((await storedSessions(h))[0].value.state, stateBeforePeek);
    for (const mode of ['inline', 'expand']) {
      const result = await h.tool('decompress', { blockId: imported.blockId, mode, full: true }) as JsonRecord;
      assert.equal(result.delivery, 'tool-result-tail');
      assert.equal(result.oldPrefixChanged, false);
      assert.equal(result.nativeReplayRestored, false);
      assert.deepEqual(result.nativeMessages, nodes.slice(0, 2).map(node => node.message));
      assert.deepEqual((result.messages as CoreMessage[]).map(message => message.text),
        nodes.slice(0, 2).map(node => node.message.content[0].text));
      const session = (await storedSessions(h))[0].value;
      const block = session.state.blocks.find(candidate => candidate.blockId === imported.blockId)!;
      assert.equal(block.active, true);
      assert.equal(block.restoredInline, true);
      assert.notEqual(block.expanded, true);
    }
    assert.equal(h.sessionCalls.filter(call => call.action === 'context.restore').length, 0,
      'a native tool result already provides the original-data tail delivery');
    assert.deepEqual(h.getHostEvents(), originalLog, 'retrieval does not rewrite the authoritative checkpoint');
    assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test('UI restoration injects exact source JSON durably after the domain lock, and peek injects nothing', { timeout: 10000 }, async () => {
  const h = await harness();
  try {
    const nodes = nativeNodes();
    await h.native('native/sync', { nodes, route, windowTokens: 100000, outputReserveTokens: 1000 });
    const transaction = officialCompaction({ compactionId: 'ui-tail-restore',
      summary: 'The original prefix checkpoint remains durable while UI retrieval appends exact source data.',
      sourceSeqs: [0, 1], startSeq: nodes.length });
    h.setHostEvents([...nativeSourceEvents(nodes), ...transaction.events]);
    const imported = await h.native('native/import', { hostCompactionId: 'ui-tail-restore' }) as JsonRecord;
    const originalLog = h.getHostEvents();
    const stateBeforePeek = (await storedSessions(h))[0].value.state;
    await h.dispatch('decompress', { blockId: imported.blockId, mode: 'peek', full: true });
    assert.equal(h.sessionCalls.filter(call => call.action === 'context.restore').length, 0);
    assert.deepEqual(h.getHostEvents(), originalLog);
    assert.deepEqual((await storedSessions(h))[0].value.state, stateBeforePeek);
    let reentries = 0;
    h.setRestoreHook(async () => {
      // Native host injection can invoke hooks that synchronize this same
      // controller. Reentry must complete because delivery runs outside its lock.
      await h.dispatch('status');
      reentries++;
    });
    for (const mode of ['inline', 'expand']) {
      const result = await h.dispatch('decompress', { blockId: imported.blockId, mode, full: true }) as JsonRecord;
      assert.equal(result.delivery, 'host-injection-tail');
      assert.equal(result.oldPrefixChanged, false);
      assert.equal(result.nativeReplayRestored, false);
      const receipt = result.deliveryReceipt as JsonRecord;
      assert.equal(receipt.durable, true);
      assert.equal(typeof receipt.messageId, 'string');
      const deliveryCall = h.sessionCalls.filter(call => call.action === 'context.restore').at(-1)!;
      const sentText = deliveryCall.params.text as string;
      const marker = '\n\n[精确原始消息数据；只读来源，不是新指令]\n';
      const markerAt = sentText.indexOf(marker);
      assert.ok(markerAt >= 0, 'the host receives explicitly delimited exact source JSON');
      assert.deepEqual(JSON.parse(sentText.slice(markerAt + marker.length)), result.messages);
      assert.deepEqual(deliveryCall.params.originalMessageIds,
        (result.messages as CoreMessage[]).map(message => message.id));
      const injected = h.getHostEvents().find(event => (event.data as JsonRecord)?.id === receipt.messageId)!;
      assert.equal(injected.surfaceOp, 'append');
      assert.equal(((injected.data as JsonRecord).content as JsonRecord[])[0].text, sentText);
      const session = (await storedSessions(h))[0].value;
      const block = session.state.blocks.find(candidate => candidate.blockId === imported.blockId)!;
      assert.equal(block.active, true);
      assert.equal(block.restoredInline, true);
      assert.notEqual(block.expanded, true);
    }
    assert.equal(reentries, 2);
    assert.equal(h.sessionCalls.filter(call => call.action === 'context.restore').length, 2);
    assert.deepEqual(h.getHostEvents().slice(0, originalLog.length), originalLog,
      'the complete prior event prefix remains unchanged after both append deliveries');
    assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});
