import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { isSurfaceEvent, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { isNexusError, NexusError, type StoredRecord } from '../ports/contracts.js';
import { parseCompressArgs } from '../adapters/upstream/billion/index.js';
import { COMPRESSION_DOCTRINE } from '../domain/context/doctrine.js';
import { hashObject, sha256 } from '../domain/context/cache.js';
import { appendNativeDiagnostic, beforeOfficialPhase, NATIVE_OWNER_COLLECTION,
  type NativeLaneOwner, type NativeOperationDiagnostic } from '../domain/context/native-transactions.js';
import { createLeaseManager, type Lease, type LeaseManager } from '../domain/storage/lease.js';
import { nativeErrorIdentity, toHarnessError, toNativeLlmError } from './native-diagnostics.js';
import { registerNativeCompactionBinding } from './compaction-binding.js';
import { compactSurfaceRegion } from '../../vendor/compaction-basic/region.mjs';
import { NATIVE_SYNC_CHECKPOINTS, nativeSyncStateHash, type NativeSyncCheckpoint } from '../domain/context/native-sync.js';
import type { ContextArchiveHead } from '../domain/context/archive-types.js';
import type { ContextSession } from '../domain/context/types.js';

const NATIVE_SURFACE_KEY = 'nexusNativeSurface';
const nativeSurfaceSchema = z.object({
  lastSurfaceSeq: z.number().int().min(-1),
  nodes: z.array(z.object({
    seq: z.number().int().nonnegative(), messageId: z.string().min(1),
    emptyMessage: z.record(z.string(), z.unknown()).optional(),
  })),
});
type NativeSurfaceState = z.infer<typeof nativeSurfaceSchema>;
type LaneLease = { record: StoredRecord<NativeLaneOwner>; retained: boolean; completed?: boolean; lease?: Lease };
const RUNNING_LANES = Symbol.for('dsh-nexus.native-compaction.running.v1');
function runningLanes(): Map<string, string> {
  const runtime = globalThis as typeof globalThis & { [RUNNING_LANES]?: Map<string, string> };
  return runtime[RUNNING_LANES] ??= new Map();
}

/**
 * Read-only host projection: retain current identity/position and the empty
 * native messages omitted by deriveMessages. Replacement removes shadowed
 * entries. The public registry drives new events and owns checkpoints; its
 * first materialization may fold the seed once.
 */
export const nativeSurfaceProjection = {
  key: NATIVE_SURFACE_KEY,
  stateVersion: 2,
  stateSchema: nativeSurfaceSchema,
  init: (): NativeSurfaceState => ({ lastSurfaceSeq: -1, nodes: [] }),
  apply(state: NativeSurfaceState, event: SessionEvent): NativeSurfaceState {
    // Unknown ignorable records can carry opaque surface-looking metadata.
    // The official predicate excludes them; content projections keep IDs and
    // positions and are reflected by deriveMessages at read time.
    if (!isSurfaceEvent(event)) return state;
    if (event.seq <= state.lastSurfaceSeq) {
      throw new NexusError('CTX_NATIVE_SURFACE_GAP', '原生表层投影事件水位倒退；必须从有效 checkpoint 或完整 seed 恢复');
    }
    const message: any = event.type === 'user/message' ? event.data : (event.data as any).message;
    if (typeof message?.id !== 'string' || !message.id) {
      throw new NexusError('CTX_NATIVE_SURFACE_INVALID', '正式表层事件没有稳定消息标识');
    }
    const node = { seq: Number(event.seq), messageId: message.id,
      ...(['system', 'developer', 'assistant'].includes(message.role) && message.content?.length === 0
        ? { emptyMessage: structuredClone(message) } : {}) };
    const operation = event.surfaceOp;
    if (operation === 'append') return { lastSurfaceSeq: event.seq, nodes: [...state.nodes, node] };
    const start = state.nodes.findIndex(entry => entry.seq === operation.startSeq);
    const end = state.nodes.findIndex(entry => entry.seq === operation.endSeq);
    if (start < 0 || end < start) {
      throw new NexusError('CTX_NATIVE_SURFACE_INVALID', '正式替换的端点不在当前有序表层，不能按 seq 数值猜测范围');
    }
    return { lastSurfaceSeq: event.seq, nodes: [...state.nodes.slice(0, start), node, ...state.nodes.slice(end + 1)] };
  },
};

/**
 * Uses the official transactional compactor as the only main-session mutation
 * owner. The reused kernel chooses and prepares; DSH validates/balances and
 * commits; the kernel activates only after independently reading that receipt.
 */
export default class NexusCompactionEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions', 'nexus', 'systemPrompt', 'sessionQuery', 'sessionProjections'];
  private pendingSummaries = new WeakMap<object, any>();
  private officialOwners = new WeakMap<object, LaneLease>();
  private nativeContext: any;
  private nativeOverflowRetries = new WeakMap<object, number>();
  private idleRangeAgents = new WeakSet<object>();
  private runningLanes = runningLanes();
  private laneLeases?: LeaseManager;

  constructor(ctx: any, config: any = {}) {
    super(ctx, { ...config, auto: false });
    this.nativeContext = ctx;
    const projections = ctx.get('sessionProjections');
    if (typeof projections?.register !== 'function' || typeof projections.stateOf !== 'function') {
      throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', 'DSH 公有 sessionProjections registry 不可用；不能反复扫描完整日志冒充增量同步');
    }
    projections.register(nativeSurfaceProjection);
    const binding = registerNativeCompactionBinding(ctx, this);
    ctx.get('systemPrompt').context({
      name: 'nexus-compression-doctrine', order: -100,
      text: COMPRESSION_DOCTRINE, interpolate: false,
    });
    ctx.on('agent/pre-step', async ({ agent, signal }: any, next: () => Promise<any>) => {
      binding.bind(agent);
      if (!signal.aborted) await this.compactIfNeeded(agent, 'pressure', signal);
      return next();
    });
    ctx.on('agent/request-error', async ({ agent, failure, signal }: any, next: () => Promise<any>) => {
      if (failure.code !== 'CONTEXT_WINDOW_EXCEEDED' || signal.aborted) return next();
      const retries = this.nativeOverflowRetries.get(agent) ?? 0;
      if (retries >= 2) return next();
      let result: any;
      try { result = await this.compactIfNeeded(agent, 'context-overflow', signal); }
      catch (error) {
        // A failed auxiliary recovery must not replace the real provider
        // CONTEXT_WINDOW_EXCEEDED error with an unrelated generic failure.
        this.notifyDiagnostic(agent, error);
        return next();
      }
      if (result) { this.nativeOverflowRetries.set(agent, retries + 1); return { kind: 'retry' }; }
      return next();
    });
    ctx.on('agent/status', ({ agent, status }: any) => { if (status === 'idle') this.nativeOverflowRetries.delete(agent); });
  }

  private async call(agent: any, action: string, params: Record<string, unknown>, signal?: AbortSignal, requestId?: string): Promise<any> {
    return this.nativeContext.get('nexus').services.invoke('context', {
      action, requestId: requestId ?? `native:${agent.id}:${action}:${randomUUID()}`,
      params: { sessionId: agent.id, purpose: 'main', lane: 'main', ...params },
    }, { sessionId: agent.id, workspaceRoot: agent.session.header.cwd, signal, actorId: 'native-compaction-owner', permissions: new Set([`context.${action}`]) });
  }

  private async synchronize(agent: any, signal: AbortSignal): Promise<any> {
    const session = agent.session;
    const header = session.requestHeader();
    const route = header?.config ?? agent.options;
    if (!route?.provider || !route?.model) return null;
    const metadata = await this.nativeContext.get('llm').resolveModelInfo(route.provider, route.model, signal);
    const windowTokens = metadata.context?.contextWindow;
    if (!windowTokens) throw new NexusError('DEPENDENCY_MISSING', '精确模型窗口未知，Nexus 不猜测主会话容量');
    const messages = session.deriveMessages();
    const byId = new Map<string, any>(messages.map((message: any) => [message.id, message]));
    if (byId.size !== messages.length) throw new NexusError('CTX_NATIVE_SURFACE_INVALID', '当前派生表层存在重复消息身份，不能猜测 seq 归属');
    const projected = this.nativeContext.get('sessionProjections').stateOf(session, NATIVE_SURFACE_KEY) as NativeSurfaceState | undefined;
    const current = session.surface.nodes as readonly number[];
    if (!projected || projected.nodes.length !== current.length
        || projected.nodes.some((entry, index) => entry.seq !== current[index])) {
      throw new NexusError('CTX_NATIVE_SURFACE_GAP', '原生只读投影与正式表层不在同一切面；未发送不完整来源');
    }
    const matched = new Set<string>();
    const nodes = projected.nodes.map(({ seq, messageId, emptyMessage }) => {
      const derived = byId.get(messageId);
      let message = derived ?? emptyMessage;
      if (!message && typeof session.eventAt === 'function') {
        // Public point access also covers a formerly nonempty node hidden by
        // a committed content projection. It never reads the session log.
        const event = session.eventAt(SessionSeq(seq));
        const original = event?.type === 'user/message' ? event.data : event?.data?.message;
        if (original?.id === messageId) message = original;
      }
      if (!message) throw new NexusError('CTX_NATIVE_SURFACE_INVALID', '当前正式节点没有可核验的原生消息', { seq, messageId });
      if (derived && matched.has(messageId)) throw new NexusError('CTX_NATIVE_SURFACE_INVALID', '多个正式节点具有同一派生消息身份', { seq, messageId });
      if (derived) matched.add(messageId);
      return { seq, message };
    });
    if (matched.size !== messages.length) throw new NexusError('CTX_NATIVE_SURFACE_INVALID', '存在无法归属正式 seq 的派生消息');
    const params = {
      sessionId: agent.id, purpose: 'main', lane: 'main',
      nodes, surfaceSeqs: [...current],
      route: { providerId: route.provider, modelId: route.model, adapterVersion: 'dsh-0.2.1-rc.2' },
      windowTokens, outputReserveTokens: header?.config?.maxTokens ?? metadata.defaultMaxTokens ?? 0,
      tools: header?.tools ?? [], system: '',
    };
    const store = this.nativeContext.get('nexus').services.store;
    const key = this.laneKey(agent);
    const [head, checkpoint] = await Promise.all([
      store.get('context.sessions', key) as Promise<StoredRecord<ContextSession | ContextArchiveHead> | undefined>,
      store.get(NATIVE_SYNC_CHECKPOINTS, key) as Promise<StoredRecord<NativeSyncCheckpoint> | undefined>,
    ]);
    const previous = checkpoint?.value;
    // Reuse the original intent as well as its plan/wire. Durable receipts keep
    // their existing recovery contract and remain byte-for-byte replayable.
    const requestId = previous?.schemaVersion === 1 && previous.sessionKey === key
      && previous.inputHash === hashObject(params)
      && (previous.state === 'started' || previous.state === 'finished' && previous.stateHash === nativeSyncStateHash(head?.value))
      ? previous.requestId : undefined;
    const result = await this.call(agent, 'native/sync', params, signal, requestId);
    return result;
  }

  override async compactIfNeeded(agent: any, trigger: any, signal: AbortSignal): Promise<any> {
    try {
      return await this.withLane(agent, 'autonomous', async owner => {
        const synced = await this.synchronize(agent, signal);
        if (!synced) return null;
        if (!synced.nudge?.shouldInject && trigger !== 'context-overflow') return null;
        await this.updateOwner(owner, { phase: 'decision-started' });
        const proposal = await this.call(agent, 'native/propose', { force: trigger === 'context-overflow' }, signal);
        if (proposal.decision !== 'compress') {
          await this.updateOwner(owner, { phase: 'preparing', consecutivePreparationFailures: 0,
            auxiliaryRetryAfter: new Date(Date.now() + 15_000).toISOString() });
          return null;
        }
        return this.commitProposal(agent, proposal, signal, owner);
      }, signal, trigger === 'pressure');
    } catch (error) {
      this.notifyDiagnostic(agent, error);
      const details = isNexusError(error) ? error.details as Record<string, unknown> | undefined : undefined;
      if (trigger === 'pressure' && details?.officialEffect === 'not-started' && !signal.aborted) {
        // Preparation/model analysis is an aid to the normal request. Its
        // failure is terminal for that operation, not for the user's turn.
        return null;
      }
      throw toNativeLlmError(error, { phase: 'automatic-context-maintenance', signalAborted: signal.aborted });
    }
  }

  private notifyDiagnostic(agent: any, error: unknown): void {
    const identity = nativeErrorIdentity(error);
    try { this.nativeContext.get('nexus').services.emit('nexus.context.native-diagnostic', {
      sessionId: agent.id, ...identity,
    }); } catch { /* A diagnostics observer cannot affect a native operation. */ }
    try { this.nativeContext.logger?.warn?.(`Nexus context maintenance ${identity.code}; traceId=${identity.traceId}`); }
    catch { /* Never log exception bodies, request parameters or model text. */ }
  }

  private async commitProposal(agent: any, proposal: any, signal: AbortSignal, owner: LaneLease): Promise<any> {
    await this.updateOwner(owner, { phase: 'proposal-prepared', proposalId: proposal.proposalId,
      sourceSeqs: proposal.sourceSeqs, summaryHash: sha256(proposal.summary) });
    this.pendingSummaries.set(agent, proposal);
    let officialResult: any;
    try {
      await this.updateOwner(owner, { phase: 'official-started' });
      this.officialOwners.set(agent, owner);
      try {
        officialResult = this.idleRangeAgents?.has(agent)
          ? await compactSurfaceRegion({
            meter: this.nativeContext.get('tokenMeter'),
            summarize: (input, owner, abort) => this.summarize(input, owner, abort),
            recover: (error, owner, sourceEventSeqs, abort) => this.nativeContext.waterfall('compaction/summary-error', {
              session: owner.session, sourceEventSeqs, error, ...(abort ? { signal: abort } : {}),
            }, () => false),
          }, agent.session, proposal.startSeq, proposal.endSeq, agent,
          { owner: null, stability: 'selected-span' }, signal)
          : await super.compactRegion(proposal.startSeq, proposal.endSeq, agent, signal);
      }
      finally { this.officialOwners.delete(agent); }
      await this.updateOwner(owner, { hostCompactionId: officialResult.compactionId });
      const flushed = await this.nativeContext.get('sessions').flush(agent.session);
      if (flushed !== true) throw new NexusError('SESSION_DURABILITY_UNVERIFIED', '宿主未确认正式压缩的持久化检查点');
      await this.updateOwner(owner, { phase: 'official-flushed' });
      await this.call(agent, 'native/commit', { proposalId: proposal.proposalId, hostCompactionId: officialResult.compactionId }, signal);
      await this.completeOwner(owner);
      return officialResult;
    } catch (error) {
      // Once the official replacement lands it owns the effect. Retain the
      // prepared proposal for receipt reconciliation after a durability error.
      let snapshot: any;
      try {
        if (await this.nativeContext.get('sessions').flush(agent.session) !== true) {
          throw new NexusError('SESSION_DURABILITY_UNVERIFIED', '正式事务终止记录尚未确认持久化');
        }
        snapshot = await this.nativeContext.get('sessionQuery').readSession(agent.id);
      }
      catch (snapshotError) {
        await this.retainOwner(owner, error);
        throw new NexusError('PARTIAL_EFFECT', '无法读取权威宿主日志，正式压缩效果未知；保留提案并阻止重复执行', {
          proposalId: proposal.proposalId, hostCompactionId: officialResult?.compactionId,
          officialEffect: 'unknown', cause: isNexusError(error) ? error.code : 'official-compaction-failed',
          snapshotCode: isNexusError(snapshotError) ? snapshotError.code : 'snapshot-unavailable',
        });
      }
      const landed = snapshot.events.find((event: any) => event.type === 'compaction/summary'
        && event.seq > owner.record.value.startedThroughSeq
        && hashObject(event.data?.shadowedSeqs) === hashObject(proposal.sourceSeqs)
        && Array.isArray(event.data?.summary)
        && event.data.summary.every((block: any) => block?.type === 'text' && typeof block.text === 'string')
        && event.data.summary.map((block: any) => block.text).join('') === proposal.summary);
      if (officialResult || landed) {
        await this.retainOwner(owner, error, { hostCompactionId: officialResult?.compactionId ?? landed?.data?.compactionId });
        throw new NexusError('PARTIAL_EFFECT', '正式压缩已产生记录；耐久回执尚待对账，不能重新执行', {
          proposalId: proposal.proposalId, hostCompactionId: owner.record.value.hostCompactionId,
          cause: isNexusError(error) ? error.code : 'official-compaction-receipt-failed',
        });
      }
      const failed = this.failedOfficial(owner.record.value, snapshot.events);
      if (failed) await this.updateOwner(owner, { hostCompactionId: failed.compactionId, officialStartSeq: failed.startSeq });
      if (!failed && !this.noOfficialStart(agent, owner, snapshot.events)) {
        await this.retainOwner(owner, error);
        throw new NexusError('PARTIAL_EFFECT', '正式操作未有可核验的终止收据；保留提案供对账', { officialEffect: 'unknown' });
      }
      if (!failed) await this.updateOwner(owner, { phase: 'proposal-prepared' });
      try {
        await this.call(agent, 'native/abort', { proposalId: proposal.proposalId,
          reason: isNexusError(error) ? error.code : 'official-compaction-failed' });
        await this.finishOfficialFailure(agent, owner, error);
      } catch (abortError) {
        await this.retainOwner(owner, abortError);
        throw new NexusError('PARTIAL_EFFECT', '正式替换未出现，但提案撤销收据未确认；该 lane 保持待对账', {
          proposalId: proposal.proposalId, officialEffect: 'not-observed',
          cause: isNexusError(abortError) ? abortError.code : 'proposal-abort-unconfirmed',
        });
      }
      throw error;
    } finally { this.pendingSummaries.delete(agent); }
  }

  async compactRanges(agent: any, params: Record<string, unknown>, signal: AbortSignal): Promise<any> {
    try {
      if (this.idleRangeAgents?.has(agent)) throw new NexusError('CTX_NATIVE_BUSY', '此会话的空闲压缩正在执行，未重复发起');
      if (agent.status !== 'idle') return await this.prepareRanges(agent, params, signal);
      if (typeof agent.runMaintenance !== 'function') throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '宿主未提供空闲会话维护合同，未执行压缩');
      let admitted = false;
      try {
        return await agent.runMaintenance(async (maintenanceSignal: AbortSignal) => {
          admitted = true;
          const operationSignal = AbortSignal.any([signal, maintenanceSignal]);
          this.idleRangeAgents.add(agent);
          try { return await this.prepareRanges(agent, params, operationSignal); }
          finally { this.idleRangeAgents.delete(agent); }
        });
      } catch (error) {
        if (!admitted && !signal.aborted) throw new NexusError('CTX_NATIVE_BUSY', '会话正忙或已有待执行输入，空闲后重试；未执行压缩');
        throw error;
      }
    }
    // This entry returns to the Nexus dispatcher, not the native turn driver.
    // Retain the branded domain contract across the separate bundle entries.
    catch (error) { if (isNexusError(error)) throw error; throw toHarnessError(error); }
  }

  private async prepareRanges(agent: any, params: Record<string, unknown>, signal: AbortSignal): Promise<any> {
    let ranges: any[] | undefined;
    if (params.autonomous !== true && Array.isArray(params.ranges)) ranges = params.ranges;
    else if (params.autonomous !== true && params.content) {
      const parsed = parseCompressArgs({ content: params.content });
      if (!parsed.diagnostics.ok) throw new NexusError('CTX_RANGE_INVALID', '无法解析原生折叠范围', parsed.diagnostics);
      ranges = parsed.ranges;
    }
    if (params.autonomous !== true && (!ranges?.length || ranges.length > 1000)) {
      throw new NexusError('CTX_RANGE_INVALID', '显式压缩需要 1–1000 个范围');
    }
    if (params.autonomous === true) {
      return this.withLane(agent, 'autonomous', async owner => {
        if (!await this.synchronize(agent, signal)) return null;
        await this.updateOwner(owner, { phase: 'decision-started' });
        const proposal = await this.call(agent, 'native/propose', { force: params.force === true,
          provider: params.provider, model: params.model }, signal);
        if (proposal.decision === 'compress') return this.commitProposal(agent, proposal, signal, owner);
        await this.updateOwner(owner, { phase: 'preparing' });
        return proposal;
      }, signal);
    }
    const results: any[] = [];
    try {
      for (const range of ranges!) {
        results.push(await this.withLane(agent, 'explicit-ranges', async owner => {
          signal.throwIfAborted();
          await this.synchronize(agent, signal);
          await this.updateOwner(owner, { phase: 'decision-started' });
          const proposal = await this.call(agent, 'native/propose', { ranges: [range] }, signal);
          if (proposal.decision === 'compress') return this.commitProposal(agent, proposal, signal, owner);
          await this.updateOwner(owner, { phase: 'preparing' });
          return proposal;
        }, signal));
      }
      return { results, committed: results.length };
    } catch (error) {
      if (results.length) throw new NexusError('PARTIAL_EFFECT', '部分范围已处理，后续范围未完成', {
        results, completed: results.length, cause: isNexusError(error) ? error.code : 'compaction-failed',
      });
      throw error;
    }
  }

  override async compactNow(agent: any, signal: AbortSignal, sourceCommandId?: any): Promise<any> {
    try {
      return await this.withLane(agent, 'manual-now', async owner => {
        await this.synchronize(agent, signal);
        return this.commitManual(agent, signal, owner, () => super.compactNow(agent, signal, sourceCommandId));
      }, signal);
    } catch (error) { throw toHarnessError(error); }
  }

  override async compactRegion(start: any, end: any, agent: any, signal?: AbortSignal): Promise<any> {
    const operationSignal = signal ?? this.nativeContext.get('nexus').services.signal ?? new AbortController().signal;
    try {
      return await this.withLane(agent, 'manual-region', async owner => {
        await this.synchronize(agent, operationSignal);
        return this.commitManual(agent, operationSignal, owner, () => super.compactRegion(start, end, agent, operationSignal));
      }, operationSignal);
    } catch (error) { throw toHarnessError(error); }
  }

  private async commitManual(agent: any, signal: AbortSignal, owner: LaneLease, execute: () => Promise<any>): Promise<any> {
    let result: any;
    try {
      await this.updateOwner(owner, { phase: 'official-started' });
      this.officialOwners.set(agent, owner);
      try { result = await execute(); }
      finally { this.officialOwners.delete(agent); }
      if (!result) {
        await this.updateOwner(owner, { phase: 'preparing' });
        return result;
      }
      await this.updateOwner(owner, { hostCompactionId: result.compactionId });
      const flushed = await this.nativeContext.get('sessions').flush(agent.session);
      if (flushed !== true) throw new NexusError('SESSION_DURABILITY_UNVERIFIED', '宿主未确认手动压缩的持久化检查点');
      await this.updateOwner(owner, { phase: 'official-flushed' });
      await this.call(agent, 'native/import', { hostCompactionId: result.compactionId }, signal);
      await this.completeOwner(owner);
      return result;
    } catch (error) {
      let snapshot: any;
      try {
        if (await this.nativeContext.get('sessions').flush(agent.session) !== true) {
          throw new NexusError('SESSION_DURABILITY_UNVERIFIED', '手动事务终止记录尚未确认持久化');
        }
        snapshot = await this.nativeContext.get('sessionQuery').readSession(agent.id);
      }
      catch {
        await this.retainOwner(owner, error, { hostCompactionId: result?.compactionId ?? owner.record.value.hostCompactionId });
        throw new NexusError('PARTIAL_EFFECT', '权威宿主日志不可读，手动压缩效果未知；保留 lane 等待对账', {
          hostCompactionId: result?.compactionId, officialEffect: 'unknown',
          cause: isNexusError(error) ? error.code : 'native-import-failed',
        });
      }
      const landed = snapshot.events.find((event: any) => event.type === 'compaction/summary'
        && event.seq > owner.record.value.startedThroughSeq);
      if (!result && !landed) {
        const failed = this.failedOfficial(owner.record.value, snapshot.events);
        if (failed) await this.updateOwner(owner, { hostCompactionId: failed.compactionId, officialStartSeq: failed.startSeq });
        if (failed || this.noOfficialStart(agent, owner, snapshot.events)) {
          await this.finishOfficialFailure(agent, owner, error);
          throw error;
        }
        await this.retainOwner(owner, error);
        throw new NexusError('PARTIAL_EFFECT', '未观察到正式替换，但手动模型调用结果未知；保留 lane，不能自动重复执行', {
          officialEffect: 'not-observed', modelEffect: 'unknown',
          cause: isNexusError(error) ? error.code : 'manual-compaction-unconfirmed',
        });
      }
      // A nearby manual summary has no proposal fingerprint tying it to this
      // operation. Only the result's own ID can authorize later completion.
      await this.retainOwner(owner, error, { hostCompactionId: result?.compactionId ?? owner.record.value.hostCompactionId });
      throw new NexusError('PARTIAL_EFFECT', '正式手动压缩已产生记录；耐久性和 Nexus 来源回执仍须对账', {
        hostCompactionId: owner.record.value.hostCompactionId, cause: isNexusError(error) ? error.code : 'native-import-failed',
      });
    }
  }

  /** A paired official error is terminal only when that same transaction never replaced the surface. */
  private failedOfficial(value: NativeLaneOwner, events: any[]): { compactionId: string; startSeq: number } | undefined {
    const starts = events.filter(event => event.type === 'compaction/start' && event.seq > value.startedThroughSeq
      && typeof event.data?.compactionId === 'string'
      && (!value.hostCompactionId || event.data.compactionId === value.hostCompactionId)
      && (value.officialStartSeq === undefined || event.seq === value.officialStartSeq));
    if (starts.length !== 1) return undefined;
    const start = starts[0], id = start.data.compactionId;
    const ends = events.filter(event => event.type === 'compaction/end' && event.seq > start.seq && event.data?.compactionId === id);
    if (ends.length !== 1 || !ends[0].data?.error) return undefined;
    if (events.some(event => event.data?.compactionId === id && event.type === 'compaction/summary'
      || event.type === 'user/message' && event.data?.source?.compactionId === id)) return undefined;
    return { compactionId: id, startSeq: start.seq };
  }

  /** Only used after the original local await has rejected, never for an orphan owner after restart. */
  private noOfficialStart(agent: any, owner: LaneLease, events: any[]): boolean {
    if (owner.record.value.hostCompactionId || typeof agent.session.eventAt !== 'function') return false;
    const through = owner.record.value.startedThroughSeq;
    for (let seq = through + 1; seq < agent.session.seq; seq++) {
      const event = agent.session.eventAt(SessionSeq(seq));
      if (['compaction/start', 'compaction/summary', 'compaction/end'].includes(event?.type)) return false;
    }
    return !events.some(event => event.seq > through && ['compaction/start', 'compaction/summary', 'compaction/end'].includes(event.type));
  }

  private async finishOfficialFailure(agent: any, owner: LaneLease, error: unknown): Promise<void> {
    const flushed = await this.nativeContext.get('sessions').flush(agent.session);
    if (flushed !== true) throw new NexusError('SESSION_DURABILITY_UNVERIFIED', '失败的正式事务尚未确认持久化，保留 lane 等待对账');
    const diagnostic = this.operationDiagnostic(owner, error, 'failed-before-replacement');
    await this.updateOwner(owner, { status: 'released', phase: 'official-failed',
      traceId: diagnostic.traceId, errorCode: diagnostic.code,
      diagnostics: appendNativeDiagnostic(owner.record.value, { ...diagnostic, auxiliaryEffect: 'unknown', officialEffect: 'not-started' }) });
    owner.completed = true;
  }

  private laneKey(agent: any): string {
    return hashObject({ sessionId: agent.id, purpose: 'main', lane: 'main', branchId: 'main',
      workspace: path.resolve(agent.session.header.cwd ?? this.nativeContext.get('nexus').services.workspaceRoot).toLowerCase() });
  }

  private async updateOwner(owner: LaneLease, patch: Partial<NativeLaneOwner>): Promise<void> {
    await owner.lease?.assertOwned();
    owner.record = await this.nativeContext.get('nexus').services.store.put(NATIVE_OWNER_COLLECTION, owner.record.id,
      { ...owner.record.value, ...patch, updatedAt: new Date().toISOString() }, owner.record.revision);
  }

  private async retainOwner(owner: LaneLease, error: unknown, patch: Partial<NativeLaneOwner> = {}): Promise<void> {
    owner.retained = true;
    // If this small receipt write itself fails, the previous active CAS record
    // still prevents another compactor from issuing a duplicate model/replace.
    const diagnostic = this.operationDiagnostic(owner, error, 'reconciliation-required');
    await this.updateOwner(owner, { ...patch, status: 'reconciliation-required',
      errorCode: diagnostic.code, traceId: diagnostic.traceId,
      diagnostics: appendNativeDiagnostic(owner.record.value, diagnostic) }).catch(() => undefined);
  }

  private operationDiagnostic(
    owner: LaneLease, error: unknown, outcome: NativeOperationDiagnostic['outcome'],
  ): NativeOperationDiagnostic {
    const phase = owner.record.value.phase;
    return {
      at: new Date().toISOString(), operationId: owner.record.value.operationId,
      ...nativeErrorIdentity(error, beforeOfficialPhase(phase) ? 'CTX_PREPARATION_FAILED' : 'CTX_NATIVE_OPERATION_FAILED'), phase, outcome,
      ...(outcome === 'abandoned-before-official' && /^[A-Z][A-Z0-9_]{0,95}$/.test(owner.record.value.errorCode ?? '')
        ? { previousCode: owner.record.value.errorCode } : {}),
      auxiliaryEffect: phase === 'preparing' ? 'not-started'
        : phase === 'decision-started' ? 'unknown' : 'completed',
      officialEffect: beforeOfficialPhase(phase) ? 'not-started'
        : phase === 'context-committed' ? 'committed' : 'unknown',
    };
  }

  private async finishPreparation(
    owner: LaneLease, error: unknown, abandoned = false,
  ): Promise<NativeOperationDiagnostic> {
    const diagnostic = this.operationDiagnostic(owner, error, abandoned ? 'abandoned-before-official' : 'failed-before-official');
    const previousFailures = owner.record.value.consecutivePreparationFailures ?? 0;
    const failures = Math.min(8, (Number.isSafeInteger(previousFailures) && previousFailures >= 0 ? previousFailures : 0) + 1);
    // This timestamp controls whether a NEW automatic auxiliary analysis may
    // be admitted. It is never evidence for clearing an official mutation.
    const retryAfter = new Date(Date.now() + Math.min(300_000, 30_000 * 2 ** (failures - 1))).toISOString();
    await this.updateOwner(owner, {
      status: 'released', phase: abandoned ? 'preparation-abandoned' : 'preparation-failed',
      traceId: diagnostic.traceId, errorCode: diagnostic.code,
      diagnostics: appendNativeDiagnostic(owner.record.value, diagnostic),
      consecutivePreparationFailures: failures, auxiliaryRetryAfter: retryAfter,
    });
    owner.completed = true;
    return diagnostic;
  }

  private async completeOwner(owner: LaneLease, recovered = false): Promise<void> {
    const latest = await this.nativeContext.get('nexus').services.store.get(NATIVE_OWNER_COLLECTION, owner.record.id) as StoredRecord<NativeLaneOwner> | undefined;
    if (!latest) throw new NexusError('CTX_NATIVE_RECONCILIATION_REQUIRED', '已提交原生事务的 lane 收据缺失');
    // The domain can finish this same owner while draining its transaction
    // outbox. A later owner may already have acquired the released lane; this
    // completed operation must never overwrite that successor's CAS record.
    if (latest.value.operationId !== owner.record.value.operationId) {
      owner.completed = true;
      return;
    }
    owner.record = latest;
    const recoveryDiagnostic = recovered ? this.operationDiagnostic(owner,
      new NexusError('CTX_NATIVE_RECONCILED', '', { traceId: latest.value.traceId }), 'reconciled') : undefined;
    if (latest.value.status !== 'released' || latest.value.phase !== 'context-committed'
        || latest.value.consecutivePreparationFailures || latest.value.auxiliaryRetryAfter || recovered) {
      await this.updateOwner(owner, { status: 'released', phase: 'context-committed',
        consecutivePreparationFailures: 0, auxiliaryRetryAfter: undefined,
        ...(recoveryDiagnostic ? { diagnostics: appendNativeDiagnostic(latest.value,
          { ...recoveryDiagnostic, officialEffect: 'committed' }) } : {}) });
    }
    owner.completed = true;
  }

  private async reconcileOwner(agent: any, previous: StoredRecord<NativeLaneOwner>, lease: Lease): Promise<void> {
    const value = previous.value;
    const owner: LaneLease = { record: previous, retained: false, lease };
    if (beforeOfficialPhase(value.phase)) {
      // No code path invokes the official compactor before the durable
      // official-started CAS. The lease excludes new-protocol live writers;
      // the revision CAS also fences an older writer still awaiting a model.
      // The old model may have been billed: record it as unknown and abandon
      // that operation. Do not replay native/propose or its requestId.
      await this.finishPreparation(owner, new NexusError('CTX_PREPARATION_INTERRUPTED',
        '上一辅助准备未完成；该操作已终止，未执行正式替换', {
          traceId: value.traceId,
        }), true);
      return;
    }
    try {
    if (value.phase === 'official-failed') {
      await this.updateOwner(owner, { status: 'released' });
      return;
    }
    if (value.phase === 'context-committed') {
      await this.updateOwner(owner, { status: 'released' });
      return;
    }
    let hostCompactionId = value.hostCompactionId;
    if (!hostCompactionId && ['official-started', 'official-flushed'].includes(value.phase)) {
      // An active durable record may have survived process exit between the
      // official append and its small owner receipt. Absence in this snapshot
      // never proves that a model call or official operation can be repeated.
      let snapshot: any;
      try { snapshot = await this.nativeContext.get('sessionQuery').readSession(agent.id); }
      catch (error) {
        await this.retainOwner(owner, error);
        throw new NexusError('CTX_NATIVE_RECONCILIATION_REQUIRED', '权威宿主日志不可读，无法确认未完成原生操作的效果', {
          operationId: value.operationId, phase: value.phase, effect: 'unknown',
        });
      }
      const candidates = snapshot.events.filter((event: any) => {
        if (event.type !== 'compaction/summary' || event.seq <= value.startedThroughSeq
            || typeof event.data?.compactionId !== 'string') return false;
        return Array.isArray(value.sourceSeqs) && typeof value.summaryHash === 'string'
          && hashObject(event.data?.shadowedSeqs) === hashObject(value.sourceSeqs)
          && Array.isArray(event.data?.summary)
          && event.data.summary.every((block: any) => block?.type === 'text' && typeof block.text === 'string')
          && sha256(event.data.summary.map((block: any) => block.text).join('')) === value.summaryHash;
      });
      if (candidates.length === 1) hostCompactionId = candidates[0].data.compactionId;
      const failed = this.failedOfficial(value, snapshot.events);
      if (failed) {
        await this.updateOwner(owner, { hostCompactionId: failed.compactionId, officialStartSeq: failed.startSeq });
        if (value.proposalId) await this.call(agent, 'native/abort', {
          proposalId: value.proposalId, reason: 'CTX_OFFICIAL_SUMMARY_FAILED',
        });
        await this.finishOfficialFailure(agent, owner, new NexusError('CTX_OFFICIAL_SUMMARY_FAILED',
          '上一正式摘要事务已失败结束，未替换表层', { traceId: value.traceId }));
        return;
      }
    }
    if (hostCompactionId) {
      const snapshot = await this.nativeContext.get('sessionQuery').readSession(agent.id);
      if (this.failedOfficial(owner.record.value, snapshot.events)) {
        if (value.proposalId) await this.call(agent, 'native/abort', {
          proposalId: value.proposalId, reason: 'CTX_OFFICIAL_SUMMARY_FAILED',
        });
        await this.finishOfficialFailure(agent, owner, new NexusError('CTX_OFFICIAL_SUMMARY_FAILED',
          '上一正式摘要事务已失败结束，未替换表层', { traceId: value.traceId }));
        return;
      }
      // Reconciliation performs only flush/receipt work. In particular it
      // never steals an unknown decision by invoking a model or compactor.
      if (hostCompactionId !== value.hostCompactionId) await this.updateOwner(owner, { hostCompactionId });
      const flushed = await this.nativeContext.get('sessions').flush(agent.session);
      if (flushed !== true) throw new NexusError('SESSION_DURABILITY_UNVERIFIED', '待对账的正式压缩尚无耐久性确认');
      if (value.proposalId) await this.call(agent, 'native/commit', {
        proposalId: value.proposalId, hostCompactionId,
      });
      else await this.call(agent, 'native/import', { hostCompactionId });
      await this.completeOwner(owner, true);
      return;
    }
    const identity = nativeErrorIdentity(new NexusError('CTX_NATIVE_RECONCILIATION_REQUIRED', '', { traceId: value.traceId }));
    throw new NexusError('CTX_NATIVE_RECONCILIATION_REQUIRED', '该 lane 有未完成的原生操作；先恢复收据，不能自动重复正式替换', {
      operationId: value.operationId, phase: value.phase, proposalId: value.proposalId,
      hostCompactionId: value.hostCompactionId, effect: 'unknown-or-pending', officialEffect: 'unknown',
      traceId: identity.traceId,
    });
    } catch (error) {
      await this.retainOwner(owner, error);
      const identity = nativeErrorIdentity(error, 'CTX_NATIVE_OPERATION_FAILED');
      throw new NexusError(identity.code, '正式上下文操作需要对账，未重复执行', {
        ...identity, operationId: value.operationId, phase: owner.record.value.phase,
        officialEffect: 'unknown', proposalId: value.proposalId, hostCompactionId: owner.record.value.hostCompactionId,
      });
    }
  }

  private async withLane<T>(
    agent: any, kind: NativeLaneOwner['kind'], run: (owner: LaneLease) => Promise<T>,
    signal?: AbortSignal, automatic = false,
  ): Promise<T> {
    const key = this.laneKey(agent);
    const services = this.nativeContext.get('nexus').services;
    const runningKey = `${path.resolve(services.dataDir)}\0${key}`;
    if (this.runningLanes.has(runningKey)) throw new NexusError('CTX_NATIVE_BUSY', '同一上下文 lane 已有原生操作正在执行');
    const operationId = randomUUID();
    this.runningLanes.set(runningKey, operationId);
    try {
      this.laneLeases ??= createLeaseManager(path.join(services.dataDir, 'native-compaction-v1', 'leases'),
        { lockTimeoutMs: 2_000 });
      return await this.laneLeases.withLease(key, async lease => {
        return this.withOwnedLane(agent, key, operationId, kind, run, lease, automatic);
      }, signal);
    } finally { this.runningLanes.delete(runningKey); }
  }

  private async withOwnedLane<T>(
    agent: any, key: string, operationId: string, kind: NativeLaneOwner['kind'],
    run: (owner: LaneLease) => Promise<T>, lease: Lease, automatic: boolean,
  ): Promise<T> {
      const store = this.nativeContext.get('nexus').services.store;
      let previous = await store.get(NATIVE_OWNER_COLLECTION, key) as StoredRecord<NativeLaneOwner> | undefined;
      if (previous && previous.value.status !== 'released') {
        await this.reconcileOwner(agent, previous, lease);
        previous = await store.get(NATIVE_OWNER_COLLECTION, key);
      }
      if (previous && previous.value.status !== 'released') {
        throw new NexusError('CTX_NATIVE_BUSY', '原生收据对账期间另一操作已取得该 lane');
      }
      if (automatic && previous?.value.auxiliaryRetryAfter
          && Date.parse(previous.value.auxiliaryRetryAfter) > Date.now()) {
        // All automatic callers use a nullable result. Manual/overflow calls
        // bypass this admission suppression, never the reconciliation rules.
        return null as T;
      }
      const now = new Date().toISOString();
      await lease.assertOwned();
      const record = await store.put(NATIVE_OWNER_COLLECTION, key, {
        schemaVersion: 1, sessionKey: key, sessionId: agent.id, operationId, status: 'active', phase: 'preparing',
        kind, startedThroughSeq: agent.session.seq - 1, startedAt: now, updatedAt: now, leaseProtocol: 1,
        diagnostics: (previous?.value.diagnostics ?? []).slice(-16),
        consecutivePreparationFailures: previous?.value.consecutivePreparationFailures ?? 0,
        ...(previous?.value.auxiliaryRetryAfter ? { auxiliaryRetryAfter: previous.value.auxiliaryRetryAfter } : {}),
      } satisfies NativeLaneOwner, previous?.revision ?? 0);
      const owner: LaneLease = { record, retained: false, lease };
      try { return await run(owner); }
      catch (error) {
        if (owner.completed) throw error;
        if (beforeOfficialPhase(owner.record.value.phase)) {
          let diagnostic = this.operationDiagnostic(owner, error, 'failed-before-official');
          let diagnosticPersisted = false;
          try {
            diagnostic = await this.finishPreparation(owner, error);
            diagnosticPersisted = true;
          } catch {
            // A failed store may leave the prior preparation owner active.
            // Its phase remains recoverable under the next lease + CAS.
            owner.retained = true;
          }
          throw new NexusError(diagnostic.code, isNexusError(error) ? error.message : '辅助准备未完成，未执行正式替换', {
            operationId, traceId: diagnostic.traceId, nativePhase: diagnostic.phase,
            officialEffect: 'not-started', auxiliaryEffect: diagnostic.auxiliaryEffect, diagnosticPersisted,
            ...(isNexusError(error) && error.code === 'CTX_NATIVE_NO_PROGRESS' ? { validation: error.details } : {}),
          });
        } else {
          await this.retainOwner(owner, error);
          const identity = nativeErrorIdentity(error, 'CTX_NATIVE_OPERATION_FAILED');
          throw new NexusError(identity.code, '正式上下文操作需要核验，未重复执行', {
            ...identity, operationId, phase: owner.record.value.phase, officialEffect: 'unknown',
            proposalId: owner.record.value.proposalId, hostCompactionId: owner.record.value.hostCompactionId,
          });
        }
      } finally {
        if (!owner.retained && !owner.completed) {
          try { await this.updateOwner(owner, { status: 'released' }); }
          catch (error) {
            await this.retainOwner(owner, error);
            throw new NexusError('PARTIAL_EFFECT', '原生操作已结束，但 lane 收据写入失败；重试前须对账', {
            operationId, proposalId: owner.record.value.proposalId, hostCompactionId: owner.record.value.hostCompactionId,
            officialEffect: beforeOfficialPhase(owner.record.value.phase) ? 'not-started' : 'unknown',
            traceId: nativeErrorIdentity(error).traceId,
            });
          }
        }
      }
  }

  protected override async summarize(input: any, agent: any, signal?: AbortSignal): Promise<any> {
    const owner = this.officialOwners.get(agent);
    if (owner) {
      // The official engine appends start synchronously before entering its sole summary hook.
      let opening: any;
      for (let seq = agent.session.seq - 1; seq > owner.record.value.startedThroughSeq; seq--) {
        const event = agent.session.eventAt(SessionSeq(seq));
        if (event?.type === 'compaction/start') { opening = event; break; }
      }
      if (!opening || typeof opening.data?.compactionId !== 'string') {
        throw new NexusError('CTX_NATIVE_PROOF_MISSING', '正式摘要缺少所属 start 记录，未发送模型请求');
      }
      await this.updateOwner(owner, { hostCompactionId: opening.data.compactionId, officialStartSeq: opening.seq });
    }
    const proposal = this.pendingSummaries.get(agent);
    if (proposal) return { summary: [{ type: 'text', text: proposal.summary }], provider: proposal.provider, model: proposal.model };
    return super.summarize(input, agent, signal);
  }
}
