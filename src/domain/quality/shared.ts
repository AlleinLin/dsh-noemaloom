import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NexusError, type DispatchContext, type NexusServices } from '../../ports/contracts.js';

export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
export const sha256 = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
export const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;
export const now = (): string => new Date().toISOString();
export const strings = (value: unknown, fallback: string[] = []): string[] => {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > 2000 || value.some(item => typeof item !== 'string' || item.length > 8192)) throw new NexusError('INVALID_ARGUMENT', '必须提供受限字符串数组');
  return value as string[];
};
export const number = (value: unknown, fallback: number, min: number, max: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new NexusError('INVALID_ARGUMENT', `数值必须在 ${min}–${max} 范围内`);
  return value;
};
export const object = (value: unknown): Record<string, unknown> => {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NexusError('INVALID_ARGUMENT', '必须提供对象');
  return value as Record<string, unknown>;
};
export const checkAbort = (signal?: AbortSignal): void => { if (signal?.aborted) throw new NexusError('CANCELLED', '操作已取消'); };
export const secretPath = (value: string): boolean => /(^|[\\/])(\.env(?:\..*)?|\.ssh|credentials?|secrets?)([\\/.]|$)|\.(pem|key|p12|pfx|keystore)$/i.test(value);
const inRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

/** Reject traversal and symbolic-link escapes, including nonexistent write destinations. */
export async function scopedPath(root: string, candidate: string, allowMissing = false): Promise<string> {
  const actualRoot = await fs.realpath(root);
  const absolute = path.resolve(actualRoot, candidate);
  if (!inRoot(actualRoot, absolute)) throw new NexusError('SCOPE_MISMATCH', '路径超出当前项目');
  let current = absolute;
  while (true) {
    try {
      const actual = await fs.realpath(current);
      if (!inRoot(actualRoot, actual)) throw new NexusError('SCOPE_MISMATCH', '链接目标超出当前项目');
      if (current === absolute) return actual;
      return absolute;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}
export const projectRoot = (services: NexusServices, context?: DispatchContext): string => context?.workspaceRoot ?? services.workspaceRoot;

export async function textFile(root: string, name: string, maxBytes = 262144): Promise<{ path: string; text: string; hash: string; bytes: Buffer; mode: number }> {
  if (secretPath(name)) throw new NexusError('SCOPE_MISMATCH', '敏感文件不进入质量与审查正文');
  const filename = await scopedPath(root, name);
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size > maxBytes) throw new NexusError('BUDGET_EXHAUSTED', '文件不是受限大小的普通文件', { path: name, maxBytes });
  const bytes = await fs.readFile(filename);
  if (bytes.includes(0)) throw new NexusError('FORMAT_UNSUPPORTED', '二进制文件不支持文本检查');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new NexusError('FORMAT_UNSUPPORTED', '自动检查与修复仅支持可验证的 UTF-8 文本'); }
  return { path: path.relative(root, filename).replaceAll('\\', '/'), text, hash: sha256(bytes), bytes, mode: stat.mode };
}

export async function walk(root: string, options: { maxFiles?: number; extensions?: Set<string>; signal?: AbortSignal } = {}): Promise<string[]> {
  const files: string[] = [];
  const ignored = new Set(['node_modules', '.git', '.svn', 'dist', 'build', 'coverage', '.next', '.nuxt', '__pycache__', '.venv', 'vendor', 'target']);
  const visit = async (directory: string): Promise<void> => {
    checkAbort(options.signal);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      const relative = path.relative(root, filename).replaceAll('\\', '/');
      if (secretPath(relative)) continue;
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile() && (!options.extensions || options.extensions.has(path.extname(entry.name).toLowerCase()))) {
        if (files.length >= (options.maxFiles ?? 10000)) throw new NexusError('BUDGET_EXHAUSTED', '文件枚举达到上限，请缩小范围');
        files.push(relative);
      }
    }
  };
  await visit(await fs.realpath(root));
  return files;
}

export async function atomicWrite(root: string, name: string, bytes: Uint8Array, expectedHash: string | null, mode?: number): Promise<void> {
  const filename = await scopedPath(root, name, true);
  let before: string | null = null;
  try { before = sha256(await fs.readFile(filename)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (before !== expectedHash) throw new NexusError('REVISION_CONFLICT', '文件已变化，必须重新预览', { path: name, expectedHash, actualHash: before });
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = path.join(path.dirname(filename), `.nexus-write-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    // Recheck immediately before rename. This is conflict protection, not an OS-wide write lock.
    let latest: string | null = null;
    try { latest = sha256(await fs.readFile(filename)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (latest !== before) throw new NexusError('REVISION_CONFLICT', '文件在应用过程中变化', { path: name });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function stored<T>(services: NexusServices, collection: string, id: unknown): Promise<{ id: string; revision: number; value: T }> {
  if (typeof id !== 'string') throw new NexusError('INVALID_ARGUMENT', '缺少对象引用');
  const record = await services.store.get<T>(collection, id);
  if (!record) throw new NexusError('NOT_FOUND', '未找到引用对象', { collection, id });
  return record;
}
export function page<T>(items: T[], cursor: unknown, limit: unknown, max = 100): { items: T[]; total: number; truncated: boolean; cursor: string | null } {
  const offset = cursor === undefined || cursor === null ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new NexusError('INVALID_ARGUMENT', '分页游标无效');
  const size = number(limit, 20, 1, max);
  const end = Math.min(items.length, offset + size);
  return { items: items.slice(offset, end), total: items.length, truncated: end < items.length, cursor: end < items.length ? String(end) : null };
}
export const capabilities = (names: string[], prefix: string) => names.map(action => ({ action, description: `${prefix}: ${action}`, mutating: /^(run|execute|init|fix_apply|rollback|baseline|create|update|render|export|deliver|cancel|delta|outline)$/.test(action) }));
