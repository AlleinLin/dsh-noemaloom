import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent';
import {
  LlmAdapter, LlmRuntime, ProviderRequestId, markAgentLoopRequest, type GenerateOptions, type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import { HostAttemptTracker } from '../src/host/attempt-policy.js';
import type { HostContext } from '../src/host/types.js';
import {
  NexusError, type HostAttemptMetadata, type HostAttemptPolicy, type HostAttemptReceipt,
  type JsonRecord,
} from '../src/ports/contracts.js';

const route = { provider: 'attempt-fixture', model: 'local-model', maxTokens: 32 };
type ProviderStream = (options: GenerateOptions, attempt: number) => AsyncIterable<StreamChunk>;

async function* success(): AsyncGenerator<StreamChunk> {
  yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 5 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

class LocalAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];

  constructor(private readonly produce: ProviderStream) { super(); }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    return this.produce(options, this.calls.length);
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function recordingPolicy(before?: (metadata: HostAttemptMetadata) => Promise<void>) {
  const admitted: HostAttemptMetadata[] = [];
  const receipts: HostAttemptReceipt[] = [];
  const policy: HostAttemptPolicy = {
    version: 1, runId: 'attempt-run', nodeId: 'attempt-node',
    async beforeAttempt(metadata) {
      admitted.push(metadata);
      await before?.(metadata);
    },
    async settleAttempt(receipt) { receipts.push(receipt); },
  };
  return { policy, admitted, receipts };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

async function harness(t: TestContext, produce: ProviderStream = success, observe?: (facts: JsonRecord) => Promise<void>) {
  const root = new Context();
  const adapter = new LocalAdapter(produce);
  const ledger: JsonRecord[] = [];
  const detachers: Array<() => void> = [];
  let ctx!: Context;
  let agents!: AgentRegistry;
  let llm!: LlmRuntime;
  let tracker!: HostAttemptTracker;
  const fiber = root.plugin({
    name: 'host-attempt-policy-fixture',
    apply(ownerCtx: Context) {
      ctx = ownerCtx;
      agents = new AgentRegistry(ctx);
      llm = new LlmRuntime(ctx);
      tracker = new HostAttemptTracker(ctx as unknown as HostContext);
      ctx.on('llm/stream', (options, next) => tracker.observe(
        options, next, tracker.identity(options), async facts => { ledger.push(facts); await observe?.(facts); },
      ));
      llm.registerAdapter([route.provider], adapter);
    },
  });
  t.after(async () => {
    for (const detach of detachers.reverse()) detach();
    tracker?.dispose();
    await fiber.dispose();
  });
  await fiber.await();
  assert.equal(fiber.state, 2, 'the official runtime services must activate');
  assert.ok(root.get('llm') instanceof LlmRuntime);
  assert.ok(root.get('agents') instanceof AgentRegistry);

  async function enter(name: string, owner?: Agent, durableParent?: Agent) {
    const id = SessionId(name);
    const session = Session.create(id, [], {
      version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false,
      ...(durableParent ? { parentSession: durableParent.id } : {}),
    });
    // Only the driver is a fixture: Session, publication, ownership, scope
    // carriers, initiator propagation and provider dispatch use rc.2 itself.
    const agent = { id, session, ctx, status: 'idle', options: route } as Agent;
    const detach = agents.enter(agent, owner);
    detachers.push(detach);
    await agents.announce(agent, 'startup');
    return { agent, detach };
  }

  async function run(
    agent: Agent, turn: number, step: number,
    consume: (stream: AsyncIterable<StreamChunk>) => Promise<unknown> = collect,
    purpose?: GenerateOptions['purpose'],
  ) {
    return agents.withInitiator(agent, async () => {
      assert.equal(agents.currentInitiator(), agent);
      const signal = new AbortController().signal;
      const config = await ctx.waterfall(scopeTarget(agent, agent), 'agent/request', {
        agent, turn, step, signal,
      }, async () => route);
      const prepared = await llm.prepareCall(config, signal);
      const request: GenerateOptions = {
        ...prepared.config, messages: [], sessionId: agent.id, signal,
        ...(purpose ? { purpose } : {}),
      };
      Object.freeze(request.messages);
      Object.freeze(request);
      return consume(prepared.stream(purpose ? request : markAgentLoopRequest(request)));
    });
  }

  return { agents, tracker, adapter, ledger, enter, run };
}

test('independent auxiliary attempts cannot inherit or dispose a bound main owner', async t => {
  const h = await harness(t), record = recordingPolicy();
  const mainOwner = h.tracker.ownerFor({ role: 'main', prompt: 'main', attemptPolicy: record.policy });
  assert.ok(mainOwner); h.tracker.reserve('isolated-parent', mainOwner);
  const parent = await h.enter('isolated-parent');
  let disposed = 0; h.tracker.attach(mainOwner, async () => { disposed++; });
  await h.agents.withInitiator(parent.agent, async () => h.tracker.withOwner(mainOwner, async () => {
    assert.equal(h.tracker.ownerFor({ role: 'companion', prompt: 'side', independentRoute: true }, parent.agent), undefined);
    const independent = recordingPolicy();
    independent.policy.runId = 'auxiliary-run';
    const owner = h.tracker.ownerFor({ role: 'companion', prompt: 'side', independentRoute: true, attemptPolicy: independent.policy }, parent.agent);
    assert.ok(owner); assert.notEqual(owner, mainOwner);
    const identity = h.tracker.identity({ sessionId: parent.agent.id, provider: route.provider, model: route.model }, { owner, isolated: true, attemptId: 'independent-attempt', role: 'companion', logicalCallId: 'independent' });
    assert.equal(identity.owner, owner);
    h.tracker.fail(owner, new Error('auxiliary provider failed'));
    await assert.rejects(h.tracker.finish(owner), /auxiliary/);
    assert.equal(mainOwner.controller.signal.aborted, false); assert.equal(disposed, 0);
    await h.tracker.finish(mainOwner);
  }));
});

test('an asynchronous budget rejection stops the real LLM adapter and survives failed teardown', async t => {
  const h = await harness(t);
  const budgetError = new NexusError('BUDGET_EXCEEDED', 'no provider attempt remains');
  const record = recordingPolicy(async () => {
    await Promise.resolve();
    assert.equal(h.adapter.calls.length, 0);
    throw budgetError;
  });
  const owner = h.tracker.ownerFor({ role: 'worker', prompt: 'work', attemptPolicy: record.policy });
  assert.ok(owner);
  h.tracker.reserve('denied-child', owner);
  const child = await h.enter('denied-child');
  let disposals = 0;
  h.tracker.attach(owner, async () => {
    disposals++;
    child.detach();
    throw new Error('fixture teardown also failed');
  });

  await assert.rejects(h.run(child.agent, 1, 1), error => error === budgetError);
  await assert.rejects(h.tracker.finish(owner), error => error === budgetError);
  await assert.rejects(h.tracker.finish(owner), error => error === budgetError);
  assert.equal(h.adapter.calls.length, 0);
  assert.equal(record.admitted.length, 1);
  assert.equal(record.receipts.length, 0, 'a denied attempt never opens a usage reservation');
  assert.equal(h.ledger.length, 0);
  assert.equal(disposals, 1);
  assert.equal(owner.controller.signal.aborted, true);
  assert.equal(h.agents.get(child.agent.id), undefined);
});

test('same-agent retries keep the request-step identity and settle the final streamed usage once', async t => {
  const h = await harness(t, async function* (_options, attempt): AsyncGenerator<StreamChunk> {
    if (attempt === 1) {
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 0 } };
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'retry this request' } } };
      return;
    }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } };
    yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const record = recordingPolicy();
  const owner = h.tracker.ownerFor({ role: 'worker', prompt: 'work', attemptPolicy: record.policy });
  assert.ok(owner);
  h.tracker.reserve('retry-child', owner);
  const { agent } = await h.enter('retry-child');

  await h.run(agent, 2, 3);
  assert.equal(record.receipts.length, 1);
  assert.equal(record.receipts[0].status, 'failed');
  assert.deepEqual(record.receipts[0].usage, { inputTokens: 4, outputTokens: 0 });

  // Re-enter the public request waterfall for the same exact Agent, turn and
  // step, as the loop does when request-error recovery chooses another attempt.
  await h.run(agent, 2, 3, async stream => {
    const iterator = stream[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, 'usage');
    assert.equal((await iterator.next()).value?.type, 'usage');
    assert.equal((await iterator.next()).value?.type, 'finish');
    assert.equal(record.receipts.length, 1, 'receipts wait for the stream tail');
    assert.equal(h.ledger.length, 1);
    assert.equal((await iterator.next()).done, true);
    assert.equal(record.receipts.length, 2);
    await iterator.return?.();
    assert.equal(record.receipts.length, 2, 'closing an exhausted stream must not settle twice');
  });
  await h.run(agent, 2, 4);

  assert.equal(h.adapter.calls.length, 3);
  assert.equal(record.admitted.length, 3);
  assert.equal(record.receipts.length, 3);
  assert.equal(record.admitted[0].logicalCallId, record.admitted[1].logicalCallId);
  assert.notEqual(record.admitted[1].logicalCallId, record.admitted[2].logicalCallId);
  assert.equal(new Set(record.admitted.map(item => item.attemptId)).size, 3);
  assert.deepEqual(record.receipts.map(item => item.attemptId), record.admitted.map(item => item.attemptId));
  assert.equal(record.receipts[1].status, 'reported');
  assert.deepEqual(record.receipts[1].usage, { inputTokens: 11, outputTokens: 5 });
  assert.equal(record.receipts[1].usageRevision, 1);
  assert.equal(record.receipts[1].providerHttpAttempts, 'opaque');
  assert.equal(h.ledger.length, 3);
  assert.deepEqual(h.ledger[1].usage, record.receipts[1].usage);
  assert.equal(h.ledger[1].attemptId, record.receipts[1].attemptId);

  await h.run(agent, 2, 4, collect, 'compaction');
  await h.run(agent, 2, 4, collect, 'session-title');
  const auxiliary = record.admitted.slice(3);
  assert.equal(auxiliary.length, 2);
  assert.ok(auxiliary.every(item => item.logicalCallId !== record.admitted[2].logicalCallId));
  assert.notEqual(auxiliary[0].logicalCallId, auxiliary[1].logicalCallId);
  assert.equal(new Set(record.admitted.map(item => item.attemptId)).size, 5);
  assert.equal(record.receipts.length, 5);
  assert.equal(h.ledger.length, 5);
});

