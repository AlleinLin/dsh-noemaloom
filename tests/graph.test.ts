import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraphModule } from '../src/domain/graph/index.js';
import { parseHistory } from '../src/domain/graph/history-parser.js';
import { readIncrementalHistory } from '../src/domain/graph/history-reader.js';
import { hash, sha256 } from '../src/upstream/thoughtdag/graph.js';
import { scanZstdFrames } from '../src/upstream/thoughtdag/zstd.js';
import { NexusError, type NexusServices, type NexusStore, type StoredRecord } from '../src/ports/contracts.js';
import type { GraphDocument, HistorySource } from '../src/domain/graph/types.js';

function fixture() {
  const rows = new Map<string, StoredRecord>();
  const store: NexusStore = {
    async get<T>(collection: string, id: string) { const row = rows.get(`${collection}:${id}`); return row ? structuredClone(row) as StoredRecord<T> : undefined; },
    async list<T>(collection: string) { return [...rows].filter(([key]) => key.startsWith(`${collection}:`)).map(([, row]) => structuredClone(row) as StoredRecord<T>); },
    async put<T>(collection: string, id: string, value: T, expectedRevision?: number) {
      const key = `${collection}:${id}`, previous = rows.get(key);
      if (expectedRevision !== undefined && expectedRevision !== (previous?.revision ?? 0)) throw new NexusError('CTX-REVISION-CONFLICT', 'fixture CAS conflict');
      const record = { id, value: structuredClone(value), revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
      rows.set(key, record); return structuredClone(record);
    },
    async remove(collection: string, id: string, expectedRevision?: number) {
      const key = `${collection}:${id}`, previous = rows.get(key);
      if (expectedRevision !== undefined && expectedRevision !== previous?.revision) throw new NexusError('CTX-REVISION-CONFLICT', 'fixture CAS conflict');
      return rows.delete(key);
    },
  };
  const calls: unknown[] = [];
  const services: NexusServices = {
    store, dataDir: 'D:/fixture/data', workspaceRoot: 'D:/fixture/project',
    executor: { async run() { throw new Error('No shell is expected in graph fixture'); } },
    host: {
      async facts() { return {}; },
      async model(request) { calls.push(request); return { text: 'Evidence based result [S1]', provider: 'fixture', model: 'fixture-model', usage: { inputTokens: 10, outputTokens: 8 } }; },
      async spawn() { throw new Error('No child expected'); },
      async sessions() { throw new Error('No host session mutation expected'); },
      async secret() { return undefined; }, async approve() { return true; },
    },
    emit() {}, async invoke() { throw new Error('No cross-domain call expected'); },
  };
  const module = createGraphModule(services);
  const call = async (action: string, params: Record<string, unknown> = {}, expectedRevision?: number): Promise<any> => module.dispatch({ action, params, expectedRevision });
  const create = async () => (await call('create', { title: 'Fixture' })).id as string;
  const add = async (graphId: string, question: string, answer = `${question} answer`) => (await call('node.add', { graphId, question, answer })).result.id as string;
  return { module, services, store, calls, call, create, add };
}

test('CTX-GRF-001: context and reference-full cycles reject atomically with a path', async () => {
  const f = fixture(), graphId = await f.create();
  const a = await f.add(graphId, 'A'), b = await f.add(graphId, 'B'), c = await f.add(graphId, 'C');
  await f.call('wire', { graphId, from: a, to: b });
  await f.call('wire', { graphId, from: b, to: c });
  const before = await f.call('get', { graphId });
  await assert.rejects(f.call('wire', { graphId, from: c, to: a, kind: 'reference', contextMode: 'full' }), (error: any) => {
    assert.equal(error.code, 'CTX-GRAPH-CYCLE'); assert.deepEqual(error.details.path, [c, a, b, c]); return true;
  });
  const after = await f.call('get', { graphId });
  assert.equal(after.revision, before.revision); assert.equal(after.edges.length, 2);
  await assert.rejects(f.call('wire', { graphId, from: a, to: a }), { code: 'CTX-GRAPH-CYCLE' });
});

test('CTX-GRF-002/004: diamond ancestors deduplicate, explicit merge order and layout do not drift preview', async () => {
  const f = fixture(), graphId = await f.create();
  const a = await f.add(graphId, 'A'), b = await f.add(graphId, 'B'), c = await f.add(graphId, 'C'), d = await f.add(graphId, 'D');
  for (const [from, to, order] of [[a, b, 0], [a, c, 0], [b, d, 20], [c, d, 10]] as [string, string, number][]) await f.call('wire', { graphId, from, to, order });
  const plan = await f.call('context.preview', { graphId, nodeId: d });
  assert.equal(plan.messages.filter((message: any) => message.content === 'A answer').length, 1);
  const answers = plan.messages.filter((message: any) => message.role === 'assistant').map((message: any) => message.content);
  assert.deepEqual(answers, ['A answer', 'C answer', 'B answer']);
  const before = await f.call('get', { graphId });
  await f.call('layout', { graphId, nodes: [{ id: a, x: 9_999, y: -20, collapsed: true }] });
  const after = await f.call('get', { graphId }), next = await f.call('context.preview', { graphId, nodeId: d });
  assert.equal(after.revision, before.revision); assert.equal(after.semanticRevision, before.semanticRevision);
  assert.equal(next.semanticHash, plan.semanticHash); assert.equal(after.nodes.find((node: any) => node.id === a).x, 9_999);
});

test('CTX-GRF-003/PLAN-001: unlink affects next plan, source edit rejects stale preview and preserves old answer', async () => {
  const f = fixture(), graphId = await f.create(), a = await f.add(graphId, 'A'), b = await f.add(graphId, 'B');
  const edge = (await f.call('wire', { graphId, from: a, to: b })).result;
  const plan = await f.call('context.preview', { graphId, nodeId: b });
  await f.call('node.update', { graphId, nodeId: a, patch: { answer: 'Changed A' } });
  await assert.rejects(f.call('generate', { graphId, nodeId: b, planId: plan.id }), { code: 'CTX-PLAN-STALE' });
  assert.equal(f.calls.length, 0);
  await f.call('unlink', { graphId, edgeId: edge.id });
  const next = await f.call('context.preview', { graphId, nodeId: b }), graph = await f.call('get', { graphId });
  assert.deepEqual(next.messages.map((message: any) => message.content), ['B']);
  assert.equal(graph.nodes.find((node: any) => node.id === a).versions.length, 2);
});

test('real model generation stores a version, usage attempt evidence and durable idempotency', async () => {
  const f = fixture(), graphId = await f.create(), nodeId = await f.add(graphId, 'Question');
  const plan = await f.call('context.preview', { graphId, nodeId });
  const params = { graphId, nodeId, planId: plan.id, idempotencyKey: 'model-once' };
  const first = await f.call('generate', params), duplicate = await f.call('generate', params);
  assert.equal(first.operationId, duplicate.operationId); assert.equal(f.calls.length, 1);
  const graph = await f.call('get', { graphId }), node = graph.nodes.find((item: any) => item.id === nodeId);
  assert.equal(node.versions.length, 2); assert.equal(node.versions.at(-1).stale, false);
  assert.equal(node.versions.at(-1).usageRequestIds.length, 2);
  assert.equal((await f.store.list('graph-model-evidence')).length, 1);
  await assert.rejects(f.call('generate', { ...params, model: 'different' }), { code: 'CTX-IDEMPOTENCY-CONFLICT' });
});

test('CTX-PLAN-001: a source edit while the model runs saves orphan candidate without overwriting target', async () => {
  const f = fixture(), graphId = await f.create(), a = await f.add(graphId, 'A'), b = await f.add(graphId, 'B');
  await f.call('wire', { graphId, from: a, to: b });
  let entered!: () => void, complete!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { complete = resolve; });
  f.services.host.model = async request => { f.calls.push(request); entered(); await gate; return { text: 'Late answer', usage: { outputTokens: 2 } }; };
  const pending = f.call('generate', { graphId, nodeId: b });
  await started; await f.call('node.update', { graphId, nodeId: a, patch: { answer: 'Edited during generation' } }); complete();
  await assert.rejects(pending, { code: 'CTX-PLAN-STALE' });
  const graph = await f.call('get', { graphId });
  assert.equal(graph.nodes.find((node: any) => node.id === b).versions.length, 1);
  assert.equal((await f.store.list('graph-orphan-results')).length, 1);
  assert.equal((await f.store.list('graph-model-evidence')).length, 1);
});

