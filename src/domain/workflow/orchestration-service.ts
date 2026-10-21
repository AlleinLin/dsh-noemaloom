import { realpath, stat } from 'node:fs/promises';
import { NexusError, type DispatchContext, type JsonRecord, type NexusRequest, type NexusServices } from '../../ports/contracts.js';
import {
  FRAMEWORK_CATALOG, GATE_LIBRARY, ROLE_IDS, adaptationSignature, checkAdaptationCapacity, classifyTaskShape,
  compileBlueprint, createBuiltinBlueprint, createHandoffManifest, evaluateAdaptationPromotion,
  guardAdaptation, isAdaptationActive, modelKey, policyHash, readFrameworkText, readRoleAssets,
  resolveModelReference, selectAdaptations, selectRoute, validateBlueprint, generateFrameworkLeaf, validateGeneratedLeaf,
  generatedLeafBlueprint,
  type Adaptation, type AdaptationApplication, type AdaptationEvaluation, type AffinityLease,
  type CheckPolicy, type GatePolicy, type ModelCandidate, type ModelRef, type RoleModelPolicy,
  type GeneratedLeaf, type RouteDecision, type RouteSelectionInput, type TaskShape, type WorkflowBlueprint,
} from '../orchestration/index.js';
import { digest, newId, now, object, required, revision, safePath, text } from './util.js';
import { validatePlan } from './plan.js';
import type { Oracle, RouteBinding, Run, TaskNode } from './types.js';
import { prepareAdaptationCompilation, saveCompiledPlan, type LearningSettings } from './adaptation-compiler.js';

