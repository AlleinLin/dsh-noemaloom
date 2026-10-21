import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DispatchContext, NexusModule, NexusServices, NexusStore, StoredRecord } from '../ports/contracts.js';
import { NexusError } from '../ports/contracts.js';

export const workspaceIdentity = (root: string) => createHash('sha256').update(process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)).digest('hex').slice(0, 24);
const inheritedCollections = new Set(['agent-experts', 'agent-teams', 'workflow-prompts', 'cli-adapters', 'cli-settings',
  'searchProviders', 'connections', 'preset-config', 'imported-presets']);
function legacyRoot(value: any): string | undefined {
  const root = value?.root ?? value?.workspaceRoot ?? value?.workspace ?? value?.scope;
  return typeof root === 'string' && /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(root) ? root : undefined;
}
/** Execution state is private to its tier. Templates inherit live; writes and
 * removals affect only the current tier, including inherited configurations. */
export function workspaceStore(base: NexusStore, root: string, sessionId?: string): NexusStore {
  const identity = workspaceIdentity(root), prefix = sessionId
    ? `ss_${identity}_${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}_` : `ws_${identity}_`;
  const parent = sessionId ? workspaceStore(base, root) : base;
  const owns = (row: StoredRecord<any>) => {
    if (row.value?.scopeLevel && row.value.scopeLevel !== (sessionId ? 'session' : 'workspace')) return false;
    const stored = legacyRoot(row.value);
    return stored !== undefined && workspaceIdentity(stored) === identity && (!sessionId || row.value.ownerSessionId === sessionId);
  };
  const legacy = async <T>(collection: string, id: string) => {
    const row = await base.get<T>(collection, id);
    return row && owns(row) ? row : undefined;
  };
  const visible = (row: StoredRecord<any> | undefined) => row && !row.value?.__scopeDeleted ? row : undefined;
  return {
    async get<T>(collection: string, id: string) {
      const current = await base.get<T>(`${prefix}${collection}`, id);
      if (current) return visible(current);
      return inheritedCollections.has(collection) ? parent.get<T>(collection, id) : legacy<T>(collection, id);
    },
    async list<T>(collection: string) {
      const current = await base.list<T>(`${prefix}${collection}`);
      const prior = inheritedCollections.has(collection) ? await parent.list<T>(collection) : (await base.list<T>(collection)).filter(owns);
      return [...new Map([...prior, ...current].map(row => [row.id, row])).values()].filter(row => visible(row));
    },
    async put<T>(collection: string, id: string, value: T, revision?: number) {
      const current = await base.get(`${prefix}${collection}`, id);
      if (!current) {
        const inherited = inheritedCollections.has(collection) ? await parent.get(collection, id) : await legacy(collection, id);
        if (revision !== undefined && revision !== (inherited?.revision ?? 0)) throw new NexusError('REVISION_CONFLICT', '继承配置已变更');
      }
      return base.put(`${prefix}${collection}`, id, value, current ? revision : 0);
    },
    async remove(collection, id, revision) {
      const current = await base.get(`${prefix}${collection}`, id);
      const inherited = inheritedCollections.has(collection) ? await parent.get(collection, id) : await legacy(collection, id);
      const effective = current ?? inherited;
      if (!effective) return false;
      if (revision !== undefined && revision !== effective.revision) throw new NexusError('REVISION_CONFLICT', '对象已变更');
      await base.put(`${prefix}${collection}`, id, { __scopeDeleted: true }, current?.revision ?? 0);
      return true;
    },
  };
}
type Factory = (services: NexusServices) => NexusModule;
export async function workspaceModules(base: NexusServices, factories: Factory[]): Promise<NexusModule[]> {
  const instances = new Map<string, Promise<{ modules: NexusModule[]; services: NexusServices }>>();
  const retired = new Set<number>();
  let disposed = false;
  const instance = async (root: string, ctx: DispatchContext = {}) => {
    if (disposed) throw new NexusError('DISPOSED', '范围服务已关闭');
    const canonical = await realpath(root);
    const level = ctx.scopeLevel ?? (ctx.sessionId ? 'session' : 'workspace');
    if (level === 'session' && !ctx.sessionId) throw new NexusError('INVALID_ARGUMENT', '会话范围缺少会话');
    const key = level === 'global' ? 'global' : `${workspaceIdentity(canonical)}${level === 'session' ? `_${createHash('sha256').update(ctx.sessionId!).digest('hex').slice(0, 24)}` : ''}`;
    let pending = instances.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => {
        const scoped: NexusServices = {
          ...base, workspaceRoot: canonical,
          dataDir: level === 'global' ? base.dataDir : join(base.dataDir, level === 'session' ? 'sessions' : 'workspaces', key),
          store: level === 'global' ? base.store : workspaceStore(base.store, canonical, level === 'session' ? ctx.sessionId : undefined),
          invoke: (domain, request, context) => base.invoke(domain, request, {
            sessionId: level === 'session' ? ctx.sessionId : undefined, ...context, scopeLevel: context?.scopeLevel ?? level,
            workspaceRoot: context?.workspaceRoot ?? canonical,
          }),
        };
        return { services: scoped, modules: factories.map(factory => factory(scoped)) };
      });
      instances.set(key, pending);
    }
    return pending;
  };
  const initial = await instance(base.workspaceRoot, { scopeLevel: 'global' });
  return initial.modules.map((module, index) => ({
    ...module,
    async dispatch(request, context: DispatchContext = {}) {
      if (retired.has(index)) throw new NexusError('DISPOSED', '功能已关闭');
      if (module.id === 'connections' && /^(?:native\.|remote\.(?:pair|devices|revoke)$)/.test(request.action)) return module.dispatch(request, context);
      const target = await instance(context.workspaceRoot ?? base.workspaceRoot, context);
      return target.modules[index].dispatch(request, { ...context, workspaceRoot: target.services.workspaceRoot });
    },
    async dispose() {
      if (retired.has(index)) return;
      retired.add(index);
      const outcomes = await Promise.allSettled([...instances.values()].map(async pending => (await pending).modules[index].dispose?.()));
      if (retired.size === factories.length) { disposed = true; instances.clear(); }
      if (outcomes.some(o => o.status === 'rejected')) throw new NexusError('INTERNAL', '部分范围资源未完成清理');
    },
  }));
}
