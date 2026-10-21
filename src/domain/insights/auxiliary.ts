import { NexusError, type DispatchContext, type JsonRecord, type ModelRequest, type ModelResult, type NexusServices } from '../../ports/contracts.js';
import { effectiveSettings } from '../scope.js';
import { workspaceIdentity } from '../workspace-runtime.js';
import { REFLECTION_SYSTEM } from './prompts.js';
import { redactString } from '../operations/index.js';
import { boundedRead } from '../../shared/bounded-read.js';

export interface AuxiliaryRoute { provider: string; model: string; reasoningEffort?: string }
export interface AuxiliaryAttempt extends AuxiliaryRoute { state: 'failed' | 'succeeded'; code?: string; reason?: string; retryAfterMs?: number }
export interface AuxiliaryChoice extends AuxiliaryRoute { code: string; efforts: string[]; highest: string | null; reasoningKnown: boolean; maxOutputTokens?: number }
export const AUXILIARY_DEFAULT_OUTPUT_TOKENS = 32768;
export const AUXILIARY_MAX_OUTPUT_TOKENS = 65536;
const object = (v: unknown): any => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const integer = (v: unknown, fallback: number, min: number, max: number) => Math.floor(Math.min(max, Math.max(min, Number(v) || fallback)));
export const AUXILIARY_CATALOG_TIMEOUT_MS = 8000;
const pendingCatalogs = new WeakMap<NexusServices, Promise<AuxiliaryChoice[]>>();

