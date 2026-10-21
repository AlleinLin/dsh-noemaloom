import { randomUUID } from 'node:crypto';
import { NexusError, type Capability, type DispatchContext, type JsonRecord, type NexusModule, type NexusRequest, type NexusServices, type StoredRecord } from '../../ports/contracts.js';
import { adjacency, canonical, contextEdge, descendants, findCandidateSegments, hash, selectionSinks, semanticGraphHash, semanticNode, sha256, stableEdge, structural, validateEdge, validateGraph, walkUpAncestors } from '../../upstream/thoughtdag/graph.js';
import { projectSession } from '../../upstream/synapse/projection.js';
import { activeAnswer, buildContextPlan, estimateTokens, nodeSource, validateContextPlan } from './context.js';
import { createHistoryService } from './history.js';
import { graphActionSchema } from './schema.js';
import type { AnswerVersion, GraphContextPlan, GraphDocument, GraphEdge, GraphNode, GraphOperation, GraphSnapshot, Highlight, Material, SourceRef } from './types.js';

const GRAPHS = 'graphs';
const PLANS = 'graph-context-plans';
const OPERATIONS = 'graph-operations';
const LAYOUTS = 'graph-layouts';
const IDEMPOTENCY = 'graph-idempotency';
const now = (): string => new Date().toISOString();
const text = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
const number = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const jsonObject = (value: unknown): JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const required = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new NexusError('INVALID_ARGUMENT', `${name} 必须为非空字符串`);
  return value;
};
const nodeKinds = ['conversation', 'material', 'note', 'summary', 'reviewer', 'session'];
const edgeKinds = ['conversation', 'explore', 'reference', 'review', 'session-lineage', 'task-dependency', 'agent-communication'];
const highlightKinds = ['insight', 'decision', 'pivot', 'rule-out', 'open'];
const historyActions = ['atlas.sources', 'atlas.source.upsert', 'atlas.source.remove', 'atlas.index.clear', 'atlas.ingest', 'atlas.scan', 'atlas.sync', 'atlas.list', 'atlas.hide', 'atlas.restore',
  'atlas.watch.start', 'atlas.watch.stop', 'atlas.watch.status',
  'why.check', 'why.file', 'why.find', 'why.recall', 'recall', 'topic.list', 'topic.upsert', 'topic.dossier'];
const writes = new Set(['workspace.attach', 'create', 'update', 'delete', 'node.add', 'node.update', 'node.delete', 'node.archive', 'node.duplicate', 'node.convert', 'branch', 'wire', 'unlink',
  'edge.update', 'highlight.add', 'highlight.remove', 'version.select', 'material.add', 'material.update', 'material.extract', 'material.recognize', 'material.attach', 'layout', 'autoLayout', 'undo', 'redo', 'batch',
  'generate', 'replay', 'review', 'condense', 'merge', 'weave', 'import', 'atlas.mount', 'atlas.remirror', 'session.fork', 'session.prompt', 'operation.cancel',
  'atlas.source.upsert', 'atlas.source.remove', 'atlas.index.clear', 'atlas.ingest', 'atlas.scan', 'atlas.sync', 'atlas.hide', 'atlas.restore', 'atlas.watch.start', 'atlas.watch.stop', 'topic.upsert', 'topic.dossier']);

const descriptions: Record<string, string> = {
  'workspace.list': '浏览当前工作区画布，在会话中显式引用后创建独立干涉分支',
  'workspace.attach': '将已选工作区画布派生到当前会话；不修改工作区原件',
  list: '列出画布及结构统计', create: '创建持久画布', get: '读取画布与独立布局修订', update: '修改画布标题或归档状态', delete: '删除插件画布元数据，保留宿主会话',
  'node.add': '增加对话、材料、便签或审阅节点', 'node.update': '创建画布内容覆盖版本并标记受影响回答', 'node.delete': '删除画布节点与连线',
  'node.archive': '归档或恢复画布节点', 'node.duplicate': '复制节点及明确选定的后代', 'node.convert': '将节点转为便签或其它明确种类',
  branch: '从精确版本选文或现有节点创建探索分支', wire: '校验并添加类型明确的有向连线', unlink: '断开连线并立即改变后续上下文', 'edge.update': '修改引用深度或合并顺序并重新验证',
  'highlight.add': '保存精确版本范围及 SHA256 高光', 'highlight.remove': '移除所选高光', 'version.select': '选择既有回答版本',
  'material.add': '保存材料原件及独立提取版本', 'material.update': '保存新的提取文本版本，保留原件', 'material.extract': '经统一文件服务提取 PDF、DOCX、HTML 或文本并保留页码与原件',
  'material.recognize': '向支持图片的实际宿主模型提交原始图像及明确选区，保存识别或问答版本',
  'material.attach': '设置目标材料继承排除或包含',
  layout: '独立保存布局，保持语义和上下文 hash', autoLayout: '按拓扑布局且保留手动钉住坐标', undo: '撤销一次画布事务，保留真实模型和宿主副作用', redo: '重做一次画布事务', batch: '原子应用多个结构编辑',
  'context.preview': '冻结将实际发送的来源和上下文计划', 'context.validate': '核验预览是否仍有效', generate: '使用冻结预览调用实际宿主模型并保留版本和费用来源',
  replay: '按依赖顺序重放陈旧节点并隔离失败支路', review: '有最大波次和总调用上限的审阅',
  'condense.preview': '发现无分叉连续段及保护边界', condense: '生成保留所有原文和引用映射的凝练副本', merge: '汇总后原子添加节点，明确选择时归档未变化来源',
  weave: '只编织已选高光并校验输出逐条引用', diagnose: '检测陈旧回答、孤立节点、来源和引用问题', export: '导出附 manifest 和 SHA256 的 JSON、Markdown、结构图或旅程 SVG',
  import: '校验导入 Nexus、ThoughtDAG 或 Synapse 数据到新命名空间', 'atlas.mount': '将授权历史映射为增量镜像，保留手工覆盖版本', 'atlas.remirror': '重新投影镜像且保留用户编辑',
  'session.fork': '通过宿主从已完成轮次分支', 'session.open': '打开宿主原生聊天', 'session.prompt': '使用宿主队列继续会话', 'operation.list': '查询真实模型作业状态',
  'operation.cancel': '取消当前模型作业并保留已发生调用证据',
};
for (const action of historyActions) descriptions[action] ??= `授权历史与来源服务：${action}`;

export const graphCapabilities: Capability[] = Object.entries(descriptions).map(([action, description]) => ({
  action, description, mutating: writes.has(action),
  schema: graphActionSchema(action),
}));

function graphSnapshot(graph: GraphDocument): GraphSnapshot {
  const { history: _history, ...snapshot } = graph;
  return structuredClone(snapshot);
}

function nodeById(graph: GraphSnapshot, id: string): GraphNode {
  const node = graph.nodes.find(item => item.id === id);
  if (!node) throw new NexusError('NOT_FOUND', '画布节点不存在', { nodeId: id });
  return node;
}

function makeNode(graphId: string, input: JsonRecord, id = randomUUID()): GraphNode {
  const kind = text(input.kind, 'conversation');
  if (!nodeKinds.includes(kind)) throw new NexusError('INVALID_ARGUMENT', '不支持的节点种类');
  const node: GraphNode = { id, graphId, kind: kind as GraphNode['kind'], question: text(input.question, text(input.title)),
    answerVersionIds: [], versions: [], attachmentIds: strings(input.attachmentIds), excludedAttachmentIds: [],
    includedAttachmentIds: [], archived: false, x: number(input.x, 80), y: number(input.y, 80), highlights: [],
    createdAt: now(), semanticRevision: '', rolePrompt: text(input.rolePrompt) || undefined, roleMode: 'inherit' };
  if (typeof input.answer === 'string' || typeof input.response === 'string') {
    const versionId = randomUUID();
    node.versions.push({ id: versionId, nodeId: id, text: text(input.answer, text(input.response)), providerId: 'user-edited', modelId: 'manual',
      contextPlanId: '', inputHash: '', createdAt: now(), status: 'complete', stale: false, staleCauses: [], usageRequestIds: [], sourceRevisionSet: {} });
    node.answerVersionIds.push(versionId); node.activeVersionId = versionId;
  }
  node.semanticRevision = hash(semanticNode(node));
  return node;
}

function makeEdge(graph: GraphSnapshot, input: JsonRecord): GraphEdge {
  const kind = text(input.kind, 'conversation'), contextMode = text(input.contextMode, ['conversation', 'explore'].includes(kind) ? 'full' : kind === 'reference' ? 'quote' : 'none');
  if (!edgeKinds.includes(kind) || !['none', 'quote', 'full'].includes(contextMode)) throw new NexusError('INVALID_ARGUMENT', '不支持的连线种类或上下文模式');
  if (!['conversation', 'explore', 'reference'].includes(kind) && contextMode !== 'none') throw new NexusError('INVALID_ARGUMENT', '血缘、任务、通信或审阅关系不能隐式贡献模型上下文');
  return { id: text(input.id, randomUUID()), graphId: graph.id, from: required(input.from, 'from'), to: required(input.to, 'to'),
    kind: kind as GraphEdge['kind'], contextMode: contextMode as GraphEdge['contextMode'], order: number(input.order, 0),
    ...(input.quote ? { quote: jsonObject(input.quote) as unknown as GraphEdge['quote'] } : {}) };
}

function markStale(graph: GraphDocument): void {
  for (const node of graph.nodes) {
    node.semanticRevision = hash(semanticNode(node));
    for (const version of node.versions) {
      if (!Object.keys(version.sourceRevisionSet).length) continue;
      if (!version.contextPlanId) {
        const changed = Object.entries(version.sourceRevisionSet).filter(([key, value]) => {
          if (!key.startsWith('node:')) return false;
          const source = graph.nodes.find(item => item.id === key.slice(5));
          return !source || hash(semanticNode(source)) !== value;
        });
        version.stale = changed.length > 0;
        version.staleCauses = changed.map(([key]) => ({ sourceId: key, kind: 'graph', binding: 'live' }));
        continue;
      }
      try {
        const plan = buildContextPlan(graph, node.id, { provider: version.providerId, model: version.modelId });
        const keys = new Set([...Object.keys(version.sourceRevisionSet), ...Object.keys(plan.sourceRevisionSet)]);
        const changed = [...keys].filter(key => version.sourceRevisionSet[key] !== plan.sourceRevisionSet[key]);
        version.stale = changed.length > 0;
        version.staleCauses = changed.map(key => ({ sourceId: key, kind: 'graph', binding: 'live', revision: plan.sourceRevisionSet[key] }));
      } catch {
        version.stale = true;
        version.staleCauses = [{ sourceId: `graph:${graph.id}`, kind: 'graph', binding: 'live', revision: graph.semanticRevision }];
      }
    }
  }
}

