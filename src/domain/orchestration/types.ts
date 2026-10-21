/** Pure orchestration contracts. Actual dispatch, reservations and persistence belong to WorkflowRuntime. */
export type FactState = 'verified' | 'declared' | 'unknown' | 'unsupported';
export interface Fact<T> {
  state: FactState;
  value?: T;
  source: string;
  checkedAt?: string;
  expiresAt?: string;
  protocolAdapterVersion?: string;
}
export interface ModelRef {
  providerRouteId: string;
  modelId: string;
  endpointIdentity: string;
  protocol: string;
  revision?: string;
  credentialScopeId?: string;
  region?: string;
}
export interface PriceQuote {
  id: string;
  currency: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  unit: number;
  effectiveAt: string;
  source: string;
}
export type CapabilityName = 'text' | 'image' | 'audio' | 'toolCalling' | 'structuredOutput' |
  'streaming' | 'cancellation' | 'contextWindow' | 'maxOutputTokens' | 'reasoningEffort' | 'cacheModes' | 'dataResidency';
export interface CapabilityRule {
  capability: CapabilityName;
  minimum?: number;
  includes?: string;
  requireVerified?: boolean;
}
export interface ModelCandidate {
  ref: ModelRef;
  capabilities: Partial<Record<CapabilityName, Fact<boolean | number | readonly string[]>>>;
  executorIds: string[];
  authorized: boolean;
  credentialAvailable: boolean;
  /** Unknown permits an authorized on-call attempt; it is never proof of authentication. */
  credentialState?: 'available' | 'unavailable' | 'unknown';
  expiresAt?: string;
  health: 'healthy' | 'degraded' | 'open-circuit' | 'unknown';
  price?: PriceQuote;
  quality?: { lowerBound: number; samples: number; datasetVersion: string };
  latencyP95Ms?: number;
  cacheReuseEstimate?: number;
  failureRisk?: number;
  contextLineageIds?: string[];
}
export interface RoleModelPolicy {
  mode: 'inherit' | 'pinned' | 'ordered' | 'scored';
  candidates: (ModelRef | string)[];
  strictPool: boolean;
  minCapabilities: CapabilityRule[];
  effort?: { requested?: string; mode: 'exact' | 'at-least' | 'best-supported' | 'inherit'; orderedLevels?: string[] };
  fallback?: { allowPinnedSwitch: boolean; maxRetries: number; retryableCodes: string[] };
}
export interface AffinityLease {
  id: string;
  model: ModelRef;
  partitionId: string;
  expiresAt: string;
  nodeId?: string;
}
export interface ScoringWeights {
  quality: number; capability: number; cache: number; cost: number;
  latency: number; uncertainty: number; switch: number; failure: number;
}
export interface CandidateEvaluation {
  key: string;
  feasible: boolean;
  reasons: string[];
  score: number | null;
  knownCostUpperBound: number | null;
  currency?: string;
  effortStatus: 'selectable' | 'inherited-only' | 'unsupported' | 'unknown';
  effortResolved?: string;
  features?: Record<string, number>;
}
export interface RouteSelectionInput {
  id: string;
  nodeId: string;
  nodeAttempt: number;
  roleId: string;
  policy: RoleModelPolicy;
  catalog: ModelCandidate[];
  approvedPool: ModelRef[];
  inheritedModel?: ModelRef;
  inheritAvailable: boolean;
  hostSupportsAgentOptions: boolean;
  allowedExecutorIds: string[];
  inputTokens: number;
  maxOutputTokens: number;
  toolSchemaTokens?: number;
  retriesReserved?: number;
  remainingBudget?: { currency: string; amount: number };
  unknownCostPolicy: { mode: 'block' | 'bounded'; maxExposure?: number };
  allowedRegions?: string[];
  excludedModelKeys?: string[];
  excludedContextLineageIds?: string[];
  currentAffinity?: AffinityLease;
  hysteresisThreshold?: number;
  weights?: Partial<ScoringWeights>;
  normalization?: { maxCost: number; maxLatencyMs: number };
  authorizationRef: string;
  capabilitySnapshotRef: string;
  policyHash: string;
  cache: { promptEpoch: string; toolSurfaceEpoch: string; rendererVersion: string; namespace: string };
  now: string;
  leaseDurationMs?: number;
}
export interface RouteDecision {
  id: string;
  nodeId: string;
  nodeAttempt: number;
  policyHash: string;
  requestedRole: string;
  mode: 'inherit' | 'selected';
  selectedModel?: ModelRef;
  selectedExecutorId: string;
  candidateFacts: CandidateEvaluation[];
  effortRequested?: string;
  effortResolved?: string;
  effortStatus: CandidateEvaluation['effortStatus'];
  capabilitySnapshotRef: string;
  priceQuoteRef?: string;
  cachePartitionRef: string;
  cacheAffinityLeaseId: string;
  lease: AffinityLease | null;
  reasonCodes: string[];
  excludedCandidates: CandidateEvaluation[];
  authorizationRef: string;
  expiresAt: string;
  decisionHash: string;
}
export type Tier = 'FAST_PATH' | 'T0' | 'T1' | 'T2' | 'T3';
export type VerificationKind = 'code-behavior' | 'visual' | 'docs' | 'data' | 'service' | 'mechanical';
export interface OwnershipSurface {
  id: string;
  /** Canonical real paths resolved by the host. Planned paths must be verified before dispatch. */
  paths: string[];
  resources: string[];
  validated: boolean;
  planned?: boolean;
  ready: boolean;
}
export interface TaskShape {
  executionRequested: boolean;
  fullySpecified: boolean;
  designFork: boolean;
  lowImpact: boolean;
  surfaces: OwnershipSurface[];
  dependencies: { from: string; to: string }[];
  defectInvestigation?: boolean;
  allowAgents?: boolean;
  caseSensitivePaths?: boolean;
  unresolvedRequiredFacts?: string[];
}
export interface ShapeDecision {
  tier: Tier;
  blocked: boolean;
  reasons: string[];
  overlaps: { first: string; second: string; resources: string[] }[];
  overlays: string[];
  allowSpawn: boolean;
  assuranceGaps: string[];
}
export type EvidenceLevel = 'structural' | 'observed' | 'oracle';
export interface CheckPolicy {
  id: string;
  kind: 'command' | 'artifact' | 'metric' | 'review' | 'goal';
  required: boolean;
  expectedExit?: number;
  artifactRef?: string;
  nonEmpty?: boolean;
  expectedHash?: string;
  datasetRef?: string;
  metric?: { operator: '>=' | '<=' | '==' | '>' | '<'; threshold: number; tolerance?: number };
}
export interface GatePolicy {
  gateId: string;
  kind: string;
  scope: 'node' | 'lane' | 'run';
  requiredRoles: string[];
  checks: CheckPolicy[];
  requiredEvidenceLevels: EvidenceLevel[];
  onFail: 'block' | { loopTo: string };
  maxLoops: number;
  protected: boolean;
  independent?: boolean;
}
export interface RoleBinding {
  roleId: string;
  personaRef?: string;
  modelPolicy: RoleModelPolicy;
  allowedCapabilityIds: string[];
  ownedPathRules: string[];
  executorPolicy: { preferred: string; allowedExecutorIds: string[]; allowRecursive: boolean; maxDepth: number };
}
export interface BlueprintNode {
  id: string;
  kind: 'tier' | 'framework' | 'role' | 'gate' | 'complete';
  ref: string;
  laneId?: string;
  acceptanceCriteria?: string[];
}
export interface BlueprintEdge {
  from: string;
  to: string;
  kind: 'dependency' | 'failure';
}
export interface WorkflowBlueprint {
  schemaVersion: 1;
  id: string;
  revision: number;
  nodes: BlueprintNode[];
  roles: RoleBinding[];
  gates: GatePolicy[];
  edges: BlueprintEdge[];
  protectedInvariants: string[];
  budgets: { maxConcurrent: number | null; maxNodes: number | null; maxDepth: number | null;
    maxModelCalls: number | null; maxRetries: number; maxRepairRounds: number };
  sourceRefs: string[];
  releaseEligible: boolean;
  tier?: Tier;
}
export interface ValidationIssue { code: string; path: string; message: string }
export interface ActorEvidence {
  actorId: string;
  contextLineageId: string;
  model?: ModelRef;
  inheritedFullHistory?: boolean;
  inputRefs: { ref: string; kind: 'mission' | 'diff' | 'raw-evidence' | 'code' | 'test' |
    'author-claim' | 'prior-verdict' | 'reviewer-reasoning' | 'failure-trace' }[];
}
export interface CheckReceipt {
  checkId: string;
  kind: CheckPolicy['kind'];
  source: 'executor' | 'artifact-store' | 'oracle' | 'model';
  receiptRef: string;
  candidateSnapshotHash: string;
  contractHash: string;
  exitCode?: number | null;
  cancelled?: boolean;
  childResultValid?: boolean;
  sampled?: boolean;
  exists?: boolean;
  byteLength?: number;
  contentHash?: string;
  formatValid?: boolean;
  observedMetric?: number;
  datasetRef?: string;
  conclusion?: 'pass' | 'fail' | 'blocked' | 'inconclusive';
  evidenceRefs: string[];
}
export interface Finding {
  id: string;
  priority: 0 | 1 | 2 | 3;
  resolved: boolean;
  path?: string;
  trigger?: string;
  evidenceRefs: string[];
}
export interface GateVerdict {
  gateId: string;
  nodeId: string;
  actorId: string;
  contextLineageId: string;
  routeDecisionId: string;
  verdict: 'pass' | 'fail' | 'blocked' | 'inconclusive';
  verificationStatus: 'verified' | 'unverified' | 'not_applicable';
  candidateSnapshotHash: string;
  contractHash: string;
  evidenceRefs: string[];
  commandReceipts: string[];
  artifactHashes: string[];
  findings: Finding[];
  reasons: string[];
  createdAt: string;
  judgeVersion: string;
}
