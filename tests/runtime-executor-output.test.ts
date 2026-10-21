import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostExecutor } from '../src/domain/runtime/execution/index.js';
import type { HostContext } from '../src/host/types.js';
import type { NexusHost } from '../src/ports/contracts.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

test('the official collected readers expose live batches without consuming final output or propagating observer errors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-executor-output-'));
  const done = deferred<{ exitCode: number; signal: null }>(), spawned = deferred<void>();
  let tick = () => {};
  let intervalDelay: number | undefined;
  const timer = { unref() {} } as NodeJS.Timeout;
  t.mock.method(globalThis, 'setInterval', ((callback: () => void, delay?: number) => {
    tick = callback;
    intervalDelay = delay;
    return timer;
  }) as unknown as typeof setInterval);
  t.mock.method(globalThis, 'clearInterval', (() => {}) as typeof clearInterval);
  const output = { stdout: '', stderr: '' };
  const reads: Array<{ stream: string; offset: number }> = [];
  const reader = (stream: 'stdout' | 'stderr') => ({
    readFrom(offset: number) {
      reads.push({ stream, offset });
      const bytes = Buffer.from(output[stream]);
      return { text: bytes.subarray(offset).toString('utf8'), nextOffset: bytes.length, lossy: false };
    },
  });
  let spawnCount = 0, terminated = 0, approvalCount = 0;
  let spec: any;
  const handle = {
    collected: { stdout: reader('stdout'), stderr: reader('stderr') },
    done: done.promise, waitForExit: async () => true, terminate() { terminated++; },
  };
  const subprocess = {
    resolveExecutable: async () => 'fixture-executable',
    spawn(received: any) { spawnCount++; spec = received; spawned.resolve(); return handle; },
  };
  const ctx = { get(name: string) {
    if (name === 'subprocess') return subprocess;
    if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'danger-full-access' }) };
  } } as unknown as HostContext;
  const host = { approve: async () => { approvalCount++; return true; } } as unknown as NexusHost;
  const executor = createHostExecutor(ctx, host, root);
  t.after(async () => {
    done.resolve({ exitCode: 0, signal: null });
    await executor.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const batches: Array<{ stream: string; text: string; nextOffset: number; lossy: boolean }> = [];
  let settled = false;
  const running = executor.run('fixture', [], {
    cwd: root, timeoutMs: 60000, maxOutputBytes: 8192,
    onOutput(batch) {
      batches.push(batch);
      if (batches.length === 1) throw new Error('synchronous observer failure');
      if (batches.length === 2) return Promise.reject(new Error('asynchronous observer failure'));
    },
  }).then(result => { settled = true; return result; });
  try {
    await spawned.promise;
    assert.equal(intervalDelay, 100);
    output.stdout = 'first\n';
    tick();
    assert.equal(settled, false, 'live output must arrive while the command is still executing');
    assert.deepEqual(batches.map(batch => [batch.stream, batch.text]), [['stdout', 'first\n']]);
    assert.equal(handle.collected.stdout.readFrom(0).text, 'first\n', 'independent reads retain the complete collected result');
    output.stderr = 'warning\n';
    tick();
    output.stdout += 'last\n';
    done.resolve({ exitCode: 0, signal: null });
    const result = await running;
    assert.equal(result.stdout, 'first\nlast\n');
    assert.equal(result.stderr, 'warning\n');
    assert.equal(result.cancelled, false);
    assert.deepEqual(batches.map(batch => [batch.stream, batch.text]), [
      ['stdout', 'first\n'], ['stderr', 'warning\n'], ['stdout', 'last\n'],
    ]);
    assert.ok(reads.some(read => read.stream === 'stdout' && read.offset === 6));
    assert.equal(spawnCount, 1);
    assert.equal(approvalCount, 1);
    assert.equal(terminated, 0);
    assert.deepEqual(spec.stdio, { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } });
  } finally {
    done.resolve({ exitCode: 0, signal: null });
    await running;
  }
});