export async function auxiliaryCatalog(services: NexusServices, signal?: AbortSignal): Promise<AuxiliaryChoice[]> {
  if (signal?.aborted) throw new NexusError('CANCELLED', '辅助模型目录读取已取消');
  let pending = pendingCatalogs.get(services);
  if (!pending) {
    // The host enumerator may ignore cancellation. Keep its original promise
    // until it settles so explicit retries cannot pile up hung enumerations.
    pending = Promise.resolve().then(() => services.host.sessions('models/list', {})).then((result: any) => {
      if (!Array.isArray(result?.items)) throw new NexusError('AUXILIARY_CATALOG_INVALID', '宿主模型目录返回格式不兼容，请检查 Nexus 与宿主版本');
      return result.items.map((item: any): AuxiliaryChoice => {
        if (!item || typeof item.provider !== 'string' || !item.provider.trim()
          || typeof item.model !== 'string' || !item.model.trim()
          || item.capabilities?.reasoningEffort?.value !== undefined && (!Array.isArray(item.capabilities.reasoningEffort.value)
            || item.capabilities.reasoningEffort.value.some((effort: unknown) => typeof effort !== 'string'))) {
          throw new NexusError('AUXILIARY_CATALOG_INVALID', '宿主模型目录包含不兼容的型号或思考强度元数据');
        }
        return {
          provider: item.provider, model: item.model, code: typeof item.code === 'string' ? item.code : `${item.provider}/${item.model}`,
          efforts: item.capabilities?.reasoningEffort?.value ?? [],
          highest: typeof item.highestReasoningEffort === 'string' ? item.highestReasoningEffort : null,
          reasoningKnown: item.capabilities?.reasoningEffort?.state === 'declared',
          ...(item.capabilities?.maxOutputTokens?.state === 'declared' && Number.isSafeInteger(item.capabilities.maxOutputTokens.value)
            && item.capabilities.maxOutputTokens.value > 0 ? { maxOutputTokens: item.capabilities.maxOutputTokens.value } : {}),
        };
      });
    });
    pendingCatalogs.set(services, pending);
    const owned = pending;
    void pending.then(() => { if (pendingCatalogs.get(services) === owned) pendingCatalogs.delete(services); },
      () => { if (pendingCatalogs.get(services) === owned) pendingCatalogs.delete(services); });
  }
  return boundedRead(() => pending!, {
    signal, timeoutMs: AUXILIARY_CATALOG_TIMEOUT_MS,
    timeout: () => new NexusError('AUXILIARY_CATALOG_TIMEOUT', '宿主模型目录读取超过8秒；已保存设置继续可用。请重试目录，持续无响应时检查宿主模型提供方', {
      phase: 'auxiliary-catalog-read', catalogState: 'pending', timeoutMs: AUXILIARY_CATALOG_TIMEOUT_MS,
    }),
    cancelled: () => new NexusError('CANCELLED', '辅助模型目录读取已取消'),
  });
}
export async function auxiliarySettings(services: NexusServices, ctx: DispatchContext = {}) {
  const root = ctx.workspaceRoot ?? services.workspaceRoot;
  const inherited = await effectiveSettings(services.store, root, ctx, 'auxiliary');
  const defaults = object(inherited.effective.defaults);
  const legacySources: string[] = [];
  let routes: AuxiliaryRoute[] = Array.isArray(defaults.routes) ? defaults.routes : [];
  // Preserve previously explicit routes, but never manufacture one from the
  // live session. An explicit [] is an intentional unconfigured override.
  if (!Array.isArray(defaults.routes)) {
    for (const feature of ['insights', 'autonomy']) {
      const old = object((await effectiveSettings(services.store, root, ctx, feature)).effective.defaults);
      if (typeof old.provider === 'string' && old.provider.trim() && typeof old.model === 'string' && old.model.trim()) {
        const route = { provider: old.provider, model: old.model, ...(typeof old.reasoningEffort === 'string' && old.reasoningEffort.trim() ? { reasoningEffort: old.reasoningEffort } : {}) };
        if (!routes.some(r => r.provider === route.provider && r.model === route.model)) routes.push(route);
        legacySources.push(feature);
      }
    }
  }
  return { ...inherited, routes, legacySources,
    enabled: inherited.effective.enabled !== false,
    suggestions: defaults.suggestions !== false, reflection: defaults.reflection !== false,
    planningPrompt: defaults.planningPrompt !== false,
    reflectionSystem: typeof defaults.reflectionSystem === 'string' && defaults.reflectionSystem.trim() ? defaults.reflectionSystem : REFLECTION_SYSTEM,
    minIntervalMs: integer(defaults.minIntervalMs, 60000, 10000, 3600000),
    maxCallsPerDay: integer(defaults.maxCallsPerDay, 96, 1, 200),
    maxInputTokens: integer(defaults.maxInputTokens, 256000, 4000, 1000000),
    maxContextChars: integer(defaults.maxContextChars, 1000000, 20000, 4000000),
    maxChunks: integer(defaults.maxChunks, 48, 1, 128),
    maxOutputTokens: integer(defaults.maxOutputTokens, AUXILIARY_DEFAULT_OUTPUT_TOKENS, 512, AUXILIARY_MAX_OUTPUT_TOKENS),
    retentionDays: integer(defaults.retentionDays, 30, 1, 365) };
}
export async function validateAuxiliaryConfig(services: NexusServices, config: JsonRecord,
  options: { preservedRoutes?: AuxiliaryRoute[]; signal?: AbortSignal } = {}) {
  const d = object(config.defaults);
  const allowed = ['routes', 'suggestions', 'reflection', 'reflectionSystem', 'planningPrompt', 'minIntervalMs', 'maxCallsPerDay', 'maxInputTokens', 'maxContextChars', 'maxChunks', 'maxOutputTokens', 'retentionDays'];
  if (Object.keys(d).some(k => !allowed.includes(k))) throw new NexusError('INVALID_ARGUMENT', '辅助模型设置包含未知字段');
  for (const key of ['suggestions', 'reflection', 'planningPrompt']) if (d[key] !== undefined && typeof d[key] !== 'boolean') throw new NexusError('INVALID_ARGUMENT', `${key} 必须为布尔值`);
  if (d.reflectionSystem !== undefined && (typeof d.reflectionSystem !== 'string' || !d.reflectionSystem.trim() || d.reflectionSystem.length > 8000)) throw new NexusError('INVALID_ARGUMENT', '深层问题系统提示词须为1至8000字符');
  const ranges: Record<string, number[]> = { minIntervalMs: [10000, 3600000], maxCallsPerDay: [1, 200], maxInputTokens: [4000, 1000000], maxContextChars: [20000, 4000000], maxChunks: [1, 128], maxOutputTokens: [512, AUXILIARY_MAX_OUTPUT_TOKENS], retentionDays: [1, 365] };
  for (const [key, [min, max]] of Object.entries(ranges)) if (d[key] !== undefined && (!Number.isSafeInteger(d[key]) || d[key] < min || d[key] > max)) throw new NexusError('INVALID_ARGUMENT', `${key} 超出允许范围 ${min}–${max}`);
  if (d.routes === undefined) return;
  if (!Array.isArray(d.routes) || d.routes.length > 12) throw new NexusError('INVALID_ARGUMENT', '辅助模型路由最多12项');
  const seen = new Set<string>();
  for (const route of d.routes) {
    if (!route || typeof route !== 'object' || Array.isArray(route)
      || Object.keys(route).some(k => !['provider', 'model', 'reasoningEffort'].includes(k))
      || typeof route.provider !== 'string' || !route.provider.trim() || typeof route.model !== 'string' || !route.model.trim()
      || route.reasoningEffort !== undefined && typeof route.reasoningEffort !== 'string') throw new NexusError('INVALID_ARGUMENT', '辅助模型路由格式无效');
    const key = JSON.stringify([route.provider, route.model]);
    if (seen.has(key)) throw new NexusError('AUXILIARY_ROUTE_INVALID', '请选择当前宿主公布的不同模型，不能填写或保存未知型号', { provider: route.provider, model: route.model });
    seen.add(key);
  }
  const changed = d.routes.filter((route: AuxiliaryRoute) => !options.preservedRoutes?.some(saved =>
    saved.provider === route.provider && saved.model === route.model && saved.reasoningEffort === route.reasoningEffort));
  if (!changed.length) return;
  const catalog = await auxiliaryCatalog(services, options.signal);
  for (const route of changed) {
    const item = catalog.find(c => c.provider === route.provider && c.model === route.model);
    if (!item) throw new NexusError('AUXILIARY_ROUTE_INVALID', '请选择当前宿主公布的不同模型，不能填写或保存未知型号', { provider: route.provider, model: route.model });
    if (route.reasoningEffort !== undefined && !item.efforts.includes(route.reasoningEffort)) throw new NexusError('AUXILIARY_ROUTE_INVALID', 'reasoning_effort 不在该模型支持的目录中');
  }
}

