import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { runRg, SearchEngine } from '../src/search.mjs';

function fakeChild(t, { closeOnKill = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = []; child.unref = () => {};
  child.kill = kind => {
    child.kills.push(kind ?? 'SIGTERM');
    if (closeOnKill) queueMicrotask(() => child.emit('close', null));
    return true;
  };
  t.after(() => {
    child.emit('close', null);
    child.stdout.destroy(); child.stderr.destroy();
  });
  return child;
}

async function bounded(promise, milliseconds = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('test watchdog expired')), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

const event = (file = 'source.txt', text = 'needle\n') => JSON.stringify({
  type: 'match', data: { path: { text: file }, lines: { text }, line_number: 1 },
});
const passFilter = async (_exe, _argv, options) => {
  const { files, limit } = JSON.parse(options.input);
  for (const file of files.slice(0, limit)) options.onLine(JSON.stringify({ path: file }));
  options.onLine(JSON.stringify({ total: files.length }));
  return { truncated: false, stderr: '' };
};

test('search timeout bounds a child that never closes and quarantines it until late close', async t => {
  const children = [fakeChild(t), fakeChild(t)];
  for (const child of children) {
    await assert.rejects(bounded(runRg('fake', [], {
      spawnProcess: () => child, timeoutMs: 10, killGraceMs: 10,
    })), /exceeded 10 ms/);
    assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stdout.listenerCount('data'), 0);
  }
  let spawned = false;
  await assert.rejects(runRg('fake', [], {
    spawnProcess: () => { spawned = true; return fakeChild(t); },
  }), /awaiting OS termination/);
  assert.equal(spawned, false);
  const engine = new SearchEngine({}, async () => ({ truncated: false, stderr: '' }));
  assert.equal(engine.metrics().unconfirmedProcesses, 2);
  children.forEach(child => child.emit('close', null));
  assert.equal(engine.metrics().unconfirmedProcesses, 0);
  await engine.dispose();
});

