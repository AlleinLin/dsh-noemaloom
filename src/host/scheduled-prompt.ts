import { createHash } from 'node:crypto';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal';
import { NexusError, type JsonRecord, type NexusServices, type StoredRecord } from '../ports/contracts.js';
import { NEXUS_SOURCE } from './source.js';
import type { HostContext } from './types.js';

interface Delivery extends JsonRecord {
  id: string;
  sessionId: string;
  fingerprint: string;
  state: 'prepared' | 'dispatching' | 'accepted' | 'failed' | 'discarded';
  messageId?: string;
  message?: UserMessage;
  error?: string;
}
const COLLECTION = 'host-scheduled-prompts';
const object = (v: unknown): JsonRecord => v !== null && typeof v === 'object' ? v as JsonRecord : {};
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const code = (e: unknown) => String(object(e).code ?? '');
const messageOf = (event: SessionEvent) => {
  const data = object(event.data);
  return typeof data.role === 'string' ? data : object(data.message);
};

/** Ordinary Web sessions need the API owner's preset and model-selection setup. */
export async function resolveScheduledRoot(ctx: HostContext, sessionId: string): Promise<Agent> {
  const controller = ctx.get('sessionController');
  if (typeof controller?.resolveAgent !== 'function') {
    throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '宿主主会话恢复入口不可用');
  }
  const result = await controller.resolveAgent(SessionId(sessionId));
  if (result?.error) {
    const error = object(result.error);
    throw new NexusError(error.code === 'session/not-found' ? 'SESSION_NOT_FOUND' : 'HOST_CAPABILITY_UNAVAILABLE',
      result.error instanceof Error ? result.error.message : '宿主暂时无法恢复该主会话');
  }
  if (result?.agent?.id !== sessionId) throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '宿主恢复了不同的主会话');
  return result.agent;
}

/**
 * A scheduled user action must wake its exact session. A cold native child is
 * continued by its original parent/runtime, never resumed as an independent
 * root. Dispatch intents survive a crash; ambiguous acceptance is reconciled
 * against the original native source marker, never blindly replayed.
 */
