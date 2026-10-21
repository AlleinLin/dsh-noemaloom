/**
 * Adapted from chenxiachan/thoughtdag, src/lib/graph.ts and condense.ts.
 * Copyright (c) 2026 Xia Chen. MIT (see LICENSE in this directory).
 * Changes: indexed iterative traversal, stable edge-id tie breaking, typed
 * edge semantics, cycle paths, exact quote binding, protected run boundaries.
 */
import { createHash } from 'node:crypto';
import { NexusError } from '../../ports/contracts.js';
import type { GraphEdge, GraphNode, GraphSnapshot } from '../../domain/graph/types.js';

export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

export const hash = (value: unknown): string => sha256(canonical(value));
export const structural = (edge: GraphEdge): boolean => edge.kind === 'conversation' || edge.kind === 'explore';
export const contextEdge = (edge: GraphEdge): boolean => structural(edge) || (edge.kind === 'reference' && edge.contextMode !== 'none');
export const stableEdge = (a: GraphEdge, b: GraphEdge): number => a.order - b.order || a.id.localeCompare(b.id);

export function adjacency(edges: GraphEdge[], incoming = false): Map<string, GraphEdge[]> {
  const index = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const key = incoming ? edge.to : edge.from;
    const list = index.get(key) ?? [];
    list.push(edge);
    index.set(key, list);
  }
  for (const list of index.values()) list.sort(stableEdge);
  return index;
}

export function findPath(from: string, to: string, edges: GraphEdge[]): string[] | undefined {
  const out = adjacency(edges);
  const visited = new Set([from]);
  const parent = new Map<string, string>();
  const queue = [from];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (current === to) {
      const path = [to];
      while (path[0] !== from) path.unshift(parent.get(path[0])!);
      return path;
    }
    for (const edge of out.get(current) ?? []) if (!visited.has(edge.to)) {
      visited.add(edge.to);
      parent.set(edge.to, current);
      queue.push(edge.to);
    }
  }
  return undefined;
}

export function validateEdge(graph: GraphSnapshot, edge: GraphEdge, previous: GraphEdge[] = graph.edges): void {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  if (edge.graphId !== graph.id || !byId.has(edge.from) || !byId.has(edge.to)) {
    throw new NexusError('CTX-GRAPH-ENDPOINT', '连线端点必须存在于同一画布；跨画布材料请先明确导入引用');
  }
  if (edge.from === edge.to) throw new NexusError('CTX-GRAPH-CYCLE', '节点不能连接到自己', { path: [edge.from, edge.to] });
  if (!Number.isFinite(edge.order)) throw new NexusError('INVALID_ARGUMENT', '连线 order 必须是有限数值');
  if (previous.some(item => item.id === edge.id || (item.from === edge.from && item.to === edge.to && item.kind === edge.kind && item.contextMode === edge.contextMode && hash(item.quote) === hash(edge.quote)))) {
    throw new NexusError('CTX-GRAPH-DUPLICATE', '该语义连线已存在');
  }
  const cycleFamily = contextEdge(edge) ? previous.filter(contextEdge)
    : edge.kind === 'session-lineage' ? previous.filter(item => item.kind === 'session-lineage')
    : edge.kind === 'task-dependency' ? previous.filter(item => item.kind === 'task-dependency') : [];
  if (contextEdge(edge) || edge.kind === 'session-lineage' || edge.kind === 'task-dependency') {
    const path = findPath(edge.to, edge.from, cycleFamily);
    if (path) throw new NexusError('CTX-GRAPH-CYCLE', '连线会形成循环；画布未作修改', { path: [edge.from, ...path] });
  }
  if (edge.contextMode === 'quote' && edge.quote) {
    const source = byId.get(edge.from)!;
    const version = source.versions.find(item => item.id === edge.quote!.sourceVersionId);
    const { start, end, textHash } = edge.quote;
    if (!version || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > version.text.length || sha256(version.text.slice(start, end)) !== textHash) {
      throw new NexusError('CTX-SOURCE-CHANGED', '选文版本、范围或内容摘要不匹配；请重新选择原文');
    }
  }
}

