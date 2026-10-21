import * as React from 'react';
import type { ClientContext } from './types.js';
import type { DockRenderProps, NativeDockProvider } from './native-docking.js';
import {
  NativeSubagentConversationViews, NativeSubagentViewScope, installNativeSubagentConversationViews,
} from './subagent-conversation-views.js';

const FACTORY = 'nexus.dock.conversation-view';
type Renderer = (key: string, owner: any, options?: any) => React.ReactNode;
interface Capture {
  renderSlot: Renderer;
  renderFactorySlot: Renderer;
  SessionProvider: React.ComponentType<any>;
}
interface CaptureState { capture?: Capture; error?: string }
interface SessionReference {
  sessionId: string;
  binding: unknown;
  ready: Promise<unknown>;
  release(): void;
}
const emptySubscription = () => () => {};

/**
 * Reuse the real View entries through the original owner's delegated renderSlot.
 * The dedicated scoped Factory borrows the native session store handle and inject,
 * so a fixed pane gets its own session's callbacks, never the main pane's callbacks.
 */
export function createNativeDockViewProvider(rawContext: ClientContext): {
  provider: NativeDockProvider;
  dispose(): void;
} {
  const ctx = rawContext as any;
  const listeners = new Set<() => void>();
  const lifetime = new AbortController();
  let state: CaptureState = {};
  let disposed = false;
  const activateSubagentView = (sessionId: string, viewId: string) => ctx.uiConversation.binding(sessionId).activate(viewId);
  const publish = (next: CaptureState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const getSnapshot = () => state;

  function ScopedNativeView(props: any) {
    const tabs = props.useConversationViews((value: any) => value) as { id: string; label?: string }[];
    const nativeInspectCall = props.useInspectCall((value: unknown) => value);
    const viewRequest = props.useStore((value: any) => value.viewRequest ?? null);
    const [navigation, setNavigation] = React.useState<{ source: string; view: string }>();
    const viewId = navigation && navigation.source === props.viewId ? navigation.view : props.viewId;
    const available = tabs.some(tab => tab.id === viewId);
    const openView = React.useCallback((view: string, focus = '') => {
      props.openView(view, focus);
      setNavigation({ source: props.viewId, view });
    }, [props.openView, props.viewId]);
    const inspectCall = React.useMemo(() => nativeInspectCall === undefined ? undefined : (callId: string) => {
      // Keep the native inspect action and its opaque focus request. Also reveal
      // that target inside this pane when its session is fixed away from main.
      const destination = ctx.uiConversation.views.entries().find((definition: any) =>
        definition.toolCallFocus !== undefined && tabs.some(tab => tab.id === definition.target));
      nativeInspectCall(callId);
      if (destination) setNavigation({ source: props.viewId, view: destination.target });
    }, [nativeInspectCall, props.viewId, tabs]);
    React.useEffect(() => {
      if (available) ctx.uiConversation.binding(props.sessionId).activate(viewId);
    }, [available, props.sessionId, viewId]);
    if (!available) return <p className="nexus-native-dock-empty">此视图尚未就绪，加载对应插件后将自动恢复。</p>;
    return <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {viewId === props.viewId ? null : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 8px' }}>
        <span>{tabs.find(tab => tab.id === viewId)?.label ?? viewId}</span>
        <button type="button" onClick={() => openView(props.viewId)}>返回{tabs.find(tab => tab.id === props.viewId)?.label ?? '原视图'}</button>
      </div>}
      <div data-conversation-scroll="" data-nexus-native-dock-view={viewId} style={{
        flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
        containerType: 'inline-size', '--dsh-composer-height': '0px',
      } as React.CSSProperties}>
        {props.nativeRenderSlot('conversation.view', {
          inspectCall,
          viewRequest,
          openView,
          completeViewRequest: props.actions.completeViewRequest,
          active: props.visible,
        }, { only: viewId })}
      </div>
    </div>;
  }

  function NativeDockView({ sessionId, target, visible, signal }: DockRenderProps) {
    const captured = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const generationSource = ctx.connection?.generation;
    const generation = React.useSyncExternalStore(
      generationSource?.subscribe ?? emptySubscription,
      () => generationSource?.getSnapshot?.()?.id ?? 0,
      () => generationSource?.getSnapshot?.()?.id ?? 0,
    );
    const [retained, setRetained] = React.useState<{
      sessionId: string; generation: unknown; reference?: SessionReference; error?: string;
    }>();
    React.useEffect(() => {
      if (disposed || signal.aborted) return;
      let active = true;
      let released = false;
      let reference: SessionReference | undefined;
      const cancellation = new AbortController();
      const release = () => {
        if (released) return;
        released = true;
        reference?.release();
      };
      const abort = () => {
        active = false;
        cancellation.abort();
        release();
        setRetained(undefined);
      };
      signal.addEventListener('abort', abort, { once: true });
      lifetime.signal.addEventListener('abort', abort, { once: true });
      try {
        reference = ctx.sessions.retain(sessionId, { source: 'nexus-dock-view', signal: cancellation.signal });
        const owned = reference!;
        void Promise.resolve(owned.ready).then(() => {
          if (active) setRetained({ sessionId, generation, reference: owned });
        }, error => {
          release();
          if (active) setRetained({ sessionId, generation, error: error instanceof Error ? error.message : String(error) });
        });
      } catch (error) {
        release();
        if (active) setRetained({ sessionId, generation, error: error instanceof Error ? error.message : String(error) });
      }
      return () => {
        active = false;
        signal.removeEventListener('abort', abort);
        lifetime.signal.removeEventListener('abort', abort);
        cancellation.abort();
        release();
      };
    }, [sessionId, generation, signal]);
    if (disposed || signal.aborted) return null;
    if (captured.error) return <p role="alert" className="nexus-native-dock-empty">{captured.error}</p>;
    const current = retained?.sessionId === sessionId && retained.generation === generation ? retained : undefined;
    if (current?.error) return <p role="alert" className="nexus-native-dock-empty">无法打开此会话：{current.error}</p>;
    if (!captured.capture || !current?.reference) return <p role="status" className="nexus-native-dock-empty">正在打开会话视图…</p>;
    const capture = captured.capture;
    const SessionProvider = capture.SessionProvider;
    return <SessionProvider session={current.reference} empty={() => <p className="nexus-native-dock-empty">此会话已关闭。</p>}>
      {capture.renderFactorySlot(FACTORY, {
        viewId: target.id,
        visible,
        nativeRenderSlot: capture.renderSlot,
      })}
    </SessionProvider>;
  }

  let stop: unknown;
  try {
    stop = ctx.slots.inject('conversation.session', () => {
      const entry = ctx.slots.entriesOfSlot('conversation.session')[0];
      if (!entry?.children?.['conversation.view'] || entry.store?.spec?.persist !== 'dsh.conversation'
        || typeof entry.component !== 'function' || typeof entry.inject !== 'function'
        || typeof ctx.slots.registerFactory !== 'function') {
        throw new Error('当前宿主的原生会话视图协议已变化，无法安装会话分栏查看器。');
      }
      const original = entry.component;
      // This is a narrow rc.2 compatibility wrapper of the already-assembled
      // owner entry, not a direct invocation of a View component. The renderer
      // still supplies the original entry's store/inject/children authorization.
      function CaptureNativeOwner(props: any) {
        const subagentOccurrence = React.useContext(NativeSubagentViewScope);
        React.useLayoutEffect(() => {
          if (disposed) return;
          const next = {
            renderSlot: props.renderSlot,
            renderFactorySlot: props.renderFactorySlot,
            SessionProvider: props.SessionProvider,
          };
          if (typeof next.renderSlot !== 'function' || typeof next.renderFactorySlot !== 'function'
            || typeof next.SessionProvider !== 'function') {
            publish({ error: '宿主没有提供已授权的会话视图渲染器。' });
            return;
          }
          const previous = state.capture;
          if (!previous || previous.renderSlot !== next.renderSlot || previous.SessionProvider !== next.SessionProvider
            || previous.renderFactorySlot !== next.renderFactorySlot) publish({ capture: next });
        }, [props.renderSlot, props.renderFactorySlot, props.SessionProvider]);
        return subagentOccurrence
          ? <NativeSubagentConversationViews component={original} owner={props} activate={activateSubagentView} />
          : React.createElement(original, props);
      }
      const stopFactory = ctx.slots.registerFactory({
        name: FACTORY,
        scope: 'session',
        store: entry.store,
        inject: entry.inject,
        ...(entry.locale ? { locale: entry.locale } : {}),
      }, ScopedNativeView);
      const entries = ctx.slots.entries?.('conversation.session') ?? [entry];
      const priority = Math.max(0, ...entries.map((item: any) => item.options.priority ?? 0)) + 1000000;
      let stopVersion: (() => void) | undefined;
      try {
        entry.component = CaptureNativeOwner;
        // A non-elected public registration publishes the component change.
        stopVersion = ctx.slots.register({ name: 'conversation.session', priority }, () => null);
      } catch (error) {
        if (entry.component === CaptureNativeOwner) entry.component = original;
        stopFactory();
        throw error;
      }
      return () => {
        publish({});
        if (entry.component === CaptureNativeOwner) entry.component = original;
        stopVersion?.();
        stopFactory();
      };
    });
  } catch (error) {
    publish({ error: error instanceof Error ? error.message : String(error) });
    console.error('[nexus native dock views]', error);
  }

  let stopSubagent: (() => void) | undefined;
  try {
    stopSubagent = installNativeSubagentConversationViews(ctx);
  } catch (error) {
    console.error('[nexus subagent conversation views]', error);
  }

  return {
    provider: {
      id: 'nexus.native-conversation-views',
      accepts: target => target.type === 'view',
      render: props => <NativeDockView {...props} />,
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      stopSubagent?.();
      if (typeof stop === 'function') stop();
      publish({});
      listeners.clear();
    },
  };
}
