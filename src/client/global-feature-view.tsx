import * as React from 'react';
import { useState } from 'react';
import type { Data, PageId, ViewContext } from './types.js';
import { rows, titleOf } from './types.js';
import { navigation } from './catalog.js';
import { Button, DataView, Icon, PageHeader, QueryState, Records, SearchField, StateMessage, Status, Tabs, Time, useQuery } from './components.js';
import { openScopePanel } from './native-workspace.js';
import { QualityWorkbench } from './QualityWorkbench.js';

export const globalFeatureLabels: Partial<Record<PageId, string>> = {
  engineering: '工程目录', context: '上下文会话', quality: '质量记录', review: '审查记录', recovery: '恢复记录',
};
const recordLabels: Partial<Record<PageId, string>> = {
  engineering: '后台作业', context: '上下文会话', quality: '检查运行', review: '审查运行', recovery: '恢复点',
};

/** A source scope travels with each row; global actions never borrow a workspace. */
export function globalFeatureRecords(value: unknown): Data[] {
  return rows(value).flatMap(workspace => {
    const unique = new Map<string, Data>();
    for (const target of workspace.counts ?? []) {
      for (const [index, item] of rows(target.items).entries()) {
        const sessionId = item.sessionId ?? target.sessionId;
        // Context overview contains session lanes at both workspace and session
        // levels. Prefer the narrower source without duplicating those lanes.
        const identity = item.lane !== undefined && sessionId
          ? `${sessionId}:${item.lane}:${item.purpose ?? 'main'}`
          : `${target.level}:${target.sessionId ?? ''}:${item.id ?? index}`;
        const key = `${workspace.id}:${identity}`;
        unique.set(key, { ...item, id: key, sourceId: item.id, workspaceId: workspace.id,
          workspaceTitle: workspace.title, sessionId, sourceLevel: sessionId ? 'session' : 'workspace' });
      }
    }
    return [...unique.values()];
  });
}

export function GlobalFeatureView({ context, page }: { context: ViewContext; page: PageId }) {
  const [tab, setTab] = useState(page === 'engineering' ? 'workspaces' : 'records');
  const [search, setSearch] = useState('');
  const query = useQuery(context.api, 'scope', 'overview', { feature: page, includeRecords: true },
    { scope: { level: 'global' }, refresh: context.refreshToken });
  const workspaces = rows(query.data);
  const records = globalFeatureRecords(query.data).filter(item => !search.trim()
    || JSON.stringify(item).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const title = navigation.find(item => item.id === page)?.title ?? page;
  const openWorkspace = (workspace: Data) => { if (context.host) openScopePanel(context.host, 'workspace', page, workspace.workspaceId ?? workspace.id); };
  const columns = [
    { key: 'title', label: page === 'context' ? '会话 / 通道' : recordLabels[page] ?? '记录',
      render: (item: Data) => page === 'context' ? `${item.sessionId} · ${item.lane ?? 'main'}` : titleOf({ ...item, id: item.sourceId }) },
    { key: 'workspaceTitle', label: '工作区' },
    ...(page === 'context' ? [
      { key: 'mode', label: '压缩策略' }, { key: 'blocks', label: '压缩块' }, { key: 'activeBlocks', label: '活跃块' },
      { key: 'inFlight', label: '进行中' },
    ] : [
      { key: 'status', label: page === 'review' ? '审查状态' : '状态',
        render: (item: Data) => <Status value={item.verification ?? item.reportStatus ?? item.status ?? item.state ?? item.phase ?? 'unknown'} /> },
      { key: 'summary', label: page === 'quality' ? '检查结果' : page === 'review' ? '审查结果' : '摘要',
        render: (item: Data) => <DataView value={item.summary ?? item.label ?? item.mode} /> },
    ]),
    { key: 'updatedAt', label: '时间', render: (item: Data) => <Time value={item.updatedAt ?? item.createdAt ?? item.startedAt} /> },
    { key: 'open', label: '打开', render: (item: Data) => item.sessionId
      ? <Button onClick={() => context.openNativeSession(item.sessionId)}>打开会话</Button>
      : <Button onClick={() => openWorkspace(item)}>打开工作区</Button> },
  ];
  const unavailable = workspaces.flatMap(workspace => (workspace.counts ?? [])
    .filter((target: Data) => target.state === 'unavailable').map((target: Data) => ({ workspace: workspace.title, ...target })));
  const truncated = workspaces.some(workspace => workspace.counts?.some((target: Data) => target.truncated));
  return <section className="nexus-page" data-global-feature={page}>
    <PageHeader title={title}><Button icon="refresh" onClick={query.reload}>刷新</Button></PageHeader>
    <Tabs value={tab} onChange={setTab} tabs={page === 'engineering'
      ? [{ id: 'workspaces', label: '工作区' }, { id: 'records', label: '后台作业' }]
      : [{ id: 'records', label: recordLabels[page] ?? title }, { id: 'workspaces', label: '工作区' }, ...(page === 'quality' ? [{ id: 'rules', label: '规则选择' }] : [])]} />
    {tab === 'rules' && page === 'quality' && <QualityWorkbench context={context} rulesOnly />}
    {tab === 'records' && <SearchField value={search} onChange={setSearch} placeholder={`搜索${recordLabels[page] ?? title}…`} />}
    {tab !== 'rules' && <QueryState query={query}>
      {tab === 'workspaces' ? <div className="nexus-scope-projects">{workspaces.map(workspace => <article key={workspace.id}>
        <Icon name="folder" size={24} /><div><h2>{workspace.title}</h2><small>{workspace.path}</small></div>
        <Button onClick={() => openWorkspace(workspace)}>{page === 'engineering' ? '打开工程' : `打开${title}`}</Button>
      </article>)}</div> : records.length ? <Records items={records} columns={columns}
        onSelect={item => context.inspect({ title: titleOf({ ...item, id: item.sourceId }), kind: title, data: item })} />
        : <StateMessage title={`暂无${recordLabels[page] ?? title}`} />}
      {unavailable.length > 0 && <details><summary>读取失败（{unavailable.length}）</summary><DataView value={unavailable} /></details>}
      {truncated && <p className="nexus-muted">部分范围仅显示前 100 条，请打开对应工作区查看全部记录。</p>}
    </QueryState>}
  </section>;
}
