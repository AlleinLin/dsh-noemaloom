import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry, type AgentHandle } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { LlmAdapter, LlmRuntime, ToolCallId, createToolResultMessage, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import { buildSummarizationInput, compactSurfaceRegion } from '../vendor/compaction-basic/region.mjs';
import NexusCompactionEngine, { manualSummaryRequest } from '../src/host/compaction.js';
import { auxiliaryInputMessages, summaryEnvelopeBudget, summaryRequestBudget } from '../src/host/auxiliary-input.js';
import { createHostAdapter } from '../src/host/host-adapter.js';
import { createContextModule } from '../src/domain/context/index.js';
import type { HostContext } from '../src/host/types.js';
import type { NexusModule, NexusServices } from '../src/ports/contracts.js';
import { companionFixture } from './companion-fixture.js';

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
    assert.ok(summaryRequestBudget(manualSummaryRequest(input, agent.id, policy),
      policy.summaryWindowTokens, policy.summaryMaxTokens).fits);
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
  const policy = { provider: 'fixture', model: 'fixture', summaryWindowTokens: Number.MAX_SAFE_INTEGER, summaryMaxTokens };
  const budget = summaryRequestBudget(manualSummaryRequest(buildSummarizationInput(session, [start, assistant]), agent.id, policy),
    policy.summaryWindowTokens, summaryMaxTokens);
  policy.summaryWindowTokens = budget.inputUpperEstimate + budget.outputReserveTokens + budget.headroomTokens + 1;
  assert.equal(summaryRequestBudget(manualSummaryRequest(buildSummarizationInput(session, [start, assistant, tool]), agent.id, policy),
    policy.summaryWindowTokens, summaryMaxTokens).fits, false);
  const { engine, calls } = idleEngine(root, policy);
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

async function actualSummaryHost(t: TestContext, root: Context, windowTokens: number) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nexus-summary-envelope-'));
  const { services: base } = companionFixture();
  const requests: GenerateOptions[] = [], releases: string[] = [];
  const route = { provider: 'summary-envelope', model: 'bounded-summary' };
  class Adapter extends LlmAdapter {
    override async listModels() { return [{ provider: route.provider, id: route.model, name: route.model }]; }
    override async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, context: { contextWindow: windowTokens }, defaultMaxTokens: 128 };
    }
    async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
      requests.push(options);
      const bytes = Buffer.byteLength(JSON.stringify({ system: options.system, messages: options.messages, tools: options.tools }), 'utf8');
      assert.ok(bytes + (options.maxTokens ?? 4096) + 1024 < windowTokens,
        'the real prepared stream must receive an envelope inside the selected model window');
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Faithful summary of the selected completed source and remaining constraints.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  root.get('llm')!.registerAdapter([route.provider], new Adapter());
  let host!: ReturnType<typeof createHostAdapter>, module!: NexusModule;
  const services: NexusServices = {
    ...base, dataDir, workspaceRoot: dataDir,
    async invoke(domain, request, context) {
      assert.equal(domain, 'context');
      if (request.action === 'request/release') releases.push(String(request.params?.planId));
      return module.dispatch(request, context);
    },
  };
  const fiber = root.plugin({ name: 'summary-envelope-real-host', apply(ctx: Context) {
    host = createHostAdapter(ctx as unknown as HostContext, {}, dataDir, new AbortController().signal);
    services.host = host;
    module = createContextModule(services);
    host.connect(services);
  } });
  await fiber.await(); assert.equal(fiber.state, 2);
  t.after(async () => {
    await host.dispose(); await module.dispose?.(); await fiber.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { services, host, requests, releases, route };
}

test('escape-heavy idle source reaches the actual native summary stream after final-envelope range selection', async t => {
  const { root, agent, session } = await nativeFixture(t);
  const seqs = Array.from({ length: 8 }, (_, i) => session.append('user/message', createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: `Verified source ${i}: ` + '"C:\\work\\data"\\n'.repeat(900) }],
  }), { surfaceOp: 'append' }).seq);
  const tail = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Current input remains exact.' }] });
  session.append('user/message', tail, { surfaceOp: 'append' });
  const fullInput = buildSummarizationInput(session, seqs);
  const windowTokens = Buffer.byteLength(JSON.stringify(fullInput), 'utf8') + 128 + 4097;
  const h = await actualSummaryHost(t, root, windowTokens);
  const policy = { ...h.route, summaryWindowTokens: windowTokens, summaryMaxTokens: 128 };
  const fullRequest = manualSummaryRequest(fullInput, agent.id, policy);
  assert.equal(summaryRequestBudget(fullRequest, windowTokens, 128).fits, false,
    'the old raw-source budget passes while the final serialized envelope cannot fit');
  assert.equal(summaryEnvelopeBudget({ messages: auxiliaryInputMessages(fullRequest) }, windowTokens, 128).fits, false);
  const { engine } = idleEngine(root, policy);
  engine.officialOwners = new WeakMap();
  engine.pendingSummaries = new WeakMap();
  const fallback = engine.nativeContext.get;
  engine.nativeContext.get = (name: string) => name === 'nexus' ? { services: h.services } : fallback(name);
  delete engine.summarize; // Exercise production summarize, adapter, context preparation and LlmRuntime.
  const before = session.snapshotEvents();
  const result = await engine.compactNow(agent, new AbortController().signal, 'escaped-envelope-command');
  assert.ok(result?.compactionId);
  assert.equal(h.requests.length, 1);
  assert.equal(h.releases.length, 1);
  const events = session.snapshotEvents();
  assert.deepEqual(events.slice(0, before.length), before);
  assert.deepEqual(events.slice(before.length).map(event => event.type),
    ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end']);
  const summary = events.find(event => event.type === 'compaction/summary')!.data as any;
  assert.ok(summary.shadowedSeqs.length > 0 && summary.shadowedSeqs.length < seqs.length);
  const replacement = events[before.length + 2];
  assert.ok('surfaceOp' in replacement);
  assert.deepEqual(replacement.surfaceOp,
    { op: 'replace', startSeq: summary.shadowedSeqs[0], endSeq: summary.shadowedSeqs.at(-1) });
  for (const seq of seqs.filter(seq => !summary.shadowedSeqs.includes(seq))) {
    const original = session.deriveEventMessage(session.eventAt(seq)!);
    assert.deepEqual(session.deriveMessages().find(message => message.id === original!.id), original);
  }
  assert.deepEqual(session.deriveMessages().find(message => message.id === tail.id), tail);
  assert.equal(agent.options.model, undefined, 'the independent summary route must not change the conversation model');
  await agent.runMaintenance(async () => {});
});

