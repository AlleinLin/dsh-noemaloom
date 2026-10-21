import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createScopeModule, effectiveSettings } from '../src/domain/scope.js';
import { registerStepPauseHook, STEP_PAUSE_READ_TIMEOUT_MS } from '../src/host/step-pause-hook.js';
import { registerInsightsHook } from '../src/host/insights-hook.js';
import { registerAutonomyHook } from '../src/host/autonomy-hook.js';
import { registerCompanionHook } from '../src/host/companion-hook.js';
import { OperationController } from '../src/host/lifecycle.js';
import { conversationSurface } from '../src/domain/insights/conversation.js';
import { analysisSurface } from '../src/domain/insights/surface.js';
import { STEP_PAUSE_FEATURE, STEP_PAUSE_DEFAULT_PROMPT, isStepProgressMessage, resolveStepPauseOptions } from '../src/shared/step-pause.js';
import type { HostContext } from '../src/host/types.js';
import type { DispatchContext } from '../src/ports/contracts.js';
import { deferred, flush, stepProgressServices } from './step-progress-fixture.js';

function fixture(t: TestContext) {
  const f = stepProgressServices(), handlers = new Map<string, Set<(...args: any[]) => any>>();
  const agents = new Map<string, any>(), roots = new Set<any>(), warnings: string[] = [];
  const registry = { get: (id: string) => agents.get(id), roots: () => [...roots] };
  const ctx = {
    get: (name: string) => name === 'agents' ? registry : undefined,
    on(name: string, callback: (...args: any[]) => any) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(callback); return () => handlers.get(name)?.delete(callback);
    }, logger: { warn(_message: string, code: string) { warnings.push(code); } },
  } as unknown as HostContext;
  const stop = registerStepPauseHook(ctx, f.services); t.after(stop);
  const scopeModule = createScopeModule(f.services);
  const authority = (level: 'global' | 'workspace' | 'session', root = f.services.workspaceRoot, sessionId?: string): DispatchContext =>
    ({ scopeLevel: level, workspaceRoot: root, sessionId, actorId: 'connection-owner', permissions: new Set(['scope.configure', 'scope.reset']) });
  const configure = (config: any, context = authority('global'), revision = 0) => scopeModule.dispatch({
    action: 'configure', expectedRevision: revision, params: { feature: STEP_PAUSE_FEATURE, config },
  }, context);
  const agent = (id: string, root = f.services.workspaceRoot, child = false, header: any = {}) => {
    const value = { id, session: { id, header: { cwd: root, ...header }, firstLiveSeq: 1 },
      cancel() { assert.fail('progress must not cancel the native driver'); },
      followup() { assert.fail('progress must not enqueue a new turn'); },
      steer() { assert.fail('progress must not replay a step'); } };
    agents.set(id, value); if (!child) roots.add(value); return value;
  };
  const propose = (agent: any, turn = 1, step = 10, decision: any = { kind: 'enter', messages: [] }, signal = new AbortController().signal) =>
    [...handlers.get('agent/pre-step')!][0]({ agent, turn, step, signal }, async () => decision);
  const emit = (name: string, ...args: any[]) => { for (const handler of handlers.get(name) ?? []) handler(...args); };
  return { ...f, handlers, agents, roots, ctx, stop, configure, authority, scopeModule, agent, propose, emit, warnings };
}
const notices = (decision: any) => decision.messages.filter(isStepProgressMessage);

test('real scope overlays apply live per field, isolate workspace/session siblings, and reset restores inheritance', async t => {
  const f = fixture(t), rootA = join(process.cwd(), 'a'), rootB = join(process.cwd(), 'b');
  const a = f.agent('a1', rootA), sibling = f.agent('a2', rootA), b = f.agent('b1', rootB);
  await f.configure({ defaults: { everyNSteps: 4, maxReportsPerTurn: 2 } });
  await f.configure({ defaults: { everyNSteps: 2 } }, f.authority('workspace', rootA));
  await f.configure({ enabled: false }, f.authority('session', rootA, a.id));
  assert.equal(notices(await f.propose(a, 1, 2)).length, 0);
  assert.equal(notices(await f.propose(sibling, 1, 2)).length, 1);
  assert.equal(notices(await f.propose(b, 1, 2)).length, 0);
  assert.equal(notices(await f.propose(b, 1, 4)).length, 1);
  await f.scopeModule.dispatch({ action: 'reset', expectedRevision: 1, params: { feature: STEP_PAUSE_FEATURE } }, f.authority('session', rootA, a.id));
  assert.equal(notices(await f.propose(a, 1, 2)).length, 1);
  await f.configure({ defaults: { everyNSteps: 6 } }, f.authority('workspace', rootA), 1);
  assert.equal(notices(await f.propose(a, 1, 4)).length, 0);
  assert.equal(notices(await f.propose(a, 1, 6)).length, 1);
  const result = await effectiveSettings(f.store, rootA, f.authority('session', rootA, a.id), STEP_PAUSE_FEATURE);
  assert.equal(resolveStepPauseOptions(result.effective).maxReportsPerTurn, 2);
  assert.deepEqual(result.local.config, {});
});