test('CTX-XFM-001: condense generates a complete independent copy, preserving original graph', async () => {
  const f = fixture(), graphId = await f.create(), nodes: string[] = [];
  for (let i = 0; i < 7; i++) {
    const id = await f.add(graphId, `Question ${i}`, `Fact ${i} ${'detail '.repeat(20)}`); nodes.push(id);
    if (i) await f.call('wire', { graphId, from: nodes[i - 1], to: id });
  }
  const preview = await f.call('condense.preview', { graphId });
  assert.equal(preview.segments.length, 1); assert.equal(preview.segments[0].nodeIds.length, 4);
  const result = await f.call('condense', { graphId });
  assert.equal(result.result.collapsedRuns, 1); assert.equal(result.result.copiedNodes, 4); assert.equal(f.calls.length, 1);
  const graph = await f.call('get', { graphId });
  for (const id of nodes) assert.ok(graph.nodes.some((node: any) => node.id === id));
  const copyTail = result.result.mapping[nodes.at(-1)!];
  const plan = await f.call('context.preview', { graphId, nodeId: copyTail });
  assert.ok(plan.items.filter((item: any) => item.kind === 'assistant').every((item: any) => !nodes.includes(item.includedBecause.nodeId)));
  await f.call('undo', { graphId });
  assert.equal((await f.call('get', { graphId })).nodes.length, 7);
  assert.equal((await f.call('operation.list', { graphId }))[0].modelCalls, 1);
});

