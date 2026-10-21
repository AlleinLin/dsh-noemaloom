import { getLanguage } from './i18n.js';

export type LocalizedText = string | Record<string, string>;
const localeKey = (value: string) => value.toLowerCase().replaceAll('_', '-');
const localePattern = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

export function isLocalizedText(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([key, text]) => localePattern.test(localeKey(key)) && typeof text === 'string');
}

/** Package descriptors are language maps, not data to stringify into a label. */
export function localizedText(value: unknown, locale = getLanguage(), fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!isLocalizedText(value)) return fallback;
  const translations = new Map(Object.entries(value).map(([key, text]) => [localeKey(key), text]));
  const requested = localeKey(locale);
  const chain: string[] = [];
  for (let candidate = requested; candidate; candidate = candidate.includes('-') ? candidate.slice(0, candidate.lastIndexOf('-')) : '') chain.push(candidate);
  for (const candidate of [...chain, 'en', 'zh']) {
    const text = translations.get(candidate);
    if (text !== undefined) return text;
  }
  return translations.values().next().value ?? fallback;
}
