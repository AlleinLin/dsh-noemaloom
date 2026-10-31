import * as React from 'react';
import type { Data, NexusApi, NexusScope } from './types.js';
import { Button, ErrorMessage } from './components.js';
import { boundedRead } from '../shared/bounded-read.js';
import { REQUEST_RETRY_FEATURE, requestRetryDelay, resolveRequestRetryOptions, validateRequestRetryConfig, type RequestRetryOptions } from '../shared/request-retry.js';

const labels: Record<string, string> = { global: '全局', workspace: '工作区', session: '会话' };
const modeLabels = { inherit: '沿用提供方间隔', custom: '自动退避重试', disabled: '关闭自动重试' };
function useRead(api: NexusApi, action: string, params: Data, scope: NexusScope, enabled = true) {
  const [data, setData] = React.useState<Data>(), [error, setError] = React.useState<unknown>();
  const [loading, setLoading] = React.useState(enabled), [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    const controller = new AbortController(); setLoading(true); setError(undefined);
    void boundedRead(signal => api.call('scope', action, params, { scope, signal }), {
      signal: controller.signal, timeoutMs: 10000,
      timeout: () => new Error('读取重试设置超过10秒，请重新读取'),
      cancelled: () => new Error('读取已取消'),
    }).then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, action, JSON.stringify(params), JSON.stringify(scope), enabled, revision]);
  return { data, error, loading, reload: () => setRevision(value => value + 1) };
}

export function RequestRetrySettings({ api, scope: initial }: { api: NexusApi; scope?: NexusScope }) {
  const [level, setLevel] = React.useState(initial?.level ?? 'global');
  const [workspaceId, setWorkspaceId] = React.useState(''), [sessionId, setSessionId] = React.useState('');
  const workspaces = useRead(api, 'workspaces', {}, { level: 'global' }, !initial && level !== 'global');
  const items: Data[] = workspaces.data?.items ?? [], sessions: string[] = items.find(item => item.id === workspaceId)?.sessionIds ?? [];
  const scope: NexusScope = initial ?? (level === 'global' ? { level } : level === 'workspace' ? { level, workspaceId } : { level, workspaceId, sessionId });
  const ready = Boolean(initial || level === 'global' || workspaceId && (level === 'workspace' || sessions.includes(sessionId)));
  const generation = React.useSyncExternalStore(api.subscribe, api.getGeneration, api.getGeneration);
  return <section data-nexus-request-retry="">
    {!initial && <div className="nexus-setting-controls">
      <select aria-label="模型请求重试作用域" value={level} onChange={event => setLevel(event.target.value as typeof level)}><option value="global">全局</option><option value="workspace">工作区</option><option value="session">会话</option></select>
      {level !== 'global' && <select aria-label="模型请求重试工作区" value={workspaceId} onChange={event => { setWorkspaceId(event.target.value); setSessionId(''); }}><option value="">选择工作区</option>{items.map(item => <option key={item.id} value={item.id}>{item.title ?? item.path}</option>)}</select>}
      {level === 'session' && <select aria-label="模型请求重试会话" value={sessionId} onChange={event => setSessionId(event.target.value)}><option value="">选择会话</option>{sessions.map(id => <option key={id} value={id}>{id}</option>)}</select>}
    </div>}
    {workspaces.loading && <p role="status">正在读取工作区…</p>}
    {Boolean(workspaces.error) && <ErrorMessage error={workspaces.error} retry={workspaces.reload} />}
    {ready ? <RetryForm key={`${JSON.stringify(scope)}:${generation}`} api={api} scope={scope} /> : <p>请选择对应范围。</p>}
  </section>;
}

