import type { DispatchContext, JsonRecord } from '../../ports/contracts.js';
import { NexusError } from '../../ports/contracts.js';
import { DEFAULT_BUDGET, type Budget, type TaskNode, type TaskPlan } from './types.js';
import { digest, newId, now, object, safePath, text } from './util.js';

export function validatePlan(value: JsonRecord, context: DispatchContext = {}): TaskPlan {
  const raw = value.nodes;
  if (!Array.isArray(raw) || raw.length === 0) throw new NexusError('INVALID_ARGUMENT', '计划必须包含节点');
  const budget = { ...DEFAULT_BUDGET, ...(value.budgets ? object(value.budgets) : {}) } as Budget;
  for (const field of ['maxConcurrent', 'maxNodes', 'maxDepth', 'maxChildren', 'maxModelCalls', 'maxInputBytes', 'maxOutputBytes', 'maxWallMs', 'maxRetries'] as const) {
    if (!Number.isSafeInteger(budget[field]) || budget[field] < (field === 'maxRetries' ? 0 : 1)) throw new NexusError('INVALID_ARGUMENT', `预算 ${field} 无效`);
  }
  if (budget.maxConcurrent > 32 || raw.length > budget.maxNodes) throw new NexusError('BUDGET_EXHAUSTED', '计划超出节点或并发预算');
  const nodes = raw.map((item, i) => {
    const node = structuredClone(object(item, `nodes[${i}]`)) as unknown as TaskNode;
    node.id = node.id ?? newId('node');
    text(node.id, 'node.id', 128);
    if (!['agent', 'prompt', 'tool', 'cli', 'session', 'manual', 'approval', 'gate', 'synthesis', 'merge', 'export', 'review'].includes(node.kind)) throw new NexusError('INVALID_ARGUMENT', `不支持节点类型 ${node.kind}`);
    if (node.prompt !== undefined) text(node.prompt, 'prompt', budget.maxInputBytes);
    if (['agent', 'prompt', 'synthesis'].includes(node.kind) && !node.prompt) throw new NexusError('INVALID_ARGUMENT', `${node.id} 缺少 prompt`);
    if ((node.depth ?? 0) > budget.maxDepth) throw new NexusError('SCOPE_MISMATCH', '节点超出层级深度');
    if ((node.depth ?? 0) >= 4 && node.allowChildren) throw new NexusError('SCOPE_MISMATCH', 'L4 终端角色不得派生');
    if (context.workspaceRoot) node.cwd = node.cwd ? safePath(context.workspaceRoot, node.cwd) : context.workspaceRoot;
    if (node.writeClaims && (!Array.isArray(node.writeClaims) || node.writeClaims.some(p => typeof p !== 'string' || !p.trim()))) throw new NexusError('INVALID_ARGUMENT', 'writeClaims 必须为非空路径数组');
    if (context.workspaceRoot) node.writeClaims = node.writeClaims?.map(path => path.startsWith('service:') || path.startsWith('resource:') ? path.toLowerCase() : safePath(context.workspaceRoot!, path));
    if (node.dependsOn !== undefined && (!Array.isArray(node.dependsOn)
        || node.dependsOn.some(id => typeof id !== 'string' || !id.trim()))) {
      throw new NexusError('INVALID_ARGUMENT', 'dependsOn 必须为节点 ID 数组');
    }
    if (node.inputRefs !== undefined && (!Array.isArray(node.inputRefs) || node.inputRefs.length > 256
        || node.inputRefs.some(ref => typeof ref !== 'string' || !ref.trim() || ref.length > 256))) {
      throw new NexusError('INVALID_ARGUMENT', 'inputRefs 必须为至多 256 项的非空引用数组');
    }
    if (node.inputRefs) node.inputRefs = [...new Set(node.inputRefs)];
    return node;
  });
  const ids = new Set(nodes.map(n => n.id));
  if (ids.size !== nodes.length) throw new NexusError('INVALID_ARGUMENT', '节点 ID 重复');
  const resolvingParents = new Set<string>(), resolvedParents = new Set<string>();
  const resolveParent = (node: TaskNode): void => {
    if (!node.parentId || resolvedParents.has(node.id)) return;
    if (resolvingParents.has(node.id)) throw new NexusError('INVALID_ARGUMENT', 'parentId 层级闭环');
    resolvingParents.add(node.id);
    const parent = nodes.find(n => n.id === node.parentId);
    if (!parent) throw new NexusError('INVALID_ARGUMENT', 'parentId 必须引用冻结计划中的真实父节点');
    resolveParent(parent);
    if (!parent.allowChildren || !['coordinator', 'scope-coordinator', 'feature-coordinator', 'sweep-coordinator'].includes(parent.role ?? '')) throw new NexusError('SCOPE_MISMATCH', '普通专家没有递归派生权限', { reason: 'expert_recursion_denied', parentId: parent.id });
    if (nodes.filter(n => n.parentId === parent.id).length > budget.maxChildren) throw new NexusError('BUDGET_EXHAUSTED', '子节点超出 maxChildren');
    node.depth = (parent.depth ?? 0) + 1;
    if (node.depth > budget.maxDepth) throw new NexusError('SCOPE_MISMATCH', '递归超出冻结预算深度');
    resolvingParents.delete(node.id); resolvedParents.add(node.id);
  };
  nodes.forEach(resolveParent);
  const edges = (Array.isArray(value.edges) ? value.edges : []).map(e => object(e) as unknown as TaskPlan['edges'][number]);
  for (const node of nodes) for (const from of node.dependsOn ?? []) edges.push({ from, to: node.id });
  for (const edge of edges) if (!ids.has(edge.from) || !ids.has(edge.to)) throw new NexusError('INVALID_ARGUMENT', '依赖引用不存在节点', edge);
  const visited = new Set<string>(), stack: string[] = [];
  const walk = (id: string): void => {
    if (stack.includes(id)) throw new NexusError('INVALID_ARGUMENT', '依赖闭环', { cycle: [...stack.slice(stack.indexOf(id)), id] });
    if (visited.has(id)) return;
    stack.push(id);
    for (const edge of edges.filter(e => e.from === id)) walk(edge.to);
    stack.pop(); visited.add(id);
  };
  nodes.forEach(n => walk(n.id));
  for (const edge of edges.filter(edge => edge.kind === 'data')) {
    const target = nodes.find(node => node.id === edge.to)!;
    target.inputRefs = [...new Set([...(target.inputRefs ?? []), `node:${edge.from}`])];
  }
  for (const node of nodes) for (const ref of node.inputRefs ?? []) {
    const source = nodeInputSource(ref);
    if (source === undefined) continue;
    if (!['agent', 'prompt', 'synthesis'].includes(node.kind)) {
      throw new NexusError('INVALID_ARGUMENT', '节点结果数据输入仅支持 agent、prompt、synthesis 节点', { nodeId: node.id });
    }
    if (!ids.has(source) || source === node.id || !hasDependencyPath(source, node.id, edges)) {
      throw new NexusError('INVALID_ARGUMENT', '节点数据输入必须引用本计划依赖路径上的上游节点', {
        nodeId: node.id, sourceNodeId: source,
      });
    }
  }
  // Shared write surfaces are serialized before execution, including lockfiles and service resources.
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i]!, b = nodes[j]!;
    if ((a.writeClaims ?? []).some(p => (b.writeClaims ?? []).some(q => {
      const left = p.replaceAll('\\', '/').toLowerCase(), right = q.replaceAll('\\', '/').toLowerCase();
      return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
    }))) {
      if (!hasDependencyPath(b.id, a.id, edges) && !hasDependencyPath(a.id, b.id, edges)) edges.push({ from: a.id, to: b.id, kind: 'ownership' });
    }
  }
  const delivery = object(value.deliveryContract ?? {}, 'deliveryContract');
  const requiredNodeIds = Array.isArray(delivery.requiredNodeIds) ? delivery.requiredNodeIds as string[] : nodes.map(n => n.id);
  if (requiredNodeIds.some(id => !ids.has(id))) throw new NexusError('INVALID_ARGUMENT', '交付合同引用不存在节点');
  const plan: TaskPlan = {
    schemaVersion: 1, id: newId('plan'), goal: text(value.goal, 'goal', 20000),
    scope: typeof value.scope === 'string' ? value.scope : context.workspaceRoot ?? '',
    ownerSessionId: context.sessionId ?? 'local', createdAt: now(), updatedAt: now(),
    nodes, edges, budgets: budget, authorizationRefs: Array.isArray(value.authorizationRefs) ? value.authorizationRefs as string[] : [],
    deliveryContract: { requiredNodeIds, requireIndependentVerification: delivery.requireIndependentVerification === true, checks: Array.isArray(delivery.checks) ? delivery.checks as TaskPlan['deliveryContract']['checks'] : undefined },
    provenance: { source: 'nexus', actor: context.actorId ?? 'user' }, hash: '',
    ...(value.editor === undefined ? {} : { editor: editorLayout(value.editor, ids) }),
  };
  plan.hash = digest({ ...plan, hash: undefined });
  return plan;
}
export function hasDependencyPath(from: string, to: string, edges: TaskPlan['edges'], seen = new Set<string>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return edges.filter(e => e.from === from).some(e => hasDependencyPath(e.to, to, edges, seen));
}

