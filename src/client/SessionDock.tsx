import * as React from 'react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Data, ViewContext } from './types.js';
import { idOf, isRecord, rows, sessionTranscript, titleOf, unwrap } from './types.js';
export { sessionTranscript } from './types.js';
import { Button, ErrorMessage, Icon, IconButton, StateMessage, Status, Time, useQuery } from './components.js';
import { errorData } from './transport.js';
import { appendCommandOutput, emptyCommandOutput, type CommandOutput } from './live-command-model.js';
import { openLiveCommandMonitor } from './LiveCommands.js';
import styles from './SessionDock.css';
import xtermStyles from '@xterm/xterm/css/xterm.css';

interface ChatTab { key: string; id?: string; parentId?: string; title: string }
interface InputReceipt extends Data { activationId: string; text: string }
interface DockProps { context: ViewContext; sessionId?: string; onClose?(): void; visible?: boolean }
interface TerminalInfo { id: string; title: string; cwd: string; cols: number; rows: number; state: string; exitCode: number | null; error?: string }
interface TerminalState {
  phase: string; writable: boolean; info?: TerminalInfo; error?: string; issue?: string;
  environment?: { maxCols: number; maxRows: number; maxInputBytes: number; scrollback: number };
  render?: { revision: number; frame: { type: 'snapshot'; sequence: number; screen: string; info: TerminalInfo } | { type: 'output'; sequence: number; data: string } };
}
// Structural client contract of DSH's official webTerminals service, also used
// by DSH-better-sidebar at 83faf70940160e5cd4c5332f5400aa8f4dbbb6d6.
// The host retains the PTY, reconnection, output ordering and input lease.
interface TerminalModel {
  state: { getSnapshot(): TerminalState; subscribe(listener: () => void): () => void };
  mount(): () => void; refresh(): Promise<void>; connect(): void; acknowledge(revision: number): void;
  write(data: string): void; resize(cols: number, rows: number): void; close(): Promise<void>;
}
interface TerminalService {
  view(sessionId: string, key: string, contentId: string, terminalId?: string, shellPath?: string): TerminalModel;
  recover(sessionId: string): Promise<TerminalInfo[]>;
}
interface TerminalTab { key: string; sessionId: string; title: string; model: TerminalModel }

function hostTerminals(context: ViewContext): TerminalService | undefined {
  try {
    const host = (context as ViewContext & { host?: { get?(name: string): unknown; webTerminals?: unknown } }).host;
    const service = (host?.get?.('webTerminals') ?? host?.webTerminals) as Partial<TerminalService> | undefined;
    return typeof service?.view === 'function' && typeof service.recover === 'function' ? service as TerminalService : undefined;
  } catch { return undefined; }
}

