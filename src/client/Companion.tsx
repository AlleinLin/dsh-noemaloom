import * as React from 'react';
import type { ClientContext, Data, NexusApi } from './types.js';
import { createNexusApi, errorData } from './transport.js';
import { AuxiliarySettings } from './AuxiliarySettings.js';
import styles from './companion.css';

export function quoteCompanion(actions: any, input: any, note: Data): boolean {
  if (!actions?.insertText || input.phase !== 'plain') return false;
  const span = actions.captureInsertion();
  const applied = actions.insertText(`\n> You should know: ${note.text}\n> ${note.explanation}\n\n`, span);
  if (applied) actions.persistDraft();
  return applied;
}
/** A click enters the native submission transaction exactly once. It neither
 * overwrites a draft nor bypasses claims, attachment serialization, or Queue. */
export function sendThoroughPrompt(actions: any, input: any, prompt: string, latch: { current: boolean }, span: any): boolean {
  if (latch.current || !actions?.submit || !actions?.insertText || input.phase !== 'plain' || input.draft?.length || input.attachmentIds?.length) return false;
  if (!actions.insertText(prompt, span)) return false;
  latch.current = true; actions.persistDraft(); actions.submit(); return true;
}
function Companion({ api, sessionId, inputActions, useInput, running }: { api: NexusApi; sessionId: string; inputActions: any; useInput: any; running: boolean }) {
  const latestInput = React.useRef<any>(undefined);
  const input = useInput((value: any) => { latestInput.current = value; return value; });
  const [value, setValue] = React.useState<Data>(), [error, setError] = React.useState('');
  const [expanded, setExpanded] = React.useState(false), [settingsOpen, setSettingsOpen] = React.useState(false), [busy, setBusy] = React.useState(false);
  const [dismissedWithoutReading, setDismissedWithoutReading] = React.useState(false);
  const [now, setNow] = React.useState(Date.now()), latch = React.useRef(false);
  const scope = React.useMemo(() => ({ level: 'session' as const, sessionId }), [sessionId]);
  const alive = React.useRef<AbortController | undefined>(undefined);
  const latestValue = React.useRef(value); latestValue.current = value;
  const loading = React.useRef<Promise<void> | undefined>(undefined);
  const readVersion = React.useRef(0);
  const load = React.useCallback(async (signal?: AbortSignal) => {
    if (loading.current) return loading.current;
    const version = readVersion.current;
    const operation = (async () => { const result = await api.call('companion', 'get', {}, { scope, signal }); if (!signal?.aborted && version === readVersion.current) setValue(result); })();
    loading.current = operation;
    try { await operation; } finally { if (loading.current === operation) loading.current = undefined; }
  }, [api, scope]);
  React.useEffect(() => {
    const c = new AbortController(); alive.current = c;
    void load(c.signal).catch(e => { if (!c.signal.aborted) setError(errorData(e).message); });
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      const current = latestValue.current;
      const delay = current?.enabled === false || current?.state === 'unconfigured' ? 120000 : current?.state === 'checking' || current?.gate?.state === 'pending' || running ? 2000 : 30000;
      timer = setTimeout(() => { if (document.visibilityState === 'hidden') { poll(); return; } void load(c.signal).catch(() => {}).finally(() => { if (!c.signal.aborted) poll(); }); }, delay);
    };
    poll();
    const visible = () => { if (document.visibilityState !== 'hidden') void load(c.signal).catch(() => {}); };
    document.addEventListener('visibilitychange', visible);
    return () => { c.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); alive.current = undefined; };
  }, [load, running]);
  React.useEffect(() => {
    if (value?.gate?.state !== 'pending' && !value?.dismissedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);
  }, [value?.gate?.state, value?.dismissedAt]);
  React.useEffect(() => { setExpanded(false); }, [value?.noteId]);
  React.useEffect(() => { latch.current = false; }, [value?.gate?.id]);
  const act = async (action: string, params: Data) => {
    const signal = alive.current?.signal; if (!signal || signal.aborted || busy) return;
    setBusy(true); setError(''); readVersion.current++;
    try { const result = await api.call('companion', action, params, { scope, mutating: true, signal }); if (!signal.aborted) { readVersion.current++; setValue(previous => ({ ...previous, ...result })); } }
    catch (e) { if (!signal.aborted) setError(errorData(e).message); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const note = value?.note, gate = value?.gate;
  const currentTime = Math.max(now, Date.now());
  const ready = gate?.state === 'pending' && gate.expiresAt > currentTime;
  const disabledSend = busy || latch.current || input.phase !== 'plain' || Boolean(input.draft?.length) || Boolean(input.attachmentIds?.length);
  const answer = (choice: string) => {
    setDismissedWithoutReading(choice === 'dismiss' && !expanded);
    void act('answer', { noteId: value?.noteId, choice });
  };
  return <section className="nexus-companion" data-nexus-companion={sessionId} aria-label="You should know">
    <style>{styles}</style>
    {note && value?.enabled && value?.suggestionsEnabled && <div className="nexus-companion-note" data-nexus-companion-note="">
      <div className="nexus-companion-note-text"><strong>You should know</strong><span title={note.text}>{note.text}</span></div>
      {expanded ? <><p className="nexus-companion-explanation" data-nexus-note-explanation="">{note.explanation}</p><div className="nexus-companion-actions">
        <button disabled={busy} data-nexus-note-understood="" onClick={() => answer('known')}>Understood</button>
        <button disabled={busy || input.phase !== 'plain'} data-nexus-note-quote="" onClick={() => { if (!quoteCompanion(inputActions, input, note)) setError('草稿已变化或正在发送，引用未写入'); }}>Chat in main session</button>
        <button disabled={busy} data-nexus-note-dismiss="" onClick={() => answer('dismiss')}>Dismiss</button>
      </div></> : <div className="nexus-companion-actions">
        <button data-nexus-note-learn="" onClick={() => setExpanded(true)}>Learn more</button>
        <button disabled={busy} data-nexus-note-known="" onClick={() => answer('known')}>Knew this already</button>
        <button disabled={busy} data-nexus-note-dismiss="" onClick={() => answer('dismiss')}>Dismiss</button>
      </div>}
    </div>}
    {!note && dismissedWithoutReading && value?.dismissedAt && currentTime - value.dismissedAt < 20000 && <div className="nexus-companion-dismissed">Dismissed. <button disabled={busy} onClick={() => {
      const signal = alive.current?.signal; setBusy(true);
      void api.call('scope', 'settings', { feature: 'auxiliary' }, { scope, signal }).then(config => api.call('scope', 'configure',
        { feature: 'auxiliary', config: { ...config.local?.config, defaults: { ...config.local?.config?.defaults, suggestions: false } } },
        { scope, signal, mutating: true, revision: config.local?.revision ?? 0 })).then(() => load(signal)).catch(e => { if (!signal?.aborted) setError(errorData(e).message); }).finally(() => { if (!signal?.aborted) setBusy(false); });
    }}>Turn off suggestions</button></div>}
    {ready && value?.enabled && <div className="nexus-companion-gate" data-nexus-thorough-gate="">
      <strong>调研已完成，方案尚未开始</strong>
      <details><summary>深入四问</summary><p>{value.planningPrompt}</p></details>
      <div className="nexus-companion-actions"><button data-nexus-thorough-send="" disabled={disabledSend} title={disabledSend ? '现有草稿、附件或发送事务尚未处理' : '通过原生输入发送四问'} onClick={() => {
        const signal = alive.current?.signal;
        if (!signal || signal.aborted || disabledSend || gate.expiresAt <= Date.now()) return;
        const span = inputActions.captureInsertion();
        setBusy(true);
        void api.call('companion', 'gate', { gateId: gate.id, choice: 'authorize' }, { scope, signal, mutating: true }).then(async result => {
          if (signal.aborted || !result.authorized || gate.expiresAt <= Date.now()) return;
          if (sendThoroughPrompt(inputActions, latestInput.current, value.planningPrompt, latch, span)) {
            const latest = await api.call('companion', 'gate', { gateId: gate.id, choice: 'sent' }, { scope, signal, mutating: true });
            if (!signal.aborted) { readVersion.current++; setValue(previous => ({ ...previous, ...latest })); }
          } else setError('草稿、附件或发送状态已变化，四问未发送');
        }).catch(e => { if (!signal.aborted) setError(errorData(e).message); }).finally(() => { if (!signal.aborted) setBusy(false); });
      }}>发送四问</button><button data-nexus-thorough-skip="" disabled={busy} onClick={() => void act('gate', { gateId: gate.id, choice: 'skipped' })}>略过</button>
        <small>{Math.max(0, Math.ceil((gate.expiresAt - currentTime) / 1000))} 秒后继续</small></div>
    </div>}
    {value?.reflection && value.enabled && value.reflectionEnabled && <details className="nexus-companion-reflection" data-nexus-deep-reflection=""><summary>{value.reflection.stage === 'review' ? 'Review' : '规划前'} · 更深的问题</summary><p>{value.reflection.text}</p></details>}
    {value && <details className="nexus-companion-status"><summary>{value.state === 'checking' ? '独立辅助检查中' : value.state === 'unconfigured' ? '辅助模型未配置' : value.state === 'failed' || value.state === 'context-incomplete' ? '辅助检查未完成' : value.state === 'disabled' ? '独立辅助已停用' : '独立辅助'}{value.attempts?.some((a: Data) => a.state === 'failed') ? ' · 已降级' : ''}</summary>
      {value.error && <p role="status">{value.errorCode} · {value.error}</p>}
      {value.attempts?.length > 0 && <ol>{value.attempts.map((a: Data, index: number) => <li key={index}>{a.provider}/{a.model} · {a.state === 'succeeded' ? '成功' : `${a.code} · ${a.reason}`}{a.reasoningEffort ? ` · reasoning_effort=${a.reasoningEffort}` : ''}{a.retryAfterMs ? ` · 服务建议等待 ${a.retryAfterMs}ms` : ''}</li>)}</ol>}
      {value.coverage && <div data-nexus-context-coverage=""><p>{value.coverage.complete ? '已覆盖全部可访问事件' : '上下文覆盖不完整'} · {value.coverage.eventCount} 事件 · {value.coverage.sessions?.length} 会话 · {value.coverage.chars} 字符 · {value.contextMode === 'summarized' ? '有损分段摘要' : '脱敏原文'}</p><p>{value.coverage.boundary}</p>{value.coverage.unavailable?.map((item: Data) => <p key={item.sessionId}>{item.sessionId} · {item.reason}</p>)}</div>}
      <p>今日实际请求 {value.callsToday ?? 0} 次</p><div className="nexus-companion-actions"><button disabled={busy || value.state === 'checking'} data-nexus-companion-retry="" onClick={() => void act('retry', {})}>重试辅助检查</button><button onClick={() => setSettingsOpen(!settingsOpen)}>本会话辅助设置</button></div>
      {settingsOpen && <AuxiliarySettings api={api} scope={scope} scoped onSaved={() => void load(alive.current?.signal)} />}
    </details>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
export function registerCompanionConversation(ctx: ClientContext): () => void {
  const api = createNexusApi(ctx); let disposed = false;
  function Entry(props: any) {
    const session = props.useSession((s: any) => s);
    if (disposed || !props.sessionId || session?.sessionId !== props.sessionId || session?.header?.origin === 'subagent') return null;
    return <Companion key={props.sessionId} api={api} sessionId={props.sessionId} inputActions={props.inputActions} useInput={props.useInput} running={Boolean(session.running)} />;
  }
  const generation = ctx.connection.generation; let old = generation?.getSnapshot()?.id;
  const reset = generation?.subscribe(() => { const next = generation.getSnapshot()?.id; if (next !== old) { old = next; api.reset(); } });
  const remove = ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'nexus.companion', order: 30 }, Entry));
  return () => { disposed = true; if (typeof remove === 'function') remove(); reset?.(); api.dispose(); };
}
