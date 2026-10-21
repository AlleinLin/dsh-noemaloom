import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { createSqliteStore } from '../src/domain/storage/sqlite.js';
import { NexusError } from '../src/ports/contracts.js';

async function fixture(workerSource?: string) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-sqlite-'));
  await mkdir(join(root, 'lib', 'workers'), { recursive: true });
  const source = workerSource ?? await readFile(new URL('../src/workers/storage-worker.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  await writeFile(join(root, 'lib', 'workers', 'storage-worker.js'), compiled);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  return { root, data: join(root, 'data') };
}

function observeStorageWorker() {
  const state: { worker?: Worker; error?: Error; exited: boolean; failuresWhileAlive: Set<string> } = {
    exited: false, failuresWhileAlive: new Set(),
  };
  const observe = (worker: Worker) => {
    state.worker = worker;
    worker.on('message', message => {
      if (message.ok === false && typeof message.error?.message === 'string' && worker.threadId > 0) {
        state.failuresWhileAlive.add(message.error.message);
      }
    });
    worker.once('error', error => { state.error = error; });
    worker.once('exit', () => { state.exited = true; });
  };
  // Observe the real thread without replacing Worker or its termination method.
  process.once('worker', observe);
  return {
    state,
    async dispose() {
      process.off('worker', observe);
      // A regressed factory must not leave the test process hanging either.
      if (state.worker && state.worker.threadId !== -1) await state.worker.terminate();
    },
  };
}

test('failed initial facts recycles the live worker before rejecting the factory', async () => {
  const f = await fixture(`
    import { parentPort } from 'node:worker_threads';
    // This listener deliberately keeps the thread alive after the error reply.
    parentPort.on('message', ({ id, operation }) => {
      if (operation === 'facts') parentPort.postMessage({
        id, ok: false,
        error: { code: 'INTERNAL', message: 'fixture facts failure', details: { phase: 'facts' } },
      });
    });
    parentPort.postMessage({ ready: true });
  `);
  const observed = observeStorageWorker();
  try {
    await assert.rejects(createSqliteStore(f.data, f.root), (error: unknown) => {
      assert.ok(error instanceof NexusError);
      assert.equal(error.code, 'INTERNAL');
      assert.equal(error.message, 'fixture facts failure');
      assert.deepEqual(error.details, { phase: 'facts' });
      assert.equal(observed.state.failuresWhileAlive.has('fixture facts failure'), true,
        'the failed request came from a live worker');
      assert.equal(observed.state.exited, true, 'factory rejection waits for the actual worker exit');
      assert.ok(observed.state.worker);
      assert.equal(observed.state.worker.threadId, -1);
      return true;
    });
  } finally {
    try { await observed.dispose(); } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test('startup failure preserves the original worker error and waits for exit', async () => {
  const f = await fixture(`throw new Error('fixture startup failure');`);
  const observed = observeStorageWorker();
  try {
    await assert.rejects(createSqliteStore(f.data, f.root), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'fixture startup failure');
      assert.equal(error, observed.state.error, 'cleanup preserves the exact startup error');
      assert.equal(observed.state.exited, true);
      assert.ok(observed.state.worker);
      assert.equal(observed.state.worker.threadId, -1);
      return true;
    });
  } finally {
    try { await observed.dispose(); } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test('failed close terminates the live worker before preserving its error', async () => {
  const f = await fixture(`
    import { parentPort } from 'node:worker_threads';
    parentPort.on('message', ({ id, operation }) => {
      if (operation === 'facts') parentPort.postMessage({ id, ok: true, result: { backend: 'fixture' } });
      if (operation === 'close') parentPort.postMessage({
        id, ok: false,
        error: { code: 'INTERNAL', message: 'fixture close failure', details: { phase: 'close' } },
      });
    });
    parentPort.postMessage({ ready: true });
  `);
  const observed = observeStorageWorker();
  try {
    const store = await createSqliteStore(f.data, f.root);
    await assert.rejects(store.close(), (error: unknown) => {
      assert.ok(error instanceof NexusError);
      assert.equal(error.code, 'INTERNAL');
      assert.equal(error.message, 'fixture close failure');
      assert.deepEqual(error.details, { phase: 'close' });
      assert.equal(observed.state.failuresWhileAlive.has('fixture close failure'), true);
      assert.equal(observed.state.exited, true, 'close rejection waits for the actual worker exit');
      assert.ok(observed.state.worker);
      assert.equal(observed.state.worker.threadId, -1);
      return true;
    });
    await assert.rejects(store.facts(), { code: 'CANCELLED' });
    await store.close();
  } finally {
    try { await observed.dispose(); } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test('SQLite worker retains acknowledged records, tombstone revisions, and actual runtime facts after reopen', async () => {
  const f = await fixture();
  let store = await createSqliteStore(f.data, f.root);
  try {
    const facts: any = await store.facts();
    assert.equal(facts.backend, 'node:sqlite-worker');
    assert.equal(facts.worker.node, process.version);
    assert.equal(facts.integrity, 'not-checked');
    assert.equal(facts.integrityCheck.mode, 'manual-only');
    const check = await store.checkIntegrity();
    assert.equal(check.state, 'ok');
    assert.deepEqual(check.messages, ['ok']);
    assert.equal(check.check, 'PRAGMA integrity_check');
    assert.equal((await store.facts()).integrity, 'ok');
    const first = await store.put('memory', 'one', { body: '持久事实' }, 0);
    assert.equal(first.revision, 1);
    await store.close();
    store = await createSqliteStore(f.data, f.root);
    assert.equal((await store.facts()).integrity, 'not-checked', 'a previous process check is not a new verification');
    assert.deepEqual((await store.get('memory', 'one'))?.value, { body: '持久事实' });
    assert.equal(await store.remove('memory', 'one', 1), true);
    await assert.rejects(store.put('memory', 'one', { body: 'stale resurrection' }, 0), { code: 'REVISION_CONFLICT' });
    assert.equal((await store.put('memory', 'one', { body: 'explicit new revision' }, 2)).revision, 3);
  } finally { await store.close(); await rm(f.root, { recursive: true, force: true }); }
});
test('independent SQLite workers admit exactly one CAS update of the same observed revision', async () => {
  const f = await fixture();
  const a = await createSqliteStore(f.data, f.root);
  const b = await createSqliteStore(f.data, f.root);
  try {
    await a.put('workflow', 'shared', { value: 0 }, 0);
    const outcomes = await Promise.allSettled(Array.from({ length: 16 }, (_, index) =>
      (index % 2 ? a : b).put('workflow', 'shared', { value: index + 1 }, 1)));
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(item => item.status === 'rejected' && item.reason.code === 'REVISION_CONFLICT').length, 15);
    assert.equal((await a.get('workflow', 'shared'))?.revision, 2);
    assert.equal((await b.list('workflow')).length, 1);
  } finally { await Promise.all([a.close(), b.close()]); await rm(f.root, { recursive: true, force: true }); }
});

for (const messages of [['fixture structural error'], []]) {
  test(`manual integrity reports ${messages.length ? 'SQLite errors' : 'invalid empty results'} without claiming ok`, async () => {
    const f = await fixture(`
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', ({ id, operation }) => {
        const result = operation === 'facts' ? { backend: 'fixture' }
          : operation === 'integrity' ? { integrity: 'failed', messages: ${JSON.stringify(messages)} } : true;
        parentPort.postMessage({ id, ok: true, result });
        if (operation === 'close') parentPort.close();
      });
      parentPort.postMessage({ ready: true });
    `);
    const store = await createSqliteStore(f.data, f.root);
    try {
      assert.equal((await store.facts()).integrity, 'not-checked');
      if (messages.length) {
        const checked = await store.checkIntegrity();
        assert.equal(checked.state, 'failed');
        assert.deepEqual(checked.messages, messages);
        assert.equal((await store.facts()).integrity, 'failed');
      } else {
        await assert.rejects(store.checkIntegrity(), { code: 'INTEGRITY_FAILED' });
        assert.equal((await store.facts()).integrity, 'error');
      }
    } finally { await store.close(); await rm(f.root, { recursive: true, force: true }); }
  });
}
