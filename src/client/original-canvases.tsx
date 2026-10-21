import * as React from 'react';
import type { ClientContext } from './types.js';
import { claudeThemeTokens } from './native-theme-tokens.js';
import { openOriginalComposer, openOriginalConversationView } from './original-navigation.js';
import canvasChromeCss from './original-canvases.css';

type Level = 'global' | 'workspace' | 'session';
type Canvas = 'thoughtdag' | 'synapse';
interface Scope { level: Level; id: string }
const empty = { ids: [] as string[], byId: {} as Record<string, any> };
const noSubscribe = () => () => {};
const sessionRows = (ctx: any) => ctx.get('sessions')?.list?.getSnapshot() ?? empty;
const workspaceRows = (ctx: any) => ctx.get('workspaces')?.list?.getSnapshot()?.items ?? [];
function scopedIds(ctx: any, scope: Scope) {
  const sessions = sessionRows(ctx);
  const workspaces = workspaceRows(ctx);
  const explicitlyElsewhere = new Set<string>(scope.level === 'workspace'
    ? workspaces.filter((row: any) => row.workspaceId !== scope.id).flatMap((row: any) => row.sessionIds) : []);
  const ids = new Set<string>(scope.level === 'global' ? sessions.ids
    : scope.level === 'workspace' ? workspaces.find((row: any) => row.workspaceId === scope.id)?.sessionIds ?? []
      : [scope.id]);
  let size;
  do {
    size = ids.size;
    for (const row of Object.values(sessions.byId) as any[]) if (ids.has(row.parentId)
      && (scope.level !== 'workspace' || !explicitlyElsewhere.has(row.id))) ids.add(row.id);
  } while (size !== ids.size);
  return ids;
}
const scopedUrl = (canvas: Canvas, path: string, scope: Scope) => {
  const query = new URLSearchParams({ nexusLevel: scope.level, nexusId: scope.id });
  return `/${canvas}/${path}?${query}`;
};

