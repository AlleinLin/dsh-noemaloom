import * as React from 'react';
import { AuxiliarySettings } from './AuxiliarySettings.js';
import { createNexusApi, errorData } from './transport.js';
import type { ClientContext, Data, NexusApi, NexusScope } from './types.js';
import styles from './autonomy-plan.css';

export interface AutonomyStep {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  acceptance: string[];
}
export interface AutonomyEvidence {
  stepId: string;
  activationId: string;
  turnEndSeq?: number;
  evidenceRefs: number[];
  verdict: 'completed' | 'incomplete' | 'unknown';
  inference: true;
  at: string;
}
export interface AutonomyPlanRecord {
  id: string;
  sessionId: string;
  workspace: string;
  objective: string;
  steps: AutonomyStep[];
  status: 'proposed' | 'approved' | 'running' | 'paused' | 'rejected' | 'completed' | 'needs-review';
  revision: number;
  planRevision: number;
  approvedRevision?: number;
  currentStep?: string;
  progress: { completed: number; total: number; rounds: number; maxRounds: number; stepStates: Record<string, string> };
  evidence: AutonomyEvidence[];
  reason?: string;
  userEpoch?: number;
  approval?: { actor: 'connection-owner'; at: string; userEpoch: number };
  delivery?: { requestId: string; stepId: string; state: 'intent' | 'sent' | 'unknown'; startSeq: number; activationId?: string; terminal?: 'succeeded' };
  monitor?: { state: 'idle' | 'started' | 'ready' | 'failed' | 'unknown'; kind?: 'plan' | 'verify'; errorCode?: string };
  budget?: AutonomyBudget;
  reconciliation?: { state: 'none' | 'awaiting-native-terminal' | 'delivery-unknown'; canReplace: boolean; canReconcile?: boolean; activationId?: string };
  source: 'model-inference' | 'user-edited';
  createdAt: string;
  updatedAt: string;
}
interface AutonomyBudget { day: string; callsToday: number; maxCallsPerDay: number; remainingCalls: number; nextCallAt: number | string; cooldownMs: number }
export type AutonomyAction = 'propose' | 'edit' | 'approve' | 'reject' | 'pause' | 'resume' | 'reconcile';
export interface AutonomyDraft { objective: string; steps: AutonomyStep[] }
interface Cache { key: string; value: Data; settings: Data }
type Inheritance = 'inherit' | 'on' | 'off';
export interface AutonomySettingsDraft {
  enabled: Inheritance;
  automatic: Inheritance;
  route: 'inherit' | 'session' | 'custom';
  provider: string;
  model: string;
  maxCallsPerDay: string;
  minIntervalMs: string;
  maxOutputTokens: string;
  maxRounds: string;
}
const statusLabels: Record<string, string> = {
  empty: '等待提案', proposed: '待批准', approved: '已批准 · 等待原生会话', running: '执行中',
  paused: '已暂停', rejected: '已拒绝', completed: '已完成', 'needs-review': '需人工核实',
};
const stepLabels: Record<string, string> = { pending: '待执行', running: '原生会话执行中', completed: '已完成' };
const verdictLabels = { completed: '已完成', incomplete: '未完成', unknown: '无法判断' };
const scopeLabels: Record<string, string> = { global: '全局', workspace: '工作区', session: '会话' };
const configNumbers = [
  ['maxCallsPerDay', '每会话每日模型调用上限', 1, 100],
  ['maxOutputTokens', '单次模型输出预算（含思考 token）', 512, 65536],
  ['minIntervalMs', '自动观察间隔（毫秒）', 60000, 3600000],
  ['maxRounds', '计划执行轮数上限', 1, 12],
] as const;
const own = (value: Data, key: string) => Object.hasOwn(value, key);
const scopeIdentity = (scope: NexusScope) => JSON.stringify([scope.level, scope.workspaceId, scope.sessionId]);
let requestSequence = 0;
const requestId = () => `nexus-autonomy-${Date.now().toString(36)}-${++requestSequence}`;
export function autonomyReason(reason?: string): string {
  if (!reason) return '';
  const labels: Record<string, string> = {
    'budget-exhausted': '今日模型调用预算已用尽', 'daily-budget-exhausted': '今日模型调用预算已用尽',
    'cooldown': '等待自动观察间隔', 'rate-limited': '等待自动观察间隔',
    'max-rounds': '已达到计划执行轮数上限', 'round-limit': '已达到计划执行轮数上限',
    'max-rounds-reached': '已达到计划执行轮数上限', 'round-limit-reached': '已达到计划执行轮数上限',
    'awaiting-approval': '等待用户批准', 'awaiting-native-idle': '等待原生会话空闲',
    'native-busy': '原生会话正在执行', 'inbox-not-empty': '等待原生会话处理已有消息',
    'user-paused': '用户已暂停', 'manual-pause': '用户已暂停', 'user-rejected': '用户已拒绝',
    'plan-edited': '计划已编辑，需要重新批准', 'approval-invalidated': '内容已变更，需要重新批准',
    'unknown-delivery': '原生消息投递状态待核实', 'delivery-unknown': '原生消息投递状态待核实',
    'restart': '重启后的原生执行状态待核实', 'restart-recovery': '重启后的原生执行状态待核实',
    'execution-unknown': '原生执行状态待核实', 'acceptance-unknown': '验收结果待核实',
    'step-incomplete': '当前步骤尚未满足验收条件', 'step-completed': '当前步骤已通过模型验收推断',
    'all-steps-completed': '全部步骤已通过模型验收推断', 'completed': '全部步骤已通过模型验收推断',
    'disabled': '此范围已停用自动计划', 'automatic-disabled': '此范围已关闭自动提案',
    'daily-budget': '今日模型调用预算已用尽', 'execution-budget': '已达到计划执行轮数上限',
    'monitor-disabled': '此范围已关闭自动提案', 'active-native-operation': '原生会话尚未结束当前操作，计划暂不能替换',
    'proposal-failed': '提案未完成，请显式重新提案', 'invalid-proposal': '模型提案格式不完整，请重新提案',
    'verification-failed': '步骤核验未完成，需用户处理', 'acceptance-unproven': '现有证据不足以确认验收通过',
    'dependency-unproven': '尚无满足依赖条件的可执行步骤', 'native-stopped': '原生会话已停止，等待用户处理',
    'native-status-unverified': '原生会话状态尚未核实', 'feature-disabled': '此范围已停用自动计划',
    'delivery-state-changed': '原生会话的执行记录已变化，请重新核实', 'activation-identity-unverified': '无法确认执行记录属于当前原生会话',
    'activation-evidence-missing': '原生回合缺少完整的结束记录', 'completion-evidence-missing': '缺少可用于验收的正式完成证据',
    'host-restarted': '宿主已重启，请核查原生会话后重新批准', 'new-user-input': '收到新用户输入，现有批准已失效',
    'owner-paused': '用户已暂停后续计划', 'owner-rejected': '用户已拒绝计划',
    'delivery-not-sent': '已确认上一条指令未投递，旧批准已失效，请重新批准',
    'not-sent': '已确认上一条指令未投递，旧批准已失效，请重新批准',
    'delivery-reconciled': '已找到原生执行记录，计划保持暂停，需用户恢复后再核验',
  };
  return Object.hasOwn(labels, reason) ? labels[reason] : /^[A-Za-z0-9_:/.-]+$/.test(reason) ? `计划状态需人工核实（${reason}）` : reason;
}

