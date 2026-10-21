import assert from 'node:assert/strict';
import test from 'node:test';
import { CanvasArchiveCache } from '../src/host/canvas-archive-cache.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('concurrent graph reads and repeated unchanged sequence share one official archive read', async () => {
  const pending = deferred<string>();
  const owner = {};
  let reads = 0, seq = 4;
  const cache = new CanvasArchiveCache({
    load: async () => { reads++; return pending.promise; }, version: () => ({ owner, seq }), weight: value => value.length,
  });
  const a = cache.read('a'), b = cache.read('a');
  assert.equal(a, b);
  pending.resolve('archive');
  assert.equal(await a, 'archive');
  assert.equal(await cache.read('a'), 'archive');
  assert.equal(reads, 1);
  seq++;
  await cache.read('a');
  assert.equal(reads, 2, 'a committed event invalidates the old snapshot');
});

test('a sequence change during archive I/O cannot stamp the old read with a newer version', async () => {
  const pending = deferred<string>();
  const owner = {};
  let seq = 1, reads = 0;
  const cache = new CanvasArchiveCache({
    load: async () => ++reads === 1 ? pending.promise : 'fresh',
    version: () => ({ owner, seq }), weight: value => value.length,
  });
  const old = cache.read('a');
  await Promise.resolve();
  seq = 2;
  assert.equal(await cache.read('a'), 'fresh');
  pending.resolve('old');
  assert.equal(await old, 'old');
  assert.equal(await cache.read('a'), 'fresh');
  assert.equal(reads, 2);
});

test('native owner replacement and archive TTL invalidate without mixing session identities', async () => {
  let time = 0, reads = 0, owner: object | undefined = {};
  const cache = new CanvasArchiveCache({
    load: async id => `${id}:${++reads}`, version: () => ({ owner, seq: owner ? 1 : undefined }),
    weight: value => value.length, now: () => time, archiveTtlMs: 10,
  });
  assert.equal(await cache.read('a'), 'a:1');
  assert.equal(await cache.read('b'), 'b:2');
  owner = {};
  assert.equal(await cache.read('a'), 'a:3');
  owner = undefined;
  assert.equal(await cache.read('a'), 'a:4');
  time = 9;
  assert.equal(await cache.read('a'), 'a:4');
  time = 10;
  assert.equal(await cache.read('a'), 'a:5');
});

test('failed archive reads and cache admission failures do not poison future requests', async () => {
  let reads = 0, weights = 0;
  const owner = {};
  const cache = new CanvasArchiveCache({
    load: async () => { if (++reads === 1) throw new Error('temporary archive failure'); return 'ok'; },
    version: () => ({ owner, seq: 1 }),
    weight: value => { if (++weights === 1) throw new Error('admission failed'); return value.length; },
  });
  await assert.rejects(cache.read('a'), /temporary archive failure/);
  await assert.rejects(cache.read('a'), /admission failed/);
  assert.equal(await cache.read('a'), 'ok');
  assert.equal(await cache.read('a'), 'ok');
  assert.equal(reads, 3);
});

test('LRU and byte bounds retain hot entries and skip oversized archives', async () => {
  const counts = new Map<string, number>(), owner = {};
  const cache = new CanvasArchiveCache({
    load: async id => { counts.set(id, (counts.get(id) ?? 0) + 1); return id === 'huge' ? 'x'.repeat(100) : id; },
    version: () => ({ owner, seq: 1 }), weight: value => value.length, maxEntries: 2, maxBytes: 10,
  });
  await cache.read('a'); await cache.read('b'); await cache.read('a'); await cache.read('c');
  await cache.read('a');
  assert.equal(counts.get('a'), 1);
  await cache.read('huge');
  await cache.read('a');
  assert.equal(counts.get('a'), 1);
  await cache.read('huge');
  assert.equal(counts.get('huge'), 2);
  await cache.read('b');
  assert.equal(counts.get('b'), 2);
  cache.clear();
  await cache.read('a');
  assert.equal(counts.get('a'), 2);
});
