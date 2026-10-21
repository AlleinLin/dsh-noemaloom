import * as React from 'react';
import {
  DOCK_PANE_LIMIT, DOCK_STORAGE, advanceDock, dockLayoutFingerprint, dockPaneIds, nativeDockLayoutCompatible,
  planDockDrop, planDockSplit, readDockSurface, shouldRestoreDockBackup,
  type DockAxis, type DockKit, type DockLayout, type DockSurface, type DockZone,
} from './dock-model.js';
import { NativeDockTree } from './dock-native-tree.js';

interface AdapterOptions {
  renderControls(sessionId: string, layout: DockLayout): React.ReactNode;
  changed?(): void;
}
export interface NativeDockAdapter {
  controller: any;
  layout(sessionId?: string): DockLayout | undefined;
  split(axis: DockAxis, paneId?: string): string | undefined;
  canSplit(axis: DockAxis, paneId?: string): boolean;
  activePane(sessionId?: string): string | undefined;
  restored(sessionId: string): boolean;
  dispose(): void;
}
const safeStorage = {
  read(key: string): unknown { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return undefined; } },
  write(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { console.error('[nexus dock persistence]', error); } },
  clear(key: string) { try { localStorage.removeItem(key); } catch {} },
};

/**
 * rc.2 compatibility boundary. The native registration, authorized renderSlot,
 * store, controller, session references, TabDomain and tab bodies keep ownership.
 * No native factory is replayed and no child Slot is re-declared.
 */
