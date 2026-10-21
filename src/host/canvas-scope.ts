import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { HostContext } from './types.js';
import { nativeWorkspaces } from './session-metadata.js';
import { ThoughtdagOriginRepository, expandThoughtdagOrigins } from './thoughtdag-session-controller.js';

const originRepositories = new WeakMap<object, ThoughtdagOriginRepository>();
export function thoughtdagOrigins(ctx: HostContext): ThoughtdagOriginRepository {
  let repository = originRepositories.get(ctx);
  if (!repository) {
    repository = new ThoughtdagOriginRepository(join(ctx.get('profileContext').dir,
      'data', 'nexus', 'canvases', 'thoughtdag-origins'));
    originRepositories.set(ctx, repository);
  }
  return repository;
}

export interface CanvasScope {
  key: string;
  level: 'global' | 'workspace' | 'session';
  id: string;
  sessionIds: Set<string>;
}
/** Scope comes from native identities, never from a browser supplied disk path. */
export async function resolveCanvasScope(ctx: HostContext, url: URL): Promise<CanvasScope> {
  const level = url.searchParams.get('nexusLevel');
  const id = url.searchParams.get('nexusId') ?? '';
  if (!['global', 'workspace', 'session'].includes(level ?? '') || (level !== 'global' && !id)) {
    throw new Error('请选择图谱的全局、工作区或会话范围');
  }
  const records = await ctx.get('sessionQuery').listSessions();
  const headers = records.map((record: any) => record.header);
  const workspaces = nativeWorkspaces(ctx);
  const explicitlyElsewhere = new Set<string>();
  let ids: Set<string>;
  if (level === 'global') {
    if (id !== 'global') throw new Error('全局范围标识无效');
    ids = new Set(headers.map((header: any) => header.id));
  } else if (level === 'workspace') {
    const workspace = workspaces.find((row: any) => row.id === id);
    if (!workspace) throw new Error('工作区不存在');
    for (const other of workspaces) if (other.id !== id) {
      for (const sessionId of other.sessionIds) explicitlyElsewhere.add(sessionId);
    }
    ids = new Set(workspace.sessionIds);
  } else {
    if (!headers.some((header: any) => header.id === id)) throw new Error('会话不存在');
    ids = new Set([id]);
  }
  if (level !== 'global') {
    const origins = await thoughtdagOrigins(ctx).list();
    // Descendant sessions remain part of their parent's analysis surface.
    let size: number;
    do {
      size = ids.size;
      for (const header of headers) if (ids.has(header.parentSession)
        && (level !== 'workspace' || !explicitlyElsewhere.has(header.id))) ids.add(header.id);
      expandThoughtdagOrigins({ sessionIds: ids, headers, workspaces, origins });
      if (level === 'workspace') for (const sessionId of explicitlyElsewhere) ids.delete(sessionId);
    } while (size !== ids.size);
  }
  return {
    level: level as CanvasScope['level'], id, sessionIds: ids,
    key: createHash('sha256').update(`${level}\0${id}`).digest('hex'),
  };
}
