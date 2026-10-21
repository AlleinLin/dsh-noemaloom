import { resolve } from 'node:path';
import { NexusError, type DispatchContext, type JsonRecord, type NexusServices } from '../../ports/contracts.js';

const TYPES = ['session', 'memory', 'file', 'task', 'resource'] as const;
const object = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const rows = (value: unknown): JsonRecord[] => {
  const source = Array.isArray(value) ? value : object(value).items;
  return Array.isArray(source) ? source.map(object).map(row => row.value ? { ...object(row.value), id: row.id } : row) : [];
};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const sameRoot = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
function visibleText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.filter(block => object(block).type === 'text').map(block => text(object(block).text)).join('\n');
}

/** Local queries never enter a search provider or model. Each source retains its
 * existing scope/permission checks; failures and bounded coverage stay visible. */
export async function localSearch(services: NexusServices, params: JsonRecord, context: DispatchContext = {}) {
  const query = text(params.query).trim(), type = params.type ?? 'all';
  if (!query || query.length > 4096) throw new NexusError('INVALID_ARGUMENT', 'query 需要 1–4096 字符');
  if (type !== 'all' && !TYPES.includes(type as typeof TYPES[number])) throw new NexusError('INVALID_ARGUMENT', '未知本地搜索类型');
  const limit = params.maxResults ?? 50;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new NexusError('INVALID_ARGUMENT', 'maxResults 需要 1–100 的整数');
  const root = context.workspaceRoot ?? services.workspaceRoot, needle = query.toLocaleLowerCase();
  const items: JsonRecord[] = [], coverage: JsonRecord[] = [];
  const matches = (value: string) => value.toLocaleLowerCase().includes(needle);
  const snippet = (value: string) => {
    const start = Math.max(0, value.toLocaleLowerCase().indexOf(needle) - 100);
    return value.slice(start, start + 600);
  };
  const invoke = (domain: string, action: string, values: JsonRecord = {}) =>
    services.invoke(domain, { action, params: values, limit: 100 }, context);
  for (const kind of TYPES.filter(kind => type === 'all' || type === kind)) {
    context.signal?.throwIfAborted(); services.signal?.throwIfAborted();
    try {
      let complete = true;
      let details: JsonRecord = {};
      if (kind === 'session') {
        const currentOnly = context.scopeLevel === 'session' || Boolean(context.sessionId && !context.scopeLevel);
        if (currentOnly && !context.sessionId) throw new NexusError('INVALID_ARGUMENT', '会话搜索缺少会话身份');
        const listed = currentOnly ? [{ id: context.sessionId! }]
          : rows(await services.host.sessions('list', context.scopeLevel === 'global' ? {} : { projectRoot: root }));
        const candidates = listed.filter(row => currentOnly || context.scopeLevel === 'global' || text(row.cwd) && sameRoot(text(row.cwd), root));
        complete = candidates.length <= 128;
        let characters = 0;
        for (const row of candidates.slice(0, 128)) {
          context.signal?.throwIfAborted();
          const id = text(row.sessionId ?? row.id);
          const snapshot = object(await services.host.sessions('snapshot', { sessionId: id }));
          if (snapshot.sessionId !== id && snapshot.id !== id) throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '搜索来源会话身份不匹配');
          if (context.scopeLevel !== 'global' && (!text(snapshot.cwd) || !sameRoot(text(snapshot.cwd), root))) throw new NexusError('SCOPE_MISMATCH', '搜索来源属于其他工作区');
          const events = Array.isArray(snapshot.events) ? snapshot.events.map(object) : undefined;
          if (!events) throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '宿主没有返回会话事件');
          if (events.length > 100000) { complete = false; continue; }
          const title = text(snapshot.title ?? row.title) || id;
          if (matches(title)) items.push({ id: `${id}:title`, sessionId: id, type: kind, title, snippet: title, domain: 'agents' });
          for (const event of events) {
            const data = object(event.data);
            const content = event.type === 'user/message' ? object(event.message).content ?? data.content
              : event.type === 'assistant/message' ? object(data.message).content ?? object(event.message).content
                : undefined;
            const body = visibleText(content);
            characters += body.length;
            if (characters > 16 * 1024 * 1024) { complete = false; break; }
            if (body && matches(body)) items.push({ id: `${id}:${event.seq}`, sessionId: id, seq: event.seq, type: kind, title, snippet: snippet(body), domain: 'agents' });
          }
          if (!complete && characters > 16 * 1024 * 1024) break;
        }
        details = { candidateSessions: candidates.length, sessionLimit: 128, textCharacterLimit: 16 * 1024 * 1024, content: 'user-and-assistant-text-only' };
      } else if (kind === 'file') {
        if (context.scopeLevel === 'global') { coverage.push({ type: kind, state: 'skipped', reason: '请选择工作区搜索文件' }); continue; }
        const result = object(await invoke('files', 'search', { query, mode: 'all', limit: 100 }));
        complete = !result.truncated && !result.mayOmit && !(Array.isArray(result.warnings) && result.warnings.length);
        details = { pageInfo: result.pageInfo, warnings: result.warnings };
        for (const row of rows(result)) items.push({ ...row, id: `file:${row.path}:${row.line ?? 0}`, title: row.path, type: kind, domain: 'files' });
      } else {
        if (kind === 'memory' && context.scopeLevel === 'global') { coverage.push({ type: kind, state: 'skipped', reason: '请选择工作区搜索本地记忆' }); continue; }
        const result = kind === 'task' ? await invoke('workflow', 'todo/list', { query, limit: 100 })
          : kind === 'memory' ? await invoke('memory', 'search', { query, mode: 'keyword', includeProviders: false, limit: 100 })
            : await invoke('resources', 'list', { query });
        const value = object(result);
        const loaded = rows(result);
        const errors = Array.isArray(value.errors) ? value.errors : [];
        const warnings = Array.isArray(value.warnings) ? value.warnings : [];
        complete = !value.cursor && !value.nextCursor && Number(value.hidden ?? 0) === 0 && !value.truncated
          && Number(value.total ?? loaded.length) <= loaded.length && !errors.length && !warnings.length;
        // Memory ranking intentionally caps each source. Its total is not a
        // count of every matching document, so do not present it as exhaustive.
        if (kind === 'memory') complete = false;
        details = { loaded: loaded.length, total: value.total, nextCursor: value.nextCursor, hidden: value.hidden,
          errors, warnings, ...(kind === 'memory' ? { sourceCoverage: value.sourceCoverage, boundedRanking: true } : {}) };
        for (const row of loaded) {
          const body = [row.title, row.name, row.content, row.body, row.summary, row.description].map(text).join('\n');
          if (matches(body)) items.push({ id: row.id, title: row.title ?? row.name ?? row.content ?? row.id, snippet: snippet(body), type: kind,
            domain: kind === 'task' ? 'workflow' : kind === 'memory' ? 'memory' : 'resources' });
        }
      }
      coverage.push({ type: kind, state: 'searched', complete, ...details });
    } catch (error) {
      if (context.signal?.aborted || services.signal?.aborted || type !== 'all') throw error;
      coverage.push({ type: kind, state: 'unavailable', code: error instanceof NexusError ? error.code : 'SOURCE_READ_FAILED' });
    }
  }
  return { items: items.slice(0, Number(limit)), totalMatched: items.length, truncated: items.length > Number(limit),
    modeUsed: 'local-keyword', networkUsed: false, coverage, complete: coverage.every(row => row.state === 'searched' && row.complete) && items.length <= Number(limit) };
}
