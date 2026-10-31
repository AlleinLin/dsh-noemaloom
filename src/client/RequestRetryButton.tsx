import * as React from 'react';
import { createPortal } from 'react-dom';
import type { ClientContext, NexusApi } from './types.js';
import { createNexusApi } from './transport.js';
import { Icon } from './components.js';
import { RequestRetrySettings } from './RequestRetrySettings.js';

type ButtonProps = { api: NexusApi; sessionId?: string };

/**
 * The retry/freeze settings are a session concern. Keeping the trigger in the
 * input.right seat makes it available in both the main composer and the
 * subagent composer while preserving the host's model selector order.
 */
export function RequestRetryButton({ api, sessionId }: ButtonProps): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  const dialog = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => {
    const element = dialog.current;
    if (!element || !open) return;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, [open]);

  const close = () => setOpen(false);
  if (!sessionId) return null;
  return <span className="nexus-request-retry-control" data-nexus-request-retry-session={sessionId}>
    <button
      type="button"
      className="nexus-request-retry-trigger"
      aria-label="请求重试与会话冻结"
      title="设置订阅限额冻结时长"
      onMouseDown={event => event.preventDefault()}
      onClick={() => setOpen(true)}
    >
      <Icon name="history" size={15} /><span>冻结</span>
    </button>
    {open && createPortal(
      <dialog
        ref={dialog}
        className="nexus-request-retry-dialog"
        aria-label="请求重试与会话冻结"
        data-nexus-request-retry-dialog={sessionId}
        onCancel={event => { event.preventDefault(); close(); }}
      >
        <header>
          <strong>请求重试与会话冻结</strong>
          <button type="button" aria-label="关闭请求重试与会话冻结" onClick={close}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="nexus-request-retry-body">
          <small className="nexus-request-retry-identity">当前会话 · {sessionId}</small>
          <RequestRetrySettings api={api} scope={{ level: 'session', sessionId }} />
        </div>
      </dialog>,
      document.body,
    )}
  </span>;
}

/**
 * Register the button only after the host declares the right input seat.
 * This follows the same injection lifecycle as the existing maintenance
 * control and is therefore shared by native and Codinput composers.
 */
export function registerRequestRetryButton(raw: ClientContext, api?: NexusApi): () => void {
  const ctx = raw as any;
  const retryApi = api ?? createNexusApi(raw);
  const Entry = (props: Omit<ButtonProps, 'api'>) => <RequestRetryButton {...props} api={retryApi} />;
  const mounted = ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'noemaloom.request-retry',
    order: 90,
  }, Entry));
  return () => {
    if (typeof mounted === 'function') mounted();
    if (!api) retryApi.dispose();
  };
}