test('runtime descendants share their owner policy while durable parent metadata grants no ownership', async t => {
  const h = await harness(t);
  const record = recordingPolicy();
  const request = { role: 'worker', prompt: 'work' };
  const owner = h.tracker.ownerFor({ ...request, attemptPolicy: record.policy });
  assert.ok(owner);
  h.tracker.reserve('policy-root', owner);
  const { agent: root } = await h.enter('policy-root');
  const { agent: child } = await h.enter('policy-child', root);
  const { agent: grandchild } = await h.enter('policy-grandchild', child);
  const { agent: unrelated } = await h.enter('durable-parent-only', undefined, root);

  assert.equal(h.agents.isOwnedBy(child.id, root), true);
  assert.equal(h.agents.isOwnedBy(grandchild.id, child), true);
  assert.equal(h.agents.isOwnedBy(grandchild.id, root), false);
  assert.equal(unrelated.session.header.parentSession, root.id);
  assert.equal(h.agents.isOwnedBy(unrelated.id, root), false);
  assert.equal(h.tracker.ownerFor(request, grandchild), owner);
  assert.equal(h.agents.withInitiator(grandchild, () => h.tracker.ownerFor(request)), owner);
  assert.equal(h.tracker.ownerFor(request, unrelated), undefined);
  assert.equal(h.agents.withInitiator(unrelated, () => h.tracker.ownerFor(request)), undefined);
  assert.throws(() => h.tracker.ownerFor({
    ...request, attemptPolicy: { ...record.policy, nodeId: 'replacement-node' },
  }, grandchild), { code: 'PERMISSION_DENIED' });

  for (const agent of [root, child, grandchild, unrelated]) await h.run(agent, 1, 1);
  assert.equal(h.adapter.calls.length, 4);
  assert.deepEqual(record.admitted.map(item => item.sessionId), [root.id, child.id, grandchild.id]);
  assert.equal(record.receipts.length, 3);
  assert.ok(record.receipts.every(item => item.runId === record.policy.runId && item.nodeId === record.policy.nodeId));
  assert.ok(record.receipts.every(item => item.status === 'reported'));
  assert.deepEqual(record.receipts.map(item => item.usage), [
    { inputTokens: 11, outputTokens: 5 },
    { inputTokens: 11, outputTokens: 5 },
    { inputTokens: 11, outputTokens: 5 },
  ]);
  assert.equal(h.ledger.length, 4, 'the unowned runtime call is recorded without inheriting the policy');
});

