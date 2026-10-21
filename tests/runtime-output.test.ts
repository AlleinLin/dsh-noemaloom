import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeModule } from '../src/domain/runtime/index.js';
import { createAtomicStore } from '../src/domain/storage/index.js';
import {
  NexusError, type DispatchContext, type ExecutionOptions, type ExecutionResult,
  type JsonRecord, type NexusServices, type NexusStore,
} from '../src/ports/contracts.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-runtime-output-'));
  const firstRoot = join(root, 'first'), secondRoot = join(root, 'second');
  await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
  const store = createAtomicStore(join(root, 'data'));
  const writes: Array<{ collection: string; id: string }> = [];
  const countedStore: NexusStore = {
    get: store.get.bind(store),
    list: store.list.bind(store),
    remove: store.remove.bind(store),
    async put<T>(collection: string, id: string, value: T, expectedRevision?: number) {
      writes.push({ collection, id });
      return store.put<T>(collection, id, value, expectedRevision);
    },
  };
  const result = deferred<ExecutionResult>(), completed = deferred<void>();
  let options: ExecutionOptions | undefined;
  let executions = 0;
  const services = {
    workspaceRoot: firstRoot, dataDir: join(root, 'data'), store: countedStore,
    emit(event: string) { if (event === 'runtime.job.changed') completed.resolve(); },
    host: {
      approve: async () => true,
      sessions: async () => [
        { header: { id: 'first-session', cwd: firstRoot } },
        { header: { id: 'second-session', cwd: secondRoot } },
      ],
    },
    executor: {
      run(_command: string, _args: string[], received: ExecutionOptions) {
        executions++;
        options = received;
        return result.promise;
      },
    },
  } as unknown as NexusServices;
  const modules = [createRuntimeModule(services)];
  t.after(async () => {
    result.resolve({ exitCode: null, stdout: '', stderr: '', cancelled: true, durationMs: 1 });
    if (executions) await completed.promise;
    for (const module of modules) await module.dispose?.();
    await rm(root, { recursive: true, force: true });
  });
  const context: DispatchContext = { scopeLevel: 'session', workspaceRoot: firstRoot, sessionId: 'first-session' };
  return {
    module: modules[0], store, writes, context, firstRoot, secondRoot,
    get executions() { return executions; },
    get options() { assert.ok(options); return options; },
    createGeneration() {
      const module = createRuntimeModule(services);
      modules.push(module);
      return module;
    },
    finish(value: ExecutionResult) { result.resolve(value); return completed.promise; },
  };
}

async function start(h: Awaited<ReturnType<typeof fixture>>, id = 'live-command') {
  return h.module.dispatch({
    action: 'terminal.run', requestId: id,
    params: { command: 'fixture-command', args: ['--fixture'], background: true },
  }, h.context);
}

test('running jobs expose independent cursor reads across generations without writing each output batch', async t => {
  const h = await fixture(t);
  await start(h);
  await h.options.onOutput?.({ stream: 'stdout', text: 'alpha\n', nextOffset: 6, lossy: false });
  await h.options.onOutput?.({ stream: 'stderr', text: 'warn\n', nextOffset: 5, lossy: false });
  assert.equal(h.writes.filter(write => write.collection === 'runtimeJobs').length, 1);

  const request = { action: 'jobs.output', params: { id: 'live-command', cursor: 0, maxBytes: 8 } };
  const first: any = await h.module.dispatch(request, h.context);
  const repeated: any = await h.module.dispatch(request, h.context);
  const generation: any = await h.createGeneration().dispatch(request, h.context);
  assert.deepEqual(repeated, first, 'reading a cursor must not consume another reader');
  assert.deepEqual(generation, first, 'a new module generation observes the same owned command');
  assert.equal(first.state, 'running');
  assert.equal(first.available, true);
  assert.equal(first.lossy, false);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.chunks.map((chunk: any) => [chunk.stream, chunk.text]), [['stdout', 'alpha\n'], ['stderr', 'wa']]);

  const rest: any = await h.module.dispatch({
    action: 'jobs.output', params: { id: 'live-command', cursor: first.nextCursor },
  }, h.context);
  assert.deepEqual(rest.chunks.map((chunk: any) => [chunk.stream, chunk.text]), [['stderr', 'rn\n']]);
  assert.equal(rest.hasMore, false);
  assert.equal(rest.nextCursor, 11);
  assert.equal(h.options.signal?.aborted, false, 'observing output never cancels execution');
  await h.finish({ exitCode: 0, stdout: 'alpha\n', stderr: 'warn\n', cancelled: false, durationMs: 10 });
  const final: any = await h.module.dispatch({ action: 'jobs.get', params: { id: 'live-command' } }, h.context);
  assert.equal(final.value.state, 'succeeded');
  assert.equal(h.writes.filter(write => write.collection === 'runtimeJobs').length, 2);

  await start(h);
  assert.equal(h.executions, 1, 'the same request ID returns its existing receipt');
});

