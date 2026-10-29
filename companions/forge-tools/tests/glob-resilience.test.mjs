import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SearchEngine, runRg } from '../src/search.mjs';
import { environment } from './helpers.mjs';

async function bounded(promise, milliseconds = 2000) {
  let timer;
  try {
    return await Promise.race([promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('glob test watchdog expired')), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

test('isolated glob preserves root anchoring, braces, classes, Unicode, ignores and warm results', async t => {
  const { root } = await environment(t);
  await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
  for (const name of ['root.mjs', 'ignored.mjs', 'src/a.mjs', 'src/a1.ts', 'src/b2.ts', 'src/nested/中文 文件.mjs']) {
    await writeFile(path.join(root, name), 'content');
  }
  await writeFile(path.join(root, '.ignore'), 'ignored.mjs\n');
  const engine = new SearchEngine({ ttlMs: 30000 });
  t.after(() => engine.dispose());
  assert.deepEqual((await engine.glob(root, { pattern: '*.mjs' })).files, ['root.mjs']);
  const before = engine.metrics().globFilters;
  const warm = await engine.glob(root, { pattern: '*.mjs' });
  warm.files.push('corrupted');
  assert.deepEqual((await engine.glob(root, { pattern: '*.mjs' })).files, ['root.mjs']);
  assert.equal(engine.metrics().globFilters, before);
  assert.deepEqual((await engine.glob(root, { pattern: 'src/*.{mjs,ts}' })).files.sort(),
    ['src/a.mjs', 'src/a1.ts', 'src/b2.ts']);
  assert.deepEqual((await engine.glob(root, { pattern: 'src/[ab]?.ts' })).files.sort(), ['src/a1.ts', 'src/b2.ts']);
  assert.deepEqual((await engine.glob(root, { pattern: 'src/**/中文*.mjs' })).files, ['src/nested/中文 文件.mjs']);
  assert.equal((await engine.glob(root, { pattern: '**/*.mjs' })).files.includes('ignored.mjs'), false);
  assert.equal((await engine.glob(root, { pattern: '**/*.mjs', no_ignore: true })).files.includes('ignored.mjs'), true);
});

test('pathological backtracking and brace expansion stay outside the Desktop main thread', async () => {
  for (const pattern of ['*a'.repeat(20) + 'b', '{a,b}'.repeat(14)]) {
    const engine = new SearchEngine({ timeoutMs: 200 }, async (_exe, _argv, options) => {
      options.onLine('a'.repeat(100)); return { truncated: false, stderr: '' };
    });
    let beats = 0;
    const beat = setInterval(() => { beats++; }, 5);
    try {
      await assert.rejects(bounded(engine.glob('.', { pattern })), /exceeded|exited/);
      assert.ok(beats >= 3, 'parent event loop must remain responsive during native glob compilation');
    } finally { clearInterval(beat); await bounded(engine.dispose()); }
    assert.equal(engine.metrics().running, 0);
    assert.equal(engine.metrics().managedProcesses, 0);
  }
});

test('synchronous event-loop stalls cannot produce a late successful search or cache entry', async () => {
  const engine = new SearchEngine({ timeoutMs: 10 }, async (_exe, _argv, options) => {
    const until = performance.now() + 40;
    while (performance.now() < until) {}
    options.onLine(JSON.stringify({ type: 'match', data: {
      path: { text: 'file' }, lines: { text: 'needle' }, line_number: 1,
    } }));
    return { truncated: false, stderr: '' };
  });
  await assert.rejects(engine.grep('.', { pattern: 'needle' }), /exceeded 10 ms/);
  assert.equal(engine.metrics().queryEntries, 0);
  await engine.dispose();
});

test('glob source generation and age survive delayed isolated filtering', async () => {
  let finishFilter;
  const started = new Promise(resolve => { finishFilter = resolve; });
  let continueFilter;
  const continuation = new Promise(resolve => { continueFilter = resolve; });
  const engine = new SearchEngine({ ttlMs: 1000 }, async (_exe, _argv, options) => {
    options.onLine('file.mjs'); return { truncated: false, stderr: '' };
  }, undefined, async (_exe, _argv, options) => {
    finishFilter(); await continuation;
    options.onLine(JSON.stringify({ path: 'file.mjs' }));
    options.onLine(JSON.stringify({ total: 1 }));
    return { truncated: false, stderr: '' };
  });
  const operation = engine.glob('.', { pattern: '*.mjs' });
  await started;
  engine.invalidate();
  continueFilter();
  assert.deepEqual((await operation).files, ['file.mjs']);
  assert.equal(engine.metrics().snapshots, 0, 'invalidation during filtering must prevent reintroducing an old source snapshot');
  await engine.dispose();
  const age = new SearchEngine({ ttlMs: 10 }, async (_exe, _argv, options) => {
    options.onLine('file.mjs'); return { truncated: false, stderr: '' };
  }, undefined, async (_exe, _argv, options) => {
    await delay(20);
    options.onLine(JSON.stringify({ path: 'file.mjs' }));
    options.onLine(JSON.stringify({ total: 1 }));
    return { truncated: false, stderr: '' };
  });
  assert.ok((await age.glob('.', { pattern: '*.mjs' })).snapshotAgeMs >= 10);
  assert.equal(age.metrics().snapshots, 0, 'filter completion must not extend the original content TTL');
  await age.dispose();
});

test('oversized filter stdin is rejected before creating a process', async () => {
  let spawned = false;
  await assert.rejects(runRg('fake', [], {
    input: 'x'.repeat(32 * 1024 * 1024 + 1),
    spawnProcess: () => { spawned = true; throw new Error('must not spawn'); },
  }), /input exceeds 32 MiB/);
  assert.equal(spawned, false);
});
