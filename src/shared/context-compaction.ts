/** User-owned live scope overlays. Models can inspect, but never configure them. */
export const CONTEXT_COMPACTION_FEATURE = 'context-compaction';
export const SELF_COMPACTION_TOOL = 'compact_context';
export const CONTEXT_COMPACTION_DEFAULTS = Object.freeze({ enabled: true, thresholdPercent: 80 });
export interface ContextCompactionOptions {
  enabled: boolean; thresholdPercent: number;
  /** null explicitly follows the conversation; undefined inherits. */
  summaryModel?: { provider: string; model: string } | null;
}
export function validateContextCompactionConfig(value: unknown): string | undefined {
  const config = value as Record<string, any>;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return '压缩设置须为对象';
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') return '启用状态须为布尔值';
  const defaults = config.defaults ?? {};
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)
    || Object.keys(defaults).some(key => !['thresholdPercent', 'summaryModel'].includes(key))) return '压缩设置包含未知字段';
  if (defaults.thresholdPercent !== undefined && (!Number.isInteger(defaults.thresholdPercent)
    || defaults.thresholdPercent < 10 || defaults.thresholdPercent > 95)) return '自动压缩阈值须为10–95的整数百分比';
  const route = defaults.summaryModel;
  if (route !== undefined && route !== null && (!route || typeof route !== 'object' || Array.isArray(route)
    || Object.keys(route).some(key => !['provider', 'model'].includes(key))
    || ![route.provider, route.model].every(value => typeof value === 'string' && value.trim() && value.length <= 256))) return '压缩模型须同时指定准确provider/model，或选择跟随当前会话';
}
export function resolveContextCompactionOptions(value: unknown): ContextCompactionOptions {
  const invalid = validateContextCompactionConfig(value);
  if (invalid) throw new Error(invalid);
  const config = value as Record<string, any>;
  return { enabled: config.enabled !== false, thresholdPercent: config.defaults?.thresholdPercent ?? 80,
    summaryModel: config.defaults?.summaryModel ?? null };
}
