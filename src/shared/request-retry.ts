/** Same-step recovery; counts exclude the original model request. */
export const REQUEST_RETRY_FEATURE = 'request-retry';
export const REQUEST_RETRY_DEFAULTS = Object.freeze({
  mode: 'custom' as const,
  maxRetries: 64,
  algorithm: 'exponential' as const,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitterRatio: 0.1,
  // Retained for reading older settings. Error eligibility is no longer gated
  // by this flag; all failed requests use the selected retry budget.
  retryOpaqueProviderErrors: true,
});
export interface RequestRetryOptions {
  mode: 'inherit' | 'custom' | 'disabled';
  maxRetries: number;
  algorithm: 'fixed' | 'linear' | 'exponential';
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
  retryOpaqueProviderErrors: boolean;
}

export function validateRequestRetryConfig(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '重试设置须为对象';
  const config = value as Record<string, any>;
  if (Object.keys(config).some(key => !['enabled', 'defaults'].includes(key))
    || config.enabled !== undefined && typeof config.enabled !== 'boolean') return '重试设置包含未知字段或无效启用状态';
  const defaults = config.defaults ?? {};
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)
    || Object.keys(defaults).some(key => !Object.hasOwn(REQUEST_RETRY_DEFAULTS, key))) return '重试设置包含未知字段';
  if (defaults.mode !== undefined && !['inherit', 'custom', 'disabled'].includes(defaults.mode)) return '重试模式无效';
  if (defaults.algorithm !== undefined && !['fixed', 'linear', 'exponential'].includes(defaults.algorithm)) return '重试间隔算法无效';
  if (defaults.maxRetries !== undefined && (!Number.isSafeInteger(defaults.maxRetries)
    || defaults.maxRetries < 0 || defaults.maxRetries > 100)) return '重试次数须为0–100的整数';
  for (const key of ['initialDelayMs', 'maxDelayMs']) {
    if (defaults[key] !== undefined && (!Number.isSafeInteger(defaults[key]) || defaults[key] < 0
      || defaults[key] > 86_400_000)) return '重试间隔须为0–86400000毫秒的整数';
  }
  if (defaults.multiplier !== undefined && (typeof defaults.multiplier !== 'number'
    || !Number.isFinite(defaults.multiplier) || defaults.multiplier < 1 || defaults.multiplier > 10)) return '指数倍率须为1–10';
  if (defaults.jitterRatio !== undefined && (typeof defaults.jitterRatio !== 'number'
    || !Number.isFinite(defaults.jitterRatio) || defaults.jitterRatio < 0 || defaults.jitterRatio > 1)) return '随机抖动须为0–1';
  if (defaults.retryOpaqueProviderErrors !== undefined && typeof defaults.retryOpaqueProviderErrors !== 'boolean') return '适配器错误重试开关无效';
  // The complete inherited result is validated again at both save and use time.
  if (defaults.initialDelayMs !== undefined && defaults.maxDelayMs !== undefined
    && defaults.initialDelayMs > defaults.maxDelayMs) return '初始间隔不能大于间隔上限';
}

export function resolveRequestRetryOptions(value: unknown): RequestRetryOptions {
  const invalid = validateRequestRetryConfig(value);
  if (invalid) throw new Error(invalid);
  const config = value as Record<string, any>;
  const options: RequestRetryOptions = { ...REQUEST_RETRY_DEFAULTS, ...config.defaults };
  if (config.enabled === false) options.mode = 'disabled';
  if (options.initialDelayMs > options.maxDelayMs) throw new Error('初始间隔不能大于继承后的间隔上限');
  return options;
}

/** previous is the durable number of retries already scheduled for this step. */
export function requestRetryDelay(
  options: Pick<RequestRetryOptions, 'algorithm' | 'initialDelayMs' | 'maxDelayMs' | 'multiplier' | 'jitterRatio'>,
  previous: number,
  providerRetryAfterMs?: number,
  random = Math.random,
): number | undefined {
  if (Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs! > 0) {
    // The cap bounds our algorithm, not the provider's minimum wait. A long
    // Retry-After must not turn a transient error into a one-attempt stop.
    return providerRetryAfterMs! <= Number.MAX_SAFE_INTEGER ? Math.ceil(providerRetryAfterMs!) : undefined;
  }
  const factor = options.algorithm === 'fixed' ? 1 : options.algorithm === 'linear' ? previous + 1
    : options.multiplier ** Math.min(previous, 1024);
  const base = options.initialDelayMs === 0 ? 0 : Math.min(options.initialDelayMs * factor, options.maxDelayMs);
  return Math.round(Math.min(base * (1 - options.jitterRatio + 2 * options.jitterRatio * random()), options.maxDelayMs));
}
