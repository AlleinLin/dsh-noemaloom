import * as React from 'react';
import { createPortal } from 'react-dom';
import type { ClientContext, Data, NexusApi } from './types.js';
import { ContextCompactionSettings } from './ContextCompactionSettings.js';
import { Icon } from './components.js';
import { errorData } from './transport.js';
import { boundedRead } from '../shared/bounded-read.js';

type State = { open: boolean; settings: boolean; busy: boolean; loading: boolean; status?: Data; result?: Data; error?: string;
  requestId?: string; resumeRequestId?: string; operation?: 'compact' | 'resume'; viewOwner?: string };
const empty: State = Object.freeze({ open: false, settings: false, busy: false, loading: false });
export function compactionOutcome(result: Data): string {
  if (result.queued === true) return result.idempotent === true
    ? '已收到恢复操作，正在重新检查原步骤的上下文。'
    : '正在重新检查上下文；通过检查后继续原步骤。';
  if (result.committed === true) return `已压缩${Number.isFinite(result.beforeTokens) && Number.isFinite(result.afterTokens)
    ? ` · ${Math.round(result.beforeTokens).toLocaleString()} → ${Math.round(result.afterTokens).toLocaleString()} token` : ''}`;
  if (result.officialEffect === 'unknown') return '压缩结果待核实；保留原请求编号，未重复执行。';
  return `未压缩 · ${result.reason ?? '没有安全压缩范围'}${result.recovery ? `。${result.recovery}` : ''}`;
}

/** A user command never travels through a chat prompt. Keep the exact Session
 * supplied by the native command/slot; workspace selection is not an owner.
 * The shared per-session store lets native and Codinput seats show one operation. */