/** Shared scheduler consumes this metadata; no second runtime or lease authority exists here. */
interface CompiledNode extends TaskNode {
  routeDecision?: RouteDecision;
  routingInput?: RouteSelectionInput;
  cacheLease?: AffinityLease | null;
  orchestration?: {
    blueprintNodeId: string; gateId?: string; gatePolicy?: GatePolicy; candidateRole: string;
    authorNodeIds: string[]; priorReviewerNodeIds: string[]; subjectNodeId?: string;
    contextLineageId: string; evidenceInputKinds: string[]; rootOwned: boolean;
    sourceMethodRefs: string[]; capabilityIds: string[];
  };
}
interface IndependenceOracle extends Oracle { subjectNodeId?: string; contextLineageId?: string }
interface GeneratedLeafRecord {
  leaf: GeneratedLeaf; validation: ReturnType<typeof validateGeneratedLeaf>; createdAt: string;
  ownerSessionId: string; ownerScopeId: string; projectScopeId: string; hash: string;
  use: 'task-only';
}
interface LeafGeneration {
  ownerSessionId: string; ownerScopeId: string; projectScopeId: string; attempts: number;
  diagnostics: { attempt: number; inputHash: string; status: string; details: unknown; requestId?: string }[];
  leafId?: string; result?: GeneratedLeafRecord;
}
interface GraphSpan { entries: string[]; exits: string[] }
const sourceCommit = 'metis:8b1eda95afea3592e08a315e29dc7746ee57ca25';
const readOnlyRoles = new Set(['reviewer', 'verifier', 'fresh-verifier', 'juror', 'arbiter', 'goal-checker', 'framework-validator']);
const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.map(item => text(item, 'reference', 4096)) : [];
const optionalNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export class OrchestrationService {
  constructor(private readonly services: NexusServices) {}

  async models(): Promise<{ items: ModelCandidate[]; inheritance: string; raw: unknown }> {
    let raw: unknown;
    try { raw = await this.services.host.sessions('models/list', {}); }
    catch (error) { raw = { items: [], reason: error instanceof Error ? error.message : '正式宿主模型目录不可用' }; }
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as JsonRecord).items)
      ? (raw as { items: unknown[] }).items : [];
    const items = list.map((value): ModelCandidate => {
      const row = object(value), inputRef = row.ref && typeof row.ref === 'object' ? object(row.ref) : row;
      const ref: ModelRef = {
        providerRouteId: String(inputRef.providerRouteId ?? inputRef.provider ?? ''),
        modelId: String(inputRef.modelId ?? inputRef.model ?? inputRef.id ?? ''),
        endpointIdentity: String(inputRef.endpointIdentity ?? ''), protocol: String(inputRef.protocol ?? ''),
        revision: typeof inputRef.revision === 'string' ? inputRef.revision : undefined,
        credentialScopeId: typeof inputRef.credentialScopeId === 'string' ? inputRef.credentialScopeId : undefined,
        region: typeof inputRef.region === 'string' ? inputRef.region : undefined,
      };
      const capabilities: ModelCandidate['capabilities'] = {};
      if (row.capabilities && typeof row.capabilities === 'object') {
        for (const [name, value] of Object.entries(object(row.capabilities))) {
          if (!value || typeof value !== 'object') continue;
          const fact = object(value);
          if (['verified', 'declared', 'unknown', 'unsupported'].includes(String(fact.state)) && typeof fact.source === 'string') {
            capabilities[name as keyof ModelCandidate['capabilities']] = fact as unknown as NonNullable<ModelCandidate['capabilities']['text']>;
          }
        }
      }
      return {
        ref, capabilities, executorIds: Array.isArray(row.executorIds) ? asStrings(row.executorIds) : ['dsh-subagent'],
        authorized: row.authorized === true, credentialAvailable: row.credentialAvailable === true,
        credentialState: ['available', 'unavailable', 'unknown'].includes(String(row.credentialState))
          ? row.credentialState as ModelCandidate['credentialState'] : row.credentialAvailable === true ? 'available' : 'unavailable',
        health: ['healthy', 'degraded', 'open-circuit'].includes(String(row.health)) ? row.health as ModelCandidate['health'] : 'unknown',
        expiresAt: typeof row.expiresAt === 'string' ? row.expiresAt : undefined,
        price: row.price as ModelCandidate['price'], quality: row.quality as ModelCandidate['quality'],
        latencyP95Ms: optionalNumber(row.latencyP95Ms), cacheReuseEstimate: optionalNumber(row.cacheReuseEstimate),
        failureRisk: optionalNumber(row.failureRisk),
        contextLineageIds: Array.isArray(row.contextLineageIds) ? asStrings(row.contextLineageIds) : undefined,
      };
    }).filter(candidate => candidate.ref.providerRouteId && candidate.ref.modelId && candidate.ref.endpointIdentity && candidate.ref.protocol);
    return { items: [...new Map(items.map(candidate => [modelKey(candidate.ref), candidate])).values()],
      inheritance: 'inherited-only; actual availability is checked against the live host before dispatch', raw };
  }

  private policy(value: unknown): RoleModelPolicy {
    const raw = value === undefined ? { mode: 'inherit', candidates: [], strictPool: true, minCapabilities: [{ capability: 'text' }] } : object(value, 'modelPolicy');
    if (!['inherit', 'pinned', 'ordered', 'scored'].includes(String(raw.mode)) || !Array.isArray(raw.candidates) || !Array.isArray(raw.minCapabilities)) {
      throw new NexusError('INVALID_ARGUMENT', '模型策略必须包含有效 mode、candidates 和 minCapabilities。');
    }
    if (raw.mode !== 'inherit' && raw.candidates.length === 0) throw new NexusError('ROUTE_POOL_EMPTY', '显式模型策略没有候选。');
    if (raw.strictPool !== undefined && typeof raw.strictPool !== 'boolean') throw new NexusError('INVALID_ARGUMENT', 'strictPool 必须是布尔值。');
    const capabilityIds = ['text', 'image', 'audio', 'toolCalling', 'structuredOutput', 'streaming', 'cancellation',
      'contextWindow', 'maxOutputTokens', 'reasoningEffort', 'cacheModes', 'dataResidency'];
    for (const rule of raw.minCapabilities) {
      const item = object(rule, 'minCapabilities');
      if (!capabilityIds.includes(String(item.capability))) throw new NexusError('INVALID_ARGUMENT', '未知能力要求。');
    }
    return structuredClone(raw) as unknown as RoleModelPolicy;
  }
  private async routeInput(p: JsonRecord, context: DispatchContext, catalog: ModelCandidate[],
    roleId: string, nodeId: string, policy: RoleModelPolicy, prompt: string, maxOutputTokens: number): Promise<RouteSelectionInput> {
    const facts = await this.services.host.facts(), caps = Array.isArray(facts.capabilities) ? facts.capabilities : [];
    const approvedPool = p.approvedPool === undefined ? catalog.map(candidate => candidate.ref) :
      (Array.isArray(p.approvedPool) ? p.approvedPool.map(reference => resolveModelReference(reference as string | ModelRef, catalog).ref) :
        (() => { throw new NexusError('INVALID_ARGUMENT', 'approvedPool 必须是完整模型引用数组。'); })());
    return {
      id: newId('route'), nodeId, nodeAttempt: 1, roleId, policy, catalog: structuredClone(catalog), approvedPool,
      inheritAvailable: facts.inheritAvailable === true || (caps.includes('subagents') && Boolean(context.sessionId)),
      hostSupportsAgentOptions: facts.agentOptionsSupported === true || caps.includes('subagents'),
      allowedExecutorIds: Array.isArray(p.allowedExecutorIds) ? asStrings(p.allowedExecutorIds) : ['dsh-subagent'],
      inputTokens: Math.max(Buffer.byteLength(prompt, 'utf8'), optionalNumber(p.inputTokens) ?? 0),
      maxOutputTokens, toolSchemaTokens: optionalNumber(p.toolSchemaTokens), retriesReserved: optionalNumber(p.retriesReserved) ?? 1,
      unknownCostPolicy: p.unknownCostPolicy ? object(p.unknownCostPolicy) as unknown as RouteSelectionInput['unknownCostPolicy'] : { mode: 'block' },
      authorizationRef: typeof p.authorizationRef === 'string' ? p.authorizationRef : `session:${context.sessionId ?? 'local'}`,
      capabilitySnapshotRef: digest(facts), policyHash: policyHash(policy), now: now(),
      cache: { promptEpoch: String(p.promptEpoch ?? '1'), toolSurfaceEpoch: String(p.toolSurfaceEpoch ?? '1'),
        rendererVersion: String(p.rendererVersion ?? '1'), namespace: String(p.cacheNamespace ?? context.sessionId ?? 'local') },
      currentAffinity: p.currentAffinity as RouteSelectionInput['currentAffinity'],
      hysteresisThreshold: optionalNumber(p.hysteresisThreshold), remainingBudget: p.remainingBudget as RouteSelectionInput['remainingBudget'],
      allowedRegions: Array.isArray(p.allowedRegions) ? asStrings(p.allowedRegions) : undefined,
      excludedModelKeys: Array.isArray(p.excludedModelKeys) ? asStrings(p.excludedModelKeys) : undefined,
      excludedContextLineageIds: Array.isArray(p.excludedContextLineageIds) ? asStrings(p.excludedContextLineageIds) : undefined,
    };
  }

  async routes(request: NexusRequest, context: DispatchContext): Promise<unknown> {
    const p = request.params ?? {}, action = request.action.replace('routes/', '');
    if (action === 'list') return (await this.services.store.list<{ ownerSessionId: string }>('orchestration-routes'))
      .filter(row => row.value.ownerSessionId === (context.sessionId ?? 'local') || context.permissions?.has('workflow:all'));
    if (action === 'resolve') return resolveModelReference(text(p.reference, 'reference', 4096), (await this.models()).items);
    if (action === 'select') {
      const catalog = (await this.models()).items;
      const input = await this.routeInput(p, context, catalog, String(p.roleId ?? 'implementer'), String(p.nodeId ?? 'preview'),
        this.policy(p.policy), typeof p.prompt === 'string' ? p.prompt : '', optionalNumber(p.maxOutputTokens) ?? 4096);
      const decision = selectRoute(input);
      await this.services.store.put('orchestration-routes', decision.id, { decision, routingInput: input,
        state: 'proposed', ownerSessionId: context.sessionId ?? 'local' }, 0);
      return decision;
    }
    throw new NexusError('INVALID_ARGUMENT', '未知 routes action');
  }

  private async shape(value: unknown, context: DispatchContext): Promise<TaskShape> {
    const workspace = await realpath(context.workspaceRoot ?? this.services.workspaceRoot);
    const input = value ? structuredClone(object(value, 'shape')) as unknown as TaskShape : {
      executionRequested: true, fullySpecified: false, designFork: false, lowImpact: false, allowAgents: true,
      surfaces: [{ id: 'integrated', paths: [workspace], resources: [], ready: true, validated: true }], dependencies: [],
    };
    if (!Array.isArray(input.surfaces) || !Array.isArray(input.dependencies)) throw new NexusError('INVALID_ARGUMENT', 'shape 缺少 surfaces/dependencies。');
    for (const surface of input.surfaces) {
      if (!Array.isArray(surface.paths) || !Array.isArray(surface.resources)) throw new NexusError('INVALID_ARGUMENT', 'ownership surface 需要 paths/resources。');
      surface.validated = true;
      for (let index = 0; index < surface.paths.length; index++) {
        const path = safePath(workspace, surface.paths[index]!);
        try {
          const canonical = await realpath(path);
          safePath(workspace, canonical); await stat(canonical); surface.paths[index] = canonical;
        } catch {
          if (surface.planned) { surface.paths[index] = path; surface.validated = false; surface.ready = false; }
          else throw new NexusError('OWNERSHIP_PATH_INVALID', 'Ownership 路径不存在、链接越界或不可访问。', { surfaceId: surface.id, path });
        }
      }
    }
    return input;
  }

  async blueprints(request: NexusRequest, context: DispatchContext): Promise<unknown> {
    const p = request.params ?? {}, action = request.action.replace('blueprints/', '');
    if (action === 'generate') {
      const scope = this.scopeIds(context);
      const generationId = p.generationId === undefined
        ? request.requestId ? `leaf-generation-${digest([context.sessionId ?? 'local', scope.user, scope.project, request.requestId]).slice(0, 48)}` : newId('leaf-generation')
        : text(p.generationId, 'generationId', 128);
      const previous = await this.services.store.get<LeafGeneration>('orchestration-leaf-generations', generationId);
      if (previous && (previous.value.ownerSessionId !== (context.sessionId ?? 'local') ||
        previous.value.ownerScopeId !== scope.user || previous.value.projectScopeId !== scope.project)) {
        throw new NexusError('SCOPE_MISMATCH', '生成尝试属于其他私有任务。');
      }
      if (previous?.value.result && previous.value.leafId) {
        if (previous.value.diagnostics.at(-1)?.inputHash !== digest(p.input)) {
          throw new NexusError('REVISION_CONFLICT', '已成功的生成任务不可改绑输入；新任务需使用新 identity。', { generationId });
        }
        const saved = await this.services.store.get<GeneratedLeafRecord>('orchestration-generated-leaves', previous.value.leafId);
        const result = saved ?? await this.services.store.put('orchestration-generated-leaves', previous.value.leafId, previous.value.result, 0);
        return { ...result, generationId, generationAttempt: previous.value.attempts };
      }
      const repeated = request.requestId && previous?.value.diagnostics.find(item => item.requestId === request.requestId);
      if (repeated) {
        if (repeated.inputHash !== digest(p.input)) throw new NexusError('REVISION_CONFLICT', '同一生成 requestId 不能改绑输入。', { generationId });
        throw new NexusError(repeated.status === 'OUT_OF_SCOPE' ? 'OUT_OF_SCOPE' : 'GENERATED_LEAF_REGENERATE',
          '返回该次已记录生成诊断，未重复尝试。', { generationId, attempt: repeated.attempt, status: repeated.status, details: repeated.details });
      }
      const attempt = (previous?.value.attempts ?? 0) + 1;
      if (attempt > 2) throw new NexusError('OUT_OF_SCOPE', '同一生成任务只允许一次重生。', { generationId, diagnostics: previous?.value.diagnostics });
      if (p.generationAttempt !== undefined && p.generationAttempt !== attempt) {
        throw new NexusError('REVISION_CONFLICT', 'generationAttempt 必须匹配服务端下一次尝试，不能重置或跳过。', { generationId, expectedAttempt: attempt });
      }
      let leaf: GeneratedLeaf | undefined, failure: unknown;
      try { leaf = generateFrameworkLeaf(object(p.input) as unknown as Parameters<typeof generateFrameworkLeaf>[0]); }
      catch (error) { failure = error instanceof NexusError ? { code: error.code, details: error.details } : { code: 'GENERATED_LEAF_INPUT_INVALID' }; }
      const validation = leaf ? validateGeneratedLeaf(leaf, attempt) : {
        valid: false, status: attempt < 2 ? 'regenerate' : 'OUT_OF_SCOPE', issues: ['GENERATED_LEAF_INPUT_INVALID'],
      };
      const generation: LeafGeneration = {
        ownerSessionId: context.sessionId ?? 'local', ownerScopeId: scope.user, projectScopeId: scope.project,
        attempts: attempt, diagnostics: [...(previous?.value.diagnostics ?? []), {
          attempt, inputHash: digest(p.input), status: validation.status, details: failure ?? validation, requestId: request.requestId,
        }],
      };
      if (leaf && validation.valid) {
        const id = newId('leaf');
        generation.leafId = id;
        generation.result = { leaf, validation: validation as ReturnType<typeof validateGeneratedLeaf>, createdAt: now(),
          ownerSessionId: context.sessionId ?? 'local', ownerScopeId: scope.user, projectScopeId: scope.project,
          hash: digest(leaf), use: 'task-only' };
      }
      await this.services.store.put('orchestration-leaf-generations', generationId, generation, previous?.revision ?? 0);
      if (!generation.result || !generation.leafId) throw new NexusError(attempt < 2 ? 'GENERATED_LEAF_REGENERATE' : 'OUT_OF_SCOPE',
        '生成框架未通过约束，诊断已保留。', { generationId, ...validation });
      const saved = await this.services.store.put<GeneratedLeafRecord>('orchestration-generated-leaves', generation.leafId, generation.result, 0);
      return { ...saved, generationId, generationAttempt: attempt };
    }
    if (action === 'validate_leaf') return validateGeneratedLeaf(p.leaf, p.generationAttempt === undefined ? 1 : p.generationAttempt);
    if (action === 'leaves/list') {
      const ids = this.scopeIds(context);
      return (await this.services.store.list<GeneratedLeafRecord>('orchestration-generated-leaves'))
        .filter(row => row.value.ownerSessionId === (context.sessionId ?? 'local') &&
          row.value.ownerScopeId === ids.user && row.value.projectScopeId === ids.project)
        .map(row => ({ id: row.id, revision: row.revision, hash: row.value.hash, createdAt: row.value.createdAt,
          axes: row.value.leaf.axes, mission: row.value.leaf.mission, use: row.value.use }));
    }
    if (action === 'leaves/get') return this.generatedLeaf(text(p.leafId ?? p.id, 'leafId', 128), context);
    if (action === 'leaves/generation') {
      const row = await required<LeafGeneration>(this.services, 'orchestration-leaf-generations', text(p.generationId, 'generationId', 128));
      const scope = this.scopeIds(context);
      if (row.value.ownerSessionId !== (context.sessionId ?? 'local') || row.value.ownerScopeId !== scope.user ||
        row.value.projectScopeId !== scope.project) throw new NexusError('SCOPE_MISMATCH', '生成诊断属于其他私有任务。');
      return { id: row.id, revision: row.revision, attempts: row.value.attempts, diagnostics: row.value.diagnostics, leafId: row.value.leafId };
    }
    if (action === 'compile_leaf') {
      const leaf = await this.generatedLeaf(text(p.leafId, 'leafId', 128), context);
      if (p.leafHash !== undefined && p.leafHash !== leaf.value.hash) throw new NexusError('REVISION_CONFLICT', '生成框架版本已变化。');
      const shapeInput = await this.shape(p.shape, context);
      if (p.allowAgents === false) shapeInput.allowAgents = false;
      const shape = classifyTaskShape(shapeInput);
      if (shape.tier === 'FAST_PATH') throw new NexusError('TASK_CONTRACT_INCOMPLETE', '生成框架编译需要明确执行请求。');
      // The descriptor supplies method semantics, never a replacement goal or capability authority.
      return this.compile(generatedLeafBlueprint(leaf.value.leaf, shape.tier), shapeInput, p, context,
        { id: leaf.id, hash: leaf.value.hash, leaf: leaf.value.leaf });
    }
    if (action === 'catalog') return { frameworks: FRAMEWORK_CATALOG, roles: ROLE_IDS, gates: GATE_LIBRARY };
    if (action === 'framework') {
      const framework = FRAMEWORK_CATALOG.find(item => item.id === p.id);
      if (!framework) throw new NexusError('NOT_FOUND', 'Framework 不存在。');
      return { ...framework, content: readFrameworkText(framework.id) };
    }
    if (action === 'roles') return readRoleAssets();
    if (action === 'list') return {
      builtin: (['T0', 'T1', 'T2', 'T3'] as const).map(tier => createBuiltinBlueprint({ id: `builtin-${tier}`, tier, verificationKind: 'code-behavior' })),
      saved: await this.services.store.list<WorkflowBlueprint>('orchestration-blueprints'),
    };
    const supplied = p.blueprint ? object(p.blueprint, 'blueprint') as unknown as WorkflowBlueprint : undefined;
    const id = typeof p.id === 'string' ? p.id : typeof p.blueprintId === 'string' ? p.blueprintId : supplied?.id ?? newId('blueprint');
    const row = await this.services.store.get<WorkflowBlueprint>('orchestration-blueprints', id);
    const builtin = id.startsWith('builtin-') && ['T0', 'T1', 'T2', 'T3'].includes(id.slice(8))
      ? createBuiltinBlueprint({ id, tier: id.slice(8) as 'T0' | 'T1' | 'T2' | 'T3', verificationKind: 'code-behavior' }) : undefined;
    if (action === 'get') {
      if (!row && !builtin) throw new NexusError('NOT_FOUND', '蓝图不存在');
      return row ?? { id, revision: 1, value: builtin };
    }
    if (action === 'save' || action === 'validate') {
      if (!supplied) throw new NexusError('INVALID_ARGUMENT', 'blueprint 是必需字段。');
      const blueprint = { ...supplied, id, revision: (row?.value.revision ?? 0) + 1 };
      const validation = validateBlueprint(blueprint, { current: row?.value ?? builtin });
      if (!validation.valid) throw new NexusError('INVALID_ARGUMENT', '蓝图未通过约束校验', validation);
      if (action === 'validate') return validation;
      const saved = await this.services.store.put('orchestration-blueprints', id, blueprint,
        row ? revision(request.expectedRevision ?? p.expectedRevision) : 0);
      await this.services.store.put('orchestration-blueprint-history', `${id}:${saved.revision}`, { blueprint, hash: validation.hash }, 0);
      return saved;
    }
    if (action === 'compile') {
      const shapeInput = await this.shape(p.shape, context);
      if (p.allowAgents === false) shapeInput.allowAgents = false;
      const shape = classifyTaskShape(shapeInput);
      if (shape.tier === 'FAST_PATH') return { shape, executionRequested: false, plan: null, reason: '没有执行请求，不自动创建 DAG 或 worker。' };
      const blueprint = supplied ?? row?.value ?? builtin ?? createBuiltinBlueprint({
        id: 'builtin-shape', tier: shape.tier, verificationKind: 'code-behavior',
      });
      return this.compile(blueprint, shapeInput, p, context);
    }
    throw new NexusError('INVALID_ARGUMENT', '未知 blueprints action');
  }

  private toOracle(check: CheckPolicy): Oracle | undefined {
    if (check.kind === 'artifact') return { id: check.id, kind: 'artifact', artifactId: check.artifactRef, nonEmpty: check.nonEmpty, sha256: check.expectedHash };
    // A method's check ID is not a real command, browser runner or metric output path.
    // The delivery contract must supply its structured actual oracle explicitly.
    return undefined;
  }
  private async generatedLeaf(id: string, context: DispatchContext) {
    const row = await required<GeneratedLeafRecord>(this.services, 'orchestration-generated-leaves', id), ids = this.scopeIds(context);
    if (row.value.ownerSessionId !== (context.sessionId ?? 'local') || row.value.ownerScopeId !== ids.user ||
      row.value.projectScopeId !== ids.project) throw new NexusError('SCOPE_MISMATCH', '生成方法仅供所属任务会话和项目读取/编译。');
    const validation = validateGeneratedLeaf(row.value.leaf, 2);
    if (digest(row.value.leaf) !== row.value.hash || !validation.valid) throw new NexusError('EVIDENCE_MISMATCH', '生成方法归档不完整或校验失败。', validation);
    return row;
  }
  private checkPolicyOracles(gate: GatePolicy, checks: Oracle[]): void {
    const seen = new Set<string>();
    for (const check of checks) if (check.id) {
      if (seen.has(check.id)) throw new NexusError('INVALID_ARGUMENT', '同一门的 oracle ID 不得重复。', { gateId: gate.gateId, checkId: check.id });
      seen.add(check.id);
    }
    for (const check of gate.checks.filter(item => item.required)) {
      const oracle = checks.find(item => item.id === check.id);
      if (!oracle) throw new NexusError('GATE_EVIDENCE_MISSING', '编译需要为每条必需 policy check 配置真实 oracle。', { gateId: gate.gateId, checkId: check.id });
      if ((check.kind === 'command' && (oracle.kind !== 'command' || !oracle.command ||
        oracle.expectedExitCode !== undefined && oracle.expectedExitCode !== (check.expectedExit ?? 0))) ||
        (check.kind === 'artifact' && (oracle.kind !== 'artifact' || check.artifactRef !== undefined && oracle.artifactId !== check.artifactRef ||
          check.nonEmpty === true && oracle.nonEmpty !== true || check.expectedHash !== undefined && oracle.sha256 !== check.expectedHash))) {
        throw new NexusError('EVIDENCE_MISMATCH', '必需 oracle 与冻结 policy 的类型或预期不一致。', { gateId: gate.gateId, checkId: check.id });
      }
      if (check.kind === 'metric') {
        const metric = check.metric, tolerance = metric?.tolerance ?? 0;
        if (oracle.kind !== 'metric' || !oracle.path || oracle.datasetRef !== check.datasetRef || !metric ||
          !Number.isFinite(tolerance) || tolerance < 0 ||
          (metric.operator === '>=' && oracle.min !== metric.threshold - tolerance) ||
          (metric.operator === '<=' && oracle.max !== metric.threshold + tolerance) ||
          (metric.operator === '==' && (oracle.min !== metric.threshold - tolerance || oracle.max !== metric.threshold + tolerance)) ||
          (metric.operator === '>' && (oracle.min !== metric.threshold - tolerance || oracle.minExclusive !== true)) ||
          (metric.operator === '<' && (oracle.max !== metric.threshold + tolerance || oracle.maxExclusive !== true)) ||
          (['>=', '=='].includes(metric.operator) && oracle.minExclusive === true) ||
          (['<=', '=='].includes(metric.operator) && oracle.maxExclusive === true)) {
          throw new NexusError('EVIDENCE_MISMATCH', 'Metric oracle 必须绑定冻结数据集、阈值、严格边界和容差。', { gateId: gate.gateId, checkId: check.id });
        }
      }
    }
  }
  private async compile(blueprint: WorkflowBlueprint, shapeInput: TaskShape, p: JsonRecord, context: DispatchContext,
    generated?: { id: string; hash: string; leaf: GeneratedLeaf }): Promise<unknown> {
    if (blueprint.nodes.some(node => node.kind === 'framework' && node.ref.startsWith('generated:')) && !generated) {
      throw new NexusError('GENERATED_LEAF_REQUIRED', '生成框架必须通过 compile_leaf 读取已校验的本任务归档，不能只写字符串引用。');
    }
    const workspaceRoot = context.workspaceRoot ?? this.services.workspaceRoot;
    const shape = classifyTaskShape(shapeInput), compiled = compileBlueprint(blueprint, shape), goal = text(p.goal, 'goal', 20000);
    const adaptations = await prepareAdaptationCompilation(this.services, p, context, goal);
    const catalog = (await this.models()).items, roleAssets = readRoleAssets();
    const oracleMap = p.oracles ? object(p.oracles) : {}, prompts = p.prompts ? object(p.prompts) : {};
    const nodes: CompiledNode[] = [], spans = new Map<string, GraphSpan>();
    const routeRecords: { decision: RouteDecision; input: RouteSelectionInput }[] = [];
    const authors: string[] = [], reviewers: string[] = [], verifiers: string[] = [];
    const declaredRoles = new Map(compiled.snapshot.roles.map(binding => [binding.roleId, binding]));
    const byId = new Map(compiled.snapshot.nodes.map(node => [node.id, node]));
    let authorClaims = shapeInput.surfaces.flatMap(surface => [...surface.paths, ...surface.resources.map(resource => `resource:${resource}`)]);
    if (generated) {
      const allowedHarnesses = Array.isArray(p.allowedExecutorIds) ? asStrings(p.allowedExecutorIds) : ['dsh-subagent'];
      if (!['host', 'workflow-runtime', ...allowedHarnesses].includes(generated.leaf.harnessRef)) {
        throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '生成方法的 harnessRef 未映射到本任务允许的正式执行器。');
      }
      const generatedPaths: string[] = [];
      for (const claim of generated.leaf.ownedPaths) {
        const full = safePath(workspaceRoot, claim);
        const canonical = await realpath(full);
        safePath(workspaceRoot, canonical);
        if (!shapeInput.surfaces.some(surface => surface.paths.some(root => {
          try { safePath(root, canonical); return true; } catch { return false; }
        }))) throw new NexusError('SCOPE_MISMATCH', '生成方法 ownership 超出已授权任务路径。', { claim });
        generatedPaths.push(canonical);
      }
      if (generated.leaf.axes.targetLocus === 'in-repo' && !generatedPaths.length) {
        throw new NexusError('TASK_CONTRACT_INCOMPLETE', '仓库内生成方法必须声明已授权 ownership 路径。');
      }
      if (generated.leaf.axes.targetLocus === 'external-system' && !shapeInput.surfaces.some(surface => surface.resources.length)) {
        throw new NexusError('TASK_CONTRACT_INCOMPLETE', '外部系统生成方法必须声明当前任务授权的资源 ownership。');
      }
      authorClaims = [...generatedPaths, ...authorClaims.filter(claim => claim.startsWith('resource:'))];
    }
    const rootOwned = !compiled.spawnAllowed;
    const rootLimits = compiled.snapshot.budgets;
    const budgetOverrides = p.budgets ? object(p.budgets) : {};
    for (const [key, value] of Object.entries(budgetOverrides)) {
      const limit = rootLimits[key as keyof typeof rootLimits];
      if (limit !== undefined && limit !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > limit)) {
        throw new NexusError('BUDGET_EXHAUSTED', '任务预算只能缩小蓝图上限。', { key, upperBound: limit });
      }
    }
    const makeActor = async (blueprintNodeId: string, roleId: string, prompt: string, laneId?: string, gatePolicy?: GatePolicy): Promise<CompiledNode> => {
      const id = `${blueprintNodeId}:${roleId}`, binding = declaredRoles.get(roleId), lane = `${laneId ?? 'integrated'}:${roleId}`;
      const readOnly = readOnlyRoles.has(roleId), source = roleAssets.find(role => role.id === roleId);
      const capabilityIds = binding?.allowedCapabilityIds ?? (readOnly ? ['files.read', 'execution.authorized-test'] : ['files.read', 'files.write', 'execution.authorized-command']);
      if (generated && gatePolicy?.gateId === 'G4') prompt = [
        prompt, `冻结生成方法 ${generated.id}（${generated.hash}）；方法不覆盖原始目标或宿主授权。`,
        `三轴：${JSON.stringify(generated.leaf.axes)}`, `方法使命：${generated.leaf.mission}`,
        `输入引用：${generated.leaf.inputs.join(', ')}`, `执行 harness 参考：${generated.leaf.harnessRef}`,
        `接受条件：\n${generated.leaf.acceptanceCriteria.map(item => `- ${item}`).join('\n')}`,
        `来源：${generated.leaf.sourceRefs.join(', ')}`, '此方法不授权额外工具、发布或递归代理。',
      ].join('\n');
      prompt = adaptations.forNode({ id, roleId, blueprintNodeId, tier: shape.tier, prompt, capabilityIds,
        frameworkId: byId.get(blueprintNodeId)?.kind === 'framework' ? byId.get(blueprintNodeId)?.ref : undefined });
      const policy = this.policy(p.rolePolicies && typeof p.rolePolicies === 'object' ? object(p.rolePolicies)[roleId] ?? binding?.modelPolicy : binding?.modelPolicy), maxOutput = optionalNumber(p.maxOutputTokens) ?? 4096;
      const input = await this.routeInput({ ...p, cacheNamespace: `${context.sessionId ?? 'local'}:${lane}` },
        context, catalog, roleId, id, policy, prompt, maxOutput);
      const decision = selectRoute(input);
      const route: RouteBinding = { provider: decision.selectedModel?.providerRouteId, model: decision.selectedModel?.modelId,
        reasoningEffort: decision.effortResolved, credentialScope: decision.selectedModel?.credentialScopeId,
        laneId: lane, requireObserved: p.requireObservedRoutes === true };
      const claims: string[] = [];
      if (!readOnly && roleId === 'implementer') {
        for (const claim of binding?.ownedPathRules.length ? binding.ownedPathRules : authorClaims) {
          if (claim.startsWith('resource:')) {
            if (!authorClaims.includes(claim)) throw new NexusError('SCOPE_MISMATCH', '角色资源 claim 未获任务 ownership 授权。', { claim });
            claims.push(claim);
          } else claims.push(safePath(workspaceRoot, claim));
        }
      }
      const system = [
        `你执行 DSH Nexus 已冻结合同中的 ${roleId} 职责。任务目标与宿主授权优先。`,
        `本节点独立上下文，不得启动新的编排运行或递归创建代理。${readOnly ? '只读评审/验证，禁止修改生产路径。' : '仅修改本节点声明的 ownership。'}`,
        '不得以 PASS/VERIFIED 文本、退出码或自述冒充真实证据。缺少环境、能力或 oracle 必须报告 blocked。',
        `方法来源：${source?.description ?? roleId}。完整原文可在角色目录审查；原文不授予权限或固定覆盖率。`,
      ].join('\n');
      const node: CompiledNode = { id, kind: rootOwned ? 'prompt' : 'agent', role: roleId, actorId: newId(`actor-${roleId}`),
        depth: 3, allowChildren: false, prompt, system, route, cwd: workspaceRoot, maxTokens: maxOutput,
        routeDecision: decision, routingInput: input, cacheLease: decision.lease, dependsOn: [],
        writeClaims: claims,
        outputContracts: { nonEmpty: true },
        orchestration: { blueprintNodeId, gateId: gatePolicy?.gateId, gatePolicy: gatePolicy ? structuredClone(gatePolicy) : undefined,
          candidateRole: roleId, authorNodeIds: [...authors], priorReviewerNodeIds: [...reviewers],
          contextLineageId: newId('lineage'), evidenceInputKinds: ['mission', 'diff', 'raw-evidence', 'code', 'test'],
          rootOwned, sourceMethodRefs: [sourceCommit, `metis:role/${roleId}`],
          capabilityIds } };
      nodes.push(node); routeRecords.push({ decision, input });
      if (roleId === 'implementer') authors.push(id);
      else if (roleId === 'reviewer') reviewers.push(id);
      else if (['verifier', 'fresh-verifier'].includes(roleId)) verifiers.push(id);
      return node;
    };
    if (!generated && shape.tier === 'T3' && compiled.snapshot.nodes.filter(node => node.kind === 'gate' && node.ref === 'G4').length === 1 &&
      !compiled.snapshot.nodes.some(node => node.kind === 'framework' || node.kind === 'role')) {
      const laneSpans: { first: string; last: string }[] = [];
      for (const surface of shapeInput.surfaces) {
        const ownedClaims = [...surface.paths, ...surface.resources.map(resource => `resource:${resource}`)];
        let previous: string | undefined;
        let first = '';
        const laneAuthors: string[] = [], laneReviewers: string[] = [];
        for (const gateId of ['G4', 'G5', 'G6']) {
          const gate = compiled.snapshot.gates.find(policy => policy.gateId === gateId);
          if (!gate) throw new NexusError('INVALID_ARGUMENT', `T3 蓝图缺少 ${gateId}`);
          const role = gateId === 'G4' ? 'implementer' : gateId === 'G5' ? 'reviewer' : 'verifier';
          const actor = await makeActor(`lane:${surface.id}:${gateId}`, role,
            `${typeof prompts[role] === 'string' ? prompts[role] : goal}\n\n本 lane：${surface.id}\n唯一 ownership：${ownedClaims.join(', ')}\n其他 lane 由其他执行者负责。独立评审只看此 lane 文件及原始证据。`, surface.id, gate);
          actor.writeClaims = role === 'implementer' ? ownedClaims : [];
          actor.orchestration!.authorNodeIds = [...laneAuthors];
          actor.orchestration!.priorReviewerNodeIds = [...laneReviewers];
          if (previous) actor.dependsOn = [previous];
          if (!first) first = actor.id;
          if (role === 'implementer') laneAuthors.push(actor.id);
          if (role === 'reviewer') laneReviewers.push(actor.id);
          const source = oracleMap[`${gateId}:${surface.id}`] ?? oracleMap[gateId];
          if (!Array.isArray(source) || !source.length) throw new NexusError('GATE_EVIDENCE_MISSING', '每个并行 lane 需要独立真实 oracle', { gateId, laneId: surface.id });
          const checks: IndependenceOracle[] = structuredClone(source) as Oracle[];
          this.checkPolicyOracles(gate, checks);
          if (gate.independent) checks.push({ id: `${gateId}:${surface.id}:independence`, kind: 'independence', authorNodeIds: [...laneAuthors], reviewerNodeIds: gateId === 'G6' ? [...laneReviewers] : [], subjectNodeId: actor.id, requireDifferentModel: p.requireDifferentModel === true });
          const gateNode: CompiledNode = { id: `lane:${surface.id}:${gateId}:oracle`, kind: 'gate', role: `${gateId}-host-oracle`, actorId: newId('host-gate'), dependsOn: [actor.id], checks, writeClaims: [], orchestration: { blueprintNodeId: `lane:${surface.id}:${gateId}`, gateId, gatePolicy: structuredClone(gate), candidateRole: role, subjectNodeId: actor.id, authorNodeIds: [...laneAuthors], priorReviewerNodeIds: gateId === 'G6' ? [...laneReviewers] : [], contextLineageId: newId('host-lineage'), evidenceInputKinds: ['raw-evidence'], rootOwned: false, sourceMethodRefs: [sourceCommit], capabilityIds: ['evidence.validate'] } };
          nodes.push(gateNode); previous = gateNode.id;
        }
        laneSpans.push({ first, last: previous! });
      }
      for (const gateId of ['G2', 'sweep', 'goal-check']) {
        const gate = compiled.snapshot.gates.find(policy => policy.gateId === gateId);
        if (!gate) continue;
        const source = oracleMap[gateId];
        if (!Array.isArray(source) || !source.length) throw new NexusError('GATE_EVIDENCE_MISSING', 'Run 级检查需要真实 oracle', { gateId });
        this.checkPolicyOracles(gate, source as unknown as Oracle[]);
        const node: CompiledNode = { id: `run:${gateId}:oracle`, kind: 'gate', actorId: newId('host-gate'), checks: structuredClone(source) as Oracle[], dependsOn: gateId === 'G2' ? [] : gateId === 'sweep' ? laneSpans.map(span => span.last) : nodes.some(n => n.id === 'run:sweep:oracle') ? ['run:sweep:oracle'] : laneSpans.map(span => span.last), orchestration: { blueprintNodeId: `run:${gateId}`, gateId, gatePolicy: structuredClone(gate), candidateRole: 'host', authorNodeIds: [], priorReviewerNodeIds: [], contextLineageId: newId('host-lineage'), evidenceInputKinds: ['raw-evidence'], rootOwned: true, sourceMethodRefs: [sourceCommit], capabilityIds: ['evidence.validate'] } };
        nodes.push(node);
        if (gateId === 'G2') for (const span of laneSpans) nodes.find(n => n.id === span.first)!.dependsOn!.push(node.id);
      }
      const plan = validatePlan({ goal, scope: workspaceRoot, nodes, budgets: { ...Object.fromEntries(Object.entries(compiled.snapshot.budgets).filter(([, value]) => value !== null)), ...budgetOverrides }, deliveryContract: { requiredNodeIds: nodes.map(n => n.id), requireIndependentVerification: true }, authorizationRefs: p.authorizationRefs ?? [] }, { ...context, workspaceRoot: workspaceRoot });
      plan.provenance = { source: 'metis-compiler', blueprintSnapshot: compiled.snapshot, blueprintHash: compiled.snapshotHash, shape, lanes: shapeInput.surfaces.map(s => s.id), freeze: 'node-boundary', sourceCommit };
      if (adaptations.snapshot) plan.provenance.adaptationSnapshot = adaptations.snapshot;
      if (generated) plan.provenance.generatedLeafSnapshot = generated;
      plan.hash = digest({ ...plan, hash: undefined });
      const saved = await saveCompiledPlan(this.services, plan);
      for (const record of routeRecords) await this.services.store.put('orchestration-routes', record.decision.id, { decision: record.decision, routingInput: record.input, state: 'proposed', planId: plan.id, ownerSessionId: context.sessionId ?? 'local' }, 0);
      return { plan: saved, shape, snapshotHash: compiled.snapshotHash, assuranceGaps: compiled.assuranceGaps };
    }
    for (const blueprintNodeId of compiled.order) {
      const blueprintNode = byId.get(blueprintNodeId)!;
      if (blueprintNode.kind === 'complete' || blueprintNode.kind === 'tier') {
        spans.set(blueprintNodeId, { entries: [], exits: [] }); continue;
      }
      if (blueprintNode.kind !== 'gate') {
        const roleId = blueprintNode.kind === 'role' ? blueprintNode.ref : 'implementer';
        const framework = blueprintNode.kind === 'framework' ? FRAMEWORK_CATALOG.find(asset => asset.id === blueprintNode.ref) : undefined;
        const instructions = framework ? `框架：${framework.id}\n必要标准：${framework.doneCriteria.join('；')}\n完整方法原文作为版本化参考资产保留。` : '';
        const actor = await makeActor(blueprintNodeId, roleId, `${goal}\n${instructions}\n${typeof prompts[roleId] === 'string' ? prompts[roleId] : ''}`, blueprintNode.laneId);
        if (framework) actor.orchestration!.sourceMethodRefs.push(`metis:framework/${framework.id}`);
        spans.set(blueprintNodeId, { entries: [actor.id], exits: [actor.id] }); continue;
      }
      const gate = compiled.snapshot.gates.find(policy => policy.gateId === blueprintNode.ref)!;
      const closer = gate.gateId === 'G4' ? 'implementer' : gate.requiredRoles.find(roleId => declaredRoles.has(roleId)) ?? gate.requiredRoles[0];
      let actor: CompiledNode | undefined;
      if (closer && !['G0', 'G2', 'goal-check'].includes(gate.gateId)) {
        actor = await makeActor(blueprintNodeId, closer,
          typeof prompts[closer] === 'string' ? String(prompts[closer]) :
            `原始目标：${goal}\n本门职责：${gate.kind}\n仅根据真实项目文件、candidate diff 和原始证据判断；不继承作者自述、前位 verdict 或评审推理。未执行的动作不得声称已验证。`,
          blueprintNode.laneId, gate);
      }
      const supplied = oracleMap[gate.gateId];
      const checks: IndependenceOracle[] = Array.isArray(supplied) ? structuredClone(supplied) as Oracle[] :
        gate.checks.map(check => this.toOracle(check)).filter((oracle): oracle is Oracle => Boolean(oracle));
      this.checkPolicyOracles(gate, checks);
      if (checks.length === 0) throw new NexusError('GATE_EVIDENCE_MISSING', '执行前需要配置真实检查；空检查不能编译成通过路径。', { gateId: gate.gateId });
      if (gate.independent) {
        if (rootOwned || !actor) throw new NexusError('INDEPENDENCE_VIOLATION', '此蓝图要求独立 actor，但当前约束不允许独立上下文。', { gateId: gate.gateId, assuranceGaps: compiled.assuranceGaps });
        if (!authors.length) throw new NexusError('INDEPENDENCE_BASELINE_MISSING', '独立评审之前没有实现作者。', { gateId: gate.gateId });
        checks.push({ id: `${gate.gateId}:independence`, kind: 'independence', subjectNodeId: actor.id,
          contextLineageId: actor.orchestration!.contextLineageId, authorNodeIds: [...authors],
          reviewerNodeIds: gate.gateId === 'G6' ? [...reviewers] : gate.gateId === 'G7' ? [...reviewers, ...verifiers] : [],
          requireDifferentModel: p.requireDifferentModel === true });
      }
      const gateNode: CompiledNode = { id: `${blueprintNodeId}:oracle`, kind: 'gate', role: `${gate.gateId}-host-oracle`,
        dependsOn: actor ? [actor.id] : [], checks, actorId: newId('host-gate'), writeClaims: [],
        orchestration: { blueprintNodeId, gateId: gate.gateId, gatePolicy: structuredClone(gate),
          candidateRole: closer ?? 'host', subjectNodeId: actor?.id, authorNodeIds: [...authors],
          priorReviewerNodeIds: gate.gateId === 'G6' ? [...reviewers] : [], contextLineageId: newId('host-lineage'),
          evidenceInputKinds: ['raw-evidence'], rootOwned, sourceMethodRefs: [sourceCommit], capabilityIds: ['evidence.validate'] } };
      nodes.push(gateNode);
      spans.set(blueprintNodeId, { entries: actor ? [actor.id] : [gateNode.id], exits: [gateNode.id] });
    }
    if (!authors.length) throw new NexusError('BLUEPRINT_IMPLEMENTATION_MISSING', '执行蓝图没有 implementation 节点；不能在 baseline 之前插入作者。');
    const priorExits = (id: string, seen = new Set<string>()): string[] => {
      if (seen.has(id)) return [];
      seen.add(id);
      const span = spans.get(id);
      if (span?.exits.length) return span.exits;
      return compiled.snapshot.edges.filter(edge => edge.kind === 'dependency' && edge.to === id)
        .flatMap(edge => priorExits(edge.from, new Set(seen)));
    };
    const edges: { from: string; to: string }[] = [];
    for (const edge of compiled.snapshot.edges.filter(item => item.kind === 'dependency')) {
      for (const source of priorExits(edge.from)) for (const target of spans.get(edge.to)?.entries ?? []) {
        if (source !== target) edges.push({ from: source, to: target });
      }
    }
    const plan = validatePlan({
      goal, scope: workspaceRoot, nodes, edges,
      budgets: { ...Object.fromEntries(Object.entries(compiled.snapshot.budgets).filter(([, value]) => value !== null && value !== undefined)),
        ...budgetOverrides },
      deliveryContract: { requiredNodeIds: nodes.map(node => node.id), requireIndependentVerification: compiled.snapshot.tier !== 'T0' && compiled.spawnAllowed },
      authorizationRefs: Array.isArray(p.authorizationRefs) ? asStrings(p.authorizationRefs) : [],
    }, context);
    plan.provenance = { source: 'metis-compiler', blueprintId: compiled.snapshot.id, blueprintHash: compiled.snapshotHash,
      blueprintSnapshot: compiled.snapshot, shape, assuranceGaps: compiled.assuranceGaps,
      routeDecisionIds: routeRecords.map(record => record.decision.id), freeze: 'node-boundary', leaseState: 'proposed-not-acquired', sourceCommit };
    if (adaptations.snapshot) plan.provenance.adaptationSnapshot = adaptations.snapshot;
    if (generated) plan.provenance.generatedLeafSnapshot = generated;
    plan.hash = digest({ ...plan, hash: undefined });
    const saved = await saveCompiledPlan(this.services, plan);
    for (const record of routeRecords) await this.services.store.put('orchestration-routes', record.decision.id,
      { decision: record.decision, routingInput: record.input, state: 'proposed', planId: plan.id, ownerSessionId: context.sessionId ?? 'local' }, 0);
    return { plan: saved, shape, snapshotHash: compiled.snapshotHash, assuranceGaps: compiled.assuranceGaps };
  }

  private scopeIds(context: DispatchContext): { user: string; project: string } {
    return { user: context.actorId ?? context.sessionId ?? 'local-user', project: digest(context.workspaceRoot ?? this.services.workspaceRoot) };
  }
  private async settings(context: DispatchContext): Promise<LearningSettings> {
    const ids = this.scopeIds(context);
    return (await this.services.store.get<LearningSettings>('orchestration-settings', `learning:${ids.user}:${ids.project}`))?.value ??
      { enabled: false, projectTrusted: false, ownerScopeId: ids.user, projectScopeId: ids.project };
  }
  private assertAdaptationScope(adaptation: Adaptation, context: DispatchContext): void {
    const ids = this.scopeIds(context), expected = adaptation.scope === 'user' ? ids.user : ids.project;
    if (adaptation.scopeId !== expected && !context.permissions?.has('workflow:all')) throw new NexusError('SCOPE_MISMATCH', '学习项不属于当前用户或项目。', { expectedScopeId: expected });
  }
  private async assertRunEvidence(runId: string, evidenceRefs: string[], context: DispatchContext): Promise<Run> {
    const run = (await required<Run>(this.services, 'workflow-runs', runId)).value;
    if (run.ownerSessionId !== (context.sessionId ?? 'local') && !context.permissions?.has('workflow:all')) throw new NexusError('SCOPE_MISMATCH', '不能以其他私有会话作为学习样本。');
    if (!run.finishedAt || !evidenceRefs.length || evidenceRefs.some(ref => !run.artifacts.some(artifact => artifact.id === ref))) {
      throw new NexusError('GATE_EVIDENCE_MISSING', '评价需要已完成 Run 中的真实证据引用。');
    }
    return run;
  }
  async adaptations(request: NexusRequest, context: DispatchContext): Promise<unknown> {
    const p = request.params ?? {}, action = request.action.replace('adaptations/', ''), ids = this.scopeIds(context);
    if (action === 'settings/get') return this.settings(context);
    if (action === 'settings') {
      const id = `learning:${ids.user}:${ids.project}`, previous = await this.services.store.get('orchestration-settings', id);
      if (p.enabled !== undefined && typeof p.enabled !== 'boolean' || p.projectTrusted !== undefined && typeof p.projectTrusted !== 'boolean') {
        throw new NexusError('INVALID_ARGUMENT', 'enabled/projectTrusted 必须为布尔值。');
      }
      const holdoutPercent = p.holdoutPercent ?? 15;
      if (typeof holdoutPercent !== 'number' || !Number.isFinite(holdoutPercent) || holdoutPercent < 0 || holdoutPercent > 100) {
        throw new NexusError('INVALID_ARGUMENT', 'holdoutPercent 必须为 0–100。');
      }
      return this.services.store.put('orchestration-settings', id, { enabled: p.enabled === true, projectTrusted: p.projectTrusted === true,
        ownerScopeId: ids.user, projectScopeId: ids.project, holdoutPercent }, previous ? revision(request.expectedRevision ?? p.expectedRevision) : 0);
    }
    const settings = await this.settings(context);
    if (['history', 'trial', 'retire', 'rollback'].includes(action)) {
      const row = await required<Adaptation>(this.services, 'orchestration-adaptations', text(p.id, 'id', 128));
      this.assertAdaptationScope(row.value, context);
      if (action === 'history') return (await this.services.store.list<{ adaptation: Adaptation }>('orchestration-adaptation-history')).filter(h => h.value.adaptation.id === row.id);
      revision(request.expectedRevision ?? p.expectedRevision);
      let value = structuredClone(row.value);
      if (action === 'trial') {
        if (!settings.enabled || !['proposed', 'tentative'].includes(value.status)) throw new NexusError('INVALID_ARGUMENT', '仅学习已开启且待审候选可进入 trial');
        const guard = guardAdaptation(value, { trustedProject: settings.projectTrusted, currentScope: { kind: value.scope, id: value.scopeId } });
        if (!guard.accepted || guard.needsExplicitReview && (!value.review?.diffReviewed || !value.review.sourceVerified)) throw new NexusError('AUTHORIZATION_REQUIRED', '候选尚未完成必需审查', guard);
        value.status = 'trial';
      } else if (action === 'retire') value.status = 'retired';
      else {
        if (!Number.isSafeInteger(p.revision) || Number(p.revision) < 1 || Number(p.revision) >= row.revision) throw new NexusError('INVALID_ARGUMENT', 'rollback revision 必须是已存在的较早存储版本');
        const history = await required<{ adaptation: Adaptation; hash: string }>(this.services, 'orchestration-adaptation-history', `${row.id}:${p.revision}`);
        if (digest(history.value.adaptation) !== history.value.hash) throw new NexusError('EVIDENCE_MISMATCH', '学习历史 hash 不一致');
        value = { ...history.value.adaptation, revision: row.value.revision + 1, status: 'tentative' };
      }
      const saved = await this.services.store.put('orchestration-adaptations', row.id, value, Number(request.expectedRevision ?? p.expectedRevision));
      await this.services.store.put('orchestration-adaptation-history', `${row.id}:${saved.revision}`, { adaptation: value, hash: digest(value), action, sourceRevision: p.revision, createdAt: now() }, 0);
      return saved;
    }
    if (action === 'active') {
      const activation = { configured: settings.enabled, projectTrusted: settings.projectTrusted, explicit: p.enabled === false ? 'off' as const : undefined };
      if (!isAdaptationActive(activation)) return { active: [], heldOut: [], baselineUnchanged: true };
      const rows = await this.services.store.list<Adaptation>('orchestration-adaptations');
      const selected = selectAdaptations({ activation, load: () => rows.map(row => row.value), sessionId: context.sessionId ?? 'local',
        turnId: String(p.turnId ?? 'current'), scope: { kind: 'project', id: ids.project }, userScopeId: ids.user });
      return { active: selected.applied, heldOut: selected.heldOut, baselineUnchanged: selected.baselineUnchanged };
    }
    if (action === 'list') return (await this.services.store.list<Adaptation>('orchestration-adaptations'))
      .filter(row => row.value.scopeId === (row.value.scope === 'user' ? ids.user : ids.project));
    if (action === 'propose' || action === 'save') {
      const candidate = structuredClone(object(p.adaptation, 'adaptation')) as unknown as Adaptation;
      this.assertAdaptationScope(candidate, context);
      const row = await this.services.store.get<Adaptation>('orchestration-adaptations', candidate.id);
      const guard = guardAdaptation(candidate, { previous: row?.value, trustedProject: settings.projectTrusted,
        currentScope: { kind: candidate.scope, id: candidate.scopeId } });
      if (!guard.accepted) throw new NexusError('INVALID_ARGUMENT', '学习候选违反保护约束', guard);
      const current = (await this.services.store.list<Adaptation>('orchestration-adaptations')).map(record => record.value);
      const capacity = checkAdaptationCapacity({ current, candidate });
      if (!capacity.allowed) throw new NexusError('BUDGET_EXHAUSTED', '学习技能已达容量，先审查替换/退役计划', capacity);
      const duplicate = current.find(item => item.id !== candidate.id && adaptationSignature(item) === adaptationSignature(candidate));
      if (duplicate) throw new NexusError('REVISION_CONFLICT', '已存在同主题候选，应更新而非重复创建', { duplicateId: duplicate.id });
      // Promotion belongs to the evaluated content revision. Editing that revision
      // cannot inherit its old active verdict; retired/quarantined items stay stopped.
      const nextStatus = !row ? 'proposed' : ['retired', 'quarantined', 'proposed'].includes(row.value.status)
        ? row.value.status : 'tentative';
      const saved = await this.services.store.put('orchestration-adaptations', candidate.id,
        { ...candidate, status: nextStatus }, row ? revision(request.expectedRevision ?? p.expectedRevision) : 0);
      await this.services.store.put('orchestration-adaptation-history', `${candidate.id}:${saved.revision}`,
        { adaptation: saved.value, hash: digest(saved.value), guard }, 0);
      return saved;
    }
    if (action === 'applications/list') {
      const runs = await this.services.store.list<Run>('workflow-runs');
      const owned = new Set(runs.filter(row => row.value.ownerSessionId === (context.sessionId ?? 'local')).map(row => row.id));
      return (await this.services.store.list<AdaptationApplication>('orchestration-applications')).filter(row =>
        owned.has(row.value.runId) && (p.runId === undefined || row.value.runId === p.runId));
    }
    if (action === 'application' || action === 'applications/get') {
      if (p.record !== undefined) throw new NexusError('AUTHORIZATION_REQUIRED', '应用记录仅由冻结计划的编译/Run 接线生成，调用者不能自行声明。');
      const application = await required<AdaptationApplication>(this.services, 'orchestration-applications', text(p.id, 'id', 128));
      const run = (await required<Run>(this.services, 'workflow-runs', application.value.runId)).value;
      if (run.ownerSessionId !== (context.sessionId ?? 'local')) throw new NexusError('SCOPE_MISMATCH', '应用记录属于其他私有会话。');
      return application;
    }
    if (action === 'evaluation') {
      const data = structuredClone(object(p.record)), evaluation = data as unknown as AdaptationEvaluation;
      const application = (await required<AdaptationApplication>(this.services, 'orchestration-applications', text(evaluation.applicationId, 'applicationId', 128))).value;
      if (!['helped', 'hurt', 'neutral', 'unknown'].includes(evaluation.outcome) || !Number.isInteger(evaluation.revision) || evaluation.revision < 1) throw new NexusError('INVALID_ARGUMENT', '评价 outcome/revision 无效。');
      const evaluatedRun = await this.assertRunEvidence(application.runId, asStrings(evaluation.evidenceRefs), context);
      if (!evaluatedRun.nodeRuns[application.nodeId]?.attempt || evaluatedRun.planHash !== application.inputSnapshotHash) {
        throw new NexusError('EVIDENCE_MISMATCH', '尚未实际执行的节点不能形成学习效果评价。');
      }
      const adaptation = (await required<Adaptation>(this.services, 'orchestration-adaptations', application.adaptationId)).value;
      this.assertAdaptationScope(adaptation, context);
      const id = evaluation.applicationId, previous = await this.services.store.get<AdaptationEvaluation>('orchestration-evaluations', id);
      if (previous && evaluation.revision <= previous.value.revision) {
        if (digest(previous.value) === digest(data)) return previous;
        throw new NexusError('REVISION_CONFLICT', '评价修正必须递增 revision，不能重复加计。');
      }
      return this.services.store.put('orchestration-evaluations', id, { ...data, completedTask: true }, previous?.revision ?? 0);
    }
    if (action === 'evaluate') {
      const row = await required<Adaptation>(this.services, 'orchestration-adaptations', text(p.id, 'id', 128));
      this.assertAdaptationScope(row.value, context);
      const applications = (await this.services.store.list<AdaptationApplication>('orchestration-applications')).map(record => record.value);
      const evaluations = (await this.services.store.list<AdaptationEvaluation>('orchestration-evaluations')).map(record => record.value);
      let regressionPassed = false;
      if (typeof p.regressionRunId === 'string' && Array.isArray(p.regressionEvidenceRefs)) {
        const refs = asStrings(p.regressionEvidenceRefs), run = await this.assertRunEvidence(p.regressionRunId, refs, context);
        const actualChecks: { id?: string; status?: string }[] = [];
        for (const ref of refs) {
          const artifact = await required<{ content: string; hash: string }>(this.services, 'workflow-artifacts', ref);
          const owned = run.artifacts.find(item => item.id === ref)!;
          if (artifact.value.hash !== digest(artifact.value.content) || artifact.value.hash !== owned.hash ||
            run.nodeRuns[owned.nodeId]?.state !== 'succeeded' || !run.planSnapshot.nodes.some(node => node.id === owned.nodeId && node.kind === 'gate')) continue;
          try {
            const parsed: unknown = JSON.parse(artifact.value.content);
            if (Array.isArray(parsed)) actualChecks.push(...parsed as { id?: string; status?: string }[]);
            else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as JsonRecord).checks)) actualChecks.push(...(parsed as { checks: { id?: string; status?: string }[] }).checks);
          } catch { /* Invalid actual evidence cannot satisfy regressions. */ }
        }
        regressionPassed = run.state === 'succeeded' && row.value.regressionCases.every(checkId =>
          actualChecks.some(check => check.id === checkId && check.status === 'passed'));
      }
      const promotion = evaluateAdaptationPromotion({ adaptation: row.value, applications, evaluations, regressionPassed });
      const status = promotion.action === 'promote' ? 'active' : promotion.action === 'quarantine' ? 'quarantined' : row.value.status;
      if (status === row.value.status) return { ...row, promotion };
      const saved = await this.services.store.put('orchestration-adaptations', row.id, { ...row.value, status }, row.revision);
      await this.services.store.put('orchestration-adaptation-history', `${row.id}:${saved.revision}`,
        { adaptation: saved.value, promotion, hash: digest(saved.value), regressionEvidenceRefs: p.regressionEvidenceRefs ?? [] }, 0);
      return { ...saved, promotion };
    }
    throw new NexusError('INVALID_ARGUMENT', '未知 adaptations action');
  }

  handoff(params: JsonRecord): unknown {
    const input = object(params), from = object(input.from, 'from'), to = object(input.to, 'to');
    for (const [label, ref] of [['from', from], ['to', to]] as const) {
      for (const key of ['providerRouteId', 'modelId', 'endpointIdentity', 'protocol']) text(ref[key], `${label}.${key}`, 4096);
    }
    if (!Array.isArray(input.blocks) || !Array.isArray(input.authorizationRefs)) throw new NexusError('INVALID_ARGUMENT', 'Handoff 缺少 blocks/authorizationRefs。');
    return createHandoffManifest({ from: from as unknown as ModelRef, to: to as unknown as ModelRef,
      fromPartition: text(input.fromPartition, 'fromPartition', 4096), toPartition: text(input.toPartition, 'toPartition', 4096),
      missionRef: text(input.missionRef, 'missionRef', 4096), contractRef: text(input.contractRef, 'contractRef', 4096),
      checkpointRef: text(input.checkpointRef, 'checkpointRef', 4096), artifactRefs: asStrings(input.artifactRefs),
      unresolved: asStrings(input.unresolved), authorizationRefs: asStrings(input.authorizationRefs),
      blocks: structuredClone(input.blocks) as Parameters<typeof createHandoffManifest>[0]['blocks'],
      maxSummaryBytes: optionalNumber(input.maxSummaryBytes) ?? 24000, allowSameProtocolContinuity: input.allowSameProtocolContinuity === true });
  }
}
