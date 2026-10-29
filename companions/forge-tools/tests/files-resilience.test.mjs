import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HostFiles } from '../src/host-files.mjs';

const deferred = () => Promise.withResolvers();
const execution = signal => ({ agent: {}, signal: signal ?? new AbortController().signal });
const tick = () => new Promise(resolve => setImmediate(resolve));
const target = file => ({ targetKey: file, displayPath: file });

function harness(config = {}, overrides = {}) {
  const observations = [];
  const counts = { resolve: 0, stat: 0, read: 0, write: 0, list: 0 };
  const state = { text: 'old', version: 'v1', size: 3 };
  const ctx = {
    fs: {
      resolve: async file => { counts.resolve++; return target(file); },
      stat: async () => { counts.stat++; return { type: 'file', size: state.size, version: state.version }; },
      readBytes: async () => { counts.read++; return Buffer.from(state.text); },
      streamText: async () => [state.text],
      writeText: async (_target, content) => {
        counts.write++;
        const before = state.text;
        state.text = content; state.size = Buffer.byteLength(content); state.version = 'v2';
        return { before, after: content, version: state.version };
      },
      listDir: async () => { counts.list++; return []; },
      processPath: target => target.displayPath,
      processPathFromHostPath: value => value,
      ...overrides,
    },
    workingDirectory: { ensure: async () => '.' },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    waterfall: async () => undefined,
    emit: (...args) => observations.push(args),
  };
  const files = new HostFiles(ctx, { watch: false, ...config });
  return { files, ctx, counts, state, observations };
}

async function rejectsPromptly(promise, pattern) {
  const timeout = new AbortController();
  try {
    await Promise.race([
      assert.rejects(promise, pattern),
      delay(500, undefined, { signal: timeout.signal }).then(() => {
        assert.fail('Cancellation did not settle while the provider remained blocked');
      }),
    ]);
  } finally { timeout.abort(); }
}

test('uncooperative slow reads cancel promptly and never continue, cache, or observe later', async t => {
  for (const stage of ['resolve', 'stat', 'readBytes']) await t.test(stage, async () => {
    const started = deferred(), release = deferred();
    const { files, ctx, counts, observations } = harness();
    const original = ctx.fs[stage];
    ctx.fs[stage] = async (...args) => {
      started.resolve();
      await release.promise; // Injected provider deliberately ignores AbortSignal.
      return original(...args);
    };
    const controller = new AbortController();
    const result = files.read({ file_path: 'slow.txt' }, execution(controller.signal));
    await started.promise;
    controller.abort(new Error('injected cancellation'));
    await rejectsPromptly(result, /injected cancellation/);
    assert.equal(files.metrics().activeIo, 1, 'OS/provider work still owns its capacity');
    release.resolve(); await tick(); await tick();
    assert.equal(files.metrics().activeIo, 0);
    assert.equal(files.metrics().pendingReads, 0);
    assert.equal(files.metrics().cacheEntries, 0);
    assert.equal(observations.length, 0);
    if (stage === 'resolve') assert.equal(counts.stat, 0);
    if (stage !== 'readBytes') assert.equal(counts.read, 0);
    files.dispose();
  });
});

test('cancelled stale load cannot overwrite a later successful read or create hidden extra I/O', async () => {
  const started = deferred(), release = deferred();
  const { files, ctx, state, counts } = harness({ concurrency: 1 });
  const original = ctx.fs.readBytes;
  let first = true;
  ctx.fs.readBytes = async (...args) => {
    if (!first) return original(...args);
    first = false; started.resolve(); await release.promise; return Buffer.from('old snapshot');
  };
  const controller = new AbortController();
  const old = files.read({ file_path: 'one' }, execution(controller.signal));
  await started.promise; controller.abort(new Error('stop old read'));
  await rejectsPromptly(old, /stop old read/);
  state.text = 'new'; state.version = 'v2';
  const current = files.read({ file_path: 'one' }, execution());
  await tick();
  assert.equal(counts.read, 0, 'new read waits for the real provider slot');
  release.resolve();
  assert.equal((await current).lines[0].text, 'new');
  assert.equal((await files.read({ file_path: 'one' }, execution())).lines[0].text, 'new');
  assert.equal(counts.read, 1);
  files.dispose();
});

