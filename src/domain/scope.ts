import { NexusError, type DispatchContext, type JsonRecord, type NexusModule, type NexusServices, type NexusStore } from '../ports/contracts.js';
import { workspaceIdentity } from './workspace-runtime.js';
import { boundedRead } from '../shared/bounded-read.js';

export type ScopeLevel = 'global' | 'workspace' | 'session';
export const scopeLevel = (ctx?: DispatchContext): ScopeLevel => ctx?.scopeLevel ?? (ctx?.sessionId ? 'session' : 'workspace');
export function scopeKeys(root: string, ctx?: DispatchContext): string[] {
  const level = scopeLevel(ctx), keys = ['global'];
  if (level !== 'global') keys.push(`workspace:${workspaceIdentity(root)}`);
  if (level === 'session') {
    if (!ctx?.sessionId) throw new NexusError('INVALID_ARGUMENT', '会话范围需要原生会话');
    keys.push(`session:${workspaceIdentity(root)}:${ctx.sessionId}`);
  }
  return keys;
}
function merge(base: JsonRecord, patch: JsonRecord): JsonRecord {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new NexusError('INVALID_ARGUMENT', '配置键无效');
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]) ? out[key] as JsonRecord : {}, value as JsonRecord) : value;
  }
  return out;
}
export async function effectiveSettings(store: NexusStore, root: string, ctx: DispatchContext | undefined, feature: string) {
  let effective: JsonRecord = { enabled: true, defaults: {} };
  const layers: Array<{ scope: string; revision: number; config: JsonRecord }> = [];
  for (const key of scopeKeys(root, ctx)) {
    const row = await store.get<JsonRecord>('scope-settings', `${key}/${feature}`);
    layers.push({ scope: key.split(':')[0], revision: row?.revision ?? 0, config: row?.value ?? {} });
    if (row) effective = merge(effective, row.value);
  }
  return { effective, layers, local: layers.at(-1)!, inherited: layers.slice(0, -1) };
}
/** Settings are live overlays. Reading a parent never copies it into a child. */
export function createScopeModule(services: NexusServices): NexusModule {
  return {
    id: 'scope',
    capabilities: [
      { action: 'workspaces', description: '列出宿主原生工作区及会话身份，不读取会话正文。' },
      { action: 'storage.integrity', description: '由用户手动执行独立只读 SQLite 完整性检查；重复请求复用进行中的检查。' },
      { action: 'storage.integrity.cancel', description: '仅取消当前手动完整性检查，不中断主任务或存储写入。' },
      { action: 'overview', description: '汇总原生工作区及会话的本地功能记录；失败单独返回，不执行写入或模型调用。' },
      { action: 'settings', description: '读取功能在全局→工作区→会话的有效配置与各层修订。' },
      { action: 'configure', description: '仅修改当前层配置；defaults 为该层动作默认参数。', mutating: true },
      { action: 'reset', description: '清除当前层覆盖，立即恢复继承父级配置。', mutating: true },
    ],
    async dispatch(request, ctx) {
      if (['storage.integrity', 'storage.integrity.cancel'].includes(request.action)) {
        if (ctx?.actorId !== 'connection-owner' || ctx.scopeLevel !== 'global') throw new NexusError('PERMISSION_DENIED', '完整性检查仅可由用户在全局诊断入口执行');
        const method = request.action === 'storage.integrity' ? services.store.checkIntegrity : services.store.cancelIntegrityCheck;
        if (!method) throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '当前存储不支持独立完整性检查');
        // Bound only this RPC waiter. The store retains single-flight scan
        // ownership after disconnect/deadline, and closes its own worker later.
        return boundedRead(() => method.call(services.store), {
          signal: ctx.signal, timeoutMs: 15000,
          timeout: () => new NexusError('STORAGE_INTEGRITY_PENDING', '手动检查尚未返回结果；再次读取会复用当前检查，也可手动取消'),
          cancelled: () => new NexusError('CANCELLED', '已停止等待手动检查结果；检查仍由存储实例管理'),
        });
      }
      if (request.action === 'workspaces') return services.host.sessions('scope.workspaces', {});
      if (request.action === 'overview') {
        if (ctx?.scopeLevel !== 'global') throw new NexusError('PERMISSION_DENIED', '跨工作区汇总请使用全局入口');
        const feature = String(request.params?.feature ?? '');
        const actions: Record<string, [string, string]> = {
          engineering: ['runtime', 'jobs.list'], tasks: ['workflow', 'todo/list'],
          orchestration: ['workflow', 'plans/list'], memory: ['memory', 'list'], knowledge: ['artifact', 'list'],
          graph: ['graph', 'list'], context: ['context', 'overview'], cache: ['usage', 'summary'],
          quality: ['quality', 'status'], review: ['review', 'status'], recovery: ['recovery', 'list'],
          resources: ['artifact', 'list'], usage: ['usage', 'summary'], connections: ['connections', 'list'],
          extensions: ['presets', 'list'], search: ['graph', 'list'], autonomy: ['autonomy', 'list'],
        };
        const query = actions[feature];
        if (!query) throw new NexusError('INVALID_ARGUMENT', '功能不存在');
        const source = await services.host.sessions('scope.workspaces', {}) as { items: Array<{ id: string; title: string; path: string; sessionIds: string[] }> };
        const items = [];
        for (const workspace of source.items) {
          ctx?.signal?.throwIfAborted();
          const targets: DispatchContext[] = [{ scopeLevel: 'workspace', workspaceRoot: workspace.path, workspaceId: workspace.id },
            ...workspace.sessionIds.map(sessionId => ({ scopeLevel: 'session' as const, workspaceRoot: workspace.path, workspaceId: workspace.id, sessionId }))];
          const counts = [];
          for (const target of targets) {
            try {
              const value: any = await services.invoke(query[0], { action: query[1], limit: 100, params: { limit: 100 } }, { ...ctx, ...target, sessionId: target.sessionId });
              const list = Array.isArray(value) ? value : value.items ?? value.sessions ?? value.records ?? value.runs ?? [];
              counts.push({ level: target.scopeLevel, sessionId: target.sessionId, count: value.total ?? value.count ?? value.attempts ?? list.length, state: 'available',
                ...(request.params?.includeRecords === true ? { items: list.slice(0, 100),
                  truncated: list.length > 100 || Boolean(value.nextCursor ?? value.page?.nextCursor ?? value.truncated) } : {}) });
            } catch (error) {
              ctx?.signal?.throwIfAborted();
              counts.push({ level: target.scopeLevel, sessionId: target.sessionId, count: null, state: 'unavailable',
                code: error instanceof NexusError ? error.code : 'INTERNAL' });
            }
          }
          items.push({ ...workspace, counts });
        }
        return { feature, items };
      }
      const feature = String(request.params?.feature ?? '');
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(feature)) throw new NexusError('INVALID_ARGUMENT', '请选择功能');
      if (feature === 'autonomy' && ['configure', 'reset'].includes(request.action)
        && (ctx?.actorId !== 'connection-owner' || !ctx.permissions?.has(`scope.${request.action}`))) {
        throw new NexusError('PERMISSION_DENIED', '自主规划设置仅由用户在对应范围修改');
      }
      const root = ctx?.workspaceRoot ?? services.workspaceRoot;
      if (feature === 'auxiliary' && ['configure', 'reset'].includes(request.action)
        && (ctx?.actorId !== 'connection-owner' || !ctx.permissions?.has(`scope.${request.action}`))) {
        throw new NexusError('PERMISSION_DENIED', '辅助模型设置仅由用户在对应范围修改');
      }
      const key = `${scopeKeys(root, ctx).at(-1)}/${feature}`;
      if (request.action === 'configure') {
        const config = request.params?.config as JsonRecord;
        if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(k => !['enabled', 'defaults'].includes(k))
          || config.enabled !== undefined && typeof config.enabled !== 'boolean'
          || config.defaults !== undefined && (!config.defaults || typeof config.defaults !== 'object' || Array.isArray(config.defaults))) throw new NexusError('INVALID_ARGUMENT', '配置格式无效');
        merge({}, config);
        if (feature === 'auxiliary') {
          const { auxiliarySettings, validateAuxiliaryConfig } = await import('./insights/auxiliary.js');
          // An unavailable directory must not force users to delete saved
          // priorities just to change a toggle, reorder or remove a route.
          const saved = await auxiliarySettings(services, ctx);
          await validateAuxiliaryConfig(services, config, { preservedRoutes: saved.routes, signal: ctx?.signal });
        }
        if (['insights', 'autonomy'].includes(feature)) {
          const defaults = config.defaults as JsonRecord | undefined;
          if (typeof defaults?.provider === 'string' || typeof defaults?.model === 'string') {
            await (await import('./insights/auxiliary.js')).validateAuxiliaryConfig(services, {
              defaults: { routes: [{ provider: defaults?.provider, model: defaults?.model,
                ...(defaults?.reasoningEffort === undefined ? {} : { reasoningEffort: defaults.reasoningEffort }) }] },
            });
          }
        }
        await services.store.put('scope-settings', key, config, request.expectedRevision ?? 0);
      } else if (request.action === 'reset') {
        await services.store.remove('scope-settings', key, request.expectedRevision ?? 0);
      } else if (request.action !== 'settings') throw new NexusError('NOT_FOUND', '范围动作不存在');
      if (['autonomy', 'auxiliary'].includes(feature) && request.action !== 'settings') {
        services.emit('scope/updated', { feature, level: scopeLevel(ctx),
          workspace: workspaceIdentity(root), sessionId: ctx?.sessionId });
      }
      return effectiveSettings(services.store, root, ctx, feature);
    },
  };
}
export function withScopePolicy(module: NexusModule, services: NexusServices): NexusModule {
  return { ...module, async dispatch(request, ctx) {
    // Native transactions must always be able to settle and clean up.
    if (request.action.startsWith('native/') || ctx?.actorId?.startsWith('native-') || request.action === 'prompt/on-turn') return module.dispatch(request, ctx);
    const config = await effectiveSettings(services.store, ctx?.workspaceRoot ?? services.workspaceRoot, ctx, module.id);
    if (config.effective.enabled === false
      && !(module.id === 'autonomy' && ['settings', 'get', 'list', 'pause', 'reconcile'].includes(request.action))) {
      throw new NexusError('PERMISSION_DENIED', '此范围已停用该功能');
    }
    const defaults = config.effective.defaults as JsonRecord;
    const actionDefaults = defaults?.[request.action];
    if (ctx?.scopeLevel === 'global' && ['files', 'runtime'].includes(module.id) &&
      module.capabilities.find(c => c.action === request.action)?.mutating) throw new NexusError('PERMISSION_DENIED', '请选择工作区或会话执行');
    if (ctx?.scopeLevel === 'global' && module.id === 'memory' && ['sources', 'handoff', 'file_read', 'file_refresh', 'file_writeback'].includes(request.action)) throw new NexusError('PERMISSION_DENIED', '请选择工作区文件来源');
    if (ctx?.scopeLevel && ctx.scopeLevel !== 'global' && module.id === 'extensions' && module.capabilities.find(c => c.action === request.action)?.mutating) throw new NexusError('PERMISSION_DENIED', '安装与生命周期操作请使用全局入口；本层开关在本层配置中设置');
    if (ctx?.scopeLevel && ctx.scopeLevel !== 'global' && module.id === 'resources' && /^themes\.(?:apply|preview)$/.test(request.action)) throw new NexusError('PERMISSION_DENIED', '外观为全局设置，请在 DSH 设置中修改');
    return module.dispatch({ ...request, params: {
      ...(actionDefaults && typeof actionDefaults === 'object' && !Array.isArray(actionDefaults) ? actionDefaults as JsonRecord : {}), ...request.params,
    } }, ctx);
  } };
}
