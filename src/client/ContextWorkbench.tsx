import * as React from 'react';
import type { Data, ViewContext } from './types.js';
import { rows } from './types.js';
import { Button, PageHeader, QueryState, SearchField, StateMessage, Tabs, Time, useQuery } from './components.js';
import { contextViewPrerequisites } from './context-prerequisites.js';
import { EvidenceDisclosure, useWorkbenchOperation } from './workbench.js';
import { pathLines } from './QualityWorkbench.js';

const modes: Data = { auto: '自动压缩', observe: '仅观察', disabled: '已停用' };
export function compressionBlockState(block: Data) {
  return block.restoredInline ? '原文已恢复' : block.expanded ? '已展开' : block.active ? '压缩生效中' : '已由后续压缩合并';
}
export function compressionBlockRange(block: Data, refs: Data = {}) {
  const ids: string[] = block.effectiveMessageIds ?? block.directMessageIds ?? [];
  return { startRef: block.startRef ?? refs.byRaw?.[ids[0]], endRef: block.endRef ?? refs.byRaw?.[ids.at(-1) ?? ''] };
}
export function cacheEvidenceSummary(data: Data) {
  const observed = data.evidence === 'provider-reported' && data.coverage?.reported > 0;
  return { observed, totals: observed ? data.report?.totals ?? {} : {}, coverage: data.coverage ?? {},
    share: observed && typeof data.cacheReadShare === 'number' ? data.cacheReadShare : null };
}
export function compressionResultSummary(result: Data): { text: string; errors: string[]; reason?: string } {
  const applied = result.applied && typeof result.applied === 'object' ? result.applied : result;
  if (result.decision === 'wait') return { text: '当前无需压缩', errors: [], reason: result.reason === 'no-candidate' ? '没有可压缩的候选范围' : result.reason };
  if (result.decision === 'observe') return { text: '当前处于观察模式，未应用压缩', errors: [] };
  return { text: applied.blocksCreated > 0 ? `已新增 ${applied.blocksCreated} 个压缩块` : '未新增压缩块', errors: applied.errors ?? [] };
}
export function ContextWorkbench({ context }: { context: ViewContext; cache?: boolean }) {
  const [tab, setTab] = React.useState('compression');
  const [refresh, setRefresh] = React.useState(0);
  return <div className="nexus-page nexus-workbench nexus-context-workbench">
    <PageHeader title="压缩与恢复"><Button icon="refresh" onClick={() => setRefresh(value => value + 1)}>刷新</Button></PageHeader>
    <Tabs value={tab} onChange={setTab} tabs={[{ id: 'compression', label: '压缩记录' }, { id: 'policy', label: '压缩设置' }, { id: 'cache', label: '缓存证据' }]} />
    {contextWorkbenchBoundary(context, context.scope.sessionId ?? '', tab, refresh)}
  </div>;
}

/** A changed read identity retires its rows, errors and mutation callbacks together. */
export function contextWorkbenchBoundary(context: ViewContext, sessionId: string, tab: string, refresh = 0) {
  const prerequisites = contextViewPrerequisites(sessionId, tab);
  const action = prerequisites.hasSession ? prerequisites.queries.detail.action : prerequisites.queries.overview.action;
  return <ContextWorkbenchContent key={JSON.stringify([context.scope.workspaceId ?? null, prerequisites.sessionId, action])}
    context={{ ...context, refreshToken: context.refreshToken + refresh }} prerequisites={prerequisites} tab={tab} />;
}

