import type { JsonRecord } from '../../ports/contracts.js';

export interface NormalizedUsage {
  status: 'reported' | 'unreported' | 'invalid';
  source: 'provider' | 'host-normalized' | 'none';
  uncachedInputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWriteByTtl: { ttl: string; tokens: number }[] | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  providerPromptTotal: number | null;
  providerTotal: number | null;
  isFinal: boolean;
  receivedAt: string;
  rawUsageSchemaId: string | null;
  warnings: string[];
}

const record = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};

export function normalizeUsage(raw: unknown, provider = '', source?: string, isFinal = true): NormalizedUsage {
  const body = record(raw), warnings: string[] = [];
  const result: NormalizedUsage = { status: Object.keys(body).length ? 'reported' : 'unreported', source: Object.keys(body).length ? 'provider' : 'none', uncachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, cacheWriteByTtl: null, outputTokens: null, reasoningTokens: null, providerPromptTotal: null, providerTotal: null, isFinal, receivedAt: new Date().toISOString(), rawUsageSchemaId: null, warnings };
  function count(value: unknown, label: string): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) { warnings.push(`invalid:${label}`); result.status = 'invalid'; return null; }
    return value;
  }
  if (['reported', 'unreported', 'invalid'].includes(String(body.status)) && 'uncachedInputTokens' in body) {
    result.status = body.status as NormalizedUsage['status'];
    result.source = body.source === 'host-normalized' ? 'host-normalized' : 'provider';
    for (const field of ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'providerPromptTotal', 'providerTotal'] as const) result[field] = count(body[field], field);
    result.rawUsageSchemaId = String(body.rawUsageSchemaId ?? 'nexus.normalized.v1');
    if (Array.isArray(body.warnings)) warnings.push(...body.warnings.filter(value => typeof value === 'string') as string[]);
  } else if (source === 'host-normalized' || 'inputTokens' in body || 'cacheReadTokens' in body || 'cacheRead' in body) {
    result.source = 'host-normalized'; result.rawUsageSchemaId = 'dsh.token-usage.v1';
    result.uncachedInputTokens = count(body.inputTokens ?? body.input, 'inputTokens');
    result.cacheReadTokens = count(body.cacheReadTokens ?? body.cacheRead, 'cacheReadTokens');
    result.cacheWriteTokens = count(body.cacheWriteTokens ?? body.cacheWrite, 'cacheWriteTokens');
    result.outputTokens = count(body.outputTokens ?? body.output, 'outputTokens');
    result.reasoningTokens = count(body.reasoningTokens ?? body.reasoning, 'reasoningTokens');
    result.providerTotal = count(body.totalTokens ?? body.total, 'totalTokens');
  } else if (/deepseek/i.test(provider) || 'prompt_cache_hit_tokens' in body || 'prompt_cache_miss_tokens' in body) {
    result.rawUsageSchemaId = 'deepseek.chat.v1';
    result.providerPromptTotal = count(body.prompt_tokens, 'prompt_tokens');
    result.cacheReadTokens = count(body.prompt_cache_hit_tokens ?? record(body.prompt_tokens_details).cached_tokens, 'prompt_cache_hit_tokens');
    const cachedAlias = count(record(body.prompt_tokens_details).cached_tokens, 'cached_tokens');
    if (body.prompt_cache_hit_tokens !== undefined && cachedAlias !== null && result.cacheReadTokens !== cachedAlias) { result.status = 'invalid'; warnings.push('invalid:cache-read-alias-conflict'); }
    result.uncachedInputTokens = count(body.prompt_cache_miss_tokens, 'prompt_cache_miss_tokens');
    if (result.uncachedInputTokens === null && result.providerPromptTotal !== null && result.cacheReadTokens !== null) result.uncachedInputTokens = result.providerPromptTotal - result.cacheReadTokens;
    result.cacheWriteTokens = 0;
    result.outputTokens = count(body.completion_tokens, 'completion_tokens');
    result.reasoningTokens = count(record(body.completion_tokens_details).reasoning_tokens, 'reasoning_tokens');
    result.providerTotal = count(body.total_tokens, 'total_tokens');
  } else if (/anthropic|claude/i.test(provider) || 'cache_creation_input_tokens' in body || 'cache_read_input_tokens' in body) {
    result.rawUsageSchemaId = 'anthropic.messages.v1';
    result.uncachedInputTokens = count(body.input_tokens, 'input_tokens');
    result.cacheReadTokens = count(body.cache_read_input_tokens ?? 0, 'cache_read_input_tokens');
    result.cacheWriteTokens = count(body.cache_creation_input_tokens ?? 0, 'cache_creation_input_tokens');
    result.outputTokens = count(body.output_tokens, 'output_tokens');
    const creation = record(body.cache_creation), ttl = [];
    for (const [field, label] of [['ephemeral_5m_input_tokens', '5m'], ['ephemeral_1h_input_tokens', '1h']] as const) { const tokens = count(creation[field], field); if (tokens !== null) ttl.push({ ttl: label, tokens }); }
    result.cacheWriteByTtl = ttl.length ? ttl : null;
  } else if ('prompt_tokens' in body || 'input_tokens' in body) {
    result.rawUsageSchemaId = 'openai.compatible.v1';
    result.providerPromptTotal = count(body.prompt_tokens ?? body.input_tokens, 'prompt_tokens');
    const detail = record(body.prompt_tokens_details ?? body.input_tokens_details);
    result.cacheReadTokens = count(detail.cached_tokens, 'cached_tokens');
    result.cacheWriteTokens = count(detail.cache_write_tokens, 'cache_write_tokens');
    result.outputTokens = count(body.completion_tokens ?? body.output_tokens, 'completion_tokens');
    result.reasoningTokens = count(record(body.completion_tokens_details ?? body.output_tokens_details).reasoning_tokens, 'reasoning_tokens');
    result.providerTotal = count(body.total_tokens, 'total_tokens');
    if (result.cacheReadTokens !== null && result.providerPromptTotal !== null) {
      // OpenAI cache-write is not a separately billed input bucket by this schema.
      if (result.cacheWriteTokens === null) result.cacheWriteTokens = 0;
      result.uncachedInputTokens = result.providerPromptTotal - result.cacheReadTokens - result.cacheWriteTokens;
    } else warnings.push('ambiguous:compatible-gateway-cache-semantics');
  } else if (Object.keys(body).length) { result.status = 'unreported'; warnings.push('ambiguous:unknown-schema'); }
  const buckets = [result.uncachedInputTokens, result.cacheReadTokens, result.cacheWriteTokens];
  if (buckets.some(value => value !== null && value < 0)) { result.status = 'invalid'; warnings.push('invalid:negative-bucket'); }
  const closed = buckets.every(value => value !== null);
  const totalPrompt = closed ? buckets.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  if (result.providerPromptTotal === null && totalPrompt !== null) result.providerPromptTotal = totalPrompt;
  if (totalPrompt !== null && result.providerPromptTotal !== null && totalPrompt !== result.providerPromptTotal) { result.status = 'invalid'; warnings.push('invalid:prompt-total'); }
  if (result.providerTotal !== null && totalPrompt !== null && result.outputTokens !== null && result.providerTotal !== totalPrompt + result.outputTokens) { result.status = 'invalid'; warnings.push('invalid:total-tokens'); }
  if (result.cacheWriteByTtl && result.cacheWriteByTtl.reduce((sum, row) => sum + row.tokens, 0) !== result.cacheWriteTokens) { result.status = 'invalid'; warnings.push('invalid:cache-write-ttl'); }
  if (result.reasoningTokens !== null && result.outputTokens !== null && result.reasoningTokens > result.outputTokens) { result.status = 'invalid'; warnings.push('invalid:reasoning-total'); }
  if (result.status === 'reported' && (!closed || result.outputTokens === null)) { result.status = 'unreported'; warnings.push('missing:complete-buckets'); }
  return result;
}