test('bounded output reports dropped history and keeps valid UTF-8 cursor pages', async t => {
  const h = await fixture(t);
  await start(h, 'large-command');
  const text = '🙂'.repeat(300000);
  await h.options.onOutput?.({ stream: 'stdout', text, nextOffset: Buffer.byteLength(text), lossy: false });
  let cursor = 0, retained = '', count = 0;
  do {
    const page: any = await h.module.dispatch({
      action: 'jobs.output', params: { id: 'large-command', cursor, maxBytes: 256 * 1024 },
    }, h.context);
    if (count === 0) {
      assert.equal(page.lossy, true);
      assert.ok(page.startCursor > 0);
    }
    const delta = page.chunks.map((chunk: any) => chunk.text).join('');
    assert.ok(!delta.includes('\ufffd'), 'pages must not split an encoded character');
    retained += delta;
    assert.ok(page.nextCursor > cursor);
    cursor = page.nextCursor;
    count++;
    if (!page.hasMore) break;
    assert.ok(count < 10, 'bounded pages must make progress');
  } while (true);
  assert.ok(Buffer.byteLength(retained) <= 1024 * 1024);
  assert.ok(retained.length < text.length);
  assert.equal(retained, '🙂'.repeat(retained.length / 2));
  assert.equal(h.writes.filter(write => write.collection === 'runtimeJobs').length, 1);
  await h.finish({ exitCode: 0, stdout: 'final retained output', stderr: '', cancelled: false, durationMs: 10, truncated: true });
});

test('all job entry points enforce canonical workspace and session scope, including legacy receipts', async t => {
  const h = await fixture(t);
  const firstRoot = await realpath(h.firstRoot), secondRoot = await realpath(h.secondRoot);
  const base = { state: 'succeeded', startedAt: new Date().toISOString(), command: 'fixture', args: [], result: { stdout: 'private output' } };
  await h.store.put('runtimeJobs', 'first', { ...base, id: 'first', workspaceRoot: firstRoot, sessionId: 'first-session' }, 0);
  await h.store.put('runtimeJobs', 'second', { ...base, id: 'second', workspaceRoot: secondRoot, sessionId: 'second-session' }, 0);
  await h.store.put('runtimeJobs', 'legacy-first', { ...base, id: 'legacy-first', sessionId: 'first-session' }, 0);
  await h.store.put('runtimeJobs', 'legacy-unknown', { ...base, id: 'legacy-unknown' }, 0);
  const list: any = await h.module.dispatch({ action: 'jobs.list', params: {} }, h.context);
  assert.deepEqual(list.items.map((row: any) => row.id).sort(), ['first', 'legacy-first']);
  const forged: any = await h.module.dispatch({ action: 'jobs.list', params: { sessionId: 'second-session' } }, h.context);
  assert.deepEqual(forged.items, []);
  for (const action of ['jobs.get', 'jobs.output', 'jobs.cancel']) {
    for (const id of ['second', 'legacy-unknown']) {
      await assert.rejects(h.module.dispatch({ action, params: { id } }, h.context),
        (error: unknown) => error instanceof NexusError && error.code === 'NOT_FOUND');
    }
    await assert.rejects(h.module.dispatch({ action, params: { id: 'first' } }, {
      scopeLevel: 'session', workspaceRoot: secondRoot, sessionId: 'first-session',
    }), (error: unknown) => error instanceof NexusError && error.code === 'NOT_FOUND');
  }
  await assert.rejects(h.module.dispatch({
    action: 'terminal.run', requestId: 'second', params: { command: 'fixture', args: [] },
  }, h.context), (error: unknown) => error instanceof NexusError && error.code === 'NOT_FOUND');
  assert.equal(h.executions, 0);
  const global: any = await h.module.dispatch({ action: 'jobs.list', params: {} }, { scopeLevel: 'global' });
  assert.equal(global.items.length, 4);
  const snapshot: any = await h.module.dispatch({ action: 'jobs.output', params: { id: 'first' } }, h.context);
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.result.stdout, 'private output');
});

test('invalid cursor requests do not affect command lifetime', async t => {
  const h = await fixture(t);
  await start(h);
  for (const params of [{ cursor: -1 }, { cursor: 1 }, { maxBytes: 0 }, { maxBytes: 262145 }]) {
    await assert.rejects(h.module.dispatch({
      action: 'jobs.output', params: { id: 'live-command', ...params } as JsonRecord,
    }, h.context), (error: unknown) => error instanceof NexusError && error.code === 'INVALID_ARGUMENT');
  }
  assert.equal(h.options.signal?.aborted, false);
  await h.finish({ exitCode: 0, stdout: '', stderr: '', cancelled: false, durationMs: 1 });
});
