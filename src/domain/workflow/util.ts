import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { NexusError, type JsonRecord, type NexusServices, type StoredRecord } from '../../ports/contracts.js';

export const newId = (prefix: string): string => `${prefix}-${randomUUID()}`;
export const now = (): string => new Date().toISOString();
export const digest = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
export function object(value: unknown, name = 'params'): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NexusError('INVALID_ARGUMENT', `${name} 必须是对象`);
  return value as JsonRecord;
}
export function text(value: unknown, name: string, max = 20000): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) throw new NexusError('INVALID_ARGUMENT', `${name} 必须为 1–${max} 码点字符串`);
  return value;
}
export function safePath(root: string, path: string): string {
  const full = resolve(root, path);
  const rel = relative(resolve(root), full);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new NexusError('SCOPE_MISMATCH', '路径超出当前工作区');
  return full;
}
/** Check lexical scope and the real target, accepting either spelling of the root. */
export async function safeExistingPath(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root), full = resolve(root, path);
  try { safePath(root, full); }
  catch { safePath(canonicalRoot, full); }
  return safePath(canonicalRoot, await realpath(full));
}
export async function required<T>(services: NexusServices, collection: string, id: string): Promise<StoredRecord<T>> {
  const row = await services.store.get<T>(collection, id);
  if (!row) throw new NexusError('NOT_FOUND', `${collection} 对象不存在`, { id });
  return row;
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new NexusError('INVALID_ARGUMENT', '更新必须提供 expectedRevision');
  return value as number;
}
export function cleanExport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanExport);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]') : value;
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, /(?:secret|password|api.?key|access.?token|authorization)$/i.test(key) ? '[REDACTED]' : cleanExport(val)]));
}
