import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NexusError } from '../../ports/contracts.js';
import { redactString } from '../../domain/operations/index.js';
import { debugLanguage } from './configuration.js';
import { openAdapter, DebugCleanupError, type AdapterConnection, type AdapterOptions } from './adapters.js';
import { FramedProtocol } from './protocol.js';
import type { DebugBreakpoint, DebugEvent, DebugLaunch, DebugScope, DebugSnapshot } from '../../shared/debug.js';

type Breakpoints = Record<string, DebugBreakpoint[]>;
interface Run {
  snapshot: DebugSnapshot; scope: DebugScope; stop: AbortController; adapter?: AdapterConnection;
  channels: FramedProtocol[]; active?: FramedProtocol; breakpoints: Breakpoints;
  events: DebugEvent[]; cursor: number; bytes: number; references: Map<string, FramedProtocol>;
  cleanup?: Promise<void>; terminatedChannels: Set<FramedProtocol>;
  preparation?: Promise<void>; secrets: string[];
  ready: Set<FramedProtocol>;
  cleanupFailure?: Error;
}
/** Session runtime is deliberately independent of the task/agent cancellation signal. */
export class DebugRuntime {
  private runs = new Map<string, Run>();
  private starting = new Set<string>();
  constructor(private options: Omit<AdapterOptions, 'output'>) {}
  private key(scope: DebugScope) { return scope.sessionId; }
  private async run(scope: DebugScope) {
    const run = this.runs.get(this.key(scope));
    const identity = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    if (run && identity(run.scope.workspaceRoot) !== identity(await realpath(scope.workspaceRoot))) throw new NexusError('SCOPE_MISMATCH', 'Debugger belongs to another workspace');
    return run;
  }
  async start(scope: DebugScope, launch: DebugLaunch, breakpoints: Breakpoints) {
    if (this.starting.has(this.key(scope))) throw new NexusError('CONFLICT', 'Debugger is already preparing');
    this.starting.add(this.key(scope));
    let root: string;
    try {
      const previous = await this.run(scope);
      if (previous && !['terminated', 'failed'].includes(previous.snapshot.phase)) throw new NexusError('CONFLICT', 'Stop the current debugger before starting another');
      if (previous) await this.cleanup(previous);
      if (!previous && this.runs.size >= 32) {
        const retired = [...this.runs.entries()].find(([, run]) => ['terminated', 'failed'].includes(run.snapshot.phase));
        if (!retired) throw new NexusError('RESOURCE_LIMIT', 'Debugger session budget exceeded');
        await this.cleanup(retired[1]);
        this.runs.delete(retired[0]);
      }
      root = await realpath(scope.workspaceRoot);
    } catch (error) { this.starting.delete(this.key(scope)); throw error; }
    const run: Run = {
      snapshot: { id: randomUUID(), sessionId: scope.sessionId, language: debugLanguage(launch), phase: 'preparing', generation: 0, capabilities: {} },
      scope: { ...scope, workspaceRoot: root }, stop: new AbortController(),
      channels: [], breakpoints, events: [], cursor: 0, bytes: 0, references: new Map(), terminatedChannels: new Set(),
      secrets: Object.values(launch.env ?? {}).filter((value): value is string => typeof value === 'string' && value.length >= 4),
      ready: new Set(),
    };
    this.runs.set(this.key(scope), run);
    this.event(run, 'state', run.snapshot);
    // Return an observable preparing state immediately; adapter failure remains local to this debugger.
    run.preparation = (async () => {
      try {
        run.adapter = await openAdapter({ ...this.options, output: (category, output) => this.event(run, 'output', { category, output }) }, launch, scope, run.stop.signal);
        if (run.stop.signal.aborted) { await run.adapter.dispose(); return; }
        run.snapshot.phase = 'starting'; this.event(run, 'state', run.snapshot);
        await this.initialize(run, run.adapter.protocol, run.adapter.launch);
        if (run.snapshot.phase === 'starting') { run.snapshot.phase = 'running'; this.event(run, 'state', run.snapshot); }
      } catch (error) {
        if (error instanceof DebugCleanupError) run.cleanupFailure = error;
        if (!run.stop.signal.aborted || run.cleanupFailure) {
          run.snapshot.phase = 'failed'; run.snapshot.failure = { phase: 'adapter', message: this.text(run, error instanceof Error ? error.message : 'Debugger failed', 2000) };
          this.event(run, 'state', run.snapshot);
        }
        await this.cleanup(run).catch(error => {
          run.cleanupFailure = error; run.snapshot.phase = 'failed';
          run.snapshot.failure = { phase: 'cleanup', message: this.text(run, String(error.message), 1000) }; this.event(run, 'state', run.snapshot);
        });
      } finally { this.starting.delete(this.key(scope)); }
    })();
    return structuredClone(run.snapshot);
  }
  private async initialize(run: Run, protocol: FramedProtocol, launch: DebugLaunch) {
    if (run.stop.signal.aborted || run.channels.length >= 32) { protocol.close(); throw new Error('Debugger target channel budget exceeded or session closed'); }
    run.channels.push(protocol); run.active ??= protocol;
    protocol.on('message', message => this.message(run, protocol, message));
    protocol.on('closed', error => {
      if (!run.stop.signal.aborted && !run.terminatedChannels.has(protocol) && !['terminated', 'failed'].includes(run.snapshot.phase)) {
        run.snapshot.phase = 'failed'; run.snapshot.failure = { phase: 'transport', message: this.text(run, error.message, 1000) };
        this.event(run, 'state', run.snapshot); void this.cleanup(run).catch(() => {});
      }
    });
    const capabilities = await protocol.request('initialize', { clientID: 'dsh-nexus', clientName: 'Noemaloom native editor', adapterID: String(launch.type),
      pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsVariablePaging: true,
      supportsRunInTerminalRequest: true, supportsStartDebuggingRequest: Boolean(run.adapter?.connectChild), supportsProgressReporting: true,
      supportsMemoryReferences: false, supportsInvalidatedEvent: true });
    run.snapshot.capabilities = Object.fromEntries(Object.entries({ ...run.snapshot.capabilities, ...capabilities })
      .filter(([name, value]) => name.length <= 128 && typeof value === 'boolean').slice(0, 64));
    // Most adapters defer launch response until configurationDone.
    const launched = protocol.request(launch.request ?? 'launch', launch, 120000);
    // Attach a rejection handler now, before waiting for initialized.
    void launched.catch(() => {});
    await protocol.waitFor(message => message.type === 'event' && message.event === 'initialized', 90000);
    for (const [path, points] of Object.entries(run.breakpoints)) await this.setBreakpoints(run, protocol, path, points);
    await protocol.request('setExceptionBreakpoints', { filters: [] });
    if (capabilities.supportsConfigurationDoneRequest) await protocol.request('configurationDone');
    await launched;
    run.ready.add(protocol);
  }
  private message(run: Run, protocol: FramedProtocol, message: any) {
    if (message.type === 'request') {
      void (async () => {
        try {
          if (message.command === 'runInTerminal') protocol.respond(message, await run.adapter!.spawnTerminal(message.arguments));
          else if (message.command === 'startDebugging' && run.adapter?.connectChild) {
            const child = await run.adapter.connectChild();
            // Acknowledge the reverse request before waiting on the child's target handshake.
            protocol.respond(message, {});
            await this.initialize(run, child, { ...message.arguments.configuration, request: message.arguments.request });
            run.active = child;
          } else protocol.respond(message, undefined, `Unsupported reverse request: ${message.command}`);
        } catch (error) {
          try { protocol.respond(message, undefined, redactString(error instanceof Error ? error.message : 'Reverse request failed', 1000)); } catch {}
          run.snapshot.phase = 'failed'; run.snapshot.failure = { phase: 'reverse-request', message: 'Debugger target startup failed' };
          this.event(run, 'state', run.snapshot); await this.cleanup(run).catch(() => {});
        }
      })();
      return;
    }
    if (message.type !== 'event') return;
    let body = message.body ?? {};
    if (message.event === 'output') body = { category: String(body.category ?? 'console').slice(0, 64), output: this.text(run, String(body.output ?? ''), 16384) };
    if (message.event === 'stopped') {
      run.active = protocol; run.references.clear(); run.snapshot.generation++;
      run.snapshot.phase = 'stopped'; run.snapshot.stopped = { reason: this.text(run, String(body.reason ?? 'pause'), 256),
        threadId: Number.isSafeInteger(body.threadId) && body.threadId >= 0 ? body.threadId : undefined,
        allThreadsStopped: body.allThreadsStopped === true };
      this.event(run, 'state', run.snapshot);
    } else if (message.event === 'continued') {
      run.references.clear(); run.snapshot.generation++; run.snapshot.phase = 'running'; delete run.snapshot.stopped;
      this.event(run, 'state', run.snapshot);
    } else if (message.event === 'exited') run.snapshot.exitCode = Number.isSafeInteger(body.exitCode) ? body.exitCode : undefined;
    else if (message.event === 'terminated') {
      run.terminatedChannels.add(protocol);
      // The root js-debug session owns the target subtree; its terminated event is authoritative.
      if (protocol === run.channels[0]) {
        run.snapshot.phase = 'terminated'; delete run.snapshot.stopped; this.event(run, 'state', run.snapshot);
        void this.cleanup(run).catch(error => {
          run.snapshot.phase = 'failed'; run.snapshot.failure = { phase: 'cleanup', message: this.text(run, String(error.message), 1000) }; this.event(run, 'state', run.snapshot);
        });
      }
    }
    if (['output', 'breakpoint', 'stopped', 'continued', 'exited', 'terminated', 'thread', 'loadedSource', 'invalidated'].includes(message.event)) this.event(run, message.event, body);
  }
  private event(run: Run, event: string, body: any) {
    if (event === 'output') body = { ...body, output: this.text(run, String(body.output ?? ''), 16384) };
    const item = { cursor: ++run.cursor, event, body: structuredClone(body) };
    const bytes = Buffer.byteLength(JSON.stringify(item)); run.events.push(item); run.bytes += bytes;
    while (run.events.length > 512 || run.bytes > 1024 * 1024) run.bytes -= Buffer.byteLength(JSON.stringify(run.events.shift()));
  }
  async snapshot(scope: DebugScope, cursor = 0) {
    const run = await this.run(scope);
    if (!run) return { snapshot: null, events: [], cursor: 0 };
    return { snapshot: structuredClone(run.snapshot), events: run.events.filter(event => event.cursor > cursor).slice(0, 200),
      cursor: Math.min(run.cursor, run.events.filter(event => event.cursor > cursor).slice(0, 200).at(-1)?.cursor ?? run.cursor),
      dropped: cursor > 0 && cursor < (run.events[0]?.cursor ?? 0) - 1 };
  }
  private async setBreakpoints(run: Run, protocol: FramedProtocol, path: string, breakpoints: DebugBreakpoint[]) {
    const result = await protocol.request('setBreakpoints', { source: { path }, breakpoints, sourceModified: false });
    const points = (Array.isArray(result.breakpoints) ? result.breakpoints : []).slice(0, 200).map((point: any) => ({
      id: reference(point.id), verified: point.verified === true, line: reference(point.line), column: reference(point.column),
      message: this.text(run, String(point.message ?? ''), 1000),
    }));
    this.event(run, 'breakpoints', { path, breakpoints: points });
    return { breakpoints: points };
  }
  async breakpoints(scope: DebugScope, path: string, points: DebugBreakpoint[]) {
    const run = await this.run(scope);
    if (!run || ['terminated', 'failed'].includes(run.snapshot.phase)) return { breakpoints: [] };
    run.breakpoints[path] = points;
    const results = await Promise.all([...run.ready].map(channel => this.setBreakpoints(run, channel, path, points)));
    return results.at(-1) ?? { breakpoints: points.map(point => ({ ...point, verified: false })) };
  }
  async request(scope: DebugScope, command: string, args: any = {}, generation?: number): Promise<any> {
    const run = await this.run(scope);
    if (!run?.active || ['preparing', 'starting', 'failed', 'terminated'].includes(run.snapshot.phase)) throw new NexusError('CONFLICT', 'Debugger is not ready');
    const stopped = ['stackTrace', 'scopes', 'variables', 'evaluate', 'next', 'stepIn', 'stepOut'].includes(command);
    if (stopped && run.snapshot.phase !== 'stopped') throw new NexusError('CONFLICT', 'Pause the debugger first');
    if (stopped && generation !== run.snapshot.generation) throw new NexusError('STALE_REFERENCE', 'Debugger resumed; refresh stack and variables');
    const allowed = ['threads', 'stackTrace', 'scopes', 'variables', 'evaluate', 'continue', 'pause', 'next', 'stepIn', 'stepOut'];
    if (!allowed.includes(command)) throw new NexusError('INVALID_ARGUMENT', 'Unsupported debug control');
    const params: any = {};
    if (['continue', 'pause', 'next', 'stepIn', 'stepOut', 'stackTrace'].includes(command)) params.threadId = positive(args.threadId ?? run.snapshot.stopped?.threadId, true);
    if (command === 'stackTrace') { params.startFrame = Math.max(0, Math.min(10000, Number(args.startFrame) || 0)); params.levels = 100; }
    if (command === 'scopes') params.frameId = positive(args.frameId, true);
    if (command === 'variables') { params.variablesReference = positive(args.variablesReference); params.start = Math.max(0, Math.min(100000, Number(args.start) || 0)); params.count = 100; }
    if (command === 'evaluate') {
      if (typeof args.expression !== 'string' || args.expression.length > 4096) throw new Error('Expression exceeds budget');
      params.expression = args.expression; params.context = 'watch';
      if (args.frameId !== undefined) params.frameId = positive(args.frameId, true);
    }
    const before = run.snapshot.generation;
    const result = await run.active.request(command, params);
    if (['stackTrace', 'scopes', 'variables', 'evaluate'].includes(command) && before !== run.snapshot.generation) throw new NexusError('STALE_REFERENCE', 'Debugger resumed while reading; refresh stack and variables');
    if (['continue', 'next', 'stepIn', 'stepOut'].includes(command)) {
      // An adapter can deliver stopped before the response to next/continue.
      if (run.snapshot.generation === before) {
        run.snapshot.generation++; run.references.clear(); run.snapshot.phase = 'running'; delete run.snapshot.stopped; this.event(run, 'state', run.snapshot);
      }
    }
    if (command === 'variables') {
      return { variables: (Array.isArray(result.variables) ? result.variables : []).slice(0, 100).map((item: any) => ({
        name: this.text(run, String(item.name ?? ''), 256), value: this.text(run, String(item.value ?? ''), 8192),
        type: this.text(run, String(item.type ?? ''), 256), variablesReference: reference(item.variablesReference),
        namedVariables: count(item.namedVariables), indexedVariables: count(item.indexedVariables),
      })) };
    }
    if (command === 'evaluate') return { result: this.text(run, String(result.result ?? ''), 8192),
      type: this.text(run, String(result.type ?? ''), 256), variablesReference: reference(result.variablesReference),
      namedVariables: count(result.namedVariables), indexedVariables: count(result.indexedVariables) };
    if (command === 'threads') return { threads: (Array.isArray(result.threads) ? result.threads : []).slice(0, 200)
      .map((item: any) => ({ id: reference(item.id), name: this.text(run, String(item.name ?? ''), 256) })) };
    if (command === 'scopes') return { scopes: (Array.isArray(result.scopes) ? result.scopes : []).slice(0, 32)
      .map((item: any) => ({ name: this.text(run, String(item.name ?? ''), 256), variablesReference: reference(item.variablesReference),
        expensive: item.expensive === true, namedVariables: count(item.namedVariables), indexedVariables: count(item.indexedVariables) })) };
    if (command === 'stackTrace') return { totalFrames: count(result.totalFrames),
      stackFrames: (Array.isArray(result.stackFrames) ? result.stackFrames : []).slice(0, 100).map((item: any) => ({
        id: reference(item.id), name: this.text(run, String(item.name ?? ''), 512), line: reference(item.line), column: reference(item.column),
        source: item.source ? { name: this.text(run, String(item.source.name ?? ''), 256),
          path: String(item.source.path ?? '').slice(0, 32700), sourceReference: reference(item.source.sourceReference) } : undefined,
      })) };
    return command === 'continue' ? { allThreadsContinued: result.allThreadsContinued === true } : {};
  }
  async stop(scope: DebugScope) {
    const run = await this.run(scope); if (!run) return { stopped: true };
    await Promise.all([...run.channels].reverse().map(channel =>
      channel.request('disconnect', { restart: false, terminateDebuggee: run.adapter?.launch.request !== 'attach' }, 5000).catch(() => {})));
    run.stop.abort();
    await this.cleanup(run).catch(error => { run.cleanupFailure = error; });
    await run.preparation;
    if (run.cleanupFailure) {
      run.snapshot.phase = 'failed'; run.snapshot.failure = { phase: 'cleanup', message: this.text(run, run.cleanupFailure.message, 1000) };
      this.event(run, 'state', run.snapshot); throw run.cleanupFailure;
    }
    run.snapshot.phase = 'terminated'; delete run.snapshot.stopped; this.event(run, 'state', run.snapshot);
    return { stopped: true, snapshot: structuredClone(run.snapshot) };
  }
  private cleanup(run: Run) { return run.cleanup ??= (async () => { run.stop.abort(); await run.adapter?.dispose(); })(); }
  private text(run: Run, value: string, limit: number) {
    for (const secret of run.secrets) value = value.replaceAll(secret, '[REDACTED]');
    return redactString(value, limit);
  }
  async removeSession(sessionId: string) {
    const run = this.runs.get(sessionId);
    if (run) { await this.stop(run.scope); this.runs.delete(sessionId); }
  }
  async dispose() {
    const results = await Promise.allSettled([...this.runs.values()].map(run => this.stop(run.scope)));
    this.runs.clear();
    if (results.some(result => result.status === 'rejected')) throw new Error('Debugger cleanup failed');
  }
}
function positive(value: any, zero = false) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new Error('Invalid debugger reference');
  return value;
}
function reference(value: unknown) { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0; }
function count(value: unknown) { return value === undefined ? undefined : Math.min(reference(value), 1000000); }
