/** JSON contracts at the native docking boundary. No second layout engine. */
export const DOCK_PANE_LIMIT = 6;
export const DOCK_STORAGE = 'dsh.nexus.dock.v1';
export const DOCK_PREFERENCES = 'dsh.nexus.dock.preferences.v1';
export type DockAxis = 'row' | 'column';
export type DockZone = 'center' | 'left' | 'right' | 'top' | 'bottom';
export type DockTemplateId = 'conversation-agents' | 'review' | 'watch';
export type DockPreferenceScope = 'global' | 'workspace' | 'session';
export interface NativeDockTarget {
  type: 'view' | 'agent' | 'artifact' | string;
  id: string;
  title: string;
  /** Absent follows the session that owns the native pane. */
  sessionId?: string;
  binding?: 'follow' | 'fixed';
  params?: Record<string, string | number | boolean | null>;
}
export interface DockPane {
  kind: 'pane'; id: string; host: 'dock' | 'float'; tabs: string[];
  activeTabId?: string; rect?: { x: number; y: number; width: number; height: number };
}
export interface DockSplit { kind: 'split'; id: string; axis: DockAxis; children: string[]; sizes: number[] }
export interface DockTab { id: string; kind: string; contentId: string; title: string }
export interface DockLayout {
  nodes: Record<string, DockPane | DockSplit>; tabs: Record<string, DockTab>; rootId: string;
  floats: string[]; activePaneId: string; expanded: boolean; mode: 'push' | 'fullscreen';
}
export interface DockSurface { layout: DockLayout; minted: number; history: any }
export interface DockKit {
  [key: string]: any;
  replay(state: DockLayout, ops: any[]): DockLayout;
  record(history: any, state: DockLayout, ops: any[]): { state: DockLayout; history: any };
  planSettle(state: DockLayout, mint: (prefix: string) => string, seed?: (id: string) => DockTab): any[];
}
export interface DockPreferences {
  global?: DockTemplateId;
  workspace: Record<string, DockTemplateId>;
  session: Record<string, DockTemplateId>;
}
/** A native live resource wins over an older plugin backup on installation. */
export function shouldRestoreDockBackup(live: DockSurface | undefined): boolean {
  return !live || Object.values(live.layout.tabs).every(tab => tab.kind === 'guide');
}
export function nativeDockLayoutCompatible(layout: DockLayout): boolean {
  const root = layout.nodes[layout.rootId];
  return root?.kind === 'pane' || root?.kind === 'split' && root.axis === 'row' && root.children.length === 2
    && root.children.every(id => layout.nodes[id]?.kind === 'pane');
}
/** Order-independent marker for a reversible native projection during unload. */
export function dockLayoutFingerprint(layout: DockLayout): string {
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
    : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(layout));
}
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const idPattern = /^(?:pane|float|split|tab)[1-9][0-9]*$/u;
const panePattern = /^(?:pane|float)[1-9][0-9]*$/u;
export const isDockTemplate = (value: unknown): value is DockTemplateId =>
  value === 'conversation-agents' || value === 'review' || value === 'watch';

export function dockPaneIds(layout: DockLayout): string[] {
  const result: string[] = [];
  const visit = (id: string) => {
    const node = layout.nodes[id];
    if (node?.kind === 'pane') result.push(id);
    else if (node?.kind === 'split') node.children.forEach(visit);
  };
  visit(layout.rootId);
  return result;
}

