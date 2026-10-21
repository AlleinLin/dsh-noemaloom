import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NexusError, type NexusServices } from '../../ports/contracts.js';
import { checkAbort, scopedPath, secretPath, sha256, textFile, now } from '../../domain/quality/shared.js';

export interface CaptureOptions {
  vcs?: 'git' | 'svn'; mode?: 'worktree' | 'staged' | 'unstaged' | 'commit' | 'range' | 'project';
  oldRef?: string; newRef?: string; selectedPaths?: string[]; contextPaths?: string[]; rulePaths?: string[];
  maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number; allowNetwork?: boolean; signal?: AbortSignal;
}
export interface CapturedFile {
  path: string; oldPath?: string; status: string; state: 'captured' | 'blocked' | 'excluded';
  reason?: string; left?: { text: string; hash: string; revision: string; path: string };
  right?: { text: string; hash: string; revision: string; path: string }; primary: boolean;
}
export interface VcsSnapshot {
  id: string; root: string; vcs: string; mode: string; repositoryIdentity: string;
  oldRef: string; newRef: string; files: CapturedFile[]; capturedAt: string;
  scopeHash: string; workingIdentity: string; limitations: string[]; bytes: number;
}

const flags = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
const safeRef = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.startsWith('-') || value.includes('\0') || value.length > 512) throw new NexusError('INVALID_ARGUMENT', 'VCS revision 无效');
  return value;
};
const normalized = (name: string): string => {
  if (!name || name.includes('\0') || path.isAbsolute(name) || name.split(/[\\/]/).some(part => part === '..')) throw new NexusError('SCOPE_MISMATCH', 'VCS 路径必须为项目内相对路径');
  return name.replaceAll('\\', '/');
};
function xmlText(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
export function createVcsAdapter(services: NexusServices) {
  const run = async (root: string, executable: string, args: string[], options: CaptureOptions = {}, max = 5 * 1024 * 1024): Promise<string> => {
    checkAbort(options.signal);
    const result = await services.executor.run(executable, args, { cwd: root, signal: options.signal, timeoutMs: 120000, maxOutputBytes: max });
    if (result.cancelled) throw new NexusError('CANCELLED', 'VCS 捕获已取消');
    if (result.exitCode !== 0 || result.truncated) throw new NexusError(result.truncated ? 'BUDGET_EXHAUSTED' : 'PROCESS_EXIT_NONZERO', '只读 VCS 命令未成功', { executable, args, exitCode: result.exitCode, stderr: result.stderr.slice(0, 4096) });
    return result.stdout;
  };
  const git = (root: string, args: string[], options?: CaptureOptions, max?: number) => run(root, 'git', [...flags, ...args], options, max);
  const gitBlob = async (root: string, reference: string, name: string, options: CaptureOptions): Promise<{ text: string; hash: string; revision: string; path: string } | undefined> => {
    const query = `${reference}:${name}`;
    const probe = await services.executor.run('git', [...flags, 'cat-file', '-e', query], { cwd: root, signal: options.signal, timeoutMs: 30000 });
    if (probe.exitCode !== 0) return undefined;
    // Never dereference symlinks/submodules or mixed merge stages as normal text.
    const tree = reference === '' ? await git(root, ['ls-files', '--stage', '-z', '--', name], options) : await git(root, ['ls-tree', '-z', reference, '--', name], options);
    if (/^(120000|160000)/.test(tree)) throw new NexusError('FORMAT_UNSUPPORTED', '链接或子模块仅记录，不读取其目标', { path: name });
    const text = await git(root, ['cat-file', 'blob', query], options, options.maxFileBytes ?? 262144);
    if (text.includes('\0')) throw new NexusError('FORMAT_UNSUPPORTED', '二进制 blob 不进入文本审查');
    return { text, hash: sha256(Buffer.from(text)), revision: reference || 'INDEX', path: name };
  };

  async function captureGit(root: string, options: CaptureOptions): Promise<VcsSnapshot> {
    const resolved = (await git(root, ['rev-parse', '--show-toplevel'], options)).trim();
    const actualRoot = await fs.realpath(root);
    if (await fs.realpath(resolved) !== actualRoot) throw new NexusError('SCOPE_MISMATCH', '必须选择仓库根目录，不能隐式审查父仓库');
    const mode = options.mode ?? 'worktree';
    let head = '';
    const headResult = await services.executor.run('git', [...flags, 'rev-parse', '--verify', 'HEAD'], { cwd: root, signal: options.signal });
    if (headResult.exitCode === 0) head = headResult.stdout.trim();
    let oldRef = head;
    let newRef = ['commit', 'range'].includes(mode) ? '' : mode === 'staged' ? 'INDEX' : 'WORKTREE';
    const changes: Array<{ path: string; oldPath?: string; status: string }> = [];
    let initialStatus = '';
    if (mode === 'commit' || mode === 'range') {
      newRef = (await git(root, ['rev-parse', '--verify', `${safeRef(options.newRef ?? 'HEAD')}^{commit}`], options)).trim();
      if (mode === 'commit') {
        const parents = (await git(root, ['rev-list', '--parents', '-n', '1', newRef], options)).trim().split(/\s+/).slice(1);
        if (parents.length > 1) throw new NexusError('INVALID_ARGUMENT', 'merge commit 需要显式 oldRef/newRef 区间');
        oldRef = parents[0] ?? (await git(root, ['hash-object', '-t', 'tree', '--stdin'], options)).trim();
      } else oldRef = (await git(root, ['rev-parse', '--verify', `${safeRef(options.oldRef)}^{commit}`], options)).trim();
      const records = (await git(root, ['diff', '--name-status', '-z', '-M', oldRef, newRef, '--'], options)).split('\0').filter(Boolean);
      for (let index = 0; index < records.length;) {
        const status = records[index++]!;
        const oldName = records[index++]!;
        const rename = /^[RC]/.test(status);
        changes.push({ path: normalized(rename ? records[index++]! : oldName), ...(rename ? { oldPath: normalized(oldName) } : {}), status });
      }
    } else {
      initialStatus = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], options);
      const records = initialStatus.split('\0').filter(Boolean);
      for (let index = 0; index < records.length; index++) {
        const status = records[index]!.slice(0, 2);
        const name = records[index]!.slice(3);
        const oldPath = /[RC]/.test(status) ? records[++index] : undefined;
        if (mode === 'staged' && (status[0] === ' ' || status[0] === '?')) continue;
        if (mode === 'unstaged' && status[1] === ' ') continue;
        changes.push({ path: normalized(name), ...(oldPath && mode !== 'unstaged' ? { oldPath: normalized(oldPath) } : {}), status });
      }
      if (mode === 'project') {
        changes.length = 0;
        for (const name of (await git(root, ['ls-files', '-z'], options)).split('\0').filter(Boolean)) changes.push({ path: normalized(name), status: 'project' });
      }
      if (mode === 'unstaged') oldRef = 'INDEX';
    }
    const selected = options.selectedPaths?.map(normalized);
    const selection = selected ? changes.filter(change => selected.includes(change.path)) : changes.filter(change => change.status !== '??');
    if (selected && mode !== 'staged' && !['commit', 'range'].includes(mode)) {
      for (const name of selected) if (!selection.some(change => change.path === name)) selection.push({ path: name, status: 'selected' });
    }
    const all: Array<Pick<CapturedFile, 'path' | 'oldPath' | 'status' | 'primary'>> = [...selection.map(change => ({ ...change, primary: true })), ...[...(options.contextPaths ?? []), ...(options.rulePaths ?? [])].map(name => ({ path: normalized(name), status: 'context', primary: false }))];
    if (all.length > (options.maxFiles ?? 200)) throw new NexusError('BUDGET_EXHAUSTED', '捕获文件数超过预算，请分批审查', { total: all.length });
    const files: CapturedFile[] = [];
    let bytes = 0;
    for (const change of all) {
      checkAbort(options.signal);
      const file: CapturedFile = { ...change, state: 'captured' };
      if (secretPath(change.path)) { files.push({ ...file, state: 'excluded', reason: '敏感路径' }); continue; }
      try {
        const historical = ['commit', 'range'].includes(mode);
        const oldName = change.oldPath ?? change.path;
        if (oldRef) file.left = await gitBlob(root, oldRef === 'INDEX' ? '' : oldRef, oldName, options);
        if (historical) file.right = await gitBlob(root, newRef, change.path, options);
        else if (mode === 'staged') file.right = await gitBlob(root, '', change.path, options);
        else {
          try {
            const local = await textFile(root, change.path, options.maxFileBytes ?? 262144);
            file.right = { text: local.text, hash: local.hash, revision: 'WORKTREE', path: change.path };
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        bytes += Buffer.byteLength(file.left?.text ?? '') + Buffer.byteLength(file.right?.text ?? '');
        if (bytes > (options.maxTotalBytes ?? 4 * 1024 * 1024)) throw new NexusError('BUDGET_EXHAUSTED', '捕获正文超过全局预算');
        if (!file.left && !file.right) throw new NexusError('NOT_FOUND', '两端均未能取得固定内容');
      } catch (error) { file.state = 'blocked'; file.reason = error instanceof Error ? error.message : String(error); }
      files.push(file);
    }
    const identity = sha256({ root: actualRoot, gitDir: (await git(root, ['rev-parse', '--absolute-git-dir'], options)).trim() });
    const manifest = files.map(file => ({ path: file.path, left: file.left?.hash, right: file.right?.hash, state: file.state }));
    const scopeHash = sha256({ identity, mode, oldRef, newRef, manifest });
    return { id: `snapshot_${scopeHash}`, root, vcs: 'git', mode, repositoryIdentity: identity, oldRef, newRef, files, capturedAt: now(), scopeHash, workingIdentity: sha256({ head, status: initialStatus, manifest }), bytes, limitations: ['辅助依赖仅为显式路径；未发现调用方不等于不存在调用方', '静态 capture 不执行项目代码或测试'] };
  }

  async function captureSvn(root: string, options: CaptureOptions): Promise<VcsSnapshot> {
    const info = await run(root, 'svn', ['info', '--xml', '--non-interactive', '.'], options);
    if (/<!DOCTYPE|<!ENTITY/i.test(info)) throw new NexusError('MODEL_PROTOCOL_INVALID', '拒绝带实体声明的 SVN XML');
    const uuid = /<uuid>([^<]+)<\/uuid>/.exec(info)?.[1];
    const url = xmlText(/<url>([^<]+)<\/url>/.exec(info)?.[1] ?? '');
    const repositoryRoot = xmlText(/<root>([^<]+)<\/root>/.exec(info)?.[1] ?? '');
    const revision = /<entry\b[^>]*revision="(\d+)"/.exec(info)?.[1];
    if (!uuid || !url || !revision || !repositoryRoot) throw new NexusError('FORMAT_UNSUPPORTED', '无法解析 SVN 固定身份');
    const mode = options.mode ?? 'worktree';
    if (['staged', 'unstaged'].includes(mode)) throw new NexusError('FORMAT_UNSUPPORTED', 'SVN 不存在 Git index 范围');
    const historical = ['commit', 'range'].includes(mode);
    const decimal = (value: unknown): string => { if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new NexusError('INVALID_ARGUMENT', 'SVN revision 必须为十进制字符串'); return value; };
    const newRef = historical ? decimal(options.newRef) : 'WORKING';
    const oldRef = historical ? mode === 'commit' ? String(BigInt(newRef) - 1n) : decimal(options.oldRef) : 'BASE';
    if (historical && (!options.allowNetwork || BigInt(oldRef) < 0n || BigInt(oldRef) >= BigInt(newRef))) throw new NexusError('AUTHORIZATION_REQUIRED', 'SVN 历史读取需要有效固定范围和显式 network opt-in');
    const status = historical ? await run(root, 'svn', ['diff', '--summarize', '--xml', '-r', `${oldRef}:${newRef}`, '--non-interactive', `${url}@${newRef}`], options) : await run(root, 'svn', ['status', '--xml', '--ignore-externals', '--non-interactive', '.'], options);
    const changed: string[] = [];
    if (historical) for (const match of status.matchAll(/<path\b[^>]*>([^<]+)<\/path>/g)) {
      const target = xmlText(match[1]!);
      if (!target.startsWith(`${url}/`)) throw new NexusError('SCOPE_MISMATCH', 'SVN 输出来源越界');
      changed.push(normalized(decodeURIComponent(target.slice(url.length + 1))));
    } else for (const match of status.matchAll(/<entry\s+path="([^"]+)"[\s\S]*?<wc-status\b([^>]*)/g)) {
      if (/item="(?:normal|unversioned|ignored|external)"/.test(match[2]!)) continue;
      changed.push(normalized(xmlText(match[1]!)));
    }
    const selected = options.selectedPaths ? changed.filter(name => options.selectedPaths!.includes(name)) : changed;
    const files: CapturedFile[] = [];
    let bytes = 0;
    const sources = [...selected.map(name => ({ name, primary: true })),
      ...[...(options.contextPaths ?? []), ...(options.rulePaths ?? [])].map(name => ({ name: normalized(name), primary: false }))];
    for (const { name, primary } of sources) {
      if (files.length >= (options.maxFiles ?? 200)) throw new NexusError('BUDGET_EXHAUSTED', 'SVN 捕获达到文件上限');
      const file: CapturedFile = { path: name, status: primary ? 'modified' : 'context', state: 'captured', primary };
      try {
        await scopedPath(root, name, true);
        if (secretPath(name)) throw new NexusError('SCOPE_MISMATCH', '敏感路径');
        const localProps = await run(root, 'svn', ['proplist', '--xml', '--verbose', '--non-interactive', `${name}@`], options);
        if (/svn:(?:externals|special|keywords|eol-style)/.test(localProps)) throw new NexusError('FORMAT_UNSUPPORTED', 'SVN special/keywords/EOL/externals 需要可逆映射，当前文件阻断');
        const target = historical ? `${url}/${encodeURI(name)}@${newRef}` : `${name}@`;
        try {
          const left = await run(root, 'svn', ['cat', '--non-interactive', '-r', oldRef, target], options, options.maxFileBytes ?? 262144);
          file.left = { text: left, hash: sha256(left), revision: oldRef, path: name };
        } catch (error) { if (primary && !/added/.test(status)) throw error; }
        if (historical) {
          const right = await run(root, 'svn', ['cat', '--non-interactive', '-r', newRef, target], options, options.maxFileBytes ?? 262144);
          file.right = { text: right, hash: sha256(right), revision: newRef, path: name };
        } else {
          const local = await textFile(root, name, options.maxFileBytes ?? 262144);
          file.right = { text: local.text, hash: local.hash, revision: 'WORKING', path: name };
        }
        bytes += Buffer.byteLength(file.left?.text ?? '') + Buffer.byteLength(file.right?.text ?? '');
        if (bytes > (options.maxTotalBytes ?? 4 * 1024 * 1024)) throw new NexusError('BUDGET_EXHAUSTED', 'SVN 全局捕获预算已耗尽');
      } catch (error) { file.state = 'blocked'; file.reason = error instanceof Error ? error.message : String(error); }
      files.push(file);
    }
    const identity = sha256({ root: await fs.realpath(root), uuid, repositoryRoot, url });
    const scopeHash = sha256({ identity, oldRef, newRef, files: files.map(file => [file.path, file.left?.hash, file.right?.hash, file.state]) });
    return { id: `snapshot_${scopeHash}`, root, vcs: 'svn', mode, repositoryIdentity: identity, oldRef, newRef, files, capturedAt: now(), scopeHash, workingIdentity: scopeHash, bytes, limitations: ['mixed/switched/sparse 与属性规范化不可证明时按文件 blocked', 'effective mergeinfo 仅为导航，不证明已审查或语义一致'] };
  }
  return {
    async capture(root: string, options: CaptureOptions = {}): Promise<VcsSnapshot> {
      const vcs = options.vcs ?? (await fs.stat(path.join(root, '.svn')).then(() => 'svn' as const, () => 'git' as const));
      return vcs === 'svn' ? captureSvn(root, options) : captureGit(root, options);
    },
    async changedPaths(root: string, options: CaptureOptions = {}): Promise<string[]> {
      const snapshot = await this.capture(root, { ...options, maxFileBytes: 1, maxTotalBytes: 1 });
      return snapshot.files.filter(file => file.primary).map(file => file.path);
    },
  };
}