test('only owner UI can alter progress policy and invalid overrides never persist', async t => {
  const f = fixture(t);
  for (const actorId of ['native-tool', 'nexus-autonomy-hook', 'remote:owner']) {
    for (const action of ['configure', 'reset']) await assert.rejects(f.scopeModule.dispatch({
      action, expectedRevision: 0, params: { feature: STEP_PAUSE_FEATURE, config: { enabled: false } },
    }, { ...f.authority('global'), actorId }), { code: 'PERMISSION_DENIED' });
  }
  for (const defaults of [{ everyNSteps: 0 }, { everyNSteps: 1.5 }, { maxReportsPerTurn: -1 },
    { prompt: '' }, { prompt: 'x'.repeat(8001) }, { showPromptInChat: 'true' }, { pause: true }]) {
    await assert.rejects(f.configure({ defaults }), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal((await effectiveSettings(f.store, process.cwd(), f.authority('global'), STEP_PAUSE_FEATURE)).local.revision, 0);
});

test('pre-step appends after native admission once, preserves decisions, resets turn budgets, and never changes the stable prefix', async t => {
  const f = fixture(t), agent = f.agent('main');
  await f.configure({ defaults: { everyNSteps: 1, maxReportsPerTurn: 2, prompt: 'Progress {{ step }}/{{every}} turn {{turn}}' } });
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Original user task' }] });
  const accepted = { kind: 'enter', messages: [message], startsRequestSeries: true, original: 'retained' };
  assert.equal(await f.propose(agent, 1, 1, accepted), accepted);
  const decorated = await f.propose(agent, 1, 2, accepted);
  assert.equal(decorated.messages[0], message); assert.equal(accepted.messages.length, 1);
  assert.equal(decorated.startsRequestSeries, true); assert.equal(decorated.original, 'retained');
  assert.equal(notices(decorated)[0].content[0].text, 'Progress 2/1 turn 1');
  assert.equal(notices(await f.propose(agent, 1, 2, accepted)).length, 0);
  assert.equal(notices(await f.propose(agent, 1, 3, accepted)).length, 1);
  assert.equal(notices(await f.propose(agent, 1, 4, accepted)).length, 0);
  assert.equal(notices(await f.propose(agent, 1, 2, accepted)).length, 0);
  assert.equal(notices(await f.propose(agent, 2, 2, accepted)).length, 1);
  assert.equal(notices(await f.propose(agent, 1, 9, accepted)).length, 0);
  assert.match(STEP_PAUSE_DEFAULT_PROMPT, /原任务.*输出格式/);
  assert.match(STEP_PAUSE_DEFAULT_PROMPT, /若格式不允许进度正文/);
});

test('unknown identities, real children and missing cwd skip; independent roots and fork lineage are not confused', async t => {
  const f = fixture(t), main = f.agent('main'), child = f.agent('child', undefined, true);
  const headerChild = f.agent('header-child', undefined, false, { origin: 'subagent' });
  const fork = f.agent('fork', undefined, false, { parentSession: 'main', delegationDepth: 0, isSeeded: true });
  for (const agent of [child, headerChild, { id: 'main', session: main.session }, f.agent('no-cwd', 'relative-root')]) {
    assert.equal(notices(await f.propose(agent)).length, 0);
  }
  assert.equal(notices(await f.propose(main)).length, 1);
  assert.equal(notices(await f.propose(fork)).length, 1);
  await f.configure({ defaults: { mainAgentOnly: false } }, undefined, 0);
  assert.equal(notices(await f.propose(child)).length, 1);
  assert.equal(notices(await f.propose(main)).length, 0, 'the child did not reset the main agent deduplication');
});

test('reject, native exceptions and native cancellation pass unchanged; unload/replacement cannot decorate an in-flight step', async t => {
  const f = fixture(t), agent = f.agent('main'), reject = { kind: 'reject', reason: 'native-approval' };
  assert.equal(await f.propose(agent, 1, 10, reject), reject);
  const listener = [...f.handlers.get('agent/pre-step')!][0], failure = new Error('native admission failed');
  let calls = 0;
  await assert.rejects(listener({ agent, turn: 1, step: 10 }, async () => { calls++; throw failure; }), error => error === failure);
  assert.equal(calls, 1);
  const cancelled = new AbortController(); cancelled.abort();
  const accepted = { kind: 'enter', messages: [] };
  assert.equal(await f.propose(agent, 1, 10, accepted, cancelled.signal), accepted);
  const waiting = deferred<any>();
  const pending = listener({ agent, turn: 1, step: 10, signal: new AbortController().signal }, () => waiting.promise);
  f.stop(); waiting.resolve(accepted);
  assert.equal(await pending, accepted);
});

test('settings failures and deadlines cannot terminate native work, and cancelled/disposed reads cannot inject late', async t => {
  const f = fixture(t), agent = f.agent('main'), accepted = { kind: 'enter', messages: [] };
  f.store.get = async () => { throw new Error('synthetic read failure with secret text'); };
  assert.equal(await f.propose(agent, 1, 10, accepted), accepted);
  assert.deepEqual(f.warnings, ['STEP_PROGRESS_DECORATION_FAILED']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred<any>(); f.store.get = () => pending.promise;
  const timed = f.propose(agent, 1, 10, accepted); await flush();
  t.mock.timers.tick(STEP_PAUSE_READ_TIMEOUT_MS); await flush();
  assert.equal(await timed, accepted); assert.equal(f.warnings.at(-1), 'STEP_PROGRESS_SETTINGS_TIMEOUT');
  const cancel = new AbortController(), cancelled = f.propose(agent, 1, 10, accepted, cancel.signal);
  await flush(); cancel.abort(); assert.equal(await cancelled, accepted);
  const disposed = f.propose(agent, 1, 10, accepted); await flush();
  f.emit('agent/disposed', { agent }); pending.resolve(undefined);
  assert.equal(await disposed, accepted);
});

test('visible progress is still synthetic for actual insight/autonomy/companion hooks and latest human objective', async t => {
  const f = fixture(t), agent = f.agent('main');
  await f.configure({ defaults: { showPromptInChat: true } });
  const notice = notices(await f.propose(agent))[0]; assert.equal(notice.source.kind, 'user');
  const calls: Array<{ domain: string; action: string }> = [], controller = new OperationController();
  f.services.invoke = async (domain, request) => { calls.push({ domain, action: request.action }); return {}; };
  const stops = [registerInsightsHook(f.ctx, f.services, controller), registerAutonomyHook(f.ctx, f.services, controller),
    registerCompanionHook(f.ctx, f.services, controller)];
  t.after(async () => { for (const stop of stops) stop(); await controller.dispose(); });
  t.mock.timers.enable({ apis: ['setTimeout'] }); await flush(); calls.length = 0;
  f.emit('agent/inbox/inserted', { agent, message: notice });
  f.emit('session/event', agent.session, { type: 'user/message', seq: 2, data: notice });
  t.mock.timers.tick(10_000); await flush(); assert.equal(calls.length, 0);
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep the original JSON format.' }] });
  const events = [{ type: 'user/message', seq: 1, data: human }, { type: 'user/message', seq: 2, data: notice }];
  const surface = (entries: any[]) => conversationSurface('main', [{ sessionId: 'main', status: 'running', events: entries }], [], 100000, 20000, 10);
  assert.equal(surface(events).taskKey, surface(events.slice(0, 1)).taskKey);
  assert.equal(analysisSurface('main', events, 'running').lines.length, 1);
  f.emit('agent/inbox/inserted', { agent, message: human });
  f.emit('session/event', agent.session, events[0]);
  await flush(); assert.ok(calls.some(call => call.action === 'invalidate'));
  assert.ok(calls.some(call => call.domain === 'autonomy' && call.action === 'on-event'));
});
