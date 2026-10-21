import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { AdapterCache } from '../src/host/debug/cache.js';
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
test('pinned cache validates archive hashes, expanded paths and previously installed bytes', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-debug-cache-')), seed = join(root, 'seed'), cache = join(root, 'cache');
  await mkdir(seed);
  const bytes = zipSync({ 'adapter/main.js': strToU8('export const value = 21;') });
  const artifact = { id: 'fixture', name: 'fixture.zip', version: '1', sha256: hash(bytes), url: 'https://example.invalid/fixture.zip', license: 'MIT' };
  try {
    await writeFile(join(seed, artifact.name), bytes);
    const instance = new AdapterCache(cache, [artifact], seed), signal = new AbortController().signal;
    const installed = await instance.ensure('fixture', signal);
    assert.equal(await readFile(join(installed, 'adapter/main.js'), 'utf8'), 'export const value = 21;');
    await writeFile(join(installed, 'adapter/main.js'), 'changed');
    await assert.rejects(instance.ensure('fixture', signal), /removal/);
    await assert.rejects(new AdapterCache(join(root, 'other'), [{ ...artifact, sha256: '0'.repeat(64) }], seed).ensure('fixture', signal), /SHA-256/);
    const traversal = zipSync({ '../escape.txt': strToU8('escape') });
    await writeFile(join(seed, 'unsafe.zip'), traversal);
    await assert.rejects(new AdapterCache(join(root, 'unsafe'), [{ ...artifact, name: 'unsafe.zip', sha256: hash(traversal) }], seed).ensure('fixture', signal), /escapes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
