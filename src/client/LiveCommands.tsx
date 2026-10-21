import * as React from 'react';
import type { ClientContext, NexusApi } from './types.js';
import { rows } from './types.js';
import {
  appendCommandOutput, emptyCommandOutput, isCommandTool,
  type CommandOutput, type CommandOutputPage, type LiveCommand,
} from './live-command-model.js';

const TAB = 'nexus-live-commands';
const installations = new WeakMap<object, { open(sessionId: string, callId?: string): void }>();
const emptySubscription = () => () => {};
const statusLabels: Record<string, string> = {
  running: '执行中', stopping: '停止中', cancelling: '停止中', completed: '已完成',
  succeeded: '已完成', failed: '失败', killed: '已停止', cancelled: '已停止',
  effectUnknown: '状态待核对',
};
const time = (value: unknown) => typeof value === 'number' ? value : Date.parse(String(value ?? '')) || 0;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function runtimeCommands(value: unknown, sessionId: string): LiveCommand[] {
  return rows(value).filter(row => row.sessionId === sessionId).map(row => ({
    id: `runtime:${row.id}`, source: 'runtime', sessionId, tool: 'shell',
    label: row.command ?? row.label ?? row.id, state: row.state,
    startedAt: time(row.startedAt), finishedAt: row.completedAt ? time(row.completedAt) : undefined,
    exitCode: row.result?.exitCode, detail: row.error?.message,
  }));
}

/** Reopening always reveals the original adjustable bottom workbench. */
export function openLiveCommandMonitor(ctx: ClientContext, sessionId: string, callId?: string): void {
  try { installations.get(ctx)?.open(sessionId, callId); }
  catch (error) { console.warn('[nexus live command monitor]', error); }
}

/**
 * A read-only monitor of original DSH commands and Nexus background jobs.
 * It deliberately has no command launcher or cancellation path.
 */
