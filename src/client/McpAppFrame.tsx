import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Data, ViewContext } from './types.js';
import { Button, ErrorMessage, Icon, Status } from './components.js';

/** MCP/HTML artifacts remain opaque sandboxed documents; never the plugin shell. */
export function McpAppFrame({ context, html, source, artifactId, revision, onSubmit }: { context: ViewContext; html: string; source: string; artifactId: string; revision?: number; onSubmit?(value: Data): Promise<unknown> }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(420);
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const nonce = useMemo(() => `nexus-${crypto.randomUUID()}`, [artifactId, revision, html]);
  const seen = useRef(new Set<string>());
  const [request, setRequest] = useState<Data>();
  const lastSubmit = useRef(0);
  useEffect(() => {
    setReady(false); setLoaded(false); setRequest(undefined); setError(undefined); seen.current.clear();
    const handle = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      const message = event.data;
      if (!message || typeof message !== 'object' || message.protocol !== 'nexus.mcp-app.v1' || message.nonce !== nonce || typeof message.type !== 'string') return;
      if (message.type === 'ready') { setReady(true); return; }
      if (message.type === 'resize') { const next = Number(message.height); if (Number.isFinite(next)) setHeight(Math.min(1200, Math.max(180, next))); return; }
      if (message.type === 'submit') {
        const requestId = typeof message.requestId === 'string' ? message.requestId : '';
        if (!onSubmit || !requestId || requestId.length > 128 || seen.current.has(requestId) || Date.now() - lastSubmit.current < 500 || !message.value || typeof message.value !== 'object' || Array.isArray(message.value)) return;
        try { if (JSON.stringify(message.value).length > 16384) return; } catch { return; }
        seen.current.add(requestId); lastSubmit.current = Date.now(); setRequest({ requestId, value: message.value });
      }
    };
    window.addEventListener('message', handle);
    return () => { window.removeEventListener('message', handle); seen.current.clear(); };
  }, [artifactId, revision, nonce, onSubmit]);
  const initialize = () => { setLoaded(true); frame.current?.contentWindow?.postMessage({ protocol: 'nexus.mcp-app.v1', type: 'initialize', nonce, artifactId, revision, capabilities: { resize: true, submit: !!onSubmit, network: false, hostAccess: false } }, '*'); };
  const submit = async () => {
    if (!request || !onSubmit) return;
    setBusy(true); setError(undefined);
    try {
      const result = await onSubmit(request.value);
      frame.current?.contentWindow?.postMessage({ protocol: 'nexus.mcp-app.v1', type: 'result', nonce, requestId: request.requestId, result }, '*');
      setRequest(undefined); context.notify('产物提交已获得宿主回执');
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  const content = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; connect-src 'none'; base-uri 'none'"><meta name="referrer" content="no-referrer">${html}`;
  return <section className="nexus-mcp-app"><header><span><Icon name="file" size={15} /><span data-nexus-verbatim="">{source}</span></span><Status value={ready ? 'active' : loaded ? 'available' : 'pending'} /><small>受限 sandbox · 禁止网络 / 宿主直接访问</small></header>{Boolean(error) && <ErrorMessage error={error} />}<iframe ref={frame} title={`MCP App · ${source}`} srcDoc={content} sandbox="allow-scripts" referrerPolicy="no-referrer" onLoad={initialize} style={{ width: '100%', height, border: 0, background: 'white' }} />{request && <div className="nexus-notice-inline"><div><strong>产物请求提交内容</strong><p>此请求只会在你明确提交后交给对应宿主动作；产物不能直接调用宿主。</p><pre data-nexus-verbatim="">{JSON.stringify(request.value, null, 2)}</pre><Button onClick={() => setRequest(undefined)}>拒绝</Button><Button primary disabled={!onSubmit} busy={busy} onClick={() => void submit()}>提交给宿主</Button></div></div>}</section>;
}
