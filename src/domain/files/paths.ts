import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { NexusError } from '../../ports/contracts.js';

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Resolve every existing ancestor, including junctions, before authorizing an IO. */
export async function workspacePath(root: string, requested: unknown, allowMissing = false): Promise<string> {
  if (typeof requested !== 'string' || requested.includes('\0') || requested.length > 32700) {
    throw new NexusError('INVALID_ARGUMENT', '文件路径无效');
  }
  if (/^(?:\\\\[?.]\\|[A-Za-z]:[^\\/])/.test(requested) || /(^|[\\/])(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:[.]|[\\/]|$)/i.test(requested)) {
    throw new NexusError('SCOPE_MISMATCH', '拒绝设备路径');
  }
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, requested);
  if (!within(canonicalRoot, candidate) || relative(canonicalRoot, candidate).includes(':')) {
    throw new NexusError('SCOPE_MISMATCH', '文件路径超出工作区');
  }
  let ancestor = candidate;
  for (;;) {
    try {
      const canonical = await realpath(ancestor);
      if (!within(canonicalRoot, canonical)) throw new NexusError('SCOPE_MISMATCH', '链接目标超出工作区');
      if (ancestor !== candidate && !(await stat(canonical)).isDirectory()) throw new NexusError('INVALID_ARGUMENT', '父路径不是目录');
      if (!allowMissing && ancestor !== candidate) throw new NexusError('NOT_FOUND', '文件不存在');
      return candidate;
    } catch (error) {
      if (error instanceof NexusError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!allowMissing) throw new NexusError('NOT_FOUND', '文件不存在');
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new NexusError('SCOPE_MISMATCH', '找不到有效工作区父目录');
      ancestor = parent;
    }
  }
}

export async function existingFile(path: string, maxBytes = 8 * 1024 * 1024) {
  const info = await lstat(path);
  if (!info.isFile()) throw new NexusError('FORMAT_UNSUPPORTED', '该路径不是普通文件');
  if (info.size > maxBytes) throw new NexusError('RESOURCE_LIMIT', `文件超过 ${maxBytes} 字节上限`);
  return info;
}
