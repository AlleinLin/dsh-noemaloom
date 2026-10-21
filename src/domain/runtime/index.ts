import { randomUUID } from 'node:crypto';
import { join, relative, basename, resolve } from 'node:path';
import { stat, realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { NexusError, recordParams, requiredString, type NexusModule, type NexusServices, type NexusRequest, type DispatchContext, type JsonRecord, type ExecutionResult, type StoredRecord } from '../../ports/contracts.js';
import { workspacePath, sha256 } from '../files/paths.js';

interface Job extends JsonRecord { id: string; state: string; startedAt: string; completedAt?: string; sessionId?: string; workspaceRoot?: string; command: string; args: string[]; result?: ExecutionResult; }
const ACTIVE_JOBS = Symbol.for('dsh-nexus.active-runtime-jobs.v1');
const jobRuntime = globalThis as typeof globalThis & { [ACTIVE_JOBS]?: Map<string, AbortController> };
const activeJobs = jobRuntime[ACTIVE_JOBS] ??= new Map<string, AbortController>();
interface OutputChunk { cursor: number; nextCursor: number; stream: 'stdout' | 'stderr'; text: string; lossy?: boolean }
interface LiveOutput { chunks: OutputChunk[]; bytes: number; startCursor: number; nextCursor: number; completed: boolean }
const LIVE_OUTPUT = Symbol.for('dsh-nexus.runtime-live-output.v1');
const outputRuntime = globalThis as typeof globalThis & { [LIVE_OUTPUT]?: Map<string, LiveOutput> };
const liveOutputs = outputRuntime[LIVE_OUTPUT] ??= new Map<string, LiveOutput>();
const LIVE_BYTES = 1024 * 1024, LIVE_JOBS = 64, COMPLETED_OUTPUTS = 32, CHUNK_BYTES = 16 * 1024;
const continuation = (byte: number) => (byte & 0xc0) === 0x80;
function beginOutput(ownerToken: string) {
  while (liveOutputs.size >= LIVE_JOBS) {
    const oldest = [...liveOutputs].find(([, output]) => output.completed)?.[0] ?? liveOutputs.keys().next().value;
    if (!oldest) break;
    // Evict only presentation data; command ownership and cancellation are separate.
    liveOutputs.delete(oldest);
  }
  liveOutputs.set(ownerToken, { chunks: [], bytes: 0, startCursor: 0, nextCursor: 0, completed: false });
}
function appendOutput(ownerToken: string, stream: 'stdout' | 'stderr', text: string, lossy = false) {
  const output = liveOutputs.get(ownerToken);
  if (!output || !text) return;
  const bytes = Buffer.from(text, 'utf8');
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + CHUNK_BYTES, bytes.length);
    while (end < bytes.length && continuation(bytes[end])) end--;
    const chunk: OutputChunk = {
      cursor: output.nextCursor, nextCursor: output.nextCursor + end - start, stream,
      text: bytes.subarray(start, end).toString('utf8'), ...(lossy && start === 0 ? { lossy: true } : {}),
    };
    output.chunks.push(chunk);
    output.nextCursor = chunk.nextCursor;
    output.bytes += end - start;
    start = end;
    while (output.bytes > LIVE_BYTES || output.chunks.length > 256) {
      const removed = output.chunks.shift()!;
      output.bytes -= removed.nextCursor - removed.cursor;
    }
    output.startCursor = output.chunks[0]?.cursor ?? output.nextCursor;
  }
}
function finishOutput(ownerToken: string) {
  const output = liveOutputs.get(ownerToken);
  if (output) output.completed = true;
  const completed = [...liveOutputs].filter(([, value]) => value.completed);
  for (const [token] of completed.slice(0, Math.max(0, completed.length - COMPLETED_OUTPUTS))) liveOutputs.delete(token);
}
function outputPage(output: LiveOutput, cursor: number, maxBytes: number) {
  if (cursor > output.nextCursor) throw new NexusError('INVALID_ARGUMENT', '输出 cursor 超出已观察范围');
  const from = Math.max(cursor, output.startCursor), chunks: OutputChunk[] = [];
  let nextCursor = from, remaining = maxBytes, lossy = cursor < output.startCursor;
  for (const chunk of output.chunks) {
    if (chunk.nextCursor <= from) continue;
    const bytes = Buffer.from(chunk.text, 'utf8');
    let start = Math.max(0, from - chunk.cursor);
    while (start < bytes.length && continuation(bytes[start])) { start++; lossy = true; }
    let end = Math.min(bytes.length, start + remaining);
    while (end < bytes.length && end > start && continuation(bytes[end])) end--;
    if (end === start) break;
    const item = { ...chunk, cursor: chunk.cursor + start, nextCursor: chunk.cursor + end, text: bytes.subarray(start, end).toString('utf8') };
    chunks.push(item);
    nextCursor = item.nextCursor;
    remaining -= end - start;
    if (item.lossy) lossy = true;
    if (!remaining) break;
  }
  return { cursor, nextCursor, startCursor: output.startCursor, lossy, hasMore: nextCursor < output.nextCursor, available: true, chunks };
}
const gitMutations = new Set(['stage', 'unstage', 'commit', 'discard', 'checkout', 'pull', 'push', 'revert', 'cherry-pick', 'worktree.create', 'worktree.remove', 'continue', 'abort']);
const actions = ['shells', 'shell.run', 'terminal.run', 'terminal.open', 'terminal.input', 'terminal.resize', 'terminal.close', 'jobs.list', 'jobs.get', 'jobs.output', 'jobs.cancel', 'git.status', 'git.diff', 'git.log', 'git.branches', 'git.refs', 'git.show', 'git.message.generate', 'git.stage', 'git.unstage', 'git.commit', 'git.discard', 'git.checkout', 'git.pull', 'git.push', 'git.revert', 'git.cherry-pick', 'git.continue', 'git.abort', 'git.worktrees', 'git.worktree.create', 'git.worktree.remove'];

