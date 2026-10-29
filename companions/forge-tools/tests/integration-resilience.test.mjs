import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { environment } from './helpers.mjs';

const input = (name, args, controller) => ({ name, arguments: args, callId: `resilience-${name}`,
  signal: controller.signal });
const contexts = result => {
  for (const message of result.additionalContexts ?? []) {
    assert.equal(typeof message.id, 'string', 'Agent persistence requires an identified SDK message');
    assert.ok(message.id.length > 0);
    assert.equal(message.role, 'user');
    assert.equal(message.source.kind, 'forge-file-status');
    assert.equal(message.source.form, 'notice');
    assert.ok(message.source.summary.length <= 120);
  }
  return (result.additionalContexts ?? [])
    .flatMap(message => message.content ?? []).map(block => block.text ?? '').join('\n');
};

test('SDK cancellation preserves the fact that an atomic write already committed', async t => {
  const { root, ctx } = await environment(t);
  const controller = new AbortController();
  const original = ctx.fs.writeText.bind(ctx.fs);
  ctx.fs.writeText = async (...args) => {
    const result = await original(...args);
    controller.abort(new Error('cancel after publication'));
    return result;
  };
  const result = await ctx.tools.execute(input('write', { file_path: 'committed.txt', content: 'COMMITTED' }, controller));
  assert.equal(result.isError, true);
  assert.equal(result.error.info.code, 'ABORTED');
  assert.equal(await readFile(path.join(root, 'committed.txt'), 'utf8'), 'COMMITTED');
  assert.match(contexts(result), /committed\.txt/);
  assert.match(contexts(result), /Confirmed commits are not rolled back/);
  assert.match(contexts(result), /"committed"/);
});

test('SDK cancelled batch preserves committed progress and never dispatches later edits', async t => {
  const { root, ctx } = await environment(t);
  await writeFile(path.join(root, 'a'), 'one');
  await writeFile(path.join(root, 'b'), 'two');
  const controller = new AbortController();
  const original = ctx.fs.editText.bind(ctx.fs);
  let calls = 0;
  ctx.fs.editText = async (...args) => {
    calls++;
    const result = await original(...args);
    controller.abort(new Error('stop after first commit'));
    return result;
  };
  const result = await ctx.tools.execute(input('batch_edit', { edits: [
    { file_path: 'a', old_string: 'one', new_string: 'ONE' },
    { file_path: 'b', old_string: 'two', new_string: 'TWO' },
  ] }, controller));
  assert.equal(result.isError, true);
  assert.equal(calls, 1);
  assert.equal(await readFile(path.join(root, 'a'), 'utf8'), 'ONE');
  assert.equal(await readFile(path.join(root, 'b'), 'utf8'), 'two');
  assert.match(contexts(result), /"committed"/);
  assert.match(contexts(result), /sha256/);
});

test('post-publication provider failure is marked unconfirmed and is never silently retried', async t => {
  const { root, ctx } = await environment(t);
  const original = ctx.fs.writeText.bind(ctx.fs);
  let calls = 0;
  ctx.fs.writeText = async (...args) => {
    calls++;
    await original(...args);
    throw Object.assign(new Error('post-publication metadata probe failed'), { code: 'EIO' });
  };
  const result = await ctx.tools.execute(input('write', { file_path: 'uncertain.txt', content: 'landed' }, new AbortController()));
  assert.equal(result.isError, true);
  assert.equal(calls, 1);
  assert.equal(await readFile(path.join(root, 'uncertain.txt'), 'utf8'), 'landed');
  assert.match(contexts(result), /unconfirmed/);
  assert.match(contexts(result), /fresh-read/);
});

test('large edit results omit full bodies and batch results never retain complete file snapshots', async t => {
  const { root, ctx, execute } = await environment(t);
  const body = 'a'.repeat(128 * 1024) + 'needle';
  await writeFile(path.join(root, 'large'), body);
  const result = await ctx.tools.execute(input('edit', {
    file_path: 'large', old_string: 'needle', new_string: 'new value',
  }, new AbortController()));
  assert.equal(result.isError, false);
  const rendered = JSON.stringify(result);
  assert.ok(rendered.length < 10000);
  assert.match(rendered, /diffOmitted/);
  assert.doesNotMatch(rendered, /a{1000}/);
  const batch = await execute('batch_edit', { edits: [
    { file_path: 'large', old_string: 'new value', new_string: 'final' },
  ] });
  assert.equal(batch.completed, 1);
  assert.equal(batch.results[0].before, undefined);
  assert.equal(batch.results[0].after, undefined);
  assert.ok(JSON.stringify(batch).length < 3000);
});

test('cancelled slow search root cannot launch a ripgrep process or exceed the shared I/O limit', async t => {
  const { ctx, execute } = await environment(t, { config: { ioConcurrency: 2 } });
  const original = ctx.fs.resolve.bind(ctx.fs);
  let release, active = 0, peak = 0;
  const block = new Promise(resolve => { release = resolve; });
  ctx.fs.resolve = async (...args) => {
    active++; peak = Math.max(peak, active);
    try { await block; return await original(...args); }
    finally { active--; }
  };
  const controllers = Array.from({ length: 12 }, () => new AbortController());
  const work = controllers.map(controller => execute('grep', { pattern: 'never' }, controller.signal));
  // Install rejection observers before firing all aborts.
  const settled = Promise.allSettled(work);
  await new Promise(resolve => setImmediate(resolve));
  controllers.forEach(controller => controller.abort(new Error('cancel slow root')));
  const results = await settled;
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.ok(peak <= 2);
  const status = await execute('forge_status', {});
  assert.equal(status.search.processes, 0);
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
});
