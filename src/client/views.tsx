import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Data, InspectionRead, PageId, ViewContext } from './types.js';
import { idOf, isRecord, rows, sessionTranscript, textOf, titleOf, unwrap } from './types.js';
import { ActionShelf, Button, DataView, ErrorMessage, Icon, IconButton, PageHeader, QueryState, Records, SearchField, StateMessage, Status, Tabs, Time, useQuery } from './components.js';
import { capability, findAction, labelAction, pageDomains, seedParams } from './catalog.js';
import { errorData } from './transport.js';
import { ConnectionsView } from './domain-views.js';
import { memoryReadDescriptor, memoryScopeLabel, resolveDetailRead } from './detail-read.js';
import { homeContextQuery } from './home-context-query.js';
import { TaskInsights } from './AgentInsights.js';

function useDomain(context: ViewContext, domain: string, choices: string[], params: Data = {}, enabled = true) {
  const action = findAction(context.catalog, domain, choices);
  const available = context.catalog.some(item => item.id === domain);
  return useQuery(context.api, domain, action, params, { scope: context.scope, refresh: context.refreshToken, enabled: enabled && available });
}
function inspect(context: ViewContext, domain: string, item: Data, read?: InspectionRead, title = titleOf(item)) {
  context.inspect({ title, domain, id: idOf(item), revision: item.revision, data: item, read });
}
function action(context: ViewContext, domain: string, choices: string[], params?: Data, item?: Data) {
  context.action({ domain, action: findAction(context.catalog, domain, choices), params, id: item ? idOf(item) : undefined, revision: item?.revision });
}
function filtered(items: Data[], search: string) {
  if (!search.trim()) return items;
  const query = search.toLocaleLowerCase();
  return items.filter(item => JSON.stringify(item).toLocaleLowerCase().includes(query));
}
function titleStatus(item: Data) { return item.state ?? item.status ?? item.verification ?? 'unknown'; }
function MetaStrip({ items }: { items: { label: string; value: any }[] }) {
  return <dl className="nexus-meta-strip">{items.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{textOf(item.value)}</dd></div>)}</dl>;
}
function CatalogEmpty({ context, domain }: { context: ViewContext; domain: string }) {
  return context.catalog.some(item => item.id === domain) ? null : <StateMessage title="此领域尚未完成宿主挂载">能力目录未报告 {domain}，可在“能力与扩展”查看启动状态和依赖。</StateMessage>;
}
function CopyIdentity({ value, context }: { value: string; context: ViewContext }) {
  const [fallback, setFallback] = useState(false);
  return <span className="nexus-copy-identity"><code data-nexus-verbatim="" title={value}>{value}</code><IconButton name="copy" label="复制完整 ID" onClick={async () => { try { await navigator.clipboard.writeText(value); context.notify('已复制完整 ID'); } catch { setFallback(true); } }} />{fallback && <input aria-label="完整 ID，选择后手动复制" readOnly value={value} onFocus={event => event.target.select()} />}</span>;
}