export function autonomySettingSource(settings: Data, field: string): string {
  const layers: Data[] = Array.isArray(settings.layers) ? settings.layers : [];
  for (let index = layers.length - 1; index >= 0; index--) {
    const config = layers[index].config ?? {};
    if (own(field === 'enabled' ? config : config.defaults ?? {}, field)) {
      return `${scopeLabels[layers[index].scope] ?? '当前层'} · r${layers[index].revision ?? 0}`;
    }
  }
  return '默认';
}

/** Validate the user's actual dependency graph before allowing a new approval. */
export function autonomyDraftErrors(draft: AutonomyDraft): string[] {
  const errors: string[] = [];
  if (!draft.objective.trim()) errors.push('请填写完整目标');
  if (draft.objective.length > 2400) errors.push('目标不能超过 2400 字');
  if (!draft.steps.length) errors.push('请至少添加一个步骤');
  if (draft.steps.length > 12) errors.push('一个计划最多包含 12 个步骤');
  const ids = new Set<string>();
  for (const [index, step] of draft.steps.entries()) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(step.id)) errors.push(`步骤 ${index + 1} 的标识无效`);
    if (ids.has(step.id)) errors.push(`步骤标识 ${step.id} 重复`);
    ids.add(step.id);
    if (!step.title.trim()) errors.push(`步骤 ${index + 1} 缺少标题`);
    if (step.title.length > 160) errors.push(`步骤 ${index + 1} 的标题不能超过 160 字`);
    if (!step.description.trim()) errors.push(`步骤 ${index + 1} 缺少执行说明`);
    if (step.description.length > 1200) errors.push(`步骤 ${index + 1} 的执行说明不能超过 1200 字`);
    if (!step.acceptance.length || step.acceptance.some(item => !item.trim())) errors.push(`步骤 ${index + 1} 需要验收条件`);
    if (step.acceptance.length > 6) errors.push(`步骤 ${index + 1} 最多包含 6 条验收条件`);
    if (step.acceptance.some(item => item.length > 600)) errors.push(`步骤 ${index + 1} 的每条验收条件不能超过 600 字`);
    if (new Set(step.dependsOn).size !== step.dependsOn.length) errors.push(`步骤 ${index + 1} 的依赖重复`);
  }
  for (const [index, step] of draft.steps.entries()) {
    if (step.dependsOn.some(id => !ids.has(id))) errors.push(`步骤 ${index + 1} 引用了不存在的依赖`);
  }
  const byId = new Map(draft.steps.map(step => [step.id, step]));
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cycle = byId.get(id)?.dependsOn.some(dependency => visit(dependency)) ?? false;
    visiting.delete(id); visited.add(id);
    return cycle;
  }
  if (draft.steps.some(step => visit(step.id))) errors.push('步骤依赖存在循环');
  return [...new Set(errors)];
}

