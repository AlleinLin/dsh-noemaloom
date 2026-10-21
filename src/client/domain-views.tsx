import * as React from 'react';
import { useState } from 'react';
import type { Data, ViewContext } from './types.js';
import { idOf, isRecord, rows, textOf, titleOf, unwrap } from './types.js';
import { ActionShelf, Button, DataView, Icon, IconButton, PageHeader, QueryState, Records, SearchField, StateMessage, Status, Tabs, Time, useDescriptorLocale, useQuery } from './components.js';
import { localizedText } from './localized-text.js';
import { findAction, labelAction } from './catalog.js';
import { McpAppFrame } from './McpAppFrame.js';
import { PairingPanel } from './PairingPanel.js';
import { recoveryMessageBoundaries, recoveryWorkspaceNotice } from './context-prerequisites.js';
import { EvidenceDisclosure, useWorkbenchOperation } from './workbench.js';
export { ContextWorkbench as ContextView, contextWorkbenchBoundary as contextContentBoundary } from './ContextWorkbench.js';
export { QualityWorkbench as QualityView } from './QualityWorkbench.js';

function useDomain(context: ViewContext, domain: string, choices: string[], params: Data = {}, enabled = true) {
  return useQuery(context.api, domain, findAction(context.catalog, domain, choices), params, { scope: context.scope, refresh: context.refreshToken, enabled: enabled && context.catalog.some(item => item.id === domain) });
}
function act(context: ViewContext, domain: string, choices: string[], params?: Data, item?: Data) {
  context.action({ domain, action: findAction(context.catalog, domain, choices), params, id: item ? idOf(item) : undefined, revision: item?.revision });
}
function inspect(context: ViewContext, domain: string, item: Data) { context.inspect({ title: titleOf(item), domain, id: idOf(item), revision: item.revision, data: item }); }
function filtered(items: Data[], search: string) { return search ? items.filter(item => JSON.stringify(item).toLocaleLowerCase().includes(search.toLocaleLowerCase())) : items; }

interface GraphNode extends Data {
  type?: string;
  question?: string;
  versions?: { id: string; text?: string }[];
  activeVersionId?: string;
  content?: string;
  text?: string;
  x?: number;
  y?: number;
}
type PositionedGraphNode = GraphNode & { x: number; y: number };

