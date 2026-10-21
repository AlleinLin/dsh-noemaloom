import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NexusError, type NexusModule, type NexusServices, type DispatchContext } from '../../ports/contracts.js';
import { workspaceStore, workspaceIdentity } from '../workspace-runtime.js';
import { workspacePath } from '../files/paths.js';
import { launchConfigurations, resolveLaunch } from '../../host/debug/configuration.js';
import type { DebugBreakpoint, DebugScope } from '../../shared/debug.js';

const actions = ['configurations', 'breakpoints', 'breakpoints.set', 'start', 'snapshot', 'request', 'stop', 'draft.get', 'draft.put', 'draft.remove', 'vscode'];
const mutations = new Set(['breakpoints.set', 'start', 'request', 'stop', 'draft.put', 'draft.remove']);
const key = (path: string) => createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex');
export function createDebugModule(services: NexusServices): NexusModule {
  const locks = new Map<string, Promise<unknown>>();
  async function serialize<T>(root: string, action: () => Promise<T>): Promise<T> {
    const next = (locks.get(root) ?? Promise.resolve()).catch(() => {}).then(action);
    locks.set(root, next); try { return await next; } finally { if (locks.get(root) === next) locks.delete(root); }
  }
  const owner = (context: DispatchContext | undefined) => {
    if (context?.actorId !== 'connection-owner') throw new NexusError('PERMISSION_DENIED', '编辑器调试与草稿仅由已认证用户操作');
  };
  return {
    id: 'debug',
    capabilities: actions.map(action => ({ action, description: `Native editor ${action}`, mutating: mutations.has(action) })),
    async dispatch(request, context) {
      owner(context);
      const params = request.params ?? {};
      const root = await realpath(context?.workspaceRoot ?? services.workspaceRoot);
      const store = workspaceStore(services.store, root);
      const file = typeof params.path === 'string' ? await workspacePath(root, params.path) : undefined;
      const session = (): DebugScope => {
        if (!context?.sessionId || context.scopeLevel === 'global') throw new NexusError('INVALID_ARGUMENT', '调试运行需要原生会话');
        return { sessionId: context.sessionId, workspaceRoot: root };
      };
      if (request.action === 'configurations') {
        const configurations = await launchConfigurations({ sessionId: context?.sessionId ?? '', workspaceRoot: root }, file);
        // Only labels and support state leave the host. Environment expansion stays in start().
        return { configurations: configurations.map((item, index) => ({ index, name: String(item.name ?? `Configuration ${index + 1}`).slice(0, 256),
          type: String(item.type ?? '').slice(0, 128), request: item.request ?? 'launch', supported: item.supported !== false })) };
      }
      if (request.action === 'vscode') {
        const path = file ?? root;
        return { url: `vscode://file/${path.replaceAll('\\', '/').split('/').map(part => encodeURIComponent(part).replace(/%3A/gi, ':')).join('/')}` };
      }
      if (request.action === 'breakpoints') {
        return { items: (await store.list<any>('editor-breakpoints')).map(row => row.value).filter(value => value.breakpoints?.length) };
      }
      if (request.action === 'breakpoints.set') {
        return serialize(`${root}\0breakpoints`, async () => {
          if (!file) throw new NexusError('INVALID_ARGUMENT', '断点需要文件');
          const points = validateBreakpoints(params.breakpoints);
          const rows = await store.list('editor-breakpoints');
          if (rows.filter(row => (row.value as any).breakpoints?.length).length >= 500 && !rows.some(row => row.id === key(file))) throw new NexusError('RESOURCE_LIMIT', '工作区断点文件上限为500');
          const row = await store.get('editor-breakpoints', key(file));
          if (points.length) await store.put('editor-breakpoints', key(file), { path: file, breakpoints: points }, row?.revision ?? 0);
          else if (row) await store.put('editor-breakpoints', key(file), { path: file, breakpoints: [] }, row.revision);
          const result = context?.sessionId ? await services.debug?.breakpoints(session(), file, points) : undefined;
          return result ?? { breakpoints: points.map(point => ({ ...point, verified: false })) };
        });
      }
      if (request.action.startsWith('draft.')) {
        if (!file) throw new NexusError('INVALID_ARGUMENT', '草稿需要文件');
        const id = key(file), row = await store.get<any>('editor-drafts', id);
        if (request.action === 'draft.get') return { workspace: workspaceIdentity(root), file, draftRevision: row?.revision ?? 0,
          draft: row && row.value.active !== false ? { ...row.value, revision: row.revision } : null };
        return serialize(root, async () => {
          const current = await store.get<any>('editor-drafts', id);
          if (request.action === 'draft.remove') {
            const removed = current ? await store.put('editor-drafts', id, { active: false }, request.expectedRevision ?? current.revision) : undefined;
            return { removed: true, revision: removed?.revision ?? 0 };
          }
          if (request.action !== 'draft.put') throw new NexusError('NOT_FOUND', '草稿操作不存在');
          if (typeof params.content !== 'string' || Buffer.byteLength(params.content) > 512 * 1024 || typeof params.baseHash !== 'string' || !/^[a-f0-9]{64}$/.test(params.baseHash)) throw new NexusError('RESOURCE_LIMIT', '草稿必须是512 KiB以内的文本与有效基础hash');
          const rows = (await store.list<any>('editor-drafts')).filter(row => row.value.active !== false);
          const bytes = rows.filter(row => row.id !== id).reduce((sum, row) => sum + Buffer.byteLength(String(row.value.content ?? '')), 0);
          if ((!current || current.value.active === false) && rows.length >= 32 || bytes + Buffer.byteLength(params.content) > 8 * 1024 * 1024) throw new NexusError('RESOURCE_LIMIT', '工作区草稿已达32份或8 MiB，请保存或显式丢弃后继续');
          const saved = await store.put('editor-drafts', id, { path: file, content: params.content, baseHash: params.baseHash,
            encoding: String(params.encoding ?? 'utf8'), updatedAt: new Date().toISOString() }, request.expectedRevision ?? 0);
          return { revision: saved.revision };
        });
      }
      if (!services.debug) throw new NexusError('DEPENDENCY_MISSING', '调试运行服务未启用');
      if (request.action === 'start') {
        const scope = session(), configurations = await launchConfigurations(scope, file);
        if (!Number.isInteger(params.index) || Number(params.index) < 0 || Number(params.index) >= configurations.length) throw new NexusError('INVALID_ARGUMENT', '请选择有效调试配置');
        const selected = configurations[Number(params.index)];
        // SDK choices are executable paths, never command strings or arbitrary launch overrides.
        for (const name of ['pythonPath', 'javacPath', 'javaPath', 'dotnetPath']) {
          if (params[name] !== undefined) {
            if (typeof params[name] !== 'string' || !params[name] || params[name].includes('\0') || params[name].length > 32700) throw new NexusError('INVALID_ARGUMENT', 'SDK executable path is invalid');
            selected[name] = params[name];
          }
        }
        const launch = await resolveLaunch(selected, scope, file);
        const breakpoints = Object.fromEntries((await store.list<any>('editor-breakpoints')).map(row => [row.value.path, row.value.breakpoints]));
        return services.debug.start(scope, launch, breakpoints);
      }
      if (request.action === 'snapshot') return services.debug.snapshot(session(), Math.max(0, Number(params.cursor) || 0));
      if (request.action === 'request') return services.debug.request(session(), String(params.command), params.arguments ?? {}, params.generation as number | undefined);
      if (request.action === 'stop') return services.debug.stop(session());
      throw new NexusError('NOT_FOUND', '编辑器调试动作不存在');
    },
  };
}
export function validateBreakpoints(value: unknown): DebugBreakpoint[] {
  if (!Array.isArray(value) || value.length > 200) throw new NexusError('RESOURCE_LIMIT', '每个文件最多200个断点');
  const lines = new Set<number>();
  return value.map(item => {
    if (!item || !Number.isInteger(item.line) || item.line < 1 || item.line > 1000000 || lines.has(item.line)) throw new NexusError('INVALID_ARGUMENT', '断点行号无效或重复');
    lines.add(item.line);
    const point: DebugBreakpoint = { line: item.line };
    if (item.column !== undefined) {
      if (!Number.isInteger(item.column) || item.column < 1 || item.column > 100000) throw new NexusError('INVALID_ARGUMENT', '断点列号无效');
      point.column = item.column;
    }
    for (const field of ['condition', 'hitCondition', 'logMessage'] as const) {
      if (item[field] !== undefined) {
        if (typeof item[field] !== 'string' || item[field].length > 4096) throw new NexusError('INVALID_ARGUMENT', '断点表达式超出上限');
        point[field] = item[field];
      }
    }
    return point;
  });
}
