import { NexusError, type DispatchContext, type JsonRecord, type NexusRequest, type NexusServices } from '../../ports/contracts.js';
import { digest, newId, now, object, required, safePath, text } from './util.js';

interface Room extends JsonRecord { id: string; ownerSessionId: string; name: string; members: { sessionId: string; role: string; joinedAt: string; lastSeenAt: string }[]; nextSeq: number; dissolvedAt?: string; }
interface Claim extends JsonRecord { id: string; ownerNodeId: string; ownerSessionId: string; resourceKind: string; resource: string; intent: string; leaseExpiresAt: string; source: string; releasedAt?: string; }
export class CollaborationService {
  constructor(private readonly services: NexusServices) {}
  private actor(context: DispatchContext): string { return context.sessionId ?? 'local'; }
  private async changeRoom(id: string, fn: (room: Room) => void): Promise<unknown> {
    for (let i = 0; i < 10; i++) {
      const row = await required<Room>(this.services, 'agent-rooms', id), value = structuredClone(row.value);
      fn(value);
      try { return await this.services.store.put('agent-rooms', id, value, row.revision); }
      catch (error) { if (!(error instanceof NexusError) || error.code !== 'REVISION_CONFLICT') throw error; }
    }
    throw new NexusError('REVISION_CONFLICT', '房间状态竞争');
  }
  async room(request: NexusRequest, context: DispatchContext): Promise<unknown> {
    const p = request.params ?? {}, action = request.action.replace('room/', ''), actor = this.actor(context);
    if (action === 'create') {
      const room: Room = { id: newId('room'), name: text(p.name, 'name', 160), ownerSessionId: actor, members: [{ sessionId: actor, role: 'owner', joinedAt: now(), lastSeenAt: now() }], nextSeq: 1, createdAt: now(), scope: p.scope ?? 'project', projectId: p.projectId };
      return this.services.store.put('agent-rooms', room.id, room, 0);
    }
    if (action === 'list') return (await this.services.store.list<Room>('agent-rooms')).filter(r => !r.value.dissolvedAt && r.value.members.some(m => m.sessionId === actor));
    const id = text(p.roomId ?? request.target?.id, 'roomId', 128);
    const row = await required<Room>(this.services, 'agent-rooms', id), room = row.value;
    const isOwner = room.ownerSessionId === actor;
    const isMember = room.members.some(m => m.sessionId === actor);
    if (!isMember && action !== 'join') throw new NexusError('SCOPE_MISMATCH', '不是此房间成员');
    if (room.dissolvedAt && !['messages', 'read'].includes(action)) throw new NexusError('NOT_FOUND', '房间已解散');
    if (action === 'join') {
      const memberId = typeof p.sessionId === 'string' ? p.sessionId : actor;
      if (memberId !== actor && !isOwner) throw new NexusError('AUTHORIZATION_REQUIRED', '只有房主可以邀请其他会话');
      return this.changeRoom(id, value => { if (!value.members.some(m => m.sessionId === memberId)) value.members.push({ sessionId: memberId, role: 'member', joinedAt: now(), lastSeenAt: now() }); });
    }
    if (action === 'leave' || action === 'kick') {
      if (action === 'kick' && !isOwner) throw new NexusError('AUTHORIZATION_REQUIRED', '只有房主可以移除成员');
      const target = action === 'leave' ? actor : text(p.sessionId, 'sessionId', 128);
      return this.changeRoom(id, value => { value.members = value.members.filter(m => m.sessionId !== target); });
    }
    if (action === 'dissolve') {
      if (!isOwner) throw new NexusError('AUTHORIZATION_REQUIRED', '只有房主可以解散房间');
      return this.changeRoom(id, value => { value.dissolvedAt = now(); });
    }
    if (action === 'presence') {
      await this.changeRoom(id, value => { const member = value.members.find(m => m.sessionId === actor); if (member) member.lastSeenAt = now(); });
      return room.members.map(m => ({ ...m, state: Date.now() - Date.parse(m.lastSeenAt) < 120000 ? 'online' : 'offline', executionConfirmed: false }));
    }
    if (action === 'send') {
      if (!context.permissions?.has('agents:message') && !context.permissions?.has('agents.room/send')) throw new NexusError('AUTHORIZATION_REQUIRED', '房间消息需要任务中明确的发送授权');
      if (typeof p.nodeId !== 'string') throw new NexusError('INVALID_ARGUMENT', '房间消息必须关联 TaskNode');
      const key = typeof p.idempotencyKey === 'string' ? p.idempotencyKey : newId('message-request');
      const messageId = `message-${digest(`${id}:${actor}:${key}`).slice(0, 40)}`;
      const existing = await this.services.store.get('agent-room-messages', messageId);
      if (existing) return existing;
      const body = text(p.body, 'body', 100000), attachments = Array.isArray(p.attachments) ? p.attachments : [];
      if (attachments.some(a => typeof a === 'string' && /^https?:/i.test(a))) throw new NexusError('AUTHORIZATION_REQUIRED', '远端附件必须先经有权限的资源读取登记');
      let seq = 0;
      await this.changeRoom(id, value => { seq = value.nextSeq++; });
      return this.services.store.put('agent-room-messages', messageId, { id: messageId, roomId: id, seq, senderSession: actor, senderAgent: context.actorId ?? 'user', source: 'plugin:dsh-nexus', subject: p.subject ?? '', body, attachments, nodeId: p.nodeId, runId: p.runId, target: p.target ?? 'room', replyTo: p.replyTo, mentions: p.mentions ?? [], delivery: 'accepted', executionConfirmed: false, idempotencyKey: key, acceptedAt: now(), readBy: [] }, 0);
    }
    if (action === 'messages') {
      const after = Number(p.afterSeq ?? 0);
      const messages = (await this.services.store.list<JsonRecord>('agent-room-messages')).filter(r => r.value.roomId === id && Number(r.value.seq) > after && !r.value.deletedAt).sort((a, b) => Number(a.value.seq) - Number(b.value.seq));
      return { items: messages.slice(0, Math.min(100, Number(p.limit ?? 50))), total: messages.length, nextSeq: room.nextSeq };
    }
    if (action === 'read' || action === 'delete') {
      const message = await required<JsonRecord>(this.services, 'agent-room-messages', text(p.messageId, 'messageId', 128));
      if (message.value.roomId !== id) throw new NexusError('SCOPE_MISMATCH', '消息属于其他房间');
      if (action === 'delete' && !isOwner && message.value.senderSession !== actor) throw new NexusError('AUTHORIZATION_REQUIRED', '只能删除自己发送的消息');
      return this.services.store.put('agent-room-messages', message.id, action === 'delete' ? { ...message.value, deletedAt: now() } : { ...message.value, readBy: [...new Set([...(message.value.readBy as string[] ?? []), actor])], readAt: now() }, message.revision);
    }
    throw new NexusError('INVALID_ARGUMENT', '未知 room action');
  }
  async claim(request: NexusRequest, context: DispatchContext): Promise<unknown> {
    const p = request.params ?? {}, action = request.action.replace('claim/', ''), actor = this.actor(context);
    const all = await this.services.store.list<Claim>('agent-claims');
    if (action === 'status') return all.filter(r => !r.value.releasedAt && Date.parse(r.value.leaseExpiresAt) > Date.now());
    if (action === 'release') {
      const row = await required<Claim>(this.services, 'agent-claims', text(p.id, 'id', 128));
      if (row.value.ownerSessionId !== actor) throw new NexusError('SCOPE_MISMATCH', '声明属于其他会话');
      return this.services.store.put('agent-claims', row.id, { ...row.value, releasedAt: now(), releaseReason: p.reason ?? 'explicit-release' }, request.expectedRevision ?? row.revision);
    }
    if (action !== 'declare') throw new NexusError('INVALID_ARGUMENT', '未知 claim action');
    const kind = p.resourceKind === 'service' ? 'service' : 'file';
    const resource = kind === 'file' ? safePath(context.workspaceRoot ?? this.services.workspaceRoot, text(p.resource ?? p.path, 'resource', 4096)) : text(p.resource, 'resource', 256).toLowerCase();
    const ownerNodeId = text(p.nodeId, 'nodeId', 128);
    const duration = Math.min(24 * 60 * 60 * 1000, Math.max(1000, Number(p.leaseMs ?? 300000)));
    const id = newId('claim'), claim: Claim = { id, ownerNodeId, ownerSessionId: actor, resourceKind: kind, resource, intent: String(p.intent ?? 'write'), leaseExpiresAt: new Date(Date.now() + duration).toISOString(), source: p.source === 'observed' ? 'observed' : 'declared', createdAt: now(), runId: p.runId, baseRevision: p.baseRevision };
    const conflicts = all.filter(r => !r.value.releasedAt && Date.parse(r.value.leaseExpiresAt) > Date.now() && r.value.ownerNodeId !== ownerNodeId && (r.value.resource === resource || kind === 'file' && (r.value.resource.startsWith(`${resource}\\`) || resource.startsWith(`${r.value.resource}\\`))) && (r.value.intent !== 'read' || claim.intent !== 'read'));
    if (p.exclusive === true && conflicts.length) throw new NexusError('REVISION_CONFLICT', '独占声明与现有租约冲突', { conflicts: conflicts.map(r => r.value), requested: claim });
    const row = await this.services.store.put('agent-claims', id, claim, 0);
    return { ...row, conflicts, isOsLock: false, nextAction: conflicts.length ? '协调所有者或串行派发；实际写入仍须 CAS' : null };
  }
}
