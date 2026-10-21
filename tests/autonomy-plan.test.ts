import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { AutonomyPlanRecord, AutonomySettingsDraft } from '../src/client/AutonomyPlan.js';
import type { ClientContext, NexusApi, NexusScope, RpcOptions } from '../src/client/types.js';

type Fixture = typeof import('../src/client/AutonomyPlan.js');
// Bundle the real component through its CSS-as-text browser boundary.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/AutonomyPlan.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22',
  packages: 'external', loader: { '.css': 'text' }, logLevel: 'silent',
});
const fixtureModule: { exports: unknown } = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0]!.text)(
  createRequire(import.meta.url), fixtureModule, fixtureModule.exports,
);
const {
  AutonomyPlan, autonomyDraftErrors, autonomyAllowedActions, readAutonomyCache, sendAutonomyAction,
  autonomySettingsDraft, autonomySettingsConfig, autonomySettingSource, autonomyReason, registerAutonomyConversation,
} = fixtureModule.exports as Fixture;

function plan(patch: Partial<AutonomyPlanRecord> = {}): AutonomyPlanRecord {
  return {
    id: 'plan-one', sessionId: 'native-one', workspace: 'workspace-one', objective: '完成并核实用户要求',
    steps: [
      { id: 'inspect', title: '确认需求', description: '读取现有资料并确认约束', dependsOn: [], acceptance: ['约束有可引用的来源'] },
      { id: 'deliver', title: '交付结果', description: '完成需求并提供验证证据', dependsOn: ['inspect'], acceptance: ['结果满足确认后的要求'] },
    ],
    status: 'proposed', revision: 19, planRevision: 4, userEpoch: 2,
    approval: { actor: 'connection-owner', at: '2026-10-20T10:00:00Z', userEpoch: 2 },
    progress: { completed: 0, total: 2, rounds: 0, maxRounds: 12, stepStates: { inspect: 'pending', deliver: 'pending' } },
    evidence: [], source: 'model-inference', createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z',
    ...patch,
  };
}
const scope: NexusScope = { level: 'session', sessionId: 'native-one' };
function recordingApi() {
  const calls: Array<{ domain: string; action: string; params: unknown; options: RpcOptions }> = [];
  const api = { async call(domain: string, action: string, params: unknown, options: RpcOptions = {}) {
    calls.push({ domain, action, params, options });
    return action === 'settings' ? { automatic: true, maxCallsPerDay: 24 } : { status: 'empty', revision: 0 };
  } } as unknown as NexusApi;
  return { api, calls };
}

test('approval requires a valid objective, complete acceptance criteria, and an acyclic dependency graph', () => {
  const valid = plan();
  assert.deepEqual(autonomyDraftErrors(valid), []);
  const cyclic = plan({ steps: valid.steps.map(step => step.id === 'inspect' ? { ...step, dependsOn: ['deliver'] } : step) });
  assert.ok(autonomyDraftErrors(cyclic).includes('步骤依赖存在循环'));
  const missing = plan({ steps: [{ ...valid.steps[0], dependsOn: ['missing'] }] });
  assert.ok(autonomyDraftErrors(missing).some(message => message.includes('不存在的依赖')));
  assert.ok(autonomyDraftErrors({ objective: ' ', steps: [] }).includes('请填写完整目标'));
  assert.ok(autonomyDraftErrors(plan({ steps: [{ ...valid.steps[0], acceptance: [''] }] })).some(message => message.includes('验收条件')));
  assert.ok(autonomyDraftErrors(plan({ steps: [valid.steps[0], valid.steps[0]] })).some(message => message.includes('重复')));
  assert.ok(autonomyDraftErrors(plan({ objective: '长'.repeat(2401) })).some(message => message.includes('2400')));
  assert.ok(autonomyDraftErrors(plan({ steps: [{ ...valid.steps[0], acceptance: Array(7).fill('验收条件') }] })).some(message => message.includes('6 条')));
  assert.ok(autonomyDraftErrors(plan({ steps: [{ ...valid.steps[0], acceptance: ['长'.repeat(601)] }] })).some(message => message.includes('600')));
  assert.equal(autonomyAllowedActions(cyclic).includes('approve'), false);
});