const requestKey = () => globalThis.crypto?.randomUUID?.() ?? `dock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const hasAction = (context: ViewContext, domain: string, action: string) =>
  context.catalog.some(item => item.id === domain && item.capabilities.some(capability => capability.action === action));
const scoped = (context: ViewContext, sessionId?: string) => ({ ...context.scope, ...(sessionId ? { sessionId } : {}) });
const activeState = (value: unknown) => ['running', 'queued', 'pending', 'cancelling', 'unknown'].includes(String(value));

/** Poll one request at a time, retain its last successful data, and stop while hidden. */
function useDockQuery(context: ViewContext, domain: string, action: string, params: Data, enabled: boolean, poll = false) {
  const query = useQuery(context.api, domain, action, params, {
    enabled: enabled && hasAction(context, domain, action),
    scope: scoped(context, typeof params.sessionId === 'string' ? params.sessionId : undefined),
    refresh: context.refreshToken,
  });
  useEffect(() => {
    if (!enabled || !poll || query.loading || !hasAction(context, domain, action)) return;
    const timer = window.setTimeout(() => { if (document.visibilityState !== 'hidden') query.reload(); }, query.error ? 7000 : 1800);
    return () => window.clearTimeout(timer);
  }, [enabled, poll, query.loading, query.data, query.error, context.api, context.catalog, domain, action]);
  useEffect(() => {
    if (!enabled || !poll) return;
    const visible = () => { if (document.visibilityState !== 'hidden') query.reload(); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [enabled, poll, context.api]);
  return query;
}

export function SessionDock({ context, sessionId, onClose, visible = true }: DockProps) {
  const [page, setPage] = useState<'chat' | 'terminal'>('chat');
  const [height, setHeight] = useState(420);
  const headingId = useId();
  const dock = useRef<HTMLElement>(null);
  const drag = useRef<{ y: number; height: number; pointerId: number } | undefined>(undefined);
  const parentId = sessionId || context.scope.sessionId;
  return <section className="nexus-session-dock" aria-labelledby={headingId} style={{ height }} ref={dock}>
    <style>{styles}</style>
    <style>{xtermStyles}</style>
    <div className="nexus-dock-resize" role="separator" aria-label="调整 Dock 高度" aria-orientation="horizontal" tabIndex={0}
      aria-valuemin={280} aria-valuemax={800} aria-valuenow={height}
      onKeyDown={event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const maximum = Math.max(280, Math.min(800, (dock.current?.parentElement?.clientHeight ?? 900) - 90));
        setHeight(value => event.key === 'Home' ? 280 : event.key === 'End' ? maximum : Math.max(280, Math.min(maximum, value + (event.key === 'ArrowUp' ? 24 : -24))));
      }}
      onPointerDown={event => { drag.current = { y: event.clientY, height, pointerId: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => {
        if (!drag.current || drag.current.pointerId !== event.pointerId) return;
        const maximum = Math.max(280, Math.min(800, (dock.current?.parentElement?.clientHeight ?? 900) - 90));
        setHeight(Math.max(280, Math.min(maximum, drag.current.height + drag.current.y - event.clientY)));
      }}
      onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }} />
    <header className="nexus-dock-heading">
      <strong id={headingId}>工作 Dock</strong>
      <nav aria-label="Dock 面板">
        <button type="button" aria-pressed={page === 'chat'} onClick={() => setPage('chat')}><Icon name="chat" size={15} />侧聊</button>
        <button type="button" aria-pressed={page === 'terminal'} onClick={() => setPage('terminal')}><Icon name="terminal" size={15} />终端与作业</button>
      </nav>
      <span>{parentId ? `父会话 ${parentId}` : '未选择父会话'}</span>
      {onClose && <IconButton name="close" label="收起工作 Dock，保留会话与作业" onClick={onClose} />}
    </header>
    <div className="nexus-dock-page" hidden={page !== 'chat'}><ChildChats context={context} parentId={parentId} visible={visible && page === 'chat'} /></div>
    <div className="nexus-dock-page" hidden={page !== 'terminal'}><TerminalJobs context={context} sessionId={parentId} visible={visible && page === 'terminal'} /></div>
  </section>;
}

function ChildChats({ context, parentId, visible }: { context: ViewContext; parentId?: string; visible: boolean }) {
  const [tabs, setTabs] = useState<ChatTab[]>(() => [{ key: requestKey(), parentId, title: '新侧聊' }]);
  const [active, setActive] = useState(() => tabs[0].key);
  const [attach, setAttach] = useState('');
  const sessions = useDockQuery(context, 'agents', 'session/list', {}, visible);
  useEffect(() => {
    if (parentId) setTabs(old => old.map(tab => !tab.id && !tab.parentId ? { ...tab, parentId } : tab));
  }, [parentId]);
  const add = () => {
    const tab = { key: requestKey(), parentId, title: '新侧聊' };
    setTabs(old => [...old, tab]); setActive(tab.key);
  };
  const close = (key: string) => {
    const index = tabs.findIndex(tab => tab.key === key), remaining = tabs.filter(tab => tab.key !== key);
    setTabs(remaining);
    if (active === key) setActive(remaining[Math.max(0, index - 1)]?.key ?? '');
  };
  return <div className="nexus-dock-workspace">
    <div className="nexus-dock-tabbar">
      <div className="nexus-dock-tabstrip" role="tablist" aria-label="侧聊会话">
        {tabs.map((tab, index) => <div key={tab.key} className={`nexus-dock-tab ${active === tab.key ? 'is-active' : ''}`}>
          <button type="button" role="tab" aria-selected={active === tab.key} aria-controls={`dock-chat-${tab.key}`} id={`dock-chat-tab-${tab.key}`}
            tabIndex={active === tab.key ? 0 : -1} onClick={() => setActive(tab.key)}
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
              setActive(tabs[next].key); document.getElementById(`dock-chat-tab-${tabs[next].key}`)?.focus();
            }}><Icon name="chat" size={13} /><span>{tab.title}</span></button>
          <IconButton name="close" label={`关闭标签 ${tab.title}，保留会话`} onClick={() => close(tab.key)} />
        </div>)}
      </div>
      <IconButton name="plus" label="新建独立侧聊标签" onClick={add} />
      <select value={attach} aria-label="接入已有会话" onFocus={sessions.reload} onChange={event => {
        const id = event.target.value; setAttach('');
        if (!id) return;
        const prior = tabs.find(tab => tab.id === id);
        if (prior) { setActive(prior.key); return; }
        const item = rows(sessions.data).find(row => idOf(row) === id);
        const tab: ChatTab = { key: requestKey(), id, parentId, title: item ? titleOf(item) : id };
        setTabs(old => [...old, tab]); setActive(tab.key);
      }}><option value="">接入已有会话…</option>{rows(sessions.data).filter(item => idOf(item) !== parentId).map(item => <option key={idOf(item)} value={idOf(item)}>{titleOf(item)}</option>)}</select>
    </div>
    {Boolean(sessions.error) && <div className="nexus-dock-inline-error"><ErrorMessage error={sessions.error} retry={sessions.reload} /></div>}
    {!tabs.length && <StateMessage title="打开一段独立侧聊" action={<Button onClick={add} icon="plus">新侧聊</Button>}>侧聊的模型、消息与运行状态由宿主独立维护。</StateMessage>}
    {tabs.map(tab => <div key={tab.key} id={`dock-chat-${tab.key}`} role="tabpanel" aria-labelledby={`dock-chat-tab-${tab.key}`} className="nexus-dock-panel" hidden={active !== tab.key}>
      <ChildChat context={context} tab={tab} visible={visible && active === tab.key}
        onCreated={(id, title) => { setTabs(old => old.map(item => item.key === tab.key ? { ...item, id, title } : item)); sessions.reload(); }} />
    </div>)}
  </div>;
}

function ChildChat({ context, tab, visible, onCreated }: { context: ViewContext; tab: ChatTab; visible: boolean; onCreated(id: string, title: string): void }) {
  const [prompt, setPrompt] = useState('');
  const [modelKey, setModelKey] = useState('');
  const [effort, setEffort] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<unknown>();
  const [keepInbox, setKeepInbox] = useState(true);
  const [receipts, setReceipts] = useState<InputReceipt[]>([]);
  const [pendingSend, setPendingSend] = useState<{ action: string; params: Data; text: string }>();
  const live = useRef(true);
  const stream = useRef<HTMLDivElement>(null);
  const followEnd = useRef(true);
  const detail = useDockQuery(context, 'agents', 'session/get', { sessionId: tab.id }, visible && Boolean(tab.id), true);
  const status = useDockQuery(context, 'agents', 'session/status', { sessionId: tab.id }, visible && Boolean(tab.id), true);
  const models = useDockQuery(context, 'resources', 'models.list', {}, visible);
  const snapshot: Data = unwrap(detail.data ?? {});
  const state: Data = unwrap(status.data ?? {});
  const modelItems = rows(models.data).filter(item => item.available !== false && item.enabled !== false && item.authorized !== false && typeof (item.provider ?? item.ref?.providerRouteId) === 'string' && typeof (item.model ?? item.ref?.modelId) === 'string');
  const selectedModel = modelItems.find(item => JSON.stringify([item.provider ?? item.ref?.providerRouteId, item.model ?? item.ref?.modelId]) === modelKey);
  const supportedEfforts = selectedModel?.capabilities?.reasoningEffort?.value;
  const messages = sessionTranscript(snapshot);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (followEnd.current && stream.current) stream.current.scrollTop = stream.current.scrollHeight; }, [detail.data, receipts.length]);
  const refresh = () => { detail.reload(); status.reload(); };
  const route = (): Data => {
    if (!modelKey) return {};
    const [provider, model] = JSON.parse(modelKey) as string[];
    return { provider, model, ...(effort ? { reasoningEffort: effort } : {}) };
  };
  const invoke = async (action: string, params: Data) => context.api.call('agents', `session/${action}`, params, { scope: scoped(context, tab.id ?? tab.parentId), mutating: true });
  const deliver = async (mode: 'prompt' | 'wake' | 'continue') => {
    if (busy || (!pendingSend && !prompt.trim())) return;
    const request = pendingSend ?? {
      action: tab.id ? mode : 'spawn',
      params: { requestId: requestKey(), ...(tab.id ? { sessionId: tab.id } : { parentId: tab.parentId }), prompt: prompt.trim(), ...route() },
      text: prompt.trim(),
    };
    setBusy('send'); setError(undefined); setPendingSend(request);
    try {
      if (tab.id && request.params.provider && request.params.model) await invoke('model.select', {
        sessionId: tab.id, provider: request.params.provider, model: request.params.model,
        ...(request.params.reasoningEffort ? { reasoningEffort: request.params.reasoningEffort } : {}),
      });
      const result = await invoke(request.action, request.params);
      if (!live.current) return;
      if (!tab.id) {
        const id = result?.sessionId ?? result?.id;
        if (typeof id !== 'string' || !id) throw new Error('宿主未确认子会话 ID；请查看会话列表后核对原提交。');
        onCreated(id, request.text.length > 24 ? `${request.text.slice(0, 24)}…` : request.text);
      }
      const activation = isRecord(result?.activation) ? result.activation : result;
      if (typeof activation?.activationId === 'string') setReceipts(old => [...old, { ...activation, activationId: activation.activationId, text: request.text }].slice(-30));
      setPrompt(''); setPendingSend(undefined); refresh();
    } catch (cause) {
      if (!live.current) return;
      setError(cause);
      if (['INVALID_ARGUMENT', 'PERMISSION_DENIED', 'SESSION_NOT_LIVE', 'HOST_CAPABILITY_UNAVAILABLE', 'HOST_CONTRACT_UNSUPPORTED', 'NOT_FOUND', 'DEPTH_EXCEEDED'].includes(errorData(cause).code)) setPendingSend(undefined);
    } finally { if (live.current) setBusy(''); }
  };
  const sessionAction = async (action: 'resume' | 'cancel' | 'model.select') => {
    if (!tab.id || busy) return;
    setBusy(action); setError(undefined);
    try {
      const result = await invoke(action, { sessionId: tab.id, ...(action === 'cancel' ? { keepInbox } : action === 'model.select' ? route() : {}) });
      if (live.current) {
        refresh();
        if (action === 'cancel' && result?.acknowledged !== true) {
          context.notify('停止状态尚未确认', 'info');
          context.inspect({ title: '取消回执', data: result });
        } else context.notify(action === 'cancel' ? '宿主已确认停止' : action === 'resume' ? '会话已载入' : '模型将在下一轮组装时应用', 'success');
      }
    } catch (cause) { if (live.current) setError(cause); }
    finally { if (live.current) setBusy(''); }
  };
  const reportedModel = snapshot.header?.config ?? snapshot.header?.model ?? {};
  return <div className="nexus-child-chat">
    <div className="nexus-child-toolbar">
      <div><strong>{tab.id ? snapshot.title ?? tab.title : '独立侧聊'}</strong><small>{tab.id ?? (tab.parentId ? `从父会话 ${tab.parentId} 创建` : '请先在主界面选择存活的父会话')}</small></div>
      {tab.id && <><Status value={state.state ?? snapshot.status ?? 'unknown'} /><span className="nexus-dock-pending-count">待处理 {state.pending ? Number(state.pending.nextTurn ?? 0) + Number(state.pending.nextStep ?? 0) : '未报告'}</span><IconButton name="refresh" label="刷新侧聊消息与状态" onClick={refresh} /><IconButton name="info" label="查看子会话真实元数据" onClick={() => context.inspect({ title: '侧聊会话', id: tab.id, data: { ...snapshot, runtime: state } })} />{state.live === false && <Button busy={busy === 'resume'} disabled={!!busy || !!pendingSend} onClick={() => void sessionAction('resume')}>载入会话</Button>}</>}
    </div>
    <div className="nexus-child-transcript" ref={stream} onScroll={event => { const node = event.currentTarget; followEnd.current = node.scrollHeight - node.clientHeight - node.scrollTop < 70; }}>
      {Boolean(detail.error) && <ErrorMessage error={detail.error} retry={detail.reload} />}
      {Boolean(status.error) && <ErrorMessage error={status.error} retry={status.reload} />}
      {!tab.id ? <StateMessage title="把一个问题放在旁边讨论" icon="chat">使用独立模型与消息流，保留父会话关联。发送后由宿主创建持久子会话。</StateMessage>
        : detail.loading && detail.data === undefined ? <p className="nexus-muted" role="status">正在读取会话…</p>
          : messages.length ? messages.map((message, index) => <TranscriptMessage key={message.id ?? `event-${index}`} message={message} context={context} />)
            : <StateMessage title={state.live === false ? '此会话当前未载入' : '还没有可读消息'}>{state.live === false ? '载入后读取正式消息投影；保留的事件可以在会话元数据中查看。' : '消息将在宿主确认后出现在这里。'}</StateMessage>}
      {receipts.length > 0 && <div className="nexus-child-receipts" aria-label="本次输入的宿主回执">{receipts.map(receipt => <InputState key={receipt.activationId} context={context} receipt={receipt} sessionId={tab.id} visible={visible} />)}</div>}
    </div>
    <div className="nexus-child-composer">
      {Boolean(error) && <ErrorMessage error={error} />}
      {pendingSend && !busy && <p className="nexus-dock-uncertain" role="status">原提交尚未确认。重试将沿用同一请求 ID 和内容，以便宿主核对。</p>}
      <div className="nexus-dock-models">
        <select aria-label="此侧聊独立模型" value={modelKey} disabled={!!busy || !!pendingSend} onChange={event => { setModelKey(event.target.value); setEffort(''); }}>
          <option value="">{tab.id ? `当前会话模型${reportedModel.model ? ` · ${reportedModel.model}` : ''}` : '继承父会话模型'}</option>
          {modelItems.map(item => { const provider = item.provider ?? item.ref?.providerRouteId, model = item.model ?? item.ref?.modelId, value = JSON.stringify([provider, model]); return <option key={value} value={value}>{item.name ?? model} · {provider}</option>; })}
        </select>
        {modelKey && Array.isArray(supportedEfforts) && supportedEfforts.length > 0 && <select aria-label="此侧聊推理强度" value={effort} disabled={!!busy || !!pendingSend} onChange={event => setEffort(event.target.value)}><option value="">模型默认强度</option>{supportedEfforts.map((item: unknown) => <option key={String(item)} value={String(item)}>{String(item)}</option>)}</select>}
        {tab.id && modelKey && <Button busy={busy === 'model.select'} disabled={!!busy || !!pendingSend || state.live === false} onClick={() => void sessionAction('model.select')}>应用模型</Button>}
        {Boolean(models.error) && <button className="nexus-text-button" onClick={() => context.inspect({ title: '模型目录读取失败', data: errorData(models.error) })}>模型目录不可用</button>}
      </div>
      <textarea aria-label="侧聊输入" rows={2} placeholder={tab.id ? '继续讨论，Ctrl + Enter 排队发送…' : '输入独立侧聊的问题…'} value={prompt} disabled={!!busy || !!pendingSend}
        onChange={event => setPrompt(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void deliver(state.live === false ? 'continue' : 'prompt'); }
        }} />
      <div className="nexus-dock-composer-actions">
        {tab.id && <><label className="nexus-dock-checkbox"><input type="checkbox" checked={keepInbox} onChange={event => setKeepInbox(event.target.checked)} />停止时保留排队输入</label><Button icon="stop" busy={busy === 'cancel'} disabled={!!busy || state.live === false} onClick={() => void sessionAction('cancel')}>停止</Button></>}
        <span />
        {tab.id && state.live !== false && !pendingSend && <Button disabled={!!busy || !prompt.trim()} onClick={() => void deliver('wake')}>唤醒发送</Button>}
        <Button primary icon="arrow" busy={busy === 'send'} disabled={!!busy || (!pendingSend && (!prompt.trim() || (!tab.id && !tab.parentId)))}
          onClick={() => void deliver(state.live === false ? 'continue' : 'prompt')}>{pendingSend ? '重试原提交' : !tab.id ? '创建侧聊' : state.live === false ? '载入并继续' : state.state === 'running' ? '排队发送' : '发送'}</Button>
      </div>
    </div>
  </div>;
}

function TranscriptMessage({ message, context }: { message: Data; context: ViewContext }) {
  const blocks = Array.isArray(message.content) ? message.content : Array.isArray(message.blocks) ? message.blocks : [];
  return <article className={`nexus-dock-message ${message.role === 'user' ? 'is-user' : message.role === 'tool' ? 'is-tool' : ''}`}>
    <small>{message.role === 'user' ? '输入' : message.role === 'assistant' ? '助手' : message.role === 'tool' ? '工具' : String(message.role ?? '消息')}{message.source?.kind && ` · ${message.source.kind}`}</small>
    {typeof message.content === 'string' ? <div data-nexus-verbatim>{message.content}</div> : blocks.map((block: any, index: number) => {
      if (!isRecord(block)) return <div key={index} data-nexus-verbatim>{String(block)}</div>;
      const text = typeof block.text === 'string' ? block.text : typeof block.content === 'string' ? block.content : undefined;
      if (['thinking', 'reasoning'].includes(String(block.type))) return <details key={block.id ?? index}><summary>推理内容</summary><div data-nexus-verbatim>{text ?? '宿主未报告文本内容'}</div></details>;
      if (text !== undefined) return <div key={block.id ?? index} data-nexus-verbatim>{text}</div>;
      return <button key={block.id ?? index} className="nexus-dock-block" onClick={() => context.inspect({ title: `会话内容 · ${block.type ?? 'block'}`, data: block })}><Icon name="file" size={14} />{block.type ?? '结构化内容'}<span>查看内容</span></button>;
    })}
  </article>;
}

function InputState({ context, receipt, sessionId, visible }: { context: ViewContext; receipt: InputReceipt; sessionId?: string; visible: boolean }) {
  const [terminal, setTerminal] = useState(false);
  const query = useDockQuery(context, 'agents', 'session/activation/status', { activationId: receipt.activationId, sessionId }, visible, !terminal);
  const value = unwrap(query.data ?? receipt);
  useEffect(() => { if (value.terminal === true) setTerminal(true); }, [value.terminal]);
  return <div className="nexus-dock-input-state"><Icon name="check" size={12} /><span title={receipt.text}>{receipt.text}</span><Status value={value.state ?? 'queued'} /><IconButton name="info" label="查看输入的准确执行回执" onClick={() => context.inspect({ title: '输入回执', data: { ...value, ...(query.error ? { refreshError: errorData(query.error) } : {}) } })} /></div>;
}

function TerminalJobs({ context, sessionId, visible }: { context: ViewContext; sessionId?: string; visible: boolean }) {
  const [shellId, setShellId] = useState('');
  const [cwd, setCwd] = useState('.');
  const [command, setCommand] = useState('');
  const [timeout, setTimeoutSeconds] = useState(300);
  const [opened, setOpened] = useState<string[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<unknown>();
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [selectedTerminal, setSelectedTerminal] = useState('');
  const [recoverable, setRecoverable] = useState<TerminalInfo[]>([]);
  const terminalService = hostTerminals(context);
  const [submission, setSubmission] = useState<{ params: Data; requestId: string; sessionId?: string }>();
  const shells = useDockQuery(context, 'runtime', 'shells', {}, visible);
  const jobs = useDockQuery(context, 'runtime', 'jobs.list', { ...(sessionId ? { sessionId } : {}) }, visible, true);
  const shellItems = rows(shells.data);
  const allJobs = rows(jobs.data);
  const availableShells = shellItems.filter(item => item.available === true);
  const effectiveShell = shellId || availableShells[0]?.id || '';
  const detail = useDockQuery(context, 'runtime', 'jobs.get', { id: selected }, visible && !!selected, true);
  const job: Data = unwrap(detail.data ?? allJobs.find(item => idOf(item) === selected) ?? {});
  const generation = useSyncExternalStore(context.api.subscribe, context.api.getGeneration, context.api.getGeneration);
  const outputScope = JSON.stringify(scoped(context, sessionId));
  const outputKey = JSON.stringify([selected, outputScope, generation]);
  const canReadOutput = hasAction(context, 'runtime', 'jobs.output');
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const [liveOutput, setLiveOutput] = useState<{
    key: string; output: CommandOutput; available: boolean; error?: unknown; state?: string; result?: Data;
  }>();
  const [followOutput, setFollowOutput] = useState(true);
  const outputNode = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => {
    if (!visible || !documentVisible || selectedTerminal || !selected || !canReadOutput) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let output = emptyCommandOutput(selected);
    setLiveOutput({ key: outputKey, output, available: true });
    const read = async () => {
      try {
        const page = await context.api.call('runtime', 'jobs.output', {
          id: selected, cursor: output.cursor, maxBytes: 65536,
        }, { scope: JSON.parse(outputScope), signal: controller.signal });
        if (controller.signal.aborted) return;
        if (page.id !== selected) throw new Error('作业输出标识与当前选择不一致');
        output = appendCommandOutput(output, page);
        setLiveOutput({ key: outputKey, output, available: page.available !== false, state: page.state, result: page.result });
        if (page.hasMore || activeState(page.state)) timer = setTimeout(() => { void read(); }, page.hasMore ? 40 : 700);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setLiveOutput(previous => ({ key: outputKey, output, available: previous?.key === outputKey ? previous.available : true, error: cause }));
        timer = setTimeout(() => { void read(); }, 3000);
      }
    };
    void read();
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [context.api, outputKey, outputScope, selected, selectedTerminal, visible, documentVisible, canReadOutput]);
  const currentOutput = liveOutput?.key === outputKey ? liveOutput : undefined;
  const chunks = currentOutput?.output.chunks ?? [];
  const savedResult = !chunks.length && (!canReadOutput || currentOutput?.available === false)
    ? currentOutput?.result ?? job.result : undefined;
  const stdout = chunks.filter(chunk => chunk.stream !== 'stderr').map(chunk => chunk.text).join('') || savedResult?.stdout;
  const stderr = chunks.filter(chunk => chunk.stream === 'stderr').map(chunk => chunk.text).join('') || savedResult?.stderr;
  const outputState = currentOutput?.state ?? job.state;
  useEffect(() => { setFollowOutput(true); }, [outputKey]);
  useLayoutEffect(() => {
    if (visible && followOutput && outputNode.current) outputNode.current.scrollTop = outputNode.current.scrollHeight;
  }, [stdout, stderr, visible, followOutput]);
  const terminalNavigation = [
    ...terminalTabs.map(tab => ({ key: `terminal:${tab.key}`, elementId: `dock-pty-tab-${tab.key}`, select: () => { setSelectedTerminal(tab.key); setSelected(''); } })),
    ...opened.map(id => ({ key: `job:${id}`, elementId: `dock-job-tab-${id}`, select: () => { setSelected(id); setSelectedTerminal(''); } })),
  ];
  const navigateTerminalTabs = (event: React.KeyboardEvent, key: string) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !terminalNavigation.length) return;
    event.preventDefault();
    const current = terminalNavigation.findIndex(item => item.key === key);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? terminalNavigation.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + terminalNavigation.length) % terminalNavigation.length;
    terminalNavigation[next].select(); document.getElementById(terminalNavigation[next].elementId)?.focus();
  };
  const openJob = (id: string) => { setOpened(old => old.includes(id) ? old : [...old, id]); setSelected(id); setSelectedTerminal(''); };
  const closeTab = (id: string) => {
    const index = opened.indexOf(id), remaining = opened.filter(item => item !== id); setOpened(remaining);
    if (selected === id) setSelected(remaining[Math.max(0, index - 1)] ?? '');
  };
  const run = async () => {
    if (busy || (!submission && (!command.trim() || !effectiveShell))) return;
    if (!submission && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86400)) {
      setError(new Error('超时需要填写 1–86400 之间的整数秒数。')); return;
    }
    const request = submission ?? {
      params: { shellId: effectiveShell, command, cwd, background: true, timeoutMs: timeout * 1000 },
      requestId: requestKey(), sessionId,
    };
    setBusy('run'); setError(undefined); setSubmission(request);
    try {
      const value = unwrap(await context.api.call('runtime', 'shell.run', request.params, { scope: scoped(context, request.sessionId), mutating: true, requestId: request.requestId }));
      if (!value.id) throw new Error('宿主未返回作业标识；请核对作业列表和原提交。');
      openJob(String(value.id)); setCommand(''); setSubmission(undefined); jobs.reload();
      if (context.host && request.sessionId) openLiveCommandMonitor(context.host, request.sessionId, `runtime:${value.id}`);
    } catch (cause) {
      setError(cause);
      if (['INVALID_ARGUMENT', 'PERMISSION_DENIED', 'HOST_CAPABILITY_UNAVAILABLE', 'NOT_FOUND'].includes(errorData(cause).code)) setSubmission(undefined);
    }
    finally { setBusy(''); }
  };
  const cancel = async () => {
    if (!selected || busy) return;
    setBusy('cancel'); setError(undefined);
    try {
      const value = await context.api.call('runtime', 'jobs.cancel', { id: selected }, { scope: scoped(context, sessionId), mutating: true });
      if (value.cancelled === false) context.notify('作业未被取消', 'info', '此作业已经结束，或当前插件实例不持有取消句柄。');
      detail.reload(); jobs.reload();
    } catch (cause) { setError(cause); }
    finally { setBusy(''); }
  };
  const openTerminal = async () => {
    if (busy) return;
    setBusy('terminal'); setError(undefined);
    try {
      if (!sessionId) throw new Error('请先选择会话，宿主终端以会话为范围。');
      if (!terminalService) {
        await context.api.call('runtime', 'terminal.open', { cwd, ...(effectiveShell ? { shellId: effectiveShell } : {}), cols: 100, rows: 24 }, { scope: scoped(context, sessionId), mutating: true });
        throw new Error('宿主已受理终端操作，但未提供可挂载的 webTerminals 交互视图；请打开宿主原生终端。');
      }
      const key = `nexus:terminal:${requestKey()}`;
      const shellPath = availableShells.find(item => item.id === effectiveShell)?.executable;
      const model = terminalService.view(sessionId, key, key, undefined, typeof shellPath === 'string' ? shellPath : undefined);
      setTerminalTabs(old => [...old, { key, sessionId, title: effectiveShell || '宿主终端', model }]);
      setSelectedTerminal(key); setSelected('');
    } catch (cause) { setError(cause); }
    finally { setBusy(''); }
  };
  const recoverTerminals = async () => {
    if (!terminalService || !sessionId) return;
    try { setRecoverable(await terminalService.recover(sessionId)); }
    catch (cause) { setError(cause); }
  };
  const attachTerminal = (id: string) => {
    if (!terminalService || !sessionId || !id) return;
    try {
      const key = `nexus:terminal:${requestKey()}`, info = recoverable.find(item => item.id === id);
      const model = terminalService.view(sessionId, key, key, id);
      setTerminalTabs(old => [...old, { key, sessionId, title: info?.title || id, model }]);
      setSelectedTerminal(key); setSelected('');
    } catch (cause) { setError(cause); }
  };
  return <div className="nexus-terminal-jobs">
    <aside className="nexus-dock-job-list">
      <header><strong>{sessionId ? '会话作业' : '工作区作业'}</strong><IconButton name="refresh" label="刷新后台作业" onClick={jobs.reload} /></header>
      {Boolean(jobs.error) && <ErrorMessage error={jobs.error} retry={jobs.reload} />}
      {allJobs.length ? allJobs.map(item => <button key={idOf(item)} className={selected === idOf(item) ? 'is-selected' : ''} onClick={() => openJob(idOf(item))}><Icon name="terminal" size={14} /><span><strong>{item.command ?? idOf(item)}</strong><small><Status value={item.state ?? 'unknown'} /><Time value={item.startedAt} /></small></span></button>) : <p className="nexus-muted">{jobs.loading ? '正在读取作业…' : '此范围还没有作业'}</p>}
    </aside>
    <div className="nexus-dock-job-main">
      <div className="nexus-dock-tabbar">
        <div className="nexus-dock-tabstrip" role="tablist" aria-label="终端作业标签">
          {terminalTabs.map((tab, index) => <div key={tab.key} className={`nexus-dock-tab ${selectedTerminal === tab.key ? 'is-active' : ''}`}>
            <button type="button" role="tab" aria-selected={selectedTerminal === tab.key} tabIndex={selectedTerminal === tab.key ? 0 : -1} id={`dock-pty-tab-${tab.key}`} aria-controls={`dock-pty-${tab.key}`} onClick={() => { setSelectedTerminal(tab.key); setSelected(''); }}
              onKeyDown={event => navigateTerminalTabs(event, `terminal:${tab.key}`)}><Icon name="terminal" size={13} /><span>{tab.title}</span></button>
            <IconButton name="close" label="关闭终端标签，保留进程" onClick={() => {
              const remaining = terminalTabs.filter(item => item.key !== tab.key); setTerminalTabs(remaining);
              if (selectedTerminal === tab.key) { setSelectedTerminal(remaining[Math.max(0, index - 1)]?.key ?? ''); if (!remaining.length) setSelected(opened[0] ?? ''); }
            }} />
          </div>)}
          {opened.map(id => {
          const item = allJobs.find(row => idOf(row) === id);
          return <div key={id} className={`nexus-dock-tab ${selected === id ? 'is-active' : ''}`}><button role="tab" type="button" aria-selected={selected === id} tabIndex={selected === id ? 0 : -1} id={`dock-job-tab-${id}`} aria-controls="nexus-dock-job-output" onClick={() => { setSelected(id); setSelectedTerminal(''); }}
            onKeyDown={event => navigateTerminalTabs(event, `job:${id}`)}><Icon name="terminal" size={13} /><span>{item?.command ?? id}</span></button><IconButton name="close" label="关闭作业标签，保持后台运行" onClick={() => closeTab(id)} /></div>;
        })}</div>
        {terminalService && <select aria-label="接入正在运行的宿主终端" value="" onFocus={() => void recoverTerminals()} onChange={event => attachTerminal(event.target.value)}><option value="">接入终端…</option>{recoverable.map(item => <option key={item.id} value={item.id}>{item.title || item.id} · {item.state}</option>)}</select>}
        <Button icon="plus" title="交互终端沿用会话工作目录" busy={busy === 'terminal'} disabled={!!busy} onClick={() => void openTerminal()}>打开宿主终端</Button>
      </div>
      {Boolean(error) && <div className="nexus-dock-inline-error"><ErrorMessage error={error} /></div>}
      {terminalTabs.map(tab => <div key={tab.key} id={`dock-pty-${tab.key}`} className="nexus-dock-pty-panel" role="tabpanel" aria-labelledby={`dock-pty-tab-${tab.key}`} hidden={selectedTerminal !== tab.key}><HostTerminalPanel model={tab.model} visible={visible && selectedTerminal === tab.key} /></div>)}
      <div id="nexus-dock-job-output" className="nexus-dock-job-output" hidden={!!selectedTerminal} role={selected ? 'tabpanel' : undefined} aria-labelledby={selected ? `dock-job-tab-${selected}` : undefined} ref={outputNode} onScroll={event => {
        const node = event.currentTarget;
        if (node.scrollHeight - node.scrollTop - node.clientHeight > 40) setFollowOutput(false);
      }}>
        {selected ? <>{Boolean(detail.error) && <ErrorMessage error={detail.error} retry={detail.reload} />}<div className="nexus-dock-job-meta"><Status value={outputState ?? 'unknown'} /><code>{job.cwd ?? '.'}</code><span>{job.result ? `退出码 ${job.result.exitCode ?? '未报告'} · ${job.result.durationMs ?? '未报告'} ms` : activeState(outputState) ? '正在读取实时输出…' : '作业输出'}</span>
          <label><input type="checkbox" checked={followOutput} onChange={event => setFollowOutput(event.target.checked)} />跟随输出</label>
          {context.host && sessionId && <Button onClick={() => openLiveCommandMonitor(context.host!, sessionId, `runtime:${selected}`)}>底部监视器</Button>}
          <Button icon="stop" busy={busy === 'cancel'} disabled={!!busy || !activeState(job.state)} onClick={() => void cancel()}>停止作业</Button><IconButton name="info" label="查看完整作业回执" onClick={() => context.inspect({ title: '命令作业', id: selected, data: job })} /></div>
          {Boolean(currentOutput?.error) && <ErrorMessage error={currentOutput?.error} />}
          <pre className="nexus-dock-console" tabIndex={0} aria-label="命令标准输出">{stdout || (activeState(outputState) ? '命令正在运行，等待输出…' : currentOutput?.available === false && !savedResult ? '实时输出已离开保留范围。' : currentOutput || savedResult ? '（标准输出为空）' : '正在读取作业输出…')}</pre>
          {stderr && <pre className="nexus-dock-console is-stderr" tabIndex={0} aria-label="命令标准错误">{stderr}</pre>}
          {currentOutput?.output.lossy && <p className="nexus-dock-output-note">部分早期输出已超出保留范围，当前显示保留的尾部。</p>}
          {savedResult && <p className="nexus-dock-output-note">实时输出已离开内存，当前显示已保存的执行结果。</p>}
          {job.result?.truncated === true && <p className="nexus-dock-output-note">输出超过作业上限，宿主已标记为截断。</p>}
          {Boolean(job.error) && <ErrorMessage error={job.error} />}
        </> : <StateMessage title="让命令在后台继续执行" icon="terminal">选择实际 Shell 后提交命令。作业保留独立 ID、退出码和输出，关闭标签可从左侧重新打开。</StateMessage>}
      </div>
      <form className="nexus-dock-command" hidden={!!selectedTerminal} onSubmit={event => { event.preventDefault(); void run(); }}>
        {Boolean(shells.error) && <ErrorMessage error={shells.error} retry={shells.reload} />}
        <div className="nexus-dock-command-options">
          <select aria-label="命令 Shell" value={effectiveShell} disabled={!!busy || !!submission} onChange={event => setShellId(event.target.value)}><option value="" disabled>选择已验证 Shell</option>{shellItems.map(item => <option key={item.id} value={item.id} disabled={item.available !== true}>{item.flavor ?? item.id}{item.available !== true ? ' · 不可用' : ''}</option>)}</select>
          <label>作业目录<input aria-label="命令工作区相对目录" value={cwd} onChange={event => setCwd(event.target.value)} disabled={!!busy || !!submission} spellCheck={false} /></label>
          <label>超时（秒）<input type="number" aria-label="命令超时秒数" min={1} max={86400} value={timeout} disabled={!!busy || !!submission} onChange={event => setTimeoutSeconds(Number(event.target.value))} /></label>
          <span>关闭标签保留作业 · 停止按钮取消执行</span>
        </div>
        <div className="nexus-dock-command-line"><span aria-hidden="true">›</span><textarea aria-label="后台命令" rows={1} value={command} placeholder="输入实际执行的命令…" disabled={!!busy || !!submission} onChange={event => setCommand(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void run(); }
        }} /><Button type="submit" primary icon="play" busy={busy === 'run'} disabled={!!busy || (!submission && (!command.trim() || !effectiveShell))}>{submission ? '重试原命令' : '运行'}</Button></div>
      </form>
    </div>
  </div>;
}

/** Native service owns the process; this component owns only its attachment. */
function HostTerminalPanel({ model, visible }: { model: TerminalModel; visible: boolean }) {
  const subscribe = useMemo(() => (listener: () => void) => model.state.subscribe(listener), [model]);
  const snapshot = useMemo(() => () => model.state.getSnapshot(), [model]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [error, setError] = useState<unknown>();
  const [closing, setClosing] = useState(false);
  const node = useRef<HTMLDivElement>(null);
  const emulator = useRef<Terminal | undefined>(undefined);
  const fitter = useRef<FitAddon | undefined>(undefined);
  const received = useRef(0);
  const current = useRef({ state, visible });
  current.current = { state, visible };
  useEffect(() => {
    try { return model.mount(); } catch (cause) { setError(cause); }
  }, [model]);
  useLayoutEffect(() => {
    if (!node.current) return;
    const element = node.current;
    const term = new Terminal({
      fontFamily: 'Consolas, "SFMono-Regular", monospace', fontSize: 12,
      minimumContrastRatio: 4.5, cursorBlink: false, allowProposedApi: false,
      scrollback: Math.max(0, Math.min(10000, current.current.state.environment?.scrollback ?? 2000)),
    });
    const addon = new FitAddon(); term.loadAddon(addon); term.open(element);
    term.textarea?.setAttribute('aria-label', '宿主交互终端');
    emulator.current = term; fitter.current = addon; received.current = 0;
    const input = term.onData(data => {
      if (!current.current.state.writable) return;
      try { model.write(data); } catch (cause) { setError(cause); }
    });
    const resize = () => {
      const live = current.current;
      if (!live.visible || !live.state.writable || !element.clientWidth || !element.clientHeight) return;
      try { resizeTerminal(term, addon, live.state, model); } catch (cause) { setError(cause); }
    };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : undefined;
    observer?.observe(element);
    const repaint = () => {
      const tokens = getComputedStyle(element);
      term.options.theme = { background: tokens.backgroundColor, foreground: tokens.color, cursor: tokens.color, cursorAccent: tokens.backgroundColor };
    };
    repaint();
    const root = element.closest('.nexus-root');
    const themeObserver = typeof MutationObserver !== 'undefined' && root ? new MutationObserver(repaint) : undefined;
    if (root) themeObserver?.observe(root, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => {
      observer?.disconnect(); themeObserver?.disconnect(); input.dispose(); term.dispose();
      emulator.current = undefined; fitter.current = undefined;
    };
  }, [model]);
  useLayoutEffect(() => {
    const term = emulator.current, render = state.render;
    if (!term || !render || render.revision <= received.current) return;
    received.current = render.revision;
    let disposed = false;
    try {
      if (render.frame.type === 'snapshot') {
        term.reset();
        term.resize(Math.max(2, render.frame.info.cols), Math.max(1, render.frame.info.rows));
      }
      const content = render.frame.type === 'snapshot' ? render.frame.screen : render.frame.data;
      if (typeof content !== 'string') throw new Error('宿主终端屏幕帧格式无效。');
      term.write(content, () => {
        if (disposed) return;
        try { model.acknowledge(render.revision); } catch (cause) { setError(cause); }
      });
    } catch (cause) { setError(cause); }
    return () => { disposed = true; };
  }, [state.render, model]);
  useLayoutEffect(() => {
    const term = emulator.current, addon = fitter.current;
    if (!term || !addon) return;
    term.options.disableStdin = !state.writable;
    try {
      if (visible && state.writable) resizeTerminal(term, addon, state, model);
      else if (state.info) term.resize(Math.max(2, state.info.cols), Math.max(1, state.info.rows));
    } catch (cause) { setError(cause); }
  }, [state.writable, state.info, state.environment, visible, model]);
  const stop = async () => {
    setClosing(true); setError(undefined);
    try { await model.close(); }
    catch (cause) { setError(cause); }
    finally { setClosing(false); }
  };
  return <div className="nexus-host-terminal">
    <div className="nexus-host-terminal-status"><Status value={state.info?.state ?? state.phase} /><strong>{state.info?.title ?? '宿主终端'}</strong><code>{state.info?.cwd}</code><span>{state.writable ? '已获得输入控制' : '当前只读'}{state.info?.exitCode !== null && state.info?.exitCode !== undefined ? ` · 退出码 ${state.info.exitCode}` : ''}</span>
      {['failed', 'disconnected', 'closed'].includes(state.phase) && <Button disabled={closing} onClick={() => {
        setError(undefined);
        try { if (state.info) model.connect(); else void model.refresh().catch(setError); } catch (cause) { setError(cause); }
      }}>重新连接</Button>}
      <Button icon="stop" busy={closing} disabled={state.info?.state === 'exited' || state.phase === 'closed'} onClick={() => void stop()}>结束终端进程</Button>
    </div>
    {Boolean(error) && <ErrorMessage error={error} />}
    {(state.error || state.info?.error) && <p className="nexus-host-terminal-error" role="alert">{state.error ?? state.info?.error}</p>}
    <div className="nexus-host-terminal-screen" ref={node} />
  </div>;
}

function resizeTerminal(term: Terminal, addon: FitAddon, state: TerminalState, model: TerminalModel) {
  const size = addon.proposeDimensions(), limits = state.environment;
  if (!size || !limits) return;
  const columns = Math.max(2, Math.min(limits.maxCols, size.cols)), lines = Math.max(1, Math.min(limits.maxRows, size.rows));
  if (term.cols === columns && term.rows === lines && state.info?.cols === columns && state.info?.rows === lines) return;
  term.resize(columns, lines); model.resize(columns, lines);
}