test('CTX-XFM-003: Weave rejects empty/invalid highlights, accepts exact selected text with citation', async () => {
  const f = fixture(), graphId = await f.create(), nodeId = await f.add(graphId, 'Q', 'A selected fact. Another fact.');
  await assert.rejects(f.call('weave', { graphId, highlightIds: [] }), { code: 'CTX-WEAVE-EMPTY' });
  assert.equal(f.calls.length, 0);
  const highlight = (await f.call('highlight.add', { graphId, nodeId, start: 2, end: 15, kind: 'decision' })).result;
  f.services.host.model = async request => { f.calls.push(request); assert.match(request.prompt, /selected fact/); return { text: 'Woven selected fact [H1]' }; };
  const result = await f.call('weave', { graphId, highlightIds: [highlight.id] });
  assert.equal(result.result.citations[0].source.contentHash, sha256('selected fact'));
  assert.equal(result.result.node.derivedFrom.length, 1);
});

test('CTX-WHY-001/002: observed tool changes remain separate from candidate explanation and scoped projects', async () => {
  const f = fixture();
  const source = await f.call('atlas.source.upsert', { id: 'fixture-canvas', kind: 'canvas', authorized: true, projectRoots: ['D:/fixture/project', 'D:/other/project'] });
  await f.call('atlas.ingest', { sourceId: source.id, externalId: 'one', projectRoot: 'D:/fixture/project', records: [
    { id: 't1', question: 'Change target', answer: 'file.ts was changed because I guessed.', tools: [{ callId: 'c1', name: 'edit', arguments: { path: 'file.ts', oldText: 'a', newText: 'b' }, result: 'edited' }] },
  ], complete: true });
  await f.call('atlas.ingest', { sourceId: source.id, externalId: 'private-other', projectRoot: 'D:/other/project', records: [
    { id: 't2', question: 'Other private project', answer: 'file.ts secret-project-text', tools: [{ callId: 'c2', name: 'write', arguments: { path: 'file.ts' } }] },
  ], complete: true });
  const check = await f.call('why.check', { path: 'file.ts' }), result = await f.call('why.file', { path: 'file.ts' });
  assert.equal(check.history, true); assert.equal(check.count, 1); assert.equal(result.items.length, 1);
  assert.equal(result.items[0].observedChanges[0].evidence, 'observed');
  assert.equal(result.items[0].candidateExplanation[0].verifiedReason, false);
  assert.doesNotMatch(JSON.stringify(result), /secret-project-text/);
  await f.call('atlas.source.remove', { sourceId: source.id });
  assert.equal((await f.call('why.check', { path: 'file.ts' })).history, false);
});