export function autonomyAllowedActions(plan?: AutonomyPlanRecord): AutonomyAction[] {
  if (!plan) return ['propose'];
  const reconcile: AutonomyAction[] = plan.reconciliation?.canReconcile || ['intent', 'unknown'].includes(plan.delivery?.state ?? '') ? ['reconcile'] : [];
  if (plan.status === 'approved' || plan.status === 'running' || plan.monitor?.state === 'started') return ['pause', ...reconcile];
  if (plan.delivery && !plan.delivery.activationId || plan.reconciliation?.state === 'delivery-unknown' && !plan.reconciliation.activationId && !plan.delivery?.activationId) return [...reconcile, 'reject'];
  const actions: AutonomyAction[] = ['propose', 'edit', ...reconcile];
  if (plan.status === 'proposed' && !autonomyDraftErrors(plan).length) actions.push('approve');
  if (['proposed', 'paused', 'needs-review'].includes(plan.status)) actions.push('reject');
  if (plan.status === 'paused' && plan.approvedRevision === plan.planRevision && plan.approval?.userEpoch === plan.userEpoch
    && plan.approval && !['unknown', 'intent'].includes(plan.delivery?.state ?? '')) actions.push('resume');
  return actions;
}

/** Rendering and polling use this cached, read-only boundary exclusively. */
export async function readAutonomyCache(api: NexusApi, scope: NexusScope, signal?: AbortSignal) {
  const [value, settings] = await Promise.all([
    api.call('autonomy', scope.level === 'session' ? 'get' : 'list', {}, { scope, signal }),
    api.call('autonomy', 'settings', {}, { scope, signal }),
  ]);
  return { value, settings };
}

/** Each human action carries the exact observed row revision; mutations never retry. */
export async function sendAutonomyAction(
  api: NexusApi, scope: NexusScope, plan: AutonomyPlanRecord | undefined, action: AutonomyAction,
  params: Data, id: string, signal?: AbortSignal,
) {
  if (scope.level !== 'session' || !scope.sessionId || plan && plan.sessionId !== scope.sessionId) throw new Error('请选择计划所属的原生会话');
  if (!autonomyAllowedActions(plan).includes(action)) throw new Error('计划状态已变更，请刷新后操作');
  if (action === 'edit') {
    const errors = autonomyDraftErrors(params as AutonomyDraft);
    if (errors.length) throw new Error(errors.join('；'));
  }
  return api.call('autonomy', action, params, {
    scope, mutating: true, revision: plan?.revision ?? 0, requestId: id, signal,
  });
}

export function autonomySettingsDraft(settings: Data): AutonomySettingsDraft {
  const config = settings.local?.config ?? {}, defaults = config.defaults ?? {};
  const tri = (item: Data, key: string): Inheritance => !own(item, key) ? 'inherit' : item[key] === false ? 'off' : 'on';
  const route = !own(defaults, 'provider') && !own(defaults, 'model') ? 'inherit'
    : typeof defaults.provider === 'string' || typeof defaults.model === 'string' ? 'custom' : 'session';
  return {
    enabled: tri(config, 'enabled'), automatic: tri(defaults, 'automatic'), route,
    provider: typeof defaults.provider === 'string' ? defaults.provider : '',
    model: typeof defaults.model === 'string' ? defaults.model : '',
    maxCallsPerDay: own(defaults, 'maxCallsPerDay') ? String(defaults.maxCallsPerDay) : '',
    minIntervalMs: own(defaults, 'minIntervalMs') ? String(defaults.minIntervalMs) : '',
    maxOutputTokens: own(defaults, 'maxOutputTokens') ? String(defaults.maxOutputTokens) : '',
    maxRounds: own(defaults, 'maxRounds') ? String(defaults.maxRounds) : '',
  };
}

