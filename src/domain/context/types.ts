import type { CompressionState, Config, CoreMessage, FoldEvent, MessageContentStore } from '../../../vendor/acp-kernel/src/index.js';
import type { ContextRequestOwner } from './request-lifecycle.js';

export type ContextMode = 'auto' | 'observe' | 'disabled';
export interface RouteIdentity {
  providerId: string;
  modelId: string;
  endpointId?: string;
  accountAlias?: string;
  region?: string;
  protocol?: string;
  adapterVersion?: string;
  resolvedModelStatus?: 'known' | 'unknown';
}
export interface ContextIdentity {
  sessionId: string;
  branchId?: string;
  purpose?: string;
  lane?: string;
}
export interface ContextPrepareInput extends ContextIdentity {
  messages: CoreMessage[];
  system?: string;
  tools?: unknown[];
  memorySnapshot?: string;
  route: RouteIdentity;
  windowTokens: number;
  outputReserveTokens?: number;
  logicalCallId?: string;
  attemptId?: string;
  /** The adapter must set actualWire only AFTER final protocol serialization. */
  actualWire?: string;
  renderTags?: 'all' | 'text-only' | 'none';
  config?: Partial<Config>;
  autoDecide?: boolean;
}
export interface Epochs {
  promptEpoch: number;
  toolSurfaceEpoch: number;
  memorySnapshotEpoch: number;
  routeEpoch: number;
  serializationEpoch: number;
  compressionEpoch: number;
}
export interface StaticSnapshot {
  system: string;
  tools: unknown[];
  memorySnapshot: string;
  route: RouteIdentity;
  rendererVersion: string;
}
export interface OriginalRef {
  id: string;
  sourceId: string;
  sourceHash: string;
  /** Frozen permanent alias, independent of the kernel's current ref map. */
  messageRef?: string;
  nativeMessageId?: string;
  objectId: string;
  contentHash: string;
  ordinal: number;
}
export interface ContextSession {
  schemaVersion: 1;
  key: string;
  sessionId: string;
  branchId: string;
  purpose: string;
  lane: string;
  workspaceRoot: string;
  mode: ContextMode;
  owner: 'nexus/acp-kernel';
  state: CompressionState;
  originals: OriginalRef[];
  liveMessageIds?: string[];
  /** Full official surface order, including empty messages omitted by deriveMessages. */
  nativeSurfaceSeqs?: number[];
  contentStore: MessageContentStore;
  epochs: Epochs;
  accepted?: StaticSnapshot;
  pending?: StaticSnapshot;
  inFlight: string[];
  config?: Partial<Config>;
  windowTokens?: number;
  outputReserveTokens: number;
  latestPlanId?: string;
  latestWireId?: string;
  latestProjectionId?: string;
  latestActualWireId?: string;
  folds: FoldEvent[];
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}
export interface ContextPlanRecord {
  schemaVersion: 1;
  id: string;
  sessionKey: string;
  sessionId: string;
  purpose: string;
  lane: string;
  epochs: Epochs;
  messages: CoreMessage[];
  system: string;
  tools: unknown[];
  memorySnapshotHash: string;
  sourceRevisionSet: Record<string, string>;
  semanticHash: string;
  projectedBytes: number;
  estimatedPromptTokens: number;
  estimateMethod: 'acp-kernel/defaultCountTokens-v0.0.136';
  outputReserveTokens: number;
  hardWindowTokens: number;
  frozenAt: string;
  wireId: string;
  modelGuidance?: string;
  diagnostics: Record<string, unknown>;
  requestOwner?: ContextRequestOwner;
}
export interface WireArtifact {
  schemaVersion: 1;
  id: string;
  sessionKey: string;
  planId: string;
  previousId?: string;
  routeHash: string;
  epochs: Epochs;
  bytesHash: string;
  byteLength: number;
  /** Projection artifacts are never claimed to be the actual provider wire. */
  stage: 'projection' | 'actual-wire';
  serialized: string;
  prefixBytes: number;
  firstDifference: number | null;
  reason: string;
  observedAt: string;
}
export interface PhysicalUsage {
  state: 'valid' | 'missing' | 'ambiguous' | 'invalid';
  totalInputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  evidence: 'provider-reported' | 'host-normalized' | 'unobserved';
  semanticsVersion: string;
  errors: string[];
}
export interface ContextObservation {
  schemaVersion: 1;
  sessionKey: string;
  planId: string;
  logicalCallId: string;
  attemptId: string;
  providerRequestId?: string;
  completion: 'interim' | 'final';
  usage: PhysicalUsage;
  rawUsage?: unknown;
  observedAt: string;
}
