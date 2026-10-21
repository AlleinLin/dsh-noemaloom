import { MissingWorkspace, levelLabels } from './scope-views.js';
import { FeaturePage } from './feature-page.js';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActionDraft, ClientContext, Data, DomainDefinition, Inspection, NexusApi, Notice, PageId, ViewContext, NexusScope } from './types.js';
import { rows, titleOf } from './types.js';
import { defaultPageForScope, isAuxiliaryPage, normalizeCatalog, pagesForScope } from './catalog.js';
import { ActionDialog, Button, DataView, DetailPane, ErrorMessage, Icon, IconButton, PageHeader, StateMessage, useQuery } from './components.js';
import { errorData } from './transport.js';
import styles from './theme.css';
import workbenchStyles from './workbench.css';
import { getLanguage, languageDiagnostics, setLanguage, subscribeLanguage } from './i18n.js';
import { ResourceMedia } from './ResourceMedia.js';
import { DesktopControls } from './DesktopControls.js';
import { AuxiliarySettings } from './AuxiliarySettings.js';
import { StepPauseSettings } from './StepPauseSettings.js';
import { boundedRead } from '../shared/bounded-read.js';
import { nativeWorkspace, navigateNative, openNativeSession as openHostSession, originalPageEntries, scopeNavigation } from './native-workspace.js';