/** Omitted settings keep live parent inheritance; native routing is an explicit null. */
export function autonomySettingsConfig(draft: AutonomySettingsDraft, local: Data = {}): Data {
  const config: Data = { ...local, defaults: { ...(local.defaults ?? {}) } }, defaults = config.defaults;
  delete config.enabled;
  if (draft.enabled !== 'inherit') config.enabled = draft.enabled === 'on';
  for (const key of ['automatic', 'provider', 'model', ...configNumbers.map(field => field[0])]) delete defaults[key];
  if (draft.automatic !== 'inherit') defaults.automatic = draft.automatic === 'on';
  if (draft.route !== 'inherit') {
    if (draft.provider.length > 160 || draft.model.length > 160) throw new Error('提供方和模型代号不能超过 160 字');
    defaults.provider = draft.route === 'custom' ? draft.provider.trim() || null : null;
    defaults.model = draft.route === 'custom' ? draft.model.trim() || null : null;
    if (draft.route === 'custom' && !draft.provider.trim() && !draft.model.trim()) throw new Error('请填写提供方或模型代号');
  }
  for (const [key, label, min, max] of configNumbers) {
    if (!draft[key].trim()) continue;
    const value = Number(draft[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}应为 ${min}–${max} 的整数`);
    defaults[key] = value;
  }
  return config;
}

function Evidence({ items }: { items: AutonomyEvidence[] }) {
  if (!items.length) return null;
  return <details className="nexus-autonomy-evidence"><summary>原生执行证据 · {items.length} 条</summary>
    <ol>{items.map((item, index) => <li key={`${item.activationId}:${item.stepId}:${index}`}>
      <div><b>{item.stepId}</b><span>模型推断 · {verdictLabels[item.verdict] ?? '无法判断'}</span>
        <time dateTime={item.at}>{Number.isFinite(Date.parse(item.at)) ? new Date(item.at).toLocaleString() : item.at}</time></div>
      <dl><dt>原生激活</dt><dd><code>{item.activationId}</code></dd>
        {Number.isSafeInteger(item.turnEndSeq) && <><dt>回合结束事件</dt><dd>#{item.turnEndSeq}</dd></>}
        <dt>依据事件</dt><dd>{item.evidenceRefs?.length ? item.evidenceRefs.map(ref => `#${ref}`).join('、') : '未报告'}</dd>
      </dl>
    </li>)}</ol>
  </details>;
}

