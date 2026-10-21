import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import {
  LlmAdapter, LlmRuntime, ToolCallId, createUserMessage, expandAssistantStream,
  type GenerateOptions, type LlmFailure, type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { SessionId, SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime, defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import { HostAttemptTracker } from '../src/host/attempt-policy.js';
import { toNativeLlmError } from '../src/host/native-diagnostics.js';
import type { HostContext } from '../src/host/types.js';
import {
  NexusError, type HostAttemptMetadata, type HostAttemptPolicy, type HostAttemptReceipt, type JsonRecord,
} from '../src/ports/contracts.js';

// This fixture runs the installed native driver, registries, prompt assembly,
// stream accumulator and tool dispatcher. The provider alone is a local fake.
const route = { provider: 'native-recovery-fixture', model: 'local-model', maxTokens: 64 };
const toolName = 'fixture_complete';
const responseText = 'The complete provider response is retained.';
type ProviderStream = (options: GenerateOptions, attempt: number) => AsyncIterable<StreamChunk>;
type StreamMiddleware = (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>;
type RecoveryRequest = {
  agent: Agent; turn: number; step: number; provider: string; failure: LlmFailure; signal: AbortSignal;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Fixture did not reach ${label}`)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function* toolResponse(attempt = 1): AsyncGenerator<StreamChunk> {
  const id = ToolCallId(`fixture-call-${attempt}`);
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: responseText };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: responseText } };
  yield { type: 'block-start', index: 1, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 1, id, name: toolName, argumentsDelta: '{}' };
  yield { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: toolName, arguments: '{}' } };
  yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 7 } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}

class LocalAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];

  constructor(private readonly produce: ProviderStream) { super(); }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    return this.produce(options, this.calls.length);
  }
}

function recordingPolicy(options: {
  before?: (metadata: HostAttemptMetadata) => Promise<void>;
  settle?: (receipt: HostAttemptReceipt) => Promise<void>;
} = {}) {
  const admitted: HostAttemptMetadata[] = [];
  const receipts: HostAttemptReceipt[] = [];
  const policy: HostAttemptPolicy = {
    version: 1, runId: 'native-recovery-run', nodeId: 'native-recovery-node',
    async beforeAttempt(metadata) { admitted.push(metadata); await options.before?.(metadata); },
    async settleAttempt(receipt) { receipts.push(receipt); await options.settle?.(receipt); },
  };
  return { policy, admitted, receipts };
}

function eventsOf<T extends SessionEvent['type']>(agent: Agent, type: T) {
  return agent.session.snapshotEvents().filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

function turnEnd(agent: Agent) {
  const event = eventsOf(agent, 'turn/end').at(-1);
  assert.ok(event, 'the real driver must close its turn');
  return event.data.reason;
}

function assertCompleted(agent: Agent, providerAttempt = 1) {
  assert.deepEqual(turnEnd(agent), { kind: 'completed' });
  const messages = eventsOf(agent, 'assistant/message');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data.interrupted, undefined);
  assert.deepEqual(messages[0].data.message.content, [
    { type: 'text', text: responseText },
    { type: 'tool-call', id: ToolCallId(`fixture-call-${providerAttempt}`), name: toolName, arguments: '{}' },
  ]);
  assert.deepEqual(messages[0].data.usage, { inputTokens: 13, outputTokens: 7 });
  const finishes = expandAssistantStream(messages[0].data.stream)
    .map(item => item.chunk).filter(chunk => chunk.type === 'finish');
  assert.deepEqual(finishes, [{ type: 'finish', reason: { kind: 'tool-calls' } }]);
  assert.equal(eventsOf(agent, 'tool/call').length, 1);
  const results = eventsOf(agent, 'tool/result');
  assert.equal(results.length, 1);
  assert.equal(results[0].data.message.isError, false);
  assert.deepEqual(results[0].data.message.content, [{ type: 'text', text: 'local tool completed' }]);
  assert.equal(eventsOf(agent, 'tool/call')[0].data.callId, ToolCallId(`fixture-call-${providerAttempt}`));
  assert.ok(messages[0].seq < eventsOf(agent, 'tool/call')[0].seq);
  assert.ok(eventsOf(agent, 'tool/call')[0].seq < results[0].seq);
}

async function fixture(t: TestContext, options: {
  produce?: ProviderStream;
  middleware?: StreamMiddleware;
  oldAwaitedObserver?: boolean;
  observe?: (facts: JsonRecord) => Promise<void>;
  diagnostic?: (facts: JsonRecord) => void;
  retryOnce?: boolean;
} = {}) {
  const root = new Context();
  const adapter = new LocalAdapter(options.produce ?? ((_request, attempt) => toolResponse(attempt)));
  const handles: AgentHandle[] = [];
  const fibers: Array<{ dispose(): unknown }> = [];
  const observations: JsonRecord[] = [];
  const diagnostics: JsonRecord[] = [];
  const recovery: RecoveryRequest[] = [];
  const toolEntered = deferred();
  let toolsExecuted = 0;
  let ctx!: Context;
  let tracker!: HostAttemptTracker;
  t.after(async () => {
    for (const handle of handles.reverse()) await handle.dispose();
    tracker?.dispose();
    for (const fiber of fibers.reverse()) await fiber.dispose();
  });

  // Official services become visible through ctx.get() only after their
  // provider fiber is active. Each dependent layer therefore mounts afterward.
  const services = root.plugin({
    name: 'native-recovery-services',
    apply(owner: Context) {
      new AgentRegistry(owner);
      new SessionStore(owner);
      new SessionProjectionRegistry(owner);
      new SystemPrompt(owner, { includeHarnessIdentity: false });
      const llm = new LlmRuntime(owner);
      llm.registerAdapter([route.provider], adapter);
    },
  });
  fibers.push(services);
  await services.await();
  assert.equal(services.state, 2);

  const toolFiber = root.plugin({
    name: 'native-recovery-tools',
    inject: ['systemPrompt'],
    apply(owner: Context) {
      const tools = new ToolRuntime(owner);
      tools.register(defineContentToolFixture({
        name: toolName, description: 'Complete this local regression turn.', parameters: {},
        async execute(_args, exec) {
          toolsExecuted++;
          toolEntered.resolve();
          exec.concludeTurn();
          return [{ type: 'text', text: 'local tool completed' }];
        },
      }));
    },
  });
  fibers.push(toolFiber);
  await toolFiber.await();
  assert.equal(toolFiber.state, 2);

  const driver = root.plugin({
    name: 'native-recovery-driver',
    inject: ['agents', 'sessions', 'sessionProjections', 'llm', 'tools', 'systemPrompt'],
    apply(owner: Context) {
      ctx = owner;
      new AgentLoop(ctx, AgentLoop.Config({ agents: [], maxParallelToolCalls: 1 }));
      tracker = new HostAttemptTracker(ctx as unknown as HostContext, async (_request, facts) => {
        diagnostics.push(facts);
        options.diagnostic?.(facts);
      });
      ctx.on('agent/request-error', async (payload, next) => {
        recovery.push(payload);
        if (options.retryOnce && recovery.length === 1) return { kind: 'retry' };
        return next();
      });
      ctx.on('llm/stream', (request, next) => {
        // Deliberately reproduce the previous middleware's awaited settled
        // callback. This path demonstrates the native failure independently
        // from the production tracker and must remain broken in this fixture.
        if (options.oldAwaitedObserver) return {
          async *[Symbol.asyncIterator]() {
            yield* next();
            await options.observe?.({ fixture: 'old-awaited-observer' });
          },
        };
        const identity = tracker.identity(request);
        return {
          async *[Symbol.asyncIterator]() {
            try {
              yield* tracker.observe(request, next, identity, async facts => {
                observations.push(facts);
                await options.observe?.(facts);
              });
            } catch (error) {
              // Match the released LlmError boundary in host-adapter. The
              // native driver snapshots its structured failure verbatim.
              throw toNativeLlmError(error, {
                phase: 'llm-stream-middleware',
                signalAborted: Boolean(request.signal?.aborted || identity.owner?.controller.signal.aborted),
              });
            }
          },
        };
      });
      if (options.middleware) ctx.on('llm/stream', options.middleware);
    },
  });
  fibers.push(driver);
  await driver.await();
  assert.equal(driver.state, 2);

  async function create(name: string, policy?: HostAttemptPolicy) {
    const id = SessionId(name);
    const owner = policy ? tracker.ownerFor({ role: 'worker', prompt: 'local fixture', attemptPolicy: policy }) : undefined;
    tracker.reserve(id, owner);
    const handle = await ctx.agents.create({ sessionId: id, agentOptions: route });
    handles.push(handle);
    return { agent: handle.agent, owner };
  }

  function start(agent: Agent) {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the local fixture tool.' }] }));
    return within(agent.whenIdle(), 'native driver quiescence');
  }

  return {
    create, start, adapter, tracker, observations, diagnostics, recovery, toolEntered: toolEntered.promise,
    toolsExecuted: () => toolsExecuted,
  };
}

test('the old awaited observer reproduces finish(tool-calls), assistant/attempt, UNKNOWN and no tool dispatch', async t => {
  const h = await fixture(t, {
    oldAwaitedObserver: true,
    async observe() { await Promise.resolve(); throw new DOMException('操作已取消。', 'AbortError'); },
  });
  const { agent } = await h.create('old-awaited-tail');
  await h.start(agent);

  assert.equal(h.adapter.calls.length, 1);
  assert.equal(h.toolsExecuted(), 0);
  assert.equal(eventsOf(agent, 'assistant/message').length, 0);
  assert.equal(eventsOf(agent, 'tool/call').length, 0);
  assert.equal(h.recovery.length, 0, 'a thrown middleware error bypasses official request-error');
  const attempts = eventsOf(agent, 'assistant/attempt');
  assert.equal(attempts.length, 1);
  const chunks = expandAssistantStream(attempts[0].data.stream).map(item => item.chunk);
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
  assert.equal(chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').length, 1);
  const reason = turnEnd(agent);
  assert.equal(reason.kind, 'error');
  if (reason.kind === 'error') {
    assert.equal(reason.error.code, 'UNKNOWN');
    assert.match(reason.error.message, /操作已取消/);
  }
});

test('an independent observer which remains pending cannot hold native message commit or tool execution', async t => {
  const entered = deferred();
  const release = deferred();
  let observerFinished = false;
  const h = await fixture(t, {
    async observe() { entered.resolve(); await release.promise; observerFinished = true; },
  });
  const record = recordingPolicy();
  const { agent, owner } = await h.create('pending-observer', record.policy);
  const running = h.start(agent);
  try {
    await within(entered.promise, 'independent observer entry');
    await within(h.toolEntered, 'tool execution while observation is pending');
    await running;
    assert.equal(observerFinished, false);
    assertCompleted(agent);
    assert.equal(eventsOf(agent, 'assistant/attempt').length, 0);
    assert.equal(h.adapter.calls.length, 1);
    assert.equal(h.toolsExecuted(), 1);
    assert.equal(record.receipts.length, 1);
    assert.equal(record.receipts[0].status, 'reported');
    assert.equal(owner?.controller.signal.aborted, false);
    assert.equal(h.recovery.length, 0);
  } finally {
    release.resolve();
    await running;
  }
});

test('late independent observation rejection cannot change a completed native turn or replay its tool', async t => {
  const release = deferred();
  const reported = deferred();
  const h = await fixture(t, {
    async observe() { await release.promise; throw new DOMException('Observation timed out', 'AbortError'); },
    diagnostic(facts) { if (facts.diagnosticCode === 'NX_OBSERVATION_DEFERRED') reported.resolve(); },
  });
  const { agent } = await h.create('late-observer-rejection');
  try {
    await h.start(agent);
    assertCompleted(agent);
    const committedSeq = agent.session.seq;
    release.resolve();
    await within(reported.promise, 'background observation rejection handling');
    assert.equal(agent.session.seq, committedSeq);
    assertCompleted(agent);
    assert.equal(h.adapter.calls.length, 1);
    assert.equal(h.toolsExecuted(), 1);
    assert.equal(h.recovery.length, 0);
  } finally {
    release.resolve();
  }
});

test('an immediately rejecting independent observer cannot fail native commit or dispose the owner', async t => {
  const reported = deferred();
  const h = await fixture(t, {
    async observe() { throw new DOMException('Independent ledger cancelled', 'AbortError'); },
    diagnostic(facts) { if (facts.diagnosticCode === 'NX_OBSERVATION_DEFERRED') reported.resolve(); },
  });
  const record = recordingPolicy();
  const { agent, owner } = await h.create('immediate-observer-rejection', record.policy);
  let disposed = false;
  h.tracker.attach(owner, async () => { disposed = true; });
  await h.start(agent);
  await within(reported.promise, 'immediate observation rejection handling');

  assertCompleted(agent);
  assert.equal(h.adapter.calls.length, 1);
  assert.equal(h.toolsExecuted(), 1);
  assert.equal(record.receipts.length, 1);
  assert.equal(record.receipts[0].status, 'reported');
  assert.equal(owner?.controller.signal.aborted, false);
  assert.equal(disposed, false);
  assert.equal(h.recovery.length, 0);
});

for (const source of ['adapter', 'middleware'] as const) {
  test(`an ${source} AbortError after successful finish preserves the full native result without replay`, async t => {
    const abort = () => new DOMException('Terminal stream cleanup cancelled', 'AbortError');
    const h = await fixture(t, source === 'adapter' ? {
      async *produce(_request, attempt) { yield* toolResponse(attempt); throw abort(); },
    } : {
      async *middleware(_request, next) { yield* next(); throw abort(); },
    });
    const record = recordingPolicy();
    const { agent, owner } = await h.create(`${source}-successful-tail`, record.policy);
    await h.start(agent);

    assertCompleted(agent);
    assert.equal(eventsOf(agent, 'assistant/attempt').length, 0);
    assert.equal(h.adapter.calls.length, 1);
    assert.equal(h.toolsExecuted(), 1);
    assert.equal(h.recovery.length, 0);
    assert.equal(record.receipts.length, 1);
    assert.equal(record.receipts[0].status, 'reported');
    assert.deepEqual(record.receipts[0].usage, { inputTokens: 13, outputTokens: 7 });
    assert.equal(owner?.controller.signal.aborted, false);
    assert.ok(h.diagnostics.some(facts => facts.diagnosticCode === 'NX_STREAM_TAIL_RECOVERED'));
  });
}

test('a nonterminal middleware AbortError enters native request-error and retries the same step once', async t => {
  let middlewareAttempts = 0;
  const h = await fixture(t, {
    retryOnce: true,
    async *middleware(_request, next) {
      const current = ++middlewareAttempts;
      for await (const chunk of next()) {
        yield chunk;
        if (current === 1 && chunk.type === 'text-delta') {
          throw new DOMException('Middleware interrupted before finish', 'AbortError');
        }
      }
    },
  });
  const record = recordingPolicy();
  const { agent } = await h.create('nonterminal-middleware-retry', record.policy);
  await h.start(agent);

  assertCompleted(agent, 2);
  assert.equal(h.adapter.calls.length, 2);
  assert.equal(h.toolsExecuted(), 1);
  assert.equal(h.recovery.length, 1);
  assert.equal(h.recovery[0].failure.code, 'ABORTED');
  assert.equal(h.recovery[0].signal.aborted, false);
  assert.deepEqual([h.recovery[0].turn, h.recovery[0].step], [1, 1]);
  assert.equal(eventsOf(agent, 'step/start').length, 1, 'retry stays inside the native request step');
  const attempts = eventsOf(agent, 'assistant/attempt');
  assert.equal(attempts.length, 1);
  const finish = expandAssistantStream(attempts[0].data.stream).map(item => item.chunk).at(-1);
  assert.equal(finish?.type, 'finish');
  if (finish?.type === 'finish') {
    assert.equal(finish.reason.kind, 'aborted');
    if (finish.reason.kind === 'aborted') assert.equal(finish.reason.failure.code, 'ABORTED');
  }
  assert.equal(record.admitted.length, 2);
  assert.equal(record.receipts.length, 2);
  assert.equal(record.admitted[0].logicalCallId, record.admitted[1].logicalCallId);
  assert.notEqual(record.admitted[0].attemptId, record.admitted[1].attemptId);
  assert.deepEqual(record.receipts.map(receipt => receipt.status), ['cancelled', 'reported']);
});

for (const kind of ['user', 'parent'] as const) {
  test(`a true ${kind} cancellation after finish never revives the turn or dispatches its pending tool`, async t => {
    const tailEntered = deferred();
    const release = deferred();
    const h = await fixture(t, {
      retryOnce: true,
      async *middleware(_request, next) {
        yield* next();
        tailEntered.resolve();
        await release.promise;
        throw new DOMException('Cancelled while closing the stream', 'AbortError');
      },
    });
    const { agent } = await h.create(`${kind}-cancellation-after-finish`);
    const running = h.start(agent);
    try {
      await within(tailEntered.promise, 'successful terminal before explicit cancellation');
      agent.cancel({ kind });
      release.resolve();
      await running;
      assert.deepEqual(turnEnd(agent), { kind: 'aborted', reason: { kind } });
      assert.equal(h.adapter.calls.length, 1);
      assert.equal(h.toolsExecuted(), 0);
      assert.equal(eventsOf(agent, 'tool/call').length, 0);
      assert.equal(h.recovery.length, 0);
      assert.equal(h.diagnostics.some(facts => facts.diagnosticCode === 'NX_STREAM_TAIL_RECOVERED'), false);
      const messages = eventsOf(agent, 'assistant/message');
      assert.equal(messages.length, 1, 'native cancellation retains only the delivered visible prefix');
      assert.equal(messages[0].data.interrupted, true);
      assert.deepEqual(messages[0].data.message.content, [{ type: 'text', text: responseText }]);
    } finally {
      release.resolve();
      await running;
    }
  });
}

test('a hard admission budget error retains BUDGET_EXCEEDED in the real native turn', async t => {
  const failure = new NexusError('BUDGET_EXCEEDED', 'No provider attempt remains.');
  const record = recordingPolicy({ async before() { throw failure; } });
  const h = await fixture(t, { retryOnce: true });
  const { agent, owner } = await h.create('native-hard-budget', record.policy);
  await h.start(agent);

  const reason = turnEnd(agent);
  assert.equal(reason.kind, 'error');
  if (reason.kind === 'error') {
    assert.equal(reason.error.code, 'BUDGET_EXCEEDED');
    assert.match(reason.error.message, /traceId=trace_/);
  }
  assert.equal(h.adapter.calls.length, 0);
  assert.equal(h.toolsExecuted(), 0);
  assert.equal(h.recovery.length, 0);
  assert.equal(record.admitted.length, 1);
  assert.equal(record.receipts.length, 0);
  assert.equal(owner?.controller.signal.aborted, true);
  await assert.rejects(h.tracker.finish(owner), error => error === failure);
});

test('an internal middleware error retains its machine code instead of UNKNOWN', async t => {
  const h = await fixture(t, {
    retryOnce: true,
    async *middleware() { throw new NexusError('INTERNAL', 'Fixture internal failure.'); },
  });
  const { agent } = await h.create('native-internal-failure');
  await h.start(agent);

  const reason = turnEnd(agent);
  assert.equal(reason.kind, 'error');
  if (reason.kind === 'error') {
    assert.equal(reason.error.code, 'INTERNAL');
    assert.match(reason.error.message, /NX_INTERNAL_FAILURE/);
    assert.match(reason.error.message, /traceId=trace_/);
  }
  assert.equal(h.adapter.calls.length, 0);
  assert.equal(h.toolsExecuted(), 0);
  assert.equal(h.recovery.length, 0);
});

test('authoritative settlement failure after finish remains fatal and preserves its code', async t => {
  const failure = new NexusError('BUDGET_EXCEEDED', 'The authoritative reservation could not settle.');
  const record = recordingPolicy({ async settle() { throw failure; } });
  const h = await fixture(t, { retryOnce: true });
  const { agent, owner } = await h.create('native-authoritative-settlement', record.policy);
  await h.start(agent);

  const reason = turnEnd(agent);
  assert.equal(reason.kind, 'error');
  if (reason.kind === 'error') assert.equal(reason.error.code, 'BUDGET_EXCEEDED');
  assert.equal(h.adapter.calls.length, 1);
  assert.equal(h.toolsExecuted(), 0);
  assert.equal(eventsOf(agent, 'assistant/message').length, 0);
  assert.equal(eventsOf(agent, 'assistant/attempt').length, 1);
  assert.equal(eventsOf(agent, 'tool/call').length, 0);
  assert.equal(h.recovery.length, 0, 'hard policy failures never enter retry recovery');
  assert.equal(record.receipts.length, 1);
  assert.equal(owner?.controller.signal.aborted, true);
  await assert.rejects(h.tracker.finish(owner), error => error === failure);
});

for (const code of ['BUDGET_EXCEEDED', 'CTX_PREPARATION_FAILED', 'PARTIAL_EFFECT', 'AUTH']) {
  test(`a successful terminal cannot hide wrapped ${code} or execute its pending tool`, async t => {
    const h = await fixture(t, {
      retryOnce: true,
      async *middleware(_request, next) {
        yield* next();
        throw Object.assign(new Error('Private wrapped failure'), {
          name: 'AbortError', code: 'ABORTED', cause: new NexusError(code, 'Private hard cause'),
        });
      },
    });
    const { agent } = await h.create(`wrapped-hard-tail-${code.toLowerCase()}`);
    await h.start(agent);

    const reason = turnEnd(agent);
    assert.equal(reason.kind, 'error');
    if (reason.kind === 'error') {
      assert.equal(reason.error.code, code);
      assert.equal(reason.error.message.includes('Private'), false);
    }
    assert.equal(h.adapter.calls.length, 1);
    assert.equal(h.toolsExecuted(), 0);
    assert.equal(eventsOf(agent, 'assistant/message').length, 0);
    assert.equal(eventsOf(agent, 'tool/call').length, 0);
    assert.equal(h.recovery.length, 0);
    assert.equal(h.diagnostics.some(facts => facts.diagnosticCode === 'NX_STREAM_TAIL_RECOVERED'), false);
  });
}