/** Original canvas only; native DSH retains navigation, sessions and composer. */
function OriginalCanvas({ ctx, canvas, scope, sessionId, openView, active = true }: {
  ctx: ClientContext; canvas: Canvas; scope: Scope; sessionId?: string; openView?: (id: string) => void; active?: boolean;
}) {
  const frame = React.useRef<HTMLIFrameElement>(null);
  const [error, setError] = React.useState('');
  const [generatedSession, setGeneratedSession] = React.useState<string>();
  const sendRef = React.useRef<() => void>(() => {});
  const loadRef = React.useRef<() => void>(() => {});
  const frameReady = React.useRef(false);
  const readyDocument = React.useRef<Document | null>(null);
  const opened = React.useRef(false);
  const catalogState = React.useRef({ known: new Set<string>(), signature: '' });
  React.useEffect(() => {
    const host = ctx as any;
    let disposed = false;
    let syncing = false;
    let pending = false;
    let queued = false;
    let lastWorkspaces = '';
    let lastSession = '';
    const controller = new AbortController();
    const source = canvas === 'thoughtdag' ? 'dsh-thoughtdag' : 'dsh-synapse';
    const send = (type: string, data: Record<string, unknown> = {}) =>
      frame.current?.contentWindow?.postMessage({ source, type, ...data }, location.origin);
    const lifecycle = (visible: boolean) => {
      frame.current?.contentWindow?.postMessage({ source: 'nexus-canvas', active: visible }, location.origin);
      if (canvas === 'thoughtdag') {
        send('td:view', { shown: visible, bar: false, desktop: true, panel: true });
        if (!visible) send('td:resize-view', { visible: false });
      }
    };
    if (!active) {
      const hide = () => lifecycle(false);
      sendRef.current = hide;
      loadRef.current = hide;
      hide();
      return () => {
        if (sendRef.current === hide) sendRef.current = () => {};
        if (loadRef.current === hide) loadRef.current = () => {};
      };
    }
    const live = new Map<string, { binding: any; chat: any; stops: Array<() => void>; signature?: string }>();
    const references = new Map<string, any>();
    const verifiedGenerated = new Set<string>();
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeCanvas = () => {
      if (canvas !== 'thoughtdag' || disposed || !frameReady.current) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const bounds = frame.current?.getBoundingClientRect();
        send('td:resize-view', { visible: !!bounds && bounds.width > 1 && bounds.height > 1 });
      }, 100);
    };
    const frameObserver = new ResizeObserver(resizeCanvas);
    if (frame.current) frameObserver.observe(frame.current);
    const publishLive = (id: string) => {
      if (disposed) return;
      const record = live.get(id);
      const text = record?.chat?.getSnapshot()?.legacy?.partial?.blocks
        ?.filter((block: any) => block.kind === 'text').map((block: any) => block.text).join('\n') ?? '';
      const running = sessionRows(host).byId[id]?.running === true;
      const signature = JSON.stringify([running, text]);
      if (record?.signature === signature) return;
      if (record) record.signature = signature;
      send('synapse:live-reply', { sessionId: id, running, text });
    };
    const syncLive = () => {
      const ids = scopedIds(host, scope);
      const rows = sessionRows(host);
      for (const id of ids) {
        if (rows.byId[id]?.running === true && !host.get('sessions').binding(id) && !references.has(id)) {
          try {
            const reference = host.get('sessions').retain(id, { source: 'nexus-synapse-live' });
            references.set(id, reference);
            void reference.ready.then(() => { if (!disposed) sync(); }, () => {});
          } catch { /* The original graph can still show catalog running state. */ }
        }
        const binding = host.get('sessions').binding(id);
        let record = live.get(id);
        if (record && record.binding !== binding) { record.stops.forEach(stop => stop()); live.delete(id); record = undefined; }
        if (!record) {
          let chat;
          try { if (binding) chat = host.get('uiConversation').binding(id).target('chat'); } catch {}
          record = { binding, chat, stops: [] };
          if (chat) record.stops.push(chat.subscribe(() => publishLive(id)));
          if (binding?.session?.subscribe) record.stops.push(binding.session.subscribe(() => publishLive(id)));
          live.set(id, record);
        }
        publishLive(id);
      }
      for (const [id, record] of live) if (!ids.has(id)) { record.stops.forEach(stop => stop()); live.delete(id); }
      for (const [id, reference] of references) if (!ids.has(id) || rows.byId[id]?.running !== true) { reference.release(); references.delete(id); }
    };
    const close = () => openView ? openView('chat') : ctx.layout?.selectPanel(null);
    const assertSession = (id: string) => {
      if (!scopedIds(host, scope).has(id) && !verifiedGenerated.has(id)) throw new Error('会话不属于当前图谱范围');
    };
    const syncTheme = () => {
      if (disposed) return;
      const dark = document.body.hasAttribute('data-ds-dark-theme');
      frame.current?.contentWindow?.postMessage({ source: 'nexus-canvas', dark, tokens: claudeThemeTokens }, location.origin);
      if (canvas === 'synapse') send('synapse:theme', { dark });
    };
    const syncCatalog = async () => {
      pending = true;
      if (syncing) return;
      syncing = true;
      try {
        while (pending && !disposed) {
          pending = false;
          const all = sessionRows(host), ids = scopedIds(host, scope);
          const sessions = [...ids].map(id => all.byId[id]).filter(Boolean).map(row => ({
            id: row.id, title: row.displayTitle, cwd: row.cwd ?? null, parentId: row.parentId ?? null, blank: row.blank,
          }));
          const signature = JSON.stringify(sessions);
          if (signature === catalogState.current.signature) continue;
          const removedSessionIds = [...catalogState.current.known].filter(id => !ids.has(id));
          const response = await fetch(scopedUrl(canvas, 'api/sessions/sync', scope), {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
            body: JSON.stringify({ sessions, removedSessionIds }),
          });
          if (!response.ok) throw new Error((await response.json()).error ?? '图谱同步失败');
          if (!disposed) catalogState.current = { known: ids, signature };
        }
      } catch (cause) {
        if (!disposed && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '图谱同步失败');
      } finally { syncing = false; }
    };
    const sync = () => {
      if (disposed) return;
      if (!frameReady.current) { if (canvas === 'synapse') void syncCatalog(); return; }
      const all = sessionRows(host);
      const ids = scopedIds(host, scope);
      const selected = sessionId ?? host.uiWorkspace.selection.getSnapshot()?.sessionId;
      const current = selected && ids.has(selected) ? all.byId[selected] : undefined;
      const session = current ? { id: current.id, title: current.displayTitle, cwd: current.cwd ?? null } : null;
      lifecycle(true);
      syncTheme();
      if (canvas === 'thoughtdag') {
        send('td:current-session', { session });
      } else {
        syncLive();
        // The native panel already selects the scope. Supply one projection
        // group so removing the duplicate workspace picker cannot hide other
        // workspaces from the global map or descendants from a session map.
        const workspace = workspaceRows(host).find((row: any) => row.workspaceId === scope.id);
        const workspaces = [{
          id: scope.level === 'workspace' ? scope.id : 'dsh-ungrouped',
          title: scope.level === 'global' ? '全部会话' : workspace?.title ?? session?.title ?? '当前会话',
          path: workspace?.path ?? null, sessionIds: [...ids],
        }];
        const workspacesSignature = JSON.stringify(workspaces), sessionSignature = JSON.stringify(session);
        if (lastWorkspaces !== workspacesSignature) { lastWorkspaces = workspacesSignature; send('synapse:workspaces', { workspaces }); }
        if (lastSession !== sessionSignature) { lastSession = sessionSignature; send('synapse:current-session', { session }); }
        if (!opened.current) { opened.current = true; send('synapse:map-opened'); }
        void syncCatalog();
      }
    };
    const queueSync = () => {
      if (queued || disposed) return;
      queued = true;
      queueMicrotask(() => { queued = false; if (!disposed) sync(); });
    };
    sendRef.current = sync;
    const loaded = () => {
      frameReady.current = true;
      if (readyDocument.current !== frame.current?.contentDocument) {
        readyDocument.current = frame.current?.contentDocument ?? null;
        opened.current = false;
        lastWorkspaces = ''; lastSession = '';
        for (const record of live.values()) record.signature = undefined;
      }
      sync();
      resizeCanvas();
    };
    loadRef.current = loaded;
    const onMessage = async (event: MessageEvent) => {
      if (disposed || event.origin !== location.origin || event.source !== frame.current?.contentWindow || event.data?.source !== source) return;
      const data = event.data;
      try {
        if (data.type === 'td:request-current' || data.type === 'synapse:request-current') return loaded();
        if (data.type === 'td:close' || data.type === 'synapse:close') return close();
        if (data.type === 'td:generated-session' && typeof data.sessionId === 'string') {
          // A compiled graph can create a fresh native conversation. Verify
          // its persisted scope relation on the host before offering it here.
          const result = await fetch(scopedUrl(canvas, `api/sessions/${encodeURIComponent(data.sessionId)}`, scope),
            { signal: controller.signal });
          if (!result.ok) throw new Error('生成会话不属于当前图谱范围');
          if (!disposed) { verifiedGenerated.add(data.sessionId); setGeneratedSession(data.sessionId); }
          return;
        }
        if (data.type === 'td:select-session' || data.type === 'synapse:open-session' || data.type === 'synapse:activate-session') {
          const id = data.sessionId ?? data.session;
          assertSession(id);
          ctx.uiWorkspace!.openSession(id);
          if (data.type !== 'synapse:activate-session' && data.close !== false) close();
          return;
        }
        if (data.type === 'td:pick-cwd') {
          const pick = host.uiWorkspace.pickDirectory;
          if (typeof pick !== 'function') return send('td:picked-cwd', { requestId: data.requestId, path: null, unsupported: true });
          try {
            const result = await pick.call(host.uiWorkspace);
            if (!disposed) send('td:picked-cwd', { requestId: data.requestId, path: typeof result === 'string' ? result : null });
          } catch {
            if (!disposed) send('td:picked-cwd', { requestId: data.requestId, path: null, unsupported: true });
          }
          return;
        }
        if (data.type === 'synapse:compose') {
          if (!['new', 'continue', 'branch'].includes(data.kind)) throw new Error('未知的会话操作');
          let id: string;
          if (data.kind === 'continue') {
            assertSession(data.sessionId);
            id = data.sessionId;
          } else if (data.kind === 'branch' || scope.level === 'session') {
            const parent = data.sessionId ?? scope.id;
            assertSession(parent);
            id = await host.get('sessions').fork({
              sessionId: parent, ...(Number.isInteger(data.atSeq) ? { atSeq: data.atSeq } : {}), increaseTitle: true,
            });
          } else {
            if (scope.level === 'workspace' && data.workspaceId && data.workspaceId !== scope.id)
              throw new Error('不能在其他工作区创建会话');
            id = await host.get('sessions').create(scope.level === 'workspace'
              ? { workspaceId: scope.id }
              : data.workspaceId && data.workspaceId !== 'dsh-ungrouped' ? { workspaceId: data.workspaceId } : {});
          }
          const result = await openOriginalComposer(ctx, id, typeof data.text === 'string' ? data.text : '');
          const row = sessionRows(host).byId[id];
          send('synapse:composer-opened', {
            kind: data.kind, parentSessionId: data.sessionId, anchorId: data.anchorId, ...result,
            session: { id, title: row?.displayTitle ?? '新会话', cwd: row?.cwd ?? null },
          });
          if (result.draftStatus === 'preserved' || result.draftStatus === 'blocked')
            setError('原有草稿已保留，选中文本未覆盖输入框');
          return;
        }
        if (data.type === 'synapse:fork-session' || data.type === 'synapse:create-session') {
          let id: string;
          if (data.type === 'synapse:fork-session' || scope.level === 'session') {
            const parent = data.sessionId ?? scope.id;
            assertSession(parent);
            id = await host.get('sessions').fork({
              sessionId: parent, ...(Number.isInteger(data.atSeq) ? { atSeq: data.atSeq } : {}), increaseTitle: true,
            });
          } else {
            if (scope.level === 'workspace' && data.workspaceId && data.workspaceId !== scope.id) throw new Error('不能在其他工作区创建会话');
            id = await host.get('sessions').create(scope.level === 'workspace'
              ? { workspaceId: scope.id }
              : data.workspaceId && data.workspaceId !== 'dsh-ungrouped' ? { workspaceId: data.workspaceId } : data.cwd ? { cwd: data.cwd } : {});
          }
          const row = sessionRows(host).byId[id];
          send(data.type === 'synapse:fork-session' ? 'synapse:forked-session' : 'synapse:created-session', {
            requestId: data.requestId, session: { id, title: row?.displayTitle ?? '新会话', cwd: row?.cwd ?? null },
          });
          return sync();
        }
        if (data.type === 'synapse:send-message') {
          assertSession(data.sessionId);
          const text = typeof data.text === 'string' ? data.text.trim() : '';
          if (!text) throw new Error('消息不能为空');
          const reference = host.get('sessions').retain(data.sessionId, { source: 'nexus-synapse' });
          try {
            await reference.ready;
            if (disposed) throw new Error('图谱已离开，消息尚未发送');
            const result = await reference.binding.session.prompt([{ type: 'text', text }], 'queue');
            if (!result.ok) throw new Error(result.error?.message ?? '消息未被接受');
          } finally { reference.release(); }
          send('synapse:message-sent', { requestId: data.requestId, sessionId: data.sessionId });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '图谱操作失败';
        if (!disposed) setError(message);
        if (!disposed) send('synapse:bridge-error', { requestId: data.requestId, message });
      }
    };
    window.addEventListener('message', onMessage);
    const disposers = [host.get('sessions').list.subscribe(queueSync), host.get('workspaces').list.subscribe(queueSync), host.uiWorkspace.selection.subscribe(queueSync)];
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
    window.addEventListener('nexus:appearance', syncTheme);
    if (frameReady.current) loaded(); else sync();
    return () => {
      disposed = true;
      controller.abort();
      lifecycle(false);
      observer.disconnect();
      frameObserver.disconnect();
      clearTimeout(resizeTimer);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('nexus:appearance', syncTheme);
      for (const dispose of disposers) dispose();
      for (const record of live.values()) record.stops.forEach(stop => stop());
      for (const reference of references.values()) reference.release();
      if (sendRef.current === sync) sendRef.current = () => {};
      if (loadRef.current === loaded) loadRef.current = () => {};
    };
  }, [ctx, canvas, scope.level, scope.id, sessionId, openView, active]);
  return <div data-nexus-original-canvas={canvas} hidden={!active} style={{ height: '100%', minHeight: 0, display: active ? 'flex' : 'none', flexDirection: 'column' }}>
    {error && <div role="alert" style={{ padding: 8 }}>{error}<button onClick={() => { setError(''); sendRef.current(); }}>重试</button></div>}
    {generatedSession && <div style={{ padding: '4px 10px', display: 'flex', justifyContent: 'flex-end' }}>
      <button type="button" onClick={() => { void openOriginalComposer(ctx, generatedSession).catch(cause =>
        setError(cause instanceof Error ? cause.message : '无法打开生成会话')); }}>查看生成会话</button>
    </div>}
    <iframe ref={frame} title={canvas === 'thoughtdag' ? '上下文图谱' : '会话图谱'}
      src={scopedUrl(canvas, '', scope)} onLoad={() => { frameReady.current = true; loadRef.current(); }}
      style={{ flex: 1, width: '100%', minHeight: 0, border: 0, background: 'var(--dsw-alias-bg-base)' }} />
  </div>;
}