export function GraphView({ context }: { context: ViewContext }) {
  const [tab, setTab] = useState('canvas');
  const [graphId, setGraphId] = useState('');
  const [search, setSearch] = useState('');
  const [zoom, setZoom] = useState(1);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const list = useDomain(context, 'graph', ['list']);
  const graph = useDomain(context, 'graph', ['get'], { graphId }, !!graphId);
  const workspaceGraphs = useDomain(context, 'graph', ['workspace.list'], {}, context.scope.level === 'session');
  const sources = useDomain(context, 'graph', ['atlas.sources'], {}, tab === 'sources');
  const nodes: GraphNode[] = filtered(rows(graph.data?.nodes), search);
  const edges: Data[] = rows(graph.data?.edges);
  const derived = nodes.map((node, index): PositionedGraphNode => ({ ...node, x: typeof node.x === 'number' && Number.isFinite(node.x) ? node.x : 48 + (index % 4) * 245, y: typeof node.y === 'number' && Number.isFinite(node.y) ? node.y : 55 + Math.floor(index / 4) * 150 }));
  const nodeMap = new Map(derived.map(node => [idOf(node), node]));
  const width = Math.max(900, ...derived.map(node => node.x + 240));
  const height = Math.max(480, ...derived.map(node => node.y + 140));
  const selectNode = (node: Data, additive: boolean) => {
    setSelection(old => { const next = additive ? new Set(old) : new Set<string>(); if (next.has(idOf(node))) next.delete(idOf(node)); else next.add(idOf(node)); return next; });
    inspect(context, 'graph', node);
  };
  const graphList = rows(list.data);
  return <div className="nexus-page nexus-graph-page"><PageHeader title="图谱"><Button icon="refresh" onClick={() => { list.reload(); graph.reload(); }}>刷新</Button><Button primary icon="plus" onClick={() => act(context, 'graph', ['create'], { title: '', description: '' })}>新建画布</Button></PageHeader>{context.scope.level === 'session' && <details className="nexus-workspace-references"><summary>引用工作区图谱</summary><QueryState query={workspaceGraphs}><div className="nexus-reference-list">{rows(workspaceGraphs.data).map(item => <div key={item.id}><span>{titleOf(item)}</span><Button onClick={() => act(context, 'graph', ['workspace.attach'], { graphId: item.id }, item)}>派生到当前会话</Button></div>)}</div></QueryState></details>}<Tabs value={tab} onChange={setTab} tabs={[{ id: 'canvas', label: '画布' }, { id: 'nodes', label: '节点与路径' }, { id: 'sources', label: '来源 Atlas' }, { id: 'topics', label: '主题与追溯' }]} /><div className="nexus-toolbar"><select value={graphId} aria-label="选择画布" onChange={event => { setGraphId(event.target.value); setSelection(new Set()); }}><option value="">选择画布…</option>{graphList.map(item => <option value={idOf(item)} key={idOf(item)}>{titleOf(item)}</option>)}</select><SearchField value={search} onChange={setSearch} placeholder="搜索当前图谱节点…" />{graphId && <Button onClick={() => act(context, 'graph', ['node.add'], { graphId, type: 'material', question: '', text: '' })}>新增节点</Button>}{tab === 'canvas' && graphId && <div className="nexus-zoom"><button aria-label="缩小画布" onClick={() => setZoom(value => Math.max(.35, value - .1))}>−</button><span>{Math.round(zoom * 100)}%</span><button aria-label="放大画布" onClick={() => setZoom(value => Math.min(2, value + .1))}>＋</button><button onClick={() => setZoom(1)}>复位</button></div>}</div>{tab === 'sources' ? <QueryState query={sources}><Records items={rows(sources.data)} onSelect={item => inspect(context, 'graph', item)} /></QueryState> : tab === 'topics' ? <div className="nexus-editorial-actions">{[['topic.list', '主题目录', '按主题组织关联材料、会话与证据。'], ['topic.dossier', '主题档案', '从真实来源构建可追溯档案。'], ['why.find', '原因追溯', '定位文件与决策背后的证据链。'], ['recall', '关联回忆', '检索既有图谱与上下文来源。']].map(([method, title, description]) => <button key={method} onClick={() => act(context, 'graph', [method], { graphId })}><Icon name="graph" /><strong>{title}</strong></button>)}</div> : graphId ? <QueryState query={graph} empty={!nodes.length}>{tab === 'nodes' ? <Records items={nodes} columns={[{ key: 'question', label: '节点', render: node => node.question ?? titleOf(node) }, { key: 'type', label: '类型' }, { key: 'source', label: '来源', render: node => node.source?.type ?? node.sourceId ?? '未报告' }, { key: 'state', label: '状态', render: node => <Status value={node.state ?? node.status ?? 'unknown'} /> }]} onSelect={node => selectNode(node, false)} /> : <div className="nexus-graph-scroll" aria-label="可缩放图谱画布"><div className="nexus-graph-canvas" style={{ width: width * zoom, height: height * zoom }}><div style={{ width, height, transform: `scale(${zoom})`, transformOrigin: '0 0', position: 'relative' }}><svg className="nexus-graph-edges" width={width} height={height} aria-label={`${edges.length} 条真实关系`}><defs><marker id="nexus-edge-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 8 4 0 8" fill="currentColor" /></marker></defs>{edges.map((edge, index) => { const from = nodeMap.get(String(edge.from ?? edge.source)), to = nodeMap.get(String(edge.to ?? edge.target)); if (!from || !to) return null; return <g key={edge.id ?? index} className={`nexus-edge nexus-edge-${edge.type ?? 'reference'}`}><path d={`M${from.x + 205} ${from.y + 44}C${from.x + 250} ${from.y + 44},${to.x - 45} ${to.y + 44},${to.x} ${to.y + 44}`} markerEnd="url(#nexus-edge-arrow)" /><text x={(from.x + to.x + 205) / 2} y={(from.y + to.y) / 2 + 35}>{edge.label ?? edge.type ?? '关系未标注'}</text></g>; })}</svg>{derived.map(node => <button key={idOf(node)} className={`nexus-graph-node ${selection.has(idOf(node)) ? 'is-selected' : ''}`} style={{ left: node.x, top: node.y }} aria-pressed={selection.has(idOf(node))} onClick={event => selectNode(node, event.shiftKey || event.ctrlKey || event.metaKey)} onDoubleClick={() => act(context, 'graph', ['node.update'], { graphId, nodeId: idOf(node) }, node)}><small><Icon name={node.type === 'conversation' ? 'chat' : 'file'} size={13} />{node.type ?? '节点'}</small><strong>{node.question ?? titleOf(node)}</strong><span>{node.versions?.find((version: Data) => version.id === node.activeVersionId)?.text ?? node.content ?? node.text ?? idOf(node)}</span></button>)}</div></div></div>}<div className="nexus-graph-selection"><span>已选 {selection.size} 个节点 · shift / Ctrl 可多选</span><Button disabled={!selection.size} onClick={() => act(context, 'graph', ['context.preview'], { graphId, nodeId: [...selection][0] })}>预览上下文</Button><Button disabled={!selection.size} onClick={() => act(context, 'graph', ['condense.preview'], { graphId, nodeId: [...selection][0] })}>凝练预演</Button><Button onClick={() => act(context, 'graph', ['export'], { graphId, includeContent: false })}>导出结构</Button></div></QueryState> : <QueryState query={list} empty={!graphList.length}><Records items={graphList} onSelect={item => setGraphId(idOf(item))} /></QueryState>}<ActionShelf context={context} domains={['graph']} /></div>;
}

