import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Button, ErrorMessage, Status } from './components.js';

interface UpdateState { phase: string; version?: string; percent?: number; failure?: string }
interface DesktopUpdates {
  status(): Promise<UpdateState>;
  open(): Promise<void>;
  subscribe(listener: (state: UpdateState) => void): () => void;
}
function officialUpdates(): DesktopUpdates | undefined {
  if (window.location.protocol !== 'dsh-app:' || window.location.hostname !== 'app' || window.top !== window) return undefined;
  const desktop = (window as Window & { dshDesktop?: { protocolVersion?: number; updates?: DesktopUpdates } }).dshDesktop;
  return desktop?.protocolVersion === 1 && typeof desktop.updates?.status === 'function' && typeof desktop.updates?.open === 'function' && typeof desktop.updates?.subscribe === 'function' ? desktop.updates : undefined;
}
const phases: Record<string, string> = { idle: '尚未检查', checking: '正在检查', available: '有可用更新', downloading: '正在下载', ready: '更新已准备就绪', installing: '正在安装', error: '更新失败', 'up-to-date': '已是最新版本' };

/** The installed Desktop preload remains the only update authority. */
export function DesktopControls() {
  const [updates] = useState(officialUpdates);
  const [state, setState] = useState<UpdateState>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState(() => typeof Notification === 'function' ? Notification.permission : 'unsupported');
  const [notificationState, setNotificationState] = useState('尚未发送');
  const [notificationTitle, setNotificationTitle] = useState('DSH Nexus');
  const [notificationBody, setNotificationBody] = useState('');
  const notification = useRef<Notification | undefined>(undefined);
  const closeNotification = () => {
    const current = notification.current;
    if (!current) return;
    current.onshow = null; current.onclick = null; current.onerror = null; current.onclose = null;
    current.close(); notification.current = undefined;
  };
  useEffect(() => {
    const refreshPermission = () => { if (typeof Notification === 'function') setPermission(Notification.permission); };
    document.addEventListener('visibilitychange', refreshPermission);
    return () => { document.removeEventListener('visibilitychange', refreshPermission); closeNotification(); };
  }, []);
  useEffect(() => {
    if (!updates) return;
    let active = true;
    let presentation = 0;
    const dispose = updates.subscribe(next => { presentation++; if (active) setState(next); });
    const initial = presentation;
    void updates.status().then(next => { if (active && initial === presentation) setState(next); }).catch(cause => { if (active) setError(cause); });
    return () => { active = false; dispose(); };
  }, [updates]);
  const open = async () => {
    if (!updates) return;
    setBusy(true); setError(undefined);
    try { await updates.open(); } catch (cause) { setError(cause); } finally { setBusy(false); }
  };
  const requestNotifications = async () => {
    if (typeof Notification !== 'function') return;
    setError(undefined);
    try { setPermission(await Notification.requestPermission()); } catch (cause) { setError(cause); }
  };
  const sendNotification = () => {
    if (typeof Notification !== 'function' || Notification.permission !== 'granted' || !notificationTitle.trim()) return;
    setError(undefined);
    closeNotification();
    setNotificationState('等待系统展示');
    try {
      const next = new Notification(notificationTitle.trim(), { body: notificationBody, tag: 'dsh-nexus-explicit-preview' });
      notification.current = next;
      next.onshow = () => { if (notification.current === next) setNotificationState('系统已展示'); };
      next.onclick = () => { if (notification.current === next) setNotificationState('通知已点击'); };
      next.onerror = () => { if (notification.current === next) setNotificationState('系统未能展示'); };
      next.onclose = () => { if (notification.current === next) { setNotificationState('通知已关闭'); notification.current = undefined; } };
    } catch (cause) { setNotificationState('发送失败'); setError(cause); }
  };
  return <section className="nexus-desktop-controls">
    <h3>Desktop 更新</h3>
    <p className="nexus-muted">检查、下载、任务停止确认和重启由 Desktop 官方更新窗口处理。</p>
    {updates ? <><div className="nexus-actions"><Status value={phases[state?.phase ?? ''] ?? state?.phase ?? 'pending'} />{state?.version && <code data-nexus-verbatim="">{state.version}</code>}{typeof state?.percent === 'number' && Number.isFinite(state.percent) && <progress max={100} value={Math.min(100, Math.max(0, state.percent))} aria-label="Desktop 更新下载进度" />}<Button onClick={() => void open()} busy={busy}>打开官方更新流程</Button></div>{state?.failure && <p role="alert" data-nexus-verbatim="">{state.failure}</p>}</> : <p role="status" className="nexus-muted">此运行环境未公开 Desktop 更新服务。可在 Desktop 自身菜单中打开更新。</p>}
    <h3>系统通知</h3>
    {permission === 'unsupported' ? <p className="nexus-muted" role="status">当前运行环境不支持系统通知。</p> : <><p className="nexus-muted">通知权限：{permission}。系统展示、点击与关闭状态以浏览器事件为准。</p><div className="nexus-notification-compose"><label className="nexus-field"><span>通知标题</span><input value={notificationTitle} onChange={event => setNotificationTitle(event.target.value)} maxLength={160} /></label><label className="nexus-field"><span>通知正文</span><textarea value={notificationBody} onChange={event => setNotificationBody(event.target.value)} rows={2} maxLength={2000} /></label></div><div className="nexus-actions">{permission === 'default' && <Button onClick={() => void requestNotifications()}>请求系统通知权限</Button>}<Button disabled={permission !== 'granted' || !notificationTitle.trim()} onClick={sendNotification}>发送当前通知</Button><span role="status">{notificationState}</span></div>{permission === 'denied' && <p className="nexus-muted">通知已被系统或浏览器拒绝，可在对应权限设置中更改。</p>}</>}
    {Boolean(error) && <ErrorMessage error={error} />}
  </section>;
}
