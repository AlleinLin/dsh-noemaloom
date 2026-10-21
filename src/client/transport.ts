import type { ClientContext, Data, NexusApi, RpcOptions } from './types.js';

export class ClientError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); this.name = 'NexusClientError'; }
}
export function errorData(error: unknown): { code: string; message: string; details?: unknown } {
  const item = error as any;
  return { code: String(item?.code ?? (item?.name === 'AbortError' ? 'nexus/cancelled' : 'nexus/carrier-error')), message: String(item?.message ?? error ?? '请求失败'), details: item?.details };
}
export function createNexusApi(ctx: ClientContext): NexusApi {
  let generation = 0;
  let disposed = false;
  const inFlight = new Set<AbortController>();
  const listeners = new Set<() => void>();
  let sequence = 0;
  const invoke = async (method: string, payload: unknown, scope = {}, signal?: AbortSignal) => {
    if (disposed) throw new ClientError('nexus/cancelled', '插件已停止');
    const current = generation;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    inFlight.add(controller);
    let result: any;
    try {
      const ready = ctx.connection.generation;
      if (ready && !ready.getSnapshot()) await new Promise<void>((resolve, reject) => {
        let dispose = () => {};
        const finish = (error?: Error) => { clearTimeout(timeout); dispose(); controller.signal.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
        const aborted = () => finish(new ClientError('nexus/cancelled', '等待连接时已取消'));
        const timeout = setTimeout(() => finish(new ClientError('nexus/connection-not-ready', '宿主连接尚未就绪；请检查连接后重试')), 30000);
        dispose = ready.subscribe(() => { if (ready.getSnapshot()) finish(); });
        controller.signal.addEventListener('abort', aborted, { once: true });
        if (controller.signal.aborted) aborted();
        else if (ready.getSnapshot()) finish();
      });
      result = await ctx.connection.rpc.call('/api', 'nexus/rpc', { protocolVersion: 1, method, scope, payload }, controller.signal);
    } catch (cause) {
      const error = errorData(cause);
      throw new ClientError(error.code, error.message, error.details);
    } finally {
      signal?.removeEventListener('abort', abort);
      inFlight.delete(controller);
    }
    if (disposed || controller.signal.aborted) throw new ClientError('nexus/cancelled', '操作已取消');
    if (current !== generation) throw new ClientError('nexus/stale-generation', '连接已更新，请重新读取当前数据');
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') throw new ClientError('nexus/invalid-response', '宿主返回了不兼容的 Connection RPC 结果');
    if (!result.ok) throw new ClientError(String(result.error?.code ?? 'nexus/remote-service-failed'), String(result.error?.message ?? '宿主请求失败'), result.error?.details);
    const value = result.value;
    if (value && typeof value === 'object' && value.ok === false && value.error) {
      const failure = value.error;
      throw new ClientError(String(failure.code),
        `${typeof failure.diagnosticCode === 'string' ? `[${failure.diagnosticCode}] ` : ''}${String(failure.message)}`,
        { ...(failure.details && typeof failure.details === 'object' ? failure.details : {}),
          traceId: failure.traceId ?? value.traceId, diagnosticCode: failure.diagnosticCode, phase: failure.phase });
    }
    if (value && value.ok === true && 'data' in value) return value.data;
    return value && value.ok === true && 'value' in value ? value.value : value;
  };
  return {
    call<T>(domain: string, action: string, params: Data = {}, options: RpcOptions = {}) {
      return invoke(options.mutating ? 'nexus.command' : 'nexus.query', {
        action,
        requestId: options.requestId ?? `nexus-ui-${Date.now().toString(36)}-${++sequence}`,
        target: options.id ? { id: options.id } : undefined,
        params: { ...params, domain },
        expectedRevision: options.revision,
      }, options.scope, options.signal) as Promise<T>;
    },
    probe: signal => invoke('host.probe', { action: 'probe', params: {} }, {}, signal),
    snapshot: signal => invoke('nexus.snapshot', { action: 'snapshot', params: {} }, {}, signal),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getGeneration: () => generation,
    reset() { generation++; for (const controller of inFlight) controller.abort(); for (const listener of listeners) listener(); },
    dispose() { disposed = true; for (const controller of inFlight) controller.abort(); inFlight.clear(); listeners.clear(); },
  };
}
