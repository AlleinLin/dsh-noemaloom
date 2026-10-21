import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import * as zlib from 'node:zlib';
import { NexusError, type DispatchContext, type JsonRecord, type NexusRequest, type NexusServices } from '../../ports/contracts.js';
import { hash, sha256 } from '../../upstream/thoughtdag/graph.js';
import { decodeZstdFrames } from '../../upstream/thoughtdag/zstd.js';
import { parseHistory } from './history-parser.js';
import { readIncrementalHistory } from './history-reader.js';
import type { CanonicalSession, HistorySource, HistoryTurn } from './types.js';

const SOURCE_COLLECTION = 'graph-history-sources';
const SESSION_COLLECTION = 'graph-history-sessions';
const TOPIC_COLLECTION = 'graph-topics';
const string = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
const limitOf = (value: unknown, fallback = 20, maximum = 200): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
const normalizeRoot = (root: string): string => {
  const resolved = /^[a-z]:[\\/]|^\\\\/i.test(root) ? path.win32.normalize(root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    : path.resolve(root).replace(/\\/g, '/').replace(/\/+$/, '');
  return resolved;
};
const sameProject = (left: string, right: string): boolean => normalizeRoot(left) === normalizeRoot(right);

export function canonicalArtifact(value: string, projectRoot: string): string {
  const trimmed = value.trim();
  if (/^arxiv:/i.test(trimmed)) return `arxiv:${trimmed.slice(6).replace(/v\d+$/, '').toLowerCase()}`;
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    url.hash = '';
    return url.toString();
  }
  if (/^(?:material|artifact):/.test(trimmed)) return trimmed;
  const asFile = trimmed.startsWith('file://') ? decodeURIComponent(trimmed.slice(7)) : trimmed;
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(asFile) || /^[a-z]:[\\/]|^\\\\/i.test(projectRoot);
  return `file://${windows ? normalizeRoot(path.win32.resolve(projectRoot, asFile)) : normalizeRoot(path.resolve(projectRoot, asFile))}`;
}

function scopedSessions(sessions: CanonicalSession[], sources: HistorySource[], params: JsonRecord, workspaceRoot: string): CanonicalSession[] {
  const enabled = new Set(sources.filter(source => source.enabled && source.authorized).map(source => source.id));
  const projectRoot = string(params.projectRoot, workspaceRoot);
  return sessions.filter(session => enabled.has(session.sourceId) && session.available && !session.hidden
    && (params.crossProject === true || sameProject(session.projectRoot, projectRoot)));
}

function page<T>(items: T[], request: NexusRequest, revision: string): { items: T[]; cursor: string | null; total: number; truncated: boolean; revision: string } {
  let offset = 0;
  const cursor = request.cursor ?? (typeof request.params?.cursor === 'string' ? request.params.cursor : undefined);
  if (cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (parsed.revision !== revision) throw new NexusError('CTX-REVISION-CONFLICT', '分页快照已变化，请从第一页重新读取');
      if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error('offset');
      offset = parsed.offset;
    } catch (error) { if (error instanceof NexusError) throw error; throw new NexusError('INVALID_ARGUMENT', '分页 cursor 无效'); }
  }
  const limit = limitOf(request.limit ?? request.params?.limit);
  const result = items.slice(offset, offset + limit);
  const next = offset + result.length;
  return { items: result, cursor: next < items.length ? Buffer.from(JSON.stringify({ revision, offset: next })).toString('base64url') : null,
    total: items.length, truncated: next < items.length, revision };
}

