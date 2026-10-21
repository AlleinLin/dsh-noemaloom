import { realpath, stat } from 'node:fs/promises';
import { SessionId } from '@deepseek-ai/dsh-session';
import { NexusError } from '../ports/contracts.js';
import type { HostContext } from './types.js';

export function nativeWorkspaces(ctx: HostContext) {
  const registry = ctx.get('workspaceRegistry');
  if (!registry?.list) throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '宿主工作区注册表不可用');
  return registry.list().map((workspace: any) => ({
    id: String(workspace.id), title: String(workspace.title), path: String(workspace.path),
    sessionIds: [...workspace.sessionIds] as string[],
  }));
}
export async function workspaceRootById(ctx: HostContext, workspaceId: string, signal: AbortSignal): Promise<string> {
  const workspace = nativeWorkspaces(ctx).find((item: any) => item.id === workspaceId);
  if (!workspace) throw new NexusError('NOT_FOUND', '所选原生工作区不存在');
  signal.throwIfAborted();
  try {
    const root = await realpath(workspace.path);
    if (!(await stat(root)).isDirectory()) throw new Error('not-directory');
    signal.throwIfAborted();
    return root;
  } catch {
    signal.throwIfAborted();
    throw new NexusError('INVALID_ARGUMENT', '所选工作区目录不可用');
  }
}

/** No transcript, private database or client-supplied filesystem root is used. */
export async function sessionWorkspaceRoot(ctx: HostContext, sessionId: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const live = ctx.get('sessions')?.get?.(SessionId(sessionId));
  let header = live?.header;
  if (!header) {
    const query = ctx.get('sessionQuery');
    if (typeof query?.listSessions !== 'function') throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '宿主会话元数据服务不可用');
    const records = await query.listSessions(signal);
    signal.throwIfAborted();
    header = records.find((record: any) => record.header?.id === sessionId)?.header;
  }
  if (header?.id !== sessionId) throw new NexusError('NOT_FOUND', '所选原生会话不存在');
  if (typeof header.cwd !== 'string' || !header.cwd.trim()) throw new NexusError('INVALID_WORKSPACE', '所选原生会话没有工作目录');
  try {
    const root = await realpath(header.cwd);
    if (!(await stat(root)).isDirectory()) throw new Error('not-directory');
    signal.throwIfAborted();
    return root;
  } catch (error) {
    signal.throwIfAborted();
    throw new NexusError('INVALID_WORKSPACE', '所选原生会话的工作目录不可用');
  }
}

interface TitleQuery {
  readTitleSnapshots?(ids: string[], signal: AbortSignal): Promise<PromiseSettledResult<{ session: { id: string }; title?: { title: string } }>[]>;
  readTitle?(id: string, signal: AbortSignal): Promise<{ title: string } | undefined>;
}
/** A damaged/legacy title must not hide all other native sessions. */
export async function sessionTitles(query: TitleQuery, ids: string[], signal: AbortSignal): Promise<Map<string, { title?: string; titleStatus: string }>> {
  signal.throwIfAborted();
  const unique = [...new Set(ids)];
  const result = new Map<string, { title?: string; titleStatus: string }>();
  if (!unique.length) return result;
  const titles = query.readTitleSnapshots
    ? await query.readTitleSnapshots(unique, signal)
    : await Promise.all(unique.map(async id => {
      try { return { status: 'fulfilled' as const, value: { session: { id }, title: await query.readTitle?.(id, signal) } }; }
      catch (reason) { return { status: 'rejected' as const, reason }; }
    }));
  signal.throwIfAborted();
  for (const [index, id] of unique.entries()) {
    const record = titles[index];
    if (record?.status === 'fulfilled' && record.value.session.id === id) {
      const title = record.value.title?.title;
      result.set(id, { ...(typeof title === 'string' ? { title } : {}), titleStatus: typeof title === 'string' ? 'available' : 'untitled' });
    } else result.set(id, { titleStatus: 'unavailable' });
  }
  return result;
}