test('an aborted provider stream without usage finalizes its admitted attempt once', async t => {
  const h = await harness(t, async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: '' };
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'provider cancelled' } } };
  });
  const record = recordingPolicy();
  const owner = h.tracker.ownerFor({ role: 'worker', prompt: 'work', attemptPolicy: record.policy });
  assert.ok(owner);
  h.tracker.reserve('cancelled-child', owner);
  const { agent } = await h.enter('cancelled-child');

  await h.run(agent, 1, 1, async stream => {
    const iterator = stream[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, 'text-delta');
    assert.equal((await iterator.next()).value?.type, 'finish');
    assert.equal(record.receipts.length, 0);
    assert.equal((await iterator.next()).done, true);
    await iterator.return?.();
    await iterator.return?.();
  });
  assert.equal(h.adapter.calls.length, 1);
  assert.equal(record.admitted.length, 1);
  assert.equal(record.receipts.length, 1);
  assert.equal(record.receipts[0].status, 'cancelled');
  assert.equal(record.receipts[0].usage, undefined);
  assert.equal(record.receipts[0].ttftState, 'unknown');
  assert.equal(Object.hasOwn(record.receipts[0], 'ttftMs'), false);
  assert.equal(Object.hasOwn(record.receipts[0], 'firstTextAt'), false);
  assert.equal(Object.hasOwn(h.ledger[0], 'ttftMs'), false);
  assert.equal(Object.hasOwn(h.ledger[0], 'firstTextAt'), false);
  assert.equal(h.ledger.length, 1);
});

