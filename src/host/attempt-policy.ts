import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import {
  NexusError, type HostAttemptMetadata, type HostAttemptPolicy, type HostAttemptReceipt,
  type JsonRecord, type ModelRequest,
} from '../ports/contracts.js';
import type { HostContext } from './types.js';
import { classifyFailure, isRecoverableStreamTail } from '../shared/error-codes.js';
import { annotateNativeFailure, nativeErrorIdentity, nativeFailureFacts } from './native-diagnostics.js';

export interface AttemptOwner {
  readonly policy: HostAttemptPolicy;
  readonly controller: AbortController;
  failure?: unknown;
  dispose?: () => Promise<void>;
  disposal?: Promise<void>;
}

interface AgentBinding { agent?: any; owner: AttemptOwner }
interface StepIdentity { turn: number; step: number; logicalCallId: string }
export interface ExplicitAttempt {
  attemptId: string;
  logicalCallId: string;
  role: string;
  owner?: AttemptOwner;
  /** A read-only side request cannot inherit or fail the running main owner. */
  isolated?: boolean;
}

/**
 * The public registry owns runtime parentage. Durable parentSession and ambient
 * caller permissions are deliberately not used as ownership evidence.
 */
export class HostAttemptTracker {
  private readonly bindings = new Map<string, AgentBinding>();
  private readonly steps = new WeakMap<object, StepIdentity>();
  private readonly operation = new AsyncLocalStorage<AttemptOwner>();
  private readonly removers: Array<() => void> = [];

  constructor(private readonly ctx: HostContext,
    private readonly diagnostic?: (options: any, facts: { diagnosticCode: string; phase: string; [key: string]: unknown }) => Promise<void>) {
    const created = ctx.on('agent/created', ({ agent }: any) => {
      const agents = this.ctx.get('agents');
      if (agents?.get?.(agent.id) !== agent) return;
      const reserved = this.bindings.get(agent.id);
      if (reserved && !reserved.agent) { reserved.agent = agent; return; }
      if (reserved?.agent === agent) return;
      if (typeof agents.isOwnedBy !== 'function') return;
      for (const [parentId, binding] of this.bindings) {
        if (binding.agent && agents.get(parentId) === binding.agent && agents.isOwnedBy(agent.id, binding.agent)) {
          this.bindings.set(agent.id, { agent, owner: binding.owner });
          return;
        }
      }
    });
    const disposed = ctx.on('agent/disposed', ({ agent }: any) => {
      if (this.bindings.get(agent.id)?.agent === agent) this.bindings.delete(agent.id);
      this.steps.delete(agent);
    });
    const request = ctx.on('agent/request', async ({ agent, turn, step }: any, next: () => Promise<any>) => {
      const prior = this.steps.get(agent);
      if (!prior || prior.turn !== turn || prior.step !== step) {
        this.steps.set(agent, { turn, step, logicalCallId: `host-call:${agent.id}:${turn}:${step}:${randomUUID()}` });
      }
      return next();
    });
    for (const remove of [created, disposed, request]) if (typeof remove === 'function') this.removers.push(remove);
  }

  private liveBinding(agent: any): AttemptOwner | undefined {
    if (!agent || this.ctx.get('agents')?.get?.(agent.id) !== agent) return undefined;
    const binding = this.bindings.get(agent.id);
    if (!binding || binding.agent !== agent) return undefined;
    return binding.owner;
  }

  ownerFor(request: ModelRequest, parent?: any): AttemptOwner | undefined {
    const agents = this.ctx.get('agents');
    const initiating = agents?.currentInitiator?.();
    const inherited = request.independentRoute ? undefined
      : this.mergeOwners([this.liveBinding(parent), this.liveBinding(initiating), this.operation.getStore()]);
    const explicit = request.attemptPolicy;
    if (explicit && (explicit.version !== 1 || !explicit.runId || !explicit.nodeId
      || typeof explicit.beforeAttempt !== 'function' || typeof explicit.settleAttempt !== 'function')) {
      throw new NexusError('INVALID_ARGUMENT', 'Host attempt policy 必须提供正式版本、Run/node 和准入/对账回调');
    }
    if (inherited) {
      if (explicit && (explicit.runId !== inherited.policy.runId || explicit.nodeId !== inherited.policy.nodeId)) {
        throw new NexusError('PERMISSION_DENIED', '后代模型操作不能重置所属 Run/node 的预算归属');
      }
      this.assertOpen(inherited);
      return inherited;
    }
    return explicit ? { policy: explicit, controller: new AbortController() } : undefined;
  }

