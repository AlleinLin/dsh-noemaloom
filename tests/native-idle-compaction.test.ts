import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry, type AgentHandle } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { LlmRuntime, ToolCallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import { buildSummarizationInput, compactSurfaceRegion } from '../vendor/compaction-basic/region.mjs';
import NexusCompactionEngine from '../src/host/compaction.js';

test('idle selection, source replay and transaction helpers are pinned official implementations with only their exports changed', async () => {
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
      contents: upstream.replace(exportList, 'export { compactSurfaceRegion, selectCompactableRange, buildSummarizationInput };'),
      sourcefile: '@deepseek-ai/dsh-compaction-basic@0.2.1-rc.2/lib/index.js', resolveDir: process.cwd(),
    },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22',
    packages: 'external', treeShaking: true, logLevel: 'silent',
  });
  const actual = await readFile('vendor/compaction-basic/region.mjs', 'utf8');
  assert.equal(actual, result.outputFiles[0].text);
  assert.equal(hash(actual), provenance.derivedSha256);
});

async function nativeFixture(t: TestContext) {
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
  return { root, agent, session };
}

test('manual ranges reserve the real idle Agent and retain the official standalone transaction and unselected tail', async t => {
  const { root, agent, session } = await nativeFixture(t);
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

/** Owner persistence has its own suite; this seam keeps actual native admission and transactions. */
function idleEngine(root: Context, policy: any) {
  const calls = { lanes: 0, sync: 0, inputs: [] as any[] };
  const engine: any = Object.create(NexusCompactionEngine.prototype);
  engine.idleRangeAgents = new WeakSet();
  engine.nativeContext = {
    get(name: string) {
      if (name === 'tokenMeter') return root.get('tokenMeter');
      if (name === 'sessions') return { async flush() {} };
      throw new Error(`unexpected fixture service ${name}`);
    },
    async waterfall() { return false; },
  };
  engine.withLane = async (agent: any, _operation: string, execute: (owner: any) => Promise<any>) => {
    assert.ok(engine.idleRangeAgents.has(agent));
    calls.lanes++; return execute({});
  };
  engine.synchronize = async () => { calls.sync++; };
  engine.commitManual = async (_agent: any, _signal: AbortSignal, _owner: any, execute: () => Promise<any>) => execute();
  engine.measurePressure = async () => ({});
  engine.summaryPolicy = async () => policy;
  engine.summarize = async (input: any, agent: any) => {
    assert.throws(() => agent.runMaintenance(async () => {}), /already has active work/);
    calls.inputs.push(input);
    assert.ok(Buffer.byteLength(JSON.stringify(input)) + policy.summaryMaxTokens + 4096 < policy.summaryWindowTokens);
    return { summary: [{ type: 'text', text: 'A faithful short summary of the selected source.' }], provider: 'fixture', model: 'fixture' };
  };
  return { engine, calls };
}

test('compactNow rejects actual native maintenance before lane acquisition, sync or any model request', async t => {
  const { root, agent, session } = await nativeFixture(t);
  const { engine, calls } = idleEngine(root, { summaryWindowTokens: 1000000, summaryMaxTokens: 128 });
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Original user source. '.repeat(400) }] }), { surfaceOp: 'append' });
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Retain last input.' }] }), { surfaceOp: 'append' });
  let release!: () => void, entered!: () => void;
  const opened = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const maintenance = agent.runMaintenance(async () => { entered(); await gate; });
  await opened;
  try {
    assert.equal(agent.status, 'idle', 'public idle status alone does not prove maintenance admission');
    await assert.rejects(engine.compactNow(agent, new AbortController().signal), { code: 'CTX_NATIVE_BUSY' });
    assert.deepEqual(calls, { lanes: 0, sync: 0, inputs: [] });
    assert.equal(session.snapshotEvents().filter(event => event.type.startsWith('compaction/')).length, 0);
  } finally { release(); await maintenance; }
  await agent.whenIdle();
  const result = await engine.compactNow(agent, new AbortController().signal, 'compact-admission-command');
  assert.ok(result?.compactionId);
  assert.equal(calls.inputs.length, 1);
  assert.equal(calls.lanes, 1);
  assert.equal(calls.sync, 1);
  assert.equal((session.snapshotEvents().find(event => event.type === 'compaction/start')?.data as any).sourceCommandId, 'compact-admission-command');
});

test('compactNow bounds source to the selected model window without splitting a tool pair or altering its tail', async t => {
  const { root, agent, session } = await nativeFixture(t);
  const start = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'First complete original message. '.repeat(250) }] }), { surfaceOp: 'append' }).seq;
  session.append('turn/start', { turn: 0 } as any);
  session.append('step/start', { turn: 0, step: 0 } as any);
  const callId = ToolCallId('complete-pair-call');
  const assistant = session.append('assistant/message', {
    turn: 0, step: 0, stream: [],
    message: { id: 'complete-pair-assistant', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      content: [{ type: 'text', text: 'Tool request source. '.repeat(50) }, { type: 'tool-call', id: callId, name: 'fixture_read', arguments: '{}' }] },
  } as any, { surfaceOp: 'append' }).seq;
  const toolMessage = createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: 'Large original tool fact. '.repeat(2000) }] });
  const tool = session.append('tool/result', { turn: 0, step: 0, callId, message: toolMessage } as any, { surfaceOp: 'append' }).seq;
  session.append('step/end', { turn: 0, step: 0 } as any);
  session.append('turn/end', { turn: 0 } as any);
  const tail = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Unselected current input remains exact.' }] });
  session.append('user/message', tail, { surfaceOp: 'append' });
  const summaryMaxTokens = 128;
  const summaryWindowTokens = Buffer.byteLength(JSON.stringify(buildSummarizationInput(session, [start, assistant]))) + summaryMaxTokens + 4097;
  assert.ok(Buffer.byteLength(JSON.stringify(buildSummarizationInput(session, [start, assistant, tool]))) + summaryMaxTokens + 4096 > summaryWindowTokens);
  const { engine, calls } = idleEngine(root, { summaryWindowTokens, summaryMaxTokens });
  const original = session.snapshotEvents();
  await engine.compactNow(agent, new AbortController().signal, 'bounded-model-command');
  assert.equal(calls.inputs.length, 1);
  assert.equal(calls.inputs[0].messages.length, 1, 'incomplete call/result prefix is moved back to the preceding complete boundary');
  const events = session.snapshotEvents();
  assert.deepEqual(events.slice(0, original.length), original);
  const summary = events.find(event => event.type === 'compaction/summary')!;
  assert.deepEqual((summary.data as any).shadowedSeqs, [start]);
  const remaining = session.deriveMessages();
  assert.deepEqual(remaining.find(message => message.id === toolMessage.id), toolMessage);
  assert.deepEqual(remaining.find(message => message.id === tail.id), tail);
  assert.ok(remaining.find(message => message.id === 'complete-pair-assistant'));
});

test('a source with no complete prefix inside the summary window sends no model request and leaves no open transaction', async t => {
  const { root, agent, session } = await nativeFixture(t);
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Cannot fit this original source. '.repeat(1000) }] }), { surfaceOp: 'append' });
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep current input.' }] }), { surfaceOp: 'append' });
  const original = session.snapshotEvents();
  const { engine, calls } = idleEngine(root, { summaryWindowTokens: 4500, summaryMaxTokens: 128 });
  await assert.rejects(engine.compactNow(agent, new AbortController().signal), { code: 'CTX_SUMMARY_INPUT_LIMIT' });
  assert.equal(calls.inputs.length, 0);
  assert.deepEqual(session.snapshotEvents(), original);
  assert.equal(engine.idleRangeAgents.has(agent), false);
  await agent.runMaintenance(async () => {});
});
