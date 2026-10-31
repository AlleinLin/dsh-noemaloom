import type { HostContext } from './types.js';

export const UTC_TIME_CONTEXT_NAME = 'nexus:utc-time';

const TIME_NAME_PATTERN = /(?:time|clock|date|datetime|timezone|time[-_]?zone)/iu;
const TIME_TEXT_PATTERN = /(?:\b(?:current|local|host|browser|client)\s+(?:date|time|clock|timezone|time\s*zone)\b|\btime\s*zone\b|\btimezone\b|\b(?:utc|gmt)\s*[+-]\s*\d{1,2}(?::?\d{2})?\b|\b(?:asia|america|europe|africa|pacific|australia)\/[A-Za-z_+-]+\b|当前时间|当前日期|本地时间|宿主时间|浏览器时间|客户端时间|客户端时区|本地时区|宿主时区|时区|北京时间)/iu;
const TIME_VARIABLE_PATTERN = /(?:time|clock|date|datetime|timezone|time[-_]?zone)/iu;

function contributionIsTimeSensitive(name: unknown, text: unknown): boolean {
  return typeof name === 'string'
    && name !== UTC_TIME_CONTEXT_NAME
    && (TIME_NAME_PATTERN.test(name) || (typeof text === 'string' && TIME_TEXT_PATTERN.test(text)));
}

function variableIsTimeSensitive(name: string): boolean {
  return TIME_VARIABLE_PATTERN.test(name) || TIME_TEXT_PATTERN.test(name);
}

/**
 * Stable model-facing clock contract. The only instant supplied here is an
 * RFC 3339 UTC value; no host, browser, or user timezone is disclosed.
 */
export function formatUtcModelContext(now = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new RangeError('UTC model context requires a valid Date');
  return [
    'Authoritative model clock: UTC/GMT.',
    `Current instant: ${now.toISOString()}`,
    'Use UTC/GMT as the only runtime clock for dates, times, deadlines, and schedules.',
    'Do not infer, request, or reveal the host, browser, user, or local time zone.',
    'For a requested civil clock such as Beijing time, calculate from the UTC instant arithmetically and present the requested wall-clock value without a zone label or numeric offset unless the user explicitly asks for one.',
    'When a scheduler requires a time zone, submit UTC and UTC wall-clock values.',
  ].join('\n');
}

/**
 * Replace model-visible time context after all upstream prompt providers have
 * assembled. This is intentionally a prompt-layer policy: host metadata such
 * as clientTimeZone remains available to the desktop for routing, but is never
 * copied into the model prompt.
 */
export function registerUtcTimeContext(ctx: HostContext, enabled = true): () => void {
  if (enabled === false) return () => {};
  const remove = ctx.on('system-prompt/assemble', async (_assembly: any, _context: any, next: () => Promise<any>) => {
    const assembly = await next();
    if (!assembly || typeof assembly !== 'object') return assembly;
    const sections = Array.isArray(assembly.sections)
      ? assembly.sections.filter((entry: any) => !contributionIsTimeSensitive(entry?.name, entry?.text))
      : assembly.sections;
    const contexts = Array.isArray(assembly.contexts)
      ? assembly.contexts.filter((entry: any) => !contributionIsTimeSensitive(entry?.name, entry?.text))
      : [];
    const variables = assembly.variables && typeof assembly.variables === 'object'
      ? Object.fromEntries(Object.entries(assembly.variables).filter(([name]) => !variableIsTimeSensitive(name)))
      : assembly.variables;
    return {
      ...assembly,
      sections,
      contexts: [
        ...contexts,
        { name: UTC_TIME_CONTEXT_NAME, text: formatUtcModelContext(), interpolate: false },
      ],
      variables,
    };
  }, { prepend: true });
  return typeof remove === 'function' ? remove : () => {};
}