export function registerLiveCommandMonitor(rawContext: ClientContext, api: NexusApi): () => void {
  const ctx = rawContext as any;
  const cleanups: Array<() => void> = [];
  const listeners = new Set<() => void>();
  const requests = new Map<string, { id: string; revision: number }>();
  const lifetime = new AbortController();
  let sidebar: any;
  let revision = 0;
  let disposed = false;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const open = (sessionId: string, callId?: string) => {
    if (disposed || !sessionId || !sidebar) return;
    if (callId) requests.set(sessionId, {
      id: callId.startsWith('native:') || callId.startsWith('runtime:') ? callId : `native:${callId}`,
      revision: ++revision,
    });
    sidebar.openTab({ type: TAB, id: TAB, title: '命令输出', target: 'bottom' }, { sessionId });
    for (const listener of listeners) listener();
  };
  installations.set(rawContext, { open });

  function LiveCommands({ scope, visible }: { scope: { sessionId: string }; visible: boolean }) {
    const sessionId = scope.sessionId;
    const requestRevision = React.useSyncExternalStore(subscribe, () => requests.get(sessionId)?.revision ?? 0, () => 0);
    const generation = React.useSyncExternalStore(api.subscribe, api.getGeneration, api.getGeneration);
    const connection = ctx.connection.generation;
    const connectionGeneration = React.useSyncExternalStore(connection?.subscribe ?? emptySubscription,
      () => connection?.getSnapshot?.()?.id ?? 0, () => 0);
    const [selected, setSelected] = React.useState('');
    const [commands, setCommands] = React.useState<LiveCommand[]>([]);
    const [output, setOutput] = React.useState<CommandOutput>(() => emptyCommandOutput(''));
    const [error, setError] = React.useState('');
    const [available, setAvailable] = React.useState(true);
    const [follow, setFollow] = React.useState(true);
    const scroller = React.useRef<HTMLDivElement>(null);
    const outputRef = React.useRef(output);
    const snapshotApplied = React.useRef(false);
    React.useEffect(() => {
      setSelected(requests.get(sessionId)?.id ?? '');
      setCommands([]);
    }, [sessionId, requestRevision, generation, connectionGeneration]);
    React.useEffect(() => {
      outputRef.current = emptyCommandOutput(selected);
      snapshotApplied.current = false;
      setOutput(outputRef.current);
      setAvailable(true);
      setFollow(true);
      if (!visible || !sessionId || disposed) return;
      const controller = new AbortController();
      const stop = () => controller.abort();
      lifetime.signal.addEventListener('abort', stop, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const scope = { level: 'session' as const, sessionId };
      const applyPage = (page: CommandOutputPage) => {
        if (controller.signal.aborted || page.id !== selected) return;
        setAvailable(page.available !== false);
        outputRef.current = appendCommandOutput(outputRef.current, page);
        setOutput(outputRef.current);
      };
      const poll = async () => {
        const problems: string[] = [];
        let native: LiveCommand[] = [], runtime: LiveCommand[] = [];
        let more = false;
        const results = await Promise.allSettled([
          (async () => {
            const result = await ctx.connection.rpc.call('/api', 'nexus/live-commands', {
              sessionId, ...(selected.startsWith('native:') ? { id: selected, cursor: outputRef.current.cursor } : {}),
            }, controller.signal);
            if (controller.signal.aborted) return;
            if (!result?.ok) throw new Error(result?.error?.message ?? '原生命令输出暂不可用');
            native = (result.value?.commands ?? []).filter((command: LiveCommand) => command.sessionId === sessionId);
            if (result.value?.output) applyPage(result.value.output);
          })(),
          (async () => {
            runtime = runtimeCommands(await api.call('runtime', 'jobs.list', { sessionId }, { scope, signal: controller.signal }), sessionId);
          })(),
          (async () => {
            if (!selected.startsWith('runtime:')) return;
            const page: any = await api.call('runtime', 'jobs.output', {
              id: selected.slice(8), cursor: snapshotApplied.current ? 0 : outputRef.current.cursor, maxBytes: 65536,
            }, { scope, signal: controller.signal });
            if (controller.signal.aborted) return;
            more = Boolean(page.hasMore);
            applyPage({ ...page, id: `runtime:${page.id}` });
            if (page.available === false && page.result && !snapshotApplied.current && !outputRef.current.chunks.length) {
              snapshotApplied.current = true;
              let cursor = 0;
              const chunks = (['stdout', 'stderr'] as const).flatMap(stream => {
                const text = String(page.result[stream] ?? '');
                if (!text) return [];
                const from = cursor;
                cursor += new TextEncoder().encode(text).length;
                return [{ cursor: from, nextCursor: cursor, stream, text }];
              });
              outputRef.current = appendCommandOutput(emptyCommandOutput(selected), {
                id: selected, chunks, nextCursor: cursor, lossy: Boolean(page.result.truncated),
              });
              setOutput(outputRef.current);
            }
          })(),
        ]);
        if (controller.signal.aborted) return;
        for (const result of results) if (result.status === 'rejected') problems.push(message(result.reason));
        const all = [...native, ...runtime].sort((a, b) => b.startedAt - a.startedAt);
        setCommands(previous => {
          // A temporary read failure should not erase already selected history.
          const retained = previous.filter(command => command.sessionId === sessionId
            && ((command.source === 'native' && results[0].status === 'rejected')
              || (command.source === 'runtime' && results[1].status === 'rejected')));
          return [...all, ...retained].sort((a, b) => b.startedAt - a.startedAt);
        });
        if (!selected && all[0]) setSelected(all[0].id);
        setError(problems.join(' · '));
        timer = setTimeout(() => { void poll(); }, more ? 40 : 700);
      };
      void poll();
      return () => {
        if (timer) clearTimeout(timer);
        controller.abort();
        lifetime.signal.removeEventListener('abort', stop);
      };
    }, [sessionId, selected, visible, generation, connectionGeneration]);
    React.useLayoutEffect(() => {
      if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    }, [output, follow, visible]);
    const command = commands.find(command => command.id === selected);
    const state = command ? statusLabels[command.state] ?? command.state : '';
    const openTerminal = () => {
      try { ctx.sidebarRight?.openTab('terminal'); }
      catch (cause) { setError(message(cause)); }
    };
    return <section className="nexus-live-commands" aria-label="实时命令输出">
      <div className="nexus-live-toolbar">
        <label className="nexus-live-history">命令
          <select aria-label="命令历史" value={selected} onChange={event => setSelected(event.target.value)}>
            {!command && <option value={selected}>{selected ? '等待命令记录…' : '暂无命令'}</option>}
            {commands.map(item => <option key={item.id} value={item.id}>
              {statusLabels[item.state] ?? item.state} · {item.label}
            </option>)}
          </select>
        </label>
        {command && <span className="nexus-live-status" data-state={command.state} role="status">
          {state}{typeof command.exitCode === 'number' ? ` · 退出码 ${command.exitCode}` : ''}
        </span>}
        <label className="nexus-live-follow"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />跟随输出</label>
        {ctx.sidebarRight?.openTab && <button type="button" onClick={openTerminal} title="打开会话的原生交互终端">原生终端</button>}
      </div>
      {command && <div className="nexus-live-command" title={command.label}>
        <span>{command.source === 'native' ? command.tool : '后台作业'}</span><code>{command.label}</code>
        {command.detail && <span>{command.detail}</span>}
      </div>}
      {error && <div className="nexus-live-notice" role="status">{error}</div>}
      {!available && output.chunks.length > 0 && <div className="nexus-live-notice">实时输出已离开内存，当前显示已保存的执行结果。</div>}
      {output.lossy && <div className="nexus-live-notice">部分早期输出已超出保留范围，当前显示保留的尾部。</div>}
      <div className="nexus-live-output" ref={scroller} tabIndex={0} aria-label="命令输出内容" onScroll={event => {
        const element = event.currentTarget;
        if (element.scrollHeight - element.scrollTop - element.clientHeight > 40) setFollow(false);
      }}>
        {output.id === selected && output.chunks.length ? <pre>{output.chunks.map((chunk, index) =>
          <span key={`${chunk.cursor}:${index}`} data-stream={chunk.stream}>{chunk.text}</span>)}</pre>
          : <p className="nexus-live-empty">{!selected ? '选择一个命令以查看实时输出。'
            : available ? '正在等待输出；命令尚未登记或尚未产生内容。' : '此命令的实时输出已不在保留范围内。'}</p>}
      </div>
      <div className="nexus-live-footnote">关闭面板后命令继续执行。原生终端提供独立的交互会话。</div>
    </section>;
  }

  const installSidebar = (service: any) => {
    sidebar = service;
    const stop = service.registerTab({
      id: TAB, title: '命令输出', description: '实时查看命令状态、标准输出和错误输出',
      order: 45, bottomOnly: true, single: true, component: LiveCommands,
    });
    return () => { if (sidebar === service) sidebar = undefined; stop(); };
  };
  if (typeof ctx.inject === 'function') {
    const fiber = ctx.inject(['betterSidebar'], (child: any) => child.effect(() => installSidebar(child.get('betterSidebar'))));
    cleanups.push(() => fiber.dispose());
  } else {
    const service = ctx.get?.('betterSidebar');
    if (service) cleanups.push(installSidebar(service));
  }

  // Keep the original Tool owner, children, store, inject and renderer. The
  // delegate adds an affordance after each atomic command, including subcalls.
  const stopTools = ctx.slots.inject('conversation.chat.node', () => {
    const entries = ctx.slots.entries?.('conversation.chat.node')
      ?? ctx.slots.entriesOfSlot?.('conversation.chat.node') ?? [];
    const entry = entries.find((item: any) => item.options?.key === 'tool-call' || item.key === 'tool-call');
    if (!entry || typeof entry.component !== 'function' || !entry.children?.['tool.call.toolview']) return;
    const original = entry.component;
    function MonitoredToolTree(props: any) {
      const renderSlot = React.useCallback((name: string, owner: any, options?: any) => {
        const rendered = props.renderSlot(name, owner, options);
        if (name !== 'tool.call.toolview' || !isCommandTool(owner.toolName) || typeof props.sessionId !== 'string') return rendered;
        return <>{rendered}<button type="button" className="nexus-live-open"
          onClick={event => { event.stopPropagation(); open(props.sessionId, owner.callId); }}>实时输出</button></>;
      }, [props.renderSlot, props.sessionId]);
      return React.createElement(original, { ...props, renderSlot });
    }
    entry.component = MonitoredToolTree;
    const priority = Math.max(0, ...entries.map((item: any) => item.options?.priority ?? 0)) + 1000000;
    let stopVersion: (() => void) | undefined;
    try { stopVersion = ctx.slots.register({ name: 'conversation.chat.node', key: 'tool-call', priority }, () => null); }
    catch (cause) { if (entry.component === MonitoredToolTree) entry.component = original; throw cause; }
    return () => {
      if (entry.component === MonitoredToolTree) entry.component = original;
      stopVersion?.();
    };
  });
  if (typeof stopTools === 'function') cleanups.push(stopTools);
  return () => {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    for (const cleanup of cleanups.reverse()) cleanup();
    installations.delete(rawContext);
    listeners.clear();
    requests.clear();
  };
}
