import { createHash } from 'node:crypto';
import { NexusError } from '../../ports/contracts.js';

/** Canonical JSON uses JSON wire semantics, recursively sorted object keys, and UTF-8. */
export function canonicalJson(value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item)) {
        throw new Error('non-finite number');
      }
      if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
        throw new Error('non-JSON value');
      }
      return item;
    });
  } catch {
    throw new NexusError('INVALID_ARGUMENT', '数据必须是无循环引用的有效 JSON。');
  }
  if (json === undefined) throw new NexusError('INVALID_ARGUMENT', '数据必须是有效 JSON。');
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === 'object') {
      const ordered: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        ordered[key] = sort((item as Record<string, unknown>)[key]);
      }
      return ordered;
    }
    return item;
  };
  return JSON.stringify(sort(JSON.parse(json)));
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function jsonClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
