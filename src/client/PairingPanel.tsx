import * as React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from './components.js';
import { errorData } from './transport.js';
import type { Data, ViewContext } from './types.js';

type PairingProtocol = 'native' | 'web';
interface PairingTicket {
  token: string;
  expiresAt: number;
  visibleUntil: number;
  version: number;
  protocol: PairingProtocol;
  generation: number;
  scopeKey: string;
  api: ViewContext['api'];
}
interface OriginResult { value?: string; error?: string }

const permissionGroups = [
  { id: 'sessions', label: '会话控制', description: '发送消息、打断、添加附件、创建及分叉会话', capabilities: ['session.prompt', 'session.interrupt', 'session.attachment', 'session.create', 'session.fork'] },
  { id: 'tasks', label: '修改待办', description: '提交待办变更', capabilities: ['tasks.apply'] },
  { id: 'answers', label: '回答审批问题', description: '响应审批及交互问题', capabilities: ['approval.resolve', 'question.answer'] },
  { id: 'models', label: '选择模型', description: '修改会话使用的模型', capabilities: ['session.setModel'] },
  { id: 'sandbox', label: '调整沙箱', description: '修改会话的权限模式', capabilities: ['session.setPermission'] },
] as const;

function wsOrigin(input: string): OriginResult {
  const text = input.trim();
  if (!text) return {};
  try {
    const parsed = new URL(text);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname) {
      return { error: '请输入完整的 http、https、ws 或 wss 宿主地址。' };
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || /[?#]/.test(text) || parsed.pathname !== '/') {
      return { error: '宿主地址只能包含协议、主机和实际端口；不要包含凭据、路径、查询参数或片段。' };
    }
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    return { value: parsed.origin };
  } catch {
    return { error: '请输入可由配对设备访问的完整宿主地址。' };
  }
}

function reportedOrigin(probe: Data): string {
  for (const candidate of [probe.publicOrigin, probe.hostOrigin]) {
    if (typeof candidate === 'string' && wsOrigin(candidate).value) return candidate.trim();
  }
  return '';
}

function deviceName(protocol: PairingProtocol): string {
  return protocol === 'native' ? '原生手机' : 'Nexus Web 客户端';
}

function expiryLabel(expiresAt: number): string {
  return new Date(expiresAt).toLocaleTimeString('zh-CN', { hour12: false });
}

const PairingQr = React.memo(function PairingQr({ payload }: { payload: string }) {
  return <div style={{ width: 208, padding: 12, borderRadius: 12, background: '#fff', color: '#000', flexShrink: 0 }}>
    <QRCodeSVG value={payload} size={184} level="M" marginSize={4} bgColor="#ffffff" fgColor="#000000" title="一次性设备配对二维码" />
  </div>;
});

function Countdown({ until }: { until: number }) {
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [until]);
  return <span role="timer" aria-live="off">剩余 {Math.max(0, Math.ceil((until - now) / 1000))} 秒</span>;
}

