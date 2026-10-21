import * as React from 'react';
import type { ClientContext } from './types.js';
import {
  DOCK_PANE_LIMIT, DOCK_PREFERENCES, dockPaneIds, inheritedDockTemplate, parseTargetAddress,
  readDockPreferences, targetAddress, type DockLayout, type DockPreferenceScope, type DockTemplateId, type NativeDockTarget,
} from './dock-model.js';
import { adaptNativeDock, type NativeDockAdapter } from './dock-native-adapter.js';
import { NativeDockPopover } from './native-dock-popover.js';
import css from './native-docking.css';

export type { NativeDockTarget, DockTemplateId, DockPreferenceScope } from './dock-model.js';
export interface DockRenderProps {
  target: NativeDockTarget;
  /** Resolved fixed or following identity. Providers retain a different session themselves. */
  sessionId: string;
  ownerSessionId: string;
  visible: boolean;
  signal: AbortSignal;
}
export interface NativeDockProvider {
  id: string;
  accepts(target: NativeDockTarget): boolean;
  render(props: DockRenderProps): React.ReactNode;
}
export interface NativeDockOptions {
  providers?: readonly NativeDockProvider[];
  workspaceForSession?(sessionId: string): string | undefined;
  /** Called when the rc.2 compatibility guard declines; the native UI stays available. */
  onUnavailable?(error: Error): void;
}
export interface NativeDockPlacement { paneId?: string; preferNewPane?: boolean; axis?: 'row' | 'column'; replaceTab?: string }
interface DockRuntime {
  ctx: any;
  adapter: NativeDockAdapter;
  options: NativeDockOptions;
  providers: Map<string, NativeDockProvider>;
  subscribe(listener: () => void): () => void;
  revision(): number;
  publish(): void;
  supports(target: NativeDockTarget): boolean;
  open(target: NativeDockTarget, placement?: NativeDockPlacement): void;
  applyTemplate(template: DockTemplateId, scope?: DockPreferenceScope, inherit?: boolean): void;
  inherit(sessionId: string): void;
}
const DOCK_KIND = 'nexus.dock-target';
const DOCK_PROVIDER = '@local/dsh-nexus/native-dock-target';
const runtimes = new WeakMap<object, DockRuntime>();
const controllerFor = (ctx: any) => ctx.sidebarRight ?? ctx.get?.('sidebarRight');
const runtimeFor = (ctx: any) => {
  const controller = controllerFor(ctx);
  return controller ? runtimes.get(controller) : undefined;
};
const viewTarget = (id: string, title: string): NativeDockTarget => ({ type: 'view', id, title, binding: 'follow' });
const templates: Record<DockTemplateId, { title: string; targets: NativeDockTarget[] }> = {
  'conversation-agents': { title: '对话 + 代理', targets: [viewTarget('chat', '对话'), viewTarget('nexus.agents', '子代理')] },
  review: { title: '审阅', targets: [viewTarget('chat', '对话'), viewTarget('context', '上下文'), { type: 'native-tab', id: 'files', title: '文件' }] },
  watch: { title: '盯盘', targets: [viewTarget('nexus.agents', '子代理'), viewTarget('context', '上下文'), viewTarget('nexus.workflow', '工作流')] },
};
const viewLabels: Record<string, string> = {
  chat: '对话', context: '上下文', trajectory: '轨迹', 'nexus.agents': '子代理',
  'nexus.workflow': '工作流', thoughtdag: '思维图谱',
};
const noSubscription = () => () => {};
const emptySessions = { byId: {} as Record<string, any> };
function preferences() {
  try { return readDockPreferences(JSON.parse(localStorage.getItem(DOCK_PREFERENCES) ?? 'null')); }
  catch { return readDockPreferences(undefined); }
}
function saveTemplate(runtime: DockRuntime, template: DockTemplateId, scope: DockPreferenceScope, sessionId: string) {
  const saved = preferences();
  if (scope === 'global') saved.global = template;
  else if (scope === 'session') saved.session[sessionId] = template;
  else {
    const workspaceId = runtime.options.workspaceForSession?.(sessionId);
    if (!workspaceId) throw new Error('当前会话没有可保存布局的工作区');
    saved.workspace[workspaceId] = template;
  }
  try { localStorage.setItem(DOCK_PREFERENCES, JSON.stringify(saved)); } catch { throw new Error('无法保存布局偏好'); }
}

