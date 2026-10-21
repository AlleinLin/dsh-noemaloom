import type { Budget, Oracle, TaskNode, TaskPlan } from '../domain/workflow/types.js';
import type { Data, NexusScope } from './types.js';

export interface WorkflowPosition { x: number; y: number }
export interface WorkflowEdge { from: string; to: string; kind: 'data' | 'dependency'; optional?: boolean }
export interface WorkflowDraft {
  version: 1;
  goal: string;
  nodes: TaskNode[];
  edges: WorkflowEdge[];
  layout: Record<string, WorkflowPosition>;
  paramsText: Record<string, string>;
  checksText: Record<string, string>;
  budgets: Partial<Budget>;
  requiredNodeIds: string[];
  requireIndependentVerification: boolean;
  deliveryChecks?: TaskPlan['deliveryContract']['checks'];
  authorizationRefs?: string[];
  planScope?: string;
}
export const workflowNodeKinds = [
  { id: 'agent', label: '智能体' }, { id: 'prompt', label: '模型请求' },
  { id: 'synthesis', label: '汇总' }, { id: 'tool', label: '工具' },
  { id: 'cli', label: 'CLI' }, { id: 'manual', label: '人工任务' },
  { id: 'approval', label: '人工批准' },
] as const;
export const receivesWorkflowData = (node: TaskNode) => ['agent', 'prompt', 'synthesis'].includes(node.kind);
export function canonicalWorkflowScope(scope: NexusScope): NexusScope {
  const level = scope.level ?? 'session';
  if (level === 'global') return { level };
  if (level === 'workspace') {
    if (!scope.workspaceId) throw new Error('请选择工作区');
    return { level, workspaceId: scope.workspaceId };
  }
  if (!scope.sessionId) throw new Error('请打开一个会话');
  return { level, sessionId: scope.sessionId, ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}) };
}
export function workflowDraftKey(scope: NexusScope): string {
  const bound = canonicalWorkflowScope(scope);
  return `dsh-nexus:workflow-draft:v1:${encodeURIComponent(JSON.stringify([bound.level, bound.workspaceId ?? null, bound.sessionId ?? null]))}`;
}
export function newWorkflowDraft(): WorkflowDraft {
  return {
    version: 1, goal: '', nodes: [{ id: 'node-1', kind: 'agent', role: 'implementer', prompt: '', outputContracts: { nonEmpty: true } }],
    edges: [], layout: { 'node-1': { x: 70, y: 80 } }, paramsText: {}, checksText: {},
    budgets: { maxConcurrent: 4, maxModelCalls: 32, maxWallMs: 30 * 60 * 1000, maxRetries: 1 },
    requiredNodeIds: ['node-1'], requireIndependentVerification: false,
  };
}
/** A local draft may be incomplete, but must remain safe to display and edit. */
export function isWorkflowDraft(value: unknown): value is WorkflowDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as WorkflowDraft;
  const record = (candidate: unknown): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate);
  const strings = (candidate: unknown): candidate is string[] => Array.isArray(candidate) && candidate.every(item => typeof item === 'string');
  if (draft.version !== 1 || typeof draft.goal !== 'string' || !Array.isArray(draft.nodes) || draft.nodes.length > 64
    || !Array.isArray(draft.edges) || draft.edges.length > 1024 || !record(draft.layout)
    || !record(draft.paramsText) || !Object.values(draft.paramsText).every(item => typeof item === 'string')
    || !record(draft.checksText) || !Object.values(draft.checksText).every(item => typeof item === 'string')
    || !record(draft.budgets) || ['maxConcurrent', 'maxNodes', 'maxDepth', 'maxChildren', 'maxModelCalls', 'maxInputBytes', 'maxOutputBytes', 'maxWallMs', 'maxRetries'].some(field => {
      const item = draft.budgets[field as keyof Budget];
      return item !== undefined && (typeof item !== 'number' || !Number.isFinite(item));
    })
    || draft.authorizationRefs !== undefined && !strings(draft.authorizationRefs)
    || draft.planScope !== undefined && typeof draft.planScope !== 'string'
    || draft.deliveryChecks !== undefined && !Array.isArray(draft.deliveryChecks)
    || !strings(draft.requiredNodeIds) || typeof draft.requireIndependentVerification !== 'boolean') return false;
  const ids = new Set<string>();
  for (const node of draft.nodes) {
    if (!record(node) || typeof node.id !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(node.id) || ids.has(node.id)
      || !['agent', 'prompt', 'tool', 'cli', 'session', 'manual', 'approval', 'gate', 'synthesis', 'merge', 'export', 'review'].includes(node.kind)) return false;
    ids.add(node.id);
    for (const field of ['role', 'prompt', 'system', 'domain', 'action'] as const) if (node[field] !== undefined && typeof node[field] !== 'string') return false;
    if (node.inputRefs !== undefined && !strings(node.inputRefs) || node.writeClaims !== undefined && !strings(node.writeClaims)) return false;
    if (node.route !== undefined && (!record(node.route) || ['provider', 'model', 'reasoningEffort', 'reasoning_effort'].some(field => node.route?.[field as keyof NonNullable<TaskNode['route']>] !== undefined && typeof node.route?.[field as keyof NonNullable<TaskNode['route']>] !== 'string'))) return false;
    if (node.outputContracts !== undefined && (!record(node.outputContracts)
      || node.outputContracts.requiredFields !== undefined && !strings(node.outputContracts.requiredFields))) return false;
    const point = draft.layout[node.id];
    if (!record(point) || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > 20000 || point.y > 20000) return false;
  }
  return draft.edges.every(edge => record(edge) && typeof edge.from === 'string' && typeof edge.to === 'string'
    && ids.has(edge.from) && ids.has(edge.to) && ['data', 'dependency'].includes(edge.kind)
    && (edge.optional === undefined || typeof edge.optional === 'boolean'));
}
function jsonField<T>(text: string | undefined, fallback: T, name: string, array: boolean): T {
  if (text === undefined || !text.trim()) return fallback;
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${name} 不是有效 JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value) !== array) throw new Error(`${name} 必须为 JSON ${array ? '数组' : '对象'}`);
  return value as T;
}
export function workflowConnectionError(draft: WorkflowDraft, edge: WorkflowEdge): string | undefined {
  if (edge.from === edge.to) return '节点不能连接自身';
  const source = draft.nodes.find(node => node.id === edge.from), target = draft.nodes.find(node => node.id === edge.to);
  if (!source || !target) return '连线引用了不存在的节点';
  if (edge.kind === 'data' && ['manual', 'approval'].includes(source.kind)) return '人工节点不产生结果正文，请使用完成依赖';
  if (edge.kind === 'data' && !receivesWorkflowData(target)) return '数据流只能连接到智能体、模型请求或汇总节点';
  if (draft.edges.some(item => item.from === edge.from && item.to === edge.to)) return '这两个节点已连接';
  const seen = new Set<string>();
  const reaches = (from: string): boolean => {
    if (from === edge.from) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return draft.edges.filter(item => item.from === from).some(item => reaches(item.to));
  };
  return reaches(edge.to) ? '连线会形成循环' : undefined;
}
export const workflowEdgeId = (edge: Pick<WorkflowEdge, 'from' | 'to'>) => `${edge.from}:${edge.to}`;
const referencesNode = (check: Oracle, id: string) => check && typeof check === 'object'
  && (check.subjectNodeId === id || Array.isArray(check.authorNodeIds) && check.authorNodeIds.includes(id)
    || Array.isArray(check.reviewerNodeIds) && check.reviewerNodeIds.includes(id));
