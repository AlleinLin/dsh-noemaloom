import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry, type AgentHandle } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { LlmRuntime, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import { compactSurfaceRegion } from '../vendor/compaction-basic/region.mjs';
import NexusCompactionEngine from '../src/host/compaction.js';

test('the idle region helper is the pinned official implementation with only its export changed', async () => {
  const upstream = await readFile('vendor/compaction-basic/index.upstream.mjs', 'utf8');
  const installed = await readFile('node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js', 'utf8');
  const provenance = JSON.parse(await readFile('vendor/compaction-basic/SOURCE.json', 'utf8'));
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  assert.equal(upstream, installed);
  assert.equal(hash(upstream), provenance.upstreamSha256);
  const exportList = 'export { BasicCompactionEngine, BasicCompactionEngine as default };';
  assert.equal(upstream.split(exportList).length, 2);
  const result = await build({
    stdin: {
      contents: upstream.replace(exportList, 'export { compactSurfaceRegion };'),
      sourcefile: '@deepseek-ai/dsh-compaction-basic@0.2.1-rc.2/lib/index.js', resolveDir: process.cwd(),
    },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22',
    packages: 'external', treeShaking: true, logLevel: 'silent',
  });
  const actual = await readFile('vendor/compaction-basic/region.mjs', 'utf8');
  assert.equal(actual, result.outputFiles[0].text);
  assert.equal(hash(actual), provenance.derivedSha256);
});

test('manual ranges reserve the real idle Agent and retain the official standalone transaction and unselected tail', async t => {
  const root = new Context(), fibers: any[] = [];
  let handle: AgentHandle | undefined, driverContext!: Context;
  const services = root.plugin({ name: 'idle-range-native-services', apply(ctx: Context) {
    new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx);
    new SystemPrompt(ctx, { includeHarnessIdentity: false }); new LlmRuntime(ctx); new TokenMeter(ctx);
  } });
  fibers.push(services); await services.await(); assert.equal(services.state, 2);
  const tools = root.plugin({ name: 'idle-range-native-tools', inject: ['systemPrompt'], apply(ctx: Context) { new ToolRuntime(ctx); } });
  fibers.push(tools); await tools.await();
  const driver = root.plugin({
    name: 'idle-range-native-driver', inject: ['agents', 'sessions', 'sessionProjections', 'llm', 'tools', 'systemPrompt'],
    apply(ctx: Context) { driverContext = ctx; new AgentLoop(ctx, AgentLoop.Config({ agents: [] })); },
  });
  fibers.push(driver); await driver.await(); assert.equal(driver.state, 2);
  t.after(async () => { await handle?.dispose(); for (const fiber of fibers.reverse()) await fiber.dispose(); });
  handle = await driverContext.agents.create({ sessionId: SessionId(`idle-range-${randomUUID()}`), agentOptions: {} });
  const agent = handle.agent, session = agent.session;
  const start = session.append('user/message', createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'Original user source. '.repeat(400) }],
  }), { surfaceOp: 'append' }).seq;
  session.append('turn/start', { turn: 0 } as any);
  session.append('step/start', { turn: 0, step: 0 } as any);
  const end = session.append('assistant/message', {
    turn: 0, step: 0, stream: [],
    message: {
      id: 'idle-range-assistant', role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'Original assistant source. '.repeat(400) }],
    },
  } as any, { surfaceOp: 'append' }).seq;
  session.append('step/end', { turn: 0, step: 0 } as any);
  session.append('turn/end', { turn: 0 } as any);
  const tail = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Unselected tail must remain exact.' }] });
  session.append('user/message', tail, { surfaceOp: 'append' });
  const before = session.snapshotEvents();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const opened = new Promise<void>(resolve => { entered = resolve; });
  let summarizations = 0;
  const engine: any = Object.create(NexusCompactionEngine.prototype);
  engine.idleRangeAgents = new WeakSet();
  engine.prepareRanges = async (actual: any, _params: any, signal: AbortSignal) => {
    assert.equal(actual, agent);
    assert.ok(engine.idleRangeAgents.has(agent), 'the production entry must acquire maintenance before preparing');
    return compactSurfaceRegion({
      meter: root.get('tokenMeter'),
      async summarize() {
        summarizations++; entered(); await waiting;
        return { summary: [{ type: 'text', text: 'A faithful shorter summary of the two selected original source messages.' }], provider: 'test', model: 'test' };
      },
      recover() { return false; },
    }, session, start, end, agent, { owner: null, stability: 'selected-span' }, signal);
  };
  const operation = engine.compactRanges(agent, {}, new AbortController().signal);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      opened,
      operation.then(() => { throw new Error('maintenance ended before summarization'); }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('maintenance did not reach summarization')), 5_000); }),
    ]);
    assert.equal(agent.status, 'idle', 'the official public status deliberately includes maintenance in idle');
    assert.throws(() => agent.runMaintenance(async () => {}), /already has active work/, 'the native maintenance admission is held');
    await assert.rejects(engine.compactRanges(agent, {}, new AbortController().signal), { code: 'CTX_NATIVE_BUSY' });
    assert.equal(summarizations, 1);
  } finally {
    if (timeout) clearTimeout(timeout);
    release();
    await operation;
  }
  await agent.whenIdle();
  assert.equal(agent.status, 'idle');
  const events = session.snapshotEvents();
  assert.deepEqual(events.slice(0, before.length), before, 'old durable events are append-only');
  const bracket = events.filter(event => event.type.startsWith('compaction/'));
  assert.deepEqual(bracket.map(event => event.type), ['compaction/start', 'compaction/summary', 'compaction/end']);
  assert.equal((bracket[0].data as any).turn, null);
  assert.equal((bracket[2].data as any).turn, null);
  assert.deepEqual((bracket[1].data as any).shadowedSeqs, [start, end]);
  assert.deepEqual(session.deriveMessages().find(message => message.id === tail.id), tail);
  assert.equal(events.slice(before.length).filter(event => event.type === 'turn/start' || event.type === 'turn/end').length, 0, 'maintenance must not fabricate a user turn');
});