function DockControls({ runtime, sessionId, layout, active }: { runtime: DockRuntime; sessionId: string; layout: DockLayout; active: boolean }) {
  const revision = React.useSyncExternalStore(runtime.subscribe, runtime.revision, runtime.revision);
  const [error, setError] = React.useState('');
  const [scope, setScope] = React.useState<DockPreferenceScope>('session');
  const registry = runtime.ctx.uiConversation?.views;
  const viewIds = React.useSyncExternalStore(
    React.useCallback(listener => registry?.subscribe(listener) ?? (() => {}), [registry]),
    () => JSON.stringify(registry?.entries().map((entry: any) => entry.target) ?? []),
  );
  const sessionSource = runtime.ctx.sessions?.list;
  const sessions = React.useSyncExternalStore(sessionSource?.subscribe ?? noSubscription,
    () => sessionSource?.getSnapshot() ?? emptySessions);
  const [viewChoice, setViewChoice] = React.useState('chat');
  const [sessionChoice, setSessionChoice] = React.useState('');
  const count = dockPaneIds(layout).length;
  React.useEffect(() => {
    let cancelled = false;
    if (layout.expanded) queueMicrotask(() => {
      if (cancelled) return;
      try { runtime.inherit(sessionId); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    });
    return () => { cancelled = true; };
  }, [runtime, sessionId, layout.expanded, revision]);
  const workspace = runtime.options.workspaceForSession?.(sessionId);
  return <NativeDockPopover active={active && layout.expanded} identity={sessionId}
    title={`分栏与布局（${count}/${DOCK_PANE_LIMIT}）`}>{dismiss => {
    const act = (callback: () => void) => {
      try { callback(); setError(''); dismiss(); }
      catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    };
    return <>
      <span className="nexus-native-dock-caption">自由分栏 · {count}/{DOCK_PANE_LIMIT}</span>
      <button type="button" disabled={!runtime.adapter.canSplit('row')} onClick={() => act(() => { runtime.adapter.split('row'); })}>向右分栏</button>
      <button type="button" disabled={!runtime.adapter.canSplit('column')} onClick={() => act(() => { runtime.adapter.split('column'); })}>向下分栏</button>
      <span className="nexus-native-dock-hint">拖动标签到面板四边可继续分栏；拖出可浮动。</span>
      <label>会话视图<select value={viewChoice} onChange={event => setViewChoice(event.target.value)}>
        {(JSON.parse(viewIds) as string[]).filter(id => id !== 'reader').map(id => <option key={id} value={id}>{viewLabels[id] ?? id}</option>)}
      </select></label>
      <label>会话<select value={sessionChoice} onChange={event => setSessionChoice(event.target.value)}>
        <option value="">跟随当前会话</option>
        {Object.values(sessions.byId as Record<string, any>).map(session =>
          <option key={session.id} value={session.id}>{session.displayTitle ?? session.id}</option>)}
      </select></label>
      <button type="button" onClick={() => act(() => runtime.open({
        type: 'view', id: viewChoice, title: viewLabels[viewChoice] ?? viewChoice,
        binding: sessionChoice ? 'fixed' : 'follow', ...(sessionChoice ? { sessionId: sessionChoice } : {}),
      }, { preferNewPane: true, axis: 'column' }))}>在分栏打开</button>
      <label>模板适用范围
        <select value={scope} onChange={event => setScope(event.target.value as DockPreferenceScope)}>
          <option value="session">当前会话</option>
          <option value="workspace" disabled={!workspace}>当前工作区的新会话</option>
          <option value="global">所有工作区的新会话</option>
        </select>
      </label>
      {(Object.entries(templates) as [DockTemplateId, typeof templates[DockTemplateId]][]).map(([id, template]) => {
        const supported = template.targets.every(target => runtime.supports(target));
        return <button key={id} type="button" disabled={!supported}
          title={supported ? '在当前布局中打开，保留已有标签' : '对应的会话视图尚未就绪'}
          onClick={() => act(() => runtime.applyTemplate(id, scope))}>{template.title}</button>;
      })}
      <span className="nexus-native-dock-hint">工作区偏好覆盖全局偏好，会话布局优先。</span>
      {error ? <span role="alert" className="nexus-native-dock-error">{error}</span> : null}
    </>;
  }}</NativeDockPopover>;
}

function DockTargetBody({ runtime, useTabInfo, sessionId }: { runtime: DockRuntime; useTabInfo(): any; sessionId: string }) {
  const info = useTabInfo();
  React.useSyncExternalStore(runtime.subscribe, runtime.revision, runtime.revision);
  const [error, setError] = React.useState('');
  const target = parseTargetAddress(info.tab.contentId);
  if (!target) return <p className="nexus-native-dock-empty">此分栏对象的地址无效。</p>;
  const resolvedSession = target.binding === 'fixed' ? target.sessionId! : sessionId;
  const provider = [...runtime.providers.values()].find(item => item.accepts(target));
  const toggle = () => {
    try {
      const next: NativeDockTarget = target.binding === 'fixed'
        ? { ...target, binding: 'follow', sessionId: undefined }
        : { ...target, binding: 'fixed', sessionId: resolvedSession };
      info.tab.actions.openResource(targetAddress(next), { replaceTab: true, revealIfOpened: false });
      setError('');
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  return <section className="nexus-native-dock-target" data-nexus-dock-target={target.type}>
    <header>
      <span title={target.title}>{target.title}</span>
      <button type="button" aria-pressed={target.binding === 'fixed'} onClick={toggle}
        title={target.binding === 'fixed' ? '改为跟随当前会话' : '固定此对象到当前会话'}>
        {target.binding === 'fixed' ? '已固定' : '跟随会话'}
      </button>
    </header>
    {error ? <p role="alert" className="nexus-native-dock-error">{error}</p> : null}
    <div className="nexus-native-dock-content">
      {provider ? provider.render({ target, sessionId: resolvedSession, ownerSessionId: sessionId, visible: info.tab.visible, signal: info.tab.signal })
        : <p className="nexus-native-dock-empty">此对象的查看器尚未就绪。加载对应插件后将自动恢复。</p>}
    </div>
  </section>;
}

function installDocking(ctx: any, kit: any, options: NativeDockOptions): () => void {
  const controller = controllerFor(ctx);
  if (runtimes.has(controller)) throw new Error('原生自由分栏已在此客户端安装');
  const providers = new Map((options.providers ?? []).map(provider => [provider.id, provider]));
  const listeners = new Set<() => void>();
  const inherited = new Set<string>();
  let revision = 0;
  const runtime: DockRuntime = {
    ctx, options, providers,
    adapter: undefined as unknown as NativeDockAdapter,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    revision: () => revision,
    publish() { revision += 1; for (const listener of listeners) listener(); },
    supports(target) {
      if (target.type === 'native-tab') return !!controller.tabs.get(target.id);
      if (target.type === 'resource') return target.id.startsWith('dsh-resource://');
      return [...providers.values()].some(provider => provider.accepts(target));
    },
    open(target, placement = {}) {
      if (!runtime.supports(target)) throw new Error('此对象的原生分栏查看器尚未就绪');
      const address = target.type === 'resource' ? target.id : target.type === 'native-tab' ? undefined : targetAddress(target);
      // Revealing an already open resource must not leave an unused split.
      const alreadyOpen = address && !placement.replaceTab
        ? Object.values(runtime.adapter.layout()?.tabs ?? {}).find(tab => tab.contentId === address) : undefined;
      if (alreadyOpen) { controller.focus(alreadyOpen.id); return; }
      let paneId = placement.paneId;
      let replaceTab = placement.replaceTab;
      if (placement.preferNewPane) {
        const created = runtime.adapter.split(placement.axis ?? 'row', paneId);
        if (created) {
          paneId = created;
          const state = runtime.adapter.layout();
          const pane = state?.nodes[created];
          if (pane?.kind === 'pane') replaceTab = pane.tabs.find(id => state?.tabs[id]?.kind === 'guide');
        }
      }
      const nativePlacement = { ...(paneId ? { paneId } : {}), ...(replaceTab ? { replaceTab } : {}), revealIfOpened: true };
      if (target.type === 'resource') controller.openResource(target.id, nativePlacement);
      else if (target.type === 'native-tab') controller.openTab(target.id, nativePlacement);
      else controller.openResource(address!, nativePlacement);
    },
    applyTemplate(id, scope = 'session', inherit = false) {
      const template = templates[id];
      const sessionId = controller.mounted.getSnapshot();
      if (!sessionId || !runtime.adapter.layout()) throw new Error('请先打开一个会话');
      if (!template || !template.targets.every(target => runtime.supports(target))) throw new Error('模板中的会话视图尚未就绪');
      // Templates use native tabs and preserve every existing resource. There
      // is no destructive "reset layout" or synthetic parallel conversation.
      const panes = [...dockPaneIds(runtime.adapter.layout()!)];
      for (let index = 0; index < template.targets.length; index += 1) {
        let paneId = panes[index];
        if (!paneId && index > 0) {
          const created = runtime.adapter.split(index === 1 ? 'row' : 'column', panes[index === 1 ? 0 : 1]);
          if (created) { panes.push(created); paneId = created; }
        }
        const state = runtime.adapter.layout();
        const pane = paneId ? state?.nodes[paneId] : undefined;
        const guide = pane?.kind === 'pane' ? pane.tabs.find(id => state?.tabs[id]?.kind === 'guide') : undefined;
        runtime.open(template.targets[index], { paneId: paneId ?? panes[0], ...(guide ? { replaceTab: guide } : {}) });
      }
      if (!inherit) saveTemplate(runtime, id, scope, sessionId);
      inherited.add(sessionId);
    },
    inherit(sessionId) {
      if (inherited.has(sessionId) || runtime.adapter.restored(sessionId)) return;
      const preference = inheritedDockTemplate(preferences(), sessionId, options.workspaceForSession?.(sessionId));
      if (!preference) { inherited.add(sessionId); return; }
      if (!templates[preference].targets.every(target => runtime.supports(target))) return;
      runtime.applyTemplate(preference, 'session', true);
    },
  };
  const cleanups: (() => void)[] = [];
  try {
    runtime.adapter = adaptNativeDock(ctx, kit, {
      renderControls: (sessionId, layout, active) => <DockControls runtime={runtime} sessionId={sessionId} layout={layout} active={active} />,
      changed: () => runtime.publish(),
    });
    cleanups.push(() => runtime.adapter.dispose());
    runtimes.set(controller, runtime);
    const tabs = ctx.sidebarRightTabs ?? ctx.get?.('sidebarRightTabs');
    if (typeof tabs?.register !== 'function') throw new Error('原生标签注册服务未就绪');
    cleanups.push(tabs.register({
      id: DOCK_PROVIDER, kind: DOCK_KIND, priority: 'extension', keepMounted: true,
      patterns: ['dsh-resource://nexus-dock/**'], canOpen: (address: string) => !!parseTargetAddress(address),
      title: (address: string) => parseTargetAddress(address)?.title ?? '会话分栏',
    }));
    const stopBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: DOCK_PROVIDER,
      inject: () => ({ runtime }),
    }, DockTargetBody));
    if (typeof stopBody === 'function') cleanups.push(stopBody);
    const stopStyle = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'nexus.native-docking', order: 121,
    }, () => <style data-nexus-native-docking="">{css}</style>));
    if (typeof stopStyle === 'function') cleanups.push(stopStyle);
  } catch (error) {
    runtimes.delete(controller);
    for (const cleanup of cleanups.reverse()) cleanup();
    throw error;
  }
  return () => {
    runtimes.delete(controller);
    for (const cleanup of cleanups.reverse()) cleanup();
    listeners.clear();
    providers.clear();
  };
}

