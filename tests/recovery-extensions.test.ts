import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecoveryModule } from '../src/domain/recovery/index.js';
import { ChangeLedgerEngine } from '../src/domain/recovery/upstream/engine.js';
import { validateRelativePath } from '../src/domain/recovery/upstream/path-utils.js';
import { createExtensionsModule } from '../src/domain/extensions/index.js';
import { createPresetsModule } from '../src/domain/runtime/presets/index.js';
import type { NexusServices, StoredRecord, NexusStore } from '../src/ports/contracts.js';

function memoryStore(): NexusStore {
  const rows = new Map<string, StoredRecord<unknown>>();
  return {
    async get<T>(collection: string, id: string) { return rows.get(`${collection}:${id}`) as StoredRecord<T> | undefined; },
    async put<T>(collection: string, id: string, value: T, expectedRevision?: number) {
      const key = `${collection}:${id}`;
      const previous = rows.get(key);
      if (expectedRevision !== undefined && expectedRevision !== (previous?.revision ?? 0)) throw new Error('STALE_REVISION');
      const row = { id, revision: (previous?.revision ?? 0) + 1, value, updatedAt: new Date().toISOString() };
      rows.set(key, row); return row;
    },
    async list<T>(collection: string) { return [...rows].filter(([key]) => key.startsWith(`${collection}:`)).map(([, row]) => row as StoredRecord<T>); },
    async remove(collection: string, id: string) { return rows.delete(`${collection}:${id}`); },
  };
}
function services(root: string): NexusServices {
  return {
    dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace'), store: memoryStore(),
    executor: { async run() { throw new Error('unexpected process execution'); } },
    host: {
      async facts() { return {}; }, async model() { throw new Error('unexpected model call'); },
      async spawn() { throw new Error('unexpected child agent'); },
      async sessions() { throw new Error('unexpected host session action'); }, async secret() { return undefined; }, async approve() { return false; },
    },
    emit() {}, async invoke() { throw new Error('unexpected capability'); },
  };
}

