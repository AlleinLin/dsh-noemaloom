import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { PowerShellTools } from '../src/pwsh.mjs';
import { Gate } from '../src/engine.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const output = () => ({ exitCode: 0, timedOut: false, aborted: false,
  stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false } });

function harness(options = {}) {
  const handles = [], effects = [];
  const ctx = {
    sandboxPolicy: { resolve: options.policy ?? (() => ({ mode: options.mode ?? 'danger-full-access', workspaceRoot: '.' })) },
    subprocess: { spawn(spec) {
      const done = deferred(), range = deferred();
      const handle = {
        spec, done: done.promise, stdout: new PassThrough(), stderr: new PassThrough(),
        requests: [], terminations: 0, rangeChecks: 0,
        terminate() { this.terminations++; if (options.onTerminate) options.onTerminate(this); else this.finish(); },
        waitForExit() { this.rangeChecks++; return range.promise; },
        finishDirect() { done.resolve({ exitCode: null, signal: 'SIGTERM' }); },
        finishRange() { range.resolve(true); },
        finish() { this.finishDirect(); this.finishRange(); },
        complete(request, text = 'ok') {
          this.stdout.write(`${text}\n${request.marker}:0\n`);
          this.stderr.write(`${request.marker}:0\n`);
        },
      };
      handle.stdin = new Writable({ write(chunk, _encoding, callback) {
        const request = JSON.parse(chunk.toString());
        handle.requests.push(request);
        callback();
        if (options.onRequest) options.onRequest(handle, request);
        else queueMicrotask(() => handle.complete(request));
      } });
      handles.push(handle);
      if (options.ready !== false) queueMicrotask(() => handle.stdout.write('__READY__\n'));
      return handle;
    } },
    shell: { pwshPath: 'pwsh', resolve: request => request, execute: options.execute },
  };
  const service = new PowerShellTools(ctx, { clear() {}, cwd: options.cwd ?? (async () => '.') },
    { cleanupMs: 20, idleMs: 100000, ...options.config });
  const newAgent = () => ({ id: `owner-${effects.length}`, session: {},
    ctx: { effect(factory) { effects.push(factory()); } } });
  const agent = newAgent();
  const execute = (args = {}, signal = new AbortController().signal, owner = agent) =>
    service.execute({ command: '"test"', ...args }, { agent: owner, signal });
  return { service, handles, effects, agent, execute, newAgent };
}

