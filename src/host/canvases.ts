import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { resolveCanvasScope, thoughtdagOrigins, type CanvasScope } from './canvas-scope.js';
import { createCanvasOriginalState } from './canvas-original-state.js';
import { nativeWorkspaces, sessionTitles } from './session-metadata.js';
import { CanvasArchiveCache } from './canvas-archive-cache.js';
import { createThoughtdagSessionController } from './thoughtdag-session-controller.js';

const requestScope = new AsyncLocalStorage<CanvasScope>();
const assetRoot = dirname(fileURLToPath(import.meta.url));
const json = (res: any, status: number, data: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};
const active = (): CanvasScope => {
  const value = requestScope.getStore();
  if (!value) throw new Error('图谱请求缺少作用范围');
  return value;
};
const allowed = (id: string) => active().sessionIds.has(String(id));
const assertSession = (id: string) => { if (!allowed(id)) throw new Error('会话不属于当前图谱范围'); };
const archiveCaches = new WeakMap<object, CanvasArchiveCache<any>>();

function scopedSessions(ctx: any) {
  return new Proxy(ctx.sessions, { get(target, key) {
    if (key === 'list') return () => target.list().filter((session: any) => allowed(session.id));
    if (key === 'get' || key === 'sessionOf') return (id: string) => allowed(id) ? target[key](id) : undefined;
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

function decorateHtml(res: any) {
  const end = res.end.bind(res);
  let html = false;
  const writeHead = res.writeHead.bind(res);
  res.writeHead = (status: number, headers: any, ...rest: any[]) => {
    html = String(headers?.['content-type'] ?? res.getHeader?.('content-type') ?? '').includes('text/html');
    if (html) {
      headers = headers && { ...headers };
      if (headers) for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-length') delete headers[key];
      res.removeHeader?.('content-length');
    }
    return writeHead(status, headers, ...rest);
  };
  res.end = (body: any, ...args: any[]) => {
    if (html && (typeof body === 'string' || Buffer.isBuffer(body))) {
      const text = body.toString();
      body = text.replace('<head>', '<head><script src="/nexus/canvas-bootstrap.js"></script>')
        .replace('</head>', '<link rel="stylesheet" href="/nexus/canvas-theme.css"></head>');
    }
    return end(body, ...args);
  };
}

interface CanvasAsset { body: Buffer; type: string; etag: string }
function scopedWebServer(ctx: any, kind: 'thoughtdag' | 'synapse',
  prepare?: (scope: CanvasScope) => Promise<() => Promise<void>>, assets = new Map<string, CanvasAsset>()) {
  return {
    register(route: any) {
      const handler = route.handler;
      return ctx.webServer.register({ ...route, handler: async (req: any, res: any) => {
        const url = new URL(req.url ?? '/', 'http://dsh.local');
        const isApi = url.pathname === `/${kind}/api` || url.pathname.startsWith(`/${kind}/api/`);
        if (!isApi) {
          decorateHtml(res);
          const asset = assets.get(url.pathname);
          if (asset) {
            const headers = { 'content-type': asset.type, etag: asset.etag, 'cache-control': 'private, no-cache' };
            if (req.headers?.['if-none-match'] === asset.etag) { res.writeHead(304, headers); return res.end(); }
            res.writeHead(200, headers);
            return res.end(req.method === 'HEAD' ? undefined : asset.body);
          }
          return handler(req, res);
        }
        let release: (() => Promise<void>) | undefined;
        try {
          const scope = await resolveCanvasScope(ctx, url);
          return await requestScope.run(scope, async () => {
            release = await prepare?.(scope);
            if (kind === 'thoughtdag' && await nativeThoughtdagRead(ctx, url, req, res)) return;
            const match = /^\/thoughtdag\/api\/sessions\/([^/]+)/.exec(url.pathname);
            if (match) assertSession(decodeURIComponent(match[1]));
            // External runtimes have no native workspace identity. Their
            // original integrations remain available in the global canvas.
            if (scope.level !== 'global' && /\/api\/(?:roots|why|agents)(?:\/|$)/.test(url.pathname)) {
              if (url.pathname.endsWith('/roots')) return json(res, 200, { roots: [] });
              return json(res, 403, { error: '此入口仅在全局图谱中可用' });
            }
            await handler(req, res);
          });
        } catch (error) {
          if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : '图谱不可用' });
          else if (!res.writableEnded) res.end();
        } finally {
          try { await release?.(); }
          catch (error) { ctx.logger.error(error instanceof Error ? error : new Error(String(error))); }
        }
      } });
    },
  };
}

async function archiveSnapshot(ctx: any, id: string) {
  assertSession(id);
  let cache = archiveCaches.get(ctx);
  if (!cache) {
    cache = new CanvasArchiveCache({
      load: sessionId => ctx.get('sessionQuery').readSession(sessionId),
      version(sessionId) {
        const session = ctx.sessions.get(sessionId);
        return { owner: session, seq: session?.seq };
      },
      weight: snapshot => Buffer.byteLength(JSON.stringify(snapshot)),
    });
    archiveCaches.set(ctx, cache);
  }
  const snapshot = await cache.read(id);
  // Original consumers may sort/filter their event array. Never share that
  // mutable array across scopes or views, while reusing immutable event data.
  return { ...snapshot, events: [...snapshot.events] };
}

/** Use the official archive API rather than reimplementing the profile layout. */
async function nativeThoughtdagRead(ctx: any, url: URL, req: any, res: any): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const path = url.pathname.slice('/thoughtdag/api'.length);
  const query = ctx.get('sessionQuery');
  if (path === '/disksessions' || path === '/sessions') {
    const rows = (await query.listSessions()).filter((row: any) => allowed(row.header.id));
    const titles = await sessionTitles(query, rows.map((row: any) => row.header.id), AbortSignal.timeout(15_000));
    json(res, 200, { sessions: rows.map((row: any) => ({
      id: row.header.id, title: titles.get(row.header.id)?.title
        ?? (typeof row.title === 'string' ? row.title : row.title?.title ?? row.header.title ?? row.header.id),
      cwd: row.header.cwd ?? row.header.meta?.cwd ?? null, parentSession: row.header.parentSession,
      seq: ctx.sessions.get(row.header.id)?.seq ?? null,
    })) });
    return true;
  }
  const one = /^\/(?:disksessions|sessions)\/([^/]+?)(\/log)?$/.exec(path);
  if (!one) return false;
  const id = decodeURIComponent(one[1]);
  const snapshot = await archiveSnapshot(ctx, id);
  const header = snapshot.session;
  const title = snapshot.events.findLast((event: any) => event.type === 'session/title')?.data?.title;
  if (!one[2]) json(res, 200, { session: {
    ...header, title: typeof title === 'string' ? title : header.title ?? id, cwd: header.cwd ?? header.meta?.cwd,
    seq: ctx.sessions.get(id)?.seq ?? snapshot.events.length,
  } });
  else {
    const since = url.searchParams.get('since');
    const events = snapshot.events.filter((event: any) => since === null || event.seq > Number(since));
    const lines = since === null ? [{
      type: 'session', version: 0, id, createdAt: header.createdAt,
      cwd: header.cwd ?? header.meta?.cwd, parentSession: header.parentSession,
      seedLength: snapshot.inheritedEventCount ?? 0,
    }, ...events] : events;
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    res.end(lines.map((value: any) => JSON.stringify(value)).join('\n'));
  }
  return true;
}

/** Shared assets are owned once by the Nexus root, independently of either canvas. */
export function registerCanvasAssets(ctx: any) {
  for (const [file, type] of [['canvas-bootstrap.js', 'text/javascript'], ['canvas-theme.css', 'text/css']]) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `/nexus/${file}`, handler: async (_req: any, res: any) => {
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
      res.end(await readFile(join(assetRoot, file)));
    } }), `nexus canvas ${file}`);
  }
}