test('Atlas preserves an edited mirror on source rewrite and persistent hide across ingestion', async () => {
  const f = fixture(), graphId = await f.create();
  await f.call('atlas.source.upsert', { id: 'source', kind: 'canvas', authorized: true, projectRoots: ['D:/fixture/project'] });
  const imported = await f.call('atlas.ingest', { sourceId: 'source', externalId: 'session', records: [{ id: 't1', question: 'Q', answer: 'First' }], complete: true });
  const mounted = await f.call('atlas.mount', { graphId, sessionId: imported.id });
  const nodeId = mounted.mapping.t1;
  await f.call('node.update', { graphId, nodeId, patch: { answer: 'User override' } });
  await f.call('atlas.ingest', { sourceId: 'source', externalId: 'session', records: [{ id: 't1', question: 'Q', answer: 'Rewritten source' }], complete: true });
  await f.call('atlas.remirror', { graphId, sessionId: imported.id });
  const node = (await f.call('get', { graphId })).nodes.find((item: any) => item.id === nodeId);
  assert.equal(node.versions.find((version: any) => version.id === node.activeVersionId).text, 'User override');
  await f.call('atlas.hide', { sessionId: imported.id });
  await f.call('atlas.ingest', { sourceId: 'source', externalId: 'session', records: [{ id: 't1', question: 'Q', answer: 'Third' }], complete: true });
  assert.equal((await f.call('atlas.list')).items.length, 0);
});

test('native fork validates the exact completed turn and uses the host revision instead of the parser hash', async () => {
  const f = fixture(), graphId = await f.create();
  await f.call('atlas.source.upsert', { id: 'dsh-fixture', kind: 'dsh', authorized: true, projectRoots: ['D:/fixture/project'] });
  const imported = await f.call('atlas.ingest', { sourceId: 'dsh-fixture', externalId: 'native-session', records: [
    { seq: 1, type: 'user/message', data: { turn: 1, message: { role: 'user', source: { kind: 'user' }, content: 'Question' } } },
    { seq: 2, type: 'turn/end', data: { turn: 1 } },
  ], complete: true });
  let boundaryPresent = true, forks = 0;
  f.services.host.sessions = async (action, params) => {
    if (action === 'snapshot') return { id: 'native-session', revision: 'native-durable-revision',
      events: boundaryPresent ? [{ seq: 2, type: 'turn/end', data: { turn: 1 } }] : [{ seq: 2, type: 'agent/idle' }] };
    if (action === 'fork') {
      forks++;
      assert.equal(params.expectedRevision, 'native-durable-revision');
      assert.equal(params.sourceRevision, undefined);
      assert.equal(params.boundary, 2);
      return { sessionId: 'native-child' };
    }
    throw new Error(`unexpected ${action}`);
  };
  await f.call('session.fork', { graphId, sessionId: imported.id, turnId: '1' });
  const effects = await f.store.list<any>('graph-host-effects');
  assert.equal(effects[0].value.sourceRevision, imported.revision);
  assert.equal(effects[0].value.hostRevision, 'native-durable-revision');
  boundaryPresent = false;
  await assert.rejects(f.call('session.fork', { graphId, sessionId: imported.id, turnId: '1' }), { code: 'CTX-FORK-BOUNDARY' });
  assert.equal(forks, 1);
});

test('CTX-DAT-001: import validates full bundle before publishing, SHA and cycle failures retain original state', async () => {
  const f = fixture(), graphId = await f.create(), a = await f.add(graphId, 'A'), b = await f.add(graphId, 'B');
  await f.call('wire', { graphId, from: a, to: b });
  const exported = await f.call('export', { graphId, includeContent: true });
  const result = await f.call('import', { data: exported });
  assert.equal(result.graphs[0].nodes, 2); assert.notEqual(result.graphs[0].id, graphId);
  assert.equal(new Set(Object.values(result.mappings[0].nodes)).size, 2);
  const corrupted = structuredClone(exported); corrupted.graph.title = 'Tampered';
  await assert.rejects(f.call('import', { data: corrupted }), { code: 'CTX-HASH-MISMATCH' });
  const cyclic = structuredClone(exported.graph);
  cyclic.edges.push({ id: 'cycle', graphId, from: b, to: a, kind: 'conversation', contextMode: 'full', order: 0 });
  await assert.rejects(f.call('import', { data: cyclic }), { code: 'CTX-GRAPH-CYCLE' });
  assert.equal((await f.call('list')).items.length, 2);
});

