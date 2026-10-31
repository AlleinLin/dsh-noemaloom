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
  const numeric = (key: 'maxRetries' | 'initialDelayMs' | 'maxDelayMs' | 'multiplier' | 'jitterRatio' | 'freezeRetryHours', label: string, min: number, max: number, step = 1, unit?: string) =>
    <label className="nexus-retry-field">
      <span className="nexus-retry-field-label"><strong>{label}</strong><small>来源：{source(key)} · 清空恢复继承</small></span>
      <span className="nexus-retry-input-wrap">
        <input aria-label={label} type="number" min={min} max={max} step={step} value={draft.defaults?.[key] ?? options?.[key] ?? ''} placeholder={String(options?.[key] ?? '')}
          onChange={event => update(key, event.target.value === '' ? undefined : Number(event.target.value))} />
        {unit && <em>{unit}</em>}
      </span>
    </label>;
  const mode = options?.mode;
  const effectiveScope = labels[scope.level ?? 'global'];
  return <form className="nexus-retry-form" onSubmit={event => { event.preventDefault(); void save('configure'); }}>
    {settings.loading && <p role="status">正在读取重试设置…</p>}
    {Boolean(settings.error) && <ErrorMessage error={settings.error} retry={settings.reload} />}
    {Boolean(error) && <ErrorMessage error={error} retry={settings.reload} />}
    {settings.data && <fieldset disabled={busy || settings.loading}>
      <div className="nexus-retry-overview">
        <div>
          <span className={`nexus-retry-status ${mode === 'disabled' ? 'is-off' : ''}`}>{mode === 'disabled' ? '已关闭' : '运行中'}</span>
          <h2>{mode ? modeLabels[mode] : '设置待修正'}</h2>
          <p>{effectiveScope}范围 · 主代理和子代理按各自会话生效</p>
        </div>
        {options && mode !== 'disabled' && <div className="nexus-retry-overview-value"><strong>{options.maxRetries}</strong><span>次最大重试</span></div>}
      </div>

      <section className="nexus-retry-section">
        <header className="nexus-retry-section-heading"><span className="nexus-retry-step">01</span><div><h3>失败后怎么重试</h3><p>先选择策略，再调整重试次数和等待节奏。</p></div></header>
        <div className="nexus-retry-grid nexus-retry-grid-primary">
          <label className="nexus-retry-field">
            <span className="nexus-retry-field-label"><strong>重试策略</strong><small>全局 → 工作区 → 会话继承</small></span>
            <select aria-label="重试策略" value={draft.defaults?.mode ?? ''} onChange={event => update('mode', event.target.value || undefined)}>
              <option value="">继承上级 / 默认退避</option><option value="inherit">沿用提供方间隔</option><option value="custom">自定义退避重试</option><option value="disabled">关闭自动重试</option>
            </select>
          </label>
          {options && mode !== 'disabled' && numeric('maxRetries', '最大重试次数', 0, 100, 1, '次')}
        </div>
        {options && mode !== 'disabled' && <>
          {mode === 'inherit' ? <div className="nexus-retry-note"><strong>使用提供方的等待节奏</strong><span>提供方未给出时间时，使用默认指数退避。重试次数仍由上方设置控制。</span></div> : <div className="nexus-retry-subsection">
            <div className="nexus-retry-subsection-title">等待节奏 <small>来源：{source('algorithm')}</small></div>
            <div className="nexus-retry-grid">
              <label className="nexus-retry-field">
                <span className="nexus-retry-field-label"><strong>间隔算法</strong><small>固定、线性或指数</small></span>
                <select aria-label="重试间隔算法" value={draft.defaults?.algorithm ?? ''} onChange={event => update('algorithm', event.target.value || undefined)}>
                  <option value="">继承 / 默认指数退避</option><option value="fixed">固定间隔</option><option value="linear">线性退避</option><option value="exponential">指数退避</option>
                </select>
              </label>
              {numeric('initialDelayMs', '首次等待', 0, 86_400_000, 1, '毫秒')}
              {numeric('maxDelayMs', '最长等待', 0, 86_400_000, 1, '毫秒')}
              {mode && options.algorithm === 'exponential' && numeric('multiplier', '指数倍率', 1, 10, 0.1, '×')}
              {numeric('jitterRatio', '随机抖动', 0, 1, 0.01)}
            </div>
            {options && <p className="nexus-retry-timeline" role="status"><span>预览</span>{Array.from({ length: Math.min(5, options.maxRetries) }, (_, index) => `${requestRetryDelay({ ...options!, jitterRatio: 0 }, index)! / 1000}秒`).join('  →  ') || '不重试'}</p>}
          </div>}
        </>}
      </section>

      {options && mode !== 'disabled' && <section className="nexus-retry-section nexus-retry-freeze-section">
        <header className="nexus-retry-section-heading"><span className="nexus-retry-step">02</span><div><h3>订阅额度冻结</h3><p>遇到订阅窗口或限流时，先暂停一段时间再继续。</p></div></header>
        <div className="nexus-retry-freeze-control">
          <div><strong>冻结时长</strong><span>只对订阅、额度不足和限流错误生效</span></div>
          <label className="nexus-retry-freeze-input"><input aria-label="订阅限额冻结时长（小时）" type="number" min={0} max={168} step={0.5} value={draft.defaults?.freezeRetryHours ?? options.freezeRetryHours ?? ''} placeholder={String(options.freezeRetryHours ?? 0)} onChange={event => update('freezeRetryHours', event.target.value === '' ? undefined : Number(event.target.value))} /><em>小时</em></label>
        </div>
        <div className="nexus-retry-freeze-hint"><span>提示</span><p>填 0 表示沿用服务商提示和普通退避。主代理会登记一次性定时唤醒；子代理在宿主不接受定时任务时自动使用可取消计时器。</p></div>
      </section>}

      {options && mode === 'disabled' && <div className="nexus-retry-disabled-note"><strong>自动重试已关闭</strong><span>开启重试策略后，才能使用冻结时长和定时唤醒。</span></div>}

      <section className="nexus-retry-section nexus-retry-rules-section">
        <header className="nexus-retry-section-heading"><span className="nexus-retry-step">{mode === 'disabled' ? '02' : '03'}</span><div><h3>运行规则</h3><p>系统会保留原请求边界，不重复执行已经完成的工具。</p></div></header>
        <div className="nexus-retry-rule-list">
          <div><strong>服务商提示优先</strong><span>Retry-After 较长时，以服务商给出的等待时间为准。</span></div>
          <div><strong>取消立即生效</strong><span>用户、父任务取消或关闭会话都会停止等待。</span></div>
        </div>
      </section>

      {invalid && <p role="alert">{invalid}</p>}
      <div className="nexus-retry-actions"><span>{message || '修改后保存，新的请求会使用最新策略。'}</span><div><Button primary type="submit" disabled={!dirty || Boolean(invalid)}>保存设置</Button>
        <Button type="button" disabled={!settings.data.local.revision} onClick={() => void save('reset')}>恢复继承</Button>
        <Button type="button" onClick={() => { setDirty(false); settings.reload(); }}>重新读取</Button></div></div>
    </fieldset>}
    {message && <p className="nexus-retry-saved" role="status">{message}</p>}
  </form>;
}
