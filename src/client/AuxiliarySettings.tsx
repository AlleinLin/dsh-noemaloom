import * as React from 'react';
import type { Data, NexusApi, NexusScope } from './types.js';
import { ClientError, errorData } from './transport.js';
import { Icon } from './components.js';
import styles from './companion.css';
import { REFLECTION_SYSTEM } from '../domain/insights/prompts.js';
import { auxiliaryReadReport, createAuxiliarySettingsReader, type AuxiliaryReadKind, type AuxiliaryReadState } from './auxiliary-settings-reader.js';
import { boundedRead } from '../shared/bounded-read.js';

const scopeLabel = { global: '全局', workspace: '工作区', session: '会话' };
function useAuxiliaryRead(api: NexusApi, kind: AuxiliaryReadKind, scope: NexusScope, generation: number, enabled = true) {
  const identity = JSON.stringify(scope);
  const reader = React.useMemo(() => createAuxiliarySettingsReader(api, kind, scope), [api, kind, identity, generation]);
  const state = React.useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  React.useEffect(() => {
    if (enabled) void reader.read();
    return () => reader.cancel();
  }, [reader, enabled]);
  return { ...state, retry: reader.read };
}
function AuxiliaryReadError({ state, kind, retry, catalogState }: {
  state: AuxiliaryReadState; kind: AuxiliaryReadKind; retry: () => Promise<unknown>; catalogState?: string;
}) {
  if (state.state !== 'error') return null;
  const label = { settings: '辅助设置', catalog: '辅助模型目录', workspaces: '辅助设置工作区' }[kind];
  const report = auxiliaryReadReport(state, catalogState);
  return <div>
    <p role="alert">[{state.diagnostic?.code}] {state.message}</p>
    <button aria-label={`重试读取${label}`} onClick={() => void retry()}>重试读取{label}</button>
    <details data-nexus-auxiliary-diagnostic={kind}><summary>读取诊断</summary><pre>{report}</pre>
      <button aria-label="复制辅助设置诊断" onClick={() => { void navigator.clipboard?.writeText(report).catch(() => {}); }}>复制诊断</button>
    </details>
  </div>;
}
export function AuxiliarySettings({ api, scope = { level: 'global' }, scoped = false, onSaved }: { api: NexusApi; scope?: NexusScope; scoped?: boolean; onSaved?: () => void }) {
  const [level, setLevel] = React.useState(scope.level ?? 'global');
  const [workspaceId, setWorkspaceId] = React.useState(scope.workspaceId ?? '');
  const [sessionId, setSessionId] = React.useState(scope.sessionId ?? '');
  const generation = React.useSyncExternalStore(api.subscribe, api.getGeneration, api.getGeneration);
  const workspaceRead = useAuxiliaryRead(api, 'workspaces', { level: 'global' }, generation, !scoped);
  const workspaces: Data[] = workspaceRead.value?.items ?? [];
  const selected: NexusScope = scoped ? scope : level === 'global' ? { level } : level === 'workspace' ? { level, workspaceId } : { level, workspaceId: workspaceId || undefined, sessionId };
  const identity = JSON.stringify(selected), available = selected.level === 'global' || selected.level === 'workspace' && selected.workspaceId || selected.level === 'session' && selected.sessionId;
  const sessions: string[] = (workspaceId ? workspaces.filter(w => w.id === workspaceId || w.workspaceId === workspaceId) : workspaces).flatMap(w => w.sessionIds ?? []);
  return <section className="nexus-aux-settings" data-nexus-auxiliary-settings="">
    <style>{styles}</style>
    {!scoped && <>
      <div className="nexus-aux-scope"><select aria-label="辅助设置作用域" value={level} onChange={e => setLevel(e.target.value as typeof level)}>
        <option value="global">全局</option><option value="workspace">工作区</option><option value="session">会话</option></select>
        {level !== 'global' && <select aria-label="辅助设置工作区" value={workspaceId} onChange={e => { setWorkspaceId(e.target.value); setSessionId(''); }}><option value="">选择工作区</option>{workspaces.map(w => <option value={w.id ?? w.workspaceId} key={w.id ?? w.workspaceId}>{w.title ?? w.name ?? w.path}</option>)}</select>}
        {level === 'session' && <select aria-label="辅助设置会话" value={sessionId} onChange={e => setSessionId(e.target.value)}><option value="">选择会话</option>{sessions.map(id => <option key={id} value={id}>{id}</option>)}</select>}
      </div>
      {level !== 'global' && workspaceRead.state === 'loading' && <p role="status">正在读取工作区与会话…</p>}
      <AuxiliaryReadError state={workspaceRead} kind="workspaces" retry={workspaceRead.retry} />
    </>}
    {!available ? <p>请选择{selected.level === 'session' ? '会话' : '工作区'}</p>
      : <AuxiliarySettingsForm key={`${identity}:${generation}`} api={api} scope={selected} generation={generation} onSaved={onSaved} />}
  </section>;
}
function AuxiliarySettingsForm({ api, scope: selected, generation, onSaved }: { api: NexusApi; scope: NexusScope; generation: number; onSaved?: () => void }) {
  const settings = useAuxiliaryRead(api, 'settings', selected, generation);
  // Model enumeration has its own request, deadline, failure and retry. It
  // never owns the saved settings or the user's editable route priority.
  const directory = useAuxiliaryRead(api, 'catalog', selected, generation);
  const value = settings.value;
  const [local, setLocal] = React.useState<Data>({});
  const [enabled, setEnabled] = React.useState<boolean | undefined>();
  const [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false);
  const [add, setAdd] = React.useState(''), [drag, setDrag] = React.useState<number>();
  const lifetime = React.useRef<AbortController | undefined>(undefined);
  React.useEffect(() => {
    const c = new AbortController(); lifetime.current = c;
    return () => { c.abort(); if (lifetime.current === c) lifetime.current = undefined; };
  }, [api]);
  React.useEffect(() => {
    if (value) { setLocal(value.local.config.defaults ?? {}); setEnabled(value.local.config.enabled); setAdd(''); }
  }, [value]);
  const act = async (action: 'configure' | 'reset') => {
    const signal = lifetime.current?.signal; if (!signal || signal.aborted || busy || settings.state !== 'ready') return;
    setBusy(true); setError('');
    try {
      await boundedRead(writeSignal => api.call('scope', action, { feature: 'auxiliary', ...(action === 'configure' ? { config: { ...(enabled === undefined ? {} : { enabled }), defaults: local } } : {}) },
        { scope: selected, mutating: true, revision: value?.local?.revision ?? 0, signal: writeSignal }), {
        signal, timeoutMs: 15000,
        timeout: () => new ClientError('nexus/auxiliary-write-timeout', '辅助设置保存超过15秒，结果尚未确认；请先重新读取已保存设置再继续编辑'),
        cancelled: () => new ClientError('nexus/cancelled', '操作已取消'),
      });
      if (signal.aborted) return;
      const loaded = await settings.retry();
      if (loaded && !signal.aborted) onSaved?.();
    } catch (e) { if (!signal.aborted) { const failure = errorData(e); setError(`[${failure.code}] ${failure.message}`); } }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const set = (key: string, data: any) => setLocal(old => ({ ...old, [key]: data }));
  const routes: Data[] = local.routes ?? value?.routes ?? [];
  const catalog: Data[] = directory.value?.items ?? [];
  const move = (from: number, to: number) => {
    if (to < 0 || to >= routes.length || from === to) return;
    const next = [...routes], [route] = next.splice(from, 1); next.splice(to, 0, route); set('routes', next);
  };
  const numberField = (key: string, label: string, min: number, max: number) => <label className="nexus-aux-number" key={key}>{label}<input type="number" min={min} max={max} value={local[key] ?? value?.[key] ?? min} onChange={e => set(key, Number(e.target.value))} /><small>{local[key] === undefined ? '继承' : '本层覆盖'}</small></label>;
  return <>
    <AuxiliaryReadError state={settings} kind="settings" retry={settings.retry} catalogState={directory.state} />
    {settings.state === 'loading' && <p role="status">正在读取辅助设置…</p>}
    {directory.state === 'loading' && <p role="status">正在读取辅助模型目录；已保存的模型优先级继续显示…</p>}
    <AuxiliaryReadError state={directory} kind="catalog" retry={directory.retry} catalogState={directory.state} />
    {error && <div><p role="alert">{error}</p><button aria-label="重新读取已保存辅助设置" disabled={busy || settings.state === 'loading'} onClick={() => { setError(''); void settings.retry(); }}>重新读取已保存设置</button></div>}
    {value && <>
      <p className="nexus-aux-source">{scopeLabel[selected.level ?? 'global']} · r{value.local?.revision ?? 0} · {value.local?.revision ? '存在本层覆盖' : '继承父级'}{value.legacySources?.length > 0 ? ` · 沿用旧显式路由：${value.legacySources.join('、')}` : ''}</p>
      <label><input type="checkbox" checked={enabled ?? value.enabled} onChange={e => setEnabled(e.target.checked)} />启用独立辅助机制</label>
      <div className="nexus-aux-toggles">{[['suggestions', 'You should know 提示'], ['reflection', '规划前与 review 深层问题'], ['planningPrompt', '调研完成后的四问确认']].map(([key, label]) => <label key={key}><input type="checkbox" checked={local[key] ?? value[key]} onChange={e => set(key, e.target.checked)} />{label}<small>{local[key] === undefined ? '继承' : '本层覆盖'}</small></label>)}</div>
      <details><summary>规划前与 review 系统提示词</summary><label>深层问题系统提示词<textarea data-nexus-reflection-system="" rows={6} maxLength={8000} value={local.reflectionSystem ?? value.reflectionSystem} onChange={e => set('reflectionSystem', e.target.value)} /></label><small>{local.reflectionSystem === undefined ? '继承' : '本层覆盖'}</small><div className="nexus-companion-actions"><button onClick={() => setLocal(old => { const next = { ...old }; delete next.reflectionSystem; return next; })}>恢复提示词继承</button><button onClick={() => set('reflectionSystem', REFLECTION_SYSTEM)}>使用默认提示词</button></div></details>
      <h3>辅助模型优先级</h3>
      <ol className="nexus-aux-routes" data-nexus-auxiliary-routes="">{routes.map((route, index) => {
        const item = catalog.find(c => c.provider === route.provider && c.model === route.model);
        return <li key={`${route.provider}/${route.model}`} data-nexus-auxiliary-model-row="" draggable={!busy} onDragStart={e => { setDrag(index); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(index)); }} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (drag !== undefined) move(drag, index); setDrag(undefined); }} onDragEnd={() => setDrag(undefined)}>
          <span className="nexus-aux-grip" data-nexus-sort-grip="" title="拖动调整优先级"><Icon name="grid" size={15} /></span><span className="nexus-aux-route-name">{index + 1}. {route.provider}/{route.model}{directory.state === 'ready' && !item && <small role="alert">目录未列出此模型；保留已保存优先级</small>}</span>
          <select aria-label={`模型 ${index + 1} reasoning_effort`} value={route.reasoningEffort ?? ''} disabled={busy || directory.state !== 'ready' || !item?.reasoningKnown} onChange={e => set('routes', routes.map((r, i) => i === index ? { provider: r.provider, model: r.model, ...(e.target.value ? { reasoningEffort: e.target.value } : {}) } : r))}>
            <option value="">最高支持值{item?.highest ? `（${item.highest}）` : item?.reasoningKnown ? '（不支持，不发送）' : '（元数据未知）'}</option>{(item?.efforts ?? []).map((effort: string) => <option key={effort}>{effort}</option>)}
            {route.reasoningEffort && !item?.efforts?.includes(route.reasoningEffort) && <option value={route.reasoningEffort}>{route.reasoningEffort}（已保存）</option>}
          </select>
          <button title="提高优先级" aria-label="提高优先级" disabled={index === 0 || busy} onClick={() => move(index, index - 1)}><Icon name="arrow" size={15} /></button>
          <button title="降低优先级" aria-label="降低优先级" disabled={index === routes.length - 1 || busy} onClick={() => move(index, index + 1)}><Icon name="down" size={15} /></button>
          <button title="移除模型" aria-label="移除模型" disabled={busy} onClick={() => set('routes', routes.filter((_, i) => i !== index))}><Icon name="close" size={15} /></button>
        </li>;
      })}</ol>
      {!routes.length && <p role="status">尚未配置辅助模型，主任务照常运行。</p>}
      <div className="nexus-aux-add"><select aria-label="选择真实辅助模型" value={add} disabled={busy || directory.state !== 'ready'} onChange={e => setAdd(e.target.value)}><option value="">选择宿主可用模型…</option>{catalog.filter(c => !routes.some(r => r.provider === c.provider && r.model === c.model)).map(c => <option key={c.code} value={c.code} disabled={!c.reasoningKnown}>{c.code}{!c.reasoningKnown ? ' · 元数据不可用' : ''}</option>)}</select>
        <button disabled={!add || routes.length >= 12 || busy || directory.state !== 'ready'} onClick={() => { const c = catalog.find(item => item.code === add); if (c) set('routes', [...routes, { provider: c.provider, model: c.model }]); setAdd(''); }}>添加模型</button></div>
      <small>独立请求无工具。按优先级逐项退避，失败原因与降级显示在会话中。reasoning_effort 留空使用官方元数据中的最高支持强度。不支持该字段的模型不会发送。目录不证明凭据有效。</small>
      <details><summary>上下文与调用预算</summary><div className="nexus-aux-budgets">
        {numberField('maxCallsPerDay', '每会话每日实际请求上限', 1, 200)}
        {numberField('minIntervalMs', '周期检查间隔（毫秒）', 10000, 3600000)}
        {numberField('maxInputTokens', '单次输入保守 token 预算', 4000, 1000000)}
        {numberField('maxContextChars', '完整材料总字符上限', 20000, 4000000)}
        {numberField('maxChunks', '最多上下文分段', 1, 128)}
        {numberField('maxOutputTokens', '单次输出 token 上限（含思考）', 512, 65536)}
        {numberField('retentionDays', '近期提示与已知主题保留天数', 1, 365)}
      </div><small>输出预算包含模型思考消耗，最高强度默认 32768；实际请求同时受所选模型公布的输出额度约束。耗尽预算的回答会标为失败，不能作为完整审阅。已保存的本层与继承预算继续生效。</small></details>
      <div className="nexus-aux-save"><button disabled={busy || settings.state !== 'ready'} onClick={() => void act('configure')}>{busy ? '处理中…' : '保存本层设置'}</button><button disabled={busy || settings.state !== 'ready' || !value.local?.revision} onClick={() => void act('reset')}>恢复继承</button></div>
    </>}
  </>;
}
