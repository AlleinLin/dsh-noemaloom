import * as React from 'react';
import { ERROR_CODES } from '../shared/error-codes.js';
import type { ClientContext } from './types.js';

const TYPE = 'plugin:nexus/request-recovery';
const outcomes = new Set(['delegated', 'scheduled', 'retry-started', 'stopped', 'recovered', 'failed', 'deferred']);
const CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const TOKEN = /^[a-zA-Z0-9._:/-]{1,160}$/;
const emptyWindow = Object.freeze({ entries: [] as readonly unknown[] });
const noSubscription = () => () => {};
export interface RecoveryDiagnostic {
  id: string;
  seq: number;
  at: string;
  sessionId: string;
  diagnosticCode: string;
  canonicalCode: string;
  message: string;
  phase: string;
  outcome: string;
  retry: number;
  maxRetries?: number;
  stopReason?: string;
  status?: number;
  requestId?: string;
  traceId?: string;
}
function text(value: unknown, pattern = TOKEN): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10000;
}
function explanation(code: string): string | undefined {
  return Object.hasOwn(ERROR_CODES, code) ? (ERROR_CODES as Record<string, string>)[code] : undefined;
}

/**
 * Read the public ignorable-plugin-record envelope, then validate our own data.
 * The Host-only dsh-session entry point cannot be imported into a browser.
 */
export function recoveryDiagnostics(entries: readonly unknown[], sessionId: string, limit = 8): RecoveryDiagnostic[] {
  if (!sessionId || limit <= 0) return [];
  const records: RecoveryDiagnostic[] = [];
  const seen = new Set<string>();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as any;
    if (entry?.type !== 'event') continue;
    const event = entry.event;
    if (event?.type !== TYPE || event.ignorable !== true || !Number.isSafeInteger(event.seq) || event.seq < 0) continue;
    const data = event.data;
    if (!data || data.schemaVersion !== 1 || data.sessionId !== sessionId || !outcomes.has(data.outcome)
      || !text(data.id) || !text(data.diagnosticCode, CODE) || !text(data.canonicalCode, CODE)
      || !text(data.phase) || !count(data.retry)) continue;
    if (seen.has(data.id)) continue;
    seen.add(data.id);
    const eventTime = new Date(Number.isFinite(event.time) ? event.time : 0);
    const at = typeof data.at === 'string' && Number.isFinite(Date.parse(data.at))
      ? data.at : Number.isFinite(eventTime.getTime()) ? eventTime.toISOString() : new Date(0).toISOString();
    records.push({
      id: data.id, seq: event.seq, at, sessionId,
      diagnosticCode: data.diagnosticCode, canonicalCode: data.canonicalCode,
      // Provider bodies and error text never become presentation copy.
      message: explanation(data.diagnosticCode) ?? '请求状态已更新',
      phase: data.phase, outcome: data.outcome, retry: data.retry,
      ...(count(data.maxRetries) ? { maxRetries: data.maxRetries } : {}),
      ...(text(data.stopReason) ? { stopReason: data.stopReason } : {}),
      ...(Number.isInteger(data.status) && data.status >= 100 && data.status <= 599 ? { status: data.status } : {}),
      ...(text(data.requestId) ? { requestId: data.requestId } : {}),
      ...(text(data.traceId) ? { traceId: data.traceId } : {}),
    });
  }
  return records.sort((a, b) => b.seq - a.seq).slice(0, Math.min(20, limit));
}

export function recoveryDiagnosticLabel(record: RecoveryDiagnostic, running = true): string {
  const attempts = record.maxRetries === undefined ? `${record.retry}` : `${record.retry}/${record.maxRetries}`;
  if (record.outcome === 'scheduled') return `${running ? '等待重试' : '重试记录'} ${attempts}`;
  if (record.outcome === 'retry-started') return `${running ? '正在重试' : '重试记录'} ${attempts}`;
  if (record.outcome === 'recovered') return '已恢复';
  if (record.outcome === 'stopped') return '已停止';
  if (record.outcome === 'failed') return '恢复未完成';
  if (record.outcome === 'deferred') return '恢复已延后';
  return '恢复诊断';
}

/** A later owning boundary makes an old retry historical, even during a new turn. */
export function recoveryRetryActive(record: RecoveryDiagnostic, entries: readonly unknown[], running: boolean): boolean {
  if (!running || !['scheduled', 'retry-started'].includes(record.outcome)) return false;
  return !entries.some((entry: any) => entry?.type === 'event' && entry.event?.seq > record.seq
    && ['turn/start', 'turn/end', 'step/end'].includes(entry.event.type));
}

