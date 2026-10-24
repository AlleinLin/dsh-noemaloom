import type { ClientContext } from './types.js';

const preferenceKey = 'dsh-noemaloom:rightbar-width:v1';
type WidthStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Use the native root store so the grid, panel, resize handle and drag origin
 * always share one width. An explicit drag keeps the user's chosen width. */
export function installAdaptiveRightbar(ctx: ClientContext, storage?: WidthStorage): () => void {
  const root = ctx.slots.entriesOfSlot?.('root')?.find(entry => entry.component?.name === 'AppFrame');
  const instance = root?.store?.create?.();
  const actions = instance?.actions;
  if (!instance?.getSnapshot || typeof instance.store?.update !== 'function'
    || (ctx.layout as any)?.panels !== actions
    || !['openRightbar', 'setRightbar', 'setViewportWidth', 'toggleSidebar', 'setSidebar']
      .every(name => typeof actions[name] === 'function')) return () => {};
  let persistence = storage;
  try { persistence ??= globalThis.localStorage; } catch {}
  let manualWidth: number | undefined;
  try {
    const value = persistence?.getItem(preferenceKey);
    const width = value ? Number(value) : NaN;
    if (Number.isFinite(width) && width >= 300 && width <= 10000) manualWidth = width;
  } catch {}
  const original = Object.fromEntries(
    ['openRightbar', 'setRightbar', 'setViewportWidth', 'toggleSidebar', 'setSidebar']
      .map(name => [name, actions[name]]),
  );
  const automaticWidth = () => {
    const info = instance.getSnapshot().layoutInfo;
    const viewport = Number(info.viewportWidth);
    const sidebar = viewport < 1024
      ? info.narrowExpanded ? Number(info.sidebar) || 280 : 0 : Number(info.sidebar);
    return Math.round(Math.max(300, Math.min(360, (viewport - sidebar) * .3)));
  };
  const refresh = () => {
    const info = instance.getSnapshot().layoutInfo;
    if (info.rightbar === null && !info.rightbarShown) return;
    const width = manualWidth ?? automaticWidth();
    if (info.rightbar !== width) original.setRightbar.call(actions, width);
  };
  const wrapped: Record<string, (...args: any[]) => any> = {};
  for (const name of ['setViewportWidth', 'toggleSidebar', 'setSidebar']) {
    wrapped[name] = (...args) => {
      const result = original[name].apply(actions, args);
      refresh();
      return result;
    };
  }
  wrapped.openRightbar = (...args) => {
    // Replace the 45% default before native openRightbar materializes it.
    original.setRightbar.call(actions, manualWidth ?? automaticWidth());
    return original.openRightbar.apply(actions, args);
  };
  wrapped.setRightbar = (...args) => {
    const result = original.setRightbar.apply(actions, args);
    manualWidth = instance.getSnapshot().layoutInfo.rightbar;
    try { persistence?.setItem(preferenceKey, String(manualWidth)); } catch {}
    return result;
  };
  const reset = (event: Event) => {
    const target = event.target as Element | null;
    if (!target?.closest?.('[data-side="rightbar"]')) return;
    manualWidth = undefined;
    try { persistence?.removeItem(preferenceKey); } catch {}
    refresh();
  };
  Object.assign(actions, wrapped);
  globalThis.document?.addEventListener('dblclick', reset);
  refresh();
  return () => {
    globalThis.document?.removeEventListener('dblclick', reset);
    for (const [name, handler] of Object.entries(wrapped)) {
      if (actions[name] === handler) actions[name] = original[name];
    }
  };
}
