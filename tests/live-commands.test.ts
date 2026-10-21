import test from 'node:test';
import assert from 'node:assert/strict';
import { appendCommandOutput, emptyCommandOutput, isCommandTool } from '../src/client/live-command-model.js';
import { registerLiveCommands, terminalDelta } from '../src/host/live-commands.js';
import type { HostContext } from '../src/host/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
function fixture(services: Record<string, any> = {}) {
  const hooks = new Map<string, (...args: any[]) => any>();
  let fetch!: (request: Request) => Promise<Response>;
  let routeRemoved = false;
  const ctx = {
    get: (name: string) => services[name],
    on(name: string, callback: (...args: any[]) => any) {
      hooks.set(name, callback);
      return () => { hooks.delete(name); };
    },
    connection: { fetch: { register(route: any) {
      fetch = route.fetch;
      return async () => { routeRemoved = true; };
    } } },
  } as unknown as HostContext;
  const dispose = registerLiveCommands(ctx);
  return {
    hooks, dispose, get routeRemoved() { return routeRemoved; },
    async read(sessionId: string, id?: string, cursor = 0) {
      const response = await fetch(new Request('http://fixture/api/nexus/live-commands', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'live-command-fixture', method: 'nexus/live-commands', payload: { sessionId, id, cursor } }),
      }));
      const body: any = await response.json();
      assert.equal(body.result.ok, true);
      return body.result.value;
    },
    execute(next: () => Promise<any>, callId = 'call-one', sessionId = 'session-one') {
      return hooks.get('tools/execute')!({
        name: 'bash', callId, rootCallId: callId, agent: { session: { id: sessionId } },
        arguments: { command: 'fixture command' }, signal: new AbortController().signal,
      }, next);
    },
  };
}

test('command cursor resume rejects other ids and never repeats overlapping UTF-8 output', () => {
  const initial = appendCommandOutput(emptyCommandOutput('first'), {
    id: 'first', chunks: [{ cursor: 0, nextCursor: 4, stream: 'stdout', text: 'a你' }], nextCursor: 4,
  });
  assert.equal(appendCommandOutput(initial, { id: 'other-session', chunks: [], nextCursor: 99 }), initial);
  const resumed = appendCommandOutput(initial, {
    id: 'first', chunks: [{ cursor: 1, nextCursor: 5, stream: 'stdout', text: '你b' }], nextCursor: 5,
  });
  assert.equal(resumed.chunks.map(chunk => chunk.text).join(''), 'a你b');
  assert.equal(appendCommandOutput(resumed, {
    id: 'first', chunks: [{ cursor: 1, nextCursor: 5, stream: 'stdout', text: '你b' }], nextCursor: 5,
  }).chunks.map(chunk => chunk.text).join(''), 'a你b');
  const bounded = appendCommandOutput(resumed, {
    id: 'first', chunks: [{ cursor: 5, nextCursor: 15, stream: 'stderr', text: '0123456789' }], nextCursor: 15,
  }, 6);
  assert.equal(bounded.chunks.map(chunk => chunk.text).join(''), '456789');
  assert.equal(bounded.lossy, true);
});

test('PTY scrollback overlap preserves new lines and marks lost content', () => {
  assert.deepEqual(terminalDelta('old\nkeep\n', 'keep\nnext\n'), { text: 'next\n', lossy: false });
  assert.deepEqual(terminalDelta('prompt> ', 'prompt> output\n'), { text: 'output\n', lossy: false });
  assert.deepEqual(terminalDelta('earlier\n', 'new window\n'), { text: 'new window\n', lossy: true });
  assert.equal(isCommandTool('pwsh'), true);
  assert.equal(isCommandTool('read'), false);
});

