import { isNexusError } from '../ports/contracts.js';

/** Stable public diagnostics. Provider retry routing continues to use canonicalCode. */
export const ERROR_CODES = {
  NX_NETWORK_TRANSPORT: '网络连接失败',
  NX_NETWORK_TIMEOUT: '模型请求超时',
  NX_GATEWAY_RATE_LIMIT: '网关限流或容量不足',
  NX_GATEWAY_UNAVAILABLE: '网关或模型服务暂不可用',
  NX_AUTH_DENIED: '凭据、订阅或模型访问权限被拒绝',
  NX_REQUEST_REJECTED: '模型请求配置被拒绝',
  NX_PROVIDER_EMPTY_RESPONSE: '模型返回空响应',
  NX_MODEL_OUTPUT_LIMIT: '模型输出预算已耗尽（包含思考 token），未获得完整回答',
  NX_PROVIDER_FAILURE: '模型服务返回错误',
  NX_CANCELLED: '请求取消信号已触发',
  NX_ABORT_UNATTRIBUTED: '取消来源未识别',
  NX_CONTEXT_MAINTENANCE: '上下文维护未完成',
  NX_CONTEXT_WINDOW_EXCEEDED: '当前模型请求超出有效上下文窗口；仅在正式压缩并核实缩减后重试',
  NX_PENDING_EFFECT: '已有操作结果待核实',
  NX_POLICY_BLOCKED: '权限或预算策略阻止执行',
  NX_INTERNAL_FAILURE: '内部操作失败',
  NX_UNKNOWN_FAILURE: '错误来源尚未识别',
  NX_OBSERVATION_DEFERRED: '独立记账已延后恢复',
  NX_STREAM_TAIL_RECOVERED: '已保留完整响应并恢复收尾',
  NX_RETRY_EXHAUSTED: '自动重试次数已耗尽',
  NX_RETRY_DELAY_UNSUPPORTED: '服务要求的等待时间超过重试策略上限',
  NX_RETRY_DISABLED: '当前策略不允许自动重试',
  NX_RECOVERY_FAILED: '恢复操作未完成',
} as const;