test('dispose clears queues, cached state and listeners without releasing a blocked OS operation', async () => {
  const started = deferred(), release = deferred();
  const { files, ctx } = harness({ concurrency: 1 });
  ctx.fs.readBytes = async () => { started.resolve(); await release.promise; return Buffer.from('old'); };
  const controller = new AbortController();
  const baseline = getEventListeners(controller.signal, 'abort').length;
  const first = files.read({ file_path: 'blocked' }, execution(controller.signal));
  const settled = Promise.allSettled([first]);
  await started.promise;
  const queued = Array.from({ length: 64 }, (_, i) =>
    files.read({ file_path: `queued-${i}` }, execution(controller.signal)));
  const allQueued = Promise.allSettled(queued);
  await tick();
  assert.equal(files.metrics().queuedIo, 64);
  files.dispose(); files.dispose();
  assert.equal((await settled)[0].status, 'rejected');
  assert.ok((await allQueued).every(result => result.status === 'rejected'));
  assert.equal(files.metrics().cacheEntries, 0);
  assert.equal(files.metrics().pendingReads, 0);
  assert.equal(files.metrics().queuedIo, 0);
  assert.equal(files.metrics().activeIo, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, baseline);
  await assert.rejects(files.read({ file_path: 'after' }, execution()), error => error.code === 'FS_DISPOSED');
  await assert.rejects(files.list({}, execution()), error => error.code === 'FS_DISPOSED');
  await assert.rejects(files.mutate('write', { file_path: 'after', content: 'x' }, execution()),
    error => error.code === 'FS_DISPOSED');
  release.resolve(); await tick(); await tick();
  assert.equal(files.metrics().activeIo, 0);
  assert.equal(files.metrics().cacheEntries, 0);
});

test('streaming and directory enumeration share bounded I/O capacity and cancellation releases iterators', async () => {
  const started = deferred(), release = deferred();
  let closed = 0;
  const { files, ctx, state, counts } = harness({ concurrency: 1 });
  state.size = 1e10;
  ctx.fs.streamText = async () => (async function* () {
    try { started.resolve(); await release.promise; yield 'delayed\n'; }
    finally { closed++; }
  })();
  const controller = new AbortController();
  const read = files.read({ file_path: 'stream', limit: 1 }, execution(controller.signal));
  await started.promise;
  const list = files.list({}, execution());
  await tick(); assert.equal(counts.list, 0);
  controller.abort(new Error('stop stream'));
  await rejectsPromptly(read, /stop stream/);
  assert.equal(files.metrics().activeIo, 1);
  release.resolve();
  await list; await tick();
  assert.equal(closed, 1);
  assert.equal(files.metrics().activeIo, 0);
  files.dispose();
});

test('search-root metadata checks are bounded and cannot launch late work after cancellation', async () => {
  const started = deferred(), release = deferred();
  const { files, ctx, counts } = harness({ concurrency: 1 });
  ctx.fs.resolve = async file => { started.resolve(); await release.promise; return target(file); };
  const controller = new AbortController();
  const root = files.searchRoot({}, execution(controller.signal));
  await started.promise;
  controller.abort(new Error('stop search root'));
  await rejectsPromptly(root, /stop search root/);
  assert.equal(files.metrics().activeIo, 1);
  release.resolve(); await tick(); await tick();
  assert.equal(counts.stat, 0);
  assert.equal(files.metrics().activeIo, 0);
  files.dispose();
});