test('native shell observation preserves execution identity, scopes output and never consumes or cancels', async () => {
  const done = deferred<void>(), toolResult = deferred<any>();
  let stdout = 'alpha\n', stderr = 'warn\n';
  let consuming = 0, cancellations = 0;
  const handle = {
    status: 'running', exitCode: null,
    done: done.promise,
    observed: {
      stdout: { readFrom: (offset: number) => ({ text: stdout.slice(offset), nextOffset: stdout.length, lossy: false }) },
      stderr: { readFrom: (offset: number) => ({ text: stderr.slice(offset), nextOffset: stderr.length, lossy: false }) },
    },
    result() { consuming++; }, readOutput() { consuming++; }, kill() { cancellations++; },
  };
  const returned = Promise.resolve(handle);
  const signal = new AbortController().signal;
  const spec = { command: 'fixture', args: ['one argument'], signal };
  let received: unknown;
  const original = function (this: any, value: unknown) { assert.equal(this, shell); received = value; return returned; };
  const shell = { execute: original };
  const h = fixture({ shell });
  const running = h.execute(async () => {
    assert.equal(shell.execute(spec), returned);
    await returned;
    return toolResult.promise;
  });
  await returned;
  await Promise.resolve();
  assert.equal(received, spec);
  const first = await h.read('session-one', 'native:call-one');
  assert.deepEqual(first.output.chunks.map((chunk: any) => [chunk.stream, chunk.text]), [['stdout', stdout], ['stderr', stderr]]);
  assert.deepEqual((await h.read('session-two', 'native:call-one')).commands, []);
  assert.equal((await h.read('session-two', 'native:call-one')).output, undefined);
  stdout += 'later\n';
  stderr += 'again\n';
  const second = await h.read('session-one', 'native:call-one', first.output.nextCursor);
  assert.equal(second.output.chunks.map((chunk: any) => chunk.text).join(''), 'later\nagain\n');
  await h.dispose();
  assert.equal(shell.execute, original);
  assert.equal(h.routeRemoved, true);
  assert.equal(cancellations, 0);
  assert.equal(consuming, 0);
  handle.status = 'completed';
  done.resolve();
  const official = { content: [{ type: 'text', text: 'official result' }] };
  toolResult.resolve(official);
  assert.equal(await running, official);
});

test('job settlement captures the final tail before removal without falling back to duplicate process output', async () => {
  const done = deferred<void>(), toolResult = deferred<any>();
  const handle = { status: 'running', exitCode: 0, done: done.promise, observed: {
    stdout: { readFrom: () => ({ text: 'registry output\n', nextOffset: 16, lossy: false }) },
    stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
  } };
  let listener!: (event: any) => void;
  let removed = false;
  let job: any = { id: 'bash-one', owner: 'session-one', status: 'running' };
  let text = 'registry ';
  const jobs = {
    events: { subscribe(_filter: unknown, callback: typeof listener) { listener = callback; return () => {}; } },
    get() { if (removed) throw new Error('removed'); return job; },
    readAt(_id: string, cursor: number, sessionId: string) {
      assert.equal(sessionId, 'session-one');
      if (removed) throw new Error('removed');
      return { next: text.length, chunks: cursor < text.length ? [{ at: cursor, text: text.slice(cursor), channel: 'stdout' }] : [], lossy: false };
    },
    read() { assert.fail('consuming registry read was called'); },
  };
  const shell = { execute: () => Promise.resolve(handle) };
  const h = fixture({ jobs, shell });
  const running = h.execute(async () => {
    await shell.execute();
    h.hooks.get('session/event')!({ id: 'session-one', firstLiveSeq: 0 }, {
      type: 'job/registered', seq: 1, data: { jobId: 'bash-one', owner: 'session-one', toolCall: { callId: 'call-one' } },
    });
    return toolResult.promise;
  });
  await Promise.resolve();
  await Promise.resolve();
  const first = await h.read('session-one', 'native:call-one');
  assert.equal(first.output.chunks.map((chunk: any) => chunk.text).join(''), 'registry ');
  text += 'output\n';
  job = { ...job, status: 'completed', finishedAt: Date.now(), detail: 'exit code: 0' };
  listener({ type: 'settled', job });
  removed = true;
  listener({ type: 'removed', job });
  handle.status = 'completed';
  done.resolve();
  toolResult.resolve({ content: [{ type: 'text', text }] });
  await running;
  const final = await h.read('session-one', 'native:call-one');
  assert.equal(final.output.chunks.map((chunk: any) => chunk.text).join(''), text);
  assert.equal(final.commands[0].state, 'completed');
  assert.equal(final.commands[0].exitCode, 0);
  await h.dispose();
});

test('persistent terminal captures its baseline before synchronous command output and preserves the operation', async () => {
  const finish = deferred<any>();
  const owner = { id: 'session-one' };
  let scrollback = 'old prompt> ';
  let consumed = 0, cancelled = 0;
  const operation = { done: Promise.resolve(), readOutput() { consumed++; }, cancel() { cancelled++; } };
  const request = { text: 'the exact original payload' };
  const original = (_owner: unknown, _id: string, received: unknown) => {
    assert.equal(received, request);
    scrollback += 'synchronous output\n';
    return operation;
  };
  const terminals = { startSend: original, read: () => ({ text: scrollback }) };
  const h = fixture({ terminals });
  const running = h.execute(async () => {
    assert.equal(terminals.startSend(owner, 'pty-one', request), operation);
    return finish.promise;
  });
  const value = await h.read('session-one', 'native:call-one');
  assert.equal(value.output.chunks.map((chunk: any) => chunk.text).join(''), 'synchronous output\n');
  finish.resolve({ content: [] });
  await running;
  await h.dispose();
  assert.equal(terminals.startSend, original);
  assert.equal(consumed, 0);
  assert.equal(cancelled, 0);
});
