import { createHash, randomUUID } from 'node:crypto';
import { NexusError, recordParams, requiredString, type NexusModule, type NexusServices, type JsonRecord } from '../../ports/contracts.js';
import { publicUrl, safeRequest } from './network.js';
import { localSearch } from './local.js';

type ProviderId = 'keenable' | 'exa' | 'tavily';
interface Config extends JsonRecord { id: ProviderId; credentialRef: string; enabled?: boolean; }
interface Health { state: 'healthy' | 'cooldown' | 'unauthorized'; failures: number; until: number; active: number; }
const providerIds: ProviderId[] = ['keenable', 'exa', 'tavily'];
const object = (input: unknown): JsonRecord => input && typeof input === 'object' && !Array.isArray(input) ? input as JsonRecord : {};
const array = (input: unknown): JsonRecord[] => Array.isArray(input) ? input.map(object) : [];
function bounded(value: unknown, defaultValue: number, min: number, max: number) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new NexusError('INVALID_ARGUMENT', `参数须为 ${min}–${max} 的整数`);
  return value;
}
export function createSearchModule(services: NexusServices): NexusModule {
  let next = 0;
  const health = new Map<ProviderId, Health>();
  async function configured() { return (await services.store.list<Config>('searchProviders')).filter(row => row.value.enabled !== false).map(row => row.value); }
  async function attempt(provider: Config, params: JsonRecord, fetchMode: boolean, signal: AbortSignal) {
    const state = health.get(provider.id) ?? { state: 'healthy' as const, failures: 0, until: 0, active: 0 };
    health.set(provider.id, state);
    if (state.until > Date.now() || state.active >= 2) throw new NexusError('PROVIDER_UNAVAILABLE', '供应商冷却或并发已满');
    const credential = await services.host.secret(provider.credentialRef);
    if (!credential) throw new NexusError('AUTH_REQUIRED', '搜索凭据尚未配置', { credentialRef: provider.credentialRef });
    const id = provider.id, query = String(params.query ?? ''), maxResults = Number(params.maxResults ?? 8), maxChars = Number(params.maxChars ?? 30000), timeRange = params.timeRange as string | undefined;
    const days: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
    let endpoint: string, body: JsonRecord = {}, method = 'POST';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (id === 'keenable') {
      headers['X-API-Key'] = credential;
      if (fetchMode) { const url = new URL('https://api.keenable.ai/v1/fetch'); url.searchParams.set('url', String(params.url)); url.searchParams.set('max_chars', String(maxChars)); if (params.live) url.searchParams.set('live', 'true'); endpoint = url.href; method = 'GET'; }
      else { endpoint = 'https://api.keenable.ai/v1/search'; body = { query, mode: 'realtime', ...(timeRange ? { published_after: ({ day: '1d', week: '7d', month: '1mo', year: '1y' } as Record<string, string>)[timeRange] } : {}) }; }
    } else if (id === 'exa') {
      headers['x-api-key'] = credential; endpoint = `https://api.exa.ai/${fetchMode ? 'contents' : 'search'}`;
      body = fetchMode ? { urls: [params.url], text: { maxCharacters: maxChars }, ...(params.live ? { maxAgeHours: 0 } : {}) } : { query, type: 'auto', numResults: maxResults, contents: { text: { maxCharacters: 3000 }, title: true }, ...(timeRange ? { startPublishedDate: new Date(Date.now() - days[timeRange]! * 86400_000).toISOString() } : {}) };
    } else {
      headers.authorization = `Bearer ${credential}`; endpoint = `https://api.tavily.com/${fetchMode ? 'extract' : 'search'}`;
      body = fetchMode ? { urls: [params.url], extract_depth: 'advanced', format: 'markdown' } : { query, max_results: maxResults, search_depth: 'advanced', ...(timeRange ? { time_range: timeRange } : {}) };
    }
    state.active++;
    try {
      const response = await safeRequest(endpoint, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined, signal, timeoutMs: 15000, maxRedirects: 0 });
      let json: JsonRecord; try { json = object(JSON.parse(response.body)); } catch { throw new NexusError('PROVIDER_INVALID_RESPONSE', '供应商返回非 JSON'); }
      state.failures = 0; state.state = 'healthy'; state.until = 0;
      const fetchedAt = new Date().toISOString();
      const safeResultUrl = (value: unknown): string => {
        try { const url = new URL(String(value ?? '')); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
      };
      if (fetchMode) {
        const item = id === 'keenable' ? json : array(json.results)[0];
        if (!item) throw new NexusError('PROVIDER_INVALID_RESPONSE', '供应商未返回可读正文');
        const returnedUrl = safeResultUrl(item.url ?? params.url);
        await publicUrl(returnedUrl);
        return { provider: id, fetchedAt, url: returnedUrl, title: typeof item.title === 'string' ? item.title : undefined, content: String(item.content ?? item.text ?? item.raw_content ?? '').slice(0, maxChars), networkEvidence: 'provider-mediated', liveApplied: params.live === true && id !== 'tavily', untrusted: true };
      }
      const items = array(json.results).slice(0, maxResults).map(item => {
        const url = safeResultUrl(item.url), title = typeof item.title === 'string' ? item.title : undefined, snippet = String(item.snippet ?? item.description ?? item.text ?? item.content ?? '').slice(0, 6000);
        return { title, url, snippet, ...(typeof (item.published_at ?? item.publishedDate) === 'string' ? { publishedAt: item.published_at ?? item.publishedDate } : {}), provider: id, fetchedAt, citationId: createHash('sha256').update(`${id}\0${url}\0${snippet}`).digest('hex').slice(0, 24) };
      }).filter(item => item.url);
      return { provider: id, fetchedAt, items, timeFilter: { requested: timeRange ?? null, applied: timeRange ?? null, precision: timeRange ? 'approximate' : null }, untrusted: true };
    } catch (error) {
      state.failures++; const code = error instanceof NexusError ? error.code : 'NETWORK_ERROR';
      state.state = code === 'AUTH_REQUIRED' ? 'unauthorized' : 'cooldown';
      const retry = error instanceof NexusError ? object(error.details).retryAfter : undefined;
      const seconds = typeof retry === 'string' && /^\d+$/.test(retry) ? Number(retry) : Math.min(300, 2 ** state.failures);
      state.until = Date.now() + seconds * 1000; throw error;
    } finally { state.active--; }
  }
  return {
    id: 'search', capabilities: ['query', 'fetch', 'configure', 'status'].map(action => ({ action,
      description: action === 'query' ? '搜索：mode=local 按当前范围检索会话可见正文、文件、任务、记忆及资源，不联网；mode=web 或省略时使用已配置联网供应商。type 仅适用于 local；不支持 semantic。' : `联网搜索 ${action}`,
      mutating: action === 'configure' })),
    async dispatch(request, context) {
      const params = recordParams(request);
      if (request.action === 'query' && params.mode === 'local') return localSearch(services, params, context);
      if (request.action === 'query' && params.mode !== undefined && params.mode !== 'web') throw new NexusError('SEARCH_MODE_UNAVAILABLE', '搜索仅支持 local 或 web，未切换到其他搜索方式');
      if (request.action === 'configure') {
        const id = requiredString(params, 'id') as ProviderId;
        if (!providerIds.includes(id)) throw new NexusError('INVALID_ARGUMENT', '搜索仅支持 Keenable/Exa/Tavily');
        const credentialRef = requiredString(params, 'credentialRef');
        return services.store.put<Config>('searchProviders', id, { id, credentialRef, enabled: params.enabled !== false }, request.expectedRevision);
      }
      const configs = await configured();
      if (request.action === 'status') return { configured: await Promise.all(configs.map(async row => ({ id: row.id, credentialRef: row.credentialRef, configured: Boolean(await services.host.secret(row.credentialRef)), health: health.get(row.id) ?? { state: 'unknown' } }))), available: configs.length > 0 };
      if (request.action !== 'query' && request.action !== 'fetch') throw new NexusError('ACTION_NOT_FOUND', '未知搜索操作');
      const fetchMode = request.action === 'fetch';
      if (fetchMode) { await publicUrl(requiredString(params, 'url')); bounded(params.maxChars, 30000, 1, 50000); if (params.live !== undefined && typeof params.live !== 'boolean') throw new NexusError('INVALID_ARGUMENT', 'live 必须为布尔'); }
      else { const query = requiredString(params, 'query'); if (query.length > 4096) throw new NexusError('INVALID_ARGUMENT', 'query 最大4096字符'); bounded(params.maxResults, 8, 1, 20); if (params.timeRange !== undefined && !['day', 'week', 'month', 'year'].includes(String(params.timeRange))) throw new NexusError('INVALID_ARGUMENT', 'timeRange 无效'); }
      const policy = params.providerPolicy ?? 'balanced';
      if (!['balanced', 'preferred', 'all'].includes(String(policy))) throw new NexusError('INVALID_ARGUMENT', 'providerPolicy 无效');
      if (!configs.length) throw new NexusError('SEARCH_UNCONFIGURED', '尚未配置搜索供应商，请在连接设置配置凭据引用', { providers: providerIds });
      const cacheKey = createHash('sha256').update(JSON.stringify({ action: request.action, params, providers: configs.map(row => row.id) })).digest('hex');
      const cached = await services.store.get<JsonRecord>('searchCache', cacheKey);
      if (params.live !== true && cached && Date.now() - Number(cached.value.cachedAt) < 120000) return { ...cached.value.result as JsonRecord, cacheSource: 'local', ageMs: Date.now() - Number(cached.value.cachedAt) };
      const controller = new AbortController(), combined = AbortSignal.any([controller.signal, ...(context?.signal ? [context.signal] : []), ...(services.signal ? [services.signal] : [])]);
      const timeout = setTimeout(() => controller.abort(new NexusError('TIMEOUT', '搜索全局45秒截止')), 45000);
      const start = next++ % configs.length, ordered = policy === 'preferred' ? configs : configs.slice(start).concat(configs.slice(0, start));
      const failures: JsonRecord[] = [], successes: JsonRecord[] = [];
      try {
        for (const config of ordered) {
          combined.throwIfAborted();
          try { successes.push(await attempt(config, params, fetchMode, combined)); if (policy !== 'all') break; }
          catch (error) { if (combined.aborted) throw combined.reason; const code = error instanceof NexusError ? error.code : 'NETWORK_ERROR'; if (['PERMISSION_DENIED', 'INVALID_ARGUMENT', 'BUDGET_EXHAUSTED'].includes(code)) throw error; failures.push({ provider: config.id, code }); }
        }
        if (!successes.length) throw new NexusError('CTX-SEARCH-ALL-FAILED', '所有已配置搜索供应商均失败', { failures });
        const result = fetchMode ? { ...successes[0], partial: failures.length > 0, failures } : { items: successes.flatMap(row => Array.isArray(row.items) ? row.items : []), providers: successes.map(row => row.provider), failures, partial: failures.length > 0, timeFilters: successes.map(row => row.timeFilter), artifactId: randomUUID() };
        await services.store.put('searchCache', cacheKey, { cachedAt: Date.now(), result }, cached?.revision ?? 0);
        return { ...result, cacheSource: 'network', ageMs: 0 };
      } finally { clearTimeout(timeout); }
    },
  };
}
