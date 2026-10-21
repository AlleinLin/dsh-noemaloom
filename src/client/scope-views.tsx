import * as React from 'react';
import type { Data, PageId, ViewContext } from './types.js';
import { rows } from './types.js';
import { navigation } from './catalog.js';
import { Button, DataView, Icon, QueryState, StateMessage, useQuery } from './components.js';
import { openScopePanel } from './native-workspace.js';

export const levelLabels = { global: '全局', workspace: '工作区', session: '会话' };
export function GlobalOverview({ context, page }: { context: ViewContext; page: PageId }) {
  const query = useQuery(context.api, 'scope', 'overview', { feature: page }, { scope: { level: 'global' }, refresh: context.refreshToken });
  return <section className="nexus-page nexus-global-overview">
    <div className="nexus-page-header"><h1>{navigation.find(item => item.id === page)?.title ?? '搜索'} · 项目汇总</h1><Button icon="refresh" onClick={query.reload}>刷新</Button></div>
    <QueryState query={query} empty={!rows(query.data).length}><div className="nexus-scope-projects">{rows(query.data).map(workspace => {
      const counts: Data[] = workspace.counts ?? [];
      const project = counts.find(row => row.level === 'workspace');
      const sessions = counts.filter(row => row.level === 'session');
      return <article key={workspace.id}>
        <Icon name="folder" size={24} /><div><h2>{workspace.title}</h2><small>{workspace.path}</small></div>
        <dl><div><dt>工作区记录</dt><dd>{project?.count ?? '不可用'}</dd></div><div><dt>会话</dt><dd>{workspace.sessionIds.length}</dd></div></dl>
        <Button onClick={() => context.host && openScopePanel(context.host, 'workspace', page, workspace.id)}>打开工作区</Button>
        {counts.some(row => row.state === 'unavailable') && <details><summary>读取失败</summary><DataView value={counts.filter(row => row.state === 'unavailable')} /></details>}
        {sessions.length > 0 && <details><summary>会话记录</summary><ul>{sessions.map(row => <li key={row.sessionId}><span>{String(row.sessionId).slice(0, 12)} · {row.count ?? '不可用'}</span><Button onClick={() => context.openNativeSession(row.sessionId)}>打开会话</Button></li>)}</ul></details>}
      </article>;
    })}</div></QueryState>
  </section>;
}
export function MissingWorkspace() { return <div className="nexus-page"><StateMessage icon="folder" title="选择工作区" /></div>; }
