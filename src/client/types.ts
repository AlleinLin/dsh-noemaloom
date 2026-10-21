import type { ReactNode } from 'react';
import { localizedText, type LocalizedText } from './localized-text.js';

export type Data = Record<string, any>;
export interface ActionDefinition {
  action: string;
  description: LocalizedText;
  mutating?: boolean;
  permission?: string;
  schema?: Data;
}
export interface DomainDefinition { id: string; capabilities: ActionDefinition[] }
export interface ClientContext {
  connection: {
    rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<any> };
    generation?: { getSnapshot(): { id: number } | undefined; subscribe(listener: () => void): () => void };
    state?: { getSnapshot(): string | undefined; subscribe(listener: () => void): () => void };
    reconnect?(): void;
  };
  slots: {
    inject(name: string, callback: (...args: any[]) => any): any;
    register(options: Data, component: any): (() => void) | any;
    entries?(name: string): any[];
  };
  layout?: { selectPanel(key: string | null): void; toggleSidebar?(): void };
  uiWorkspace?: {
    selection: SnapshotSource<{ sessionId?: string; subagentAddress?: unknown }>;
    openSession(sessionId: string): void;
    startSession(workspaceId?: string, options?: { prompt?: string; clearPreviousDraft?: boolean; agentPreset?: string }): void;
  };
  locale?: { register?: (...args: any[]) => (() => void); bind?(name: string): (key: string) => string; addLanguage?(registration: Data): () => void; language?: any };
  effect(effect: () => any, label?: string): any;
  on?(event: string, listener: (...args: any[]) => any): () => void;
  inject?(dependencies: string[], callback: (ctx: ClientContext) => any): any;
  get?(name: string): any;
}
export interface SnapshotSource<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
export interface NexusScope { level?: 'global' | 'workspace' | 'session'; sessionId?: string; workspaceId?: string }
export interface RpcOptions { signal?: AbortSignal; revision?: number; id?: string; scope?: NexusScope; mutating?: boolean; requestId?: string }
export interface NexusApi {
  call<T = any>(domain: string, action: string, params?: Data, options?: RpcOptions): Promise<T>;
  probe(signal?: AbortSignal): Promise<Data>;
  snapshot(signal?: AbortSignal): Promise<Data>;
  subscribe(listener: () => void): () => void;
  getGeneration(): number;
  reset(): void;
  dispose(): void;
}
export interface Notice { id: string; title: string; message?: string; kind: 'success' | 'error' | 'info'; at: string; details?: unknown }
export interface InspectionRead { choices: string[]; params: Data; targetId?: string }
export interface Inspection { title: string; kind?: string; data: unknown; domain?: string; id?: string; revision?: number; body?: ReactNode; read?: InspectionRead }
export interface ActionDraft { domain: string; action: string; params?: Data; id?: string; revision?: number; title?: string }
export interface ViewContext {
  api: NexusApi;
  host?: ClientContext;
  catalog: DomainDefinition[];
  probe: Data;
  scope: NexusScope;
  inspect(item: Inspection): void;
  action(item: ActionDraft): void;
  notify(title: string, kind?: Notice['kind'], message?: string, details?: unknown): void;
  navigate(page: PageId): void;
  openNativeSession(sessionId: string): void;
  refreshToken: number;
  reading?: boolean;
}
export type PageId = 'home' | 'sessions' | 'tasks' | 'orchestration' | 'engineering' | 'memory' | 'knowledge' | 'graph' | 'context' | 'cache' | 'quality' | 'review' | 'recovery' | 'resources' | 'extensions' | 'connections' | 'usage' | 'search' | 'settings';
export const isRecord = (value: unknown): value is Data => value !== null && typeof value === 'object' && !Array.isArray(value);
export function unwrap(value: any): any {
  return isRecord(value) && 'value' in value && ('revision' in value || 'updatedAt' in value) ? { ...value.value, id: value.id ?? value.value?.id, revision: value.revision, updatedAt: value.updatedAt } : value;
}
export function rows(value: any): Data[] {
  if (Array.isArray(value)) return value.map(unwrap).filter(isRecord);
  if (!isRecord(value)) return [];
  if (Array.isArray(value.builtin) || Array.isArray(value.saved)) return [...(value.builtin ?? []), ...(value.saved ?? [])].map(unwrap).filter(isRecord);
  if (Array.isArray(value.imported) && Array.isArray(value.items)) return [...value.items, ...value.imported].map(unwrap).filter(isRecord);
  for (const key of ['items', 'records', 'results', 'entries', 'sessions', 'tasks', 'runs', 'plans', 'nodes', 'connections', 'accounts', 'files', 'documents', 'matches', 'data', 'models', 'resources', 'candidates', 'devices', 'snapshots', 'checkpoints', 'blocks', 'requests', 'jobs', 'blueprints', 'experts', 'findings', 'engines']) {
    if (Array.isArray(value[key])) return value[key].map(unwrap).filter(isRecord);
  }
  return [];
}
export const titleOf = (item: Data, locale?: string) => localizedText(item.title ?? item.name ?? item.label ?? item.goal ?? item.content ?? item.path ?? item.model ?? item.action ?? item.header?.title ?? item.header?.meta?.title ?? item.id, locale, localizedText(item.id, locale, '未命名'));
export const idOf = (item: Data) => String(item.id ?? item.runId ?? item.sessionId ?? item.planId ?? item.path ?? '');
export const textOf = (value: any): string => value === undefined || value === null ? '未报告' : typeof value === 'object' ? JSON.stringify(value) : String(value);
export function sessionTranscript(snapshot: Data): Data[] {
  if (Array.isArray(snapshot.messages)) return snapshot.messages.filter(isRecord);
  // Durable append/patch/replace events must be folded by the host projection.
  return [];
}