export function nodeInputSource(reference: string): string | undefined {
  if (!reference.startsWith('node:')) return undefined;
  const id = reference.slice(5);
  if (!id || id.length > 128 || /[\u0000-\u001f]/.test(id)) {
    throw new NexusError('INVALID_ARGUMENT', 'node: 输入引用缺少有效节点 ID');
  }
  return id;
}

function editorLayout(value: unknown, nodeIds: Set<string>): NonNullable<TaskPlan['editor']> {
  const editor = object(value, 'editor');
  if (editor.schemaVersion !== 1 || Object.keys(editor).some(key => !['schemaVersion', 'layout'].includes(key))) {
    throw new NexusError('INVALID_ARGUMENT', 'editor 仅支持 schemaVersion:1 和 layout');
  }
  const layout = object(editor.layout, 'editor.layout');
  const entries = Object.entries(layout);
  if (nodeIds.size > 64 || entries.length > 64) throw new NexusError('INVALID_ARGUMENT', '可视工作流编辑器至多支持 64 个节点');
  return {
    schemaVersion: 1,
    layout: Object.fromEntries(entries.map(([id, value]) => {
      if (!nodeIds.has(id)) throw new NexusError('INVALID_ARGUMENT', '布局引用不存在的节点', { nodeId: id });
      const coordinates = object(value, `editor.layout.${id}`);
      if (Object.keys(coordinates).some(key => key !== 'x' && key !== 'y')
          || ![coordinates.x, coordinates.y].every(number => typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 20000)) {
        throw new NexusError('INVALID_ARGUMENT', '节点坐标必须为 0–20000 范围内的有限数值');
      }
      return [id, { x: coordinates.x as number, y: coordinates.y as number }];
    })),
  };
}
