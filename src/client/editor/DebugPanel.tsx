import * as React from 'react';
import type { NexusApi, NexusScope } from '../types.js';
interface Props {
  api: NexusApi; scope: NexusScope; path: string; dirty: boolean;
  onBreakpoints(path: string, values: any[]): void; onStopped(path: string, line: number): void; onRunning(): void;
}
export function DebugPanel(props: Props) {
  const [configurations, setConfigurations] = React.useState<any[]>([]);
  const [selected, setSelected] = React.useState(0);
  const [snapshot, setSnapshot] = React.useState<any>();
  const [error, setError] = React.useState('');
  const [output, setOutput] = React.useState('');
  const [frames, setFrames] = React.useState<any[]>([]);
  const [threads, setThreads] = React.useState<any[]>([]);
  const [thread, setThread] = React.useState<number>();
  const [frame, setFrame] = React.useState<number>();
  const [scopes, setScopes] = React.useState<any[]>([]);
  const [pane, setPane] = React.useState('variables');
  const [expression, setExpression] = React.useState('');
  const [evaluated, setEvaluated] = React.useState<any>();
  const [sdk, setSdk] = React.useState('');
  const [sdkOpen, setSdkOpen] = React.useState(false);
  const cursor = React.useRef(0), state = React.useRef(snapshot); state.current = snapshot;
  const propsRef = React.useRef(props); propsRef.current = props;
  const command = async (name: string, args: any = {}, generation = state.current?.generation) => {
    return props.api.call<any>('debug', 'request', { command: name, arguments: { threadId: thread ?? state.current?.stopped?.threadId, ...args }, generation }, { scope: props.scope, mutating: true });
  };
  React.useEffect(() => {
    let active = true;
    void props.api.call<any>('debug', 'configurations', { path: props.path }, { scope: props.scope }).then(result => {
      if (active) { setConfigurations(result.configurations); setSelected(0); }
    }, error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [props.api, props.path, props.scope]);
  React.useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      try {
        let result = await props.api.call<any>('debug', 'snapshot', { cursor: cursor.current }, { scope: props.scope, signal: controller.signal });
        if (!active) return;
        const previous = state.current;
        if (previous?.id && result.snapshot?.id !== previous.id && cursor.current) {
          cursor.current = 0; setOutput('');
          result = await props.api.call<any>('debug', 'snapshot', { cursor: 0 }, { scope: props.scope, signal: controller.signal });
          if (!active) return;
        }
        state.current = result.snapshot; setSnapshot(result.snapshot);
        cursor.current = result.cursor;
        if (result.dropped) setOutput(value => `${value}\n[较早事件已超出缓冲区]\n`.slice(-131072));
        for (const event of result.events) {
          if (event.event === 'output') setOutput(value => (value + event.body.output).slice(-131072));
          if (event.event === 'breakpoints') propsRef.current.onBreakpoints(event.body.path, event.body.breakpoints);
          if (event.event === 'breakpoint') {
            const point = event.body.breakpoint;
            if (point?.source?.path) propsRef.current.onBreakpoints(point.source.path, [point]);
          }
        }
        if (result.snapshot?.phase === 'stopped' && (previous?.id !== result.snapshot.id || previous?.generation !== result.snapshot.generation || previous?.phase !== 'stopped')) {
          const generation = result.snapshot.generation;
          const resultThreads = await command('threads', {}, generation);
          if (!active || state.current?.generation !== generation) return;
          setThreads(resultThreads.threads ?? []);
          const id = result.snapshot.stopped?.threadId ?? resultThreads.threads?.[0]?.id;
          setThread(id);
          if (id !== undefined) await loadStack(id, generation);
        } else if (result.snapshot?.phase !== 'stopped') {
          setFrames([]); setScopes([]); setFrame(undefined); setEvaluated(undefined); propsRef.current.onRunning();
        }
      } catch (error) { if (active && !controller.signal.aborted) setError((error as Error).message); }
      finally { if (active) timer = setTimeout(poll, ['running', 'stopped', 'preparing', 'starting'].includes(state.current?.phase) ? 350 : 1500); }
    };
    void poll();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [props.api, props.scope]);
  const loadStack = async (id: number, generation = state.current?.generation) => {
    const result = await command('stackTrace', { threadId: id }, generation);
    if (state.current?.generation !== generation) return;
    setFrames(result.stackFrames ?? []);
    if (result.stackFrames?.[0]) await chooseFrame(result.stackFrames[0], generation);
  };
  const chooseFrame = async (value: any, generation = state.current?.generation) => {
    setFrame(value.id);
    if (value.source?.path && value.line > 0) propsRef.current.onStopped(value.source.path, value.line);
    const result = await command('scopes', { frameId: value.id }, generation);
    if (state.current?.generation === generation) setScopes(result.scopes ?? []);
  };
  const control = async (name: string) => {
    try { setError(''); if (name === 'stop') await props.api.call('debug', 'stop', {}, { scope: props.scope, mutating: true }); else await command(name); }
    catch (error) { setError((error as Error).message); }
  };
  const start = async () => {
    if (props.dirty) { setError('请先保存文件；调试运行使用磁盘上的源文件。'); return; }
    try {
      setError(''); setOutput(''); cursor.current = 0; setFrames([]); setScopes([]);
      const type = configurations[selected]?.type;
      const sdkField = ['python', 'debugpy'].includes(type) ? 'pythonPath' : type === 'java' ? 'javacPath' : type === 'coreclr' ? 'dotnetPath' : undefined;
      const result = await props.api.call<any>('debug', 'start', { path: props.path, index: selected, ...(sdk && sdkField ? { [sdkField]: sdk } : {}) }, { scope: props.scope, mutating: true });
      state.current = result; setSnapshot(result);
    } catch (error) { setError((error as Error).message); }
  };
  const active = ['preparing', 'starting', 'running', 'stopped'].includes(snapshot?.phase);
  const paused = snapshot?.phase === 'stopped';
  const config = configurations[selected];
  return <div className="nexus-debug" data-nexus-debug="">
    <div className="nexus-editor-toolbar">
      <select aria-label="调试配置" value={selected} disabled={active} onChange={event => { setSelected(Number(event.target.value)); setSdk(''); }}>
        {configurations.map((value, index) => <option key={index} value={index}>{value.name}{value.supported ? '' : ' · VS Code'}</option>)}
      </select>
      <button onClick={start} disabled={active || !config || !config.supported || props.dirty}>启动</button>
      <button onClick={() => control(paused ? 'continue' : 'pause')} disabled={!['running', 'stopped'].includes(snapshot?.phase)}>{paused ? '继续' : '暂停'}</button>
      <button title="单步跳过" aria-label="单步跳过" onClick={() => control('next')} disabled={!paused}>跳过</button>
      <button title="单步进入" aria-label="单步进入" onClick={() => control('stepIn')} disabled={!paused}>进入</button>
      <button title="单步跳出" aria-label="单步跳出" onClick={() => control('stepOut')} disabled={!paused}>跳出</button>
      <button onClick={() => control('stop')} disabled={!active}>停止</button>
      {['python', 'debugpy', 'java', 'coreclr'].includes(config?.type) && <button onClick={() => setSdkOpen(value => !value)} aria-expanded={sdkOpen}>SDK</button>}
      <span role="status">{snapshot?.phase ?? '未启动'}</span>
    </div>
    {sdkOpen && <label className="nexus-sdk">SDK 可执行文件（可选）<input value={sdk} onChange={event => setSdk(event.target.value)} placeholder={config?.type === 'java' ? 'javac 路径；JAVA_HOME 决定目标 java' : config?.type === 'coreclr' ? 'dotnet' : 'python'} /></label>}
    {(error || snapshot?.failure) && <p className="nexus-editor-notice" role="alert">{error || snapshot.failure.message}</p>}
    {!config?.supported && config && <p className="nexus-editor-notice">此配置需要 VS Code 扩展。使用上方“在 VS Code 中打开”。</p>}
    <div role="tablist" aria-label="调试数据" className="nexus-debug-tabs">
      {['variables', 'stack', 'output'].map((id, index) => <button key={id} role="tab" aria-selected={pane === id} onClick={() => setPane(id)}>{['变量', '调用栈 / 线程', '输出'][index]}</button>)}
    </div>
    <div className="nexus-debug-body" role="tabpanel">
      {pane === 'variables' && <>
        {scopes.map(value => <VariableNode key={`${snapshot?.generation}:${value.variablesReference}`} name={value.name} reference={value.variablesReference}
          generation={snapshot?.generation} request={command} initial />)}
        {!scopes.length && <span>暂停后显示变量。</span>}
        <form className="nexus-debug-watch" onSubmit={async event => { event.preventDefault(); try { setEvaluated(await command('evaluate', { expression, frameId: frame })); } catch (error) { setError((error as Error).message); } }}>
          <input aria-label="监视表达式" value={expression} onChange={event => setExpression(event.target.value)} placeholder="监视表达式" disabled={!paused} />
          <button disabled={!paused || !expression}>求值</button>
        </form>
        {evaluated && <VariableNode key={`${snapshot?.generation}:${expression}`} name={expression} value={evaluated.result} reference={evaluated.variablesReference} generation={snapshot?.generation} request={command} />}
      </>}
      {pane === 'stack' && <>
        <select aria-label="线程" value={thread ?? ''} onChange={async event => { const id = Number(event.target.value); setThread(id); try { await loadStack(id); } catch (error) { setError((error as Error).message); } }}>
          {threads.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}
        </select>
        {frames.map(value => <button className="nexus-stack-frame" aria-current={frame === value.id} key={value.id} onClick={() => { void chooseFrame(value).catch(error => setError(error.message)); }}>
          <strong>{value.name}</strong><span>{value.source?.name ?? value.source?.path ?? '外部源'}:{value.line}</span>
        </button>)}
      </>}
      {pane === 'output' && <pre aria-label="调试输出">{output || '尚无输出。'}</pre>}
    </div>
  </div>;
}
function VariableNode(props: { name: string; value?: string; reference?: number; generation: number; request(name: string, args: any, generation: number): Promise<any>; initial?: boolean; depth?: number }) {
  const [expanded, setExpanded] = React.useState(Boolean(props.initial)), [items, setItems] = React.useState<any[]>([]);
  const [error, setError] = React.useState(''), [hasMore, setHasMore] = React.useState(false);
  const load = async (start = 0) => {
    try {
      const result = await props.request('variables', { variablesReference: props.reference, start }, props.generation);
      setItems(value => start ? [...value, ...(result.variables ?? [])].slice(0, 500) : result.variables ?? []);
      setHasMore(result.variables?.length === 100 && start + 100 < 500);
    } catch (error) { setError((error as Error).message); }
  };
  React.useEffect(() => { if (expanded && props.reference) void load(); }, [expanded, props.reference, props.generation]);
  return <div className="nexus-variable" style={{ paddingLeft: (props.depth ?? 0) ? 12 : 0 }}>
    <button disabled={!props.reference || (props.depth ?? 0) >= 12} onClick={() => setExpanded(value => !value)} aria-expanded={expanded} title={props.value}>
      <span>{props.reference ? expanded ? '▾' : '▸' : '·'}</span> <strong>{props.name}</strong>{props.value !== undefined && <code> = {props.value}</code>}
    </button>
    {error && <span role="alert">{error}</span>}
    {expanded && items.map((item, index) => <VariableNode key={`${item.name}:${index}`} name={item.name} value={item.value} reference={item.variablesReference}
      generation={props.generation} request={props.request} depth={(props.depth ?? 0) + 1} />)}
    {expanded && hasMore && <button onClick={() => load(items.length)}>更多变量…</button>}
  </div>;
}
