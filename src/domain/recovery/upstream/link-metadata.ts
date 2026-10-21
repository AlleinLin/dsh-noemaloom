import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { isWithin } from './path-utils.js';
import type { SymlinkSnapshotEntry } from './types.js';

/** Query only the reparse point itself; never enumerate or open its target. */
async function windowsTag(path: string): Promise<string | undefined> {
  return new Promise(resolveResult => {
    execFile('fsutil.exe', ['reparsepoint', 'query', path], { windowsHide: true, timeout: 3_000, maxBuffer: 16_384 }, (error, stdout) => {
      if (error) { resolveResult(undefined); return; }
      resolveResult(stdout.match(/0xa000000[3c]/i)?.[0]?.toLowerCase());
    });
  });
}
export async function linkMetadata(root: string, path: string, originalTarget: string): Promise<Partial<SymlinkSnapshotEntry>> {
  const resolved = resolve(dirname(path), originalTarget);
  let verifiedWorkspaceRelativeTarget: string | undefined;
  if (isWithin(root, resolved)) {
    const canonical = await realpath(resolved).catch(() => undefined);
    if (canonical && isWithin(root, canonical)) verifiedWorkspaceRelativeTarget = relative(root, resolved).split('\\').join('/');
  }
  if (process.platform === 'win32') {
    const reparseTag = await windowsTag(path);
    if (reparseTag === '0xa0000003') return { linkKind: 'windows-junction', reparseTag, verifiedWorkspaceRelativeTarget };
    if (reparseTag !== '0xa000000c') return { linkKind: 'unknown-reparse', reparseTag, verifiedWorkspaceRelativeTarget };
    const targetInfo = verifiedWorkspaceRelativeTarget !== undefined ? await lstat(resolved).catch(() => undefined) : undefined;
    return { linkKind: targetInfo?.isDirectory() ? 'directory-symlink' : 'file-symlink', reparseTag, verifiedWorkspaceRelativeTarget };
  }
  const targetInfo = verifiedWorkspaceRelativeTarget !== undefined ? await lstat(resolved).catch(() => undefined) : undefined;
  return { linkKind: targetInfo?.isDirectory() ? 'directory-symlink' : 'file-symlink', verifiedWorkspaceRelativeTarget };
}