export async function applyThoughtdag(ctx: Context & any, config: any = {}) {
  const original: any = await import(pathToFileURL(join(assetRoot, 'canvas-original/thoughtdag/index.js')).href);
  const state = createCanvasOriginalState(active);
  const adaptedAssets = new Map<string, CanvasAsset>();
  for (const [relative, type] of [['index.html', 'text/html; charset=utf-8'], ['assets/nexus-entry.js', 'text/javascript; charset=utf-8']]) {
    const body = await readFile(join(assetRoot, 'canvas-original/thoughtdag/dist-app', relative));
    const asset = { body, type, etag: `"${createHash('sha256').update(body).digest('hex')}"` };
    adaptedAssets.set(`/thoughtdag/${relative === 'index.html' ? '' : relative}`, asset);
    if (relative === 'index.html') adaptedAssets.set('/thoughtdag/index.html', asset);
  }
  const controller = createThoughtdagSessionController(ctx.sessionController, {
    currentScope: active, assertSession, origins: thoughtdagOrigins(ctx),
    headers: async () => (await ctx.get('sessionQuery').listSessions()).map((row: any) => row.header),
    workspaces: () => nativeWorkspaces(ctx),
  });
  const agents = new Proxy(ctx.agents, { get(target, key) {
    if (key === 'get') return (id: string) => { assertSession(id); return target.get(id); };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const nexusCanvas = {
    assertSession,
    get scopeKey() { return active().key; },
    assertHarness(harness: any) {
      if (harness?.session) assertSession(harness.session);
      if (harness?.forkSession) assertSession(harness.forkSession);
    },
    async eventsOfSession(id: string) { return (await archiveSnapshot(ctx, id)).events; },
  };
  ctx.effect(() => () => {
    original.disposeNexusState?.();
    state.dispose();
    archiveCaches.get(ctx)?.clear();
    archiveCaches.delete(ctx);
  }, 'nexus original ThoughtDAG scope state');
  await original.apply(ctx.extend({
    webServer: scopedWebServer(ctx, 'thoughtdag', async (scope: CanvasScope) => state.acquire(scope), adaptedAssets),
    sessions: scopedSessions(ctx), sessionController: controller, agents, nexusCanvas,
  }), { ...config, mountPrefix: '/thoughtdag', nexusState: state });
}

export async function applySynapse(ctx: Context & any, config: any = {}) {
  const original: any = await import(pathToFileURL(join(assetRoot, 'canvas-original/synapse/index.js')).href);
  const dataRoot = config.dataDir ?? join(ctx.get('profileContext').dir, 'data', 'nexus', 'canvases', 'synapse');
  await mkdir(dataRoot, { recursive: true });
  interface CachedStore {
    store: any; users: number; used: number; cursors: Map<string, number>;
    archived: Set<string>;
    eviction?: Promise<void>;
  }
  const stores = new Map<string, CachedStore>();
  const maximum = 12;
  let stopped = false;
  const flush = async (record: CachedStore) => {
    await record.store.serial;
    await record.store.flush();
    clearTimeout(record.store.flushTimer);
    record.store.flushTimer = null;
  };
  const evict = async () => {
    for (const [key, record] of [...stores].sort((a, b) => a[1].used - b[1].used)) {
      if (stores.size < maximum) break;
      if (record.users || record.eviction) continue;
      record.eviction = (async () => {
        await flush(record);
        if (!record.users && stores.get(key) === record) stores.delete(key);
      })().finally(() => { record.eviction = undefined; });
      await record.eviction;
    }
  };
  const prepare = async (scope: CanvasScope) => {
    if (stopped) throw new Error('图谱已卸载');
    let record = stores.get(scope.key);
    if (record?.eviction) {
      await record.eviction;
      record = stores.get(scope.key);
    }
    if (!record) {
      await evict();
      record = stores.get(scope.key);
      if (!record) {
        if (stores.size >= maximum) throw new Error('图谱正在处理其他范围，请稍后重试');
        record = { store: new original.WorkspaceStore(join(dataRoot, `${scope.key}.json`)), users: 0, used: Date.now(), cursors: new Map(), archived: new Set() };
        stores.set(scope.key, record);
      }
    }
    record.users++;
    try {
      await record.store.ready;
      if (stopped) throw new Error('图谱已卸载');
      // Native membership is checked again before exposing persisted threads.
      await record.store.serial;
      const outside = (thread: any) => thread.dshSessionId !== null && !scope.sessionIds.has(thread.dshSessionId);
      const needsPrune = record.store.state.workspaces.some((workspace: any) =>
        workspace.threads.some(outside) || (workspace.kind === 'dsh' && !workspace.threads.length))
        || record.store.state.hiddenSessionIds.some((id: string) => !scope.sessionIds.has(id));
      if (needsPrune) await record.store.mutate(() => {
          for (const workspace of record!.store.state.workspaces) {
            workspace.threads = workspace.threads.filter((thread: any) => !outside(thread));
            const kept = new Set(workspace.threads.map((thread: any) => thread.id));
            for (const thread of workspace.threads) if (thread.parentId !== null && !kept.has(thread.parentId)) thread.parentId = null;
          }
          record!.store.state.workspaces = record!.store.state.workspaces.filter((workspace: any) => workspace.kind !== 'dsh' || workspace.threads.length);
          record!.store.state.hiddenSessionIds = record!.store.state.hiddenSessionIds.filter((id: string) => scope.sessionIds.has(id));
        }, { deferred: true });
      for (const id of record.cursors.keys()) if (!scope.sessionIds.has(id)) record.cursors.delete(id);
      for (const id of record.archived) if (!scope.sessionIds.has(id)) record.archived.delete(id);
      for (const session of ctx.sessions.list().filter((row: any) => scope.sessionIds.has(row.id))) {
        record.archived.delete(session.id);
        if (stopped) throw new Error('图谱已卸载');
        const cursor = record.cursors.get(session.id) ?? session.inheritedEventCount ?? 0;
        const nextSeq = session.seq;
        // seq is the next event index. Adding one drops the next committed event.
        if (nextSeq <= cursor) continue;
        await record.store.projectSession(session, cursor);
        // Snapshot the boundary before awaiting the store: an event committed
        // during persistence must remain eligible for the next request.
        record.cursors.set(session.id, Math.max(record.cursors.get(session.id) ?? 0, nextSeq));
      }
      // Unloaded native sessions still belong to the graph. Project each once
      // through the original projector; active sessions above keep seq deltas.
      // This avoids rescanning every archive on every original UI poll.
      for (const id of scope.sessionIds) {
        if (ctx.sessions.get(id) || record.archived.has(id)) continue;
        const snapshot = await archiveSnapshot(ctx, id);
        if (stopped) throw new Error('图谱已卸载');
        const events = snapshot.events;
        const cursor = record.cursors.get(id) ?? 0;
        const nextSeq = events.length ? events[events.length - 1].seq + 1 : 0;
        if (nextSeq > cursor) await record.store.projectSession({
          id, header: snapshot.session, inheritedEventCount: snapshot.inheritedEventCount ?? 0,
          snapshotEvents: () => events,
        }, cursor);
        record.cursors.set(id, nextSeq);
        record.archived.add(id);
      }
    } catch (error) {
      record.users--;
      if (!record.users && stores.get(scope.key) === record) stores.delete(scope.key);
      clearTimeout(record.store.flushTimer);
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try { await flush(record!); }
      finally { record!.users--; record!.used = Date.now(); }
    };
  };
  const store = new Proxy({}, { get(_target, method: string) {
    return async (...args: any[]) => {
      if (stopped) throw new Error('图谱已卸载');
      const current = stores.get(active().key);
      if (!current) throw new Error('图谱存储未就绪');
      if (method === 'syncSessions') {
        args[0] = Array.isArray(args[0]) ? args[0].filter((row: any) => allowed(row?.id)) : args[0];
        // An id that has just moved OUT must remain removable from this store.
      }
      for (const input of args) if (input?.dshSessionId) assertSession(input.dshSessionId);
      return current.store[method](...args);
    };
  } });
  ctx.effect(() => async () => {
    stopped = true;
    const settled = await Promise.allSettled([...stores.values()].map(flush));
    stores.clear();
    archiveCaches.get(ctx)?.clear();
    archiveCaches.delete(ctx);
    for (const result of settled) if (result.status === 'rejected') ctx.logger.error(result.reason);
  }, 'nexus scoped Synapse stores');
  original.apply(ctx.extend({ webServer: scopedWebServer(ctx, 'synapse', prepare), sessions: scopedSessions(ctx) }),
    { ...config, autoProjection: false, nexusStore: store });
}
