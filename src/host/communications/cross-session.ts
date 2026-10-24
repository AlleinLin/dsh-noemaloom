import { realpath } from 'node:fs/promises';
import { relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { AgentMailbox, type SendMail } from './broker.js';
import { communicationError, pathIdentity } from './directory.js';
import type { AgentDirectory } from '../../shared/communications.js';
import type { NexusStore } from '../../ports/contracts.js';
import type { HostContext } from '../types.js';

const namespace = 'nexus-cross-session-mailbox-v1';
const delegationKey = (id: string) => createHash('sha256').update(id).digest('hex');
interface Delegation { ownerId: string; childId: string; ownerCwd: string; childCwd: string }
const contains = (root: string, child: string) => {
  const path = relative(pathIdentity(root), pathIdentity(child));
  return !path || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};

/**
 * An authorized cross-root directory over the existing mailbox protocol.
 * Its scope id is explicitly a mailbox namespace, never a native parent id.
 * No API creates an agent, widens sandbox policy, or confers human authority.
 */
export class CrossSessionMailbox {
  readonly mailbox: AgentMailbox;
  private executions = new Map<string, { fingerprint: string; promise: Promise<any> }>();
  constructor(private ctx: HostContext, private store: NexusStore) {
    this.mailbox = new AgentMailbox(ctx, store, {
      child: async () => { throw communicationError('NX_MAIL_CONTROL_DENIED', 'Cross-session transport cannot claim native child ownership.'); },
      directory: (caller, signal, target) => this.directory(caller, signal, target),
      direct: async (target, content, source, signal, mail) => {
        const sender = ctx.get('agents')?.get?.(mail.senderId);
        // Re-authorize after durable outbox admission. Namespace membership
        // alone never authorizes delivery if a live policy or identity changed.
        const fresh = await this.directory(sender, signal, target.id);
        if (!fresh.agents.some(row => row.id === target.id && row.addressable)
          || ctx.get('agents').get(target.id) !== target) {
          throw communicationError('NX_MAIL_SCOPE_DENIED', 'Cross-session recipient authority changed before delivery.');
        }
        signal.throwIfAborted();
        const message = createUserMessage({ content, source });
        const method = mail.wake === false ? 'inject' : mail.delivery === 'queue' ? 'followup' : 'steer';
        if (typeof target[method] !== 'function') throw communicationError('NX_MAIL_CAPABILITY_UNAVAILABLE', `Recipient cannot honor ${method}.`);
        target[method](message);
        return message.id;
      },
    });
  }
  async recordDelegation(owner: any, child: any, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.directory(owner, signal, child.id);
    const record: Delegation = { ownerId: owner.id, childId: child.id,
      ownerCwd: await realpath(owner.session.header.cwd), childCwd: await realpath(child.session.header.cwd) };
    if (this.ctx.get('agents').get(owner.id) !== owner || this.ctx.get('agents').get(child.id) !== child) {
      throw communicationError('NX_MAIL_SENDER_STALE', 'Delegation identities changed before recording the reply channel.');
    }
    const key = delegationKey(child.id), old = await this.store.get<Delegation>('agent-mail-cross-delegations', key);
    if (old) {
      if (JSON.stringify(old.value) !== JSON.stringify(record)) throw communicationError('NX_MAIL_SCOPE_DENIED', 'This child already has a different cross-session task owner.');
      return;
    }
    await this.store.put('agent-mail-cross-delegations', key, record, 0);
  }
  private async directory(caller: any, signal: AbortSignal, requestedTarget?: string): Promise<AgentDirectory> {
    signal.throwIfAborted();
    const agents = this.ctx.get('agents');
    if (!caller || agents?.get?.(caller.id) !== caller || caller.session !== this.ctx.get('sessions')?.get?.(caller.id)) {
      throw communicationError('NX_MAIL_SENDER_STALE', 'Cross-session mailbox requires the exact live caller and Session.');
    }
    const policy = this.ctx.get('sandboxPolicy')?.resolve?.({ session: caller.session });
    if (!policy || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)) {
      throw communicationError('NX_MAIL_SCOPE_DENIED', 'Cross-session mailbox requires a known current sandbox policy.');
    }
    const workspaceRoot = await realpath(policy.workspaceRoot);
    const delegated = (await this.store.get<Delegation>('agent-mail-cross-delegations', delegationKey(caller.id)))?.value;
    const callerCwd = await realpath(caller.session.header.cwd);
    const live = agents.list?.() ?? [];
    if (live.length > 4096) throw communicationError('NX_MAIL_DIRECTORY_LIMIT', 'Cross-session directory exceeds its 4096 live-agent budget.');
    const rows: AgentDirectory['agents'] = [];
    for (const agent of live) {
      signal.throwIfAborted();
      if (requestedTarget && agent.id !== requestedTarget && agent !== caller) continue;
      const cwd = agent.session?.header?.cwd;
      if (typeof cwd !== 'string' || !cwd) continue;
      const targetRoot = await realpath(cwd).catch(() => undefined);
      const replyOwner = delegated && delegated.childId === caller.id && delegated.ownerId === agent.id
        && pathIdentity(delegated.childCwd) === pathIdentity(callerCwd)
        && targetRoot && pathIdentity(delegated.ownerCwd) === pathIdentity(targetRoot);
      if (!targetRoot || policy.mode !== 'danger-full-access' && !contains(workspaceRoot, targetRoot) && !replyOwner) continue;
      rows.push({
        id: agent.id, target: agent.id, aliases: [], role: 'lead', mode: 'external',
        label: agent.id, status: agent.status === 'running' ? 'running' : 'inactive',
        addressable: true,
      });
    }
    // A cold target can be scope-checked before the original upstream resumes
    // it. This entry is deliberately unaddressable until the native agent lives.
    if (requestedTarget && !rows.some(row => row.id === requestedTarget)) {
      const record = await this.ctx.get('sessionPersistence')?.stat?.(requestedTarget);
      const cwd = record?.header?.cwd;
      const targetRoot = typeof cwd === 'string' ? await realpath(cwd).catch(() => undefined) : undefined;
      const replyOwner = delegated && delegated.childId === caller.id && delegated.ownerId === requestedTarget
        && pathIdentity(delegated.childCwd) === pathIdentity(callerCwd)
        && targetRoot && pathIdentity(delegated.ownerCwd) === pathIdentity(targetRoot);
      if (targetRoot && (policy.mode === 'danger-full-access' || contains(workspaceRoot, targetRoot) || replyOwner)
        && record.header.parentSession === undefined) {
        rows.push({ id: requestedTarget, target: requestedTarget, aliases: [], role: 'lead', mode: 'root',
          label: requestedTarget, status: 'inactive', addressable: false });
      }
    }
    signal.throwIfAborted();
    const current = this.ctx.get('sandboxPolicy')?.resolve?.({ session: caller.session });
    if (agents.get(caller.id) !== caller || this.ctx.get('sessions')?.get?.(caller.id) !== caller.session
      || current?.mode !== policy.mode || typeof current?.workspaceRoot !== 'string'
      || pathIdentity(await realpath(current.workspaceRoot)) !== pathIdentity(workspaceRoot)) {
      throw communicationError('NX_MAIL_SCOPE_DENIED', 'Cross-session caller authority changed during lookup.');
    }
    if (requestedTarget && !rows.some(row => row.id === requestedTarget)) {
      throw communicationError('NX_MAIL_SCOPE_DENIED', 'Recipient is outside the caller’s current canonical workspace boundary.');
    }
    return { kind: 'cross-session', rootId: namespace, workspaceRoot, selfId: caller.id, agents: rows, diagnostics: [] };
  }
  beforeResume(caller: any, targetId: string, signal: AbortSignal) {
    return this.mailbox.beforeResume(caller, targetId, signal);
  }
  authorizeTarget(caller: any, targetId: string, signal: AbortSignal) {
    return this.directory(caller, signal, targetId);
  }
  async authorizeTool(caller: any, args: any, signal: AbortSignal) {
    const directory = await this.directory(caller, signal);
    const policy = this.ctx.get('sandboxPolicy').resolve({ session: caller.session });
    if (args.all_workspaces === true && policy.mode !== 'danger-full-access') {
      throw communicationError('NX_MAIL_SCOPE_DENIED', 'Cross-workspace discovery requires the caller’s current full-access policy.');
    }
    if (args.cwd && policy.mode !== 'danger-full-access' && !contains(directory.workspaceRoot, await realpath(args.cwd))) {
      throw communicationError('NX_MAIL_SCOPE_DENIED', 'Discovery cwd is outside the caller’s canonical workspace boundary.');
    }
  }
  /** A committed unknown execution is never restarted after a transport loss. */
  executeOnce(name: string, caller: any, callId: string, args: unknown, run: () => Promise<any>) {
    const key = createHash('sha256').update(JSON.stringify([caller.id, name, callId])).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify(args)).digest('hex');
    const active = this.executions.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) return Promise.reject(communicationError('NX_MAIL_REQUEST_CONFLICT', 'The active tool call id names different arguments.'));
      return active.promise;
    }
    if (this.executions.size >= 512) return Promise.reject(communicationError('NX_MAIL_RESOURCE_LIMIT', 'Cross-session execution budget reached.'));
    const work = (async () => {
      const old = await this.store.get<any>('agent-mail-cross-executions', key);
      if (old) {
        if (old.value.fingerprint !== fingerprint) throw communicationError('NX_MAIL_REQUEST_CONFLICT', 'The same tool call id names different cross-session arguments.');
        if (old.value.state === 'completed') return old.value.value;
        throw communicationError('NX_MAIL_EXECUTION_UNCONFIRMED', 'The original cross-session mutation is unconfirmed. Inspect its existing session; do not repeat it under a new call id.');
      }
      const reserved = await this.store.put('agent-mail-cross-executions', key, {
        callerId: caller.id, name, callId, fingerprint, state: 'unknown',
      }, 0);
      const value = await run();
      await this.store.put('agent-mail-cross-executions', key, { ...reserved.value, state: 'completed', value }, reserved.revision);
      return value;
    })();
    this.executions.set(key, { fingerprint, promise: work });
    void work.finally(() => this.executions.delete(key)).catch(() => {});
    return work;
  }
  send(caller: any, input: SendMail, signal: AbortSignal) {
    return this.mailbox.send(caller, input, signal);
  }
  cancelPending(caller: any, messageId: string) {
    return this.mailbox.cancelPending(caller, messageId);
  }
  async dispose() { await this.mailbox.dispose(); await Promise.allSettled([...this.executions.values()].map(row => row.promise)); }
}