export function validateGraph(graph: GraphSnapshot): void {
  if (graph.nodes.length > 50_000 || graph.edges.length > 200_000) throw new NexusError('CTX-IMPORT-LIMIT', '画布超过导入上限');
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.id || seen.has(node.id) || node.graphId !== graph.id) throw new NexusError('CTX-IMPORT-INVALID', '节点标识重复或归属不正确');
    seen.add(node.id);
    if (!Array.isArray(node.versions) || node.versions.some(version => version.nodeId !== node.id)) throw new NexusError('CTX-IMPORT-INVALID', '回答版本归属不正确');
  }
  const accepted: GraphEdge[] = [];
  for (const edge of graph.edges) { validateEdge(graph, edge, accepted); accepted.push(edge); }
}

/** Postorder ancestors, roots first. Shared ancestors enter once. */
export function walkUpAncestors(startIds: string | string[], nodes: GraphNode[], edges: GraphEdge[]): { ordered: GraphNode[]; visitedEdgeIds: Set<string> } {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const incoming = adjacency(edges, true);
  const visited = new Set<string>();
  const active = new Set<string>();
  const ordered: GraphNode[] = [];
  const visitedEdgeIds = new Set<string>();
  for (const start of typeof startIds === 'string' ? [startIds] : startIds) {
    const stack: { id: string; exit: boolean }[] = [{ id: start, exit: false }];
    while (stack.length) {
      const frame = stack.pop()!;
      if (frame.exit) {
        active.delete(frame.id);
        if (!visited.has(frame.id) && byId.has(frame.id)) { visited.add(frame.id); ordered.push(byId.get(frame.id)!); }
        continue;
      }
      if (active.has(frame.id)) throw new NexusError('CTX-GRAPH-CYCLE', '检测到上下文循环', { nodeId: frame.id });
      if (visited.has(frame.id)) continue;
      active.add(frame.id);
      stack.push({ id: frame.id, exit: true });
      for (const edge of [...(incoming.get(frame.id) ?? [])].reverse()) {
        visitedEdgeIds.add(edge.id);
        stack.push({ id: edge.from, exit: false });
      }
    }
  }
  return { ordered, visitedEdgeIds };
}

export function descendants(nodeIds: string[], edges: GraphEdge[]): string[] {
  const out = adjacency(edges);
  const seen = new Set(nodeIds);
  const result: string[] = [];
  const queue = [...nodeIds];
  for (let index = 0; index < queue.length; index++) for (const edge of out.get(queue[index]) ?? []) if (!seen.has(edge.to)) {
    seen.add(edge.to); queue.push(edge.to); result.push(edge.to);
  }
  return result;
}

/** Sinks are a selection's maximal antichain; references never justify dropping a structural edge. */
export function selectionSinks(nodeIds: string[], edges: GraphEdge[]): string[] {
  const selected = new Set(nodeIds);
  return nodeIds.filter(id => !descendants([id], edges.filter(structural)).some(child => selected.has(child)));
}

