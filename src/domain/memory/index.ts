import { memorySettings, memorySettingsKeys } from './settings.js';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { NexusError, type Capability, type DispatchContext, type JsonRecord, type NexusModule, type NexusRequest, type NexusServices } from '../../ports/contracts.js';
import { MarkdownMemory } from './local.js';
import { FileMemorySource } from './file-memory.js';
import { MemoryProviders } from './providers.js';
import { CognitionEngine } from './cognition.js';
import { ExternalMemoryEngines } from './external-engines.js';
import { MemorySync } from './sync.js';
import { normalizeLegacyMemory } from './migration.js';
import { cognitionManifest } from './cognition-manifest.js';
import { assertNoSecret, canRead, digest, estimateTokens, memoryId, projectId, stableJson, trustProjection, type MemoryRecord } from './types.js';

const readActions = ['search', 'recall', 'read', 'expand', 'list', 'proposals', 'related', 'status', 'health', 'trust', 'timeline', 'graph', 'entities', 'feedback_history', 'recurrence', 'diagnose', 'audit', 'capabilities', 'sources', 'file_read', 'handoff', 'providers', 'snapshot', 'settings'];
const writeActions = ['propose', 'save', 'commit', 'update', 'archive', 'restore', 'forget', 'protect', 'unprotect', 'verify', 'feedback', 'link', 'review', 'space_manage', 'import', 'sync', 'maintain', 'compile', 'reflect', 'seed', 'configure', 'refresh', 'file_refresh', 'file_writeback', 'capture', 'revoke', 'advanced', 'provider', 'export', 'memsearch', 'code'];
const descriptions: Record<string, string> = {
  search: '统一检索本地 Markdown、项目 MEMORY.md / MEMORY/ 及已启用空间',
  handoff: '生成2000 token有界项目接手包，保留原版本与行号',
  propose: '保存待审核记忆提案，不自动赋予可信或 canonical 权威',
  advanced: '按需调用38组完整高级认知能力；不接受自报权限字段',
  capture: '幂等捕获一个已完成回合，五轨日志与候选共用来源身份',
  snapshot: '读取会话固定的记忆快照，不因后台更新重写历史前缀',
  providers: '查看9个复用Provider能力、空间与具体配置状态',
};
function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && 'ok' in value && 'data' in value) return (value as JsonRecord).data;
  return value;
}
interface Proposal { id: string; reviewRevision: number; state: string; record: JsonRecord; producer: string; reviewer?: string; createdAt: string; decision?: string; }
const inTrack = (record: MemoryRecord, track: unknown): boolean => !track || record.track === track ||
  track === 'daily_log' && record.track === 'project_log' && record.origin.kind === 'capture';
const inScope = (record: MemoryRecord, scope: unknown): boolean => !scope || scope === 'all' ||
  (scope === 'personal' ? record.scope.kind === 'user' : scope === 'branch' ? record.scope.branchSelector?.mode === 'include' :
    scope === 'path' ? Boolean(record.scope.pathSelector?.length) : record.scope.kind === scope);