  private mergeOwners(candidates: Array<AttemptOwner | undefined>): AttemptOwner | undefined {
    const present = candidates.filter((value): value is AttemptOwner => value !== undefined);
    const owner = present[0];
    if (owner && present.some(value => value.policy.runId !== owner.policy.runId || value.policy.nodeId !== owner.policy.nodeId)) {
      throw new NexusError('PERMISSION_DENIED', '模型请求的显式目标与当前操作链具有冲突的 Run/node 归属');
    }
    return owner;
  }

  withOwner<T>(owner: AttemptOwner | undefined, operation: () => T): T {
    return owner ? this.operation.run(owner, operation) : operation();
  }

  reserve(childId: string, owner: AttemptOwner | undefined): void {
    if (owner) this.bindings.set(childId, { owner });
  }

  release(childId: string, owner: AttemptOwner | undefined): void {
    if (owner && this.bindings.get(childId)?.owner === owner) this.bindings.delete(childId);
  }

  attach(owner: AttemptOwner | undefined, dispose: () => Promise<void>): void {
    // A descendant shares its root owner's failure and cancellation boundary.
    if (!owner || owner.dispose) return;
    owner.dispose = dispose;
    if (owner.failure !== undefined) this.startDisposal(owner);
  }

  assertOpen(owner: AttemptOwner): void {
    if (owner.failure !== undefined) throw owner.failure;
    owner.controller.signal.throwIfAborted();
  }

  fail(owner: AttemptOwner, error: unknown): void {
    if (owner.failure === undefined) owner.failure = error;
    owner.controller.abort(owner.failure);
    this.startDisposal(owner);
  }

  private startDisposal(owner: AttemptOwner): void {
    if (!owner.dispose || owner.disposal) return;
    // Do not await the owning driver's own quiescence inside its active stream.
    // The activation result boundary below awaits this exact disposal afterward.
    owner.disposal = Promise.resolve().then(() => owner.dispose!());
    void owner.disposal.catch(error => {
      this.ctx.logger?.warn('Nexus attempt owner cleanup failed', error?.code ?? 'INTERNAL');
    });
  }

  async finish(owner: AttemptOwner | undefined): Promise<void> {
    if (owner?.failure === undefined) return;
    if (owner.disposal) await owner.disposal.catch(() => undefined);
    throw owner.failure;
  }

  identity(options: any, explicit?: ExplicitAttempt): { owner?: AttemptOwner; attemptId: string; logicalCallId: string } {
    const agents = this.ctx.get('agents');
    const agent = options.sessionId ? agents?.get?.(options.sessionId) : undefined;
    const initiating = agents?.currentInitiator?.();
    const owner = explicit?.isolated ? explicit.owner
      : this.mergeOwners([explicit?.owner, this.liveBinding(initiating), this.operation.getStore(), this.liveBinding(agent)]);
    const step = agent && !options.purpose && isAgentLoopRequest(options) ? this.steps.get(agent) : undefined;
    return {
      owner,
      attemptId: explicit?.attemptId ?? `attempt_${randomUUID()}`,
      logicalCallId: explicit?.logicalCallId ?? step?.logicalCallId ?? `host-call:${options.sessionId ?? 'aux'}:${options.purpose ?? 'aux'}:${randomUUID()}`,
    };
  }