export function partitionContext(nodeId: string, graph: GraphSnapshot): {
  materials: GraphNode[];
  references: { source: GraphNode; edge: GraphEdge; chain: GraphNode[] }[];
  mainline: GraphNode[];
} {
  const solid = graph.edges.filter(structural);
  const ordered = walkUpAncestors(nodeId, graph.nodes, solid).ordered;
  const mainlineIds = new Set(ordered.map(node => node.id));
  const isMaterial = (node: GraphNode) => node.kind === 'material' || node.kind === 'note';
  const materials = ordered.filter(isMaterial);
  const materialIds = new Set(materials.map(node => node.id));
  const mainline = ordered.filter(node => !isMaterial(node));
  const references: { source: GraphNode; edge: GraphEdge; chain: GraphNode[] }[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges.filter(item => item.kind === 'reference' && item.contextMode !== 'none' && mainlineIds.has(item.to)).sort(stableEdge)) {
    const source = graph.nodes.find(node => node.id === edge.from);
    if (!source || mainlineIds.has(source.id) && !edge.quote) continue;
    const identity = `${source.id}:${edge.contextMode}:${hash(edge.quote)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (isMaterial(source)) { if (!materialIds.has(source.id)) { materials.push(source); materialIds.add(source.id); } continue; }
    const chain = edge.contextMode === 'full'
      ? walkUpAncestors(source.id, graph.nodes, solid).ordered.filter(node => node.id !== source.id && !mainlineIds.has(node.id) && !isMaterial(node))
      : [];
    references.push({ source, edge, chain });
  }
  return { materials, references, mainline };
}

export function semanticNode(node: GraphNode): unknown {
  return { id: node.id, kind: node.kind, question: node.question, activeVersionId: node.activeVersionId,
    text: node.versions.find(version => version.id === node.activeVersionId)?.text,
    rolePrompt: node.rolePrompt, roleMode: node.roleMode, roleSourceNodeId: node.roleSourceNodeId,
    attachmentIds: node.attachmentIds, excludedAttachmentIds: node.excludedAttachmentIds, includedAttachmentIds: node.includedAttachmentIds,
    archived: node.archived, source: node.source, highlights: node.highlights, moveKind: node.moveKind };
}

export function semanticGraphHash(graph: GraphSnapshot): string {
  return hash({ schemaVersion: 1, nodes: graph.nodes.map(semanticNode).sort((a, b) => (a as GraphNode).id.localeCompare((b as GraphNode).id)),
    edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)),
    materials: graph.materials.map(item => ({ id: item.id, contentHash: item.contentHash, extractionVersion: item.extractionVersion, extractedText: item.extractedText })) });
}

export interface CondenseSegment { nodeIds: string[]; headQuestion: string; estimatedOriginalTokens: number; protectedHighlights: string[] }

/** Copy-tree condensation: preserve frontier, forks, decisions, pivots, quotes and tool boundaries. */
export function findCandidateSegments(graph: GraphSnapshot, selected?: string[], frontierDepth = 3): CondenseSegment[] {
  const solid = graph.edges.filter(structural);
  const out = adjacency(solid);
  const incoming = adjacency(solid, true);
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const selectedSet = selected ? new Set(selected) : undefined;
  const frontier = new Set<string>();
  for (const node of graph.nodes) if (!(out.get(node.id)?.length)) {
    let current: string | undefined = node.id;
    for (let depth = 0; depth < frontierDepth && current; depth++) {
      frontier.add(current);
      const parents: GraphEdge[] = incoming.get(current) ?? [];
      current = parents.length === 1 ? parents[0].from : undefined;
    }
  }
  const quoted = new Set(graph.edges.filter(edge => edge.quote).map(edge => edge.from));
  const eligible = (node: GraphNode | undefined): node is GraphNode => !!node && node.kind === 'conversation' && !node.archived && !node.protected
    && !['decision', 'pivot'].includes(node.moveKind ?? '') && !node.highlights.some(item => ['decision', 'pivot'].includes(item.kind))
    && !frontier.has(node.id) && !quoted.has(node.id) && (!selectedSet || selectedSet.has(node.id))
    && node.versions.some(version => version.id === node.activeVersionId && version.status === 'complete')
    && (out.get(node.id)?.length ?? 0) <= 1 && (incoming.get(node.id)?.length ?? 0) <= 1;
  const result: CondenseSegment[] = [];
  const consumed = new Set<string>();
  for (const node of walkUpAncestors(graph.nodes.map(item => item.id).sort(), graph.nodes, solid).ordered) {
    if (!eligible(node) || consumed.has(node.id)) continue;
    const chain = [node];
    let current = node;
    for (;;) {
      const nextId = out.get(current.id)?.[0]?.to;
      const next = nextId ? byId.get(nextId) : undefined;
      if (!eligible(next) || consumed.has(next.id)) break;
      chain.push(next); current = next;
    }
    for (const item of chain) consumed.add(item.id);
    if (chain.length >= 3) result.push({ nodeIds: chain.map(item => item.id), headQuestion: chain[0].question,
      estimatedOriginalTokens: Math.ceil(Buffer.byteLength(chain.map(item => `${item.question}\n${item.versions.find(version => version.id === item.activeVersionId)?.text ?? ''}`).join('\n')) / 4),
      protectedHighlights: chain.flatMap(item => item.highlights.map(highlight => highlight.text)) });
  }
  return result;
}