test('cancelled uncooperative pre-write preparation settles promptly and cannot dispatch a write later', async t => {
  for (const stage of ['cwd', 'resolve', 'policy', 'intent']) await t.test(stage, async () => {
    const started = deferred(), release = deferred();
    const { files, ctx, counts } = harness({ concurrency: 1 });
    if (stage === 'cwd') ctx.workingDirectory.ensure = async () => {
      started.resolve(); await release.promise; return '.';
    };
    else if (stage === 'resolve') ctx.fs.resolve = async file => {
      started.resolve(); await release.promise; return target(file);
    };
    else if (stage === 'policy') ctx.sandboxPolicy.resolve = async () => {
      started.resolve(); await release.promise; return { mode: 'danger-full-access' };
    };
    else ctx.waterfall = async () => { started.resolve(); await release.promise; };
    const controller = new AbortController();
    const write = files.mutate('write', { file_path: 'one', content: 'new' }, execution(controller.signal));
    await started.promise;
    controller.abort(new Error('stop before publication'));
    await rejectsPromptly(write, /stop before publication/);
    assert.equal(files.metrics().activeIo, ['cwd', 'resolve'].includes(stage) ? 1 : 0);
    assert.equal(counts.write, 0);
    release.resolve(); await tick(); await tick();
    assert.equal(files.metrics().activeIo, 0);
    assert.equal(counts.write, 0);
    if (stage === 'cwd') assert.equal(counts.resolve, 0);
    files.dispose();
  });
});

test('a confirmed late atomic commit remains truthful and invalidates bodies read during the write', async () => {
  const started = deferred(), release = deferred();
  const { files, ctx, state } = harness({ concurrency: 2, ttlMs: 30000 });
  const original = ctx.fs.writeText;
  ctx.fs.writeText = async (...args) => {
    started.resolve(); await release.promise; return original(...args);
  };
  await files.read({ file_path: 'one' }, execution());
  const controller = new AbortController();
  const write = files.mutate('write', { file_path: 'one', content: 'committed' }, execution(controller.signal));
  await started.promise;
  assert.equal((await files.read({ file_path: 'one' }, execution())).lines[0].text, 'old');
  controller.abort(new Error('cancellation during publication'));
  release.resolve();
  const outcome = await write;
  assert.equal(outcome.after, 'committed');
  assert.equal(state.text, 'committed');
  assert.equal(files.metrics().cacheEntries, 0);
  assert.equal((await files.read({ file_path: 'one' }, execution())).lines[0].text, 'committed');
  files.dispose();
});

test('post-publication provider failure reports unknown commit state and never retries a write', async () => {
  const { files, ctx, state, counts } = harness();
  await files.read({ file_path: 'one' }, execution());
  const original = ctx.fs.writeText;
  ctx.fs.writeText = async (...args) => {
    await original(...args);
    const error = new Error('post-rename stat failed'); error.code = 'FS_IO_ERROR'; throw error;
  };
  await assert.rejects(files.mutate('write', { file_path: 'one', content: 'already published' }, execution()), error => {
    assert.equal(error.code, 'FS_IO_ERROR');
    assert.equal(error.commitState, 'unknown');
    return true;
  });
  assert.equal(counts.write, 1);
  assert.equal(state.text, 'already published');
  assert.equal(files.metrics().cacheEntries, 0);
  assert.equal((await files.read({ file_path: 'one', fresh: true }, execution())).lines[0].text, 'already published');
  files.dispose();
});

test('fresh streaming reads evict an earlier small cached body', async () => {
  const { files, state } = harness({ ttlMs: 30000 });
  await files.read({ file_path: 'one' }, execution());
  state.text = 'now large'; state.size = 1e10; state.version = 'v2';
  assert.equal((await files.read({ file_path: 'one', fresh: true }, execution())).lines[0].text, 'now large');
  assert.equal(files.metrics().cacheEntries, 0);
  assert.equal((await files.read({ file_path: 'one' }, execution())).lines[0].text, 'now large');
  files.dispose();
});

