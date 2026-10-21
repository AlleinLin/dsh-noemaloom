import { createHash } from 'node:crypto';
import type { PhysicalUsage } from './types.js';

export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function walk(input: unknown): unknown {
    if (input === null || typeof input !== 'object') {
      if (typeof input === 'number' && !Number.isFinite(input)) throw new Error('非有限 JSON 数值');
      return input;
    }
    if (seen.has(input)) throw new Error('循环 JSON 对象');
    seen.add(input);
    const result = Array.isArray(input)
      ? input.map(walk)
      : Object.fromEntries(Object.keys(input).sort().filter(k => (input as Record<string, unknown>)[k] !== undefined)
        .map(k => [k, walk((input as Record<string, unknown>)[k])]));
    seen.delete(input);
    return result;
  }
  return JSON.stringify(walk(value));
}
export const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
export const hashObject = (value: unknown): string => sha256(canonicalJson(value));
export function compareBytes(before: string, after: string) {
  const a = Buffer.from(before, 'utf8');
  const b = Buffer.from(after, 'utf8');
  let same = 0;
  while (same < Math.min(a.length, b.length) && a[same] === b[same]) same++;
  return { prefixBytes: same, firstDifference: same === a.length && same === b.length ? null : same };
}

/** Physical accounting only. Missing provider fields remain null, never invented zeroes. */
export function normalizePhysicalUsage(raw: unknown, protocol?: string): PhysicalUsage {
  const empty: PhysicalUsage = {
    state: 'missing', totalInputTokens: null, uncachedInputTokens: null, cacheReadTokens: null,
    cacheWriteTokens: null, outputTokens: null, evidence: 'unobserved',
    semanticsVersion: 'nexus-physical-v1', errors: [],
  };
  if (!raw || typeof raw !== 'object') return empty;
  const u = raw as Record<string, unknown>;
  if (typeof u.state === 'string' && 'totalInputTokens' in u && 'cacheReadTokens' in u) {
    // Accept the one shared usage-ledger normalizer without interpreting its
    // already-normalized total as Anthropic's exclusive input_tokens again.
    protocol = 'normalized';
  }
  const details = (u.prompt_tokens_details ?? u.input_tokens_details ?? {}) as Record<string, unknown>;
  const read = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = u[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
        empty.errors.push(`${key}: 期望非负整数`);
        return null;
      }
      return value;
    }
    return null;
  };
  const nested = (value: unknown, key: string): number | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      empty.errors.push(`${key}: 期望非负整数`);
      return null;
    }
    return value;
  };
  const output = read('output_tokens', 'completion_tokens', 'outputTokens');
  const cached = read('cache_read_input_tokens', 'prompt_cache_hit_tokens', 'cacheReadTokens')
    ?? nested(details.cached_tokens, 'cached_tokens');
  const writes = read('cache_creation_input_tokens', 'cacheWriteTokens');
  const explicitUncached = read('prompt_cache_miss_tokens', 'uncachedInputTokens');
  const dshNormalized = protocol !== 'normalized' && 'inputTokens' in u && !('prompt_tokens' in u) && !('input_tokens' in u);
  const anthropic = protocol !== 'normalized' && (protocol === 'anthropic' || 'cache_creation_input_tokens' in u || 'cache_read_input_tokens' in u);
  const reportedInput = read('prompt_tokens', 'input_tokens', 'inputTokens', 'totalInputTokens');
  let total = reportedInput;
  let uncached = explicitUncached;
  if ((anthropic || dshNormalized) && reportedInput !== null) {
    // Anthropic input_tokens excludes the read AND creation cache buckets.
    uncached ??= reportedInput;
    total = cached !== null && writes !== null ? reportedInput + cached + writes : null;
  } else if (total !== null && uncached === null && cached !== null) {
    uncached = total - cached - (writes ?? 0);
  } else if (total === null && uncached !== null && cached !== null) {
    total = uncached + cached + (writes ?? 0);
  }
  if (total !== null && cached !== null && cached > total) empty.errors.push('cacheReadTokens 大于 totalInputTokens');
  if (uncached !== null && uncached < 0) empty.errors.push('缓存桶超过总输入');
  if (total !== null && uncached !== null && cached !== null
      && total !== uncached + cached + (writes ?? 0)) empty.errors.push('输入桶不能闭合');
  const known = [total, cached, writes, output, uncached].some(v => v !== null);
  return {
    ...empty, state: empty.errors.length ? 'invalid' : !known ? 'missing'
      : total === null || cached === null ? 'ambiguous' : 'valid',
    totalInputTokens: total, uncachedInputTokens: uncached, cacheReadTokens: cached,
    cacheWriteTokens: writes, outputTokens: output,
    evidence: known ? protocol === 'normalized' || dshNormalized ? 'host-normalized' : 'provider-reported' : 'unobserved',
  };
}

export interface CachePlannerInput {
  contextTokens: number;
  hardWindowTokens: number;
  outputReserveTokens: number;
  removableTokens: number;
  summaryTokens: number;
  expectedFutureCalls?: number;
  cacheReadPrice?: number;
  inputPrice?: number;
  outputPrice?: number;
  cacheWritePrice?: number;
  firstDivergenceTokens?: number;
  retrievalExpectedTokens?: number;
}
/** A decision aid; the model still selects exact consumed ranges and summary content. */
export function planFold(input: CachePlannerInput) {
  const mandatory = input.contextTokens + input.outputReserveTokens >= input.hardWindowTokens;
  const calls = input.expectedFutureCalls;
  const removed = Math.max(0, input.removableTokens - input.summaryTokens);
  const repayment = Math.max(0, input.contextTokens - (input.firstDivergenceTokens ?? 0) - input.removableTokens + input.summaryTokens);
  const known = [calls, input.cacheReadPrice, input.inputPrice, input.outputPrice].every(v => v !== undefined && Number.isFinite(v) && v >= 0);
  const warmPrice = input.cacheReadPrice ?? 0;
  const rewritePrice = input.cacheWritePrice ?? input.inputPrice ?? 0;
  const oneTime = known ? repayment * Math.max(0, rewritePrice - warmPrice)
    + input.summaryTokens * (input.outputPrice ?? 0)
    + (input.retrievalExpectedTokens ?? 0) * (input.inputPrice ?? 0) : null;
  const futureSaving = known ? removed * warmPrice * (calls ?? 0) : null;
  return {
    decision: mandatory ? 'compress-required' : known && oneTime !== null && futureSaving !== null
      ? futureSaving > oneTime ? 'compress-beneficial' : 'wait' : 'model-discretion',
    reason: mandatory ? '窗口安全优先' : known ? '比较摘要、重预热、检索和未来调用估计' : '价格或未来调用未知，保留模型自治',
    mandatory, estimatedRemovedTokens: removed, estimatedRepaymentTokens: repayment,
    estimatedOneTimeCost: oneTime, estimatedFutureSaving: futureSaving,
    breakevenCalls: known && removed * warmPrice > 0 && oneTime !== null ? oneTime / (removed * warmPrice) : null,
    evidence: 'local-estimated',
  };
}
