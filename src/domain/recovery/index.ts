import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  NexusError, recordParams, requiredString,
  type DispatchContext, type JsonRecord, type NexusModule, type NexusRequest, type NexusServices,
} from '../../ports/contracts.js';
import { ChangeLedgerEngine } from './upstream/engine.js';
import { ChangeLedgerError } from './upstream/errors.js';
import type { RestorePlan, RestoreResult } from './upstream/types.js';

type RecoveryMode = 'conversation-only' | 'files-only' | 'conversation-and-files';
interface Boundary {
  sessionId: string;
  workspaceId?: string;
  openingMessageSeq: number;
  previousTurnEndSeq?: number;
  draft: unknown;
  firstTurn: boolean;
  snapshotRevision?: string | number;
}
interface RecoveryPlan {
  id: string;
  mode: RecoveryMode;
  actorId: string;
  sessionId: string;
  workspace: string;
  workspaceIdentity: string;
  checkpointId?: string;
  boundary?: Boundary;
  filePlan?: RestorePlan;
  createdAt: string;
  expiresAt: string;
  digest: string;
}
interface RecoveryOperation {
  id: string;
  planId: string;
  planDigest: string;
  idempotencyKey: string;
  actorId: string;
  sessionId: string;
  mode: RecoveryMode;
  phase: 'created' | 'files-applying' | 'files-committed' | 'fork-intent' | 'completed' | 'rolled-back' | 'recovery-required' | 'fork-durability-uncertain';
  createdAt: string;
  updatedAt: string;
  files?: RestoreResult;
  childSessionId?: string;
  error?: string;
  warnings: string[];
}