export function RecoveryView({ context }: { context: ViewContext }) {
  const [tab, setTab] = useState('checkpoints');
  const [boundary, setBoundary] = useState(''), [preview, setPreview] = useState<Data>(), [applied, setApplied] = useState<Data>();
  const sessionId = context.scope.sessionId ?? '';
  const snapshot = useDomain(context, 'agents', ['session/snapshot'], { sessionId }, Boolean(sessionId));
  const boundaries = recoveryMessageBoundaries(snapshot.data, sessionId);
  const selected = boundaries.find(item => String(item.seq) === boundary);
  const operation = useWorkbenchOperation(context);
  const checkpoints = useDomain(context, 'recovery', ['list']);
  const operations = useDomain(context, 'recovery', ['operations'], {}, tab === 'operations');
  const inventory = useDomain(context, 'recovery', ['inventory'], {}, tab === 'inventory');
  const query = tab === 'operations' ? operations : tab === 'inventory' ? inventory : checkpoints;
  const workspaceNotice = recoveryWorkspaceNotice(query.error);
  return <div className="nexus-page">
    <PageHeader title="运行与恢复"><Button icon="refresh" onClick={() => { query.reload(); snapshot.reload(); }}>刷新</Button></PageHeader>
    {operation.feedback}
    {sessionId && <QueryState query={snapshot}><section className="nexus-workbench-section">
      <h2>恢复到用户回合之前</h2><p>从原生用户消息选择边界。应用后创建恢复会话，原会话保留，文件不变。</p>
      <label className="nexus-field"><span>用户消息</span><select value={boundary} onChange={event => { setBoundary(event.target.value); setPreview(undefined); setApplied(undefined); }}>
        <option value="">选择要重新开始的用户消息…</option>{boundaries.map(item => <option key={item.seq} value={item.seq}>{item.label}</option>)}
      </select></label>
      <Button primary disabled={!selected || Boolean(operation.busy)} onClick={() => {
        if (!selected) return;
        void operation.run('创建恢复预演', 'recovery', 'plan', { mode: 'conversation-only', sessionId, openingMessageSeq: selected.seq }, { mutating: true })
          .then(result => { if (result) { setPreview(result); setApplied(undefined); } });
      }}>创建恢复预演</Button>
      {preview && <div><p>用户消息 #{preview.boundary?.openingMessageSeq} · 预演有效至 <Time value={preview.expiresAt} /></p>
        <Button primary disabled={Boolean(applied)} busy={Boolean(operation.busy)} onClick={() => void operation.run('应用恢复预演', 'recovery', 'apply',
          { sessionId, planId: preview.id, idempotencyKey: `recovery-ui:${preview.id}` }, { mutating: true })
          .then(result => { if (result) { setApplied(result); operations.reload(); } })}>创建恢复会话</Button>
        {applied && <><Status value={applied.phase} />{applied.childSessionId && applied.phase === 'completed' && <Button onClick={() => context.openNativeSession(applied.childSessionId)}>打开恢复会话</Button>}</>}
        <EvidenceDisclosure title="恢复计划与执行回执" value={{ preview, applied }} />
      </div>}
    </section></QueryState>}
    <Tabs value={tab} onChange={setTab} tabs={[{ id: 'checkpoints', label: '已有恢复点' }, { id: 'operations', label: '恢复操作' }, { id: 'inventory', label: '存储清单' }]} />
    {workspaceNotice ? <div className="nexus-error" role="alert"><Icon name="error" /><div><strong>文件恢复暂不可用</strong><p>{workspaceNotice}</p></div></div> : <QueryState query={query} empty={Array.isArray(query.data) && rows(query.data).length === 0}>{rows(query.data).length ? <div className="nexus-recovery-list">{rows(query.data).map((item, index) => <article key={idOf(item) || index}><div className="nexus-plan-icon"><Icon name="history" size={23} /></div><button className="nexus-plan-description" onClick={() => inspect(context, 'recovery', item)}><strong data-nexus-verbatim="">{titleOf(item)}</strong><small>{item.mode ?? item.phase ?? item.sessionId ?? '恢复记录'}</small><Time value={item.createdAt ?? item.updatedAt} /></button><Status value={item.phase ?? item.state ?? 'unknown'} /><Button onClick={() => act(context, 'recovery', tab === 'operations' ? ['operation'] : ['preview'], tab === 'operations' ? { operationId: idOf(item) } : { checkpointId: idOf(item) })}>查看影响</Button></article>)}</div> : <DataView value={query.data} />}</QueryState>}
    <ActionShelf context={context} domains={['recovery', 'runtime']} />
  </div>;
}

