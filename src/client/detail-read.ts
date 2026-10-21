import type { ActionDraft, Data, DomainDefinition, Inspection, InspectionRead } from './types.js';
import { isRecord } from './types.js';
import { findAction } from './catalog.js';

/** A detail view may reread only its explicitly described, catalogued read action. */
export function resolveDetailRead(catalog: DomainDefinition[], item: Pick<Inspection, 'domain' | 'read'>): ActionDraft | undefined {
  if (!item.domain || !item.read) return undefined;
  const capabilities = catalog.find(domain => domain.id === item.domain)?.capabilities ?? [];
  const choices = item.read.choices.filter(action => capabilities.some(capability => capability.action === action && capability.mutating === false));
  if (!choices.length) return undefined;
  return {
    domain: item.domain,
    action: findAction(catalog, item.domain, choices),
    params: { ...item.read.params },
    ...(item.read.targetId === undefined ? {} : { id: item.read.targetId }),
  };
}

/** List, local search and file search expose distinct identities and read contracts. */
export function memoryReadDescriptor(item: Data, view: string): InspectionRead | undefined {
  if ((view === 'library' && (item.source === undefined || item.source === 'local-markdown')) || (view === 'search' && item.source === 'local-markdown')) {
    if (typeof item.id !== 'string' || !item.id) return undefined;
    return { choices: ['read', 'expand'], params: { id: item.id }, targetId: item.id };
  }
  if ((view === 'sources' && (item.source === undefined || item.source === 'file_memory')) || (view === 'search' && item.source === 'file_memory')) {
    if (typeof item.documentId !== 'string' || !item.documentId) return undefined;
    return {
      choices: ['file_read'],
      params: { documentId: item.documentId, ...(typeof item.sourceHash === 'string' && item.sourceHash ? { sourceHash: item.sourceHash } : {}) },
    };
  }
  return undefined;
}

const scopeLabels: Record<string, string> = { user: '个人', project: '项目', session: '会话', team: '团队', reusable: '可复用' };

/** Only a known scope kind belongs in the list; owner and project identifiers stay out. */
export function memoryScopeLabel(scope: unknown): string {
  const kind: unknown = isRecord(scope) ? scope.kind : scope;
  return typeof kind === 'string' && Object.hasOwn(scopeLabels, kind) ? scopeLabels[kind] : '范围未报告';
}
