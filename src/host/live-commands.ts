import { AsyncLocalStorage } from 'node:async_hooks';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { readBoundedJson } from './routes.js';
import type { HostContext } from './types.js';
import { commandExitCode, isCommandTool, type CommandChunk, type LiveCommand } from '../client/live-command-model.js';

const MAX_TAIL_BYTES = 262144;
const MAX_COMMANDS = 60;
interface RecordState {
  command: LiveCommand;
  chunks: CommandChunk[];
  total: number;
  usedJob?: boolean;
  job?: { service: any; id: string; cursor: number };
  process?: { handle: any; stdout: number; stderr: number };
  terminal?: { service: any; owner: any; id: string; previous: string };
}
/** Suffix/prefix overlap keeps a rolling PTY scrollback read non-consuming. */
export function terminalDelta(previous: string, current: string): { text: string; lossy: boolean } {
  if (current.startsWith(previous)) return { text: current.slice(previous.length), lossy: false };
  const limit = Math.min(previous.length, current.length);
  // Prefer line boundaries; the small final fallback also covers a partial line.
  for (let start = Math.max(0, previous.length - limit); start < previous.length; start++) {
    if (start !== 0 && previous[start - 1] !== '\n') continue;
    const suffix = previous.slice(start);
    if (current.startsWith(suffix)) return { text: current.slice(suffix.length), lossy: false };
  }
  for (let size = Math.min(limit, 4096); size > 0; size--) {
    if (current.startsWith(previous.slice(-size))) return { text: current.slice(size), lossy: false };
  }
  return { text: current, lossy: previous.length > 0 };
}
function utf8Tail(text: string, bytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  let start = buffer.length - bytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString('utf8');
}
function append(row: RecordState, text: string, stream: CommandChunk['stream'], lossy = false) {
  if (!text) return;
  const bytes = Buffer.byteLength(text);
  const retained = utf8Tail(text, MAX_TAIL_BYTES);
  row.total += bytes;
  row.command.outputAvailable = true;
  row.chunks.push({
    cursor: row.total - Buffer.byteLength(retained), nextCursor: row.total, stream, text: retained,
    ...(lossy || retained !== text ? { lossy: true } : {}),
  });
  while (row.chunks.length > 1 && row.total - row.chunks[0]!.cursor > MAX_TAIL_BYTES) row.chunks.shift();
}
function labelOf(exec: any): string {
  const args = exec.arguments;
  return String(args?.description ?? args?.command ?? args?.text ?? exec.name).slice(0, 2000);
}
/** Transparently observe a method. The original arguments, return and this are unchanged. */
function observeMethod(service: any, key: string, observe: (args: any[], value: any) => void, before = false): () => void {
  if (!service || typeof service[key] !== 'function') return () => {};
  const descriptor = Object.getOwnPropertyDescriptor(service, key);
  const original = service[key];
  const wrapper = function (this: any, ...args: any[]) {
    if (before) try { observe(args, undefined); } catch { /* Read-only observation is best effort. */ }
    const result = original.apply(this, args);
    if (!before) try { observe(args, result); } catch { /* An observer never changes execution. */ }
    return result;
  };
  try { service[key] = wrapper; } catch { return () => {}; }
  return () => {
    if (service[key] !== wrapper) return;
    if (descriptor) Object.defineProperty(service, key, descriptor);
    else delete service[key];
  };
}

/**
 * Install beside the Nexus RPC route using its authenticated registration Context.
 * Only retained output readers are used; no command is replayed or cancelled.
 */
