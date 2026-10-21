import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CanvasScope } from './canvas-scope.js';

export interface ThoughtdagOrigin {
  schemaVersion: 1;
  sessionId: string;
  scopeLevel: CanvasScope['level'];
  scopeId: string;
  /** Application lineage only: this session did not inherit the source log. */
  sourceSessionId?: string;
  workspaceId?: string;
  createdAt: number;
}

export interface ThoughtdagSessionHeader {
  id: string;
  cwd?: string;
  parentSession?: string;
  agentPreset?: string;
}

export interface ThoughtdagWorkspace {
  id: string;
  sessionIds: readonly string[];
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const fingerprint = (id: string): string => createHash('sha256').update(id).digest('hex');

function validateOrigin(value: unknown): ThoughtdagOrigin {
  const origin = value as ThoughtdagOrigin | undefined;
  if (!origin || origin.schemaVersion !== 1 || !nonempty(origin.sessionId) || !nonempty(origin.scopeId)
    || !['global', 'workspace', 'session'].includes(origin.scopeLevel)
    || !Number.isSafeInteger(origin.createdAt) || origin.createdAt < 0
    || (origin.sourceSessionId !== undefined && !nonempty(origin.sourceSessionId))
    || (origin.workspaceId !== undefined && !nonempty(origin.workspaceId))
    || (origin.scopeLevel === 'session' && origin.sourceSessionId !== origin.scopeId)
    || (origin.scopeLevel === 'global' && origin.scopeId !== 'global')
    || (origin.scopeLevel === 'workspace' && origin.workspaceId !== origin.scopeId)
    || origin.sessionId === origin.sourceSessionId) {
    throw new Error('ThoughtDAG 新会话来源记录无效');
  }
  return {
    schemaVersion: 1, sessionId: origin.sessionId, scopeLevel: origin.scopeLevel, scopeId: origin.scopeId,
    ...(origin.sourceSessionId === undefined ? {} : { sourceSessionId: origin.sourceSessionId }),
    ...(origin.workspaceId === undefined ? {} : { workspaceId: origin.workspaceId }),
    createdAt: origin.createdAt,
  };
}

/** Small immutable plugin metadata files; native headers and histories stay untouched. */
export class ThoughtdagOriginRepository {
  readonly directory: string;
  private generation = 0;
  private cached?: { expiresAt: number; origins: ThoughtdagOrigin[] };
  private pending?: { generation: number; promise: Promise<ThoughtdagOrigin[]> };

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  private location(sessionId: string): string {
    return join(this.directory, `${fingerprint(sessionId)}.json`);
  }

