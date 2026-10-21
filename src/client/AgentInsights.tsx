import * as React from 'react';
import { createNexusApi, errorData } from './transport.js';
import type { ClientContext, Data, NexusApi, NexusScope } from './types.js';
import { AutonomyPlan } from './AutonomyPlan.js';
import { AuxiliarySettings } from './AuxiliarySettings.js';
import styles from './agent-insights.css';

const empty = {};
const FactsContext = React.createContext<{ ctx?: any; insights: Record<string, Data>; projections: Data; api?: NexusApi }>({ insights: empty, projections: empty });
const labels: Record<string, string> = { system: '系统', tools: '工具定义', user: '用户', inject: '注入', skill: '技能', assistant: '助手', tool: '工具结果' };
const colors = ['#a7866c', '#bc9062', '#74958b', '#b58aaa', '#8595ac', '#c98069', '#8c9c69'];
function subscribeConnection(ctx: ClientContext, api: NexusApi) {
  const source = ctx.connection.generation;
  let previous = source?.getSnapshot()?.id;
  return source?.subscribe(() => {
    const next = source?.getSnapshot()?.id;
    if (next !== previous) { previous = next; api.reset(); }
  });
}
/** Mirrors Context's current-pressure calibration; billed usage stays separate. */
export function agentContextMetrics(values: Data) {
  const head = values.contextTimeline, pressure = values.contextPressure, breakdown = values.contextBreakdown;
  const current = head?.current;
  if (!current) return undefined;
  const last = head.last ?? head.requests?.at(-1);
  const tokens = Math.max(0, pressure?.projectedTokens ?? pressure?.pressureTokens
    ?? (Number.isFinite(last?.prompt) ? last.prompt + current.total - last.total : current.total));
  const window = pressure?.contextWindow ?? head.contextWindow;
  const messageTotal = ['user', 'inject', 'skill', 'assistant', 'tool'].reduce((sum, key) => sum + (current[key] ?? 0), 0);
  const parts = Object.keys(labels).map((key, index) => ({ key, label: labels[key], color: colors[index],
    value: key === 'system' ? breakdown?.systemTokens ?? current.system ?? 0
      : key === 'tools' ? breakdown?.toolsTokens ?? current.tools ?? 0
      : messageTotal > 0 ? (breakdown?.messageTokens ?? messageTotal) * (current[key] ?? 0) / messageTotal : 0 }));
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  const billed = values.tokenUsage;
  return { tokens, window, percent: window > 0 ? Math.min(100, Math.round(tokens / window * 1000) / 10) : undefined,
    parts: parts.map(part => ({ ...part, value: total > 0 ? part.value * tokens / total : 0 })),
    billed: billed ? billed.uncachedInputTokens + billed.cacheReadTokens + billed.cacheWriteTokens + billed.outputTokens : undefined };
}
const number = (value: number) => new Intl.NumberFormat('zh-CN', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);