/** The resource registry keeps multilingual descriptors intact for inspection and editing. */
export function ResourceListItem({ context, item, tab }: { context: ViewContext; item: Data; tab: string }) {
  const locale = useDescriptorLocale();
  const open = () => tab === 'artifacts'
    ? context.inspect({ title: titleOf(item, locale), kind: '产物', data: item, body: <ArtifactViewer context={context} artifactId={idOf(item)} /> })
    : inspect(context, tab === 'presets' ? 'presets' : 'resources', item);
  return <article>
    <div className="nexus-resource-icon"><Icon name={tab === 'models' ? 'gauge' : item.kind === 'skill' ? 'book' : 'file'} size={23} /></div>
    <div><button className="nexus-cell-link" onClick={open}><span data-nexus-verbatim="">{titleOf(item, locale)}</span></button>
      <p data-nexus-verbatim="">{localizedText(item.description ?? item.model ?? item.path, locale, '查看来源、内容与配置')}</p>
      <small>{localizedText(item.source ?? item.provider, locale, '来源未报告')} · {localizedText(item.license, locale, '许可未报告')}{item.version && ` · ${localizedText(item.version, locale)}`}</small>
    </div>
    <div className="nexus-resource-trailing">
      <Status value={item.state ?? item.status ?? (item.enabled === true ? 'enabled' : item.enabled === false ? 'disabled' : 'unknown')} />
      <Button onClick={() => tab === 'artifacts' ? open() : act(context, tab === 'presets' ? 'presets' : item.resourceDomain ?? 'resources', tab === 'market' ? ['market.install'] : ['get'], { id: idOf(item), kind: item.kind, ...(tab === 'market' ? { dryRun: true } : {}) }, item)}>{tab === 'market' ? '预检安装' : '查看详情'}</Button>
    </div>
  </article>;
}

