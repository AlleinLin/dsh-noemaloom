import type { ClientContext } from './types.js';

type Data = Record<string, any>;
interface Artifact { key: string; name: string; hash: string; integrity: string; url: string }
interface Manifest {
  handle: string; owner: string; generation: number; packageId: string; digest: string;
  release: { version: string; commit: string }; dependencies: string[]; entry: string;
  artifacts: Artifact[]; config: Data;
}
interface Resource {
  kind: string; label: string; removed: boolean;
  install(): any; release?: () => any; cleanupError?: string;
}
interface ModuleRecord { artifact: Artifact; factory?: (require: any) => any; exports?: any; loaded: boolean; loading: boolean; script?: HTMLScriptElement }
interface Generation {
  manifest: Manifest; state: 'loading' | 'staged' | 'committing' | 'active' | 'paused' | 'disposed' | 'failed';
  modules: Map<string, ModuleRecord>; shared: Map<string, any>; resources: Resource[];
  observers: Array<() => any>;
  cleanupErrors: string[];
  fiber?: any; pluginFiber?: any; previousHandle?: string; scope?: any;
}
interface BundleRequire { (specifier: string): any; async(specifier: string): Promise<any> }
interface Command { id: string; kind: 'stage' | 'commit' | 'rollback' | 'dispose'; handle: string; digest: string; manifest?: Manifest; previousHandle?: string }
interface Registry {
  owners: Map<string, { generation: Generation; module: ModuleRecord; bridge: Bridge }>;
  window(key: string): Window;
}
interface Bridge { scopedWindow(generation: Generation, module: ModuleRecord): Window }

const CHANNEL = '/nexus-extension-clients';
const GLOBAL = '__DSH_NEXUS_EXTENSION_BUNDLES__';
const object = (value: unknown): Data => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const fail = (message: string): never => { throw new Error(message); };
const exactRelease = (a: Data, b: Data) => typeof a.version === 'string' && typeof a.commit === 'string' && a.version === b.version && a.commit === b.commit;
const disposer = (value: any): (() => any) => typeof value === 'function' ? value
  : typeof value?.dispose === 'function' ? () => value.dispose()
    : fail('注册服务没有返回精确 disposer');
