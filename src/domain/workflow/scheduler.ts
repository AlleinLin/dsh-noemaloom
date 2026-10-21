import { randomUUID } from 'node:crypto';
import type { ChildActivation, DispatchContext, JsonRecord, ModelRequest, ModelResult, NexusServices, StoredRecord } from '../../ports/contracts.js';
import { NexusError } from '../../ports/contracts.js';
import { type ArtifactRef, type GateReviewEvidence, type NodeRun, type NodeState, type Run, type RunEvent, type TaskNode, type TaskPlan, TERMINAL } from './types.js';
import { cleanExport, digest, newId, now, required } from './util.js';
import { verifyChecks } from './verification.js';
import { selectRoute } from '../orchestration/routing.js';
import { evaluateGate } from '../orchestration/gates.js';
import type { ActorEvidence, CheckReceipt, GatePolicy, RouteDecision } from '../orchestration/types.js';
import { OrchestrationService } from './orchestration-service.js';
import { admitAttempt, observedBudgetViolation, settleAttempt } from './attempt-budget.js';
import { freezeReviewMission, requiresReviewReport, reviewInstructions, validateReviewReport } from './gate-review.js';
import { persistAdaptationApplications } from './adaptation-compiler.js';
import { resolveWorkflowInputs } from './inputs.js';

interface ActiveNode { controller: AbortController; handle?: ChildActivation; accepting?: boolean; failure?: unknown; workSettled?: boolean; done: Promise<void>; }
interface PoolLease { id: string; runId: string; nodeId: string; owner: string; expiresAt: number; claims: string[]; routeDecision?: RouteDecision; }
interface Pool { leases: PoolLease[]; }
const ACTIVE = new Set<NodeState>(['starting', 'running', 'cancelRequested']);
function unresolvedEffects(value: unknown, failed = false): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.length > 0;
  const effects = value as JsonRecord;
  return effects.state === 'unknown' || effects.verificationRequired === true
    || effects.receipt === 'reconciliation-required'
    || failed && Object.keys(effects).length > 0 && !['not-started', 'none', 'rolled-back'].includes(String(effects.state));
}
const errorInfo = (error: unknown): { code: string; message: string; details?: unknown } => error instanceof NexusError ? { code: error.code, message: error.message, details: error.details } : { code: 'EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error) };
const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new NexusError('CANCELLED', '操作已取消'));
  const onAbort = (): void => { clearTimeout(timer); reject(new NexusError('CANCELLED', '操作已取消')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});
async function boundedDispose(handle: ChildActivation): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([handle.dispose(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new NexusError('PROCESS_EFFECT_UNKNOWN', '宿主取消 ACK 超时')), 15000); })]);
  } finally { if (timer) clearTimeout(timer); }
}

export class WorkflowScheduler {
  private readonly owner = randomUUID();
  private readonly active = new Map<string, ActiveNode>();
  private readonly loops = new Map<string, Promise<void>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private disposed = false;
  constructor(readonly services: NexusServices) {}

  async initialize(): Promise<void> {
    for (const row of await this.services.store.list<Run>('workflow-runs')) {
      const run = row.value;
      if (run.finishedAt) continue;
      const recovered = await this.update(run.id, current => {
        for (const node of Object.values(current.nodeRuns)) {
          if (ACTIVE.has(node.state) || node.state === 'queued') {
            node.checkpoint = { previousState: node.state, activationId: node.activationId, lastEvent: current.events.at(-1)?.seq ?? 0 };
            node.state = node.state === 'queued' || node.execution?.state === 'prepared' ? 'interrupted' : 'effectUnknown';
            if (node.state === 'effectUnknown' && node.execution) node.execution.state = 'unknown';
          }
        }
        current.state = 'interrupted'; current.paused = true;
        this.event(current, 'run.interrupted', undefined, '宿主重新加载，保留原 activation ID，等待查询与显式恢复');
      });
      const pool = await this.services.store.get<Pool>('workflow-coordination', 'global-pool');
      for (const lease of pool?.value.leases.filter(candidate => candidate.runId === run.id) ?? []) {
        const node = recovered.value.nodeRuns[lease.nodeId];
        if (node?.state === 'interrupted' && (node.execution?.state === 'prepared' || node.checkpoint?.previousState === 'queued')) {
          await this.release(lease.id);
        } else await this.quarantineLease(lease.id);
      }
    }
  }