test('stream timing starts after manually released admission and records reasoning before nonempty text', async t => {
  const admissionEntered = deferred();
  const releaseAdmission = deferred();
  const reasoningObserved = deferred();
  const releaseText = deferred();
  t.after(() => { releaseAdmission.resolve(); releaseText.resolve(); });
  const h = await harness(t, async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' };
    yield { type: 'reasoning-delta', index: 0, text: 'considering' };
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'considering' } };
    yield { type: 'block-start', index: 1, blockType: 'text' };
    yield { type: 'text-delta', index: 1, text: '' };
    await releaseText.promise;
    yield { type: 'text-delta', index: 1, text: 'answer' };
    yield { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } };
    yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const record = recordingPolicy(async () => {
    admissionEntered.resolve();
    await releaseAdmission.promise;
  });
  const owner = h.tracker.ownerFor({ role: 'worker', prompt: 'work', attemptPolicy: record.policy });
  assert.ok(owner);
  h.tracker.reserve('timed-child', owner);
  const { agent } = await h.enter('timed-child');

  const running = h.run(agent, 1, 1, async stream => {
    for await (const chunk of stream) {
      if (chunk.type === 'reasoning-delta') reasoningObserved.resolve();
    }
  });
  await admissionEntered.promise;
  assert.equal(h.adapter.calls.length, 0, 'awaited admission must finish before the adapter is invoked');
  assert.equal(record.receipts.length, 0);
  releaseAdmission.resolve();
  await reasoningObserved.promise;
  assert.equal(h.adapter.calls.length, 1);
  assert.equal(record.receipts.length, 0);
  releaseText.resolve();
  await running;

  assert.equal(record.receipts.length, 1);
  const receipt = record.receipts[0];
  assert.equal(receipt.status, 'reported');
  assert.ok(typeof receipt.admissionWaitMs === 'number' && receipt.admissionWaitMs >= 0);
  assert.ok(receipt.dispatchStartedAt);
  assert.ok(receipt.firstReasoningAt);
  assert.ok(receipt.firstTextAt);
  assert.ok(Number.isFinite(Date.parse(receipt.dispatchStartedAt)));
  assert.ok(Number.isFinite(Date.parse(receipt.firstReasoningAt)));
  assert.ok(Number.isFinite(Date.parse(receipt.firstTextAt)));
  assert.ok(typeof receipt.timeToFirstReasoningMs === 'number' && receipt.timeToFirstReasoningMs >= 0);
  assert.ok(typeof receipt.ttftMs === 'number' && receipt.ttftMs >= receipt.timeToFirstReasoningMs);
  assert.equal(receipt.ttftState, 'observed');
  assert.equal(receipt.ttftSource, 'llm-runtime-stream:first-nonempty-text-delta');
  assert.equal(Object.hasOwn(receipt, 'providerRequestId'), false);
  assert.equal(h.ledger.length, 1);
  assert.equal(h.ledger[0].ttftMs, receipt.ttftMs);
  assert.equal(h.ledger[0].timeToFirstReasoningMs, receipt.timeToFirstReasoningMs);
});