test('source that fits alone but whose minimum full envelope cannot fit creates no transaction or model request', async t => {
  const { root, agent, session } = await nativeFixture(t);
  const first = session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: '"\\n\\tC:\\work"'.repeat(600) }] }), { surfaceOp: 'append' }).seq;
  session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'Retain current input.' }] }), { surfaceOp: 'append' });
  const windowTokens = Buffer.byteLength(JSON.stringify(buildSummarizationInput(session, [first]))) + 128 + 4097;
  const h = await actualSummaryHost(t, root, windowTokens);
  const { engine } = idleEngine(root, { ...h.route, summaryWindowTokens: windowTokens, summaryMaxTokens: 128 });
  const before = session.snapshotEvents();
  await assert.rejects(engine.compactNow(agent, new AbortController().signal), { code: 'CTX_SUMMARY_INPUT_LIMIT' });
  assert.deepEqual(session.snapshotEvents(), before);
  assert.equal(h.requests.length, 0);
  await agent.runMaintenance(async () => {});
});

test('summary envelope sizing includes UTF-8, prompts, message wrappers and escaped source with strict headroom', () => {
  const policy = { provider: 'fixture', model: 'fixture', summaryMaxTokens: 128 };
  const request = manualSummaryRequest({ tools: [{ name: 'read', description: '只读工具' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: '"C:\\工作\\result.json"\\n' }] }] }, 'fixture', policy);
  const envelope = { system: '', messages: auxiliaryInputMessages(request), tools: [] };
  const bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
  const budget = summaryRequestBudget(request, Number.MAX_SAFE_INTEGER, 128);
  assert.equal(budget.inputUpperEstimate, bytes);
  assert.ok(bytes > Buffer.byteLength(request.prompt, 'utf8') + Buffer.byteLength(request.system!, 'utf8'));
  assert.equal(budget.headroomTokens, 4096);
  assert.equal(summaryRequestBudget(request, bytes + 128 + 4096, 128).fits, false);
  assert.equal(summaryRequestBudget(request, bytes + 128 + 4097, 128).fits, true);
  assert.equal(summaryEnvelopeBudget(envelope, bytes + 128 + 1024, 128).fits, false);
  assert.equal(summaryEnvelopeBudget(envelope, bytes + 128 + 1025, 128).fits, true);
});

test('the final host guard rejects an oversized escaped envelope, releases its plan, and accepts the next request', async t => {
  const { root } = await nativeFixture(t);
  const prompt = '\\'.repeat(16000);
  const windowTokens = Buffer.byteLength(prompt) + 128 + 1025;
  const h = await actualSummaryHost(t, root, windowTokens);
  const request = { ...h.route, role: 'compression-auxiliary', independentRoute: true, sessionId: 'guard-release',
    prompt, maxTokens: 128 };
  await assert.rejects(h.host.model(request), (error: any) => {
    assert.equal(error.code, 'CTX_SUMMARY_INPUT_LIMIT');
    assert.match(error.message, /摘要最终请求/);
    assert.ok(error.details.inputUpperEstimate + 128 + 1024 >= windowTokens);
    return true;
  });
  assert.equal(h.requests.length, 0, 'local envelope rejection must not dispatch a paid request');
  assert.equal(h.releases.length, 1, 'the prepared request is released even if the final guard refuses it');
  const result = await h.host.model({ ...request, prompt: 'A smaller subsequent explicit request.' });
  assert.ok(result.text);
  assert.equal(h.requests.length, 1);
  assert.equal(h.releases.length, 2);
});
