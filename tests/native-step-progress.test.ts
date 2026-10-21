import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { LlmAdapter, LlmRuntime, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime, defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import { createScopeModule } from '../src/domain/scope.js';
import { registerStepPauseHook } from '../src/host/step-pause-hook.js';
import { STEP_PAUSE_FEATURE, isStepProgressMessage } from '../src/shared/step-pause.js';
import type { HostContext } from '../src/host/types.js';
import { deferred, stepProgressServices } from './step-progress-fixture.js';

const route = { provider: 'native-step-progress-fixture', model: 'local-only', maxTokens: 64 };
const toolName = 'fixture_progress_work';
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native progress fixture timed out')), 5000); })]); }
  finally { clearTimeout(timer); }
}

async function fixture(t: TestContext, options: { holdTool?: boolean; retrySecondStep?: boolean; failRead?: boolean } = {}) {
  const root = new Context(), f = stepProgressServices(), scope = createScopeModule(f.services);
  await scope.dispatch({ action: 'configure', params: { feature: STEP_PAUSE_FEATURE, config: { defaults: { everyNSteps: 2 } } }, expectedRevision: 0 },
    { scopeLevel: 'global', actorId: 'connection-owner', permissions: new Set(['scope.configure']) });
  if (options.failRead) f.store.get = async () => { throw new Error('Local fixture settings unavailable'); };
  const enteredTool = deferred(), releaseTool = deferred(), calls: GenerateOptions[] = [];
  const attempts = new Map<string, number>(), toolRuns = new Map<string, number>(), recovery: any[] = [], warnings: string[] = [];
  const fibers: any[] = [], handles: AgentHandle[] = [];
  let ctx!: Context, stop = () => {};
  class Adapter extends LlmAdapter {
    async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
      calls.push(request);
      const id = String(request.sessionId), attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      if (options.retrySecondStep && attempt === 2) throw new Error('Local transient response failure');
      const logicalStep = options.retrySecondStep && attempt > 2 ? attempt - 1 : attempt;
      if (logicalStep <= 2) {
        const callId = ToolCallId(`${id}-work-${logicalStep}`);
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id: callId, name: toolName, argumentsDelta: '{}' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: toolName, arguments: '{}' } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'Finished local fixture.' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Finished local fixture.' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  const provider = root.plugin({ name: 'native-progress-services', apply(owner: Context) {
    new AgentRegistry(owner); new SessionStore(owner); new SessionProjectionRegistry(owner);
    new SystemPrompt(owner, { includeHarnessIdentity: false });
    const llm = new LlmRuntime(owner); llm.registerAdapter([route.provider], new Adapter());
  } });
  fibers.push(provider); await provider.await(); assert.equal(provider.state, 2);
  const tools = root.plugin({ name: 'native-progress-tools', inject: ['systemPrompt'], apply(owner: Context) {
    const runtime = new ToolRuntime(owner);
    runtime.register(defineContentToolFixture({ name: toolName, description: 'Local progress regression work.', parameters: {},
      async execute(_args, exec) {
        assert.ok(exec.agent, 'native tool execution belongs to a live agent');
        const id = String(exec.agent.id), count = (toolRuns.get(id) ?? 0) + 1; toolRuns.set(id, count);
        if (options.holdTool && count === 1) { enteredTool.resolve(); await releaseTool.promise; }
        return [{ type: 'text', text: 'Work completed once.' }];
      } }));
  } });
  fibers.push(tools); await tools.await(); assert.equal(tools.state, 2);
  const driver = root.plugin({ name: 'native-progress-driver', inject: ['agents', 'sessions', 'sessionProjections', 'llm', 'tools', 'systemPrompt'],
    apply(owner: Context) {
      ctx = owner; new AgentLoop(owner, AgentLoop.Config({ agents: [], maxParallelToolCalls: 1 }));
      stop = registerStepPauseHook({ get: (name: string) => owner.get(name as any), on: (...args: any[]) => (owner.on as any)(...args),
        logger: { warn(_message: string, code: string) { warnings.push(code); } } } as unknown as HostContext, f.services);
      owner.on('agent/request-error', async (payload, next) => {
        recovery.push(payload); if (options.retrySecondStep && recovery.length === 1) return { kind: 'retry' };
        return next();
      });
    } });
  fibers.push(driver); await driver.await(); assert.equal(driver.state, 2);
  t.after(async () => {
    releaseTool.resolve(); stop();
    for (const handle of handles.reverse()) await handle.dispose();
    for (const fiber of fibers.reverse()) await fiber.dispose();
  });
  async function create(id: string, parentAgent?: Agent) {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), parentAgent,
      meta: { cwd: process.cwd(), ...(parentAgent ? { origin: 'subagent' as const, delegationDepth: 1 } : {}) }, agentOptions: route });
    handles.push(handle); return handle.agent;
  }
  const start = (agent: Agent) => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Complete the local work.' }] }));
    return within(agent.whenIdle());
  };
  return { create, start, enteredTool: enteredTool.promise, releaseTool, calls, toolRuns, stop, warnings, recovery };
}
const progressEvents = (agent: Agent) => agent.session.snapshotEvents().filter(event => event.type === 'user/message' && isStepProgressMessage(event.data));
const turnReasons = (agent: Agent) => agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => (event.data as any).reason?.kind);