export function ResourcesView({ context, extensions = false }: { context: ViewContext; extensions?: boolean }) {
  const locale = useDescriptorLocale();
  const [tab, setTab] = useState(extensions ? 'capabilities' : context.scope.level === 'session' || context.scope.level === 'workspace' ? 'artifacts' : 'installed');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const query = useDomain(context, 'resources', tab === 'models' ? ['models.list'] : tab === 'market' ? ['market.search'] : ['list'], { kind: tab === 'market' ? (['theme', 'pet', 'plugin', 'preset'].includes(kind) ? kind : undefined) : kind === 'all' ? undefined : kind, query: search }, !['capabilities', 'extensions', 'presets', 'artifacts'].includes(tab));
  const installed = useDomain(context, 'extensions', ['list'], {}, tab === 'extensions');
  const presets = useDomain(context, 'presets', ['list'], {}, tab === 'presets');
  const artifacts = useDomain(context, 'artifact', ['list'], {}, tab === 'artifacts');
  const activeQuery = tab === 'extensions' ? installed : tab === 'presets' ? presets : tab === 'artifacts' ? artifacts : query;
  const items = filtered(rows(activeQuery.data), search);
  const installedItems = rows(installed.data?.installed);
  return <div className="nexus-page"><PageHeader title={extensions ? '能力与扩展' : '产物与资源'}><Button icon="refresh" onClick={activeQuery.reload}>刷新</Button><Button primary onClick={() => act(context, tab === 'extensions' ? 'extensions' : 'resources', tab === 'extensions' ? ['inspect'] : ['import'], tab === 'extensions' ? { source: '', mode: 'native-managed' } : { path: '', dryRun: true })}>{tab === 'extensions' ? '预检插件包' : '导入资源'}</Button></PageHeader><Tabs value={tab} onChange={setTab} tabs={[{ id: 'artifacts', label: '产物' }, { id: 'installed', label: '已装资源' }, { id: 'presets', label: '预设' }, { id: 'models', label: '模型目录' }, { id: 'market', label: '资源市场' }, { id: 'capabilities', label: '领域能力' }, { id: 'extensions', label: '插件与沙箱' }]} /><div className="nexus-toolbar"><SearchField value={search} onChange={setSearch} placeholder="搜索名称、来源或能力…" /><select value={kind} onChange={event => setKind(event.target.value)} aria-label="资源类型"><option value="all">全部类型</option><option value="skill">技能</option><option value="agent">代理</option><option value="preset">预设</option><option value="theme">主题</option><option value="pet">宠物</option><option value="background">背景</option><option value="plugin">插件</option></select></div>{tab === 'capabilities' ? <div className="nexus-capability-list">{context.catalog.filter(domain => JSON.stringify(domain).toLowerCase().includes(search.toLowerCase())).map(domain => <section key={domain.id}><div><Icon name="grid" size={21} /><h3>{domain.id}</h3><span>{domain.capabilities.length} 项操作</span></div><p>{domain.capabilities.slice(0, 4).map(item => localizedText(item.description, locale)).join('；')}</p><Button onClick={() => context.inspect({ title: `${domain.id} 能力目录`, kind: '宿主报告', data: domain })}>权限与 Schema</Button><Status value="available" /></section>)}</div> : <QueryState query={activeQuery} empty={!items.length && !(tab === 'extensions' && installedItems.length)}>{tab === 'extensions' && installedItems.length ? <Records items={installedItems} onSelect={item => inspect(context, 'extensions', item)} /> : <div className="nexus-resource-list">{items.map((item, index) => <ResourceListItem key={idOf(item) || index} context={context} item={item} tab={tab} />)}</div>}</QueryState>}{tab === 'extensions' && <div className="nexus-notice-inline"><Icon name="info" /></div>}<ActionShelf context={context} domains={tab === 'extensions' ? ['extensions'] : tab === 'presets' ? ['presets'] : tab === 'artifacts' ? ['artifact'] : ['resources', 'agents']} /></div>;
}

