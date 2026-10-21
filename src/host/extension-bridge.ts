import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { NexusError, type JsonRecord, type NexusServices } from '../ports/contracts.js';
import type { HostContext } from './types.js';

interface OfficialContext extends HostContext {
  plugin(plugin: Plugin, config?: unknown): Fiber & PromiseLike<Fiber>;
  isolate(name: string, label?: symbol): OfficialContext;
}
interface DeferredRegistration {
  id: string; type: string; label: string; install: () => (() => unknown) | Promise<() => unknown>;
  dispose?: () => unknown; removed: boolean; cleanupError?: string; cleanupPromise?: Promise<void>;
}
interface Generation {
  handle: string; owner: string; generation: number; packageRoot: string; entry: string;
  entryHash: string; fiber?: Fiber; tools?: ToolRuntime; state: 'preparing' | 'staged' | 'active' | 'draining' | 'disposed' | 'failed';
  client?: ClientGeneration; registrations: DeferredRegistration[]; activeCalls: number;
  calls: Set<AbortController>; waiters: Set<() => void>; resources: JsonRecord[];
  cleanupErrors?: JsonRecord[]; disposePromise?: Promise<JsonRecord>;
}
interface ClientGeneration {
  owner: string; generation: number; handle: string; ready: boolean;
  commit(): Promise<unknown>; dispose(): Promise<unknown>; facts?: JsonRecord;
}
interface PresetRegistration {
  handle: string; owner: string; id: string; definitionHash: string; fiber: Fiber; createdAt: string;
  cleanupError?: string; disposePromise?: Promise<void>;
}
export interface ExtensionBridge {
  handles(action: string): boolean;
  call(action: string, params: JsonRecord): Promise<unknown>;
  restore(): Promise<void>;
  dispose(): Promise<void>;
}
const isRecord = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value);
const required = (params: JsonRecord, key: string): string => {
  if (typeof params[key] !== 'string' || !(params[key] as string).trim()) throw new NexusError('INVALID_ARGUMENT', `${key} 必须为非空字符串`);
  return params[key] as string;
};
const generationOf = (params: JsonRecord): number => {
  if (!Number.isSafeInteger(params.generation) || Number(params.generation) < 1) throw new NexusError('INVALID_ARGUMENT', 'generation 必须为正整数');
  return Number(params.generation);
};
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const within = (root: string, filename: string): boolean => {
  const rel = path.relative(root, filename);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const now = () => new Date().toISOString();
const missing = (name: string): never => { throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', `正式宿主 ${name} 服务不可用`); };

/**
 * rc.2 bridge built on the actual Cordis Fiber contract.
 *
 * ctx.plugin()'s await() settling does not imply ACTIVE: a missing dependency
 * can leave PENDING. ACTIVE=2 is checked after the owned fiber settles.
 * Every disposal is the exact Fiber.dispose(), awaited through all cleanup.
 * Native code is trusted in-process code, not an OS sandbox.
 */
export function createExtensionBridge(hostContext: HostContext, getServices: () => NexusServices, pluginSignal: AbortSignal): ExtensionBridge {
  const ctx = hostContext as OfficialContext;
  const generations = new Map<string, Generation>();
  const active = new Map<string, string>();
  const clients = new Map<string, ClientGeneration>();
  const presets = new Map<string, PresetRegistration>();
  const disposedReceipts = new Map<string, JsonRecord>();
  const mutations = new Set<string>();
  const publicSlots = new Map<string, { owner: string; bindings: Map<string, (...args: any[]) => any>; release: () => unknown; cleanupError?: string }>();
  const actions = new Set([
    'extensions.activate', 'extensions.commit', 'extensions.dispose', 'extensions.call',
    'extensions.health', 'extensions.cleanup', 'extensions.client.stage', 'extensions.client.dispose',
    'extensions.install', 'extensions.uninstall', 'extensions.restore', 'presets.register', 'presets.unregister',
  ]);
  let disposed = false;
  const restoreRuntimeId = `nexus-restore:${randomUUID()}`;
  const restoredDomains = new Set<string>();
  let restoreAttempt = 0;
  let restorePromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;
  const services = () => getServices();
  const clientKey = (owner: string, generation: number) => `${owner}\0${generation}`;
  const resourceFacts = (generation: Generation): JsonRecord[] => [
    { type: 'cordis-fiber', owner: generation.owner, generation: generation.generation, fiberUid: generation.fiber?.uid ?? null, state: generation.fiber?.state, entry: generation.entry, entryHash: generation.entryHash, trust: 'trusted-in-process-not-sandbox' },
    ...(generation.tools?.schemas().map(tool => ({ type: 'tool', name: tool.name, description: tool.description, owner: generation.owner, generation: generation.generation, exposure: 'fixed-nexus-dispatcher-only' })) ?? []),
    ...generation.registrations.filter(registration => !registration.removed).map(registration => ({ id: registration.id, type: registration.type, label: registration.label, owner: generation.owner, generation: generation.generation, installed: !!registration.dispose, ...(registration.cleanupError ? { cleanupState: 'unknown', cleanupError: registration.cleanupError } : {}) })),
    ...(generation.client ? [{ type: 'client', handle: generation.client.handle, owner: generation.owner, generation: generation.generation, facts: generation.client.facts ?? {} }] : []),
    ...(generation.cleanupErrors?.length ? [{ type: 'cleanup-failure', owner: generation.owner, generation: generation.generation, state: 'unknown', failures: generation.cleanupErrors }] : []),
  ];
  const receipt = async (operation: string, generation: Generation, extra: JsonRecord = {}): Promise<void> => {
    const id = randomUUID();
    await services().store.put('extension-host-receipts', id, { id, operation, owner: generation.owner, generation: generation.generation, handle: generation.handle, state: generation.state, resources: resourceFacts(generation), at: now(), ...extra }, 0);
    services().emit('extensions.host', { operation, owner: generation.owner, generation: generation.generation, handle: generation.handle, state: generation.state, ...extra });
  };
  const assertContext = (): void => {
    if (typeof ctx.plugin !== 'function' || typeof ctx.isolate !== 'function') missing('Cordis ctx.plugin/isolate');
    if (disposed || pluginSignal.aborted) throw new NexusError('DISPOSED', '扩展宿主桥已停止');
  };
  const resolveGeneration = (params: JsonRecord): Generation => {
    const handle = required(params, 'handle');
    const found = generations.get(handle);
    if (!found) throw new NexusError('NOT_FOUND', '找不到精确扩展代际句柄', { handle });
    if (params.owner !== undefined && params.owner !== found.owner || params.generation !== undefined && params.generation !== found.generation) throw new NexusError('SCOPE_MISMATCH', '扩展句柄与 owner/generation 不一致');
    return found;
  };
  const assertActive = async (fiber: Fiber, label: string): Promise<void> => {
    await fiber.await();
    if (fiber.uid === null || fiber.state !== 2) throw new NexusError('DEPENDENCY_MISSING', `${label} 未达到 Cordis ACTIVE 状态`, { fiberUid: fiber.uid, state: fiber.state });
  };
  function deferred(generation: Generation, type: string, label: string, install: DeferredRegistration['install']): () => Promise<void> {
    if (generation.state === 'disposed' || generation.state === 'draining') throw new NexusError('GENERATION_DRAINING', '扩展正在排空');
    // Registering new public routes after commit requires a new generation.
    // Silently installing here would bypass the reviewed staged resource set.
    if (generation.state === 'active') throw new NexusError('REVISION_CONFLICT', '活动代新增路由需要重新 staging');
    const item: DeferredRegistration = { id: randomUUID(), type, label, install, removed: false };
    generation.registrations.push(item);
    return () => releaseRegistration(item);
  }
  function releaseRegistration(registration: DeferredRegistration): Promise<void> {
    if (registration.cleanupPromise) return registration.cleanupPromise;
    if (registration.removed) return Promise.resolve();
    if (registration.cleanupError) return Promise.reject(new NexusError('DISPOSAL_FAILED', '注册资源清理状态未知，不能以空回调确认释放', { id: registration.id, cleanupError: registration.cleanupError }));
    if (!registration.dispose) { registration.removed = true; return Promise.resolve(); }
    registration.cleanupPromise = Promise.resolve().then(async () => {
      try {
        await registration.dispose!();
        registration.removed = true;
        registration.dispose = undefined;
      } catch (error) {
        // Cordis may already have retired the effect epoch when cleanup throws.
        // Replaying an empty disposer cannot prove that its resources vanished.
        registration.cleanupError = String(error);
        throw error;
      }
    });
    return registration.cleanupPromise;
  }
  async function recordCleanupFailure(item: Generation, failures: JsonRecord[], reason: string): Promise<void> {
    item.cleanupErrors = [...(item.cleanupErrors ?? []), ...failures];
    try {
      const key = `${item.owner}:${item.generation}`;
      const previous = await services().store.get('extension-host-leaks', key);
      await services().store.put('extension-host-leaks', key, {
        handle: item.handle, owner: item.owner, generation: item.generation, reason,
        activeCalls: item.activeCalls, resources: resourceFacts(item), errors: item.cleanupErrors, at: now(),
      }, previous?.revision ?? 0);
    } catch (error) {
      item.cleanupErrors.push({ resource: 'cleanup-receipt', error: String(error) });
    }
    services().emit('extensions.host.cleanup-failed', {
      handle: item.handle, owner: item.owner, generation: item.generation,
      reason, resources: resourceFacts(item), errors: item.cleanupErrors,
    });
  }
  async function bindPublicSlot(generation: Generation, type: string, label: string, handler: (...args: any[]) => any, register: (handler: (...args: any[]) => any) => (() => unknown) | Promise<() => unknown>): Promise<() => Promise<void>> {
    const key = `${generation.owner}\0${type}\0${label}`;
    let slot = publicSlots.get(key);
    if (slot?.cleanupError) throw new NexusError('DISPOSAL_FAILED', '旧路由清理状态未知，保留精确句柄后方可恢复', { owner: generation.owner, type, label, cleanupError: slot.cleanupError });
    if (!slot) {
      const bindings = new Map<string, (...args: any[]) => any>();
      const candidate = { owner: generation.owner, bindings, release: undefined as unknown as () => unknown };
      const dispatch = (...args: any[]) => {
        const currentHandle = active.get(candidate.owner);
        const current = currentHandle ? candidate.bindings.get(currentHandle) : undefined;
        if (!current) {
          if (type === 'fetch-route') return new Response('Extension generation is not committed', { status: 503 });
          throw new NexusError('GENERATION_NOT_COMMITTED', '该扩展路由尚无活动代际');
        }
        return current(...args);
      };
      candidate.release = await register(dispatch);
      if (typeof candidate.release !== 'function') throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '正式路由注册没有精确 disposer');
      publicSlots.set(key, candidate); slot = candidate;
    }
    slot.bindings.set(generation.handle, handler);
    let cleanupPromise: Promise<void> | undefined;
    return () => cleanupPromise ??= Promise.resolve().then(async () => {
      slot!.bindings.delete(generation.handle);
      if (!slot!.bindings.size) {
        try {
          await slot!.release();
          if (publicSlots.get(key) === slot) publicSlots.delete(key);
        } catch (error) {
          slot!.cleanupError = String(error);
          throw error;
        }
      }
    });
  }
  function connectionFacade(generation: Generation, original: any): unknown {
    if (!original) return undefined;
    // A proxy of the real Service would inherit its Cordis tracker. Traceable
    // lookup can then read prototype descriptors directly and bypass our get
    // trap. Plain facades keep deferred methods authoritative at every level.
    const facade = (read: (key: string) => unknown) => new Proxy(Object.create(null), {
      get: (_target, key) => typeof key === 'string' ? read(key) : undefined,
    });
    const read = (target: any, key: string) => {
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    };
    const originalFetch = original.fetch;
    const originalRpc = original.rpc;
    const fetch = originalFetch && facade(key => {
      if (key === 'register') return (route: any) => {
        if (!route || typeof route.path !== 'string' || !Array.isArray(route.methods) || typeof route.fetch !== 'function') throw new NexusError('INVALID_ARGUMENT', '扩展 exact Fetch route 无效');
        if (route.path === '/api' || route.path === '/api/nexus/rpc') throw new NexusError('SCOPE_MISMATCH', '扩展不能抢占共享 Gateway/Nexus 路由');
        const label = `${[...route.methods].sort().join(',')} ${route.path}`;
        return deferred(generation, 'fetch-route', label, () => bindPublicSlot(generation, 'fetch-route', label, request => route.fetch(request), handler => originalFetch.register({ ...route, fetch: handler })));
      };
      return read(originalFetch, key);
    });
    const rpc = originalRpc && facade(key => {
      if (key === 'intercept') return () => { throw new NexusError('SCOPE_MISMATCH', '扩展暂存禁止抢占共享 /api interceptor；使用 exact 自有 channel'); };
      if (key === 'handle') return (channel: string, handler: unknown) => {
        if (channel === '/api' || channel === '/api/nexus/rpc' || !channel.startsWith('/')) throw new NexusError('SCOPE_MISMATCH', '扩展 RPC channel 必须为自有绝对路径');
        if (typeof handler !== 'function') throw new NexusError('INVALID_ARGUMENT', 'RPC handler 必须为函数');
        return deferred(generation, 'rpc-channel', channel, () => bindPublicSlot(generation, 'rpc-channel', channel, handler as (...args: any[]) => any, dispatch => originalRpc.handle(channel, dispatch)));
      };
      return read(originalRpc, key);
    });
    return facade(key => key === 'fetch' ? fetch : key === 'rpc' ? rpc : read(original, key));
  }
  async function stageClient(params: JsonRecord): Promise<ClientGeneration> {
    const owner = required(params, 'owner'); const generation = generationOf(params);
    const key = clientKey(owner, generation);
    const prior = clients.get(key);
    if (prior) return prior;
    const bridge = ctx.get('nexusExtensionClients');
    if (!bridge || typeof bridge.stage !== 'function') throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '当前宿主没有任意客户端模块 staging API；需要已注册的 Nexus 客户端代际桥，不能以 Host import 成功冒充浏览器就绪', { requiredService: 'nexusExtensionClients.stage', formalClientModulesApi: ['graph', 'clientPath', 'fetchBundle', 'rebuilt'], owner, generation });
    const staged = await bridge.stage({ owner, generation, entry: required(params, 'entry'), packageRoot: required(params, 'packageRoot'), signal: pluginSignal });
    if (!staged || staged.ready !== true || typeof staged.handle !== 'string' || typeof staged.commit !== 'function' || typeof staged.dispose !== 'function') {
      if (typeof staged?.dispose === 'function') await staged.dispose();
      throw new NexusError('CLIENT_STAGING_FAILED', '客户端桥必须返回真实 ready 回执与精确 commit/dispose 句柄');
    }
    const item: ClientGeneration = { owner, generation, handle: staged.handle, ready: true, commit: () => staged.commit(), dispose: () => staged.dispose(), facts: isRecord(staged.facts) ? staged.facts : {} };
    clients.set(key, item);
    return item;
  }
  async function disposeGeneration(item: Generation, reason: string): Promise<JsonRecord> {
    if (item.disposePromise) return item.disposePromise;
    if (item.state === 'disposed') return disposedReceipts.get(item.handle) ?? { handle: item.handle, disposed: true, idempotent: true };
    item.state = 'draining';
    item.disposePromise = Promise.resolve().then(async () => {
      for (const controller of item.calls) controller.abort();
      if (item.activeCalls) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            new Promise<void>(resolve => item.waiters.add(resolve)),
            new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new NexusError('DRAIN_TIMEOUT', '原生扩展调用尚未达到静止状态；保留精确泄漏记录', { owner: item.owner, generation: item.generation, activeCalls: item.activeCalls })), 30000); timer.unref(); }),
          ]);
        } catch (error) {
          await recordCleanupFailure(item, [{ resource: 'active-calls', error: String(error) }], reason);
          throw new NexusError('DRAIN_TIMEOUT', '调用未排空，精确句柄及资源继续保留', { handle: item.handle, errors: item.cleanupErrors });
        } finally { if (timer) clearTimeout(timer); }
      }
      const failures: JsonRecord[] = [];
      for (const registration of [...item.registrations].reverse()) {
        try { await releaseRegistration(registration); }
        catch (error) { failures.push({ resource: registration.id, type: registration.type, label: registration.label, error: String(error) }); }
      }
      try { await item.client?.dispose(); }
      catch (error) { failures.push({ resource: 'client', handle: item.client?.handle, error: String(error) }); }
      // Cordis owns child effects, including timers, nested fibers and services.
      // Failure of one cleanup must not skip the remaining independent owners.
      try { await item.fiber?.dispose(); }
      catch (error) { failures.push({ resource: 'cordis-fiber', fiberUid: item.fiber?.uid, error: String(error) }); }
      if (failures.length || item.cleanupErrors?.length) {
        await recordCleanupFailure(item, failures, reason);
        throw new NexusError('DISPOSAL_FAILED', '扩展代际清理失败，精确句柄及未知状态保留', { handle: item.handle, resources: resourceFacts(item), errors: item.cleanupErrors });
      }
      item.state = 'disposed';
      clients.delete(clientKey(item.owner, item.generation));
      if (active.get(item.owner) === item.handle) active.delete(item.owner);
      generations.delete(item.handle);
      const result = { handle: item.handle, owner: item.owner, generation: item.generation, disposed: true, reason, at: now(), fiberUid: item.fiber?.uid ?? null };
      disposedReceipts.set(item.handle, result);
      await receipt('disposed', item, { reason });
      return result;
    });
    return item.disposePromise;
  }
  async function activate(params: JsonRecord): Promise<unknown> {
    assertContext();
    const owner = required(params, 'owner'); const generation = generationOf(params);
    if (mutations.has(owner)) throw new NexusError('EXTENSION_BUSY', '该 owner 的代际正在变更');
    if ([...generations.values()].some(item => item.owner === owner && item.generation === generation)) throw new NexusError('REVISION_CONFLICT', 'owner/generation 已存在');
    const root = await fs.realpath(required(params, 'packageRoot'));
    const entry = await fs.realpath(required(params, 'entry'));
    if (!within(root, entry)) throw new NexusError('SCOPE_MISMATCH', '扩展入口不属于批准的 packageRoot');
    const info = await fs.stat(entry);
    if (!info.isFile() || info.size > 32 * 1024 * 1024 || !/\.[cm]?js$/i.test(entry)) throw new NexusError('FORMAT_UNSUPPORTED', '原生扩展需要受限大小的已构建 JavaScript 入口');
    const item: Generation = { handle: `extension-host:${randomUUID()}`, owner, generation, packageRoot: root, entry, entryHash: hash(await fs.readFile(entry)), state: 'preparing', registrations: [], activeCalls: 0, calls: new Set(), waiters: new Set(), resources: [] };
    mutations.add(owner); generations.set(item.handle, item);
    try {
      const moduleUrl = pathToFileURL(entry);
      moduleUrl.searchParams.set('nexus_generation', `${generation}-${item.entryHash}`);
      const loaded = await import(moduleUrl.href);
      const plugin: Plugin = (typeof loaded.default === 'function' || typeof loaded.default?.apply === 'function' ? loaded.default : loaded) as Plugin;
      if (typeof plugin !== 'function' && typeof (plugin as { apply?: unknown }).apply !== 'function') throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '原生扩展没有正式 Cordis function/class/apply 入口');
      const provides = [...new Set(['tools', 'connection', ...(Array.isArray((plugin as { provide?: unknown }).provide) ? (plugin as { provide: string[] }).provide : typeof (plugin as { provide?: unknown }).provide === 'string' ? [(plugin as { provide: string }).provide] : [])])];
      // The wrapper is itself a real plugin. All its nested providers and the
      // actual extension fiber are owned by this exact generation.
      const wrapper: Plugin = {
        name: `nexus-extension:${owner}:${generation}`,
        async apply(ownedContext: Context) {
          let scope = ownedContext as unknown as OfficialContext;
          for (const name of provides) scope = scope.isolate(name, Symbol(`nexus:${owner}:${generation}:${name}`));
          const originalConnection = ctx.get('connection');
          if (originalConnection) scope.provide('connection', connectionFacade(item, originalConnection));
          const toolsFiber = scope.plugin(ToolRuntime, { mode: 'native' });
          await assertActive(toolsFiber, '扩展独立工具注册表');
          item.tools = scope.get('tools');
          const extensionFiber = scope.plugin(plugin, params.config ?? {});
          await assertActive(extensionFiber, '扩展插件');
        },
      };
      item.fiber = ctx.plugin(wrapper);
      await assertActive(item.fiber, '扩展代际');
      if (params.clientEntry !== undefined) item.client = await stageClient({ ...params, entry: params.clientEntry });
      if (hash(await fs.readFile(entry)) !== item.entryHash) throw new NexusError('SOURCE_CHANGED', '插件加载过程中入口发生变化');
      item.state = 'staged';
      item.resources = resourceFacts(item);
      await receipt('staged', item, { moduleReload: 'unique-entry-url', dependencyCache: 'shared-package-dependencies; rebuild self-contained entry for transitive source changes' });
      return { handle: item.handle, owner, generation, ready: true, fiberState: item.fiber.state, clientReady: item.client?.ready ?? params.clientEntry === undefined, resources: item.resources, staged: true, toolSurfaceChanged: false, confinement: { osSandbox: false, trust: 'explicit-trusted-in-process', generationScopedTools: true, publicRoutesDeferredUntilCommit: true }, limitations: ['入口 URL 按代际更新；非打包的 ESM 传递模块仍受 Node 模块缓存约束，传递变更应先构建自包含入口', '原生插件任意直接进程/文件副作用属于已批准可信代码，暂存不是操作系统隔离'] };
    } catch (error) {
      item.state = 'failed';
      try { await disposeGeneration(item, 'activation-failed'); } catch (cleanupError) { services().emit('extensions.host.cleanup-failed', { owner, generation, error: String(cleanupError) }); }
      throw error;
    } finally { mutations.delete(owner); }
  }
  async function commit(params: JsonRecord): Promise<unknown> {
    const owner = required(params, 'owner'); const generation = generationOf(params);
    const item = typeof params.handle === 'string' ? resolveGeneration(params) : undefined;
    const client = item?.client ?? clients.get(clientKey(owner, generation));
    if (!item && !client) throw new NexusError('NOT_FOUND', '没有可提交的精确代际');
    const previous = active.get(owner);
    const prior = previous ? generations.get(previous) : undefined;
    if (params.previousGeneration !== undefined && prior?.generation !== params.previousGeneration) throw new NexusError('REVISION_CONFLICT', '提交时活动代际已变化');
    if (item?.state === 'active') return { handle: item.handle, committed: true, idempotent: true };
    if (item && (item.state !== 'staged' || item.cleanupErrors?.length)) throw new NexusError('GENERATION_NOT_STAGED', '仅可提交无清理失败的完整暂存代；失败候选需要新代际', { handle: item.handle, state: item.state, cleanupErrors: item.cleanupErrors });
    const installed: DeferredRegistration[] = [];
    try {
      for (const registration of item?.registrations ?? []) {
        if (registration.removed) continue;
        try {
          registration.dispose = await registration.install();
          if (typeof registration.dispose !== 'function') throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '宿主注册没有返回精确 disposer');
          installed.push(registration);
        } catch (error) {
          registration.cleanupError = String(error);
          installed.push(registration);
          throw error;
        }
      }
      if (client) await client.commit();
      if (item) { item.state = 'active'; active.set(owner, item.handle); await receipt('committed', item, { previousGeneration: prior?.generation ?? null }); }
      return { handle: item?.handle ?? client!.handle, owner, generation, committed: true, previousGeneration: prior?.generation ?? null, previousStillOwnedUntilDrain: !!prior, clientReady: client?.ready ?? true, toolSurfaceChanged: false };
    } catch (error) {
      // Restore routing before any awaited cleanup; a cleanup failure must not
      // strand the active pointer on a failed candidate.
      if (item && active.get(owner) === item.handle) {
        if (previous) active.set(owner, previous);
        else active.delete(owner);
      }
      const cleanupFailures: JsonRecord[] = [];
      for (const registration of installed.reverse()) {
        try { await releaseRegistration(registration); }
        catch (cleanupError) { cleanupFailures.push({ resource: registration.id, type: registration.type, label: registration.label, error: String(cleanupError) }); }
      }
      if (item) {
        item.state = 'failed';
        try {
          await receipt('commit-failed', item, { previousGeneration: prior?.generation ?? null, hostPointerRetained: active.get(owner) === previous, clientEffectState: client ? 'unknown-inspect-client-bridge-before-retry' : 'none', error: String(error), cleanupFailures });
        } catch (receiptError) {
          cleanupFailures.push({ resource: 'commit-failed-receipt', error: String(receiptError) });
        }
        if (cleanupFailures.length) await recordCleanupFailure(item, cleanupFailures, 'commit-rollback');
      }
      if (cleanupFailures.length) throw new NexusError('DISPOSAL_FAILED', '提交失败且回滚有未确认资源，所有独立清理均已尝试', { handle: item?.handle, owner, generation, originalError: String(error), cleanupFailures, clientEffectState: client ? 'unknown' : 'none' });
      throw error;
    }
  }
  function disposePreset(item: PresetRegistration): Promise<void> {
    if (item.disposePromise) return item.disposePromise;
    item.disposePromise = Promise.resolve().then(async () => {
      try {
        await item.fiber.dispose();
        presets.delete(item.handle);
      } catch (error) {
        item.cleanupError = String(error);
        const failure = { handle: item.handle, owner: item.owner, id: item.id, resource: 'preset-cordis-fiber', state: 'unknown', cleanupError: item.cleanupError, at: now() };
        try {
          const key = `preset:${item.handle}`;
          const previous = await services().store.get('extension-host-leaks', key);
          await services().store.put('extension-host-leaks', key, failure, previous?.revision ?? 0);
        } catch (receiptError) {
          services().emit('extensions.host.cleanup-receipt-failed', { ...failure, receiptError: String(receiptError) });
        }
        services().emit('extensions.host.cleanup-failed', failure);
        throw new NexusError('DISPOSAL_FAILED', '预设声明清理失败，精确 Fiber 句柄及未知状态保留', failure);
      }
    });
    return item.disposePromise;
  }
  async function registerPreset(params: JsonRecord): Promise<unknown> {
    assertContext();
    const owner = required(params, 'owner');
    const definition = params.definition;
    if (!isRecord(definition) || typeof definition.id !== 'string' || !Array.isArray(definition.plugins)) throw new NexusError('INVALID_ARGUMENT', '正式 preset 需要 id 和完整 plugins 组合');
    const handle = `preset-host:${randomUUID()}`;
    let registrationObserved = false;
    const plugin: Plugin = {
      name: `nexus-preset-declaration:${definition.id}`,
      inject: ['agentPresets'],
      async apply(presetContext: Context) {
        const registry = presetContext.get('agentPresets') as { register(value: JsonRecord): Promise<() => unknown> | (() => unknown) } | undefined;
        if (!registry || typeof registry.register !== 'function') return missing('agentPresets.register');
        const release = await registry.register(definition);
        if (typeof release !== 'function') throw new NexusError('PRESET_REGISTRATION_UNVERIFIED', 'agentPresets.register 未返回精确 disposer');
        registrationObserved = true;
        return async () => { await release(); };
      },
    };
    const fiber = ctx.plugin(plugin);
    const item: PresetRegistration = { handle, owner, id: definition.id, definitionHash: hash(JSON.stringify(definition)), fiber, createdAt: now() };
    presets.set(handle, item);
    try {
      await assertActive(fiber, '预设声明');
      if (!registrationObserved) throw new NexusError('PRESET_REGISTRATION_UNVERIFIED', '预设声明尚未通过真实 registry.register');
      return { handle, owner, id: item.id, registered: true, fiberState: fiber.state, definitionHash: item.definitionHash, ownership: 'exact-declaration-fiber', existingSessionGenerationsPreserved: true };
    } catch (error) {
      try { await disposePreset(item); }
      catch (cleanupError) { throw new NexusError('DISPOSAL_FAILED', '预设注册失败且清理未确认，精确句柄继续保留', { handle, owner, id: item.id, originalError: String(error), cleanupError: String(cleanupError) }); }
      throw error;
    }
  }
  async function call(action: string, params: JsonRecord): Promise<unknown> {
    switch (action) {
      case 'extensions.activate': return activate(params);
      case 'extensions.commit': return commit(params);
      case 'extensions.dispose': {
        if (typeof params.handle === 'string' && disposedReceipts.has(params.handle)) return { ...disposedReceipts.get(params.handle), idempotent: true };
        return disposeGeneration(resolveGeneration(params), 'owner-request');
      }
      case 'extensions.call': {
        const item = resolveGeneration(params);
        if (!['staged', 'active'].includes(item.state) || !item.tools) throw new NexusError('GENERATION_DRAINING', '该代际不可接受新调用');
        const name = required(params, 'name');
        if (!item.tools.get(name)) throw new NexusError('NOT_FOUND', '扩展工具不存在于精确代际', { name });
        const controller = new AbortController(); const signal = AbortSignal.any([controller.signal, pluginSignal]);
        item.calls.add(controller); item.activeCalls++;
        try {
          const result = await item.tools.execute({ callId: `nexus-extension:${randomUUID()}` as any, name, arguments: params.args ?? {}, signal });
          if (result.isError) throw new NexusError(result.error.info?.code ?? 'EXTENSION_CALL_FAILED', result.error.message, { owner: item.owner, generation: item.generation });
          return result.value;
        } finally { item.calls.delete(controller); item.activeCalls--; if (!item.activeCalls) { for (const resolve of item.waiters) resolve(); item.waiters.clear(); } }
      }
      case 'extensions.health': {
        const item = resolveGeneration(params);
        if (item.fiber) await assertActive(item.fiber, '扩展代际');
        return { handle: item.handle, ready: ['staged', 'active'].includes(item.state), state: item.state, activeCalls: item.activeCalls, fiberState: item.fiber?.state, resources: resourceFacts(item), evidence: 'actual-cordis-fiber-and-tool-registry' };
      }
      case 'extensions.cleanup': {
        const owner = required(params, 'owner'); const generation = generationOf(params);
        const target = [...generations.values()].find(item => item.owner === owner && item.generation === generation);
        if (!target) return { owner, generation, status: 'not-found', residualState: 'unknown-unless-prior-disposal-receipt', observedHandles: [] };
        if (active.get(owner) === target.handle) throw new NexusError('ACTIVE_GENERATION', '不能清理活动代际');
        return disposeGeneration(target, 'exact-generation-cleanup');
      }
      case 'extensions.client.stage': {
        const client = await stageClient(params);
        return { handle: client.handle, owner: client.owner, generation: client.generation, ready: client.ready, facts: client.facts };
      }
      case 'extensions.client.dispose': {
        const key = clientKey(required(params, 'owner'), generationOf(params));
        const client = clients.get(key);
        if (!client) return { disposed: false, state: 'not-found', idempotent: true };
        await client.dispose(); clients.delete(key); return { disposed: true, handle: client.handle };
      }
      case 'extensions.install': {
        const profile = ctx.get('profileContext')?.name;
        if (typeof params.profile === 'string' && profile && params.profile !== profile) throw new NexusError('SCOPE_MISMATCH', '当前 Plugin Manager 只能管理当前 profile');
        const manager = ctx.get('pluginManager');
        if (typeof manager?.installBundle !== 'function') missing('pluginManager.installBundle');
        const source = typeof params.source === 'string' ? params.source : required(params, 'spec');
        // The built-in manager owns launcher runtime, package locks and compatibility.
        // enabled:false prevents a second composition from double-activating this generation.
        const result = await manager.installBundle(source, { enabled: false, saveExact: true, requestId: typeof params.requestId === 'string' ? params.requestId : `nexus-extension:${randomUUID()}` });
        if (result?.application === 'failed' || result?.application === 'cancelled') throw new NexusError('HOST_INSTALL_FAILED', '官方 Plugin Manager 未完成安装', result);
        return { managerResult: result, compositionEnabled: false, lifecycleScriptsApproved: false, directProfileWrites: false, generationActivationOwner: 'nexus-extension-bridge' };
      }
      case 'extensions.uninstall': {
        const profile = ctx.get('profileContext')?.name;
        if (typeof params.profile === 'string' && profile && params.profile !== profile) throw new NexusError('SCOPE_MISMATCH', '只能管理当前 profile');
        const manager = ctx.get('pluginManager');
        if (typeof manager?.removeBundle !== 'function') missing('pluginManager.removeBundle');
        return manager.removeBundle(typeof params.packageId === 'string' ? params.packageId : required(params, 'name'));
      }
      case 'presets.register': return registerPreset(params);
      case 'presets.unregister': {
        const handle = required(params, 'handle'); const item = presets.get(handle);
        if (!item) return { handle, unregistered: false, idempotent: true };
        if (params.owner !== item.owner) throw new NexusError('SCOPE_MISMATCH', '预设句柄不属于该 owner');
        await disposePreset(item);
        return { handle, id: item.id, unregistered: true, existingSessionGenerationsPreserved: true };
      }
      case 'extensions.restore': await restore(); return { restoreRequested: true };
      default: throw new NexusError('UNKNOWN_ACTION', `扩展桥不拥有 ${action}`);
    }
  }
  async function restore(): Promise<void> {
    if (restorePromise) return restorePromise;
    const attempt = ++restoreAttempt;
    let degraded = false;
    restorePromise = (async () => {
      // Only domain records with explicit persistent/restoreTemporary intent are
      // selected. This exact restore grant cannot approve a new installation or
      // execution: the domains still enforce their previously stored grants.
      const domains = ['presets', 'extensions'] as const;
      const requestIds = domains.map(domain => `${restoreRuntimeId}:${domain}:${attempt}`);
      const results = await Promise.allSettled(domains.map(async (domain, index) => {
        assertContext();
        if (restoredDomains.has(domain)) return { alreadyRestored: true };
        return services().invoke(domain, { action: 'restore', requestId: requestIds[index], params: {} }, {
          actorId: restoreRuntimeId,
          workspaceRoot: services().workspaceRoot,
          signal: pluginSignal,
          permissions: new Set([`${domain}.restore`]),
        });
      }));
      const facts = results.map((result, index): JsonRecord => {
        const domain = domains[index];
        const failures = result.status === 'rejected' ? [{ error: String(result.reason) }]
          : isRecord(result.value) && Array.isArray(result.value.failures) ? result.value.failures : [];
        const state = failures.length ? 'degraded' : 'restored';
        if (state === 'restored') restoredDomains.add(domain);
        else degraded = true;
        const fact = {
          domain, requestId: requestIds[index], runtimeId: restoreRuntimeId, attempt,
          state, status: result.status, failures,
          ...(result.status === 'fulfilled' ? { result: result.value } : {}),
        };
        services().emit('extensions.restore.domain', fact);
        return fact;
      });
      services().emit('extensions.restore.completed', {
        runtimeId: restoreRuntimeId, attempt, state: degraded ? 'degraded' : 'restored',
        results: facts, failures: facts.filter(fact => fact.state === 'degraded'),
      });
      if (degraded) ctx.logger?.warn('Nexus persisted declarations partially restored; see extensions.restore.domain facts');
    })().catch(error => { restorePromise = undefined; throw error; }).finally(() => {
      // A later explicit retry is a new intent; concurrent callers above share
      // one request ID, while dispatcher-cached partial results are not replayed.
      if (degraded) restorePromise = undefined;
    });
    return restorePromise;
  }
  const onAbort = () => { void dispose().catch(error => ctx.logger?.error('Nexus extension bridge disposal failed', String(error))); };
  pluginSignal.addEventListener('abort', onAbort, { once: true });
  async function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    disposed = true; pluginSignal.removeEventListener('abort', onAbort);
    disposePromise = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        ...[...generations.values()].map(item => disposeGeneration(item, 'bridge-dispose')),
        ...[...presets.values()].map(item => disposePreset(item)),
        ...[...clients.entries()].filter(([key]) => ![...generations.values()].some(item => clientKey(item.owner, item.generation) === key)).map(async ([key, client]) => { await client.dispose(); clients.delete(key); }),
      ]);
      const failures = results.filter(result => result.status === 'rejected') as PromiseRejectedResult[];
      if (failures.length) throw new NexusError('DISPOSAL_FAILED', '扩展桥有未完成清理', { errors: failures.map(result => String(result.reason)) });
    });
    return disposePromise;
  }
  return { handles: action => actions.has(action), call, restore, dispose };
}