export type DiagnosticCode = keyof typeof ERROR_CODES;
export interface FailureDiagnosis {
  diagnosticCode: DiagnosticCode;
  canonicalCode: string;
  category: 'network' | 'gateway' | 'authorization' | 'cancelled' | 'unattributed' | 'internal' | 'provider';
  retryable: boolean;
  message: string;
  phase: string;
  status?: number;
  requestId?: string;
}
export interface FailureContext { phase?: string; signalAborted?: boolean; provenance?: 'provider' | 'local-admission' }
export interface FailureMetadata {
  causeCodes: string[];
  provenance?: 'provider';
  authorityDenied?: true;
  status?: number;
  requestId?: string;
  providerRetryAfterMs?: number;
}
const CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const TRANSPORT = new Set(['TRANSPORT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT', 'ERR_NETWORK', 'NETWORK_ERROR']);
const TIMEOUT = new Set(['TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const AUTH = new Set(['AUTH', 'INVALID_CREDENTIAL', 'PERMISSION_DENIED', 'UNAUTHORIZED', 'FORBIDDEN']);
const contextFailure = (code: string) => code.startsWith('CTX_') || code === 'SESSION_DURABILITY_UNVERIFIED';
const pendingEffect = (code: string) => code === 'PARTIAL_EFFECT' || code.includes('PENDING_OPERATION') || code.endsWith('_EFFECT_UNVERIFIED');
const policyFailure = (code: string) => code.includes('BUDGET') || code.endsWith('APPROVAL_REQUIRED') || code === 'POLICY_DENIED';
const OVERFLOW = new Set(['CONTEXT_WINDOW_EXCEEDED', 'CONTEXT_LENGTH_EXCEEDED', 'MAX_CONTEXT_LENGTH_EXCEEDED', 'PROMPT_TOO_LONG']);
const RATE_LIMIT = new Set(['RATE_LIMIT', 'RATE_LIMITED', 'RATE_LIMIT_EXCEEDED', 'TOO_MANY_REQUESTS']);

/** Bounded provider metadata traversal; never expose response bodies. */
export function failureChain(error: unknown): Record<string, any>[] {
  const chain = [record(error)], seen = new Set<object>(chain);
  for (let i = 0; i < chain.length && i < 12; i++) {
    for (let candidate of [chain[i]!.cause, chain[i]!.failure, chain[i]!.error, chain[i]!.body, chain[i]!.response, chain[i]!.data, chain[i]!.details]) {
      if (typeof candidate === 'string' && candidate.length <= 32768 && candidate.trimStart().startsWith('{')) {
        try { candidate = JSON.parse(candidate); } catch { continue; }
      }
      if (candidate && typeof candidate === 'object' && !seen.has(candidate) && chain.length < 12) {
        seen.add(candidate); chain.push(candidate);
      }
    }
  }
  return chain;
}

function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' ? value as Record<string, any> : {};
}
/** Copy only bounded public causal fields, including across bundled Nexus wrappers. */
export function failureMetadata(error: unknown): FailureMetadata {
  const chain = failureChain(error);
  const causeCodes = [...new Set(chain.flatMap(item => [item.code, ...(Array.isArray(item.causeCodes) ? item.causeCodes.slice(0, 12) : [])])
    .filter((value): value is string => typeof value === 'string' && CODE.test(value)))].slice(0, 12);
  const status = chain.map(item => item.status ?? item.statusCode).find(value => Number.isInteger(value) && value >= 100 && value <= 599);
  const requestId = chain.map(item => item.requestId).find(value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value));
  const providerRetryAfterMs = chain.map(item => item.providerRetryAfterMs)
    .find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400_000);
  const provenance = chain.some(item => item.provenance === 'provider' || item.name === 'LlmError'
    || isNexusError(item) && record(item.details).provenance === 'provider') ? 'provider' as const : undefined;
  const authorityDenied = chain.some(item => item.authorityDenied === true
    || isNexusError(item) && item.code === 'PERMISSION_DENIED' && record(item.details).provenance !== 'provider');
  return { causeCodes, ...(status === undefined ? {} : { status }), ...(requestId ? { requestId } : {}),
    ...(provenance ? { provenance } : {}), ...(authorityDenied ? { authorityDenied: true as const } : {}),
    ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }) };
}
/** Inspect bounded cause metadata, never serialize exception text or provider bodies. */
export function classifyFailure(error: unknown, context: FailureContext = {}): FailureDiagnosis {
  const chain = failureChain(error);
  const metadata = failureMetadata(error);
  const codes = chain.flatMap(item => [item.code, ...(Array.isArray(item.causeCodes) ? item.causeCodes.slice(0, 12) : [])])
    .filter((value): value is string => typeof value === 'string' && CODE.test(value));
  const overflow = chain.some(item => [item.code, item.type].some(value =>
    typeof value === 'string' && value.length <= 96 && OVERFLOW.has(value.toUpperCase())));
  // Some adapters have already reduced a socket Error to a released failure
  // snapshot. Recognize exact platform markers without retaining its body.
  for (const item of chain) {
    if (typeof item.message !== 'string' || item.message.length > 32768) continue;
    const marker = /\b(ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)\b/.exec(item.message)?.[1];
    if (marker) codes.push(marker);
    if (/^(?:fetch failed|Failed to fetch|Network request failed)\.?$/i.test(item.message)) codes.push('TRANSPORT');
  }
  // Wrappers may report ABORTED/TRANSPORT while their cause records a hard
  // policy failure. Those failures must keep their identity and must never
  // become a retry or successful-tail recovery just because of the wrapper.
  const hardCode = codes.find(code => contextFailure(code) || pendingEffect(code) || policyFailure(code))
    ?? (overflow ? 'CONTEXT_WINDOW_EXCEEDED' : undefined);
  const raw = hardCode ?? codes.find(code => code !== 'UNKNOWN') ?? 'UNKNOWN';
  const { status, requestId } = metadata;
  // RATE_LIMITED is also the local lease admission contract. A branded local
  // error is not evidence of a provider request or permission to retry it.
  const localAdmission = context.provenance === 'local-admission'
    || chain.some(item => item.code === 'RATE_LIMITED' && isNexusError(item) && record(item.details).provenance !== 'provider');
  const providerRateLimit = status === 429 || context.provenance === 'provider'
    || !localAdmission && codes.some(code => RATE_LIMIT.has(code));
  let canonicalCode = raw;
  let diagnosticCode: DiagnosticCode;
  let category: FailureDiagnosis['category'];
  let retryable = false;
  const aborted = chain.some(item => item.name === 'AbortError' || item.code === 'ABORTED' || item.code === 'CANCELLED'
    || (item.code === 'UNKNOWN' && /^(?:操作已取消。?|The operation was aborted\.?|This operation was aborted\.?)$/i.test(item.message ?? '')));
  const quota = codes.some(code => /(?:QUOTA|CREDIT|BALANCE|PAYMENT)/.test(code)) || status === 402
    || chain.some(item => typeof item.message === 'string' && item.message.length <= 32768
      && /insufficient[_ -]?quota|quota.{0,20}exceeded|insufficient.{0,20}(?:credits?|balance|funds)|credit balance|payment required|余额不足|额度(?:不足|耗尽)/i.test(item.message));
  const subscription = chain.some(item => typeof item.message === 'string' && item.message.length <= 32768
    && /subscription.{0,100}(?:does not have access|no access|expired|invalid|not active)|does not have access to|订阅.{0,20}(?:无权|过期|不足)/i.test(item.message));
  if (context.signalAborted) {
    diagnosticCode = 'NX_CANCELLED'; category = 'cancelled'; canonicalCode = 'ABORTED';
  } else if (contextFailure(raw)) {
    diagnosticCode = 'NX_CONTEXT_MAINTENANCE'; category = 'internal';
  } else if (pendingEffect(raw)) {
    diagnosticCode = 'NX_PENDING_EFFECT'; category = 'internal';
  } else if (policyFailure(raw)) {
    diagnosticCode = 'NX_POLICY_BLOCKED'; category = 'internal';
  } else if (raw === 'CONTEXT_WINDOW_EXCEEDED') {
    diagnosticCode = 'NX_CONTEXT_WINDOW_EXCEEDED'; category = 'provider';
  } else if (quota) {
    diagnosticCode = 'NX_AUTH_DENIED'; category = 'authorization'; canonicalCode = 'QUOTA_EXCEEDED';
  } else if (codes.some(code => AUTH.has(code)) || subscription || status === 401 || status === 403) {
    diagnosticCode = 'NX_AUTH_DENIED'; category = 'authorization'; canonicalCode = AUTH.has(raw) ? raw : 'AUTH';
  } else if (aborted) {
    diagnosticCode = 'NX_ABORT_UNATTRIBUTED'; category = 'unattributed'; canonicalCode = 'ABORTED';
  } else if (codes.some(code => TIMEOUT.has(code)) || status === 408 || status === 504 || chain.some(item => item.name === 'TimeoutError')) {
    diagnosticCode = 'NX_NETWORK_TIMEOUT'; category = 'network'; canonicalCode = 'TIMEOUT'; retryable = true;
  } else if (codes.some(code => TRANSPORT.has(code))) {
    diagnosticCode = 'NX_NETWORK_TRANSPORT'; category = 'network'; canonicalCode = 'TRANSPORT'; retryable = true;
  } else if (providerRateLimit && (codes.some(code => RATE_LIMIT.has(code)) || status === 429)) {
    diagnosticCode = 'NX_GATEWAY_RATE_LIMIT'; category = 'gateway'; canonicalCode = 'RATE_LIMIT'; retryable = true;
  } else if (raw === 'SERVER' || (status !== undefined && status >= 500)) {
    diagnosticCode = 'NX_GATEWAY_UNAVAILABLE'; category = 'gateway'; canonicalCode = 'SERVER'; retryable = true;
  } else if (raw === 'MODEL_OUTPUT_LIMIT') {
    diagnosticCode = 'NX_MODEL_OUTPUT_LIMIT'; category = 'provider';
  } else if (raw === 'EMPTY_RESPONSE') {
    diagnosticCode = 'NX_PROVIDER_EMPTY_RESPONSE'; category = 'provider'; canonicalCode = 'EMPTY_RESPONSE'; retryable = true;
  } else if (raw === 'INVALID_ARGUMENT' || raw.startsWith('INVALID_') || status === 400 || status === 404 || status === 422) {
    diagnosticCode = 'NX_REQUEST_REJECTED'; category = 'provider';
  } else if (raw === 'PI_AI_ERROR') {
    diagnosticCode = 'NX_PROVIDER_FAILURE'; category = 'provider';
  } else if (raw === 'UNKNOWN' || raw === 'UNCLASSIFIED_FAILURE') {
    diagnosticCode = 'NX_UNKNOWN_FAILURE'; category = 'unattributed';
  } else {
    diagnosticCode = 'NX_INTERNAL_FAILURE'; category = 'internal';
  }
  return { diagnosticCode, canonicalCode, category, retryable, message: ERROR_CODES[diagnosticCode],
    phase: context.phase ?? 'operation', ...(status !== undefined ? { status } : {}), ...(requestId ? { requestId } : {}) };
}

