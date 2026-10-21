export type JsonRecord = Record<string, unknown>;

// Compaction and the main plugin are separate bundles. A constructor identity
// cannot be used as their error wire contract.
const NEXUS_ERROR = Symbol.for('dsh-nexus.error.v1');
export class NexusError extends Error {
  readonly [NEXUS_ERROR] = true;
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
    this.name = 'NexusError';
  }
}

export function isNexusError(value: unknown): value is NexusError {
  if (!value || typeof value !== 'object') return false;
  try {
    const candidate = value as NexusError;
    return candidate[NEXUS_ERROR] === true && typeof candidate.message === 'string'
      && typeof candidate.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(candidate.code);
  } catch { return false; }
}

export interface NexusRequest {
  action: string;
  requestId?: string;
  target?: { id?: string; [key: string]: unknown };
  params?: JsonRecord;
  expectedRevision?: number;
  cursor?: string | null;
  limit?: number;
}

export interface StoredRecord<T = unknown> {
  id: string;
  revision: number;
  value: T;
  updatedAt: string;
}

export interface NexusStore {
  get<T = unknown>(collection: string, id: string): Promise<StoredRecord<T> | undefined>;
  put<T = unknown>(collection: string, id: string, value: T, expectedRevision?: number): Promise<StoredRecord<T>>;
  list<T = unknown>(collection: string): Promise<StoredRecord<T>[]>;
  remove(collection: string, id: string, expectedRevision?: number): Promise<boolean>;
  /** Explicit diagnostics only; scans must stay off normal reads. */
  checkIntegrity?(): Promise<JsonRecord>;
  cancelIntegrityCheck?(): Promise<JsonRecord>;
}

export interface ExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  durationMs: number;
  truncated?: boolean;
}

export interface ExecutionOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  /** Passed through the host subprocess stdin stream, never interpolated into argv. */
  stdin?: string;
  /** Non-consuming collected output; observer failures never cancel the command. */
  onOutput?: (output: { stream: 'stdout' | 'stderr'; text: string; nextOffset: number; lossy: boolean }) => void | Promise<void>;
}

export interface NexusExecutor {
  run(command: string, args: string[], options?: ExecutionOptions): Promise<ExecutionResult>;
}

/** One invocation of the public LlmRuntime stream boundary, before dispatch. */
export interface HostAttemptMetadata {
  attemptId: string;
  logicalCallId: string;
  runId: string;
  nodeId: string;
  sessionId: string;
  provider: string;
  model: string;
  startedAt: string;
  inputBytes: number;
  maxOutputTokens?: number;
  inputTokens?: number;
  /** Only authoritative upper bounds belong here; estimates stay absent. */
  inputTokensUpperBound?: number;
  costUpperBound?: number;
  costCurrency?: string;
  source: 'llm-runtime-stream';
  /** An adapter can retry HTTP internally without opening another runtime stream. */
  providerHttpAttempts: 'opaque';
}

export interface HostAttemptReceipt extends HostAttemptMetadata {
  finishedAt: string;
  status: 'reported' | 'unreported' | 'failed' | 'cancelled';
  usage?: JsonRecord;
  usageRevision?: number;
  /** Awaited policy admission only; excluded from stream TTFT. */
  admissionWaitMs?: number;
  /** Public stream dispatch start, after admission and cancellation checks. */
  dispatchStartedAt?: string;
  firstTextAt?: string;
  /** Unknown when no non-empty text delta was observed; never imputed as zero. */
  ttftState?: 'observed' | 'unknown';
  ttftMs?: number;
  ttftSource?: 'llm-runtime-stream:first-nonempty-text-delta';
  firstReasoningAt?: string;
  timeToFirstReasoningMs?: number;
  /** Provider-issued diagnostic ID from the public failure contract. */
  providerRequestId?: string;
  providerRequestIdSource?: 'llm-failure.requestId';
}

