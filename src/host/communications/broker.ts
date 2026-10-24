import { createHash } from 'node:crypto';
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { AgentMessageSource } from '@deepseek-ai/dsh-subagent';
import { queueHostSubagentPrompt, steerHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal';
import type { NexusStore } from '../../ports/contracts.js';
import type { HostContext } from '../types.js';
import type { AgentDirectory, AgentMail, MailState } from '../../shared/communications.js';
import { agentDirectory, communicationError, pathIdentity, resolveAgent } from './directory.js';
import { realpath } from 'node:fs/promises';
import { isHumanInputMessage } from '../../shared/step-pause.js';

// rc.2 declares this producer on the barrel; MessageSource is actually owned
// by the exported /message submodule. Extend that owning registry as well.
declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap { 'agent-message': AgentMessageSource; }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const timestamp = () => new Date().toISOString();
const sourceId = (message: any): string | undefined => message?.source?.nexusMessageId;
const MAIL_CAPACITY = 2048;
const ACTIVE_CAPACITY = 512, CACHE_CAPACITY = 4096, PUMP_CAPACITY = 32, PUMP_BATCH = 64, WAITER_CAPACITY = 128;
const SETTLED = new Set<MailState>(['consumed', 'discarded', 'failed']);
interface MailIndexEntry {
  senderId: string; targetId: string; createdAt: string; fingerprint: string; state: MailState; revision: number;
}
interface MailIndex { schema: 1; rootId: string; entries: Record<string, MailIndexEntry> }
interface PauseMarker { sessionId: string; paused: boolean; at: number; stopSeq?: number }
export interface SendMail {
  target: string;
  alternateTarget?: string;
  content: Array<{ type: 'text'; text: string }>;
  requestId: string;
  delivery?: 'steer' | 'queue';
  wake?: boolean;
  replyTo?: string;
}
export type MailNotice = { cursor: number; kind: string; agentId?: string; mailId?: string };
export interface MailTransport {
  child(parent: any, targetId: string, content: ContentBlock[], source: any, signal: AbortSignal, delivery: 'steer' | 'queue'): Promise<string>;
  directory?(caller: any, signal: AbortSignal, requestedTarget?: string): Promise<AgentDirectory>;
  direct?(target: any, content: ContentBlock[], source: any, signal: AbortSignal, mail: AgentMail): Promise<string>;
}

/** Durable sender outbox and exact recipient receipts; never starts replacement agents. */
export class AgentMailbox {
  private stop = new AbortController();
  private locks = new Map<string, Promise<unknown>>();
  private active = new Set<Promise<unknown>>();
  private events: MailNotice[] = [];
  private cursor = 0;
  private waiters = new Set<() => void>();
  private roots = new Map<string, string>();
  private paused = new Set<string>();
  private pauseOverflow = false;
  private pumping = new Set<string>();
  private pumpOffsets = new Map<string, number>();
  private nativeReads = new Map<string, Promise<any>>();
  private transport: MailTransport;
  constructor(private ctx: HostContext, private store: NexusStore, transport?: MailTransport) {
    this.transport = transport ?? {
      child: async (parent, id, content, source, signal, delivery) => {
        const runtime = ctx.get('subagents');
        return delivery === 'queue'
          ? queueHostSubagentPrompt(runtime, parent, SessionId(id), content, source, signal)
          : steerHostSubagentPrompt(runtime, parent, SessionId(id), content, source, signal);
      },
    };
  }
  private collection(rootId: string) { return `agent-mail-${digest(rootId).slice(0, 32)}`; }
  private serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (this.active.size >= ACTIVE_CAPACITY) return Promise.reject(communicationError('NX_MAIL_RESOURCE_LIMIT', 'Mailbox operation budget reached; wait for existing calls to settle.'));
    const work = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    this.locks.set(key, work); this.active.add(work);
    void work.finally(() => { if (this.locks.get(key) === work) this.locks.delete(key); this.active.delete(work); }).catch(() => {});
    return work;
  }
  /** Root CAS reservation survives crashes and bounds capacity across mailbox instances. */
  private indexed(rootId: string, change?: (index: MailIndex) => boolean): Promise<MailIndex> {
    return this.serial(`index:${rootId}`, async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const collection = `${this.collection(rootId)}-index`, current = await this.store.get<MailIndex>(collection, 'root');
        let index: MailIndex;
        if (current) {
          index = current.value;
          if (index.schema !== 1 || index.rootId !== rootId || !index.entries || Array.isArray(index.entries)) throw communicationError('NX_MAIL_INDEX_INVALID', 'Mailbox index is invalid; no delivery attempted.');
        } else {
          // One migration of older durable mail. Normal sends/pages/pumps never scan message bodies.
          const rows = await this.store.list<AgentMail>(this.collection(rootId));
          index = { schema: 1, rootId, entries: {} };
          for (const row of rows) {
            if (row.value.rootId !== rootId) throw communicationError('NX_MAIL_INDEX_INVALID', 'Mailbox contains a foreign root identity.');
            index.entries[row.id] = this.indexEntry(row.value, row.revision);
          }
        }
        if (Object.keys(index.entries).length > MAIL_CAPACITY) throw communicationError('NX_MAILBOX_FULL', 'Task mailbox already exceeds its 2048 retained message budget.');
        const changed = change?.(index) ?? false;
        if (current && !changed) return index;
        try { await this.store.put(collection, 'root', index, current?.revision ?? 0); return index; }
        catch (error: any) { if (error?.code !== 'REVISION_CONFLICT') throw error; }
      }
      throw communicationError('NX_MAIL_BUSY', 'Mailbox index changed repeatedly; retry with the same request_id.');
    });
  }
  private indexEntry(mail: AgentMail, revision: number): MailIndexEntry {
    return { senderId: mail.senderId, targetId: mail.targetId, createdAt: mail.createdAt, fingerprint: mail.fingerprint, state: mail.state, revision };
  }
  private async save(mail: AgentMail, revision: number) {
    mail.updatedAt = timestamp();
    const stored = await this.store.put(this.collection(mail.rootId), mail.id, mail, revision);
    try {
      await this.indexed(mail.rootId, index => {
        if ((index.entries[mail.id]?.revision ?? -1) >= stored.revision) return false;
        if (!index.entries[mail.id] && Object.keys(index.entries).length >= MAIL_CAPACITY) throw communicationError('NX_MAILBOX_FULL', 'Mailbox index capacity reached.');
        index.entries[mail.id] = this.indexEntry(stored.value, stored.revision); return true;
      });
    } catch { this.warn('NX_MAIL_INDEX_UPDATE_DEFERRED'); } // The durable mail row remains authoritative.
    this.notice('receipt', mail.targetId, mail.id);
    return stored;
  }
  private notice(kind: string, agentId?: string, mailId?: string) {
    this.events.push({ cursor: ++this.cursor, kind, agentId, mailId });
    if (this.events.length > 512) this.events.shift();
    for (const wake of this.waiters) wake();
  }
  async directory(caller: any, signal: AbortSignal, requestedTarget?: string) {
    const combined = AbortSignal.any([signal, this.stop.signal]);
    const directory = this.transport.directory
      ? await this.transport.directory(caller, combined, requestedTarget)
      : await agentDirectory(this.ctx, caller, combined);
    for (const row of directory.agents) this.roots.set(row.id, directory.rootId);
    // This map is only an event-routing cache, never authorization.
    while (this.roots.size > 4096) this.roots.delete(this.roots.keys().next().value!);
    return directory;
  }
  async list(caller: any, signal: AbortSignal) {
    return { ...(await this.directory(caller, signal)), cursor: this.cursor, mechanism: 'unified-task-mailbox-v1' };
  }
  async send(caller: any, input: SendMail, signal: AbortSignal) {
    signal = AbortSignal.any([signal, this.stop.signal]);
    this.stop.signal.throwIfAborted(); signal.throwIfAborted();
    if (typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 200) throw communicationError('NX_MAIL_INVALID_REQUEST', 'Use a stable request_id of 1–200 characters.');
    if (!Array.isArray(input.content) || !input.content.length || input.content.some(block => !block || block.type !== 'text' || typeof block.text !== 'string')
      || Buffer.byteLength(JSON.stringify(input.content)) > 65536) throw communicationError('NX_MAIL_MESSAGE_LIMIT', 'Messages must contain text and fit 64 KiB.');
    if (input.delivery !== undefined && !['steer', 'queue'].includes(input.delivery)) throw communicationError('NX_MAIL_INVALID_ARGUMENT', 'delivery must be steer or queue.');
    const replyTo = typeof input.replyTo === 'string' ? input.replyTo.trim() || undefined : input.replyTo;
    if (replyTo !== undefined && !/^mail_[a-f0-9]{64}$/.test(replyTo)) throw communicationError('NX_MAIL_REPLY_DENIED',
      'No message was sent. For a NEW message omit reply_to or use "". For a reply, call read_agent_messages and copy the received message_id (mail_ followed by 64 hexadecimal characters), targeting its sender. Never use request_id, an agent id, parent or lead as reply_to. Correct the arguments and retry with the same request_id.');
    if (input.wake !== undefined && typeof input.wake !== 'boolean') throw communicationError('NX_MAIL_INVALID_ARGUMENT', 'wake must be boolean.');
    const directory = await this.directory(caller, signal, input.target), target = resolveAgent(directory, input.target, input.alternateTarget);
    if (target.id === caller.id) throw communicationError('NX_MAIL_SELF_MESSAGE', 'Send to another agent; this operation does not steer yourself.');
    const id = `mail_${digest([directory.rootId, caller.id, input.requestId])}`;
    const fingerprint = digest([caller.id, target.id, input.content, input.delivery ?? 'steer', replyTo ?? null,
      ...(input.wake === undefined ? [] : [input.wake])]);
    return this.serial(id, async () => {
      signal.throwIfAborted();
      const old = await this.store.get<AgentMail>(this.collection(directory.rootId), id);
      if (old) {
        if (old.value.fingerprint !== fingerprint) throw communicationError('NX_MAIL_REQUEST_CONFLICT', 'request_id already names different content, recipient, or delivery. Inspect its receipt.');
        return this.reconcile(old.value, old.revision, signal);
      }
      if (!target.addressable) throw communicationError('NX_MAIL_NOT_RESUMABLE', 'Target is one-shot, external, unknown, or outside the authorized workspace. No replacement was created.');
      if (replyTo) {
        const reply = await this.store.get<AgentMail>(this.collection(directory.rootId), replyTo);
        if (!reply || reply.value.targetId !== caller.id || reply.value.senderId !== target.id) throw communicationError('NX_MAIL_REPLY_DENIED',
          'No message was sent. reply_to must identify a message you received from the target agent. Call read_agent_messages and copy that message_id and sender_id; for a new update omit reply_to or use "". Retry corrected arguments with the same request_id.');
      }
      const mail: AgentMail = {
        id, rootId: directory.rootId, workspaceRoot: directory.workspaceRoot, senderId: caller.id, targetId: target.id,
        requestId: input.requestId, fingerprint, content: structuredClone(input.content), delivery: input.delivery ?? 'steer',
        ...(input.wake === undefined ? {} : { wake: input.wake }),
        ...(replyTo ? { replyTo } : {}), state: 'queued', createdAt: timestamp(), updatedAt: timestamp(),
      };
      // Durable outbox acceptance precedes any recipient effect.
      await this.indexed(directory.rootId, index => {
        const existing = index.entries[id];
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw communicationError('NX_MAIL_REQUEST_CONFLICT', 'request_id reservation names a different message.');
          return false;
        }
        if (Object.keys(index.entries).length >= MAIL_CAPACITY) throw communicationError('NX_MAILBOX_FULL', 'Task mailbox reached 2048 retained messages. No delivery attempted; archive this task before further messaging.');
        index.entries[id] = this.indexEntry(mail, 0); return true;
      });
      try {
        const saved = await this.save(mail, 0);
        return await this.deliver(directory, mail, saved.revision, signal);
      } catch (error: any) {
        if (error?.code !== 'REVISION_CONFLICT') throw error;
        const concurrent = await this.store.get<AgentMail>(this.collection(directory.rootId), id);
        if (!concurrent || concurrent.value.fingerprint !== fingerprint) throw error;
        return this.reconcile(concurrent.value, concurrent.revision, signal);
      }
    });
  }
  /** rc.2 readSession has one argument and cannot cancel its underlying read. */
  private async sessionSnapshot(id: string, signal: AbortSignal): Promise<any> {
    const query = this.ctx.get('sessionQuery');
    if (!query?.readSession) throw communicationError('NX_MAIL_CAPABILITY_UNAVAILABLE', 'Session query is required to respect user stop and reconcile receipts.');
    const combined = AbortSignal.any([signal, this.stop.signal, AbortSignal.timeout(30000)]);
    combined.throwIfAborted();
    let reading = this.nativeReads.get(id);
    if (!reading) {
      if (this.nativeReads.size >= 64) throw communicationError('NX_MAIL_RESOURCE_LIMIT', 'Native session observation budget reached; wait for outstanding reads.');
      reading = Promise.resolve().then(() => query.readSession(SessionId(id)));
      this.nativeReads.set(id, reading);
      const pending = reading;
      void pending.finally(() => { if (this.nativeReads.get(id) === pending) this.nativeReads.delete(id); }).catch(() => {});
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: any) => {
        if (settled) return; settled = true; combined.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(combined.reason ?? new Error('Session observation cancelled'));
      combined.addEventListener('abort', abort, { once: true });
      void reading!.then(value => finish(undefined, value), error => finish(error));
      if (combined.aborted) abort();
    });
  }
  private async stoppedByHuman(id: string, signal: AbortSignal): Promise<boolean> {
    if (this.pauseOverflow) throw communicationError('NX_MAIL_PAUSE_LIMIT', 'User-stop tracking budget reached; no target was woken. Reload after reviewing stopped sessions.');
    if (this.paused.has(id)) return true;
    const marker = await this.store.get<PauseMarker>('agent-mail-controls', digest(id));
    const snapshot = await this.sessionSnapshot(id, signal);
    signal.throwIfAborted();
    const own = snapshot.events.slice(Number(snapshot.inheritedEventCount) || 0);
    const human = (event: any) => event.type === 'user/message' && isHumanInputMessage(event.data)
      || event.type === 'agent/inbox/spliced' && event.data?.inserted?.some(isHumanInputMessage);
    // Canceled inbox removal alone does not distinguish user from ancestor cancellation.
    const lastStop = own.findLast((event: any) => event.type === 'turn/end' && event.data?.reason?.kind === 'aborted' && event.data.reason.reason?.kind === 'user');
    if (lastStop && !own.some((event: any) => event.seq > lastStop.seq && human(event))) return true;
    if (marker?.value.paused) {
      return !own.some((event: any) => human(event) && (marker.value.stopSeq !== undefined
        ? event.seq > marker.value.stopSeq : Number(event.time) > marker.value.at));
    }
    return false;
  }
  /** Cold resume must obey the same human-stop evidence as an admitted send. */
  async beforeResume(caller: any, targetId: string, signal: AbortSignal) {
    const directory = await this.directory(caller, signal, targetId);
    resolveAgent(directory, targetId);
    const root = directory.kind === 'cross-session' ? caller.id : directory.rootId;
    if (await this.stoppedByHuman(root, signal) || await this.stoppedByHuman(targetId, signal)) {
      throw communicationError('NX_MAIL_USER_STOPPED', 'A human must resume the stopped session; no cold resume or message delivery was attempted.');
    }
  }
  private async deliver(directory: AgentDirectory, mail: AgentMail, revision: number, signal: AbortSignal) {
    try {
      return await this.dispatch(directory, mail, revision, signal);
    } catch (error) {
      if (signal.aborted || this.stop.signal.aborted) {
        // A cancellation before the durable dispatch boundary must not leave
        // a queued row for a later activity pump with an unrelated signal.
        const current = await this.store.get<AgentMail>(this.collection(mail.rootId), mail.id);
        if (current && ['queued', 'held'].includes(current.value.state)) {
          current.value.state = 'discarded';
          current.value.code = 'NX_MAIL_SEND_CANCELLED';
          await this.save(current.value, current.revision);
        }
      }
      throw error;
    }
  }
  private async dispatch(directory: AgentDirectory, mail: AgentMail, revision: number, signal: AbortSignal) {
    signal.throwIfAborted();
    const registry = this.ctx.get('agents');
    const target = directory.agents.find(row => row.id === mail.targetId)!;
    const liveTarget = registry.get(mail.targetId);
    // A queued message never wakes a manually stopped agent or a stopped task.
    const stopRoot = directory.kind === 'cross-session' ? mail.senderId : mail.rootId;
    if (await this.stoppedByHuman(stopRoot, signal) || await this.stoppedByHuman(mail.targetId, signal)) {
      mail.state = 'held'; mail.code = 'NX_MAIL_USER_STOPPED'; await this.save(mail, revision); return this.receipt(mail);
    }
    const parent = target.parentId ? registry.get(target.parentId) : undefined;
    if (target.parentId && !parent) {
      mail.state = 'queued'; mail.code = 'NX_MAIL_PARENT_UNAVAILABLE'; await this.save(mail, revision); return this.receipt(mail);
    }
    if (parent && pathIdentity(await realpath(parent.session.header.cwd)) !== pathIdentity(mail.workspaceRoot)) throw communicationError('NX_MAIL_SCOPE_DENIED', 'Recipient owner changed workspace.');
    if (!target.parentId && (!liveTarget || !this.transport.direct && liveTarget !== registry.get(mail.rootId))) throw communicationError('NX_MAIL_TARGET_UNAVAILABLE', 'Task root is not live.');
    const source: AgentMessageSource & { nexusMessageId: string } = {
      kind: 'agent-message', form: 'relay', senderSessionId: SessionId(mail.senderId), nexusMessageId: mail.id,
    };
    const content: ContentBlock[] = [{ type: 'text', text: `Agent ${mail.senderId} → ${mail.targetId}; message ${mail.id}${mail.replyTo ? `; reply to ${mail.replyTo}` : ''}:\n` }, ...mail.content];
    signal.throwIfAborted(); this.stop.signal.throwIfAborted();
    // Crash after this commit is ambiguous until the recipient inbox/log is observed.
    mail.state = 'unknown'; delete mail.code;
    let saved = await this.save(mail, revision);
    let dispatchAttempted = false;
    try {
      // A user may stop the task while the durable unknown boundary is being committed.
      if (this.pauseOverflow || this.paused.has(stopRoot) || this.paused.has(mail.targetId)) {
        mail.state = 'held'; mail.code = 'NX_MAIL_USER_STOPPED'; saved = await this.save(mail, saved.revision); return this.receipt(saved.value);
      }
      const deliverySignal = AbortSignal.any([signal, this.stop.signal]);
      deliverySignal.throwIfAborted();
      if (parent && registry.get(target.parentId!) !== parent
        || !parent && registry.get(this.transport.direct ? target.id : mail.rootId) !== liveTarget) {
        mail.state = 'queued'; mail.code = 'NX_MAIL_PARENT_UNAVAILABLE'; saved = await this.save(mail, saved.revision); return this.receipt(saved.value);
      }
      if (this.transport.direct && directory.kind === 'cross-session') {
        dispatchAttempted = true;
        mail.messageId = await this.transport.direct(liveTarget, content, source, deliverySignal, mail);
      } else if (target.parentId) {
        dispatchAttempted = true;
        mail.messageId = await this.transport.child(parent, mail.targetId, content, source, deliverySignal, mail.delivery);
      } else {
        deliverySignal.throwIfAborted();
        const message = createUserMessage({ content, source });
        dispatchAttempted = true;
        if (mail.delivery === 'queue') liveTarget.followup(message); else liveTarget.steer(message);
        mail.messageId = message.id;
      }
      mail.state = 'accepted';
      saved = await this.save(mail, saved.revision);
    } catch (error) {
      // Never guess whether an adapter that threw had already accepted a message.
      mail.state = !dispatchAttempted && (signal.aborted || this.stop.signal.aborted) ? 'discarded' : 'unknown';
      mail.code = mail.state === 'discarded' ? 'NX_MAIL_SEND_CANCELLED' : 'NX_MAIL_DELIVERY_UNCONFIRMED';
      try { saved = await this.save(mail, saved.revision); } catch { /* Prior durable unknown remains authoritative. */ }
    }
    return this.receipt(saved.value);
  }
  private receipt(mail: AgentMail) {
    return {
      status: SETTLED.has(mail.state) && mail.state === 'failed' ? 'error' : ['queued', 'held', 'unknown', 'discarded'].includes(mail.state) ? 'warning' : 'success',
      state: mail.state, message_id: mail.id, messageId: mail.messageId ?? null,
      sender_id: mail.senderId, target: mail.targetId, request_id: mail.requestId,
      ...(mail.wake === undefined ? {} : { wake: mail.wake }),
      ...(mail.code ? { code: mail.code } : {}),
      summary: mail.state === 'consumed' ? 'Recipient claimed this message; no answer is implied.'
        : mail.state === 'accepted' ? 'Recipient inbox accepted this message; no answer is implied.'
        : mail.state === 'queued' ? 'Outbox accepted this message; recipient delivery is pending.'
        : mail.state === 'held' ? 'Message is held until a human resumes the stopped recipient or task.'
        : mail.state === 'unknown' ? 'Recipient acceptance is unconfirmed; automatic replay is blocked.'
        : `Message is ${mail.state}.`,
      next_actions: mail.state === 'unknown' ? ['Call get_message_status with message_id. Do not resend under a new request_id.']
        : mail.state === 'held' ? ['A human must resume the stopped agent.']
        : mail.state === 'queued' ? ['Keep this message_id; wait for the original recipient owner to become available.']
        : ['Read replies with read_agent_messages or wait_agent.'],
    };
  }
  private async reconcile(mail: AgentMail, revision: number, signal: AbortSignal) {
    if (!['unknown', 'accepted'].includes(mail.state)) return this.receipt(mail);
    try {
      const snapshot = await this.sessionSnapshot(mail.targetId, signal);
      signal.throwIfAborted();
      let inboxId: string | undefined, consumed = false, discarded = false;
      const inboxes: Record<string, any[]> = { 'next-step': [], 'next-turn': [] };
      for (const event of snapshot.events.slice(Number(snapshot.inheritedEventCount) || 0)) {
        if (event.type === 'agent/inbox/spliced') {
          const inbox = inboxes[event.data?.target];
          const removed = inbox?.splice(event.data.start, event.data.removedCount ?? 0, ...(event.data.inserted ?? [])) ?? [];
          if (removed.some((message: any) => sourceId(message) === mail.id)) {
            if (event.data?.outcome === 'canceled') discarded = true; else consumed = true;
          }
          const found = event.data?.inserted?.find((message: any) => sourceId(message) === mail.id);
          if (found) inboxId = found.id;
        } else if (event.type === 'user/message' && sourceId(event.data) === mail.id) { inboxId = event.data.id; consumed = true; }
      }
      if (inboxId) {
        mail.messageId = inboxId; mail.state = consumed ? 'consumed' : discarded ? 'discarded' : 'accepted';
        if (discarded && !consumed) mail.code = 'NX_MAIL_INBOX_DISCARDED'; else delete mail.code;
        await this.save(mail, revision);
      }
    } catch (error) { if (signal.aborted) throw error; /* Unknown remains unknown; read errors never trigger replay. */ }
    return this.receipt(mail);
  }
  async status(caller: any, id: string, signal: AbortSignal) {
    signal = AbortSignal.any([signal, this.stop.signal]);
    if (typeof id !== 'string' || !/^mail_[a-f0-9]{64}$/.test(id)) throw communicationError('NX_MAIL_RECEIPT_NOT_FOUND', 'Provide an exact mailbox message_id.');
    const directory = await this.directory(caller, signal);
    return this.serial(id, async () => {
      const row = await this.store.get<AgentMail>(this.collection(directory.rootId), id);
      if (!row || row.value.senderId !== caller.id && row.value.targetId !== caller.id) throw communicationError('NX_MAIL_RECEIPT_NOT_FOUND', 'No authorized mailbox receipt for this message_id.');
      return this.reconcile(row.value, row.revision, signal);
    });
  }
  /** Retire an owned pending notice after its request ended; never replay or
   * retract a dispatch whose recipient acceptance is already ambiguous. */
  async cancelPending(caller: any, id: string) {
    if (typeof id !== 'string' || !/^mail_[a-f0-9]{64}$/.test(id))
      throw communicationError('NX_MAIL_RECEIPT_NOT_FOUND', 'Provide an exact mailbox message_id.');
    const directory = await this.directory(caller, AbortSignal.timeout(30000));
    return this.serial(id, async () => {
      const current = await this.store.get<AgentMail>(this.collection(directory.rootId), id);
      if (!current || current.value.senderId !== caller.id)
        throw communicationError('NX_MAIL_RECEIPT_NOT_FOUND', 'Only the original sender may retire this pending message.');
      if (['queued', 'held'].includes(current.value.state)) {
        current.value.state = 'discarded';
        current.value.code = 'NX_MAIL_SEND_CANCELLED';
        return this.receipt((await this.save(current.value, current.revision)).value);
      }
      return this.receipt(current.value);
    });
  }
  async read(caller: any, signal: AbortSignal, offset = 0, limit = 30) {
    signal = AbortSignal.any([signal, this.stop.signal]);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAIL_CAPACITY || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw communicationError('NX_MAIL_INVALID_ARGUMENT', 'Mailbox pages use offset 0–2048 and limit 1–100.');
    const directory = await this.directory(caller, signal);
    const index = await this.indexed(directory.rootId);
    const entries = Object.entries(index.entries).filter(([, mail]) => mail.senderId === caller.id || mail.targetId === caller.id)
      .sort(([leftId, left], [rightId, right]) => left.createdAt.localeCompare(right.createdAt) || leftId.localeCompare(rightId));
    const page = await Promise.all(entries.slice(offset, offset + limit).map(([id]) => this.store.get<AgentMail>(this.collection(directory.rootId), id)));
    signal.throwIfAborted();
    const rows = page.filter(row => row && (row.value.senderId === caller.id || row.value.targetId === caller.id)).map(row => row!.value);
    return { messages: rows.map(mail => ({
      ...this.receipt(mail), content: mail.content, reply_to: mail.replyTo ?? null, created_at: mail.createdAt,
    })), offset, next_offset: offset + limit < entries.length ? offset + limit : null, cursor: this.cursor };
  }
  async interrupt(caller: any, rawTarget: string, signal: AbortSignal, alternateTarget?: string) {
    const directory = await this.directory(caller, signal), target = resolveAgent(directory, rawTarget, alternateTarget);
    let descendant = target;
    while (descendant.parentId && descendant.parentId !== caller.id) {
      descendant = directory.agents.find(row => row.id === descendant.parentId)!;
    }
    if (target.id === caller.id || descendant.parentId !== caller.id) throw communicationError('NX_MAIL_CONTROL_DENIED', 'Only an exact ancestor may interrupt a descendant; peers cannot stop one another.');
    const previousStatus = target.status;
    this.ctx.get('subagents').interrupt(SessionId(target.id), { kind: 'ancestor', agent: caller });
    return { accepted: true, previousStatus };
  }
  async wait(caller: any, signal: AbortSignal, after?: number, timeout = 30000) {
    const directory = await this.directory(caller, signal), ids = new Set(directory.agents.map(row => row.id));
    const cursor = after ?? this.cursor;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.cursor) throw communicationError('NX_MAIL_CURSOR_INVALID', 'Cursor belongs to another runtime or is invalid; re-list agents after a restart.');
    const changed = () => this.events.filter(event => event.cursor > cursor && (!event.agentId || ids.has(event.agentId)));
    const result = () => ({ timedOut: false as boolean, cursor: this.cursor, events: changed(), dropped: cursor < (this.events[0]?.cursor ?? 0) - 1 });
    if (changed().length) return result();
    if (this.waiters.size >= WAITER_CAPACITY) throw communicationError('NX_MAIL_RESOURCE_LIMIT', 'Mailbox wait budget reached.');
    if (!Number.isSafeInteger(timeout) || timeout < 10000 || timeout > 3600000) throw communicationError('NX_MAIL_INVALID_ARGUMENT', 'Wait timeout must be 10,000–3,600,000 milliseconds.');
    const combined = AbortSignal.any([signal, this.stop.signal]); combined.throwIfAborted();
    return new Promise<ReturnType<typeof result> & { timedOut: boolean }>((resolve, reject) => {
      const finish = (error?: unknown, timedOut = false) => {
        clearTimeout(timer); this.waiters.delete(wake); combined.removeEventListener('abort', abort);
        error ? reject(error) : resolve({ ...result(), timedOut });
      };
      const wake = () => { if (changed().length) finish(); };
      const abort = () => finish(combined.reason ?? new Error('Mailbox wait cancelled'));
      const timer = setTimeout(() => finish(undefined, true), timeout);
      this.waiters.add(wake); combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) abort();
      wake();
    });
  }
  observed(agent: any, kind: string, message?: any) {
    if (this.stop.signal.aborted) return;
    this.notice(kind, agent.id, sourceId(message));
    const mailId = sourceId(message), rootId = this.roots.get(agent.id);
    if (!mailId || !rootId) return;
    void this.serial(mailId, async () => {
      const row = await this.store.get<AgentMail>(this.collection(rootId), mailId);
      if (!row || row.value.targetId !== agent.id) return;
      const mail = row.value;
      if (mail.state === 'consumed' || mail.state === 'discarded' && kind !== 'consumed') return;
      if (kind === 'consumed') mail.state = 'consumed';
      else if (kind === 'discarded') { mail.state = 'discarded'; mail.code = 'NX_MAIL_INBOX_DISCARDED'; }
      else if (kind === 'accepted' && ['queued', 'held', 'unknown'].includes(mail.state)) mail.state = 'accepted';
      else return;
      mail.messageId = message.id; await this.save(mail, row.revision);
    }).catch(() => this.warn('NX_MAIL_OBSERVER_FAILED'));
  }
  private async persistPause(id: string, paused: boolean, stopSeq?: number) {
    if (this.stop.signal.aborted) return;
    const at = Date.now();
    // Capture before async work: an old stop must not swallow later human input.
    const offset = this.ctx.get('agents')?.get?.(id)?.session?.seq;
    if (stopSeq === undefined && Number.isSafeInteger(offset) && offset >= 0) stopSeq = offset - 1;
    const marker: PauseMarker = { sessionId: id, paused, at, ...(stopSeq === undefined ? {} : { stopSeq }) };
    return this.serial(`pause:${id}`, async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const key = digest(id), old = await this.store.get<PauseMarker>('agent-mail-controls', key);
        if (old && (old.value.at > at || old.value.stopSeq !== undefined && stopSeq !== undefined && old.value.stopSeq > stopSeq)) return;
        try {
          await this.store.put('agent-mail-controls', key, marker, old?.revision ?? 0);
          return;
        } catch (error: any) { if (error?.code !== 'REVISION_CONFLICT') throw error; }
      }
      throw communicationError('NX_MAIL_BUSY', 'Could not persist user-stop marker.');
    }).catch(() => this.warn('NX_MAIL_PAUSE_PERSIST_DEFERRED'));
  }
  pausedByUser(id: string, stopSeq?: number) {
    if (this.stop.signal.aborted) return;
    if (this.paused.size >= CACHE_CAPACITY && !this.paused.has(id)) this.pauseOverflow = true; else this.paused.add(id);
    void this.persistPause(id, true, stopSeq); this.notice('user-stopped', id);
  }
  humanResumed(agent: any) {
    this.paused.delete(agent.id);
    // Pump only after the durable stop marker is released. Otherwise a pump
    // can see the previous paused marker and leave held mail stranded.
    void this.persistPause(agent.id, false).then(() => this.activity(agent));
  }
  activity(agent: any) {
    if (this.stop.signal.aborted) return;
    this.notice('activity', agent.id);
    if (this.pumping.size >= PUMP_CAPACITY || this.active.size >= ACTIVE_CAPACITY) return;
    const cachedRoot = this.roots.get(agent.id);
    const key = cachedRoot ? `root:${cachedRoot}` : `agent:${agent.id}`;
    if (this.pumping.has(key)) return;
    this.pumping.add(key);
    let rootKey: string | undefined;
    const work = (async () => {
      const directory = await this.directory(agent, this.stop.signal);
      const actualKey = `root:${directory.rootId}`;
      if (actualKey !== key) {
        if (this.pumping.has(actualKey)) return;
        this.pumping.delete(key); this.pumping.add(actualKey); rootKey = actualKey;
      }
      const index = await this.indexed(directory.rootId);
      const pending = Object.entries(index.entries).filter(([, mail]) => ['queued', 'held'].includes(mail.state)).map(([id]) => id);
      const offset = (this.pumpOffsets.get(directory.rootId) ?? 0) % Math.max(1, pending.length);
      this.pumpOffsets.set(directory.rootId, offset + PUMP_BATCH);
      while (this.pumpOffsets.size > 256) this.pumpOffsets.delete(this.pumpOffsets.keys().next().value!);
      const batch = [...pending.slice(offset), ...pending.slice(0, offset)].slice(0, PUMP_BATCH);
      const directories = new Map<string, Promise<AgentDirectory>>();
      for (const id of batch) {
        this.stop.signal.throwIfAborted();
        await this.serial(id, async () => {
          const current = await this.store.get<AgentMail>(this.collection(directory.rootId), id);
          if (!current) return; // A reserved but uncommitted admission is never replayed.
          if (!['queued', 'held'].includes(current.value.state)) {
            await this.indexed(directory.rootId, next => {
              if ((next.entries[id]?.revision ?? -1) >= current.revision) return false;
              next.entries[id] = this.indexEntry(current.value, current.revision); return true;
            });
            return;
          }
          const sender = this.ctx.get('agents')?.get?.(current.value.senderId);
          if (!sender) return;
          let freshRead = directories.get(sender.id);
          if (!freshRead) { freshRead = this.directory(sender, this.stop.signal); directories.set(sender.id, freshRead); }
          const fresh = await freshRead;
          const target = fresh.agents.find(item => item.id === current.value.targetId);
          if (target?.addressable && fresh.rootId === current.value.rootId) await this.deliver(fresh, current.value, current.revision, this.stop.signal);
        });
      }
    })();
    this.active.add(work);
    void work.catch(() => { if (!this.stop.signal.aborted) this.warn('NX_MAIL_QUEUE_PUMP_DEFERRED'); })
      .finally(() => { this.pumping.delete(key); if (rootKey) this.pumping.delete(rootKey); this.active.delete(work); });
  }
  private warn(code: string) { try { this.ctx.logger?.warn('Unified agent mailbox observation deferred', code); } catch {} }
  async dispose() {
    this.stop.abort();
    while (this.active.size) await Promise.allSettled([...this.active]);
    this.waiters.clear(); this.roots.clear(); this.paused.clear(); this.pumping.clear(); this.pumpOffsets.clear(); this.events = [];
  }
}