export function createMemoryModule(services: NexusServices): NexusModule {
  const local = new MarkdownMemory(services);
  const files = new FileMemorySource(services);
  const providers = new MemoryProviders(services);
  const cognition = new CognitionEngine(services);
  const external = new ExternalMemoryEngines(services);
  const sync = new MemorySync(services, local);
  const recallLanes = new Map<string, Promise<unknown>>();
  async function authorizedSave(input: JsonRecord, root: string, ctx?: DispatchContext, revision?: number): Promise<JsonRecord> {
    let current: MemoryRecord | undefined;
    if (typeof input.id === 'string') {
      try { current = await local.read(input.id, root, ctx); } catch (error) { if ((error as NexusError).code !== 'NOT_FOUND') throw error; }
    }
    const grants = new Set(ctx?.permissions);
    const requestGrant = async (permission: string) => {
      if (grants.has(permission)) return;
      if (!await services.host.approve(permission, String(input.id ?? input.title ?? 'new-memory'), { sessionId: ctx?.sessionId, expectedRevision: revision })) throw new NexusError('APPROVAL_REQUIRED', '此记忆保护属性需要独立人工授权', { permission });
      grants.add(permission);
    };
    if (current?.protection.kind !== undefined && current.protection.kind !== 'none' ||
      input.protection && (input.protection as JsonRecord).kind !== 'none') await requestGrant('memory.protected');
    if ((input.authority ?? current?.authority) === 'canonical') await requestGrant('memory.canonical');
    if (['anchor', 'self'].includes(String(input.layer ?? current?.layer ?? ''))) await requestGrant('memory.anchor');
    if (input.validation === 'verified') {
      if (!Array.isArray(input.evidence) || !input.evidence.length) throw new NexusError('EVIDENCE_REQUIRED', '标记已验证必须附可检查依据');
      if (current && current.origin.actorId === ctx?.actorId && ctx?.actorId !== 'local-user') throw new NexusError('INDEPENDENT_REVIEW_REQUIRED', '作者不能自行标记独立验证');
      await requestGrant('memory.verify');
    }
    return local.save(input, root, { ...ctx, permissions: grants }, revision);
  }
  const proposalPath = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,100}$/u.test(id)) throw new NexusError('INVALID_ID', '提案ID无效');
    return join(local.root, 'reviews', `${id}.md`);
  };
  async function saveProposal(proposal: Proposal): Promise<void> {
    assertNoSecret(proposal);
    await mkdir(join(local.root, 'reviews'), { recursive: true });
    await writeFile(proposalPath(proposal.id), `---\n${stringify(proposal, { lineWidth: 0, sortMapEntries: true }).trimEnd()}\n---\n${String(proposal.record.body ?? '')}`, { mode: 0o600 });
  }
  async function loadProposal(id: string): Promise<Proposal> {
    let raw: string;
    try { raw = await readFile(proposalPath(id), 'utf8'); } catch { throw new NexusError('NOT_FOUND', '提案不存在'); }
    const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(raw);
    if (!match) throw new NexusError('REPAIR_REQUIRED', '提案格式损坏');
    return parse(match[1]) as Proposal;
  }
  async function proposals(root: string, ctx?: DispatchContext): Promise<Proposal[]> {
    await mkdir(join(local.root, 'reviews'), { recursive: true });
    const entries = await readdir(join(local.root, 'reviews'));
    const result: Proposal[] = [];
    for (const file of entries.filter(name => name.endsWith('.md')).sort()) {
      const proposal = await loadProposal(file.slice(0, -3));
      if (canRead(proposal.record as unknown as MemoryRecord, root, ctx)) result.push(proposal);
    }
    return result;
  }
  async function search(root: string, params: JsonRecord, ctx?: DispatchContext): Promise<JsonRecord> {
    const query = String(params.query ?? '').toLocaleLowerCase();
    const terms = query.match(/[\p{L}\p{N}_/.-]+/gu) ?? [];
    const limit = Math.min(50, Math.max(1, Number(params.limit ?? 8)));
    const { items: records, errors } = await local.list(root, ctx);
    const branch = typeof params.branch === 'string' ? params.branch : undefined;
    const touched = Array.isArray(params.touchedPaths) ? params.touchedPaths as string[] : [];
    const ordinary: JsonRecord[] = [], negative: JsonRecord[] = [];
    for (const record of records) {
      if (!inScope(record, params.scope)) continue;
      if (!params.includeArchived && record.lifecycle !== 'current') continue;
      if (params.kind && record.kind !== params.kind || !inTrack(record, params.track) || params.layer && record.layer !== params.layer) continue;
      const selector = record.scope.branchSelector;
      if (selector?.mode === 'include' && (!branch || !selector.refs?.includes(branch))) continue;
      if (params.ambient === true && record.scope.pathSelector?.length && !record.scope.pathSelector.some(path => touched.some(item => item === path || item.startsWith(`${path}/`)))) continue;
      const haystack = `${record.title}\n${record.body}\n${record.tags.join(' ')}`.toLocaleLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? Math.max(1, term.length) : 0), 0);
      if (terms.length && score === 0) continue;
      const item: JsonRecord = { id: record.id, revision: record.revision, title: record.title, summary: record.summary || record.body.slice(0, 400), body: record.body, scope: record.scope, kind: record.kind, track: record.track, source: 'local-markdown', score, scoreSemantics: 'keyword-native', trustProjection: trustProjection(record), evidenceRefs: record.evidence, contentHash: record.contentHash, warning: record.kind === 'negative' ? '已失败或否定，不作为推荐方案' : record.kind === 'unresolved' ? '尚未解决，不作为已验证结论' : undefined };
      (['negative', 'unresolved'].includes(record.kind) ? negative : ordinary).push(item);
    }
    const fileResult = await files.search(root, query, limit);
    ordinary.push(...fileResult.items as JsonRecord[]);
    const providerErrors: JsonRecord[] = [];
    if (params.includeProviders === true) {
      const spaces = await services.store.list<JsonRecord>('memory-spaces');
      const calls = spaces.filter(space => space.value.projectId === projectId(root) && space.value.enabled).map(async space => {
        try {
          const output = await providers.call(root, 'search', { spaceId: space.id, query, limit }, ctx) as { results?: JsonRecord[] };
          return (output.results ?? []).map((item, rank) => ({ ...item, id: `${space.id}:${item.id}`, source: String(space.value.providerId), providerSpaceId: space.id, body: item.content, summary: String(item.content ?? '').slice(0, 400), rankScore: 1 / (60 + rank + 1), scoreSemantics: 'provider-native', trustProjection: { trust: 'review_required', reasons: ['外部来源，尚未独立核验'] } }));
        } catch (error) { providerErrors.push({ spaceId: space.id, code: (error as NexusError).code ?? 'PROVIDER_ERROR' }); return []; }
      });
      const results = await Promise.allSettled(calls);
      for (const result of results) if (result.status === 'fulfilled') ordinary.push(...result.value);
    }
    ordinary.sort((a, b) => Number(b.rankScore ?? b.score ?? 0) - Number(a.rankScore ?? a.score ?? 0) || String(a.id).localeCompare(String(b.id)));
    negative.sort((a, b) => Number(b.score) - Number(a.score) || String(a.id).localeCompare(String(b.id)));
    const unique: JsonRecord[] = [], duplicates = new Map<string, JsonRecord>();
    const sourceItems = params.kind ? [...ordinary, ...negative] : [...ordinary.slice(0, limit), ...negative.slice(0, 2)];
    for (const item of sourceItems) {
      const hash = digest(String(item.body ?? '').trim());
      const previous = duplicates.get(hash);
      if (previous) { previous.alsoFrom = [...(previous.alsoFrom as unknown[] ?? []), { id: item.id, source: item.source }]; continue; }
      duplicates.set(hash, item); unique.push(item);
    }
    return { items: unique.slice(0, limit), errors: [...errors, ...providerErrors], sourceCoverage: fileResult.coverage, modeRequested: String(params.mode ?? 'keyword'), modeUsed: params.includeProviders ? 'keyword+provider-rrf' : 'keyword', warnings: params.mode === 'semantic' ? ['本地尚未配置向量引擎，明确降级 keyword'] : [], scoreSemantics: 'per-source-native; fusion rank only', total: unique.length };
  }
  const snapshotKey = (root: string, sessionId: string) => `${projectId(root)}_${digest(sessionId).slice(7, 25)}`;
  async function snapshotCandidate(root: string, ctx: DispatchContext | undefined, epoch: number): Promise<JsonRecord> {
    const records = (await local.list(root, ctx)).items.filter(record => ['profile', 'facts', 'key'].includes(record.track) && record.lifecycle === 'current' && record.authority !== 'candidate' && record.scope.branchSelector?.mode !== 'include').sort((a, b) => a.id.localeCompare(b.id));
    let used = 0;
    const refs: JsonRecord[] = [], parts: string[] = [];
    for (const record of records.slice(0, 25)) {
      const text = `${record.title}\n${record.summary || record.body}`;
      const tokens = estimateTokens(text);
      if (used + tokens > 1200) continue;
      refs.push({ id: record.id, revision: record.revision, contentHash: record.contentHash, binding: 'pinned' });
      parts.push(`[${record.id} r${record.revision}] ${text}`); used += tokens;
    }
    const bytes = parts.join('\n\n').replace(/\r\n/gu, '\n');
    return { memorySnapshotEpoch: epoch, memorySnapshotHash: digest(bytes), bytes, refs, estimatedTokens: used, estimateMethod: 'cjk-0.75-other-0.25', binding: 'pinned' };
  }
  async function snapshot(root: string, ctx?: DispatchContext): Promise<JsonRecord> {
    const key = snapshotKey(root, ctx?.sessionId ?? 'default');
    return local.serial(`snapshot:${key}`, async () => {
      const existing = await services.store.get<JsonRecord>('memory-snapshots', key);
      if (existing) return existing.value;
      const value = await snapshotCandidate(root, ctx, 1);
      await services.store.put('memory-snapshots', key, value, 0);
      return value;
    });
  }
  async function refreshSnapshot(root: string, request: NexusRequest, ctx?: DispatchContext): Promise<JsonRecord> {
    const requestedSession = request.params?.sessionId;
    if (ctx?.sessionId && requestedSession && requestedSession !== ctx.sessionId) throw new NexusError('SOURCE_SCOPE_DENIED', '记忆刷新不能跨越当前会话');
    const sessionId = ctx?.sessionId ?? (typeof requestedSession === 'string' ? requestedSession : '');
    if (!sessionId || !request.requestId) throw new NexusError('INVALID_ARGUMENT', '记忆刷新需要精确 sessionId 和 requestId');
    const key = snapshotKey(root, sessionId);
    return local.serial(`snapshot:${key}`, async () => {
      const intentId = digest(`${root}\0${sessionId}\0${request.requestId}`).slice(7);
      let intent = await services.store.get<JsonRecord>('memory-refresh-intents', intentId);
      if (intent?.value.state === 'committed') return { ...(intent.value.result as JsonRecord), duplicate: true };
      if (!intent) {
        let current = await services.store.get<JsonRecord>('memory-snapshots', key);
        if (!current) {
          current = await services.store.put('memory-snapshots', key, await snapshotCandidate(root, { ...ctx, sessionId }, 1), 0);
        }
        const acceptedKey = digest(`${root}\0${sessionId}`).slice(7);
        const accepted = await services.store.get<JsonRecord>('memory-hook-accepted', acceptedKey);
        const epoch = Math.max(Number(current?.value.memorySnapshotEpoch ?? 0), Number(accepted?.value.memorySnapshotEpoch ?? 0)) + 1;
        const value = await snapshotCandidate(root, { ...ctx, sessionId }, epoch);
        const handoff = await files.handoff(root, '', { ...ctx, sessionId }) as JsonRecord;
        const sections: Array<{ name: string; text: string }> = [];
        let used = 0;
        for (const item of handoff.items as JsonRecord[] ?? []) {
          const locator = (item.reference as JsonRecord | undefined)?.locator as JsonRecord | undefined;
          const text = `[文件记忆 ${locator?.path ?? item.id ?? ''}:${locator?.startLine ?? '?'}-${locator?.endLine ?? '?'}]\n${String(item.body ?? '')}`;
          const cost = estimateTokens(text);
          if (used + cost > 2000) continue;
          sections.push({ name: `file:${item.id ?? sections.length}`, text }); used += cost;
        }
        if (value.bytes && used + estimateTokens(String(value.bytes)) <= 2000) sections.push({ name: 'accepted-memory', text: String(value.bytes) });
        const bytes = sections.map(section => section.text).join('\n\n');
        if (!bytes.trim()) throw new NexusError('EMPTY_SNAPSHOT', '当前没有可追加的记忆，快照代际保持不变');
        const acceptedValue = { sections, bytes, memorySnapshotHash: digest(bytes).slice(7), memorySnapshotEpoch: epoch,
          handoffHash: handoff.contentHash, refs: [...(handoff.items as JsonRecord[] ?? []).map(item => item.reference).filter(Boolean), ...(value.refs as unknown[] ?? [])],
          sourcePolicy: handoff.instructionPolicy, refreshIntentId: intentId };
        intent = await services.store.put('memory-refresh-intents', intentId, { state: 'pending', sessionId,
          snapshot: value, snapshotRevision: current?.revision ?? 0, acceptedKey, acceptedRevision: accepted?.revision ?? 0,
          accepted: acceptedValue, hostRequestId: `memory-refresh:${intentId}` }, 0);
      }
      const pending = intent.value;
      const acceptedValue = pending.accepted as JsonRecord;
      const delivery = await services.host.sessions('memory.refresh', {
        sessionId, requestId: pending.hostRequestId, correlationId: pending.hostRequestId,
        bytes: acceptedValue.bytes, sections: acceptedValue.sections,
        meta: { purpose: 'memory-snapshot', memorySnapshotHash: acceptedValue.memorySnapshotHash,
          memorySnapshotEpoch: acceptedValue.memorySnapshotEpoch, handoffHash: acceptedValue.handoffHash, refs: acceptedValue.refs },
      }) as JsonRecord;
      if (delivery?.accepted !== true || delivery.durable !== true || typeof delivery.messageId !== 'string') {
        throw new NexusError('DELIVERY_UNCONFIRMED', '宿主尚未确认精确记忆消息持久追加；快照代际保持不变', { delivery, intentId });
      }
      const value = pending.snapshot as JsonRecord;
      const current = await services.store.get<JsonRecord>('memory-snapshots', key);
      if (current?.value.refreshIntentId !== intentId) {
        await services.store.put('memory-snapshots', key, { ...value, refreshIntentId: intentId }, Number(pending.snapshotRevision));
      }
      const accepted = await services.store.get<JsonRecord>('memory-hook-accepted', String(pending.acceptedKey));
      if (accepted?.value.refreshIntentId !== intentId) {
        // Loading an inactive official session can publish its initial hook
        // packet before delivering this refresh. Preserve that history and
        // supersede only this initial packet, never a different refresh.
        const initialPacket = accepted && !accepted.value.refreshIntentId &&
          Number(accepted.value.memorySnapshotEpoch) < Number(acceptedValue.memorySnapshotEpoch);
        await services.store.put('memory-hook-accepted', String(pending.acceptedKey), acceptedValue,
          initialPacket ? accepted.revision : Number(pending.acceptedRevision));
      }
      const result = { ...value, appended: true, delivery, deliveredSnapshotHash: acceptedValue.memorySnapshotHash, refreshIntentId: intentId };
      await services.store.put('memory-refresh-intents', intentId, { ...pending, state: 'committed', result }, intent.revision);
      return result;
    });
  }
  async function dispatch(request: NexusRequest, ctx?: DispatchContext): Promise<unknown> {
    const params = request.params ?? {};
    const root = ctx?.workspaceRoot ?? services.workspaceRoot;
    const id = String(request.target?.id ?? params.id ?? '');
    switch (request.action) {
      case 'capabilities': return { items: module.capabilities, cognition: cognitionManifest };
      case 'search': return search(root, { ...params, limit: request.limit ?? params.limit }, ctx);
      case 'recall': {
        const key = `${projectId(root)}/${ctx?.sessionId ?? 'default'}/${String(params.turnId ?? 'explicit')}`;
        const previous = recallLanes.get(key) ?? Promise.resolve();
        const operation = previous.catch(() => undefined).then(async () => {
          const queryHash = digest(stableJson({ query: params.query, filters: params.filters, branch: params.branch }));
          const receiptId = digest(`${key}/${queryHash}`).slice(7);
          const old = await services.store.get<JsonRecord>('memory-recalls', receiptId);
          if (old) return { ...old.value, duplicate: true };
          const budget = await services.store.get<{ queries: string[]; usedTokens: number }>('memory-recall-budgets', digest(key).slice(7));
          if ((budget?.value.queries.length ?? 0) >= 2) throw new NexusError('BUDGET_EXHAUSTED', '本轮记忆召回与一次精化次数已用完');
          const result = await search(root, params, ctx);
          let tokens = budget?.value.usedTokens ?? 0;
          const pack: JsonRecord[] = [], skipped: JsonRecord[] = [];
          const maximum = Math.min(2400, Number(params.budgetTokens ?? 2400));
          for (const item of result.items as JsonRecord[]) {
            const cost = estimateTokens(String(item.body ?? ''));
            if (tokens + cost > maximum) { skipped.push({ id: item.id, reason: 'token_budget' }); continue; }
            tokens += cost; pack.push(item);
          }
          const value = { items: pack, errors: result.errors, estimatedTokens: tokens - (budget?.value.usedTokens ?? 0), sharedUsedTokens: tokens, budgetTokens: maximum, skipped, queryHash, source: 'plugin:@local/dsh-nexus', injected: false };
          await services.store.put('memory-recall-budgets', digest(key).slice(7), { queries: [...(budget?.value.queries ?? []), queryHash], usedTokens: tokens }, budget?.revision);
          await services.store.put('memory-recalls', receiptId, value);
          return value;
        });
        recallLanes.set(key, operation);
        try { return await operation; } finally { if (recallLanes.get(key) === operation) recallLanes.delete(key); }
      }
      case 'list': {
        const result = await local.list(root, ctx);
        const filtered = result.items.filter(record => inScope(record, params.scope) && inTrack(record, params.track) && (!params.lifecycle || record.lifecycle === params.lifecycle));
        const offset = Math.max(0, Number(request.cursor ?? 0)), limit = Math.min(200, request.limit ?? 20);
        return { items: filtered.slice(offset, offset + limit).map(record => ({ ...record, ...(params.track ? { viewTrack: params.track } : {}), trustProjection: trustProjection(record) })), total: filtered.length, nextCursor: offset + limit < filtered.length ? String(offset + limit) : null, errors: result.errors };
      }
      case 'read': case 'expand': {
        const record = await local.read(id, root, ctx);
        if (params.revision && params.revision !== record.revision) throw new NexusError('STALE_CURSOR', '记忆版本已改变，请重新读取', { actualRevision: record.revision });
        const offset = Math.max(0, Number(params.offset ?? 0)), maximum = Math.min(16000, Number(params.maxChars ?? 16000));
        return { ...record, body: record.body.slice(offset, offset + maximum), totalChars: record.body.length, nextOffset: offset + maximum < record.body.length ? offset + maximum : null, truncated: offset + maximum < record.body.length, trustProjection: trustProjection(record) };
      }
      case 'save': case 'commit': case 'update': {
        const record = { ...((params.record ?? params.patch ?? params) as JsonRecord), ...(id ? { id } : {}) };
        if (params.proposalId) return dispatch({ ...request, action: 'review', params: { proposalId: params.proposalId, decision: 'accept' } }, ctx);
        return authorizedSave(record, root, ctx, request.expectedRevision);
      }
      case 'propose': {
        const record = local.normalize((params.record ?? params) as JsonRecord, root, ctx);
        const proposal: Proposal = { id: memoryId('review'), reviewRevision: 1, state: 'pending_review', record, producer: ctx?.actorId ?? 'agent', createdAt: new Date().toISOString() };
        await saveProposal(proposal);
        return { state: 'pending_review', committed: false, proposalId: proposal.id, proposal };
      }
      case 'proposals': return { items: (await proposals(root, ctx)).filter(p => !params.state || p.state === params.state) };
      case 'review': {
        if (!params.proposalId) return { items: await proposals(root, ctx) };
        return local.serial(String(params.proposalId), async () => {
        const proposal = await loadProposal(String(params.proposalId));
        if (!canRead(proposal.record as unknown as MemoryRecord, root, ctx)) throw new NexusError('ACCESS_DENIED', '当前主体无权审核该提案');
        if (proposal.state === 'committed') return { committed: true, duplicate: true, proposal };
        if (proposal.state === 'rejected') throw new NexusError('REVIEW_CLOSED', '已拒绝提案需重新提交后审核');
        if (request.expectedRevision !== undefined && request.expectedRevision !== proposal.reviewRevision) throw new NexusError('REVISION_CONFLICT', '提案已变更，需重新审核');
        if (params.decision === 'edit') {
          proposal.record = local.normalize({ ...proposal.record, ...(params.edits as JsonRecord ?? {}) }, root, ctx, proposal.record as unknown as MemoryRecord);
          assertNoSecret(proposal.record); proposal.reviewRevision++; proposal.state = 'needs_reapproval'; proposal.reviewer = undefined;
          await saveProposal(proposal); return { proposal, committed: false };
        }
        if (params.decision === 'accept' || params.decision === 'merge') {
          const reviewer = ctx?.actorId ?? 'local-user';
          if (proposal.producer === reviewer && reviewer !== 'local-user') throw new NexusError('INDEPENDENT_REVIEW_REQUIRED', '提案者不能自证独立审核');
          if (!await services.host.approve('memory.review.accept', proposal.id, { reviewRevision: proposal.reviewRevision, contentHash: digest(stableJson(proposal.record)) })) throw new NexusError('APPROVAL_REQUIRED', '接受记忆候选需要审核授权');
          let record: JsonRecord = { ...proposal.record, authority: 'derived', validation: 'reviewed' };
          let revision: number | undefined;
          if (params.decision === 'merge') {
            const target = await local.read(String(params.mergeInto), root, ctx); revision = target.revision;
            record = { ...target, body: `${target.body}\n\n${String(proposal.record.body)}`, evidence: [...target.evidence, ...(proposal.record.evidence as unknown[] ?? [])], id: target.id, authority: 'derived', validation: 'reviewed' };
          } else delete (record as JsonRecord).id;
          const outcome = await authorizedSave(record, root, ctx, revision);
          proposal.state = 'committed'; proposal.reviewer = reviewer; proposal.decision = String(params.decision); proposal.reviewRevision++;
          await saveProposal(proposal);
          return { ...outcome, proposalId: proposal.id };
        }
        if (!['reject', 'defer'].includes(String(params.decision))) throw new NexusError('INVALID_DECISION', '审核决定应为 accept/edit/merge/reject/defer');
        proposal.state = params.decision === 'reject' ? 'rejected' : 'deferred'; proposal.decision = String(params.decision); proposal.reviewRevision++;
        await saveProposal(proposal); return { committed: false, proposal };
        });
      }
      case 'archive': case 'restore': case 'forget': case 'protect': case 'unprotect': case 'verify': {
        const current = await local.read(id, root, ctx);
        const patch: JsonRecord = { id };
        if (request.action === 'protect' || request.action === 'unprotect') {
          if (!await services.host.approve(`memory.${request.action}`, id)) throw new NexusError('APPROVAL_REQUIRED', '保护变更需要独立授权');
          patch.protection = { kind: request.action === 'protect' ? 'user_pinned' : 'none', reason: String(params.reason ?? ''), actor: ctx?.actorId ?? 'local-user', at: new Date().toISOString() };
        } else if (request.action === 'verify') {
          if (String(current.origin.actorId ?? '') === ctx?.actorId && ctx.actorId !== 'local-user') throw new NexusError('INDEPENDENT_REVIEW_REQUIRED', '作者不能自行标记独立验证');
          if (!Array.isArray(params.evidence) || !params.evidence.length) throw new NexusError('EVIDENCE_REQUIRED', '验证必须提交可检查依据');
          patch.validation = params.verdict === 'falsify' ? 'invalid' : params.verdict === 'weaken' ? 'doubted' : 'verified';
          patch.evidence = [...current.evidence, ...params.evidence];
        } else patch.lifecycle = request.action === 'archive' ? 'archived' : request.action === 'forget' ? 'tombstoned' : 'current';
        return authorizedSave(patch, root, ctx, request.expectedRevision ?? current.revision);
      }
      case 'feedback': {
        const record = await local.read(id, root, ctx);
        const applicationId = String(params.applicationId ?? '');
        if (!applicationId) throw new NexusError('INVALID_ARGUMENT', '反馈需要 applicationId');
        assertNoSecret(params);
        const key = digest(`${record.id}/${applicationId}`).slice(7);
        const old = await services.store.get('memory-feedback', key);
        if (old) return { committed: true, duplicate: true, feedback: old.value };
        const value = { recordId: id, applicationId, problemKey: params.problemKey ?? record.kind, result: params.result, evidence: params.evidence, scope: record.scope, occurredAt: new Date().toISOString() };
        await services.store.put('memory-feedback', key, value);
        return { committed: true, feedback: value };
      }
      case 'feedback_history': case 'recurrence': {
        const visible = new Set((await local.list(root, ctx)).items.map(record => record.id));
        const items = (await services.store.list<JsonRecord>('memory-feedback')).map(entry => entry.value).filter(item => visible.has(String(item.recordId)) && (!id || item.recordId === id));
        const groups = new Map<string, JsonRecord[]>();
        for (const item of items) { const key = String(item.problemKey); groups.set(key, [...(groups.get(key) ?? []), item]); }
        return request.action === 'feedback_history' ? { items } : { items: [...groups].map(([problemKey, entries]) => ({ problemKey, occurrences: entries.length, evidenceRefs: entries.map(entry => entry.applicationId) })) };
      }
      case 'link': {
        const source = await local.read(String(params.sourceId ?? id), root, ctx);
        const target = await local.read(String(params.targetId), root, ctx);
        if (!['causal', 'semantic', 'temporal', 'entity', 'contradicts', 'depends_on', 'derived_from', 'supersedes'].includes(String(params.type))) throw new NexusError('INVALID_RELATION', '关系类型未知');
        const edge = { id: memoryId('medge'), sourceId: source.id, targetId: target.id, type: params.type, evidence: params.evidence ?? [], hypothesis: params.type === 'causal' && !params.evidence, reason: params.reason, projectId: projectId(root) };
        await mkdir(join(local.root, 'relations'), { recursive: true });
        await writeFile(join(local.root, 'relations', `${edge.id}.md`), `---\n${stringify(edge)}---\n${String(params.reason ?? '')}`, { mode: 0o600 });
        await services.store.put('memory-relations', edge.id, edge);
        return { committed: true, edge };
      }
      case 'related': case 'graph': case 'entities': {
        const records = (await local.list(root, ctx)).items;
        const visible = new Set(records.map(record => record.id));
        const edges = (await services.store.list<JsonRecord>('memory-relations')).map(entry => entry.value).filter(edge => visible.has(String(edge.sourceId)) && visible.has(String(edge.targetId)));
        if (request.action === 'related') { const ids = new Set(edges.filter(edge => edge.sourceId === id || edge.targetId === id).flatMap(edge => [edge.sourceId, edge.targetId])); return { items: records.filter(record => record.id !== id && ids.has(record.id)) }; }
        if (request.action === 'entities') return { items: [...new Set(records.flatMap(record => record.tags))].sort() };
        return { graphKind: 'memory-relations', ownerDomain: 'memory', nodes: records.map(record => ({ id: record.id, title: record.title, kind: record.kind, trustProjection: trustProjection(record) })), edges };
      }
      case 'timeline': {
        const axis = params.timeAxis === 'observed' ? 'observedAt' : 'validFrom';
        return { axis: params.timeAxis === 'observed' ? 'observed' : 'effective', items: (await local.list(root, ctx)).items.map(record => ({ id: record.id, title: record.title, time: record[axis] ?? null, unknown: !record[axis] })).sort((a, b) => String(a.time ?? '').localeCompare(String(b.time ?? ''))) };
      }
      case 'trust': return trustProjection(await local.read(id, root, ctx), params);
      case 'snapshot': return snapshot(root, ctx);
      case 'refresh': return refreshSnapshot(root, request, ctx);
      case 'sources': return { binding: await files.bind(root), documents: await files.documents(root) };
      case 'file_refresh': return files.scan(root, ctx, params);
      case 'file_read': return files.readVersion(root, String(params.documentId ?? id), typeof params.sourceHash === 'string' ? params.sourceHash : undefined, Number(params.offset ?? 0), Number(params.maxChars ?? 16000));
      case 'file_writeback': return files.writeback(root, params, ctx);
      case 'handoff': return files.handoff(root, String(params.query ?? ''), ctx);
      case 'providers': return providers.catalog(root);
      case 'space_manage': return providers.configure(root, params, ctx);
      case 'provider': return providers.call(root, String(params.method ?? 'probe'), params, ctx);
      case 'advanced': return cognition.call(root, { ...params, requestId: request.requestId ? `${request.requestId}:engine-child` : undefined }, ctx);
      case 'memsearch': return external.memsearch(root, params, ctx);
      case 'code': return external.code(root, params, ctx);
      case 'configure': {
        const settingsKey = memorySettingsKeys(root, ctx).at(-1)!;
        const old = await services.store.get<JsonRecord>('memory-settings', settingsKey);
        const allowed = ['cognitionEnabled', 'whiteboxEnabled', 'pythonCommand', 'captureEnabled', 'syncEnabled', 'syncRemote', 'syncBranch', 'autoInject', 'retainSessions', 'strategy', 'memsearchEnabled', 'memsearchCredentialRef', 'memsearchModel', 'memsearchProvider', 'memsearchEndpoint', 'milvusUri', 'codeEnabled', 'codeCommand'];
        const config = Object.fromEntries(Object.entries(params).filter(([key]) => allowed.includes(key)));
        assertNoSecret(config);
        if (params.readMode || params.removeBinding) await files.configure(root, { readMode: params.readMode, remove: params.removeBinding }, ctx);
        const stored = await services.store.put('memory-settings', settingsKey, { ...old?.value, ...config }, old?.revision);
        return { committed: true, revision: stored.revision, config: stored.value };
      }
      case 'settings': return { config: await memorySettings(services, root, ctx) };
      case 'capture': {
        if (params.historicalReplay === true || params.originVerified === false) return { state: 'skipped', reason: 'historical_replay_no_writes', committed: false };
        const originSessionId = String(params.originSessionId ?? ctx?.sessionId ?? ''), originTurnId = String(params.originTurnId ?? params.turnId ?? '');
        if (!originSessionId || !originTurnId) throw new NexusError('SOURCE_ID_REQUIRED', '捕获需要原始 session/turn 身份');
        if (ctx?.sessionId && originSessionId !== ctx.sessionId && !ctx.permissions?.has('memory.capture.origin')) throw new NexusError('SOURCE_SCOPE_DENIED', '跨会话来源捕获需要宿主来源授权');
        const captureKey = `${String(params.hostId ?? 'dsh')}/${originSessionId}/${originTurnId}/1`;
        const captureId = digest(captureKey).slice(7);
        return local.serial(captureId, async () => {
        if (await services.store.get('memory-captures', captureId)) return { duplicate: true, committed: true, captureId };
        const text = String(params.summary ?? params.text ?? '');
        assertNoSecret(text);
        if (!text.trim()) return { state: 'skipped', reason: 'empty_capture', committed: false };
        if (params.status && params.status !== 'completed') return { state: 'skipped', reason: `turn_${String(params.status)}`, committed: false };
        const record = { id: `cap_${captureId}`, title: String(params.title ?? '已完成回合'), body: text, track: 'project_log', kind: 'observation', layer: 'contextual', origin: { kind: 'capture', captureKey, actorId: ctx?.actorId ?? 'local-user', sessionId: originSessionId, turnId: originTurnId }, sourceRefs: [{ captureKey }], authority: 'derived' };
        let recovered: MemoryRecord | undefined;
        try { recovered = await local.read(record.id, root, ctx); } catch (error) { if ((error as NexusError).code !== 'NOT_FOUND') throw error; }
        if (recovered) {
          if (recovered.origin.captureKey !== captureKey) throw new NexusError('SOURCE_CONFLICT', '捕获来源身份冲突');
          await services.store.put('memory-captures', captureId, { captureKey, recordId: recovered.id, views: ['project_log', 'daily_log'], hash: recovered.contentHash });
          return { duplicate: true, recoveredReceipt: true, committed: true, captureId, record: recovered };
        }
        const outcome = await local.save(record, root, ctx, undefined, record.origin);
        const capturedRecord = outcome.record as MemoryRecord;
        await services.store.put('memory-captures', captureId, { captureKey, recordId: capturedRecord.id, views: ['project_log', 'daily_log'], hash: capturedRecord.contentHash });
        return { ...outcome, captureId, views: ['project_log', 'daily_log'], logicalFactCount: 1 };
        });
      }
      case 'revoke': {
        if (id.startsWith('filemem_')) await services.store.put('memory-revocations', id, { state: 'revoked', reason: params.reason });
        else { const record = await local.read(id, root, ctx); await authorizedSave({ id, lifecycle: 'tombstoned' }, root, ctx, record.revision); }
        return { committed: true, futureSendingBlocked: true, historicalModelRecall: 'cannot_retract', next: 'planned-rewrite-or-new-session' };
      }
      case 'health': case 'status': case 'diagnose': case 'audit': {
        const result = await local.list(root, ctx);
        const pending = (await proposals(root, ctx)).filter(item => ['pending_review', 'needs_reapproval', 'deferred'].includes(item.state));
        const docs = await files.documents(root);
        return { rootKind: 'Markdown-source-of-truth', records: result.items.length, pendingReview: pending.length, tracks: Object.fromEntries(['profile', 'facts', 'key', 'project_log', 'daily_log'].map(track => [track, result.items.filter(record => record.track === track).length])), trust: result.items.map(record => ({ id: record.id, ...trustProjection(record) })), errors: result.errors, fileMemory: { sources: docs.length, ready: docs.filter(doc => doc.scanStatus === 'ready').length, excluded: docs.filter(doc => doc.scanStatus !== 'ready').map(doc => ({ id: doc.documentId, state: doc.scanStatus, reason: doc.reason })) }, cache: { reportedHitRate: 'unknown', stableSnapshotIsNotCacheEvidence: true }, machineBackups: 'disabled-by-user' };
      }
      case 'import': {
        const legacy = params.sourceFormat && params.sourceFormat !== 'nexus-json' ? normalizeLegacyMemory(String(params.sourceFormat), params.data ?? params.records) : undefined;
        const records = legacy?.records ?? params.records;
        if (!Array.isArray(records) || records.length > 200) throw new NexusError('INVALID_IMPORT', '导入需要 records 数组，单批最多200条');
        assertNoSecret(records);
        const preview = records.map((record, index) => {
          try { const normalized = local.normalize(record as JsonRecord, root, ctx); return { index, valid: true, record: normalized, sourceHash: digest(stableJson(record)) }; }
          catch (error) { return { index, valid: false, code: (error as NexusError).code, record: null, sourceHash: digest(stableJson(record)) }; }
        });
        if (params.apply !== true) return { preview: true, items: preview, warnings: legacy?.warnings ?? [], externalRefs: legacy?.externalRefs ?? [], sourceUnchanged: true };
        const receipts: unknown[] = [];
        for (const item of preview) {
          ctx?.signal?.throwIfAborted();
          if (!item.valid || !item.record) { receipts.push({ index: item.index, state: 'rejected', code: item.code }); continue; }
          const key = digest(`${params.sourceInstanceId ?? 'explicit-import'}/${item.sourceHash}`).slice(7);
          const existing = await services.store.get('memory-imports', key);
          if (existing) { receipts.push({ index: item.index, duplicate: true, receipt: existing.value }); continue; }
          const { id: _id, ...data } = item.record;
          const receipt = await authorizedSave({ ...data, sourceRefs: [...item.record.sourceRefs, { sourceInstanceId: params.sourceInstanceId, sourceHash: item.sourceHash, sourceFormat: params.sourceFormat ?? 'nexus-json' }] }, root, ctx);
          await services.store.put('memory-imports', key, { recordId: (receipt.record as MemoryRecord).id, sourceHash: item.sourceHash });
          receipts.push(receipt);
        }
        return { receipts, warnings: legacy?.warnings ?? [], externalRefs: legacy?.externalRefs ?? [], sourceUnchanged: true, committed: receipts.some(receipt => (receipt as JsonRecord).committed) };
      }
      case 'export': {
        const items = (await local.list(root, ctx)).items;
        return services.invoke('artifact', { action: 'create', requestId: request.requestId ? `${request.requestId}:artifact` : undefined, params: { kind: 'memory-export', name: 'nexus-memory-export.json', mime: 'application/json', content: JSON.stringify({ formatVersion: 1, records: items, exclusions: ['secrets', 'host-sessions', 'provider-native-databases', 'machine-config'], sources: ['Markdown'] }, null, 2) } }, ctx);
      }
      case 'sync': return sync.call(root, params, ctx);
      case 'maintain': {
        const records = (await local.list(root, ctx)).items;
        const plan = records.map(record => ({ id: record.id, revision: record.revision, hash: record.contentHash, trust: trustProjection(record), proposed: record.lifecycle === 'current' && ['stale', 'invalid', 'expired'].includes(record.validation) ? 'review' : 'keep' }));
        if (params.apply !== true) return { preview: true, items: plan, contentUnchanged: true };
        for (const record of records) await services.store.put('memory-index', record.id, { title: record.title, scope: record.scope, contentHash: record.contentHash, revision: record.revision, track: record.track, lifecycle: record.lifecycle });
        return { committed: true, rebuilt: records.length, sourceUnchanged: true };
      }
      case 'compile': case 'reflect': case 'seed': {
        if (request.action === 'reflect' && params.spaceId) {
          return dispatch({ ...request, action: 'provider', params: { ...params, method: 'reflect' } }, ctx);
        }
        const source = String(params.text ?? params.query ?? '');
        if (!source || source.length > 24000) throw new NexusError('INVALID_ARGUMENT', '模型整理输入应为1–24000字符');
        assertNoSecret(source);
        if (request.action === 'seed' && params.confirmBudget !== true) throw new NexusError('BUDGET_APPROVAL_REQUIRED', 'seed默认关闭；须明确模型与提交预算');
        const model = await services.host.model({ role: request.action === 'reflect' ? 'memory-reflector' : 'memory-compiler', provider: typeof params.provider === 'string' ? params.provider : undefined, model: typeof params.model === 'string' ? params.model : undefined, prompt: `从以下来源提取有证据的记忆候选。只输出JSON数组，每项为title,body,kind,evidence。不把TODO、旧测试或猜测当作完成事实。\n\n${source}`, signal: ctx?.signal, sessionId: ctx?.sessionId, maxTokens: 4096 });
        let candidates: JsonRecord[];
        try { const match = /\[[\s\S]*\]/u.exec(model.text); candidates = JSON.parse(match?.[0] ?? model.text); if (!Array.isArray(candidates)) throw new Error(); }
        catch { throw new NexusError('INVALID_MODEL_OUTPUT', '模型未返回可审核候选；未写入任何事实', { usage: model.usage }); }
        const records = candidates.slice(0, Math.max(1, Math.min(30, Number(params.maxRecords ?? 10)))).map(candidate => {
          const record = Object.fromEntries(Object.entries(candidate).filter(([field]) => ['title', 'body', 'summary', 'kind', 'tags', 'conditions', 'evidence'].includes(field)));
          const evidence = Array.isArray(record.evidence) ? record.evidence.map(item => typeof item === 'object' && item !== null && typeof (item as JsonRecord).type === 'string' ? item : { type: 'model_claim', declaredReference: item }) : [];
          return local.normalize({ ...record, authority: 'candidate', validation: 'unverified', evidence: [...evidence, { type: 'source_text', hash: digest(source), producer: 'memory-compiler' }] }, root, { ...ctx, actorId: 'memory-compiler' });
        });
        const results: unknown[] = [];
        for (const record of records) results.push(await dispatch({ action: 'propose', requestId: memoryId('compile'), params: { record } }, { ...ctx, actorId: 'memory-compiler' }));
        return { state: 'awaiting_review', candidates: results, usage: model.usage, independentVerification: 'not_yet_performed' };
      }
      default: throw new NexusError('UNKNOWN_ACTION', '未知记忆操作');
    }
  }
  const capabilities: Capability[] = [
    ...readActions.map(action => ({ action, description: descriptions[action] ?? `记忆：${action}`, mutating: false })),
    ...writeActions.map(action => ({ action, description: descriptions[action] ?? `记忆：${action}`, mutating: true, permission: 'memory.write' })),
  ];
  const module: NexusModule = { id: 'memory', capabilities, dispatch, dispose: () => files.dispose() };
  return module;
}