test('conversation-only recovery preserves files, validates direct user boundary and forks once after retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-conversation-fixture-'));
  try {
    const fixture = services(root);
    let forks = 0; let flushes = 0;
    fixture.host.sessions = async (action, params) => {
      if (action === 'snapshot') return { id: 'source', workspaceId: 'ws', revision: 9, events: [
        { seq: 1, type: 'message', role: 'user', directUser: true, content: 'first' },
        { seq: 4, type: 'turn/end' }, { seq: 5, type: 'message', role: 'user', directUser: true, content: 'retry' },
        { seq: 6, type: 'message', role: 'user', injected: true, content: 'reminder' },
        { seq: 7, type: 'message', role: 'user', content: 'unverified-role-only' },
      ] };
      if (action === 'fork') { forks++; assert.equal(params.atSeq, 4); return { sessionId: 'child' }; }
      if (action === 'flush') { flushes++; return {}; }
      throw new Error(`unexpected ${action}`);
    };
    const module = createRecoveryModule(fixture);
    const context = { sessionId: 'source', actorId: 'user' };
    await assert.rejects(module.dispatch({ action: 'plan', params: { mode: 'conversation-only', openingMessageSeq: 6 } }, context), /直接用户/);
    await assert.rejects(module.dispatch({ action: 'plan', params: { mode: 'conversation-only', openingMessageSeq: 7 } }, context), /直接用户/);
    const plan = await module.dispatch({ action: 'plan', params: { mode: 'conversation-only', openingMessageSeq: 5 } }, context) as { id: string };
    const applied = await module.dispatch({ action: 'apply', params: { planId: plan.id, idempotencyKey: 'one' } }, context) as { childSessionId: string; phase: string };
    const retried = await module.dispatch({ action: 'apply', params: { planId: plan.id, idempotencyKey: 'one' } }, context) as { childSessionId: string };
    assert.equal(applied.phase, 'completed'); assert.equal(applied.childSessionId, 'child');
    assert.equal(retried.childSessionId, 'child'); assert.equal(forks, 1); assert.equal(flushes, 1);
    // workspace does not exist: conversation-only must never inventory user files.
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('injected messages do not displace the first real user turn; unknown create never retries', async () => {
  const fixture = services('/nonexistent-fixture');
  let forks = 0;
  fixture.host.sessions = async action => {
    if (action === 'snapshot') return { id: 'source', events: [
      { seq: 0, type: 'message', role: 'user', directUser: true, injected: true, content: 'plugin-reminder' },
      { seq: 1, type: 'message', role: 'user', directUser: true, content: 'first' },
    ] };
    if (action === 'create') { forks++; throw new Error('response lost'); }
    throw new Error('unexpected');
  };
  const module = createRecoveryModule(fixture);
  const context = { sessionId: 'source', actorId: 'user' };
  const plan = await module.dispatch({ action: 'plan', params: { mode: 'conversation-only', openingMessageSeq: 1 } }, context) as { id: string };
  const request = { action: 'apply', params: { planId: plan.id, idempotencyKey: 'lost-response' } };
  const first = await module.dispatch(request, context) as { phase: string };
  await module.dispatch(request, context);
  assert.equal(first.phase, 'fork-durability-uncertain'); assert.equal(forks, 1);
});

test('fixture ledger restores raw bytes, retains rescue, rejects post-plan edit and excludes credentials before capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-ledger-fixture-'));
  try {
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    const original = Buffer.from([0xef, 0xbb, 0xbf, 0x00, 0x0d, 0x0a, 0xff]);
    await writeFile(join(workspace, 'binary.dat'), original);
    await writeFile(join(workspace, '.env'), 'PRIVATE_FIXTURE_SECRET=excluded');
    const engine = new ChangeLedgerEngine({ storageDir: join(root, 'ledger'), turnCheckpointMode: 'off' });
    const point = await engine.create({ cwd: workspace, sessionId: 'fixture' });
    const manifest = await engine.store.readManifest(workspace, point.id);
    assert.equal(manifest.entries['.env'], undefined);
    await writeFile(join(workspace, 'binary.dat'), Buffer.from('new'));
    const plan = await engine.planRestore({ cwd: workspace, restorePointId: point.id, sessionId: 'fixture' });
    await writeFile(join(workspace, 'binary.dat'), Buffer.from('edited-after-plan'));
    await assert.rejects(engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation, sessionId: 'fixture' }), /changed/);
    assert.equal(await readFile(join(workspace, 'binary.dat'), 'utf8'), 'edited-after-plan');
    const fresh = await engine.planRestore({ cwd: workspace, restorePointId: point.id, sessionId: 'fixture' });
    const result = await engine.applyRestore({ planId: fresh.id, confirmation: fresh.confirmation, sessionId: 'fixture' });
    assert.deepEqual(await readFile(join(workspace, 'binary.dat')), original);
    assert.ok(result.rescuePointId);
    assert.equal(await readFile(join(workspace, '.env'), 'utf8'), 'PRIVATE_FIXTURE_SECRET=excluded');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('relative recovery paths reject traversal on all platforms', () => {
  for (const path of ['../a', '/etc/passwd', 'a//b', 'a/./b', 'a/../b', 'C:/outside', 'a\0b']) assert.throws(() => validateRelativePath(path));
  assert.equal(validateRelativePath('中文/binary.dat'), '中文/binary.dat');
});

