import { NexusError, type DispatchContext, type JsonRecord, type NexusServices, type StoredRecord } from '../../ports/contracts.js';
import { guardAdaptation, isAdaptationActive, selectAdaptations, type Adaptation, type AdaptationApplication } from '../orchestration/index.js';
import type { Run, TaskPlan } from './types.js';
import { digest, object, text } from './util.js';

export interface LearningSettings {
  enabled: boolean; projectTrusted: boolean; ownerScopeId: string; projectScopeId: string;
  holdoutPercent?: number;
}
interface FrozenRule {
  adaptation: Adaptation;
  contentHash: string;
  storageRevision: number;
  heldOut: boolean;
  assignments: { nodeId: string; matchedTriggers: string[] }[];
}
export interface AdaptationSnapshot {
  schemaVersion: 1;
  compiler: 'nexus-adaptation-compiler-v1';
  ownerSessionId: string;
  ownerScopeId: string;
  projectScopeId: string;
  turnId: string;
  decisionRef: string;
  settingsRevision: number;
  rules: FrozenRule[];
  rejected: { id: string; reason: string }[];
}
export interface AdaptationCompilation {
  snapshot?: AdaptationSnapshot;
  forNode(input: { id: string; roleId: string; blueprintNodeId: string; frameworkId?: string; tier: string; prompt: string; capabilityIds: string[] }): string;
}

/** Matching uses literal text or explicit structural selectors; never user-supplied regular expressions. */
function matches(trigger: string, facts: { goal: string; roleId: string; blueprintNodeId: string; frameworkId?: string; tier: string }): boolean {
  const value = trigger.trim().toLocaleLowerCase('en-US');
  if (value === '*') return true;
  const separator = value.indexOf(':');
  if (separator > 0) {
    const key = value.slice(0, separator), expected = value.slice(separator + 1);
    const actual = key === 'role' ? facts.roleId : key === 'framework' ? facts.frameworkId :
      key === 'tier' ? facts.tier : key === 'node' ? facts.blueprintNodeId : key === 'goal' ? facts.goal : undefined;
    if (actual !== undefined) return key === 'goal'
      ? actual.toLocaleLowerCase('en-US').includes(expected)
      : actual.toLocaleLowerCase('en-US') === expected;
    return false;
  }
  return facts.goal.toLocaleLowerCase('en-US').includes(value);
}