  async get(sessionId: string): Promise<ThoughtdagOrigin | undefined> {
    try {
      const bytes = await readFile(this.location(sessionId));
      if (bytes.length > 16_384) throw new Error('ThoughtDAG 新会话来源记录过大');
      const origin = validateOrigin(JSON.parse(bytes.toString('utf8')));
      if (origin.sessionId !== sessionId) throw new Error('ThoughtDAG 新会话来源标识不一致');
      return origin;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async list(): Promise<ThoughtdagOrigin[]> {
    const copy = (items: ThoughtdagOrigin[]) => items.map(item => ({ ...item }));
    if (this.cached && this.cached.expiresAt > performance.now()) return copy(this.cached.origins);
    if (this.pending?.generation === this.generation) return copy(await this.pending.promise);
    const generation = this.generation;
    const promise: Promise<ThoughtdagOrigin[]> = this.scan().then(origins => {
      if (generation === this.generation) this.cached = { expiresAt: performance.now() + 1_500, origins };
      return origins;
    }).finally(() => {
      if (this.pending?.promise === promise) this.pending = undefined;
    });
    this.pending = { generation, promise };
    return copy(await promise);
  }

  private async scan(): Promise<ThoughtdagOrigin[]> {
    let entries: string[];
    try { entries = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const result: ThoughtdagOrigin[] = [];
    for (const entry of entries.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
      const bytes = await readFile(join(this.directory, entry));
      if (bytes.length > 16_384) throw new Error('ThoughtDAG 新会话来源记录过大');
      const origin = validateOrigin(JSON.parse(bytes.toString('utf8')));
      if (`${fingerprint(origin.sessionId)}.json` !== entry) throw new Error('ThoughtDAG 新会话来源文件不一致');
      result.push(origin);
    }
    return result;
  }

  async record(value: ThoughtdagOrigin): Promise<void> {
    const origin = validateOrigin(value);
    const text = `${JSON.stringify(origin)}\n`;
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `.${fingerprint(origin.sessionId)}-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(text, 'utf8'); await file.sync(); }
      finally { await file.close(); }
      try {
        // Link publishes the complete file atomically and never overwrites an
        // independently committed origin for the same native session.
        await link(temporary, this.location(origin.sessionId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (JSON.stringify(await this.get(origin.sessionId)) !== JSON.stringify(origin)) {
          throw new Error('ThoughtDAG 新会话已存在其他来源记录');
        }
      }
      this.generation++;
      this.cached = undefined;
      this.pending = undefined;
    } finally {
      try { await unlink(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}

/** Resolve explicit native membership before considering native seed lineage. */
export function thoughtdagWorkspaceOf(sessionId: string, headers: readonly ThoughtdagSessionHeader[],
  workspaces: readonly ThoughtdagWorkspace[]): string | undefined {
  return workspaceLookup(headers, workspaces)(sessionId);
}

function workspaceLookup(headers: readonly ThoughtdagSessionHeader[], workspaces: readonly ThoughtdagWorkspace[]) {
  const byId = new Map(headers.map(header => [header.id, header]));
  const memberships = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const workspace of workspaces) for (const id of workspace.sessionIds) {
    if (memberships.has(id) && memberships.get(id) !== workspace.id) conflicts.add(id);
    memberships.set(id, workspace.id);
  }
  const resolved = new Map<string, string | undefined>();
  return (sessionId: string): string | undefined => {
    if (resolved.has(sessionId)) return resolved.get(sessionId);
    const seen = new Set<string>();
    let id: string | undefined = sessionId;
    let workspace: string | undefined;
    while (id && !seen.has(id)) {
      seen.add(id);
      if (conflicts.has(id)) throw new Error('原生会话同时属于多个工作区');
      if (memberships.has(id)) { workspace = memberships.get(id); break; }
      id = byId.get(id)?.parentSession;
    }
    resolved.set(sessionId, workspace);
    return workspace;
  };
}

/**
 * Adds application descendants without loading transcripts. Call alongside the
 * native descendant traversal until the scope set stops growing.
 */
export function expandThoughtdagOrigins(options: {
  sessionIds: Set<string>;
  headers: readonly ThoughtdagSessionHeader[];
  workspaces: readonly ThoughtdagWorkspace[];
  origins: readonly ThoughtdagOrigin[];
}): void {
  const { sessionIds, headers, workspaces, origins } = options;
  const existing = new Set(headers.map(header => header.id));
  const workspaceOf = workspaceLookup(headers, workspaces);
  let size: number;
  do {
    size = sessionIds.size;
    for (const origin of origins) {
      if (!origin.sourceSessionId || !sessionIds.has(origin.sourceSessionId)
        || !existing.has(origin.sessionId) || !existing.has(origin.sourceSessionId)) continue;
      const sourceWorkspace = workspaceOf(origin.sourceSessionId);
      const childWorkspace = workspaceOf(origin.sessionId);
      // Explicit moves override plugin lineage. An ungrouped child may still
      // follow its source; equal disk paths never establish workspace identity.
      if (childWorkspace && sourceWorkspace && childWorkspace !== sourceWorkspace) continue;
      if (childWorkspace && !sourceWorkspace && origin.workspaceId && childWorkspace !== origin.workspaceId) continue;
      sessionIds.add(origin.sessionId);
    }
  } while (size !== sessionIds.size);
}

export interface ThoughtdagSessionControllerOptions {
  currentScope(): CanvasScope;
  assertSession(sessionId: string): void;
  origins: ThoughtdagOriginRepository;
  headers(): Promise<readonly ThoughtdagSessionHeader[]>;
  workspaces(): readonly ThoughtdagWorkspace[];
  now?(): number;
}

/** Preserve the upstream fresh/continue/fork decision instead of converting create into fork. */
export function createThoughtdagSessionController<T extends object>(target: T, options: ThoughtdagSessionControllerOptions): T {
  return new Proxy(target, {
    get(controller: any, key) {
      const method = Reflect.get(controller, key);
      if (typeof method !== 'function') return method;
      if (key === 'create') return async (input: any = {}, ...rest: unknown[]) => {
        const scope = options.currentScope();
        const headers = await options.headers();
        const workspaces = options.workspaces();
        let workspaceId: string | undefined;
        let request: Record<string, unknown>;
        if (scope.level === 'workspace') {
          if (!workspaces.some(workspace => workspace.id === scope.id)) throw new Error('工作区不存在');
          workspaceId = scope.id;
          request = { workspaceId };
        } else if (scope.level === 'session') {
          const root = headers.find(header => header.id === scope.id);
          if (!root) throw new Error('会话不存在');
          workspaceId = thoughtdagWorkspaceOf(root.id, headers, workspaces);
          if (!workspaceId && !nonempty(root.cwd)) throw new Error('原生会话没有工作目录');
          request = {
            ...(workspaceId ? { workspaceId } : { cwd: root.cwd }),
            ...(root.agentPreset ? { agentPreset: root.agentPreset } : {}),
          };
        } else {
          workspaceId = nonempty(input.workspaceId) ? input.workspaceId : undefined;
          request = {
            ...(workspaceId ? { workspaceId } : nonempty(input.cwd) ? { cwd: input.cwd } : {}),
            ...(nonempty(input.agentPreset) ? { agentPreset: input.agentPreset } : {}),
          };
        }
        // No sessionId reuse: the graph's compiled context requires an empty log.
        const result = await method.call(controller, request, ...rest);
        if (!nonempty(result?.sessionId)) throw new Error('宿主没有返回图谱会话标识');
        await options.origins.record({
          schemaVersion: 1, sessionId: result.sessionId, scopeLevel: scope.level, scopeId: scope.id,
          ...(scope.level === 'session' ? { sourceSessionId: scope.id } : {}),
          ...(workspaceId ? { workspaceId } : {}), createdAt: (options.now ?? Date.now)(),
        });
        scope.sessionIds.add(result.sessionId);
        return result;
      };
      if (key === 'fork') return async (input: any = {}, ...rest: unknown[]) => {
        const scope = options.currentScope();
        options.assertSession(input.sessionId);
        const result = await method.call(controller, input, ...rest);
        if (!nonempty(result?.sessionId)) throw new Error('宿主没有返回图谱会话标识');
        scope.sessionIds.add(result.sessionId);
        return result;
      };
      return (input: any, ...rest: unknown[]) => {
        if (typeof input === 'string' && key === 'resolveAgent') options.assertSession(input);
        if (input?.sessionId) options.assertSession(input.sessionId);
        return method.call(controller, input, ...rest);
      };
    },
  });
}
