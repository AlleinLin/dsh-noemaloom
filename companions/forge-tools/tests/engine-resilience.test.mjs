import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { Gate, waitWithSignal } from '../src/engine.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('stalled I/O holds its slot; a full gate rejects excess work and cancellation removes listeners', async () => {
  const gate = new Gate(1, 2), stalled = deferred();
  const active = gate.run(() => stalled.promise);
  const controller = new AbortController();
  const queued = gate.run(() => assert.fail('cancelled queued work must not run'), controller.signal);
  const last = gate.run(() => 'last');
  await assert.rejects(gate.run(() => assert.fail('overflow must not run')), { code: 'FORGE_QUEUE_FULL' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort(new Error('test cancel'));
  await assert.rejects(queued, /test cancel/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(gate.metrics(), { active: 1, queued: 1, maxQueued: 2, closed: false });
  stalled.resolve('finished');
  assert.equal(await active, 'finished');
  assert.equal(await last, 'last');
  assert.equal(gate.active, 0);
});

test('closing a gate rejects queued and future calls while preserving the active commit', async () => {
  const gate = new Gate(1), committing = deferred();
  const active = gate.run(() => committing.promise);
  const controller = new AbortController();
  const queued = gate.run(() => assert.fail('disposed work must not execute'), controller.signal);
  gate.close(new Error('disposed'));
  await assert.rejects(queued, /disposed/);
  await assert.rejects(gate.run(() => assert.fail()), /disposed/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(gate.active, 1);
  committing.resolve('commit confirmed');
  assert.equal(await active, 'commit confirmed');
  assert.equal(gate.active, 0);
});

test('cancelling a pure read wait does not prematurely release the occupied I/O slot', async () => {
  const gate = new Gate(1), stalled = deferred(), controller = new AbortController();
  const underlying = gate.run(() => stalled.promise);
  const waiting = waitWithSignal(underlying, controller.signal);
  controller.abort(new Error('read cancelled'));
  await assert.rejects(waiting, /read cancelled/);
  assert.equal(gate.active, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  stalled.reject(new Error('late provider failure'));
  await assert.rejects(underlying, /late provider failure/);
  assert.equal(gate.active, 0);
});

test('successful waits and queued handoffs release their abort listeners', async () => {
  const gate = new Gate(1), stalled = deferred();
  const active = gate.run(() => stalled.promise);
  const controller = new AbortController();
  const queued = gate.run(() => 42, controller.signal);
  stalled.resolve();
  await active;
  assert.equal(await queued, 42);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(await waitWithSignal(Promise.resolve(9), controller.signal), 9);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
