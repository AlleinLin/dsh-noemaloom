import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { environment } from './helpers.mjs';

test('real SDK filesystem rejects writes and edits under read-only policy', async t => {
  const { root, execute } = await environment(t, { sandboxFs: true, mode: 'read-only' });
  await writeFile(path.join(root, 'a'), 'original');
  await execute('read', { file_path: 'a' });
  await assert.rejects(execute('write', { file_path: 'a', content: 'bad' }), error => error.code === 'FS_SANDBOX_DENIED');
  await assert.rejects(execute('edit', { file_path: 'a', old_string: 'original', new_string: 'bad' }), error => error.code === 'FS_SANDBOX_DENIED');
  assert.equal(await readFile(path.join(root, 'a'), 'utf8'), 'original');
});

test('registry native pipeline validates schemas, preserves rendered results and rejects invalid args', async t => {
  const { root, ctx } = await environment(t);
  await writeFile(path.join(root, 'a'), 'pipeline');
  const result = await ctx.tools.execute({ name: 'read', arguments: { file_path: 'a' },
    callId: 'pipeline-read', signal: new AbortController().signal });
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /1\tpipeline/);
  const invalid = await ctx.tools.execute({ name: 'read', arguments: {},
    callId: 'pipeline-invalid', signal: new AbortController().signal });
  assert.equal(invalid.isError, true);
});

test('malformed escalation fails before any mutation', async t => {
  const { root, execute } = await environment(t, { sandboxFs: true, mode: 'read-only' });
  await writeFile(path.join(root, 'a'), 'original');
  await assert.rejects(execute('write', { file_path: 'a', content: 'bad',
    sandbox_permissions: 'danger-full-access' }), /justification/);
  assert.equal(await readFile(path.join(root, 'a'), 'utf8'), 'original');
});
