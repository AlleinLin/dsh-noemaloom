import { memorySettings, memoryEngineScope } from './settings.js';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { NexusError, type DispatchContext, type JsonRecord, type NexusServices } from '../../ports/contracts.js';
import { cognitionManifest, cognitionMethodAliases, cognitionReadMethods } from './cognition-manifest.js';
import { assertNoSecret, digest, projectId, stableJson } from './types.js';
import { CognitionWorkflowBridge } from './workflow-bridge.js';
import { cognitionArgumentAliases, cognitionSourceFields } from './cognition-fields.js';

const forbidden = new Set(['actor', 'actorId', 'admin', 'root', 'clearance', 'principal', 'can_admin', 'can_write', 'token', 'as_unit', 'tenant', 'master_key', '__proto__', 'constructor', 'prototype', 'bypassGain', 'bypass_gain', 'overwrite_live', 'force', 'op', 'action']);
const acceptedArguments = new Set(`intent view scope conditions query id goal includeRecent offset budgetTokens excerptStrategy mode session validity content contentKind dependsOn importanceHint gated consistency onConflict derivedFrom relation evidence verdict marker fact questions verificationTypes proposalId decision edits mergeInto olderThan kind sensitivity subjectId subjectKind trait position requestedLayer contractId grantor grantee docRef candidate excludeIds maxDepth autoFlywheel subject window dimension links rule missingCondition change entryId source dryRun intervals autoFlags allowEvolve pools queries ids kinds strategy seed minSeverity apply lexical startId blindspotId horizon maxBranches semantic sort predictedId actualId hit a b relationTypes direction reason protectionPolicy priority deadline actionHint taskId plan result acceptance boundary condition memory includeHistory text role meta limit slot old new seq path patterns skipDirs prune maxFiles maxItems incremental maxHeadingLevel ref roots maxNodes question message sessionId protocolId version declaration peer subsystem positionMap signature subjects pack child parent ledgerOnly note writeNote budget watermark maxEvents mineFixPairs includeContent since until tag outputTarget minJaccard minDelta minConfidence snapshotId sampleN prefix batch minCluster minMerge minImportance requireConditions sourceLayer targetLayer clues statement state windows neighbors sampleLimit branchId transcriptRef producer verifier allowDegrade cap cursor ordering aggregation expandNodes sourceRefs k feedback evidenceRefs hypothesis verificationBasis tags issueId knownClues expectedState actualState missingConditions events pairs`.split(/\s+/u));
for (const argument of 'name taskName nodeId taskStatus newStatus goalStatus goalText importance activeLimit doneLimit sources roles'.split(' ')) acceptedArguments.add(argument);
for (const argument of 'layer conditionSpace conditionRef stateRef timestamp statusSummary outputTarget out sources accepted acceptedVersions'.split(' ')) acceptedArguments.add(argument);
for (const argument of cognitionSourceFields) acceptedArguments.add(argument);
const adminMethods = new Set([
  'memory.protection.mark', 'memory.protection.protect', 'cognition.identity.anchor', 'cognition.identity.contract',
  'cognition.evolution.rollback', 'memory.lifecycle.forget', 'memory.lifecycle.restore', 'memory.recent.clear',
  'memory.review.decide', 'memory.review.verifyRecord', 'cognition.peer.policy', 'cognition.peer.deriveRebuild',
  'memory.maintenance.rollback', 'memory.maintenance.importance', 'memory.maintenance.longterm', 'memory.maintenance.prefeed',
  'memory.maintenance.separate', 'memory.maintenance.backfill', 'memory.maintenance.cap', 'memory.maintenance.exempt',
  'memory.maintenance.visionEvidence', 'memory.maintenance.refine', 'memory.maintenance.propagate',
  'memory.consolidation.promote', 'memory.consolidation.promoteRollback', 'memory.consolidation.induce',
  'memory.consolidation.contextualize', 'memory.consolidation.contextualizeRollback',
  'cognition.insight.branchMerge', 'cognition.insight.branchDiscard',
  'memory.export.graph', 'memory.export.nodes', 'memory.export.slice', 'memory.export.stat',
]);
function validateArgs(value: unknown, root: string, depth = 0): void {
  if (depth > 12) throw new NexusError('INVALID_ARGUMENT', '认知参数嵌套过深');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new NexusError('INVALID_ARGUMENT', '数值必须有限');
  if (Array.isArray(value)) { if (value.length > 1000) throw new NexusError('INPUT_TOO_LARGE', '数组超过1000项'); for (const item of value) validateArgs(item, root, depth + 1); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (forbidden.has(key)) throw new NexusError('TRUSTED_FIELD_REJECTED', '参数不可覆盖宿主身份、权限或内部根目录', { field: key });
    if (['path', 'outputTarget', 'out', 'file', 'directory', 'aeis_root', 'aeisRoot', 'goal_path', 'goalPath', 'signers_file', 'signersFile', 'swarm'].includes(key) && typeof item === 'string') {
      const path = resolve(root, item); const rel = relative(root, path);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new NexusError('PATH_OUTSIDE_WORKSPACE', '认知操作路径超出当前工程');
    }
    validateArgs(item, root, depth + 1);
  }
}
export class CognitionEngine {
  private lanes = new Map<string, Promise<unknown>>();
  constructor(private services: NexusServices) {}
  async call(root: string, params: JsonRecord, ctx?: DispatchContext): Promise<unknown> {
    const previous = this.lanes.get(root) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.execute(root, params, ctx));
    this.lanes.set(root, operation);
    try { return await operation; } finally { if (this.lanes.get(root) === operation) this.lanes.delete(root); }
  }
  private async execute(root: string, params: JsonRecord, ctx?: DispatchContext): Promise<unknown> {
    const capabilityId = String(params.capabilityId ?? 'memory.capabilities');
    const method = String(params.method ?? 'list');
    if (capabilityId === 'memory.capabilities') return { items: cognitionManifest, aliases: cognitionMethodAliases };
    const entry = cognitionManifest.find(item => item.id === capabilityId && item.methods.includes(method));
    if (!entry) throw new NexusError('UNKNOWN_METHOD', '未知高级认知能力或方法', { capabilityId, method });
    const args = (params.args ?? {}) as JsonRecord;
    for (const key of Object.keys(args)) if (!acceptedArguments.has(key) && !forbidden.has(key)) throw new NexusError('UNKNOWN_FIELD', '高级认知参数包含未声明字段', { field: key });
    validateArgs(args, root);
    assertNoSecret(args);
    if (Buffer.byteLength(JSON.stringify(args)) > entry.maxInputBytes) throw new NexusError('INPUT_TOO_LARGE', '认知参数超过64KiB');
    if (entry.sourceOp === 'session' && method === 'compact') return this.services.invoke('context', { action: 'compress', requestId: typeof params.requestId === 'string' ? params.requestId : undefined, params: args }, ctx);
    const settings = { value: await memorySettings(this.services, root, ctx) };
    if (settings?.value.cognitionEnabled !== true) throw new NexusError('MODULE_DISABLED', '高级认知引擎尚未启用；基础记忆保持可用', { enableAction: 'memory.configure', dependency: 'Python >=3.10' });
    const writes = !cognitionReadMethods.has(method) || args.apply === true || entry.sourceOp === 'task' && method === 'status';
    if (writes && !await this.services.host.approve('memory.advanced', `${capabilityId}.${method}`, { projectId: projectId(root) })) throw new NexusError('APPROVAL_REQUIRED', '高级认知写入或管理操作需要宿主授权');
    const exactMethod = `${capabilityId}.${method}`;
    const needsAdmin = adminMethods.has(exactMethod) || entry.sourceOp === 'insight' && args.apply === true ||
      entry.sourceOp === 'goal' && method === 'generate' && args.apply === true;
    const admin = ctx?.permissions?.has('memory.admin') === true || needsAdmin && await this.services.host.approve('memory.admin', exactMethod, { projectId: projectId(root), sessionId: ctx?.sessionId });
    if (needsAdmin && !admin) throw new NexusError('APPROVAL_REQUIRED', '此精确认知管理方法需要单独人工授权');
    const needsAnchor = exactMethod === 'cognition.identity.anchor' || ['anchor', 'self'].includes(String(args.requestedLayer ?? args.layer ?? ''));
    const anchor = ctx?.permissions?.has('memory.anchor') === true || needsAnchor && await this.services.host.approve('memory.anchor', exactMethod, { projectId: projectId(root), sessionId: ctx?.sessionId });
    if (needsAnchor && !anchor) throw new NexusError('APPROVAL_REQUIRED', '受保护认知层需要单独人工授权');
    if (['verifyEncoding', 'verifyExisting'].includes(method) && settings.value.whiteboxEnabled !== true) throw new NexusError('MODULE_DISABLED', '白箱语义验证需要单独启用并配置真实验证模型');
    const packageRoot = (this.services as NexusServices & { packageRoot?: string }).packageRoot;
    const vendor = packageRoot ? join(packageRoot, 'vendor', 'memory-cognition') : fileURLToPath(new URL('../../../vendor/memory-cognition/', import.meta.url));
    const engineRoot = join(this.services.dataDir, 'memory', 'cognition', memoryEngineScope(root, ctx));
    const auxRoot = join(this.services.dataDir, 'memory', 'cognition-state', memoryEngineScope(root, ctx));
    await mkdir(engineRoot, { recursive: true }); await mkdir(auxRoot, { recursive: true });
    const payload = {
      op: entry.sourceOp, action: cognitionMethodAliases[method] ?? method,
      args: Object.fromEntries(Object.entries(args).map(([key, value]) => [cognitionArgumentAliases[key] ?? key.replace(/[A-Z]/gu, letter => `_${letter.toLowerCase()}`), value])),
      trusted: { actor: ctx?.actorId ?? 'local-user', session: ctx?.sessionId ?? 'nexus-local', writable: writes, admin,
        layers: ['contextual', 'knowledge', 'structural', 'goals', ...(anchor ? ['anchor', 'self'] : [])] },
    };
    const result = await this.services.executor.run(String(settings.value.pythonCommand ?? 'python'), ['-X', 'utf8', join(vendor, 'nexus_bridge.py')], {
      cwd: root, signal: ctx?.signal, timeoutMs: Math.min(330000, Number(params.timeoutMs ?? 30000)),
      maxOutputBytes: entry.maxOutputBytes,
      env: { PYTHONPATH: vendor, MDCG_ROOT: engineRoot, MDCG_AUX_ROOT: auxRoot, MDCG_DATA_ROOT: auxRoot, MDCG_INGEST_ROOT: root, MDCG_EXPORT_ROOT: root,
        MDCG_LINKS_FILE: join(auxRoot, 'links.json'), MDCG_SIGNERS_FILE: join(auxRoot, 'signers.json'), MDCG_SIGNER_KEY_FILE: join(auxRoot, 'signer.key'), MDCG_SWARM_DIR: join(auxRoot, 'swarm'),
        MDCG_MASTER_KEY_PATH: join(auxRoot, 'master.key'), MDCG_AUTO_BACKUP: '0', OPENBLAS_NUM_THREADS: '1', PYTHONDONTWRITEBYTECODE: '1' },
      stdin: JSON.stringify(payload),
    } as Parameters<NexusServices['executor']['run']>[2]);
    if (result.cancelled) throw new NexusError('CANCELLED', '高级认知调用已取消');
    if (result.exitCode !== 0) throw new NexusError('ENGINE_FAILED', '认知引擎调用失败；未声称通过', { exitCode: result.exitCode, diagnostic: result.stderr.slice(0, 4000) });
    let output: JsonRecord;
    try { output = JSON.parse(result.stdout); } catch { throw new NexusError('INVALID_ENGINE_RESPONSE', '认知引擎未返回有效JSON'); }
    if (output.ok === false) throw new NexusError('ENGINE_REJECTED', String(output.error ?? '认知引擎拒绝请求'));
    const source = output.data as JsonRecord | undefined;
    if (source?.ok === false) throw new NexusError('ENGINE_REJECTED', String(source.error ?? '认知引擎拒绝请求'), source);
    let workflow: JsonRecord | undefined;
    if (source && ['task', 'goal'].includes(entry.sourceOp)) {
      try { workflow = await new CognitionWorkflowBridge(this.services).reconcile(root, entry.sourceOp, method, args, source, ctx); }
      catch (error) { workflow = { state: 'reconcile_required', sourceCommitted: writes, executionStarted: false, code: (error as NexusError).code ?? 'BRIDGE_FAILED', message: (error as Error).message }; }
    }
    return { ...output, workflow, source: 'vendored-md_cg', capabilityId, method, engineGeneration: digest(stableJson(settings.value)) };
  }
}
