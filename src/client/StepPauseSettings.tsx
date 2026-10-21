import * as React from 'react';
import type { Data, NexusApi, NexusScope } from './types.js';
import { Button, ErrorMessage, useQuery } from './components.js';
import { boundedRead } from '../shared/bounded-read.js';
import { STEP_PAUSE_FEATURE, STEP_PAUSE_DEFAULT_PROMPT, resolveStepPauseOptions, validateStepPauseConfig } from '../shared/step-pause.js';

const labels: Record<string, string> = {
  enabled: '启用步骤进度', mainAgentOnly: '只在主智能体汇报', showPromptInChat: '在对话里显示提示词原文',
  everyNSteps: '每多少步汇报一次', maxReportsPerTurn: '每轮最多汇报几次', prompt: '进度提示词',
};
const scopeLabels: Record<string, string> = { global: '全局', workspace: '工作区', session: '会话' };

/** Same scope/settings route as the other Nexus features, with sparse overrides. */
export function StepPauseSettings({ api }: { api: NexusApi }) {
  const [level, setLevel] = React.useState<'global' | 'workspace' | 'session'>('global');
  const [workspaceId, setWorkspaceId] = React.useState(''), [sessionId, setSessionId] = React.useState('');
  const workspaces = useQuery(api, 'scope', 'workspaces', {}, { scope: { level: 'global' }, enabled: level !== 'global' });
  const items: Data[] = workspaces.data?.items ?? [];
  const sessions: string[] = items.find(item => item.id === workspaceId)?.sessionIds ?? [];
  const scope: NexusScope = level === 'global' ? { level } : level === 'workspace' ? { level, workspaceId } : { level, workspaceId, sessionId };
  const ready = level === 'global' || Boolean(workspaceId && (level === 'workspace' || sessions.includes(sessionId)));
  const generation = React.useSyncExternalStore(api.subscribe, api.getGeneration, api.getGeneration);
  return <section className="nexus-step-progress" data-nexus-step-progress="">
    <p>每 N 个步骤先在对话里汇报进度，然后继续原任务。长工具调用结束后才会到达步骤边界；汇报使用当前模型响应。</p>
    <div className="nexus-setting-controls">
      <select aria-label="步骤进度作用域" value={level} onChange={event => setLevel(event.target.value as typeof level)}>
        <option value="global">全局</option><option value="workspace">工作区</option><option value="session">会话</option>
      </select>
      {level !== 'global' && <select aria-label="步骤进度工作区" value={workspaceId} onChange={event => { setWorkspaceId(event.target.value); setSessionId(''); }}>
        <option value="">选择工作区</option>{items.map(item => <option key={item.id} value={item.id}>{item.title ?? item.path}</option>)}
      </select>}
      {level === 'session' && <select aria-label="步骤进度会话" value={sessionId} onChange={event => setSessionId(event.target.value)}>
        <option value="">选择会话</option>{sessions.map(id => <option key={id} value={id}>{id}</option>)}
      </select>}
    </div>
    {level !== 'global' && workspaces.loading && <p role="status">正在读取工作区与会话…</p>}
    {Boolean(workspaces.error) && level !== 'global' && <ErrorMessage error={workspaces.error} retry={workspaces.reload} />}
    {ready ? <StepPauseSettingsForm key={`${JSON.stringify(scope)}:${generation}`} api={api} scope={scope} />
      : <p>请选择{level === 'session' ? '工作区与会话' : '工作区'}。</p>}
  </section>;
}