export function registerContextMaintenance(raw: ClientContext, api: NexusApi) {
  const ctx = raw as any, states = new Map<string, State>(), listeners = new Set<() => void>();
  const seats = new Map<string, Set<string>>();
  const lifetime = new AbortController(), reads = new Map<string, Promise<unknown>>();
  const cleanups: Array<() => void> = [];
  let serial = 0, disposed = false;
  const state = (id: string) => states.get(id) ?? empty;
  const publish = (id: string, patch: Partial<State>) => {
    if (disposed) return;
    states.set(id, { ...state(id), ...patch });
    if (states.size > 128) for (const [key, value] of states) {
      if (key !== id && !value.open && !value.busy && !value.loading) { states.delete(key); break; }
    }
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const owned = (id: unknown): id is string => typeof id === 'string' && !!id && ctx.sessions?.binding(id)?.sessionId === id;
  const load = (id: string): Promise<unknown> => {
    const pending = reads.get(id); if (pending) return pending;
    publish(id, { loading: true });
    const request = boundedRead(signal => api.call('context', 'maintenance/status', {}, {
      scope: { level: 'session', sessionId: id }, signal,
    }), { signal: lifetime.signal, timeoutMs: 10000,
      timeout: () => new Error('读取压缩状态超过10秒，可重试'), cancelled: () => new Error('读取已取消') })
      .then(status => publish(id, { status, loading: false }))
      .catch(error => publish(id, { error: errorData(error).message, loading: false }))
      .finally(() => { if (reads.get(id) === request) reads.delete(id); });
    reads.set(id, request); return request;
  };
  const compact = async (id: string) => {
    if (!owned(id) || state(id).busy || disposed) return;
    // A lost reply keeps the same id. Only an acknowledged terminal receipt
    // permits a subsequent explicit intention to allocate a different id.
    const requestId = state(id).requestId ?? `manual-compact:${Date.now().toString(36)}:${++serial}`;
    publish(id, { open: true, settings: false, busy: true, operation: 'compact', error: undefined, result: undefined, requestId });
    try {
      const result = await api.call('context', 'maintenance/compact', {}, {
        scope: { level: 'session', sessionId: id }, requestId, mutating: true, signal: lifetime.signal,
      });
      publish(id, { result, requestId: result.officialEffect === 'unknown' ? requestId : undefined });
    } catch (error) { publish(id, { error: errorData(error).message }); }
    finally { publish(id, { busy: false }); if (!disposed) void load(id); }
  };
  const resume = async (id: string) => {
    if (!owned(id) || state(id).busy || disposed) return;
    const requestId = state(id).resumeRequestId ?? `context-resume:${Date.now().toString(36)}:${++serial}`;
    publish(id, { open: true, settings: false, busy: true, operation: 'resume', error: undefined, result: undefined, resumeRequestId: requestId });
    try {
      const result = await api.call('context', 'maintenance/resume', {}, {
        scope: { level: 'session', sessionId: id }, requestId, mutating: true, signal: lifetime.signal,
      });
      publish(id, { result, resumeRequestId: undefined });
    } catch (error) { publish(id, { error: errorData(error).message }); }
    finally { publish(id, { busy: false }); if (!disposed) void load(id); }
  };
  function Dialog({ id }: { id: string }) {
    const value = React.useSyncExternalStore(subscribe, () => state(id), () => empty);
    const ref = React.useRef<HTMLDialogElement>(null), [level, setLevel] = React.useState<'global' | 'session'>('global');
    const close = () => publish(id, { open: false });
    React.useEffect(() => {
      const element = ref.current; if (!element) return;
      element.showModal();
      // Closing the view never cancels an admitted compaction transaction.
      return () => { if (element.open) element.close(); };
    }, []);
    React.useEffect(() => { void load(id); }, [id]);
    const recoveryState = value.status?.recovery?.state;
    React.useEffect(() => {
      if (!['resume-required', 'checking'].includes(recoveryState)) return;
      const timer = setInterval(() => { void load(id); }, 2000);
      return () => clearInterval(timer);
    }, [id, recoveryState]);
    const status = value.status, percent = typeof status?.occupancyPercent === 'number' ? status.occupancyPercent : NaN;
    return createPortal(<dialog ref={ref} className="nexus-compaction-dialog" aria-label="上下文压缩"
      data-nexus-compaction-session={id} onCancel={event => { event.preventDefault(); close(); }}>
      <header><strong>上下文压缩</strong><button type="button" aria-label="关闭上下文压缩" onClick={close}><Icon name="close" size={16} /></button></header>
      <div className="nexus-compaction-body">
        <small className="nexus-compaction-identity">当前会话 · {id}</small>
        {status && <div className="nexus-compaction-metrics">
          <strong>{Number.isFinite(percent) ? `${percent.toFixed(1)}%` : '窗口未知'}</strong>
          <span>{status.occupiedTokens?.toLocaleString()} / {status.windowTokens?.toLocaleString()} token</span>
          <span>{typeof status.enabled === 'boolean' ? `自动压缩${status.automaticPause ? '已暂停' : status.enabled ? '开启' : '关闭'} · 阈值 ${status.thresholdPercent}%` : '占用暂不可测；可查看设置与恢复状态'}</span>
          <span>压缩模型 · {status.summary?.state === 'available' ? `${status.summary.provider}/${status.summary.model}` : '暂不可用'}</span>
        </div>}
        {value.loading && <p role="status">正在读取当前会话…</p>}
        {value.busy && <p role="status">{value.operation === 'resume' ? '正在恢复原步骤…' : '正在压缩当前会话，关闭此窗口不影响执行…'}</p>}
        {value.error && <p role="alert">{value.error}</p>}
        {value.result && <p role="status">{compactionOutcome(value.result)}</p>}
        {status?.automaticPause && <p role="status">{status.automaticPause.recovery}</p>}
        {status?.maintenance?.state !== undefined && status.maintenance.state !== 'available'
          && <p role="status">{status.maintenance.recovery}</p>}
        {['resume-required', 'checking', 'interrupted'].includes(status?.recovery?.state) && <p role="status">{status?.recovery.message}</p>}
        <div className="nexus-compaction-actions">
          <button type="button" className="nexus-compaction-primary" disabled={value.busy || ['resume-required', 'checking'].includes(recoveryState)} onClick={() => void compact(id)}>立即压缩</button>
          {['resume-required', 'checking'].includes(recoveryState) && <button type="button" disabled={value.busy || status?.recovery?.available !== true} onClick={() => void resume(id)}>恢复当前步骤</button>}
          <button type="button" disabled={value.loading} onClick={() => { publish(id, { error: undefined }); void load(id); }}>刷新状态</button>
          <button type="button" aria-expanded={value.settings} onClick={() => publish(id, { settings: !value.settings })}>压缩设置</button>
        </div>
        {value.settings && <div className="nexus-compaction-settings"><label>设置范围 <select aria-label="压缩设置范围" value={level} onChange={event => setLevel(event.target.value as typeof level)}>
          <option value="global">全局（主代理与全部子代理）</option><option value="session">仅当前会话</option>
        </select></label><ContextCompactionSettings key={level} api={api} scope={level === 'global' ? { level } : { level, sessionId: id }} /></div>}
      </div>
    </dialog>, document.body);
  }
  function Control(props: any) {
    const id = props.sessionId, occurrence = React.useId();
    const value = React.useSyncExternalStore(subscribe, () => state(id), () => empty);
    React.useEffect(() => {
      const owners = seats.get(id) ?? new Set<string>(); owners.add(occurrence); seats.set(id, owners);
      publish(id, {});
      return () => {
        owners.delete(occurrence); if (!owners.size) seats.delete(id);
        if (state(id).viewOwner === occurrence) publish(id, { viewOwner: undefined });
        else publish(id, {});
      };
    }, [id, occurrence]);
    if (!owned(id)) return null;
    const ownsDialog = value.viewOwner ? value.viewOwner === occurrence : seats.get(id)?.values().next().value === occurrence;
    return <span data-nexus-compaction-control={id}><button type="button" className="nexus-compaction-trigger"
      aria-label="压缩上下文" title="压缩上下文 · 自动阈值与压缩设置" onClick={() => publish(id, { open: true, viewOwner: occurrence })}>
      <Icon name="layers" size={16} /><span>{value.busy ? '压缩中' : '压缩'}</span>
    </button>{value.open && ownsDialog && <Dialog id={id} />}</span>;
  }
  cleanups.push(ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'noemaloom.context-maintenance', order: 90,
  }, Control)));
  // The host deliberately omits its command catalog for subagent Sessions.
  // A public client contribution fills exactly that gap, without colliding
  // with the parent's native /compact command or rewriting its submit path.
  const inject = ctx.inject?.(['commandUi', 'sessions'], (owner: any) => {
    const commandUi = owner.commandUi ?? owner.get?.('commandUi');
    if (!commandUi?.register) return;
    return commandUi.register({ name: 'compact', label: () => '压缩上下文',
      description: () => '压缩当前子代理，使用统一阈值与压缩模型',
      available: (session: any) => owned(session?.sessionId) && ctx.sessions.subagentAddress(session.sessionId) !== undefined,
      ui: { kind: 'action', run: (session: any) => { if (owned(session?.sessionId)) void compact(session.sessionId); } },
    });
  });
  if (typeof inject === 'function') cleanups.push(inject);
  return {
    state, compact, resume, load,
    dispose() {
      if (disposed) return; disposed = true; lifetime.abort();
      for (const cleanup of cleanups.reverse()) if (typeof cleanup === 'function') cleanup();
      listeners.clear(); states.clear(); seats.clear();
    },
  };
}