export function createHistoryService(services: NexusServices) {
  const watchers = new Map<string, { watcher?: FSWatcher; timer?: ReturnType<typeof setTimeout>; poll?: ReturnType<typeof setInterval>; controller: AbortController; context?: DispatchContext }>();
  const sourceScans = new Map<string, Promise<unknown>>();
  const scanControllers = new Map<string, AbortController>();
  let disposed = false;
  const sources = async (): Promise<HistorySource[]> => (await services.store.list<HistorySource>(SOURCE_COLLECTION)).map(record => record.value);
  const sessions = async (): Promise<CanonicalSession[]> => (await services.store.list<CanonicalSession>(SESSION_COLLECTION)).map(record => record.value);
  const sourceById = async (id: string): Promise<HistorySource> => {
    const result = await services.store.get<HistorySource>(SOURCE_COLLECTION, id);
    if (!result) throw new NexusError('NOT_FOUND', '历史来源不存在');
    if (!result.value.enabled || !result.value.authorized) throw new NexusError('CTX-HISTORY-SOURCE-DISABLED', '历史来源尚未授权或已关闭');
    return result.value;
  };
  const saveSession = async (session: CanonicalSession): Promise<CanonicalSession> => {
    const authorizedSource = await sourceById(session.sourceId);
    if (authorizedSource.projectRoots.length && !authorizedSource.projectRoots.some(root => sameProject(root, session.projectRoot))) {
      throw new NexusError('CTX-HISTORY-SCOPE', '历史记录声明的项目不在来源授权范围内');
    }
    const previous = await services.store.get<CanonicalSession>(SESSION_COLLECTION, session.id);
    session.hidden = previous?.value.hidden ?? false;
    session.changed = previous ? previous.value.revision !== session.revision : true;
    await services.store.put(SESSION_COLLECTION, session.id, session, previous?.revision ?? 0);
    services.emit('graph:history-change', { sessionId: session.id, revision: session.revision, changed: session.changed });
    return session;
  };
  const ingest = async (params: JsonRecord): Promise<CanonicalSession> => {
    const source = await sourceById(string(params.sourceId));
    const externalId = string(params.externalId);
    if (!externalId) throw new NexusError('INVALID_ARGUMENT', 'externalId 必须为非空字符串');
    const input = params.records ?? params.text;
    if (typeof input !== 'string' && !Array.isArray(input)) throw new NexusError('INVALID_ARGUMENT', '请提供 text 或 records 历史内容');
    const projectRoot = string(params.projectRoot, source.projectRoots[0] ?? services.workspaceRoot);
    if (source.projectRoots.length && !source.projectRoots.some(root => sameProject(root, projectRoot))) throw new NexusError('CTX-HISTORY-SCOPE', '该项目不在来源授权范围内');
    return saveSession(parseHistory(source, externalId, input, { projectRoot, complete: params.complete === true }));
  };
  const sessionById = async (id: string, params: JsonRecord = {}): Promise<CanonicalSession> => {
    const permitted = scopedSessions(await sessions(), await sources(), params, services.workspaceRoot);
    const session = permitted.find(item => item.id === id || item.externalId === id);
    if (!session) throw new NexusError('NOT_FOUND', '授权范围内没有该会话');
    return session;
  };
  const whyHits = async (params: JsonRecord): Promise<{
    artifact: string; hits: JsonRecord[]; readsHidden: number; revision: string;
  }> => {
    const query = string(params.path, string(params.artifact));
    if (!query) throw new NexusError('INVALID_ARGUMENT', 'path 或 artifact 必须为非空字符串');
    const projectRoot = string(params.projectRoot, services.workspaceRoot);
    const artifact = canonicalArtifact(query, projectRoot);
    const permitted = scopedSessions(await sessions(), await sources(), params, services.workspaceRoot);
    const hits: JsonRecord[] = [];
    let readsHidden = 0;
    for (const session of permitted) for (const turn of session.turns) {
      const touches = turn.tools.filter(tool => tool.artifacts.some(item => {
        try { return canonicalArtifact(item, session.projectRoot) === artifact; } catch { return false; }
      }));
      if (!touches.length) continue;
      const observed = touches.filter(tool => params.includeRead === true || params.include_read === true || tool.op !== 'read');
      if (!observed.length) { readsHidden += touches.length; continue; }
      const artifactName = query.split(/[\\/]/).at(-1) ?? query;
      const candidates = turn.answer.split(/\n|(?<=[。.!?])\s+/).filter(line => line.includes(artifactName));
      hits.push({ sessionId: session.id, sourceId: session.sourceId, agent: session.agent, turnId: turn.id, timestamp: turn.timestamp,
        question: turn.question, observedChanges: observed.map(tool => ({
          callId: tool.callId, operation: tool.op, toolName: tool.name, arguments: tool.arguments, result: tool.result, evidence: 'observed',
        })),
        candidateExplanation: candidates.map(text => ({ text, evidence: 'candidate-from-answer', verifiedReason: false })),
        source: { sourceId: session.sourceId, sessionId: session.id, turnId: turn.id, revision: session.revision, binding: 'pinned', contentHash: turn.contentHash },
        citation: `nexus://history/${encodeURIComponent(session.id)}/${encodeURIComponent(turn.id)}`, truncated: false });
    }
    hits.sort((a, b) => string(b.timestamp).localeCompare(string(a.timestamp)) || string(a.sessionId).localeCompare(string(b.sessionId)));
    return { artifact, hits, readsHidden, revision: hash(permitted.map(session => [session.id, session.revision])) };
  };
  const scanSourceCore = async (params: JsonRecord, context?: DispatchContext) => {
    const source = await sourceById(string(params.sourceId));
    if (source.mode === 'host-port') {
      const listed = await services.host.sessions('list', { projectRoot: services.workspaceRoot });
      const list = Array.isArray(listed) ? listed : Array.isArray((listed as JsonRecord)?.sessions) ? (listed as { sessions: unknown[] }).sessions : [];
      const imported: JsonRecord[] = [];
      for (const entry of list.slice(0, limitOf(params.maxSessions, 1_000, 10_000))) {
        context?.signal?.throwIfAborted();
        const summary = entry as JsonRecord;
        const externalId = string(summary.id, string(summary.sessionId));
        if (!externalId) continue;
        const loaded = await services.host.sessions('get', { sessionId: externalId });
        const value = loaded as JsonRecord;
        const header = value?.header && typeof value.header === 'object' ? value.header as JsonRecord
          : summary.header && typeof summary.header === 'object' ? summary.header as JsonRecord : {};
        const meta = header.meta && typeof header.meta === 'object' ? header.meta as JsonRecord : {};
        const projectRoot = string(summary.cwd, string(meta.cwd, string(header.cwd)));
        if (!projectRoot || source.projectRoots.length && !source.projectRoots.some(root => sameProject(root, projectRoot))) continue;
        const records = Array.isArray(value?.events) ? value.events : Array.isArray(loaded) ? loaded : [];
        const parsed = parseHistory(source, externalId, records, { projectRoot, complete: summary.status === 'completed' || summary.status === 'idle' });
        parsed.title = string(summary.title, parsed.title);
        if (typeof header.parentSession === 'string') parsed.parentSessionId = `${source.id}:${header.parentSession}`;
        await saveSession(parsed);
        imported.push({ id: parsed.id, turns: parsed.turns.length, warnings: parsed.warnings });
      }
      return { imported, hostPort: true };
    }
    if (!source.root) throw new NexusError('CTX-HISTORY-SCOPE', '文件来源没有授权根目录');
    const root = await realpath(source.root);
    const files: string[] = [], warnings: JsonRecord[] = [];
    const queue = [root], maxFiles = limitOf(params.maxFiles, 2_000, 10_000);
    while (queue.length && files.length < maxFiles) {
      const directory = queue.shift()!;
      context?.signal?.throwIfAborted();
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(directory, entry.name), relative = path.relative(root, full).replace(/\\/g, '/');
        if (source.excludes.some(exclude => relative === exclude || relative.startsWith(`${exclude}/`))) continue;
        if (entry.isSymbolicLink()) { warnings.push({ relative, message: '跳过符号链接，避免越过授权来源边界' }); continue; }
        if (entry.isDirectory()) { if (queue.length < 20_000) queue.push(full); continue; }
        if (entry.isFile() && /\.(?:jsonl|ndjson|json|zst|zstd|md)$/i.test(entry.name)) files.push(full);
        if (files.length >= maxFiles) break;
      }
    }
    const imported: JsonRecord[] = [];
    const existingSessions = await sessions();
    for (const full of files) {
      context?.signal?.throwIfAborted();
      const actual = await realpath(full), relative = path.relative(root, actual);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new NexusError('CTX-HISTORY-SCOPE', '来源文件逃逸授权根目录');
      const info = await stat(actual);
      if (/\.(?:jsonl|ndjson)$/i.test(full)) {
        if (info.size > Number(params.maxStreamBytes ?? 2 * 1024 * 1024 * 1024)) { warnings.push({ relative, message: 'JSONL 文件超过本次明确流式读取上限' }); continue; }
        const previous = existingSessions.find(session => session.sourceId === source.id && session.fileState?.relative === relative);
        try {
          const result = await readIncrementalHistory({ file: actual, relative, source, previous, byteLength: info.size, mtimeMs: info.mtimeMs,
            projectRoot: source.projectRoots[0] ?? services.workspaceRoot, signal: context?.signal ?? services.signal });
          if (result.mode !== 'unchanged') await saveSession(result.session);
          imported.push({ id: result.session.id, turns: result.session.turns.length, cursor: result.session.cursor, changed: result.mode !== 'unchanged',
            mode: result.mode, parsedBytes: result.parsedBytes });
        } catch (error) {
          if (context?.signal?.aborted || services.signal?.aborted) throw error;
          warnings.push({ relative, code: error instanceof NexusError ? error.code : 'CTX-HISTORY-FORMAT', message: error instanceof Error ? error.message : '历史流式解析失败' });
        }
        continue;
      }
      if (info.size > 128 * 1024 * 1024) { warnings.push({ relative, message: '非 JSONL 文件超过 128 MiB，需拆分后导入' }); continue; }
      let bytes = await readFile(actual), cursorBytes: number | undefined;
      if (/\.(?:zst|zstd)$/i.test(full)) {
        const inflate = (zlib as unknown as { zstdDecompressSync?: (buffer: Uint8Array, options?: unknown) => Buffer }).zstdDecompressSync;
        if (!inflate) throw new NexusError('CTX-CAPABILITY-MISSING', '当前运行时没有 zstd 解码器；请使用宿主会话 port 或安装支持 zstd 的 Node 版本');
        const decoded = decodeZstdFrames(bytes, frame => inflate(frame, { maxOutputLength: 128 * 1024 * 1024 }));
        bytes = Buffer.from(decoded.bytes); cursorBytes = decoded.cursor;
        if (decoded.warning) warnings.push({ relative, message: decoded.warning });
      }
      const text = bytes.toString('utf8');
      const input: string | unknown[] = source.kind === 'memory' && /\.md$/i.test(full)
        ? [{ title: path.basename(full), text }] : text;
      try {
        const session = parseHistory(source, relative, input, { projectRoot: source.projectRoots[0] ?? services.workspaceRoot, complete: /\.json$/i.test(full), cursorBytes });
        if (!session.turns.length) { warnings.push({ relative, message: '没有可导入的完整轮次' }); continue; }
        await saveSession(session);
        imported.push({ id: session.id, turns: session.turns.length, cursor: session.cursor, changed: session.changed });
      } catch (error) {
        warnings.push({ relative, code: error instanceof NexusError ? error.code : 'CTX-HISTORY-FORMAT', message: error instanceof Error ? error.message : '历史解析失败' });
      }
    }
    return { imported, warnings, truncated: queue.length > 0 || files.length >= maxFiles, scanned: files.length };
  };
  const scanSource = (params: JsonRecord, context?: DispatchContext): Promise<unknown> => {
    const id = string(params.sourceId), previous = sourceScans.get(id);
    if (previous) return previous;
    const controller = new AbortController();
    scanControllers.set(id, controller);
    const signals = [controller.signal, context?.signal, services.signal].filter((signal): signal is AbortSignal => !!signal);
    const promise = scanSourceCore(params, { ...context, signal: AbortSignal.any(signals) });
    sourceScans.set(id, promise);
    void promise.then(() => { sourceScans.delete(id); scanControllers.delete(id); }, () => { sourceScans.delete(id); scanControllers.delete(id); });
    return promise;
  };
  const stopWatch = (id: string): boolean => {
    scanControllers.get(id)?.abort();
    const state = watchers.get(id);
    if (!state) return false;
    state.controller.abort(); state.watcher?.close();
    if (state.timer) clearTimeout(state.timer);
    if (state.poll) clearInterval(state.poll);
    watchers.delete(id); return true;
  };
  const startWatch = async (id: string, context?: DispatchContext) => {
    if (disposed) throw new NexusError('DISPOSED', '历史服务已停用');
    const source = await sourceById(id);
    if (watchers.has(id)) return { sourceId: id, watching: true, alreadyRunning: true };
    const controller = new AbortController();
    const state: { watcher?: FSWatcher; timer?: ReturnType<typeof setTimeout>; poll?: ReturnType<typeof setInterval>; controller: AbortController; context?: DispatchContext }
      = { controller, context: { ...context, signal: controller.signal } };
    const schedule = () => {
      if (disposed || controller.signal.aborted) return;
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.timer = undefined;
        void scanSource({ sourceId: id }, state.context).then(result => services.emit('graph:history-watch', { sourceId: id, status: 'synced', result }),
          error => services.emit('graph:history-watch', { sourceId: id, status: 'failed', code: error instanceof NexusError ? error.code : 'CTX-HISTORY-FORMAT' }));
      }, 1_000);
      state.timer.unref?.();
    };
    if (source.mode === 'host-port') {
      state.poll = setInterval(schedule, 5_000); state.poll.unref?.();
    } else {
      if (!source.root) throw new NexusError('CTX-HISTORY-SCOPE', '监视来源没有授权根目录');
      const root = await realpath(source.root);
      state.watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) return schedule();
        const relative = filename.toString().replace(/\\/g, '/');
        if (relative.startsWith('../') || source.excludes.some(exclude => relative === exclude || relative.startsWith(`${exclude}/`))) return;
        schedule();
      });
      state.watcher.on('error', error => {
        services.emit('graph:history-watch', { sourceId: id, status: 'failed', code: 'CTX-HISTORY-WATCH', message: error.message });
        stopWatch(id);
      });
    }
    watchers.set(id, state); schedule();
    return { sourceId: id, watching: true, debounceMs: 1_000, mode: source.mode === 'host-port' ? 'official-host-poll' : 'authorized-recursive-watch' };
  };
  const dispatch = async (request: NexusRequest, context?: DispatchContext): Promise<unknown> => {
    const params = request.params ?? {}, action = request.action;
    if (action === 'atlas.sources') return sources();
    if (action === 'atlas.watch.start') return startWatch(string(params.sourceId), context);
    if (action === 'atlas.watch.stop') return { sourceId: params.sourceId, stopped: stopWatch(string(params.sourceId)) };
    if (action === 'atlas.watch.status') return [...watchers].map(([sourceId, state]) => ({ sourceId, watching: !state.controller.signal.aborted, scanRunning: sourceScans.has(sourceId) }));
    if (action === 'atlas.source.upsert') {
      const id = string(params.id, randomUUID()), previous = await services.store.get<HistorySource>(SOURCE_COLLECTION, id);
      const kind = string(params.kind, previous?.value.kind ?? 'dsh') as HistorySource['kind'];
      const mode = string(params.mode, previous?.value.mode ?? (kind === 'dsh' ? 'host-port' : 'authorized-file-import')) as HistorySource['mode'];
      if (!['dsh', 'claude-code', 'codex', 'pi', 'canvas', 'memory'].includes(kind) || !['host-port', 'authorized-file-import', 'external-live-source'].includes(mode)) throw new NexusError('INVALID_ARGUMENT', '不支持的来源类型或读取模式');
      const requestedRoot = string(params.root, previous?.value.root);
      const authorized = params.authorized === true || previous?.value.authorized === true;
      if (!authorized) throw new NexusError('CTX-HISTORY-SCOPE', '请先明确授权所选历史来源');
      const root = requestedRoot ? await realpath(requestedRoot) : undefined;
      const projectRoots = Array.isArray(params.projectRoots) ? params.projectRoots.filter((item): item is string => typeof item === 'string') : previous?.value.projectRoots ?? [services.workspaceRoot];
      const source: HistorySource = { schemaVersion: 1, id, title: string(params.title, previous?.value.title ?? `${kind} 历史`), kind, mode,
        enabled: params.enabled !== false, authorized, root, projectRoots,
        excludes: Array.isArray(params.excludes) ? params.excludes.filter((item): item is string => typeof item === 'string') : previous?.value.excludes ?? [],
        createdAt: previous?.value.createdAt ?? new Date().toISOString() };
      await services.store.put(SOURCE_COLLECTION, id, source, request.expectedRevision ?? previous?.revision ?? 0);
      if (!source.enabled) stopWatch(id);
      else if (source.mode === 'external-live-source') { stopWatch(id); await startWatch(id, context); }
      for (const session of await sessions()) if (session.sourceId === id) {
        const record = await services.store.get<CanonicalSession>(SESSION_COLLECTION, session.id);
        await services.store.put(SESSION_COLLECTION, session.id, { ...session, available: source.enabled }, record?.revision);
      }
      return source;
    }
    if (action === 'atlas.source.remove' || action === 'atlas.index.clear') {
      const id = string(params.sourceId, string(params.id));
      const previous = await services.store.get<HistorySource>(SOURCE_COLLECTION, id);
      if (!previous) throw new NexusError('NOT_FOUND', '历史来源不存在');
      stopWatch(id);
      let removed = 0;
      for (const record of await services.store.list<CanonicalSession>(SESSION_COLLECTION)) if (record.value.sourceId === id) {
        if (params.removeImported === true || action === 'atlas.index.clear') { await services.store.remove(SESSION_COLLECTION, record.id, record.revision); removed++; }
        else await services.store.put(SESSION_COLLECTION, record.id, { ...record.value, available: false }, record.revision);
      }
      if (action === 'atlas.source.remove') await services.store.put(SOURCE_COLLECTION, id, { ...previous.value, enabled: false }, request.expectedRevision ?? previous.revision);
      return { removed, sourceId: id, localCanvasCopiesRetained: true };
    }
    if (action === 'atlas.ingest') return ingest(params);
    if (action === 'atlas.scan' || action === 'atlas.sync') return scanSource(params, context);
    if (action === 'atlas.list') {
      const all = scopedSessions(await sessions(), await sources(), params, services.workspaceRoot)
        .filter(session => params.changed !== true || session.changed)
        .map(({ turns, ...session }) => ({ ...session, turns: turns.length, toolCount: turns.reduce((sum, turn) => sum + turn.tools.length, 0) }))
        .sort((a, b) => a.projectRoot.localeCompare(b.projectRoot) || b.importedAt.localeCompare(a.importedAt));
      return page(all, request, hash(all.map(session => [session.id, session.revision])));
    }
    if (action === 'atlas.hide' || action === 'atlas.restore') {
      const id = string(params.sessionId);
      const previous = await services.store.get<CanonicalSession>(SESSION_COLLECTION, id);
      if (!previous) throw new NexusError('NOT_FOUND', '会话不存在');
      await services.store.put(SESSION_COLLECTION, id, { ...previous.value, hidden: action === 'atlas.hide' }, request.expectedRevision ?? previous.revision);
      return { sessionId: id, hidden: action === 'atlas.hide', hostSessionUnchanged: true };
    }
    if (action === 'why.check' || action === 'why.file') {
      const found = await whyHits(params);
      if (action === 'why.check') return { artifact: found.artifact, history: found.hits.length + found.readsHidden > 0,
        count: found.hits.length, readsHidden: found.readsHidden, freshness: 'indexed-snapshot', indexRevision: found.revision };
      return { artifact: found.artifact, readsHidden: found.readsHidden, ...page(found.hits, request, found.revision) };
    }
    if (action === 'why.find') {
      const phrase = string(params.phrase, string(params.query));
      const scopes: Record<string, string> = { q: 'question', a: 'answer', m: 'material', all: 'all', question: 'question', answer: 'answer', material: 'material' };
      const scope = scopes[string(params.scope, 'all')];
      if (!phrase.trim() || !scope) throw new NexusError('INVALID_ARGUMENT', '请提供精确匹配词和 question/answer/material/all 范围');
      const permitted = scopedSessions(await sessions(), await sources(), params, services.workspaceRoot);
      const hits: JsonRecord[] = [];
      for (const session of permitted) for (const turn of session.turns) {
        const fields = { question: turn.question, answer: turn.answer, material: turn.materials.join('\n') };
        const matched: JsonRecord[] = [];
        for (const [field, text] of Object.entries(fields)) if (scope === 'all' || scope === field) {
          const haystack = params.caseSensitive === true ? text : text.toLocaleLowerCase();
          const needle = params.caseSensitive === true ? phrase : phrase.toLocaleLowerCase();
          let start = 0;
          while ((start = haystack.indexOf(needle, start)) !== -1 && matched.length < 100) {
            matched.push({ field, start, end: start + phrase.length, excerpt: text.slice(Math.max(0, start - 100), Math.min(text.length, start + phrase.length + 200)), evidence: 'observed-verbatim' });
            start += Math.max(1, needle.length);
          }
        }
        if (matched.length) hits.push({ sessionId: session.id, turnId: turn.id, sourceId: session.sourceId, agent: session.agent,
          timestamp: turn.timestamp, matches: matched, indexRevision: session.revision,
          citation: `nexus://history/${encodeURIComponent(session.id)}/${encodeURIComponent(turn.id)}`, truncated: matched.length >= 100 });
      }
      return { phrase, scope, matching: 'exact-substring', ...page(hits, request, hash(permitted.map(session => [session.id, session.revision]))) };
    }
    if (action === 'why.recall') {
      const session = await sessionById(string(params.sessionId), params);
      const target = params.turnId ?? params.turn;
      const turn = typeof target === 'number' ? session.turns[target - 1] : session.turns.find(item => item.id === target);
      if (!turn) throw new NexusError('NOT_FOUND', '指定轮次不存在');
      const full = params.full !== false;
      const content = full ? JSON.stringify({ question: turn.question, answer: turn.answer, materials: turn.materials, tools: turn.tools }, null, 2)
        : `Q: ${turn.question}\nA: ${turn.answer}`;
      const maxTokens = limitOf(params.maxTokens, 4_096, 32_768), chunkSize = maxTokens * 3;
      const chunks: string[] = [];
      for (let index = 0; index < content.length; index += chunkSize) chunks.push(content.slice(index, index + chunkSize));
      const result = page(chunks.map((text, index) => ({ text, part: index + 1, parts: chunks.length })), { ...request, limit: 1 }, hash({ session: session.revision, turn: turn.contentHash, full, chunkSize }));
      return { sessionId: session.id, turnId: turn.id, full, source: { sourceId: session.sourceId, revision: session.revision, contentHash: turn.contentHash },
        ...result, completeContent: !result.truncated && result.total <= 1, truncated: result.truncated || result.total > 1 };
    }
    if (action === 'recall') {
      const query = string(params.query), amount = string(params.amount, 'standard'), reach = string(params.reach, 'light');
      if (!['lean', 'standard', 'generous'].includes(amount) || !['light', 'deep', 'full'].includes(reach)) throw new NexusError('INVALID_ARGUMENT', '召回 amount 或 reach 无效');
      const permitted = scopedSessions(await sessions(), await sources(), params, services.workspaceRoot);
      const candidates = permitted.flatMap(session => session.turns.map(turn => ({ session, turn })));
      const scanLimit = reach === 'light' ? 40 : reach === 'deep' ? 2_000 : candidates.length;
      const tokenBudget = limitOf(params.maxTokens, amount === 'lean' ? 1_024 : amount === 'standard' ? 4_096 : 12_288, 32_768);
      if (reach === 'full' && params.maxCandidates !== undefined && candidates.length > Number(params.maxCandidates)) {
        throw new NexusError('CTX-BUDGET-EXCEEDED', '全部召回候选超过本次明确上限', { candidates: candidates.length, maxCandidates: params.maxCandidates, modelCalls: 0 });
      }
      const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const ranked = candidates.slice(-scanLimit).map(candidate => {
        const text = `${candidate.turn.question}\n${candidate.turn.answer}`;
        const lower = text.toLocaleLowerCase();
        return { ...candidate, text, score: terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0) };
      }).filter(candidate => !terms.length || candidate.score > 0).sort((a, b) => b.score - a.score || (b.turn.timestamp ?? '').localeCompare(a.turn.timestamp ?? ''));
      let used = 0;
      const included: JsonRecord[] = [], excluded: JsonRecord[] = [];
      for (const candidate of ranked) {
        const estimatedTokens = Math.ceil(Buffer.byteLength(candidate.text) / 4);
        const ref = { sourceId: candidate.session.sourceId, sessionId: candidate.session.id, turnId: candidate.turn.id,
          revision: candidate.session.revision, contentHash: candidate.turn.contentHash, binding: 'pinned', kind: 'session' };
        if (used + estimatedTokens > tokenBudget) { excluded.push({ source: ref, reason: '最终上下文 token 预算不足', estimatedTokens }); continue; }
        used += estimatedTokens;
        included.push({ text: candidate.text, source: ref, estimatedTokens, score: candidate.score, reason: '精确词匹配规则', cost: { modelCalls: 0, money: null } });
      }
      return { query, amount, reach, candidatesAvailable: candidates.length, scanned: Math.min(scanLimit, candidates.length),
        estimatedTokens: used, tokenBudget, included, excluded, decision: { method: 'deterministic-exact-match', calibrated: false }, modelCalls: 0 };
    }
    if (action === 'topic.list') return (await services.store.list(TOPIC_COLLECTION)).map(record => ({ ...(record.value as JsonRecord), revision: record.revision }));
    if (action === 'topic.upsert') {
      const id = string(params.id, randomUUID()), previous = await services.store.get<JsonRecord>(TOPIC_COLLECTION, id);
      const title = string(params.title);
      if (!title.trim()) throw new NexusError('INVALID_ARGUMENT', '主题名称不能为空');
      const topic = { ...previous?.value, schemaVersion: 1, id, title, query: string(params.query, title),
        sessionIds: Array.isArray(params.sessionIds) ? params.sessionIds : previous?.value.sessionIds ?? [],
        userEdits: string(params.userEdits, string(previous?.value.userEdits)), updatedAt: new Date().toISOString() };
      return services.store.put(TOPIC_COLLECTION, id, topic, request.expectedRevision ?? previous?.revision ?? 0);
    }
    if (action === 'topic.dossier') {
      const id = string(params.id, string(params.topicId)), previous = await services.store.get<JsonRecord>(TOPIC_COLLECTION, id);
      if (!previous) throw new NexusError('NOT_FOUND', '主题不存在');
      const permitted = scopedSessions(await sessions(), await sources(), params, services.workspaceRoot);
      const ids = previous.value.sessionIds as string[];
      const evidence = permitted.filter(session => !ids.length || ids.includes(session.id))
        .flatMap(session => session.turns.map(turn => ({ label: `S${sha256(`${session.id}:${turn.id}`).slice(0, 10)}`, sessionId: session.id, turn })));
      const maxTokens = limitOf(params.maxInputTokens, 16_384, 64_000);
      const input = evidence.map(item => `[${item.label}] ${item.turn.question}\n${item.turn.answer}`).join('\n\n');
      if (Math.ceil(Buffer.byteLength(input) / 4) > maxTokens) throw new NexusError('CTX-BUDGET-EXCEEDED', '主题证据超过本次输入预算，请缩小会话选择');
      const result = await services.host.model({ role: 'dossier', prompt: `主题：${previous.value.title}\n只根据以下证据生成中文 dossier，分为“是什么、决定、当前状态、未决”。每一非空内容行末尾必须包含 [S编号] 引用。不要编造引用。\n${input}`,
        provider: string(params.provider) || undefined, model: string(params.model) || undefined, signal: context?.signal ?? services.signal,
        logicalCallId: `dossier:${id}:${previous.revision}`, attemptId: randomUUID(), maxTokens: limitOf(params.maxTokens, 4_096, 16_384) });
      const allowed = new Set(evidence.map(item => item.label));
      const lines = result.text.split('\n').map(text => {
        const citations = [...text.matchAll(/\[(S[0-9a-f]+)\]/g)].map(match => match[1]);
        const invalid = citations.filter(label => !allowed.has(label));
        return { text, citations, supported: !text.trim() || text.trim().startsWith('#') || citations.length > 0 && !invalid.length, invalid };
      });
      const latest = await services.store.get<JsonRecord>(TOPIC_COLLECTION, id);
      const dossier = { text: result.text, lines, citations: evidence.map(({ label, sessionId, turn }) => ({ label, sessionId, turnId: turn.id, contentHash: turn.contentHash })),
        generatedAt: new Date().toISOString(), provider: result.provider, model: result.model, usage: result.usage, userEdits: previous.value.userEdits };
      if (latest?.revision !== previous.revision) {
        const conflict = await services.store.put('graph-dossier-conflicts', randomUUID(), { topicId: id, expectedRevision: previous.revision, dossier });
        return { conflict: true, candidateId: conflict.id, dossier, message: '主题在生成期间已修改，保留候选和用户编辑' };
      }
      await services.store.put(TOPIC_COLLECTION, id, { ...previous.value, dossier, priorDossier: previous.value.dossier }, previous.revision);
      return dossier;
    }
    throw new NexusError('UNKNOWN_ACTION', `不支持的历史动作：${action}`);
  };
  return { dispatch, sources, sessions, sessionById, async dispose() {
    disposed = true;
    for (const controller of scanControllers.values()) controller.abort();
    for (const id of [...watchers.keys()]) stopWatch(id);
    await Promise.allSettled([...sourceScans.values()]);
  } };
}