export function StepPauseSettingsForm({ api, scope }: { api: NexusApi; scope: NexusScope }) {
  const [value, setValue] = React.useState<Data>(), [draft, setDraft] = React.useState<Data>({});
  const [error, setError] = React.useState<unknown>(), [busy, setBusy] = React.useState(false), [loading, setLoading] = React.useState(true);
  const [dirty, setDirty] = React.useState(false), [message, setMessage] = React.useState('');
  const lifetime = React.useRef<AbortController | undefined>(undefined);
  const load = async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const result = await boundedRead(readSignal => api.call('scope', 'settings', { feature: STEP_PAUSE_FEATURE }, { scope, signal: readSignal }), {
        signal, timeoutMs: 15000, timeout: () => new Error('步骤进度设置读取超过15秒，请重试'),
        cancelled: () => new Error('读取已取消'),
      });
      if (signal.aborted) return;
      // Validate inherited data before making it an editable draft.
      resolveStepPauseOptions(result.effective);
      setValue(result); setDraft(result.local?.config ?? {}); setDirty(false);
    } finally { if (!signal.aborted) setLoading(false); }
  };
  React.useEffect(() => {
    const owner = new AbortController(); lifetime.current = owner;
    void load(owner.signal).catch(cause => { if (!owner.signal.aborted) setError(cause); });
    return () => { owner.abort(); if (lifetime.current === owner) lifetime.current = undefined; };
  }, [api, JSON.stringify(scope)]);
  const update = (key: string, next: unknown, inherit = false) => {
    setDraft(old => {
      const result = { ...old, defaults: { ...(old.defaults ?? {}) } };
      const target = key === 'enabled' ? result : result.defaults;
      if (inherit) delete target[key]; else target[key] = next;
      return result;
    });
    setDirty(true); setMessage('');
  };
  const act = async (action: 'configure' | 'reset') => {
    const signal = lifetime.current?.signal; if (!signal || signal.aborted || busy || loading || !value) return;
    setError(undefined); setMessage('');
    const invalid = action === 'configure' ? validateStepPauseConfig(draft) : undefined;
    if (invalid) { setError(new Error(invalid)); return; }
    setBusy(true);
    try {
      await boundedRead(writeSignal => api.call('scope', action, { feature: STEP_PAUSE_FEATURE, ...(action === 'configure' ? { config: draft } : {}) },
        { scope, mutating: true, revision: value.local.revision, signal: writeSignal }), {
        signal, timeoutMs: 15000, timeout: () => new Error('保存结果尚未确认，请先重新读取已保存设置'),
        cancelled: () => new Error('保存已取消'),
      });
      if (!signal.aborted) { await load(signal); if (!signal.aborted) setMessage('已保存，下个步骤生效'); }
    } catch (cause) { if (!signal.aborted) setError(cause); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const options = value ? resolveStepPauseOptions(value.effective) : undefined;
  const local = (key: string) => key === 'enabled' ? draft.enabled : draft.defaults?.[key];
  const source = (key: string) => {
    const layer = value?.layers?.slice().reverse().find((item: Data) => key === 'enabled' ? item.config.enabled !== undefined : item.config.defaults?.[key] !== undefined);
    return layer ? scopeLabels[layer.scope] : '默认';
  };
  const inherited = scope.level === 'global' ? '使用默认' : '继承父级';
  return <form className="nexus-step-progress-form" onSubmit={event => { event.preventDefault(); void act('configure'); }}>
    {Boolean(error) && <ErrorMessage error={error} retry={() => {
      const signal = lifetime.current?.signal;
      if (signal && !busy) { setError(undefined); void load(signal).catch(cause => { if (!signal.aborted) setError(cause); }); }
    }} />}
    {loading && <p role="status">正在读取步骤进度设置…</p>}
    {options && <fieldset disabled={busy || loading}>
      <p>当前范围：{scopeLabels[scope.level ?? 'global']}</p>
      {['enabled', 'mainAgentOnly', 'showPromptInChat'].map(key => <label className="nexus-setting-row" key={key}>
        <span>{labels[key]}<small>当前生效：{options[key as keyof typeof options] ? '开启' : '关闭'} · 来源：{source(key)}</small></span>
        <select aria-label={labels[key]} value={local(key) === undefined ? 'inherit' : local(key) ? 'on' : 'off'}
          onChange={event => update(key, event.target.value === 'on', event.target.value === 'inherit')}>
          <option value="inherit">{inherited}</option><option value="on">开启</option><option value="off">关闭</option>
        </select>
      </label>)}
      {(['everyNSteps', 'maxReportsPerTurn'] as const).map(key => <label className="nexus-setting-row" key={key}>
        <span>{labels[key]}<small>当前生效：{options[key]} · 来源：{source(key)}{key === 'maxReportsPerTurn' ? ' · 0 表示不限次数' : ' · 第1步不汇报'}</small></span>
        <input aria-label={labels[key]} type="number" min={key === 'everyNSteps' ? 1 : 0} max={key === 'everyNSteps' ? 500 : 1000}
          value={local(key) ?? ''} placeholder={`${inherited}（${options[key]}）`} onChange={event => update(key, event.target.value === '' ? undefined : Number(event.target.value), event.target.value === '')} />
      </label>)}
      <label className="nexus-step-progress-prompt">{labels.prompt}<textarea aria-label={labels.prompt} rows={9} maxLength={8000}
        value={local('prompt') ?? options.prompt} onChange={event => update('prompt', event.target.value)} /></label>
      <small>来源：{source('prompt')} · 支持 {'{{step}} {{every}} {{turn}}'}。进度提示会随对话保留并占用上下文；隐藏仅影响显示。原任务格式与审批约束优先。</small>
      <div className="nexus-actions"><Button type="button" onClick={() => update('prompt', undefined, true)}>恢复提示词继承</Button>
        <Button type="button" onClick={() => update('prompt', STEP_PAUSE_DEFAULT_PROMPT)}>使用默认提示词</Button></div>
      <div className="nexus-settings-save"><Button type="submit" primary disabled={!dirty}>保存设置</Button>
        <Button type="button" disabled={!value?.local.revision} onClick={() => void act('reset')}>恢复继承</Button>
        <Button type="button" disabled={!dirty} onClick={() => { setDraft(value?.local.config ?? {}); setDirty(false); setError(undefined); }}>撤销修改</Button></div>
    </fieldset>}
    {message && <p role="status">{message}</p>}
  </form>;
}