export function ConnectionsView({ context, embedded = false }: { context: ViewContext; embedded?: boolean }) {
  const [tab, setTab] = useState('hosts');
  const [search, setSearch] = useState('');
  const query = useDomain(context, 'connections', ['list']);
  const items = filtered(rows(query.data), search);
  const hosts = items.filter(item => item.type === 'ssh' || item.type === 'host');
  const remotes = items.filter(item => item.type !== 'ssh' && item.type !== 'host');
  return <div className={embedded ? '' : 'nexus-page'}>{!embedded && <PageHeader title="连接与远程"><Button icon="refresh" onClick={query.reload}>刷新</Button><Button primary onClick={() => act(context, 'connections', ['save'], { name: '', type: 'ssh', hostname: '', port: 22, username: '', credentialRef: '', forwardAgent: false })}>新增连接</Button></PageHeader>}<Tabs value={tab} onChange={setTab} tabs={[{ id: 'hosts', label: 'SSH 主机' }, { id: 'remote', label: '手机与 Web' }, { id: 'services', label: '服务与渠道' }]} />{tab === 'remote' && <><div className="nexus-remote-protocols"><article><PairingPanel context={context} protocol="native" /></article><article><PairingPanel context={context} protocol="web" /></article></div><PairedDevices context={context} /></>}<div className="nexus-toolbar"><SearchField value={search} onChange={setSearch} placeholder="搜索连接、主机或分组…" />{tab === 'hosts' && <Button onClick={() => act(context, 'connections', ['ssh.import.preview'], { path: '' })}>导入 SSH config 预演</Button>}</div><QueryState query={query} empty={!items.length}><div className="nexus-connection-list">{(tab === 'hosts' ? hosts : remotes).map((item, index) => <article key={idOf(item) || index}><div className="nexus-plan-icon"><Icon name={tab === 'hosts' ? 'terminal' : 'link'} size={21} /></div><button className="nexus-plan-description" onClick={() => inspect(context, 'connections', item)}><strong data-nexus-verbatim="">{titleOf(item)}</strong><small>{item.hostname ?? item.config?.host ?? item.host ?? item.type ?? '连接类型未报告'}{(item.port ?? item.config?.port) ? `:${item.port ?? item.config.port}` : ''}</small><Time value={item.lastActivityAt ?? item.lastTestedAt ?? item.updatedAt} /></button><Status value={item.status ?? item.state ?? 'unknown'} /><div className="nexus-actions"><Button onClick={() => act(context, 'connections', ['test'], { id: idOf(item) })}>测试</Button>{tab === 'hosts' && <Button onClick={() => act(context, 'connections', ['ssh.exec'], { id: idOf(item), command: '', args: [], timeoutMs: 60000 })}>执行</Button>}<Button onClick={() => act(context, 'connections', ['save'], { ...item, id: idOf(item) }, item)}>配置</Button></div></article>)}</div></QueryState><ActionShelf context={context} domains={['connections']} /></div>;
}

function PairedDevices({ context }: { context: ViewContext }) {
  const native = useDomain(context, 'connections', ['native.devices']);
  const web = useDomain(context, 'connections', ['remote.devices']);
  const devices = [...rows(native.data).filter(item => item.protocol !== 'web-v1'), ...rows(web.data)];
  return <section className="nexus-paired-devices"><div className="nexus-section-heading"><h2>已配对设备</h2><Button icon="refresh" onClick={() => { native.reload(); web.reload(); }}>刷新设备</Button></div><QueryState query={native}><QueryState query={web} empty={!devices.length}><div className="nexus-connection-list">{devices.map(item => <article key={item.deviceId}><div className="nexus-plan-icon"><Icon name="link" /></div><button className="nexus-plan-description" onClick={() => context.inspect({ title: item.name ?? item.deviceId, kind: '设备权限与身份', data: item })}><strong data-nexus-verbatim="">{item.name ?? item.deviceId}</strong><small data-nexus-verbatim="">{item.protocol} · {item.fingerprint}</small><Time value={item.lastSeenAt ?? item.pairedAt} /></button><Status value={item.revoked ? 'disabled' : item.online ? 'active' : 'unknown'} /><Button disabled={item.revoked} onClick={() => act(context, 'connections', [item.protocol === 'web-v1' ? 'remote.revoke' : 'native.revoke'], { deviceId: item.deviceId })}>撤销设备</Button></article>)}</div></QueryState></QueryState></section>;
}

