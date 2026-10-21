import type { DispatchContext, HostAttemptReceipt, JsonRecord, ModelResult } from '../../ports/contracts.js';
import type { AffinityLease, Finding, GatePolicy, RouteDecision, RouteSelectionInput } from '../orchestration/types.js';

export type NodeState = 'queued' | 'starting' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelRequested' | 'cancelled' | 'timedOut' | 'interrupted' | 'effectUnknown' | 'blocked';
export type RunState = NodeState | 'paused';
export interface Budget {
  maxConcurrent: number;
  maxNodes: number;
  maxDepth: number;
  maxChildren: number;
  /** Hard admission limit at public LlmRuntime stream attempts; adapter HTTP retries are opaque. */
  maxModelCalls: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxWallMs: number;
  maxRetries: number;
  maxTokens?: number | { input?: number; output?: number; total?: number };
  maxCost?: number;
  deadline?: string;
  hardOrAdvisory?: 'hard' | 'advisory';
}
export interface RouteBinding {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  reasoning_effort?: string;
  agentPreset?: string;
  credentialScope?: string;
  requireObserved?: boolean;
  laneId?: string;
}
export interface Oracle {
  id?: string;
  kind: 'command' | 'file' | 'json' | 'metric' | 'artifact' | 'independence';
  command?: string;
  args?: string[];
  path?: string;
  artifactId?: string;
  nonEmpty?: boolean;
  sha256?: string;
  jsonPath?: string;
  equals?: unknown;
  min?: number;
  max?: number;
  minExclusive?: boolean;
  maxExclusive?: boolean;
  metric?: string;
  datasetRef?: string;
  expectedExitCode?: number;
  timeoutMs?: number;
  authorNodeIds?: string[];
  reviewerNodeIds?: string[];
  /** The reviewer actor being checked, distinct from the author subjects. */
  subjectNodeId?: string;
  requireDifferentModel?: boolean;
}
export interface TaskNode {
  id: string;
  kind: 'agent' | 'prompt' | 'tool' | 'cli' | 'session' | 'manual' | 'approval' | 'gate' | 'synthesis' | 'merge' | 'export' | 'review';
  role?: string;
  actorId?: string;
  parentId?: string;
  depth?: number;
  allowChildren?: boolean;
  prompt?: string;
  system?: string;
  domain?: string;
  action?: string;
  params?: JsonRecord;
  route?: RouteBinding;
  routeDecision?: RouteDecision;
  routingInput?: RouteSelectionInput;
  cacheLease?: AffinityLease | null;
  orchestration?: {
    blueprintNodeId: string; gateId?: string; gatePolicy?: GatePolicy; candidateRole: string;
    authorNodeIds: string[]; priorReviewerNodeIds: string[]; subjectNodeId?: string;
    contextLineageId: string; evidenceInputKinds: string[]; rootOwned: boolean; sourceMethodRefs: string[];
    capabilityIds?: string[];
  };
  cwd?: string;
  expertId?: string;
  inputRefs?: string[];
  writeClaims?: string[];
  dependsOn?: string[];
  checks?: Oracle[];
  timeoutMs?: number;
  maxTokens?: number;
  retryPolicy?: { maxRetries?: number; retryableCodes?: string[]; baseDelayMs?: number };
  outputContracts?: { nonEmpty?: boolean; json?: boolean; requiredFields?: string[] };
}
export interface TaskPlan {
  schemaVersion: 1;
  id: string;
  goal: string;
  scope: string;
  ownerSessionId: string;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  nodes: TaskNode[];
  edges: { from: string; to: string; optional?: boolean; kind?: string }[];
  budgets: Budget;
  deliveryContract: { requiredNodeIds: string[]; requireIndependentVerification: boolean; checks?: Oracle[] };
  authorizationRefs: string[];
  provenance: JsonRecord;
  /** Display coordinates only; execution always uses the validated DAG. */
  editor?: { schemaVersion: 1; layout: Record<string, { x: number; y: number }> };
  hash: string;
}
export interface ArtifactRef { id: string; hash: string; bytes: number; mediaType: string; path?: string; nodeId: string }
export interface GateReviewMission {
  schemaVersion: 1;
  runId: string;
  planHash: string;
  reviewerNodeId: string;
  reviewerActorId: string;
  subjectNodeIds: string[];
  candidateSnapshotHash: string;
  contractHash: string;
  missionHash: string;
  expectedArtifacts: { ref: string; hash: string; nodeId: string; kind: 'artifact' | 'file' }[];
  scope: string[];
  oracleIds: string[];
  oracleChecks: { ref: string; definition: Oracle }[];
  unavailableEvidence: string[];
}
export interface GateReviewEvidence {
  mission: GateReviewMission;
  reportRef: ArtifactRef;
  valid: boolean;
  verdict: 'pass' | 'fail' | 'needs-review';
  reasons: string[];
  findings: Finding[];
}
export interface NodeRun {
  id: string;
  actorId: string;
  state: NodeState;
  attempt: number;
  idempotencyKey: string;
  startedAt?: string;
  finishedAt?: string;
  activationId?: string;
  resultRef?: ArtifactRef;
  evidenceRefs: string[];
  error?: { code: string; message: string; details?: unknown };
  checkpoint?: JsonRecord;
  requestedRoute?: RouteBinding;
  observedRoute?: { provider?: string; model?: string; evidence?: unknown };
  routeDecision?: RouteDecision;
  resultError?: string;
  teardownError?: string;
  /** Host-bound review of author subjects; subjectNodeId on a gate still names its reviewer actor. */
  reviewEvidence?: GateReviewEvidence;
  execution?: {
    requestId: string;
    state: 'prepared' | 'started' | 'settled' | 'unknown';
    kind: TaskNode['kind'];
    receiptContext?: Pick<DispatchContext, 'scopeLevel' | 'workspaceId' | 'sessionId' | 'actorId' | 'workspaceRoot'>;
  };
}
export interface UsageAttempt {
  logicalCallId: string;
  attemptId: string;
  nodeId: string;
  model?: string;
  provider?: string;
  usage?: ModelResult['usage'];
  startedAt: string;
  finishedAt?: string;
  observed: boolean;
  source?: 'llm-runtime-stream';
  providerHttpAttempts?: 'opaque';
  sessionId?: string;
  inputBytes?: number;
  inputTokensUpperBound?: number;
  maxOutputTokens?: number;
  costUpperBound?: number;
  admissionHash?: string;
  status?: 'admitted' | 'reported' | 'unreported' | 'failed' | 'cancelled';
  usageRevision?: number;
  settlementHash?: string;
  /** Exact host receipt preserves additive online timings and provider evidence. */
  receipt?: HostAttemptReceipt;
}
export interface RunEvent {
  seq: number;
  at: string;
  type: string;
  nodeId?: string;
  actor: string;
  reason: string;
  data?: unknown;
}
export interface Run {
  schemaVersion: 1;
  id: string;
  planId: string;
  planRevision: number;
  planHash: string;
  planSnapshot: TaskPlan;
  ownerSessionId: string;
  initiator: string;
  state: RunState;
  startedAt: string;
  finishedAt?: string;
  terminalReason?: string;
  hostCapabilitySnapshot: JsonRecord;
  routeSnapshot: Record<string, RouteBinding>;
  nodeRuns: Record<string, NodeRun>;
  usage: { attempts: UsageAttempt[]; modelCalls: number; inputBytes: number; outputBytes: number; totalTokens: number | null; cost: number | null; complete: boolean; computeMs: number; wallMs: number };
  events: RunEvent[];
  artifacts: ArtifactRef[];
  paused: boolean;
  cancellationRequested: boolean;
}
export const DEFAULT_BUDGET: Budget = {
  maxConcurrent: 4, maxNodes: 64, maxDepth: 4, maxChildren: 8, maxModelCalls: 32,
  maxInputBytes: 4 * 1024 * 1024, maxOutputBytes: 8 * 1024 * 1024,
  maxWallMs: 30 * 60 * 1000, maxRetries: 1, hardOrAdvisory: 'hard',
};
export const TERMINAL = new Set<NodeState>(['succeeded', 'failed', 'cancelled', 'timedOut', 'blocked']);
