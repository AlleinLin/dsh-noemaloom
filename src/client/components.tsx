import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import type { ActionDraft, Data, DomainDefinition, Inspection, NexusApi, RpcOptions, ViewContext } from './types.js';
import { isRecord, textOf, titleOf, idOf } from './types.js';
import { capability, fieldLabels, labelAction, seedParams } from './catalog.js';
import { errorData } from './transport.js';
import { resolveDetailRead } from './detail-read.js';
import { localizedText } from './localized-text.js';
import { getLanguage, subscribeLanguage } from './i18n.js';

export function useDescriptorLocale() { return React.useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage); }

const paths: Record<string, string> = {
  menu: 'M4 6h16M4 12h16M4 18h16', plus: 'M12 5v14M5 12h14', close: 'm6 6 12 12M18 6 6 18', arrow: 'M12 19V5m-6 6 6-6 6 6',
  chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 2V11.5a9 9 0 1 1 18 0Z', folder: 'M3 6h7l2 2h9v12H3ZM3 8V4h7l2 2',
  file: 'M6 3h8l4 4v14H6ZM14 3v5h5M9 12h6M9 16h6', branch: 'M6 3v12a5 5 0 0 0 5 5h7M6 8h7a5 5 0 0 0 5-5M3 3h6M15 20h6',
  check: 'm4 12 5 5L20 6', memory: 'M9 3a4 4 0 0 0-4 4v1a4 4 0 0 0-2 7 4 4 0 0 0 6 5V3Zm6 0a4 4 0 0 1 4 4v1a4 4 0 0 1 2 7 4 4 0 0 1-6 5V3Z',
  book: 'M12 5C9 3 5 3 2 4v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-3-1-7-1-10 1v15',
  graph: 'M5 5h5v5H5ZM15 15h5v5h-5ZM3 16h5v5H3ZM15 3h6v6h-6ZM10 7h5M7 10v6M17 9v6M8 18h7',
  layers: 'm3 8 9-5 9 5-9 5Zm0 5 9 5 9-5M3 18l9 5 9-5', gauge: 'M3 18a10 10 0 1 1 18 0M12 13l5-6M5 15h2M17 15h2M12 5v2',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6Zm-4 9 3 3 5-6', code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  history: 'M3 10a9 9 0 1 1 0 6M3 4v6h6M12 7v5l4 3', link: 'm9 8 3-3a5 5 0 0 1 7 7l-3 3M15 16l-3 3a5 5 0 0 1-7-7l3-3m0 6 8-8',
  grid: 'M3 3h7v7H3Zm11 0h7v7h-7ZM3 14h7v7H3Zm11 0h7v7h-7Z', chart: 'M4 3v17h17M8 16v-5m5 5V7m5 9V4',
  search: 'M15.5 15.5 21 21M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z', settings: 'm9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Zm7 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  chevron: 'm9 5 7 7-7 7', down: 'm5 9 7 7 7-7', refresh: 'M20 7a9 9 0 1 0 1 8M20 3v5h-5', terminal: 'm4 5 7 7-7 7m9 0h7',
  download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4', copy: 'M8 8h13v13H8ZM16 8V3H3v13h5',
  info: 'M12 10v7M12 7h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z', error: 'M12 8v5M12 17h.01M12 3 2 21h20Z',
  play: 'm7 3 15 9-15 9Z', stop: 'M5 5h14v14H5Z', pin: 'm8 3 8 0-1 7 4 4H5l4-4Zm4 11v8', sun: 'M12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z',
};
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return <svg className="nexus-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.file} /></svg>;
}
export function Button({ children, icon, primary, busy, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: string; primary?: boolean; busy?: boolean }) {
  return <button {...props} className={`nexus-button ${primary ? 'is-primary' : ''} ${props.className ?? ''}`} disabled={props.disabled || busy} aria-busy={busy || undefined}>{icon && <Icon name={icon} size={16} />}{children}{busy && <span className="nexus-busy-dot" aria-label="处理中" />}</button>;
}
export function IconButton({ name, label, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { name: string; label: string }) {
  return <button {...props} className={`nexus-icon-button ${props.className ?? ''}`} aria-label={label} title={label}><Icon name={name} /></button>;
}
const states: Record<string, string> = { succeeded: '已完成', completed: '已完成', running: '执行中', queued: '排队中', failed: '失败', cancelled: '已取消', pending: '待处理', unknown: '未知', available: '可用', active: '活跃', disabled: '已停用', enabled: '已启用', degraded: '部分可用', 'needs-configuration': '需要配置', 'dependency-missing': '依赖缺失', 'needs-runtime-validation': '需要真实验证', verified: '已验证', unverified: '未验证', planning: '规划', todo: '待办', done: '完成', rejected: '已拒绝', accepted: '已受理', reported: '供应商报告', estimated: '本地估计', 'not-reported': '未报告', invalid: '数据无效' };
export function Status({ value }: { value: any }) {
  const status = textOf(value);
  const success = ['succeeded', 'completed', 'verified', 'available', 'active', 'reported'].includes(status);
  const error = ['failed', 'error', 'invalid', 'denied'].includes(status);
  return <span className={`nexus-status ${success ? 'is-success' : error ? 'is-error' : ''}`}><span aria-hidden="true">{success ? '✓' : error ? '!' : '○'}</span>{states[status] ?? status}</span>;
}
export function StateMessage({ title, children, icon = 'info', action }: { title: string; children?: React.ReactNode; icon?: string; action?: React.ReactNode }) {
  return <div className="nexus-state"><Icon name={icon} size={26} /><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}
export function ErrorMessage({ error, retry }: { error: unknown; retry?: () => void }) {
  const info = errorData(error);
  const titles: Record<string, string> = { 'nexus/dependency-missing': '此能力所需的依赖尚未连接', 'DEPENDENCY_MISSING': '此能力所需的依赖尚未连接', 'nexus/unsupported-capability': '宿主尚未提供此能力', 'UNSUPPORTED_CAPABILITY': '宿主尚未提供此能力', 'nexus/policy-denied': '当前权限不允许此操作', 'nexus/conflict': '内容已被其他操作修改', 'nexus/stale-generation': '连接已更新', 'nexus/not-found': '未找到该记录', 'nexus/cancelled': '操作已取消' };
  return <div className="nexus-error" role="alert"><Icon name="error" /><div><strong>{titles[info.code] ?? '请求未能完成'}</strong><p>{info.message}</p><code>{info.code}</code>{Boolean(info.details) && <details><summary>安全诊断详情</summary><DataView value={info.details} /></details>}</div>{retry && <Button onClick={retry}>重试</Button>}</div>;
}
export function useQuery(api: NexusApi, domain: string, action: string, params: Data = {}, options: RpcOptions & { refresh?: number; enabled?: boolean } = {}) {
  const [state, setState] = useState<{ key?: string; data: any; loading: boolean; error?: unknown; at?: string }>({ data: undefined, loading: options.enabled !== false });
  const [reload, setReload] = useState(0);
  const generation = React.useSyncExternalStore(api.subscribe, api.getGeneration, api.getGeneration);
  const paramsKey = JSON.stringify(params);
  const scopeKey = JSON.stringify(options.scope);
  const key = JSON.stringify([domain, action, paramsKey, scopeKey, generation]);
  useEffect(() => {
    if (options.enabled === false) { setState(old => ({ ...old, loading: false })); return; }
    const controller = new AbortController();
    setState(old => ({ ...(old.key === key ? old : { key, data: undefined }), loading: true, error: undefined }));
    api.call(domain, action, JSON.parse(paramsKey), { ...options, signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ key, data, loading: false, at: new Date().toISOString() });
    }).catch(error => { if (!controller.signal.aborted) setState(old => ({ ...old, key, loading: false, error })); });
    return () => controller.abort();
  }, [api, domain, action, paramsKey, scopeKey, options.refresh, options.enabled, reload, generation]);
  return { ...(state.key === key ? state : { data: undefined, loading: options.enabled !== false, error: undefined, at: undefined }), reload: () => setReload(value => value + 1) };
}
export function QueryState({ query, empty, children }: { query: ReturnType<typeof useQuery>; empty?: boolean; children: React.ReactNode }) {
  if (query.loading && query.data === undefined) return <div className="nexus-skeleton" aria-busy="true" aria-label="正在读取宿主数据"><i /><i /><i /></div>;
  return <>{Boolean(query.error) && <ErrorMessage error={query.error} retry={query.reload} />}{query.loading && <div className="nexus-updating" role="status">正在更新，保留上次内容…</div>}{query.data !== undefined && (empty ? <StateMessage title="这里还没有记录">当前范围没有可显示的数据。可以新建、导入，或调整工作区。</StateMessage> : children)}</>;
}
export function PageHeader({ title, description, children }: { title: string; description?: string; children?: React.ReactNode }) {
  return <div className="nexus-page-header"><div><h1>{title}</h1></div><div className="nexus-actions">{children}</div></div>;
}
export function Tabs({ value, onChange, tabs }: { value: string; onChange(value: string): void; tabs: { id: string; label: string }[] }) {
  return <div className="nexus-tabs" role="tablist">{tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" aria-selected={value === tab.id} tabIndex={value === tab.id ? 0 : -1} onClick={() => onChange(tab.id)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; onChange(tabs[next].id); (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus(); } }}>{tab.label}</button>)}</div>;
}
export function SearchField({ value, onChange, placeholder = '搜索当前记录…' }: { value: string; onChange(value: string): void; placeholder?: string }) {
  return <label className="nexus-search-field"><Icon name="search" size={16} /><input value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} />{value && <IconButton name="close" label="清除搜索" onClick={() => onChange('')} />}</label>;
}
export function DataView({ value, depth = 0 }: { value: any; depth?: number }) {
  if (value === null || value === undefined) return <span className="nexus-muted">未报告</span>;
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>;
  if (typeof value !== 'object') return <span data-nexus-verbatim="" className={typeof value === 'number' ? 'nexus-number' : ''}>{String(value)}</span>;
  if (Array.isArray(value)) return value.length ? <div className="nexus-data-list">{value.map((item, index) => <div key={index}>{isRecord(item) ? <DataView value={item} depth={depth + 1} /> : <span data-nexus-verbatim="">{textOf(item)}</span>}</div>)}</div> : <span className="nexus-muted">无条目</span>;
  const entries = Object.entries(value).filter(([key]) => !/^(?:secret|token|password|passphrase|privateKey|authorization|cookie|apiKey|credentials)$/i.test(key));
  return <dl className={`nexus-data nexus-data-depth-${Math.min(depth, 3)}`}>{entries.map(([key, item]) => <div key={key}><dt>{fieldLabels[key] ?? key}</dt><dd>{typeof item === 'object' && item !== null && depth > 1 ? <details><summary>{Array.isArray(item) ? `${item.length} 项` : '展开详情'}</summary><DataView value={item} depth={depth + 1} /></details> : <DataView value={item} depth={depth + 1} />}</dd></div>)}</dl>;
}
export function Records({ items, onSelect, columns, empty = '没有匹配的记录' }: { items: Data[]; onSelect(item: Data): void; columns?: { key: string; label: string; render?: (item: Data) => React.ReactNode }[]; empty?: string }) {
  const shown = columns ?? [{ key: 'title', label: '名称', render: titleOf }, { key: 'status', label: '状态', render: (item: Data) => <Status value={item.status ?? item.state ?? item.verification ?? 'unknown'} /> }, { key: 'updatedAt', label: '最近更新', render: (item: Data) => <Time value={item.updatedAt ?? item.createdAt ?? item.observedAt} /> }];
  const [page, setPage] = useState(0);
  const pageSize = 80;
  const displayed = items.slice(page * pageSize, (page + 1) * pageSize);
  useEffect(() => { if (page * pageSize >= items.length) setPage(0); }, [items.length, page]);
  if (!items.length) return <StateMessage title={empty}>保留当前筛选条件；可以清除搜索或刷新当前范围。</StateMessage>;
  return <><div className="nexus-table-scroll"><table className="nexus-table"><thead><tr>{shown.map(column => <th key={column.key} scope="col">{column.label}</th>)}<th scope="col"><span className="nexus-sr-only">查看详情</span></th></tr></thead><tbody>{displayed.map((item, index) => <tr key={idOf(item) || index}>{shown.map((column, columnIndex) => <td key={column.key} data-nexus-verbatim="">{columnIndex === 0 ? <button className="nexus-cell-link" data-nexus-verbatim="" onClick={() => onSelect(item)}>{column.render ? column.render(item) : textOf(item[column.key])}</button> : column.render ? column.render(item) : textOf(item[column.key])}</td>)}<td><IconButton name="chevron" label={`查看${titleOf(item)}`} onClick={() => onSelect(item)} /></td></tr>)}</tbody></table></div><div className="nexus-pagination"><span>当前 {page * pageSize + 1}–{Math.min(items.length, (page + 1) * pageSize)} / 已载入 {items.length} 项</span>{items.length > pageSize && <><Button disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一页</Button><Button disabled={(page + 1) * pageSize >= items.length} onClick={() => setPage(value => value + 1)}>下一页</Button></>}</div></>;
}
export function Time({ value }: { value: any }) {
  if (!value) return <span className="nexus-muted">未报告</span>;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? <time dateTime={date.toISOString()} title={date.toISOString()}>{new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)}</time> : <span>{String(value)}</span>;
}
export function ActionShelf({ context, domains, filter, disabled }: { context: ViewContext; domains: string[]; filter?: (action: string) => boolean; disabled?: (action: string, domain: string) => boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const locale = useDescriptorLocale();
  const groups = context.catalog.filter(domain => domains.includes(domain.id)).map(domain => ({ ...domain, capabilities: domain.capabilities.filter(item => !item.action.startsWith('native/')) }));
  return <section className="nexus-action-shelf"><button className="nexus-disclosure" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><Icon name="grid" size={16} /><span>全部领域操作</span><small>{groups.reduce((sum, domain) => sum + domain.capabilities.filter(item => !filter || filter(item.action)).length, 0)} 项真实宿主能力</small><Icon name={expanded ? 'down' : 'chevron'} size={14} /></button>{expanded && <div className="nexus-shelf-body"><SearchField value={search} onChange={setSearch} placeholder="查找能力或操作…" />{groups.length ? groups.map(domain => <div key={domain.id}><h3>{domain.id}</h3><div className="nexus-operation-grid">{domain.capabilities.filter(item => (!filter || filter(item.action)) && `${item.action} ${localizedText(item.description, locale)}`.toLowerCase().includes(search.toLowerCase())).map(item => <button key={item.action} disabled={disabled?.(item.action, domain.id)} onClick={() => { if (!disabled?.(item.action, domain.id)) context.action({ domain: domain.id, action: item.action }); }}><span>{labelAction(item.action)}</span><small>{localizedText(item.description, locale)}</small><em>{item.mutating ? '写操作' : '读取'}{item.permission ? ` · ${item.permission}` : ''}</em></button>)}</div></div>) : <StateMessage title="宿主尚未公布此领域的能力目录">请刷新能力或在设置中查看启动诊断。</StateMessage>}</div>}</section>;
}
export function ActionDialog({ draft, catalog, api, scope, onClose, onDone, onNext }: { draft: ActionDraft; catalog: DomainDefinition[]; api: NexusApi; scope: Data; onClose(): void; onDone(value: any): void; onNext?(draft: ActionDraft): void }) {
  const locale = useDescriptorLocale();
  const definition = capability(catalog, draft.domain, draft.action);
  const defaults = { ...seedParams(draft.domain, draft.action), ...(draft.params ?? {}) };
  const schema = definition?.schema ?? {};
  const properties: Data = schema.properties ?? schema.params?.properties ?? {};
  const requiredFields: string[] = schema.required ?? [];
  const [values, setValues] = useState<Data>(() => ({ ...Object.fromEntries(Object.entries(properties).filter(([key, field]: [string, any]) => requiredFields.includes(key) || field.default !== undefined).map(([key, field]: [string, any]) => [key, field.default ?? field.enum?.[0] ?? (field.type === 'boolean' ? false : field.type === 'object' ? {} : field.type === 'array' ? [] : '')])), ...defaults }));
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState(() => JSON.stringify(defaults, null, 2));
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>();
  const controller = useRef<AbortController | undefined>(undefined);
  const panel = useRef<HTMLDivElement>(null);
  const beforeFocus = useRef<HTMLElement | null>(null);
  const mutating = definition?.mutating ?? !/^(list|get|read|stat|status|overview|search|query|preview|inspect|export|health|models|cache\/report|wire\/diff|diagnose|why\.)/.test(draft.action);
  const continuation = (value: any): ActionDraft | undefined => {
    const record = value?.value ?? value;
    if (draft.domain === 'quality' && draft.action === 'plan' && record?.planHash) return { domain: 'quality', action: 'run', params: { planId: record.id, planHash: record.planHash, background: true }, title: '依据已冻结检查计划执行' };
    if (draft.domain === 'review' && draft.action === 'preview' && (record?.previewHash || record?.hash)) return { domain: 'review', action: 'execute', params: { previewId: record.id ?? record.previewId, previewHash: record.previewHash ?? record.hash, background: true }, title: '依据已预览范围执行审查' };
    if (draft.domain === 'workflow' && draft.action === 'plan' && record?.id) return { domain: 'workflow', action: 'run', params: { planId: record.id, idempotencyKey: `ui-${Date.now().toString(36)}` } };
    if (draft.domain === 'quality' && draft.action === 'fix_preview' && record?.id) return { domain: 'quality', action: 'fix_apply', params: { previewId: record.id, previewHash: record.previewHash ?? record.hash } };
    if (draft.domain === 'resources' && draft.action === 'market.install' && record?.effect === 'preview' && record.item?.id) return { domain: 'resources', action: 'market.install', params: { id: record.item.id, kind: record.item.kind, dryRun: false }, title: '应用已预检的资源安装' };
    return undefined;
  };
  useEffect(() => {
    beforeFocus.current = document.activeElement as HTMLElement;
    panel.current?.focus();
    return () => { controller.current?.abort(); beforeFocus.current?.focus(); };
  }, []);
  const run = async () => {
    setError(undefined); setBusy(true);
    controller.current = new AbortController();
    try {
      const params = advanced ? JSON.parse(json) : Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value]));
      if (!isRecord(params)) throw new Error('参数必须为对象');
      const value = await api.call(draft.domain, draft.action, params, { id: draft.id, revision: draft.revision, scope, mutating, signal: controller.current.signal });
      setResult(value); onDone(value);
    } catch (cause) { if (!controller.current?.signal.aborted) setError(cause); }
    finally { setBusy(false); }
  };
  const focusTrap = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose(); }
    if (event.key !== 'Tab') return;
    const controls = panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input,textarea,select,a[href],[tabindex="0"]');
    if (!controls?.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="nexus-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div className="nexus-modal" role="dialog" aria-modal="true" aria-labelledby="nexus-action-title" tabIndex={-1} ref={panel} onKeyDown={focusTrap}><header><div><small>{draft.domain} / {draft.action}</small><h2 id="nexus-action-title">{localizedText(draft.title, locale, labelAction(draft.action))}</h2></div><IconButton name="close" label="关闭操作，保留已提交结果" disabled={busy} onClick={onClose} /></header><div className="nexus-modal-body"><p className="nexus-muted">{localizedText(definition?.description, locale, '此操作将通过已认证的宿主连接执行。')}</p>{draft.id && <p className="nexus-operation-target">目标：<code>{draft.id}</code>{draft.revision !== undefined && ` · 基础修订 ${draft.revision}`}</p>}{mutating && <div className="nexus-notice-inline"><Icon name="info" size={16} />此操作会写入对应领域。执行结果、权限与审批以宿主回执为准。</div>}{Boolean(error) && <ErrorMessage error={error} />}{result !== undefined ? <section><h3>真实执行回执</h3><DataView value={result} /></section> : <><div className="nexus-form-toolbar"><button className="nexus-text-button" onClick={() => { setAdvanced(value => !value); setJson(JSON.stringify(values, null, 2)); }}>{advanced ? '切换字段表单' : '高级参数编辑'}</button></div>{advanced ? <label className="nexus-field"><span>结构化参数</span><textarea aria-label="结构化参数" className="nexus-code-editor" value={json} onChange={event => setJson(event.target.value)} rows={14} spellCheck={false} /><small>仅提交本次操作需要的数据。现存秘密不会从宿主读取到此处。</small></label> : Object.keys(values).length ? <div className="nexus-form">{Object.entries(values).map(([key, value]) => <Field key={key} name={key} value={value} schema={properties[key]} locale={locale} onChange={next => setValues(old => ({ ...old, [key]: next }))} />)}</div> : <StateMessage title={mutating ? '此操作没有额外参数' : '读取当前作用范围'}>如需指定范围，可以展开高级参数。所有参数仍由宿主验证。</StateMessage>}</>}</div><footer>{result !== undefined ? <><Button onClick={onClose}>完成</Button>{continuation(result) && onNext && <Button primary onClick={() => onNext(continuation(result)!)}>审阅下一步执行</Button>}</> : <><Button onClick={busy ? () => controller.current?.abort() : onClose}>{busy ? '取消当前请求' : '返回'}</Button><Button primary busy={busy} onClick={run} icon={mutating ? 'play' : 'search'}>{mutating ? '执行此操作' : '读取真实数据'}</Button></>}</footer></div></div>;
}
function Field({ name, value, schema, locale, onChange }: { name: string; value: any; schema?: Data; locale: string; onChange(value: any): void }) {
  const type = schema?.type === 'integer' ? 'number' : schema?.type ?? typeof value;
  const label = localizedText(schema?.title, locale, fieldLabels[name] ?? name);
  const [raw, setRaw] = useState(typeof value === 'object' ? JSON.stringify(value, null, 2) : '');
  const [invalid, setInvalid] = useState(false);
  const multiline = /content|prompt|description|body|text|goal|summary|system/i.test(name);
  return <label className="nexus-field">
    <span>{label}{schema?.required && <small> 必填</small>}</span>
    {schema?.enum ? <select aria-label={label} value={String(value)} onChange={event => onChange(event.target.value)}>
      {schema.enum.map((option: any) => <option key={String(option)} value={option}>{String(option)}</option>)}
    </select> : type === 'boolean' ? <span className="nexus-checkbox-row">
      <input aria-label={label} type="checkbox" checked={!!value} onChange={event => onChange(event.target.checked)} />{value ? '开启' : '关闭'}
    </span> : type === 'object' || type === 'array' || Array.isArray(value) ? <>
      <textarea aria-label={label} className="nexus-code-editor" rows={Math.min(12, Math.max(3, raw.split('\n').length))} value={raw} onChange={event => { setRaw(event.target.value); try { onChange(JSON.parse(event.target.value)); setInvalid(false); } catch { setInvalid(true); } }} spellCheck={false} aria-invalid={invalid || undefined} />
      {invalid && <small className="nexus-danger">请输入有效的 JSON；尚未替换原参数。</small>}
    </> : multiline ? <textarea aria-label={label} rows={4} value={String(value ?? '')} onChange={event => onChange(event.target.value)} />
      : <input aria-label={label} type={type === 'number' ? 'number' : /secret|password|apiKey/i.test(name) ? 'password' : 'text'} value={String(value ?? '')} onChange={event => onChange(type === 'number' ? Number(event.target.value) : event.target.value)} />}
    {schema?.description && <small>{localizedText(schema.description, locale)}</small>}
  </label>;
}
export function DetailPane({ item, context, close, pinned, togglePin }: { item: Inspection; context: ViewContext; close(): void; pinned: boolean; togglePin(): void }) {
  const locale = useDescriptorLocale();
  const [tab, setTab] = useState('details');
  const [copyText, setCopyText] = useState('');
  const read = resolveDetailRead(context.catalog, item);
  const copy = async () => {
    const text = typeof item.data === 'string' ? item.data : JSON.stringify(item.data, null, 2);
    try { await navigator.clipboard.writeText(text); context.notify('已复制当前详情'); } catch { setCopyText(text); }
  };
  return <aside className="nexus-inspector" aria-label="Inspector 详情面板"><header><div><small>{localizedText(item.kind, locale, '详情')}{item.revision !== undefined && ` · revision ${item.revision}`}</small><h2 data-nexus-verbatim="">{localizedText(item.title, locale, '详情')}</h2></div><IconButton name="pin" label={pinned ? '取消固定详情' : '固定当前详情'} aria-pressed={pinned} onClick={togglePin} /><IconButton name="close" label="关闭详情面板" onClick={close} /></header><Tabs value={tab} onChange={setTab} tabs={[{ id: 'details', label: '产物 / 详情' }, { id: 'evidence', label: '证据' }]} /><div className="nexus-inspector-tools"><Button icon="copy" onClick={copy}>复制</Button>{read && <Button onClick={() => context.action(read)}>重新读取</Button>}</div><div className="nexus-inspector-body">{copyText && <label className="nexus-field"><span>剪贴板不可用，请选择后复制</span><textarea readOnly value={copyText} rows={8} /></label>}{item.body && tab === 'details' ? item.body : <DataView value={tab === 'evidence' && isRecord(item.data) ? item.data.evidence ?? item.data.receipts ?? item.data : item.data} />}</div></aside>;
}
