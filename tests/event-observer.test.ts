import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createEventObserver } from '../src/host/event-observer.js';
import type { HostContext } from '../src/host/types.js';

test('failed synchronous and asynchronous listeners cannot mask a committed result or prevent other observers', async t => {
  const root = new Context();
  let healthy = 0, published = 0, logs = 0;
  const owner = root.plugin({ name: 'event-observer-fixture', apply(ctx: Context) {
    ctx.on('nexus/event' as any, () => { throw new Error('Optional listener unavailable'); });
    ctx.on('nexus/event' as any, async () => { throw new Error('Optional asynchronous listener unavailable'); });
    ctx.on('nexus/event' as any, () => { healthy++; });
  } });
  await owner.await(); t.after(() => owner.dispose());
  const remotes = [
    { publish() { throw new Error('Disconnected optional remote'); } },
    { async publish() { throw new Error('Disconnected asynchronous remote'); } },
    { publish() { published++; } },
  ];
  const observed = {
    parallel: (...args: any[]) => (root as any).parallel(...args),
    logger: { info() {}, error() {}, warn() { logs++; throw new Error('Optional logger unavailable'); } },
  } as unknown as HostContext;
  const emit = createEventObserver(observed, remotes);
  const committed = { committed: true, receiptId: 'local-receipt' };
  const complete = () => { emit('fixture/committed', committed); return committed; };
  assert.equal(complete(), committed);
  assert.equal(complete(), committed);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(healthy, 2);
  assert.equal(published, 2);
  assert.equal(logs, 1, 'diagnostics are bounded even when logging also fails');
});