export interface Preferences { skin: 'claude' | 'host'; theme: 'light' | 'dark' | 'system'; density: 'comfortable' | 'compact'; fontSize: number; reduceMotion: boolean; reading: boolean }
const defaultPreferences: Preferences = { skin: 'claude', theme: 'system', density: 'comfortable', fontSize: 14, reduceMotion: true, reading: true };
function getPreferences(): Preferences {
  try { return { ...defaultPreferences, ...JSON.parse(localStorage.getItem('dsh-nexus:ui-preferences:v1') ?? '{}') }; } catch { return defaultPreferences; }
}
const hostIsDark = () => document.body.hasAttribute('data-ds-dark-theme');
function subscribeHostTheme(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
  return () => observer.disconnect();
}
class PageBoundary extends React.Component<{ children: React.ReactNode; onError(error: Error): void; page: string }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { this.props.onError(error); }
  componentDidUpdate(previous: { page: string }) { if (previous.page !== this.props.page && this.state.error) this.setState({ error: undefined }); }
  render() { return this.state.error ? <div className="nexus-page"><ErrorMessage error={this.state.error} retry={() => this.setState({ error: undefined })} /></div> : this.props.children; }
}
/** One native main-panel contribution. Navigation and main chat belong to DSH. */
export function NexusApp({ api, ctx, initialPage, fixedPage, level = 'workspace', boundSessionId, openView, embedded = false }: { api: NexusApi; ctx: ClientContext; initialPage?: PageId; fixedPage?: PageId; level?: 'global' | 'workspace' | 'session'; boundSessionId?: string; openView?: (id: string) => void; embedded?: boolean }) {
  const request = React.useSyncExternalStore(scopeNavigation.subscribe, () => scopeNavigation.read(level), () => undefined);
  const [requestedPage, setPage] = useState<PageId>(request?.page ?? initialPage ?? defaultPageForScope(level));
  const page = fixedPage ?? (isAuxiliaryPage(requestedPage, level) ? requestedPage : defaultPageForScope(level));
  const [workspaceChoice, setWorkspaceChoice] = useState(request?.workspaceId ?? '');
  useEffect(() => { if (request) { setPage(request.page); if (request.workspaceId) setWorkspaceChoice(request.workspaceId); } }, [request]);
  const selectionSource = useMemo(() => nativeWorkspace(ctx).selection, [ctx]);
  const subscribeSelection = useCallback((listener: () => void) => selectionSource.subscribe(listener), [selectionSource]);
  const readSelection = useCallback(() => selectionSource.getSnapshot(), [selectionSource]);
  const selection = React.useSyncExternalStore(subscribeSelection, readSelection, readSelection);
  const sessionId = level === 'session' ? boundSessionId : undefined;
  const workspaces = useQuery(api, 'scope', 'workspaces', {}, { scope: { level: 'global' } });
  const workspaceRows = rows(workspaces.data);
  const selectedWorkspace = workspaceChoice || workspaceRows.find(w => w.sessionIds?.includes(selection.sessionId))?.id;
  const workspaceId = level === 'global' ? undefined : level === 'session' ? workspaceRows.find(w => w.sessionIds?.includes(sessionId))?.id : selectedWorkspace;
  const scope: NexusScope = useMemo(() => level === 'global' ? { level } : level === 'session' ? { level, sessionId, workspaceId } : { level, workspaceId }, [level, sessionId, workspaceId]);
  const scopeIdentity = JSON.stringify(scope);
  const dark = React.useSyncExternalStore(subscribeHostTheme, hostIsDark, () => false);
  const [preferences, setPreferences] = useState<Preferences>(getPreferences);
  const [probe, setProbe] = useState<Data>({});
  const [catalog, setCatalog] = useState<DomainDefinition[]>([]);
  const [snapshot, setSnapshot] = useState<Data>({});
  const [startupError, setStartupError] = useState<unknown>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [inspection, setInspection] = useState<Inspection>();
  const [pinned, setPinned] = useState(false);
  const [actionDraft, setActionDraft] = useState<ActionDraft>();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [themeConfig, setThemeConfig] = useState<Data>({});
  const actionSequence = useRef(0);
  const generation = React.useSyncExternalStore(api.subscribe, api.getGeneration, api.getGeneration);
  const notify = useCallback((title: string, kind: Notice['kind'] = 'success', message?: string, details?: unknown) => {
    setNotices(old => [{ id: `${Date.now()}-${++actionSequence.current}`, title, kind, message, details, at: new Date().toISOString() }, ...old].slice(0, 100));
  }, []);
  const navigate = useCallback((next: PageId) => {
    try {
      if (['home', 'sessions', 'settings'].includes(next) || originalPageEntries[next] || fixedPage && level === 'session') navigateNative(ctx, next, openView);
      else if (isAuxiliaryPage(next, level)) setPage(next);
      else notify('此功能不属于当前范围', 'info');
    } catch (error) { notify('无法打开宿主页面', 'error', errorData(error).message); }
  }, [ctx, fixedPage, level, notify, openView]);
  const openNativeSession = useCallback((id: string) => {
    try { openHostSession(ctx, id); } catch (error) { notify('无法打开宿主原生会话', 'error', errorData(error).message); }
  }, [ctx, notify]);
  const inspect = useCallback((item: Inspection) => {
    if (pinned && inspection) { notify('当前详情已固定', 'info', '请取消固定后查看新的选择。'); return; }
    setInspection(item);
  }, [pinned, inspection, notify]);
  const context: ViewContext = { api, host: ctx, catalog, probe, scope, inspect, action: setActionDraft, notify, navigate, openNativeSession, refreshToken, reading: preferences.reading };
  useEffect(() => { setInspection(undefined); setActionDraft(undefined); setPinned(false); }, [scopeIdentity, page]);
  useEffect(() => { try { localStorage.setItem('dsh-nexus:ui-preferences:v1', JSON.stringify(preferences)); window.dispatchEvent(new Event('nexus:appearance')); } catch {} }, [preferences]);
  useEffect(() => {
    const controller = new AbortController();
    setStartupError(undefined);
    Promise.allSettled([api.probe(controller.signal), api.snapshot(controller.signal)]).then(results => {
      if (controller.signal.aborted) return;
      if (results[0].status === 'fulfilled') setProbe(results[0].value ?? {});
      if (results[1].status === 'fulfilled') { setSnapshot(results[1].value ?? {}); setCatalog(normalizeCatalog(results[1].value ?? {})); }
      const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult | undefined;
      if (failed) setStartupError(failed.reason);
    });
    return () => controller.abort();
  }, [api, refreshToken, generation]);
  useEffect(() => {
    if (!catalog.some(domain => domain.id === 'resources' && domain.capabilities.some(item => item.action === 'themes.config'))) return;
    const controller = new AbortController();
    api.call('resources', 'themes.config', {}, { signal: controller.signal }).then(config => {
      if (controller.signal.aborted) return;
      setThemeConfig(config);
      setPreferences(old => ({ ...old, theme: 'system', density: config.density ?? old.density, fontSize: config.fontSize ?? old.fontSize, reduceMotion: config.reduceMotion ?? old.reduceMotion, reading: config.readingMode ?? old.reading }));
    }).catch(error => { if (!controller.signal.aborted) notify('外观配置读取失败', 'error', errorData(error).message); });
    return () => controller.abort();
  }, [api, catalog, refreshToken, notify]);
  const pages = () => {
    if (level === 'workspace' && !workspaceId) return <><QueryScopeError query={workspaces} /><MissingWorkspace /></>;
    if (level === 'session' && !sessionId) return <div className="nexus-page"><StateMessage icon="chat" title="打开一个会话" /></div>;
    if (page === 'home' || page === 'sessions') return <div className="nexus-page"><Button onClick={() => navigate(page)}>打开 DSH 会话</Button></div>;
    if (page !== 'settings') return <FeaturePage context={context} page={page} />;
    return <SettingsView context={context} preferences={preferences} setPreferences={setPreferences} snapshot={snapshot} notify={notify} themeConfig={themeConfig} setThemeConfig={setThemeConfig} />;
  };
  const availablePages = pagesForScope(level);
  const title = page === 'settings' ? 'Nexus 设置' : availablePages.find(item => item.id === page)?.title ?? 'Nexus';
  return <div className={`nexus-root nexus-native-panel ${embedded ? 'nexus-conversation-panel' : ''} nexus-shell nexus-theme-${dark ? 'dark' : 'light'} nexus-density-${preferences.density} ${inspection ? 'nexus-has-inspector' : ''} ${preferences.reduceMotion ? 'nexus-reduce-motion' : ''}`} data-dsh-nexus-view="" data-dsh-plugin="nexus" data-session-id={sessionId} data-scope-level={level} data-workspace-id={workspaceId} data-page={page} data-global-view={level === 'global' ? 'feature' : undefined} style={{ ...(themeConfig.tokens ?? {}), '--nexus-base-font': `${preferences.fontSize}px` } as React.CSSProperties}>
    <style>{styles}{workbenchStyles}</style>{themeConfig.css && <style>{themeConfig.css}</style>}
    <div className="nexus-center">
      {page !== 'settings' && !fixedPage && <header className="nexus-scope-header"><div className="nexus-scope-heading"><span className="nexus-scope-badge">{levelLabels[level]}</span><strong>{title}</strong>
        {level === 'workspace' && <select aria-label="原生工作区" value={workspaceId ?? ''} onChange={e => setWorkspaceChoice(e.target.value)}><option value="">选择工作区…</option>{workspaceRows.map(w => <option key={w.id} value={w.id}>{w.title}</option>)}</select>}
        {level === 'session' && <small>当前对话</small>}
        <div className="nexus-topbar-actions"><IconButton name="refresh" label="刷新页面数据" onClick={() => { setRefreshToken(value => value + 1); workspaces.reload(); }} /><IconButton name="info" label="页面通知" onClick={() => setNotificationOpen(value => !value)} /></div>
      </div><nav className="nexus-feature-nav" aria-label={`${levelLabels[level]}功能`}>{availablePages.map(item => <button key={item.id} aria-current={item.id === page ? 'page' : undefined} onClick={() => setPage(item.id)}><Icon name={item.icon} size={15} />{item.title}</button>)}</nav>
      </header>}
      {Boolean(startupError) && <div className="nexus-startup-error"><ErrorMessage error={startupError} retry={() => setRefreshToken(value => value + 1)} /></div>}
      {fixedPage && notices[0] && <div className="nexus-native-feedback" role={notices[0].kind === 'error' ? 'alert' : 'status'}><span>{notices[0].title}{notices[0].message && ` · ${notices[0].message}`}</span><IconButton name="close" label="关闭通知" onClick={() => setNotices(old => old.slice(1))} /></div>}
      <main tabIndex={-1} className="nexus-main"><PageBoundary page={`${page}:${scopeIdentity}`} onError={error => notify('页面发生异常', 'error', error.message)}><React.Fragment key={`${scopeIdentity}:${page}`}>{pages()}</React.Fragment></PageBoundary></main>
      <ResourceMedia context={context} config={{ ...themeConfig, reduceMotion: preferences.reduceMotion }} />
    </div>
    {inspection && <DetailPane item={inspection} context={context} close={() => setInspection(undefined)} pinned={pinned} togglePin={() => setPinned(value => !value)} />}
    {actionDraft && <ActionDialog key={`${scopeIdentity}:${actionDraft.domain}/${actionDraft.action}/${actionDraft.id ?? ''}`} draft={actionDraft} catalog={catalog} api={api} scope={scope} onNext={setActionDraft} onClose={() => setActionDraft(undefined)} onDone={() => { notify('宿主已返回执行回执'); setRefreshToken(token => token + 1); }} />}
    {notificationOpen && <section className="nexus-native-notices" aria-label="页面通知"><Button onClick={() => setNotificationOpen(false)}>关闭</Button>{notices.length ? notices.map(item => <div key={item.id} role={item.kind === 'error' ? 'alert' : 'status'}><strong>{item.title}</strong><p>{item.message}</p></div>) : <span>暂无通知</span>}</section>}
  </div>;
}

