import * as React from 'react';
import type { Data, NexusApi, NexusScope } from './types.js';
import { Button, ErrorMessage } from './components.js';
import { boundedRead } from '../shared/bounded-read.js';
import { CONTEXT_COMPACTION_FEATURE, resolveContextCompactionOptions, validateContextCompactionConfig } from '../shared/context-compaction.js';

const labels: Record<string, string> = { global: '全局', workspace: '工作区', session: '会话' };
function useBoundedSettingsRead(api: NexusApi, domain: string, action: string, params: Data, scope: NexusScope, enabled = true) {
  const [data, setData] = React.useState<Data>(), [error, setError] = React.useState<unknown>();
  const [loading, setLoading] = React.useState(enabled), [revision, retry] = React.useState(0);
  React.useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    const owner = new AbortController(); setLoading(true); setError(undefined);
    void boundedRead(signal => api.call(domain, action, params, { scope, signal }), {
      signal: owner.signal, timeoutMs: 10000,
      timeout: () => new Error('读取上下文设置或模型目录超过10秒，请重试；已保存配置继续有效'),
      cancelled: () => new Error('读取已取消'),
    }).then(value => { if (!owner.signal.aborted) setData(value); })
      .catch(cause => { if (!owner.signal.aborted) setError(cause); })
      .finally(() => { if (!owner.signal.aborted) setLoading(false); });
    return () => owner.abort();
  }, [api, domain, action, JSON.stringify(params), JSON.stringify(scope), enabled, revision]);
  return { data, error, loading, reload: () => retry(value => value + 1) };
}
export function ContextCompactionSettings({ api, scope: initial }: { api: NexusApi; scope?: NexusScope }) {
  const [level, setLevel] = React.useState(initial?.level ?? 'global');
  const [workspaceId, setWorkspaceId] = React.useState(''), [sessionId, setSessionId] = React.useState('');
  const workspaces = useBoundedSettingsRead(api, 'scope', 'workspaces', {}, { level: 'global' }, !initial && level !== 'global');
  const items: Data[] = workspaces.data?.items ?? [], sessions: string[] = items.find(item => item.id === workspaceId)?.sessionIds ?? [];
  const scope: NexusScope = initial ?? (level === 'global' ? { level } : level === 'workspace' ? { level, workspaceId } : { level, workspaceId, sessionId });
  const ready = Boolean(initial || level === 'global' || workspaceId && (level === 'workspace' || sessions.includes(sessionId)));
  const generation = React.useSyncExternalStore(api.subscribe, api.getGeneration, api.getGeneration);
  return <section data-nexus-context-compaction="">
    {!initial && <div className="nexus-setting-controls"><select aria-label="上下文压缩作用域" value={level} onChange={event => setLevel(event.target.value as typeof level)}><option value="global">全局</option><option value="workspace">工作区</option><option value="session">会话</option></select>
      {level !== 'global' && <select aria-label="上下文压缩工作区" value={workspaceId} onChange={event => { setWorkspaceId(event.target.value); setSessionId(''); }}><option value="">选择工作区</option>{items.map(item => <option key={item.id} value={item.id}>{item.title ?? item.path}</option>)}</select>}
      {level === 'session' && <select aria-label="上下文压缩会话" value={sessionId} onChange={event => setSessionId(event.target.value)}><option value="">选择会话</option>{sessions.map(id => <option key={id} value={id}>{id}</option>)}</select>}</div>}
    {workspaces.loading && <p role="status">正在读取工作区…</p>}
    {Boolean(workspaces.error) && <ErrorMessage error={workspaces.error} retry={workspaces.reload} />}
    {ready ? <CompactionForm key={`${JSON.stringify(scope)}:${generation}`} api={api} scope={scope} /> : <p>请选择对应范围。</p>}
  </section>;
}
function CompactionForm({ api, scope }: { api: NexusApi; scope: NexusScope }) {
  const settings = useBoundedSettingsRead(api, 'scope', 'settings', { feature: CONTEXT_COMPACTION_FEATURE }, scope);
  const directory = useBoundedSettingsRead(api, 'context', 'models/list', {}, scope);
  const [draft, setDraft] = React.useState<Data>({}), [dirty, setDirty] = React.useState(false);
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState<unknown>(), [message, setMessage] = React.useState('');
  const lifetime = React.useRef<AbortController | undefined>(undefined);
  React.useEffect(() => { const c = new AbortController(); lifetime.current = c; return () => c.abort(); }, []);
  React.useEffect(() => { if (settings.data) { setDraft(settings.data.local?.config ?? {}); setDirty(false); } }, [settings.data]);
  let options: ReturnType<typeof resolveContextCompactionOptions> | undefined;
  try { if (settings.data) options = resolveContextCompactionOptions(settings.data.effective); } catch {}
  const routes: Data[] = directory.data?.items ?? [], localModel = draft.defaults?.summaryModel;
  const selected = localModel === undefined ? 'inherit' : localModel === null ? 'follow' : JSON.stringify([localModel.provider, localModel.model]);
  const update = (key: string, value: unknown) => {
    setDraft(old => {
      const next = { ...old, defaults: { ...(old.defaults ?? {}) } }, target = key === 'enabled' ? next : next.defaults;
      if (value === undefined) delete target[key]; else target[key] = value;
      return next;
    }); setDirty(true); setMessage('');
  };
  const save = async (action: 'configure' | 'reset') => {
    const signal = lifetime.current?.signal; if (!signal || signal.aborted || busy || !settings.data) return;
    const invalid = action === 'configure' ? validateContextCompactionConfig(draft) : undefined;
    if (invalid) { setError(new Error(invalid)); return; }
    setBusy(true); setError(undefined);
    try {
      await boundedRead(writeSignal => api.call('scope', action, { feature: CONTEXT_COMPACTION_FEATURE, ...(action === 'configure' ? { config: draft } : {}) },
        { scope, mutating: true, revision: settings.data!.local.revision, signal: writeSignal }), {
        signal, timeoutMs: 15000, timeout: () => new Error('保存结果尚未确认，请先重新读取已保存设置'), cancelled: () => new Error('保存已取消'),
      });
      if (!signal.aborted) { setMessage('已保存，下次模型请求前生效'); settings.reload(); }
    } catch (cause) { if (!signal.aborted) setError(cause); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const source = (key: string) => {
    const layer = settings.data?.layers?.slice().reverse().find((item: Data) => key === 'enabled' ? item.config.enabled !== undefined : item.config.defaults?.[key] !== undefined);
    return layer ? labels[layer.scope] : '默认';
  };
  return <form onSubmit={event => { event.preventDefault(); void save('configure'); }}>
    {settings.loading && <p role="status">正在读取压缩设置…</p>}
    {Boolean(settings.error) && <ErrorMessage error={settings.error} retry={settings.reload} />}
    {Boolean(error) && <ErrorMessage error={error} retry={settings.reload} />}
    {options && <fieldset disabled={busy || settings.loading}><p>{labels[scope.level ?? 'global']} · 全局→工作区→会话实时继承</p>
      <label className="nexus-setting-row"><span>自动提前压缩<small>当前{options.enabled ? '开启' : '关闭'} · 来源：{source('enabled')}</small></span>
        <select aria-label="自动提前压缩" value={draft.enabled === undefined ? 'inherit' : draft.enabled ? 'on' : 'off'} onChange={event => update('enabled', event.target.value === 'inherit' ? undefined : event.target.value === 'on')}><option value="inherit">继承 / 使用默认</option><option value="on">开启</option><option value="off">关闭</option></select></label>
      <label className="nexus-setting-row"><span>有效窗口占用阈值（%）<small>当前{options.thresholdPercent}% · 来源：{source('thresholdPercent')}。10–95，留空继承；包含输出预算。</small></span>
        <input aria-label="有效窗口占用阈值" type="number" min={10} max={95} step={1} value={draft.defaults?.thresholdPercent ?? ''} placeholder={`${options.thresholdPercent}（继承）`} onChange={event => update('thresholdPercent', event.target.value === '' ? undefined : Number(event.target.value))} /></label>
      <label className="nexus-setting-row"><span>压缩模型<small>当前：{options.summaryModel ? `${options.summaryModel.provider}/${options.summaryModel.model}` : '跟随当前会话'} · 来源：{source('summaryModel')}。仅用于摘要。</small></span>
        <select aria-label="压缩模型" value={selected} onChange={event => {
          if (event.target.value === 'inherit') update('summaryModel', undefined);
          else if (event.target.value === 'follow') update('summaryModel', null);
          else { const [provider, model] = JSON.parse(event.target.value); update('summaryModel', { provider, model }); }
        }}><option value="inherit">继承 / 使用默认</option><option value="follow">跟随当前会话模型</option>
          {localModel && !routes.some(item => item.provider === localModel.provider && item.model === localModel.model) && <option value={selected}>{localModel.provider}/{localModel.model}（已保存；目录未确认）</option>}
          {routes.map(item => <option key={item.code ?? `${item.provider}/${item.model}`} value={JSON.stringify([item.provider, item.model])}>{item.provider}/{item.model} · 窗口 {item.capabilities?.contextWindow?.value?.toLocaleString() ?? '未知'}</option>)}</select></label>
      <div className="nexus-actions"><Button primary type="submit" disabled={!dirty}>保存压缩设置</Button><Button type="button" disabled={!settings.data?.local?.revision} onClick={() => void save('reset')}>恢复继承</Button></div>
    </fieldset>}
    {directory.loading && <p role="status">正在读取压缩模型目录；已保存配置继续显示…</p>}
    {Boolean(directory.error) && <ErrorMessage error={directory.error} retry={directory.reload} />}
    {message && <p role="status">{message}</p>}
  </form>;
}
