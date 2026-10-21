import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationController } from '../src/host/lifecycle.js';

test('route teardown failure still aborts and joins admitted work, and every disposer awaits the same cleanup', async () => {
  const controller = new OperationController();
  let joined = false;
  controller.setRouteDisposer(async () => { throw new Error('unregister failed'); });
  const work = controller.run(undefined, signal => new Promise<boolean>(resolve => {
    signal.addEventListener('abort', () => { joined = true; resolve(signal.aborted); }, { once: true });
  }));
  await new Promise<void>(resolve => setImmediate(resolve));
  const first = controller.dispose();
  const repeated = controller.dispose();
  assert.equal(first, repeated);
  await assert.rejects(first, /unregister failed/);
  assert.equal(await work, true);
  assert.equal(joined, true);
  await assert.rejects(controller.run(undefined, async () => 'late write'), { code: 'CANCELLED' });
});