function QueryScopeError({ query }: { query: ReturnType<typeof useQuery> }) { return query.error ? <ErrorMessage error={query.error} retry={query.reload} /> : null; }

function StorageIntegrityControls({ api }: { api: NexusApi }) {
  const [busy, setBusy] = useState(false), [cancelling, setCancelling] = useState(false);
  const [result, setResult] = useState<Data>(), [error, setError] = useState<unknown>();
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => { controller.abort(); lifetime.current = undefined; };
  }, [api]);
  const run = async (cancel = false) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || (cancel ? cancelling : busy)) return;
    cancel ? setCancelling(true) : setBusy(true); setError(undefined);
    try {
      const value = await boundedRead(waitSignal => api.call('scope', cancel ? 'storage.integrity.cancel' : 'storage.integrity', {}, {
        scope: { level: 'global' }, signal: waitSignal,
      }), { signal, timeoutMs: 15000,
        timeout: () => new Error('等待检查结果超过15秒。检查可能仍在进行；再次读取会复用当前检查，也可手动取消。'),
        cancelled: () => new Error('已停止等待完整性检查结果'),
      });
      if (!signal.aborted) setResult(value);
    } catch (cause) { if (!signal.aborted) setError(cause); }
    finally { if (!signal.aborted) cancel ? setCancelling(false) : setBusy(false); }
  };
  return <section className="nexus-storage-integrity" data-nexus-storage-integrity="" aria-label="手动数据库完整性检查">
    <p>普通状态读取不扫描数据库。完整检查由独立只读线程执行，可能耗时较长；结果表示检查时的 SQLite 结构状态。记录正文校验仍在逐条读取时执行。</p>
    <div className="nexus-actions"><Button aria-label="手动数据库完整性检查" busy={busy} onClick={() => void run()}>手动完整性检查 / 读取进行中的结果</Button>
      <Button aria-label="取消手动数据库完整性检查" busy={cancelling} onClick={() => void run(true)}>取消手动检查</Button></div>
    {busy && <p role="status">正在等待手动检查结果…</p>}
    {Boolean(error) && <ErrorMessage error={error} />}
    {result && <DataView value={result} />}
  </section>;
}

