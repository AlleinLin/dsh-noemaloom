import type { JsonRecord } from '../../ports/contracts.js';

const s = { type: 'string' }, n = { type: 'number' }, b = { type: 'boolean' };
const stringList = { type: 'array', items: s };
const object = { type: 'object' };
const nodeFields = {
  id: s, kind: { enum: ['conversation', 'material', 'note', 'summary', 'reviewer', 'session'] },
  question: s, title: s, answer: s, response: s, x: n, y: n, rolePrompt: s,
  roleMode: { enum: ['inherit', 'reset', 'set-next'] }, roleSourceNodeId: s,
  attachmentIds: stringList, protected: b, moveKind: { enum: ['insight', 'decision', 'pivot', 'rule-out', 'open'] },
};
const properties: JsonRecord = {
  graphId: s, nodeId: s, nodeIds: stringList, id: s, idempotencyKey: s, title: s, workspaceRoot: s, projectRoot: s, projectId: s,
  includeArchived: b, archived: b, includeDescendants: b, parentId: s, edgeKind: s,
  kind: s, question: s, answer: s, response: s, x: n, y: n, rolePrompt: s,
  node: { type: 'object', properties: nodeFields, additionalProperties: false },
  patch: { type: 'object', properties: { ...nodeFields, from: s, to: s, contextMode: s, order: n, quote: object }, additionalProperties: false },
  from: s, to: s, edgeId: s, contextMode: { enum: ['none', 'quote', 'full'] }, order: n,
  quote: { type: 'object', properties: { sourceVersionId: s, start: n, end: n, textHash: s }, required: ['sourceVersionId', 'start', 'end', 'textHash'], additionalProperties: false },
  versionId: s, start: n, end: n, textHash: s, page: n, highlightId: s, highlightIds: stringList,
  materialId: s, name: s, mimeType: s, originalText: s, originalBase64: s, text: s, extractedText: s, extractor: s, attachmentIds: stringList,
  material: { type: 'object', properties: { name: s, mimeType: s, originalText: s, originalBase64: s, text: s, extractedText: s, extractor: s }, additionalProperties: false },
  path: s, mode: s, scope: s, nodes: { type: 'array', items: { type: 'object', properties: { id: s, x: n, y: n, pinned: b, collapsed: b, color: s }, required: ['id'], additionalProperties: false } },
  region: { type: 'object', properties: { x: n, y: n, width: n, height: n }, required: ['x', 'y', 'width', 'height'], additionalProperties: false },
  viewport: { type: 'object', properties: { x: n, y: n, zoom: n }, additionalProperties: false }, expectedLayoutRevision: n,
  edits: { type: 'array', items: { type: 'object', properties: { action: s, params: object }, required: ['action', 'params'], additionalProperties: false } },
  provider: s, model: s, sessionId: s, turnId: s, turn: { type: ['string', 'number'] }, prompt: s, planId: s, outputReserveTokens: n, hardWindowTokens: n,
  maxTokens: n, maxInputTokens: n, maxCalls: n, maxIterations: n, reEvaluate: b, reviewerId: s, continueIndependent: b,
  operationId: s, recall: { type: 'array', items: { type: 'object', properties: { text: s, source: object }, additionalProperties: false } },
  segments: { type: 'array', items: { type: 'object', properties: { nodeIds: stringList }, required: ['nodeIds'], additionalProperties: false } },
  language: s, intent: s, archiveSources: b, format: s, includeContent: b, anonymous: b, data: {}, bundle: {},
  sourceId: s, externalId: s, root: s, projectRoots: stringList, excludes: stringList, authorized: b, enabled: b,
  records: { type: 'array' }, complete: b, maxSessions: n, maxFiles: n, maxStreamBytes: n, changed: b, removeImported: b,
  artifact: s, crossProject: b, includeRead: b, include_read: b, phrase: s, query: s, caseSensitive: b, full: b,
  cursor: s, limit: n, amount: { enum: ['lean', 'standard', 'generous'] }, reach: { enum: ['light', 'deep', 'full'] }, maxCandidates: n,
  topicId: s, sessionIds: stringList, userEdits: s,
};

export function graphActionSchema(action: string): JsonRecord {
  const required = ['workspace.attach', 'get', 'update', 'delete', 'node.add', 'node.update', 'node.delete', 'node.archive', 'node.duplicate', 'node.convert',
    'branch', 'wire', 'unlink', 'edge.update', 'highlight.add', 'highlight.remove', 'version.select', 'material.add', 'material.update', 'material.extract', 'material.recognize', 'material.attach',
    'layout', 'autoLayout', 'undo', 'redo', 'batch', 'context.preview', 'context.validate', 'generate', 'replay', 'review', 'condense.preview',
    'condense', 'merge', 'weave', 'diagnose', 'export', 'atlas.mount', 'atlas.remirror', 'session.fork', 'session.open', 'session.prompt'].includes(action) ? ['graphId'] : [];
  return { type: 'object', properties, required, additionalProperties: false };
}