export function createScheduledPromptDelivery(
  ctx: HostContext, signal: AbortSignal, getServices: () => NexusServices,
  findAgent: (id: string) => Agent | undefined,
  resumeRoot: (id: string) => Promise<Agent>,
  read: (id: string) => Promise<{ session: SessionHeader; inheritedEventCount: number; events: SessionEvent[] }>,
  flush: (id: string) => Promise<unknown>,
) {
  const inflight = new Map<string, Promise<JsonRecord>>();
  async function reconcile(row: StoredRecord<Delivery>): Promise<JsonRecord> {
    if (row.value.state === 'failed') return { state: 'failed', accepted: false, durable: false, deliveryError: row.value.error };
    const matches = (m: JsonRecord) => Boolean(row.value.messageId && m.id === row.value.messageId)
      || object(object(m.source).meta).scheduledPromptId === row.id && object(m.source).kind === NEXUS_SOURCE;
    const proof = async () => {
      const snapshot = await read(row.value.sessionId);
      let found: string | undefined, consumed = false, discarded = false;
      const inboxes: Record<string, JsonRecord[]> = { 'next-turn': [], 'next-step': [] };
      for (const event of snapshot.events) {
        if (event.seq < snapshot.inheritedEventCount) continue;
        if (event.type === 'user/message' && matches(messageOf(event))) {
          found = String(messageOf(event).id); consumed = true;
        } else if (event.type === 'agent/inbox/spliced') {
          const data = object(event.data), list = inboxes[String(data.target)];
          if (!list) continue;
          const inserted = Array.isArray(data.inserted) ? data.inserted.map(object) : [];
          const removed = list.splice(Number(data.start), Number(data.removedCount ?? 0), ...inserted);
          for (const m of inserted) if (matches(m)) found = String(m.id);
          if (removed.some(matches)) {
            if (data.outcome === 'canceled') discarded = true;
            else consumed = true;
          }
        }
      }
      return { found, consumed, discarded, pending: Object.values(inboxes).some(list => list.some(matches)) };
    };
    let { found, consumed, discarded, pending } = await proof();
    if (found && (consumed || pending)) {
      await flush(row.value.sessionId);
      // A human cancellation during the persistence await must not become a
      // success receipt for a message removed before the model claimed it.
      ({ found, consumed, discarded, pending } = await proof());
      if (found && (consumed || pending)) {
        if (row.value.state !== 'accepted' || row.value.messageId !== found) {
          await getServices().store.put(COLLECTION, row.id, { ...row.value, state: 'accepted', messageId: found }, row.revision);
        }
        return { state: 'accepted', accepted: true, durable: true, messageId: found, wakesAgent: true,
          evidence: 'official-session-log-and-persistence-barrier', consumed, pending };
      }
    }
    if (discarded || row.value.state === 'discarded') {
      if (row.value.state !== 'discarded') await getServices().store.put(COLLECTION, row.id, { ...row.value, state: 'discarded' }, row.revision);
      return { state: 'failed', accepted: false, durable: false, deliveryError: '宿主已取消这条消息；不会重新发送。' };
    }
    return { state: 'unknown', accepted: false, durable: false, messageId: row.value.messageId,
      deliveryError: '尚未核实宿主是否接收；正在核对原消息，不会重复发送。' };
  }
  async function deliver(params: JsonRecord): Promise<JsonRecord> {
    const { sessionId, requestId, text } = params;
    if (typeof sessionId !== 'string' || !sessionId || typeof requestId !== 'string' || !requestId
      || typeof text !== 'string' || !text.trim()) throw new NexusError('INVALID_ARGUMENT', '延时投递需要会话、正文和固定请求标识');
    const id = `scheduled:${hash({ sessionId, requestId })}`, fingerprint = hash({ sessionId, text });
    let row = await getServices().store.get<Delivery>(COLLECTION, id);
    if (row && row.value.fingerprint !== fingerprint) throw new NexusError('IDEMPOTENCY_CONFLICT', '延时计划标识对应了不同正文');
    if (row && row.value.state !== 'prepared') return reconcile(row);
    // Metadata is sufficient for routing. Do not hydrate a cold child through
    // the generic Agent factory and lose its descriptor/parent ownership.
    const stored = await ctx.get('sessionPersistence')?.stat(SessionId(sessionId), { signal });
    const header = findAgent(sessionId)?.session.header ?? stored?.header;
    if (!header || header.id !== sessionId) throw new NexusError('SESSION_NOT_FOUND', '延时目标会话不存在');
    let parent: Agent | undefined, target: Agent | undefined;
    if (header.origin === 'subagent') {
      if (!header.parentSession) throw new NexusError('NOT_RESUMABLE', '子代理缺少原父会话，无法继续');
      const runtime = ctx.get('subagents');
      if (!runtime?.listChildren) throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '宿主子代理继续入口不可用');
      const child = (await runtime.listChildren(header.parentSession, signal)).find((entry: any) => entry.id === sessionId);
      if (child?.mode !== 'continuable') throw new NexusError('NOT_RESUMABLE', '该子代理不支持继续对话，无法延时发送');
      parent = findAgent(header.parentSession);
      if (!parent) {
        const metadata = await ctx.get('sessionPersistence').stat(header.parentSession, { signal });
        // Loading an ordinary root is safe. A cold *child parent* must first
        // become available through its own native parent; do not fork a tree.
        if (metadata?.header?.origin !== 'subagent' && metadata?.header?.id === header.parentSession) {
          parent = await resumeRoot(header.parentSession);
        }
      }
      if (!parent) return { state: 'waiting', accepted: false, durable: false,
        deliveryError: '等待原父代理可用；打开或继续父会话后会自动投递。' };
    } else target = findAgent(sessionId) ?? await resumeRoot(sessionId);
    signal.throwIfAborted();
    if (!row) row = await getServices().store.put<Delivery>(COLLECTION, id, {
      id, sessionId, fingerprint, state: 'prepared',
    }, 0);
    const source = { kind: NEXUS_SOURCE, meta: { operation: 'scheduled-prompt', requestId, scheduledPromptId: id } };
    const content = [{ type: 'text' as const, text }];
    const message = parent ? undefined : row.value.message ?? createUserMessage({ content, source });
    row = await getServices().store.put<Delivery>(COLLECTION, id, {
      ...row.value, state: 'dispatching', ...(message ? { message, messageId: message.id } : {}),
    }, row.revision);
    // This durable boundary precedes the native call. Anything uncertain after
    // it is observation-only, including process exit before recording a reply.
    try {
      signal.throwIfAborted();
      let messageId: string;
      if (parent) {
        messageId = await queueHostSubagentPrompt(ctx.get('subagents'), parent, SessionId(sessionId), content, source, signal);
      } else {
        target!.followup(message!);
        messageId = message!.id;
      }
      row = await getServices().store.put<Delivery>(COLLECTION, id, { ...row.value, messageId }, row.revision);
      return await reconcile(row);
    } catch (error) {
      // These official runtime errors reject admission before inbox acceptance.
      // Unknown errors (including failures saving the receipt) never replay.
      const permanent = ['NOT_RESUMABLE', 'UNAUTHORIZED', 'INPUT_CLOSED'].includes(code(error));
      const retryable = ['PARENT_UNAVAILABLE', 'ACTIVATION_CLOSING', 'ACTIVATION_LIMIT_REACHED', 'DRAINING', 'CONTINUATION_UNAVAILABLE'].includes(code(error));
      if (permanent || retryable) {
        await getServices().store.put<Delivery>(COLLECTION, id, {
          ...row.value, state: permanent ? 'failed' : 'prepared', error: error instanceof Error ? error.message : String(error),
        }, row.revision);
        if (retryable) return { state: 'waiting', accepted: false, durable: false, deliveryError: '等待宿主子代理继续入口可用后重试。' };
        return { state: 'failed', accepted: false, durable: false, deliveryError: '宿主拒绝继续该子代理；消息未投递。' };
      }
      return reconcile(row);
    }
  }
  return {
    dispatch(params: JsonRecord): Promise<JsonRecord> {
      const key = hash({ sessionId: params.sessionId, requestId: params.requestId });
      const prior = inflight.get(key);
      // Serialize even conflicting duplicate requests, so fingerprint checks
      // still run rather than borrowing a different request's successful reply.
      const pending = (prior ? prior.catch(() => {}) : Promise.resolve()).then(() => deliver(params)).catch(async error => {
        if (['IDEMPOTENCY_CONFLICT', 'INVALID_ARGUMENT'].includes(code(error))) throw error;
        // Read/flush/store failures after the native boundary are ambiguous.
        // Keep cancellation and recovery from treating them as unsent input.
        const row = await getServices().store.get<Delivery>(COLLECTION, `scheduled:${key}`);
        if (row && row.value.state !== 'prepared') return {
          state: 'unknown', accepted: false, durable: false,
          deliveryError: '宿主回执暂不可读；保留原消息核对，不会重复发送。',
        };
        throw error;
      });
      inflight.set(key, pending);
      void pending.finally(() => { if (inflight.get(key) === pending) inflight.delete(key); }).catch(() => {});
      return pending;
    },
    async drain() { await Promise.allSettled([...inflight.values()]); },
  };
}
