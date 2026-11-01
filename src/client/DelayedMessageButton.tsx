import * as React from 'react';
import { createPortal } from 'react-dom';
import type { Data, NexusApi } from './types.js';
import { errorData } from './transport.js';
import { Icon } from './components.js';

interface Props { api: NexusApi; sessionId?: string }

function asRows(value: any): Data[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function localDate(value: unknown): string {
  const date = new Date(String(value ?? ''));
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
    : '时间未报告';
}

/**
 * A small shared control for the native main composer and subagent composer.
 * The actual delivery is durable and server-side; this UI only creates or
 * revokes a schedule and never keeps a browser timer alive.
 */
export function DelayedMessageButton({ api, sessionId }: Props): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState('');
  const [minutes, setMinutes] = React.useState('60');
  const [plans, setPlans] = React.useState<Data[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const dialog = React.useRef<HTMLDialogElement>(null);
  const scope = React.useMemo(() => ({ level: 'session' as const, sessionId: sessionId ?? '' }), [sessionId]);

  const loadPlans = React.useCallback(async () => {
    if (!sessionId) return;
    try {
      const result = await api.call('workflow', 'prompt/injections', {}, { scope });
      setPlans(asRows(result).map(row => row?.value ? { ...row.value, id: row.id, revision: row.revision } : row)
        .filter(item => ['scheduled', 'queued'].includes(String(item.status))));
    } catch (cause) {
      setError(errorData(cause).message);
    }
  }, [api, scope, sessionId]);

  React.useEffect(() => {
    if (!dialog.current || !open) return;
    dialog.current.showModal();
    void loadPlans();
    return () => { if (dialog.current?.open) dialog.current.close(); };
  }, [open, loadPlans]);

  const close = () => { if (!busy) { setOpen(false); setError(''); setMessage(''); } };
  const schedule = async () => {
    const value = Number(minutes);
    if (!text.trim()) { setError('请填写要发送的固定文字'); return; }
    if (!Number.isFinite(value) || value <= 0 || value > 10_080) { setError('延时须为 1–10080 分钟'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const result: any = await api.call('workflow', 'prompt/schedule',
        { sessionId, text: text.trim(), delayMinutes: value }, { scope, mutating: true });
      const dueAt = result?.value?.dueAt ?? result?.dueAt;
      setText(''); setMessage(`已安排在 ${localDate(dueAt)} 发送`);
      await loadPlans();
    } catch (cause) {
      setError(errorData(cause).message);
    } finally { setBusy(false); }
  };
  const revoke = async (item: Data) => {
    setBusy(true); setError('');
    try {
      await api.call('workflow', 'prompt/revoke', { id: item.id }, { scope, revision: item.revision, mutating: true });
      await loadPlans();
    } catch (cause) {
      setError(errorData(cause).message);
    } finally { setBusy(false); }
  };
  if (!sessionId) return null;
  return <span className="nexus-delayed-message-control" data-nexus-delayed-message-session={sessionId}>
    <button
      type="button"
      className="nexus-delayed-message-trigger"
      aria-label="延时发送固定文字"
      title="设置延时发送固定文字"
      onMouseDown={event => event.preventDefault()}
      onClick={() => setOpen(true)}
    >
      <Icon name="history" size={15} /><span>延时</span>
    </button>
    {open && createPortal(
      <dialog
        ref={dialog}
        className="nexus-delayed-message-dialog"
        aria-label="延时发送固定文字"
        onCancel={event => { event.preventDefault(); close(); }}
      >
        <header>
          <div className="nexus-delayed-message-title">
            <span>SCHEDULED MESSAGE</span>
            <strong>延时发送固定文字</strong>
          </div>
          <button type="button" aria-label="关闭延时发送" onClick={close}><Icon name="close" size={16} /></button>
        </header>
        <div className="nexus-delayed-message-body">
          <div className="nexus-delayed-message-identity"><span>当前会话</span><code>{sessionId}</code></div>
          <label className="nexus-delayed-message-field">
            <span>多久后发送</span>
            <span className="nexus-delayed-message-duration">
              <input aria-label="延时时长（分钟）" type="number" min={1} max={10080} step={1} value={minutes} onChange={event => setMinutes(event.target.value)} />
              <em>分钟</em>
            </span>
            <small>支持 1 分钟到 7 天；主代理和子代理按当前会话分别保存。</small>
          </label>
          <div className="nexus-delayed-message-presets" aria-label="常用延时">
            {[5, 30, 60, 300, 1440].map(value => <button key={value} type="button" onClick={() => setMinutes(String(value))}>{value < 60 ? `${value} 分钟` : value % 1440 === 0 ? `${value / 1440} 天` : `${value / 60} 小时`}</button>)}
          </div>
          <label className="nexus-delayed-message-field">
            <span>发送内容</span>
            <textarea aria-label="延时发送内容" rows={4} maxLength={20000} value={text} onChange={event => setText(event.target.value)} placeholder="例如：请继续检查刚才的测试结果。" />
            <small>到点后作为一条固定文字进入会话，并沿用该会话的模型和权限。</small>
          </label>
          {message && <p className="nexus-delayed-message-success" role="status">{message}</p>}
          {error && <p className="nexus-delayed-message-error" role="alert">{error}</p>}
          {plans.length > 0 && <section className="nexus-delayed-message-plans">
            <h3>待发送</h3>
            {plans.map(item => <div key={item.id} className="nexus-delayed-message-plan">
              <div><strong>{localDate(item.dueAt)}</strong><span title={String(item.body)}>{String(item.body)}</span></div>
              <button type="button" disabled={busy} onClick={() => void revoke(item)}>取消</button>
            </div>)}
          </section>}
        </div>
        <footer>
          <button type="button" onClick={close}>{message ? '完成' : '返回'}</button>
          <button type="button" className="is-primary" disabled={busy || !text.trim()} onClick={() => void schedule()}>{busy ? '处理中…' : '安排发送'}</button>
        </footer>
      </dialog>,
      document.body,
    )}
  </span>;
}

export function registerDelayedMessageButton(raw: { slots: any }, api: NexusApi): () => void {
  const Entry = (props: { sessionId?: string }) => <DelayedMessageButton {...props} api={api} />;
  const mounted = raw.slots.inject('conversation.input.right', () => raw.slots.register({
    name: 'conversation.input.right', id: 'noemaloom.delayed-message', order: 95,
  }, Entry));
  return () => { if (typeof mounted === 'function') mounted(); };
}
