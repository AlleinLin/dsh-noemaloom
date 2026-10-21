export type NodeKind = 'conversation' | 'material' | 'note' | 'summary' | 'reviewer' | 'session';
export type EdgeKind = 'conversation' | 'explore' | 'reference' | 'review' | 'session-lineage' | 'task-dependency' | 'agent-communication';
export type HighlightKind = 'insight' | 'decision' | 'pivot' | 'rule-out' | 'open';

export interface SourceRef {
  sourceId: string;
  kind: 'session' | 'file' | 'url' | 'skill' | 'memory' | 'tool' | 'graph';
  sessionId?: string;
  turnId?: string;
  artifactId?: string;
  revision?: string;
  binding: 'pinned' | 'live';
  immutableVersion?: string;
  contentHash?: string;
  start?: number;
  end?: number;
}

export interface AnswerVersion {
  id: string;
  nodeId: string;
  previousId?: string;
  text: string;
  providerId: string;
  modelId: string;
  contextPlanId: string;
  inputHash: string;
  createdAt: string;
  status: 'partial' | 'complete' | 'failed' | 'cancelled';
  stale: boolean;
  staleCauses: SourceRef[];
  usageRequestIds: string[];
  sourceRevisionSet: Record<string, string>;
}

export interface Highlight {
  id: string;
  nodeId: string;
  versionId: string;
  start: number;
  end: number;
  text: string;
  textHash: string;
  kind: HighlightKind;
  page?: number;
}

export interface Material {
  id: string;
  name: string;
  mimeType: string;
  originalBase64?: string;
  originalText?: string;
  contentHash: string;
  extractedText: string;
  extractionVersion: string;
  versions: { id: string; text: string; createdAt: string; extractor: string }[];
  source?: SourceRef;
  page?: number;
  pages?: { page: number; text: string }[];
  extractionWarnings?: string[];
}

export interface GraphNode {
  id: string;
  graphId: string;
  kind: NodeKind;
  question: string;
  answerVersionIds: string[];
  activeVersionId?: string;
  versions: AnswerVersion[];
  rolePrompt?: string;
  roleMode?: 'inherit' | 'reset' | 'set-next';
  roleSourceNodeId?: string;
  attachmentIds: string[];
  excludedAttachmentIds: string[];
  includedAttachmentIds: string[];
  archived: boolean;
  source?: SourceRef;
  semanticRevision: string;
  x: number;
  y: number;
  pinned?: boolean;
  collapsed?: boolean;
  color?: string;
  highlights: Highlight[];
  moveKind?: HighlightKind;
  protected?: boolean;
  createdAt: string;
  derivedFrom?: { nodeId: string; versionId?: string; contentHash: string }[];
  sourceTurnId?: string;
  sourceSessionId?: string;
  mirrorEdited?: boolean;
}

export interface GraphEdge {
  id: string;
  graphId: string;
  from: string;
  to: string;
  kind: EdgeKind;
  contextMode: 'none' | 'quote' | 'full';
  order: number;
  quote?: { sourceVersionId: string; start: number; end: number; textHash: string };
}

export interface GraphSnapshot {
  scopeLevel?: 'global' | 'workspace' | 'session';
  ownerSessionId?: string;
  sourceGraphId?: string;
  schemaVersion: 1;
  id: string;
  title: string;
  workspaceRoot: string;
  projectId?: string;
  archived: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  materials: Material[];
  semanticRevision: string;
  createdAt: string;
  updatedAt: string;
}

export interface GraphDocument extends GraphSnapshot {
  history: { past: GraphSnapshot[]; future: GraphSnapshot[] };
}

export interface ContextItem {
  id: string;
  kind: 'system' | 'material' | 'reference' | 'user' | 'assistant' | 'recall';
  role: 'system' | 'user' | 'assistant';
  content: string;
  source: SourceRef;
  ordinal: number;
  estimatedTokens: number;
  estimateMethod: 'utf8-quarter-v1';
  selected: boolean;
  transformIds: string[];
  includedBecause: { edgeId?: string; nodeId: string; reason: string };
}

export interface GraphContextPlan {
  schemaVersion: 1;
  id: string;
  graphId: string;
  targetNodeId: string;
  graphRevision: string;
  sourceRevisionSet: Record<string, string>;
  items: ContextItem[];
  excluded: { source: SourceRef; reason: string }[];
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  builderVersion: 'thoughtdag-nexus-v1';
  providerId: string;
  modelId: string;
  estimatedPromptTokens: number;
  outputReserveTokens: number;
  hardWindowTokens?: number;
  semanticHash: string;
  frozenAt: string;
}

export interface GraphOperation {
  schemaVersion: 1;
  id: string;
  graphId: string;
  nodeId?: string;
  kind: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'orphaned';
  startedAt: string;
  finishedAt?: string;
  modelCalls: number;
  result?: unknown;
  error?: { code: string; message: string };
  externalEffects: string[];
}

export interface HistorySource {
  schemaVersion: 1;
  id: string;
  title: string;
  kind: 'dsh' | 'claude-code' | 'codex' | 'pi' | 'canvas' | 'memory';
  mode: 'host-port' | 'authorized-file-import' | 'external-live-source';
  enabled: boolean;
  authorized: boolean;
  root?: string;
  projectRoots: string[];
  excludes: string[];
  createdAt: string;
}

export interface ObservedTool {
  callId: string;
  name: string;
  arguments: unknown;
  result?: string;
  op: 'read' | 'edit' | 'write' | 'delete' | 'run' | 'other';
  artifacts: string[];
}

export interface HistoryTurn {
  id: string;
  itemIds?: string[];
  parentTurnId?: string;
  startSeq?: number;
  endSeq?: number;
  question: string;
  answer: string;
  materials: string[];
  tools: ObservedTool[];
  timestamp?: string;
  complete: boolean;
  contentHash: string;
}

export interface CanonicalSession {
  schemaVersion: 1;
  id: string;
  externalId: string;
  sourceId: string;
  agent: HistorySource['kind'];
  title: string;
  projectRoot: string;
  parentSessionId?: string;
  revision: string;
  parserVersion: string;
  turns: HistoryTurn[];
  warnings: { line?: number; offset?: number; message: string }[];
  cursor: number;
  byteLength: number;
  importedAt: string;
  changed: boolean;
  available: boolean;
  hidden: boolean;
  fileState?: { relative: string; byteLength: number; mtimeMs: number; cursor: number; prefixHash: string };
}
