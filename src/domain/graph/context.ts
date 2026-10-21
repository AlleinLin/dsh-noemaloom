import { randomUUID } from 'node:crypto';
import { NexusError } from '../../ports/contracts.js';
import { hash, partitionContext, semanticNode, sha256 } from '../../upstream/thoughtdag/graph.js';
import type { ContextItem, GraphContextPlan, GraphNode, GraphSnapshot, SourceRef } from './types.js';

export const estimateTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
export const activeAnswer = (node: GraphNode): string => node.versions.find(version => version.id === node.activeVersionId)?.text ?? '';
export const nodeSource = (graph: GraphSnapshot, node: GraphNode): SourceRef => node.source ?? {
  sourceId: `graph:${graph.id}:${node.id}`, kind: 'graph', binding: 'live',
  revision: node.semanticRevision, immutableVersion: node.activeVersionId,
};

export function buildContextPlan(graph: GraphSnapshot, nodeId: string, options: {
  provider?: string; model?: string; outputReserveTokens?: number; hardWindowTokens?: number;
  recall?: { text: string; source: SourceRef }[];
} = {}): GraphContextPlan {
  const target = graph.nodes.find(node => node.id === nodeId);
  if (!target) throw new NexusError('NOT_FOUND', '画布节点不存在');
  if (target.archived) throw new NexusError('CTX-NODE-ARCHIVED', '请先恢复已归档节点');
  const { materials, references, mainline } = partitionContext(nodeId, graph);
  const items: ContextItem[] = [];
  const excluded: GraphContextPlan['excluded'] = [];
  const sourceRevisionSet: Record<string, string> = {};
  const seen = new Set<string>();
  const attachmentIds = new Set<string>();
  const include = new Set(target.includedAttachmentIds);
  const exclude = new Set(target.excludedAttachmentIds);
  for (const node of [...materials, ...mainline]) for (const id of node.excludedAttachmentIds) if (!include.has(id)) exclude.add(id);
  const source = (node: GraphNode): SourceRef => {
    const ref = nodeSource(graph, node);
    if (node.id !== nodeId || node.source) return ref;
    const semantic = semanticNode(node) as Record<string, unknown>;
    return { ...ref, immutableVersion: undefined, revision: hash({ ...semantic, activeVersionId: undefined, text: undefined, highlights: undefined }) };
  };
  const track = (node: GraphNode): void => {
    const semantic = semanticNode(node) as Record<string, unknown>;
    // The target's previous answer is never sent as its own input. Switching
    // or generating that answer must therefore not stale its frozen plan.
    sourceRevisionSet[`node:${node.id}`] = hash(node.id === nodeId
      ? { ...semantic, activeVersionId: undefined, text: undefined, highlights: undefined } : semantic);
  };
  const push = (kind: ContextItem['kind'], role: ContextItem['role'], content: string, node: GraphNode, reason: string,
    edgeId?: string, sourceOverride?: SourceRef, identity?: string): void => {
    if (!content) return;
    const ref = sourceOverride ?? source(node);
    const key = identity ?? `${node.id}:${node.activeVersionId ?? ''}:${kind}:${sha256(content)}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ id: `item:${sha256(key).slice(0, 24)}`, kind, role, content, source: ref,
      ordinal: items.length, estimatedTokens: estimateTokens(content), estimateMethod: 'utf8-quarter-v1', selected: true,
      transformIds: [], includedBecause: { nodeId: node.id, edgeId, reason } });
  };
  const attachments = (node: GraphNode): void => {
    for (const id of node.attachmentIds) {
      const material = graph.materials.find(item => item.id === id);
      if (!material) { excluded.push({ source: { sourceId: id, artifactId: id, kind: 'file', binding: 'pinned' }, reason: '材料原件不存在' }); continue; }
      const ref: SourceRef = material.source ?? { sourceId: `material:${id}`, artifactId: id, kind: 'file', binding: 'pinned',
        revision: material.extractionVersion, contentHash: material.contentHash };
      if (exclude.has(id) && !include.has(id)) { excluded.push({ source: ref, reason: '目标节点或继承规则已排除' }); continue; }
      const fingerprint = `${id}:${material.extractionVersion}`;
      if (attachmentIds.has(fingerprint)) continue;
      attachmentIds.add(fingerprint);
      sourceRevisionSet[`material:${id}`] = hash({ hash: material.contentHash, text: material.extractedText, version: material.extractionVersion });
      push('material', 'user', `[Material: ${material.name}; ${material.mimeType}; extraction=${material.extractionVersion}]\n${material.extractedText}`,
        node, '按明确的附件继承规则包含', undefined, ref, fingerprint);
    }
  };
  let role: string | undefined;
  if (target.roleSourceNodeId === '__none__') role = undefined;
  else if (target.roleSourceNodeId) {
    const roleNode = graph.nodes.find(node => node.id === target.roleSourceNodeId);
    if (!roleNode) throw new NexusError('CTX-SOURCE-CHANGED', '指定的角色来源不存在');
    track(roleNode); role = roleNode.rolePrompt;
  } else {
    for (let index = mainline.length - 1; index >= 0; index--) {
      const node = mainline[index], self = node.id === nodeId;
      if (node.roleMode === 'reset') { if (self) role = node.rolePrompt; break; }
      if (node.roleMode === 'set-next' && self) continue;
      if (node.rolePrompt) { role = node.rolePrompt; break; }
    }
  }
  if (role) push('system', 'system', role, target, '继承或明确选定的角色策略');
  for (const node of materials) {
    track(node);
    if (node.archived) { excluded.push({ source: source(node), reason: '材料节点已归档' }); continue; }
    attachments(node);
    if (node.id !== nodeId) push('material', 'user', `[${node.kind === 'note' ? 'Note' : 'Material'}: ${node.id}]\n${node.question}\n${activeAnswer(node)}`, node, '材料层');
  }
  for (const reference of references) {
    const { source: node, edge, chain } = reference;
    if (node.archived) { track(node); excluded.push({ source: source(node), reason: '引用来源已归档' }); continue; }
    if (edge.quote) {
      const quote = edge.quote;
      const version = node.versions.find(item => item.id === quote.sourceVersionId);
      if (!version || sha256(version.text.slice(quote.start, quote.end)) !== quote.textHash) {
        throw new NexusError('CTX-SOURCE-CHANGED', '引用选文已失效；请重新选择来源版本', { edgeId: edge.id });
      }
      const ref: SourceRef = { ...source(node), binding: 'pinned', immutableVersion: version.id, start: quote.start, end: quote.end, contentHash: quote.textHash };
      sourceRevisionSet[`quote:${edge.id}`] = hash({ versionId: version.id, quote });
      push('reference', 'user', `[Reference ${node.id}; version=${version.id}; range=${quote.start}:${quote.end}]\n${version.text.slice(quote.start, quote.end)}\n[/Reference]`,
        node, '明确的固定版本选文引用', edge.id, ref);
    } else {
      const lines: string[] = [];
      for (const ancestor of [...chain, node]) {
        track(ancestor);
        if (ancestor.archived) continue;
        const key = `reference:${ancestor.id}:${ancestor.activeVersionId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`[Source ${ancestor.id}; version=${ancestor.activeVersionId ?? 'none'}]\nQ: ${ancestor.question}\nA: ${activeAnswer(ancestor)}`);
      }
      push('reference', 'user', `[Reference; mode=${edge.contextMode}]\n${lines.join('\n\n')}\n[/Reference]`, node, '隔离引用块', edge.id);
    }
  }
  for (const recall of options.recall ?? []) push('recall', 'user', `[Recalled evidence]\n${recall.text}`, target, '用户选中的历史召回',
    undefined, recall.source, `recall:${hash(recall)}`);
  for (const node of mainline) {
    track(node);
    if (node.archived) { excluded.push({ source: source(node), reason: '节点已归档；跳过内容但保留祖先遍历' }); continue; }
    attachments(node);
    if (node.id === nodeId) continue;
    push('user', 'user', node.question, node, '按稳定拓扑顺序继承的问题');
    const version = node.versions.find(item => item.id === node.activeVersionId);
    const answer = version?.text ?? '';
    push('assistant', 'assistant', version?.stale ? `[Stale: input changed since this answer was generated]\n${answer}` : answer,
      node, '按稳定拓扑顺序继承的回答');
  }
  track(target);
  push('user', 'user', target.question, target, '本次问题始终最后');
  sourceRevisionSet.edges = hash(graph.edges.filter(edge => [...materials, ...mainline].some(node => node.id === edge.to)
    && (edge.kind === 'conversation' || edge.kind === 'explore' || edge.kind === 'reference')));
  const messages = items.map(item => ({ role: item.role, content: item.content }));
  const estimatedPromptTokens = items.reduce((sum, item) => sum + item.estimatedTokens, 0);
  const outputReserveTokens = options.outputReserveTokens ?? 2_048;
  if (!Number.isSafeInteger(outputReserveTokens) || outputReserveTokens < 1) throw new NexusError('INVALID_ARGUMENT', '输出预算必须是正整数');
  if (options.hardWindowTokens !== undefined && estimatedPromptTokens + outputReserveTokens > options.hardWindowTokens) {
    throw new NexusError('CTX-BUDGET-EXCEEDED', '当前明确选择的上下文超过窗口预算；请调整材料或使用压缩', {
      estimatedPromptTokens, outputReserveTokens, hardWindowTokens: options.hardWindowTokens, estimateMethod: 'utf8-quarter-v1' });
  }
  return { schemaVersion: 1, id: randomUUID(), graphId: graph.id, targetNodeId: nodeId, graphRevision: graph.semanticRevision,
    sourceRevisionSet, items, excluded, messages, builderVersion: 'thoughtdag-nexus-v1',
    providerId: options.provider ?? 'host-default', modelId: options.model ?? 'host-default',
    estimatedPromptTokens, outputReserveTokens, hardWindowTokens: options.hardWindowTokens,
    semanticHash: hash({ version: 'thoughtdag-nexus-v1', messages, sources: items.map(item => item.source), sourceRevisionSet,
      provider: options.provider ?? 'host-default', model: options.model ?? 'host-default', outputReserveTokens }),
    frozenAt: new Date().toISOString() };
}

export function validateContextPlan(plan: GraphContextPlan, graph: GraphSnapshot): void {
  const current = buildContextPlan(graph, plan.targetNodeId, {
    provider: plan.providerId, model: plan.modelId, outputReserveTokens: plan.outputReserveTokens, hardWindowTokens: plan.hardWindowTokens,
    recall: plan.items.filter(item => item.kind === 'recall').map(item => ({ text: item.content.replace(/^\[Recalled evidence\]\n/, ''), source: item.source })),
  });
  if (current.semanticHash !== plan.semanticHash) {
    const changed = Object.keys({ ...plan.sourceRevisionSet, ...current.sourceRevisionSet })
      .filter(key => plan.sourceRevisionSet[key] !== current.sourceRevisionSet[key]);
    throw new NexusError('CTX-PLAN-STALE', '预览之后输入来源已变化；请重新预览后发送', { changed, previousPlanId: plan.id, currentSemanticHash: current.semanticHash });
  }
}