export function registerLiveCommands(ctx: HostContext): () => Promise<void> {
  const context = ctx as any;
  const execution = new AsyncLocalStorage<RecordState>();
  const sessions = new Map<string, Map<string, RecordState>>();
  const cleanups: Array<() => unknown> = [];
  let disposed = false;
  function remember(exec: any): RecordState | undefined {
    const sessionId = exec.agent?.session?.id ?? exec.agent?.id;
    if (typeof sessionId !== 'string' || !isCommandTool(exec.name)) return;
    let rows = sessions.get(sessionId);
    if (!rows) {
      sessions.set(sessionId, rows = new Map());
      // Bound completed history without evicting an active session's records.
      if (sessions.size > 32) {
        const oldest = [...sessions].find(([, values]) => [...values.values()].every(row => !['running', 'stopping'].includes(row.command.state)));
        if (oldest) sessions.delete(oldest[0]);
      }
    }
    const row: RecordState = {
      command: { id: `native:${exec.callId}`, source: 'native', sessionId, callId: exec.callId,
        rootCallId: exec.rootCallId ?? exec.callId, tool: exec.name, label: labelOf(exec),
        state: 'running', startedAt: Date.now(), outputAvailable: false },
      chunks: [], total: 0,
    };
    rows.set(exec.callId, row);
    while (rows.size > MAX_COMMANDS) {
      const old = [...rows].find(([, value]) => !['running', 'stopping'].includes(value.command.state));
      if (!old) break;
      rows.delete(old[0]);
    }
    return row;
  }
  function pull(row: RecordState) {
    try {
      if (row.job) {
        const read = row.job.service.readAt(row.job.id, row.job.cursor, row.command.sessionId);
        for (const [index, chunk] of read.chunks.entries()) {
          append(row, chunk.text, chunk.channel === 'stderr' ? 'stderr' : chunk.channel === 'log' ? 'log' : 'stdout', chunk.gapBefore || (index === 0 && read.lossy));
        }
        row.job.cursor = read.next;
        const job = row.job.service.get(row.job.id, row.command.sessionId);
        row.command.state = job.status;
        row.command.detail = job.detail;
        row.command.finishedAt = job.finishedAt;
        row.command.exitCode = commandExitCode(job.detail);
      } else if (!row.usedJob && row.process) {
        for (const stream of ['stdout', 'stderr'] as const) {
          const read = row.process.handle.observed?.[stream]?.readFrom(row.process[stream]);
          if (read) {
            append(row, read.text, stream, read.lossy);
            row.process[stream] = read.nextOffset;
          }
        }
      } else if (!row.usedJob && row.terminal) {
        const terminal = row.terminal;
        const current = terminal.service.read(terminal.owner, terminal.id, { offset: 0, count: 1000 });
        const delta = terminalDelta(terminal.previous, current.text);
        append(row, delta.text, 'stdout', delta.lossy);
        terminal.previous = current.text;
      }
    } catch { /* A disposed producer leaves the already captured tail readable. */ }
  }
  cleanups.push(ctx.on('tools/execute', async (exec: any, next: () => Promise<any>) => {
    const row = disposed ? undefined : remember(exec);
    if (!row) return next();
    return execution.run(row, async () => {
      try {
        const result = await next();
        pull(row);
        if (!row.job && (!row.process || row.process.handle.status !== 'running')) {
          if (['running', 'stopping'].includes(row.command.state)) row.command.state = result?.isError ? 'failed' : 'completed';
          row.command.finishedAt = Date.now();
          const value = result?.value;
          if (typeof value?.exitCode === 'number' || value?.exitCode === null) row.command.exitCode = value.exitCode;
          if (!row.chunks.length) {
            const text = result?.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
            append(row, text ?? '', result?.isError ? 'stderr' : 'stdout');
          }
        }
        return result;
      } catch (error) {
        pull(row);
        if (!row.usedJob) {
          row.command.state = exec.signal?.aborted ? 'killed' : 'failed';
          row.command.finishedAt = Date.now();
        }
        throw error;
      }
    });
  }));
  cleanups.push(ctx.on('session/event', (session: any, event: any) => {
    if (disposed || event.type !== 'job/registered' || event.seq < session.firstLiveSeq) return;
    const data = event.data;
    if (data.owner !== session.id) return;
    const row = sessions.get(session.id)?.get(data.toolCall?.callId);
    const jobs = context.get('jobs');
    if (row && jobs) {
      row.job = { service: jobs, id: data.jobId, cursor: 0 };
      row.usedJob = true;
      row.command.outputAvailable = true;
    }
  }));
  function optional(name: string, install: (service: any) => () => void) {
    if (typeof context.inject === 'function') {
      const fiber = context.inject([name], (child: any) => child.effect(() => install(child.get(name))));
      cleanups.push(() => fiber.dispose());
    } else {
      const service = context.get(name);
      if (service) cleanups.push(install(service));
    }
  }
  optional('jobs', jobs => jobs.events.subscribe({ owners: 'all' }, (event: any) => {
    if (disposed || !['settled', 'removed'].includes(event.type)) return;
    const row = [...(sessions.get(event.job.owner)?.values() ?? [])].find(value => value.job?.id === event.job.id);
    if (!row) return;
    pull(row);
    row.command.state = event.job.status;
    row.command.finishedAt = event.job.finishedAt;
    row.command.detail = event.job.detail;
    row.command.exitCode = commandExitCode(event.job.detail);
    if (event.type === 'removed') row.job = undefined;
  }));
  optional('shell', shell => observeMethod(shell, 'execute', (_args, result) => {
    const row = execution.getStore();
    if (!row) return;
    void Promise.resolve(result).then(handle => {
      if (disposed || !handle) return;
      row.process = { handle, stdout: 0, stderr: 0 };
      row.command.outputAvailable = true;
      void Promise.resolve(handle.done).then(() => {
        if (disposed) return;
        pull(row);
        if (!row.usedJob) {
          row.command.state = handle.status === 'killed' ? 'killed' : handle.exitCode === 0 ? 'completed' : 'failed';
          row.command.exitCode = handle.exitCode;
          row.command.finishedAt = Date.now();
        }
        row.process = undefined;
      }, () => {});
    }, () => {});
  }));
  optional('terminals', terminals => observeMethod(terminals, 'startSend', (args) => {
    const row = execution.getStore();
    if (!row || row.terminal) return;
    const [owner, id] = args;
    if ((owner?.session?.id ?? owner?.id) !== row.command.sessionId) return;
    // Scrollback is a non-consuming snapshot; never call operation.readOutput().
    const previous = terminals.read(owner, id, { offset: 0, count: 1000 }).text;
    row.terminal = { service: terminals, owner, id, previous };
    row.command.outputAvailable = true;
  }, true));
  const stopRoute = ctx.connection.fetch.register({
    path: '/api/nexus/live-commands', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let parsed;
      try { parsed = clientRequestSchema.safeParse(await readBoundedJson(request, 16384)); }
      catch { return Response.json({ error: 'invalid-request' }, { status: 400 }); }
      if (!parsed.success) return Response.json({ error: 'invalid-envelope' }, { status: 400 });
      const envelope = parsed.data;
      const payload = envelope.payload as any;
      const reply = (result: any) => Response.json({ type: 'server-response', rpcId: envelope.rpcId, result });
      if (disposed || envelope.method !== 'nexus/live-commands' || typeof payload?.sessionId !== 'string'
        || (payload.cursor !== undefined && (!Number.isSafeInteger(payload.cursor) || payload.cursor < 0))) {
        return reply({ ok: false, error: { code: 'nexus/invalid-command-observation', message: '命令观察范围无效', details: {} } });
      }
      const rows = [...(sessions.get(payload.sessionId)?.values() ?? [])];
      const selected = rows.find(row => row.command.id === payload.id || row.command.callId === payload.id || row.command.rootCallId === payload.id);
      if (selected) pull(selected);
      const from = payload.cursor ?? 0;
      const chunks = selected?.chunks.filter(chunk => chunk.nextCursor > from) ?? [];
      return reply({ ok: true, value: {
        commands: rows.map(row => ({ ...row.command })).reverse(),
        ...(selected ? { output: { id: selected.command.id, chunks, nextCursor: selected.total,
          lossy: Boolean(chunks[0] && from < chunks[0].cursor), available: selected.command.outputAvailable } } : {}),
      } });
    },
  });
  return async () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups.reverse()) if (typeof cleanup === 'function') await cleanup();
    sessions.clear();
    await stopRoute();
    execution.disable();
  };
}
