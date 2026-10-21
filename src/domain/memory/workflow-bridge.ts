import { NexusError, type DispatchContext, type JsonRecord, type NexusServices, type StoredRecord } from '../../ports/contracts.js';
import { digest, projectId, stableJson } from './types.js';

/** Cognitive task cards keep their full source text; execution belongs to the shared workflow scheduler. */
export class CognitionWorkflowBridge {
  constructor(private services: NexusServices) {}
  async reconcile(root: string, sourceOp: string, method: string, args: JsonRecord, source: JsonRecord, ctx?: DispatchContext): Promise<JsonRecord> {
    const identity = String(source.node_id ?? source.id ?? (source.goal as JsonRecord | undefined)?.id ?? args.nodeId ?? args.taskId ?? args.id ?? '');
    const key = identity ? digest(`${projectId(root)}/${sourceOp}/${identity}`).slice(7) : '';
    if (!key) return { state: 'source-only', reason: 'no_task_identity', executionStarted: false };
    const previous = await this.services.store.get<JsonRecord>('cognition-workflow-links', key);
    const mutating = sourceOp === 'goal' ? ['add', 'setStatus'].includes(method) : ['open', 'status', 'planAdd'].includes(method);
    if (!mutating) return { state: previous ? 'linked' : 'source-only', ...previous?.value, executionStarted: false };
    const status = String(source.status ?? (source.goal as JsonRecord | undefined)?.status ?? args.taskStatus ?? args.newStatus ?? args.goalStatus ?? 'active');
    const content = String(source.name ?? args.name ?? args.taskName ?? args.goal ?? args.text ?? previous?.value.content ?? identity);
    const sourceRef = `cognition://${projectId(root)}/${sourceOp}/${encodeURIComponent(identity)}`;
    const todoStatus = ({ active: 'doing', blocked: 'blocked', done: 'done', dropped: 'cancelled' } as Record<string, string>)[status];
    if (!todoStatus) throw new NexusError('INVALID_ARGUMENT', '认知任务状态不能映射到统一工作流', { status });
    const sourceHash = digest(stableJson({ source, args }));
    if (previous?.value.sourceHash === sourceHash) return { state: 'linked', ...previous.value, duplicate: true, executionStarted: false };
    const todoId = String(previous?.value.todoId ?? `cognition_${key.slice(0, 32)}`);
    const todo = await this.services.store.get('workflow-todos', todoId);
    const todoResult = await this.services.invoke('workflow', {
      action: todo ? 'todo/update' : 'todo/create', expectedRevision: todo?.revision, requestId: `memory-link:${key}:${sourceHash}:todo-r${todo?.revision ?? 0}`,
      params: { id: todoId, content, scope: 'project', projectId: projectId(root), status: todoStatus,
        completionEvidenceRefs: status === 'done' ? [`${sourceRef}#result`] : [],
        source: { kind: 'cognitive-task-card', identity, ref: sourceRef, validation: 'unverified' } },
    }, ctx) as StoredRecord;
    let workflowPlanId = previous?.value.workflowPlanId;
    if (sourceOp === 'task' && (method === 'open' || method === 'planAdd')) {
      const prompt = [String(args.plan ?? ''), String(args.change ?? args.text ?? ''), String(args.acceptance ?? ''), String(args.boundary ?? '')].filter(Boolean).join('\n\n') || content;
      const plan = await this.services.invoke('workflow', {
        action: 'plan', requestId: `memory-link:${key}:${sourceHash}:plan`,
        params: { goal: content, scope: root, nodes: [{ id: `task_${key.slice(0, 24)}`, kind: 'manual', prompt,
          metadata: { cognitiveSourceRef: sourceRef, previousPlanId: workflowPlanId, sourceHash } }],
          deliveryContract: { requireIndependentVerification: true } },
      }, ctx) as StoredRecord;
      workflowPlanId = plan.id;
    }
    const link = { sourceIdentity: identity, sourceRef, sourceHash, content, todoId: todoResult.id, workflowPlanId,
      previousPlanId: previous?.value.workflowPlanId, sourceStatus: status, validation: 'unverified', executionStarted: false };
    await this.services.store.put('cognition-workflow-links', key, link, previous?.revision);
    return { state: 'linked', ...link, next: workflowPlanId ? 'workflow.run requires an explicit execution request' : undefined };
  }
}