function ContextWorkbenchContent({ context, prerequisites, tab }: { context: ViewContext; prerequisites: ReturnType<typeof contextViewPrerequisites>; tab: string }) {
  const { hasSession, params } = prerequisites;
  const status = useQuery(context.api, 'context', hasSession ? 'status' : 'overview', params, { scope: context.scope, enabled: true, refresh: context.refreshToken });
  const detail = useQuery(context.api, 'context', prerequisites.queries.detail.action, params, { scope: context.scope,
    enabled: hasSession && prerequisites.queries.detail.action !== 'status', refresh: context.refreshToken });
  const [search, setSearch] = React.useState(''), [manual, setManual] = React.useState(false);
  const [startRef, setStartRef] = React.useState(''), [endRef, setEndRef] = React.useState('');
  const [summary, setSummary] = React.useState(''), [topic, setTopic] = React.useState('');
  const [decision, setDecision] = React.useState<Data>();
  const operation = useWorkbenchOperation(context, () => { status.reload(); detail.reload(); });
  const data = status.data ?? {};
  const hasMessages = Object.keys(data.refs?.byRef ?? {}).length > 0;
  const blocks = rows(data.blocks).filter(block => `${block.blockId} ${block.topic ?? ''} ${block.summary ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const inFlight = Boolean(data.inFlight?.length);
  async function act(label: string, action: string, values: Data = {}, mutating = true) {
    if (!hasSession) return;
    return operation.run(label, 'context', action, { ...params, ...values }, { mutating });
  }
  async function restore(block: Data, mode: string) {
    const result = await act(mode === 'peek' ? '读取原文' : mode === 'file' ? '导出原文' : '恢复原文',
      mode === 'peek' ? 'decompress/peek' : 'decompress',
      { blockId: block.blockId, ...(mode === 'peek' ? {} : { mode }), full: true }, mode !== 'peek');
    if (result) context.inspect({ title: mode === 'peek' ? `${block.topic ?? block.blockId} · 精确原文` : mode === 'file' ? '原文导出回执' : '原文恢复回执',
      kind: '压缩来源', data: result, body: mode === 'peek' ? <div className="nexus-workbench-original"><pre data-nexus-verbatim="">{result.text}</pre><EvidenceDisclosure title="原文校验与消息来源" value={{ exact: result.exact, sha256: result.sha256, count: result.count, messages: result.messages }} /></div> : undefined });
  }
  if (!hasSession) return <><StateMessage title="请先打开一个会话">压缩记录和策略属于具体会话。</StateMessage><QueryState query={status}><EvidenceDisclosure title="工作区上下文概览" value={status.data} /></QueryState></>;
  return <>{operation.feedback}
    {tab === 'compression' && <QueryState query={status}>
      <div className="nexus-workbench-context-status"><span>{modes[data.mode] ?? data.mode}</span><span>{data.originals ?? data.originalMessages ?? 0} 条原始消息</span><span>{rows(data.blocks).filter(block => block.active && !block.restoredInline && !block.expanded).length} 个生效压缩块</span>{inFlight && <span>请求进行中</span>}</div>
      {data.state === 'unobserved' && <p className="nexus-workbench-hint">尚未收到模型窗口数据。可在压缩设置中填写窗口，或等待本会话的真实请求。</p>}
      <div className="nexus-toolbar"><SearchField value={search} onChange={setSearch} placeholder="搜索压缩块、主题或摘要…" /><Button disabled={!hasMessages} onClick={() => setManual(value => !value)}>{manual ? '收起手动压缩' : '手动压缩范围'}</Button><Button primary busy={Boolean(operation.busy)} disabled={inFlight || data.mode !== 'auto' || !hasMessages} onClick={() => void act('自动分析并压缩', 'decide').then(result => { if (result) setDecision(result); })}>自动分析并压缩</Button></div>
      {!hasMessages && <p className="nexus-workbench-hint">尚未收到本会话的模型上下文，产生实际请求后可查看消息引用和压缩范围。</p>}
      {data.mode !== 'auto' && <p className="nexus-workbench-hint">在压缩设置中切换为自动压缩后，可应用新的压缩。</p>}
      {decision && <div className="nexus-workbench-action-result" role="status"><strong>{compressionResultSummary(decision).text}</strong>{compressionResultSummary(decision).reason && <p>{compressionResultSummary(decision).reason}</p>}{compressionResultSummary(decision).errors.map((error: string, index: number) => <p key={index}>{error}</p>)}<EvidenceDisclosure title="本次操作回执" value={decision} /></div>}
      {manual && <form className="nexus-workbench-section" onSubmit={event => { event.preventDefault(); void act('压缩指定范围', 'compress', { ranges: [{ startRef: startRef.trim(), endRef: endRef.trim(), summary: summary.trim(), ...(topic.trim() ? { topic: topic.trim() } : {}) }] }).then(result => { if (result) { setDecision(result); if (result.blocksCreated > 0) { setManual(false); setSummary(''); } } }); }}>
        <h2>手动压缩范围</h2><div className="nexus-workbench-form"><label className="nexus-field"><span>起始引用</span><input required value={startRef} placeholder="m1" onChange={e => setStartRef(e.target.value)} /></label><label className="nexus-field"><span>结束引用</span><input required value={endRef} placeholder="m8" onChange={e => setEndRef(e.target.value)} /></label><label className="nexus-field nexus-workbench-wide"><span>保留摘要</span><textarea required rows={4} value={summary} onChange={e => setSummary(e.target.value)} /></label><label className="nexus-field nexus-workbench-wide"><span>主题（可选）</span><input value={topic} onChange={e => setTopic(e.target.value)} /></label></div>
        <details className="nexus-workbench-evidence"><summary>查看可用消息引用</summary><div className="nexus-workbench-ref-list">{Object.entries(data.refs?.byRef ?? {}).map(([ref, id]) => <code key={ref}>{ref} · {String(id)}</code>)}</div></details>
        <Button primary type="submit" busy={Boolean(operation.busy)} disabled={inFlight || data.mode !== 'auto' || !startRef.trim() || !endRef.trim() || !summary.trim()}>压缩此范围</Button>
      </form>}
      {blocks.length ? <div className="nexus-workbench-blocks">{blocks.map(block => { const range = compressionBlockRange(block, data.refs); return <article key={block.blockId}>
        <div className="nexus-workbench-block-heading"><strong>{block.topic || block.blockId}</strong><span>T{block.tier} · {compressionBlockState(block)}</span></div>
        <p data-nexus-verbatim="">{block.summary}</p><div className="nexus-workbench-block-meta"><code>{block.blockId}{range.startRef && ` · ${range.startRef} → ${range.endRef ?? range.startRef}`}</code><span>{block.effectiveMessageIds?.length ?? 0} 条原文 · 摘要 {block.compressedTokens ?? '—'} token</span><Time value={block.createdAt} /></div>
        <div className="nexus-actions"><Button disabled={Boolean(operation.busy)} onClick={() => void restore(block, 'peek')}>查看原文</Button><Button disabled={Boolean(operation.busy) || inFlight || block.restoredInline} onClick={() => void restore(block, 'expand')}>恢复原文到会话</Button><Button disabled={Boolean(operation.busy)} onClick={() => void restore(block, 'file')}>导出原文</Button></div>
      </article>; })}</div> : <StateMessage title={search ? '没有匹配的压缩块' : '尚无压缩记录'}>{search ? '调整搜索词或清除搜索。' : '可自动分析当前上下文，或指定消息引用手动压缩。'}</StateMessage>}
      <details className="nexus-workbench-evidence"><summary>状态与压缩证据</summary><pre data-nexus-verbatim="">{data.text ?? ''}</pre><EvidenceDisclosure title="会话状态、压缩块与引用" value={data} /><ContextAdvancedEvidence context={context} params={params} /></details>
    </QueryState>}
    {tab === 'policy' && <QueryState query={detail}><ContextPolicyEditor key={JSON.stringify(detail.data)} context={context} params={params} policy={detail.data ?? {}} inFlight={inFlight} reload={detail.reload} /></QueryState>}
    {tab === 'cache' && <QueryState query={detail}><CacheEvidence data={detail.data ?? {}} /></QueryState>}
    {tab === 'epochs' || tab === 'prefix' ? <QueryState query={detail}><EvidenceDisclosure value={detail.data} /></QueryState> : null}
  </>;
}

function ContextPolicyEditor({ context, params, policy, inFlight, reload }: { context: ViewContext; params: Data; policy: Data; inFlight: boolean; reload(): void }) {
  const config = policy.config ?? {};
  const [mode, setMode] = React.useState(policy.mode ?? 'observe');
  const [recentMessages, setRecentMessages] = React.useState(String(config.preserveRecentMessages ?? ''));
  const [recentTokens, setRecentTokens] = React.useState(String(config.preserveRecentTokens ?? ''));
  const [window, setWindow] = React.useState(String(policy.windowTokens ?? ''));
  const [reserve, setReserve] = React.useState(String(policy.outputReserveTokens ?? ''));
  const [tools, setTools] = React.useState<string>();
  const [rule, setRule] = React.useState('');
  const reminders = useQuery(context.api, 'context', 'rules/list', params, { scope: context.scope, refresh: context.refreshToken });
  const operation = useWorkbenchOperation(context, () => { reload(); reminders.reload(); });
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const saved = await operation.run('保存压缩策略', 'context', 'policy', { ...params, mode,
      ...(window ? { windowTokens: Number(window) } : {}), ...(reserve ? { outputReserveTokens: Number(reserve) } : {}),
      config: { ...(recentMessages ? { preserveRecentMessages: Number(recentMessages) } : {}),
        ...(recentTokens ? { preserveRecentTokens: Number(recentTokens) } : {}),
        ...(tools === undefined ? {} : { protectedTools: pathLines(tools) }) } }, { mutating: true });
    if (saved) context.notify('当前会话的压缩策略已保存');
  }
  return <section className="nexus-workbench-section">{operation.feedback}<h2>当前会话策略</h2><p className="nexus-workbench-source">来源：会话上下文策略 · 所有者：{policy.owner ?? '尚未分配'}</p>
    <form onSubmit={event => void save(event)}><div className="nexus-workbench-form">
      <label className="nexus-field"><span>压缩模式</span><select value={mode} onChange={e => setMode(e.target.value)}><option value="auto">自动压缩</option><option value="observe">仅观察</option><option value="disabled">停用</option></select></label>
      <label className="nexus-field"><span>模型窗口（token）</span><input type="number" min={1} step={1} value={window} placeholder="等待宿主报告" onChange={e => setWindow(e.target.value)} /></label>
      <label className="nexus-field"><span>保留最近消息数</span><input type="number" min={0} step={1} value={recentMessages} placeholder="使用内核默认值" onChange={e => setRecentMessages(e.target.value)} /></label>
      <label className="nexus-field"><span>保留最近内容（token）</span><input type="number" min={0} step={1} value={recentTokens} placeholder="使用内核默认值" onChange={e => setRecentTokens(e.target.value)} /></label>
      <label className="nexus-field"><span>输出预留（token）</span><input type="number" min={0} step={1} value={reserve} placeholder="使用当前值" onChange={e => setReserve(e.target.value)} /></label>
      <label className="nexus-field nexus-workbench-wide"><span>保护的工具名称（每行一个，支持后缀 *）</span><textarea rows={3} value={tools ?? (config.protectedTools ?? []).join('\n')} onChange={e => setTools(e.target.value)} /></label>
    </div><div className="nexus-actions"><Button primary type="submit" busy={Boolean(operation.busy)} disabled={inFlight}>保存会话策略</Button>{inFlight && <span className="nexus-workbench-hint">等待进行中的请求结束后保存。</span>}</div></form>
    <div className="nexus-workbench-section"><h2>保护提醒</h2><QueryState query={reminders}>{rows(reminders.data?.rules).length ? <ul className="nexus-workbench-reminders">{rows(reminders.data?.rules).map(item => <li key={item.id}><p data-nexus-verbatim="">{item.text}</p><Button disabled={Boolean(operation.busy)} onClick={() => void operation.run('移除提醒', 'context', 'rules', { ...params, operation: 'remove', id: item.id }, { mutating: true })}>移除</Button></li>)}</ul> : <p className="nexus-workbench-hint">尚无自定义保护提醒。</p>}</QueryState><label className="nexus-field"><span>新增保护提醒</span><textarea rows={3} value={rule} onChange={e => setRule(e.target.value)} placeholder="需要在压缩过程中持续保留的信息…" /></label><Button disabled={!rule.trim() || Boolean(operation.busy)} onClick={() => void operation.run('添加提醒', 'context', 'rules', { ...params, operation: 'add', text: rule.trim() }, { mutating: true }).then(result => { if (result) setRule(''); })}>添加提醒</Button></div>
    <EvidenceDisclosure title="完整有效策略" value={policy} />
  </section>;
}

function CacheEvidence({ data }: { data: Data }) {
  const { observed, totals, coverage, share } = cacheEvidenceSummary(data);
  const metric = (value: any) => typeof value === 'number' ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
  return <section className="nexus-workbench-section"><h2>供应商缓存报告</h2><p className="nexus-workbench-source">{observed ? '来源：供应商实际 usage' : '尚无完整的供应商缓存 usage'} · 已报告 {coverage.reported ?? 0} / {coverage.attempts ?? 0} 次请求</p>
    <dl className="nexus-workbench-metrics">{[['缓存读取比例', share === null ? '—' : `${(share * 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`], ['输入 token', metric(totals.input)], ['缓存读取 token', metric(totals.cached)], ['输出 token', metric(totals.output)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <p className="nexus-workbench-hint">缺失 {coverage.missing ?? 0} · 口径不明 {coverage.ambiguous ?? 0} · 无效 {coverage.invalid ?? 0} · 有输出用量 {coverage.outputReported ?? 0}</p>
    <details className="nexus-workbench-evidence"><summary>压缩与缓存收益证据</summary><p className="nexus-workbench-hint">{data.priceProfileSource === 'caller-supplied-estimate' ? '按调用方提供的价格比例估算压缩成本与回本；金额以实际账单为准。' : '尚未配置价格比例，成本与回本金额不作估算。'}</p><EvidenceDisclosure title="请求统计与压缩记录" value={data.report} /></details>
    <EvidenceDisclosure title="供应商 usage、覆盖与原始观测" value={{ evidence: data.evidence, coverage: data.coverage, observations: data.observations, costOwner: data.costOwner, estimatedSavingsAreActualBill: data.estimatedSavingsAreActualBill }} />
  </section>;
}

function ContextAdvancedEvidence({ context, params }: { context: ViewContext; params: Data }) {
  const [action, setAction] = React.useState('');
  const query = useQuery(context.api, 'context', action || 'epochs/get', params, { scope: context.scope, enabled: Boolean(action), refresh: context.refreshToken });
  return <><div className="nexus-actions"><Button onClick={() => setAction('epochs/get')}>配置世代</Button><Button onClick={() => setAction('wire/diff')}>请求前缀差异</Button></div>{action && <QueryState query={query}><EvidenceDisclosure title={action === 'epochs/get' ? '配置世代证据' : '本地请求前缀证据'} value={query.data} /></QueryState>}</>;
}
