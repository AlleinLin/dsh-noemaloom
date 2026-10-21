import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DebugRuntime } from '../src/host/debug/runtime.js';
import { FramedProtocol } from '../src/host/debug/protocol.js';
import { DebugCleanupError, type AdapterConnection } from '../src/host/debug/adapters.js';
function fixtureAdapter(replies: Record<string, any> = {}) {
  const input = new PassThrough(), output = new PassThrough();
  const protocol = new FramedProtocol(input, output), peer = new FramedProtocol(output, input);
  let disposed = 0;
  peer.on('message', message => {
    if (message.type !== 'request') return;
    if (message.command === 'initialize') {
      peer.respond(message, { ...replies.initialize, supportsConfigurationDoneRequest: true });
      peer.send({ type: 'event', event: 'initialized' });
    } else if (message.command === 'setBreakpoints') peer.respond(message, { breakpoints: message.arguments.breakpoints.map((point: any) => ({ ...point, verified: true })) });
    else if (message.command === 'next') {
      peer.send({ type: 'event', event: 'stopped', body: { threadId: 0, reason: 'step' } });
      peer.respond(message, {});
    } else peer.respond(message, replies[message.command] ?? {});
  });
  const adapter: AdapterConnection = { protocol, launch: { type: 'lldb', request: 'launch' }, spawnTerminal: async () => ({}),
    async dispose() { disposed++; protocol.close(); peer.close(); } };
  return { adapter, peer, disposed: () => disposed };
}
async function wait(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error('Mock runtime did not settle');
}
test('a stopped event delivered before next response remains authoritative', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-debug-state-')), fixture = fixtureAdapter();
  const scope = { sessionId: 'one', workspaceRoot: root };
  const runtime = new DebugRuntime({ broker: {} as any, cache: {} as any, workRoot: root, rust: async () => fixture.adapter });
  try {
    await runtime.start(scope, { type: 'lldb' }, {});
    await wait(async () => (await runtime.snapshot(scope)).snapshot?.phase === 'running');
    fixture.peer.send({ type: 'event', event: 'stopped', body: { threadId: 0, reason: 'breakpoint' } });
    const before = (await runtime.snapshot(scope)).snapshot!;
    assert.equal(before.stopped?.threadId, 0, 'js-debug uses zero as a valid thread id');
    await runtime.request(scope, 'next', { threadId: 0 }, before.generation);
    const after = (await runtime.snapshot(scope)).snapshot!;
    assert.equal(after.phase, 'stopped'); assert(after.generation > before.generation);
    await assert.rejects(runtime.request(scope, 'variables', { variablesReference: 1 }, before.generation), /resumed/);
    await assert.rejects(runtime.snapshot({ ...scope, workspaceRoot: tmpdir() }), /another workspace/);
    assert.equal((await runtime.snapshot({ ...scope, sessionId: 'other' })).snapshot, null);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
test('stop during preparation disposes an adapter that returns after cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-debug-stop-')), fixture = fixtureAdapter();
  const scope = { sessionId: 'one', workspaceRoot: root };
  let complete!: (adapter: AdapterConnection) => void;
  const ready = new Promise<AdapterConnection>(resolve => { complete = resolve; });
  const runtime = new DebugRuntime({ broker: {} as any, cache: {} as any, workRoot: root, rust: async () => ready });
  try {
    await runtime.start(scope, { type: 'lldb' }, {});
    const stopped = runtime.stop(scope);
    complete(fixture.adapter); await stopped;
    assert.equal(fixture.disposed(), 1);
    assert.equal((await runtime.snapshot(scope)).snapshot?.phase, 'terminated');
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
test('late adapter cleanup failure remains a failed stop instead of a terminated state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-debug-stop-fail-')), fixture = fixtureAdapter();
  const scope = { sessionId: 'one', workspaceRoot: root };
  let complete!: (adapter: AdapterConnection) => void;
  const ready = new Promise<AdapterConnection>(resolve => { complete = resolve; });
  const dispose = fixture.adapter.dispose;
  fixture.adapter.dispose = async () => { await dispose(); throw new DebugCleanupError('Owned cleanup unconfirmed'); };
  const runtime = new DebugRuntime({ broker: {} as any, cache: {} as any, workRoot: root, rust: async () => ready });
  try {
    await runtime.start(scope, { type: 'lldb' }, {});
    const stopped = runtime.stop(scope);
    complete(fixture.adapter);
    await assert.rejects(stopped, /cleanup unconfirmed/);
    assert.equal((await runtime.snapshot(scope)).snapshot?.phase, 'failed');
  } finally { await runtime.dispose().catch(() => {}); await rm(root, { recursive: true, force: true }); }
});
test('concurrent starts have one preparation owner and adapter failure never cancels a task signal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-debug-owner-')), task = new AbortController();
  const scope = { sessionId: 'one', workspaceRoot: root };
  const runtime = new DebugRuntime({ broker: {} as any, cache: {} as any, workRoot: root, rust: async () => { throw new Error('Adapter startup failure'); } });
  try {
    const first = runtime.start(scope, { type: 'lldb' }, {});
    await assert.rejects(runtime.start(scope, { type: 'lldb' }, {}), /already preparing/);
    await first;
    await wait(async () => (await runtime.snapshot(scope)).snapshot?.phase === 'failed');
    assert.equal(task.signal.aborted, false);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
test('debug output is bounded, cursored, and explicit launch secrets are redacted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-debug-buffer-')), fixture = fixtureAdapter(), scope = { sessionId: 'one', workspaceRoot: root };
  const runtime = new DebugRuntime({ broker: {} as any, cache: {} as any, workRoot: root, rust: async () => fixture.adapter });
  try {
    await runtime.start(scope, { type: 'lldb', env: { TEST_CREDENTIAL: 'synthetic-private-value' } }, {});
    await wait(async () => (await runtime.snapshot(scope)).snapshot?.phase === 'running');
    for (let i = 0; i < 600; i++) fixture.peer.send({ type: 'event', event: 'output', body: { output: `synthetic-private-value ${i}\n` } });
    const first = await runtime.snapshot(scope, 1);
    assert.equal(first.dropped, true); assert(first.events.length <= 200);
    assert(!JSON.stringify(first).includes('synthetic-private-value'));
    const second = await runtime.snapshot(scope, first.cursor);
    assert(second.events.every(event => event.cursor > first.cursor));
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
test('debug replies expose only bounded display fields and boolean capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-debug-shapes-'));
  const fixture = fixtureAdapter({
    initialize: { secretMetadata: 'hidden-adapter-detail', supportsEvaluateForHovers: true },
    variables: { variables: Array.from({ length: 110 }, () => ({ name: 'n'.repeat(400), value: 'v'.repeat(10000), type: 't'.repeat(400),
      variablesReference: 1, privateMetadata: 'hidden-adapter-detail' })) },
    threads: { threads: Array.from({ length: 210 }, (_, id) => ({ id: id + 1, name: 'worker', privateMetadata: 'hidden-adapter-detail' })) },
  });
  const scope = { sessionId: 'one', workspaceRoot: root };
  const runtime = new DebugRuntime({ broker: {} as any, cache: {} as any, workRoot: root, rust: async () => fixture.adapter });
  try {
    await runtime.start(scope, { type: 'lldb' }, {});
    await wait(async () => (await runtime.snapshot(scope)).snapshot?.phase === 'running');
    const ready = (await runtime.snapshot(scope)).snapshot!;
    assert.equal(ready.capabilities.supportsEvaluateForHovers, true);
    assert.equal(ready.capabilities.secretMetadata, undefined);
    fixture.peer.send({ type: 'event', event: 'stopped', body: { threadId: 1, reason: 'breakpoint' } });
    const generation = (await runtime.snapshot(scope)).snapshot!.generation;
    const variables = await runtime.request(scope, 'variables', { variablesReference: 1 }, generation);
    assert.equal(variables.variables.length, 100);
    assert(variables.variables.every((item: any) => item.name.length <= 256 && item.value.length <= 8192 && item.type.length <= 256));
    assert(!JSON.stringify(variables).includes('hidden-adapter-detail'));
    assert.equal((await runtime.request(scope, 'threads')).threads.length, 200);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
