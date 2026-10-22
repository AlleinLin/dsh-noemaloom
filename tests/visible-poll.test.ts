import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleBatch, visiblePoll, type PollEnvironment } from '../src/client/visible-poll.js';

function environment() {
  let clock = 0, visible = true, serial = 0;
  const timers = new Map<number, { at: number; callback(): void }>(), listeners = new Set<() => void>();
  const env: PollEnvironment = {
    visible: () => visible,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    later(callback, delay) { const id = ++serial; timers.set(id, { at: clock + delay, callback }); return id; },
    cancel(timer) { timers.delete(timer as number); },
  };
  return {
    env, timers, listeners,
    show(next: boolean) { visible = next; for (const listener of listeners) listener(); },
    async tick(ms: number) {
      await Promise.resolve(); await Promise.resolve();
      const end = clock + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        clock = next[1].at; timers.delete(next[0]); next[1].callback();
        await Promise.resolve(); await Promise.resolve();
      }
      clock = end; await Promise.resolve(); await Promise.resolve();
    },
  };
}
test('slow reads never overlap; a thousand refreshes become one follow-up, not a queue', async () => {
  const f = environment();
  let calls = 0, active = 0, maximum = 0, finish!: () => void;
  const poll = visiblePoll(async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => { finish = resolve; }); active--;
  }, { delay: () => 8000, environment: f.env });
  for (let i = 0; i < 1000; i++) poll.refresh();
  await f.tick(60000); assert.equal(calls, 1);
  finish(); await f.tick(0); await f.tick(0);
  assert.equal(calls, 2); assert.equal(maximum, 1);
  poll.dispose(); finish(); await f.tick(60000);
  assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
});
test('hidden windows have zero polling timers and resume once without catch-up bursts', async () => {
  const f = environment(); let calls = 0;
  const poll = visiblePoll(async () => { calls++; }, { delay: () => 2000, environment: f.env });
  await f.tick(2000); assert.equal(calls, 2);
  f.show(false); assert.equal(f.timers.size, 0);
  await f.tick(3600000); assert.equal(calls, 2);
  f.show(true); await f.tick(0); assert.equal(calls, 3);
  poll.dispose(); await f.tick(3600000); assert.equal(calls, 3);
});
test('read failures back off, remain visible, and a successful retry resets the interval', async () => {
  const f = environment(); let calls = 0, errors = 0;
  const poll = visiblePoll(async () => { if (++calls < 3) throw new Error('network'); }, {
    delay: () => 2000, environment: f.env, onError() { errors++; },
  });
  await f.tick(3999); assert.equal(calls, 1);
  await f.tick(1); assert.equal(calls, 2);
  await f.tick(8000); assert.equal(calls, 3); assert.equal(errors, 2);
  await f.tick(2000); assert.equal(calls, 4);
  poll.dispose();
});
test('stream projections combine bursts, retain the final state, and leave no idle work', async () => {
  const f = environment(); let source = 0, latest = 0, flushes = 0;
  const batch = visibleBatch(() => { latest = source; flushes++; }, 100, f.env);
  for (let i = 1; i <= 1000; i++) { source = i; batch.request(); }
  assert.equal(f.timers.size, 1); await f.tick(100);
  assert.equal(latest, 1000); assert.equal(flushes, 1); assert.equal(f.timers.size, 0);
  f.show(false);
  for (let i = 1001; i <= 2000; i++) { source = i; batch.request(); }
  await f.tick(3600000); assert.equal(latest, 1000); assert.equal(f.timers.size, 0);
  f.show(true); await f.tick(100);
  assert.equal(latest, 2000); assert.equal(flushes, 2);
  batch.dispose(); assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
});
test('repeated mount/unmount and disposal during a read release every timer and listener', async () => {
  const f = environment();
  for (let i = 0; i < 500; i++) {
    let signal!: AbortSignal, finish!: () => void;
    const poll = visiblePoll(async value => { signal = value; await new Promise<void>(resolve => { finish = resolve; }); },
      { delay: () => 100, environment: f.env });
    const batch = visibleBatch(() => assert.fail('Disposed work must not run'), 100, f.env);
    batch.request(); batch.dispose(); poll.dispose(); finish(); await f.tick(100);
    assert.equal(signal.aborted, true);
    assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
  }
});