function applyEdit(graph: GraphDocument, action: string, params: JsonRecord): unknown {
  if (action === 'update') {
    if (typeof params.title === 'string') graph.title = params.title.trim() || graph.title;
    if (typeof params.archived === 'boolean') graph.archived = params.archived;
    return { id: graph.id };
  }
  if (action === 'node.add') {
    const node = makeNode(graph.id, jsonObject(params.node ?? params)); graph.nodes.push(node);
    if (typeof params.parentId === 'string') {
      const edge = makeEdge(graph, { from: params.parentId, to: node.id, kind: params.edgeKind ?? 'conversation' });
      validateEdge(graph, edge); graph.edges.push(edge);
    }
    return node;
  }
  if (action === 'node.update') {
    const node = nodeById(graph, required(params.nodeId, 'nodeId'));
    const patch = jsonObject(params.patch ?? params);
    for (const field of ['question', 'rolePrompt'] as const) if (typeof patch[field] === 'string') node[field] = patch[field];
    if (patch.roleMode && ['inherit', 'reset', 'set-next'].includes(text(patch.roleMode))) node.roleMode = patch.roleMode as GraphNode['roleMode'];
    if (typeof patch.roleSourceNodeId === 'string') node.roleSourceNodeId = patch.roleSourceNodeId;
    if (typeof patch.protected === 'boolean') node.protected = patch.protected;
    if (typeof patch.moveKind === 'string' && highlightKinds.includes(patch.moveKind)) node.moveKind = patch.moveKind as GraphNode['moveKind'];
    if (typeof patch.answer === 'string') {
      const id = randomUUID();
      node.versions.push({ id, nodeId: node.id, previousId: node.activeVersionId, text: patch.answer, providerId: 'user-edited', modelId: 'manual',
        contextPlanId: '', inputHash: '', createdAt: now(), status: 'complete', stale: false, staleCauses: [], usageRequestIds: [], sourceRevisionSet: {} });
      node.answerVersionIds.push(id); node.activeVersionId = id;
    }
    if (node.sourceSessionId) node.mirrorEdited = true;
    return node;
  }
  if (action === 'node.archive' || action === 'node.delete') {
    const ids = strings(params.nodeIds);
    if (!ids.length) ids.push(required(params.nodeId, 'nodeId'));
    const affected = new Set(params.includeDescendants === true ? [...ids, ...descendants(ids, graph.edges.filter(structural))] : ids);
    for (const id of ids) nodeById(graph, id);
    if (action === 'node.archive') {
      for (const node of graph.nodes) if (affected.has(node.id)) node.archived = params.archived !== false;
    } else { graph.nodes = graph.nodes.filter(node => !affected.has(node.id)); graph.edges = graph.edges.filter(edge => !affected.has(edge.from) && !affected.has(edge.to)); }
    return { affected: [...affected], hostSessionsUnchanged: true };
  }
  if (action === 'node.convert') {
    const node = nodeById(graph, required(params.nodeId, 'nodeId')), kind = text(params.kind, 'note');
    if (!nodeKinds.includes(kind)) throw new NexusError('INVALID_ARGUMENT', '不支持的节点种类');
    node.kind = kind as GraphNode['kind'];
    return node;
  }
  if (action === 'node.duplicate') {
    const ids = strings(params.nodeIds);
    if (!ids.length) ids.push(required(params.nodeId, 'nodeId'));
    const selected = new Set(params.includeDescendants === true ? [...ids, ...descendants(ids, graph.edges.filter(structural))] : ids);
    const mapping = new Map<string, string>(), copies: GraphNode[] = [];
    for (const id of selected) {
      const original = nodeById(graph, id), copy = structuredClone(original), newId = randomUUID();
      mapping.set(id, newId); copy.id = newId; copy.x += 560; copy.y += 40; copy.createdAt = now();
      const versionIds = new Map(copy.versions.map(version => [version.id, randomUUID()]));
      for (const version of copy.versions) { version.nodeId = newId; version.id = versionIds.get(version.id)!; if (version.previousId) version.previousId = versionIds.get(version.previousId); }
      copy.answerVersionIds = copy.answerVersionIds.map(id => versionIds.get(id)!);
      if (copy.activeVersionId) copy.activeVersionId = versionIds.get(copy.activeVersionId);
      copy.highlights = copy.highlights.map(item => ({ ...item, id: randomUUID(), nodeId: newId, versionId: versionIds.get(item.versionId)! }));
      copy.derivedFrom = [{ nodeId: original.id, versionId: original.activeVersionId, contentHash: hash(semanticNode(original)) }];
      copy.sourceSessionId = undefined; copy.sourceTurnId = undefined; copy.mirrorEdited = undefined;
      copies.push(copy);
    }
    const edges = graph.edges.filter(edge => selected.has(edge.from) && selected.has(edge.to)).map(edge => ({ ...structuredClone(edge), id: randomUUID(), from: mapping.get(edge.from)!, to: mapping.get(edge.to)! }));
    graph.nodes.push(...copies);
    for (const edge of edges) { validateEdge(graph, edge); graph.edges.push(edge); }
    return { mapping: Object.fromEntries(mapping), nodes: copies };
  }
  if (action === 'branch') {
    const parent = nodeById(graph, required(params.nodeId ?? params.from, 'nodeId'));
    const node = makeNode(graph.id, { question: text(params.question), x: parent.x + 560, y: parent.y + 100 });
    graph.nodes.push(node);
    let quote: GraphEdge['quote'];
    if (params.start !== undefined || params.end !== undefined) {
      const version = parent.versions.find(item => item.id === text(params.versionId, parent.activeVersionId));
      const start = number(params.start, -1), end = number(params.end, -1);
      if (!version || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > version.text.length) throw new NexusError('CTX-SOURCE-CHANGED', '分支选文范围或版本无效');
      quote = { sourceVersionId: version.id, start, end, textHash: sha256(version.text.slice(start, end)) };
      const reference = makeEdge(graph, { from: parent.id, to: node.id, kind: 'reference', contextMode: 'quote', quote });
      validateEdge(graph, reference); graph.edges.push(reference);
    }
    const edge = makeEdge(graph, { from: parent.id, to: node.id, kind: 'explore', contextMode: 'full' });
    validateEdge(graph, edge); graph.edges.push(edge);
    return { node, edge, quote };
  }
  if (action === 'wire') {
    const edge = makeEdge(graph, params); validateEdge(graph, edge); graph.edges.push(edge); return edge;
  }
  if (action === 'edge.update') {
    const id = required(params.edgeId, 'edgeId'), previous = graph.edges.find(edge => edge.id === id);
    if (!previous) throw new NexusError('NOT_FOUND', '连线不存在');
    const edge = makeEdge(graph, { ...previous, ...jsonObject(params.patch ?? params), id });
    const remaining = graph.edges.filter(item => item.id !== id);
    validateEdge(graph, edge, remaining); graph.edges = [...remaining, edge]; return edge;
  }
  if (action === 'unlink') {
    const removed = graph.edges.filter(edge => params.edgeId ? edge.id === params.edgeId : edge.from === params.from && edge.to === params.to);
    if (!removed.length) throw new NexusError('NOT_FOUND', '连线不存在');
    const ids = new Set(removed.map(edge => edge.id)); graph.edges = graph.edges.filter(edge => !ids.has(edge.id));
    return { removed: [...ids], nodesAndAnswersRetained: true };
  }
  if (action === 'version.select') {
    const node = nodeById(graph, required(params.nodeId, 'nodeId')), id = required(params.versionId, 'versionId');
    if (!node.versions.some(version => version.id === id)) throw new NexusError('NOT_FOUND', '回答版本不存在');
    node.activeVersionId = id; if (node.sourceSessionId) node.mirrorEdited = true; return node;
  }
  if (action === 'highlight.add') {
    const node = nodeById(graph, required(params.nodeId, 'nodeId'));
    const version = node.versions.find(item => item.id === text(params.versionId, node.activeVersionId));
    const start = number(params.start, -1), end = number(params.end, -1), kind = text(params.kind, 'insight');
    if (!version || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > version.text.length || !highlightKinds.includes(kind)) throw new NexusError('CTX-SOURCE-CHANGED', '高光版本、范围或种类无效');
    const selected = version.text.slice(start, end);
    if (params.textHash && params.textHash !== sha256(selected)) throw new NexusError('CTX-SOURCE-CHANGED', '高光内容已变化，请重新选择');
    const highlight: Highlight = { id: randomUUID(), nodeId: node.id, versionId: version.id, start, end, text: selected,
      textHash: sha256(selected), kind: kind as Highlight['kind'], ...(typeof params.page === 'number' ? { page: params.page } : {}) };
    node.highlights.push(highlight); return highlight;
  }
  if (action === 'highlight.remove') {
    const node = nodeById(graph, required(params.nodeId, 'nodeId')), id = required(params.highlightId, 'highlightId');
    node.highlights = node.highlights.filter(item => item.id !== id); return { removed: id };
  }
  if (action === 'material.add') {
    const input = jsonObject(params.material ?? params);
    const originalText = typeof input.originalText === 'string' ? input.originalText : typeof input.text === 'string' ? input.text : undefined;
    const originalBase64 = typeof input.originalBase64 === 'string' ? input.originalBase64 : undefined;
    if (originalText === undefined && originalBase64 === undefined) throw new NexusError('INVALID_ARGUMENT', '材料必须提供完整原始文本或 base64 原件');
    const bytes = originalBase64 !== undefined ? Buffer.from(originalBase64, 'base64') : Buffer.from(originalText!, 'utf8');
    if (bytes.length > 64 * 1024 * 1024) throw new NexusError('CTX-IMPORT-LIMIT', '材料超过 64 MiB 上限');
    const id = randomUUID(), extractionVersion = randomUUID(), extractedText = text(input.extractedText, originalText ?? '');
    const material: Material = { id, name: required(input.name, 'name'), mimeType: text(input.mimeType, 'text/plain'), originalText, originalBase64,
      contentHash: sha256(bytes), extractedText, extractionVersion, versions: [{ id: extractionVersion, text: extractedText, createdAt: now(), extractor: text(input.extractor, 'user-supplied') }] };
    graph.materials.push(material);
    if (params.nodeId) nodeById(graph, text(params.nodeId)).attachmentIds.push(id);
    return material;
  }
  if (action === 'material.update') {
    const material = graph.materials.find(item => item.id === params.materialId);
    if (!material) throw new NexusError('NOT_FOUND', '材料不存在');
    const id = randomUUID(), extractedText = required(params.extractedText, 'extractedText');
    material.versions.push({ id, text: extractedText, createdAt: now(), extractor: text(params.extractor, 'user-edited') });
    material.extractedText = extractedText; material.extractionVersion = id; return material;
  }
  if (action === 'material.attach') {
    const node = nodeById(graph, required(params.nodeId, 'nodeId')), id = required(params.materialId, 'materialId');
    if (!graph.materials.some(material => material.id === id)) throw new NexusError('NOT_FOUND', '材料不存在');
    if (!node.attachmentIds.includes(id)) node.attachmentIds.push(id);
    node.excludedAttachmentIds = node.excludedAttachmentIds.filter(item => item !== id);
    node.includedAttachmentIds = node.includedAttachmentIds.filter(item => item !== id);
    if (params.mode === 'exclude') node.excludedAttachmentIds.push(id);
    if (params.mode === 'include') node.includedAttachmentIds.push(id);
    return node;
  }
  throw new NexusError('UNKNOWN_ACTION', `不支持的结构编辑：${action}`);
}