test('a public provider failure request ID is preserved separately from local attempt identities', async t => {
  const providerRequestId = ProviderRequestId('req_provider_failure_fixture');
  const h = await harness(t, async function* (): AsyncGenerator<StreamChunk> {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'SERVER', message: 'provider rejected request', requestId: providerRequestId } },
    };
  });
  const record = recordingPolicy();
  const owner = h.tracker.ownerFor({ role: 'worker', prompt: 'work', attemptPolicy: record.policy });
  assert.ok(owner);
  h.tracker.reserve('diagnostic-child', owner);
  const { agent } = await h.enter('diagnostic-child');
  await h.run(agent, 1, 1);

  assert.equal(h.adapter.calls.length, 1);
  assert.equal(record.receipts.length, 1);
  const receipt = record.receipts[0];
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.providerRequestId, providerRequestId);
  assert.equal(receipt.providerRequestIdSource, 'llm-failure.requestId');
  assert.notEqual(receipt.providerRequestId, receipt.attemptId);
  assert.notEqual(receipt.providerRequestId, receipt.logicalCallId);
  assert.equal(receipt.ttftState, 'unknown');
  assert.equal(Object.hasOwn(receipt, 'ttftMs'), false);
  assert.equal(Object.hasOwn(receipt, 'firstTextAt'), false);
  assert.equal(h.ledger.length, 1);
  assert.equal(h.ledger[0].providerRequestId, providerRequestId);
  assert.equal(h.ledger[0].providerRequestIdSource, 'llm-failure.requestId');
});

