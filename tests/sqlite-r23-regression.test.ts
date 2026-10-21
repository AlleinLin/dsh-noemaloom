import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { createSqliteStore } from '../src/domain/storage/sqlite.js';
import { createDispatcher, type Dispatcher } from '../src/domain/operations/index.js';
import { createScopeModule, withScopePolicy } from '../src/domain/scope.js';
import { createCompanionModule } from '../src/domain/insights/companion.js';
import { createContextModule } from '../src/domain/context/index.js';
import { NATIVE_SYNC_CHECKPOINTS } from '../src/domain/context/native-sync.js';
import { createHostAdapter } from '../src/host/host-adapter.js';
import NexusCompactionEngine, { nativeSurfaceProjection } from '../src/host/compaction.js';
import { registerRpcRoute } from '../src/host/routes.js';
import { OperationController } from '../src/host/lifecycle.js';
import { NexusError, type NexusServices } from '../src/ports/contracts.js';

const RECEIPTS = '__nexus_operation_receipts_v1';
async function fixture(t: TestContext, gateIntegrity = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'nexus-r23-sqlite-'));
  await mkdir(path.join(root, 'lib', 'workers'), { recursive: true });
  let source = await readFile(new URL('../src/workers/storage-worker.ts', import.meta.url), 'utf8');
  // Keep the production worker/real SQLite. Only intercept entry to expensive
  // PRAGMAs: ordinary facts must never enter; explicit scans can be held while
  // concurrent RPC point reads and writes are checked without timing guesses.
  source = `import { existsSync, writeFileSync } from 'node:fs';\n` + source.replace(
    'const select =', `
      const prepareReal = database.prepare.bind(database);
      database.prepare = ((sql: string) => {
        if (/integrity_check|quick_check/i.test(sql)) {
          if (!integrityReader) throw new Error('ordinary RPC attempted a full integrity scan');
          writeFileSync((workerData as StorageWorkerData).database + '.checking', '1');
          ${gateIntegrity ? `while (!existsSync((workerData as StorageWorkerData).database + '.release')) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }` : ''}
        }
        return prepareReal(sql);
      }) as typeof database.prepare;
      const select =`);
  await writeFile(path.join(root, 'lib', 'workers', 'storage-worker.js'),
    ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  const store = await createSqliteStore(path.join(root, 'data'), root);
  const databasePath = path.join(root, 'data', 'database', 'nexus.sqlite');
  let route: any;
  const ctx: any = {
    get: (name: string) => name === 'llm' ? { listProviders: () => [], listModels: async () => [] } : undefined,
    on: () => () => {}, effect: () => {}, provide: () => () => {},
    connection: { fetch: { register(value: any) { route = value; return async () => {}; } } },
  };
  const host = createHostAdapter(ctx, {}, root, new AbortController().signal);
  let modelCalls = 0;
  host.model = async () => { modelCalls++; throw new Error('no model execution is permitted by this fixture'); };
  const base: Omit<NexusServices, 'invoke'> = {
    store, host, dataDir: root, workspaceRoot: root, emit() {},
    executor: { async run() { throw new Error('no subprocess execution is permitted by this fixture'); } },
  };
  const own = (value: Dispatcher) => {
    value.register(createScopeModule(value.services));
    value.register(withScopePolicy(createCompanionModule(value.services), value.services));
    value.register(createContextModule(value.services));
    host.connect(value.services);
    return value;
  };
  let dispatcher = own(createDispatcher(base));
  const controller = new OperationController();
  controller.setRouteDisposer(registerRpcRoute(ctx, dispatcher, controller, 1024 * 1024));
  t.after(async () => {
    await store.cancelIntegrityCheck();
    await controller.dispose();
    await dispatcher.dispose();
    await host.dispose();
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const rpc = async (method: string, domain: string, action: string, signal?: AbortSignal) => {
    const response = await route.fetch(new Request('http://fixture.invalid/api/nexus/rpc', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ type: 'client-request', rpcId: action, method: 'nexus/rpc', payload: {
        protocolVersion: 1, method, scope: { level: 'global' },
        payload: { action, params: { domain } },
      } }),
    }));
    const envelope = await response.json();
    assert.equal(envelope.result.ok, true);
    return envelope.result.value;
  };
  const metrics = async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return db.prepare(`SELECT collection, count(*) AS count, sum(length(value)) AS bytes FROM nexus_records
        WHERE deleted=0 AND collection IN ('context.plans','context.wires','${RECEIPTS}') GROUP BY collection ORDER BY collection`).all();
    } finally { db.close(); }
  };
  return { root, store, host, databasePath, rpc, metrics,
    dispatcher: () => dispatcher, modelCalls: () => modelCalls,
    async restart() {
      await dispatcher.dispose();
      dispatcher = own(createDispatcher(base));
      controller.setRouteDisposer(registerRpcRoute(ctx, dispatcher, controller, 1024 * 1024));
    },
  };
}
async function waitForCheck(databasePath: string) {
  const deadline = Date.now() + 4000;
  while (true) {
    try { await readFile(databasePath + '.checking'); return; } catch {}
    if (Date.now() > deadline) throw new Error('diagnostic worker never reached its gated real SQLite scan');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function bounded<T>(value: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([value, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('ordinary RPC blocked behind diagnostic scan')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

test('real SQLite ordinary probe/snapshot and absent auxiliary settings use point reads without any full scan', async t => {
  const f = await fixture(t);
  // An unrelated corrupt application record must not be parsed just to count
  // records for normal facts. Its own indexed read must still fail truthfully.
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(f.databasePath);
  raw.prepare(`INSERT INTO nexus_records VALUES(?,?,?,?,?,?,?)`).run('historical.large', 'bad', 1,
    'not valid JSON', 'bad-checksum', new Date().toISOString(), 0);
  raw.close();
  const [probe, snapshot, settings] = await bounded(Promise.all([
    f.rpc('host.probe', 'scope', 'probe'), f.rpc('nexus.snapshot', 'scope', 'snapshot'),
    f.rpc('nexus.query', 'companion', 'settings'),
  ]));
  assert.equal(probe.ok, true); assert.equal(probe.data.storage.integrity, 'not-checked');
  assert.equal(snapshot.ok, true); assert.equal(snapshot.data.facts.storage.integrity, 'not-checked');
  assert.equal(settings.ok, true);
  assert.deepEqual(settings.data.routes, []);
  assert.equal(settings.data.local.revision, 0);
  assert.equal(settings.data.maxOutputTokens, 32768);
  assert.deepEqual(await f.store.list('scope-settings'), [], 'reading defaults creates no configuration records');
  await assert.rejects(f.store.get('historical.large', 'bad'), { code: 'INTEGRITY_FAILED' });
  assert.equal(f.modelCalls(), 0);
});

test('one isolated manual SQLite scan is shared across RPC retries while saved settings and writes remain available', async t => {
  const f = await fixture(t, true);
  const routes = [{ provider: 'fixture', model: 'saved', reasoningEffort: 'high' }];
  await f.store.put('scope-settings', 'global/auxiliary', { defaults: { routes } }, 0);
  const first = f.store.checkIntegrity();
  await waitForCheck(f.databasePath);
  assert.equal(f.store.checkIntegrity(), first, 'even a disconnected client cannot create another scan');
  const client = new AbortController();
  const abandoned = f.rpc('nexus.query', 'scope', 'storage.integrity', client.signal);
  client.abort(new NexusError('CANCELLED', 'fixture waiter abandoned'));
  assert.equal((await abandoned).error.code, 'CANCELLED');
  assert.equal(f.store.checkIntegrity(), first, 'cancelling an RPC waiter retains scan ownership');
  const checkRequest = f.rpc('nexus.query', 'scope', 'storage.integrity');
  const [settings, snapshot] = await bounded(Promise.all([
    f.rpc('nexus.query', 'companion', 'settings'), f.rpc('nexus.snapshot', 'scope', 'snapshot'),
  ]));
  assert.equal(settings.ok, true); assert.deepEqual(settings.data.routes, routes);
  assert.equal(snapshot.data.facts.storage.integrity, 'running');
  assert.equal((await bounded(f.store.put('unrelated', 'still-writable', { value: true }, 0))).revision, 1);
  await writeFile(f.databasePath + '.release', '1');
  const checked = await first;
  assert.equal(checked.state, 'ok'); assert.deepEqual(checked.messages, ['ok']);
  assert.equal((await checkRequest).data.completedAt, checked.completedAt);
  assert.equal((await f.store.facts()).integrity, 'ok');
  assert.equal(f.modelCalls(), 0);
  const denied = await f.dispatcher().dispatch('scope', { action: 'storage.integrity' }, {
    actorId: 'tool-agent', scopeLevel: 'global',
  });
  assert.equal(denied.error?.code, 'PERMISSION_DENIED');
});

test('manual scan cancellation and store close terminate only their diagnostic worker', async t => {
  const f = await fixture(t, true);
  const first = f.store.checkIntegrity();
  const rejected = assert.rejects(first, { code: 'CANCELLED' });
  await waitForCheck(f.databasePath);
  const cancelled = await f.rpc('nexus.query', 'scope', 'storage.integrity.cancel');
  assert.equal(cancelled.data.state, 'cancelled'); await rejected;
  assert.equal((await f.store.put('unrelated', 'after-cancel', {}, 0)).revision, 1);
  const second = f.store.checkIntegrity();
  const closed = assert.rejects(second, { code: 'CANCELLED' });
  await f.store.close(); await closed;
  await assert.rejects(f.store.checkIntegrity(), { code: 'CANCELLED' });
});

function engineFor(f: Awaited<ReturnType<typeof fixture>>) {
  const nodes = [0, 1].map(seq => ({ seq, message: {
    id: `native-${seq}`, role: seq ? 'assistant' : 'user',
    content: [{ type: 'text', text: `Exact original ${seq}: ` + 'long historical source '.repeat(5000) }],
    source: { kind: seq ? 'assistant' : 'user' },
  } }));
  let windowTokens = 1_000_000, model = 'fixture-model';
  const agent: any = {
    id: 'real-native-session', options: {},
    session: { header: { cwd: f.root }, surface: { nodes: nodes.map(node => node.seq) },
      requestHeader: () => ({ config: { provider: 'fixture-provider', model, maxTokens: 1000 }, tools: [] }),
      deriveMessages: () => nodes.map(node => node.message) },
  };
  const engine: any = Object.create(NexusCompactionEngine.prototype);
  engine.nativeContext = { get: (name: string) => name === 'nexus' ? { services: f.dispatcher().services }
    : name === 'llm' ? { resolveModelInfo: async () => ({ context: { contextWindow: windowTokens }, defaultMaxTokens: 1000 }) }
    : name === 'sessionProjections' ? { stateOf: (_session: unknown, key: string) => {
      assert.equal(key, nativeSurfaceProjection.key);
      return { lastSurfaceSeq: 1, nodes: nodes.map(node => ({ seq: node.seq, messageId: node.message.id })) };
    } } : undefined };
  return { engine, agent, nodes,
    sync: () => engine.synchronize(agent, new AbortController().signal),
    window: (next: number) => { windowTokens = next; }, model: (next: string) => { model = next; } };
}

test('identical official sync reuses plans, wires and durable receipts across dispatcher restart; changed inputs invalidate it', async t => {
  const f = await fixture(t), h = engineFor(f);
  const first = await h.sync();
  assert.equal(typeof first.planId, 'string');
  const before = await f.metrics();
  for (let index = 0; index < 6; index++) assert.deepEqual(await h.sync(), first);
  assert.deepEqual(await f.metrics(), before, 'identical native event versions add no full snapshot or operation receipt');
  const checkpoint = (await f.store.list<any>(NATIVE_SYNC_CHECKPOINTS))[0].value;
  const context = { actorId: 'native-compaction-owner', sessionId: h.agent.id,
    workspaceRoot: f.root, permissions: new Set(['context.native/sync']) };
  const receipt = await f.dispatcher().readReceipt(checkpoint.requestId, context);
  assert.equal(receipt?.ok, true);
  await f.restart();
  assert.deepEqual(await h.sync(), first);
  assert.deepEqual(await f.dispatcher().readReceipt(checkpoint.requestId, context), receipt);
  assert.deepEqual(await f.metrics(), before, 'receipt recovery does not replay domain work');
  h.window(900_000);
  const changedWindow = await h.sync();
  assert.notEqual(changedWindow.planId, first.planId);
  h.model('other-fixture-model');
  assert.notEqual((await h.sync()).planId, changedWindow.planId);
  const previous = (await h.sync()).planId;
  const configured = await f.dispatcher().dispatch('context', { action: 'policy', requestId: 'change-context-policy',
    params: { sessionId: h.agent.id, mode: 'observe' } }, {
      ...context, permissions: new Set(['context.policy']),
    });
  assert.equal(configured.ok, true);
  assert.notEqual((await h.sync()).planId, previous);
  assert.equal(f.modelCalls(), 0);
});

test('a final sync checkpoint write failure retains its original intent so retries never create duplicate snapshots', async t => {
  const f = await fixture(t), h = engineFor(f);
  const put = f.store.put.bind(f.store);
  let inject = true;
  f.store.put = (async (collection: string, id: string, value: any, revision?: number) => {
    if (collection === NATIVE_SYNC_CHECKPOINTS && value.state === 'finished' && inject) {
      inject = false; throw new NexusError('INTERNAL', 'injected final checkpoint failure');
    }
    return put(collection, id, value, revision);
  }) as typeof f.store.put;
  await assert.rejects(h.sync(), { code: 'INTERNAL' });
  const before = await f.metrics();
  const checkpoint = (await f.store.list<any>(NATIVE_SYNC_CHECKPOINTS))[0].value;
  assert.equal(checkpoint.state, 'started');
  await assert.rejects(h.sync(), { code: 'INTERNAL' });
  assert.deepEqual(await f.metrics(), before, 'retry reads the existing failure receipt and does not execute sync again');
  await f.restart();
  await assert.rejects(h.sync(), { code: 'INTERNAL' });
  assert.deepEqual(await f.metrics(), before);
});

test('native sync with a fresh explicit intent still reuses its exact existing plan and wire', async t => {
  const f = await fixture(t), h = engineFor(f);
  const first = await h.sync();
  const params = { sessionId: h.agent.id, purpose: 'main', lane: 'main',
    nodes: h.nodes, surfaceSeqs: h.nodes.map(node => node.seq),
    route: { providerId: 'fixture-provider', modelId: 'fixture-model', adapterVersion: 'dsh-0.2.1-rc.2' },
    windowTokens: 1_000_000, outputReserveTokens: 1000, tools: [], system: '' };
  const context = { actorId: 'native-compaction-owner', sessionId: h.agent.id,
    workspaceRoot: f.root, permissions: new Set(['context.native/sync']) };
  const before = (await f.metrics()).filter((row: any) => row.collection !== RECEIPTS);
  const repeated = await f.dispatcher().dispatch('context', { action: 'native/sync',
    requestId: 'explicit-independent-sync-intent', params }, context);
  assert.equal(repeated.ok, true);
  assert.equal((repeated.data as any).planId, first.planId);
  assert.deepEqual((await f.metrics()).filter((row: any) => row.collection !== RECEIPTS), before);
  // An explicitly distinct intent keeps its own ordinary durable receipt.
  assert.equal((await f.store.list(RECEIPTS)).length, 2);
});