export function recoveryStopReason(reason?: string): string | undefined {
  if (!reason) return;
  const reasons: Record<string, string> = {
    'retry-exhausted': '自动重试次数已耗尽',
    'retry-disabled': '当前策略不允许自动重试',
    'retry-delay-unsupported': '等待时间超过重试策略上限',
    'signal-aborted': '请求取消信号已触发',
    'user-cancelled': '用户已停止请求',
    'parent-cancelled': '父任务已停止请求',
    'hook-cancelled': '请求被扩展钩子停止',
    'agent-disposed': '执行此请求的代理已退出',
    'plugin-disposed': '恢复插件已停止',
    'authorization-denied': '模型访问权限被拒绝',
    'quota-denied': '可用配额不足',
    'budget-denied': '已达到预算上限',
    'session-deleted': '会话已删除',
    'recovery-handler-failed': '恢复处理未完成',
    'recovery-state-unavailable': '恢复状态暂不可用',
    'recovery-record-failed': '恢复记录未能保存',
    'native-retry-stopped': '原生重试已停止',
    'not-retryable': '此原因不适合自动重试',
  };
  return explanation(reason) ?? (Object.hasOwn(reasons, reason) ? reasons[reason] : undefined)
    ?? (reason.startsWith('OBSERVATION_') ? '独立记账等待恢复' : reason);
}

/** The surrounding original SessionProvider supplies all identity and lifecycle. */
export function registerRecoveryDiagnostics(rawContext: ClientContext): () => void {
  const ctx = rawContext as any;
  let disposed = false;
  function Diagnostics(props: any) {
    const session = props.useSession((value: any) => value);
    const generationSource = ctx.connection?.generation;
    // Re-resolve the public binding when a connection replaces its Session.
    React.useSyncExternalStore(generationSource?.subscribe ?? noSubscription,
      () => generationSource?.getSnapshot?.()?.id ?? 0, () => 0);
    const sessionId = props.sessionId;
    const binding = typeof sessionId === 'string' && session?.sessionId === sessionId
      ? (ctx.sessions ?? ctx.get?.('sessions'))?.binding(sessionId) : undefined;
    const source = binding?.sessionId === sessionId ? binding.eventSource : undefined;
    const subscribe = React.useCallback((listener: () => void) => source?.subscribe(listener) ?? (() => {}), [source]);
    const read = React.useCallback(() => source?.getSnapshot() ?? emptyWindow, [source]);
    const window = React.useSyncExternalStore(subscribe, read, () => emptyWindow);
    const records = React.useMemo(() => recoveryDiagnostics(window.entries, sessionId), [window, sessionId]);
    const latest = records[0];
    if (disposed || !latest) return null;
    const retryActive = recoveryRetryActive(latest, window.entries, session.running);
    const stopReason = recoveryStopReason(latest.stopReason);
    return <aside className="nexus-recovery-diagnostics" data-outcome={latest.outcome} aria-label="请求恢复诊断">
      <details key={sessionId}>
        <summary>
          <span className="nexus-recovery-label">{recoveryDiagnosticLabel(latest, retryActive)}</span>
          <code>{latest.diagnosticCode}</code>
          <span className="nexus-recovery-message">{stopReason ?? latest.message}</span>
        </summary>
        <ol aria-label="最近的请求诊断记录">
          {records.map(record => <li key={`${record.seq}:${record.id}`} data-outcome={record.outcome}>
            <div className="nexus-recovery-record-title">
              <span>{recoveryDiagnosticLabel(record, record === latest && retryActive)}</span>
              <code>{record.diagnosticCode}</code>
              <time dateTime={record.at}>{new Date(record.at).toLocaleTimeString()}</time>
            </div>
            <p>{record.message}{record.stopReason ? `；停止原因：${recoveryStopReason(record.stopReason)}` : ''}</p>
            <dl>
              <dt>原始代码</dt><dd><code>{record.canonicalCode}</code></dd>
              <dt>阶段</dt><dd>{record.phase}</dd>
              {record.status !== undefined && <><dt>HTTP 状态</dt><dd>{record.status}</dd></>}
              {record.requestId && <><dt>请求 ID</dt><dd>{record.requestId}</dd></>}
              {record.traceId && <><dt>追踪 ID</dt><dd>{record.traceId}</dd></>}
            </dl>
          </li>)}
        </ol>
      </details>
    </aside>;
  }
  const stop = ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'nexus.request-recovery', order: 40,
  }, Diagnostics));
  return () => {
    if (disposed) return;
    disposed = true;
    if (typeof stop === 'function') stop();
  };
}
