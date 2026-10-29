import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { SearchEngine } from '../src/search.mjs';
import { environment } from './helpers.mjs';

test('real ripgrep glob ignores, UTF-8 paths, query cache and output cap', async t => {
  const { root, execute } = await environment(t);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, '.ignore'), 'ignored.txt\n');
  await writeFile(path.join(root, 'ignored.txt'), 'needle\n');
  await writeFile(path.join(root, 'src', '中文 文件.cs'), 'needle\nneedle\nneedle\n');
  const found = await execute('glob', { pattern: '**/*.cs' });
  assert.deepEqual(found.files, ['src/中文 文件.cs']);
  assert.deepEqual((await execute('glob', { pattern: '*.txt' })).files, []);
  const search = await execute('grep', { pattern: 'needle', limit: 2 });
  assert.equal(search.matches.length, 2); assert.equal(search.truncated, true);
  assert.equal(search.matches[0].line, 1);
  const again = await execute('grep', { pattern: 'needle', limit: 2 });
  assert.equal(again.cache, 'bounded');
  const all = await execute('grep', { pattern: 'needle', no_ignore: true, fresh: true });
  assert.equal(all.matches.length, 4);
  await assert.rejects(execute('grep', { pattern: '[bad' }), /regex|ripgrep/);
});

test('NUL filenames normalize and ignore-aware snapshots serve isolated glob filters until invalidation', async () => {
  let calls = 0;
  const engine = new SearchEngine({}, async (_exe, _argv, options) => {
    calls++; options.onLine('./src/a.mjs'); options.onLine('.\\src\\b.mjs');
    return { truncated: false, stderr: '' };
  });
  assert.equal((await engine.glob('.', { pattern: 'src/**/*.mjs' })).files.length, 2);
  await engine.glob('.', { pattern: 'src/**/*.mjs' });
  assert.equal(calls, 1);
  await engine.glob('.', { pattern: '**/*.mjs' });
  assert.equal(calls, 1);
  engine.invalidate();
  await engine.glob('.', { pattern: '**/*.mjs' });
  assert.equal(calls, 2);
  await engine.dispose();
});

test('cancelled searches reject without starting another process', async () => {
  const engine = new SearchEngine();
  const controller = new AbortController(); controller.abort(new Error('test-cancel'));
  await assert.rejects(engine.grep('.', { pattern: 'x' }, controller.signal), /test-cancel/);
  assert.equal(engine.metrics().processes, 0);
  engine.dispose();
});

test('search disposal waits for in-flight cancellation cleanup', async () => {
  let finished = false;
  const engine = new SearchEngine({}, async (_exe, _argv, options) => {
    await new Promise(resolve => {
      if (options.signal.aborted) resolve();
      else options.signal.addEventListener('abort', resolve, { once: true });
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    finished = true;
    throw options.signal.reason;
  });
  const operation = engine.grep('.', { pattern: 'test' }).catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 10));
  await engine.dispose();
  assert.equal(finished, true);
  assert.match((await operation).message, /disposed/);
});
