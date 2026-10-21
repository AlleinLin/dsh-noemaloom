import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { createHostAdapter, hostAuthority } from '../src/host/host-adapter.js';
import { nativeCompactionFor, registerNativeCompactionBinding } from '../src/host/compaction-binding.js';
import type { HostContext } from '../src/host/types.js';

test('the production compression bridge reaches the provider isolated below the agent preset and releases it on unload', async t => {
  const root = new Context(), id = `binding-${randomUUID()}`, signal = new AbortController().signal;
  const agent = { id, ctx: root };
  const calls: any[] = [];
  let host!: ReturnType<typeof createHostAdapter>;
  const owner = root.plugin({ name: 'compaction-binding-host', apply(ctx: Context) {
    ctx.provide('agents', { get(sessionId: string) { return sessionId === id ? agent : undefined; } });
    host = createHostAdapter(ctx as unknown as HostContext, {}, process.cwd(), signal);
  } });
  await owner.await();
  const provider = {
    async compactRanges(actual: any, params: Record<string, unknown>, actualSignal: AbortSignal) {
      calls.push({ actual, params, signal: actualSignal });
      return { committed: true, source: 'isolated-provider' };
    },
  };
  const child = root.isolate('compaction').plugin({ name: 'preset-compaction-child', apply(ctx: Context) {
    ctx.provide('compaction', provider);
    registerNativeCompactionBinding(ctx as unknown as HostContext, provider);
  } });
  await child.await();
  t.after(async () => { await child.dispose(); await host.dispose(); await owner.dispose(); });
  assert.equal(agent.ctx.get('compaction'), undefined, 'the old lookup cannot see the official isolated group');
  await (root as any).serial('agent/created', { agent, source: 'create' });
  const params = { sessionId: id, ranges: [{ startRef: 'm00001', endRef: 'm00001', summary: 'manual summary' }] };
  const result = await hostAuthority.run({ signal, sessionId: id }, () => host.sessions('context.compress', params));
  assert.deepEqual(result, { committed: true, source: 'isolated-provider' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actual, agent);
  assert.equal(calls[0].signal, signal);
  assert.deepEqual(calls[0].params, params);
  await assert.rejects(host.sessions('context.compress', { sessionId: 'unrelated-session' }), { code: 'SESSION_NOT_LIVE' });
  assert.equal(calls.length, 1, 'there is no global provider fallback for another session');
  await child.dispose();
  assert.equal(nativeCompactionFor(agent), undefined);
  await assert.rejects(host.sessions('context.compress', params), { code: 'DEPENDENCY_MISSING' });
});

test('an older provider or disposed agent cannot remove a replacement binding', async t => {
  const root = new Context(), id = `binding-generation-${randomUUID()}`;
  const oldAgent = { id }, newAgent = { id };
  const provider = () => ({ async compactRanges() { return {}; } });
  const first = provider(), second = provider();
  let oldBinding!: ReturnType<typeof registerNativeCompactionBinding>, freshBinding!: typeof oldBinding;
  const oldOwner = root.plugin({ name: 'old-native-compactor', apply(ctx: Context) {
    oldBinding = registerNativeCompactionBinding(ctx as unknown as HostContext, first);
  } });
  const newOwner = root.plugin({ name: 'new-native-compactor', apply(ctx: Context) {
    freshBinding = registerNativeCompactionBinding(ctx as unknown as HostContext, second);
  } });
  await Promise.all([oldOwner.await(), newOwner.await()]);
  t.after(async () => { await newOwner.dispose(); await oldOwner.dispose(); });
  oldBinding.bind(oldAgent); freshBinding.bind(newAgent);
  await (root as any).emit('agent/disposed', { agent: oldAgent });
  assert.equal(nativeCompactionFor(newAgent), second);
  await oldOwner.dispose();
  assert.equal(nativeCompactionFor(newAgent), second);
  await (root as any).emit('agent/disposed', { agent: newAgent });
  assert.equal(nativeCompactionFor(newAgent), undefined);
});