function SettingsView({ context, preferences, setPreferences, snapshot, notify, themeConfig, setThemeConfig }: { context: ViewContext; preferences: Preferences; setPreferences(value: Preferences | ((previous: Preferences) => Preferences)): void; snapshot: Data; notify: ViewContext['notify']; themeConfig: Data; setThemeConfig(value: Data): void }) {
  const [section, setSection] = useState('appearance');
  const [draft, setDraft] = useState(preferences);
  const [appearanceDraft, setAppearanceDraft] = useState(themeConfig);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>();
  const language = React.useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
  const resources = useQuery(context.api, 'resources', 'list', {}, { enabled: section === 'appearance', scope: context.scope, refresh: context.refreshToken });
  const installedResources = rows(resources.data);
  useEffect(() => { if (!dirty) { setDraft(preferences); setAppearanceDraft(themeConfig); } }, [preferences, themeConfig, dirty]);
  const saveAppearance = async () => {
    setSaving(true); setSaveError(undefined);
    try {
      const value = await context.api.call('resources', 'themes.apply', { config: { ...appearanceDraft, mode: 'host', density: draft.density, fontSize: draft.fontSize, reduceMotion: draft.reduceMotion, readingMode: draft.reading }, expectedRevision: themeConfig.revision ?? 0 }, { scope: { level: 'global' }, mutating: true, revision: themeConfig.revision ?? 0 });
      setThemeConfig(value?.config ?? value); setPreferences(draft); setDirty(false); notify('外观偏好已由宿主保存');
    } catch (cause) { setSaveError(cause); }
    finally { setSaving(false); }
  };
  const groups = [{ id: 'appearance', label: '外观与阅读' }, { id: 'auxiliary', label: '意图识别与旁路审阅' }, { id: 'step-progress', label: '步骤进度' }, { id: 'diagnostics', label: '诊断与来源' }];
  if (section === 'auxiliary') return <div className="nexus-page nexus-settings-page"><PageHeader title="设置" /><div className="nexus-settings-layout"><nav className="nexus-settings-nav" aria-label="设置分类">{groups.map(group => <button key={group.id} aria-current={section === group.id ? 'page' : undefined} onClick={() => setSection(group.id)}>{group.label}</button>)}</nav><section className="nexus-settings-content"><h2>意图识别与旁路审阅</h2><AuxiliarySettings api={context.api} /></section></div></div>;
  const update = (value: Partial<Preferences>) => { setDraft(old => ({ ...old, ...value })); setDirty(true); };
  const updateAppearance = (value: Data) => { setAppearanceDraft(old => ({ ...old, ...value })); setDirty(true); };
  const mediaPaths = (item?: Data) => Object.keys(item?.fileHashes ?? {}).filter(path => /\.(png|jpe?g|webp|gif|avif|mp4|webm)$/i.test(path));
  const backgroundResource = installedResources.find(item => item.id === appearanceDraft.backgroundAsset?.id);
  const appearanceResources = <>
    <div className="nexus-setting-row"><div><strong>已安装皮肤</strong></div><select aria-label="已安装皮肤" value={appearanceDraft.themeId ?? ''} onChange={event => updateAppearance({ themeId: event.target.value || null })}><option value="">Claude 默认</option>{installedResources.filter(item => item.kind === 'skin').map(item => <option key={item.id} value={item.id} data-nexus-verbatim="">{titleOf(item)}</option>)}</select></div>
    <div className="nexus-setting-row"><div><strong>宠物</strong></div><div className="nexus-setting-controls"><select aria-label="选择宠物" value={appearanceDraft.petId ?? ''} onChange={event => updateAppearance({ petId: event.target.value || null, petEnabled: event.target.value ? appearanceDraft.petEnabled : false })}><option value="">选择宠物…</option>{installedResources.filter(item => item.kind === 'pet').map(item => <option key={item.id} value={item.id} data-nexus-verbatim="">{titleOf(item)}</option>)}</select><label><input type="checkbox" checked={appearanceDraft.petEnabled === true} disabled={!appearanceDraft.petId} onChange={event => updateAppearance({ petEnabled: event.target.checked })} />启用</label></div></div>
    <div className="nexus-setting-row"><div><strong>装饰背景</strong></div><div className="nexus-setting-controls"><select aria-label="背景资源" value={appearanceDraft.backgroundAsset?.id ?? ''} onChange={event => { const item = installedResources.find(resource => resource.id === event.target.value); updateAppearance({ backgroundAsset: item ? { id: item.id, path: mediaPaths(item)[0] } : null, backgroundEnabled: item ? appearanceDraft.backgroundEnabled : false }); }}><option value="">选择背景资源…</option>{installedResources.filter(item => mediaPaths(item).length).map(item => <option key={item.id} value={item.id} data-nexus-verbatim="">{titleOf(item)}</option>)}</select>{backgroundResource && <select aria-label="背景文件" value={appearanceDraft.backgroundAsset?.path ?? ''} onChange={event => updateAppearance({ backgroundAsset: { id: backgroundResource.id, path: event.target.value } })}>{mediaPaths(backgroundResource).map(path => <option key={path} value={path} data-nexus-verbatim="">{path}</option>)}</select>}<label><input type="checkbox" checked={appearanceDraft.backgroundEnabled === true} disabled={!appearanceDraft.backgroundAsset} onChange={event => updateAppearance({ backgroundEnabled: event.target.checked })} />启用</label></div></div>
    <div className="nexus-actions"><Button onClick={() => context.action({ domain: 'resources', action: 'asset.import', params: { kind: 'background', path: '' } })}>导入本地媒体</Button><Button onClick={() => context.navigate('resources')}>管理外观资源</Button></div>
  </>;
  return <div className="nexus-page nexus-settings-page"><PageHeader title="设置" /><div className="nexus-settings-layout">
    <nav className="nexus-settings-nav" aria-label="设置分类">{groups.map(group => <button key={group.id} aria-current={section === group.id ? 'page' : undefined} onClick={() => setSection(group.id)}>{group.label}</button>)}</nav>
    <section className="nexus-settings-content"><h2>{groups.find(group => group.id === section)?.label}</h2>
      {section === 'step-progress' ? <StepPauseSettings api={context.api} /> : section === 'appearance' ? <>
        {Boolean(saveError) && <ErrorMessage error={saveError} />}
        <div className="nexus-setting-row"><div><strong>界面语言</strong></div><select aria-label="界面语言" value={language} onChange={event => { setLanguage(event.target.value); try { localStorage.setItem('dsh-nexus:language', event.target.value); } catch {} }}><option value="zh">简体中文</option><option value="en">English</option><option value="ru">Русский</option></select></div>
        <div className="nexus-setting-row"><div><strong>Claude 主题</strong></div><select aria-label="全局皮肤" value={draft.skin} onChange={e => update({ skin: e.target.value as Preferences['skin'] })}><option value="claude">Claude（默认）</option><option value="host">DSH 原生</option></select></div>
        <div className="nexus-theme-preview" aria-label="Claude 配色预览"><i /><i /><i /></div>
        <div className="nexus-setting-row"><div><strong>界面密度</strong></div><select aria-label="界面密度" value={draft.density} onChange={event => update({ density: event.target.value as Preferences['density'] })}><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></div>
        <div className="nexus-setting-row"><div><strong>正文字号</strong></div><select aria-label="正文字号" value={draft.fontSize} onChange={event => update({ fontSize: Number(event.target.value) })}>{[13, 14, 15, 16, 18].map(value => <option value={value} key={value}>{value}px</option>)}</select></div>
        <div className="nexus-setting-row"><div><strong>减少动效</strong></div><input type="checkbox" aria-label="减少动效" checked={draft.reduceMotion} onChange={event => update({ reduceMotion: event.target.checked })} /></div>
        <div className="nexus-setting-row"><div><strong>会话阅读视图</strong></div><input type="checkbox" aria-label="会话阅读视图" checked={draft.reading} onChange={event => update({ reading: event.target.checked })} /></div>
        {appearanceResources}
        <div className="nexus-settings-save"><span>{dirty ? '有未保存的外观草稿' : '已保存'}</span><Button onClick={() => { setDraft(defaultPreferences); setAppearanceDraft({ ...themeConfig, themeId: null, tokens: {}, petEnabled: false, petId: null, backgroundEnabled: false, backgroundAsset: null }); setDirty(true); }}>恢复外观默认</Button><Button primary busy={saving} disabled={!dirty} onClick={() => void saveAppearance()}>保存外观</Button></div>
      </> : <>
        <DesktopControls />
        <StorageIntegrityControls api={context.api} />
        <DataView value={context.probe} />
        <details className="nexus-details"><summary>语言与命名空间</summary><DataView value={languageDiagnostics()} /></details>
        <details className="nexus-details"><summary>Host / Client 版本与能力快照</summary><DataView value={snapshot} /></details>
        <Button onClick={() => context.inspect({ title: '脱敏诊断导出预览', kind: '诊断', data: { probe: context.probe, catalog: context.catalog.map(item => ({ id: item.id, actionCount: item.capabilities.length })) } })}>预览诊断导出</Button>
      </>}
    </section>
  </div></div>;
}