export function UsageView({ context, cache = false }: { context: ViewContext; cache?: boolean }) {
  const [tab, setTab] = useState('requests');
  const [range, setRange] = useState('7d');
  const [search, setSearch] = useState('');
  const summary = useDomain(context, 'usage', ['summary'], { range });
  const query = useDomain(context, 'usage', tab === 'accounts' ? ['accounts.list'] : tab === 'prices' ? ['prices.list'] : ['list'], { range });
  const data = summary.data ?? {};
  const requests = filtered(rows(query.data), search);
  return <div className="nexus-page"><PageHeader title={cache ? '缓存与费用' : '模型与用量'}><select value={range} onChange={event => setRange(event.target.value)} aria-label="用量时间范围"><option value="today">今日</option><option value="7d">近 7 日</option><option value="30d">近 30 日</option><option value="all">全部</option></select><Button icon="refresh" onClick={() => { summary.reload(); query.reload(); }}>刷新</Button></PageHeader><QueryState query={summary}><dl className="nexus-usage-totals">{[['实际总费用', data.actualCost ?? data.cost ?? data.totalCost], ['模型请求 / attempt', data.attempts ?? data.requestCount ?? data.requests], ['输入 token', data.inputTokens], ['输出 token', data.outputTokens], ['缓存读取 token', data.cachedReadTokens ?? data.cacheReadTokens]].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value === undefined || value === null ? <span className="nexus-muted">未报告</span> : typeof value === 'number' ? value.toLocaleString('zh-CN', { maximumFractionDigits: 6 }) : textOf(value)}</dd></div>)}</dl>{data.currency && <p className="nexus-muted">币种：{data.currency} · 不同币种不直接相加</p>}</QueryState><Tabs value={tab} onChange={setTab} tabs={[{ id: 'requests', label: '请求明细' }, { id: 'accounts', label: '账户与余额' }, { id: 'prices', label: '价格快照' }]} /><div className="nexus-toolbar"><SearchField value={search} onChange={setSearch} placeholder="搜索提供方、模型或请求 ID…" />{tab === 'accounts' && <Button onClick={() => act(context, 'usage', ['accounts.refresh'])}>探测账户余额</Button>}{tab === 'prices' && <Button onClick={() => act(context, 'usage', ['prices.save'], { provider: '', model: '', currency: 'USD', source: '', observedAt: new Date().toISOString() })}>编辑价格来源</Button>}</div><QueryState query={query} empty={!requests.length}><Records items={requests} columns={tab === 'requests' ? [{ key: 'model', label: '模型 / 请求', render: item => <span>{item.provider ?? '提供方未报告'} / {item.model ?? '模型未报告'}<small className="nexus-id">{item.attemptId ?? item.requestId ?? item.id}</small></span> }, { key: 'usageSource', label: 'usage 来源', render: item => <Status value={item.usageSource ?? item.source ?? 'not-reported'} /> }, { key: 'cost', label: '费用', render: item => item.actualCost !== undefined || item.cost !== undefined ? `${item.actualCost ?? item.cost} ${item.currency ?? ''}` : '未报告' }, { key: 'observedAt', label: '观测时间', render: item => <Time value={item.observedAt ?? item.createdAt} /> }] : undefined} onSelect={item => inspect(context, 'usage', item)} /></QueryState><ActionShelf context={context} domains={['usage']} /></div>;
}

