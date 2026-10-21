import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TaskNode, TaskPlan } from '../domain/workflow/types.js';
import type { Data, NexusApi, NexusScope } from './types.js';
import { rows, titleOf, unwrap } from './types.js';
import { Button, DataView, ErrorMessage, Icon, IconButton, StateMessage, Status, useQuery } from './components.js';
import {
  canonicalWorkflowScope, isWorkflowDraft, newWorkflowDraft, receivesWorkflowData, removeWorkflowEdge, removeWorkflowNode,
  updateWorkflowEdge, workflowConnectionError, workflowDeleteShortcut, workflowEdgeId,
  workflowDraftFromPlan, workflowDraftKey, workflowModelOptions, workflowNodeKinds, workflowPlanPayload,
  type WorkflowDraft, type WorkflowEdge, type WorkflowPosition,
} from './workflow-editor-model.js';
import baseCss from './theme.css';
import css from './WorkflowEditor.css';

interface SavedPlan { id: string; hash: string; signature: string; runKey: string }
interface EditorSnapshot { draft: WorkflowDraft; saved?: SavedPlan; runId?: string }
interface Props { api: NexusApi; scope: NexusScope; active?: boolean }
const terminalStates = new Set(['succeeded', 'failed', 'cancelled', 'timedOut', 'blocked']);
const newRunKey = () => `editor-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const scopeLabels = { global: '全局模板', workspace: '工作区工作流', session: '会话工作流' };

function readDraft(key: string): EditorSnapshot {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 2 * 1024 * 1024) return { draft: newWorkflowDraft() };
    const value = JSON.parse(raw) as EditorSnapshot;
    if (!isWorkflowDraft(value.draft)) return { draft: newWorkflowDraft() };
    const saved = value.saved && ['id', 'hash', 'signature', 'runKey'].every(field => typeof value.saved?.[field as keyof SavedPlan] === 'string')
      ? value.saved : undefined;
    return { draft: value.draft, saved, runId: typeof value.runId === 'string' ? value.runId : undefined };
  } catch { return { draft: newWorkflowDraft() }; }
}
function writeDraft(key: string, value: EditorSnapshot) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* The host-saved plan remains authoritative. */ }
}

/** Native conversation view and the same editor under each scoped tools entry. */
export function WorkflowEditor(props: Props) {
  let scope: NexusScope;
  try { scope = canonicalWorkflowScope(props.scope); }
  catch (error) { return <StateMessage icon="branch" title={error instanceof Error ? error.message : '请选择作用范围'} />; }
  return <WorkflowEditorScope key={workflowDraftKey(scope)} {...props} scope={scope} />;
}

function WorkflowEditorScope({ api, scope, active = true }: Props) {
  const key = workflowDraftKey(scope);
  const [initial] = useState(() => readDraft(key));
  const [draft, setDraft] = useState<WorkflowDraft>(initial.draft);
  const [saved, setSaved] = useState<SavedPlan | undefined>(initial.saved);
  const [runId, setRunId] = useState(initial.runId ?? '');
  const [runRecord, setRunRecord] = useState<Data>();
  const [selected, setSelected] = useState(initial.draft.nodes[0]?.id ?? '');
  const [selectedPlan, setSelectedPlan] = useState('');
  const [addKind, setAddKind] = useState<TaskNode['kind']>('agent');
  const [edgeKind, setEdgeKind] = useState<WorkflowEdge['kind']>('data');
  const [connecting, setConnecting] = useState<string>();
  const [wirePoint, setWirePoint] = useState<WorkflowPosition>();
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState('');
  const [poll, setPoll] = useState(0);
  const [artifact, setArtifact] = useState<Data>();
  const [evidence, setEvidence] = useState('');
  const [showEvents, setShowEvents] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const drag = useRef<{ id: string; startX: number; startY: number; origin: WorkflowPosition } | undefined>(undefined);
  const connectingRef = useRef<string | undefined>(undefined);
  const board = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  const inspector = useRef<HTMLElement>(null);
  const inspectionRevision = useRef(0);
  const latestSnapshot = useRef<EditorSnapshot>({ draft, saved, runId });
  const markerId = React.useId().replace(/:/g, '');
  latestSnapshot.current = { draft, saved, runId };
  const signature = JSON.stringify(draft);
  const dirty = saved?.signature !== signature;
  const run = runRecord ? unwrap(runRecord) : undefined;
  const executing = Boolean(runId && (!run || !run.finishedAt && !terminalStates.has(run.state)));
  const editLocked = executing || Boolean(busy);
  const displayedRun = !dirty && run?.planId === saved?.id && run?.planHash === saved?.hash ? run : undefined;
  const modelQuery = useQuery(api, 'workflow', 'models/list', {}, { scope, enabled: active });
  const planQuery = useQuery(api, 'workflow', 'plans/list', { limit: 100 }, { scope, enabled: active });
  const modelOptions = useMemo(() => workflowModelOptions(modelQuery.data ?? {}), [modelQuery.data]);
  const node = draft.nodes.find(item => item.id === selected);
  const edge = draft.edges.find(item => workflowEdgeId(item) === selectedEdge);
  const nodeState = displayedRun?.nodeRuns?.[selected];
  const width = Math.max(1200, ...Object.values(draft.layout).map(point => point.x + 330));
  const height = Math.max(700, ...Object.values(draft.layout).map(point => point.y + 260));
  const scopeLevel = scope.level ?? 'session';

  useEffect(() => {
    const listener = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => writeDraft(key, latestSnapshot.current), 400);
    return () => window.clearTimeout(timer);
  }, [key, draft, saved, runId]);
  useEffect(() => () => writeDraft(key, latestSnapshot.current), [key]);
  useEffect(() => { inspectionRevision.current++; setArtifact(undefined); setEvidence(''); }, [selected, selectedEdge, runId, signature]);
  useEffect(() => {
    if (!runId || !active || !pageVisible) return;
    const controller = new AbortController();
    const update = async () => {
      let afterRevision = 0;
      while (!controller.signal.aborted) {
        const record = await api.call<Data>('workflow', 'wait', { runId, afterRevision, timeoutMs: 15000 }, { scope, signal: controller.signal });
        if (controller.signal.aborted) return;
        setRunRecord(record);
        afterRevision = Number(record.revision ?? 0);
        const value = unwrap(record);
        if (value.finishedAt || terminalStates.has(value.state)) return;
      }
    };
    void update().catch(cause => { if (!controller.signal.aborted) setError(cause); });
    return () => controller.abort();
  }, [api, key, runId, active, pageVisible, poll]);

  const change = (update: (current: WorkflowDraft) => WorkflowDraft) => {
    if (editLocked) return;
    setDraft(update); setMessage(''); setError(undefined);
  };
  const clearInspection = () => { inspectionRevision.current++; setArtifact(undefined); setEvidence(''); };
  const cancelConnection = () => { connectingRef.current = undefined; setConnecting(undefined); setWirePoint(undefined); };
  const selectNode = (id: string) => { clearInspection(); setSelected(id); setSelectedEdge(undefined); };
  const selectEdge = (id: string) => { clearInspection(); setSelected(''); setSelectedEdge(id); };
  const focusInspector = () => {
    window.requestAnimationFrame(() => {
      const panel = inspector.current;
      if (!panel) return;
      panel.scrollTop = 0;
      panel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      (panel.querySelector<HTMLElement>('input:not(:disabled),select:not(:disabled),textarea:not(:disabled)') ?? panel).focus({ preventScroll: true });
    });
  };
  const editNode = (id: string) => { selectNode(id); focusInspector(); };
  const updateNode = (patch: Partial<TaskNode>) => change(current => ({
    ...current, nodes: current.nodes.map(item => item.id === selected ? { ...item, ...patch } : item),
  }));
  const operation = async (name: string, task: () => Promise<void>) => {
    if (busy) return;
    setBusy(name); setError(undefined); setMessage('');
    try { await task(); } catch (cause) { setError(cause); }
    finally { setBusy(''); }
  };
  const addNode = () => {
    if (editLocked) return;
    if (draft.nodes.length >= 64) { setError(new Error('最多添加 64 个节点')); return; }
    let sequence = draft.nodes.length + 1;
    while (draft.nodes.some(item => item.id === `node-${sequence}`)) sequence++;
    const id = `node-${sequence}`, index = draft.nodes.length;
    const item: TaskNode = { id, kind: addKind, ...(addKind === 'agent' ? { role: 'implementer' } : {}),
      prompt: '', ...(receivesWorkflowData({ id, kind: addKind }) ? { outputContracts: { nonEmpty: true } } : {}) };
    change(current => ({ ...current, nodes: [...current.nodes, item], layout: { ...current.layout, [id]: { x: 70 + index % 3 * 310, y: 80 + Math.floor(index / 3) * 240 } },
      requiredNodeIds: [...current.requiredNodeIds, id] }));
    cancelConnection(); editNode(id);
  };
  const removeNode = (id = selected) => {
    if (editLocked || !draft.nodes.some(item => item.id === id)) return;
    const index = draft.nodes.findIndex(item => item.id === id);
    const next = removeWorkflowNode(draft, id);
    change(() => next);
    drag.current = undefined; cancelConnection();
    selectNode(next.nodes[Math.min(index, next.nodes.length - 1)]?.id ?? '');
    setMessage(`已删除 ${id}，关联连线、引用和验证规则已清理；保存计划后生效`);
    editor.current?.focus({ preventScroll: true });
  };
  const removeEdge = () => {
    if (editLocked || !edge) return;
    change(current => removeWorkflowEdge(current, workflowEdgeId(edge)));
    cancelConnection(); selectNode(edge.to);
    setMessage('已删除连线；保存计划后生效');
    editor.current?.focus({ preventScroll: true });
  };
  const updateEdge = (patch: Pick<Partial<WorkflowEdge>, 'kind' | 'optional'>) => {
    if (editLocked || !selectedEdge) return;
    try { const next = updateWorkflowEdge(draft, selectedEdge, patch); change(() => next); }
    catch (cause) { setError(cause); }
  };
  const connect = (target: string) => {
    const source = connectingRef.current;
    if (!source || editLocked) return;
    const edge: WorkflowEdge = { from: source, to: target, kind: edgeKind };
    const reason = workflowConnectionError(draft, edge);
    if (reason) setError(new Error(reason));
    else { change(current => ({ ...current, edges: [...current.edges, edge] })); selectEdge(workflowEdgeId(edge)); }
    cancelConnection();
  };
  const loadPlan = () => void operation('load', async () => {
    const record = await api.call<Data>('workflow', 'plan/get', { planId: selectedPlan }, { scope });
    const value = unwrap(record) as TaskPlan;
    const next = workflowDraftFromPlan(value);
    if (!isWorkflowDraft(next)) throw new Error('保存的工作流包含无效节点或布局');
    drag.current = undefined; cancelConnection(); clearInspection();
    setDraft(next); selectNode(next.nodes[0]?.id ?? '');
    setSaved({ id: value.id, hash: value.hash, signature: JSON.stringify(next), runKey: newRunKey() });
    setRunId(''); setRunRecord(undefined); setArtifact(undefined);
  });
  const save = () => void operation('save', async () => {
    const payload = workflowPlanPayload(draft);
    for (const item of draft.nodes) {
      if (!item.route?.provider) continue;
      if (modelQuery.loading || modelQuery.error) throw new Error('无法核验所选模型，请刷新模型目录');
      const option = modelOptions.find(option => option.provider === item.route!.provider && option.model === item.route!.model);
      if (!option) throw new Error(`${item.id} 的模型已不在可用目录中，请重新选择`);
      const effort = item.route.reasoningEffort ?? item.route.reasoning_effort;
      if (effort && !option.efforts.includes(effort)) throw new Error(`${item.id} 的模型不支持所选思考强度`);
    }
    const record = await api.call<Data>('workflow', 'plan', payload, { scope, mutating: true });
    const value = unwrap(record);
    if (typeof value.id !== 'string' || typeof value.hash !== 'string') throw new Error('宿主未返回冻结计划身份');
    setSaved({ id: value.id, hash: value.hash, signature, runKey: newRunKey() });
    setRunId(''); setRunRecord(undefined); setMessage('计划已保存'); planQuery.reload();
  });
  const start = (fresh = false) => void operation('run', async () => {
    if (!saved || dirty || scopeLevel !== 'session') return;
    const next = fresh ? { ...saved, runKey: newRunKey() } : saved;
    if (fresh) setSaved(next);
    writeDraft(key, { draft, saved: next, runId });
    const record = await api.call<Data>('workflow', 'run', { planId: next.id, idempotencyKey: next.runKey }, { scope, mutating: true });
    const value = unwrap(record);
    if (typeof value.id !== 'string') throw new Error('宿主未返回运行身份');
    setRunRecord(record); setRunId(value.id); setPoll(value => value + 1);
  });
  const control = (action: string, params: Data = {}) => void operation(action, async () => {
    const record = await api.call<Data>('workflow', action, { runId, ...params }, { scope, mutating: true });
    setRunRecord(record); setPoll(value => value + 1);
  });
  const inspectResult = () => void operation('artifact', async () => {
    if (!nodeState?.resultRef?.id) return;
    const revision = inspectionRevision.current;
    const value = await api.call<Data>('workflow', 'artifact/get', { artifactId: nodeState.resultRef.id }, { scope });
    if (revision === inspectionRevision.current) setArtifact(value);
  });
  const checkStructure = () => {
    try { workflowPlanPayload(draft); setError(undefined); setMessage('结构检查通过'); }
    catch (cause) { setError(cause); setMessage(''); }
  };
  const newDraft = () => {
    if (editLocked) return;
    const next = newWorkflowDraft();
    drag.current = undefined; cancelConnection(); clearInspection();
    setDraft(next); setSaved(undefined); setRunId(''); setRunRecord(undefined); selectNode('node-1'); setMessage(''); setError(undefined);
  };
  const line = (from: WorkflowPosition, to: WorkflowPosition) => `M${from.x} ${from.y} C${from.x + 90} ${from.y}, ${to.x - 90} ${to.y}, ${to.x} ${to.y}`;
  const pointerPosition = (event: React.PointerEvent) => {
    const rect = board.current?.getBoundingClientRect();
    return rect ? { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom } : undefined;
  };

  return <div ref={editor} tabIndex={-1} className="nexus-root nexus-native-panel nexus-workflow" data-nexus-workflow="" data-scope-level={scopeLevel} data-session-id={scope.sessionId} data-workspace-id={scope.workspaceId} onKeyDown={event => {
    if (event.key === 'Escape' && connecting && !event.nativeEvent.isComposing) { event.preventDefault(); cancelConnection(); return; }
    const target = event.target instanceof Element ? event.target : undefined;
    const editingText = Boolean(target?.closest('input,textarea,select,[role="textbox"],[contenteditable]:not([contenteditable="false"])'));
    if (editLocked || !workflowDeleteShortcut(event.nativeEvent, editingText) || !node && !edge) return;
    event.preventDefault(); event.stopPropagation();
    if (edge) removeEdge(); else removeNode();
  }}>
    <style>{baseCss + css}</style>
    <header className="nexus-workflow-header">
      <div className="nexus-workflow-title"><strong>工作流</strong><span>{scopeLabels[scopeLevel]}</span><small>{dirty ? '未保存' : '已保存'}</small></div>
      <div className="nexus-actions">
        <select aria-label="已保存的工作流" value={selectedPlan} onChange={event => setSelectedPlan(event.target.value)} disabled={editLocked}>
          <option value="">已保存的工作流…</option>{rows(planQuery.data).map(item => <option key={item.id} value={item.id}>{titleOf(item)}</option>)}
        </select>
        <Button disabled={!selectedPlan || editLocked} onClick={loadPlan}>打开</Button>
        <Button disabled={editLocked} onClick={newDraft}>新建</Button>
        <Button disabled={editLocked} onClick={checkStructure}>检查结构</Button>
        <Button primary disabled={editLocked} busy={busy === 'save'} onClick={save}>保存计划</Button>
        {scopeLevel === 'session' && <Button primary icon="play" disabled={!saved || dirty || executing || Boolean(busy)} busy={busy === 'run'} onClick={() => start()}>运行</Button>}
      </div>
    </header>
    <div className="nexus-workflow-goal"><label><span>目标</span><input aria-label="工作流目标" value={draft.goal} disabled={editLocked} onChange={event => change(current => ({ ...current, goal: event.target.value }))} placeholder="工作流完成后应交付什么…" /></label></div>
    {Boolean(error) && <div className="nexus-workflow-feedback"><ErrorMessage error={error} /></div>}
    {message && <div className="nexus-workflow-message" role="status">{message}</div>}
    {Boolean(planQuery.error) && <div className="nexus-workflow-feedback"><ErrorMessage error={planQuery.error} retry={planQuery.reload} /></div>}
    <div className="nexus-workflow-toolbar">
      <select aria-label="新增节点类型" value={addKind} disabled={editLocked} onChange={event => setAddKind(event.target.value as TaskNode['kind'])}>{workflowNodeKinds.map(kind => <option key={kind.id} value={kind.id}>{kind.label}</option>)}</select>
      <Button icon="plus" disabled={editLocked} onClick={addNode}>添加节点</Button>
      <select aria-label="连线类型" value={edgeKind} disabled={editLocked} onChange={event => setEdgeKind(event.target.value as WorkflowEdge['kind'])}><option value="data">数据流</option><option value="dependency">完成依赖</option></select>
      {connecting ? <span className="nexus-workflow-connecting">{connecting} → 选择输入端口<Button onClick={cancelConnection}>取消连线</Button></span> : <span>{draft.nodes.length} 个节点 · {draft.edges.length} 条连线</span>}
      <div className="nexus-workflow-zoom"><IconButton name="search" label="缩小画布" onClick={() => setZoom(value => Math.max(.5, value - .1))} /><button onClick={() => setZoom(1)} aria-label="重置画布缩放">{Math.round(zoom * 100)}%</button><IconButton name="plus" label="放大画布" onClick={() => setZoom(value => Math.min(1.5, value + .1))} /></div>
    </div>
    <div className="nexus-workflow-selection" role="toolbar" aria-label="选中元素操作">
      <strong>{node ? `节点 ${node.id}` : edge ? `${edge.from} → ${edge.to}` : '选择节点或连线'}</strong>
      {node && <><Button onClick={() => editNode(node.id)}>编辑节点</Button><Button className="nexus-workflow-delete" disabled={editLocked} onClick={() => removeNode()}>删除节点</Button></>}
      {edge && <><Button onClick={focusInspector}>编辑连线</Button><Button className="nexus-workflow-delete" disabled={editLocked} onClick={removeEdge}>删除连线</Button></>}
      <small>{executing ? '运行中，计划已锁定' : '草稿自动保留 · 保存计划后生效'}</small>
    </div>
    <div className="nexus-workflow-body">
      <section className="nexus-workflow-canvas" aria-label="工作流编排画布">
        <div style={{ width: width * zoom, height: height * zoom, position: 'relative' }}>
          <div ref={board} className="nexus-workflow-board" style={{ width, height, transform: `scale(${zoom})` }} onPointerMove={event => { if (connecting) setWirePoint(pointerPosition(event)); }}>
            <svg className="nexus-workflow-lines" width={width} height={height} aria-label="节点依赖与数据流">
              <defs><marker id={`wf-arrow-${markerId}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 8 4 0 8" /></marker></defs>
              {draft.edges.map(edge => {
                const source = draft.layout[edge.from], target = draft.layout[edge.to];
                if (!source || !target) return null;
                const id = workflowEdgeId(edge), path = line({ x: source.x + 250, y: source.y + 56 }, { x: target.x, y: target.y + 56 });
                return <g key={id} role="button" tabIndex={0} aria-label={`选择连线 ${edge.from} 到 ${edge.to}`} aria-pressed={selectedEdge === id} className={`nexus-workflow-edge is-${edge.kind} ${selectedEdge === id ? 'is-selected' : ''}`} onClick={() => selectEdge(id)} onFocus={() => selectEdge(id)} onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectEdge(id); focusInspector(); }
                }}>
                  <path className="nexus-workflow-edge-hit" d={path} /><path d={path} markerEnd={`url(#wf-arrow-${markerId})`} />
                  <text x={(source.x + 250 + target.x) / 2} y={(source.y + target.y) / 2 + 46}>{edge.kind === 'data' ? '数据' : '依赖'}</text>
                </g>;
              })}
              {connecting && draft.layout[connecting] && wirePoint && <path className="nexus-workflow-wire" d={line({ x: draft.layout[connecting].x + 250, y: draft.layout[connecting].y + 56 }, wirePoint)} />}
            </svg>
            {draft.nodes.map(item => {
              const position = draft.layout[item.id], state = displayedRun?.nodeRuns?.[item.id];
              if (!position) return null;
              return <article key={item.id} className={`nexus-workflow-node ${selected === item.id ? 'is-selected' : ''}`} style={{ left: position.x, top: position.y }} data-node-id={item.id} onClick={() => selectNode(item.id)} onFocusCapture={() => selectNode(item.id)}>
                <button className="nexus-workflow-port is-input" aria-label={`${item.id} 输入端口`} title="连接输入" disabled={editLocked} onPointerUp={event => { event.stopPropagation(); connect(item.id); }} onClick={event => { event.stopPropagation(); connect(item.id); }} />
                <header role="button" tabIndex={editLocked ? -1 : 0} aria-label={`移动节点 ${item.id}，使用方向键调整位置`} onKeyDown={event => {
                  if (editLocked || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
                  event.preventDefault();
                  const step = event.shiftKey ? 50 : 10;
                  const point = { x: Math.min(20000, Math.max(0, position.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0))),
                    y: Math.min(20000, Math.max(0, position.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0))) };
                  change(value => ({ ...value, layout: { ...value.layout, [item.id]: point } }));
                }} onPointerDown={event => {
                  if (editLocked || event.button !== 0) return;
                  selectNode(item.id); event.currentTarget.setPointerCapture(event.pointerId);
                  drag.current = { id: item.id, startX: event.clientX, startY: event.clientY, origin: position };
                }} onPointerMove={event => {
                  const current = drag.current;
                  if (!current || current.id !== item.id) return;
                  const point = { x: Math.min(20000, Math.max(0, Math.round((current.origin.x + (event.clientX - current.startX) / zoom) / 10) * 10)),
                    y: Math.min(20000, Math.max(0, Math.round((current.origin.y + (event.clientY - current.startY) / zoom) / 10) * 10)) };
                  change(value => ({ ...value, layout: { ...value.layout, [item.id]: point } }));
                }} onPointerUp={event => { drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { drag.current = undefined; }}>
                  <Icon name={item.kind === 'cli' ? 'terminal' : item.kind === 'tool' ? 'grid' : item.kind === 'manual' || item.kind === 'approval' ? 'check' : 'branch'} size={17} />
                  <strong>{item.role || workflowNodeKinds.find(kind => kind.id === item.kind)?.label || item.kind}</strong><small>{item.id}</small>
                </header>
                <button className="nexus-workflow-node-body" aria-label={`配置节点 ${item.id}`} onClick={event => { event.stopPropagation(); editNode(item.id); }}>
                  <span>{item.prompt || (item.kind === 'tool' ? `${item.domain ?? '领域'} / ${item.action ?? '动作'}` : '配置执行过程')}</span>
                  <small>{item.route?.model ?? '继承会话模型'}</small>
                </button>
                <div className="nexus-workflow-node-actions">
                  <button aria-label={`编辑节点 ${item.id}`} onClick={event => { event.stopPropagation(); editNode(item.id); }}>编辑</button>
                  <button className="nexus-workflow-delete" aria-label={`删除节点 ${item.id}`} disabled={editLocked} onClick={event => { event.stopPropagation(); removeNode(item.id); }}>删除</button>
                </div>
                {state && <div className="nexus-workflow-node-state"><Status value={state.state} /></div>}
                <button className={`nexus-workflow-port is-output ${connecting === item.id ? 'is-active' : ''}`} aria-label={`${item.id} 输出端口`} title="连接输出" disabled={editLocked} onPointerDown={event => { event.stopPropagation(); connectingRef.current = item.id; setConnecting(item.id); setWirePoint({ x: position.x + 270, y: position.y + 56 }); }} onClick={event => { event.stopPropagation(); if (event.detail === 0) { connectingRef.current = item.id; setConnecting(item.id); } }} />
              </article>;
            })}
            {!draft.nodes.length && <div className="nexus-workflow-empty"><strong>还没有节点</strong><Button icon="plus" disabled={editLocked} onClick={addNode}>添加节点</Button></div>}
          </div>
        </div>
      </section>
      <aside ref={inspector} tabIndex={-1} className="nexus-workflow-inspector" aria-label="节点与结果配置">
        <header className="nexus-workflow-inspector-heading">
          <strong>{node ? `节点 ${node.id}` : edge ? '连线配置' : '工作流配置'}</strong>
          {node && <Button className="nexus-workflow-delete" disabled={editLocked} onClick={() => removeNode()}>删除节点</Button>}
          {edge && <Button className="nexus-workflow-delete" disabled={editLocked} onClick={removeEdge}>删除连线</Button>}
        </header>
        {edge && <section className="nexus-workflow-inspector-section">
          <code className="nexus-workflow-edge-name">{edge.from} → {edge.to}</code>
          <label className="nexus-field"><span>连线类型</span><select aria-label="编辑连线类型" value={edge.kind} disabled={editLocked} onChange={event => updateEdge({ kind: event.target.value as WorkflowEdge['kind'] })}><option value="data">数据流</option><option value="dependency">完成依赖</option></select></label>
          {edge.kind === 'dependency' && <label className="nexus-workflow-check"><input type="checkbox" checked={edge.optional === true} disabled={editLocked} onChange={event => updateEdge({ optional: event.target.checked })} />上游失败时允许继续</label>}
        </section>}
        {node && <section className="nexus-workflow-inspector-section">
          <h3>{workflowNodeKinds.find(kind => kind.id === node.kind)?.label ?? node.kind}</h3>
          <label className="nexus-field"><span>角色</span><input aria-label="节点角色" value={node.role ?? ''} disabled={editLocked} onChange={event => updateNode({ role: event.target.value })} /></label>
          <label className="nexus-field"><span>{node.kind === 'manual' || node.kind === 'approval' ? '完成要求' : '执行指令'}</span><textarea aria-label="节点执行指令" value={node.prompt ?? ''} rows={5} disabled={editLocked} onChange={event => updateNode({ prompt: event.target.value })} /></label>
          {receivesWorkflowData(node) && <>
            {Boolean(modelQuery.error) && <ErrorMessage error={modelQuery.error} retry={modelQuery.reload} />}
            <label className="nexus-field"><span>模型</span><select aria-label="节点模型" disabled={editLocked} value={node.route?.provider && node.route?.model ? JSON.stringify([node.route.provider, node.route.model]) : ''} onChange={event => {
              const option = modelOptions.find(item => item.key === event.target.value);
              updateNode({ route: option ? { ...node.route, provider: option.provider, model: option.model, reasoningEffort: undefined, reasoning_effort: undefined } : undefined });
            }}><option value="">继承会话模型</option>{node.route?.provider && !modelOptions.some(item => item.provider === node.route!.provider && item.model === node.route!.model) && <option disabled value={JSON.stringify([node.route.provider, node.route.model])}>{node.route.provider} / {node.route.model}（不可用）</option>}{modelOptions.map(item => <option key={item.key} value={item.key}>{item.provider} / {item.model}</option>)}</select></label>
            <label className="nexus-field"><span>思考强度</span><select aria-label="节点思考强度" value={node.route?.reasoningEffort ?? node.route?.reasoning_effort ?? ''} disabled={editLocked} onChange={event => updateNode({ route: { ...node.route, reasoningEffort: event.target.value || undefined, reasoning_effort: undefined } })}><option value="">自动使用模型最高强度</option>{modelOptions.find(item => item.provider === node.route?.provider && item.model === node.route?.model)?.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>
            <label className="nexus-field"><span>系统指令</span><textarea aria-label="节点系统指令" rows={3} value={node.system ?? ''} disabled={editLocked} onChange={event => updateNode({ system: event.target.value || undefined })} /></label>
          </>}
          {(node.kind === 'tool' || ['review', 'export', 'merge'].includes(node.kind)) && <><label className="nexus-field"><span>工具领域</span><input aria-label="节点工具领域" value={node.domain ?? ''} disabled={editLocked} onChange={event => updateNode({ domain: event.target.value })} /></label><label className="nexus-field"><span>工具动作</span><input aria-label="节点工具动作" value={node.action ?? ''} disabled={editLocked} onChange={event => updateNode({ action: event.target.value })} /></label></>}
          {(node.kind === 'tool' || node.kind === 'cli' || ['review', 'export', 'merge', 'session'].includes(node.kind)) && <label className="nexus-field"><span>{node.kind === 'cli' ? 'CLI 参数（adapterId、prompt）' : '工具参数'}</span><textarea aria-label="节点工具参数" rows={5} spellCheck={false} disabled={editLocked} value={draft.paramsText[node.id] ?? JSON.stringify(node.params ?? {}, null, 2)} onChange={event => change(current => ({ ...current, paramsText: { ...current.paramsText, [node.id]: event.target.value } }))} /></label>}
          <label className="nexus-field"><span>超时（秒）</span><input type="number" aria-label="节点超时秒数" min={1} max={86400} value={Math.round((node.timeoutMs ?? draft.budgets.maxWallMs ?? 1800000) / 1000)} disabled={editLocked} onChange={event => updateNode({ timeoutMs: Number(event.target.value) * 1000 })} /></label>
          <details><summary>输入与文件范围</summary><label className="nexus-field"><span>已有产物引用（每行一个）</span><textarea aria-label="节点已有产物引用" rows={3} value={(node.inputRefs ?? []).filter(ref => !ref.startsWith('node:')).join('\n')} disabled={editLocked} onChange={event => updateNode({ inputRefs: event.target.value.split('\n').map(value => value.trim()).filter(Boolean) })} /></label><label className="nexus-field"><span>写入范围（每行一个）</span><textarea aria-label="节点写入范围" rows={3} value={(node.writeClaims ?? []).join('\n')} disabled={editLocked} onChange={event => updateNode({ writeClaims: event.target.value.split('\n').map(value => value.trim()).filter(Boolean) })} /></label></details>
          <h3>结果要求</h3>
          <label className="nexus-workflow-check"><input type="checkbox" checked={draft.requiredNodeIds.includes(node.id)} disabled={editLocked} onChange={event => change(current => ({ ...current, requiredNodeIds: event.target.checked ? [...current.requiredNodeIds, node.id] : current.requiredNodeIds.filter(id => id !== node.id) }))} />最终交付必须包含此节点</label>
          {receivesWorkflowData(node) && <><label className="nexus-workflow-check"><input type="checkbox" checked={node.outputContracts?.nonEmpty !== false} disabled={editLocked} onChange={event => updateNode({ outputContracts: { ...node.outputContracts, nonEmpty: event.target.checked } })} />结果不能为空</label><label className="nexus-workflow-check"><input type="checkbox" checked={node.outputContracts?.json === true} disabled={editLocked} onChange={event => updateNode({ outputContracts: { ...node.outputContracts, json: event.target.checked } })} />结果必须为 JSON</label>{node.outputContracts?.json && <label className="nexus-field"><span>必需字段（逗号分隔）</span><input aria-label="结果必需字段" value={node.outputContracts.requiredFields?.join(', ') ?? ''} disabled={editLocked} onChange={event => updateNode({ outputContracts: { ...node.outputContracts, requiredFields: event.target.value.split(',').map(value => value.trim()).filter(Boolean) } })} /></label>}</>}
          <details><summary>独立验证规则</summary><label className="nexus-field"><span>验证规则（JSON 数组）</span><textarea aria-label="节点验证规则" rows={6} spellCheck={false} disabled={editLocked} value={draft.checksText[node.id] ?? JSON.stringify(node.checks ?? [], null, 2)} onChange={event => change(current => ({ ...current, checksText: { ...current.checksText, [node.id]: event.target.value } }))} /></label></details>
          {nodeState && <div className="nexus-workflow-result"><h3>当前运行</h3><Status value={nodeState.state} />{nodeState.error && <ErrorMessage error={nodeState.error} />}<Button disabled={!nodeState.resultRef || Boolean(busy)} onClick={inspectResult}>查看结果</Button>{nodeState.state === 'waiting' && <><label className="nexus-field"><span>完成证据引用（每行一个）</span><textarea rows={3} value={evidence} onChange={event => setEvidence(event.target.value)} /></label><Button disabled={!evidence.trim() || Boolean(busy)} onClick={() => control('resume', { completedNodeIds: [node.id], evidenceRefs: evidence.split('\n').map(value => value.trim()).filter(Boolean) })}>确认完成并继续</Button></>}{artifact && <pre tabIndex={0}>{String(unwrap(artifact).content ?? '')}</pre>}</div>}
        </section>}
        <details className="nexus-workflow-inspector-section"><summary>工作流预算</summary>
          <label className="nexus-field"><span>最大并发</span><input type="number" min={1} max={32} value={draft.budgets.maxConcurrent ?? 4} disabled={editLocked} onChange={event => change(current => ({ ...current, budgets: { ...current.budgets, maxConcurrent: Number(event.target.value) } }))} /></label>
          <label className="nexus-field"><span>模型调用上限</span><input type="number" min={1} value={draft.budgets.maxModelCalls ?? 32} disabled={editLocked} onChange={event => change(current => ({ ...current, budgets: { ...current.budgets, maxModelCalls: Number(event.target.value) } }))} /></label>
          <label className="nexus-field"><span>总超时（分钟）</span><input type="number" min={1} value={(draft.budgets.maxWallMs ?? 1800000) / 60000} disabled={editLocked} onChange={event => change(current => ({ ...current, budgets: { ...current.budgets, maxWallMs: Number(event.target.value) * 60000 } }))} /></label>
          <label className="nexus-field"><span>节点重试上限</span><input type="number" min={0} max={10} value={draft.budgets.maxRetries ?? 1} disabled={editLocked} onChange={event => change(current => ({ ...current, budgets: { ...current.budgets, maxRetries: Number(event.target.value) } }))} /></label>
          <label className="nexus-workflow-check"><input type="checkbox" checked={draft.requireIndependentVerification} disabled={editLocked} onChange={event => change(current => ({ ...current, requireIndependentVerification: event.target.checked }))} />要求独立验证通过</label>
        </details>
      </aside>
    </div>
    {runId && <footer className="nexus-workflow-runbar"><Status value={run?.state ?? 'unknown'} /><code>{runId}</code>{dirty && <span>此运行对应之前保存的计划</span>}<Button disabled={Boolean(busy)} onClick={() => setPoll(value => value + 1)}>刷新状态</Button>{!run?.finishedAt && <><Button disabled={Boolean(busy)} onClick={() => control(run?.paused ? 'resume' : 'pause')}>{run?.paused ? '继续' : '暂停派发'}</Button><Button disabled={Boolean(busy)} onClick={() => control('reconcile')}>查询原运行</Button><Button icon="stop" disabled={Boolean(busy)} onClick={() => control('cancel')}>取消运行</Button></>}{run?.finishedAt && <Button disabled={dirty || Boolean(busy)} onClick={() => start(true)}>再运行一次</Button>}<Button disabled={Boolean(busy)} onClick={() => { setRunId(''); setRunRecord(undefined); }}>关闭监控</Button>{run?.terminalReason && <span role="status">{run.terminalReason}</span>}<details open={showEvents} onToggle={event => setShowEvents(event.currentTarget.open)}><summary>运行事件</summary>{showEvents && <DataView value={run?.events ?? []} />}</details></footer>}
  </div>;
}