/** Each failure advances once to the next explicitly chosen route. User
 * cancellation never retries. Authentication/format failures can fall back;
 * uncertain provider side effects are harmless here because tools are absent. */
export async function auxiliaryModel(services: NexusServices, ctx: DispatchContext, request: ModelRequest,
  options: { validate?: (text: string) => void; reserve?: () => Promise<void>; report?: (attempts: AuxiliaryAttempt[]) => Promise<void> } = {}): Promise<ModelResult & { attempts: AuxiliaryAttempt[] }> {
  const config = await auxiliarySettings(services, ctx);
  if (!config.enabled) throw new NexusError('AUXILIARY_DISABLED', '本范围已停用辅助模型');
  if (!config.routes.length) throw new NexusError('AUXILIARY_NOT_CONFIGURED', '尚未选择独立辅助模型；请在设置中选择模型与优先级，主任务继续运行');
  // UTF-8 bytes plus framing is deliberately a conservative upper bound for
  // byte-based tokenizers, not a claim to know a provider's private tokenizer.
  const inputBytes = new TextEncoder().encode(JSON.stringify({ system: request.system, prompt: request.prompt, messages: request.messages })).length + 512;
  if (inputBytes > config.maxInputTokens) throw new NexusError('AUXILIARY_INPUT_BUDGET', '完整请求（含系统提示词和覆盖说明）的保守输入预算超限；未截断材料或请求模型', { conservativeInputUnits: inputBytes, maxInputTokens: config.maxInputTokens });
  const catalog = await auxiliaryCatalog(services, request.signal ?? ctx.signal), attempts: AuxiliaryAttempt[] = [];
  const reserveBudget = async () => {
    const id = `${workspaceIdentity(ctx.workspaceRoot ?? services.workspaceRoot)}/${ctx.sessionId ?? 'global'}/${new Date().toISOString().slice(0, 10)}`;
    for (let race = 0; race < 5; race++) {
      request.signal?.throwIfAborted();
      const row = await services.store.get<{ calls: number }>('auxiliary-call-budget', id);
      const calls = row?.value.calls ?? 0;
      if (calls >= config.maxCallsPerDay) throw new NexusError('AUXILIARY_BUDGET_EXHAUSTED', '本范围今日独立辅助模型请求预算已用尽');
      try { await services.store.put('auxiliary-call-budget', id, { calls: calls + 1 }, row?.revision ?? 0); return; }
      catch (error) { if (!(error instanceof NexusError) || error.code !== 'REVISION_CONFLICT' || race === 4) throw error; }
    }
  };
  for (const [index, route] of config.routes.entries()) {
    request.signal?.throwIfAborted();
    try {
      const item = catalog.find(c => c.provider === route.provider && c.model === route.model);
      if (!item || route.reasoningEffort !== undefined && !item.efforts.includes(route.reasoningEffort)) throw new NexusError('AUXILIARY_ROUTE_INVALID', '所选模型已不在宿主目录中或思考强度不受支持');
      if (!item.reasoningKnown) throw new NexusError('AUXILIARY_METADATA_UNAVAILABLE', '模型思考强度元数据不可用，无法确定最高支持值');
      await reserveBudget();
      await options.reserve?.();
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new NexusError('TIMEOUT', '辅助模型调用超过45秒')), 45000);
      let result: ModelResult;
      const callSignal = AbortSignal.any([timeout.signal, ...(request.signal ? [request.signal] : [])]);
      let abortCall = () => {};
      try {
        const cancelled = new Promise<never>((_, reject) => {
          abortCall = () => reject(callSignal.reason);
          callSignal.addEventListener('abort', abortCall, { once: true });
          if (callSignal.aborted) abortCall();
        });
        result = await Promise.race([services.host.model({ ...request, ...route, independentRoute: true,
          reasoningEffort: route.reasoningEffort ?? item.highest ?? undefined,
          // DeepSeek's Messages max_tokens also bounds thinking. Keep a
          // caller's explicit lower limit, and respect the published route cap.
          maxTokens: Math.min(request.maxTokens ?? config.maxOutputTokens, config.maxOutputTokens, item.maxOutputTokens ?? Infinity),
          signal: callSignal,
          logicalCallId: `${request.logicalCallId ?? 'auxiliary'}:route:${index}`, readOnly: true, allowChildren: false }), cancelled]);
      } finally { clearTimeout(timer); callSignal.removeEventListener('abort', abortCall); }
      request.signal?.throwIfAborted();
      options.validate?.(result.text);
      attempts.push({ ...route, reasoningEffort: route.reasoningEffort ?? item.highest ?? undefined, state: 'succeeded' });
      await options.report?.([...attempts]);
      return { ...result, attempts };
    } catch (error) {
      request.signal?.throwIfAborted();
      const failure = error instanceof NexusError ? error : new NexusError('AUXILIARY_FAILED', error instanceof Error ? error.message : '辅助请求失败');
      const details = object(failure.details);
      attempts.push({ ...route, state: 'failed', code: failure.code, reason: redactString(failure.message, 500),
        ...(Number.isFinite(details.providerRetryAfterMs) ? { retryAfterMs: details.providerRetryAfterMs } : {}) });
      await options.report?.([...attempts]);
      if (failure.code === 'AUXILIARY_BUDGET_EXHAUSTED') break;
      if (index < config.routes.length - 1) {
        const delay = Math.min(3000, Math.max(250 * 2 ** index, Number(details.providerRetryAfterMs) || 0));
        await new Promise<void>((resolve, reject) => {
          const aborted = () => { clearTimeout(timer); reject(request.signal?.reason); };
          const timer = setTimeout(() => { request.signal?.removeEventListener('abort', aborted); resolve(); }, delay);
          request.signal?.addEventListener('abort', aborted, { once: true });
          if (request.signal?.aborted) aborted();
        });
      }
    }
  }
  throw new NexusError('AUXILIARY_ROUTES_EXHAUSTED', '全部独立辅助模型均失败；主任务继续，辅助结果需显式重试', { attempts });
}