export function HomeView({ context, openSession }: { context: ViewContext; openSession(id: string): void }) {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState('');
  const [effort, setEffort] = useState('');
  const [modelMenu, setModelMenu] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const controller = useRef<AbortController | undefined>(undefined);
  const sessions = useDomain(context, 'agents', ['session/list']);
  const models = useDomain(context, 'resources', ['models.list']);
  const contextRequest = homeContextQuery(context.scope);
  const contextStatus = useDomain(context, 'context', [contextRequest.action], contextRequest.params);
  const modelItems = filtered(rows(models.data), modelSearch);
  useEffect(() => () => controller.current?.abort(), []);
  const send = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true); setError(undefined); controller.current = new AbortController();
    try {
      const result = await context.api.call('agents', 'session/spawn', { prompt, ...(model ? { model } : {}), ...(provider ? { provider } : {}), ...(effort ? { reasoningEffort: effort } : {}) }, { scope: context.scope, mutating: true, signal: controller.current.signal });
      const id = result?.sessionId ?? result?.id ?? result?.session?.id;
      context.notify('任务已提交给宿主', 'success', id ? `会话 ${id}` : '请查看真实会话或执行回执');
      if (id) openSession(String(id));
      else context.inspect({ title: '宿主提交回执', kind: '会话', data: result });
      setPrompt('');
    } catch (cause) { if (!controller.current?.signal.aborted) setError(cause); }
    finally { setBusy(false); }
  };
  return <div className="nexus-home"><div className="nexus-welcome"><div className="nexus-spark" aria-hidden="true">✳</div><h1>把想法，继续向前。</h1><p>在同一个工作区里，连接会话、记忆与真实执行。</p><div className="nexus-composer"><textarea aria-label="新会话指令" placeholder="今天想一起完成什么？" value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} rows={4} /><div className="nexus-composer-bottom"><div className="nexus-composer-left"><IconButton name="plus" label="打开工程文件与附件" onClick={() => context.navigate('engineering')} /><button onClick={() => context.navigate('orchestration')} className="nexus-text-button"><Icon name="branch" size={15} />编排任务</button></div><div className="nexus-model-control"><button className="nexus-model-trigger" aria-expanded={modelMenu} onClick={() => setModelMenu(value => !value)}>{model || '继承宿主模型'}<Icon name="down" size={13} /></button>{modelMenu && <div className="nexus-model-popover"><SearchField value={modelSearch} onChange={setModelSearch} placeholder="搜索模型…" /><button className="nexus-model-option" onClick={() => { setModel(''); setProvider(''); setEffort(''); setModelMenu(false); }}><strong>继承宿主模型</strong><small>本次新会话的有效配置</small>{!model && <Icon name="check" size={16} />}</button><QueryState query={models} empty={!modelItems.length}>{modelItems.map((item, index) => <button key={idOf(item) || index} className="nexus-model-option" disabled={item.available === false || item.enabled === false} onClick={() => { setModel(String(item.model ?? item.id ?? item.name)); setProvider(String(item.provider ?? '')); setModelMenu(false); }}><strong>{item.model ?? item.name ?? item.id}</strong><small>{item.provider ?? item.description ?? '已登记模型'}{item.available === false ? ' · 不可用' : ''}</small>{model === (item.model ?? item.id) && <Icon name="check" size={16} />}</button>)}</QueryState><label className="nexus-field"><span>下一轮 reasoning effort</span><select value={effort} onChange={event => setEffort(event.target.value)}><option value="">继承模型默认</option>{['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(value => <option key={value}>{value}</option>)}</select><small>宿主会验证模型支持的 effort；执行租约启动后保持冻结。</small></label></div>}</div><button className="nexus-send-button" aria-label={busy ? '取消当前提交' : '发送到宿主新会话'} disabled={!busy && !prompt.trim()} onClick={busy ? () => controller.current?.abort() : () => void send()}><Icon name={busy ? 'stop' : 'arrow'} size={20} /></button></div></div>{Boolean(error) && <ErrorMessage error={error} />}<div className="nexus-home-suggestions"><button onClick={() => context.navigate('engineering')}><Icon name="code" size={16} />查看工作区</button><button onClick={() => context.navigate('memory')}><Icon name="memory" size={16} />接续项目记忆</button><button onClick={() => context.navigate('orchestration')}><Icon name="branch" size={16} />多角色协作</button></div><button className="nexus-cache-line" onClick={() => context.navigate('cache')}><Icon name="gauge" size={14} />缓存：{contextStatus.loading ? '读取中' : contextStatus.data?.cache?.usageSource === 'reported' ? '查看供应商报告' : '未报告'}<span>查看上下文与 epoch</span><Icon name="chevron" size={12} /></button></div><section className="nexus-recent"><div className="nexus-section-heading"><h2>最近会话</h2><button className="nexus-text-button" onClick={() => context.navigate('sessions')}>查看全部<Icon name="chevron" size={13} /></button></div><QueryState query={sessions} empty={rows(sessions.data).length === 0}>{rows(sessions.data).slice(0, 4).map((item, index) => <button className="nexus-recent-row" key={idOf(item) || index} onClick={() => openSession(idOf(item))}><Icon name="chat" /><span><strong data-nexus-verbatim="">{titleOf(item)}</strong><small>{item.cwd ?? item.workspace ?? item.sessionId ?? item.id}</small></span><Time value={item.updatedAt ?? item.lastActivityAt ?? item.createdAt} /><Icon name="chevron" size={14} /></button>)}</QueryState></section></div>;
}

export function SessionsView({ context, selected, openSession }: { context: ViewContext; selected?: string; openSession(id: string): void }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const list = useDomain(context, 'agents', ['session/list']);
  const detail = useDomain(context, 'agents', ['session/get', 'session/status'], { sessionId: selected }, !!selected);
  const items = filtered(rows(list.data), search).filter(item => filter === 'all' || filter === 'archived' ? filter === 'all' || item.archived === true : !item.archived);
  const selectedOffscreen = [...checked].filter(id => !items.some(item => idOf(item) === id)).length;
  const batch = (method: string) => context.action({ domain: 'runtime', action: method, params: { sessionIds: [...checked] } });
  if (selected) return <SessionReader context={context} sessionId={selected} query={detail} back={() => openSession('')} />;
  return <div className="nexus-page"><PageHeader title="会话"><Button icon="refresh" onClick={list.reload}>刷新</Button><Button primary icon="plus" onClick={() => context.navigate('home')}>新会话</Button></PageHeader><div className="nexus-toolbar"><SearchField value={search} onChange={setSearch} placeholder="搜索标题或完整会话 ID…" /><select aria-label="归档筛选" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部会话</option><option value="active">未归档</option><option value="archived">已归档</option></select></div>{checked.size > 0 && <div className="nexus-selection-bar">已选择 {checked.size} 项{selectedOffscreen > 0 && `（其中 ${selectedOffscreen} 项在当前筛选外）`}<Button onClick={() => batch('sessions.archive')}>归档</Button><Button onClick={() => batch('sessions.restore')}>恢复</Button><Button onClick={() => setChecked(new Set())}>清除选择</Button></div>}<QueryState query={list} empty={!items.length}><div className="nexus-table-scroll"><table className="nexus-table"><thead><tr><th><input type="checkbox" aria-label="选择当前页会话" checked={!!items.length && items.every(item => checked.has(idOf(item)))} onChange={event => setChecked(event.target.checked ? new Set([...checked, ...items.map(idOf)]) : new Set([...checked].filter(id => !items.some(item => idOf(item) === id))))} /></th><th>标题 / ID</th><th>工作区</th><th>关系</th><th>状态</th><th>最近活动</th><th>详情</th></tr></thead><tbody>{items.slice(0, 200).map((item, index) => <tr key={idOf(item) || index}><td><input type="checkbox" aria-label={`选择 ${titleOf(item)}`} checked={checked.has(idOf(item))} onChange={event => setChecked(old => { const next = new Set(old); if (event.target.checked) next.add(idOf(item)); else next.delete(idOf(item)); return next; })} /></td><td><button className="nexus-cell-link" onClick={() => openSession(idOf(item))}><span data-nexus-verbatim="">{titleOf(item)}</span></button><CopyIdentity value={idOf(item)} context={context} /></td><td>{item.cwd ?? item.header?.cwd ?? item.header?.meta?.cwd ?? item.workspace ?? '未关联'}</td><td>{item.parentId ? '派生会话' : item.relationship ?? '未报告'}</td><td><Status value={titleStatus(item)} /></td><td><Time value={item.updatedAt ?? item.lastActivityAt ?? item.header?.createdAt} /></td><td><IconButton name="chevron" label={`会话详情 ${titleOf(item)}`} onClick={() => inspect(context, 'agents', item, { choices: ['session/get'], params: { sessionId: idOf(item) } })} /></td></tr>)}</tbody></table></div>{items.length > 200 && <p className="nexus-muted">当前显示前 200 项，请缩小筛选范围；已载入 {items.length} 项。</p>}</QueryState><ActionShelf context={context} domains={['agents', 'runtime']} filter={value => /session|archive|rewind/.test(value)} /></div>;
}
function SessionReader({ context, sessionId, query, back }: { context: ViewContext; sessionId: string; query: ReturnType<typeof useQuery>; back(): void }) {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [raw, setRaw] = useState(context.reading === false);
  const [expanded, setExpanded] = useState(true);
  useEffect(() => setRaw(context.reading === false), [context.reading]);
  const item = unwrap(query.data ?? {});
  const messages = sessionTranscript(item);
  const send = async () => {
    if (!prompt.trim()) return;
    setBusy(true); setError(undefined);
    try { const result = await context.api.call('agents', 'session/wake', { sessionId, prompt }, { scope: { ...context.scope, sessionId }, mutating: true }); setPrompt(''); context.notify('已提交后续指令', 'success'); context.inspect({ title: '会话提交回执', data: result }); query.reload(); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <div className="nexus-session-reader"><header className="nexus-reader-heading"><button className="nexus-text-button" onClick={back}>‹ 全部会话</button><strong data-nexus-verbatim="">{item.title ?? '会话阅读'}</strong><Button onClick={() => setRaw(value => !value)}>{raw ? '阅读视图' : '原始投影'}</Button><Button onClick={() => context.openNativeSession(sessionId)}>打开宿主原生会话</Button><IconButton name="info" label="查看会话元数据" onClick={() => context.inspect({ title: item.title ?? sessionId, kind: '宿主会话', data: item, domain: 'agents', id: sessionId, read: { choices: ['session/get'], params: { sessionId } } })} /></header><QueryState query={query}><div className="nexus-message-column">{raw ? <DataView value={item} /> : Array.isArray(messages) && messages.length ? messages.map((message: Data, index: number) => <article className={`nexus-message nexus-message-${message.role ?? 'assistant'}`} key={message.id ?? index}><small>{message.role === 'user' ? '你' : message.role === 'tool' ? '工具结果' : message.role ?? '助手'}</small>{typeof message.content === 'string' ? <div className="nexus-message-text" data-nexus-verbatim="">{message.content}</div> : Array.isArray(message.content ?? message.blocks) ? (message.content ?? message.blocks).map((block: Data, blockIndex: number) => block.type === 'reasoning' || block.type === 'thinking' ? <details className="nexus-reasoning" key={block.id ?? blockIndex} open={expanded}><summary onClick={() => setExpanded(value => !value)}>思考过程 · 原始内容</summary><div className="nexus-message-text" data-nexus-verbatim="">{block.text ?? block.content ?? ''}</div></details> : typeof (block.text ?? block.content) === 'string' ? <div key={block.id ?? blockIndex} className="nexus-message-text" data-nexus-verbatim="">{block.text ?? block.content}</div> : <div className="nexus-native-fallback" key={block.id ?? blockIndex}>此 {block.type ?? '未知'} block 需在宿主原生会话中查看。<Button onClick={() => context.openNativeSession(sessionId)}>打开宿主原生会话</Button><Button onClick={() => context.inspect({ title: '原始会话 block', data: block })}>查看安全元数据</Button></div>) : <DataView value={message} />}</article>) : <StateMessage title="宿主尚未返回可读消息投影" action={<Button onClick={() => context.openNativeSession(sessionId)}>打开宿主原生会话</Button>}>会话元数据已保留。可以查看原始投影、刷新或进入宿主原生会话；不会用推测内容填充会话。</StateMessage>}</div></QueryState><div className="nexus-reader-composer"><div className="nexus-composer"><textarea value={prompt} aria-label="后续指令" onChange={event => setPrompt(event.target.value)} placeholder="继续讨论…" rows={3} /><div className="nexus-composer-bottom"><span className="nexus-muted">沿用本会话模型与权限</span><Button primary busy={busy} disabled={!prompt.trim()} icon="arrow" onClick={() => void send()}>发送</Button></div></div>{Boolean(error) && <ErrorMessage error={error} />}</div></div>;
}

export function TasksView({ context }: { context: ViewContext }) {
  const [tab, setTab] = useState('board');
  const [search, setSearch] = useState('');
  const query = useDomain(context, 'workflow', ['todo/list']);
  const runs = useDomain(context, 'workflow', ['list']);
  const items = filtered(rows(query.data), search);
  const columns = [{ id: 'planning', label: '规划' }, { id: 'todo', label: '待办' }, { id: 'running', label: '运行' }, { id: 'done', label: '完成' }, { id: 'failed', label: '失败' }];
  const classify = (item: Data) => ({ pending: 'todo', queued: 'todo', succeeded: 'done', completed: 'done', draft: 'planning', doing: 'running', blocked: 'failed', cancelled: 'planning' } as Record<string, string>)[item.managementStatus ?? item.status ?? item.state] ?? item.managementStatus ?? item.status ?? item.state ?? 'todo';
  return <div className="nexus-page"><PageHeader title="任务"><Button icon="refresh" onClick={() => { query.reload(); runs.reload(); }}>刷新</Button><Button primary icon="plus" onClick={() => action(context, 'workflow', ['todo/create'], { ...seedParams('workflow', 'todo/create'), scope: context.scope.level === 'session' ? 'session' : context.scope.level === 'global' ? 'work' : 'project' })}>新建任务</Button></PageHeader><TaskInsights api={context.api} scope={context.scope} /><Tabs value={tab} onChange={setTab} tabs={[{ id: 'board', label: '看板' }, { id: 'list', label: '列表' }, { id: 'runs', label: '真实运行' }, { id: 'schedule', label: '调度' }]} /><div className="nexus-toolbar"><SearchField value={search} onChange={setSearch} placeholder="搜索任务、标签或执行目标…" /></div>{tab === 'board' ? <QueryState query={query} empty={!items.length}><div className="nexus-board">{columns.map(column => { const group = items.filter(item => classify(item) === column.id); return <section className="nexus-board-column" key={column.id}><h2>{column.label}<span>{group.length}</span></h2>{group.map((item, index) => <article className="nexus-task-card" key={idOf(item) || index}><button className="nexus-task-title" onClick={() => inspect(context, 'workflow', item)}><span data-nexus-verbatim="">{titleOf(item)}</span></button><p data-nexus-verbatim="">{item.description ?? item.goal ?? '未提供描述'}</p><div className="nexus-task-tags">{(item.tags ?? []).slice(0, 3).map((tag: string) => <span key={tag}>{tag}</span>)}</div><footer><small>{item.source ?? '手动'}{item.manual ? ' · 手动归类' : ''}</small><button className="nexus-text-button" onClick={() => action(context, 'workflow', ['todo/update'], { id: idOf(item), content: item.content, status: item.status }, item)}>管理</button></footer>{item.runId && <button className="nexus-text-button" onClick={() => action(context, 'workflow', ['status'], { runId: item.runId })}>查看真实运行 ↗</button>}</article>)}</section>; })}</div></QueryState> : tab === 'runs' ? <QueryState query={runs} empty={!rows(runs.data).length}><Records items={filtered(rows(runs.data), search)} onSelect={item => context.action({ domain: 'workflow', action: 'status', params: { runId: idOf(item) } })} /></QueryState> : tab === 'schedule' ? <div className="nexus-schedule"><p>停止调度与取消运行是独立动作。时区、misfire 与下一次触发以服务端预演为准。</p><ActionShelf context={context} domains={['workflow']} filter={value => /schedule|cron|todo/.test(value)} /></div> : <QueryState query={query} empty={!items.length}><Records items={items} onSelect={item => inspect(context, 'workflow', item)} /></QueryState>}<ActionShelf context={context} domains={['workflow']} /></div>;
}

const WorkflowEditor = React.lazy(() => import('./WorkflowEditor.js').then(module => ({ default: module.WorkflowEditor })));
export function OrchestrationView({ context }: { context: ViewContext }) {
  const level = context.scope.level ?? 'global';
  const [selectedTab, setTab] = useState(level === 'session' ? 'plans' : 'editor');
  const [search, setSearch] = useState('');
  const [goal, setGoal] = useState('');
  const tabs = level === 'global'
    ? [{ id: 'editor', label: '工作流模板' }, { id: 'blueprints', label: '执行蓝图' }]
    : [...(level === 'workspace' ? [{ id: 'editor', label: '工作流' }] : []), { id: 'plans', label: '执行计划' }, { id: 'runs', label: '运行与证据' }, ...(level === 'workspace' ? [{ id: 'blueprints', label: '工作区蓝图' }] : [])];
  const tab = tabs.some(item => item.id === selectedTab) ? selectedTab : tabs[0].id;
  const choices = tab === 'runs' ? ['list'] : tab === 'blueprints' ? ['blueprints/list'] : ['plans/list'];
  const query = useDomain(context, 'workflow', choices, {}, tab !== 'editor');
  const createPlan = () => action(context, 'workflow', ['plan'], {
    ...seedParams('workflow', 'plan'), goal,
    nodes: [{ id: 'implement', kind: 'agent', role: 'implementer', prompt: goal, dependsOn: [], checks: [] }],
  });
  if (tab === 'editor') return <section className="nexus-workflow-tools" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 560 }}>
    <div style={{ padding: '14px 20px 0' }}><Tabs value={tab} onChange={setTab} tabs={tabs} /></div>
    <React.Suspense fallback={<StateMessage title="正在加载工作流" />}><WorkflowEditor api={context.api} scope={context.scope} /></React.Suspense>
  </section>;
  return <div className="nexus-page">
    <PageHeader title={level === 'global' ? '执行蓝图' : '执行计划'}>
      <Button icon="refresh" onClick={query.reload}>刷新</Button>
      {level !== 'global' && <Button primary icon="plus" onClick={createPlan}>新建执行计划</Button>}
    </PageHeader>
    {level !== 'global' && <div className="nexus-goal-input">
      <textarea value={goal} onChange={event => setGoal(event.target.value)} placeholder="执行目标…" rows={2} aria-label="执行目标" />
      <Button primary disabled={!goal.trim()} onClick={createPlan}>编辑计划<Icon name="chevron" size={14} /></Button>
    </div>}
    {tabs.length > 1 && <Tabs value={tab} onChange={setTab} tabs={tabs} />}
    <div className="nexus-toolbar"><SearchField value={search} onChange={setSearch} /></div>
    <QueryState query={query} empty={!rows(query.data).length}>
      <div className="nexus-plan-list">{filtered(rows(query.data), search).map((item, index) => <article className="nexus-plan-row" key={idOf(item) || index}>
        <div className="nexus-plan-icon"><Icon name={tab === 'runs' ? 'play' : 'branch'} size={22} /></div>
        <button onClick={() => inspect(context, 'workflow', item, tab === 'plans' ? { choices: ['plan/get'], params: { planId: idOf(item) } } : tab === 'runs' ? { choices: ['status'], params: { runId: idOf(item) } } : undefined)} className="nexus-plan-description">
          <strong data-nexus-verbatim="">{titleOf(item)}</strong><small>{item.description ?? item.goal ?? idOf(item)}</small>
          <span>{Array.isArray(item.nodes) ? item.nodes.length + ' 个节点' : ''}</span>
        </button>
        <Status value={titleStatus(item)} />
        <div className="nexus-plan-actions">
          {tab === 'plans' && <><Button onClick={() => action(context, 'workflow', ['plan/get'], { planId: idOf(item) })}>计划详情</Button>{level === 'session' && <Button primary icon="play" onClick={() => action(context, 'workflow', ['run'], { planId: idOf(item), idempotencyKey: 'ui-' + Date.now().toString(36) })}>执行</Button>}</>}
          {tab === 'runs' && <><Button onClick={() => action(context, 'workflow', ['status'], { runId: idOf(item) })}>运行详情</Button><Button onClick={() => action(context, 'workflow', ['evidence/export'], { runId: idOf(item) })}>证据</Button>{item.state === 'running' && <Button onClick={() => action(context, 'workflow', ['cancel'], { runId: idOf(item) })}>取消</Button>}</>}
          {tab === 'blueprints' && level !== 'global' && <Button onClick={() => action(context, 'workflow', ['blueprints/compile'], { id: idOf(item), goal })}>编译为计划</Button>}
        </div>
      </article>)}</div>
    </QueryState>
    <ActionShelf context={context} domains={['workflow']} filter={value => level === 'global' ? /blueprint/.test(value) : level === 'workspace' ? /^(?:plan|plans\/list|plan\/get|blueprints\/|models\/list|routes\/)/.test(value) : !/todo|schedule|cron|teams/.test(value)} />
  </div>;
}

export function MemoryView({ context, knowledge = false }: { context: ViewContext; knowledge?: boolean }) {
  const [tab, setTab] = useState(knowledge && context.scope.level !== 'global' ? 'sources' : 'library');
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState('all');
  const [searchMode, setSearchMode] = useState('keyword');
  const [submitted, setSubmitted] = useState('');
  const query = useDomain(context, 'memory', tab === 'sources' ? ['sources'] : tab === 'providers' ? ['providers'] : tab === 'evolution' ? ['status'] : tab === 'review' ? ['proposals'] : ['list'], tab === 'review' ? { state: 'pending_review' } : { scope: scope === 'all' ? undefined : scope }, tab !== 'search');
  const searchQuery = useDomain(context, 'memory', ['search', 'recall'], { query: submitted, mode: searchMode, scope: scope === 'all' ? undefined : scope }, tab === 'search' && !!submitted);
  const shownQuery = tab === 'search' ? searchQuery : query;
  const items = tab === 'search' ? rows(searchQuery.data) : filtered(rows(query.data), search);
  const newMemory = () => action(context, 'memory', ['save'], seedParams('memory', 'save'));
  return <div className="nexus-page">
    <PageHeader title={knowledge ? '知识与来源' : '记忆'}>
      <Button icon="refresh" onClick={shownQuery.reload}>刷新</Button><Button primary icon="plus" onClick={newMemory}>新增记忆</Button>
    </PageHeader>
    <Tabs value={tab} onChange={setTab} tabs={[{ id: 'library', label: '记忆库' }, { id: 'search', label: '检索' }, { id: 'review', label: '候选审核' }, { id: 'evolution', label: '演化与维护' }, ...(context.scope.level === 'global' ? [] : [{ id: 'sources', label: '文件与交接' }]), { id: 'providers', label: '引擎与空间' }]} />
    {tab === 'search' ? <form className="nexus-toolbar" onSubmit={event => { event.preventDefault(); setSubmitted(search); }}>
      <SearchField value={search} onChange={setSearch} placeholder="关键词、条件或语义检索…" />
      <select value={searchMode} aria-label="记忆检索模式" onChange={event => setSearchMode(event.target.value)}><option value="keyword">关键词</option><option value="semantic">语义检索</option><option value="spatiotemporal">时空检索</option></select>
      <Button primary type="submit" disabled={!search.trim()}>检索</Button>
    </form> : <div className="nexus-toolbar">
      <SearchField value={search} onChange={setSearch} placeholder="搜索标题、正文或标签…" />
      <select aria-label="记忆范围" value={scope} onChange={event => setScope(event.target.value)}><option value="all">当前范围及继承记忆</option><option value="session">当前会话</option><option value="personal">个人</option><option value="project">项目</option><option value="branch">分支</option><option value="path">路径触及</option></select>
    </div>}
    {tab === 'sources' && <div className="nexus-notice-inline"><Icon name="file" size={18} /><div>
      
      <Button onClick={() => action(context, 'memory', ['handoff'])}>生成交接包</Button><Button onClick={() => action(context, 'memory', ['file_refresh'])}>刷新文件来源</Button>
    </div></div>}
    {tab === 'evolution' ? <>
      <QueryState query={query}><DataView value={query.data} /></QueryState>
      <div className="nexus-editorial-actions">{[['maintain', '维护预演', '先展示遗忘、依赖传播与保护条目，再决定是否应用。'], ['reflect', '反思与提炼', '保留模型来源与证据，候选不会直接当作已验证记忆。'], ['trust', '信任与校准', '查看验证证据、置信度与盲区。'], ['advanced', '高级认知操作', '访问各记忆引擎的独特能力与完整操作目录。']].map(([method, title, description]) => <button key={method} onClick={() => action(context, 'memory', [method], method === 'maintain' ? { dryRun: true } : {})}><Icon name="memory" /><strong>{title}</strong><Icon name="chevron" size={15} /></button>)}</div>
    </> : tab === 'search' && !submitted ? <StateMessage title="从一个问题开始检索">关键词检索可离线使用；语义与时空检索会按已配置引擎返回来源与排名依据。</StateMessage> : <QueryState query={shownQuery} empty={items.length === 0 && Array.isArray(query.data)}>
      {items.length ? <div className="nexus-memory-list">{items.map((item, index) => {
        const read = memoryReadDescriptor(item, tab);
        const draft = resolveDetailRead(context.catalog, { domain: 'memory', read });
        const title = tab === 'review' ? titleOf(item.record ?? item) : tab === 'sources' ? titleOf({ ...item, title: item.title ?? item.relativePath ?? item.documentId }) : titleOf(item);
        return <article className="nexus-memory-row" key={idOf(item) || item.documentId || index}>
          <div className="nexus-memory-marker"><Icon name={tab === 'sources' ? 'file' : tab === 'providers' ? 'grid' : 'memory'} size={19} /></div>
          <button className="nexus-memory-content" onClick={() => inspect(context, 'memory', item, read, title)}>
            <h3 data-nexus-verbatim="">{title}</h3>
            <p data-nexus-verbatim="">{item.snippet ?? item.body ?? item.content ?? item.description ?? item.path ?? item.relativePath ?? item.sourcePath ?? idOf(item)}</p>
            <small>{memoryScopeLabel(item.scope)} · {item.kind ?? item.type ?? '记忆'} · revision {item.revision ?? item.observedRevision ?? '未报告'}</small>
          </button>
          <div className="nexus-memory-meta">
            <Status value={item.verification ?? item.state ?? item.status ?? 'unverified'} /><Time value={item.updatedAt} />
            <div className="nexus-actions">{tab === 'review' ? <>
              <Button onClick={() => action(context, 'memory', ['review'], { proposalId: item.proposalId ?? idOf(item), decision: 'accept' }, item)}>采纳</Button>
              <Button onClick={() => action(context, 'memory', ['review'], { proposalId: item.proposalId ?? idOf(item), decision: 'reject' }, item)}>拒绝</Button>
            </> : draft && <Button onClick={() => context.action(draft)}>{draft.action === 'file_read' ? '读取文件' : '完整详情'}</Button>}</div>
          </div>
        </article>;
      })}</div> : <DataView value={shownQuery.data} />}
    </QueryState>}
    <ActionShelf context={context} domains={['memory', 'knowledge']} />
  </div>;
}

export function EngineeringView({ context }: { context: ViewContext }) {
  const [tab, setTab] = useState('files');
  return <div className="nexus-page nexus-engineering"><PageHeader title="工程" description={context.scope.sessionId ? '当前 DSH 会话的工作目录' : '请选择 DSH 会话'}><Button onClick={() => action(context, 'runtime', ['terminal.open'])} icon="terminal">宿主终端</Button></PageHeader><Tabs value={tab} onChange={setTab} tabs={[{ id: 'files', label: '文件' }, { id: 'git', label: 'Git' }, { id: 'terminal', label: '终端与作业' }, { id: 'hosts', label: '远程主机' }]} />{tab === 'files' ? <FilesPane context={context} /> : tab === 'git' ? <GitPane context={context} /> : tab === 'terminal' ? <TerminalPane context={context} /> : <ConnectionsView context={context} embedded />}<ActionShelf context={context} domains={tab === 'files' ? ['files'] : tab === 'hosts' ? ['connections'] : ['runtime']} /></div>;
}
function FilesPane({ context }: { context: ViewContext }) {
  const [directory, setDirectory] = useState('');
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState('');
  const [baseHash, setBaseHash] = useState<string | undefined>();
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState('filename');
  const [submitted, setSubmitted] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const query = useDomain(context, 'files', ['list'], { path: directory });
  const file = useDomain(context, 'files', ['read'], { path: selected }, !!selected);
  const searchQuery = useDomain(context, 'files', ['search'], { path: directory, query: submitted, mode }, !!submitted);
  useEffect(() => {
    if (!file.loading && file.data && !dirty) {
      setDraft(String(file.data.content ?? file.data.text ?? '')); setBaseHash(file.data.hash ?? file.data.sourceHash ?? file.data.sha256);
    }
  }, [file.data, file.loading, dirty]);
  const open = (item: Data) => {
    if (item.type === 'directory' || item.isDirectory || item.kind === 'directory') { setDirectory(item.path ?? `${directory}/${item.name}`.replace(/^\//, '')); return; }
    if (dirty && selected !== item.path) { context.notify('请先保存或保留当前文件草稿', 'info', selected); return; }
    setSelected(item.path ?? item.name); setDirty(false); setError(undefined); setPreview(false);
  };
  const save = async () => {
    setBusy(true); setError(undefined);
    try {
      const result = await context.api.call('files', 'write', { path: selected, content: draft, expectedHash: baseHash }, { scope: context.scope, revision: file.data?.revision, mutating: true });
      setDirty(false); setBaseHash(result.hash ?? result.sourceHash); context.notify('文件已由宿主保存', 'success', selected); file.reload(); query.reload();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  const items = submitted ? rows(searchQuery.data) : filtered(rows(query.data), search);
  return <><form className="nexus-toolbar" onSubmit={event => { event.preventDefault(); setSubmitted(search); }}><SearchField value={search} onChange={value => { setSearch(value); if (!value) setSubmitted(''); }} placeholder="搜索文件名或内容…" /><select value={mode} onChange={event => setMode(event.target.value)} aria-label="文件搜索模式"><option value="filename">文件名</option><option value="content">文件内容</option><option value="all">全部</option></select><Button type="submit" disabled={!search}>搜索</Button><Button onClick={() => action(context, 'files', ['write'], { path: `${directory ? `${directory}/` : ''}`, content: '', createOnly: true })}>新建文件</Button><Button onClick={() => action(context, 'files', ['mkdir'], { path: directory })}>新建目录</Button></form><div className="nexus-file-workbench"><aside className="nexus-file-tree" aria-label="工作区文件"><div className="nexus-file-path"><button disabled={!directory} onClick={() => setDirectory(directory.split(/[\\/]/).slice(0, -1).join('/'))}>上一级</button><code title={directory || '.'}>{directory || '.'}</code><IconButton name="refresh" label="刷新文件列表" onClick={query.reload} /></div><QueryState query={submitted ? searchQuery : query} empty={!items.length}><div role="tree" aria-label="文件树">{items.slice(0, 500).map((item, index) => <button role="treeitem" aria-selected={selected === item.path} className={`nexus-tree-row ${selected === item.path ? 'is-selected' : ''}`} key={item.path ?? idOf(item) ?? index} onClick={() => open(item)} onKeyDown={event => { if (event.key === 'ArrowRight' && (item.type === 'directory' || item.isDirectory)) { event.preventDefault(); open(item); } if (event.key === 'ArrowLeft') { event.preventDefault(); setDirectory(directory.split(/[\\/]/).slice(0, -1).join('/')); } }}><Icon name={item.type === 'directory' || item.isDirectory ? 'folder' : 'file'} size={16} /><span>{item.name ?? item.path ?? titleOf(item)}</span>{item.line && <small>{item.line}</small>}{item.gitStatus && <em>{item.gitStatus}</em>}</button>)}</div>{items.length > 500 && <p>仅显示前 500 项，请缩小范围。</p>}</QueryState></aside><section className="nexus-file-editor">{selected ? <><div className="nexus-editor-tabs"><span><Icon name="file" size={15} />{selected}{dirty && <span className="nexus-dirty" aria-label="未保存">●</span>}</span><div><Button onClick={() => setPreview(value => !value)}>{preview ? '源码' : '文本预览'}</Button><Button primary busy={busy} disabled={!dirty || !baseHash} onClick={() => void save()}>保存</Button><IconButton name="info" label="文件信息" onClick={() => context.inspect({ title: selected, kind: '文件', data: file.data })} /></div></div>{Boolean(error) && <ErrorMessage error={error} />}<QueryState query={file}>{file.data?.binary ? <StateMessage title="此文件需要宿主预览器">二进制内容不会作为文本写回。可以通过文件操作打开、下载或选择外部应用。</StateMessage> : preview ? <pre className="nexus-file-preview" data-nexus-verbatim="">{draft}</pre> : <textarea className="nexus-editor-textarea" value={draft} onChange={event => { setDraft(event.target.value); setDirty(true); }} spellCheck={false} aria-label={`${selected} 文件编辑器`} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); if (dirty && baseHash) void save(); } }} />}</QueryState><footer className="nexus-editor-status"><span>{dirty ? '● 未保存草稿' : '已读取基础版本'}</span><span>{file.data?.encoding ?? '编码未报告'} · {file.data?.newline ?? '换行未报告'}</span><span>{baseHash ? `base ${baseHash.slice(0, 12)}` : '基础 Hash 缺失，写回禁用'}</span>{dirty && <Button onClick={() => { setDirty(false); setDraft(String(file.data?.content ?? '')); }}>放弃草稿</Button>}</footer></> : <StateMessage title="选择一个文件，开始阅读或编辑" icon="folder">文件路径始终相对于当前工作区。保存使用基础 Hash，防止覆盖外部修改。</StateMessage>}</section></div></>;
}
function GitPane({ context }: { context: ViewContext }) {
  const [tab, setTab] = useState('changes');
  const [selected, setSelected] = useState('');
  const [message, setMessage] = useState('');
  const query = useDomain(context, 'runtime', ['git.status']);
  const log = useDomain(context, 'runtime', ['git.log'], { limit: 200 }, tab === 'history');
  const worktrees = useDomain(context, 'runtime', ['git.worktrees'], {}, tab === 'worktrees');
  const diff = useDomain(context, 'runtime', ['git.diff'], { path: selected }, !!selected);
  const changes = rows(query.data?.files ?? query.data?.changes ?? query.data);
  return <><MetaStrip items={[{ label: '仓库', value: query.data?.root ?? query.data?.repository }, { label: '分支', value: query.data?.branch }, { label: '远端', value: query.data?.remote }, { label: '工作树', value: query.data?.worktree }]} /><Tabs value={tab} onChange={setTab} tabs={[{ id: 'changes', label: '当前更改' }, { id: 'history', label: '提交历史' }, { id: 'worktrees', label: '工作树' }]} />{tab === 'changes' ? <div className="nexus-git-layout"><aside><QueryState query={query} empty={!changes.length}>{changes.map((item, index) => <article className="nexus-git-file" key={item.path ?? index}><button onClick={() => setSelected(item.path ?? item.name)}><code>{item.status ?? item.index ?? '?'}</code><span>{item.path ?? item.name}</span></button><div><button className="nexus-text-button" onClick={() => action(context, 'runtime', ['git.stage'], { paths: [item.path] })}>暂存</button><button className="nexus-text-button" onClick={() => action(context, 'runtime', ['git.unstage'], { paths: [item.path] })}>取消暂存</button></div></article>)}</QueryState><label className="nexus-field"><span>提交说明</span><textarea rows={4} value={message} onChange={event => setMessage(event.target.value)} placeholder="说明这些修改的原因…" /></label><Button primary disabled={!message.trim()} onClick={() => action(context, 'runtime', ['git.commit'], { message })}>审阅并提交</Button></aside><section>{selected ? <QueryState query={diff}><div className="nexus-diff-title"><code>{selected}</code><Button onClick={() => action(context, 'runtime', ['git.discard'], { paths: [selected] })}>丢弃此文件修改</Button></div><DiffText text={String(diff.data?.diff ?? diff.data?.stdout ?? diff.data?.text ?? (typeof diff.data === 'string' ? diff.data : ''))} /></QueryState> : <StateMessage title="选择文件查看准确差异" icon="code">暂存、提交、丢弃和远端操作是独立动作。</StateMessage>}</section></div> : <QueryState query={tab === 'history' ? log : worktrees} empty={!rows((tab === 'history' ? log : worktrees).data).length}><Records items={rows((tab === 'history' ? log : worktrees).data)} onSelect={item => inspect(context, 'runtime', item)} /></QueryState>}</>;
}
function DiffText({ text }: { text: string }) { return text ? <pre className="nexus-diff">{text.split('\n').map((line, index) => <span className={line.startsWith('+') && !line.startsWith('+++') ? 'is-add' : line.startsWith('-') && !line.startsWith('---') ? 'is-remove' : line.startsWith('@@') ? 'is-hunk' : ''} key={index}>{line}{'\n'}</span>)}</pre> : <StateMessage title="没有差异内容">当前选择没有返回可显示的文本差异。</StateMessage>; }
function TerminalPane({ context }: { context: ViewContext }) {
  const [command, setCommand] = useState('');
  const jobs = useDomain(context, 'runtime', ['jobs.list']);
  const shells = useDomain(context, 'runtime', ['shells']);
  return <><div className="nexus-terminal-intro"><Icon name="terminal" size={25} /><div><h2>在真实执行边界内工作</h2><p>交互终端由宿主 PTY 提供；一次性命令由共享执行器执行。关闭输出不会终止作业。</p></div><Button onClick={() => action(context, 'runtime', ['terminal.open'])}>打开宿主 PTY</Button></div><div className="nexus-command-line"><span aria-hidden="true">›</span><input value={command} onChange={event => setCommand(event.target.value)} placeholder="输入明确的可执行程序，例如 git 或 node" aria-label="待执行命令" /><Button primary disabled={!command.trim()} onClick={() => action(context, 'runtime', ['terminal.run'], { command, args: [], timeoutMs: 60000 })}>编辑参数并执行</Button></div><h3>后台作业</h3><QueryState query={jobs} empty={!rows(jobs.data).length}><Records items={rows(jobs.data)} columns={[{ key: 'command', label: '命令', render: item => item.command ?? titleOf(item) }, { key: 'state', label: '状态', render: item => <Status value={titleStatus(item)} /> }, { key: 'pid', label: '进程' }, { key: 'startedAt', label: '启动时间', render: item => <Time value={item.startedAt} /> }]} onSelect={item => action(context, 'runtime', ['jobs.get'], { id: idOf(item) })} /></QueryState><details className="nexus-details"><summary>实际可用 Shell</summary><QueryState query={shells}><DataView value={shells.data} /></QueryState></details></>;
}