/** Remove dependent configuration with the node so reusing its ID cannot restore old contracts. */
export function removeWorkflowNode(draft: WorkflowDraft, id: string): WorkflowDraft {
  if (!draft.nodes.some(node => node.id === id)) return draft;
  const withoutKey = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([key]) => key !== id));
  const checksText = withoutKey(draft.checksText);
  for (const [key, text] of Object.entries(checksText)) {
    try {
      const checks: Oracle[] = JSON.parse(text);
      if (Array.isArray(checks) && checks.some(check => referencesNode(check, id))) {
        checksText[key] = JSON.stringify(checks.filter(check => !referencesNode(check, id)), null, 2);
      }
    } catch { /* Preserve incomplete JSON for its author to finish editing. */ }
  }
  return {
    ...draft,
    nodes: draft.nodes.filter(node => node.id !== id).map(node => ({
      ...node,
      ...(node.dependsOn ? { dependsOn: node.dependsOn.filter(source => source !== id) } : {}),
      ...(node.inputRefs ? { inputRefs: node.inputRefs.filter(ref => ref !== `node:${id}`) } : {}),
      ...(node.parentId === id ? { parentId: undefined, depth: 0 } : {}),
      ...(node.checks ? { checks: node.checks.filter(check => !referencesNode(check, id)) } : {}),
    })),
    edges: draft.edges.filter(edge => edge.from !== id && edge.to !== id),
    layout: withoutKey(draft.layout), paramsText: withoutKey(draft.paramsText), checksText,
    requiredNodeIds: draft.requiredNodeIds.filter(required => required !== id),
    ...(draft.deliveryChecks ? { deliveryChecks: draft.deliveryChecks.filter(check => !referencesNode(check, id)) } : {}),
  };
}
export function removeWorkflowEdge(draft: WorkflowDraft, id: string): WorkflowDraft {
  const edge = draft.edges.find(item => workflowEdgeId(item) === id);
  if (!edge) return draft;
  return {
    ...draft, edges: draft.edges.filter(item => workflowEdgeId(item) !== id),
    nodes: draft.nodes.map(node => node.id === edge.to ? {
      ...node,
      ...(node.dependsOn ? { dependsOn: node.dependsOn.filter(source => source !== edge.from) } : {}),
      ...(node.inputRefs ? { inputRefs: node.inputRefs.filter(ref => ref !== `node:${edge.from}`) } : {}),
    } : node),
  };
}
/** Validate edits against the remaining graph instead of treating an existing edge as a duplicate. */
export function updateWorkflowEdge(draft: WorkflowDraft, id: string, patch: Pick<Partial<WorkflowEdge>, 'kind' | 'optional'>): WorkflowDraft {
  const previous = draft.edges.find(item => workflowEdgeId(item) === id);
  if (!previous) throw new Error('连线已不存在');
  const kind = patch.kind ?? previous.kind;
  const next: WorkflowEdge = { from: previous.from, to: previous.to, kind,
    ...(kind === 'dependency' && (patch.optional ?? previous.optional) !== undefined ? { optional: patch.optional ?? previous.optional } : {}) };
  const remaining = removeWorkflowEdge(draft, id);
  const reason = workflowConnectionError(remaining, next);
  if (reason) throw new Error(reason);
  return { ...remaining, edges: draft.edges.map(edge => workflowEdgeId(edge) === id ? next : edge) };
}
export function workflowDeleteShortcut(event: {
  key: string; defaultPrevented?: boolean; isComposing?: boolean;
  altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean;
}, editingText: boolean): boolean {
  return !editingText && !event.defaultPrevented && !event.isComposing
    && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    && (event.key === 'Delete' || event.key === 'Backspace');
}
export function workflowPlanPayload(draft: WorkflowDraft): Data {
  if (!draft || draft.version !== 1 || !Array.isArray(draft.nodes) || !draft.nodes.length || draft.nodes.length > 64) throw new Error('工作流需要 1–64 个节点');
  if (!Array.isArray(draft.edges) || draft.edges.length > 1024) throw new Error('工作流连线数量超限');
  if (typeof draft.goal !== 'string' || !draft.goal.trim()) throw new Error('请填写工作流目标');
  const ids = new Set(draft.nodes.map(node => node.id));
  if (ids.size !== draft.nodes.length || draft.nodes.some(node => !/^[A-Za-z0-9_.-]{1,128}$/.test(node.id))) throw new Error('节点 ID 无效或重复');
  const checkedEdges: WorkflowEdge[] = [];
  for (const edge of draft.edges) {
    if (!['data', 'dependency'].includes(edge.kind)) throw new Error('连线类型无效');
    const error = workflowConnectionError({ ...draft, edges: checkedEdges }, edge);
    if (error) throw new Error(error);
    checkedEdges.push(edge);
  }
  const nodes = draft.nodes.map(node => {
    if (receivesWorkflowData(node) && !node.prompt?.trim()) throw new Error(`${node.id} 缺少执行指令`);
    if (node.kind === 'tool' && (!node.domain?.trim() || !node.action?.trim())) throw new Error(`${node.id} 缺少工具领域或动作`);
    if (node.timeoutMs !== undefined && (!Number.isSafeInteger(node.timeoutMs) || node.timeoutMs < 1000 || node.timeoutMs > 86400000)) throw new Error(`${node.id} 的超时应为 1–86400 秒`);
    if (Boolean(node.route?.provider) !== Boolean(node.route?.model)) throw new Error(`${node.id} 的提供方和模型必须一起设置`);
    const params = jsonField(draft.paramsText[node.id], node.params ?? {}, `${node.id} 参数`, false);
    const checks = jsonField(draft.checksText[node.id], node.checks ?? [], `${node.id} 验证规则`, true);
    const inputRefs = [...new Set([
      ...(node.inputRefs ?? []).filter(ref => !ref.startsWith('node:')),
      ...checkedEdges.filter(edge => edge.to === node.id && edge.kind === 'data').map(edge => `node:${edge.from}`),
    ])];
    return { ...node, params, checks, dependsOn: [], inputRefs };
  });
  const layout = Object.fromEntries(nodes.map(node => {
    const point = draft.layout[node.id];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > 20000 || point.y > 20000) throw new Error(`${node.id} 的位置无效`);
    return [node.id, { x: Math.round(point.x), y: Math.round(point.y) }];
  }));
  if (!draft.requiredNodeIds.length || draft.requiredNodeIds.some(id => !ids.has(id))) throw new Error('请选择有效的最终交付节点');
  return {
    goal: draft.goal.trim(), nodes, edges: checkedEdges.map(edge => ({ ...edge })), budgets: { ...draft.budgets },
    deliveryContract: { requiredNodeIds: [...new Set(draft.requiredNodeIds)], requireIndependentVerification: draft.requireIndependentVerification,
      ...(draft.deliveryChecks ? { checks: structuredClone(draft.deliveryChecks) } : {}) },
    ...(draft.authorizationRefs ? { authorizationRefs: [...draft.authorizationRefs] } : {}),
    ...(draft.planScope ? { scope: draft.planScope } : {}),
    editor: { schemaVersion: 1, layout },
  };
}
export function workflowDraftFromPlan(plan: TaskPlan & { editor?: { layout?: Record<string, WorkflowPosition> } }): WorkflowDraft {
  if (!Array.isArray(plan.nodes) || plan.nodes.length > 64) throw new Error('工作流节点数量超限');
  const nodes = structuredClone(plan.nodes);
  const edges: WorkflowEdge[] = [];
  for (const node of nodes) {
    for (const source of node.dependsOn ?? []) edges.push({ from: source, to: node.id, kind: node.inputRefs?.includes(`node:${source}`) ? 'data' : 'dependency' });
  }
  for (const edge of plan.edges ?? []) {
    const existing = edges.find(item => item.from === edge.from && item.to === edge.to);
    if (existing) { if (edge.optional !== undefined) existing.optional = edge.optional; }
    else edges.push({ from: edge.from, to: edge.to, kind: nodes.find(node => node.id === edge.to)?.inputRefs?.includes(`node:${edge.from}`) ? 'data' : 'dependency',
      ...(edge.optional !== undefined ? { optional: edge.optional } : {}) });
  }
  for (const node of nodes) for (const ref of node.inputRefs ?? []) if (ref.startsWith('node:')) {
    const from = ref.slice(5), existing = edges.find(edge => edge.from === from && edge.to === node.id);
    if (existing) existing.kind = 'data';
    else edges.push({ from, to: node.id, kind: 'data' });
  }
  return {
    version: 1, goal: plan.goal, nodes, edges,
    layout: Object.fromEntries(nodes.map((node, index) => [node.id, plan.editor?.layout?.[node.id] ?? { x: 70 + index % 3 * 310, y: 80 + Math.floor(index / 3) * 180 }])),
    paramsText: {}, checksText: {}, budgets: { ...plan.budgets }, requiredNodeIds: [...plan.deliveryContract.requiredNodeIds],
    requireIndependentVerification: plan.deliveryContract.requireIndependentVerification,
    deliveryChecks: structuredClone(plan.deliveryContract.checks), authorizationRefs: [...plan.authorizationRefs], planScope: plan.scope,
  };
}
export interface WorkflowModelOption { key: string; provider: string; model: string; efforts: string[] }
export function workflowModelOptions(value: Data): WorkflowModelOption[] {
  const source = Array.isArray(value?.items) ? value.items : [];
  const options = source.flatMap((item: Data) => {
    const provider = item.ref?.providerRouteId ?? item.provider, model = item.ref?.modelId ?? item.model ?? item.id;
    if (typeof provider !== 'string' || typeof model !== 'string') return [];
    const fact = item.capabilities?.reasoningEffort;
    const rawEfforts = fact?.state === 'unknown' || fact?.state === 'unsupported' ? [] : fact?.value ?? item.reasoningEfforts;
    return [{ key: JSON.stringify([provider, model]), provider, model, efforts: Array.isArray(rawEfforts) ? rawEfforts.filter((effort: unknown) => typeof effort === 'string') : [] }];
  });
  return [...new Map(options.map(option => [option.key, option])).values()];
}
