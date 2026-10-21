import type { Data, NexusApi, NexusScope } from './types.js';
import { isRecord } from './types.js';
import { ClientError, errorData } from './transport.js';
import { boundedRead } from '../shared/bounded-read.js';

export const AUXILIARY_READ_TIMEOUT_MS = 10000;
export type AuxiliaryReadKind = 'settings' | 'catalog' | 'workspaces';
export interface AuxiliaryReadDiagnostic {
  code: string;
  phase: string;
  elapsedMs: number;
  scope: NexusScope;
  traceId?: string;
  diagnosticCode?: string;
}
export interface AuxiliaryReadState {
  state: 'loading' | 'ready' | 'error';
  value?: Data;
  message?: string;
  diagnostic?: AuxiliaryReadDiagnostic;
}
const labels = { settings: '辅助设置', catalog: '辅助模型目录', workspaces: '辅助设置工作区' };
const plainScope = (scope: NexusScope): NexusScope => ({
  level: scope.level ?? 'global',
  ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
  ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
});
function checked(kind: AuxiliaryReadKind, value: unknown): Data {
  const invalid = () => new ClientError('nexus/auxiliary-invalid-response', `${labels[kind]}返回格式不兼容；请确认前端与宿主安装了同一版本 Nexus`);
  const routeValid = (route: unknown) => isRecord(route) && typeof route.provider === 'string' && !!route.provider.trim()
    && typeof route.model === 'string' && !!route.model.trim()
    && (route.reasoningEffort === undefined || typeof route.reasoningEffort === 'string');
  if (!isRecord(value)) throw invalid();
  if (kind === 'settings') {
    if (!Array.isArray(value.routes) || typeof value.enabled !== 'boolean' || !isRecord(value.effective)
      || !isRecord(value.local) || !isRecord(value.local.config) || !Number.isSafeInteger(value.local.revision) || value.local.revision < 0
      || (value.local.config.defaults !== undefined && !isRecord(value.local.config.defaults))
      || value.local.config.enabled !== undefined && typeof value.local.config.enabled !== 'boolean'
      || value.routes.some((route: unknown) => !routeValid(route))
      || value.local.config.defaults?.routes !== undefined && (!Array.isArray(value.local.config.defaults.routes)
        || value.local.config.defaults.routes.some((route: unknown) => !routeValid(route)))
      || value.legacySources !== undefined && (!Array.isArray(value.legacySources) || value.legacySources.some((item: unknown) => typeof item !== 'string'))) throw invalid();
  } else if (!Array.isArray(value.items)) throw invalid();
  else if (kind === 'catalog' && value.items.some((item: unknown) => !isRecord(item)
    || typeof item.provider !== 'string' || typeof item.model !== 'string' || typeof item.code !== 'string'
    || !Array.isArray(item.efforts) || item.efforts.some((effort: unknown) => typeof effort !== 'string')
    || typeof item.reasoningKnown !== 'boolean')) throw invalid();
  else if (kind === 'workspaces' && value.items.some((item: unknown) => !isRecord(item)
    || typeof (item.id ?? item.workspaceId) !== 'string'
    || item.sessionIds !== undefined && (!Array.isArray(item.sessionIds) || item.sessionIds.some((id: unknown) => typeof id !== 'string')))) throw invalid();
  return value;
}

/** Each page/scope owns a reader. Retries retire the previous request, and
 * cancellation prevents notifications even with an uncooperative RPC mock. */
export function createAuxiliarySettingsReader(api: NexusApi, kind: AuxiliaryReadKind, scope: NexusScope,
  timeoutMs = AUXILIARY_READ_TIMEOUT_MS) {
  const selected = plainScope(scope), listeners = new Set<() => void>();
  let state: AuxiliaryReadState = { state: 'loading' };
  let current: AbortController | undefined;
  let epoch = 0;
  const publish = (next: AuxiliaryReadState) => { state = next; for (const listener of listeners) listener(); };
  const cancel = () => { epoch++; current?.abort(); current = undefined; };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    cancel,
    async read(): Promise<Data | undefined> {
      cancel();
      const id = epoch, controller = new AbortController();
      current = controller;
      const startedAt = Date.now(), previous = state.value;
      publish({ state: 'loading', value: previous });
      try {
        const value = checked(kind, await boundedRead(signal =>
          api.call(kind === 'workspaces' ? 'scope' : 'companion', kind, {}, { scope: selected, signal }), {
          signal: controller.signal, timeoutMs,
          timeout: () => new ClientError(`nexus/auxiliary-${kind}-timeout`,
            `读取${labels[kind]}超过${timeoutMs / 1000}秒；请重试并查看读取诊断。若持续失败，请确认宿主连接与 Nexus 版本`),
          cancelled: () => new ClientError('nexus/cancelled', '读取已取消'),
        }));
        if (id !== epoch || controller.signal.aborted) return;
        publish({ state: 'ready', value });
        return value;
      } catch (cause) {
        if (id !== epoch || controller.signal.aborted) return;
        const error = errorData(cause), details = isRecord(error.details) ? error.details : {};
        const incompatible = /^(?:NOT_FOUND|HOST_CONTRACT_UNSUPPORTED|DEPENDENCY_MISSING)$/.test(error.code);
        const diagnostic: AuxiliaryReadDiagnostic = {
          code: error.code, phase: typeof details.phase === 'string' ? details.phase : `auxiliary-${kind}-read`,
          elapsedMs: Math.max(0, Date.now() - startedAt), scope: selected,
          ...(typeof details.traceId === 'string' ? { traceId: details.traceId } : {}),
          ...(typeof details.diagnosticCode === 'string' ? { diagnosticCode: details.diagnosticCode } : {}),
        };
        publish({ state: 'error', value: previous, diagnostic,
          message: `${error.message}${incompatible ? '；当前宿主缺少此读取接口或依赖，请确认前端与宿主安装了同一版本 Nexus' : ''}` });
      } finally {
        if (id === epoch) current = undefined;
      }
    },
  };
}

/** A support report deliberately excludes server messages and settings data. */
export function auxiliaryReadReport(state: AuxiliaryReadState, catalogState?: string): string {
  return JSON.stringify({ ...state.diagnostic, ...(catalogState ? { catalogState } : {}) }, null, 2);
}