function PlanContents({ plan }: { plan: AutonomyPlanRecord }) {
  const progress = plan.progress;
  const reconciliation = plan.reconciliation;
  return <div className="nexus-autonomy-content">
    <div className="nexus-autonomy-metadata"><span>{plan.source === 'user-edited' ? '人工编辑' : '模型推断'}</span>
      <span>内容 v{plan.planRevision}</span><span>{plan.approvedRevision === plan.planRevision ? `已批准 v${plan.approvedRevision}` : plan.approvedRevision === undefined ? '尚未批准' : `批准 v${plan.approvedRevision} 已失效`}</span>
      <span>记录 r{plan.revision}</span></div>
    <p className="nexus-autonomy-objective">{plan.objective}</p>
    {progress && <div className="nexus-autonomy-progress"><progress max={Math.max(1, progress.total)} value={progress.completed} aria-label="计划步骤进度" />
      <span>{progress.completed}/{progress.total} 步 · {progress.rounds}/{progress.maxRounds} 轮</span></div>}
    {plan.reason && <p className="nexus-autonomy-reason">{autonomyReason(plan.reason)}</p>}
    {reconciliation?.state === 'delivery-unknown' || plan.delivery && !plan.delivery.activationId
      ? <p role="status">无法确认上一条计划指令是否已进入原生会话。请核实投递并检查原会话记录；在取得明确回执前，此计划保持锁定。</p>
      : reconciliation?.state === 'awaiting-native-terminal' ? <p role="status">上一项原生操作尚待核实结束。请检查原会话；操作结束后可编辑或重新提案，再批准。</p>
      : plan.status === 'needs-review' && <p role="status">请核实原生执行证据，编辑或重新提案后再批准。</p>}
    {plan.monitor && <p className="nexus-autonomy-monitor">模型观察：{plan.monitor.state === 'started' ? plan.monitor.kind === 'verify' ? '正在核验步骤' : '正在生成提案'
      : ({ idle: '待观察', ready: '已更新', failed: '调用未完成', unknown: '调用结果待核实' })[plan.monitor.state] ?? '状态待核实'}
      {plan.monitor.errorCode && <code>{plan.monitor.errorCode}</code>}</p>}
    {plan.delivery && <dl className="nexus-autonomy-delivery"><dt>当前原生操作</dt><dd>{plan.delivery.stepId} · {plan.delivery.terminal === 'succeeded' ? '原生回合已结束' : plan.delivery.state === 'sent' ? '已交给原生会话' : '执行情况待核实'}</dd>
      {plan.delivery.activationId && <><dt>原生执行记录</dt><dd><code>{plan.delivery.activationId}</code></dd></>}
    </dl>}
    <ol className="nexus-autonomy-steps">{plan.steps.map(step => <li key={step.id} data-state={progress?.stepStates?.[step.id] ?? 'pending'}>
      <div className="nexus-autonomy-step-title"><code>{step.id}</code><strong>{step.title}</strong><span>{stepLabels[progress?.stepStates?.[step.id] ?? 'pending'] ?? '待核实'}</span></div>
      <p>{step.description}</p>
      <div className="nexus-autonomy-dependencies">依赖：{step.dependsOn.length ? step.dependsOn.map(id => <code key={id}>{id}</code>) : '无'}</div>
      <ul aria-label={`${step.title}的验收条件`}>{step.acceptance.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </li>)}</ol>
    <Evidence items={plan.evidence ?? []} />
  </div>;
}

function PlanEditor({ initial, busy, changed, save, cancel }: {
  initial: AutonomyDraft; busy: boolean; changed: boolean;
  save(draft: AutonomyDraft): void; cancel(): void;
}) {
  const [draft, setDraft] = React.useState<AutonomyDraft>(() => ({
    objective: initial.objective, steps: initial.steps.map(step => ({ ...step, dependsOn: [...step.dependsOn], acceptance: [...step.acceptance] })),
  }));
  const [submitted, setSubmitted] = React.useState(false);
  const errors = autonomyDraftErrors(draft);
  const update = (id: string, values: Partial<AutonomyStep>) => setDraft(old => ({ ...old, steps: old.steps.map(step => step.id === id ? { ...step, ...values } : step) }));
  return <form className="nexus-autonomy-editor" onSubmit={event => {
    event.preventDefault(); setSubmitted(true); if (!errors.length && !changed) save(draft);
  }}>
    <p className="nexus-autonomy-edit-notice">保存将使现有批准失效。</p>
    {changed && <p role="alert">计划版本已更新，请取消编辑后重新读取。</p>}
    <label>完整目标<textarea rows={3} maxLength={2400} value={draft.objective} onChange={event => setDraft(old => ({ ...old, objective: event.target.value }))} /></label>
    {draft.steps.map((step, index) => <fieldset key={step.id}><legend>步骤 {index + 1} · {step.id}</legend>
      <label>标题<input maxLength={160} value={step.title} onChange={event => update(step.id, { title: event.target.value })} /></label>
      <label>执行说明<textarea rows={2} maxLength={1200} value={step.description} onChange={event => update(step.id, { description: event.target.value })} /></label>
      <div className="nexus-autonomy-dependency-editor"><span>依赖步骤</span>{draft.steps.filter(other => other.id !== step.id).map(other => <label key={other.id}>
        <input type="checkbox" checked={step.dependsOn.includes(other.id)} onChange={event => update(step.id, { dependsOn: event.target.checked ? [...step.dependsOn, other.id] : step.dependsOn.filter(id => id !== other.id) })} />{other.id} · {other.title || '未命名'}
      </label>)}</div>
      <label>验收条件（每行一条，最多 6 条，每条 600 字）<textarea rows={3} maxLength={3605} value={step.acceptance.join('\n')} onChange={event => update(step.id, { acceptance: event.target.value.split('\n') })} /></label>
      <button type="button" disabled={busy} onClick={() => setDraft(old => ({ ...old, steps: old.steps.filter(item => item.id !== step.id).map(item => ({ ...item, dependsOn: item.dependsOn.filter(id => id !== step.id) })) }))}>删除步骤</button>
    </fieldset>)}
    <div className="nexus-autonomy-actions"><button type="button" disabled={busy || draft.steps.length >= 12} onClick={() => setDraft(old => {
      let id = 1; while (old.steps.some(step => step.id === `step-${id}`)) id++;
      return { ...old, steps: [...old.steps, { id: `step-${id}`, title: '', description: '', dependsOn: [], acceptance: [''] }] };
    })}>添加步骤</button><button type="submit" className="nexus-autonomy-primary" disabled={busy || changed}>保存待审批版本</button><button type="button" disabled={busy} onClick={cancel}>取消</button></div>
    {submitted && errors.length > 0 && <ul role="alert" className="nexus-autonomy-validation">{errors.map(error => <li key={error}>{error}</li>)}</ul>}
  </form>;
}

function SettingsForm({ settings, busy, save, reset }: { settings: Data; busy: boolean; save(config: Data): void; reset(): void }) {
  const [draft, setDraft] = React.useState(() => autonomySettingsDraft(settings));
  const [error, setError] = React.useState('');
  const inherited = settings.inherited?.length > 0;
  const inheritance = inherited ? '继承上级' : '使用默认';
  const enabled = settings.effective?.enabled !== false;
  return <form className="nexus-autonomy-settings" onSubmit={event => {
    event.preventDefault();
    try { const config = autonomySettingsConfig(draft, settings.local?.config); setError(''); save(config); }
    catch (cause) { setError(errorData(cause).message); }
  }}>
    <p className="nexus-autonomy-effective">当前：{enabled ? '已启用' : '已停用'} · 自动提案{settings.automatic !== false ? '开启' : '关闭'} · 使用独立辅助模型优先级</p>
    {(['enabled', 'automatic'] as const).map((key, index) => <label key={key}>{index === 0 ? '计划功能' : '自动提案'}<select value={draft[key]} onChange={event => setDraft(old => ({ ...old, [key]: event.target.value as Inheritance }))}>
      <option value="inherit">{inheritance}</option><option value="on">开启</option><option value="off">关闭</option></select><small>当前来源：{autonomySettingSource(settings, key)}</small></label>)}
    {configNumbers.map(([key, label, min, max]) => <label key={key}>{label}<input type="number" min={min} max={max} step={1} value={draft[key]}
      placeholder={`${inheritance} · ${settings[key] ?? ({ maxCallsPerDay: 24, maxOutputTokens: 32768, minIntervalMs: 60000, maxRounds: 12 })[key]}`}
      onChange={event => setDraft(old => ({ ...old, [key]: event.target.value }))} /><small>当前来源：{autonomySettingSource(settings, key)}</small></label>)}
    {error && <p role="alert">{error}</p>}
    <div className="nexus-autonomy-actions"><button type="submit" disabled={busy}>保存本层设置</button><button type="button" disabled={busy || !settings.local?.revision} onClick={reset}>恢复继承</button></div>
  </form>;
}

export function AutonomyPlan({ api, scope, compact = false, active = true, openSession }: {
  api: NexusApi; scope: NexusScope; compact?: boolean; active?: boolean; openSession?(sessionId: string): void;
}) {
  const generation = React.useSyncExternalStore(React.useCallback(listener => api.subscribe(listener), [api]), () => api.getGeneration(), () => 0);
  const scopeKey = scopeIdentity(scope);
  const stableScope = React.useMemo(() => ({ ...scope }), [scopeKey]);
  const key = `${generation}:${scopeKey}`;
  const identity = React.useRef(key); identity.current = key;
  const sequence = React.useRef(0);
  const alive = React.useRef(false);
  const busyRef = React.useRef(false);
  const mutations = React.useRef(new Set<AbortController>());
  const [cache, setCache] = React.useState<Cache>();
  const [failure, setFailure] = React.useState({ key, message: '' });
  const [pending, setPending] = React.useState<string>();
  const [opened, setOpened] = React.useState(false);
  const [editor, setEditor] = React.useState<{ key: string; revision: number; draft: AutonomyDraft }>();
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [objective, setObjective] = React.useState('');
  const value = cache?.key === key ? cache.value : undefined;
  const settings = cache?.key === key ? cache.settings : undefined;
  const plan = value && value.status !== 'empty' && Array.isArray(value.steps) ? value as AutonomyPlanRecord : undefined;
  const actions = autonomyAllowedActions(plan);
  const busy = pending === key || !active;
  const error = failure.key === key ? failure.message : '';
  const currentEditor = editor?.key === key ? editor : undefined;
  const enabled = settings?.effective?.enabled !== false;
  const budget: AutonomyBudget | undefined = value?.budget ?? settings?.budget;
  const load = React.useCallback(async (signal?: AbortSignal) => {
    const call = ++sequence.current;
    const result = await readAutonomyCache(api, stableScope, signal);
    if (signal?.aborted || !alive.current || identity.current !== key || call !== sequence.current) return;
    setCache(old => old?.key === key && JSON.stringify(old.value) === JSON.stringify(result.value) && JSON.stringify(old.settings) === JSON.stringify(result.settings) ? old : { key, ...result });
    setFailure({ key, message: '' });
  }, [api, key]);
  React.useEffect(() => {
    alive.current = true;
    busyRef.current = false;
    setOpened(false); setSettingsOpen(false); setObjective('');
    const disposeMutations = () => { for (const controller of mutations.current) controller.abort(); mutations.current.clear(); };
    if (!active) return () => { alive.current = false; disposeMutations(); };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!controller.signal.aborted && !busyRef.current && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
        try { await load(controller.signal); }
        catch (cause) { if (!controller.signal.aborted && identity.current === key && alive.current) setFailure({ key, message: errorData(cause).message }); }
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 8000);
    };
    void poll();
    return () => { alive.current = false; controller.abort(); disposeMutations(); clearTimeout(timer); };
  }, [load, active]);

  const act = async (operation: (signal: AbortSignal) => Promise<unknown>, after?: () => void, refresh = true) => {
    if (busyRef.current || !active || !alive.current) return;
    busyRef.current = true; sequence.current++; setPending(key); setFailure({ key, message: '' });
    const controller = new AbortController(); mutations.current.add(controller);
    try {
      await operation(controller.signal);
      if (controller.signal.aborted || identity.current !== key || !alive.current) return;
      after?.();
      if (refresh) await load(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted && identity.current === key && alive.current) setFailure({ key, message: errorData(cause).message });
    } finally {
      mutations.current.delete(controller);
      if (identity.current === key && alive.current) { busyRef.current = false; setPending(undefined); }
    }
  };
  const mutate = (action: AutonomyAction, params: Data = {}, after?: () => void) =>
    act(signal => sendAutonomyAction(api, stableScope, plan, action, params, requestId(), signal), after);
  const configure = (config: Data) => act(signal => api.call('scope', 'configure', { feature: 'autonomy', config }, {
    scope: stableScope, mutating: true, revision: settings?.local?.revision ?? 0, requestId: requestId(), signal,
  }));
  const body = <>
    {error && <p role="alert" className="nexus-autonomy-error">{error}</p>}
    {!value && <p className="nexus-autonomy-empty">正在读取计划…</p>}
    {settings && <div className="nexus-autonomy-budget">
      <span>每日模型调用上限 {settings.maxCallsPerDay ?? 24} 次/会话 · {settings.maxOutputTokens ?? 32768} token/次（含思考）</span>
      <span>观察间隔 {Math.ceil((settings.minIntervalMs ?? 60000) / 1000)} 秒 · 最多 {settings.maxRounds ?? 12} 轮</span>
      {budget && <span>今日已用 {budget.callsToday} 次 · 剩余 {budget.remainingCalls} 次
        {budget.remainingCalls <= 0 ? ' · 今日预算已用尽' : budget.cooldownMs > 0 ? ` · 冷却 ${Math.ceil(budget.cooldownMs / 1000)} 秒` : ' · 可观察'}</span>}
      {budget && Number.isFinite(new Date(budget.nextCallAt).getTime()) && (budget.remainingCalls <= 0 || budget.cooldownMs > 0)
        && <span>下次可观察：<time dateTime={new Date(budget.nextCallAt).toISOString()}>{new Date(budget.nextCallAt).toLocaleString()}</time></span>}
      <span>本层：{scopeLabels[settings.local?.scope ?? scope.level ?? 'session'] ?? '当前层'} · r{settings.local?.revision ?? 0} · 自动提案来自{autonomySettingSource(settings, 'automatic')}</span>
    </div>}
    {scope.level === 'session' ? <>
      {plan ? <><PlanContents plan={plan} />{openSession && <button type="button" onClick={() => openSession(plan.sessionId)}>查看原生会话</button>}</>
        : value && <p className="nexus-autonomy-empty">{value.reason ? autonomyReason(value.reason) : '尚无待审批计划'}</p>}
      {currentEditor ? <PlanEditor key={`${key}:${currentEditor.revision}`} initial={currentEditor.draft} busy={busy}
        changed={currentEditor.revision !== (plan?.revision ?? 0)}
        save={draft => void mutate('edit', draft, () => setEditor(undefined))} cancel={() => setEditor(undefined)} /> : <>
        {actions.includes('propose') && <label className="nexus-autonomy-propose">提案目标（可留空，从会话推断）<textarea rows={2} maxLength={2400} value={objective} onChange={event => setObjective(event.target.value)} /></label>}
        <div className="nexus-autonomy-actions">
          {actions.includes('approve') && <button className="nexus-autonomy-primary" disabled={busy || !enabled} onClick={() => void mutate('approve')}>批准 v{plan?.planRevision} 并运行</button>}
          {actions.includes('pause') && <button disabled={busy} onClick={() => void mutate('pause')}>暂停计划</button>}
          {actions.includes('resume') && <button className="nexus-autonomy-primary" disabled={busy || !enabled} onClick={() => void mutate('resume')}>恢复已批准计划</button>}
          {actions.includes('edit') && <button disabled={busy || !enabled} onClick={() => setEditor({ key, revision: plan?.revision ?? 0, draft: { objective: plan?.objective ?? '', steps: plan?.steps ?? [] } })}>编辑计划</button>}
          {actions.includes('reject') && <button disabled={busy || !enabled} onClick={() => void mutate('reject')}>拒绝计划</button>}
          {actions.includes('reconcile') && <button disabled={busy || !enabled} onClick={() => void mutate('reconcile')}>核实投递</button>}
          {actions.includes('propose') && <button disabled={busy || !settings || !enabled} onClick={() => void mutate('propose', { ...(objective.trim() ? { objective: objective.trim() } : {}), retry: Boolean(plan) }, () => setObjective(''))}>{plan ? '重新提案' : '生成提案'}</button>}
        </div>
      </>}
    </> : <div className="nexus-autonomy-list">
      {(value?.items ?? []).map((item: AutonomyPlanRecord) => <details key={item.id ?? `${item.workspace}:${item.sessionId}`}>
        <summary><span className="nexus-autonomy-status" data-status={item.status}>{statusLabels[item.status] ?? '状态待核实'}</span>
          <strong>{item.objective}</strong><span>{item.sessionId}</span><span>v{item.planRevision}</span></summary>
        <PlanContents plan={item} />
        {openSession && <button type="button" onClick={() => openSession(item.sessionId)}>打开原生会话</button>}
      </details>)}
      {value && !value.items?.length && <p className="nexus-autonomy-empty">此范围暂无计划</p>}
    </div>}
    {settings && <details className="nexus-autonomy-settings-wrap" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}>
      <summary>自动计划设置 · {scope.level === 'global' ? '全局' : scope.level === 'workspace' ? '工作区' : '会话'}</summary>
      {settingsOpen && <SettingsForm key={`${key}:${settings.local?.revision ?? 0}`} settings={settings} busy={busy}
        save={config => void configure(config)} reset={() => void act(signal => api.call('scope', 'reset', { feature: 'autonomy' }, {
          scope: stableScope, mutating: true, revision: settings.local?.revision ?? 0, requestId: requestId(), signal,
        }))} />}
      {settingsOpen && <AuxiliarySettings api={api} scope={stableScope} scoped />}
    </details>}
  </>;
  const toolbar = <div className="nexus-autonomy-toolbar"><strong>自动计划</strong>
    <span className="nexus-autonomy-status" data-status={plan?.status ?? 'empty'}>{scope.level === 'session' ? statusLabels[plan?.status ?? 'empty'] ?? '状态待核实' : `${value?.items?.length ?? 0} 个计划`}</span>
    <label><input type="checkbox" checked={settings?.automatic !== false} disabled={busy || !settings} onChange={event => {
      const automatic = event.target.checked, local = settings?.local?.config ?? {};
      void configure({ ...local, ...(automatic ? { enabled: true } : {}), defaults: { ...(local.defaults ?? {}), automatic } });
    }} />自动提案</label>
    <button disabled={busy || !active} onClick={() => void act(signal => load(signal), undefined, false)}>{busy ? '处理中…' : '刷新'}</button></div>;
  return <section className={`nexus-autonomy${compact ? ' nexus-autonomy-compact' : ''}`} data-nexus-autonomy={scope.sessionId ?? scope.level} aria-label="自动计划">
    <style>{styles}</style>
    {compact ? <details open={opened} onToggle={event => setOpened(event.currentTarget.open)}><summary className="nexus-autonomy-strip">
      <strong>自动计划</strong><span className="nexus-autonomy-status" data-status={plan?.status ?? 'empty'}>{statusLabels[plan?.status ?? 'empty'] ?? '状态待核实'}</span>
      <span className="nexus-autonomy-strip-objective">{plan?.objective || (settings?.automatic !== false ? '自动提案已开启' : '自动提案已关闭')}</span>
      {plan && <span>{plan.progress?.completed ?? 0}/{plan.steps.length} 步 · v{plan.planRevision}</span>}
    </summary>{opened && <div className="nexus-autonomy-expanded">{toolbar}{body}</div>}</details> : <>{toolbar}{body}</>}
  </section>;
}

/** The original SessionProvider remains the sole source of session identity. */
export function registerAutonomyConversation(rawContext: ClientContext): () => void {
  const ctx = rawContext as any, api = createNexusApi(rawContext);
  let disposed = false;
  function ConversationPlan(props: any) {
    const session = props.useSession((value: any) => value);
    if (disposed || typeof props.sessionId !== 'string' || session?.sessionId !== props.sessionId) return null;
    return <AutonomyPlan key={props.sessionId} api={api} scope={{ level: 'session', sessionId: props.sessionId }}
      openSession={ctx.uiWorkspace?.openSession ? id => ctx.uiWorkspace.openSession(id) : undefined} compact />;
  }
  const generation = ctx.connection?.generation;
  let previousGeneration = generation?.getSnapshot?.()?.id;
  const reset = generation?.subscribe?.(() => {
    const next = generation.getSnapshot?.()?.id;
    if (next !== previousGeneration) { previousGeneration = next; api.reset(); }
  });
  const stop = ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'nexus.autonomy-plan', order: 35,
  }, ConversationPlan));
  return () => {
    if (disposed) return;
    disposed = true;
    if (typeof stop === 'function') stop();
    if (typeof reset === 'function') reset();
    api.dispose();
  };
}
