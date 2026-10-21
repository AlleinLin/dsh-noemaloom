import { NexusError, type DispatchContext, type JsonRecord, type NexusRequest, type NexusServices } from '../../ports/contracts.js';
import type { WorkflowScheduler } from './scheduler.js';
import { digest, newId, now, object, required, text } from './util.js';
import { validatePlan } from './plan.js';

export class AdvisorService {
  constructor(private readonly services: NexusServices, private readonly scheduler: WorkflowScheduler) {}
  async dispatch(request: NexusRequest, context: DispatchContext): Promise<unknown> {
    const p = request.params ?? {}, action = request.action.replace('advisor/', '');
    if (action === 'list') return (await this.services.store.list<JsonRecord>('agent-advisors')).filter(r => !context.sessionId || r.value.ownerSessionId === context.sessionId);
    if (action === 'create') {
      const id = newId('advisor');
      return this.services.store.put('agent-advisors', id, { id, name: text(p.name ?? '独立旁观评审', 'name', 160), ownerSessionId: context.sessionId ?? 'local', projectId: p.projectId, enabled: p.enabled !== false, autoEvaluate: p.autoEvaluate === true, role: p.role ?? 'reviewer', route: p.route, createdAt: now(), status: 'idle', scope: p.scope ?? 'session' }, 0);
    }
    const row = await required<JsonRecord>(this.services, 'agent-advisors', text(p.advisorId ?? p.id, 'advisorId', 128));
    if (context.sessionId && row.value.ownerSessionId !== context.sessionId) throw new NexusError('SCOPE_MISMATCH', '旁观评审属于其他会话');
    if (action === 'evaluate') {
      if (!row.value.enabled) throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '旁观评审已停用');
      const messages = Array.isArray(p.messages) ? p.messages.map(v => object(v)).filter(m => {
        const source = m.source && typeof m.source === 'object' ? m.source as JsonRecord : {};
        return source.kind !== 'advisor';
      }) : [];
      const surface = typeof p.text === 'string' ? p.text : messages.map(m => String(m.text ?? m.content ?? '')).join('\n\n');
      text(surface, 'review surface', 200000);
      const hash = digest(surface);
      if (row.value.lastSurfaceHash === hash && row.value.lastRunId) return this.scheduler.get(String(row.value.lastRunId), context);
      const plan = validatePlan({ goal: '独立旁观评审当前可见材料', nodes: [{ id: 'advisor-review', kind: 'agent', role: row.value.role, route: row.value.route, prompt: `你是独立旁观评审。只评审以下材料，不继承作者完整历史，不冒充用户。输出严格 JSON {"notes":[{"severity":"info|nit|concern|blocker","text":"建议正文","evidenceRefs":[]}]}。证据不足要明确。\n\n${surface}`, outputContracts: { json: true, requiredFields: ['notes'], nonEmpty: true } }], budgets: { maxModelCalls: 1, maxConcurrent: 1 } }, context);
      await this.services.store.put('workflow-plans', plan.id, plan, 0);
      const run = await this.scheduler.start(plan.id, `${row.id}:${hash}`, context);
      await this.services.store.put('agent-advisors', row.id, { ...row.value, lastSurfaceHash: hash, lastRunId: run.id, status: 'running', updatedAt: now() }, row.revision);
      return run;
    }
    if (action === 'notes') {
      if (!row.value.lastRunId) return [];
      const run = await this.scheduler.get(String(row.value.lastRunId), context), ref = run.value.nodeRuns['advisor-review']?.resultRef;
      if (!ref) return { state: run.value.state, notes: [] };
      const artifact = await required<{ content: string }>(this.services, 'workflow-artifacts', ref.id);
      const result = JSON.parse(artifact.value.content);
      const parsed = JSON.parse(result.text);
      return { state: run.value.state, notes: parsed.notes, source: 'advisor', automaticExecution: false, artifactRef: ref };
    }
    if (action === 'adopt' || action === 'ignore' || action === 'reopen') {
      const id = typeof p.noteId === 'string' ? p.noteId : newId('advisor-note');
      const previous = await this.services.store.get('agent-advisor-decisions', id);
      return this.services.store.put('agent-advisor-decisions', id, { id, advisorId: row.id, actor: context.actorId ?? 'user', source: 'advisor', state: action, text: p.text, evidenceRefs: p.evidenceRefs ?? [], updatedAt: now() }, previous?.revision ?? 0);
    }
    if (action === 'steer') {
      const body = text(p.text, 'text', 20000);
      const draft = { id: newId('advisor-draft'), advisorId: row.id, sessionId: context.sessionId ?? 'local', source: { kind: 'advisor', plugin: 'dsh-nexus' }, text: body, state: 'draft', createdAt: now() };
      // No user-role message is forged. Host injection retains the source and requires adoption.
      if (p.adopted === true) {
        try {
          const receipt = await this.services.host.sessions('inject', { sessionId: draft.sessionId, text: `[旁观评审建议，来源 advisor；由使用者采纳]\n${body}`, source: draft.source, actor: context.actorId ?? 'user' });
          return { ...draft, state: 'injected', receipt };
        } catch (error) {
          if (!(error instanceof NexusError) || !['HOST_CAPABILITY_UNAVAILABLE', 'HOST_CONTRACT_UNSUPPORTED', 'DEPENDENCY_MISSING'].includes(error.code)) throw error;
        }
      }
      return this.services.store.put('agent-advisor-drafts', draft.id, draft, 0);
    }
    if (action === 'enable' || action === 'disable') return this.services.store.put('agent-advisors', row.id, { ...row.value, enabled: action === 'enable' }, request.expectedRevision ?? row.revision);
    throw new NexusError('INVALID_ARGUMENT', '未知 advisor action');
  }
}