test('only human approval of the current proposed content permits execution, and uncertain delivery cannot resume', () => {
  assert.deepEqual(autonomyAllowedActions(), ['propose']);
  assert.ok(autonomyAllowedActions(plan()).includes('approve'));
  assert.deepEqual(autonomyAllowedActions(plan({ status: 'running', approvedRevision: 4 })), ['pause']);
  assert.deepEqual(autonomyAllowedActions(plan({ status: 'approved', approvedRevision: 4 })), ['pause']);
  assert.ok(autonomyAllowedActions(plan({ status: 'paused', approvedRevision: 4 })).includes('resume'));
  assert.equal(autonomyAllowedActions(plan({ status: 'paused', approvedRevision: 3 })).includes('resume'), false);
  assert.equal(autonomyAllowedActions(plan({ status: 'needs-review', approvedRevision: 4 })).includes('resume'), false);
  assert.equal(autonomyAllowedActions(plan({ status: 'paused', approvedRevision: 4, userEpoch: 3 })).includes('resume'), false);
  assert.deepEqual(autonomyAllowedActions(plan({ status: 'needs-review', reconciliation: { state: 'delivery-unknown', canReplace: false } })), ['reject']);
  const unknown = plan({ status: 'needs-review', delivery: { requestId: 'native-request', stepId: 'inspect', state: 'unknown', startSeq: 4 }, reconciliation: { state: 'delivery-unknown', canReplace: false } });
  assert.deepEqual(autonomyAllowedActions(unknown), ['reconcile', 'reject']);
  assert.equal(autonomyAllowedActions(unknown).includes('resume'), false);
  const nativePending = plan({ status: 'paused', delivery: { requestId: 'native-request', stepId: 'inspect', state: 'sent', startSeq: 4, activationId: 'native-activation' },
    reconciliation: { state: 'awaiting-native-terminal', canReplace: false, activationId: 'native-activation' } });
  assert.ok(autonomyAllowedActions(nativePending).includes('edit'), 'a known activation may be checked against the formal terminal record');
  assert.equal(autonomyAllowedActions(plan({ status: 'rejected' })).includes('approve'), false);
});

test('human mutations use exact native session scope, row CAS revision and explicit request identity', async () => {
  const { api, calls } = recordingApi(), controller = new AbortController();
  await sendAutonomyAction(api, scope, plan(), 'approve', {}, 'approval-request', controller.signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].domain, 'autonomy');
  assert.equal(calls[0].action, 'approve');
  assert.deepEqual(calls[0].params, {});
  assert.equal(calls[0].options.revision, 19, 'CAS must use row revision, not content revision 4');
  assert.equal(calls[0].options.requestId, 'approval-request');
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.mutating, true);
  assert.deepEqual(calls[0].options.scope, scope);
  await assert.rejects(sendAutonomyAction(api, { level: 'global' }, plan(), 'approve', {}, 'global'), /原生会话/);
  await assert.rejects(sendAutonomyAction(api, { level: 'session', sessionId: 'other' }, plan(), 'approve', {}, 'other'), /原生会话/);
  await assert.rejects(sendAutonomyAction(api, scope, plan({ status: 'running' }), 'edit', plan(), 'edit-running'), /计划状态/);
  await assert.rejects(sendAutonomyAction(api, scope, plan(), 'edit', { objective: '', steps: [] }, 'invalid-edit'), /目标/);
  assert.equal(calls.length, 1, 'invalid actions must not reach the transport');
  await sendAutonomyAction(api, scope, plan({ status: 'needs-review', delivery: {
    requestId: 'native-request', stepId: 'inspect', state: 'unknown', startSeq: 4,
  } }), 'reconcile', {}, 'reconcile-request', controller.signal);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].action, 'reconcile');
  assert.equal(calls[1].options.revision, 19);
  assert.equal(calls[1].options.requestId, 'reconcile-request');
});

test('cached observations never invoke a planner or an execution command at any scope', async () => {
  const { api, calls } = recordingApi(), controller = new AbortController();
  for (const target of [scope, { level: 'workspace', workspaceId: 'workspace-one' }, { level: 'global' }] as NexusScope[]) {
    const result = await readAutonomyCache(api, target, controller.signal);
    assert.equal(result.settings.maxCallsPerDay, 24);
  }
  assert.deepEqual(calls.map(call => `${call.domain}.${call.action}`), [
    'autonomy.get', 'autonomy.settings', 'autonomy.list', 'autonomy.settings', 'autonomy.list', 'autonomy.settings',
  ]);
  assert.ok(calls.every(call => call.options.mutating !== true && call.options.signal === controller.signal));
  assert.equal(calls.some(call => ['propose', 'approve', 'resume'].includes(call.action)), false);
});

