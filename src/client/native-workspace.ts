import type { ClientContext, PageId } from './types.js';
import { pagesForScope } from './catalog.js';
import { originalConversationViews } from './original-surface-adapter.js';
export const nativePanels = [
  { id: 'workspace', title: '工作区工具', icon: 'folder' },
  { id: 'global', title: '资源与管理', icon: 'grid' },
] as const;
export const panelKey = (page: string) => `nexus.${page}`;
export const sessionPages: PageId[] = pagesForScope('session').map(item => item.id);
export const conversationViewId = (page: PageId) => `nexus.${page}`;
export const originalPageEntries: Partial<Record<PageId, { panel?: string; view?: string; rightTab?: string }>> = {
  engineering: { rightTab: 'files' },
  tasks: { panel: 'task-board' },
  memory: { panel: 'mnemon' },
  knowledge: { panel: 'mnemon' },
  context: { view: originalConversationViews.context.id },
  graph: { view: originalConversationViews.graph.id },
  usage: { panel: 'settings' },
};
export function nativeWorkspace(ctx: ClientContext): NonNullable<ClientContext['uiWorkspace']> {
  const workspace = ctx.uiWorkspace ?? ctx.get?.('uiWorkspace');
  if (!workspace) throw new Error('当前宿主未提供原生工作区服务');
  return workspace;
}
const requests = new Map<string, { page: PageId; workspaceId?: string }>();
const listeners = new Set<() => void>();
export const scopeNavigation = {
  read: (level: string) => requests.get(level),
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
export function openScopePanel(ctx: ClientContext, level: 'global' | 'workspace', page: PageId, workspaceId?: string) {
  requests.set(level, { page, workspaceId });
  for (const listener of listeners) listener();
  ctx.layout?.selectPanel(panelKey(level));
}
export function navigateNative(ctx: ClientContext, page: PageId, openView?: (id: string) => void): void {
  if (page === 'home') { nativeWorkspace(ctx).startSession(); return; }
  if (page === 'sessions') { ctx.layout?.selectPanel(null); return; }
  if (page === 'settings') { ctx.layout?.selectPanel('settings'); return; }
  const original = originalPageEntries[page];
  if (original?.panel) { ctx.layout?.selectPanel(original.panel); return; }
  if (original?.view) {
    if (!openView) throw new Error('请在会话中打开此功能');
    openView(original.view);
    return;
  }
  if (original?.rightTab) {
    const right = ctx.get?.('sidebarRight');
    if (!right?.openTab) throw new Error('文件侧栏尚未就绪');
    right.openTab(original.rightTab);
    return;
  }
  if (openView && sessionPages.includes(page)) { openView(conversationViewId(page)); return; }
  openScopePanel(ctx, 'workspace', page);
}
export function openNativeSession(ctx: ClientContext, sessionId: string): void { nativeWorkspace(ctx).openSession(sessionId); }
/** Each conversation feature uses the host's own view navigation. */
export function registerNativePanels(ctx: ClientContext, render: {
  panel(level: 'global' | 'workspace'): any; conversation(page: PageId): any; workflow?: any; icon(name: string): any; settings: any; theme: any; brand: any;
}): () => void {
  const disposers: (() => void)[] = [];
  const seat = (name: string, options: Record<string, any>, component: any) => {
    const dispose = ctx.slots.inject(name, () => ctx.slots.register({ name, ...options }, component));
    if (typeof dispose === 'function') disposers.push(dispose);
  };
  for (const [index, panel] of nativePanels.entries()) {
    const id = panelKey(panel.id);
    seat('main', { key: id }, render.panel(panel.id));
    seat('sidebar.panellist', { id, order: 20 + index, label: () => panel.title }, render.icon(panel.icon));
  }
  for (const [index, page] of pagesForScope('session').entries()) {
    seat('conversation.view', { id: conversationViewId(page.id), order: 80 + index, label: () => page.title,
      inject: (sessionId: string) => ({ sessionId }) }, render.conversation(page.id));
  }
  if (render.workflow) seat('conversation.view', { ...originalConversationViews.workflow, label: () => '工作流', inject: (sessionId: string) => ({ sessionId }) }, render.workflow);
  seat('settings.section', { id: 'nexus', order: 120, label: () => 'Nexus', locale: 'nexus' }, render.settings);
  seat('shell.overlay', { id: 'nexus.native-theme', order: 120 }, render.theme);
  // rc.2 single slots elect the lowest priority. Keep the official registrations
  // alive underneath so removing this plugin restores them without DOM edits.
  seat('sidebar.brand.mark', { priority: -1000 }, render.brand);
  seat('conversation.hero.brand.mark', { priority: -1000 }, render.brand);
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