const PLANS = 'recovery-plans';
const OPERATIONS = 'recovery-operations';
const APPROVAL_PERMISSION = 'recovery.capture';

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
function iso(value: number): string { return new Date(value).toISOString(); }
function publicValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'confirmation').map(([key, entry]) => [
      key, (key === 'createdAt' || key === 'expiresAt' || key === 'lastRestoredAt' || key === 'startedAt' || key === 'finishedAt')
        && typeof entry === 'number' ? iso(entry) : publicValue(entry),
    ]));
  }
  return value;
}
function page<T>(entries: readonly T[], request: NexusRequest): { items: T[]; cursor: string | null; total: number } {
  const offset = request.cursor ? Number(Buffer.from(request.cursor, 'base64url').toString()) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new NexusError('INVALID_CURSOR', '分页游标无效');
  const limit = Math.min(500, Math.max(1, request.limit ?? 100));
  return { items: entries.slice(offset, offset + limit), cursor: offset + limit < entries.length ? Buffer.from(String(offset + limit)).toString('base64url') : null, total: entries.length };
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function actor(context?: DispatchContext): string { return context?.actorId ?? 'host-authenticated-user'; }
function session(params: JsonRecord, context?: DispatchContext): string {
  return context?.sessionId ?? requiredString(params, 'sessionId');
}
function modeOf(value: unknown): RecoveryMode {
  if (value === 'conversation-only' || value === 'files-only' || value === 'conversation-and-files') return value;
  throw new NexusError('INVALID_ARGUMENT', 'mode 必须选择 conversation-only、files-only 或 conversation-and-files');
}

/** All filesystem recovery is opt-in. Merely loading this module creates no checkpoint or rescue data. */
export function createRecoveryModule(services: NexusServices): NexusModule {
  let engine: ChangeLedgerEngine | undefined;
  const active = new Map<string, Promise<RecoveryOperation>>();
  const busyWorkspaces = new Set<string>();
  const getEngine = (): ChangeLedgerEngine => {
    engine ??= new ChangeLedgerEngine({
      storageDir: join(services.dataDir, 'recovery'),
      maxFiles: 100_000, maxFileBytes: 64 * 1024 * 1024, maxSnapshotBytes: 2 * 1024 * 1024 * 1024,
      planTtlMs: 120_000, turnCheckpointMode: 'off', turnCheckpointTimeoutMs: 5_000,
      turnCheckpointMaxNewBytes: 256 * 1024 * 1024,
    });
    return engine;
  };
  async function authorize(action: string, resource: string, details: JsonRecord, context?: DispatchContext): Promise<void> {
    if (context?.permissions?.has(action)) return;
    if (!await services.host.approve(action, resource, details)) {
      throw new NexusError('APPROVAL_REQUIRED', '该操作会保存或恢复工作区文件，需要宿主确认精确范围', details);
    }
  }
  async function workspaceIdentity(root: string): Promise<string> {
    const canonical = await realpath(root);
    const info = await lstat(canonical, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new NexusError('UNSAFE_WORKSPACE', '工作区必须是真实目录');
    return digest({ canonical, dev: info.dev.toString(), ino: info.ino.toString(), birth: info.birthtimeNs.toString() });
  }
  async function hostSnapshot(sessionId: string): Promise<JsonRecord> {
    const value = asRecord(await services.host.sessions('snapshot', { sessionId }));
    if (!value.id && !value.sessionId) throw new NexusError('SESSION_UNVERIFIED', '宿主未返回可验证的会话');
    return value;
  }
  async function boundaryFor(params: JsonRecord, context?: DispatchContext): Promise<Boundary> {
    const sessionId = session(params, context);
    const snapshot = await hostSnapshot(sessionId);
    const openingMessageSeq = Number(params.openingMessageSeq);
    if (!Number.isSafeInteger(openingMessageSeq) || openingMessageSeq < 0) throw new NexusError('INVALID_BOUNDARY', '需要精确用户消息序号');
    const events = Array.isArray(snapshot.events) ? snapshot.events.map(asRecord) : [];
    const directUser = events.find(event =>
      Number(event.seq) === openingMessageSeq
      && (event.type === 'message' || event.type === 'user/message' || event.type === 'turn/start')
      && event.directUser === true
      && event.injected !== true);
    if (!directUser) throw new NexusError('INVALID_BOUNDARY', '所选事件不是宿主确认的直接用户消息');
    const previous = events.filter(event => event.type === 'turn/end' && Number(event.seq) < openingMessageSeq).at(-1);
    const firstTurn = !events.some(event =>
      Number(event.seq) < openingMessageSeq && event.directUser === true && event.injected !== true);
    if (!firstTurn && !previous) throw new NexusError('INCOMPLETE_BOUNDARY', '前一个完整回合边界不可验证');
    return {
      sessionId, openingMessageSeq,
      ...(typeof snapshot.workspaceId === 'string' ? { workspaceId: snapshot.workspaceId } : {}),
      ...(previous ? { previousTurnEndSeq: Number(previous.seq) } : {}),
      draft: directUser.content ?? directUser.message ?? directUser,
      firstTurn, snapshotRevision: snapshot.revision as string | number | undefined,
    };
  }
  async function noActiveWriters(workspace: string, sessionId: string): Promise<void> {
    const activeResult = await services.host.sessions('active', { workspace, sessionId });
    const entries = Array.isArray(activeResult) ? activeResult : asRecord(activeResult).agents;
    if (!Array.isArray(entries)) throw new NexusError('WORKSPACE_BARRIER_UNAVAILABLE', '宿主不能核验工作区活动代理，暂不允许文件恢复');
    const writers = entries.map(asRecord).filter(entry => entry.writing !== false && entry.state !== 'stopped' && entry.state !== 'completed');
    if (writers.length) throw new NexusError('WORKSPACE_BUSY', '请先停止正在写入该工作区的代理', { agents: writers });
  }
  async function saveOperation(operation: RecoveryOperation): Promise<RecoveryOperation> {
    const next = { ...operation, updatedAt: new Date().toISOString() };
    const stored = await services.store.get<RecoveryOperation>(OPERATIONS, operation.id);
    await services.store.put(OPERATIONS, next.id, next, stored?.revision ?? 0);
    services.emit('recovery.operation', next);
    return next;
  }
  async function plan(params: JsonRecord, context?: DispatchContext): Promise<RecoveryPlan> {
    const mode = modeOf(params.mode);
    const sessionId = session(params, context);
    const boundary = mode !== 'files-only' ? await boundaryFor(params, context) : undefined;
    const workspace = context?.workspaceRoot ?? services.workspaceRoot;
    let filePlan: RestorePlan | undefined;
    if (mode !== 'conversation-only') {
      await authorize('recovery.read', workspace, { checkpointId: params.checkpointId }, context);
      await noActiveWriters(workspace, sessionId);
      filePlan = await getEngine().planRestore({
        cwd: workspace, restorePointId: requiredString(params, 'checkpointId'), sessionId,
        paths: Array.isArray(params.paths) ? params.paths.map(String) : undefined,
        allowHeadChange: params.allowHeadChange === true,
        expectedCurrentTreeHash: typeof params.expectedCurrentTreeHash === 'string' ? params.expectedCurrentTreeHash : undefined,
        signal: context?.signal,
      });
    }
    const now = Date.now();
    const value = {
      id: randomUUID(), mode, actorId: actor(context), sessionId, workspace,
      workspaceIdentity: mode === 'conversation-only' ? '' : await workspaceIdentity(workspace),
      checkpointId: filePlan?.restorePointId, boundary, filePlan,
      createdAt: iso(now), expiresAt: iso(now + 120_000),
    };
    const result: RecoveryPlan = { ...value, digest: digest(value) };
    await services.store.put(PLANS, result.id, result, 0);
    return result;
  }
  async function apply(params: JsonRecord, context?: DispatchContext): Promise<RecoveryOperation> {
    const planId = requiredString(params, 'planId');
    const planRecord = await services.store.get<RecoveryPlan>(PLANS, planId);
    if (!planRecord) throw new NexusError('NOT_FOUND', '恢复计划不存在');
    const plan = planRecord.value;
    if (plan.actorId !== actor(context) || plan.sessionId !== session(params, context)) throw new NexusError('SESSION_MISMATCH', '恢复计划属于其他主体或会话');
    const key = requiredString(params, 'idempotencyKey');
    const operationId = digest({ actorId: plan.actorId, idempotencyKey: key });
    const pendingOperation = active.get(operationId);
    if (pendingOperation) return pendingOperation;
    const existing = await services.store.get<RecoveryOperation>(OPERATIONS, operationId);
    if (existing) {
      if (existing.value.planDigest !== plan.digest) throw new NexusError('IDEMPOTENCY_CONFLICT', '幂等键已绑定其他计划');
      return active.get(operationId) ?? existing.value;
    }
    if (Date.parse(plan.expiresAt) < Date.now()) throw new NexusError('PLAN_EXPIRED', '恢复计划已过期，请重新预览');
    if (busyWorkspaces.has(plan.workspace)) throw new NexusError('WORKSPACE_BUSY', '该工作区已有恢复操作');
    const promise = performApply(plan, operationId, key, context);
    active.set(operationId, promise);
    try { return await promise; } finally { active.delete(operationId); }
  }
  async function performApply(plan: RecoveryPlan, id: string, key: string, context?: DispatchContext): Promise<RecoveryOperation> {
    busyWorkspaces.add(plan.workspace);
    let operation: RecoveryOperation = {
      id, planId: plan.id, planDigest: plan.digest, idempotencyKey: key, actorId: plan.actorId,
      sessionId: plan.sessionId, mode: plan.mode, phase: 'created', warnings: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    try {
      if (plan.filePlan) {
        await authorize('recovery.apply', plan.workspace, { planId: plan.id, planDigest: plan.digest, paths: plan.filePlan.paths, createsRescueCheckpoint: true }, context);
        if (await workspaceIdentity(plan.workspace) !== plan.workspaceIdentity) throw new NexusError('WORKSPACE_IDENTITY_CHANGED', '工作区身份发生变化');
        await noActiveWriters(plan.workspace, plan.sessionId);
      }
      operation = await saveOperation(operation);
      if (plan.filePlan) {
        operation = await saveOperation({ ...operation, phase: 'files-applying' });
        const files = await getEngine().applyRestore({ planId: plan.filePlan.id, confirmation: plan.filePlan.confirmation, sessionId: plan.sessionId, signal: context?.signal });
        operation = await saveOperation({ ...operation, phase: 'files-committed', files });
      }
      if (plan.boundary) {
        // Never retry a fork after an unknown response: the durable intent has its
        // correlation ID so host reconciliation can locate the one child.
        operation = await saveOperation({ ...operation, phase: 'fork-intent' });
        let child: JsonRecord;
        try {
          child = asRecord(await services.host.sessions(plan.boundary.firstTurn ? 'create' : 'fork', {
            sessionId: plan.boundary.sessionId, workspaceId: plan.boundary.workspaceId,
            atSeq: plan.boundary.previousTurnEndSeq, correlationId: operation.id,
            draft: plan.boundary.draft, expectedRevision: plan.boundary.snapshotRevision,
          }));
        } catch (error) {
          operation = await saveOperation({ ...operation, phase: 'fork-durability-uncertain', error: String(error) });
          return operation;
        }
        const childId = typeof child.sessionId === 'string' ? child.sessionId : typeof child.id === 'string' ? child.id : undefined;
        if (!childId) return saveOperation({ ...operation, phase: 'fork-durability-uncertain', error: '宿主未返回可验证子会话标识' });
        operation = await saveOperation({ ...operation, childSessionId: childId });
        try { await services.host.sessions('flush', { sessionId: childId }); }
        catch (error) { return saveOperation({ ...operation, phase: 'fork-durability-uncertain', error: String(error) }); }
      }
      return saveOperation({ ...operation, phase: 'completed' });
    } catch (error) {
      const phase = error instanceof ChangeLedgerError && error.code === 'RESTORE_FAILED_ROLLED_BACK' ? 'rolled-back' : 'recovery-required';
      operation = await saveOperation({ ...operation, phase, error: String(error) });
      return operation;
    } finally {
      busyWorkspaces.delete(plan.workspace);
    }
  }
  return {
    id: 'recovery',
    capabilities: [
      { action: 'list', description: '列出工作区检查点与部分捕获事实' },
      { action: 'capture', description: '经宿主明确许可捕获用户检查点', mutating: true, permission: APPROVAL_PERMISSION },
      { action: 'capture.turn', description: '仅在用户明确启用时，为宿主验证的用户回合捕获有界检查点', mutating: true, permission: APPROVAL_PERMISSION },
      { action: 'configure', description: '明确选择是否启用未来回合的自动检查点；默认关闭', mutating: true, permission: 'recovery.configure' },
      { action: 'preview', description: '只读预览检查点差异与活跃代理' },
      { action: 'plan', description: '建立绑定主体、边界、文件指纹和时限的恢复计划', mutating: true },
      { action: 'changes', description: '分页查看稳定恢复计划差异' },
      { action: 'apply', description: '执行已批准恢复计划，验证并创建精确会话分支', mutating: true, permission: 'recovery.apply' },
      { action: 'operation', description: '查询幂等恢复操作与分叉线索' },
      { action: 'reconcile', description: '只读核验不确定分支；只在宿主证明未创建时补偿文件', mutating: true },
      { action: 'operations', description: '恢复操作账本' },
      { action: 'undo.plan', description: '从救援点建立新的撤销预览', mutating: true },
      { action: 'inventory', description: '恢复库存与未完成事务' },
      { action: 'cleanup.plan', description: '预览清理并保护进行中恢复引用' },
      { action: 'cleanup.apply', description: '按修订号清理获准检查点', mutating: true, permission: 'recovery.cleanup' },
    ],
    async dispatch(request, context) {
      const params = recordParams(request);
      if (context?.scopeLevel === 'session' && params.sessionId && params.sessionId !== context.sessionId) throw new NexusError('PERMISSION_DENIED', '恢复目标必须是当前会话');
      const workspace = context?.workspaceRoot ?? services.workspaceRoot;
      try {
        switch (request.action) {
          case 'list': return publicValue(page(await getEngine().list({ cwd: workspace, includeRescue: true, includeTurnCheckpoints: true, signal: context?.signal }), request));
          case 'capture': {
            await authorize(APPROVAL_PERMISSION, workspace, { label: params.label, purpose: '用户检查点；不是部署备份' }, context);
            return publicValue(await getEngine().create({ cwd: workspace, sessionId: context?.sessionId, label: typeof params.label === 'string' ? params.label : undefined, signal: context?.signal }));
          }
          case 'configure': {
            await authorize('recovery.configure', workspace, { automatic: params.automatic === true, createsFutureCheckpoints: params.automatic === true }, context);
            const key = digest(workspace);
            const previous = await services.store.get('recovery-config', key);
            if (request.expectedRevision !== (previous?.revision ?? 0)) throw new NexusError('STALE_REVISION', '恢复设置变化，需要匹配 expectedRevision');
            return services.store.put('recovery-config', key, {
              automatic: params.automatic === true,
              mode: params.mode === 'legacy' ? 'legacy' : 'auto',
              trust: params.trust === 'strict' ? 'strict' : 'fast',
              configuredAt: new Date().toISOString(),
              purpose: '用户未来回合文件检查点；不用于安装或部署备份',
            }, previous?.revision ?? 0);
          }
          case 'capture.turn': {
            const config = await services.store.get<JsonRecord>('recovery-config', digest(workspace));
            if (config?.value.automatic !== true) return { state: 'skipped', reason: 'automatic-checkpoint-disabled', capturesUserFiles: false };
            const boundary = await boundaryFor(params, context);
            const snapshot = await hostSnapshot(boundary.sessionId);
            const event = (snapshot.events as JsonRecord[]).find(event => Number(event.seq) === boundary.openingMessageSeq);
            if ((snapshot.events as JsonRecord[]).some(event => Number(event.seq) > boundary.openingMessageSeq
              && /^(?:step\/start|tool\/call|assistant\/message|turn\/end)$/.test(String(event.type)))) {
              throw new NexusError('CAPTURE_BOUNDARY_PASSED', '该回合已可能产生副作用，不创建伪装为回合开头的检查点');
            }
            const turn = Number(event?.turn ?? event?.turnNumber);
            if (!Number.isSafeInteger(turn) || turn < 0) throw new NexusError('INVALID_BOUNDARY', '宿主没有为用户回合提供稳定 turn 编号');
            getEngine().updateConfig({
              ...getEngine().config, turnCheckpointMode: config.value.mode === 'legacy' ? 'legacy' : 'auto',
              turnCheckpointTrust: config.value.trust === 'strict' ? 'strict' : 'fast',
            });
            return publicValue(await getEngine().createTurnCheckpoint({
              cwd: workspace, sessionId: boundary.sessionId, turn, turnStartSeq: boundary.openingMessageSeq, signal: context?.signal,
            }));
          }
          case 'preview': {
            await authorize('recovery.read', workspace, { checkpointId: params.checkpointId }, context);
            const preview = await getEngine().inspect({ cwd: workspace, restorePointId: requiredString(params, 'checkpointId'), signal: context?.signal });
            const activeAgents = await services.host.sessions('active', { workspace });
            return publicValue({ ...preview, changes: page(preview.changes, request), activeAgents, toctou: '逐路径重复身份与指纹校验；不声称工作区整体原子可见', metadata: '不恢复 ACL、xattr、hardlink topology' });
          }
          case 'plan': return publicValue(await plan(params, context));
          case 'changes': {
            const stored = await services.store.get<RecoveryPlan>(PLANS, requiredString(params, 'planId'));
            if (!stored || stored.value.actorId !== actor(context)) throw new NexusError('NOT_FOUND', '计划不存在');
            return publicValue({ ...page(stored.value.filePlan?.changes ?? [], request), planId: stored.id, revision: stored.revision, digest: stored.value.digest });
          }
          case 'apply': return apply(params, context);
          case 'operation': {
            const stored = await services.store.get<RecoveryOperation>(OPERATIONS, String(params.operationId ?? request.target?.id ?? ''));
            if (!stored || stored.value.actorId !== actor(context)) throw new NexusError('NOT_FOUND', '操作不存在');
            return stored;
          }
          case 'reconcile': {
            const stored = await services.store.get<RecoveryOperation>(OPERATIONS, requiredString(params, 'operationId'));
            if (!stored || stored.value.actorId !== actor(context)) throw new NexusError('NOT_FOUND', '操作不存在');
            const operation = stored.value;
            if (operation.phase !== 'fork-durability-uncertain' && operation.phase !== 'fork-intent') return operation;
            const lookup = asRecord(await services.host.sessions('fork.lookup', { correlationId: operation.id, sessionId: operation.sessionId }));
            if (lookup.known !== true) return { ...operation, warnings: [...operation.warnings, '宿主不能证明是否已创建分支；保留文件与线索，不重新 fork'] };
            if (lookup.created === true && typeof lookup.sessionId === 'string') {
              await services.host.sessions('flush', { sessionId: lookup.sessionId });
              return saveOperation({ ...operation, childSessionId: lookup.sessionId, phase: 'completed', error: undefined });
            }
            if (lookup.created === false && operation.files) {
              const planRecord = await services.store.get<RecoveryPlan>(PLANS, operation.planId);
              const sourcePlan = planRecord?.value;
              if (!sourcePlan?.filePlan) return saveOperation({ ...operation, phase: 'recovery-required', error: '缺少原文件恢复计划，保留救援点等待处理' });
              // The rescue is compared against the recognizable postimage first;
              // any later user edits prevent automatic compensation.
              const inspection = await getEngine().inspect({ cwd: sourcePlan.workspace, restorePointId: sourcePlan.filePlan.restorePointId });
              const edited = inspection.changes.filter(change => operation.files!.restoredPaths.includes(change.path));
              if (edited.length) return saveOperation({ ...operation, phase: 'recovery-required', error: '恢复后出现新编辑，不能自动补偿', warnings: [...operation.warnings, ...edited.map(change => change.path)] });
              await noActiveWriters(sourcePlan.workspace, operation.sessionId);
              const compensation = await getEngine().planRestore({ cwd: sourcePlan.workspace, restorePointId: operation.files.rescuePointId, sessionId: operation.sessionId, paths: operation.files.restoredPaths });
              await getEngine().applyRestore({ planId: compensation.id, confirmation: compensation.confirmation, sessionId: operation.sessionId });
              return saveOperation({ ...operation, phase: 'rolled-back', error: '宿主已证明未创建子会话，文件安全补偿完成' });
            }
            return saveOperation({ ...operation, phase: 'rolled-back', error: '宿主已证明没有创建子会话' });
          }
          case 'operations': return page((await services.store.list<RecoveryOperation>(OPERATIONS)).filter(row => row.value.actorId === actor(context)), request);
          case 'undo.plan': {
            const operation = await services.store.get<RecoveryOperation>(OPERATIONS, requiredString(params, 'operationId'));
            if (!operation || operation.value.actorId !== actor(context) || !operation.value.files) throw new NexusError('NOT_FOUND', '没有可撤销的文件恢复操作');
            return publicValue(await plan({ ...params, checkpointId: operation.value.files.rescuePointId, mode: 'files-only' }, context));
          }
          case 'inventory': return publicValue({ workspaces: await getEngine().listWorkspaces({ signal: context?.signal }), recovery: await getEngine().listRecovery({ cwd: workspace, signal: context?.signal }) });
          case 'cleanup.plan': {
            const ids = Array.isArray(params.checkpointIds) ? params.checkpointIds.map(String).sort() : [];
            const inventory = await getEngine().list({ cwd: workspace, includeRescue: true, includeTurnCheckpoints: true });
            const selected = inventory.filter(entry => ids.includes(entry.id));
            return { checkpointIds: selected.map(entry => entry.id), inventoryDigest: digest(inventory), estimatedLogicalBytes: selected.reduce((sum, entry) => sum + entry.totalBytes, 0), protectsPendingOperations: true };
          }
          case 'cleanup.apply': {
            await authorize('recovery.cleanup', workspace, { checkpointIds: params.checkpointIds }, context);
            const inventory = await getEngine().list({ cwd: workspace, includeRescue: true, includeTurnCheckpoints: true });
            if (digest(inventory) !== params.inventoryDigest) throw new NexusError('STALE_REVISION', '库存变化，请重新预览');
            return getEngine().purgeWorkspace({ workspace, restorePointIds: Array.isArray(params.checkpointIds) ? params.checkpointIds.map(String) : [] });
          }
          default: throw new NexusError('UNKNOWN_ACTION', `未知恢复操作 ${request.action}`);
        }
      } catch (error) {
        if (error instanceof ChangeLedgerError) throw new NexusError(error.code, error.message);
        throw error;
      }
    },
  };
}
