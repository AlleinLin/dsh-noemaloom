import { NexusError, type DispatchContext, type JsonRecord, type NexusRequest, type NexusServices } from '../../ports/contracts.js';
import { digest, newId, now, object, required, revision, text } from './util.js';
import { validatePlan } from './plan.js';
import type { WorkflowScheduler } from './scheduler.js';

/** Reuses the single authenticated GitHub connector; external writes remain explicit actions. */
export class GithubTaskBoard {
  constructor(private readonly services: NexusServices, private readonly scheduler: WorkflowScheduler) {}
  async dispatch(request: NexusRequest, context: DispatchContext): Promise<unknown> {
    const p = request.params ?? {}, action = request.action.replace('github/', '');
    if (action === 'list') return (await this.services.store.list<JsonRecord>('workflow-github-tasks')).filter(r => r.value.ownerSessionId === (context.sessionId ?? 'local'));
    if (action === 'import') {
      const query = { id: text(p.connectionId, 'connectionId', 128), owner: text(p.owner, 'owner', 160), repo: text(p.repo, 'repo', 160), state: p.state ?? 'open', page: p.page ?? 1 };
      const receipt = object(await this.services.invoke('connections', { action: 'github.issues', params: query }, context));
      if (!Array.isArray(receipt.result)) throw new NexusError('MODEL_PROTOCOL_INVALID', 'GitHub issue 查询未返回列表');
      const tasks = [];
      for (const item of receipt.result) {
        const issue = object(item);
        if (issue.pull_request) continue;
        if (typeof p.number === 'number' && issue.number !== p.number) continue;
        const id = `github-${digest(`${query.owner}/${query.repo}/${issue.number}`).slice(0, 40)}`;
        const existing = await this.services.store.get<JsonRecord>('workflow-github-tasks', id);
        const snapshot = { number: issue.number, title: issue.title, body: issue.body ?? '', updatedAt: issue.updated_at, url: issue.html_url, labels: issue.labels, state: issue.state };
        tasks.push(await this.services.store.put('workflow-github-tasks', id, { ...existing?.value, id, connectionId: query.id, owner: query.owner, repo: query.repo, ownerSessionId: context.sessionId ?? 'local', issue: snapshot, issueHash: digest(snapshot), importedAt: now(), status: existing?.value.status ?? 'imported', sourceReceipt: receipt.operationId }, existing?.revision ?? 0));
      }
      return { tasks, sourceReceipt: receipt.operationId, page: query.page, coverage: { scanComplete: receipt.result.length < 100, observed: receipt.result.length, imported: tasks.length } };
    }
    const row = await required<JsonRecord>(this.services, 'workflow-github-tasks', text(p.taskId, 'taskId', 128));
    if (row.value.ownerSessionId !== (context.sessionId ?? 'local')) throw new NexusError('SCOPE_MISMATCH', '任务属于其他会话');
    if (action === 'get') return row;
    if (action === 'freeze') {
      revision(request.expectedRevision ?? p.expectedRevision);
      const issue = object(row.value.issue);
      const prompt = typeof p.prompt === 'string' ? p.prompt : `实现 GitHub issue #${issue.number}: ${issue.title}\n\n${issue.body}\n\n按真实源码、测试、审查与证据交付；不会自动评论、创建 PR 或关闭 issue。`;
      return this.services.store.put('workflow-github-tasks', row.id, { ...row.value, frozenPrompt: text(prompt, 'prompt', 200000), frozenPromptHash: digest(prompt), frozenIssueHash: row.value.issueHash, frozenAt: now(), status: 'frozen', route: p.route }, Number(request.expectedRevision ?? p.expectedRevision));
    }
    if (action === 'analyze' || action === 'run' || action === 'review') {
      if (typeof row.value.frozenPrompt !== 'string' || row.value.frozenIssueHash !== row.value.issueHash) throw new NexusError('SNAPSHOT_STALE', '先冻结当前 issue/prompt，变更后需重新审核');
      const role = action === 'analyze' ? 'planner' : action === 'review' ? 'reviewer' : 'implementer';
      const plan = validatePlan({ goal: String(row.value.frozenPrompt), nodes: [{ id: role, kind: 'agent', role, prompt: row.value.frozenPrompt, route: row.value.route, writeClaims: action === 'run' ? [context.workspaceRoot ?? this.services.workspaceRoot] : [], system: action === 'review' ? '独立审查当前 issue 对应变更。只报告真实证据、触发与影响。不得自动发布或关闭 issue。' : undefined }], budgets: p.budgets }, context);
      plan.provenance = { source: 'github-task-board', taskId: row.id, issueHash: row.value.frozenIssueHash, promptHash: row.value.frozenPromptHash };
      plan.hash = digest({ ...plan, hash: undefined });
      await this.services.store.put('workflow-plans', plan.id, plan, 0);
      const run = await this.scheduler.start(plan.id, String(p.idempotencyKey ?? newId('github-run')), context);
      await this.services.store.put('workflow-github-tasks', row.id, { ...row.value, lastRunId: run.id, status: action === 'run' ? 'running' : action, updatedAt: now() }, row.revision);
      return run;
    }
    if (['comment', 'close', 'reopen', 'pull'].includes(action)) {
      const query: JsonRecord = { id: row.value.connectionId, owner: row.value.owner, repo: row.value.repo, number: object(row.value.issue).number };
      let connectorAction = 'github.issue.update';
      if (action === 'comment') { connectorAction = 'github.issue.comment'; query.body = text(p.body, 'body', 200000); }
      else if (action === 'pull') {
        connectorAction = 'github.request';
        query.path = `/repos/${row.value.owner}/${row.value.repo}/pulls`; query.method = 'POST';
        query.body = { title: text(p.title, 'title', 256), body: text(p.body, 'body', 200000), head: text(p.head, 'head', 256), base: text(p.base, 'base', 256), draft: p.draft !== false };
      } else query.state = action === 'close' ? 'closed' : 'open';
      // The connector independently verifies write authorization and stores the external receipt.
      const receipt = await this.services.invoke('connections', { action: connectorAction, params: query, requestId: request.requestId }, context);
      await this.services.store.put('workflow-github-tasks', row.id, { ...row.value, externalReceipts: [...(Array.isArray(row.value.externalReceipts) ? row.value.externalReceipts : []), receipt], updatedAt: now() }, row.revision);
      return receipt;
    }
    throw new NexusError('INVALID_ARGUMENT', '未知 GitHub 任务板 action');
  }
}
