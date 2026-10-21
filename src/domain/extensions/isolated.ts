import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { NexusError, type JsonRecord, type NexusServices } from '../../ports/contracts.js';

export interface IsolatedHandle {
  call(name: string, args: unknown, timeoutMs?: number): Promise<unknown>;
  health(): Promise<unknown>;
  dispose(): Promise<void>;
  tools: JsonRecord[];
  confinement: JsonRecord;
  processId?: number;
}
export async function createIsolatedHandle(
  services: NexusServices,
  options: { entry: string; root: string; owner: string; generation: number; capabilities: string[] },
): Promise<IsolatedHandle> {
  const bundledWorker = fileURLToPath(new URL('./workers/isolated-extension.js', import.meta.url));
  const workerFile = existsSync(bundledWorker) ? bundledWorker
    : fileURLToPath(new URL('../../workers/isolated-extension.js', import.meta.url));
  const permissionFlag = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission'
    : process.allowedNodeEnvironmentFlags.has('--experimental-permission') ? '--experimental-permission' : undefined;
  if (!permissionFlag) throw new NexusError('ISOLATION_UNAVAILABLE', '该 Node 运行时没有权限模型，请使用经确认的可信 native-managed 模式');
  const dataRoot = join(options.root, '.nexus-extension-data');
  const execArgv = [
    permissionFlag, `--allow-fs-read=${options.root}`,
    `--allow-fs-read=${dirname(workerFile)}`, `--allow-fs-write=${dataRoot}`,
  ];
  const hasNetworkPolicy = process.allowedNodeEnvironmentFlags.has('--allow-net');
  if (hasNetworkPolicy && options.capabilities.includes('network')) execArgv.push('--allow-net');
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:PATH|Path|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|LANG|LC_ALL|COMSPEC)$/i.test(key)));
  // spawn supports windowsHide; ForkOptions does not. Node's IPC stdio entry
  // establishes process.send/on('message') just as fork does, using the exact
  // current executable and only our reviewed permission arguments.
  const child: ChildProcess = spawn(process.execPath, [...execArgv, workerFile], {
    cwd: options.root, env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json',
    shell: false, windowsHide: true,
  });
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> }>();
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_384); });
  let disposed = false;
  const failAll = (error: Error): void => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timeout); waiter.reject(error); }
    pending.clear();
  };
  child.on('error', failAll);
  child.on('exit', (code, signal) => {
    failAll(new NexusError('WORKER_EXITED', `扩展进程退出 ${code ?? signal}: ${stderr}`));
    services.emit('extensions.worker.exit', { owner: options.owner, generation: options.generation, code, signal, disposed });
  });
  child.on('message', async (value: unknown) => {
    const message = value as { kind: string; id: string; result?: unknown; error?: string; domain?: string; action?: string; params?: JsonRecord; event?: string; data?: unknown };
    if (message.kind === 'result') {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id); clearTimeout(waiter.timeout);
      if (message.error) waiter.reject(new NexusError('EXTENSION_CALL_FAILED', message.error));
      else waiter.resolve(message.result);
    } else if (message.kind === 'event') {
      services.emit('extensions.event', { owner: options.owner, generation: options.generation, event: message.event, data: message.data });
    } else if (message.kind === 'capability') {
      const capability = `${message.domain}.${message.action}`;
      if (!options.capabilities.includes(capability)) {
        child.send({ kind: 'capability-result', id: message.id, error: `capability denied: ${capability}` });
        return;
      }
      try {
        const result = await services.invoke(String(message.domain), { action: String(message.action), params: message.params ?? {} });
        child.send({ kind: 'capability-result', id: message.id, result });
      } catch (error) { child.send({ kind: 'capability-result', id: message.id, error: String(error) }); }
    }
  });
  const request = (kind: string, payload: JsonRecord = {}, timeoutMs = 30_000): Promise<unknown> => new Promise((resolve, reject) => {
    if (!child.connected) { reject(new NexusError('WORKER_DISCONNECTED', '扩展进程已断开')); return; }
    const id = randomUUID();
    const timeout = setTimeout(() => { pending.delete(id); reject(new NexusError('EXTENSION_TIMEOUT', '扩展响应超时')); }, Math.min(120_000, timeoutMs));
    timeout.unref();
    pending.set(id, { resolve, reject, timeout });
    child.send({ kind, id, ...payload });
  });
  try {
    const initialized = await request('initialize', { entry: options.entry, generation: options.generation }) as { tools: JsonRecord[] };
    return {
      tools: initialized.tools, processId: child.pid,
      confinement: {
        filesystem: 'node-permission-model', subprocess: 'denied', nativeAddons: 'denied',
        network: hasNetworkPolicy ? (options.capabilities.includes('network') ? 'granted' : 'denied') : 'not-enforced-by-this-node-version',
        osSandbox: false, capabilityRpc: 'explicit-allowlist',
      },
      call: (name, args, timeoutMs) => request('call', { name, args }, timeoutMs),
      health: () => request('health'),
      async dispose() {
        if (disposed) return;
        disposed = true;
        try { await request('dispose', {}, 3_000); } catch { child.kill(); }
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise<void>(resolve => {
            child.once('exit', () => resolve());
            const timer = setTimeout(() => { child.kill(); resolve(); }, 3_000);
            timer.unref();
          });
        }
      },
    };
  } catch (error) { disposed = true; child.kill(); throw error; }
}
