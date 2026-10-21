import { NexusError, type DispatchContext, type JsonRecord, type NexusRequest, type NexusServices } from '../../ports/contracts.js';
import { PROMPT_SEED } from './prompt-seed.js';
import { digest, newId, now, object, required, revision, text } from './util.js';
import { projectId } from '../memory/types.js';

interface Todo extends JsonRecord { id: string; content: string; scope: string; status: string; quadrant: number; due?: string; date?: string; category?: string; createdAt: string; updatedAt: string; doneAt?: string; archivedAt?: string; ownerSessionId: string; }
interface Prompt extends JsonRecord { id: string; name: string; content: string; description: string; enabled: boolean; bindings?: string[]; source: string; }
const dateOnly = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'string' ? new Date(`${value}T00:00:00Z`) : new Date(NaN);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new NexusError('INVALID_ARGUMENT', '日期必须是有效 YYYY-MM-DD');
  return value;
};
const today = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export class Productivity {
  constructor(private readonly services: NexusServices) {}
  private scope(row: JsonRecord, context: DispatchContext): void {
    if (context.sessionId && row.scope === 'session' && row.ownerSessionId !== context.sessionId) throw new NexusError('SCOPE_MISMATCH', '对象属于另一会话');
    if (context.scopeLevel !== 'global' && row.projectId && row.projectId !== projectId(context.workspaceRoot ?? this.services.workspaceRoot)) throw new NexusError('SCOPE_MISMATCH', '对象属于另一工作区');
  }
  async todo(request: NexusRequest, context: DispatchContext): Promise<unknown> {
    const params = request.params ?? {}, action = request.action.replace('todo/', '');
    if (action === 'list' || action === 'export') {
      const project = context.scopeLevel === 'global' ? 'global' : projectId(context.workspaceRoot ?? this.services.workspaceRoot);
      const rows = (await this.services.store.list<Todo>('workflow-todos')).filter(row => !row.value.archivedAt && (!row.value.projectId || row.value.projectId === project) && (row.value.scope !== 'session' || row.value.ownerSessionId === context.sessionId));
      const day = typeof params.today === 'string' ? dateOnly(params.today)! : today();
      const filtered = rows.filter(({ value: v }) => (!params.scope || v.scope === params.scope) && (!params.status || v.status === params.status) && (!params.category || v.category === params.category) && (!params.query || v.content.toLowerCase().includes(String(params.query).toLowerCase())) && (!params.projectId || v.projectId === params.projectId) && (!params.branch || v.branch === params.branch));
      const rank = (v: Todo): number => !['done', 'cancelled'].includes(v.status) && ((v.due && v.due < day) || (!v.due && v.scope === 'daily' && v.date && v.date < day)) ? 0 : v.due === day ? 1 : v.quadrant === 1 ? 2 : v.quadrant === 2 ? 3 : v.quadrant === 3 ? 4 : 5;
      filtered.sort((a, b) => rank(a.value) - rank(b.value) || (a.value.due ?? '9999').localeCompare(b.value.due ?? '9999') || a.value.createdAt.localeCompare(b.value.createdAt) || a.id.localeCompare(b.id));
      if (action === 'export') return { format: 'markdown-tags-v1', content: filtered.map(({ value: v }) => `§\n[${v.createdAt}] [id: ${v.id}] [q${v.quadrant}] ${v.due ? `[due: ${v.due}] ` : ''}[status: ${v.status}]${v.category ? ` [cat: ${v.category}]` : ''}${v.doneAt ? ` [done: ${v.doneAt}]` : ''}\n${v.content}`).join('\n') };
      const limit = typeof params.limit === 'number' ? Math.min(500, params.limit) : 8;
      return { total: filtered.length, hidden: Math.max(0, filtered.length - limit), items: filtered.slice(0, limit), today: day, timezone: 'Asia/Shanghai' };
    }
    if (action === 'import') {
      const source = text(params.content, 'content', 4 * 1024 * 1024);
      const results = [];
      for (const entry of source.split(/^§\s*$/m).filter(s => s.trim())) {
        const lines = entry.trim().split('\n'), header = lines.shift() ?? '', tags: Record<string, string> = {};
        for (const match of header.matchAll(/\[([^:\]]+):\s*([^\]]*)\]/g)) tags[match[1].trim()] = match[2].trim();
        const due = dateOnly(tags.due), q = Number(header.match(/\[q([1-4])\]/)?.[1] ?? 4);
        results.push(await this.todo({ action: 'todo/create', params: { content: lines.join('\n') || entry, scope: params.scope ?? 'work', due, quadrant: q, category: tags.cat, status: tags.status ?? 'pending', legacyTags: tags, originalBody: entry } }, context));
      }
      return { imported: results.length, results };
    }
    const id = typeof params.id === 'string' ? params.id : request.target?.id ?? newId('todo');
    const row = await this.services.store.get<Todo>('workflow-todos', id);
    if (action !== 'create' && !row) throw new NexusError('NOT_FOUND', '待办不存在');
    if (row) { this.scope(row.value, context); revision(request.expectedRevision ?? params.expectedRevision); }
    const status = typeof params.status === 'string' ? params.status : row?.value.status ?? 'pending';
    if (!['pending', 'doing', 'blocked', 'done', 'cancelled'].includes(status)) throw new NexusError('INVALID_ARGUMENT', '待办状态无效');
    const scope = context.scopeLevel === 'session' ? 'session' : typeof params.scope === 'string' ? params.scope : row?.value.scope ?? (context.scopeLevel === 'global' ? 'work' : 'project');
    if (context.scopeLevel === 'session' && params.scope && params.scope !== 'session') throw new NexusError('PERMISSION_DENIED', '会话入口只能创建会话任务');
    const project = context.scopeLevel === 'global' ? 'global' : projectId(context.workspaceRoot ?? this.services.workspaceRoot);
    if (params.projectId && params.projectId !== project) throw new NexusError('SCOPE_MISMATCH', '不能指定其他工作区');
    if (!['life', 'work', 'project', 'daily', 'session'].includes(scope)) throw new NexusError('INVALID_ARGUMENT', '待办 scope 无效');
    const value: Todo = {
      ...row?.value, ...params, id, projectId: project, content: params.content === undefined && row ? row.value.content : text(params.content, 'content', 20000), scope, status,
      quadrant: Number(params.quadrant ?? row?.value.quadrant ?? 4), due: params.due === undefined ? row?.value.due : dateOnly(params.due),
      date: params.date === undefined ? row?.value.date : dateOnly(params.date), createdAt: row?.value.createdAt ?? now(), updatedAt: now(),
      ownerSessionId: row?.value.ownerSessionId ?? context.sessionId ?? 'local', doneAt: status === 'done' ? row?.value.doneAt ?? now() : undefined,
    };
    if (value.quadrant < 1 || value.quadrant > 4 || !Number.isInteger(value.quadrant)) throw new NexusError('INVALID_ARGUMENT', 'quadrant 必须为 1–4');
    if (status === 'done' && value.linkedNodeId && (!Array.isArray(params.completionEvidenceRefs) || !params.completionEvidenceRefs.length)) throw new NexusError('EVIDENCE_MISMATCH', '关联人工待办完成需要 delivery evidence，不能只依据节点成功');
    if (action === 'archive' || action === 'remove') value.archivedAt = now();
    return this.services.store.put('workflow-todos', id, value, row ? Number(request.expectedRevision ?? params.expectedRevision) : 0);
  }
  private async prompts(): Promise<Prompt[]> {
    const seeds: Prompt[] = PROMPT_SEED.prompts.map((p, i) => ({ ...p, id: `prompt-seed-${i + 1}`, name: String(p.name), description: String(p.description ?? ''), content: String(p.content), source: PROMPT_SEED.source, enabled: true }));
    const rows = await this.services.store.list<Prompt>('workflow-prompts');
    return [...new Map([...seeds.map(p => [p.id, p] as const), ...rows.map(r => [r.id, r.value] as const)]).values()];
  }
  async prompt(request: NexusRequest, context: DispatchContext): Promise<unknown> {
    const params = request.params ?? {}, action = request.action.replace('prompt/', '');
    if (action === 'list') return (await this.prompts()).filter(p => (!params.query || `${p.name} ${p.description}`.toLowerCase().includes(String(params.query).toLowerCase())) && (!params.category || p.category === params.category)).map(({ content: _body, ...summary }) => summary);
    if (action === 'injections') return (await this.services.store.list<JsonRecord>('workflow-injections')).filter(r => !context.sessionId || r.value.sessionId === context.sessionId);
    if (action === 'revoke' || action === 'pause') {
      const row = await required<JsonRecord>(this.services, 'workflow-injections', text(params.id, 'id', 128));
      if (context.sessionId && row.value.sessionId !== context.sessionId) throw new NexusError('SCOPE_MISMATCH', '注入计划属于其他会话');
      return this.services.store.put('workflow-injections', row.id, { ...row.value, status: action === 'pause' ? 'paused' : 'revoked', updatedAt: now() }, request.expectedRevision ?? row.revision);
    }
    if (action === 'apply' || action === 'tick') {
      let injection: JsonRecord;
      if (action === 'tick') {
        const row = await required<JsonRecord>(this.services, 'workflow-injections', text(params.id, 'id', 128)); injection = row.value;
        if (context.sessionId && injection.sessionId !== context.sessionId) throw new NexusError('SCOPE_MISMATCH', '注入计划属于其他会话');
        if (injection.status !== 'active' && injection.status !== 'queued') return row;
        const turn = Number(params.turn ?? 0), last = Number(injection.lastTurn ?? -1);
        if (turn <= last || turn % Number(injection.everyTurns ?? 1)) return row;
        if (injection.remainingRounds !== null && Number(injection.remainingRounds) <= 0) return row;
        injection = { ...injection, lastTurn: turn, remainingRounds: injection.remainingRounds === null ? null : Number(injection.remainingRounds) - 1 };
      } else {
        const prompt = (await this.prompts()).find(p => p.id === params.templateId && p.enabled);
        if (!prompt) throw new NexusError('NOT_FOUND', '启用的提示词模板不存在');
        const bindings = params.bindings ? object(params.bindings) : {};
        const names = [...new Set([...prompt.content.matchAll(/\{\{([A-Za-z0-9_.-]+)\}\}/g)].map(m => m[1]))];
        for (const name of [...(prompt.bindings ?? []), ...names]) if (!(name in bindings)) throw new NexusError('INVALID_ARGUMENT', `缺少 binding ${name}`);
        const body = prompt.content.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (_match, name: string) => String(bindings[name]));
        const schedule = String(params.schedule ?? 'once');
        const rounds = schedule === 'continuous' ? null : schedule === 'immediate' || schedule === 'once' ? 1 : Number(params.rounds);
        if (rounds !== null && (!Number.isSafeInteger(rounds) || rounds < 1)) throw new NexusError('INVALID_ARGUMENT', '有限注入 rounds 必须为正整数');
        const everyTurns = Number(params.everyTurns ?? 1);
        if (!Number.isSafeInteger(everyTurns) || everyTurns < 1) throw new NexusError('INVALID_ARGUMENT', 'everyTurns 必须为正整数');
        injection = { id: newId('injection'), templateId: prompt.id, templateHash: digest(prompt.content), sessionId: params.sessionId ?? context.sessionId ?? 'local', source: 'plugin:dsh-nexus', body, schedule, remainingRounds: rounds, everyTurns, status: 'queued', createdAt: now() };
      }
      if (context.sessionId && injection.sessionId !== context.sessionId && !context.permissions?.has('agents:message')) throw new NexusError('AUTHORIZATION_REQUIRED', '向其他会话注入需要明确发送授权');
      try {
        const receipt = await this.services.host.sessions('inject', { sessionId: injection.sessionId, text: injection.body, source: { kind: 'plugin', id: 'dsh-nexus', operation: 'prompt-template' }, injectionId: injection.id });
        injection.remainingRounds = injection.remainingRounds === null ? null : Math.max(0, Number(injection.remainingRounds) - (action === 'apply' ? 1 : 0));
        injection.status = injection.remainingRounds === 0 ? 'completed' : 'active'; injection.receipt = receipt;
      } catch (error) {
        if (!(error instanceof NexusError) || !['HOST_CAPABILITY_UNAVAILABLE', 'HOST_CONTRACT_UNSUPPORTED', 'DEPENDENCY_MISSING'].includes(error.code)) throw error;
        injection.status = 'queued'; injection.deliveryReason = '正式即时注入 API 不可用，保留可见草稿等待下一轮';
      }
      const row = await this.services.store.get('workflow-injections', String(injection.id));
      return this.services.store.put('workflow-injections', String(injection.id), injection, row?.revision ?? 0);
    }
    const id = typeof params.id === 'string' ? params.id : newId('prompt');
    const current = (await this.prompts()).find(p => p.id === id);
    if (action === 'get') {
      if (!current) throw new NexusError('NOT_FOUND', '模板不存在'); return current;
    }
    const row = await this.services.store.get<Prompt>('workflow-prompts', id);
    if (row) revision(request.expectedRevision ?? params.expectedRevision);
    const value: Prompt = { ...current, ...params, id, name: text(params.name ?? current?.name, 'name', 160), content: text(params.content ?? current?.content, 'content', 200000), description: String(params.description ?? current?.description ?? ''), enabled: params.enabled !== false, source: current?.source ?? 'user', updatedAt: now() };
    return this.services.store.put('workflow-prompts', id, value, row ? Number(request.expectedRevision ?? params.expectedRevision) : 0);
  }
  /** Called by the host turn hook; advisor output is not reclassified as a user instruction. */
  async onTurn(sessionId: string, turn: number): Promise<void> {
    const rows = await this.services.store.list<JsonRecord>('workflow-injections');
    for (const row of rows.filter(r => r.value.sessionId === sessionId && ['queued', 'active'].includes(String(r.value.status)))) {
      if (Number(row.value.lastTurn ?? -1) >= turn) continue;
      await this.prompt({ action: 'prompt/tick', params: { id: row.id, turn } }, { sessionId, actorId: 'plugin:dsh-nexus' });
    }
  }
}
