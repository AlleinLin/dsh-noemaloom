import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientError, createNexusApi } from '../src/client/transport.js';
import { auxiliaryModel } from '../src/domain/insights/auxiliary.js';
import { companionFixture, routes } from './companion-fixture.js';
import type { ClientContext } from '../src/client/types.js';

function fixture() {
  const signals: AbortSignal[] = [];
  const api = createNexusApi({ connection: { rpc: { call(_channel, _endpoint, _payload, signal) {
    signals.push(signal!);
    return new Promise((_, reject) => signal!.addEventListener('abort',
      () => reject(new DOMException('signal is aborted without reason', 'AbortError')), { once: true }));
  } } }, slots: { inject() {}, register() {} }, effect() {} } as ClientContext);
  return { api, signals };
}
test('reconnect retains internal ownership even if RPC erases the abort reason', async () => {
  const f = fixture(); let notifications = 0; f.api.subscribe(() => { notifications++; });
  const call = f.api.call('companion', 'get');
  f.api.reset();
  await assert.rejects(call, error => error instanceof ClientError && error.code === 'nexus/stale-generation');
  assert.equal(notifications, 1); assert.equal(f.signals[0].aborted, true); f.api.dispose();
});
test('unattributed remote abort never claims that a local user cancelled', async () => {
  const api = createNexusApi({ connection: { rpc: { async call() {
    throw new DOMException('The user aborted a request.', 'AbortError');
  } } }, slots: { inject() {}, register() {} }, effect() {} } as ClientContext);
  await assert.rejects(api.call('companion', 'get'), error =>
    error instanceof ClientError && error.code === 'nexus/remote-aborted' && /未收到本地取消信号/.test(error.message));
  api.dispose();
});
test('caller cancellation and plugin disposal keep their own lifecycle category', async () => {
  const f = fixture(), controller = new AbortController();
  const caller = f.api.call('companion', 'get', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(caller, error => error instanceof ClientError && error.code === 'nexus/cancelled');
  const disposed = f.api.call('companion', 'get'); f.api.dispose();
  await assert.rejects(disposed, /插件已停止/);
});
test('an auxiliary provider AbortError falls back to the next route without a false user stop', async () => {
  const f = companionFixture({ routes });
  f.produce(async request => {
    if (request.model === 'first') throw new DOMException('The user aborted a request.', 'AbortError');
    return { text: 'recovered', model: request.model, provider: request.provider };
  });
  const result = await auxiliaryModel(f.services, f.context, { role: 'companion', prompt: 'task' });
  assert.equal(result.text, 'recovered');
  assert.equal(result.attempts[0].code, 'AUXILIARY_ABORT_UNATTRIBUTED');
  assert.equal(result.attempts[1].state, 'succeeded');
  assert.equal(f.calls.length, 2);
});