function RetryForm({ api, scope }: { api: NexusApi; scope: NexusScope }) {
  const settings = useRead(api, 'settings', { feature: REQUEST_RETRY_FEATURE }, scope);
  const [draft, setDraft] = React.useState<Data>({}), [dirty, setDirty] = React.useState(false);
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState<unknown>(), [message, setMessage] = React.useState('');
  const lifetime = React.useRef<AbortController | undefined>(undefined);
  React.useEffect(() => { const owner = new AbortController(); lifetime.current = owner; return () => owner.abort(); }, []);
  React.useEffect(() => { if (settings.data && !dirty) setDraft(settings.data.local?.config ?? {}); }, [settings.data, dirty]);
  const update = (key: string, value: unknown) => {
    setDraft(old => {
      const next = { ...old, defaults: { ...old.defaults } };
      if (value === undefined) delete next.defaults[key]; else next.defaults[key] = value;
      return next;
    }); setDirty(true); setMessage('');
  };
  let options: RequestRetryOptions | undefined, invalid: string | undefined;
  try {
    if (settings.data) {
      const inherited = settings.data.inherited.reduce((all: Data, layer: Data) => ({
        ...all, ...layer.config, defaults: { ...all.defaults, ...layer.config.defaults },
      }), {});
      options = resolveRequestRetryOptions({ ...inherited, ...draft, defaults: { ...inherited.defaults, ...draft.defaults } });
    }
  } catch (cause) { invalid = (cause as Error).message; }
  const source = (key: string) => draft.defaults?.[key] !== undefined ? labels[scope.level ?? 'global']
    : labels[settings.data?.inherited?.slice().reverse().find((layer: Data) => layer.config.defaults?.[key] !== undefined)?.scope] ?? '默认';
  const save = async (action: 'configure' | 'reset') => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || busy || !settings.data) return;
    const validation = action === 'configure' ? validateRequestRetryConfig(draft) ?? invalid : undefined;
    if (validation) { setError(new Error(validation)); return; }
    setBusy(true); setError(undefined);
    try {
      await boundedRead(writeSignal => api.call('scope', action, { feature: REQUEST_RETRY_FEATURE, ...(action === 'configure' ? { config: draft } : {}) },
        { scope, mutating: true, revision: settings.data!.local.revision, signal: writeSignal }), {
        signal, timeoutMs: 15000, timeout: () => new Error('保存结果尚未确认，请重新读取设置'), cancelled: () => new Error('保存已取消'),
      });
      if (!signal.aborted) { setDirty(false); setMessage('已保存，下次请求失败时生效；进行中的等待保持原策略'); settings.reload(); }
    } catch (cause) { if (!signal.aborted) setError(cause); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const numeric = (key: 'maxRetries' | 'initialDelayMs' | 'maxDelayMs' | 'multiplier' | 'jitterRatio' | 'freezeRetryHours', label: string, min: number, max: number, step = 1) =>
    <label className="nexus-setting-row"><span>{label}<small>来源：{source(key)} · 清空恢复继承</small></span>
      <input aria-label={label} type="number" min={min} max={max} step={step} value={draft.defaults?.[key] ?? options?.[key] ?? ''} placeholder={String(options?.[key] ?? '')}
        onChange={event => update(key, event.target.value === '' ? undefined : Number(event.target.value))} /></label>;
  return <form onSubmit={event => { event.preventDefault(); void save('configure'); }}>
    {settings.loading && <p role="status">正在读取重试设置…</p>}
    {Boolean(settings.error) && <ErrorMessage error={settings.error} retry={settings.reload} />}
    {Boolean(error) && <ErrorMessage error={error} retry={settings.reload} />}
    {settings.data && <fieldset disabled={busy || settings.loading}>
      <p>{labels[scope.level ?? 'global']} · 当前：{options ? modeLabels[options.mode] : '设置待修正'}</p>
      <label className="nexus-setting-row"><span>重试策略<small>全局→工作区→会话继承；主代理和子代理均按各自会话生效</small></span>
        <select aria-label="重试策略" value={draft.defaults?.mode ?? ''} onChange={event => update('mode', event.target.value || undefined)}>
          <option value="">继承上级 / 默认64次退避重试</option><option value="inherit">沿用提供方间隔</option><option value="custom">自定义退避重试</option><option value="disabled">关闭自动重试</option>
        </select></label>
      {options && options.mode !== 'disabled' && <>
        {numeric('maxRetries', '最大重试次数', 0, 100)}
        {options.mode === 'inherit' ? <p>间隔使用当前提供方的初始值、上限和随机抖动，按2倍指数退避；提供方未给出时使用默认值。次数仍由这里控制。</p> : <>
        <label className="nexus-setting-row"><span>间隔算法<small>来源：{source('algorithm')}</small></span>
          <select aria-label="重试间隔算法" value={draft.defaults?.algorithm ?? ''} onChange={event => update('algorithm', event.target.value || undefined)}>
            <option value="">继承 / 默认指数退避</option><option value="fixed">固定间隔</option><option value="linear">线性退避</option><option value="exponential">指数退避</option>
          </select></label>
        {numeric('initialDelayMs', '初始间隔（毫秒）', 0, 86_400_000)}
        {numeric('maxDelayMs', '间隔上限（毫秒）', 0, 86_400_000)}
        {options?.algorithm === 'exponential' && numeric('multiplier', '指数倍率', 1, 10, 0.1)}
        {numeric('jitterRatio', '随机抖动比例', 0, 1, 0.01)}
        {options && <p role="status">前{Math.min(5, options.maxRetries)}次间隔（未含抖动）：{Array.from({ length: Math.min(5, options.maxRetries) }, (_, index) => `${requestRetryDelay({ ...options!, jitterRatio: 0 }, index)! / 1000}秒`).join(' → ') || '不重试'}</p>}
        </>}
        {numeric('freezeRetryHours', '订阅限额冻结时长（小时）', 0, 168, 0.5)}
        <p>检测到订阅窗口、额度或限流错误时，会话会冻结这里设置的时长后再尝试；填0表示沿用提供方提示和普通退避。主代理与子代理按各自会话范围生效。</p>
        <p>主会话会关联一次性定时唤醒；宿主运行期间到点自动继续。停止会话可取消等待并清理关联任务。关闭宿主后，需要手动继续未完成的回合。</p>
        <p>所有失败的模型请求均按本策略重试，包括 PI_AI_ERROR 和流式异常。默认最多64次；用户或父任务取消会立即停止。</p>
        <p>服务端 Retry-After 优先，可超过算法间隔上限。每次重试重新校验权限和预算，已执行的工具不会重放。</p>
      </>}
      {invalid && <p role="alert">{invalid}</p>}
      <div className="nexus-actions"><Button primary type="submit" disabled={!dirty || Boolean(invalid)}>保存重试设置</Button>
        <Button type="button" disabled={!settings.data.local.revision} onClick={() => void save('reset')}>恢复继承</Button>
        <Button type="button" onClick={() => { setDirty(false); settings.reload(); }}>重新读取</Button></div>
    </fieldset>}
    {message && <p role="status">{message}</p>}
  </form>;
}