export async function prepareAdaptationCompilation(services: NexusServices, params: JsonRecord,
  context: DispatchContext, goal: string): Promise<AdaptationCompilation> {
  const disabled: AdaptationCompilation = { forNode: node => node.prompt };
  const options = params.adaptations === undefined ? {} : object(params.adaptations, 'adaptations');
  for (const key of Object.keys(options)) if (!['enabled', 'benchmark', 'headless', 'persistent', 'holdoutPercent', 'turnId'].includes(key)) {
    throw new NexusError('INVALID_ARGUMENT', `未知 adaptations 编译参数：${key}`);
  }
  for (const key of ['enabled', 'benchmark', 'headless', 'persistent']) if (options[key] !== undefined && typeof options[key] !== 'boolean') {
    throw new NexusError('INVALID_ARGUMENT', `adaptations.${key} 必须是布尔值`);
  }
  // Explicit off and noninteractive defaults return before even reading learning settings.
  if (options.enabled === false || (options.enabled !== true &&
    (options.benchmark === true || options.headless === true || options.persistent === false))) return disabled;
  const ownerScopeId = context.actorId ?? context.sessionId ?? 'local-user';
  const projectScopeId = digest(context.workspaceRoot ?? services.workspaceRoot);
  const row = await services.store.get<LearningSettings>('orchestration-settings', `learning:${ownerScopeId}:${projectScopeId}`);
  const settings = row?.value ?? { enabled: false, projectTrusted: false, ownerScopeId, projectScopeId };
  if (settings.ownerScopeId !== ownerScopeId || settings.projectScopeId !== projectScopeId) {
    throw new NexusError('SCOPE_MISMATCH', '学习设置 scope 与当前编译上下文不匹配。');
  }
  const activation = { configured: settings.enabled, projectTrusted: settings.projectTrusted,
    explicit: options.enabled === true ? 'on' as const : undefined,
    benchmark: options.benchmark === true, headless: options.headless === true, persistent: options.persistent !== false };
  if (!isAdaptationActive(activation)) return disabled;
  const percent = options.holdoutPercent ?? settings.holdoutPercent ?? 15;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new NexusError('INVALID_ARGUMENT', 'holdoutPercent 必须为 0–100。');
  }
  const turnId = options.turnId === undefined ? String(params.turnId ?? 'plan') : text(options.turnId, 'adaptations.turnId', 256);
  const snapshot: AdaptationSnapshot = {
    schemaVersion: 1, compiler: 'nexus-adaptation-compiler-v1', ownerSessionId: context.sessionId ?? 'local',
    ownerScopeId, projectScopeId, turnId, decisionRef: '', settingsRevision: row?.revision ?? 0, rules: [], rejected: [],
  };
  const records = await services.store.list<Adaptation>('orchestration-adaptations');
  const selected = selectAdaptations({ activation, load: () => records.map(record => record.value),
    sessionId: context.sessionId ?? 'local', turnId, holdoutPercent: percent,
    scope: { kind: 'project', id: projectScopeId }, userScopeId: ownerScopeId });
  for (const adaptation of [...selected.applied, ...selected.heldOut].sort((a, b) => a.id.localeCompare(b.id))) {
    const guard = guardAdaptation(adaptation, { trustedProject: settings.projectTrusted,
      currentScope: { kind: adaptation.scope, id: adaptation.scopeId } });
    if (!guard.accepted || guard.needsExplicitReview &&
      (!adaptation.review?.diffReviewed || !adaptation.review.sourceVerified || !adaptation.review.permissionGranted)) {
      snapshot.rejected.push({ id: adaptation.id, reason: !guard.accepted ? 'GUARD_REJECTED' : 'REVIEW_REQUIRED' }); continue;
    }
    const stored = records.find(record => record.id === adaptation.id);
    if (!stored || digest(stored.value) !== digest(adaptation)) {
      throw new NexusError('EVIDENCE_MISMATCH', '学习版本 identity 与存储记录不一致。');
    }
    snapshot.rules.push({ adaptation: structuredClone(adaptation), contentHash: digest(adaptation),
      storageRevision: stored.revision,
      heldOut: selected.heldOut.includes(adaptation), assignments: [] });
  }
  // decisionRef is independent of actor IDs, which are frozen after this decision.
  snapshot.decisionRef = `adaptation-decision:${digest({ ...snapshot, decisionRef: undefined })}`;
  return {
    snapshot,
    forNode(input) {
      const facts = { goal, ...input };
      const sections: string[] = [];
      for (const rule of snapshot.rules) {
        const adaptation = rule.adaptation;
        const triggers = adaptation.triggers.filter(trigger => matches(trigger, facts));
        if (!triggers.length || adaptation.exclusions.some(exclusion => matches(exclusion, facts))) continue;
        const guard = guardAdaptation(adaptation, { trustedProject: settings.projectTrusted,
          currentScope: { kind: adaptation.scope, id: adaptation.scopeId }, allowedCapabilityIds: input.capabilityIds });
        if (!guard.accepted) continue;
        rule.assignments.push({ nodeId: input.id, matchedTriggers: triggers });
        if (!rule.heldOut) sections.push([
          `方法经验 ${adaptation.id}@${adaptation.revision}（${adaptation.kind}，${rule.contentHash}）`,
          '以下为冻结的受限方法参考。当前目标、系统职责、授权、ownership、预算、工具白名单及质量门始终优先。',
          ...(adaptation.kind === 'tool' || adaptation.kind === 'hook'
            ? ['仅可在既有白名单与显式授权内使用已审方法；本记录不安装工具或 hook，不获得额外执行权限。'] : []),
          adaptation.content,
          `来源证据：${adaptation.sourceEvidenceRefs.join(', ')}`,
        ].join('\n'));
      }
      return sections.length ? `${input.prompt}\n\n<versioned-method-context>\n${sections.join('\n\n')}\n</versioned-method-context>` : input.prompt;
    },
  };
}

