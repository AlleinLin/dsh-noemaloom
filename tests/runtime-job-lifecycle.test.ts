import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { createRuntimeModule } from '../src/domain/runtime/index.js';
import { createAtomicStore } from '../src/domain/storage/index.js';
import type { NexusServices } from '../src/ports/contracts.js';

test('a lost command owner becomes effectUnknown and the same request never executes again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-runtime-lifecycle-'));
  const store = createAtomicStore(root);
  let calls = 0;
  const services = {
    workspaceRoot: root, dataDir: root, store, emit() {},
    host: { approve: async () => true },
    executor: { async run() { calls++; throw new Error('must never replay'); } },
  } as unknown as NexusServices;
  const module = createRuntimeModule(services);
  try {
    await store.put('runtimeJobs', 'interrupted', { id: 'interrupted', state: 'running', command: 'tool', args: [], startedAt: new Date().toISOString(),
      ownerPid: process.pid, ownerHost: hostname(), ownerToken: 'owner-that-no-longer-exists' }, 0);
    const recovered: any = await module.dispatch({ action: 'jobs.get', params: { id: 'interrupted' } }, { scopeLevel: 'global' });
    assert.equal(recovered.value.state, 'effectUnknown');
    const repeat: any = await module.dispatch({ action: 'terminal.run', requestId: 'interrupted', params: { command: 'tool', args: [] } }, { scopeLevel: 'global' });
    assert.equal(repeat.value.state, 'effectUnknown');
    assert.equal(calls, 0);
    const cancelled: any = await module.dispatch({ action: 'jobs.cancel', params: { id: 'interrupted' } }, { scopeLevel: 'global' });
    assert.equal(cancelled.cancelled, false);
    assert.equal(cancelled.reason, 'external-effect-unverified');
  } finally { await module.dispose?.(); await rm(root, { recursive: true, force: true }); }
});

test('a new module generation can observe and cancel a still-owned background job without fencing its result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-runtime-owner-'));
  const store = createAtomicStore(root);
  let finish!: (result: any) => void;
  const execution = new Promise<any>(resolve => { finish = resolve; });
  let receivedSignal: AbortSignal | undefined;
  const services = {
    workspaceRoot: root, dataDir: root, store, emit() {},
    host: { approve: async () => true },
    executor: { run(_command: string, _args: string[], options: any) { receivedSignal = options.signal; return execution; } },
  } as unknown as NexusServices;
  const first = createRuntimeModule(services), second = createRuntimeModule(services);
  try {
    await first.dispatch({ action: 'terminal.run', requestId: 'active', params: { command: 'tool', args: [], background: true } });
    const observed: any = await second.dispatch({ action: 'jobs.get', params: { id: 'active' } });
    assert.equal(observed.value.state, 'running');
    await second.dispatch({ action: 'jobs.cancel', params: { id: 'active' } });
    assert.equal(receivedSignal?.aborted, true);
    finish({ exitCode: null, stdout: '', stderr: '', cancelled: true, durationMs: 1 });
    for (let i = 0; i < 100; i++) {
      if ((await store.get<any>('runtimeJobs', 'active'))?.value.state === 'cancelled') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((await store.get<any>('runtimeJobs', 'active'))?.value.state, 'cancelled');
  } finally { finish({ exitCode: null, cancelled: true }); await first.dispose?.(); await second.dispose?.(); await rm(root, { recursive: true, force: true }); }
});