test('post-stat file growth uses bounded byte reads and falls back to a limited streaming window', async () => {
  let boundedCalls = 0, consumed = 0, closed = false;
  const { files, ctx } = harness({ cacheFileBytes: 1024 });
  ctx.fs.readBytes = async (_target, _signal, maxBytes) => {
    boundedCalls++; assert.equal(maxBytes, 1024);
    const error = new Error('grew after stat'); error.code = 'FS_TOO_LARGE'; throw error;
  };
  ctx.fs.streamText = async () => (async function* () {
    try { for (let i = 0; i < 10000; i++) { consumed++; yield 'large\n'.repeat(100); } }
    finally { closed = true; }
  })();
  const value = await files.read({ file_path: 'growing', limit: 2 }, execution());
  assert.equal(boundedCalls, 1); assert.equal(consumed, 1); assert.equal(closed, true);
  assert.equal(value.lines.length, 2); assert.equal(value.cache, 'stream');
  assert.equal(files.metrics().cacheEntries, 0);
  files.dispose();
});

test('bounded bytes retain official UTF-8 and binary rejection semantics', async () => {
  const { files, ctx, state } = harness();
  state.text = '中文 😀\r\n'; state.size = Buffer.byteLength(state.text);
  assert.equal((await files.read({ file_path: 'utf8' }, execution())).lines[0].text, '中文 😀');
  state.text = `${'x'.repeat(1999)}😀`; state.size = Buffer.byteLength(state.text); state.version = 'v2';
  const clipped = (await files.read({ file_path: 'surrogate-boundary' }, execution())).lines[0].text;
  assert.equal(clipped, state.text.slice(0, 2000));
  assert.equal(clipped.charCodeAt(1999), 0xd83d);
  ctx.fs.readBytes = async () => Uint8Array.from([0xff, 0x61]);
  await assert.rejects(files.read({ file_path: 'invalid' }, execution()), error => error.code === 'FS_NOT_TEXT');
  ctx.fs.readBytes = async () => Uint8Array.from([0x61, 0]);
  await assert.rejects(files.read({ file_path: 'binary' }, execution()), error => error.code === 'FS_NOT_TEXT');
  files.dispose();
});

test('cache churn is bounded by estimated retained strings, metadata and entry count', () => {
  const { files } = harness({ cacheBytes: 128 * 1024, cacheFileBytes: 8192 });
  const text = 'a'.repeat(4096);
  for (let i = 0; i < 20000; i++) {
    const file = `long-path-${i}-${'b'.repeat(200)}`;
    files.put(JSON.stringify(['.', file]), { text, target: target(file), version: 'v1', sha256: 'x'.repeat(64) }, files.epoch);
    assert.ok(files.bytes <= 128 * 1024);
  }
  assert.ok(files.metrics().cacheEntries < 16, 'UTF-16 strings and metadata are charged against the budget');
  assert.ok(files.metrics().cacheBytes >= files.metrics().cacheEntries * text.length * 2);
  files.clear();
  assert.equal(files.metrics().cacheBytes, 0);
  assert.equal(files.metrics().cacheEntries, 0);
  files.config.cacheBytes = 16 * 1024 * 1024;
  for (let i = 0; i < 10000; i++)
    files.put(`${i}`, { text: '', target: target(`${i}`), version: 'v1' }, files.epoch);
  assert.equal(files.metrics().cacheEntries, 4096);
  files.dispose();
  assert.equal(files.metrics().cacheBytes, 0);
});

test('native watchers remain bounded and late callbacks cannot resurrect disposed state', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-watch-resilience-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { files } = harness({ watch: true });
  t.after(() => files.dispose());
  const dirs = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const dir = path.join(root, `${i}`); await mkdir(dir); return dir;
  }));
  files.ensureWatch(dirs[0]);
  const old = files.watchers.get(dirs[0]);
  assert.ok(old, 'native directory watcher started');
  for (const dir of dirs) {
    files.ensureWatch(dir);
    assert.ok(files.watchers.size <= 8);
  }
  const invalidations = files.stats.invalidations;
  old.emit('error', new Error('late error on evicted watcher'));
  assert.equal(files.stats.invalidations, invalidations);
  const last = [...files.watchers.values()].find(Boolean);
  files.dispose();
  last.emit('error', new Error('late error after disposal'));
  assert.equal(files.watchers.size, 0);
  assert.equal(files.metrics().watchers, 0);
});
