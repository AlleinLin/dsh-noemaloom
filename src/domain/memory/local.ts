import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { NexusError, type DispatchContext, type JsonRecord, type NexusServices } from '../../ports/contracts.js';
import { assertNoSecret, canRead, digest, memoryId, scopeFor, stableJson, type MemoryRecord } from './types.js';

const allowed = /^[A-Za-z0-9_-]{1,100}$/u;
export class MarkdownMemory {
  readonly root: string;
  private lanes = new Map<string, Promise<unknown>>();
  constructor(private services: NexusServices) { this.root = join(services.dataDir, 'memory'); }
  private file(id: string): string {
    if (!allowed.test(id)) throw new NexusError('INVALID_ID', '记忆 ID 格式无效');
    return join(this.root, 'records', `${id}.md`);
  }
  async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.lanes.set(id, current);
    try { return await current; } finally { if (this.lanes.get(id) === current) this.lanes.delete(id); }
  }
  async read(id: string, root: string, ctx?: DispatchContext): Promise<MemoryRecord> {
    let raw: string;
    try { raw = await readFile(this.file(id), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NexusError('NOT_FOUND', '记忆不存在'); throw error; }
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(raw);
    if (!match) throw new NexusError('REPAIR_REQUIRED', '记忆格式损坏；原文件保持不变');
    let metadata: JsonRecord;
    try { metadata = parse(match[1]) as JsonRecord; }
    catch { throw new NexusError('REPAIR_REQUIRED', '记忆元数据无法解析；原文件保持不变'); }
    if (metadata.schemaVersion !== 1) throw new NexusError('SCHEMA_READONLY', '该记忆版本需要显式迁移', { schemaVersion: metadata.schemaVersion });
    const record = { ...metadata, body: match[2] } as unknown as MemoryRecord;
    if (!canRead(record, root, ctx)) throw new NexusError('ACCESS_DENIED', '当前工作区或主体无权读取该记忆');
    const { revision: _revision, updatedAt: _updatedAt, contentHash: _contentHash, ...semantic } = record;
    if (digest(stableJson(semantic)) !== record.contentHash) {
      Object.defineProperty(record, 'externalChange', { value: true, enumerable: false });
    }
    return record;
  }
  async list(root: string, ctx?: DispatchContext): Promise<{ items: MemoryRecord[]; errors: JsonRecord[] }> {
    await mkdir(join(this.root, 'records'), { recursive: true });
    const files = (await readdir(join(this.root, 'records'))).filter(name => name.endsWith('.md')).sort();
    const items: MemoryRecord[] = [], errors: JsonRecord[] = [];
    for (const file of files) {
      ctx?.signal?.throwIfAborted();
      try { items.push(await this.read(file.slice(0, -3), root, ctx)); }
      catch (error) {
        if ((error as NexusError).code !== 'ACCESS_DENIED') errors.push({ id: file.slice(0, -3), code: (error as NexusError).code ?? 'IO_ERROR', message: (error as Error).message });
      }
    }
    return { items, errors };
  }
  normalize(input: JsonRecord, root: string, ctx?: DispatchContext, current?: MemoryRecord, trustedOrigin?: JsonRecord): MemoryRecord {
    assertNoSecret(input);
    const now = new Date().toISOString();
    const title = String(input.title ?? current?.title ?? '').trim();
    const body = String(input.body ?? current?.body ?? '').replace(/\r\n/gu, '\n');
    if (!title || [...title].length > 160 || !body || [...body].length > 20000) {
      throw new NexusError('INVALID_ARGUMENT', '标题须为 1–160 字符，正文须为 1–20000 字符');
    }
    const base = scopeFor(root, ctx);
    const scope = { ...base, ...(current?.scope ?? {}), ...(input.scope as JsonRecord ?? {}) } as MemoryRecord['scope'];
    if (ctx?.scopeLevel === 'session' && scope.kind !== 'session' || ctx?.scopeLevel === 'global' && (scope.projectId || !['user', 'reusable'].includes(scope.kind))) throw new NexusError('PERMISSION_DENIED', '请到记忆所属层级修改，或在当前层新建');
    if (!['user', 'project', 'session', 'team', 'reusable'].includes(scope.kind) ||
      !['public', 'internal', 'private', 'restricted'].includes(scope.sensitivity) ||
      !['local', 'team', 'git', 'provider'].includes(scope.sharing)) throw new NexusError('INVALID_SCOPE', '记忆作用域、敏感级别或共享方式无效');
    if (scope.projectId && scope.projectId !== base.projectId) throw new NexusError('SCOPE_DENIED', '请求不能扩大到其他项目');
    if (scope.kind === 'user') scope.ownerId = ctx?.actorId ?? 'local-user';
    if (scope.kind === 'session') scope.sessionId = ctx?.sessionId;
    if (scope.kind === 'team' && !ctx?.permissions?.has(`memory.team:${scope.ownerId}`)) throw new NexusError('SCOPE_DENIED', '当前主体没有团队记忆授权');
    if (current && stableJson(scope) !== stableJson(current.scope)) throw new NexusError('SCOPE_CHANGE_REQUIRES_REVIEW', '作用域变更需要独立审核');
    const record = {
      ...current, ...input, schemaVersion: 1, id: current?.id ?? (typeof input.id === 'string' ? input.id : memoryId()),
      revision: (current?.revision ?? 0) + 1, title, body,
      summary: String(input.summary ?? current?.summary ?? '').slice(0, 500),
      scope, track: input.track ?? current?.track ?? 'facts', layer: input.layer ?? current?.layer ?? 'knowledge',
      kind: input.kind ?? current?.kind ?? 'fact', lifecycle: input.lifecycle ?? current?.lifecycle ?? 'current',
      validation: input.validation ?? (current && (body !== current.body || title !== current.title) ? 'unverified' : current?.validation) ?? 'unverified',
      authority: input.authority ?? current?.authority ?? 'candidate',
      confidence: input.confidence ?? current?.confidence ?? 'unknown', importance: input.importance ?? current?.importance ?? 'normal',
      createdAt: current?.createdAt ?? now, updatedAt: now,
      tags: [...new Set((input.tags ?? current?.tags ?? []) as string[])].sort().slice(0, 24),
      evidence: input.evidence ?? current?.evidence ?? [], origin: current?.origin ?? trustedOrigin ?? { kind: 'human', actorId: ctx?.actorId ?? 'local-user', sessionId: ctx?.sessionId, ...(input.origin ? { declaredSource: input.origin, sourceVerified: false } : {}) },
      relations: input.relations ?? current?.relations ?? [], protection: input.protection ?? current?.protection ?? { kind: 'none' },
      sourceRefs: input.sourceRefs ?? current?.sourceRefs ?? [],
    } as MemoryRecord;
    delete record.externalChange;
    if (!['profile', 'facts', 'key', 'project_log', 'daily_log'].includes(record.track) ||
      !['anchor', 'structural', 'knowledge', 'contextual', 'self'].includes(record.layer)) {
      throw new NexusError('INVALID_ARGUMENT', '未知 track 或 layer');
    }
    if (!Array.isArray(record.evidence) || record.evidence.some(item => !item || typeof item !== 'object' || typeof item.type !== 'string') ||
      !Array.isArray(record.relations) || record.relations.some(item => typeof item !== 'string') ||
      !Array.isArray(record.sourceRefs) || record.sourceRefs.some(item => !item || typeof item !== 'object') ||
      record.tags.some(item => typeof item !== 'string') || !record.protection || typeof record.protection.kind !== 'string') {
      throw new NexusError('INVALID_ARGUMENT', '依据、标签、关联、来源或保护信息格式无效');
    }
    if (!['candidate', 'derived', 'canonical'].includes(record.authority)) throw new NexusError('INVALID_ARGUMENT', '记忆权威状态无效');
    if (!['current', 'archived', 'tombstoned', 'superseded'].includes(record.lifecycle)) throw new NexusError('INVALID_ARGUMENT', '记忆生命周期无效');
    if (record.authority === 'canonical' && !ctx?.permissions?.has('memory.canonical')) throw new NexusError('APPROVAL_REQUIRED', '授予 canonical 需要人工显式授权');
    if (['anchor', 'self'].includes(record.layer) && !ctx?.permissions?.has('memory.anchor')) throw new NexusError('APPROVAL_REQUIRED', '写入受保护认知层需要显式授权');
    if (record.evidence.length > 32) throw new NexusError('INVALID_ARGUMENT', '依据超过32项');
    if (record.validFrom && record.validUntil && Date.parse(record.validFrom) > Date.parse(record.validUntil)) throw new NexusError('INVALID_ARGUMENT', '有效时间范围倒置');
    const { revision: _r, updatedAt: _u, contentHash: _h, ...semantics } = record;
    record.contentHash = digest(stableJson(semantics));
    return record;
  }
  async save(input: JsonRecord, root: string, ctx?: DispatchContext, expectedRevision?: number, trustedOrigin?: JsonRecord): Promise<JsonRecord> {
    const id = typeof input.id === 'string' ? input.id : memoryId();
    return this.serial(id, async () => {
      let current: MemoryRecord | undefined;
      try { current = await this.read(id, root, ctx); }
      catch (error) { if ((error as NexusError).code !== 'NOT_FOUND') throw error; }
      if (current && expectedRevision === undefined) throw new NexusError('REVISION_REQUIRED', '更新需要 expectedRevision');
      if (current?.externalChange === true) throw new NexusError('EXTERNAL_CHANGE', '原文件有未经审阅的外部修改；保留原字节，请先预览修复');
      if (current && current.revision !== expectedRevision) throw new NexusError('REVISION_CONFLICT', '记忆已被修改', { expectedRevision, actualRevision: current.revision, draft: input });
      if (current && current.protection.kind !== 'none' && !ctx?.permissions?.has('memory.protected')) throw new NexusError('PROTECTED', '该记忆受保护，需单独授权');
      const record = this.normalize({ ...input, id }, root, ctx, current, trustedOrigin);
      record.id = id;
      if (current && current.contentHash === record.contentHash) return { committed: true, duplicate: true, record: current };
      const target = this.file(id);
      await mkdir(dirname(target), { recursive: true });
      // A journal receipt is product transaction state, never a profile/deployment backup.
      const transactionId = memoryId('txn');
      await this.services.store.put('memory-transactions', transactionId, { id, state: 'prepared', beforeHash: current?.contentHash, afterHash: record.contentHash });
      const { body, ...metadata } = record;
      const text = `---\n${stringify(metadata, { lineWidth: 0, sortMapEntries: true }).trimEnd()}\n---\n${body}`;
      const temp = `${target}.${memoryId('tmp')}.tmp`;
      try {
        if (current) {
          const latest = await this.read(id, root, ctx);
          if (latest.externalChange || latest.revision !== current.revision || latest.contentHash !== current.contentHash || latest.body !== current.body) {
            throw new NexusError('EXTERNAL_CHANGE', '原文件已被外部修改；保留原字节并拒绝覆盖');
          }
        }
        await writeFile(temp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temp, target);
      } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
      const event = { id: memoryId('audit'), recordId: id, actorId: ctx?.actorId ?? 'local-user', beforeHash: current?.contentHash, afterHash: record.contentHash, revision: record.revision, occurredAt: record.updatedAt };
      await mkdir(join(this.root, 'audit'), { recursive: true });
      await writeFile(join(this.root, 'audit', `${event.id}.md`), `---\n${stringify(event)}---\n记忆语义更新\n`, { mode: 0o600 });
      let indexPending = false;
      try {
        await this.services.store.put('memory-index', id, { title: record.title, scope: record.scope, contentHash: record.contentHash, revision: record.revision, track: record.track, lifecycle: record.lifecycle });
        await this.services.store.put('memory-transactions', transactionId, { id, state: 'committed', afterHash: record.contentHash, revision: record.revision });
      } catch { indexPending = true; }
      this.services.emit('memory.changed', { id, revision: record.revision, contentHash: record.contentHash });
      return { committed: true, duplicate: false, record, indexPending, receipt: { state: 'committed', committed: true, recordIds: [id], revisions: [record.revision], indexPending, occurredAt: record.updatedAt } };
    });
  }
}