export function AgentInsightsProvider({ ctx, sessionId, active = true, children }: { ctx: any; sessionId: string; active?: boolean; children: React.ReactNode }) {
  const list = React.useSyncExternalStore(React.useCallback(fn => ctx.sessions.list.subscribe(fn), [ctx]), React.useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]));
  let root = sessionId;
  const seen = new Set<string>();
  while (list.byId?.[root]?.origin === 'subagent' && list.byId[root].parentId && !seen.has(root)) { seen.add(root); root = list.byId[root].parentId; }
  const api = React.useMemo(() => createNexusApi(ctx), [ctx]);
  const [insights, setInsights] = React.useState<Record<string, Data>>(empty);
  React.useEffect(() => {
    const stop = subscribeConnection(ctx, api);
    return () => { stop?.(); api.dispose(); };
  }, [api, ctx]);
  React.useEffect(() => {
    setInsights(empty);
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result: Data = await api.call('insights', 'list', { tree: true }, { scope: { level: 'session', sessionId: root }, signal: controller.signal });
        if (!controller.signal.aborted) setInsights(old => {
          const next = Object.fromEntries((result.items ?? []).map((item: Data) => [item.sessionId, item]));
          return JSON.stringify(old) === JSON.stringify(next) ? old : next;
        });
      } catch { /* Keep the last committed summary while reconnecting. */ }
      if (!controller.signal.aborted) timer = setTimeout(poll, 8000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, root, active]);
  return <FactsContext.Provider value={{ ctx, api, insights, projections: list.projectionsBySession ?? empty }}><style>{styles}</style>{children}</FactsContext.Provider>;
}
export function AgentFacts({ node, compact = false }: { node: Data; compact?: boolean }) {
  const { insights, projections, api } = React.useContext(FactsContext);
  const [open, setOpen] = React.useState(false);
  const metrics = agentContextMetrics(projections[node.id]?.values ?? {});
  const insight = insights[node.id], summary = insight?.summary;
  const full = [summary?.goal && `目标：${summary.goal}`, summary?.currentWork && `当前：${summary.currentWork}`, summary?.nextStep && `建议：${summary.nextStep}`].filter(Boolean).join('\n');
  return <span className="nexus-agent-facts" data-nexus-agent-facts={node.id} style={{ '--agent-line': colors[node.depth % colors.length] } as React.CSSProperties}>
    <span className="nexus-agent-context">{metrics ? <>上下文 {number(metrics.tokens)}{metrics.window > 0 ? ` / ${number(metrics.window)} · ${metrics.percent}%` : ' · 窗口未知'}</> : '上下文未报告'}</span>
    <span className="nexus-agent-stack" title={metrics?.parts.map(part => `${part.label} ≈${Math.round(part.value)}`).join('\n')} aria-label="当前上下文构成">
      {metrics?.parts.filter(p => p.value > 0).map(p => <span key={p.key} style={{ background: p.color, flex: p.value }} />)}
    </span>
    {!compact && <span className="nexus-agent-goal" title={full}>{summary?.goal ? `目标 · ${summary.goal}` : node.tasks?.length ? `任务 · ${node.tasks[0].subject}` : '目标待分析'}</span>}
    <button className="nexus-agent-suggestion" title={full || '任务规划与上下文'} onClick={event => { event.stopPropagation(); setOpen(true); }}>{compact ? '规划与上下文' : summary?.nextStep ? `建议 · ${summary.nextStep}` : '规划与上下文'}</button>
    {open && api && <span className="nexus-insight-backdrop" onClick={event => { event.stopPropagation(); setOpen(false); }}><span role="dialog" aria-modal="true" aria-label="代理任务与上下文" className="nexus-insight-dialog" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}>
      <button className="nexus-insight-close" onClick={() => setOpen(false)} aria-label="关闭">×</button>
      <strong>{node.label}</strong><span>宿主状态 · {node.state}</span>
      {metrics && <span>当前上下文 ≈{number(metrics.tokens)} / {metrics.window > 0 ? number(metrics.window) : '未知'}{metrics.percent === undefined ? '' : ` · ${metrics.percent}%`}{metrics.billed === undefined ? '' : `　累计消耗 ${number(metrics.billed)}`}</span>}
      {metrics && <span className="nexus-context-legend">{metrics.parts.map(p => <span key={p.key}><i style={{ background: p.color }} />{p.label} ≈{number(p.value)}</span>)}</span>}
      <TaskInsights api={api} scope={{ level: 'session', sessionId: node.id }} />
    </span></span>}
  </span>;
}