function RetainedCanvas(props: React.ComponentProps<typeof OriginalCanvas>) {
  const [visited, setVisited] = React.useState(props.active !== false);
  React.useEffect(() => { if (props.active !== false) setVisited(true); }, [props.active]);
  return visited || props.active !== false ? <OriginalCanvas {...props} /> : null;
}

const inlineCanvases = new Map<string, Canvas>();
const inlineListeners = new Set<() => void>();
const subscribeInline = (listener: () => void) => { inlineListeners.add(listener); return () => { inlineListeners.delete(listener); }; };
function selectInline(sessionId: string, canvas?: Canvas) {
  if (canvas) inlineCanvases.set(sessionId, canvas); else inlineCanvases.delete(sessionId);
  for (const listener of inlineListeners) listener();
}
function useInlineCanvas(sessionId: string) {
  return React.useSyncExternalStore(subscribeInline, () => inlineCanvases.get(sessionId));
}
function ConversationCanvasAction({ sessionId }: { sessionId: string }) {
  return <button className="nexus-canvas-header-action" type="button" title="打开完整 ThoughtDAG 会话页面" aria-label="打开完整 ThoughtDAG 会话页面"
    onClick={() => openOriginalConversationView(sessionId, 'nexus.thoughtdag')}>图谱</button>;
}

