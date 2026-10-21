import { memorySettings, memoryEngineScope } from './settings.js';
import { join, isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { NexusError, type DispatchContext, type JsonRecord, type NexusServices } from '../../ports/contracts.js';
import { cbmProjectName, resolveSafeRepoPath, discoverRepository, sanitizeCodeContent } from '../../../vendor/veyra-code/discovery.mjs';
import { assertNoSecret, digest, projectId, stableJson } from './types.js';

/** Optional engines use the one execution broker, never an ungoverned second plugin. */
export class ExternalMemoryEngines {
  constructor(private services: NexusServices) {}
  async memsearch(root: string, params: JsonRecord, ctx?: DispatchContext): Promise<unknown> {
    const config = await memorySettings(this.services, root, ctx);
    if (config.memsearchEnabled !== true) throw new NexusError('MODULE_DISABLED', 'Memsearch可选向量引擎未启用；本地文件关键词检索可用', { dependency: 'Python >=3.10 and memsearch dependencies', action: 'memory.configure' });
    const method = String(params.method ?? 'search');
    if (!['search', 'expand', 'index', 'stats', 'transcript', 'skills.list', 'skills.distill'].includes(method)) throw new NexusError('UNKNOWN_METHOD', '未知 Memsearch 操作');
    const packageRoot = this.services.packageRoot ?? fileURLToPath(new URL('../../../', import.meta.url));
    const base = join(packageRoot, 'vendor', 'memsearch', 'src');
    const stateRoot = join(this.services.dataDir, 'memory', 'memsearch', memoryEngineScope(root, ctx));
    await mkdir(stateRoot, { recursive: true });
    const args = ['-X', 'utf8', join(packageRoot, 'vendor', 'memsearch', 'nexus_bridge.py')];
    const env: Record<string, string> = { PYTHONPATH: base, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', OPENBLAS_NUM_THREADS: '1', NEXUS_MEMSEARCH_STATE: stateRoot };
    if (config.memsearchCredentialRef) {
      const secret = await this.services.host.secret(String(config.memsearchCredentialRef));
      if (!secret) throw new NexusError('CREDENTIAL_MISSING', 'Memsearch embedding凭据引用无法解析');
      env.OPENAI_API_KEY = secret;
    }
    const common = ['--default-collection', `nexus_${projectId(root)}`];
    if (config.memsearchModel) common.push('--model', String(config.memsearchModel));
    if (config.memsearchProvider) common.push('--provider', String(config.memsearchProvider));
    if (config.memsearchEndpoint) common.push('--base-url', String(config.memsearchEndpoint));
    common.push('--milvus-uri', String(config.milvusUri ?? join(stateRoot, 'milvus.db')));
    let stdin: string | undefined;
    if (method === 'search') {
      const query = String(params.query ?? ''); assertNoSecret(query);
      args.push('search', query, '--top-k', String(Math.min(50, Number(params.limit ?? 8))), '--source-prefix', root, '--json-output', ...common);
    } else if (method === 'expand') {
      if (!/^[A-Fa-f0-9]{8,128}$/u.test(String(params.chunkHash))) throw new NexusError('INVALID_ARGUMENT', 'chunkHash无效');
      args.push('expand', String(params.chunkHash), '--json-output', ...common);
    } else if (method === 'index') {
      if (!await this.services.host.approve('memory.memsearch.index', root, { model: config.memsearchModel, maxFiles: params.maxFiles ?? 256 })) throw new NexusError('APPROVAL_REQUIRED', '向量索引可能外发文本和产生费用，需要授权');
      // Index only project memory paths already accepted by the file source.
      const binding = (await this.services.store.list<JsonRecord>('memory-file-bindings')).find(item => item.value.projectId === projectId(root) && item.value.enabled === true)?.value;
      if (!binding) throw new NexusError('SOURCE_REQUIRED', '请先建立当前项目文件记忆绑定');
      const paths = [...(binding.entryFileRefs as string[] ?? []), ...(binding.directoryRefs as string[] ?? [])].map(path => resolve(root, path));
      if (!paths.length) return { state: 'skipped', reason: 'no_memory_sources' };
      args.push('index', ...paths, ...common);
    } else if (method === 'stats') args.push('stats', '--default-collection', `nexus_${projectId(root)}`, '--milvus-uri', String(config.milvusUri ?? join(stateRoot, 'milvus.db')));
    else if (method === 'transcript') {
      // Host remains authoritative for original turns; no arbitrary private JSONL paths.
      return this.services.host.sessions('snapshot', { sessionId: params.sessionId ?? ctx?.sessionId, turnId: params.turnId, maxEvents: Math.min(200, Number(params.limit ?? 20)) });
    } else {
      if (method === 'skills.list') args.push('skills', 'list', '--json-output');
      else {
        if (!await this.services.host.approve('memory.memsearch.distill', root, { candidateOnly: true })) throw new NexusError('APPROVAL_REQUIRED', '技能提炼需要授权');
        const source = String(params.text ?? '');
        if (!source || source.length > 24000) throw new NexusError('INVALID_ARGUMENT', '技能提炼需要显式1–24000字符的已脱敏来源文本');
        assertNoSecret(source);
        const model = await this.services.host.model({ role: 'memory-skill-distiller', sessionId: ctx?.sessionId, signal: ctx?.signal, maxTokens: 4096,
          prompt: `从已完成任务的记录提炼重复出现、可复用的技能候选，禁止把猜测、未执行TODO和思考过程当作事实。只返回JSON数组，每项为name(小写短横线slug),description,body(Markdown步骤与限制),sources(字符串数组),reason。没有足够重复证据返回空数组。所有候选保持待审核，不安装或启用。\n\n${source}` });
        assertNoSecret(model.text);
        args.push('nexus-apply-candidates');
        stdin = JSON.stringify({ modelOutput: model.text, maxCandidates: Math.max(1, Math.min(10, Number(params.maxCandidates ?? 10))) });
      }
    }
    const result = await this.services.executor.run(String(config.pythonCommand ?? 'python'), args, { cwd: root, signal: ctx?.signal, timeoutMs: Math.min(330000, Number(params.timeoutMs ?? 60000)), maxOutputBytes: 262144, env, stdin });
    if (result.cancelled) throw new NexusError('CANCELLED', 'Memsearch调用已取消');
    if (result.exitCode !== 0) throw new NexusError('DEPENDENCY_FAILED', 'Memsearch调用失败', { exitCode: result.exitCode, diagnostic: result.stderr.slice(0, 3000) });
    let output: unknown = result.stdout;
    if (['search', 'expand', 'skills.list', 'skills.distill'].includes(method)) { try { output = JSON.parse(result.stdout); } catch { throw new NexusError('INVALID_ENGINE_RESPONSE', 'Memsearch没有返回有效JSON'); } }
    return { method, output, dependency: 'vendored-memsearch-0.4.21', usage: 'unreported-by-cli', estimatedEmbeddingCost: 'unknown', sourceTruth: 'Markdown', sourceUnchanged: method !== 'skills.distill' };
  }
  async code(root: string, params: JsonRecord, ctx?: DispatchContext): Promise<unknown> {
    const method = String(params.method ?? 'status');
    const settings = await memorySettings(this.services, root, ctx);
    if (method === 'status') return { state: settings.codeEnabled === true ? 'configured_pending_probe' : 'module_disabled', binary: 'codebase-memory-mcp', hasIndex: Boolean(await this.services.store.get('memory-code-indexes', projectId(root))) };
    if (settings.codeEnabled !== true) throw new NexusError('MODULE_DISABLED', '代码脑可选引擎未启用', { dependency: 'codebase-memory-mcp', action: 'memory.configure' });
    const tools: Record<string, string> = { index: 'index_repository', search: 'search_graph', trace: 'trace_path', snippet: 'get_code_snippet', architecture: 'get_architecture', text: 'search_code' };
    const tool = tools[method];
    if (!tool) throw new NexusError('UNKNOWN_METHOD', '未知代码脑操作');
    if (params.path && !resolveSafeRepoPath(root, String(params.path))) throw new NexusError('PATH_OUTSIDE_WORKSPACE', '代码脑路径超出当前仓库或为敏感文件');
    const args: JsonRecord = { project: cbmProjectName(root) };
    let coverage: unknown;
    if (method === 'index') {
      if (!await this.services.host.approve('memory.code.index', root)) throw new NexusError('APPROVAL_REQUIRED', '代码图索引需要明确工程授权');
      coverage = discoverRepository(root, { maxFiles: Math.min(10000, Number(params.maxFiles ?? 1000)) });
      args.path = root; args.mode = params.mode === 'full' ? 'full' : 'fast';
    } else if (method === 'search') Object.assign(args, { name_pattern: String(params.query ?? ''), file_pattern: String(params.path ?? ''), limit: Math.min(200, Number(params.limit ?? 50)) });
    else if (method === 'trace') Object.assign(args, { function_name: String(params.symbol ?? ''), direction: String(params.direction ?? 'both'), depth: Math.min(5, Number(params.depth ?? 3)) });
    else if (method === 'snippet') Object.assign(args, { qualified_name: String(params.symbol ?? ''), max_lines: Math.min(400, Number(params.maxLines ?? 100)), start_line: params.startLine });
    else if (method === 'text') Object.assign(args, { query: String(params.query ?? ''), limit: Math.min(200, Number(params.limit ?? 50)) });
    assertNoSecret(args);
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-nexus', version: '0.1.0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } },
    ];
    const result = await this.services.executor.run(String(settings.codeCommand ?? 'codebase-memory-mcp'), ['--ui=false'], { cwd: root, signal: ctx?.signal, timeoutMs: Math.min(180000, Number(params.timeoutMs ?? 30000)), maxOutputBytes: 262144, stdin: messages.map(item => JSON.stringify(item)).join('\n') + '\n' });
    if (result.cancelled) throw new NexusError('CANCELLED', '代码脑调用已取消');
    const reply = result.stdout.split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line) as JsonRecord]; } catch { return []; } }).find(item => item.id === 2);
    if (!reply || reply.error || (reply.result as JsonRecord)?.isError) throw new NexusError('CODE_ENGINE_FAILED', '代码脑没有提供成功的实际工具响应', { exitCode: result.exitCode, response: reply ?? null });
    const response = JSON.parse(sanitizeCodeContent(JSON.stringify(reply.result)));
    if (method === 'index') await this.services.store.put('memory-code-indexes', projectId(root), { project: cbmProjectName(root), lastIndexedAt: new Date().toISOString(), coverage, source: 'codebase-memory-mcp' });
    return { result: response, coverage, evidence: { tool, argumentHash: digest(stableJson(args)), source: 'actual-mcp-response' } };
  }
}