test('history collectors retain complete JSONL records, skip hidden reasoning, pair tool results, preserve native trees', () => {
  const source: HistorySource = { schemaVersion: 1, id: 'claude', title: 'fixture', kind: 'claude-code', mode: 'authorized-file-import',
    enabled: true, authorized: true, projectRoots: ['D:/fixture/project'], excludes: [], createdAt: new Date().toISOString() };
  const records = [
    { type: 'user', uuid: 'q1', sessionId: 's', message: { role: 'user', content: 'Q' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'q1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE' }, { type: 'text', text: 'Answer' }, { type: 'tool_use', id: 'c', name: 'Read', input: { file_path: 'f.ts' } }] } },
    { type: 'user', uuid: 'r1', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: 'contents' }] } },
    { type: 'user', uuid: 'q2', parentUuid: 'a1', message: { role: 'user', content: 'Branch Q' } },
  ];
  const parsed = parseHistory(source, 's', `${records.map(row => JSON.stringify(row)).join('\n')}\n{"type":"partial"`);
  assert.equal(parsed.turns.length, 2); assert.equal(parsed.turns[0].tools[0].result, 'contents');
  assert.equal(parsed.turns[1].parentTurnId, parsed.turns[0].id); assert.equal(parsed.turns[0].answer, 'Answer');
  assert.doesNotMatch(JSON.stringify(parsed), /PRIVATE/); assert.equal(parsed.warnings.at(-1)?.offset, parsed.cursor);
});

test('zstd scanner returns complete frames and leaves torn tail without decoding unbounded output', () => {
  // Single-segment frame, one raw block with one byte "x", no checksum.
  const frame = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 1, 9, 0, 0, 120]);
  const bytes = new Uint8Array(frame.length * 2 - 2); bytes.set(frame); bytes.set(frame.subarray(0, frame.length - 2), frame.length);
  const result = scanZstdFrames(bytes);
  assert.equal(result.frames.length, 1); assert.equal(result.completeBytes, frame.length);
});

test('CTX-ATL-002: streaming append consumes only new complete lines and rebuilds a modified earlier prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-history-stream-fixture-'));
  try {
    const file = join(root, 'session.jsonl');
    const source: HistorySource = { schemaVersion: 1, id: 'stream', title: 'fixture', kind: 'canvas', mode: 'authorized-file-import',
      enabled: true, authorized: true, root, projectRoots: ['D:/fixture/project'], excludes: [], createdAt: new Date().toISOString() };
    const first = JSON.stringify({ id: 't1', question: 'First question', answer: 'First answer' });
    const second = JSON.stringify({ id: 't2', question: 'Second question', answer: 'Second answer' });
    await writeFile(file, `${first}\n${second.slice(0, 20)}`);
    let info = await stat(file);
    const initial = await readIncrementalHistory({ file, relative: 'session.jsonl', source, byteLength: info.size, mtimeMs: info.mtimeMs, projectRoot: 'D:/fixture/project' });
    assert.equal(initial.session.turns.length, 1); assert.equal(initial.session.cursor, Buffer.byteLength(`${first}\n`));
    await appendFile(file, `${second.slice(20)}\n`);
    info = await stat(file);
    const appended = await readIncrementalHistory({ file, relative: 'session.jsonl', source, previous: initial.session,
      byteLength: info.size, mtimeMs: info.mtimeMs, projectRoot: 'D:/fixture/project' });
    assert.equal(appended.mode, 'append'); assert.equal(appended.session.turns.length, 2);
    assert.equal(appended.parsedBytes, Buffer.byteLength(`${second}\n`));
    await writeFile(file, `${first.replace('First answer', 'Other answer')}\n${second}\n`);
    info = await stat(file);
    const rewritten = await readIncrementalHistory({ file, relative: 'session.jsonl', source, previous: appended.session,
      byteLength: info.size, mtimeMs: info.mtimeMs + 1, projectRoot: 'D:/fixture/project' });
    assert.equal(rewritten.mode, 'rebuild'); assert.equal(rewritten.session.turns.length, 2); assert.equal(rewritten.session.turns[0].answer, 'Other answer');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CTX-ATL-003: authorized source watchers start and stop without orphan timers or scans', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-history-watch-fixture-'));
  const f = fixture();
  try {
    await f.call('atlas.source.upsert', { id: 'watched', kind: 'canvas', root, authorized: true, projectRoots: ['D:/fixture/project'] });
    assert.equal((await f.call('atlas.watch.start', { sourceId: 'watched' })).watching, true);
    assert.equal((await f.call('atlas.watch.status')).length, 1);
    await f.call('atlas.source.remove', { sourceId: 'watched' });
    assert.equal((await f.call('atlas.watch.status')).length, 0);
    await assert.rejects(f.call('atlas.watch.start', { sourceId: 'watched' }), { code: 'CTX-HISTORY-SOURCE-DISABLED' });
  } finally { await f.module.dispose?.(); await rm(root, { recursive: true, force: true }); }
});