/** Process-local policy callbacks are never accepted from RPC/model arguments. */
export interface HostAttemptPolicy {
  version: 1;
  runId: string;
  nodeId: string;
  /** Reject before the provider boundary; implementations reserve atomically. */
  beforeAttempt(metadata: HostAttemptMetadata): Promise<void>;
  /** One final receipt per admitted attempt, including failed/cancelled streams. */
  settleAttempt(receipt: HostAttemptReceipt): Promise<void>;
}

export interface ModelRequest {
  role: string;
  prompt: string;
  provider?: string;
  model?: string;
  sessionId?: string;
  system?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  logicalCallId?: string;
  attemptId?: string;
  reasoningEffort?: string;
  /** Require a complete explicit route; never inherit the active session. */
  independentRoute?: boolean;
  /** Native tool spelling; blank means use the selected child model's maximum. */
  reasoning_effort?: string;
  agentPreset?: string;
  parentId?: string;
  /** Optional asserted credential route scope; secret material is never accepted. */
  credentialScope?: string;
  /** Ordered previewed text messages; prompt is used only when this is absent. */
  messages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  /** Image bytes are admitted by the official attachment service before a call. */
  images?: Array<{ mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; dataBase64: string; name?: string }>;
  readOnly?: boolean;
  allowChildren?: boolean;
  maxDepth?: number;
  actorRole?: string;
  allowedCapabilityIds?: string[];
  /** Inherited by the owned child and every live runtime descendant. */
  attemptPolicy?: HostAttemptPolicy;
}

export interface ModelResult {
  text: string;
  provider?: string;
  model?: string;
  usage?: JsonRecord;
  providerRequestId?: string;
  evidence?: unknown;
}

export interface ChildActivation {
  id: string;
  result: Promise<ModelResult>;
  dispose(): Promise<void>;
}

export interface NexusHost {
  facts(): Promise<JsonRecord>;
  model(request: ModelRequest): Promise<ModelResult>;
  spawn(request: ModelRequest & { parentId?: string; cwd?: string }): Promise<ChildActivation>;
  sessions(action: string, params: JsonRecord): Promise<unknown>;
  secret(reference: string): Promise<string | undefined>;
  approve(action: string, resource: string, details?: JsonRecord): Promise<boolean>;
}

export interface NexusServices {
  store: NexusStore;
  executor: NexusExecutor;
  host: NexusHost;
  dataDir: string;
  workspaceRoot: string;
  /** Installed package root, used for bundled read-only resources. */
  packageRoot?: string;
  signal?: AbortSignal;
  emit(event: string, data: unknown): void;
  /** Calls the same dispatcher used by authenticated UI and native tools. */
  invoke(domain: string, request: NexusRequest, context?: DispatchContext): Promise<unknown>;
  /** Read the original durable dispatcher receipt without executing or replaying its intent. */
  readReceipt?(requestId: string, context?: DispatchContext): Promise<{
    ok: boolean; data?: unknown; error?: { code: string; message: string; effects?: unknown; details?: unknown } | null;
  } | undefined>;
}

export interface DispatchContext {
  scopeLevel?: 'global' | 'workspace' | 'session';
  workspaceId?: string;
  signal?: AbortSignal;
  sessionId?: string;
  actorId?: string;
  workspaceRoot?: string;
  /** Runtime permission evidence supplied by the host, never accepted from RPC params. */
  permissions?: ReadonlySet<string>;
}

export interface Capability {
  action: string;
  description: string;
  mutating?: boolean;
  permission?: string;
  schema?: JsonRecord;
}

export interface NexusModule {
  id: string;
  capabilities: Capability[];
  dispatch(request: NexusRequest, context?: DispatchContext): Promise<unknown>;
  dispose?(): Promise<void> | void;
}

export type NexusModuleFactory = (services: NexusServices) => NexusModule | Promise<NexusModule>;

export function requiredString(params: JsonRecord, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new NexusError('INVALID_ARGUMENT', `${name} 必须为非空字符串`);
  }
  return value;
}

export function recordParams(request: NexusRequest): JsonRecord {
  return request.params ?? {};
}