/** Optional preparation may fail open only before an authoritative stop/effect boundary. */
export function mustStopAfterAuxiliaryFailure(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const chain = failureChain(error);
  const codes = chain.flatMap(item => [item.code, ...(Array.isArray(item.causeCodes) ? item.causeCodes.slice(0, 12) : [])])
    .filter((value): value is string => typeof value === 'string' && CODE.test(value));
  const metadata = failureMetadata(error);
  return metadata.authorityDenied === true
    || codes.includes('PERMISSION_DENIED') && metadata.provenance !== 'provider'
    || codes.some(code => pendingEffect(code) || policyFailure(code)
    || ['ABORTED', 'CANCELLED', 'CTX_NATIVE_RECONCILIATION_REQUIRED', 'SESSION_DURABILITY_UNVERIFIED'].includes(code))
    || chain.some(item => item.name === 'AbortError' || item.officialEffect === 'unknown'
      || item.effect === 'unknown-or-pending');
}

/** A successful terminal permits only connection/iterator cleanup recovery, never policy recovery. */
export function isRecoverableStreamTail(error: unknown, context: FailureContext = {}): boolean {
  if (context.signalAborted) return false;
  const code = record(error).code;
  if (typeof code === 'string' && !TRANSPORT.has(code) && !TIMEOUT.has(code)
    && !['UNKNOWN', 'UNCLASSIFIED_FAILURE', 'ABORTED', 'CANCELLED'].includes(code)) return false;
  const diagnosis = classifyFailure(error, context);
  return diagnosis.category === 'network' || diagnosis.diagnosticCode === 'NX_ABORT_UNATTRIBUTED';
}