export function adaptNativeDock(ctx: any, kit: DockKit, options: AdapterOptions): NativeDockAdapter {
  const controller = ctx.sidebarRight ?? ctx.get?.('sidebarRight');
  const entry = ctx.slots.entriesOfSlot?.('rightbar.session')?.[0];
  const handle = entry?.store;
  if (!entry || typeof entry.component !== 'function' || entry.component.name !== 'RightbarSeat'
    || typeof handle?.create !== 'function' || typeof handle.spec?.actions?.splitPane !== 'function'
    || typeof handle.spec?.actions?.dropTab !== 'function' || typeof handle.spec?.actions?.resizeSplit !== 'function'
    || !(controller?.adopted instanceof Map)
    || typeof controller?.screen !== 'function' || typeof controller?.place !== 'function'
    || typeof controller?.mounted?.getSnapshot !== 'function' || typeof controller?.isTargetCurrent !== 'function'
    || typeof controller?.host?.openWithFocus !== 'function' || typeof controller?.tabs?.get !== 'function'
    || typeof controller?.tabDomain?.sync !== 'function'
    || typeof kit?.record !== 'function' || typeof kit?.planSettle !== 'function' || typeof kit?.planResizeSplit !== 'function'
    || typeof kit?.DockSurface !== 'function' || typeof kit?.FloatLayer !== 'function') {
    throw new Error('当前宿主不支持原生自由分栏适配，请保留宿主分栏并更新兼容层');
  }
  const cleanups: (() => void)[] = [];
  const persistStops: (() => void)[] = [];
  const patchedInstances = new WeakSet<object>();
  const restoredSessions = new Set<string>();
  const fits = new Map<string, ReadonlyMap<string, { row: boolean; column: boolean }>>();
  let disposed = false;
  const seed = (id: string) => {
    const definition = controller.tabs.get('guide');
    return { id, kind: 'guide', contentId: 'sidebar://guide', title: definition?.title('sidebar://guide') ?? '打开内容' };
  };
  const currentSession = () => controller.mounted.getSnapshot() as string | undefined;
  const storeIn = (sessionId: string) => controller.adopted.get(sessionId)?.store;
  const surfaceIn = (sessionId: string): DockSurface | undefined => storeIn(sessionId)?.getSnapshot().bySession[sessionId];
  const layout = (sessionId = currentSession()): DockLayout | undefined => sessionId ? surfaceIn(sessionId)?.layout : undefined;
  const activePane = (sessionId = currentSession()) => {
    const state = layout(sessionId);
    if (!state) return;
    const active = state.nodes[state.activePaneId];
    return active?.kind === 'pane' && active.host === 'dock' ? active.id : dockPaneIds(state)[0];
  };
  const canSplit = (axis: DockAxis, paneId = activePane()) => {
    const sessionId = currentSession();
    const state = layout(sessionId);
    const pane = paneId ? state?.nodes[paneId] : undefined;
    return !!sessionId && !!state?.expanded && pane?.kind === 'pane' && pane.host === 'dock'
      && pane.tabs.length > 0 && dockPaneIds(state).length < DOCK_PANE_LIMIT
      && fits.get(sessionId)?.get(pane.id)?.[axis] !== false;
  };
  for (const adoption of controller.adopted.values()) {
    if (typeof adoption.store?.store?.update !== 'function' || typeof adoption.store?.store?.set !== 'function') {
      throw new Error('宿主原生分栏 store 更新协议已变化');
    }
  }
  // Acquire the version trigger before touching native objects, so an
  // unexpected registry collision cannot leave a partial adaptation.
  const allSeats = typeof ctx.slots.entries === 'function'
    ? ctx.slots.entries('rightbar.session') : ctx.slots.entriesOfSlot('rightbar.session');
  const priority = Math.max(0, ...allSeats.map((row: any) => row.options.priority ?? 0)) + 1000000;
  const stopVersionSeat = ctx.slots.register({ name: 'rightbar.session', priority }, () => null);
  const splitAction = (draft: any, sessionId: string, paneId?: string, settled?: (id: string) => void, axis: DockAxis = 'row') => {
    const before: DockSurface | undefined = draft.bySession[sessionId];
    if (!before) return;
    const target = paneId ?? activePane(sessionId);
    if (!target) return;
    const next = advanceDock(before, kit, (state, mint, makeTab) => planDockSplit(state, mint, target, axis, makeTab), seed);
    if (next === before) return;
    draft.bySession = { ...draft.bySession, [sessionId]: next };
    const previous = new Set(dockPaneIds(before.layout));
    const created = dockPaneIds(next.layout).find(id => !previous.has(id));
    if (created) settled?.(created);
  };
  const dropAction = (draft: any, sessionId: string, tabId: string, paneId: string, zone: DockZone) => {
    const before: DockSurface | undefined = draft.bySession[sessionId];
    if (!before) return;
    const next = advanceDock(before, kit, (state, mint, makeTab) => planDockDrop(state, mint, tabId, paneId, zone, makeTab), seed);
    if (next !== before) draft.bySession = { ...draft.bySession, [sessionId]: next };
  };
  const readSaved = (sessionId: string): { surface?: DockSurface; projection?: string } => {
    const raw = safeStorage.read(`${DOCK_STORAGE}.${sessionId}`) as any;
    return { surface: readDockSurface(raw, kit.EMPTY_HISTORY), projection: typeof raw?.nativeProjection === 'string' ? raw.nativeProjection : undefined };
  };
  const patchInstance = (instance: any, sessionId: string, saved?: DockSurface, projection?: string) => {
    if (patchedInstances.has(instance.actions)) return;
    if (typeof instance.store?.update !== 'function' || typeof instance.store?.set !== 'function') {
      throw new Error('宿主原生分栏 store 更新协议已变化');
    }
    patchedInstances.add(instance.actions);
    const previous = {
      splitPane: instance.actions.splitPane, dropTab: instance.actions.dropTab, resizeSplit: instance.actions.resizeSplit,
    };
    const split = (...args: any[]) => instance.store.update((draft: any) => splitAction(draft, ...args as [string, string?, ((id: string) => void)?, DockAxis?]));
    const drop = (...args: any[]) => instance.store.update((draft: any) => dropAction(draft, ...args as [string, string, string, DockZone]));
    const resize = (id: string, splitId: string, sizes: number[]) => instance.store.update((draft: any) => {
      const before: DockSurface | undefined = draft.bySession[id];
      if (!before) return;
      const next = advanceDock(before, kit, () => kit.planResizeSplit(splitId, sizes, .12), seed);
      if (next !== before) draft.bySession = { ...draft.bySession, [id]: next };
    });
    instance.actions.splitPane = split;
    instance.actions.dropTab = drop;
    instance.actions.resizeSplit = resize;
    cleanups.push(() => {
      if (instance.actions.splitPane === split) instance.actions.splitPane = previous.splitPane;
      if (instance.actions.dropTab === drop) instance.actions.dropTab = previous.dropTab;
      if (instance.actions.resizeSplit === resize) instance.actions.resizeSplit = previous.resizeSplit;
    });
    const current: DockSurface | undefined = instance.getSnapshot().bySession[sessionId];
    if (saved && (shouldRestoreDockBackup(current) || current && projection === dockLayoutFingerprint(current.layout))) {
      restoredSessions.add(sessionId);
      // rc.2 tracks occurrences by tab id, so replacing a seeded tab2 with a
      // restored tab2 must end the placeholder's old navigation and pin first.
      if (current && Object.values(current.layout.tabs).some(tab => {
        const restored = saved.layout.tabs[tab.id];
        return !restored || restored.kind !== tab.kind || restored.contentId !== tab.contentId;
      })) controller.tabDomain.sync(sessionId, { ...current.layout, tabs: {} });
      instance.store.set({ ...instance.getSnapshot(), bySession: { ...instance.getSnapshot().bySession, [sessionId]: saved } });
    } else if (saved) restoredSessions.add(sessionId);
    const persist = () => {
      const surface = instance.getSnapshot().bySession[sessionId];
      if (surface) safeStorage.write(`${DOCK_STORAGE}.${sessionId}`, { layout: surface.layout, minted: surface.minted });
    };
    persistStops.push(instance.subscribe(persist));
    persist();
  };
  const originalCreate = handle.create;
  const create = function (this: any, sessionId?: string) {
    // Read before native v1 validation; the native loader deliberately rejects
    // nested trees. The plugin's independently validated snapshot survives it.
    const saved = sessionId ? readSaved(sessionId) : undefined;
    const instance = originalCreate.call(this, sessionId);
    if (sessionId) patchInstance(instance, sessionId, saved?.surface, saved?.projection);
    const originalClear = instance.clearPersisted;
    const clear = () => {
      originalClear.call(instance);
      if (sessionId) safeStorage.clear(`${DOCK_STORAGE}.${sessionId}`);
    };
    instance.clearPersisted = clear;
    cleanups.push(() => { if (instance.clearPersisted === clear) instance.clearPersisted = originalClear; });
    return instance;
  };
  handle.create = create;
  cleanups.push(() => { if (handle.create === create) handle.create = originalCreate; });
  try {
    for (const [sessionId, adoption] of controller.adopted) {
      const saved = readSaved(sessionId);
      patchInstance(adoption.store, sessionId, saved.surface, saved.projection);
    }
  } catch (error) {
    prepareNativeRestore();
    for (const cleanup of cleanups.reverse()) cleanup();
    stopVersionSeat();
    throw error;
  }
  function prepareNativeRestore() {
    for (const stop of persistStops.splice(0)) stop();
    for (const [sessionId, adoption] of controller.adopted) {
      const surface: DockSurface | undefined = adoption.store.getSnapshot().bySession[sessionId];
      if (!surface || nativeDockLayoutCompatible(surface.layout)) continue;
      const panes = dockPaneIds(surface.layout);
      const target = panes[0];
      if (!target) continue;
      const destination = surface.layout.nodes[target];
      let index = destination.kind === 'pane' ? destination.tabs.length : 0;
      const ops = panes.slice(1).flatMap(id => {
        const pane = surface.layout.nodes[id];
        return pane.kind === 'pane' ? pane.tabs.map(tabId => ({ type: 'moveTab', tabId, toPaneId: target, index: index++ })) : [];
      });
      // Also settle a restored tree consisting only of empty panes.
      ops.push({ type: 'focusPane', paneId: target } as any);
      const projected = advanceDock(surface, kit, () => ops, seed);
      const compatible = { ...projected, history: kit.EMPTY_HISTORY };
      // Retain the full tree before projecting, and stop our persistence first:
      // native v1 receives a safe tree; the plugin backup keeps every split.
      safeStorage.write(`${DOCK_STORAGE}.${sessionId}`, {
        layout: surface.layout, minted: surface.minted, nativeProjection: dockLayoutFingerprint(compatible.layout),
      });
      adoption.store.store.set({
        ...adoption.store.getSnapshot(),
        bySession: { ...adoption.store.getSnapshot().bySession, [sessionId]: compatible },
      });
    }
  }
  const split = (axis: DockAxis, paneId = activePane()): string | undefined => {
    if (!paneId || !canSplit(axis, paneId)) return;
    const sessionId = currentSession()!;
    const instance = storeIn(sessionId);
    let created: string | undefined;
    controller.host.openWithFocus(sessionId, () => {
      instance.actions.splitPane(sessionId, paneId, (id: string) => { created = id; }, axis);
      return created;
    });
    return created;
  };
  const replaceMethod = (key: string, value: any) => {
    const previous = controller[key];
    const own = Object.hasOwn(controller, key);
    controller[key] = value;
    cleanups.push(() => {
      if (controller[key] !== value) return;
      if (own) controller[key] = previous;
      else delete controller[key];
    });
    return previous;
  };
  replaceMethod('split', (paneId?: string) => split('row', paneId));
  replaceMethod('splitBlock', (target: any) => {
    const state = layout();
    if (!state || !controller.isTargetCurrent(target)) return 'stale';
    const pane = state.nodes[target.paneId];
    if (target.host === 'float') return 'float';
    if (!state.expanded) return 'collapsed';
    if (pane?.kind !== 'pane' || !pane.tabs.length) return 'empty';
    if (dockPaneIds(state).length >= DOCK_PANE_LIMIT) return 'budget';
    if (!canSplit('row', target.paneId)) return 'width';
    return undefined;
  });
  const originalPlace = controller.place;
  replaceMethod('place', function (this: any, sessionId: string, actions: any, claim: any, address: string, placement: any, params: any) {
    let next = placement;
    const state = layout(sessionId);
    const existing = state && placement.revealIfOpened !== false
      ? Object.values(state.tabs).find(tab => tab.kind === claim.kind && tab.contentId === claim.contentId) : undefined;
    if (placement.preferNewPane && !placement.replaceTab && currentSession() === sessionId && !existing) {
      const created = split('row', placement.paneId);
      if (created) {
        const pane = layout(sessionId)?.nodes[created];
        const guide = pane?.kind === 'pane' ? pane.tabs.find(id => layout(sessionId)?.tabs[id]?.kind === 'guide') : undefined;
        next = { ...placement, paneId: created, preferNewPane: false, ...(guide ? { replaceTab: guide } : {}) };
      }
    }
    return originalPlace.call(this, sessionId, actions, claim, address, next, params);
  });

  const OriginalSeat = entry.component;
  const panels = new WeakMap<Function, React.ComponentType<any>>();
  function adaptPanel(OriginalPanel: any): React.ComponentType<any> {
    const existing = panels.get(OriginalPanel);
    if (existing) return existing;
    function NativeDockPanel(props: any) {
      // These are the original function components, invoked inside a stable
      // wrapper: their hook order and their authorized props remain intact.
      const tree = OriginalPanel(props);
      const visit = (node: React.ReactNode): React.ReactNode => {
        if (!React.isValidElement<any>(node)) return node;
        const element = node as React.ReactElement<Record<string, any>>;
        const childProps = element.props;
        if (childProps.state === props.surface.layout && childProps.intents && childProps.renderTab) {
          const originalRoom = childProps.onRoom;
          /* rc.2 DockLayout accepts only two horizontal panes. The exported
           * recursive components plus stable portals preserve native viewers. */
          return <NativeDockTree {...childProps} kit={kit as any}
            state={childProps.state} renderTab={childProps.renderTab}
            canSplit={dockPaneIds(props.surface.layout).length < DOCK_PANE_LIMIT}
            dropZones="edges" minPaneFraction={.12}
            labels={{ ...childProps.labels, splitPaneDisabled: '最多六个分栏' }}
            onRoom={(room: ReadonlyMap<string, { row: boolean; column: boolean }>) => {
              fits.set(props.sessionId, room);
              originalRoom?.(room);
              options.changed?.();
            }}
            chrome={<>{options.renderControls(props.sessionId, props.surface.layout)}{childProps.chrome}</>} />;
        }
        return childProps.children === undefined ? node
          : React.cloneElement(element, undefined, React.Children.map(childProps.children, visit));
      };
      return visit(tree);
    }
    panels.set(OriginalPanel, NativeDockPanel);
    return NativeDockPanel;
  }
  function NativeDockSeat(props: any) {
    const tree = OriginalSeat(props);
    if (!React.isValidElement<any>(tree) || typeof tree.type !== 'function' || !tree.props.surface) return tree;
    return React.createElement(adaptPanel(tree.type), tree.props);
  }
  entry.component = NativeDockSeat;
  cleanups.push(() => { if (entry.component === NativeDockSeat) entry.component = OriginalSeat; });
  // A losing registration bumps the registry version without re-declaring
  // any child slot or acquiring another store/controller.
  return {
    controller, layout, split, canSplit, activePane,
    restored: sessionId => restoredSessions.has(sessionId),
    dispose() {
      if (disposed) return;
      disposed = true;
      prepareNativeRestore();
      for (const cleanup of cleanups.reverse()) cleanup();
      // Removal publishes the restored original component in the same cell.
      stopVersionSeat();
      fits.clear();
    },
  };
}
