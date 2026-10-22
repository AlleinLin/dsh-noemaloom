import * as React from 'react';
import * as monaco from 'monaco-editor';
import { retainModel, releaseModel, saveModel, discardModel, adoptDiskBase, disposeModels, type EditorRecord } from './models.js';
import type { NexusApi } from '../types.js';
import { DebugPanel } from './DebugPanel.js';
import { EDITOR_THEME, watchEditorTheme } from './theme.js';
import './editor.css';

interface Props {
  api: NexusApi; sessionId: string; resourceAddress: string; useTabInfo(): any;
  content: { revision: number; loaded(version?: string): void; failed(): void };
}
function fileOf(address: string) {
  const prefix = 'dsh-resource://file/session/';
  if (!address.startsWith(prefix)) throw new Error('此编辑器需要会话工作区文件');
  const [session, ...parts] = address.slice(prefix.length).split(/[?#]/, 1)[0].split('/');
  if (!session || !parts.length) throw new Error('文件地址无效');
  const line = Number(new URL(address).searchParams.get('line'));
  return { sessionId: decodeURIComponent(session), path: parts.map(decodeURIComponent).join('/'), line: Number.isInteger(line) && line > 0 && line <= 1000000 ? line : undefined };
}
const samePath = (a: string, b: string) => a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase();
const mountedEditors = new Set<() => void>();
export async function disposeEditorRuntime() {
  for (const dispose of [...mountedEditors]) dispose();
  await disposeModels();
}
export function Editor(props: Props) {
  const { tab } = props.useTabInfo();
  const file = React.useMemo(() => fileOf(props.resourceAddress), [props.resourceAddress]);
  const scope = React.useMemo(() => ({ level: 'session' as const, sessionId: file.sessionId }), [file.sessionId]);
  const [record, setRecord] = React.useState<EditorRecord>();
  const [error, setError] = React.useState('');
  const [, refresh] = React.useState(0);
  const [diff, setDiff] = React.useState(false);
  const [diffBase, setDiffBase] = React.useState<string>();
  const [debug, setDebug] = React.useState(false);
  const [points, setPoints] = React.useState<any[]>([]);
  const [verified, setVerified] = React.useState<any[]>([]);
  const [stopped, setStopped] = React.useState<{ path: string; line: number }>();
  const mount = React.useRef<HTMLDivElement>(null);
  const editor = React.useRef<monaco.editor.IStandaloneCodeEditor | monaco.editor.IStandaloneDiffEditor>(null);
  const normal = () => editor.current && 'getModifiedEditor' in editor.current ? editor.current.getModifiedEditor() : editor.current as monaco.editor.IStandaloneCodeEditor | null;
  const pointRef = React.useRef(points); pointRef.current = points;
  const recordRef = React.useRef(record); recordRef.current = record;
  React.useEffect(() => {
    let active = true, retained: EditorRecord | undefined;
    setRecord(undefined); setError('');
    void retainModel(monaco, props.api, scope, file.path).then(value => {
      retained = value;
      if (!active) { releaseModel(value, tab.id, null); return; }
      setRecord(value); props.content.loaded();
    }, error => { if (active) { setError(error.message); props.content.failed(); } });
    return () => {
      active = false;
      if (retained) releaseModel(retained, tab.id, normal()?.saveViewState() ?? null);
    };
  }, [props.api, scope, file.path, tab.id, props.content.revision]);
  React.useEffect(() => {
    if (!record) return;
    const update = () => refresh(value => value + 1); record.listeners.add(update);
    return () => { record.listeners.delete(update); };
  }, [record]);
  React.useEffect(() => {
    if (!record || !mount.current) return;
    const releaseTheme = watchEditorTheme(monaco.editor, mount.current.ownerDocument);
    const options: monaco.editor.IStandaloneEditorConstructionOptions = {
      theme: EDITOR_THEME,
      automaticLayout: true, fontFamily: '"Cascadia Code", Consolas, "SFMono-Regular", monospace', fontSize: 13,
      minimap: { enabled: false }, glyphMargin: true, scrollBeyondLastLine: false, fixedOverflowWidgets: true,
      wordWrap: 'off', tabSize: 2, readOnly: new TextEncoder().encode(record.model.getValue()).length > 512 * 1024,
      renderWhitespace: 'selection', smoothScrolling: false, accessibilitySupport: 'auto', ariaLabel: `文件编辑器 ${file.path}`,
    };
    const base = diff ? monaco.editor.createModel(diffBase ?? record.base, record.model.getLanguageId()) : undefined;
    const instance = diff ? monaco.editor.createDiffEditor(mount.current, { ...options, renderSideBySide: true, originalEditable: false })
      : monaco.editor.create(mount.current, { ...options, model: record.model });
    editor.current = instance;
    if (diff) (instance as monaco.editor.IStandaloneDiffEditor).setModel({ original: base!, modified: record.model });
    const code = normal()!;
    const view = record.views.get(tab.id); if (view) code.restoreViewState(view);
    if (file.line) { code.setPosition({ lineNumber: file.line, column: 1 }); code.revealLineInCenter(file.line); }
    code.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void save(); });
    const toggle = code.onMouseDown(event => {
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !event.target.position) return;
      const line = event.target.position.lineNumber;
      const next = pointRef.current.some(point => point.line === line) ? pointRef.current.filter(point => point.line !== line) : [...pointRef.current, { line }].sort((a, b) => a.line - b.line);
      void changeBreakpoints(next);
    });
    let active = true;
    const dispose = () => {
      if (!active) return; active = false; mountedEditors.delete(dispose);
      const state = code.saveViewState(); if (state) record.views.set(tab.id, state);
      releaseTheme(); toggle.dispose(); instance.dispose(); base?.dispose(); editor.current = null;
    };
    mountedEditors.add(dispose);
    return dispose;
  }, [record, diff, diffBase, file.line]);
  React.useEffect(() => {
    if (!record) return;
    let active = true;
    void props.api.call<any>('debug', 'breakpoints', {}, { scope }).then(result => {
      if (active) setPoints(result.items.find((item: any) => samePath(item.path, record.path))?.breakpoints ?? []);
    }, error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [record]);
  React.useEffect(() => {
    const code = normal(); if (!record || !code) return;
    const decorations = code.createDecorationsCollection([
      ...points.map(point => {
        const actual = verified.find(item => item.line === point.line);
        return { range: new monaco.Range(point.line, 1, point.line, 1), options: {
          isWholeLine: true, glyphMarginClassName: actual?.verified ? 'nexus-breakpoint-verified' : 'nexus-breakpoint-pending',
          glyphMarginHoverMessage: { value: actual?.message ?? (actual?.verified ? '已验证断点' : '断点待验证') },
        } };
      }),
      ...(stopped && samePath(stopped.path, record.path) ? [{ range: new monaco.Range(stopped.line, 1, stopped.line, 1), options: { isWholeLine: true, className: 'nexus-stopped-line', glyphMarginClassName: 'nexus-stopped-arrow' } }] : []),
    ]);
    if (stopped && samePath(stopped.path, record.path)) code.revealLineInCenter(stopped.line);
    return () => decorations.clear();
  }, [record, diff, points, verified, stopped]);
  const save = async () => {
    if (!record) return;
    setError('');
    try { await saveModel(record); }
    catch (error) {
      setError(`${error instanceof Error ? error.message : '保存失败'}。草稿已保留；可对比磁盘版本后处理。`);
      record.recoveryConflict = true;
      try {
        const disk = await props.api.call<any>('files', 'read', { path: record.path, maxBytes: 8 * 1024 * 1024 }, { scope });
        if (!disk.binary && !disk.truncated) setDiffBase(disk.content);
      } catch {}
      setDiff(true);
    }
  };
  const diskDiff = async () => {
    if (!record) return;
    try {
      const disk = await props.api.call<any>('files', 'read', { path: record.path, maxBytes: 8 * 1024 * 1024 }, { scope });
      if (disk.binary || disk.truncated) throw new Error('无法读取完整磁盘版本');
      // Diff may compare with a newer disk version; the CAS base hash deliberately stays unchanged.
      setDiffBase(disk.content); setDiff(value => !value);
    } catch (error) { setError((error as Error).message); }
  };
  const changeBreakpoints = async (next: any[]) => {
    if (!record) return;
    try {
      const result = await props.api.call<any>('debug', 'breakpoints.set', { path: record.path, breakpoints: next }, { scope, mutating: true });
      setPoints(next); setVerified(result.breakpoints ?? []);
    } catch (error) { setError((error as Error).message); }
  };
  const openSource = (path: string, line: number) => {
    setStopped({ path, line });
    if (!record || samePath(path, record.path)) return;
    const address = `dsh-resource://file/session/${encodeURIComponent(file.sessionId)}/${path.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/')}?line=${line}`;
    tab.actions.openResource(address);
  };
  return <section className="nexus-editor" data-nexus-editor="" aria-label="原生文件编辑器">
    <div className="nexus-editor-toolbar">
      <button onClick={save} disabled={!record?.dirty} title="Ctrl/Cmd+S">保存{record?.dirty ? ' •' : ''}</button>
      <button onClick={() => normal()?.getAction('actions.find')?.run()}>查找</button>
      <button onClick={() => normal()?.getAction('editor.action.startFindReplaceAction')?.run()}>替换</button>
      <button onClick={diskDiff} aria-pressed={diff}>对比</button>
      <button onClick={() => setDebug(value => !value)} aria-expanded={debug}>调试</button>
      <button onClick={async () => { try { const value = await props.api.call<any>('debug', 'vscode', { path: file.path }, { scope }); window.location.href = value.url; } catch (error) { setError((error as Error).message); } }}>在 VS Code 中打开</button>
      <span className="nexus-editor-save-state" role="status">{record?.dirty ? record.durable ? '草稿已保存，可恢复' : '正在保存草稿…' : record ? '已保存' : '读取中…'}</span>
    </div>
    {(error || record?.error || record?.recoveryConflict) && <div className="nexus-editor-notice" role="alert">
      {error || record?.error || '已恢复草稿，基础版本或恢复副本有变化；请对比后保存。'}
      {record?.dirty && <button onClick={async () => { if (window.confirm('丢弃此文件的恢复草稿并重新载入磁盘版本？')) { try { await discardModel(record); setError(''); setDiff(false); } catch (error) { setError((error as Error).message); } } }}>丢弃草稿并重载</button>}
      {record?.dirty && diff && <button onClick={async () => { try { await adoptDiskBase(record); setError('已采用当前磁盘快照；确认右侧内容后保存。'); } catch (error) { setError((error as Error).message); } }}>已审阅差异，保留草稿以合并保存</button>}
    </div>}
    {record && new TextEncoder().encode(record.model.getValue()).length > 512 * 1024 && <div className="nexus-editor-notice">大于512 KiB的文件在此只读，可在本地 VS Code 编辑。</div>}
    <div className="nexus-editor-code" ref={mount} />
    {debug && <DebugPanel api={props.api} scope={scope} path={record?.path ?? file.path} dirty={Boolean(record?.dirty)}
      onBreakpoints={(path, values) => { if (record && samePath(path, record.path)) setVerified(previous => [...previous.filter(point => !values.some(value => value.id !== undefined && value.id === point.id || value.line === point.line)), ...values]); }}
      onStopped={openSource} onRunning={() => setStopped(undefined)} />}
  </section>;
}