test('the installed native loop reports at the next step only, commits once, and completes without an extra request or replayed tool', async t => {
  const f = await fixture(t, { holdTool: true }), main = await f.create('native-progress-main');
  const running = f.start(main);
  try {
    await within(f.enteredTool);
    assert.equal(f.calls.length, 1); assert.equal(progressEvents(main).length, 0, 'long tools are never interrupted for progress');
    f.releaseTool.resolve(); await running;
    assert.equal(f.calls.length, 3); assert.equal(f.toolRuns.get(main.id), 2);
    const events = progressEvents(main); assert.equal(events.length, 1);
    const notice = events[0].data as any;
    assert.equal(notice.source.meta.turn, 1); assert.equal(notice.source.meta.step, 2);
    assert.equal(notice.source.kind, 'plugin:@local/dsh-nexus');
    assert.equal(f.calls[1].messages.filter(isStepProgressMessage).length, 1);
    assert.deepEqual(f.calls[1].messages.slice(0, f.calls[0].messages.length), f.calls[0].messages, 'the original request prefix remains unchanged');
    assert.deepEqual(turnReasons(main), ['completed']); assert.equal(f.recovery.length, 0);
    const committed = main.session.seq; await main.whenIdle(); assert.equal(main.session.seq, committed);
  } finally { f.releaseTool.resolve(); await running; }
});

test('formal request recovery retries the same step with the same single notice and never reexecutes a settled tool', async t => {
  const f = await fixture(t, { retrySecondStep: true }), main = await f.create('native-progress-recovery');
  await f.start(main);
  assert.equal(f.calls.length, 4); assert.equal(f.recovery.length, 1);
  assert.equal(progressEvents(main).length, 1); assert.equal(f.toolRuns.get(main.id), 2);
  const failedNotice = f.calls[1].messages.find(isStepProgressMessage), retryNotice = f.calls[2].messages.find(isStepProgressMessage);
  assert.ok(failedNotice); assert.equal(retryNotice?.id, failedNotice.id);
  assert.deepEqual(turnReasons(main), ['completed']);
});

test('simultaneous native roots retain independent counters while a real child never receives a main-only notice', async t => {
  const f = await fixture(t), main = await f.create('native-progress-root-a'), other = await f.create('native-progress-root-b');
  const child = await f.create('native-progress-child', main);
  await Promise.all([f.start(main), f.start(other), f.start(child)]);
  assert.equal(progressEvents(main).length, 1); assert.equal(progressEvents(other).length, 1); assert.equal(progressEvents(child).length, 0);
  for (const agent of [main, other, child]) {
    assert.equal(f.toolRuns.get(agent.id), 2); assert.deepEqual(turnReasons(agent), ['completed']);
  }
  assert.equal(f.calls.length, 9);
});

for (const mode of ['read-failure', 'unload'] as const) test(`native flow completes when optional progress has ${mode}`, async t => {
  const f = await fixture(t, { holdTool: true, failRead: mode === 'read-failure' }), main = await f.create(`native-progress-${mode}`);
  const running = f.start(main);
  try {
    await within(f.enteredTool); if (mode === 'unload') f.stop();
    f.releaseTool.resolve(); await running;
    assert.equal(progressEvents(main).length, 0); assert.equal(f.calls.length, 3);
    assert.equal(f.toolRuns.get(main.id), 2); assert.deepEqual(turnReasons(main), ['completed']);
    if (mode === 'read-failure') assert.ok(f.warnings.includes('STEP_PROGRESS_DECORATION_FAILED'));
  } finally { f.releaseTool.resolve(); await running; }
});
