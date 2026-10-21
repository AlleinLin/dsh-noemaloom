import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NexusError, type DispatchContext, type JsonRecord, type NexusRequest, type NexusServices } from '../../ports/contracts.js';
import { newId, now, object, page, projectRoot, sha256, stored, strings, scopedPath, textFile } from './shared.js';

const phases = ['intake', 'requirements', 'design', 'execution_plan', 'implementation', 'verification', 'review', 'delivery', 'closed'];
const changeTypes = ['feat', 'demand-change', 'fix', 'refactor', 'migration', 'DX', 'deployment'];
const requiredFields: Record<string, string[]> = {
  feat: ['goal', 'acceptance'], 'demand-change': ['goal', 'originalRequirement', 'acceptance'],
  fix: ['goal', 'reproduction', 'expected', 'actual', 'verification'],
  refactor: ['goal', 'invariants', 'verification'], migration: ['goal', 'mapping', 'compatibility', 'irreversiblePoints', 'verification'],
  DX: ['goal', 'developerPain', 'commands', 'verification'], deployment: ['goal', 'artifact', 'targetEnvironment', 'healthChecks', 'permissions'],
};
interface Lifecycle {
  id: string; goal: string; changeType: string; fields: JsonRecord; constraints: string[];
  sourceRefs: string[]; phase: string; approvalState: string; executionState: string;
  templateRef: string; templateHash: string; artifacts: string[]; events: JsonRecord[];
  planRef?: string; root: string; createdAt: string; fastpath: boolean; gaps: string[];
}
interface Template { id: string; title: string; definition: JsonRecord; hash: string; archived: boolean; createdAt: string }
export function createLifecycleDispatcher(services: NexusServices) {
  const collection = 'quality.workflows';
  async function validateTemplate(definition: JsonRecord): Promise<JsonRecord> {
    if (!Array.isArray(definition.nodes) || definition.nodes.length > 200) throw new NexusError('INVALID_ARGUMENT', '模板必须提供受限 nodes DAG');
    const ids = new Set<string>();
    const nodes = definition.nodes.map(object);
    for (const node of nodes) {
      if (typeof node.id !== 'string' || ids.has(node.id)) throw new NexusError('INVALID_ARGUMENT', '模板节点 ID 缺失或重复');
      ids.add(node.id);
      if (!['tool', 'agent', 'review', 'manual', 'artifact', 'quality', 'export', 'verify'].includes(String(node.kind))) throw new NexusError('INVALID_ARGUMENT', '模板节点 executor 类型无效');
      if (node.retry !== undefined && (!Number.isInteger(node.retry) || Number(node.retry) < 0 || Number(node.retry) > 3)) throw new NexusError('INVALID_ARGUMENT', '模板重试必须有界 0–3');
      if (node.timeoutMs !== undefined && (typeof node.timeoutMs !== 'number' || node.timeoutMs < 1000 || node.timeoutMs > 900000)) throw new NexusError('INVALID_ARGUMENT', '模板超时无效');
      if (JSON.stringify(node).includes('"__proto__"')) throw new NexusError('INVALID_ARGUMENT', '模板含禁止字段');
    }
    const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new NexusError('INVALID_ARGUMENT', '模板 DAG 有环', { nodeId: id });
      if (visited.has(id)) return;
      visiting.add(id);
      const node = nodes.find(node => node.id === id)!;
      for (const dependency of strings(node.dependsOn)) { if (!ids.has(dependency)) throw new NexusError('INVALID_ARGUMENT', '模板引用缺失节点', { nodeId: id, dependency }); visit(dependency); }
      visiting.delete(id); visited.add(id);
    };
    for (const id of ids) visit(id);
    const reaches = (from: string, to: string): boolean => {
      if (from === to) return true;
      return strings(nodes.find(node => node.id === from)?.dependsOn).some(dependency => reaches(dependency, to));
    };
    const conflicts: JsonRecord[] = [];
    for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
      const one = nodes[a]!; const two = nodes[b]!;
      const overlap = strings(one.writeClaims).filter(claim => strings(two.writeClaims).includes(claim));
      if (overlap.length && !reaches(String(one.id), String(two.id)) && !reaches(String(two.id), String(one.id))) conflicts.push({ left: one.id, right: two.id, paths: overlap });
    }
    if (conflicts.length) throw new NexusError('REVISION_CONFLICT', '模板并行节点声明相同写路径', conflicts);
    return { valid: true, hash: sha256(definition), nodes: nodes.length, source: 'declarative-no-eval' };
  }
  async function dispatch(action: string, request: NexusRequest, context?: DispatchContext): Promise<unknown> {
    const params = request.params ?? {};
    const root = projectRoot(services, context);
    if (action === 'catalog') return { changeTypes: changeTypes.map(type => ({ type, minimumFields: requiredFields[type], source: ['feat', 'demand-change'].includes(type) ? 'qiudeng7/software-engineering-workflow' : 'Nexus explicit extension' })), phases, documents: ['README', 'CONTRIBUTING', 'architecture', 'ADR', 'issue', 'PR'], questions: ['使用者从哪里开始，成功是什么？', '失败由谁接收？', '哪个源文件证明当前事实？'] };
    if (action === 'discover') {
      const names = ['README.md', 'README.zh-CN.md', 'README.en.md', 'CONTRIBUTING.md', 'package.json', '.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE', '.github/workflows', 'docs', '.nexus/workflows'];
      const sources: JsonRecord[] = [];
      for (const name of names) try { const filename = await scopedPath(root, name); const stat = await fs.stat(filename); sources.push({ path: name, kind: stat.isDirectory() ? 'directory' : 'file', ...(stat.isFile() ? { hash: sha256(await fs.readFile(filename)) } : {}), evidence: 'observed-not-executed' }); } catch { /* absent documents remain gaps, not invented content */ }
      let ruleDocument: string | null = null;
      for (const name of ['DEEPSEEK.md', 'AGENT.md', 'AGENTS.md', 'CLAUDE.md']) {
        try {
          const filename = await scopedPath(root, name);
          if (!(await fs.stat(filename)).isFile()) continue;
          sources.push({ path: name, kind: 'file', hash: sha256(await fs.readFile(filename)), evidence: 'observed-not-executed' });
          ruleDocument = name;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      return { root, sources, ruleDocument, gaps: [...names.filter(name => !sources.some(source => source.path === name)), ...(!ruleDocument ? ['DEEPSEEK.md'] : [])], verification: 'not_run' };
    }
    if (action === 'create') {
      const changeType = String(params.changeType ?? 'feat');
      if (!changeTypes.includes(changeType) || typeof params.goal !== 'string' || !params.goal.trim()) throw new NexusError('INVALID_ARGUMENT', '变更类型或 goal 无效');
      const fields: JsonRecord = { ...object(params.fields), goal: params.goal };
      const gaps = requiredFields[changeType]!.filter(name => fields[name] === undefined || fields[name] === '');
      const workflow: Lifecycle = { id: newId('engineering'), goal: params.goal, changeType, fields, constraints: strings(params.constraints), sourceRefs: strings(params.sourceRefs), phase: 'intake', approvalState: 'not_required', executionState: 'idle', templateRef: `builtin:${changeType}:v1`, templateHash: sha256({ changeType, phases, minimum: requiredFields[changeType] }), artifacts: [], events: [{ type: 'created', at: now(), actor: context?.actorId ?? 'user' }], root: await fs.realpath(root), createdAt: now(), fastpath: params.fastpath === true, gaps };
      return services.store.put(collection, workflow.id, workflow);
    }
    if (action === 'status') {
      if (!params.workflowId) return page((await services.store.list<Lifecycle>(collection)).map(record => ({ id: record.id, revision: record.revision, goal: record.value.goal, phase: record.value.phase, approvalState: record.value.approvalState, executionState: record.value.executionState })), request.cursor, request.limit);
      return stored<Lifecycle>(services, collection, params.workflowId);
    }
    if (action === 'template') {
      const operation = String(params.operation ?? 'list');
      if (operation === 'list') return services.store.list<Template>('quality.templates');
      if (operation === 'validate') return validateTemplate(object(params.definition));
      const id = typeof params.templateId === 'string' ? params.templateId : newId('template');
      if (operation === 'archive') {
        const current = await stored<Template>(services, 'quality.templates', id);
        return services.store.put('quality.templates', id, { ...current.value, archived: true }, request.expectedRevision ?? current.revision);
      }
      if (!['create', 'update'].includes(operation)) throw new NexusError('INVALID_ARGUMENT', 'template operation 无效');
      const definition = object(params.definition);
      const validation = await validateTemplate(definition);
      const template: Template = { id, title: String(params.title ?? id), definition, hash: String(validation.hash), archived: false, createdAt: now() };
      return services.store.put('quality.templates', id, template, request.expectedRevision);
    }
    if (action === 'import') {
      const file = await textFile(root, String(params.path ?? params.sourceRef), 1024 * 1024);
      let definition: JsonRecord;
      try { definition = object(JSON.parse(file.text)); } catch { throw new NexusError('FORMAT_UNSUPPORTED', '声明式工作流导入只接受 JSON，不执行附带脚本'); }
      const validation = await validateTemplate(definition);
      if (params.dryRun !== false) return { dryRun: true, path: file.path, sourceHash: file.hash, validation, definition };
      return dispatch('template', { action: 'lifecycle/template', params: { operation: 'create', title: params.title ?? path.basename(file.path), definition } }, context);
    }
    const row = await stored<Lifecycle>(services, collection, params.workflowId);
    const workflow = row.value;
    if (workflow.root !== await fs.realpath(root)) throw new NexusError('SCOPE_MISMATCH', '生命周期对象不属于当前项目');
    if (request.expectedRevision !== undefined && request.expectedRevision !== row.revision) throw new NexusError('REVISION_CONFLICT', '生命周期版本冲突');
    if (action === 'transition') {
      const from = String(params.fromPhase ?? workflow.phase);
      const to = String(params.toPhase);
      if (from !== workflow.phase || (!phases.includes(to) && !['paused', 'cancelled'].includes(to))) throw new NexusError('REVISION_CONFLICT', '阶段或前置版本无效');
      const previousIndex = phases.indexOf(from); const nextIndex = phases.indexOf(to);
      if (!['paused', 'cancelled'].includes(to) && nextIndex > previousIndex + 1 && !workflow.fastpath) throw new NexusError('INVALID_ARGUMENT', '阶段跳跃需要显式 tiny fastpath 或回到前置阶段');
      const evidence = strings(params.evidenceRefs);
      if (['verification', 'review', 'delivery', 'closed'].includes(to) && !evidence.length) throw new NexusError('EVIDENCE_MISMATCH', '此阶段必须链接真实证据，不能以已确认替代执行通过');
      if (workflow.gaps.length && !['intake', 'requirements', 'cancelled', 'paused'].includes(to)) throw new NexusError('INVALID_ARGUMENT', '必填事实缺失，不能推断历史意图', { gaps: workflow.gaps });
      const fields = { ...workflow.fields, ...object(params.fields) };
      const gaps = requiredFields[workflow.changeType]!.filter(name => fields[name] === undefined || fields[name] === '');
      const next = { ...workflow, phase: to, fields, gaps, executionState: to === 'cancelled' ? 'cancelled' : 'idle', events: [...workflow.events, { type: 'transition', from, to, evidenceRefs: evidence, approvalRef: params.authorizationRef ?? null, at: now(), actor: context?.actorId ?? 'user' }] };
      await services.store.put('quality.workflow-versions', `${row.id}:${row.revision}`, workflow);
      return services.store.put(collection, row.id, next, row.revision);
    }
    if (action === 'artifact') {
      const operation = String(params.operation ?? 'create');
      if (operation === 'link') {
        const artifactId = String(params.artifactId);
        await stored(services, 'artifacts.items', artifactId);
        workflow.artifacts = [...new Set([...workflow.artifacts, artifactId])];
        return services.store.put(collection, workflow.id, workflow, row.revision);
      }
      const mapped = operation === 'create' ? (params.content || params.ir ? 'create' : 'document') : operation;
      const result = await services.invoke('artifact', { action: mapped, params: { ...params, title: params.title ?? workflow.goal, goal: workflow.goal, sourceRefs: workflow.sourceRefs } }, context) as { id?: string; value?: { id?: string } };
      const artifactId = result.id ?? result.value?.id;
      if (artifactId) { workflow.artifacts.push(artifactId); await services.store.put(collection, workflow.id, workflow, row.revision); }
      return result;
    }
    if (action === 'review') return services.invoke('artifact', { action: 'cold_review', params }, context);
    if (action === 'plan') {
      let template: JsonRecord | undefined;
      if (params.templateId) template = (await stored<Template>(services, 'quality.templates', params.templateId)).value.definition;
      if (template) await validateTemplate(template);
      const nodes = template?.nodes ?? params.nodes;
      if (!Array.isArray(nodes) || !nodes.length) throw new NexusError('INVALID_ARGUMENT', '执行计划必须列出真实 tool/agent/manual 节点，不能把阶段名称当已实现动作');
      const result = await services.invoke('workflow', { action: 'plan', params: { goal: workflow.goal, nodes, budgets: params.budgets ?? params.budget } }, context) as { id: string };
      workflow.planRef = result.id; workflow.executionState = 'planned';
      workflow.events.push({ type: 'plan-compiled', planRef: result.id, templateHash: workflow.templateHash, at: now() });
      await services.store.put(collection, workflow.id, workflow, row.revision);
      return result;
    }
    if (action === 'validate') {
      const findings: JsonRecord[] = workflow.gaps.map(field => ({ classification: 'missing', severity: 'blocking', field }));
      for (const artifactId of workflow.artifacts) {
        try {
          const result = await services.invoke('artifact', { action: 'validate', params: { artifactId } }, context);
          findings.push({ artifactId, result });
        } catch (error) { findings.push({ artifactId, severity: 'blocking', error: error instanceof Error ? error.message : String(error) }); }
      }
      return { workflowId: workflow.id, revision: row.revision, phase: workflow.phase, findings, verification: findings.some(finding => finding.severity === 'blocking') ? 'failed' : 'partial', limitation: '文档一致性检查不等于工程测试或部署验证' };
    }
    if (action === 'export' || action === 'evidence') {
      const artifacts = await Promise.all(workflow.artifacts.map(async id => (await stored(services, 'artifacts.items', id)).value));
      const content = String(params.format ?? 'json') === 'markdown' ? `# ${workflow.goal}\n\n阶段: ${workflow.phase}\n变更类型: ${workflow.changeType}\n\n${artifacts.map(value => (value as { content: string }).content).join('\n\n---\n\n')}\n\n## 实际事件\n\n${workflow.events.map(event => `- ${JSON.stringify(event)}`).join('\n')}\n` : JSON.stringify({ schema: 'nexus-engineering-export/v1', workflow, artifacts }, null, 2);
      const result = await services.invoke('artifact', { action: 'create', params: { kind: String(params.format ?? 'json') === 'markdown' ? 'markdown' : 'evidence', title: `${workflow.goal} 交付`, content, sourceRefs: workflow.artifacts, mediaType: String(params.format ?? 'json') === 'markdown' ? 'text/markdown' : 'application/json' } }, context) as { id: string };
      if (typeof params.path === 'string') return services.invoke('artifact', { action: 'export', params: { artifactId: result.id, path: params.path, expectedHash: params.expectedHash } }, context);
      return result;
    }
    if (action === 'cancel') {
      workflow.executionState = 'cancelled';
      workflow.events.push({ type: 'cancel-requested', at: now(), reason: params.reason ?? 'user' });
      return services.store.put(collection, workflow.id, workflow, row.revision);
    }
    throw new NexusError('INVALID_ARGUMENT', '未知生命周期 action', { action });
  }
  return dispatch;
}