test('local settings preserve live parent inheritance without copying an effective provider or budget', () => {
  const settings = {
    provider: 'parent-provider', model: 'parent-model', maxCallsPerDay: 40,
    effective: { enabled: true, defaults: { automatic: true, provider: 'parent-provider', model: 'parent-model', maxCallsPerDay: 40 } },
    local: { revision: 0, config: {} },
  };
  const draft = autonomySettingsDraft(settings);
  assert.equal(draft.route, 'inherit');
  assert.equal(draft.provider, '');
  assert.equal(draft.model, '');
  assert.equal(draft.maxCallsPerDay, '');
  assert.deepEqual(autonomySettingsConfig(draft), { defaults: {} });
  const original = { enabled: false, defaults: { automatic: false, otherSetting: 'preserved', provider: 'old' } };
  const native = { ...draft, route: 'session', enabled: 'on', automatic: 'on', maxCallsPerDay: '24' } as AutonomySettingsDraft;
  assert.deepEqual(autonomySettingsConfig(native, original), {
    enabled: true, defaults: { otherSetting: 'preserved', provider: null, model: null, automatic: true, maxCallsPerDay: 24 },
  });
  assert.equal(original.defaults.provider, 'old', 'building an override must not mutate cached settings');
  assert.throws(() => autonomySettingsConfig({ ...draft, maxCallsPerDay: '0' }), /整数/);
  assert.throws(() => autonomySettingsConfig({ ...draft, maxOutputTokens: '1000.5' }), /整数/);
  assert.equal((autonomySettingsConfig({ ...draft, maxOutputTokens: '32768' }).defaults as any).maxOutputTokens, 32768);
  assert.throws(() => autonomySettingsConfig({ ...draft, maxOutputTokens: '65537' }), /整数/);
  assert.throws(() => autonomySettingsConfig({ ...draft, minIntervalMs: '59999' }), /整数/);
  assert.throws(() => autonomySettingsConfig({ ...draft, maxRounds: '13' }), /整数/);
  assert.throws(() => autonomySettingsConfig({ ...draft, route: 'custom' }), /模型代号/);
});

test('setting sources resolve the highest explicit layer and status reasons use Chinese display text', () => {
  const settings = { layers: [
    { scope: 'global', revision: 3, config: { defaults: { automatic: false, provider: 'global-provider' } } },
    { scope: 'workspace', revision: 7, config: { defaults: { automatic: true } } },
    { scope: 'session', revision: 0, config: {} },
  ] };
  assert.equal(autonomySettingSource(settings, 'automatic'), '工作区 · r7');
  assert.equal(autonomySettingSource(settings, 'provider'), '全局 · r3');
  assert.equal(autonomySettingSource(settings, 'maxCallsPerDay'), '默认');
  assert.equal(autonomyReason('delivery-unknown'), '原生消息投递状态待核实');
  assert.equal(autonomyReason('daily-budget-exhausted'), '今日模型调用预算已用尽');
  assert.equal(autonomyReason('delivery-not-sent'), '已确认上一条指令未投递，旧批准已失效，请重新批准');
  assert.equal(autonomyReason('delivery-reconciled'), '已找到原生执行记录，计划保持暂停，需用户恢复后再核验');
  assert.match(autonomyReason('not-yet-known-machine-state'), /需人工核实/);
  assert.equal(autonomyReason('当前步骤尚缺少用户给出的文件'), '当前步骤尚缺少用户给出的文件');
});

test('conversation registration preserves the original SessionProvider and does not retain or create a session', () => {
  let options: any, component: any, listener: (() => void) | undefined, generation = 1, removed = 0, unsubscribed = 0;
  const ctx = {
    connection: {
      rpc: { call() { throw new Error('registration must not dispatch a model or command'); } },
      generation: {
        getSnapshot: () => ({ id: generation }),
        subscribe(fn: () => void) { listener = fn; return () => { unsubscribed++; }; },
      },
    },
    slots: {
      inject(name: string, mount: () => () => void) { assert.equal(name, 'conversation.input.dock'); return mount(); },
      register(config: any, render: any) { options = config; component = render; return () => { removed++; }; },
    },
  } as unknown as ClientContext;
  const stop = registerAutonomyConversation(ctx);
  assert.equal(options.id, 'nexus.autonomy-plan');
  assert.equal(options.name, 'conversation.input.dock');
  assert.equal(options.children, undefined);
  const element = component({ sessionId: 'native-one', useSession: (select: (value: any) => any) => select({ sessionId: 'native-one' }) });
  assert.equal(element.type, AutonomyPlan);
  assert.equal(element.props.compact, true);
  assert.deepEqual(element.props.scope, scope);
  assert.equal(component({ sessionId: 'native-one', useSession: (select: (value: any) => any) => select({ sessionId: 'other' }) }), null);
  generation++; listener?.();
  assert.equal(element.props.api.getGeneration(), 1);
  stop(); stop();
  assert.equal(removed, 1);
  assert.equal(unsubscribed, 1);
});