export function PairingPanel({ context, protocol }: { context: ViewContext; protocol: PairingProtocol }) {
  const action = protocol === 'native' ? 'native.pair.token' : 'remote.pair';
  const path = protocol === 'native' ? '/ios/v1' : '/nexus/web/v1';
  const expectedProtocol = protocol === 'native' ? 'native-v1' : 'web-v1';
  const available = context.catalog.some(domain => domain.id === 'connections' && domain.capabilities.some(item => item.action === action));
  const generation = React.useSyncExternalStore(context.api.subscribe, context.api.getGeneration, context.api.getGeneration);
  const id = React.useId();
  const [address, setAddress] = React.useState(() => reportedOrigin(context.probe));
  const [name, setName] = React.useState(() => deviceName(protocol));
  const [selected, setSelected] = React.useState<string[]>([]);
  const [ticket, setTicket] = React.useState<PairingTicket>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [feedback, setFeedback] = React.useState<string>();
  const [copyFeedback, setCopyFeedback] = React.useState<string>();
  const controller = React.useRef<AbortController | undefined>(undefined);
  const requestVersion = React.useRef(0);
  const addressTouched = React.useRef(false);
  const payloadInput = React.useRef<HTMLInputElement>(null);
  const originFromProbe = reportedOrigin(context.probe);
  const origin = React.useMemo(() => wsOrigin(address), [address]);
  const scopeKey = JSON.stringify([context.scope.sessionId, context.scope.workspaceId]);
  const activeTicket = ticket?.protocol === protocol && ticket.generation === generation && ticket.scopeKey === scopeKey && ticket.api === context.api ? ticket : undefined;
  const payload = React.useMemo(() => activeTicket && origin.value ? `${origin.value}${path}?token=${encodeURIComponent(activeTicket.token)}` : '', [activeTicket, origin.value, path]);

  React.useEffect(() => {
    if (!addressTouched.current) setAddress(originFromProbe);
  }, [originFromProbe]);

  React.useEffect(() => {
    requestVersion.current++;
    controller.current?.abort();
    controller.current = undefined;
    setTicket(undefined);
    setBusy(false);
    setSelected([]);
    setName(deviceName(protocol));
    setError(undefined);
    setFeedback(undefined);
    setCopyFeedback(undefined);
    return () => {
      requestVersion.current++;
      controller.current?.abort();
      controller.current = undefined;
    };
  }, [context.api, protocol, generation, context.scope.sessionId, context.scope.workspaceId]);

  React.useEffect(() => {
    if (!ticket) return;
    const timer = window.setTimeout(() => {
      if (requestVersion.current !== ticket.version) return;
      requestVersion.current++;
      setTicket(undefined);
      setSelected([]);
      setCopyFeedback(undefined);
      setFeedback(ticket.expiresAt > ticket.visibleUntil
        ? `本地展示已到 30 秒期限，票据和二维码已清除。服务端票据仍按原到期时间 ${expiryLabel(ticket.expiresAt)} 失效。`
        : '配对票据已过期，票据和二维码已清除。需要时可重新生成。');
    }, Math.max(0, ticket.visibleUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [ticket]);

  React.useEffect(() => { setCopyFeedback(undefined); }, [payload]);

  async function generate() {
    if (!available || busy) return;
    const previousExpiry = activeTicket?.expiresAt;
    const version = ++requestVersion.current;
    controller.current?.abort();
    const pending = new AbortController();
    controller.current = pending;
    setTicket(undefined);
    setError(undefined);
    setCopyFeedback(undefined);
    setBusy(true);
    setFeedback(previousExpiry && previousExpiry > Date.now()
      ? `旧票已从本地清除；服务端仍按原到期时间 ${expiryLabel(previousExpiry)} 失效。`
      : undefined);
    const capabilities = permissionGroups.filter(group => selected.includes(group.id)).flatMap(group => [...group.capabilities]);
    try {
      const result = await context.api.call<Data>('connections', action, { capabilities, name: name.trim() || deviceName(protocol) }, { mutating: true, scope: context.scope, signal: pending.signal });
      if (pending.signal.aborted || requestVersion.current !== version) return;
      const now = Date.now();
      if (result?.protocol !== expectedProtocol || result?.path !== path || result?.oneTime !== true ||
        typeof result?.token !== 'string' || !result.token || result.token.length > 4096 ||
        typeof result?.expiresAt !== 'number' || !Number.isFinite(result.expiresAt)) {
        throw new Error('宿主返回了不兼容的配对票据，请刷新连接后重试。');
      }
      if (result.expiresAt <= now) throw new Error('宿主返回的配对票据已过期，请重新生成。');
      setTicket({ token: result.token, expiresAt: result.expiresAt, visibleUntil: Math.min(result.expiresAt, now + 30_000), version, protocol, generation, scopeKey, api: context.api });
    } catch (cause) {
      if (!pending.signal.aborted && requestVersion.current === version) setError(errorData(cause).message);
    } finally {
      if (requestVersion.current === version) {
        setBusy(false);
        if (controller.current === pending) controller.current = undefined;
      }
    }
  }

  function stop() {
    const expiresAt = activeTicket?.expiresAt;
    requestVersion.current++;
    controller.current?.abort();
    controller.current = undefined;
    setTicket(undefined);
    setBusy(false);
    setSelected([]);
    setName(deviceName(protocol));
    setError(undefined);
    setCopyFeedback(undefined);
    setFeedback(expiresAt && expiresAt > Date.now()
      ? `已停止本地展示并清除票据。服务端票据在原到期时间 ${expiryLabel(expiresAt)} 前仍可能有效；当前没有票据撤销接口。`
      : '已停止本地配对请求并清除票据。若服务端已签发票据，它仍会按原到期时间失效。');
  }

  async function copyPayload() {
    if (!payload || !activeTicket || activeTicket.visibleUntil <= Date.now()) return;
    const version = activeTicket.version;
    try {
      await navigator.clipboard.writeText(payload);
      if (requestVersion.current === version) setCopyFeedback('已复制与二维码一致的协议连接地址。');
    } catch {
      if (requestVersion.current !== version) return;
      setCopyFeedback('剪贴板不可用，请选中下方协议连接地址后手动复制。');
      payloadInput.current?.focus();
      payloadInput.current?.select();
    }
  }

  return <section className="nexus-pairing-panel" aria-labelledby={`${id}-title`} style={{ display: 'grid', gap: 16, minWidth: 0 }}>
    <header>
      <h2 id={`${id}-title`}>{protocol === 'native' ? '原生手机配对' : 'Nexus Web 配对'}</h2>
      <p className="nexus-muted">{protocol === 'native'
        ? '使用支持原生 v1 P-256 协议的手机客户端扫码。票据仅保留在当前面板内存中，最多展示 30 秒。'
        : '用于支持 Nexus Web P-256 协议的客户端。二维码是 WebSocket 协议连接地址，需要客户端完成配对握手。票据最多展示 30 秒。'}</p>
    </header>
    <label className="nexus-field" htmlFor={`${id}-host`}>
      <span>设备可访问的宿主地址</span>
      <input id={`${id}-host`} type="text" inputMode="url" value={address} onChange={event => { addressTouched.current = true; setAddress(event.target.value); }} placeholder="https://你的宿主地址:实际端口" autoComplete="off" spellCheck={false} aria-invalid={!!origin.error || undefined} aria-describedby={`${id}-host-help`} />
      <small id={`${id}-host-help`}>{origin.error ?? '填写宿主公布的公网或局域网根地址；http/https 会转换为 ws/wss。生成二维码需要此地址。'}</small>
    </label>
    <label className="nexus-field" htmlFor={`${id}-name`}>
      <span>设备名称</span>
      <input id={`${id}-name`} value={name} maxLength={96} autoComplete="off" disabled={busy || !!activeTicket} onChange={event => setName(event.target.value)} />
    </label>
    <fieldset disabled={busy || !!activeTicket} style={{ margin: 0, padding: 12, border: '1px solid var(--nexus-border, currentColor)', borderRadius: 10, minWidth: 0 }}>
      <legend>为此设备申请的写权限</legend>
      <p className="nexus-muted" style={{ marginTop: 0 }}>默认只读。仅勾选需要的操作；授权由宿主绑定到本次票据及设备。</p>
      <div style={{ display: 'grid', gap: 10 }}>
        {permissionGroups.map(group => <label key={group.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
          <input type="checkbox" checked={selected.includes(group.id)} onChange={event => setSelected(current => event.target.checked ? [...current, group.id] : current.filter(item => item !== group.id))} />
          <span><strong>{group.label}</strong><small className="nexus-muted" style={{ display: 'block' }}>{group.description}</small></span>
        </label>)}
      </div>
    </fieldset>
    {!available && <p className="nexus-muted" role="status">宿主能力目录尚未提供 {action}，当前无法生成配对票据。</p>}
    {error && <p className="nexus-error" role="alert">{error}</p>}
    <div className="nexus-actions">
      <Button type="button" primary icon={activeTicket ? 'refresh' : 'link'} busy={busy} disabled={!available} onClick={generate}>{activeTicket ? '刷新一次性配对' : '生成一次性配对'}</Button>
      {(activeTicket || busy) && <Button type="button" icon="stop" onClick={stop}>完成 / 停止展示</Button>}
    </div>
    {activeTicket && <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 16, minWidth: 0 }}>
      {payload ? <PairingQr payload={payload} /> : <div className="nexus-notice-inline" role="status">填写有效的宿主根地址后显示二维码。</div>}
      <div style={{ display: 'grid', gap: 12, minWidth: 0, flex: '1 1 260px' }}>
        <div role="status"><strong><Countdown until={activeTicket.visibleUntil} /></strong><span className="nexus-muted"> · 一次性票据 · {selected.length ? `已申请 ${selected.length} 组写权限` : '只读权限'}</span></div>
        <label className="nexus-field" htmlFor={`${id}-token`}>
          <span>一次性配对票据</span>
          <input id={`${id}-token`} data-nexus-verbatim="" value={activeTicket.token} readOnly autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()} />
        </label>
        {payload && <label className="nexus-field" htmlFor={`${id}-payload`}>
          <span>协议连接地址</span>
          <input id={`${id}-payload`} data-nexus-verbatim="" ref={payloadInput} value={payload} readOnly autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()} />
        </label>}
        <div><Button type="button" icon="copy" disabled={!payload} onClick={copyPayload}>复制二维码内容</Button></div>
        {copyFeedback && <p className="nexus-muted" role="status">{copyFeedback}</p>}
      </div>
    </div>}
    {feedback && <p className="nexus-muted" role="status">{feedback}</p>}
  </section>;
}