/** The scheduler persists these records before dispatch, including on idempotent recovery. */
export async function persistAdaptationApplications(services: NexusServices, run: Run): Promise<void> {
  const raw = run.planSnapshot.provenance.adaptationSnapshot;
  if (raw === undefined) return;
  const snapshot = object(raw, 'adaptationSnapshot') as unknown as AdaptationSnapshot;
  if (snapshot.schemaVersion !== 1 || snapshot.compiler !== 'nexus-adaptation-compiler-v1' ||
    snapshot.ownerSessionId !== run.ownerSessionId || !Array.isArray(snapshot.rules) ||
    run.planSnapshot.hash !== run.planHash || digest({ ...run.planSnapshot, hash: undefined }) !== run.planHash) {
    throw new NexusError('EVIDENCE_MISMATCH', '冻结学习快照无效。');
  }
  // A caller cannot manufacture a compiler snapshot via the generic plan API: the exact
  // compiled plan and its provenance must already be in the compiler's append-only ledger.
  const manifest = await services.store.get<{ planHash: string; snapshotHash: string }>('orchestration-compiled-plans', run.planId);
  if (!manifest || manifest.value.planHash !== run.planHash || manifest.value.snapshotHash !== digest(snapshot)) {
    throw new NexusError('EVIDENCE_MISMATCH', '学习应用缺少编译器冻结证明。');
  }
  for (const rule of snapshot.rules) {
    if (digest(rule.adaptation) !== rule.contentHash) throw new NexusError('EVIDENCE_MISMATCH', '冻结学习版本 hash 不一致。');
    for (const assignment of rule.assignments) {
      if (!run.nodeRuns[assignment.nodeId] || !run.planSnapshot.nodes.some(node => node.id === assignment.nodeId)) {
        throw new NexusError('EVIDENCE_MISMATCH', '学习应用节点不属于冻结 Run。');
      }
      const application: AdaptationApplication = {
        id: `application-${digest([run.id, assignment.nodeId, rule.adaptation.id, rule.adaptation.revision])}`,
        adaptationId: rule.adaptation.id, revision: rule.adaptation.revision, runId: run.id,
        nodeId: assignment.nodeId, appliedAt: run.startedAt, inputSnapshotHash: run.planHash,
        holdout: rule.heldOut, decisionRef: snapshot.decisionRef,
      };
      const previous = await services.store.get<AdaptationApplication>('orchestration-applications', application.id);
      if (previous) {
        if (digest(previous.value) !== digest(application)) throw new NexusError('EVIDENCE_MISMATCH', '学习应用记录与冻结 Run 冲突。');
        continue;
      }
      try { await services.store.put('orchestration-applications', application.id, application, 0); }
      catch (error) {
        const winner = await services.store.get<AdaptationApplication>('orchestration-applications', application.id);
        if (!winner || digest(winner.value) !== digest(application)) throw error;
      }
    }
  }
}

/** Used by the public typed DAG compiler as well as the blueprint compiler. */
export async function compilePlanAdaptations(services: NexusServices, plan: TaskPlan, params: JsonRecord,
  context: DispatchContext): Promise<TaskPlan> {
  const compilation = await prepareAdaptationCompilation(services, params, context, plan.goal);
  if (!compilation.snapshot) return plan;
  for (const node of plan.nodes) {
    if (!node.prompt || !['agent', 'prompt', 'synthesis', 'review'].includes(node.kind)) continue;
    node.prompt = compilation.forNode({ id: node.id, roleId: node.role ?? node.kind,
      blueprintNodeId: node.id, tier: 'custom', prompt: node.prompt,
      capabilityIds: node.orchestration?.capabilityIds ?? [] });
    if (Buffer.byteLength(node.prompt, 'utf8') > plan.budgets.maxInputBytes) {
      throw new NexusError('BUDGET_EXHAUSTED', '学习上下文超出冻结输入预算，不能截断后冒充已应用。', { nodeId: node.id });
    }
    if (node.routingInput) node.routingInput.inputTokens = Math.max(node.routingInput.inputTokens, Buffer.byteLength(node.prompt, 'utf8'));
  }
  plan.provenance.adaptationSnapshot = compilation.snapshot;
  plan.hash = digest({ ...plan, hash: undefined });
  return plan;
}

export async function saveCompiledPlan(services: NexusServices, plan: TaskPlan): Promise<StoredRecord<TaskPlan>> {
  // Write proof before exposing the plan. A crash can leave unused proof, never a
  // runnable plan with a missing application manifest.
  if (plan.provenance.adaptationSnapshot !== undefined) await services.store.put('orchestration-compiled-plans', plan.id, {
    planHash: plan.hash, snapshotHash: digest(plan.provenance.adaptationSnapshot),
  }, 0);
  return services.store.put('workflow-plans', plan.id, plan, 0);
}