async function bounded<T>(work: PromiseLike<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(work), new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时；状态须继续对账`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/**
 * Applied as an effect of the real Nexus client contribution. The official
 * ctx.modules resolver supplies all shared exports, including the one React and
 * Cordis instances. Captured package factories have separate owner generations;
 * no private official module cache, registry map or Loader entry is modified.
 */
export function applyExtensionClientBridge(context: ClientContext): () => Promise<void> {
  const ctx = context as any;
  const pageId = crypto.randomUUID();
  const bootRelease = structuredClone(object((globalThis as any).__DSH_BOOT__?.release));
  const generations = new Map<string, Generation>();
  const active = new Map<string, string>();
  const results = new Map<string, Data>();
  const requests = new Map<string, Promise<Data>>();
  const controller = new AbortController();
  const modules = ctx.modules ?? ctx.get?.('modules');
  const registryRoot = globalThis as any;
  let registry = registryRoot[GLOBAL] as Registry | undefined;
  if (!registry) {
    registry = {
      owners: new Map(),
      window(key) {
        const record = this.owners.get(key);
        if (!record) throw new Error('未授权的 Nexus 客户端构件');
        return record.bridge.scopedWindow(record.generation, record.module);
      },
    };
    registryRoot[GLOBAL] = registry;
  }
  const ownedRegistry = registry;
  let token: string | undefined;
  let registered = false;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  let lastFailure: string | undefined;
  const publicFacts = (generation: Generation) => generation.resources.filter(resource => !resource.removed || resource.cleanupError)
    .map(resource => ({ kind: resource.kind, label: resource.label, installed: !!resource.release, cleanupError: resource.cleanupError }));

  async function rpc(endpoint: string, payload: Data, signal?: AbortSignal): Promise<any> {
    const result = await ctx.connection.rpc.call(CHANNEL, endpoint, payload, signal);
    if (!result || result.ok !== true) throw new Error(result?.error?.message ?? '客户端代际桥协议失败');
    return result.value;
  }
  function defer(generation: Generation, kind: string, label: string, install: () => any): () => any {
    if (generation.state === 'disposed' || generation.state === 'failed') throw new Error('客户端代际已停止');
    const resource: Resource = { kind, label, install, removed: false };
    generation.resources.push(resource);
    if (generation.state === 'active' || generation.state === 'committing') {
      const result = install();
      if (typeof result !== 'function' && result && typeof result.then === 'function') throw new Error('运行期间异步注册公开席位需要新一代 staging');
      resource.release = disposer(result);
    }
    return () => {
      if (resource.removed) return;
      resource.removed = true;
      const release = resource.release;
      if (!release) return;
      try {
        const result = release();
        if (result && typeof result.then === 'function') return Promise.resolve(result).then(
          () => { resource.release = undefined; },
          error => { resource.cleanupError = String(error); throw error; });
        resource.release = undefined;
        return result;
      } catch (error) { resource.cleanupError = String(error); throw error; }
    };
  }
  function scopedService(generation: Generation, service: any, name: string, methods: string[]): any {
    // A real Service proxy carries Cordis' tracker. Re-providing it lets Cordis
    // recover prototype descriptors and bypass our get trap. This facade has no
    // Service prototype/tracker and never forwards framework symbols.
    return new Proxy(Object.create(null), {
      get(_target, key) {
        if (typeof key !== 'string') return undefined;
        if (name === 'slots' && ['install', 'installLocale', 'installScope', 'bindStoreScope'].includes(key)
          || name === 'locale' && key === 'setLocale') {
          return () => { throw new Error('扩展候选不能修改共享席位基础设施或用户全局语言偏好'); };
        }
        if (methods.includes(key)) {
          return (...args: any[]) => defer(generation, name, `${key}:${String(args[0]?.id ?? args[0]?.key ?? args[0]?.name ?? args[0] ?? '')}`,
            () => service[key](...args));
        }
        const observing = name === 'slots' ? ['subscribe', 'onEntryError'] : ['subscribe'];
        if (observing.includes(key)) return (...args: any[]) => {
          const release = disposer(service[key](...args));
          let removed = false;
          const exact = () => {
            if (removed) return;
            removed = true;
            try {
              const result = release();
              if (result && typeof result.then === 'function') return Promise.resolve(result).catch(error => {
                generation.cleanupErrors.push(`observer:${String(error)}`); throw error;
              });
              return result;
            } catch (error) { generation.cleanupErrors.push(`observer:${String(error)}`); throw error; }
          };
          generation.observers.push(exact);
          return exact;
        };
        const reading = name === 'slots' ? ['renderSlot', 'entries', 'entriesOfSlot', 'snapshot', 'spec', 'getVersion']
          : ['getLocale', 'getSnapshot', 'resolveText', 'bind'];
        if (!reading.includes(key)) return undefined;
        const value = Reflect.get(service, key, service);
        return typeof value === 'function' ? value.bind(service) : value;
      },
    });
  }
  function scopedDocument(generation: Generation): Document {
    const nodes = new Map<Node, () => any>();
    const isStyle = (node: Node) => node instanceof HTMLStyleElement || node instanceof HTMLLinkElement && node.rel === 'stylesheet';
    function parentFacade(parent: HTMLElement): HTMLElement {
      return new Proxy(parent, {
        get(target, key) {
          if (key === 'appendChild' || key === 'insertBefore') return (node: Node, next?: Node | null) => {
            if (!isStyle(node)) return key === 'appendChild' ? target.appendChild(node) : target.insertBefore(node, next ?? null);
            const remove = defer(generation, 'style', node instanceof HTMLLinkElement ? node.href : `inline:${generation.resources.length}`, () => {
              target.insertBefore(node, next?.parentNode === target ? next : null);
              return () => { if (node.parentNode === target) target.removeChild(node); };
            });
            nodes.set(node, remove);
            return node;
          };
          if (key === 'append' || key === 'prepend') return (...children: Array<Node | string>) => {
            for (const child of children) {
              if (typeof child === 'string' || !isStyle(child)) {
                key === 'append' ? target.append(child) : target.prepend(child);
              } else {
                const remove = defer(generation, 'style', `inline:${generation.resources.length}`, () => {
                  key === 'append' ? target.append(child) : target.prepend(child);
                  return () => { if (child.parentNode === target) target.removeChild(child); };
                });
                nodes.set(child, remove);
              }
            }
          };
          if (key === 'removeChild') return (node: Node) => {
            const remove = nodes.get(node);
            if (remove) { remove(); nodes.delete(node); return node; }
            return target.removeChild(node);
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }
    const head = parentFacade(document.head), body = document.body ? parentFacade(document.body) : undefined;
    return new Proxy(document, {
      get(target, key) {
        if (key === 'head') return head;
        if (key === 'body' && body) return body;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  const bridge: Bridge = {
    scopedWindow(generation, module) {
      if (generation.state === 'disposed') throw new Error('客户端构件所属代际已释放');
      const loader = {
        load(registration: Data) {
          if (module.factory || typeof registration?.factory !== 'function') throw new Error('每个客户端构件必须精确注册一次 factory');
          if (registration.id !== generation.manifest.packageId) throw new Error('客户端 factory id 与批准的包名不一致');
          if (module.artifact.name === generation.manifest.entry ? registration.chunk !== undefined : registration.chunk !== module.artifact.name) {
            throw new Error('客户端 factory chunk 与冻结构件名称不一致');
          }
          module.factory = registration.factory;
        },
      };
      const doc = scopedDocument(generation);
      return new Proxy(window, {
        get(target, key) {
          if (key === '__ModuleLoader__') return loader;
          if (key === 'document') return doc;
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
  async function loadScript(generation: Generation, module: ModuleRecord): Promise<void> {
    if (module.factory) return;
    const url = new URL(module.artifact.url, document.baseURI);
    if (url.origin !== location.origin || !url.pathname.endsWith('/api/nexus/extension-client-bundle')) throw new Error('客户端构件 URL 超出已认证的同源精确路由');
    await new Promise<void>((resolveLoaded, reject) => {
      const script = document.createElement('script');
      module.script = script;
      script.src = url.href;
      script.integrity = module.artifact.integrity;
      script.async = true;
      const timer = setTimeout(() => finish(new Error('客户端构件下载超时')), 20_000);
      const abort = () => finish(new Error('客户端构件加载已取消'));
      const finish = (error?: Error) => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', abort);
        script.onload = null; script.onerror = null;
        if (error) { script.remove(); reject(error); } else resolveLoaded();
      };
      script.onload = () => finish(module.factory ? undefined : new Error('客户端脚本未注册所批准的 factory'));
      script.onerror = () => finish(new Error('客户端脚本下载、完整性校验或执行失败'));
      controller.signal.addEventListener('abort', abort, { once: true });
      document.head.appendChild(script);
      if (controller.signal.aborted) abort();
    });
    if (generation.state === 'disposed') throw new Error('构件到达时该客户端代际已经释放');
  }
  function materialize(generation: Generation, module: ModuleRecord): any {
    if (module.loaded) return module.exports;
    if (!module.factory || module.loading) throw new Error(module.loading ? '客户端同步 require 出现循环' : '客户端 factory 尚未加载');
    module.loading = true;
    const require: BundleRequire = Object.assign((specifier: string) => {
      const normalized = specifier.endsWith('/client') ? specifier.slice(0, -7) : specifier;
      if (normalized === generation.manifest.packageId) return materialize(generation, generation.modules.get(generation.manifest.entry)!);
      if (generation.shared.has(specifier)) return generation.shared.get(specifier);
      if (generation.shared.has(normalized)) return generation.shared.get(normalized);
      throw new Error(`未声明或未预加载的共享模块：${specifier}`);
    }, {
      async: async (specifier: string) => {
        if (/^\.\/client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(specifier)) {
          const chunk = generation.modules.get(specifier.slice(2));
          if (!chunk) throw new Error(`异步构件不属于冻结 manifest：${specifier}`);
          await loadScript(generation, chunk);
          return materialize(generation, chunk);
        }
        return require(specifier);
      },
    });
    try { module.exports = module.factory(require); module.loaded = true; return module.exports; }
    finally { module.loading = false; }
  }
  async function releasePublic(generation: Generation): Promise<void> {
    const errors: string[] = [];
    for (const resource of [...generation.resources].reverse()) {
      if (resource.cleanupError) { errors.push(resource.cleanupError); continue; }
      const release = resource.release;
      try { await release?.(); resource.release = undefined; }
      catch (error) { resource.cleanupError = String(error); errors.push(String(error)); }
    }
    if (errors.length) throw new Error(`公开席位释放尚未完成：${errors.join('; ')}`);
  }
  async function installPublic(generation: Generation): Promise<void> {
    generation.state = 'committing';
    // inject() callbacks can append their register() contribution here.
    for (let index = 0; index < generation.resources.length; index++) {
      const resource = generation.resources[index];
      if (resource.cleanupError) throw new Error(`席位先前清理未确认：${resource.cleanupError}`);
      if (resource.removed || resource.release) continue;
      const result = resource.install();
      resource.release = disposer(typeof result === 'function' ? result : await result);
    }
  }
  async function disposeGeneration(generation: Generation): Promise<void> {
    if (generation.state === 'disposed') return;
    generation.state = 'paused';
    const errors: string[] = [...generation.cleanupErrors];
    try { await releasePublic(generation); } catch (error) { errors.push(String(error)); }
    try { if (generation.fiber) await bounded(generation.fiber.dispose(), 10_000, '客户端 Fiber 释放'); }
    catch (error) { generation.cleanupErrors.push(`fiber:${String(error)}`); errors.push(String(error)); }
    for (const release of generation.observers.splice(0).reverse()) {
      try { await release(); } catch (error) { errors.push(String(error)); }
    }
    for (const module of generation.modules.values()) {
      module.script?.remove();
      ownedRegistry.owners.delete(module.artifact.key);
      module.factory = undefined; module.exports = undefined;
    }
    generation.shared.clear();
    if (errors.length) { generation.state = 'failed'; throw new Error(`客户端精确释放失败：${errors.join('; ')}`); }
    generation.state = 'disposed';
    generation.resources.length = 0;
    generation.modules.clear();
    generation.scope = undefined;
    generation.pluginFiber = undefined;
    generation.fiber = undefined;
    if (active.get(generation.manifest.owner) === generation.manifest.handle) active.delete(generation.manifest.owner);
  }
  async function stage(manifest: Manifest): Promise<Generation> {
    const old = generations.get(manifest.handle);
    if (old) {
      if (old.manifest.digest !== manifest.digest || !['staged', 'active', 'paused'].includes(old.state)) throw new Error('客户端已有不兼容或未完成的代际');
      return old;
    }
    if (!exactRelease(bootRelease, manifest.release)) throw new Error('页面与扩展 manifest 的 Host release 不匹配，请刷新');
    if (typeof modules?.import !== 'function' || typeof ctx.plugin !== 'function' || typeof ctx.isolate !== 'function') {
      throw new Error('正式 ctx.modules.import / Cordis plugin/isolate 服务不可用');
    }
    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length > 128 || !Array.isArray(manifest.dependencies)) throw new Error('客户端构件 manifest 无效');
    const generation: Generation = { manifest, state: 'loading', modules: new Map(), shared: new Map(), resources: [], observers: [], cleanupErrors: [] };
    generations.set(manifest.handle, generation);
    try {
      for (const artifact of manifest.artifacts) {
        if (!artifact.key || !/^[a-f0-9]{64}$/.test(artifact.hash) || !artifact.integrity.startsWith('sha256-') || generation.modules.has(artifact.name)) throw new Error('客户端构件摘要或名称无效');
        const module: ModuleRecord = { artifact, loaded: false, loading: false };
        generation.modules.set(artifact.name, module);
        ownedRegistry.owners.set(artifact.key, { generation, module, bridge });
      }
      const entry = generation.modules.get(manifest.entry);
      if (!entry) throw new Error('冻结 manifest 缺少入口');
      // Import from the official system rather than bundling another React or
      // inventing a synchronous public require API.
      const dependencies = await bounded(Promise.all(manifest.dependencies.map(async specifier => [specifier, await modules.import(specifier)] as const)), 20_000, '共享模块解析');
      for (const [specifier, exports] of dependencies) generation.shared.set(specifier, exports);
      await loadScript(generation, entry);
      const exports = materialize(generation, entry);
      const plugin = typeof exports?.default === 'function' || typeof exports?.default?.apply === 'function' ? exports.default : exports;
      if (typeof plugin !== 'function' && typeof plugin?.apply !== 'function') throw new Error('客户端包未导出正式 Cordis plugin');
      const provided = Array.isArray(plugin.provide) ? plugin.provide : typeof plugin.provide === 'string' ? [plugin.provide] : [];
      if (provided.some((name: string) => ['slots', 'locale', 'modules', 'connection'].includes(name))) throw new Error('扩展不能替换共享客户端基础服务');
      const wrapper = {
        name: `nexus-extension-client:${manifest.owner}:${manifest.generation}`,
        async apply(owned: any) {
          let scope = owned;
          for (const name of ['slots', 'locale', ...provided]) scope = scope.isolate(name, Symbol(`nexus-client:${manifest.handle}:${name}`));
          const slots = ctx.slots ?? ctx.get?.('slots'), locale = ctx.locale ?? ctx.get?.('locale');
          if (slots) scope.provide('slots', scopedService(generation, slots, 'slots', ['register', 'inject', 'registerFactory', 'provideRoot']));
          if (locale) scope.provide('locale', scopedService(generation, locale, 'locale', ['register', 'addLanguage']));
          generation.scope = scope;
          const fiber = scope.plugin(plugin, manifest.config ?? {});
          generation.pluginFiber = fiber;
          await bounded(fiber.await(), 15_000, '客户端插件启动');
          if (fiber.uid === null || fiber.state !== 2) throw new Error(`扩展客户端 Fiber 未达到 ACTIVE，state=${fiber.state}`);
          if (typeof exports.nexusHealth === 'function') {
            const result = await bounded(Promise.resolve(exports.nexusHealth({ ctx: scope, owner: manifest.owner, generation: manifest.generation, staged: true })), 10_000, '客户端健康检查');
            if (result === false || result?.ok === false) throw new Error(`扩展客户端健康检查失败：${String(result?.error ?? 'nexusHealth=false')}`);
          }
        },
      };
      generation.fiber = ctx.plugin(wrapper);
      await bounded(generation.fiber.await(), 20_000, '客户端代际启动');
      if (generation.fiber.uid === null || generation.fiber.state !== 2) throw new Error('客户端代际包装 Fiber 尚未 ACTIVE');
      generation.state = 'staged';
      return generation;
    } catch (error) {
      try { await disposeGeneration(generation); } catch { generation.state = 'failed'; }
      throw error;
    }
  }
  async function commit(generation: Generation, previousHandle?: string): Promise<void> {
    if (generation.state === 'active') return;
    if (!['staged', 'paused'].includes(generation.state)) throw new Error('客户端候选尚未就绪');
    if (generation.fiber?.state !== 2 || generation.pluginFiber?.state !== 2) throw new Error('客户端依赖或 Fiber 状态已经改变，请重新 staging');
    const prior = generations.get(previousHandle ?? active.get(generation.manifest.owner) ?? '');
    generation.previousHandle = prior?.manifest.handle;
    try {
      if (prior && prior !== generation) { prior.state = 'paused'; await releasePublic(prior); }
      await installPublic(generation);
      generation.state = 'active';
      active.set(generation.manifest.owner, generation.manifest.handle);
    } catch (error) {
      const failures = [String(error)];
      try { await releasePublic(generation); } catch (cleanupError) { failures.push(String(cleanupError)); }
      generation.state = 'staged';
      if (prior && prior !== generation) {
        try { await installPublic(prior); prior.state = 'active'; active.set(prior.manifest.owner, prior.manifest.handle); }
        catch (restoreError) { prior.state = 'failed'; active.delete(prior.manifest.owner); failures.push(String(restoreError)); }
      }
      if (failures.length > 1) generation.state = 'failed';
      throw new Error(failures.join('; '));
    }
  }
  async function execute(command: Command): Promise<Data> {
    let generation = generations.get(command.handle);
    if (command.kind === 'stage') generation = await stage(command.manifest ?? fail('stage 命令缺少 manifest'));
    if (!generation) {
      if (command.kind === 'dispose') return { state: 'disposed', resources: [], absent: true };
      throw new Error('客户端找不到精确代际');
    }
    if (generation.manifest.digest !== command.digest) throw new Error('客户端命令与代际构件摘要不匹配');
    if (command.kind === 'commit') await commit(generation, command.previousHandle);
    if (command.kind === 'rollback') {
      const failures: string[] = [];
      if (generation.state !== 'disposed') {
        try { await releasePublic(generation); generation.state = 'staged'; }
        catch (error) { generation.state = 'failed'; failures.push(String(error)); }
        if (active.get(generation.manifest.owner) === generation.manifest.handle) active.delete(generation.manifest.owner);
      }
      const prior = generations.get(command.previousHandle ?? generation.previousHandle ?? '');
      if (prior && prior.state !== 'disposed') {
        try { await installPublic(prior); prior.state = 'active'; active.set(prior.manifest.owner, prior.manifest.handle); }
        catch (error) { prior.state = 'failed'; active.delete(prior.manifest.owner); failures.push(String(error)); }
      }
      if (failures.length) throw new Error(`客户端回滚尚未完整确认：${failures.join('; ')}`);
    }
    if (command.kind === 'dispose') await disposeGeneration(generation);
    return { state: generation.state, fiberState: generation.pluginFiber?.state ?? generation.fiber?.state, resources: publicFacts(generation) };
  }
  async function process(command: Command): Promise<Data> {
    const previous = results.get(command.id);
    if (previous) return previous;
    const pending = requests.get(command.id);
    if (pending) return pending;
    const work = (async () => {
      let result: Data;
      try { result = { ok: true, ...await execute(command) }; }
      catch (error) { result = { ok: false, state: generations.get(command.handle)?.state ?? 'unknown', error: String(error) }; }
      const ack = { pageId, token, commandId: command.id, handle: command.handle, digest: command.digest, ...result };
      results.set(command.id, ack);
      return ack;
    })().finally(() => requests.delete(command.id));
    requests.set(command.id, work);
    return work;
  }
  async function pause(milliseconds: number) {
    if (controller.signal.aborted) return;
    await new Promise<void>(resolvePause => {
      const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolvePause(); };
      const timer = setTimeout(done, milliseconds);
      controller.signal.addEventListener('abort', done, { once: true });
    });
  }
  const loop = (async () => {
    let retry = 1000;
    while (!controller.signal.aborted) {
      try {
        if (!registered) {
          const hello = await rpc('hello', { pageId, token, release: bootRelease,
            inventory: [...generations.values()].filter(item => item.state !== 'disposed').map(item => ({ handle: item.manifest.handle, digest: item.manifest.digest })) }, controller.signal);
          token = hello.token;
          registered = true;
          for (const handle of hello.retireHandles ?? []) {
            const item = generations.get(handle);
            if (item) await disposeGeneration(item);
          }
        }
        const response = await rpc('poll', { pageId, token }, controller.signal);
        for (const command of response.commands ?? []) {
          if (controller.signal.aborted) break;
          const ack = await process(command);
          await rpc('ack', { ...ack, token }, controller.signal);
        }
        retry = 1000; lastFailure = undefined;
      } catch (error) {
        if (controller.signal.aborted) break;
        lastFailure = String(error);
        // Re-handshake after a carrier reset or Host restart. Local generations
        // remain owned until the new Host explicitly reconciles their inventory.
        registered = false;
        await pause(retry); retry = Math.min(5000, retry * 2);
      }
    }
  })();
  function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    disposed = true; controller.abort();
    disposePromise = (async () => {
      await loop;
      const settled = await Promise.allSettled([...generations.values()].map(disposeGeneration));
      const errors = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => String(result.reason));
      if (token) {
        const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 5000);
        try { await rpc('goodbye', { pageId, token, disposed: errors.length === 0,
          disposedHandles: [...generations.values()].filter(item => item.state === 'disposed').map(item => ({ handle: item.manifest.handle, digest: item.manifest.digest, state: item.state })) }, timeout.signal); }
        catch (error) { errors.push(`goodbye:${String(error)}`); }
        finally { clearTimeout(timer); }
      }
      for (const [key, owner] of ownedRegistry.owners) if (owner.bridge === bridge) ownedRegistry.owners.delete(key);
      if (!ownedRegistry.owners.size && registryRoot[GLOBAL] === ownedRegistry) delete registryRoot[GLOBAL];
      if (errors.length) throw new Error(`客户端代际清理未完全确认：${errors.join('; ')}`);
    })();
    return disposePromise;
  }
  // Expose only observability to the owning Cordis effect, never a fake ready
  // service or public activation API.
  ctx.effect(() => () => { if (!disposed) return dispose(); }, 'nexus extension client bridge fallback cleanup');
  return dispose;
}