test('slow startup ignoring abort returns timeout, quarantines the process and never sends late source', async () => {
  const h = harness({ ready: false, onTerminate() {} });
  const started = performance.now();
  const result = await h.execute({ timeout_ms: 15 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.cleanupPending, true);
  assert.ok(performance.now() - started < 500);
  assert.equal(h.handles[0].requests.length, 0);
  await assert.rejects(h.execute(), /termination is unconfirmed/);
  h.handles[0].stdout.write('__READY__\n');
  await delay(5);
  assert.equal(h.handles[0].requests.length, 0);
  assert.equal(h.handles.length, 1);
  h.handles[0].finish();
  await delay(5);
  assert.equal(h.service.metrics().residentProcesses, 0);
  await h.service.dispose();
});

test('timed-out command cannot become late success; huge output and queued calls stay bounded', async () => {
  const h = harness({ config: { maxOutputChars: 1024 }, onTerminate() {},
    onRequest(handle) { for (let i = 0; i < 100; i++) handle.stdout.write('x'.repeat(65536)); } });
  const first = h.execute({ timeout_ms: 15 });
  const queued = h.execute();
  const queuedCheck = assert.rejects(queued, /closed/);
  const result = await first;
  await queuedCheck;
  assert.equal(result.timedOut, true); assert.equal(result.stateLost, true);
  assert.equal(result.truncated, true); assert.ok(result.stdout.length <= 1024);
  assert.match(result.warnings.join(' '), /Side effects may still occur/);
  const handle = h.handles[0], slot = [...h.service.live][0];
  assert.ok(slot.resident.streams.stdout.pending.length <= 256);
  assert.ok(slot.resident.streams.stdout.tail.text.length <= 1024);
  handle.complete(handle.requests[0], 'LATE_SUCCESS');
  assert.equal(handle.requests.length, 1);
  assert.equal(result.exitCode, null);
  handle.finish(); await delay(5);
  await h.service.dispose();
});

test('direct process exit alone cannot release a worker with surviving descendants', async () => {
  const h = harness({ onRequest() {}, onTerminate(handle) { handle.finishDirect(); } });
  const result = await h.execute({ timeout_ms: 10 });
  assert.equal(result.cleanupPending, true);
  assert.equal(h.handles[0].rangeChecks, 1);
  assert.equal(h.service.metrics().cleanupPending, 1);
  await assert.rejects(h.execute(), /termination is unconfirmed/);
  h.handles[0].finishRange(); await delay(5);
  assert.equal(h.service.metrics().cleanupPending, 0);
  assert.equal(h.service.metrics().residentProcesses, 0);
  await h.service.dispose();
});

test('active cancellation returns promptly even when termination never acknowledges', async () => {
  const h = harness({ onRequest() {}, onTerminate() {} });
  const controller = new AbortController();
  const call = h.execute({}, controller.signal);
  await delay(5); controller.abort(new Error('cancel'));
  const result = await call;
  assert.equal(result.aborted, true); assert.equal(result.timedOut, false);
  assert.equal(result.cleanupPending, true);
  await assert.rejects(h.execute({ session_mode: 'isolated' }), /termination is unconfirmed/);
  await assert.rejects(h.execute({ run_in_background: true }), /termination is unconfirmed/);
  h.handles[0].finish(); await delay(5);
  await h.service.dispose();
});

test('external cancellation remains the first cause when slow cleanup outlives the total deadline', async () => {
  const h = harness({ onRequest() {}, onTerminate() {}, config: { cleanupMs: 40 } });
  const controller = new AbortController();
  const call = h.execute({ timeout_ms: 20 }, controller.signal);
  await delay(5); controller.abort(new Error('cancel-first'));
  const result = await call;
  assert.equal(result.aborted, true); assert.equal(result.timedOut, false);
  assert.equal(result.cleanupPending, true);
  h.handles[0].finish(); await delay(5);
  await h.service.dispose();
});

test('restarting workers does not accumulate owner disposers, output listeners or live entries', async () => {
  const h = harness({ onRequest() {} });
  for (let i = 0; i < 40; i++) {
    const result = await h.execute({ timeout_ms: 2 });
    assert.equal(result.timedOut, true);
    assert.equal(result.cleanupPending, false);
  }
  await delay(5);
  assert.equal(h.effects.length, 1);
  assert.equal(h.service.live.size, 0);
  assert.equal(h.service.owners.get(h.agent).slot, undefined);
  for (const handle of h.handles) {
    assert.equal(handle.stdout.listenerCount('data'), 0);
    assert.equal(handle.stderr.listenerCount('data'), 0);
    assert.equal(handle.stdin.listenerCount('error'), 0);
    assert.equal(handle.rangeChecks, 1);
  }
  await h.service.dispose();
});

test('a spontaneous idle worker exit releases its slot without waiting for the idle timeout', async () => {
  const h = harness();
  assert.equal((await h.execute()).exitCode, 0);
  assert.equal(h.service.metrics().residentProcesses, 1);
  h.handles[0].finish(); await delay(5);
  assert.equal(h.service.metrics().residentProcesses, 0);
  assert.equal(h.service.owners.get(h.agent).slot, undefined);
  assert.equal((await h.execute()).exitCode, 0);
  assert.equal(h.effects.length, 1);
  await h.service.dispose();
});

test('idle expiry releases worker streams and clears the owner slot', async () => {
  const h = harness({ config: { idleMs: 5 } });
  assert.equal((await h.execute()).exitCode, 0);
  await delay(30);
  assert.equal(h.service.metrics().residentProcesses, 0);
  assert.equal(h.service.owners.get(h.agent).slot, undefined);
  assert.equal(h.handles[0].stdout.listenerCount('data'), 0);
  await h.service.dispose();
});

test('process cap keeps unresponsive startup handles bounded across many agents', async () => {
  const h = harness({ ready: false, onTerminate() {}, config: { maxProcesses: 2 } });
  await h.execute({ timeout_ms: 5 });
  await h.execute({ timeout_ms: 5 }, undefined, h.newAgent());
  for (let i = 0; i < 30; i++)
    await assert.rejects(h.execute({}, undefined, h.newAgent()), /process limit/);
  assert.equal(h.handles.length, 2);
  assert.equal(h.service.metrics().residentProcesses, 2);
  await h.service.dispose();
  assert.equal(h.service.metrics().cleanupPending, 2);
  h.handles.forEach(handle => handle.finish()); await delay(5);
  assert.equal(h.service.metrics().residentProcesses, 0);
});

test('dispose drains queued commands and denies reentry without waiting forever for stuck cleanup', async () => {
  const h = harness({ ready: false, onTerminate() {} });
  const active = h.execute();
  const activeCheck = active.then(result => assert.equal(result.aborted, true));
  const queued = h.execute();
  const queuedCheck = assert.rejects(queued, /disposed|closed/);
  await delay(5);
  const started = performance.now();
  await h.service.dispose();
  await Promise.all([activeCheck, queuedCheck]);
  assert.ok(performance.now() - started < 500);
  await assert.rejects(h.execute(), /disposed/);
  const slot = [...h.service.live][0];
  assert.equal(slot.pending.size, 0);
  assert.equal(slot.queue.active, 0);
  assert.equal(slot.queue.queue.length, 0);
  h.handles[0].finish(); await delay(5);
});

test('isolated restricted execution times out slow preparation and kills a handle published after abort', async () => {
  const preparation = deferred(), stopped = deferred();
  let kills = 0, calls = 0, request;
  const h = harness({ mode: 'read-only', execute: async spec => {
    request = spec; calls++; return preparation.promise;
  } });
  const result = await h.execute({ timeout_ms: 10 });
  assert.equal(result.timedOut, true); assert.equal(result.cleanupPending, true);
  assert.equal(result.mode, 'isolated'); assert.equal(h.handles.length, 0);
  assert.equal(request.signal.aborted, true);
  assert.equal(request.sandboxPolicy.mode, 'read-only');
  await assert.rejects(h.execute(), /termination is unconfirmed/);
  preparation.resolve({ kill() { kills++; }, done: stopped.promise,
    result: () => stopped.promise.then(output) });
  await delay(5);
  assert.equal(kills, 1); assert.equal(calls, 1);
  assert.equal(h.service.metrics().isolatedProcesses, 1);
  stopped.resolve(); await delay(5);
  assert.equal(h.service.metrics().isolatedProcesses, 0);
  await h.service.dispose();
});

test('the total deadline bounds an uncooperative cwd wait without releasing its underlying I/O slot', async () => {
  const cwd = deferred(), gate = new Gate(1);
  const h = harness({ cwd: exec => gate.run(() => cwd.promise, exec.signal) });
  const result = await h.execute({ timeout_ms: 10 });
  assert.equal(result.timedOut, true);
  assert.equal(result.mode, 'not-started'); assert.equal(result.phase, 'preparation');
  assert.equal(result.stateLost, false); assert.equal(result.cleanupPending, false);
  assert.equal(h.handles.length, 0);
  assert.equal(gate.active, 1);
  cwd.resolve('.'); await delay(5);
  assert.equal(gate.active, 0);
  assert.equal(h.handles.length, 0);
  await h.service.dispose();
});

test('external cancellation of slow cwd returns promptly and a late result never spawns a shell', async () => {
  const cwd = deferred();
  const h = harness({ cwd: () => cwd.promise });
  const controller = new AbortController();
  const call = h.execute({}, controller.signal);
  controller.abort(new Error('cwd-external-cancel'));
  await assert.rejects(call, /cwd-external-cancel/);
  cwd.resolve('.'); await delay(5);
  assert.equal(h.handles.length, 0);
  await h.service.dispose();
});

test('policy preparation is bounded even with explicit workdir and cannot resume a cancelled command', async () => {
  const policy = deferred();
  const h = harness({ policy: () => policy.promise });
  const result = await h.execute({ workdir: '.', timeout_ms: 10 });
  assert.equal(result.timedOut, true);
  assert.equal(result.phase, 'preparation');
  policy.resolve({ mode: 'danger-full-access', workspaceRoot: '.' }); await delay(5);
  assert.equal(h.handles.length, 0);
  await h.service.dispose();
});

test('a queued call exhausts its own total deadline without killing the active call or sending source', async () => {
  const h = harness({ onRequest(handle, request) {
    if (handle.requests.length > 1) handle.complete(request);
  } });
  const first = h.execute({ timeout_ms: 1000 });
  await delay(5);
  const queued = await h.execute({ timeout_ms: 10 });
  assert.equal(queued.timedOut, true); assert.equal(queued.phase, 'queued');
  assert.equal(queued.mode, 'not-started'); assert.equal(queued.stateLost, false);
  assert.equal(h.handles[0].terminations, 0);
  assert.equal(h.handles[0].requests.length, 1);
  assert.equal([...h.service.live][0].queue.queue.length, 0);
  h.handles[0].complete(h.handles[0].requests[0]);
  assert.equal((await first).exitCode, 0);
  assert.equal((await h.execute()).exitCode, 0);
  await h.service.dispose();
});

test('queued time consumes the same budget as active execution instead of restarting its deadline', async () => {
  const h = harness({ onRequest(handle, request) {
    if (handle.requests.length === 1) setTimeout(() => handle.complete(request), 60);
  } });
  const first = h.execute({ timeout_ms: 1000 });
  await delay(5);
  const started = performance.now();
  const second = h.execute({ timeout_ms: 90 });
  assert.equal((await first).exitCode, 0);
  const result = await second;
  assert.equal(result.timedOut, true); assert.equal(result.stateLost, true);
  assert.ok(performance.now() - started < 160);
  assert.equal(h.handles[0].requests.length, 2);
  await h.service.dispose();
});

test('isolated process ignoring kill stays quarantined and caps unresolved operations', async () => {
  const done = deferred();
  let kills = 0;
  const h = harness({ mode: 'read-only', execute: async () => ({ kill() { kills++; },
    done: done.promise, result: () => done.promise.then(output) }), config: { maxProcesses: 1 } });
  const result = await h.execute({ timeout_ms: 10 });
  assert.equal(result.cleanupPending, true); assert.ok(kills >= 1);
  await assert.rejects(h.execute({}, undefined, h.newAgent()), /process limit/);
  assert.equal(h.service.metrics().isolatedProcesses, 1);
  await h.service.dispose();
  done.resolve(); await delay(5);
  assert.equal(h.service.metrics().isolatedProcesses, 0);
});

test('a throwing isolated kill cannot crash the timer or silently release an unresolved process', async () => {
  const done = deferred();
  const h = harness({ mode: 'read-only', execute: async () => ({
    kill() { throw new Error('injected termination failure'); },
    done: done.promise, result: () => done.promise.then(output),
  }) });
  const result = await h.execute({ timeout_ms: 10 });
  assert.equal(result.timedOut, true); assert.equal(result.cleanupPending, true);
  assert.equal(result.cleanupScope, 'provider-execution');
  await assert.rejects(h.execute(), /termination is unconfirmed/);
  done.resolve(); await delay(5);
  await h.service.dispose();
});
