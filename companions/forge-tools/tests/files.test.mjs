import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, symlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { environment } from './helpers.mjs';
import { HostFiles } from '../src/host-files.mjs';

test('legacy shellOnly configuration still activates the complete file, search and PowerShell toolset', async t => {
  const { ctx, execute } = await environment(t, { config: { shellOnly: true } });
  for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'pwsh_run'])
    assert.ok(ctx.tools.get(name), `Missing unified tool: ${name}`);
  await execute('write', { file_path: 'unified.txt', content: 'before' });
  await execute('edit', { file_path: 'unified.txt', old_string: 'before', new_string: 'after' });
  assert.equal((await execute('read', { file_path: 'unified.txt', fresh: true })).lines[0].text, 'after');
  assert.deepEqual((await execute('glob', { pattern: '**/*.txt' })).files, ['unified.txt']);
  assert.equal((await execute('grep', { pattern: 'after' })).matches.length, 1);
});

test('SDK registration, bounded cache, fresh read, TTL and stale mutation guard', async t => {
  const { root, execute, observations } = await environment(t, { guarded: true, config: { cacheTtlMs: 80 } });
  await writeFile(path.join(root, '中文 文件.txt'), 'first\nsecond\n');
  const initial = await execute('read', { file_path: '中文 文件.txt', limit: 1 });
  assert.equal(initial.offset, 1); assert.equal(initial.lines[0].text, 'first');
  const version = [...observations.values()][0].version;
  await writeFile(path.join(root, '中文 文件.txt'), 'external\nsecond\n');
  assert.equal((await execute('read', { file_path: '中文 文件.txt', limit: 1 })).lines[0].text, 'first');
  assert.equal([...observations.values()][0].version, version);
  await assert.rejects(execute('edit', { file_path: '中文 文件.txt', old_string: 'second', new_string: 'third' }), /stale|changed|version/i);
  assert.equal((await readFile(path.join(root, '中文 文件.txt'), 'utf8')), 'external\nsecond\n');
  await execute('read', { file_path: '中文 文件.txt', fresh: true });
  await execute('edit', { file_path: '中文 文件.txt', old_string: 'second', new_string: 'third' });
  assert.match(await readFile(path.join(root, '中文 文件.txt'), 'utf8'), /third/);
  await execute('read', { file_path: '中文 文件.txt' });
  await writeFile(path.join(root, '中文 文件.txt'), 'later');
  await delay(100);
  assert.equal((await execute('read', { file_path: '中文 文件.txt' })).lines[0].text, 'later');
});

test('batch reads isolate failures; ordered batch edits report partial commit', async t => {
  const { root, execute } = await environment(t, { guarded: true });
  await writeFile(path.join(root, 'a'), 'one');
  await writeFile(path.join(root, 'b'), 'two');
  const result = await execute('read_many', { files: [{ file_path: 'a' }, { file_path: 'b' }, { file_path: 'missing' }] });
  assert.deepEqual(result.map(e => e.ok), [true, true, false]);
  const edited = await execute('batch_edit', { edits: [
    { file_path: 'a', old_string: 'one', new_string: 'ONE' },
    { file_path: 'b', old_string: 'absent', new_string: 'X' },
  ] });
  assert.equal(edited.completed, 1); assert.equal(edited.failed, 'b');
  assert.equal(await readFile(path.join(root, 'a'), 'utf8'), 'ONE');
  assert.equal(await readFile(path.join(root, 'b'), 'utf8'), 'two');
});

test('large streaming read stops after requested window and closes iterator', async () => {
  let consumed = 0, closed = false;
  const ctx = { fs: {
    resolve: async () => ({ targetKey: 'key', displayPath: 'large' }),
    stat: async () => ({ version: 'v1', type: 'file', size: 1e10 }),
    streamText: async () => (async function* () {
      try { for (let i = 0; i < 100; i++) { consumed++; yield 'line\n'.repeat(100); } }
      finally { closed = true; }
    })(), processPath: target => target.displayPath,
  }, workingDirectory: { ensure: async () => '.' }, emit() {} };
  const files = new HostFiles(ctx, { watch: false });
  const result = await files.read({ file_path: 'large', limit: 5 }, { agent: {}, signal: new AbortController().signal });
  assert.equal(result.lines.length, 5); assert.equal(consumed, 1); assert.equal(closed, true);
  assert.equal(result.totalLines, null);
});

test('expired unchanged cache validates metadata without reopening content; fresh always reads', async t => {
  const { root, execute } = await environment(t, { config: { cacheTtlMs: 10 } });
  await writeFile(path.join(root, 'a'), 'unchanged');
  await execute('read', { file_path: 'a' });
  await delay(20);
  await execute('read', { file_path: 'a' });
  let status = await execute('forge_status', {});
  assert.equal(status.files.providerReads, 1);
  assert.equal(status.files.validatedHits, 1);
  await execute('read', { file_path: 'a', fresh: true });
  status = await execute('forge_status', {});
  assert.equal(status.files.providerReads, 2);
});

test('zero TTL disables cached bodies', async t => {
  const { root, execute } = await environment(t, { config: { cacheTtlMs: 0 } });
  await writeFile(path.join(root, 'a'), 'uncached');
  await execute('read', { file_path: 'a' });
  await execute('read', { file_path: 'a' });
  const status = await execute('forge_status', {});
  assert.equal(status.files.providerReads, 2); assert.equal(status.files.cacheEntries, 0);
});

test('watch invalidates external changes and clear_cache drops cached reads', async t => {
  const { root, execute } = await environment(t, { config: { watch: true, cacheTtlMs: 10000 } });
  await writeFile(path.join(root, 'watch.txt'), 'old');
  await execute('read', { file_path: 'watch.txt' });
  await writeFile(path.join(root, 'watch.txt'), 'new');
  let value;
  for (let i = 0; i < 20; i++) {
    await delay(20); value = await execute('read', { file_path: 'watch.txt' });
    if (value.lines[0].text === 'new') break;
  }
  assert.equal(value.lines[0].text, 'new');
  await execute('forge_status', { clear_cache: true });
  assert.equal((await execute('forge_status', {})).files.cacheEntries, 0);
});

test('empty strings, CRLF, precise replacement and concurrent guarded writes', async t => {
  const { root, execute } = await environment(t, { guarded: true });
  await execute('read_many', { files: [{ file_path: 'new.txt' }] });
  await execute('write', { file_path: 'new.txt', content: 'a\r\na\r\n' });
  await execute('read', { file_path: 'new.txt', fresh: true });
  await assert.rejects(execute('edit', { file_path: 'new.txt', old_string: 'a', new_string: 'b' }), error => error.code === 'FS_AMBIGUOUS_EDIT');
  await execute('edit', { file_path: 'new.txt', old_string: 'a', new_string: '', replace_all: true });
  const data = await readFile(path.join(root, 'new.txt'), 'utf8');
  assert.equal(data.replaceAll('\r', ''), '\n\n');
  await execute('read', { file_path: 'new.txt', fresh: true });
  const outcomes = await Promise.allSettled(['ONE', 'TWO'].map(content => execute('write', { file_path: 'new.txt', content })));
  assert.equal(outcomes.filter(e => e.status === 'fulfilled').length, 1);
});