test('compensation preserves an external edit after a committed path and reports recovery-required', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-rollback-fixture-'));
  try {
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    await writeFile(join(workspace, 'a.txt'), 'original-a'); await writeFile(join(workspace, 'b.txt'), 'original-b');
    const engine = new ChangeLedgerEngine({ storageDir: join(root, 'ledger'), turnCheckpointMode: 'off' });
    const point = await engine.create({ cwd: workspace, sessionId: 'fixture' });
    await writeFile(join(workspace, 'a.txt'), 'new-a'); await writeFile(join(workspace, 'b.txt'), 'new-b');
    const plan = await engine.planRestore({ cwd: workspace, restorePointId: point.id, sessionId: 'fixture' });
    const controller = new AbortController();
    const writeOperation = engine.store.writeOperation.bind(engine.store);
    engine.store.writeOperation = async operation => {
      await writeOperation(operation);
      if (operation.state === 'running' && operation.completedPaths?.length === 1) {
        await writeFile(join(workspace, operation.completedPaths[0]), 'external-editor-change');
        controller.abort(new Error('fixture cancelled before second file'));
      }
    };
    await assert.rejects(engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation, sessionId: 'fixture', signal: controller.signal }), /automatic rollback both failed/);
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'external-editor-change');
    assert.equal(await readFile(join(workspace, 'b.txt'), 'utf8'), 'new-b');
    const recovery = await engine.listRecovery({ cwd: workspace });
    assert.equal(recovery[0]?.state, 'recovery-required');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('extension review hashes real source and native failed generation keeps old active', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-extension-fixture-'));
  try {
    const packageRoot = join(root, 'extension'); await mkdir(packageRoot);
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-plugin', version: '1.0.0', type: 'module', main: 'index.js', license: 'MIT' }));
    await writeFile(join(packageRoot, 'index.js'), 'export function apply() {}');
    const fixture = services(root); fixture.host.approve = async () => true;
    const disposed: number[] = [];
    fixture.host.sessions = async (action, params) => {
      if (action === 'extensions.activate') {
        if (params.generation === 2) throw new Error('candidate health failed');
        return { handle: 'exact-handle-1', ready: true, resources: [{ type: 'service', name: 'fixture' }] };
      }
      if (action === 'extensions.commit') return {};
      if (action === 'extensions.dispose') { disposed.push(Number(params.generation)); return {}; }
      throw new Error(action);
    };
    const module = createExtensionsModule(fixture);
    const plan = await module.dispatch({ action: 'inspect', params: { source: packageRoot, mode: 'native-managed' } }) as { id: string };
    const active = await module.dispatch({ action: 'run', params: { planId: plan.id } }) as { generation: number };
    assert.equal(active.generation, 1);
    await writeFile(join(packageRoot, 'index.js'), 'export function apply() { throw Error("broken"); }');
    const changed = await module.dispatch({ action: 'inspect', params: { source: packageRoot, mode: 'native-managed' } }) as { id: string };
    await assert.rejects(module.dispatch({ action: 'run', params: { planId: changed.id } }), /candidate health/);
    const list = await module.dispatch({ action: 'list' }) as { active: Array<{ generation: number }> };
    assert.equal(list.active[0]?.generation, 1); assert.deepEqual(disposed, []);
    await module.dispose?.();
    assert.deepEqual(disposed, [1]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('market preset validates both file hashes and registers the complete composition through host registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-preset-fixture-'));
  try {
    const fixture = services(root);
    const presetRoot = join(root, 'preset'); await mkdir(presetRoot);
    const metadata = 'name: 测试市场预设\ndescription: 只用于可丢弃测试目录\norder: 20\n';
    const composition = "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    prefix: 测试资料\n    complete: true\n";
    await writeFile(join(presetRoot, 'preset.yml'), metadata);
    await writeFile(join(presetRoot, 'agent.cordis.yml'), composition);
    const { createHash } = await import('node:crypto');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    await fixture.store.put('resources', 'W:preset:fixture', {
      kind: 'preset', marketId: 'fixture', path: presetRoot,
      fileHashes: { 'preset.yml': hash(metadata), 'agent.cordis.yml': hash(composition) },
    }, 0);
    const registrations: unknown[] = [];
    fixture.host.approve = async () => true;
    fixture.host.sessions = async (action, params) => {
      if (action === 'presets.register') { registrations.push(params.definition); return { handle: 'preset-handle' }; }
      if (action === 'presets.unregister') return {};
      throw new Error(action);
    };
    const module = createPresetsModule(fixture);
    fixture.invoke = async (domain, request, context) => {
      assert.equal(domain, 'presets'); return module.dispatch(request, context);
    };
    const preview = await module.dispatch({ action: 'import.preview', params: { resourceId: 'W:preset:fixture' } }) as { id: string; digest: string; definition: { id: string; plugins: unknown[] } };
    assert.equal(preview.definition.id, 'market.fixture'); assert.equal(preview.definition.plugins.length, 1);
    const result = await module.dispatch({ action: 'import.apply', expectedRevision: 0, params: { planId: preview.id, digest: preview.digest } }) as { hostRegistered: boolean };
    assert.equal(result.hostRegistered, true); assert.equal(registrations.length, 1);
    await writeFile(join(presetRoot, 'agent.cordis.yml'), `${composition}# changed`);
    await assert.rejects(module.dispatch({ action: 'import.preview', params: { resourceId: 'W:preset:fixture' } }), /摘要/);
    await module.dispose?.();
  } finally { await rm(root, { recursive: true, force: true }); }
});