function ConversationCanvasPage({ ctx, canvas, sessionId, active, openView }: {
  ctx: ClientContext; canvas: Canvas; sessionId: string; active?: boolean; openView: (id: string) => void;
}) {
  return <section data-nexus-conversation-graph-page={canvas} style={{ display: 'flex', flexDirection: 'column',
    height: 'max(620px, calc(100dvh - 260px))', minHeight: 0, overflow: 'hidden' }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', flexShrink: 0 }}>
      <button type="button" onClick={() => openView('chat')}>对话记录与工具</button>
      <span style={{ flex: 1 }} />
      <button type="button" onClick={() => { selectInline(sessionId, canvas); openView('chat'); }}>与对话同时查看</button>
    </header>
    <div style={{ flex: 1, minHeight: 0 }}>
      <RetainedCanvas ctx={ctx} canvas={canvas} scope={{ level: 'session', id: sessionId }}
        sessionId={sessionId} active={active} openView={openView} />
    </div>
  </section>;
}
function ConversationCanvasDock({ ctx, sessionId, useStore }: {
  ctx: ClientContext; sessionId: string; useStore: <T>(select: (state: any) => T) => T;
}) {
  const canvas = useInlineCanvas(sessionId);
  const view = useStore(state => state.view);
  const normalConversation = view === 'chat' || view === 'reader';
  const [visited, setVisited] = React.useState(false);
  const openView = React.useCallback((id: string) => {
    if (id === 'chat') selectInline(sessionId);
    else openOriginalConversationView(sessionId, id);
  }, [sessionId]);
  React.useEffect(() => { if (canvas) setVisited(true); }, [canvas]);
  if (!canvas && !visited) return null;
  return <section data-nexus-conversation-canvas="" hidden={!canvas || !normalConversation}
    aria-label="会话图谱" style={{ display: canvas && normalConversation ? 'flex' : 'none', flexDirection: 'column',
      border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 12, overflow: 'hidden', marginBottom: 8 }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', flexShrink: 0 }}>
      <button type="button" aria-pressed={canvas === 'thoughtdag'} onClick={() => selectInline(sessionId, 'thoughtdag')}>上下文图谱</button>
      <button type="button" aria-pressed={canvas === 'synapse'} onClick={() => selectInline(sessionId, 'synapse')}>会话图谱</button>
      <span style={{ flex: 1 }} />
      <button type="button" onClick={() => openOriginalConversationView(sessionId, `nexus.${canvas ?? 'thoughtdag'}`)}>展开</button>
      <button type="button" aria-label="收起会话图谱" onClick={() => selectInline(sessionId)}>收起</button>
    </header>
    <div style={{ height: 'clamp(240px, 38vh, 400px)', minHeight: 200, maxHeight: '60vh', resize: 'vertical', overflow: 'hidden' }}>
      {(['thoughtdag', 'synapse'] as const).map(kind => <RetainedCanvas key={`${sessionId}:${kind}`} ctx={ctx} canvas={kind}
        scope={{ level: 'session', id: sessionId }} sessionId={sessionId} active={normalConversation && canvas === kind}
        openView={openView} />)}
    </div>
  </section>;
}

function CanvasPanel({ ctx, level }: { ctx: ClientContext; level: 'global' | 'workspace' }) {
  const [canvas, setCanvas] = React.useState<Canvas>('thoughtdag');
  const [workspaceId, setWorkspaceId] = React.useState('');
  const workspaces = (ctx as any).get('workspaces').list;
  const subscribeWorkspaces = React.useCallback((listener: () => void) => workspaces.subscribe(listener), [workspaces]);
  const readWorkspaces = React.useCallback(() => workspaces.getSnapshot(), [workspaces]);
  const snapshot = React.useSyncExternalStore<{ items: any[] }>(subscribeWorkspaces, readWorkspaces);
  const selectionSource = ctx.uiWorkspace?.selection;
  const subscribeSelection = React.useCallback((listener: () => void) => selectionSource?.subscribe(listener) ?? noSubscribe(), [selectionSource]);
  const readSelection = React.useCallback(() => selectionSource?.getSnapshot(), [selectionSource]);
  const selection = React.useSyncExternalStore(subscribeSelection, readSelection);
  const selected = workspaceId || snapshot.items.find((row: any) => row.sessionIds.includes(selection?.sessionId))?.workspaceId;
  const scope: Scope | undefined = level === 'global' ? { level, id: 'global' } : selected ? { level, id: selected } : undefined;
  return <div data-nexus-canvas-panel={level} style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
    <div style={{ display: 'flex', gap: 8, padding: 12 }}>
      {level === 'workspace' && <select aria-label="图谱工作区" value={selected ?? ''} onChange={event => setWorkspaceId(event.target.value)}>
        <option value="">选择工作区</option>{snapshot.items.map((row: any) => <option key={row.workspaceId} value={row.workspaceId}>{row.title}</option>)}
      </select>}
      <button aria-pressed={canvas === 'thoughtdag'} onClick={() => setCanvas('thoughtdag')}>上下文图谱</button>
      <button aria-pressed={canvas === 'synapse'} onClick={() => setCanvas('synapse')}>会话图谱</button>
    </div>
    {scope ? (['thoughtdag', 'synapse'] as const).map(kind => <RetainedCanvas key={`${scope.level}:${scope.id}:${kind}`}
      ctx={ctx} scope={scope} canvas={kind} active={canvas === kind} />)
      : <p style={{ padding: 16 }}>选择工作区</p>}
  </div>;
}

export function registerCanvasPanels(ctx: ClientContext) {
  const disposers: Array<() => void> = [];
  const chromeStyle = document.createElement('style');
  chromeStyle.dataset.nexusCanvasChrome = '';
  chromeStyle.textContent = canvasChromeCss;
  document.head.append(chromeStyle);
  disposers.push(() => chromeStyle.remove());
  const seat = (name: string, options: Record<string, unknown>, component: any) => {
    const dispose = ctx.slots.inject(name, () => ctx.slots.register({ name, ...options }, component));
    if (typeof dispose === 'function') disposers.push(dispose);
  };
  seat('conversation.session.header.actions', { id: 'nexus.inline-graph', order: 35,
    inject: (sessionId: string) => ({ sessionId }) }, ConversationCanvasAction);
  const stopDock = ctx.slots.inject('conversation.input.dock', () => {
    const native = (ctx.slots as any).entriesOfSlot('conversation.session')[0]?.store;
    if (native?.spec?.persist !== 'dsh.conversation') throw new Error('无法绑定原生会话图谱');
    return ctx.slots.register({ name: 'conversation.input.dock', id: 'nexus.inline-graph', order: -50, store: native },
      (props: any) => <ConversationCanvasDock key={props.sessionId} {...props} ctx={ctx} />);
  });
  if (typeof stopDock === 'function') disposers.push(stopDock);
  for (const [canvas, label, order] of [['thoughtdag', '上下文图谱', 40], ['synapse', '会话图谱', 50]] as const) {
    seat('conversation.view', { id: `nexus.${canvas}`, order, label: () => label, inject: (sessionId: string) => ({ sessionId }) },
      ({ sessionId, active, openView }: any) => <ConversationCanvasPage key={sessionId} ctx={ctx} canvas={canvas}
        sessionId={sessionId} openView={openView} active={active} />);
  }
  for (const [level, label, order] of [['workspace', '工作区图谱', 22], ['global', '全局图谱', 23]] as const) {
    const id = `nexus.${level}-graphs`;
    seat('main', { key: id }, () => <CanvasPanel ctx={ctx} level={level} />);
    seat('sidebar.panellist', { id, order, label: () => label }, () => <span aria-hidden="true">◇</span>);
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose();
    inlineCanvases.clear();
    inlineListeners.clear();
  };
}
