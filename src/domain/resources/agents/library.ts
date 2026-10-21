import { NexusError, type DispatchContext, type JsonRecord, type NexusServices } from '../../../ports/contracts.js';
import { BUILTIN_EXPERTS } from './builtin.js';
import { digest, newId, now, object, required, revision, text } from '../../workflow/util.js';
import type { TaskPlan } from '../../workflow/types.js';
import { validatePlan } from '../../workflow/plan.js';
import { BUILTIN_TEAMS as AGENCY_TEAMS, effectiveCoordinator } from './upstream/team-contract.js';
import { localizeTeam } from './upstream/team-content-en.js';

interface Translation { name: string; description: string; emoji?: string; body: string; }
export interface Expert {
  id: string; category: string; translations: Record<string, Translation>; source: string; license: string;
  enabled: boolean; deleted?: boolean; custom?: boolean; tags?: string[]; createdAt?: string; updatedAt?: string;
}
export interface Team {
  id: string; name: string; description: string; goal: string; constraints: string; deliveryRequirements: string;
  members: { expertId: string; duty: string; instructions?: string }[];
  examples: string[]; builtin?: boolean; enabled?: boolean; deleted?: boolean;
  coordinatorPrompt?: string; coordinatorMode?: string; coordinatorTemplateId?: string;
}
export const BUILTIN_TEAMS: Team[] = AGENCY_TEAMS.map(team => ({ ...team, members: team.members.map(({ expertSlug, ...member }) => ({ ...member, expertId: expertSlug })), coordinatorPrompt: effectiveCoordinator(team) }));
export class AgentLibrary {
  constructor(private readonly services: NexusServices) {}
  async all(): Promise<Expert[]> {
    const overrides = await this.services.store.list<Expert>('agent-experts');
    const byId = new Map<string, Expert>(BUILTIN_EXPERTS.map(e => [e.id, { ...e, enabled: true } as Expert]));
    for (const row of overrides) byId.set(row.id, row.value);
    return [...byId.values()];
  }
  async list(params: JsonRecord): Promise<unknown> {
    const locale = params.locale === 'en' ? 'en' : 'zh';
    const all = await this.all();
    const query = typeof params.query === 'string' ? params.query.toLowerCase() : '';
    const filtered = all.filter(e => !e.deleted && (!params.category || e.category === params.category) && (params.enabled === undefined || e.enabled === params.enabled) && (!params.source || e.source === params.source) && (!query || `${e.id} ${e.category} ${Object.values(e.translations).map(t => `${t.name} ${t.description}`).join(' ')}`.toLowerCase().includes(query)));
    const offset = typeof params.offset === 'number' ? Math.max(0, params.offset) : 0;
    const limit = typeof params.limit === 'number' ? Math.min(200, Math.max(1, params.limit)) : 50;
    return { total: filtered.length, categories: [...new Set(all.map(e => e.category))].sort(), offset, nextOffset: offset + limit < filtered.length ? offset + limit : null, items: filtered.slice(offset, offset + limit).map(e => ({ id: e.id, category: e.category, name: (e.translations[locale] ?? e.translations.en)?.name ?? e.id, description: (e.translations[locale] ?? e.translations.en)?.description, emoji: (e.translations[locale] ?? e.translations.en)?.emoji, enabled: e.enabled, custom: e.custom ?? false, source: e.source, license: e.license, tags: e.tags ?? [] })) };
  }
  async get(id: string): Promise<Expert> {
    const expert = (await this.all()).find(e => e.id === id && !e.deleted);
    if (!expert) throw new NexusError('NOT_FOUND', '专家不存在'); return expert;
  }
  async save(params: JsonRecord, expectedRevision?: number): Promise<unknown> {
    const id = typeof params.id === 'string' ? params.id : newId('expert-custom');
    const row = await this.services.store.get<Expert>('agent-experts', id);
    if (row || BUILTIN_EXPERTS.some(e => e.id === id)) {
      if (!row) throw new NexusError('SCOPE_MISMATCH', '内置正文只读，创建自定义副本后修改');
      revision(expectedRevision);
    }
    const name = text(params.name, 'name', 40), description = text(params.description, 'description', 160);
    const body = text(params.persona ?? params.body, 'persona', 20000), category = text(params.category, 'category', 80);
    const emoji = typeof params.emoji === 'string' ? params.emoji : '◉';
    const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
    if ([...segmenter.segment(emoji)].length !== 1) throw new NexusError('INVALID_ARGUMENT', 'emoji 必须是一个扩展字素');
    const duplicate = (await this.all()).find(e => !e.deleted && e.id !== id && Object.values(e.translations).some(t => t.name.trim().toLowerCase() === name.trim().toLowerCase()));
    if (duplicate) throw new NexusError('REVISION_CONFLICT', '专家名称冲突', { conflictingId: duplicate.id });
    const value: Expert = { id, category, translations: { ...row?.value.translations, [params.locale === 'en' ? 'en' : 'zh']: { name, description, body, emoji } }, source: 'user', license: typeof params.license === 'string' ? params.license : 'user-owned', enabled: params.enabled !== false, custom: true, tags: Array.isArray(params.tags) ? params.tags as string[] : [], createdAt: row?.value.createdAt ?? now(), updatedAt: now() };
    return this.services.store.put('agent-experts', id, value, row ? expectedRevision : 0);
  }
  async setState(id: string, patch: Partial<Expert>, expectedRevision?: number): Promise<unknown> {
    const existing = await this.services.store.get<Expert>('agent-experts', id);
    const expert = existing?.value ?? await this.get(id);
    if (existing) revision(expectedRevision);
    return this.services.store.put('agent-experts', id, { ...expert, ...patch, updatedAt: now() }, existing ? expectedRevision : 0);
  }
  async teams(locale: 'zh' | 'en' = 'zh'): Promise<Team[]> {
    const rows = await this.services.store.list<Team>('agent-teams');
    const builtins = locale === 'en' ? AGENCY_TEAMS.map(t => {
      const team = localizeTeam(t, locale);
      return { ...team, members: team.members.map(({ expertSlug, ...member }) => ({ ...member, expertId: expertSlug })), coordinatorPrompt: effectiveCoordinator(team, locale) };
    }) : BUILTIN_TEAMS;
    return [...new Map<string, Team>([...builtins.map(t => [t.id, t] as [string, Team]), ...rows.map(r => [r.id, r.value] as [string, Team])]).values()].filter(t => !t.deleted);
  }
  async team(id: string): Promise<Team> {
    const team = (await this.teams()).find(t => t.id === id);
    if (!team) throw new NexusError('NOT_FOUND', '专家团不存在'); return team;
  }
  async saveTeam(params: JsonRecord, expectedRevision?: number): Promise<unknown> {
    const id = typeof params.id === 'string' ? params.id : newId('team-custom');
    const existing = await this.services.store.get<Team>('agent-teams', id);
    if (existing) revision(expectedRevision);
    const members = Array.isArray(params.members) ? params.members.map(item => {
      const v = object(item); return { expertId: text(v.expertId, 'expertId', 128), duty: text(v.duty, 'duty', 100), instructions: typeof v.instructions === 'string' ? text(v.instructions || ' ', 'instructions', 2000) : undefined };
    }) : [];
    if (members.length < 2 || members.length > 8 || new Set(members.map(m => m.expertId)).size !== members.length) throw new NexusError('INVALID_ARGUMENT', '团队需要 2–8 个不重复成员');
    for (const m of members) await this.get(m.expertId);
    const team: Team = { id, name: text(params.name, 'name', 40), description: text(params.description, 'description', 160), goal: text(params.goal, 'goal', 2000), constraints: typeof params.constraints === 'string' ? params.constraints : '', deliveryRequirements: text(params.deliveryRequirements, 'deliveryRequirements', 2000), members, examples: Array.isArray(params.examples) ? params.examples as string[] : [], enabled: params.enabled !== false, coordinatorMode: params.coordinatorMode === 'custom' ? 'custom' : 'template', coordinatorPrompt: typeof params.coordinatorPrompt === 'string' ? params.coordinatorPrompt : undefined, coordinatorTemplateId: typeof params.coordinatorTemplateId === 'string' ? params.coordinatorTemplateId : 'general' };
    if ([...team.constraints].length > 2000 || [...(team.coordinatorPrompt ?? '')].length > 12000 || (team.coordinatorMode === 'custom' && !team.coordinatorPrompt?.trim())) throw new NexusError('INVALID_ARGUMENT', '团队约束/协调文本不合法');
    if (!team.examples.length || team.examples.length > 3) throw new NexusError('INVALID_ARGUMENT', '团队需要 1–3 个任务示例');
    return this.services.store.put('agent-teams', id, team, existing ? expectedRevision : 0);
  }
  async planTeam(params: JsonRecord, context: DispatchContext): Promise<TaskPlan> {
    const team = await this.team(text(params.teamId, 'teamId', 128));
    const brief = text(params.prompt, 'prompt', 20000);
    const disabled: string[] = [];
    const nodes = [];
    for (const m of team.members) {
      const expert = await this.get(m.expertId);
      if (!expert.enabled) disabled.push(expert.id);
      const persona = expert.translations[params.locale === 'en' ? 'en' : 'zh'] ?? expert.translations.en ?? Object.values(expert.translations)[0]!;
      nodes.push({ id: `expert-${expert.id}`, kind: 'agent', role: m.duty, expertId: expert.id, system: `${persona.body}\n\n本角色仅在当前冻结计划内执行，不得自行派生、扩权或代表用户发送消息。`, prompt: `${brief}\n\n职责：${m.duty}\n${m.instructions ?? ''}\n目标：${team.goal}\n约束：${team.constraints}\n交付：${team.deliveryRequirements}`, route: params.route, writeClaims: [] });
    }
    if (disabled.length && params.useDisabledOnce !== true) throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '团队含未启用专家，可选择仅本次使用', { disabled, nextAction: 'useDisabledOnce' });
    return validatePlan({ goal: `${team.name}: ${brief}`, scope: params.scope, nodes, budgets: params.budgets, provenance: { source: 'agency-team', teamId: team.id, contentHash: digest(team) } }, context);
  }
}