export function TaskInsights({ api, scope, openSession }: { api: NexusApi; scope: NexusScope; openSession?(sessionId: string): void }) {
  const [value, setValue] = React.useState<Data>();
  const [config, setConfig] = React.useState<Data>();
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState({ goal: '', currentWork: '', nextStep: '' });
  const [route, setRoute] = React.useState({ provider: '', model: '', maxCallsPerDay: 24 });
  const scopeKey = JSON.stringify(scope);
  const load = React.useCallback(async (signal?: AbortSignal) => {
    const [result, settings] = await Promise.all([api.call(scope.level === 'session' ? 'insights' : 'insights', scope.level === 'session' ? 'get' : 'list', {}, { scope, signal }), api.call('insights', 'settings', {}, { scope, signal })]);
    if (signal?.aborted) return;
    setValue(result); setConfig(settings);
    setRoute({ provider: settings.provider ?? '', model: settings.model ?? '', maxCallsPerDay: settings.maxCallsPerDay });
  }, [api, scopeKey]);
  React.useEffect(() => {
    const c = new AbortController(); setValue(undefined); setError('');
    void load(c.signal).catch(e => { if (!c.signal.aborted) setError(errorData(e).message); });
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void api.call('insights', scope.level === 'session' ? 'get' : 'list', {}, { scope, signal: c.signal })
        .then(result => { if (!c.signal.aborted) setValue(old => JSON.stringify(old) === JSON.stringify(result) ? old : result); }).catch(() => {});
    }, 8000);
    return () => { c.abort(); clearInterval(timer); };
  }, [load]);
  const act = async (action: () => Promise<any>) => { setBusy(true); setError(''); try { await action(); await load(); } catch (e) { setError(errorData(e).message); } finally { setBusy(false); } };
  const configure = (automatic: boolean) => api.call('scope', 'configure', { feature: 'insights', config: { ...config?.local?.config, enabled: true, defaults: { ...config?.local?.config?.defaults, automatic, maxCallsPerDay: route.maxCallsPerDay } } }, { scope, revision: config?.local?.revision ?? 0, mutating: true });
  const renderSummary = (item: Data) => {
    const s = item.summary;
    return <div className="nexus-insight-summary" key={item.sessionId}><small>{scope.level !== 'session' ? `${item.sessionId} · ` : ''}{item.source === 'model-and-user' ? '人工覆盖 · 模型推断' : '模型推断'} · {item.state === 'ready' ? '已更新' : item.state === 'started' ? '调用结果待核实' : item.state === 'empty' ? '待分析' : item.state}{item.throughSeq >= 0 ? ` · #${item.throughSeq}` : ''}</small>
      {s?.goal && <p><b>目标</b>{s.goal}</p>}{s?.currentWork && <p><b>当前</b>{s.currentWork}</p>}
      {s?.plan?.length > 0 && <ol>{s.plan.map((step: string, index: number) => <li key={index}>{step}</li>)}</ol>}
      {s?.nextStep && <p><b>下一步建议</b>{s.nextStep}</p>}
      {s?.blockers?.length > 0 && <p><b>阻塞</b>{s.blockers.join('；')}</p>}
      {s?.evidenceRefs?.length > 0 && <small>依据 {s.evidenceRefs.map((ref: number) => `#${ref}`).join('、')}</small>}
      {item.errorCode && <small>{item.errorCode} · 需显式重试</small>}
    </div>;
  };
  return <><AutonomyPlan api={api} scope={scope} openSession={openSession} /><section className="nexus-task-insights"><style>{styles}</style><div className="nexus-insight-toolbar"><strong>任务观察</strong><label><input type="checkbox" checked={config?.automatic ?? false} disabled={busy || !config} onChange={e => void act(() => configure(e.target.checked))} />自动分析</label><button disabled={busy} onClick={() => void act(() => load())}>刷新</button>
    {scope.level === 'session' && <><button disabled={busy} onClick={() => void act(() => api.call('insights', 'analyze', { retry: ['failed', 'unreported', 'started'].includes(value?.state) }, { scope, mutating: true }))}>{busy ? '处理中…' : '分析'}</button><button disabled={busy} onClick={() => { setDraft({ goal: value?.summary?.goal ?? '', currentWork: value?.summary?.currentWork ?? '', nextStep: value?.summary?.nextStep ?? '' }); setEditing(!editing); }}>编辑</button></>}
  </div>
    {error && <p role="alert">{error}</p>}{value && (scope.level === 'session' ? renderSummary(value) : (value.items ?? []).map(renderSummary))}
    {editing && <form onSubmit={e => { e.preventDefault(); void act(async () => { await api.call('insights', 'edit', { manual: draft }, { scope, mutating: true, revision: value?.revision ?? 0 }); setEditing(false); }); }}>{(['goal', 'currentWork', 'nextStep'] as const).map((key, i) => <label key={key}>{['目标', '当前工作', '下一步建议'][i]}<textarea rows={2} maxLength={2400} value={draft[key]} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))} /></label>)}<button disabled={busy}>保存</button><button type="button" disabled={busy} onClick={() => void act(() => api.call('insights', 'edit', { manual: null }, { scope, mutating: true, revision: value?.revision ?? 0 }))}>恢复模型建议</button></form>}
    <details><summary>分析设置</summary><label>每会话每日观察上限<input type="number" min="1" max="100" value={route.maxCallsPerDay} onChange={e => setRoute(r => ({ ...r, maxCallsPerDay: Number(e.target.value) }))} /></label><button disabled={busy} onClick={() => void act(() => configure(config?.automatic ?? true))}>保存观察设置</button><AuxiliarySettings api={api} scope={scope} scoped /></details>
  </section></>;
}

/** Integrate with the original board rather than replacing its page/controller. */
export function NativeTaskInsights({ ctx, children }: { ctx: ClientContext; children: React.ReactNode }) {
  const host = ctx as any;
  const selection = React.useSyncExternalStore(React.useCallback(fn => host.uiWorkspace.selection.subscribe(fn), [host]),
    React.useCallback(() => host.uiWorkspace.selection.getSnapshot(), [host]));
  const workspaces = React.useSyncExternalStore(React.useCallback(fn => host.workspaces.list.subscribe(fn), [host]),
    React.useCallback(() => host.workspaces.list.getSnapshot(), [host]));
  const [level, setLevel] = React.useState<'global' | 'workspace' | 'session'>('session');
  const [expanded, setExpanded] = React.useState(false);
  const api = React.useMemo(() => createNexusApi(ctx), [ctx]);
  React.useEffect(() => {
    const stop = subscribeConnection(ctx, api);
    return () => { stop?.(); api.dispose(); };
  }, [api, ctx]);
  const workspace = workspaces.items?.find((item: Data) => item.sessionIds?.includes(selection.sessionId));
  const scope: NexusScope = level === 'global' ? { level } : level === 'workspace' ? { level, workspaceId: workspace?.workspaceId } : { level, sessionId: selection.sessionId };
  const available = level === 'global' || level === 'session' && selection.sessionId || level === 'workspace' && workspace;
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
    <div style={{ padding: '8px 16px', flex: 'none', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
      <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer' }}>任务规划 {expanded ? '▾' : '▸'}</button>
      <select aria-label="规划范围" value={level} onChange={e => setLevel(e.target.value as typeof level)} style={{ marginLeft: 12, background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6 }}><option value="global">全局</option><option value="workspace">当前工作区</option><option value="session">当前会话</option></select>
      {expanded && <div style={{ maxHeight: 'min(60vh, 640px)', overflow: 'auto' }}>{available ? <TaskInsights key={JSON.stringify(scope)} api={api} scope={scope} openSession={id => host.uiWorkspace.openSession(id)} /> : <p>请选择{level === 'session' ? '会话' : '工作区'}</p>}</div>}
    </div>
    <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
  </div>;
}