export function createGraphModule(services: NexusServices): NexusModule {
  const history = createHistoryService(services);
  const activeOperations = new Map<string, AbortController>();
  const activeNodes = new Set<string>();
  const inFlight = new Map<string, Promise<unknown>>();
  const tasks = new Set<Promise<unknown>>();
  let disposed = false;
  const graphIdOf = (request: NexusRequest): string => required(request.params?.graphId ?? request.target?.id, 'graphId');
  const load = async (id: string): Promise<StoredRecord<GraphDocument>> => {
    const record = await services.store.get<GraphDocument>(GRAPHS, id);
    if (!record) throw new NexusError('NOT_FOUND', '画布不存在');
    return record;
  };
  const present = async (record: StoredRecord<GraphDocument>) => {
    const layout = await services.store.get<{ nodes: Record<string, JsonRecord>; viewport?: JsonRecord }>(LAYOUTS, record.id);
    const graph = graphSnapshot(record.value);
    if (layout) for (const node of graph.nodes) Object.assign(node, layout.value.nodes[node.id] ?? {});
    return { ...graph, revision: record.revision, layoutRevision: layout?.revision ?? 0, viewport: layout?.value.viewport,
      undoAvailable: record.value.history.past.length > 0, redoAvailable: record.value.history.future.length > 0 };
  };
  const verifyRevision = (record: StoredRecord<GraphDocument>, expected?: number): void => {
    if (expected !== undefined && expected !== record.revision) throw new NexusError('CTX-REVISION-CONFLICT', '画布已由另一操作修改，请刷新后重放补丁', { expectedRevision: expected, currentRevision: record.revision });
  };
  const commit = async (record: StoredRecord<GraphDocument>, graph: GraphDocument, undo = true) => {
    validateGraph(graph);
    if (undo) { graph.history.past.push(graphSnapshot(record.value)); graph.history.past = graph.history.past.slice(-100); graph.history.future = []; }
    markStale(graph); graph.semanticRevision = semanticGraphHash(graph); graph.updatedAt = now();
    const saved = await services.store.put(GRAPHS, graph.id, graph, record.revision);
    services.emit('graph:changed', { graphId: graph.id, revision: saved.revision, semanticRevision: graph.semanticRevision });
    return saved;
  };
  const runModel = async (graph: GraphDocument, kind: string, nodeId: string | undefined, params: JsonRecord, context: DispatchContext | undefined,
    execute: (operation: GraphOperation, controller: AbortController) => Promise<unknown>): Promise<unknown> => {
    const activeKey = nodeId ? `${graph.id}:${nodeId}` : undefined;
    if (activeKey && activeNodes.has(activeKey)) throw new NexusError('CTX-OPERATION-ACTIVE', '此节点已有模型作业；请先取消或显式创建比较分支');
    if (activeKey) activeNodes.add(activeKey);
    const operation: GraphOperation = { schemaVersion: 1, id: randomUUID(), graphId: graph.id, nodeId, kind, status: 'running', startedAt: now(), modelCalls: 0, externalEffects: [] };
    const controller = new AbortController();
    const abort = () => controller.abort();
    const signal = context?.signal ?? services.signal;
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
    activeOperations.set(operation.id, controller);
    await services.store.put(OPERATIONS, operation.id, operation, 0);
    services.emit('graph:operation', operation);
    try {
      controller.signal.throwIfAborted();
      const result = await execute(operation, controller);
      operation.status = 'succeeded'; operation.result = result; operation.finishedAt = now();
      const stored = await services.store.get<GraphOperation>(OPERATIONS, operation.id);
      await services.store.put(OPERATIONS, operation.id, operation, stored?.revision);
      services.emit('graph:operation', operation);
      return { operationId: operation.id, status: operation.status, result };
    } catch (error) {
      const code = error instanceof NexusError ? error.code : controller.signal.aborted ? 'CTX-CANCELLED' : 'CTX-MODEL-FAILED';
      operation.status = controller.signal.aborted ? 'cancelled' : code === 'CTX-PLAN-STALE' || code === 'CTX-REVISION-CONFLICT' ? 'orphaned' : 'failed';
      operation.error = { code, message: error instanceof Error ? error.message : '模型作业失败' }; operation.finishedAt = now();
      const stored = await services.store.get<GraphOperation>(OPERATIONS, operation.id);
      await services.store.put(OPERATIONS, operation.id, operation, stored?.revision);
      services.emit('graph:operation', operation);
      throw new NexusError(code, operation.error.message, { operationId: operation.id });
    } finally {
      activeOperations.delete(operation.id); if (activeKey) activeNodes.delete(activeKey);
      signal?.removeEventListener('abort', abort);
    }
  };
  const callModel = async (operation: GraphOperation, controller: AbortController, params: JsonRecord, prompt: string, role: string, system?: string) => {
    const maxCalls = number(params.maxCalls, 32);
    if (operation.modelCalls >= maxCalls) throw new NexusError('CTX-BUDGET-EXCEEDED', '本次模型调用次数达到上限');
    operation.modelCalls++; operation.externalEffects.push('实际模型请求已发起；撤销不会撤销已发生的费用');
    const attemptId = randomUUID(), logicalCallId = `${operation.id}:${operation.modelCalls}`;
    const running = await services.store.get<GraphOperation>(OPERATIONS, operation.id);
    await services.store.put(OPERATIONS, operation.id, operation, running?.revision);
    services.emit('graph:operation', operation);
    let response;
    try {
      response = await services.host.model({ role, prompt, system, provider: text(params.provider) || undefined, model: text(params.model) || undefined,
        sessionId: text(params.sessionId) || undefined, signal: controller.signal, maxTokens: number(params.maxTokens, 4_096), logicalCallId, attemptId,
        ...(Array.isArray(params.messages) ? { messages: params.messages } : {}),
        ...(Array.isArray(params.images) ? { images: params.images } : {}) });
    } catch (error) {
      await services.store.put('graph-model-evidence', attemptId, { operationId: operation.id, logicalCallId, attemptId, role,
        provider: params.provider, model: params.model, status: controller.signal.aborted ? 'cancelled' : 'failed',
        errorCode: error instanceof NexusError ? error.code : 'CTX-MODEL-FAILED', recordedAt: now() }, 0);
      throw error;
    }
    await services.store.put('graph-model-evidence', attemptId, { operationId: operation.id, logicalCallId, attemptId, role,
      provider: response.provider, model: response.model, usage: response.usage, providerRequestId: response.providerRequestId, evidence: response.evidence, recordedAt: now() }, 0);
    controller.signal.throwIfAborted();
    if (!response.text.trim()) throw new NexusError('CTX-MODEL-EMPTY', '模型返回空文本；保留原图');
    return { ...response, logicalCallId, attemptId };
  };
  const freeze = async (graph: GraphDocument, nodeId: string, params: JsonRecord): Promise<GraphContextPlan> => {
    const recall = Array.isArray(params.recall) ? params.recall as { text: string; source: SourceRef }[] : undefined;
    const plan = buildContextPlan(graph, nodeId, { provider: text(params.provider) || undefined, model: text(params.model) || undefined,
      hardWindowTokens: typeof params.hardWindowTokens === 'number' ? params.hardWindowTokens : undefined,
      outputReserveTokens: number(params.outputReserveTokens, 2_048), recall });
    await services.store.put(PLANS, plan.id, plan, 0); return plan;
  };
  const generate = async (request: NexusRequest, context?: DispatchContext): Promise<unknown> => {
    const params = request.params ?? {}, record = await load(graphIdOf(request));
    verifyRevision(record, request.expectedRevision);
    const nodeId = required(params.nodeId, 'nodeId'), target = nodeById(record.value, nodeId);
    const planRecord = typeof params.planId === 'string' ? await services.store.get<GraphContextPlan>(PLANS, params.planId) : undefined;
    const plan = planRecord?.value ?? await freeze(record.value, nodeId, params);
    if (plan.graphId !== record.id || plan.targetNodeId !== nodeId) throw new NexusError('CTX-PLAN-STALE', '该预览不属于当前目标节点');
    validateContextPlan(plan, record.value);
    return runModel(record.value, 'generate', nodeId, params, context, async (operation, controller) => {
      const prompt = plan.messages.filter(message => message.role !== 'system').map(message => `[${message.role}]\n${message.content}`).join('\n\n');
      const response = await callModel(operation, controller, { ...params, provider: plan.providerId === 'host-default' ? undefined : plan.providerId,
        model: plan.modelId === 'host-default' ? undefined : plan.modelId, messages: plan.messages.filter(message => message.role !== 'system') },
        prompt, 'graph-answer', plan.messages.filter(message => message.role === 'system').map(message => message.content).join('\n'));
      const latest = await load(record.id);
      try { validateContextPlan(plan, latest.value); }
      catch (error) {
        await services.store.put('graph-orphan-results', operation.id, { operationId: operation.id, graphId: record.id, nodeId, plan, response, createdAt: now() }, 0);
        throw error;
      }
      const graph = structuredClone(latest.value), node = nodeById(graph, nodeId), id = randomUUID();
      const version: AnswerVersion = { id, nodeId, previousId: node.activeVersionId, text: response.text, providerId: response.provider ?? plan.providerId, modelId: response.model ?? plan.modelId,
        contextPlanId: plan.id, inputHash: plan.semanticHash, createdAt: now(), status: 'complete', stale: false, staleCauses: [],
        usageRequestIds: [response.logicalCallId, response.attemptId], sourceRevisionSet: plan.sourceRevisionSet };
      node.versions.push(version); node.answerVersionIds.push(id); node.activeVersionId = id;
      if (node.sourceSessionId) node.mirrorEdited = true;
      const saved = await commit(latest, graph);
      return { nodeId: target.id, version, revision: saved.revision, planId: plan.id,
        actualProvider: response.provider, actualModel: response.model, usage: response.usage };
    });
  };
  const transform = async (request: NexusRequest, context?: DispatchContext): Promise<unknown> => {
    const params = request.params ?? {}, action = request.action, record = await load(graphIdOf(request));
    verifyRevision(record, request.expectedRevision);
    const sourceGraph = structuredClone(record.value);
    const nodeIds = strings(params.nodeIds);
    const selected = nodeIds.map(id => nodeById(sourceGraph, id));
    return runModel(sourceGraph, action, undefined, params, context, async (operation, controller) => {
      if (action === 'condense') {
        const candidates = findCandidateSegments(sourceGraph, nodeIds.length ? nodeIds : undefined);
        const requested = Array.isArray(params.segments) ? params.segments as { nodeIds: string[] }[] : undefined;
        const segments = requested ? requested.map(segment => {
          const found = candidates.find(candidate => canonical(candidate.nodeIds) === canonical(segment.nodeIds));
          if (!found) throw new NexusError('CTX-COMPRESSION-INVALID', '所选凝练段跨越分叉、前沿或保留的决定/选文边界');
          return found;
        }) : candidates;
        if (!segments.length) throw new NexusError('CTX-COMPRESSION-INVALID', '没有至少三个完整轮次构成的安全连续段；决定、分叉和最近三轮保持原样');
        const responses: string[] = [];
        for (const [index, segment] of segments.entries()) {
          controller.signal.throwIfAborted();
          const turns = segment.nodeIds.map(id => nodeById(sourceGraph, id));
          const input = turns.map((node, offset) => `[Source S${offset + 1}; node=${node.id}; version=${node.activeVersionId}; sha256=${sha256(activeAnswer(node))}]\nQ: ${node.question}\nA: ${activeAnswer(node)}`).join('\n\n');
          const maxInputTokens = number(params.maxInputTokens, 64_000);
          if (estimateTokens(input) > maxInputTokens) throw new NexusError('CTX-BUDGET-EXCEEDED', '凝练段超过本次输入预算，请选择更小的连续段');
          const response = await callModel(operation, controller, params,
            `将以下完整连续对话写为${text(params.language, '中文')}蒸馏稿，保留仍有效的决定、约束、精确值、转折与未决项。每个事实要点引用 [S编号]。只引用所提供来源，不能生成不存在的编号。\n先前段落只用于连贯性：\n${responses.join('\n')}\n\n本段完整原文：\n${input}`,
            'graph-condense');
          const citations = [...response.text.matchAll(/\[S(\d+)\]/g)].map(match => Number(match[1]));
          if (!citations.length || citations.some(value => value < 1 || value > turns.length)) throw new NexusError('CTX-COMPRESSION-INVALID', '凝练稿缺少有效原文引用，原图保持不变');
          const highlights = segment.protectedHighlights.map(value => `> ${value.replace(/\n/g, '\n> ')}`).join('\n\n');
          responses.push(`${response.text}${highlights ? `\n\n### 高光（原文保真）\n${highlights}` : ''}`);
          services.emit('graph:operation-progress', { operationId: operation.id, current: index + 1, total: segments.length, kind: 'condense' });
        }
        const latest = await load(record.id);
        if (latest.revision !== record.revision) {
          await services.store.put('graph-orphan-results', operation.id, { graphId: record.id, kind: action, sourceRevision: record.revision, segments, responses, createdAt: now() }, 0);
          throw new NexusError('CTX-REVISION-CONFLICT', '凝练期间原图已修改；候选已保留，未添加部分副本');
        }
        const graph = structuredClone(latest.value), mapping = new Map<string, string>(), versionMappings = new Map<string, Map<string, string>>();
        const membership = new Set(segments.flatMap(segment => segment.nodeIds));
        const copies: GraphNode[] = [], summaries: GraphNode[] = [];
        const minX = Math.min(0, ...sourceGraph.nodes.map(node => node.x)), maxX = Math.max(0, ...sourceGraph.nodes.map(node => node.x));
        const offsetX = maxX - minX + 900;
        segments.forEach((segment, index) => {
          const head = nodeById(sourceGraph, segment.nodeIds[0]), tail = nodeById(sourceGraph, segment.nodeIds.at(-1)!);
          const summary = makeNode(graph.id, { kind: 'summary', question: `凝练：${head.question.slice(0, 70)} → ${tail.question.slice(0, 70)}`,
            answer: responses[index], x: head.x + offsetX, y: head.y });
          summary.derivedFrom = segment.nodeIds.map(id => { const source = nodeById(sourceGraph, id); return { nodeId: id, versionId: source.activeVersionId, contentHash: hash(semanticNode(source)) }; });
          for (const id of segment.nodeIds) mapping.set(id, summary.id);
          summaries.push(summary); copies.push(summary);
        });
        for (const node of sourceGraph.nodes) if (!membership.has(node.id)) {
          const copy = structuredClone(node), id = randomUUID();
          mapping.set(node.id, id); copy.id = id; copy.x += offsetX; copy.createdAt = now();
          const versions = new Map(copy.versions.map(version => [version.id, randomUUID()]));
          versionMappings.set(node.id, versions);
          for (const version of copy.versions) { const old = version.id; version.id = versions.get(old)!; version.nodeId = id; if (version.previousId) version.previousId = versions.get(version.previousId); }
          copy.answerVersionIds = copy.answerVersionIds.map(versionId => versions.get(versionId)!);
          if (copy.activeVersionId) copy.activeVersionId = versions.get(copy.activeVersionId);
          copy.highlights = copy.highlights.map(highlight => ({ ...highlight, id: randomUUID(), nodeId: id, versionId: versions.get(highlight.versionId)! }));
          copy.derivedFrom = [{ nodeId: node.id, versionId: node.activeVersionId, contentHash: hash(semanticNode(node)) }];
          copy.sourceSessionId = undefined; copy.sourceTurnId = undefined; copy.mirrorEdited = undefined;
          copies.push(copy);
        }
        graph.nodes.push(...copies);
        const seen = new Set<string>();
        for (const original of sourceGraph.edges) {
          const from = mapping.get(original.from)!, to = mapping.get(original.to)!;
          if (from === to) continue;
          const edge = { ...structuredClone(original), id: randomUUID(), from, to };
          if (edge.quote) edge.quote.sourceVersionId = versionMappings.get(original.from)?.get(edge.quote.sourceVersionId) ?? edge.quote.sourceVersionId;
          const key = hash({ from, to, kind: edge.kind, contextMode: edge.contextMode, order: edge.order, quote: edge.quote });
          if (seen.has(key)) continue; seen.add(key);
          validateEdge(graph, edge); graph.edges.push(edge);
        }
        for (const summary of summaries) for (const source of summary.derivedFrom ?? []) {
          const edge = makeEdge(graph, { from: source.nodeId, to: summary.id, kind: 'reference', contextMode: 'none' });
          validateEdge(graph, edge); graph.edges.push(edge);
        }
        controller.signal.throwIfAborted();
        const saved = await commit(latest, graph);
        return { revision: saved.revision, copiedNodes: copies.length, collapsedRuns: segments.length, distillIds: summaries.map(node => node.id),
          mapping: Object.fromEntries(mapping), originalsPreserved: true, modelCalls: operation.modelCalls };
      }
      if (action === 'merge' || action === 'weave') {
        let evidence: { label: string; node: GraphNode; versionId: string; text: string; source: SourceRef }[];
        if (action === 'weave') {
          const ids = strings(params.highlightIds);
          if (!ids.length) throw new NexusError('CTX-WEAVE-EMPTY', '请先选择高光；Weave 只编织明确选中的高光');
          evidence = ids.map((id, index) => {
            const node = sourceGraph.nodes.find(item => item.highlights.some(highlight => highlight.id === id));
            const highlight = node?.highlights.find(item => item.id === id);
            if (!node || !highlight) throw new NexusError('CTX-SOURCE-CHANGED', '所选高光不存在');
            const version = node.versions.find(item => item.id === highlight.versionId);
            if (!version || sha256(version.text.slice(highlight.start, highlight.end)) !== highlight.textHash) throw new NexusError('CTX-SOURCE-CHANGED', '高光原文已失效');
            return { label: `H${index + 1}`, node, versionId: version.id, text: highlight.text,
              source: { ...nodeSource(sourceGraph, node), binding: 'pinned', immutableVersion: version.id, start: highlight.start, end: highlight.end, contentHash: highlight.textHash } };
          });
        } else {
          if (!selected.length) throw new NexusError('INVALID_ARGUMENT', '请明确选择要汇总的节点');
          evidence = selected.map((node, index) => ({ label: `S${index + 1}`, node, versionId: node.activeVersionId ?? '',
            text: `Q: ${node.question}\nA: ${activeAnswer(node)}`, source: nodeSource(sourceGraph, node) }));
        }
        const input = evidence.map(item => `[${item.label}] ${item.text}`).join('\n\n');
        if (estimateTokens(input) > number(params.maxInputTokens, 64_000)) throw new NexusError('CTX-BUDGET-EXCEEDED', '所选来源超过本次输入预算');
        const response = await callModel(operation, controller, params,
          `${action === 'weave' ? '只编织下面这些用户选中的高光，不能扩展成完整节点汇总' : '汇总下面用户明确选中的完整内容'}。\n语言：${text(params.language, '中文')}。\n用户意图：${text(params.intent, '保留重要事实、决定和未决项')}。\n每一内容段必须带 [${action === 'weave' ? 'H' : 'S'}编号] 引用，不得编造来源。\n${input}`,
          `graph-${action}`);
        const allowed = new Set(evidence.map(item => item.label));
        const cited = [...response.text.matchAll(/\[((?:H|S)\d+)\]/g)].map(match => match[1]);
        const invalid = cited.filter(label => !allowed.has(label));
        if (invalid.length || !cited.length) throw new NexusError('CTX-CITATION-INVALID', '生成文本包含无效或缺失来源引用；原图未修改', { invalid });
        const latest = await load(record.id);
        for (const item of evidence) {
          const source = latest.value.nodes.find(node => node.id === item.node.id);
          if (!source || hash(semanticNode(source)) !== hash(semanticNode(item.node))) {
            await services.store.put('graph-orphan-results', operation.id, { graphId: record.id, kind: action, evidence, response, createdAt: now() }, 0);
            throw new NexusError('CTX-SOURCE-CHANGED', '生成期间来源已修改；保留候选，未归档任何节点');
          }
        }
        const graph = structuredClone(latest.value);
        const sourceIds = [...new Set(evidence.map(item => item.node.id))];
        const unsupported = response.text.split('\n').filter(line => line.trim() && !/^#/.test(line.trim()) && !/\[(?:H|S)\d+\]/.test(line));
        const node = makeNode(graph.id, { kind: 'summary', question: text(params.title, action === 'weave' ? '高光编织' : '合并汇总'), answer: response.text,
          x: Math.max(...evidence.map(item => item.node.x)) + 560, y: Math.max(...evidence.map(item => item.node.y)) + 260 });
        node.derivedFrom = evidence.map(item => ({ nodeId: item.node.id, versionId: item.versionId, contentHash: sha256(item.text) }));
        graph.nodes.push(node);
        for (const id of action === 'merge' ? selectionSinks(sourceIds, graph.edges) : sourceIds) {
          const edge = makeEdge(graph, { from: id, to: node.id, kind: 'reference', contextMode: 'none' });
          validateEdge(graph, edge); graph.edges.push(edge);
        }
        let archived: string[] = [];
        if (action === 'merge' && params.archiveSources === true) {
          archived = params.includeDescendants === true ? [...sourceIds, ...descendants(sourceIds, sourceGraph.edges.filter(structural))] : sourceIds;
          for (const id of archived) {
            const original = sourceGraph.nodes.find(item => item.id === id), current = graph.nodes.find(item => item.id === id);
            if (!original || !current || hash(semanticNode(original)) !== hash(semanticNode(current))) throw new NexusError('CTX-SOURCE-CHANGED', '待归档后代已变化；不归档任何源');
          }
          for (const id of archived) nodeById(graph, id).archived = true;
        }
        controller.signal.throwIfAborted();
        const saved = await commit(latest, graph);
        return { revision: saved.revision, node, citations: evidence.map(({ label, source }) => ({ label, source })),
          unsupportedSentences: unsupported.map(text => ({ text, status: '未找到对应来源' })), archived, modelCalls: operation.modelCalls, usage: response.usage };
      }
      throw new NexusError('UNKNOWN_ACTION', '未知图谱变换');
    });
  };

  const innerDispatch = async (request: NexusRequest, context?: DispatchContext): Promise<unknown> => {
    if (disposed) throw new NexusError('DISPOSED', '图谱服务已停用');
    const params = request.params ?? {}, action = request.action;
    if (action === 'workspace.list' || action === 'workspace.attach') {
      if (!context?.sessionId || context.scopeLevel === 'global' || context.scopeLevel === 'workspace') throw new NexusError('PERMISSION_DENIED', '请在当前会话引用工作区图谱');
      const parent = { ...context, scopeLevel: 'workspace' as const, sessionId: undefined };
      if (action === 'workspace.list') return services.invoke('graph', { action: 'list', params: {} }, parent);
      const source = await services.invoke('graph', { action: 'get', params: { graphId: required(params.graphId, 'graphId') } }, parent) as GraphDocument & { revision: number };
      if (request.expectedRevision !== source.revision) throw new NexusError('REVISION_CONFLICT', '工作区图谱已变更，请重新选择');
      const id = randomUUID();
      const graph: GraphDocument = { ...source, id, ownerSessionId: context.sessionId, sourceGraphId: source.id,
        scopeLevel: 'session',
        nodes: source.nodes.map(node => ({ ...node, graphId: id })), edges: source.edges.map(edge => ({ ...edge, graphId: id })),
        history: { past: [], future: [] }, createdAt: now(), updatedAt: now() };
      graph.semanticRevision = semanticGraphHash(graph);
      return present(await services.store.put(GRAPHS, id, graph, 0));
    }
    if (historyActions.includes(action)) return history.dispatch(request, context);
    if (action === 'list') {
      const records = await services.store.list<GraphDocument>(GRAPHS);
      return { items: records.filter(record => params.includeArchived === true || !record.value.archived).map(record => ({
        id: record.id, title: record.value.title, projectId: record.value.projectId, workspaceRoot: record.value.workspaceRoot,
        archived: record.value.archived, nodeCount: record.value.nodes.length, edgeCount: record.value.edges.length,
        semanticRevision: record.value.semanticRevision, revision: record.revision, updatedAt: record.updatedAt,
      })) };
    }
    if (action === 'create') {
      const id = randomUUID(), graph: GraphDocument = { schemaVersion: 1, id, title: text(params.title, '新的思维地图'),
        workspaceRoot: context?.workspaceRoot ?? services.workspaceRoot, projectId: text(params.projectId) || undefined,
        ownerSessionId: context?.sessionId,
        scopeLevel: context?.scopeLevel,
        archived: false, nodes: [], edges: [], materials: [], semanticRevision: '', createdAt: now(), updatedAt: now(), history: { past: [], future: [] } };
      graph.semanticRevision = semanticGraphHash(graph);
      const saved = await services.store.put(GRAPHS, id, graph, 0); return present(saved);
    }
    if (action === 'operation.list') {
      return (await services.store.list<GraphOperation>(OPERATIONS)).filter(record => !params.graphId || record.value.graphId === params.graphId)
        .map(record => ({ ...record.value, revision: record.revision }));
    }
    if (action === 'operation.cancel') {
      const id = required(params.operationId, 'operationId'), record = await services.store.get<GraphOperation>(OPERATIONS, id);
      if (!record) throw new NexusError('NOT_FOUND', '模型作业不存在');
      const controller = activeOperations.get(id);
      if (controller) { controller.abort(); return { operationId: id, status: 'cancelling', modelCalls: record.value.modelCalls, costsRetained: true }; }
      return { operationId: id, status: record.value.status, alreadyCompleted: record.value.status !== 'running', costsRetained: true };
    }
    if (action === 'generate') return generate(request, context);
    if (action === 'condense' || action === 'merge' || action === 'weave') return transform(request, context);
    if (action === 'import') return importGraph(request, context);
    const record = await load(graphIdOf(request));
    if (action === 'get') return present(record);
    if (action === 'delete') {
      verifyRevision(record, request.expectedRevision);
      await services.store.remove(GRAPHS, record.id, record.revision);
      const layout = await services.store.get(LAYOUTS, record.id); if (layout) await services.store.remove(LAYOUTS, record.id, layout.revision);
      return { deleted: record.id, hostSessionsUnchanged: true, modelEvidenceRetained: true };
    }
    if (action === 'context.preview') return freeze(record.value, required(params.nodeId, 'nodeId'), params);
    if (action === 'context.validate') {
      const plan = await services.store.get<GraphContextPlan>(PLANS, required(params.planId, 'planId'));
      if (!plan || plan.value.graphId !== record.id) throw new NexusError('NOT_FOUND', '上下文预览不存在');
      validateContextPlan(plan.value, record.value); return { valid: true, planId: plan.id, semanticHash: plan.value.semanticHash };
    }
    if (action === 'material.extract') {
      verifyRevision(record, request.expectedRevision);
      const filePath = required(params.path, 'path');
      const read = jsonObject(await services.invoke('files', { action: 'read', params: { path: filePath, maxBytes: 8 * 1024 * 1024, raw: true } }, context));
      if (read.truncated) throw new NexusError('CTX-IMPORT-LIMIT', '材料超过单次可完整读取的上限；请拆分后导入，不能将截断内容冒充原件');
      const lower = filePath.toLowerCase();
      let extractedText = text(read.content), mimeType = 'text/plain', pages: Material['pages'], warnings: string[] = [];
      if (lower.endsWith('.pdf')) {
        const result = jsonObject(await services.invoke('files', { action: 'pdf.read', params: { path: filePath } }, context));
        extractedText = text(result.text); mimeType = 'application/pdf';
        pages = Array.isArray(result.pages) ? result.pages.map(value => { const page = jsonObject(value); return { page: number(page.num, 1), text: text(page.text) }; }) : undefined;
        warnings = strings(result.warnings);
      } else if (lower.endsWith('.docx')) {
        const result = jsonObject(await services.invoke('files', { action: 'doc.read', params: { path: filePath } }, context));
        extractedText = text(result.text); mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; warnings = strings(result.warnings);
        if (result.partial === true) warnings.push('DOCX 文本提取为部分结构投影，原始文档保持完整');
      } else if (/\.html?$/.test(lower)) {
        mimeType = 'text/html';
        extractedText = extractedText.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
          .replace(/<\/(?:p|div|section|h[1-6]|li|tr)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
        warnings.push('HTML 为本地纯文本提取；原始字节保留，不执行页面脚本');
      } else if (/\.(?:png|jpe?g|webp|gif)$/i.test(lower)) {
        mimeType = lower.endsWith('.png') ? 'image/png' : /\.jpe?g$/.test(lower) ? 'image/jpeg' : lower.endsWith('.webp') ? 'image/webp' : 'image/gif';
        extractedText = ''; warnings.push('图像原件已保存，文本识别需要支持图像的宿主模型');
      }
      const graph = structuredClone(record.value);
      const material = applyEdit(graph, 'material.add', { material: { name: filePath.split(/[\\/]/).at(-1), mimeType,
        originalText: typeof read.content === 'string' ? read.content : undefined, originalBase64: typeof read.base64 === 'string' ? read.base64 : undefined,
        extractedText, extractor: 'nexus-files-v1' }, nodeId: params.nodeId }) as Material;
      material.pages = pages; material.extractionWarnings = warnings;
      const saved = await commit(record, graph);
      return { revision: saved.revision, result: material };
    }
    if (action === 'material.recognize') {
      verifyRevision(record, request.expectedRevision);
      const material = record.value.materials.find(item => item.id === params.materialId);
      if (!material || !material.originalBase64 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(material.mimeType)) {
        throw new NexusError('INVALID_ARGUMENT', '请选择保留完整原始字节的 PNG、JPEG、WEBP 或 GIF 材料');
      }
      if (Buffer.from(material.originalBase64, 'base64').length > 8 * 1024 * 1024) throw new NexusError('CTX-BUDGET-EXCEEDED', '图片超过本次外发的 8 MiB 上限');
      const region = params.region ? jsonObject(params.region) : undefined;
      if (region && !['x', 'y', 'width', 'height'].every(key => typeof region[key] === 'number' && Number.isFinite(region[key]) && Number(region[key]) >= 0)
        || region && (Number(region.width) <= 0 || Number(region.height) <= 0)) throw new NexusError('INVALID_ARGUMENT', '图片选区必须包含有效的 x、y、width 和 height');
      return runModel(record.value, 'material-recognize', undefined, params, context, async (operation, controller) => {
        const question = text(params.question);
        const response = await callModel(operation, controller, { ...params, images: [{ mediaType: material.mimeType, dataBase64: material.originalBase64, name: material.name }] },
          `${question || '请忠实识别图片中的文字、表格与可见结构，明确无法辨认处，不要编造。'}${region ? `\n只处理图像像素选区：${canonical(region)}。图片原始字节未作修改。` : ''}\n材料 SHA256：${material.contentHash}`,
          'graph-vision');
        const latest = await load(record.id), current = latest.value.materials.find(item => item.id === material.id);
        if (!current || current.contentHash !== material.contentHash || current.extractionVersion !== material.extractionVersion) {
          await services.store.put('graph-orphan-results', operation.id, { graphId: record.id, materialId: material.id, region, response, createdAt: now() }, 0);
          throw new NexusError('CTX-SOURCE-CHANGED', '识别期间材料或提取版本已变化，结果保留为候选');
        }
        const graph = structuredClone(latest.value), target = graph.materials.find(item => item.id === material.id)!;
        let node: GraphNode | undefined;
        if (question) {
          node = makeNode(graph.id, { question, answer: response.text, x: number(params.x, 80), y: number(params.y, 80) });
          node.attachmentIds.push(material.id);
          node.source = { sourceId: `material:${material.id}`, kind: 'file', artifactId: material.id, binding: 'pinned',
            immutableVersion: material.extractionVersion, contentHash: material.contentHash };
          const version = node.versions[0]; version.providerId = response.provider ?? text(params.provider, 'host-default');
          version.modelId = response.model ?? text(params.model, 'host-default'); version.usageRequestIds = [response.logicalCallId, response.attemptId];
          graph.nodes.push(node);
        } else {
          const id = randomUUID(), extractedText = region ? `${target.extractedText}\n\n[识别选区 ${canonical(region)}]\n${response.text}` : response.text;
          target.versions.push({ id, text: extractedText, createdAt: now(), extractor: `vision:${response.provider ?? 'host'}:${response.model ?? 'default'}` });
          target.extractedText = extractedText; target.extractionVersion = id;
        }
        controller.signal.throwIfAborted();
        const saved = await commit(latest, graph);
        return { revision: saved.revision, materialId: material.id, extractionVersion: target.extractionVersion, node, text: response.text,
          region, sourceContentHash: material.contentHash, usage: response.usage, actualModel: response.model };
      });
    }
    if (action === 'condense.preview') {
      const segments = findCandidateSegments(record.value, strings(params.nodeIds).length ? strings(params.nodeIds) : undefined);
      return { segments, estimatedCalls: segments.length, estimatedOriginalTokens: segments.reduce((sum, segment) => sum + segment.estimatedOriginalTokens, 0),
        protectedRules: ['完整原文副本保留', '决定与转折不凝练', '分叉边界不凝练', '最近三轮不凝练', '固定选文不凝练', '高光原样附带'], revision: record.revision };
    }
    if (action === 'layout' || action === 'autoLayout' || (action === 'undo' || action === 'redo') && params.scope === 'layout') {
      const previous = await services.store.get<{ nodes: Record<string, JsonRecord>; viewport?: JsonRecord; past?: unknown[]; future?: unknown[] }>(LAYOUTS, record.id);
      const layout = structuredClone(previous?.value ?? { nodes: {}, past: [], future: [] });
      layout.past ??= []; layout.future ??= [];
      const snapshot = { nodes: structuredClone(layout.nodes), viewport: structuredClone(layout.viewport) };
      if (action === 'undo' || action === 'redo') {
        const from = action === 'undo' ? layout.past : layout.future, to = action === 'undo' ? layout.future : layout.past;
        const restored = from.pop() as typeof snapshot | undefined;
        if (!restored) throw new NexusError('CTX-UNDO-EMPTY', '没有可撤销或重做的布局');
        to.push(snapshot); layout.nodes = restored.nodes; layout.viewport = restored.viewport;
      } else {
        layout.past.push(snapshot); layout.past = layout.past.slice(-100); layout.future = [];
        if (action === 'layout') {
          const updates = Array.isArray(params.nodes) ? params.nodes as JsonRecord[] : [];
          for (const update of updates) {
            const id = required(update.id, 'id'); nodeById(record.value, id);
            const next: JsonRecord = { ...layout.nodes[id] };
            for (const field of ['x', 'y'] as const) if (typeof update[field] === 'number' && Number.isFinite(update[field])) next[field] = update[field];
            for (const field of ['pinned', 'collapsed'] as const) if (typeof update[field] === 'boolean') next[field] = update[field];
            if (typeof update.color === 'string') next.color = update.color;
            layout.nodes[id] = next;
          }
          if (params.viewport) layout.viewport = jsonObject(params.viewport);
        } else {
          const edges = record.value.edges.filter(structural), incoming = adjacency(edges, true), layers = new Map<string, number>(), columns = new Map<number, number>();
          const order = walkUpAncestors(record.value.nodes.map(node => node.id).sort(), record.value.nodes, edges).ordered;
          for (const node of order) {
            const depth = Math.max(0, ...(incoming.get(node.id) ?? []).map(edge => (layers.get(edge.from) ?? 0) + 1));
            layers.set(node.id, depth);
            const column = columns.get(depth) ?? 0; columns.set(depth, column + 1);
            if (layout.nodes[node.id]?.pinned === true || node.pinned) continue;
            layout.nodes[node.id] = { ...layout.nodes[node.id], x: node.kind === 'reviewer' ? 700 + column * 560 : 80 + column * 560, y: 80 + depth * 320 };
          }
        }
      }
      const expected = typeof params.expectedLayoutRevision === 'number' ? params.expectedLayoutRevision : previous?.revision ?? 0;
      const saved = await services.store.put(LAYOUTS, record.id, layout, expected);
      return { graphId: record.id, layoutRevision: saved.revision, semanticRevision: record.value.semanticRevision, nodes: layout.nodes, viewport: layout.viewport };
    }
    if (action === 'undo' || action === 'redo') {
      verifyRevision(record, request.expectedRevision);
      const graph = structuredClone(record.value), from = action === 'undo' ? graph.history.past : graph.history.future;
      const to = action === 'undo' ? graph.history.future : graph.history.past, snapshot = from.pop();
      if (!snapshot) throw new NexusError('CTX-UNDO-EMPTY', '没有可撤销或重做的画布事务');
      to.push(graphSnapshot(record.value));
      Object.assign(graph, snapshot);
      const saved = await commit(record, graph, false);
      const externalEffects = (await services.store.list<GraphOperation>(OPERATIONS)).filter(item => item.value.graphId === record.id && item.value.modelCalls > 0).map(item => item.value.id);
      return { ...(await present(saved)), externalEffectsRetained: externalEffects, message: externalEffects.length ? '画布已恢复；真实模型费用与已发生的宿主操作仍保留' : undefined };
    }
    if (action === 'atlas.mount' || action === 'atlas.remirror') {
      verifyRevision(record, request.expectedRevision);
      const session = await history.sessionById(required(params.sessionId, 'sessionId'), params);
      const graph = structuredClone(record.value), result = projectSession(graph, session, randomUUID);
      if (session.parentSessionId) {
        const parent = graph.nodes.filter(node => node.sourceSessionId === session.parentSessionId).at(-1);
        const child = graph.nodes.find(node => node.sourceSessionId === session.id);
        if (parent && child && !graph.edges.some(edge => edge.from === parent.id && edge.to === child.id && edge.kind === 'session-lineage')) {
          const edge = makeEdge(graph, { from: parent.id, to: child.id, kind: 'session-lineage', contextMode: 'none' });
          validateEdge(graph, edge); graph.edges.push(edge);
        }
      }
      const saved = await commit(record, graph); return { ...result, revision: saved.revision, sourceSessionId: session.id, sourceRevision: session.revision };
    }
    if (action === 'session.open') return services.host.sessions('open', { sessionId: required(params.sessionId, 'sessionId') });
    if (action === 'session.fork') {
      if (context?.scopeLevel && context.scopeLevel !== 'session') throw new NexusError('PERMISSION_DENIED', '图谱干涉只能在会话内执行');
      const session = await history.sessionById(required(params.sessionId, 'sessionId'), params);
      if (context?.scopeLevel === 'session' && session.externalId !== context.sessionId) throw new NexusError('PERMISSION_DENIED', '只能干涉当前会话');
      const turn = session.turns.find(item => item.id === params.turnId);
      if (!turn) throw new NexusError('NOT_FOUND', '分支轮次不存在');
      if (!turn.complete) throw new NexusError('CTX-TURN-OPEN', '所选轮次仍在运行；请等待完成后分支');
      if (session.agent !== 'dsh' || turn.endSeq === undefined) throw new NexusError('CTX-FORK-BOUNDARY', '只能从含已验证完整事件边界的 DSH 轮次创建原生分支；其它来源可继续为画布节点');
      // The parser revision hashes semantic graph content. Only the native
      // snapshot revision can protect a host fork from concurrent transcript edits.
      const native = jsonObject(await services.host.sessions('snapshot', { sessionId: session.externalId }));
      if ((native.sessionId ?? native.id) !== session.externalId || typeof native.revision !== 'string' || !native.revision) {
        throw new NexusError('CTX-FORK-UNVERIFIED', '宿主未返回身份匹配且带原生修订号的会话快照');
      }
      const boundary = (Array.isArray(native.events) ? native.events.map(jsonObject) : [])
        .find(event => event.type === 'turn/end' && event.seq === turn.endSeq);
      if (!boundary || jsonObject(boundary.data).turn !== undefined && String(jsonObject(boundary.data).turn) !== turn.id) {
        throw new NexusError('CTX-FORK-BOUNDARY', '所选历史轮次与宿主当前完整回合边界不匹配，请先同步历史');
      }
      const result = await services.host.sessions('fork', { sessionId: session.externalId, boundary: turn.endSeq, expectedRevision: native.revision });
      await services.store.put('graph-host-effects', randomUUID(), { graphId: record.id, kind: 'fork', sourceSessionId: session.id, boundary: turn.endSeq,
        sourceRevision: session.revision, hostRevision: native.revision, result, createdAt: now(), reversibleInCanvasOnly: true });
      services.emit('graph:host-effect', { kind: 'fork', graphId: record.id, sessionId: session.id, turnId: turn.id, result });
      return { result, externalEffect: '已创建宿主子会话，撤销画布不删除它' };
    }
    if (action === 'session.prompt') {
      const sessionId = required(params.sessionId, 'sessionId'), prompt = required(params.prompt, 'prompt');
      if (context?.scopeLevel && (context.scopeLevel !== 'session' || context.sessionId !== sessionId)) throw new NexusError('PERMISSION_DENIED', '只能干涉当前会话');
      const plan = params.nodeId ? await freeze(record.value, text(params.nodeId), params) : undefined;
      return services.host.sessions('prompt', { sessionId, prompt, contextPlanId: plan?.id, extraContext: plan?.items.filter(item => item.kind === 'material' || item.kind === 'reference' || item.kind === 'recall') });
    }
    if (action === 'replay') {
      const selected = strings(params.nodeIds), ids = new Set(selected.length ? selected : record.value.nodes.filter(node => node.versions.some(version => version.id === node.activeVersionId && version.stale)).map(node => node.id));
      const order = walkUpAncestors([...ids].sort(), record.value.nodes, record.value.edges.filter(contextEdge)).ordered.filter(node => ids.has(node.id));
      const maxCalls = number(params.maxCalls, 32);
      if (order.length > maxCalls) throw new NexusError('CTX-BUDGET-EXCEEDED', '依赖重放超过本次最大模型调用数', { requiredCalls: order.length, maxCalls });
      const failed = new Set<string>(), blocked = new Set<string>(), results: unknown[] = [];
      for (const node of order) {
        context?.signal?.throwIfAborted();
        if (blocked.has(node.id)) { results.push({ nodeId: node.id, status: 'blocked-by-failed-dependency' }); continue; }
        try { results.push(await generate({ action: 'generate', params: { ...params, graphId: record.id, nodeId: node.id, planId: undefined } }, context)); }
        catch (error) {
          failed.add(node.id); for (const id of descendants([node.id], record.value.edges.filter(contextEdge))) blocked.add(id);
          results.push({ nodeId: node.id, status: 'failed', code: error instanceof NexusError ? error.code : 'CTX-MODEL-FAILED' });
          if (params.continueIndependent === false) break;
        }
      }
      return { results, failed: [...failed], blocked: [...blocked], success: !failed.size };
    }
    if (action === 'review') {
      const nodeId = required(params.nodeId, 'nodeId'), maxIterations = Math.min(10, Math.max(1, number(params.maxIterations, 2)));
      const maxCalls = Math.min(40, Math.max(1, number(params.maxCalls, 4)));
      const reviewerId = required(params.reviewerId, 'reviewerId');
      nodeById(record.value, nodeId); nodeById(record.value, reviewerId);
      return runModel(record.value, 'review', reviewerId, params, context, async (operation, controller) => {
        const waves: unknown[] = [];
        for (let iteration = 0; iteration < maxIterations && operation.modelCalls < maxCalls; iteration++) {
          const latest = await load(record.id), writer = nodeById(latest.value, nodeId), reviewer = nodeById(latest.value, reviewerId);
          const response = await callModel(operation, controller, { ...params, maxCalls }, `独立检查回答，明确指出证据、缺陷与未验证项。不得自动判定 PASS。\n问题：${writer.question}\n回答：${activeAnswer(writer)}\n审阅要求：${reviewer.question}`, 'graph-reviewer', reviewer.rolePrompt);
          const fresh = await load(record.id);
          if (hash(semanticNode(nodeById(fresh.value, nodeId))) !== hash(semanticNode(writer))) throw new NexusError('CTX-SOURCE-CHANGED', '审阅期间回答已变化，未覆盖审阅结果');
          const graph = structuredClone(fresh.value), critic = nodeById(graph, reviewerId), id = randomUUID();
          critic.versions.push({ id, nodeId: reviewerId, previousId: critic.activeVersionId, text: response.text, providerId: text(params.provider, 'host-default'),
            modelId: text(params.model, 'host-default'), contextPlanId: '', inputHash: hash(semanticNode(writer)), createdAt: now(), status: 'complete',
            stale: false, staleCauses: [], usageRequestIds: [response.logicalCallId, response.attemptId], sourceRevisionSet: { [`node:${nodeId}`]: hash(semanticNode(writer)) } });
          critic.answerVersionIds.push(id); critic.activeVersionId = id; await commit(fresh, graph);
          waves.push({ iteration: iteration + 1, reviewerVersionId: id, text: response.text });
          // Re-evaluation is an explicit request. Merely drawing a reciprocal
          // watch edge never recursively invokes a writer or sends a message.
          if (params.reEvaluate !== true) break;
        }
        return { waves, modelCalls: operation.modelCalls, maxCalls, maxIterations, stopped: 'bounded-review-complete', verified: false };
      });
    }
    if (action === 'diagnose') return diagnose(record.value);
    if (action === 'export') return exportGraph(record.value, params);
    if (action === 'batch') {
      verifyRevision(record, request.expectedRevision);
      const edits = Array.isArray(params.edits) ? params.edits as { action: string; params: JsonRecord }[] : [];
      if (!edits.length || edits.length > 1_000) throw new NexusError('INVALID_ARGUMENT', '批操作需要 1 至 1000 条结构编辑');
      const graph = structuredClone(record.value), results: unknown[] = [];
      for (const edit of edits) results.push(applyEdit(graph, edit.action, edit.params ?? {}));
      const saved = await commit(record, graph); return { revision: saved.revision, semanticRevision: saved.value.semanticRevision, results };
    }
    if (writes.has(action)) {
      verifyRevision(record, request.expectedRevision);
      const graph = structuredClone(record.value), result = applyEdit(graph, action, params), saved = await commit(record, graph);
      return { revision: saved.revision, semanticRevision: saved.value.semanticRevision, result };
    }
    throw new NexusError('UNKNOWN_ACTION', `不支持的图谱动作：${action}`);
  };
  const importGraph = async (request: NexusRequest, context?: DispatchContext): Promise<unknown> => {
    const params = request.params ?? {};
    let input = params.data ?? params.bundle;
    if (typeof input === 'string') {
      if (Buffer.byteLength(input) > 128 * 1024 * 1024) throw new NexusError('CTX-IMPORT-LIMIT', '导入内容超过 128 MiB');
      try { input = JSON.parse(input); } catch { throw new NexusError('CTX-IMPORT-INVALID', '导入内容不是有效 JSON'); }
    }
    const root = jsonObject(input);
    const rejectUnsafe = (value: unknown, depth = 0): void => {
      if (depth > 100) throw new NexusError('CTX-IMPORT-LIMIT', '导入数据嵌套过深');
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new NexusError('CTX-IMPORT-INVALID', '导入数据包含不安全对象字段');
        rejectUnsafe(child, depth + 1);
      }
    };
    rejectUnsafe(root);
    if (root.manifest) {
      const manifest = jsonObject(root.manifest);
      if (manifest.schemaVersion !== 1 || manifest.contentHash !== hash(root.graph)) throw new NexusError('CTX-HASH-MISMATCH', '导入 manifest 版本或内容 SHA256 不匹配');
    }
    const source = root.graph ? jsonObject(root.graph) : root;
    const workspaces = Array.isArray(source.workspaces) ? source.workspaces.map(jsonObject) : [source];
    if (workspaces.length > 1_000) throw new NexusError('CTX-IMPORT-LIMIT', '一次导入画布数超过上限');
    const prepared: GraphDocument[] = [], mappings: JsonRecord[] = [], warnings: JsonRecord[] = [];
    for (const workspace of workspaces) {
      const id = randomUUID(), graph: GraphDocument = { schemaVersion: 1, id, title: text(workspace.title, '导入的思维地图'),
        workspaceRoot: services.workspaceRoot, scopeLevel: context?.scopeLevel, ownerSessionId: context?.sessionId, projectId: text(params.projectId) || undefined, archived: workspace.archived === true,
        nodes: [], edges: [], materials: [], semanticRevision: '', createdAt: now(), updatedAt: now(), history: { past: [], future: [] } };
      const nodeMap = new Map<string, string>(), versionMap = new Map<string, string>(), materialMap = new Map<string, string>();
      const rawMaterials = Array.isArray(workspace.materials) ? workspace.materials.map(jsonObject) : [];
      for (const raw of rawMaterials) {
        const newId = randomUUID();
        const hasOriginal = typeof raw.originalBase64 === 'string' || typeof raw.originalText === 'string';
        const bytes = typeof raw.originalBase64 === 'string' ? Buffer.from(raw.originalBase64, 'base64') : Buffer.from(text(raw.originalText, text(raw.extractedText)));
        if (hasOriginal && raw.contentHash && raw.contentHash !== sha256(bytes)) throw new NexusError('CTX-HASH-MISMATCH', '材料原件内容摘要不匹配');
        const material: Material = { id: newId, name: text(raw.name, '导入材料'), mimeType: text(raw.mimeType, 'text/plain'),
          originalText: typeof raw.originalText === 'string' ? raw.originalText : undefined,
          originalBase64: typeof raw.originalBase64 === 'string' ? raw.originalBase64 : undefined, contentHash: text(raw.contentHash, sha256(bytes)),
          extractedText: text(raw.extractedText), extractionVersion: text(raw.extractionVersion, randomUUID()),
          versions: Array.isArray(raw.versions) ? raw.versions as Material['versions'] : [],
          source: raw.source ? structuredClone(raw.source) as Material['source'] : undefined,
          pages: Array.isArray(raw.pages) ? structuredClone(raw.pages) as Material['pages'] : undefined,
          extractionWarnings: [...strings(raw.extractionWarnings), ...(!hasOriginal ? ['结构导入不含材料原件；不能据此声称可以恢复原字节'] : [])] };
        materialMap.set(text(raw.id), newId); graph.materials.push(material);
      }
      const rawNodes = Array.isArray(workspace.nodes) ? workspace.nodes.map(jsonObject)
        : Array.isArray(workspace.threads) ? workspace.threads.map(jsonObject) : [];
      if (rawNodes.length > 50_000) throw new NexusError('CTX-IMPORT-LIMIT', '一次导入节点数超过上限');
      for (const raw of rawNodes) {
        const data = Object.keys(jsonObject(raw.data)).length ? jsonObject(raw.data) : raw;
        const oldId = required(raw.id, '导入节点 id');
        if (nodeMap.has(oldId)) throw new NexusError('CTX-IMPORT-INVALID', '导入节点 id 重复');
        const position = jsonObject(raw.position);
        const node = makeNode(id, { kind: nodeKinds.includes(text(raw.kind)) ? raw.kind : data.stepKind && ['note', 'file', 'link'].includes(text(data.stepKind)) ? 'material' : workspace.threads ? 'session' : 'conversation',
          question: text(data.question, text(raw.title)), answer: text(data.response, text(raw.answer)),
          x: number(raw.x, number(position.x, 80)), y: number(raw.y, number(position.y, 80)), rolePrompt: data.rolePrompt });
        nodeMap.set(oldId, node.id);
        if (Array.isArray(raw.versions)) {
          node.versions = [];
          for (const value of raw.versions) {
            const rawVersion = jsonObject(value), versionId = randomUUID();
            versionMap.set(text(rawVersion.id), versionId);
            node.versions.push({ id: versionId, nodeId: node.id, text: text(rawVersion.text), providerId: text(rawVersion.providerId, 'imported'),
              modelId: text(rawVersion.modelId, 'unknown'), contextPlanId: text(rawVersion.contextPlanId), inputHash: text(rawVersion.inputHash),
              createdAt: text(rawVersion.createdAt, now()), status: ['partial', 'complete', 'failed', 'cancelled'].includes(text(rawVersion.status)) ? rawVersion.status as AnswerVersion['status'] : 'complete',
              stale: rawVersion.stale === true, staleCauses: [], usageRequestIds: [], sourceRevisionSet: {} });
          }
          node.answerVersionIds = node.versions.map(version => version.id);
          node.activeVersionId = versionMap.get(text(raw.activeVersionId)) ?? node.versions.at(-1)?.id;
        } else if (Array.isArray(data.responses)) {
          node.versions = data.responses.filter((value): value is string => typeof value === 'string').map(response => ({
            id: randomUUID(), nodeId: node.id, text: response, providerId: 'imported-thoughtdag', modelId: 'unknown', contextPlanId: '', inputHash: '',
            createdAt: now(), status: 'complete', stale: false, staleCauses: [], usageRequestIds: [], sourceRevisionSet: {},
          }));
          node.answerVersionIds = node.versions.map(version => version.id);
          node.activeVersionId = node.versions[number(data.responseIndex, node.versions.length - 1)]?.id;
        }
        if (workspace.threads && Array.isArray(raw.messages)) {
          const messages = raw.messages as JsonRecord[];
          node.question = messages.filter(message => message.kind === 'user').map(message => text(message.text)).join('\n\n') || node.question;
          const answer = messages.filter(message => message.kind === 'assistant').map(message => text(message.text)).join('\n\n');
          if (answer) {
            const versionId = randomUUID();
            node.versions.push({ id: versionId, nodeId: node.id, text: answer, providerId: 'imported-synapse', modelId: 'unknown',
              contextPlanId: '', inputHash: '', createdAt: now(), status: 'complete', stale: false, staleCauses: [], usageRequestIds: [], sourceRevisionSet: {} });
            node.answerVersionIds.push(versionId); node.activeVersionId = versionId;
          }
          if (typeof raw.dshSessionId === 'string') node.source = { sourceId: 'imported-synapse', kind: 'session', sessionId: raw.dshSessionId, binding: 'pinned' };
          if (strings(source.hiddenSessionIds).includes(text(raw.dshSessionId))) node.archived = true;
        }
        node.archived ||= data.archived === true;
        node.roleMode = ['inherit', 'reset', 'set-next'].includes(text(data.roleMode)) ? data.roleMode as GraphNode['roleMode'] : 'inherit';
        node.roleSourceNodeId = typeof data.roleSourceNodeId === 'string' ? data.roleSourceNodeId : undefined;
        node.moveKind = highlightKinds.includes(text(data.moveKind)) ? data.moveKind as GraphNode['moveKind'] : undefined;
        node.protected = data.protected === true;
        if (raw.source) node.source = structuredClone(raw.source) as GraphNode['source'];
        if (Array.isArray(raw.derivedFrom)) node.derivedFrom = structuredClone(raw.derivedFrom) as GraphNode['derivedFrom'];
        node.attachmentIds = strings(raw.attachmentIds).map(old => materialMap.get(old)).filter((value): value is string => !!value);
        node.excludedAttachmentIds = strings(raw.excludedAttachmentIds).map(old => materialMap.get(old)).filter((value): value is string => !!value);
        node.includedAttachmentIds = strings(raw.includedAttachmentIds).map(old => materialMap.get(old)).filter((value): value is string => !!value);
        const oldAttachments = Array.isArray(data.attachments) ? data.attachments.map(jsonObject) : [];
        for (const attachment of oldAttachments) {
          const originalText = text(attachment.content), extractedText = text(attachment.extractedText, originalText), materialId = randomUUID(), extractionVersion = randomUUID();
          const material: Material = { id: materialId, name: text(attachment.name, '导入附件'), mimeType: text(attachment.type, 'text/plain'),
            originalText, contentHash: sha256(originalText), extractedText, extractionVersion,
            versions: [{ id: extractionVersion, text: extractedText, createdAt: now(), extractor: 'thoughtdag-import' }] };
          graph.materials.push(material); node.attachmentIds.push(materialId);
        }
        const highlights = Array.isArray(data.highlights) ? data.highlights.map(jsonObject) : [];
        for (const item of highlights) {
          const versionId = versionMap.get(text(item.versionId)) ?? node.activeVersionId, version = node.versions.find(value => value.id === versionId);
          if (!version) continue;
          const selected = text(item.text);
          const start = typeof item.start === 'number' ? item.start : version.text.indexOf(selected), end = typeof item.end === 'number' ? item.end : start + selected.length;
          if (!selected || start < 0 || end > version.text.length || version.text.slice(start, end) !== selected) {
            warnings.push({ nodeId: oldId, message: '旧高光无法精确绑定，保留原内容但不创建错误引用' }); continue;
          }
          node.highlights.push({ id: randomUUID(), nodeId: node.id, versionId: version.id, start, end, text: selected, textHash: sha256(selected),
            kind: highlightKinds.includes(text(item.kind)) ? item.kind as Highlight['kind'] : 'insight' });
        }
        graph.nodes.push(node);
      }
      for (const raw of rawNodes) {
        const node = nodeById(graph, nodeMap.get(text(raw.id))!);
        if (node.roleSourceNodeId && node.roleSourceNodeId !== '__none__') node.roleSourceNodeId = nodeMap.get(node.roleSourceNodeId) ?? node.roleSourceNodeId;
        if (node.derivedFrom) for (const ref of node.derivedFrom) {
          ref.nodeId = nodeMap.get(ref.nodeId) ?? ref.nodeId;
          if (ref.versionId) ref.versionId = versionMap.get(ref.versionId) ?? ref.versionId;
        }
        if (Array.isArray(raw.versions)) for (const item of raw.versions) {
          const original = jsonObject(item), version = node.versions.find(value => value.id === versionMap.get(text(original.id)));
          if (version && typeof original.previousId === 'string') version.previousId = versionMap.get(original.previousId);
        }
      }
      const rawEdges = Array.isArray(workspace.edges) ? workspace.edges.map(jsonObject) : [];
      if (workspace.threads) for (const raw of rawNodes) if (raw.parentId && nodeMap.has(text(raw.parentId))) rawEdges.push({ from: raw.parentId, to: raw.id, kind: 'session-lineage', contextMode: 'none' });
      for (const raw of rawEdges) {
        const data = jsonObject(raw.data), from = nodeMap.get(text(raw.from, text(raw.source))), to = nodeMap.get(text(raw.to, text(raw.target)));
        if (!from || !to) throw new NexusError('CTX-GRAPH-ENDPOINT', '导入连线包含缺失端点');
        const quote = raw.quote ? jsonObject(raw.quote) : undefined;
        if (quote) quote.sourceVersionId = versionMap.get(text(quote.sourceVersionId)) ?? quote.sourceVersionId;
        const edge = makeEdge(graph, { from, to, kind: edgeKinds.includes(text(raw.kind)) ? raw.kind : data.isCrossLink ? 'reference' : 'conversation',
          contextMode: raw.contextMode ?? (data.isCrossLink ? text(data.contextDepth, 'quote') : 'full'),
          order: number(raw.order, number(data.contextOrder, 0)), quote });
        validateEdge(graph, edge); graph.edges.push(edge);
      }
      for (const node of graph.nodes) node.semanticRevision = hash(semanticNode(node));
      graph.semanticRevision = semanticGraphHash(graph); validateGraph(graph); prepared.push(graph);
      mappings.push({ graphId: graph.id, nodes: Object.fromEntries(nodeMap), versions: Object.fromEntries(versionMap), materials: Object.fromEntries(materialMap) });
    }
    // Validate every graph before publishing any import namespace. No input
    // file or old source directory is ever written or copied as a backup.
    const importId = randomUUID();
    for (const graph of prepared) await services.store.put(GRAPHS, graph.id, graph, 0);
    await services.store.put('graph-imports', importId, { id: importId, sourceHash: hash(root), graphIds: prepared.map(graph => graph.id),
      mappings, warnings, completedAt: now(), sourceUnchanged: true }, 0);
    return { importId, graphs: prepared.map(graph => ({ id: graph.id, title: graph.title, nodes: graph.nodes.length, edges: graph.edges.length })),
      mappings, warnings, sourceUnchanged: true };
  };

  const trackDispatch = (request: NexusRequest, context?: DispatchContext): Promise<unknown> => {
    const pending = innerDispatch(request, context);
    tasks.add(pending);
    void pending.then(() => tasks.delete(pending), () => tasks.delete(pending));
    return pending;
  };
  return {
    id: 'graph',
    capabilities: graphCapabilities,
    async dispatch(request, context) {
      if (!writes.has(request.action)) return trackDispatch(request, context);
      const key = text(request.params?.idempotencyKey, request.requestId);
      if (!key) return trackDispatch(request, context);
      const id = sha256(key), fingerprint = hash({ ...request, requestId: undefined, params: { ...request.params, idempotencyKey: undefined } });
      const prior = await services.store.get<{ fingerprint: string; status: string; result?: unknown; error?: { code: string; message: string; details?: unknown } }>(IDEMPOTENCY, id);
      if (prior) {
        if (prior.value.fingerprint !== fingerprint) throw new NexusError('CTX-IDEMPOTENCY-CONFLICT', '相同幂等标识不能用于不同操作');
        if (prior.value.status === 'failed' && prior.value.error) throw new NexusError(prior.value.error.code, prior.value.error.message, prior.value.error.details);
        if (prior.value.status === 'running') {
          const active = inFlight.get(id);
          if (active) return active;
          throw new NexusError('CTX-OPERATION-UNCERTAIN', '同一操作尚无终结证据；请查看作业状态，不要重复发出模型或宿主请求');
        }
        return prior.value.result;
      }
      const active = inFlight.get(id);
      if (active) return active;
      const pending = (async () => {
        const reserved = await services.store.put(IDEMPOTENCY, id, { fingerprint, status: 'running', startedAt: now() }, 0);
        try {
          const result = await trackDispatch(request, context);
          await services.store.put(IDEMPOTENCY, id, { fingerprint, status: 'succeeded', result, completedAt: now() }, reserved.revision);
          return result;
        } catch (error) {
          const failure = { code: error instanceof NexusError ? error.code : 'CTX-OPERATION-FAILED', message: error instanceof Error ? error.message : '操作失败',
            details: error instanceof NexusError ? error.details : undefined };
          await services.store.put(IDEMPOTENCY, id, { fingerprint, status: 'failed', error: failure, completedAt: now() }, reserved.revision);
          throw error;
        }
      })();
      inFlight.set(id, pending);
      try { return await pending; } finally { inFlight.delete(id); }
    },
    async dispose() {
      disposed = true;
      for (const controller of activeOperations.values()) controller.abort();
      await history.dispose();
      await Promise.allSettled([...tasks, ...inFlight.values()]);
    },
  };
}

function diagnose(graph: GraphSnapshot): unknown {
  const issues: JsonRecord[] = [];
  const incoming = adjacency(graph.edges, true), outgoing = adjacency(graph.edges);
  for (const node of graph.nodes) {
    if (!(incoming.get(node.id)?.length) && !(outgoing.get(node.id)?.length)) issues.push({ nodeId: node.id, code: 'isolated', severity: 'info' });
    if (node.versions.some(version => version.id === node.activeVersionId && version.stale)) issues.push({ nodeId: node.id, code: 'stale-answer', severity: 'warning' });
    if (node.kind === 'conversation' && !node.versions.some(version => version.id === node.activeVersionId && version.status === 'complete')) issues.push({ nodeId: node.id, code: 'no-complete-answer', severity: 'info' });
    for (const id of node.attachmentIds) if (!graph.materials.some(material => material.id === id)) issues.push({ nodeId: node.id, materialId: id, code: 'missing-material', severity: 'error' });
    for (const highlight of node.highlights) {
      const version = node.versions.find(item => item.id === highlight.versionId);
      if (!version || sha256(version.text.slice(highlight.start, highlight.end)) !== highlight.textHash) issues.push({ nodeId: node.id, highlightId: highlight.id, code: 'dangling-highlight', severity: 'error' });
      else if (version.id !== node.activeVersionId) issues.push({ nodeId: node.id, highlightId: highlight.id, code: 'selection-source-updated', severity: 'warning', message: '选文固定于旧版本，未错误套用到新文本' });
    }
    try {
      const plan = buildContextPlan(graph, node.id);
      if (plan.estimatedPromptTokens > 64_000) issues.push({ nodeId: node.id, code: 'large-context-path', severity: 'warning', estimatedTokens: plan.estimatedPromptTokens });
    } catch (error) { issues.push({ nodeId: node.id, code: error instanceof NexusError ? error.code : 'invalid-context', severity: 'error' }); }
  }
  const hashes = new Map<string, string[]>();
  for (const material of graph.materials) {
    const ids = hashes.get(material.contentHash) ?? []; ids.push(material.id); hashes.set(material.contentHash, ids);
  }
  for (const ids of hashes.values()) if (ids.length > 1) issues.push({ code: 'duplicate-material', materialIds: ids, severity: 'info' });
  return { graphId: graph.id, semanticRevision: graph.semanticRevision, issues, healthy: !issues.some(issue => issue.severity === 'error'),
    stats: { nodes: graph.nodes.length, edges: graph.edges.length, materials: graph.materials.length }, automaticDeletion: false };
}

function exportGraph(graph: GraphSnapshot, params: JsonRecord): unknown {
  const format = text(params.format, 'json'), includeContent = params.includeContent === true;
  const content = structuredClone(graph);
  if (!includeContent) {
    for (const [index, node] of content.nodes.entries()) {
      node.question = params.anonymous === true ? `节点 ${index + 1}` : node.question.slice(0, 120);
      node.versions = []; node.answerVersionIds = []; node.activeVersionId = undefined; node.highlights = []; node.rolePrompt = undefined; node.source = undefined;
    }
    content.materials = content.materials.map(material => ({ ...material, originalText: undefined, originalBase64: undefined, extractedText: '', versions: [] }));
    content.workspaceRoot = ''; content.projectId = undefined;
  }
  const manifest = { schemaVersion: 1, format: 'nexus-thought-map', builderVersion: 'thoughtdag-nexus-v1', graphId: graph.id,
    exportedAt: now(), includeContent, contentHash: hash(content),
    artifacts: graph.materials.map(material => ({ id: material.id, name: material.name, contentHash: material.contentHash,
      bytes: material.originalBase64 ? Buffer.from(material.originalBase64, 'base64').length : Buffer.byteLength(material.originalText ?? ''), included: includeContent })),
    stats: { nodes: graph.nodes.length, edges: graph.edges.length, materials: graph.materials.length } };
  if (format === 'json') return { manifest, graph: content, sha256: manifest.contentHash, suggestedFilename: `nexus-map-${graph.id}.json` };
  if (format === 'markdown' || format === 'md') {
    const nodes = walkUpAncestors(content.nodes.map(node => node.id).sort(), content.nodes, content.edges.filter(structural)).ordered;
    const markdown = `# ${content.title}\n\n${nodes.map(node => `## ${node.question || node.id}\n\n${includeContent ? activeAnswer(node) : `[${node.kind}]`}\n\n${node.derivedFrom?.map(source => `来源：${source.nodeId} ${source.versionId ?? ''} SHA256 ${source.contentHash}`).join('\n') ?? ''}`).join('\n\n')}`;
    return { manifest, text: markdown, sha256: sha256(markdown), suggestedFilename: `nexus-map-${graph.id}.md`, mimeType: 'text/markdown' };
  }
  if (format === 'csv') {
    const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const csv = `id,kind,question,answer,sourceNodeIds\r\n${content.nodes.map(node => [node.id, node.kind, node.question, includeContent ? activeAnswer(node) : '', node.derivedFrom?.map(source => source.nodeId).join(';') ?? ''].map(cell).join(',')).join('\r\n')}`;
    return { manifest, text: csv, sha256: sha256(csv), suggestedFilename: `nexus-map-${graph.id}.csv`, mimeType: 'text/csv' };
  }
  if (format === 'mermaid') {
    const escape = (value: string) => value.replace(/[\r\n"]/g, ' ').replace(/[<>[\]{}|]/g, '');
    const aliases = new Map(content.nodes.map((node, index) => [node.id, `n${index}`]));
    const diagram = `flowchart TD\n${content.nodes.map(node => `  ${aliases.get(node.id)}["${escape(node.question.slice(0, 80) || node.kind)}"]`).join('\n')}\n${content.edges.map(edge => `  ${aliases.get(edge.from)} ${structural(edge) ? '-->' : '-.->'}|"${edge.kind}: ${edge.contextMode}"| ${aliases.get(edge.to)}`).join('\n')}`;
    return { manifest, text: diagram, sha256: sha256(diagram), suggestedFilename: `nexus-map-${graph.id}.mmd`, mimeType: 'text/plain' };
  }
  if (format === 'svg' || format === 'poster') {
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const nodes = format === 'poster' ? content.nodes.filter(node => node.moveKind || node.highlights.length || node.kind === 'summary') : content.nodes;
    const chosen = nodes.length ? nodes : content.nodes;
    const index = new Map(chosen.map((node, offset) => [node.id, offset]));
    const height = 150 + chosen.length * 130;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}" viewBox="0 0 1000 ${height}" role="img" aria-label="${escape(content.title)}"><rect width="1000" height="${height}" fill="#f7f5ef"/><text x="50" y="60" font-size="26" font-family="sans-serif" fill="#29251f">${escape(content.title)}</text>${content.edges.filter(edge => index.has(edge.from) && index.has(edge.to)).map(edge => `<line x1="70" y1="${120 + index.get(edge.from)! * 130}" x2="70" y2="${120 + index.get(edge.to)! * 130}" stroke="#a68c6f" stroke-width="3"/>`).join('')}${chosen.map((node, offset) => `<g><rect x="45" y="${90 + offset * 130}" width="910" height="105" rx="14" fill="#fff" stroke="#dfd9cf"/><text x="65" y="${120 + offset * 130}" font-size="15" font-family="sans-serif" fill="#7b6554">${escape(node.moveKind ?? node.kind)} · ${escape(node.id)}</text><text x="65" y="${150 + offset * 130}" font-size="18" font-family="sans-serif" fill="#29251f">${escape(node.question.slice(0, 65))}</text><text x="65" y="${175 + offset * 130}" font-size="12" font-family="sans-serif" fill="#6b6258">${escape(includeContent ? activeAnswer(node).replace(/\s+/g, ' ').slice(0, 100) : `来源 ${node.derivedFrom?.map(source => source.nodeId).join(', ') ?? '原始节点'}`)}</text></g>`).join('')}</svg>`;
    return { manifest, text: svg, sha256: sha256(svg), suggestedFilename: `nexus-journey-${graph.id}.svg`, mimeType: 'image/svg+xml', requiresContentReview: true };
  }
  throw new NexusError('INVALID_ARGUMENT', '导出格式必须为 json、markdown、csv、mermaid、svg 或 poster');
}

export type { GraphNode, GraphEdge, GraphDocument, GraphContextPlan, CanonicalSession, HistorySource } from './types.js';