/** Validate the full graph before the host receives a restored snapshot. */
export function readDockSurface(raw: unknown, emptyHistory: unknown): DockSurface | undefined {
  if (!object(raw) || !Number.isSafeInteger(raw.minted) || raw.minted < 0 || !object(raw.layout)) return;
  const layout = raw.layout;
  if (!object(layout.nodes) || !object(layout.tabs) || !Array.isArray(layout.floats)
    || typeof layout.expanded !== 'boolean' || !['push', 'fullscreen'].includes(layout.mode)
    || typeof layout.rootId !== 'string' || !panePattern.test(layout.activePaneId ?? '')) return;
  const all = [...Object.entries(layout.nodes), ...Object.entries(layout.tabs)];
  if (all.length > 1024 || layout.floats.length > 64) return;
  for (const [id, entry] of all) {
    if (!idPattern.test(id) || !object(entry) || entry.id !== id || Number(id.replace(/^[a-z]+/u, '')) > raw.minted) return;
  }
  const seen = new Set<string>();
  const tabs = new Set<string>();
  let docked = 0;
  const pending = [{ id: layout.rootId, host: 'dock' }, ...layout.floats.map(id => ({ id, host: 'float' }))];
  for (const { id, host } of pending) {
    if (seen.has(id)) return;
    seen.add(id);
    const entry = layout.nodes[id];
    if (!object(entry)) return;
    if (entry.kind === 'split') {
      if (host !== 'dock' || !/^split[1-9][0-9]*$/u.test(id) || !['row', 'column'].includes(entry.axis)
        || !Array.isArray(entry.children) || entry.children.length < 2 || entry.children.length > DOCK_PANE_LIMIT
        || !Array.isArray(entry.sizes) || entry.children.length !== entry.sizes.length
        || entry.sizes.some((size: unknown) => typeof size !== 'number' || !Number.isFinite(size) || size <= 0)
        || Math.abs(entry.sizes.reduce((a: number, b: number) => a + b, 0) - 1) > 1e-9) return;
      pending.push(...entry.children.map((child: unknown) => ({ id: child, host })) as typeof pending);
    } else if (entry.kind === 'pane') {
      if (!panePattern.test(id) || entry.host !== host || !Array.isArray(entry.tabs)
        || (entry.tabs.length ? !entry.tabs.includes(entry.activeTabId) : entry.activeTabId !== undefined)) return;
      if (host === 'dock') { if (entry.rect !== undefined || ++docked > DOCK_PANE_LIMIT) return; }
      else if (!object(entry.rect) || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(entry.rect[key]))
        || entry.rect.width <= 0 || entry.rect.height <= 0 || entry.tabs.length !== 1) return;
      for (const tabId of entry.tabs) {
        const tab = layout.tabs[tabId];
        if (!/^tab[1-9][0-9]*$/u.test(tabId) || tabs.has(tabId) || !object(tab)
          || typeof tab.kind !== 'string' || !tab.kind || typeof tab.contentId !== 'string' || !tab.contentId
          || typeof tab.title !== 'string') return;
        tabs.add(tabId);
      }
    } else return;
  }
  if (!docked || seen.size !== Object.keys(layout.nodes).length || tabs.size !== Object.keys(layout.tabs).length
    || layout.nodes[layout.activePaneId]?.kind !== 'pane') return;
  return { layout: layout as DockLayout, minted: raw.minted, history: emptyHistory };
}

export function targetAddress(target: NativeDockTarget): string {
  if (!target.type || !target.id || !target.title || target.type.length > 80 || target.id.length > 2048 || target.title.length > 256
    || (target.binding === 'fixed' && !target.sessionId)) throw new Error('分栏对象缺少有效身份');
  const normalized = { ...target, binding: target.binding ?? 'follow' };
  const address = `dsh-resource://nexus-dock/${encodeURIComponent(JSON.stringify(normalized))}`;
  if (!parseTargetAddress(address)) throw new Error('分栏对象的参数无效');
  return address;
}
export function parseTargetAddress(address: string): NativeDockTarget | undefined {
  if (!address.startsWith('dsh-resource://nexus-dock/') || address.length > 16384) return;
  try {
    const value = JSON.parse(decodeURIComponent(address.slice('dsh-resource://nexus-dock/'.length)));
    if (!object(value) || typeof value.type !== 'string' || !value.type || value.type.length > 80
      || typeof value.id !== 'string' || !value.id || value.id.length > 2048
      || typeof value.title !== 'string' || !value.title || value.title.length > 256
      || !['fixed', 'follow'].includes(value.binding) || (value.binding === 'fixed' && (typeof value.sessionId !== 'string' || !value.sessionId))
      || (value.sessionId !== undefined && typeof value.sessionId !== 'string')) return;
    if (value.params !== undefined && (!object(value.params) || Object.keys(value.params).length > 32
      || Object.values(value.params).some(item => item !== null && !['string', 'number', 'boolean'].includes(typeof item)))) return;
    return value as NativeDockTarget;
  } catch { return; }
}