  private event(run: Run, type: string, nodeId?: string, reason = '', data?: unknown): void {
    const event: RunEvent = { seq: (run.events.at(-1)?.seq ?? 0) + 1, at: now(), type, nodeId, actor: 'plugin:dsh-nexus', reason, data };
    run.events.push(event);
  }
  private async update(id: string, mutate: (run: Run) => void): Promise<StoredRecord<Run>> {
    const before = this.queues.get(id) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(async () => {
      for (let retries = 0; retries < 12; retries++) {
        const row = await required<Run>(this.services, 'workflow-runs', id), value = structuredClone(row.value);
        mutate(value);
        value.usage.wallMs = Date.now() - Date.parse(value.startedAt);
        try {
          const saved = await this.services.store.put('workflow-runs', id, value, row.revision);
          this.services.emit('workflow.run', { runId: id, revision: saved.revision, state: value.state, eventSeq: value.events.at(-1)?.seq });
          return saved;
        } catch (error) { if (!(error instanceof NexusError) || error.code !== 'REVISION_CONFLICT' || retries === 11) throw error; }
      }
      throw new NexusError('REVISION_CONFLICT', 'Run 更新竞争过多');
    });
    this.queues.set(id, next);
    return next;
  }
  private scope(run: Run, context: DispatchContext): void {
    if (context.sessionId && context.sessionId !== run.ownerSessionId && !context.permissions?.has('workflow:all')) throw new NexusError('SCOPE_MISMATCH', '不能访问其他会话 Run');
  }
  async get(runId: string, context: DispatchContext = {}): Promise<StoredRecord<Run>> {
    const row = await required<Run>(this.services, 'workflow-runs', runId); this.scope(row.value, context); return row;
  }
  async start(planId: string, key: string, context: DispatchContext = {}): Promise<StoredRecord<Run>> {
    const planRow = await required<TaskPlan>(this.services, 'workflow-plans', planId), plan = planRow.value;
    if (context.sessionId && plan.ownerSessionId !== context.sessionId && !context.permissions?.has('workflow:all')) throw new NexusError('SCOPE_MISMATCH', '计划属于另一会话');
    const id = `run-${digest(`${plan.ownerSessionId}:${planId}:${key}`).slice(0, 40)}`;
    const existing = await this.services.store.get<Run>('workflow-runs', id);
    if (existing) {
      await persistAdaptationApplications(this.services, existing.value);
      if (!existing.value.finishedAt && !existing.value.paused && !existing.value.cancellationRequested) this.kick(id, context);
      return existing;
    }
    const nodeRuns = Object.fromEntries(plan.nodes.map(node => [node.id, {
      id: node.id, actorId: node.actorId ?? newId(`actor-${node.role ?? node.kind}`), state: 'queued',
      attempt: 0, idempotencyKey: `${id}:${node.id}`, evidenceRefs: [], requestedRoute: structuredClone(node.route ?? {}),
    } as NodeRun]));
    const run: Run = {
      schemaVersion: 1, id, planId, planRevision: planRow.revision, planHash: plan.hash, planSnapshot: structuredClone(plan),
      ownerSessionId: plan.ownerSessionId, initiator: context.actorId ?? 'user', state: 'queued', startedAt: now(),
      hostCapabilitySnapshot: await this.services.host.facts(),
      routeSnapshot: Object.fromEntries(plan.nodes.map(node => [node.id, structuredClone(node.route ?? {})])),
      nodeRuns, events: [], artifacts: [], paused: false, cancellationRequested: false,
      usage: { attempts: [], modelCalls: 0, inputBytes: 0, outputBytes: 0, totalTokens: null, cost: null, complete: false, computeMs: 0, wallMs: 0 },
    };
    this.event(run, 'run.created', undefined, '冻结计划、路由及预算快照');
    let row: StoredRecord<Run>;
    try { row = await this.services.store.put('workflow-runs', id, run, 0); }
    catch (error) {
      const raced = await this.services.store.get<Run>('workflow-runs', id);
      if (raced) {
        await persistAdaptationApplications(this.services, raced.value);
        if (!raced.value.finishedAt && !raced.value.paused && !raced.value.cancellationRequested) this.kick(id, context);
        return raced;
      }
      throw error;
    }
    await persistAdaptationApplications(this.services, row.value);
    this.kick(id, context);
    return row;
  }
  private kick(runId: string, context: DispatchContext): void {
    if (this.loops.has(runId) || this.disposed) return;
    const loop = this.schedule(runId, { ...context, signal: undefined }).catch(async error => {
      await this.update(runId, run => { run.state = 'failed'; run.terminalReason = errorInfo(error).message; this.event(run, 'run.error', undefined, run.terminalReason); });
    }).finally(() => { this.loops.delete(runId); });
    this.loops.set(runId, loop);
  }
  private async reserve(run: Run, node: TaskNode): Promise<string | undefined> {
    const id = `${run.id}:${node.id}:${this.owner}`;
    for (let i = 0; i < 16; i++) {
      const row = await this.services.store.get<Pool>('workflow-coordination', 'global-pool');
      const pool = row?.value ?? { leases: [] };
      const live: PoolLease[] = [];
      for (const lease of pool.leases) {
        if (lease.expiresAt > Date.now()) { live.push(lease); continue; }
        // Expiry is a concurrency hint, never proof that a remote tool stopped.
        const owningRun = await this.services.store.get<Run>('workflow-runs', lease.runId);
        const owner = owningRun?.value.nodeRuns[lease.nodeId];
        if (!owningRun || !owner || !TERMINAL.has(owner.state)
          || owner.execution?.state === 'started' || owner.execution?.state === 'unknown') {
          live.push({ ...lease, expiresAt: Number.MAX_SAFE_INTEGER });
        }
      }
      const runLive = live.filter(lease => lease.runId === run.id);
      if (runLive.some(lease => lease.nodeId === node.id)) return undefined;
      if (live.length >= 32 || runLive.length >= run.planSnapshot.budgets.maxConcurrent) return undefined;
      const claims = node.writeClaims ?? [];
      if (live.some(lease => lease.id !== id && lease.claims.some(a => claims.some(b => {
        const left = a.replaceAll('\\', '/').toLowerCase(), right = b.replaceAll('\\', '/').toLowerCase();
        return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
      })))) return undefined;
      live.push({ id, runId: run.id, nodeId: node.id, owner: this.owner, expiresAt: Date.now() + (node.timeoutMs ?? run.planSnapshot.budgets.maxWallMs) + 60000, claims, routeDecision: node.routeDecision });
      try { await this.services.store.put('workflow-coordination', 'global-pool', { leases: live }, row?.revision ?? 0); return id; }
      catch (error) { if (!(error instanceof NexusError) || error.code !== 'REVISION_CONFLICT') throw error; }
    }
    throw new NexusError('REVISION_CONFLICT', '全局并发预算竞争，未创建子代理');
  }
  private async release(leaseId: string): Promise<void> {
    for (let i = 0; i < 16; i++) {
      const row = await this.services.store.get<Pool>('workflow-coordination', 'global-pool');
      if (!row) return;
      try { await this.services.store.put('workflow-coordination', 'global-pool', { leases: row.value.leases.filter(l => l.id !== leaseId) }, row.revision); return; }
      catch (error) { if (!(error instanceof NexusError) || error.code !== 'REVISION_CONFLICT') throw error; }
    }
  }
  private async schedule(id: string, context: DispatchContext): Promise<void> {
    while (!this.disposed) {
      let run = (await this.get(id)).value;
      const budget = run.planSnapshot.budgets;
      if (run.finishedAt || run.paused || run.cancellationRequested) return;
      if (Date.now() - Date.parse(run.startedAt) > budget.maxWallMs || (budget.deadline && Date.now() > Date.parse(budget.deadline))) {
        await this.cancel(id, { ...context, actorId: 'budget' }, undefined, '超过运行时间预算'); return;
      }
      let started = false;
      for (const frozenNode of run.planSnapshot.nodes) {
        const node = structuredClone(frozenNode);
        const current = run.nodeRuns[node.id]!;
        if (current.state !== 'queued' || this.active.has(`${id}:${node.id}`)) continue;
        const incoming = run.planSnapshot.edges.filter(e => e.to === node.id);
        const failed = incoming.find(e => !e.optional && TERMINAL.has(run.nodeRuns[e.from]!.state) && run.nodeRuns[e.from]!.state !== 'succeeded');
        if (failed) {
          await this.update(id, value => { value.nodeRuns[node.id]!.state = 'blocked'; value.nodeRuns[node.id]!.error = { code: 'DEPENDENCY_FAILED', message: `依赖 ${failed.from} 未成功` }; this.event(value, 'node.blocked', node.id, `依赖 ${failed.from} 未成功`); });
          continue;
        }
        if (incoming.some(e => !TERMINAL.has(run.nodeRuns[e.from]!.state))) continue;
        if (node.routingInput) {
          try {
            const catalog = (await new OrchestrationService(this.services).models()).items;
            const previous = node.routeDecision;
            const decision = selectRoute({ ...node.routingInput, catalog, now: now(), nodeAttempt: current.attempt + 1, currentAffinity: previous?.lease ?? undefined });
            if (previous?.selectedModel && decision.selectedModel &&
              (previous.selectedModel.providerRouteId !== decision.selectedModel.providerRouteId || previous.selectedModel.modelId !== decision.selectedModel.modelId) &&
              !node.routingInput.policy.fallback?.allowPinnedSwitch) throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '冻结 route 不可用，未授权切换模型');
            node.routeDecision = decision;
            node.route = decision.selectedModel ? { provider: decision.selectedModel.providerRouteId, model: decision.selectedModel.modelId, credentialScope: decision.selectedModel.credentialScopeId, reasoningEffort: decision.effortResolved, laneId: node.route?.laneId, requireObserved: node.route?.requireObserved } : undefined;
          } catch (error) {
            await this.update(id, value => { value.nodeRuns[node.id]!.state = 'blocked'; value.nodeRuns[node.id]!.error = errorInfo(error); this.event(value, 'route.blocked', node.id, errorInfo(error).message); });
            continue;
          }
        }
        const lease = await this.reserve(run, node);
        if (!lease) continue;
        if (node.routeDecision) await this.update(id, value => { value.nodeRuns[node.id]!.routeDecision = node.routeDecision; value.routeSnapshot[node.id] = node.route ?? {}; this.event(value, 'route.committed', node.id, '路由和 lane lease 与全局并发占用同时提交', { routeDecisionId: node.routeDecision!.id, partitionId: node.routeDecision!.cachePartitionRef, leaseId: node.routeDecision!.cacheAffinityLeaseId }); });
        const controller = new AbortController();
        const active: ActiveNode = { controller, done: Promise.resolve() };
        this.active.set(`${id}:${node.id}`, active);
        active.done = this.execute(id, node, active, context).finally(async () => {
          this.active.delete(`${id}:${node.id}`);
          const state = (await this.get(id)).value.nodeRuns[node.id]!.state;
          if (state === 'effectUnknown' || state === 'cancelRequested') await this.quarantineLease(lease);
          else await this.release(lease);
        });
        started = true;
        run = (await this.get(id)).value;
      }
      run = (await this.get(id)).value;
      const activeWork = [...this.active].filter(([key]) => key.startsWith(`${id}:`)).map(([, v]) => v.done);
      const values = Object.values(run.nodeRuns);
      if (values.every(n => TERMINAL.has(n.state))) {
        const requiredNodes = run.planSnapshot.deliveryContract.requiredNodeIds.map(nodeId => run.nodeRuns[nodeId]!);
        const independentRequired = run.planSnapshot.deliveryContract.requireIndependentVerification;
        let finalChecks = true;
        if (run.planSnapshot.deliveryContract.checks?.length) {
          const evidence = await verifyChecks(this.services, run.planSnapshot.deliveryContract.checks, run, { id: '__delivery__', kind: 'gate' }, context);
          finalChecks = evidence.every(e => e.status === 'passed');
          await this.update(id, value => this.event(value, 'delivery.checked', undefined, '宿主执行交付 oracle', evidence));
        }
        // A passed gate records a historical snapshot. Later authorized nodes
        // (or even delivery commands) may change its files before completion.
        const successfulGates = run.planSnapshot.nodes.filter(node => node.kind === 'gate' && run.nodeRuns[node.id]?.state === 'succeeded');
        const gateReviewerId = (node: TaskNode): string | undefined => node.checks?.find(check => check.kind === 'independence')?.subjectNodeId ?? node.orchestration?.subjectNodeId;
        const requiredReviewIds = new Set(requiredNodes.filter(runtime => requiresReviewReport(run.planSnapshot.nodes.find(node => node.id === runtime.id)!)).map(runtime => runtime.id));
        for (const gate of successfulGates.filter(node => run.planSnapshot.deliveryContract.requiredNodeIds.includes(node.id))) {
          const reviewerId = gateReviewerId(gate), reviewer = run.planSnapshot.nodes.find(node => node.id === reviewerId);
          if (reviewer && requiresReviewReport(reviewer)) requiredReviewIds.add(reviewer.id);
        }
        const independentGates = successfulGates.filter(node => node.checks?.some(check => check.kind === 'independence'));
        const reviewIds = new Set([...requiredReviewIds, ...independentGates.map(gateReviewerId).filter((nodeId): nodeId is string => !!nodeId)]);
        const finalReviews = new Map<string, GateReviewEvidence>();
        for (const reviewerId of reviewIds) {
          const reviewer = run.planSnapshot.nodes.find(node => node.id === reviewerId);
          if (reviewer && requiresReviewReport(reviewer)) finalReviews.set(reviewerId, await this.reviewEvidence(run, reviewer));
        }
        const currentReviewPassed = (reviewerId: string | undefined): boolean => {
          const review = reviewerId ? finalReviews.get(reviewerId) : undefined;
          return !!review?.valid && review.verdict === 'pass' && !review.findings.some(finding => !finding.resolved && finding.priority <= 1);
        };
        const success = requiredNodes.every(node => node.state === 'succeeded') &&
          [...requiredReviewIds].every(currentReviewPassed) && !run.usage.attempts.some(attempt => attempt.status === 'admitted');
        const hasGate = independentGates.some(gate => currentReviewPassed(gateReviewerId(gate)));
        await this.update(id, value => {
          for (const [reviewerId, review] of finalReviews) {
            value.nodeRuns[reviewerId]!.reviewEvidence = review;
            this.event(value, 'delivery.review-checked', reviewerId, review.valid ? review.verdict : 'needs-review',
              { reportRef: review.reportRef.id, valid: review.valid, reasons: review.reasons });
          }
          value.state = success && (!independentRequired || hasGate) && finalChecks ? 'succeeded' : 'failed';
          value.finishedAt = now();
          value.terminalReason = value.state === 'succeeded' ? '所有必需节点和真实交付检查已完成' : '必需节点或独立验证/交付检查未通过';
          this.event(value, 'run.finished', undefined, value.terminalReason);
        });
        return;
      }
      if (values.some(n => ['waiting', 'effectUnknown', 'interrupted'].includes(n.state)) && activeWork.length === 0) {
        await this.update(id, value => { value.state = values.some(n => n.state === 'effectUnknown') ? 'effectUnknown' : 'waiting'; });
        return;
      }
      if (activeWork.length) await Promise.race(activeWork);
      else if (!started) await sleep(200);
    }
  }
  private async artifact(runId: string, nodeId: string, content: unknown): Promise<ArtifactRef> {
    const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const artifact: ArtifactRef = { id: newId('artifact'), hash: digest(body), bytes: Buffer.byteLength(body), mediaType: typeof content === 'string' ? 'text/plain' : 'application/json', nodeId };
    await this.services.store.put('workflow-artifacts', artifact.id, { runId, nodeId, content: body, hash: artifact.hash, createdAt: now() }, 0);
    return artifact;
  }
  private async quarantineLease(leaseId: string): Promise<void> {
    for (let i = 0; i < 12; i++) {
      const row = await this.services.store.get<Pool>('workflow-coordination', 'global-pool');
      if (!row) return;
      try { await this.services.store.put('workflow-coordination', 'global-pool', { leases: row.value.leases.map(l => l.id === leaseId ? { ...l, expiresAt: Number.MAX_SAFE_INTEGER } : l) }, row.revision); return; }
      catch (error) { if (!(error instanceof NexusError) || error.code !== 'REVISION_CONFLICT') throw error; }
    }
  }
  private async execute(id: string, node: TaskNode, active: ActiveNode, context: DispatchContext): Promise<void> {
    const started = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let resultError: unknown;
    let teardownError: unknown;
    let artifact: ArtifactRef | undefined;
    let executionId: string | undefined;
    let executionAttempt: number | undefined;
    let desiredState: NodeState = 'succeeded';
    try {
      const prepared = await this.update(id, run => {
        const value = run.nodeRuns[node.id]!;
        if (run.cancellationRequested || value.state !== 'queued') throw new NexusError('CANCELLED', '节点已取消');
        value.state = 'starting'; value.attempt++; value.startedAt = now(); run.state = 'running';
        value.execution = { requestId: `${run.id}:${node.id}:attempt:${value.attempt}`, state: 'prepared', kind: node.kind };
        this.event(run, 'node.starting', node.id, '已原子预留并发及资源写声明');
      });
      // Keep the exact CAS result: a later read can already belong to a resumed successor attempt.
      const run = prepared.value;
      executionId = run.nodeRuns[node.id]!.execution?.requestId;
      executionAttempt = run.nodeRuns[node.id]!.attempt;
      const work = this.perform(run, node, active, context).finally(() => { active.workSettled = true; });
      void work.catch(() => undefined);
      const timed = new Promise<never>((_, reject) => { timeout = setTimeout(() => { active.failure = new NexusError('TIMEOUT', '节点超过执行时间预算'); active.controller.abort(); reject(active.failure); }, node.timeoutMs ?? run.planSnapshot.budgets.maxWallMs); });
      const cancelled = new Promise<never>((_, reject) => { active.controller.signal.addEventListener('abort', () => reject(active.failure ?? new NexusError('CANCELLED', '节点收到取消请求')), { once: true }); });
      const result = await Promise.race([work, timed, cancelled]);
      if (node.kind === 'manual' || node.kind === 'approval') desiredState = 'waiting';
      else artifact = await this.artifact(id, node.id, result);
    } catch (error) {
      resultError = active.failure ?? error;
      desiredState = resultError instanceof NexusError && resultError.code === 'TIMEOUT' ? 'timedOut' : active.controller.signal.aborted && !active.failure ? 'cancelRequested' : 'failed';
    } finally {
      if (timeout) clearTimeout(timeout);
      if (active.handle) {
        try { await boundedDispose(active.handle); }
        catch (error) { teardownError = error; desiredState = 'effectUnknown'; }
      }
      if (active.accepting && active.controller.signal.aborted) {
        teardownError = new NexusError('PROCESS_EFFECT_UNKNOWN', '取消发生在宿主接受边界，等待原 activation 身份确认');
      }
      await this.update(id, run => {
        const current = run.nodeRuns[node.id]!;
        if (!executionId || current.execution?.requestId !== executionId || current.attempt !== executionAttempt
          || current.state === 'interrupted' && current.execution?.state === 'prepared'
          || current.state === 'queued') return;
        const pendingEffect = current.execution?.state === 'started' && !active.workSettled;
        const effects = resultError instanceof NexusError && resultError.details && typeof resultError.details === 'object'
          ? (resultError.details as JsonRecord).effects as JsonRecord | undefined : undefined;
        const uncertainReceipt = unresolvedEffects(effects, true);
        if ((pendingEffect && !active.handle) || uncertainReceipt || active.accepting) {
          teardownError ??= new NexusError('PROCESS_EFFECT_UNKNOWN', '原调用尚未证明结束，保留原requestId与写占用，禁止自动重发');
        }
        resultError = active.failure ?? resultError;
        const cancelled = run.cancellationRequested || current.state === 'cancelRequested' || active.controller.signal.aborted;
        current.state = teardownError ? 'effectUnknown' : resultError instanceof NexusError && resultError.code === 'TIMEOUT' ? 'timedOut' :
          active.failure ? 'failed' : cancelled ? 'cancelled' : desiredState;
        current.finishedAt = current.state === 'waiting' ? undefined : now();
        if (current.execution) current.execution.state = current.state === 'effectUnknown' ? 'unknown' : 'settled';
        if (resultError) { current.error = errorInfo(resultError); current.resultError = current.error.message; }
        if (teardownError) current.teardownError = errorInfo(teardownError).message;
        if (artifact) {
          current.resultRef = artifact; run.artifacts.push(artifact); run.usage.outputBytes += artifact.bytes;
          if (run.usage.outputBytes > run.planSnapshot.budgets.maxOutputBytes) { current.state = 'failed'; current.error = { code: 'BUDGET_EXHAUSTED', message: '输出超出字节预算' }; }
        }
        run.usage.computeMs += Date.now() - started;
        this.event(run, `node.${current.state}`, node.id, current.error?.message ?? '节点执行及 exact handle 清理结束', { resultRef: artifact, resultError: current.resultError, teardownError: current.teardownError });
      });
    }
  }
  private async startExecution(run: Run, node: TaskNode, context: DispatchContext): Promise<string> {
    const expected = run.nodeRuns[node.id]!;
    const expectedRequestId = expected.execution?.requestId;
    const expectedAttempt = expected.attempt;
    let requestId = '';
    await this.update(run.id, current => {
      const runtime = current.nodeRuns[node.id]!;
      if (current.cancellationRequested || runtime.state === 'cancelRequested') throw new NexusError('CANCELLED', '发送前收到取消');
      if (!expectedRequestId || !runtime.execution || runtime.execution.requestId !== expectedRequestId || runtime.attempt !== expectedAttempt
        || runtime.state !== 'starting' || runtime.execution.state !== 'prepared') {
        throw new NexusError('PROCESS_EFFECT_UNKNOWN', '节点缺少可发送的持久意图，未重发');
      }
      requestId = runtime.execution.requestId;
      runtime.execution.state = 'started';
      runtime.state = 'running';
      this.event(current, 'node.running', node.id, '持久执行意图通过后进入外部边界', { requestId });
      runtime.execution.receiptContext = {
        scopeLevel: context.scopeLevel, workspaceId: context.workspaceId, actorId: context.actorId,
        workspaceRoot: node.cwd ?? context.workspaceRoot ?? this.services.workspaceRoot, sessionId: run.ownerSessionId,
      };
    });
    return requestId;
  }
  private async perform(run: Run, node: TaskNode, active: ActiveNode, context: DispatchContext): Promise<unknown> {
    const signal = active.controller.signal;
    if (node.kind === 'manual' || node.kind === 'approval') return { state: 'waiting', prompt: node.prompt ?? '等待人工证据或批准' };
    if (node.kind === 'gate') {
      await this.startExecution(run, node, context);
      const checks = await verifyChecks(this.services, node.checks ?? [], run, node, { ...context, signal });
      const ref = await this.artifact(run.id, node.id, checks);
      await this.update(run.id, current => { current.artifacts.push(ref); current.nodeRuns[node.id]!.evidenceRefs.push(ref.id); });
      const independence = node.checks?.find(check => check.kind === 'independence');
      if (node.orchestration?.gatePolicy || independence) {
        const gate: GatePolicy = node.orchestration?.gatePolicy ?? { gateId: node.id, kind: 'independent-review', scope: 'node', requiredRoles: ['reviewer'], checks: [], requiredEvidenceLevels: [], onFail: 'block', maxLoops: 0, protected: false, independent: true };
        const subjectId = independence?.subjectNodeId ?? node.orchestration?.subjectNodeId ?? node.id;
        const reviewer = run.planSnapshot.nodes.find(candidate => candidate.id === subjectId);
        const review = reviewer && requiresReviewReport(reviewer) ? await this.reviewEvidence(run, reviewer) : undefined;
        const expectedSubjects = [...new Set(independence?.authorNodeIds ?? node.orchestration?.authorNodeIds ?? [])].filter(id => id !== subjectId).sort();
        const reviewSubjectMismatch = !!review && digest([...review.mission.subjectNodeIds].sort()) !== digest(expectedSubjects);
        const candidateSnapshotHash = review?.mission.candidateSnapshotHash ?? digest(run.planSnapshot.nodes.filter(n => n.role === 'implementer').map(n => ({ id: n.id, artifact: run.nodeRuns[n.id]?.resultRef?.hash })));
        const contractHash = digest({ plan: run.planHash, gate: gate.gateId, checks: node.checks });
        const actor = this.actorEvidence(run, subjectId);
        const priorActors = [...(independence?.authorNodeIds ?? node.orchestration?.authorNodeIds ?? []),
          ...(independence?.reviewerNodeIds ?? node.orchestration?.priorReviewerNodeIds ?? [])].filter(n => n !== subjectId).map(n => this.actorEvidence(run, n));
        const receipts: CheckReceipt[] = checks.filter(check => check.kind !== 'independence' && check.kind !== 'none').map(check => {
          const source = check.kind === 'command' ? 'executor' : check.kind === 'metric' ? 'oracle' : 'artifact-store';
          const evidence = check.evidence && typeof check.evidence === 'object' ? check.evidence as JsonRecord : {};
          const artifact = evidence.integrityChecked === true && evidence.artifact && typeof evidence.artifact === 'object' ? evidence.artifact as JsonRecord : undefined;
          return { checkId: check.id, kind: check.kind === 'json' || check.kind === 'file' ? 'artifact' : check.kind as CheckReceipt['kind'], source, receiptRef: ref.id, candidateSnapshotHash, contractHash, exitCode: typeof evidence.exitCode === 'number' ? evidence.exitCode : null, cancelled: evidence.cancelled === true, childResultValid: check.kind === 'command' ? typeof evidence.exitCode === 'number' && typeof evidence.stdout === 'string' : undefined, sampled: check.kind === 'command' ? typeof evidence.durationMs === 'number' : undefined, exists: check.status === 'passed', byteLength: typeof evidence.bytes === 'number' ? evidence.bytes : typeof artifact?.bytes === 'number' ? artifact.bytes : undefined, contentHash: typeof evidence.sha256 === 'string' ? evidence.sha256 : typeof artifact?.hash === 'string' ? artifact.hash : undefined, formatValid: check.status === 'passed', observedMetric: typeof evidence.observed === 'number' ? evidence.observed : undefined, datasetRef: typeof evidence.datasetRef === 'string' ? evidence.datasetRef : undefined, evidenceRefs: [ref.id], conclusion: check.status === 'passed' ? 'pass' : 'fail' };
        });
        // Delivery-compiled oracle identities are used verbatim; an empty policy remains unverified.
        const policy: GatePolicy = { ...gate, checks: (node.checks ?? []).filter(c => c.kind !== 'independence').map((c, i) => ({ id: c.id ?? `check-${i + 1}`, kind: c.kind === 'file' || c.kind === 'json' ? 'artifact' : c.kind as 'command' | 'artifact' | 'metric', required: true, expectedExit: c.expectedExitCode ?? 0, nonEmpty: c.nonEmpty, expectedHash: c.sha256, datasetRef: c.datasetRef, metric: c.min !== undefined ? { operator: c.minExclusive ? '>' : '>=', threshold: c.min } : c.max !== undefined ? { operator: c.maxExclusive ? '<' : '<=', threshold: c.max } : undefined })) };
        if (review) {
          const checkId = `${node.id}:structured-review`;
          policy.checks.push({ id: checkId, kind: 'review', required: true });
          receipts.push({ checkId, kind: 'review', source: 'model', receiptRef: review.reportRef.id, candidateSnapshotHash, contractHash,
            conclusion: !review.valid ? 'inconclusive' : review.verdict === 'needs-review' ? 'inconclusive' : review.verdict,
            evidenceRefs: [review.reportRef.id, ...review.mission.expectedArtifacts.map(artifact => artifact.ref)] });
        }
        const verdict = evaluateGate({ policy, nodeId: node.id, actor, priorActors,
          requireDifferentModel: node.checks?.some(check => check.kind === 'independence' && check.requireDifferentModel),
          routeDecisionId: run.nodeRuns[subjectId]?.routeDecision?.id ?? `host-route:${subjectId}`, candidateSnapshotHash, contractHash, receipts,
          findings: review?.findings, unresolvedRequiredConstraints: [
            ...(review?.valid === false ? review.reasons : []),
            ...(reviewSubjectMismatch ? ['REVIEW_GATE_SUBJECT_MISMATCH'] : []),
            ...(independence && (!reviewer || !requiresReviewReport(reviewer)) ? ['REVIEW_ACTOR_SUBJECT_MISSING'] : []),
          ], now: now() });
        const verdictRef = await this.artifact(run.id, node.id, verdict);
        await this.update(run.id, current => { current.artifacts.push(verdictRef); current.nodeRuns[node.id]!.evidenceRefs.push(verdictRef.id); this.event(current, 'gate.verdict', node.id, verdict.verdict, { verdictRef: verdictRef.id, verdict }); });
        if (verdict.verdict !== 'pass') throw new NexusError('EVIDENCE_MISMATCH', '独立质量门未通过', { verdict, verdictRef: verdictRef.id });
      }
      if (checks.some(c => c.status !== 'passed')) throw new NexusError('EVIDENCE_MISMATCH', '真实验证未通过或缺少证据', { checks, evidenceRef: ref.id });
      return { checks, evidenceRef: ref.id };
    }
    if (node.kind === 'tool' || node.kind === 'review' || node.kind === 'export' || node.kind === 'merge' || node.kind === 'cli') {
      const domain = node.kind === 'cli' ? 'agents' : node.domain;
      const action = node.kind === 'cli' ? 'cli/execute' : node.action;
      if (!domain || !action) throw new NexusError('INVALID_ARGUMENT', '工具节点缺少 domain/action');
      const requestId = await this.startExecution(run, node, context);
      return this.services.invoke(domain, { action, requestId, params: node.kind === 'cli' ? { ...node.params, runId: run.id, nodeId: node.id } : node.params }, { ...context, workspaceRoot: node.cwd ?? context.workspaceRoot ?? this.services.workspaceRoot, sessionId: run.ownerSessionId, signal });
    }
    if (node.kind === 'session') {
      const action = node.action ?? 'spawn';
      if (!['list', 'get', 'snapshot', 'info', 'status', 'activation/status', 'fork.lookup', 'models/list', 'models.list', 'cancel', 'flush', 'rename'].includes(action)) {
        throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '此 session action 尚无 Run/node attempt 与 exact activation 生命周期合同；不能绕过统一模型预算', { action });
      }
      const actorRole = node.orchestration?.candidateRole ?? node.role ?? 'session';
      const requestId = await this.startExecution(run, node, context);
      return this.services.host.sessions(action, {
        ...node.params, prompt: node.prompt, cwd: node.cwd ?? this.services.workspaceRoot, ...node.route,
        ownerRunId: run.id, parentId: node.parentId ? run.nodeRuns[node.parentId]?.activationId ?? run.ownerSessionId : run.ownerSessionId,
        requestId,
        readOnly: ['reviewer', 'verifier', 'fresh-verifier', 'juror', 'arbiter', 'goal-checker', 'framework-validator'].includes(actorRole),
        allowChildren: node.allowChildren === true, actorRole, maxDepth: run.planSnapshot.budgets.maxDepth,
        allowedCapabilityIds: node.orchestration?.capabilityIds,
      });
    }
    let prompt = node.prompt ?? '';
    for (const input of await resolveWorkflowInputs(this.services, run, node)) {
      const refId = input.ref.id;
      if (requiresReviewReport(node)) {
        const isActorConclusion = Object.values(run.nodeRuns).some(runtime => runtime.resultRef?.id === refId || runtime.reviewEvidence?.reportRef.id === refId);
        const isGateConclusion = run.events.some(event => event.type === 'gate.verdict' && event.data && typeof event.data === 'object' && (event.data as JsonRecord).verdictRef === refId);
        if (isActorConclusion || isGateConclusion) throw new NexusError('SCOPE_MISMATCH', '独立审者只接受本 Run 原始证据，禁止把作者自述或前审结论伪装为 artifact 输入', { refId });
      }
      prompt += `\n\n[Artifact ${refId} sha256=${input.ref.hash}]\n${input.content}`;
    }
    const mission = requiresReviewReport(node) ? await freezeReviewMission(this.services, run, node) : undefined;
    if (mission) prompt += `\n\n${reviewInstructions(mission)}`;
    if (run.hostCapabilitySnapshot.attemptPolicySupported !== true) throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '宿主不支持发送前 attempt 准入，不能执行有硬调用预算的模型节点');
    const logicalCallId = `${run.id}:${node.id}:${run.nodeRuns[node.id]!.attempt}`;
    const physicalAttempts = new Set<string>();
    const request: ModelRequest & { parentId?: string; cwd?: string } = {
      role: node.role ?? 'worker', prompt, provider: node.route?.provider, model: node.route?.model,
      reasoningEffort: node.route?.reasoningEffort, reasoning_effort: node.route?.reasoning_effort, agentPreset: node.route?.agentPreset,
      credentialScope: node.route?.credentialScope, sessionId: run.ownerSessionId, system: node.system,
      signal, maxTokens: node.maxTokens, logicalCallId, attemptId: newId('activation-attempt'),
      parentId: node.parentId ? run.nodeRuns[node.parentId]?.activationId ?? run.ownerSessionId : run.ownerSessionId,
      cwd: node.cwd ?? this.services.workspaceRoot,
      readOnly: ['reviewer', 'verifier', 'fresh-verifier', 'juror', 'arbiter', 'goal-checker', 'framework-validator'].includes(node.orchestration?.candidateRole ?? node.role ?? ''),
      allowChildren: node.allowChildren === true,
      actorRole: node.orchestration?.candidateRole ?? node.role,
      maxDepth: run.planSnapshot.budgets.maxDepth,
      allowedCapabilityIds: node.orchestration?.capabilityIds,
      attemptPolicy: {
        version: 1, runId: run.id, nodeId: node.id,
        beforeAttempt: async meta => {
          if (active.failure) throw active.failure;
          if (signal.aborted) throw new NexusError('CANCELLED', '节点已取消，拒绝新的运行时 attempt');
          try {
            await this.update(run.id, current => {
              if (admitAttempt(current, node.id, meta)) this.event(current, 'model.admitted', node.id, '发送前计入真实运行时 stream attempt；provider 内部 HTTP 次数不可见', {
                logicalCallId: meta.logicalCallId, attemptId: meta.attemptId, inputBytes: meta.inputBytes, boundary: 'llm-runtime-stream',
              });
            });
            physicalAttempts.add(`${meta.logicalCallId}:${meta.attemptId}`);
          } catch (error) { if (!(error instanceof NexusError) || error.code !== 'CANCELLED') active.failure = error; throw error; }
        },
        settleAttempt: async receipt => {
          let violation: NexusError | undefined;
          try {
            await this.update(run.id, current => {
              if (settleAttempt(current, node.id, receipt)) this.event(current, 'model.settled', node.id, '更新同一 Run/node 的 attempt 结算，未知用量保持未知', {
                logicalCallId: receipt.logicalCallId, attemptId: receipt.attemptId, status: receipt.status, usageRevision: receipt.usageRevision,
              });
              violation = observedBudgetViolation(current);
            });
            if (violation) throw violation;
          } catch (error) { active.failure = error; throw error; }
        },
      },
    };
    let result: ModelResult | undefined;
    await this.startExecution(run, node, context);
    if (node.orchestration?.rootOwned) {
      if (node.role === 'implementer' && node.writeClaims?.length) throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '当前宿主未提供有工具的主会话执行入口；T0 写任务等待主会话执行，禁止暗中派生');
      result = await this.services.host.model(request);
    } else {
      active.accepting = true;
      try { active.handle = await this.services.host.spawn(request); }
      finally { active.accepting = false; }
    }
    if (active.handle) {
      await this.update(run.id, current => {
        const value = current.nodeRuns[node.id]!; value.activationId = active.handle!.id; value.state = signal.aborted ? 'cancelRequested' : 'running';
        this.event(current, 'child.accepted', node.id, '保留正式宿主 activation 身份', { activationId: active.handle!.id });
      });
      if (signal.aborted) { await active.handle.dispose(); throw new NexusError('CANCELLED', '启动期间收到取消'); }
      result = await active.handle.result;
    }
      if (active.failure) throw active.failure;
      if (!result) throw new NexusError('MODEL_PROTOCOL_INVALID', '宿主未返回模型结果');
      const latest = (await this.get(run.id)).value;
      if (!physicalAttempts.size || latest.usage.attempts.some(attempt => physicalAttempts.has(`${attempt.logicalCallId}:${attempt.attemptId}`) && attempt.status === 'admitted')) throw new NexusError('MODEL_PROTOCOL_INVALID', '模型返回结果缺少真实 attempt 准入或结算，返回 usage 不能代替物理证据');
      const evidence = result.evidence && typeof result.evidence === 'object' ? result.evidence as JsonRecord : undefined;
      const observed = evidence?.observedRoute && typeof evidence.observedRoute === 'object' ? evidence.observedRoute as { provider?: string; model?: string } : undefined;
      await this.update(run.id, current => {
        current.nodeRuns[node.id]!.observedRoute = observed ? { ...observed, evidence: result!.evidence } : undefined;
      });
      if (node.route?.requireObserved && (!observed?.model || (node.route.model && node.route.model !== observed.model) || (node.route.provider && node.route.provider !== observed.provider))) throw new NexusError('EVIDENCE_MISMATCH', '宿主实测 route 缺失或与严格请求不同');
      if (mission) {
        const reportRef = await this.artifact(run.id, node.id, result.text);
        const review = { mission, reportRef, ...validateReviewReport(result.text, mission) };
        await this.update(run.id, current => {
          current.artifacts.push(reportRef); current.nodeRuns[node.id]!.evidenceRefs.push(reportRef.id);
          current.nodeRuns[node.id]!.reviewEvidence = review;
          this.event(current, 'review.reported', node.id, review.verdict, { reportRef: reportRef.id, valid: review.valid, reasons: review.reasons });
        });
      }
      if (!mission && node.outputContracts?.nonEmpty !== false && !result.text.trim()) throw new NexusError('MODEL_PROTOCOL_INVALID', '模型返回空结果');
      if (!mission && node.outputContracts?.json) {
        let parsed: unknown;
        try { parsed = JSON.parse(result.text); } catch { throw new NexusError('MODEL_PROTOCOL_INVALID', '模型结果不是完整 JSON'); }
        for (const field of node.outputContracts.requiredFields ?? []) if (!parsed || typeof parsed !== 'object' || !(field in parsed)) throw new NexusError('MODEL_PROTOCOL_INVALID', `模型结果缺少 ${field}`);
      }
      return { text: result.text, provider: observed?.provider ?? null, model: observed?.model ?? null, evidence: result.evidence, usage: result.usage };
  }
  private async reviewEvidence(run: Run, reviewer: TaskNode): Promise<GateReviewEvidence> {
    const currentMission = await freezeReviewMission(this.services, run, reviewer);
    const previous = run.nodeRuns[reviewer.id]?.reviewEvidence;
    if (!previous) {
      const reportRef = await this.artifact(run.id, reviewer.id, { reason: 'REVIEW_REPORT_MISSING' });
      await this.update(run.id, current => { current.artifacts.push(reportRef); current.nodeRuns[reviewer.id]!.evidenceRefs.push(reportRef.id); });
      return { mission: currentMission, reportRef, valid: false, verdict: 'needs-review', reasons: ['REVIEW_REPORT_MISSING'], findings: [] };
    }
    const stored = await this.services.store.get<{ content: string; hash: string; runId: string; nodeId: string }>('workflow-artifacts', previous.reportRef.id);
    const reasons: string[] = [];
    if (!stored || stored.value.runId !== run.id || stored.value.nodeId !== reviewer.id || stored.value.hash !== previous.reportRef.hash || digest(stored.value.content) !== previous.reportRef.hash) reasons.push('REVIEW_REPORT_INTEGRITY_MISMATCH');
    if (currentMission.missionHash !== previous.mission.missionHash) reasons.push('REVIEW_CANDIDATE_OR_CONTRACT_CHANGED');
    const validation = validateReviewReport(stored?.value.content ?? '', previous.mission);
    reasons.push(...validation.reasons);
    return { ...previous, ...validation, valid: !reasons.length, verdict: reasons.length ? 'needs-review' : validation.verdict, reasons };
  }
  private actorEvidence(run: Run, nodeId: string): ActorEvidence {
    const node = run.planSnapshot.nodes.find(n => n.id === nodeId);
    const runtime = run.nodeRuns[nodeId];
    return {
      actorId: runtime?.actorId ?? `missing:${nodeId}`,
      contextLineageId: node?.orchestration?.contextLineageId ?? `fresh:${run.id}:${nodeId}`,
      inheritedFullHistory: false,
      inputRefs: [{ ref: run.planId, kind: 'mission' }, ...(node?.inputRefs ?? []).map(ref => ({ ref, kind: 'raw-evidence' as const }))],
      model: runtime?.observedRoute?.model ? { providerRouteId: runtime.observedRoute.provider ?? 'unknown', modelId: runtime.observedRoute.model, endpointIdentity: runtime.observedRoute.provider ?? 'unknown', protocol: 'host' } : undefined,
    };
  }
  async cancel(id: string, context: DispatchContext = {}, nodeId?: string, reason = '用户取消'): Promise<StoredRecord<Run>> {
    const initial = await this.get(id, context);
    if (initial.value.finishedAt) return initial;
    const owned = nodeId ? new Set([nodeId]) : new Set(Object.keys(initial.value.nodeRuns));
    if (nodeId) for (let changed = true; changed;) {
      changed = false;
      for (const node of initial.value.planSnapshot.nodes) if (node.parentId && owned.has(node.parentId) && !owned.has(node.id)) { owned.add(node.id); changed = true; }
    }
    await this.update(id, run => {
      if (!nodeId) run.cancellationRequested = true;
      for (const [key, node] of Object.entries(run.nodeRuns)) if (owned.has(key) && !TERMINAL.has(node.state)) {
        node.state = this.active.has(`${id}:${key}`) ? 'cancelRequested'
          : node.activationId || node.execution?.state === 'started' || node.execution?.state === 'unknown'
            || ['starting', 'running', 'effectUnknown'].includes(node.state) ? 'effectUnknown' : 'cancelled';
        if (node.state === 'effectUnknown' && node.execution) node.execution.state = 'unknown';
      }
      run.state = 'cancelRequested'; this.event(run, 'cancel.requested', nodeId, reason);
    });
    const work = [...this.active].filter(([key]) => key.startsWith(`${id}:`) && owned.has(key.slice(id.length + 1))).map(async ([, active]) => {
      active.controller.abort();
      await active.done;
    });
    await Promise.allSettled(work);
    return this.update(id, run => {
      const unknown = Object.values(run.nodeRuns).some(n => ['effectUnknown', 'cancelRequested'].includes(n.state));
      run.state = unknown ? 'effectUnknown' : nodeId ? 'running' : 'cancelled';
      if (!nodeId && !unknown) run.finishedAt = now();
      this.event(run, 'cancel.settled', nodeId, unknown ? '取消尚未由宿主确认，需要 reconcile' : 'exact activation handle 已清理并等待后代退出');
    });
  }
  async pause(id: string, context: DispatchContext = {}): Promise<StoredRecord<Run>> {
    await this.get(id, context);
    return this.update(id, run => { run.paused = true; run.state = 'paused'; this.event(run, 'run.paused', undefined, '暂停后续派发，现有任务继续收集'); });
  }
  async resume(id: string, context: DispatchContext = {}, params: JsonRecord = {}): Promise<StoredRecord<Run>> {
    const previous = await this.get(id, context);
    if (Object.values(previous.value.nodeRuns).some(n => n.state === 'effectUnknown'
      || n.execution?.state === 'started' || n.execution?.state === 'unknown'
      || (n.state === 'interrupted' && (n.activationId
        || n.execution?.state !== 'prepared' && n.checkpoint?.previousState !== 'queued')))) {
      throw new NexusError('PROCESS_EFFECT_UNKNOWN', '先查询原调用收据或 activation，不能重复派发');
    }
    const row = await this.update(id, run => {
      for (const node of Object.values(run.nodeRuns)) {
        if (node.state === 'interrupted') node.state = 'queued';
        if (node.state === 'waiting' && Array.isArray(params.completedNodeIds) && params.completedNodeIds.includes(node.id)) {
          if (!Array.isArray(params.evidenceRefs) || !params.evidenceRefs.length) throw new NexusError('EVIDENCE_MISMATCH', '人工完成节点必须提供证据');
          node.state = 'succeeded'; node.evidenceRefs.push(...params.evidenceRefs as string[]); node.finishedAt = now();
        }
      }
      run.paused = false; run.cancellationRequested = false; run.finishedAt = undefined; run.state = 'queued';
      this.event(run, 'run.resumed', undefined, '显式继续冻结计划和剩余预算');
    });
    this.kick(id, context); return row;
  }
  async retry(id: string, context: DispatchContext, nodeIds?: string[]): Promise<StoredRecord<Run>> {
    const previous = await this.get(id, context);
    if (Object.values(previous.value.nodeRuns).some(n => ['effectUnknown', 'cancelRequested'].includes(n.state)
      || n.execution?.state === 'started' || n.execution?.state === 'unknown')) throw new NexusError('PROCESS_EFFECT_UNKNOWN', '先查询未知副作用状态，禁止盲目重发');
    const row = await this.update(id, run => {
      const failedIds = new Set(Object.values(run.nodeRuns).filter(n => ['failed', 'timedOut', 'blocked'].includes(n.state) && (!nodeIds || nodeIds.includes(n.id))).map(n => n.id));
      for (const key of failedIds) {
        const node = run.nodeRuns[key]!;
        if (node.attempt > run.planSnapshot.budgets.maxRetries) throw new NexusError('BUDGET_EXHAUSTED', '节点已达到重试预算');
        node.state = 'queued'; node.error = undefined; node.finishedAt = undefined;
      }
      run.finishedAt = undefined; run.paused = false; run.state = 'queued';
      this.event(run, 'run.retry', undefined, '同范围新物理 attempt，保留既有用量与无关证据', { nodeIds: [...failedIds] });
    });
    this.kick(id, context); return row;
  }
  async reconcile(id: string, context: DispatchContext = {}): Promise<StoredRecord<Run>> {
    const row = await this.get(id, context);
    for (const node of Object.values(row.value.nodeRuns).filter(n => !n.activationId
      && n.execution && ['interrupted', 'effectUnknown', 'cancelRequested'].includes(n.state))) {
      if (!['tool', 'cli', 'review', 'export', 'merge'].includes(node.execution!.kind) || !this.services.readReceipt) continue;
      const receipt = await this.services.readReceipt(node.execution!.requestId, node.execution!.receiptContext);
      if (!receipt) continue;
      const effects = (receipt.ok && receipt.data && typeof receipt.data === 'object'
        ? (receipt.data as JsonRecord).effects : receipt.error?.effects) as JsonRecord | undefined;
      if (unresolvedEffects(effects, !receipt.ok)) continue;
      const artifact = receipt.ok ? await this.artifact(id, node.id, receipt.data) : undefined;
      await this.update(id, run => {
        const current = run.nodeRuns[node.id]!;
        if (current.execution?.requestId !== node.execution!.requestId) throw new NexusError('REVISION_CONFLICT', '节点执行意图已变化');
        current.execution.state = 'settled';
        current.state = receipt.ok ? 'succeeded' : 'failed'; current.finishedAt = now();
        if (artifact) {
          current.resultRef = artifact; run.artifacts.push(artifact); run.usage.outputBytes += artifact.bytes;
          if (run.usage.outputBytes > run.planSnapshot.budgets.maxOutputBytes) {
            current.state = 'failed'; current.error = { code: 'BUDGET_EXHAUSTED', message: '输出超出字节预算' };
          } else current.error = undefined;
        } else if (receipt.error) current.error = { code: receipt.error.code, message: receipt.error.message };
        this.event(run, 'node.receipt-reconciled', node.id, '只读取原requestId持久收据，未重新执行', { requestId: node.execution!.requestId, state: current.state });
      });
      const pool = await this.services.store.get<Pool>('workflow-coordination', 'global-pool');
      for (const lease of pool?.value.leases.filter(l => l.runId === id && l.nodeId === node.id) ?? []) await this.release(lease.id);
    }
    for (const node of Object.values(row.value.nodeRuns).filter(n => n.activationId && ['interrupted', 'effectUnknown', 'cancelRequested'].includes(n.state))) {
      let state: JsonRecord;
      try { state = await this.services.host.sessions('activation/status', { activationId: node.activationId }) as JsonRecord; }
      catch (error) { state = { state: 'unknown', reason: errorInfo(error).message }; }
      await this.update(id, run => {
        const current = run.nodeRuns[node.id]!;
        if (state.state === 'succeeded' && (!current.resultRef || !run.artifacts.some(artifact => artifact.id === current.resultRef!.id && artifact.hash === current.resultRef!.hash) ||
          (requiresReviewReport(run.planSnapshot.nodes.find(candidate => candidate.id === node.id)!) && !current.reviewEvidence) ||
          run.usage.attempts.some(attempt => attempt.nodeId === node.id && attempt.status === 'admitted'))) {
          current.state = 'effectUnknown';
          current.error = { code: 'EVIDENCE_MISMATCH', message: '宿主成功状态缺少已收集的产物、审查或 attempt 结算，不能据此宣布成功' };
        } else if (['succeeded', 'failed', 'cancelled'].includes(String(state.state))) {
          current.state = state.state as NodeState;
          if (current.execution) current.execution.state = 'settled';
        }
        else current.state = 'effectUnknown';
        this.event(run, 'child.reconciled', node.id, '查询原 activation，未创建替代执行者', state);
      });
      if (['succeeded', 'failed', 'cancelled'].includes((await this.get(id)).value.nodeRuns[node.id]!.state)) {
        const pool = await this.services.store.get<Pool>('workflow-coordination', 'global-pool');
        for (const lease of pool?.value.leases.filter(l => l.runId === id && l.nodeId === node.id) ?? []) await this.release(lease.id);
      }
    }
    return this.get(id, context);
  }
  async wait(id: string, context: DispatchContext, afterRevision = 0, timeoutMs = 30000): Promise<StoredRecord<Run>> {
    const deadline = Date.now() + Math.min(60000, Math.max(0, timeoutMs));
    for (;;) {
      const row = await this.get(id, context);
      if (row.revision > afterRevision || row.value.finishedAt || Date.now() >= deadline) return row;
      await sleep(Math.min(250, deadline - Date.now()), context.signal);
    }
  }
  async export(id: string, context: DispatchContext): Promise<unknown> {
    const row = await this.get(id, context);
    return cleanExport({ schemaVersion: 1, exportedAt: now(), run: row, versions: { nexus: '1.0.0', metis: '2.0.2' }, licensing: ['DSH Nexus original', 'Metis MIT policies', 'Agency Agents Apache-2.0 assets'] });
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [key, active] of this.active) {
      active.controller.abort();
      await active.done;
      this.active.delete(key);
    }
    await Promise.allSettled(this.loops.values());
  }
}