test('an independent observation timeout preserves a completed stream and its owned agent', async t => {
  const h = await harness(t, success, async () => { throw new DOMException('Bookkeeping timeout', 'AbortError'); });
  const record = recordingPolicy();
  const owner = h.tracker.ownerFor({ role: 'worker', prompt: 'work', attemptPolicy: record.policy })!;
  h.tracker.reserve('observation-child', owner);
  const { agent } = await h.enter('observation-child');
  let disposed = false;
  h.tracker.attach(owner, async () => { disposed = true; });
  const chunks = await h.run(agent, 1, 1) as StreamChunk[];
  assert.equal(chunks.at(-1)?.type, 'finish');
  assert.equal(record.receipts[0].status, 'reported');
  assert.equal(owner.controller.signal.aborted, false);
  assert.equal(disposed, false);
  assert.equal(h.agents.get(agent.id), agent);
  await h.tracker.finish(owner);
});

test('authoritative settlement rejection still stops the owner when independent observation also fails', async t => {
  const h = await harness(t, success, async () => { throw new Error('ledger unavailable'); });
  const record = recordingPolicy();
  const violation = new NexusError('BUDGET_EXCEEDED', 'authoritative reservation failed');
  record.policy.settleAttempt = async () => { throw violation; };
  const owner = h.tracker.ownerFor({ role: 'worker', prompt: 'work', attemptPolicy: record.policy })!;
  h.tracker.reserve('settlement-child', owner);
  const { agent } = await h.enter('settlement-child');
  await assert.rejects(h.run(agent, 1, 1), error => error === violation);
  assert.equal(owner.controller.signal.aborted, true);
  assert.equal(h.adapter.calls.length, 1);
});

test('a cancelled provider tail after complete tool calls preserves the response without another dispatch', async t => {
  const h = await harness(t, async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 3 } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
    throw new DOMException('The operation was aborted.', 'AbortError');
  });
  const record = recordingPolicy();
  const owner = h.tracker.ownerFor({ role: 'worker', prompt: 'work', attemptPolicy: record.policy })!;
  h.tracker.reserve('tail-child', owner);
  const { agent } = await h.enter('tail-child');
  const chunks = await h.run(agent, 1, 1) as StreamChunk[];
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1);
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
  assert.equal(h.adapter.calls.length, 1);
  assert.equal(record.receipts[0].status, 'reported');
  assert.equal(owner.controller.signal.aborted, false);
});

test('failure before a terminal remains visible with its transport diagnostic and retry routing', async t => {
  const h = await harness(t, async function* (): AsyncGenerator<StreamChunk> {
    throw Object.assign(new Error('ECONNRESET private prompt'), { code: 'ECONNRESET' });
  });
  const { agent } = await h.enter('network-child');
  const chunks = await h.run(agent, 1, 1) as StreamChunk[];
  const finish = chunks.at(-1) as any;
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, 'TRANSPORT');
  assert.match(finish.reason.failure.message, /NX_NETWORK_TRANSPORT/);
  assert.equal(finish.reason.failure.message.includes('private prompt'), false);
});

test('max-tokens remains the released finish shape without an invented error payload', async t => {
  const h = await harness(t, async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  });
  const { agent } = await h.enter('max-tokens-child');
  const chunks = await h.run(agent, 1, 1) as StreamChunk[];
  assert.deepEqual(chunks, [{ type: 'finish', reason: { kind: 'max-tokens' } }]);
});

test('an opaque adapter failure after success cannot overwrite the completed terminal', async t => {
  const h = await harness(t, async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 3 } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: 'opaque adapter cleanup' } } };
  });
  const { agent } = await h.enter('opaque-tail-child');
  const chunks = await h.run(agent, 1, 1) as StreamChunk[];
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1);
  assert.equal(h.adapter.calls.length, 1);
});

test('an opaque failure without a prior success remains failed and never becomes a completed response', async t => {
  const h = await harness(t, async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: 'opaque adapter failure' } } };
  });
  const { agent } = await h.enter('opaque-failure-child');
  const chunks = await h.run(agent, 1, 1) as StreamChunk[];
  const finish = chunks.at(-1) as any;
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, 'UNCLASSIFIED_FAILURE');
  assert.match(finish.reason.failure.message, /NX_UNKNOWN_FAILURE/);
  assert.equal(h.adapter.calls.length, 1);
});