/** Native operations remain the only mutations; native record/replay supplies undo. */
export function planDockSplit(layout: DockLayout, mint: (prefix: string) => string, paneId: string,
  axis: DockAxis, seed: (id: string) => DockTab): any[] {
  const pane = layout.nodes[paneId];
  if (pane?.kind !== 'pane' || pane.host !== 'dock' || !pane.tabs.length || dockPaneIds(layout).length >= DOCK_PANE_LIMIT) return [];
  const next = mint('pane');
  return [{ type: 'split', paneId, axis, direction: 'after', newPaneId: next, newSplitId: mint('split') },
    { type: 'openTab', paneId: next, tab: seed(mint('tab')), index: 0 }];
}
export function planDockDrop(layout: DockLayout, mint: (prefix: string) => string, tabId: string,
  paneId: string, zone: DockZone, seed: (id: string) => DockTab): any[] {
  const source = Object.values(layout.nodes).find((node): node is DockPane => node.kind === 'pane' && node.tabs.includes(tabId));
  const target = layout.nodes[paneId];
  if (!source || target?.kind !== 'pane' || target.host !== 'dock') return [];
  const into = (to: string, index: number) => source.host === 'float'
    ? { type: 'unfloat', paneId: source.id, toPaneId: to, index }
    : { type: 'moveTab', tabId, toPaneId: to, index };
  if (zone === 'center') {
    if (source.id === paneId) return [];
    const tab = layout.tabs[tabId];
    const held = target.tabs.find(id => layout.tabs[id]?.kind === tab.kind && layout.tabs[id]?.contentId === tab.contentId);
    if (tab.contentId === `sidebar://${tab.kind}` && held) return [{ type: 'closeTab', tabId }, { type: 'focusTab', tabId: held }];
    return [into(paneId, target.tabs.length)];
  }
  if (dockPaneIds(layout).length >= DOCK_PANE_LIMIT) return [];
  const next = mint('pane');
  const ops: any[] = [{ type: 'split', paneId, axis: zone === 'top' || zone === 'bottom' ? 'column' : 'row',
    direction: zone === 'left' || zone === 'top' ? 'before' : 'after', newPaneId: next, newSplitId: mint('split') }];
  if (source.id === paneId && source.tabs.length === 1) ops.push({ type: 'openTab', paneId, tab: seed(mint('tab')), index: 1 });
  ops.push(into(next, 0));
  return ops;
}
export function advanceDock(surface: DockSurface, kit: DockKit,
  plan: (layout: DockLayout, mint: (prefix: string) => string, seed: (id: string) => DockTab) => any[],
  seed: (id: string) => DockTab): DockSurface {
  let used = surface.minted;
  const mint = (prefix: string) => `${prefix}${++used}`;
  const ops = plan(surface.layout, mint, seed);
  if (!ops.length) return surface;
  const after = kit.replay(surface.layout, ops);
  const settled = kit.planSettle(after, mint, after.expanded ? seed : undefined);
  const result = kit.record(surface.history, surface.layout, [...ops, ...settled]);
  return { layout: result.state, history: result.history, minted: used };
}
export function inheritedDockTemplate(preferences: DockPreferences, sessionId: string, workspaceId?: string): DockTemplateId | undefined {
  return preferences.session[sessionId] ?? (workspaceId ? preferences.workspace[workspaceId] : undefined) ?? preferences.global;
}
export function readDockPreferences(raw: unknown): DockPreferences {
  const preferences: DockPreferences = { workspace: {}, session: {} };
  if (!object(raw)) return preferences;
  if (isDockTemplate(raw.global)) preferences.global = raw.global;
  for (const scope of ['workspace', 'session'] as const) if (object(raw[scope])) {
    for (const [key, value] of Object.entries(raw[scope])) if (key && isDockTemplate(value)) preferences[scope][key] = value;
  }
  return preferences;
}
