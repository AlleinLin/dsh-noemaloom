import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NexusError, type DispatchContext, type JsonRecord, type NexusServices } from '../../../ports/contracts.js';
import { cleanExport, digest, newId, now, object, required, safePath, text } from '../../workflow/util.js';

export interface CliAdapter {
  id: string; binary: string; name: string; newArgs: string[]; resumeArgs?: string[];
  promptTransport: 'stdin' | 'file-reference'; imageFlag?: string; imageSupport: 'supported' | 'unsupported' | 'unverified';
  envAllowlist: string[]; enabled: boolean; custom?: boolean; outputParser: 'child-result' | 'text';
  versionArgs: string[]; versionRange?: string; source: string;
}
const adapters: CliAdapter[] = [
  { id: 'codex', binary: 'codex', name: 'Codex CLI', newArgs: ['exec', '--json', '-'], resumeArgs: ['exec', 'resume', '{sessionId}', '-'], promptTransport: 'stdin', imageFlag: '-i', imageSupport: 'supported', envAllowlist: ['CODEX_API_KEY'], enabled: true, outputParser: 'text', versionArgs: ['--version'], source: 'Evolve COI adapters / Codex documented stdin transport' },
  { id: 'kimi', binary: 'kimi', name: 'Kimi CLI', newArgs: ['-p', '{promptFileInstruction}'], resumeArgs: ['-S', '{sessionId}', '-p', '{promptFileInstruction}'], promptTransport: 'file-reference', imageSupport: 'unverified', envAllowlist: [], enabled: true, outputParser: 'text', versionArgs: ['--version'], source: 'Evolve COI adapters' },
  { id: 'grok', binary: 'grok', name: 'Grok CLI', newArgs: ['-p', '{promptFileInstruction}'], resumeArgs: ['-r', '{sessionId}', '{promptFileInstruction}'], promptTransport: 'file-reference', imageSupport: 'unverified', envAllowlist: [], enabled: true, outputParser: 'text', versionArgs: ['--version'], source: 'Evolve COI adapters' },
  { id: 'hermes', binary: 'hermes', name: 'Hermes CLI', newArgs: ['-z', '{promptFileInstruction}'], resumeArgs: ['--resume', '{sessionId}', '-z', '{promptFileInstruction}'], promptTransport: 'file-reference', imageFlag: '--image', imageSupport: 'supported', envAllowlist: [], enabled: true, outputParser: 'text', versionArgs: ['--version'], source: 'Evolve COI adapters' },
];
export class CliService {
  constructor(private readonly services: NexusServices) {}
  async list(): Promise<CliAdapter[]> {
    const custom = await this.services.store.list<CliAdapter>('cli-adapters');
    return [...new Map([...adapters.map(a => [a.id, a] as const), ...custom.map(r => [r.id, r.value] as const)]).values()];
  }
  async adapter(id: string): Promise<CliAdapter> {
    const adapter = (await this.list()).find(a => a.id === id && a.enabled);
    if (!adapter) throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', 'CLI 适配器未配置或已停用');
    if (adapter.custom) {
      const allowlist = await this.services.store.get<{ binaries: string[] }>('cli-settings', 'allowlist');
      if (!allowlist?.value.binaries.includes(adapter.binary)) throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '自定义 CLI 不在可执行文件白名单中');
    }
    return adapter;
  }
  async register(params: JsonRecord, expectedRevision?: number): Promise<unknown> {
    const id = text(params.id, 'id', 128);
    const value = object(params.adapter ?? params) as unknown as CliAdapter;
    text(value.binary, 'binary', 1024);
    if (!Array.isArray(value.newArgs) || value.newArgs.some(a => typeof a !== 'string')) throw new NexusError('INVALID_ARGUMENT', 'newArgs 必须是字符串数组');
    if (!['stdin', 'file-reference'].includes(value.promptTransport)) throw new NexusError('INVALID_ARGUMENT', 'promptTransport 仅支持 stdin/file-reference');
    const row = await this.services.store.get<CliAdapter>('cli-adapters', id);
    return this.services.store.put('cli-adapters', id, { ...value, id, custom: true, enabled: value.enabled !== false, source: 'user' }, row ? expectedRevision : 0);
  }
  async allow(params: JsonRecord): Promise<unknown> {
    const binaries = params.binaries;
    if (!Array.isArray(binaries) || binaries.some(x => typeof x !== 'string')) throw new NexusError('INVALID_ARGUMENT', 'binaries 必须是字符串数组');
    const row = await this.services.store.get('cli-settings', 'allowlist');
    return this.services.store.put('cli-settings', 'allowlist', { binaries }, row?.revision ?? 0);
  }
  async describe(params: JsonRecord, context: DispatchContext): Promise<unknown> {
    const adapter = await this.adapter(text(params.adapterId, 'adapterId', 128));
    const result = await this.services.executor.run(adapter.binary, adapter.versionArgs, { cwd: this.services.workspaceRoot, signal: context.signal, timeoutMs: 10000, maxOutputBytes: 16000 });
    return { ...adapter, available: result.exitCode === 0, versionProbe: result, credentialStatus: '由外部 CLI 自行管理；未读取账户文件' };
  }
  async execute(params: JsonRecord, context: DispatchContext): Promise<unknown> {
    const adapter = await this.adapter(text(params.adapterId, 'adapterId', 128));
    const prompt = text(params.prompt, 'prompt', 4 * 1024 * 1024);
    const images = Array.isArray(params.images) ? params.images as string[] : [];
    if (images.length && adapter.imageSupport !== 'supported') throw new NexusError('FORMAT_UNSUPPORTED', '当前 CLI 的图片能力未经过验证，未启动进程');
    const id = typeof params.jobId === 'string' ? params.jobId : newId('cli-job');
    const previous = await this.services.store.get<JsonRecord>('cli-jobs', id);
    if (previous?.value.state === 'succeeded') return previous;
    if (previous && !['failed', 'cancelled'].includes(String(previous.value.state))) throw new NexusError('PROCESS_EFFECT_UNKNOWN', '已有外部作业可能仍在运行，先检查原作业');
    const cwd = safePath(this.services.workspaceRoot, typeof params.cwd === 'string' ? params.cwd : '.');
    safePath(this.services.workspaceRoot, await realpath(cwd));
    const tempDir = join(this.services.dataDir, 'cli-input');
    await mkdir(tempDir, { recursive: true });
    const promptFile = join(tempDir, `${newId('prompt')}.md`);
    const outputFile = join(tempDir, `${newId('child-result')}.json`);
    const startedAt = now();
    const runId = String(params.runId ?? '');
    const nodeId = String(params.nodeId ?? '');
    const contract = `\n\n交付协议：完成后将真实结果写入 ${outputFile}，JSON 对象字段 schemaVersion=1, taskId=${JSON.stringify(nodeId)}, status="completed"|"failed", summary, artifactRefs=[], evidenceRefs=[], usage={}。不得伪造检查或固定 PASS。`;
    await writeFile(promptFile, prompt + contract, { mode: 0o600, flag: 'wx' });
    const base = typeof params.sessionId === 'string' ? adapter.resumeArgs : adapter.newArgs;
    if (!base) throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', 'CLI 不支持 session resume');
    const args = base.map(arg => arg.replaceAll('{sessionId}', String(params.sessionId ?? '')).replaceAll('{promptFileInstruction}', `读取任务文件 ${promptFile} 并执行其中任务；交付结果保存到 ${outputFile}`));
    for (const image of images) {
      const path = safePath(this.services.workspaceRoot, image);
      safePath(this.services.workspaceRoot, await realpath(path));
      if (adapter.imageFlag) args.push(adapter.imageFlag, path);
    }
    if (params.model) args.push('-m', text(params.model, 'model', 256));
    const env: Record<string, string> = {};
    const envReferences = params.envReferences ? object(params.envReferences) : {};
    for (const [name, ref] of Object.entries(envReferences)) {
      if (!adapter.envAllowlist.includes(name) || typeof ref !== 'string') throw new NexusError('AUTHORIZATION_REQUIRED', `环境变量 ${name} 不在适配器白名单内`);
      const value = await this.services.host.secret(ref);
      if (value === undefined) throw new NexusError('AUTHORIZATION_REQUIRED', '所需 secret reference 不可用');
      env[name] = value;
    }
    const record: JsonRecord = { id, adapterId: adapter.id, ownerSessionId: context.sessionId ?? 'local', runId, nodeId, cwd, state: 'running', startedAt, inputHash: digest(prompt), inputBytes: Buffer.byteLength(prompt), scope: params.scope ?? 'session', sessionId: params.sessionId, promptTransport: adapter.promptTransport, commandSummary: [adapter.binary, ...args.map(a => a.replace(promptFile, '<prompt-ref>').replace(outputFile, '<result-ref>'))], usageComplete: false };
    const saved = await this.services.store.put('cli-jobs', id, record, previous?.revision ?? 0);
    try {
      const result = await this.services.executor.run(adapter.binary, args, { cwd, signal: context.signal, timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : 1800000, maxOutputBytes: 4 * 1024 * 1024, env, stdin: adapter.promptTransport === 'stdin' ? prompt + contract : undefined });
      let childResult: JsonRecord | undefined;
      try { childResult = object(JSON.parse(await readFile(outputFile, 'utf8')), 'ChildResult'); } catch { /* no fabricated fallback from exit code or stdout */ }
      const valid = childResult?.schemaVersion === 1 && childResult.taskId === nodeId && ['completed', 'failed'].includes(String(childResult.status)) && typeof childResult.summary === 'string' && Array.isArray(childResult.artifactRefs) && Array.isArray(childResult.evidenceRefs);
      const state = result.cancelled ? 'cancelled' : result.exitCode === 0 && valid && childResult!.status === 'completed' ? 'succeeded' : 'failed';
      let safeResult: unknown = { ...record, state, finishedAt: now(), result, childResult, validation: valid ? 'valid' : 'CHILD_RESULT_INVALID', usageComplete: !!childResult?.usage && Object.keys(childResult.usage as object).length > 0 };
      for (const secret of Object.values(env)) if (secret) safeResult = JSON.parse(JSON.stringify(safeResult).split(secret).join('[REDACTED]'));
      const row = await this.services.store.put('cli-jobs', id, cleanExport(safeResult) as JsonRecord, saved.revision);
      if (state !== 'succeeded') throw new NexusError(!valid ? 'CHILD_RESULT_INVALID' : result.cancelled ? 'CANCELLED' : 'PROCESS_EXIT_NONZERO', '外部 CLI 未交付有效成功结果', { jobId: id, exitCode: result.exitCode });
      return row;
    } finally {
      await rm(promptFile, { force: true });
      await rm(outputFile, { force: true });
    }
  }
  async status(id: string, context: DispatchContext): Promise<unknown> {
    const row = await required<JsonRecord>(this.services, 'cli-jobs', id);
    if (context.sessionId && row.value.ownerSessionId !== context.sessionId) throw new NexusError('SCOPE_MISMATCH', 'CLI 作业属于其他会话');
    return row;
  }
}
