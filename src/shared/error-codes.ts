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
export interface FailureContext { phase?: string; signalAborted?: boolean }
const CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const TRANSPORT = new Set(['TRANSPORT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT', 'ERR_NETWORK', 'NETWORK_ERROR']);
const TIMEOUT = new Set(['TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const AUTH = new Set(['AUTH', 'INVALID_CREDENTIAL', 'PERMISSION_DENIED', 'UNAUTHORIZED', 'FORBIDDEN']);
const contextFailure = (code: string) => code.startsWith('CTX_') || code === 'SESSION_DURABILITY_UNVERIFIED';
const pendingEffect = (code: string) => code === 'PARTIAL_EFFECT' || code.includes('PENDING_OPERATION') || code.endsWith('_EFFECT_UNVERIFIED');
const policyFailure = (code: string) => code.includes('BUDGET') || code.endsWith('APPROVAL_REQUIRED') || code === 'POLICY_DENIED';

function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' ? value as Record<string, any> : {};
}
/** Inspect bounded cause metadata, never serialize exception text or provider bodies. */
export function classifyFailure(error: unknown, context: FailureContext = {}): FailureDiagnosis {
  const root = record(error);
  const chain = [root];
  const seen = new Set<object>(chain);
  for (let i = 0; i < chain.length && chain.length < 6; i++) {
    for (const candidate of [chain[i]!.cause, chain[i]!.failure]) {
      if (candidate && typeof candidate === 'object' && !seen.has(candidate)) {
        seen.add(candidate); chain.push(candidate);
      }
    }
  }
  const codes = chain.map(item => typeof item.code === 'string' && CODE.test(item.code) ? item.code : '').filter(Boolean);
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
  const hardCode = codes.find(code => contextFailure(code) || pendingEffect(code) || policyFailure(code));
  const raw = hardCode ?? codes.find(code => code !== 'UNKNOWN') ?? 'UNKNOWN';
  const status = chain.map(item => item.status ?? item.statusCode).find(value => Number.isInteger(value) && value >= 100 && value <= 599);
  const requestId = chain.map(item => item.requestId).find(value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value));
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
  } else if (raw === 'RATE_LIMIT' || status === 429) {
    diagnosticCode = 'NX_GATEWAY_RATE_LIMIT'; category = 'gateway'; canonicalCode = 'RATE_LIMIT'; retryable = true;
  } else if (raw === 'SERVER' || (status !== undefined && status >= 500)) {
    diagnosticCode = 'NX_GATEWAY_UNAVAILABLE'; category = 'gateway'; canonicalCode = 'SERVER'; retryable = true;
  } else if (raw === 'MODEL_OUTPUT_LIMIT') {
    diagnosticCode = 'NX_MODEL_OUTPUT_LIMIT'; category = 'provider';
  } else if (raw === 'EMPTY_RESPONSE') {
    diagnosticCode = 'NX_PROVIDER_EMPTY_RESPONSE'; category = 'provider'; canonicalCode = 'EMPTY_RESPONSE'; retryable = true;
  } else if (raw === 'INVALID_ARGUMENT' || raw.startsWith('INVALID_') || status === 400 || status === 404 || status === 422) {
    diagnosticCode = 'NX_REQUEST_REJECTED'; category = 'provider';
  } else if (raw === 'UNKNOWN' || raw === 'UNCLASSIFIED_FAILURE') {
    diagnosticCode = 'NX_UNKNOWN_FAILURE'; category = 'unattributed';
  } else {
    diagnosticCode = 'NX_INTERNAL_FAILURE'; category = 'internal';
  }
  return { diagnosticCode, canonicalCode, category, retryable, message: ERROR_CODES[diagnosticCode],
    phase: context.phase ?? 'operation', ...(status !== undefined ? { status } : {}), ...(requestId ? { requestId } : {}) };
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
