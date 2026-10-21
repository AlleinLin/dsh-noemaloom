import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAtomicStore, sha256 } from '../src/domain/storage/index.js';
import { NexusError } from '../src/ports/contracts.js';

async function fixture(t: { after(fn: () => Promise<unknown>): void }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-storage-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('atomic store survives reopen, opaque IDs never become paths, and values are detached', async (t) => {
  const directory = await fixture(t);
  const store = createAtomicStore(directory);
  const value = { title: '真实持久化', nested: { count: 1 } };
  const saved = await store.put('../sensitive', '../../user/opaque', value, 0);
  value.nested.count = 99;
  assert.equal(saved.revision, 1);
  assert.equal((await createAtomicStore(directory).get<typeof value>('../sensitive', '../../user/opaque'))?.value.nested.count, 1);
  saved.value.nested.count = 50;
  assert.equal((await store.get<typeof value>('../sensitive', '../../user/opaque'))?.value.nested.count, 1);
  const rootNames = await readdir(directory);
  assert.deepEqual(rootNames, ['store-v1']);
});

test('two store instances racing one expected revision produce exactly one commit', async (t) => {
  const directory = await fixture(t);
  const one = createAtomicStore(directory);
  const two = createAtomicStore(directory);
  await one.put('memory', 'shared', { count: 0 }, 0);
  const results = await Promise.allSettled([
    one.put('memory', 'shared', { count: 1 }, 1),
    two.put('memory', 'shared', { count: 2 }, 1),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = results.find((item) => item.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof NexusError);
  assert.equal(rejected.reason.code, 'REVISION_CONFLICT');
  assert.equal((await one.get('memory', 'shared'))?.revision, 2);
});

test('delete persists tombstone revision and prevents ABA overwrite', async (t) => {
  const directory = await fixture(t);
  const store = createAtomicStore(directory);
  await store.put('items', 'a', { count: 1 }, 0);
  assert.equal(await store.remove('items', 'a', 1), true);
  assert.equal(await store.get('items', 'a'), undefined);
  assert.deepEqual(await store.list('items'), []);
  await assert.rejects(() => store.put('items', 'a', { count: 2 }, 1), { code: 'REVISION_CONFLICT' });
  assert.equal((await store.put('items', 'a', { count: 3 }, 2)).revision, 3);
  assert.equal(await store.remove('items', 'missing', 0), false);
});

test('corruption fails closed, preserves original, and never recovers an unfinished temporary write as success', async (t) => {
  const directory = await fixture(t);
  const store = createAtomicStore(directory);
  await store.put('items', 'a', { count: 1 }, 0);
  const records = join(directory, 'store-v1', 'records', sha256('items'));
  await writeFile(join(records, '.interrupted.tmp'), '{"revision":999,"value":"uncommitted"}');
  assert.equal((await createAtomicStore(directory).get<{ count: number }>('items', 'a'))?.value.count, 1);
  const path = join(records, `${sha256('a')}.json`);
  const corrupted = '{"schemaVersion":1,"id":"a","value":"corrupt"}';
  await writeFile(path, corrupted);
  await assert.rejects(() => store.get('items', 'a'), { code: 'INTEGRITY_FAILED' });
  await assert.rejects(() => store.put('items', 'a', {}, 1), { code: 'INTEGRITY_FAILED' });
  await assert.rejects(() => store.list('items'), { code: 'INTEGRITY_FAILED' });
  assert.equal(await readFile(path, 'utf8'), corrupted);
});

test('cross-process CAS lease serializes concurrent writers', async (t) => {
  const directory = await fixture(t);
  const store = createAtomicStore(directory);
  await store.put('counter', 'a', { count: 0 }, 0);
  const workerPath = join(directory, 'worker.mjs');
  const moduleUrl = new URL('../src/domain/storage/index.ts', import.meta.url).href;
  await writeFile(workerPath, `
import { createAtomicStore } from ${JSON.stringify(moduleUrl)};
const store = createAtomicStore(process.argv[2]);
let count = 0;
while (count < 8) {
  const record = await store.get('counter', 'a');
  try {
    await store.put('counter', 'a', {count: record.value.count + 1}, record.revision);
    count += 1;
  } catch (error) {
    if (error.code !== 'REVISION_CONFLICT') throw error;
  }
}
`);
  const run = () => new Promise<void>((accept, reject) => {
    const child = fork(workerPath, [directory], { execArgv: process.execArgv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let diagnostics = '';
    child.stderr?.on('data', (chunk) => { diagnostics += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? accept() : reject(new Error(diagnostics || `worker exit ${code}`)));
  });
  await Promise.all([run(), run(), run()]);
  const result = await store.get<{ count: number }>('counter', 'a');
  assert.equal(result?.value.count, 24);
  assert.equal(result?.revision, 25);
});