export function SearchView({ context }: { context: ViewContext }) {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState<Data>();
  const [mode, setMode] = useState('local');
  const [type, setType] = useState(context.scope.level === 'session' ? 'session' : 'all');
  const result = useDomain(context, 'search', ['query'], submitted ?? {}, Boolean(submitted));
  const items = rows(result.data);
  const groups = new Map<string, Data[]>();
  for (const item of items) { const kind = item.type ?? item.kind ?? item.domain ?? '其他'; const group = groups.get(kind) ?? []; group.push(item); groups.set(kind, group); }
  return <div className="nexus-page"><PageHeader title={context.scope.level === 'session' ? '会话搜索' : '搜索'} />
    <form className="nexus-search-form" onSubmit={event => {
      event.preventDefault();
      if (!query.trim()) return;
      const next = { query: query.trim(), mode, ...(mode === 'local' ? { type } : {}) };
      if (JSON.stringify(next) === JSON.stringify(submitted)) result.reload(); else setSubmitted(next);
    }}>
      <SearchField value={query} onChange={setQuery} placeholder={context.scope.level === 'session' ? '搜索本会话或所在工作区…' : '搜索当前范围…'} />
      <select aria-label="搜索模式" value={mode} onChange={event => setMode(event.target.value)}><option value="local">本地关键词搜索</option><option value="web">外部 Web 搜索</option></select>
      {mode === 'local' && <select aria-label="结果类型" value={type} onChange={event => setType(event.target.value)}><option value="all">全部类型</option><option value="session">{context.scope.level === 'session' ? '本会话正文' : '会话'}</option><option value="memory">记忆</option><option value="file">工作区文件</option><option value="task">任务</option><option value="resource">资源</option></select>}
      <Button primary type="submit" disabled={!query.trim()}>搜索</Button>
    </form>
    {mode === 'web' && <div className="nexus-notice-inline"><Icon name="info" /><p>点击搜索后，查询才会发送给已配置的联网提供方。</p></div>}
    {submitted ? <><QueryState query={result} empty={!items.length}>{[...groups.entries()].map(([kind, entries]) => <section className="nexus-search-group" key={kind}><h2>{kind}<small>已载 {entries.length} 项</small></h2>{entries.map((item, index) => <button key={idOf(item) || index} className="nexus-search-result" onClick={() => inspect(context, item.domain ?? 'search', item)}><strong data-nexus-verbatim="">{titleOf(item)}</strong><p data-nexus-verbatim="">{item.snippet ?? item.description ?? item.content ?? ''}</p><small>{item.path ?? item.url ?? item.source ?? item.id}</small></button>)}</section>)}</QueryState>
      {result.data?.modeUsed === 'local-keyword' && <div className="nexus-workbench-hint">本地关键词 · 未联网{result.data.complete ? '' : ' · 部分来源未覆盖或结果达到上限'}<EvidenceDisclosure title="搜索覆盖" value={result.data.coverage} /></div>}
    </> : <StateMessage title="从当前范围寻找线索" icon="search">本地搜索不调用模型；会话正文仅检索当前会话，文件使用所在工作区。</StateMessage>}
    <ActionShelf context={context} domains={['search']} />
  </div>;
}

function ArtifactViewer({ context, artifactId }: { context: ViewContext; artifactId: string }) {
  const [tab, setTab] = useState('preview');
  const content = useDomain(context, 'artifact', ['get'], { artifactId });
  const preview = useDomain(context, 'artifact', ['preview'], { artifactId }, tab === 'preview');
  const artifact = unwrap(content.data ?? {});
  const rendered = unwrap(preview.data ?? {});
  return <section className="nexus-artifact-viewer"><Tabs value={tab} onChange={setTab} tabs={[{ id: 'preview', label: '预览' }, { id: 'source', label: '源码' }, { id: 'evidence', label: '证据' }]} /><div className="nexus-actions"><Button onClick={() => act(context, 'artifact', ['render'], { artifactId })}>渲染产物</Button><Button onClick={() => act(context, 'artifact', ['export'], { artifactId, path: '' })}>导出</Button><Button onClick={() => act(context, 'artifact', ['cold_review'], { artifactId })}>独立冷读审查</Button></div>{tab === 'source' ? <QueryState query={content}><pre className="nexus-artifact-source" data-nexus-verbatim="">{artifact.content ?? ''}</pre></QueryState> : tab === 'evidence' ? <QueryState query={content}><DataView value={{ validation: artifact.validation, reviewRefs: artifact.reviewRefs, sourceRefs: artifact.sourceRefs, contentHash: artifact.contentHash, licenses: artifact.licenses }} /></QueryState> : <QueryState query={preview}>{String(rendered.mediaType).includes('html') || String(rendered.mediaType).includes('svg') || /^\s*(?:<!doctype\s+html|<html\b)/i.test(rendered.content ?? '') ? <McpAppFrame context={context} artifactId={artifactId} source={artifact.title ?? artifactId} html={rendered.content ?? ''} revision={artifact.revision} /> : <pre className="nexus-artifact-source" data-nexus-verbatim="">{rendered.content ?? artifact.content ?? ''}</pre>}</QueryState>}</section>;
}