  async *observe(
    options: any,
    next: () => AsyncIterable<any>,
    identity: ReturnType<HostAttemptTracker['identity']>,
    settled: (facts: JsonRecord) => Promise<void>,
  ): AsyncGenerator<any> {
    const { owner, attemptId, logicalCallId } = identity;
    const metadata: HostAttemptMetadata = {
      attemptId, logicalCallId, runId: owner?.policy.runId ?? '', nodeId: owner?.policy.nodeId ?? '',
      sessionId: String(options.sessionId ?? 'unscoped'), provider: String(options.provider), model: String(options.model),
      startedAt: new Date().toISOString(),
      inputBytes: Buffer.byteLength(JSON.stringify({
        messages: options.messages, system: options.system, tools: options.tools, toolHistory: options.toolHistory,
      })),
      ...(Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0 ? { maxOutputTokens: options.maxTokens } : {}),
      source: 'llm-runtime-stream', providerHttpAttempts: 'opaque',
    };
    options.signal?.throwIfAborted();
    let admissionWaitMs = 0;
    if (owner) {
      this.assertOpen(owner);
      const admissionStarted = performance.now();
      try { await owner.policy.beforeAttempt(metadata); }
      catch (error) { this.fail(owner, error); throw error; }
      admissionWaitMs = performance.now() - admissionStarted;
    }
    let usage: JsonRecord | undefined;
    let status: HostAttemptReceipt['status'] = 'failed';
    let failure: unknown;
    let terminal = false;
    let successfulTerminal = false;
    let terminalKind: string | undefined;
    let terminalAt: number | undefined;
    const signalAborted = () => Boolean(options.signal?.aborted || owner?.controller.signal.aborted);
    const diagnose = async (code: string, phase: string, error?: unknown) => {
      const details = error === undefined ? {} : classifyFailure(error, { phase, signalAborted: signalAborted() });
      const facts = { ...details, ...nativeFailureFacts(error,
        options.signal?.aborted ? options.signal : owner?.controller.signal.aborted ? owner.controller.signal : options.signal),
        diagnosticCode: code, phase, attemptId, logicalCallId,
        provider: String(options.provider), model: String(options.model), signalAborted: signalAborted(),
        terminalObserved: terminal, ...(terminalKind ? { terminalKind } : {}),
        ...(terminalAt === undefined ? {} : { tailElapsedMs: Math.max(0, performance.now() - terminalAt) }),
        traceId: nativeErrorIdentity(error ?? new Error('observation')).traceId };
      try { this.ctx.logger?.warn('Nexus model recovery diagnostic', facts); } catch { /* Logging is observational. */ }
      try { await this.diagnostic?.(options, facts); } catch { /* Diagnostics never control execution. */ }
    };
    let dispatchStartedAt: string | undefined;
    let firstTextAt: string | undefined;
    let ttftMs: number | undefined;
    let firstReasoningAt: string | undefined;
    let timeToFirstReasoningMs: number | undefined;
    let providerRequestId: string | undefined;
    const execute = <T>(operation: () => T): T => owner ? this.operation.run(owner, operation) : operation();
    let iterator: AsyncIterator<any> | undefined;
    try {
      options.signal?.throwIfAborted();
      if (owner) this.assertOpen(owner);
      const dispatchStarted = performance.now();
      dispatchStartedAt = new Date().toISOString();
      iterator = execute(() => next()[Symbol.asyncIterator]());
      while (true) {
        const chunk = await execute(() => iterator!.next());
        if (chunk.done) break;
        let value = chunk.value;
        if (successfulTerminal && value.type === 'finish') {
          const tail = value.reason?.failure;
          // The official adapter normalizer discards DOMException.name and
          // untyped SDK codes. It can therefore append UNKNOWN after a fully
          // successful terminal. That second terminal cannot invalidate the
          // already completed model response. Keep the unclassified cause in
          // diagnostics; do not relabel it as a proven network failure.
          const opaqueAdapterTail = ['UNKNOWN', 'UNCLASSIFIED_FAILURE'].includes(tail?.code)
            && classifyFailure(tail).diagnosticCode === 'NX_UNKNOWN_FAILURE' && !signalAborted();
          if ((value.reason?.kind === 'error' || value.reason?.kind === 'aborted')
            && (opaqueAdapterTail || isRecoverableStreamTail(tail, { signalAborted: signalAborted() }))) {
            await diagnose('NX_STREAM_TAIL_RECOVERED', 'provider-stream-tail', tail);
            continue;
          }
          // A second successful finish is redundant. Never deliver it twice.
          if (value.reason?.kind === 'stop' || value.reason?.kind === 'tool-calls') continue;
        }
        if (value.type === 'usage') usage = value.usage;
        if (value.type === 'text-delta' && typeof value.text === 'string' && value.text.length > 0 && ttftMs === undefined) {
          ttftMs = performance.now() - dispatchStarted;
          firstTextAt = new Date().toISOString();
        }
        if (value.type === 'reasoning-delta' && typeof value.text === 'string' && value.text.length > 0 && timeToFirstReasoningMs === undefined) {
          timeToFirstReasoningMs = performance.now() - dispatchStarted;
          firstReasoningAt = new Date().toISOString();
        }
        if (value.type === 'finish') {
          terminal = true;
          terminalKind = value.reason.kind;
          terminalAt = performance.now();
          const diagnosticId = value.reason.kind === 'error' || value.reason.kind === 'aborted'
            ? value.reason.failure?.requestId : undefined;
          if (typeof diagnosticId === 'string' && diagnosticId.length > 0) providerRequestId = diagnosticId;
          status = value.reason.kind === 'stop' || value.reason.kind === 'tool-calls'
            ? (usage ? 'reported' : 'unreported') : value.reason.kind === 'aborted' ? 'cancelled' : 'failed';
          successfulTerminal = value.reason.kind === 'stop' || value.reason.kind === 'tool-calls';
          if (value.reason.kind === 'error' || value.reason.kind === 'aborted') {
            const failure = annotateNativeFailure(value.reason.failure, { phase: 'provider-response', signalAborted: signalAborted() });
            value = { ...value, reason: { ...value.reason, failure } };
          }
        }
        yield value;
      }
      if (terminal && (status === 'reported' || status === 'unreported')) status = usage ? 'reported' : 'unreported';
    } catch (error) {
      if (successfulTerminal && isRecoverableStreamTail(error, { signalAborted: signalAborted() })) {
        await diagnose('NX_STREAM_TAIL_RECOVERED', 'provider-stream-tail', error);
      } else {
        failure = error;
        if (signalAborted()) status = 'cancelled';
        const diagnosis = classifyFailure(error, { signalAborted: signalAborted() });
        await diagnose(diagnosis.diagnosticCode, terminal ? 'provider-stream-tail' : 'model-stream-iteration', error);
        // Only a model request that has not reached a terminal may be retried.
        // The native driver records an attempt and makes its same-step retry
        // decision when it receives a released failure chunk. A thrown
        // middleware AbortError would bypass that seam and become UNKNOWN.
        if (!terminal && !signalAborted()
          && (diagnosis.retryable || diagnosis.diagnosticCode === 'NX_ABORT_UNATTRIBUTED')) {
          failure = undefined;
          terminal = true;
          terminalKind = diagnosis.diagnosticCode === 'NX_ABORT_UNATTRIBUTED' ? 'aborted' : 'error';
          terminalAt = performance.now();
          status = terminalKind === 'aborted' ? 'cancelled' : 'failed';
          yield { type: 'finish', reason: {
            kind: terminalKind, failure: annotateNativeFailure(error, { phase: 'model-stream-iteration' }),
          } };
        } else {
          throw error;
        }
      }
    } finally {
      try { if (iterator?.return) await execute(() => iterator!.return!()); }
      catch (error) {
        if (successfulTerminal && isRecoverableStreamTail(error, { signalAborted: signalAborted() })) {
          await diagnose('NX_STREAM_TAIL_RECOVERED', 'provider-iterator-cleanup', error);
        } else if ((terminalKind === 'error' || terminalKind === 'aborted') && !signalAborted()
          && (classifyFailure(error).retryable || classifyFailure(error).diagnosticCode === 'NX_ABORT_UNATTRIBUTED')) {
          // A failure finish has already reached the native retry boundary.
          // A second transport/adapter abort while closing that same request
          // must not replace it with a thrown, unrouteable middleware error.
          await diagnose(classifyFailure(error).diagnosticCode, 'provider-iterator-cleanup', error);
        } else {
          await diagnose(classifyFailure(error).diagnosticCode, 'provider-iterator-cleanup', error);
          if (failure === undefined) failure = error;
        }
      }
      if (!terminal && (options.signal?.aborted || owner?.controller.signal.aborted)) status = 'cancelled';
      const receipt: HostAttemptReceipt = {
        ...metadata, finishedAt: new Date().toISOString(), status, ...(usage ? { usage } : {}), usageRevision: 1,
        admissionWaitMs, ...(dispatchStartedAt ? { dispatchStartedAt } : {}),
        ttftState: ttftMs === undefined ? 'unknown' : 'observed',
        ttftSource: 'llm-runtime-stream:first-nonempty-text-delta',
        ...(ttftMs === undefined ? {} : { ttftMs, firstTextAt }),
        ...(timeToFirstReasoningMs === undefined ? {} : { timeToFirstReasoningMs, firstReasoningAt }),
        ...(providerRequestId ? { providerRequestId, providerRequestIdSource: 'llm-failure.requestId' } : {}),
      };
      let settlementError: unknown;
      // The Run reservation is finalized even if the independent usage ledger
      // is temporarily unavailable. Both receive the same stable attempt IDs.
      try { if (owner) await owner.policy.settleAttempt(receipt); }
      catch (error) { settlementError = error; if (owner) this.fail(owner, error); }
      // Do not await independent bookkeeping at the response commit boundary.
      // Even an observer which ignores its timeout must not hold a completed
      // assistant response (and all its tool calls) hostage. The outbox tracks
      // its own lifetime and retries accounting only, never model/tool work.
      try {
        void Promise.resolve(settled({ ...receipt, completedAt: receipt.finishedAt })).catch(error =>
          diagnose('NX_OBSERVATION_DEFERRED', 'accounting-observation', error));
      } catch (error) {
        void diagnose('NX_OBSERVATION_DEFERRED', 'accounting-observation', error);
      }
      if (owner?.failure !== undefined) throw owner.failure;
      if (failure !== undefined) throw failure;
      if (settlementError !== undefined) throw settlementError;
    }
  }

  dispose(): void {
    for (const remove of this.removers.reverse()) remove();
    this.bindings.clear();
    this.operation.disable();
  }
}