/**
 * Mount once from the client effect. It imports the desktop's shared docking
 * module and owns only reversible adaptations of the existing native surface.
 */
export function mountNativeDocking(rawContext: ClientContext, options: NativeDockOptions = {}): () => void {
  const ctx = rawContext as any;
  let stopped = false;
  let stop: unknown;
  const report = (error: unknown) => {
    if (stopped) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    console.error('[nexus native docking]', failure);
    options.onUnavailable?.(failure);
  };
  void (async () => {
    const kit = await ctx.modules.import('@deepseek-ai/dsh-client-ui-dockkit');
    if (stopped) return;
    stop = ctx.slots.inject('rightbar.session', () => {
      try { return installDocking(ctx, kit, options); }
      catch (error) { report(error); return undefined; }
    });
  })().catch(report);
  return () => { stopped = true; if (typeof stop === 'function') stop(); };
}

/** Unified entry: native resources keep their original file/browser/terminal viewer. */
export function openNativeDockTarget(ctx: ClientContext, target: NativeDockTarget, placement?: NativeDockPlacement): void {
  const runtime = runtimeFor(ctx);
  if (!runtime) throw new Error('自由分栏尚未就绪，原生侧栏仍可使用');
  runtime.open(target, placement);
}
export function registerDockTargetProvider(ctx: ClientContext, provider: NativeDockProvider): () => void {
  const runtime = runtimeFor(ctx);
  if (!runtime) throw new Error('请先安装原生自由分栏，再注册分栏查看器');
  if (runtime.providers.has(provider.id)) throw new Error(`分栏查看器已注册：${provider.id}`);
  runtime.providers.set(provider.id, provider);
  runtime.publish();
  return () => {
    if (runtime.providers.get(provider.id) === provider) { runtime.providers.delete(provider.id); runtime.publish(); }
  };
}
export function applyNativeDockTemplate(ctx: ClientContext, template: DockTemplateId, scope: DockPreferenceScope = 'session'): void {
  const runtime = runtimeFor(ctx);
  if (!runtime) throw new Error('自由分栏尚未就绪');
  runtime.applyTemplate(template, scope);
}