test('abort cannot resume parsing and late close/error events are harmless', async t => {
  const child = fakeChild(t), controller = new AbortController();
  let records = 0;
  const result = runRg('fake', [], {
    spawnProcess: () => child, signal: controller.signal, timeoutMs: 500, killGraceMs: 10,
    onLine: () => { records++; },
  });
  child.stdout.write('first\n');
  controller.abort(new Error('cancel-stalled-disk'));
  for (let i = 0; i < 100; i++) child.stdout.write('ignored\n');
  await assert.rejects(bounded(result), /cancel-stalled-disk/);
  assert.equal(records, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.doesNotThrow(() => child.emit('error', new Error('late native failure')));
  child.emit('close', null);
});

test('abort reentrancy stops records inside one chunk and rejects a final unterminated record', async t => {
  for (const terminated of [true, false]) {
    const child = fakeChild(t, { closeOnKill: true }), controller = new AbortController();
    let records = 0;
    const result = runRg('fake', [], {
      spawnProcess: () => child, signal: controller.signal,
      onLine: () => { records++; controller.abort(new Error('cancel-from-record')); },
    });
    child.stdout.write(terminated ? 'first\nsecond\nthird\n' : 'last');
    if (!terminated) child.emit('close', 0);
    await assert.rejects(bounded(result), /cancel-from-record/);
    assert.equal(records, 1);
  }
});

test('parser failure stops the whole chunk and enormous unterminated records are bounded', async t => {
  const bad = fakeChild(t, { closeOnKill: true });
  let callbacks = 0;
  const failure = runRg('fake', [], {
    spawnProcess: () => bad, timeoutMs: 500,
    onLine: () => { callbacks++; throw new Error('invalid output'); },
  });
  bad.stdout.write('bad\nsecond\nthird\n');
  await assert.rejects(bounded(failure), /invalid output/);
  assert.equal(callbacks, 1);
  const huge = fakeChild(t, { closeOnKill: true });
  let parsed = false;
  const capped = runRg('fake', [], {
    spawnProcess: () => huge, maxRecordBytes: 256, maxBytes: 4096,
    onLine: () => { parsed = true; },
  });
  huge.stdout.write('x'.repeat(257));
  const result = await bounded(capped);
  assert.equal(result.truncated, true);
  assert.equal(parsed, false);
  assert.equal(huge.stdout.listenerCount('data'), 0);
});

test('output bytes and stderr retention have independent hard bounds', async t => {
  const child = fakeChild(t, { closeOnKill: true });
  const result = runRg('fake', [], { spawnProcess: () => child, maxBytes: 64 });
  child.stderr.write('e'.repeat(100000));
  child.stdout.write('x'.repeat(65));
  const value = await bounded(result);
  assert.equal(value.truncated, true);
  assert.equal(value.stderr.length, 12000);
  assert.equal(value.bytes, 65);
});

test('a real sleeping subprocess is killed on the search deadline', async () => {
  let child;
  await assert.rejects(bounded(runRg(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 80, killGraceMs: 100,
    spawnProcess: (...args) => (child = spawn(...args)),
  })), /exceeded 80 ms/);
  for (let i = 0; child.exitCode === null && child.signalCode === null && i < 20; i++) await delay(10);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('search total deadline includes a never-returning executable path check without leaking waiters', async () => {
  let calls = 0;
  const engine = new SearchEngine({ timeoutMs: 5, shutdownWaitMs: 20 }, async () => { calls++; },
    () => new Promise(() => {}));
  for (let i = 0; i < 50; i++) {
    await assert.rejects(bounded(engine.grep('.', { pattern: `wait-${i}` })), /timed out|aborted|exceeded/i);
    assert.equal(engine.readiness.waiters.size, 0);
    assert.equal(engine.metrics().gate.active, 0);
  }
  assert.equal(calls, 0);
  await bounded(engine.dispose());
});

test('uncooperative runners retain their slots, cancel callers, and permit bounded disposal', async () => {
  let calls = 0;
  const engine = new SearchEngine({ timeoutMs: 10, shutdownWaitMs: 15 }, async () => {
    calls++; return new Promise(() => {});
  });
  for (let round = 0; round < 5; round++) {
    await bounded(Promise.all(Array.from({ length: 12 }, (_, i) =>
      engine.grep('.', { pattern: `hung-${round}-${i}` }).catch(error => error))));
    assert.equal(calls, 2);
    assert.equal(engine.metrics().running, 2);
    assert.equal(engine.metrics().gate.active, 2);
    assert.equal(engine.metrics().gate.queued, 0);
  }
  await bounded(engine.dispose());
  assert.equal(engine.metrics().running, 2);
  assert.equal(engine.metrics().gate.closed, true);
  await assert.rejects(engine.grep('.', { pattern: 'after-dispose' }), /disposed/);
});

test('dispose cancels active and queued searches while awaiting actual child teardown', async t => {
  const children = [];
  const engine = new SearchEngine({ shutdownWaitMs: 200 }, (_exe, _argv, options) => {
    const child = fakeChild(t); children.push(child);
    return runRg('fake', [], { ...options, spawnProcess: () => child, killGraceMs: 10 });
  });
  const pending = Array.from({ length: 20 }, (_, i) => engine.grep('.', { pattern: `dispose-${i}` }).catch(error => error));
  await delay(5);
  await bounded(engine.dispose());
  const results = await bounded(Promise.all(pending));
  assert.equal(children.length, 2);
  assert.equal(results.every(error => /disposed/.test(error.message)), true);
  assert.equal(engine.metrics().running, 0);
  assert.equal(engine.metrics().gate.active, 0);
  assert.equal(engine.metrics().gate.queued, 0);
  assert.equal(engine.metrics().unconfirmedProcesses, 2);
  children.forEach(child => child.emit('close', null));
});

test('snapshot caches obey a global byte budget over repeated workspaces and many short names', async () => {
  const engine = new SearchEngine({
    ttlMs: 30000, maxSnapshotBytes: 4096, maxSnapshotFiles: 12, maxSnapshots: 8,
  }, async (_exe, _argv, options) => {
    for (let i = 0; i < 8; i++) options.onLine(`./source-${i}.mjs`);
    return { truncated: false, stderr: '' };
  }, undefined, passFilter);
  for (let i = 0; i < 200; i++) {
    await engine.glob(`workspace-${i}`, { pattern: '**/*.mjs' });
    const metrics = engine.metrics();
    assert.ok(metrics.snapshotBytes <= 4096);
    assert.ok(metrics.snapshots <= 8);
  }
  assert.ok(engine.metrics().snapshots < 8, 'the byte budget must evict before the count limit');
  engine.invalidate();
  assert.equal(engine.metrics().snapshotBytes, 0);
  await engine.dispose();
  const capped = new SearchEngine({ maxSnapshotBytes: 4096, maxSnapshotFiles: 3 }, async (_exe, _argv, options) => {
    let truncated = false;
    for (let i = 0; i < 10000; i++) {
      if (options.onLine(String(i)) === false) { truncated = true; break; }
    }
    return { truncated, stderr: '' };
  }, undefined, passFilter);
  const result = await capped.glob('.', { pattern: '*' });
  assert.equal(result.files.length, 3);
  assert.equal(result.truncated, true);
  assert.equal(capped.metrics().snapshots, 0, 'partial snapshots must not be cached');
  await capped.dispose();
});

test('query cache budgets, zero TTL, and returned-array isolation remain bounded under churn', async () => {
  const runner = async (_exe, _argv, options) => {
    options.onLine(event('source.txt', 'n'.repeat(100)));
    return { truncated: false, stderr: '' };
  };
  const engine = new SearchEngine({ ttlMs: 30000, maxQueryBytes: 1200, maxQueries: 8 }, runner);
  for (let i = 0; i < 200; i++) {
    await engine.grep('.', { pattern: `needle-${i}` });
    assert.ok(engine.metrics().queryBytes <= 1200);
    assert.ok(engine.metrics().queryEntries <= 8);
  }
  const args = { pattern: 'mutation' };
  const first = await engine.grep('.', args);
  first.matches[0].text = 'corrupted'; first.matches.push({ path: 'fake' });
  const cached = await engine.grep('.', args);
  assert.equal(cached.matches.length, 1);
  assert.equal(cached.matches[0].text, 'n'.repeat(100));
  cached.matches.length = 0;
  assert.equal((await engine.grep('.', args)).matches.length, 1);
  engine.invalidate();
  assert.equal(engine.metrics().queryBytes, 0);
  await engine.dispose();
  const uncached = new SearchEngine({ ttlMs: 0 }, runner);
  for (let i = 0; i < 20; i++) {
    await uncached.grep('.', { pattern: `zero-${i}` });
    await uncached.files(`workspace-${i}`);
  }
  assert.equal(uncached.metrics().queryEntries, 0);
  assert.equal(uncached.metrics().snapshots, 0);
  await uncached.dispose();
});

test('cache entries expire and cancelled cached searches never return a stale success', async () => {
  const engine = new SearchEngine({ ttlMs: 5 }, async (_exe, argv, options) => {
    options.onLine(argv.includes('--files') ? 'source.mjs' : event());
    return { truncated: false, stderr: '' };
  });
  await engine.grep('.', { pattern: 'needle' });
  await engine.files('.');
  await delay(10);
  assert.equal(engine.metrics().queryBytes, 0);
  assert.equal(engine.metrics().snapshotBytes, 0);
  await engine.grep('.', { pattern: 'needle' });
  const controller = new AbortController(); controller.abort(new Error('already cancelled'));
  await assert.rejects(engine.grep('.', { pattern: 'needle' }, controller.signal), /already cancelled/);
  await assert.rejects(engine.files('.', {}, controller.signal), /already cancelled/);
  await engine.dispose();
});

test('oversized input is rejected before queueing and ignored arguments never enter cache keys', async () => {
  const engine = new SearchEngine({ ttlMs: 30000 }, async (_exe, _argv, options) => {
    options.onLine(event()); return { truncated: false, stderr: '' };
  });
  const long = 'x'.repeat(32769);
  await assert.rejects(engine.grep('.', { pattern: long }), /at most 32768/);
  await assert.rejects(engine.grep('.', { pattern: 'needle', glob: long }), /at most 32768/);
  await assert.rejects(engine.grep(long, { pattern: 'needle' }), /at most 32768/);
  await assert.rejects(engine.glob('.', { pattern: long }), /at most 32768/);
  assert.equal(engine.metrics().processes, 0);
  await engine.grep('.', { pattern: 'needle', ignored: 'x'.repeat(1000000) });
  const args = { pattern: 'needle' }; args.ignored = args;
  const cached = await engine.grep('.', args);
  assert.equal(cached.cache, 'bounded');
  assert.equal(engine.metrics().processes, 1);
  assert.equal(engine.metrics().queryEntries, 1);
  assert.ok(engine.metrics().queryBytes < 1000);
  await engine.dispose();
});