function optionSafe(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.startsWith('-') || /[\0\r\n]/.test(value) || value.length > 4096) throw new NexusError('INVALID_ARGUMENT', `${label} 无效`);
  return value;
}

export function createRuntimeModule(services: NexusServices): NexusModule {
  const controllers = new Map<string, AbortController>();
  const gitQueues = new Map<string, Promise<unknown>>();
  async function canonicalRoot(root: string): Promise<string> {
    const canonical = await realpath(root);
    if (!(await stat(canonical)).isDirectory()) throw new NexusError('INVALID_WORKSPACE', '工作区根目录不可用');
    return process.platform === 'win32' ? resolve(canonical).toLowerCase() : resolve(canonical);
  }
  async function visibleJob(job: Job, context?: DispatchContext): Promise<boolean> {
    if (context?.scopeLevel === 'global') return true;
    const sessionId = context?.sessionId;
    if ((context?.scopeLevel === 'session' || sessionId) && (!sessionId || job.sessionId !== sessionId)) return false;
    const root = await canonicalRoot(context?.workspaceRoot ?? services.workspaceRoot);
    let jobRoot = job.workspaceRoot;
    if (!jobRoot && job.sessionId) {
      // Legacy receipts need official session metadata; relative cwd alone is no proof.
      try {
        const rows = await services.host.sessions('list', {});
        const row = Array.isArray(rows) ? rows.find(value => (value as any)?.header?.id === job.sessionId) : undefined;
        if (typeof row?.header?.cwd === 'string') jobRoot = row.header.cwd;
      } catch { return false; }
    }
    if (!jobRoot) return false;
    try { return await canonicalRoot(jobRoot) === root; }
    catch { return false; }
  }
  async function scopedJob(id: string, context?: DispatchContext) {
    const row = await services.store.get<Job>('runtimeJobs', id);
    if (!row || !await visibleJob(row.value, context)) throw new NexusError('NOT_FOUND', '当前范围内不存在此作业');
    return (await reconcileJob(row))!;
  }
  async function reconcileJob(row: StoredRecord<Job> | undefined): Promise<StoredRecord<Job> | undefined> {
    if (!row || row.value.state !== 'running') return row;
    const job = row.value;
    if (typeof job.ownerToken === 'string' && activeJobs.has(job.ownerToken)) return row;
    if (typeof job.ownerPid === 'number' && job.ownerPid !== process.pid && job.ownerHost === hostname()) {
      try { process.kill(job.ownerPid, 0); return row; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return row; }
    } else if (job.ownerHost && job.ownerHost !== hostname()) return row;
    try {
      return await services.store.put('runtimeJobs', row.id, {
        ...job, state: 'effectUnknown', interruptedAt: new Date().toISOString(),
        error: { code: 'EXECUTION_OWNER_LOST' }, recovery: 'verify-external-effects-before-starting-a-new-command',
      }, row.revision);
    } catch (error) {
      if (error instanceof NexusError && error.code === 'REVISION_CONFLICT') return services.store.get<Job>('runtimeJobs', row.id);
      throw error;
    }
  }
  async function shells() {
    const configured = (await services.store.get<JsonRecord>('runtimeSettings', 'shellPaths'))?.value ?? {};
    const paths = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const localData = process.env.LOCALAPPDATA ?? '';
    const windows = process.env.SystemRoot ?? 'C:\\Windows';
    const candidates: { id: string; paths: string[]; flavor: string; args: string[] }[] = process.platform === 'win32' ? [
      { id: 'pwsh7', paths: [String(configured.pwsh7 ?? ''), join(programFiles, 'PowerShell', '7', 'pwsh.exe'), ...paths.map(path => join(path, 'pwsh.exe'))], flavor: 'powershell7', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'] },
      { id: 'windows-powershell51', paths: [String(configured['windows-powershell51'] ?? ''), join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')], flavor: 'windows-powershell', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'] },
      { id: 'git-bash', paths: [String(configured['git-bash'] ?? ''), join(programFiles, 'Git', 'bin', 'bash.exe'), join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'), join(localData, 'Programs', 'Git', 'bin', 'bash.exe'), ...paths.map(path => join(path, 'bash.exe'))], flavor: 'git-bash', args: ['--version'] },
    ] : [{ id: 'posix-bash', paths: [String(configured['posix-bash'] ?? ''), '/bin/bash', '/usr/bin/bash'], flavor: 'posix-bash', args: ['--version'] }, { id: 'pwsh7', paths: [String(configured.pwsh7 ?? ''), ...paths.map(path => join(path, 'pwsh'))], flavor: 'powershell7', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'] }];
    const items: JsonRecord[] = [];
    for (const entry of candidates) {
      let found: JsonRecord | undefined;
      for (const candidate of [...new Set(entry.paths.filter(Boolean))]) {
        try {
          const executable = await realpath(candidate);
          if (!(await stat(executable)).isFile()) continue;
          if (entry.id === 'git-bash' && (!/bash\.exe$/i.test(executable) || /[\\/](?:system32|sysnative|syswow64|wsl)[\\/]/i.test(executable))) continue;
          if (entry.id === 'git-bash' && !/[\\/]Git[\\/]/i.test(executable) && candidate !== configured['git-bash']) continue;
          const result = await services.executor.run(executable, entry.args, { timeoutMs: 3000, maxOutputBytes: 2000 });
          if (result.exitCode !== 0) continue;
          if (entry.id === 'git-bash' && !/GNU bash|bash, version/i.test(result.stdout)) continue;
          found = { id: entry.id, flavor: entry.flavor, executable, available: true, version: result.stdout.split(/\r?\n/)[0], platform: process.platform, persistent: false }; break;
        } catch { /* one missing executable does not hide other shells */ }
      }
      items.push(found ?? { id: entry.id, flavor: entry.flavor, available: false, platform: process.platform, reason: 'executable-not-found-or-identity-rejected' });
    }
    return { items };
  }
  async function approved(action: string, resource: string, details: JsonRecord, context?: DispatchContext) {
    if (context?.permissions?.has(action) || context?.permissions?.has('external_process')) return;
    if (!await services.host.approve('runtime.execute', resource, { ...details, operation: action, sessionId: context?.sessionId })) throw new NexusError('PERMISSION_DENIED', `${action} 未获宿主批准`);
  }
  async function git(params: JsonRecord, action: string, context?: DispatchContext) {
    const root = context?.workspaceRoot ?? services.workspaceRoot, cwd = await workspacePath(root, String(params.cwd ?? '.'));
    if (action === 'message.generate') {
      const staged = await services.executor.run('git', ['diff', '--cached', '--no-ext-diff', '--no-color'], { cwd, signal: context?.signal, timeoutMs: 10000, maxOutputBytes: 128 * 1024 });
      if (staged.exitCode !== 0) throw new NexusError('VCS_FAILED', '无法读取暂存变更');
      if (!staged.stdout.trim()) throw new NexusError('INVALID_ARGUMENT', '没有暂存变更可生成提交说明');
      const generated = await services.host.model({ role: 'commit-message', prompt: `根据以下 Git staged diff 生成简洁准确的提交说明。不要执行提交，不要声称验证通过。仅返回提交说明正文。\n\n<untrusted-diff>\n${staged.stdout}\n</untrusted-diff>`, provider: typeof params.provider === 'string' ? params.provider : undefined, model: typeof params.model === 'string' ? params.model : undefined, sessionId: context?.sessionId, signal: context?.signal, maxTokens: 512, logicalCallId: `commit-draft:${randomUUID()}` });
      return { draft: generated.text, committed: false, stagedSnapshot: sha256(staged.stdout), provider: generated.provider, model: generated.model, usage: generated.usage, truncatedInput: staged.truncated === true };
    }
    const branch = () => optionSafe(params.branch ?? params.ref, '分支');
    const filePaths = async () => {
      if (!Array.isArray(params.paths) || !params.paths.length || params.paths.length > 1000) throw new NexusError('INVALID_ARGUMENT', 'paths 须为1–1000条工作区相对路径');
      return Promise.all(params.paths.map(async input => relative(cwd, await workspacePath(root, input, true))));
    };
    let args: string[];
    switch (action) {
      case 'status': args = ['status', '--porcelain=v2', '--branch', '-z']; break;
      case 'diff': args = ['diff', '--no-ext-diff', '--no-color', ...(params.staged ? ['--cached'] : []), ...(params.from ? [optionSafe(params.from, 'from'), ...(params.to ? [optionSafe(params.to, 'to')] : [])] : []), '--', ...(Array.isArray(params.paths) ? await filePaths() : [])]; break;
      case 'log': {
        const limit = params.limit ?? 200, skip = params.skip ?? 0;
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000 || typeof skip !== 'number' || !Number.isInteger(skip) || skip < 0) throw new NexusError('INVALID_ARGUMENT', '提交分页无效');
        args = ['log', '--date=iso-strict', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1e', `--max-count=${limit}`, `--skip=${skip}`, ...(params.ref ? [optionSafe(params.ref, 'ref')] : ['--all'])]; break;
      }
      case 'branches': args = ['branch', '--all', '--format=%(refname)%09%(objectname)%09%(HEAD)%09%(upstream:short)']; break;
      case 'refs': args = ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(objecttype)']; break;
      case 'show': args = ['show', '--no-ext-diff', '--no-color', '--format=fuller', optionSafe(params.ref, 'ref'), '--']; break;
      case 'stage': args = ['add', '--', ...await filePaths()]; break;
      case 'unstage': args = ['restore', '--staged', '--', ...await filePaths()]; break;
      case 'commit': args = ['commit', '--file=-']; break;
      case 'discard': args = ['restore', '--worktree', '--', ...await filePaths()]; break;
      case 'checkout': args = ['switch', ...(params.create === true ? ['-c'] : []), branch()]; break;
      case 'pull': args = ['pull', '--ff-only', ...(params.remote ? [optionSafe(params.remote, 'remote')] : [])]; break;
      case 'push': args = ['push', ...(params.remote ? [optionSafe(params.remote, 'remote')] : []), ...(params.branch ? [branch()] : [])]; break;
      case 'revert': args = ['revert', '--no-edit', optionSafe(params.commit, 'commit')]; break;
      case 'cherry-pick': args = ['cherry-pick', optionSafe(params.commit, 'commit')]; break;
      case 'continue': case 'abort': {
        if (!['revert', 'cherry-pick', 'merge', 'rebase'].includes(String(params.operation))) throw new NexusError('INVALID_ARGUMENT', 'operation 无效');
        args = [String(params.operation), `--${action}`]; break;
      }
      case 'worktrees': args = ['worktree', 'list', '--porcelain', '-z']; break;
      case 'worktree.create': {
        const destination = await workspacePath(root, params.path, true);
        if (destination === root) throw new NexusError('SCOPE_MISMATCH', '新 worktree 不能覆盖根');
        args = ['worktree', 'add', ...(params.newBranch ? ['-b', optionSafe(params.newBranch, 'newBranch')] : []), '--', destination, optionSafe(params.ref ?? 'HEAD', 'ref')]; break;
      }
      case 'worktree.remove': {
        const destination = await workspacePath(root, params.path);
        if (destination === root) throw new NexusError('SCOPE_MISMATCH', '主工作区不可删除');
        const dirty = await services.executor.run('git', ['status', '--porcelain'], { cwd: destination, signal: context?.signal, timeoutMs: 10000 });
        if (dirty.stdout.trim() && params.force !== true) throw new NexusError('REVISION_CONFLICT', 'worktree 有未提交变更', { dirty: true });
        if (dirty.stdout.trim()) await approved('git.worktree.remove.dirty', relative(root, destination), { dirty: true }, context);
        args = ['worktree', 'remove', ...(params.force === true ? ['--force'] : []), '--', destination]; break;
      }
      default: throw new NexusError('ACTION_NOT_FOUND', '未知 Git 操作');
    }
    const execute = async () => {
      if (gitMutations.has(action)) {
        const before = await services.executor.run('git', ['status', '--porcelain=v2', '--branch'], { cwd, signal: context?.signal, timeoutMs: 10000 });
        const snapshot = sha256(before.stdout);
        if (params.expectedSnapshot && params.expectedSnapshot !== snapshot) throw new NexusError('REVISION_CONFLICT', 'Git 工作区快照已变化', { currentSnapshot: snapshot });
        let affectedSessions: unknown[] | null = null;
        if (['checkout', 'worktree.remove'].includes(action)) {
          try {
            const sessionRows = await services.host.sessions('list', {});
            if (Array.isArray(sessionRows)) affectedSessions = sessionRows.filter(value => {
              const session = value as { header?: { meta?: { cwd?: string } }; cwd?: string };
              const path = session.cwd ?? session.header?.meta?.cwd;
              return typeof path === 'string' && (path === cwd || path.startsWith(`${cwd}\\`) || path.startsWith(`${cwd}/`));
            }).map(value => ({ id: (value as JsonRecord).id }));
          } catch { /* unknown impact remains explicit in approval */ }
        }
        await approved(`git.${action}`, relative(root, cwd), { args, snapshot, affectedSessions, impactKnown: affectedSessions !== null }, context);
      }
      const result = await services.executor.run('git', args, { cwd, signal: context?.signal, timeoutMs: params.timeoutMs === undefined ? 60000 : Number(params.timeoutMs), maxOutputBytes: 4 * 1024 * 1024, ...(action === 'commit' ? { stdin: requiredString(params, 'message') } : {}) });
      const receipt = { id: randomUUID(), action: `git.${action}`, cwd: relative(root, cwd), args, ...result, observedAt: new Date().toISOString(), effect: gitMutations.has(action) ? result.exitCode === 0 ? 'committed' : 'failed-or-partial' : 'read' };
      if (gitMutations.has(action)) { await services.store.put('gitAudit', receipt.id, receipt); services.emit('git.changed', { cwd: relative(root, cwd), action, exitCode: result.exitCode }); }
      if (action === 'log' && result.exitCode === 0) return { ...receipt, items: result.stdout.split('\x1e').map(value => value.trim()).filter(Boolean).map(value => { const [hash, parents, author, email, date, refs, message] = value.split('\x1f'); return { hash, parents: parents?.split(' ').filter(Boolean), author, email, date, refs, message }; }) };
      if (action === 'status') return { ...receipt, snapshot: sha256(result.stdout), records: result.stdout.split('\0').filter(Boolean) };
      if (action === 'worktree.create' && result.exitCode === 0) {
        const destination = await workspacePath(root, params.path), id = sha256(destination);
        let workspaceRegistration: unknown, registrationStatus = 'registered';
        try { workspaceRegistration = await services.host.sessions('workspace.register', { path: destination, cwd: destination }); }
        catch (error) { registrationStatus = 'host-registration-unavailable'; workspaceRegistration = { error: error instanceof NexusError ? error.code : 'HOST_CAPABILITY_UNAVAILABLE' }; }
        const managed = await services.store.put('managedWorktrees', id, { id, path: destination, branch: params.newBranch ?? null, baseline: params.ref ?? 'HEAD', createdAt: new Date().toISOString(), workspaceRegistration, registrationStatus }, 0);
        let session: unknown;
        if (params.createSession === true && registrationStatus === 'registered') session = await services.host.sessions('create', { cwd: destination });
        return { ...receipt, managed: managed.value, session, registrationStatus };
      }
      if (action === 'worktree.remove' && result.exitCode === 0) await services.store.remove('managedWorktrees', sha256(await workspacePath(root, params.path, true)));
      return receipt;
    };
    if (!gitMutations.has(action)) return execute();
    const pending = gitQueues.get(cwd) ?? Promise.resolve(), next = pending.catch(() => undefined).then(execute); gitQueues.set(cwd, next);
    try { return await next; } finally { if (gitQueues.get(cwd) === next) gitQueues.delete(cwd); }
  }
  async function run(request: NexusRequest, context?: DispatchContext) {
    const params = recordParams(request), command = requiredString(params, 'command');
    if (!Array.isArray(params.args) || !params.args.every(value => typeof value === 'string' && !value.includes('\0'))) throw new NexusError('INVALID_ARGUMENT', 'args 必须为字符串数组；shell语句须明确选择shell可执行文件');
    const args = params.args as string[], root = await realpath(context?.workspaceRoot ?? services.workspaceRoot), cwd = await workspacePath(root, String(params.cwd ?? '.'));
    const workspaceRoot = await canonicalRoot(root);
    const id = request.requestId ?? randomUUID();
    const existing = await services.store.get<Job>('runtimeJobs', id);
    if (existing) {
      if (!await visibleJob(existing.value, context)) throw new NexusError('NOT_FOUND', '当前范围内不存在此作业');
      return reconcileJob(existing);
    }
    await approved('terminal.run', command, { args, cwd: relative(root, cwd), timeoutMs: params.timeoutMs ?? 60000 }, context);
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, ...(context?.signal ? [context.signal] : []), ...(services.signal ? [services.signal] : [])]);
    const ownerToken = randomUUID();
    controllers.set(ownerToken, controller);
    activeJobs.set(ownerToken, controller);
    const job: Job = { id, state: 'running', startedAt: new Date().toISOString(), command, args, cwd: relative(root, cwd),
      sessionId: context?.sessionId, workspaceRoot, ownerToken, ownerPid: process.pid, ownerHost: hostname() };
    let saved: StoredRecord<Job>;
    try { saved = await services.store.put('runtimeJobs', id, job, 0); }
    catch (error) { controllers.delete(ownerToken); activeJobs.delete(ownerToken); throw error; }
    beginOutput(ownerToken);
    const execute = async () => {
      try {
        const result = await services.executor.run(command, args, {
          cwd, signal, timeoutMs: Number(params.timeoutMs ?? 60000), maxOutputBytes: Number(params.maxOutputBytes ?? 1024 * 1024),
          ...(typeof params.stdin === 'string' ? { stdin: params.stdin } : {}),
          onOutput(output) { appendOutput(ownerToken, output.stream, output.text, output.lossy); },
        });
        // Executors without live observation still expose their final bounded result.
        if (liveOutputs.get(ownerToken)?.nextCursor === 0) {
          appendOutput(ownerToken, 'stdout', result.stdout, result.truncated);
          appendOutput(ownerToken, 'stderr', result.stderr, result.truncated);
        }
        const final = await services.store.put('runtimeJobs', id, { ...job, state: result.cancelled ? 'cancelled' : result.exitCode === 0 ? 'succeeded' : 'failed', result, completedAt: new Date().toISOString() }, saved.revision);
        services.emit('runtime.job.changed', { id, state: final.value.state, exitCode: result.exitCode }); return final;
      } catch (error) {
        const final = await services.store.put('runtimeJobs', id, { ...job, state: signal.aborted ? 'cancelled' : 'failed', completedAt: new Date().toISOString(), error: error instanceof NexusError ? { code: error.code } : { code: 'EXECUTION_FAILED' } }, saved.revision); return final;
      } finally { controllers.delete(ownerToken); activeJobs.delete(ownerToken); finishOutput(ownerToken); }
    };
    const execution = execute();
    if (params.background === true) {
      void execution.catch(error => services.emit('runtime.job.persistence-failed', { id, code: error instanceof NexusError ? error.code : 'INTERNAL' }));
      return { id, state: 'running', owned: true };
    }
    return execution;
  }
  return {
    id: 'runtime', capabilities: actions.map(action => ({ action, description: `桌面执行 ${action}`, mutating: /terminal|cancel/.test(action) || action === 'shell.run' || action === 'git.message.generate' || gitMutations.has(action.replace(/^git\./, '')) })),
    async dispatch(request, context) {
      const params = recordParams(request);
      if (request.action.startsWith('git.')) return git(params, request.action.slice(4), context);
      switch (request.action) {
        case 'shells': {
          return shells();
        }
        case 'shell.run': {
          const shellId = requiredString(params, 'shellId'), command = requiredString(params, 'command'), selected = (await shells()).items.find(row => row.id === shellId && row.available === true);
          if (!selected) throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '请求的 Shell 不可用', { shellId });
          const args = shellId === 'pwsh7' || shellId === 'windows-powershell51' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['--noprofile', '--norc', '-c', command];
          return run({ ...request, params: { ...params, command: selected.executable, args } }, context);
        }
        case 'terminal.run': return run(request, context);
        case 'terminal.open': case 'terminal.input': case 'terminal.resize': case 'terminal.close': {
          try { return await services.host.sessions(request.action, { ...params, sessionId: context?.sessionId }); }
          catch (error) { if (error instanceof NexusError) throw error; throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '当前宿主未提供公开 PTY 服务；可使用受批准的命令作业', { fallback: 'runtime.terminal.run' }); }
        }
        case 'jobs.list': {
          const rows = await services.store.list<Job>('runtimeJobs');
          const visibility = await Promise.all(rows.map(row => visibleJob(row.value, context)));
          return { items: await Promise.all(rows.filter((row, index) => visibility[index] && (!params.sessionId || row.value.sessionId === params.sessionId))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(reconcileJob)) };
        }
        case 'jobs.get': return scopedJob(requiredString(params, 'id'), context);
        case 'jobs.output': {
          const row = await scopedJob(requiredString(params, 'id'), context);
          const cursor = params.cursor ?? 0, maxBytes = params.maxBytes ?? 64 * 1024;
          if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0
            || typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 256 * 1024) {
            throw new NexusError('INVALID_ARGUMENT', '输出 cursor 或 maxBytes 无效');
          }
          const output = typeof row.value.ownerToken === 'string' ? liveOutputs.get(row.value.ownerToken) : undefined;
          return {
            id: row.id, state: row.value.state, completedAt: row.value.completedAt,
            ...(output ? outputPage(output, cursor, maxBytes) : {
              cursor, nextCursor: cursor, startCursor: cursor, lossy: true, hasMore: false, available: false, chunks: [],
              reason: 'live-output-unavailable', ...(row.value.result ? { result: row.value.result } : {}),
            }),
          };
        }
        case 'jobs.cancel': {
          const id = requiredString(params, 'id'), row = await scopedJob(id, context);
          const controller = typeof row.value.ownerToken === 'string' ? activeJobs.get(row.value.ownerToken) : undefined;
          if (!controller) return { id, cancelled: false, state: row.value.state,
            reason: row.value.state === 'effectUnknown' ? 'external-effect-unverified' : row.value.state === 'running' ? 'owned-by-other-process' : 'already-completed' };
          controller.abort(new NexusError('CANCELLED', '用户取消')); return { id, state: 'cancelling' };
        }
        default: throw new NexusError('ACTION_NOT_FOUND', `未知运行操作: ${request.action}`);
      }
    },
    dispose() { for (const controller of controllers.values()) controller.abort(); },
  };
}
