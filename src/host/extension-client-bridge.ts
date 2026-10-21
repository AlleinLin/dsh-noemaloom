import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { NexusError, type JsonRecord, type NexusServices } from '../ports/contracts.js';
import type { HostContext } from './types.js';

const CHANNEL = '/nexus-extension-clients';
const BUNDLE_ROUTE = '/api/nexus/extension-client-bundle';
const LEASE_MS = 45_000;
const ACK_MS = 30_000;
const PLATFORM = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod',
  '@tanstack/react-virtual', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit'];
const object = (value: unknown): JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const required = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value) throw new NexusError('INVALID_ARGUMENT', `${label} 必须为非空字符串`);
  return value;
};
interface Release { version: string; commit: string }
interface Artifact { key: string; name: string; hash: string; integrity: string; url: string; bytes: Buffer }
interface Manifest {
  handle: string; owner: string; generation: number; packageId: string; digest: string;
  release: Release; dependencies: string[]; entry: string;
  artifacts: Array<Omit<Artifact, 'bytes'>>; config: JsonRecord;
}
interface Command { id: string; kind: 'stage' | 'commit' | 'rollback' | 'dispose'; handle: string; digest: string; manifest?: Manifest; previousHandle?: string }
interface Page {
  id: string; token: string; release: Release; lastSeen: number; closed: boolean;
  pending: Map<string, Command>; wake?: () => void;
}
interface ClientGeneration {
  manifest: Manifest; artifacts: Artifact[]; pages: Set<string>; disposedPages: Set<string>;
  state: 'staging' | 'staged' | 'active' | 'unknown' | 'disposed';
  facts: JsonRecord;
}
interface Ack {
  pageId: string; commandId: string; handle: string; digest: string; ok: boolean;
  state: string; resources?: unknown[]; fiberState?: number; error?: string;
}
export interface ExtensionClientBridge {
  stage(params: { owner: string; generation: number; entry: string; packageRoot: string; signal?: AbortSignal; config?: JsonRecord }): Promise<{
    handle: string; ready: true; facts: JsonRecord; commit(): Promise<unknown>; dispose(): Promise<unknown>;
  }>;
  status(): JsonRecord;
  dispose(): Promise<void>;
}

/**
 * The normal Nexus contribution carries this protocol. Arbitrary packages never
 * impersonate Loader entries or mutate clientModules' private graph/table.
 * Readiness is a browser receipt, including its release, exact artifact digest,
 * page identity and actual Cordis Fiber state.
 */
export function createExtensionClientBridge(ctx: HostContext, getServices: () => NexusServices, signal: AbortSignal): ExtensionClientBridge {
  const pages = new Map<string, Page>();
  const generations = new Map<string, ClientGeneration>();
  const active = new Map<string, string>();
  const artifacts = new Map<string, Artifact>();
  const waiting = new Map<string, { pageId: string; command: Command; resolve(ack: Ack): void; reject(error: Error): void }>();
  const receipts = new Map<string, Ack>();
  const arrivals = new Set<() => void>();
  const inProgress = new Map<string, Promise<unknown>>();
  let closing = false;
  const connection = ctx.get('connection') as any;
  if (typeof connection?.rpc?.handle !== 'function' || typeof connection?.fetch?.register !== 'function') {
    throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '客户端代际桥需要正式 Connection RPC 和 exact Fetch 路由');
  }
  function release(): Release {
    const graph = ctx.get('clientModules')?.graph?.();
    const value = object(graph?.release);
    if (typeof value.version !== 'string' || typeof value.commit !== 'string') {
      throw new NexusError('CLIENT_RELEASE_UNVERIFIED', '正式 clientModules 尚未提供 Host release 身份');
    }
    return { version: value.version, commit: value.commit };
  }
  const sameRelease = (a: Release, b: Release) => a.version === b.version && a.commit === b.commit;
  const livePages = () => [...pages.values()].filter(page => !page.closed && Date.now() - page.lastSeen < LEASE_MS);
  async function evidence(operation: string, item: ClientGeneration, extra: JsonRecord = {}) {
    item.facts.state = item.state;
    const id = randomUUID();
    await getServices().store.put('extension-client-receipts', id, { id, operation, handle: item.manifest.handle,
      owner: item.manifest.owner, generation: item.manifest.generation, digest: item.manifest.digest,
      state: item.state, pages: [...item.pages], at: new Date().toISOString(), ...extra }, 0);
    getServices().emit('extensions.client', { operation, handle: item.manifest.handle, state: item.state, ...extra });
  }
  function verifyPage(params: JsonRecord): Page {
    const page = pages.get(required(params.pageId, 'pageId'));
    if (!page || page.closed || page.token !== params.token) throw new NexusError('CLIENT_PAGE_UNVERIFIED', '客户端页面凭据已失效');
    if (!sameRelease(page.release, release())) throw new NexusError('CLIENT_RELEASE_CHANGED', 'Host release 已改变，请刷新页面后再加载扩展');
    page.lastSeen = Date.now();
    return page;
  }
  function once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const pending = inProgress.get(key);
    if (pending) return pending as Promise<T>;
    const promise = work().finally(() => { if (inProgress.get(key) === promise) inProgress.delete(key); });
    inProgress.set(key, promise);
    return promise;
  }
  async function command(page: Page, item: ClientGeneration, kind: Command['kind'], previousHandle?: string): Promise<Ack> {
    const message: Command = { id: randomUUID(), kind, handle: item.manifest.handle, digest: item.manifest.digest,
      ...(kind === 'stage' ? { manifest: item.manifest } : {}), ...(previousHandle ? { previousHandle } : {}) };
    page.pending.set(message.id, message);
    const result = new Promise<Ack>((resolveAck, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(message.id);
        reject(new NexusError('CLIENT_ACK_UNKNOWN', '浏览器未确认精确代际操作，状态未知；已保留命令供重连对账', {
          pageId: page.id, handle: message.handle, commandId: message.id, kind,
        }));
      }, ACK_MS);
      timer.unref?.();
      waiting.set(message.id, { pageId: page.id, command: message,
        resolve(ack) { clearTimeout(timer); resolveAck(ack); },
        reject(error) { clearTimeout(timer); reject(error); } });
    });
    page.wake?.();
    const ack = await result;
    if (!ack.ok) throw new NexusError('CLIENT_OPERATION_FAILED', ack.error ?? '浏览器代际操作失败', { ...ack });
    if (kind === 'stage' && (ack.state !== 'staged' || ack.fiberState !== 2)) throw new NexusError('CLIENT_STAGING_UNVERIFIED', '浏览器未证明候选 Fiber ACTIVE 且席位隐藏', { ...ack });
    if (kind === 'commit' && ack.state !== 'active' || kind === 'dispose' && ack.state !== 'disposed') {
      throw new NexusError('CLIENT_OPERATION_UNVERIFIED', '浏览器回执未确认所请求状态', { ...ack });
    }
    return ack;
  }
  async function allPages(item: ClientGeneration, kind: Command['kind'], previousHandle?: string): Promise<Ack[]> {
    const results = await Promise.allSettled([...item.pages].map(async id => {
      const page = pages.get(id);
      if (!page || page.closed) throw new NexusError('CLIENT_ACK_UNKNOWN', '已绑定页面不再在线，无法证明释放或切换', { pageId: id, kind });
      return command(page, item, kind, previousHandle);
    }));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    const acks = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    if (failures.length) {
      item.state = 'unknown';
      await evidence(`${kind}-unknown`, item, { errors: failures.map(result => String(result.reason)), acks });
      throw new NexusError('CLIENT_ACK_UNKNOWN', '部分页面操作尚未得到完成证明', { kind, errors: failures.map(result => String(result.reason)), acks });
    }
    return acks;
  }
  async function disposeItem(item: ClientGeneration): Promise<unknown> {
    if (item.state === 'disposed') return { handle: item.manifest.handle, disposed: true, idempotent: true };
    return once(`dispose:${item.manifest.handle}`, async () => {
      const acks = await allPages(item, 'dispose');
      item.state = 'disposed';
      if (active.get(item.manifest.owner) === item.manifest.handle) active.delete(item.manifest.owner);
      for (const artifact of item.artifacts) artifacts.delete(artifact.key);
      item.artifacts.length = 0;
      await evidence('disposed', item, { acks });
      return { handle: item.manifest.handle, disposed: true, acks };
    });
  }
  async function commitItem(item: ClientGeneration): Promise<unknown> {
    return once(`commit:${item.manifest.handle}`, async () => {
      if (item.state === 'active') return { committed: true, handle: item.manifest.handle, idempotent: true };
      if (item.state !== 'staged') throw new NexusError('CLIENT_STATE_UNKNOWN', '候选客户端尚未在全部页面确认就绪，请先检查回执');
      const previous = active.get(item.manifest.owner);
      try {
        const acks = await allPages(item, 'commit', previous);
        active.set(item.manifest.owner, item.manifest.handle);
        item.state = 'active';
        await evidence('committed', item, { previousHandle: previous ?? null, acks });
        return { committed: true, handle: item.manifest.handle, acks };
      } catch (error) {
        // A distributed commit can become uncertain. Ask every page to restore
        // its exact previous contribution; retain all evidence on missing ACKs.
        try { await allPages(item, 'rollback', previous); item.state = 'staged'; }
        catch { item.state = 'unknown'; }
        await evidence('commit-failed', item, { previousHandle: previous ?? null, error: String(error) });
        throw error;
      }
    });
  }
  async function materialize(params: Parameters<ExtensionClientBridge['stage']>[0]): Promise<ClientGeneration> {
    const packageRoot = await realpath(params.packageRoot), entry = await realpath(params.entry);
    const rel = relative(packageRoot, entry);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new NexusError('SCOPE_MISMATCH', '客户端入口必须属于已批准扩展包');
    const manifestInfo = object(JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')));
    const packageId = required(manifestInfo.name, 'package.name');
    const declaration = object(object(manifestInfo.dsh).client);
    if (declaration.platform !== 'web') throw new NexusError('CLIENT_MANIFEST_REQUIRED', '原生客户端扩展须声明 dsh.client.platform=web');
    const handle = `extension-client:${randomUUID()}`, token = randomUUID();
    const candidates = [basename(entry), ...(await readdir(dirname(entry))).filter(name => /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(name) && name !== basename(entry))];
    if (candidates.length > 128) throw new NexusError('CLIENT_BUNDLE_LIMIT', '客户端构件超过 128 个');
    const outputs: Artifact[] = [];
    let total = 0;
    for (const name of candidates) {
      const file = resolve(dirname(entry), name), before = await lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > 16 * 1024 * 1024) throw new NexusError('CLIENT_BUNDLE_LIMIT', '客户端构件必须为不含链接的受限 JavaScript 文件');
      const source = await readFile(file, 'utf8'), after = await lstat(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new NexusError('SOURCE_CHANGED', '读取客户端构件期间内容改变');
      if (!source.includes('__ModuleLoader__') || !source.includes('factory')) throw new NexusError('CLIENT_BUNDLE_FORMAT', '客户端构件必须使用正式 ModuleLoader factory 形式');
      const key = `${token}:${name}`;
      // A lexical facade captures this one factory without mutating the official
      // loader/cache. Its require uses ctx.modules.import for every shared module.
      const wrapper = `(function(root){const bridge=root.__DSH_NEXUS_EXTENSION_BUNDLES__;if(!bridge)throw Error("Nexus client bridge missing");const window=bridge.window(${JSON.stringify(key)});const self=window;const globalThis=window;const document=window.document;\n${source.replace(/\/\/[#@]\s*sourceMappingURL=[^\r\n]*/g, '')}\n})(globalThis);\n`;
      const bytes = Buffer.from(wrapper);
      total += bytes.length;
      if (total > 64 * 1024 * 1024) throw new NexusError('CLIENT_BUNDLE_LIMIT', '客户端构件总计超过 64 MiB');
      outputs.push({ key, name, hash: sha(bytes), integrity: `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
        url: `${BUNDLE_ROUTE.slice(1)}?artifact=${encodeURIComponent(key)}&sha256=${sha(bytes)}`, bytes });
    }
    const dependencies = [...new Set([...PLATFORM, ...[declaration.external, declaration.inject]
      .flatMap(value => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])])];
    const hostRelease = release();
    const digest = sha(JSON.stringify({ packageId, owner: params.owner, generation: params.generation, release: hostRelease,
      artifacts: outputs.map(artifact => [artifact.name, artifact.hash]), dependencies, config: params.config ?? {} }));
    const manifest: Manifest = { handle, owner: params.owner, generation: params.generation, packageId, digest, release: hostRelease,
      dependencies, entry: basename(entry), artifacts: outputs.map(({ bytes: _bytes, ...artifact }) => artifact), config: params.config ?? {} };
    return { manifest, artifacts: outputs, pages: new Set(), disposedPages: new Set(), state: 'staging',
      facts: { handle, digest, packageId, release: hostRelease, pages: [], evidence: 'browser-fiber-ack-required', publicContributionsHiddenUntilCommit: true } };
  }
  async function stage(params: Parameters<ExtensionClientBridge['stage']>[0]) {
    if (closing || signal.aborted) throw new NexusError('DISPOSED', '客户端代际桥已关闭');
    required(params.owner, 'owner');
    if (!Number.isSafeInteger(params.generation) || params.generation < 1) throw new NexusError('INVALID_ARGUMENT', 'generation 必须为正整数');
    return once(`stage:${params.owner}:${params.generation}`, async () => {
      const old = [...generations.values()].find(item => item.manifest.owner === params.owner && item.manifest.generation === params.generation && item.state !== 'disposed');
      if (old) {
        if (old.state === 'staged' || old.state === 'active') {
          return { handle: old.manifest.handle, ready: true as const, facts: old.facts, commit: () => commitItem(old), dispose: () => disposeItem(old) };
        }
        await disposeItem(old);
      }
      const item = await materialize(params);
      generations.set(item.manifest.handle, item);
      for (const artifact of item.artifacts) artifacts.set(artifact.key, artifact);
      try {
        if (!livePages().length) await new Promise<void>((resolveArrival, reject) => {
          const arrived = () => { clearTimeout(timer); arrivals.delete(arrived); resolveArrival(); };
          const timer = setTimeout(() => { arrivals.delete(arrived); reject(new NexusError('CLIENT_BROWSER_REQUIRED', '需要打开同一 Host release 的 Nexus 页面以完成真实客户端 staging')); }, 15_000);
          timer.unref?.(); arrivals.add(arrived);
        });
        for (const page of livePages()) item.pages.add(page.id);
        if (!item.pages.size) throw new NexusError('CLIENT_BROWSER_REQUIRED', '没有可验证的在线 Nexus 页面');
        const acks = await allPages(item, 'stage');
        item.state = 'staged';
        item.facts.pages = acks;
        item.facts.readyAt = new Date().toISOString();
        await evidence('staged', item, { acks });
        return { handle: item.manifest.handle, ready: true as const, facts: item.facts, commit: () => commitItem(item), dispose: () => disposeItem(item) };
      } catch (error) {
        item.state = 'unknown';
        await evidence('stage-failed', item, { error: String(error) });
        try { await disposeItem(item); } catch { /* Unknown pages retain exact commands and evidence. */ }
        throw error;
      }
    });
  }
  const releaseRpc = connection.rpc.handle(CHANNEL, async (endpoint: string, payload: unknown, requestSignal: AbortSignal, peer: any) => {
    try {
      if (peer?.principal?.kind !== 'owner') throw new NexusError('PERMISSION_DENIED', '扩展客户端协议仅允许已认证 owner 页面');
      const params = object(payload);
      if (endpoint === 'hello') {
        const pageId = required(params.pageId, 'pageId'), reported = object(params.release);
        const pageRelease = { version: required(reported.version, 'release.version'), commit: required(reported.commit, 'release.commit') };
        if (!sameRelease(pageRelease, release())) throw new NexusError('CLIENT_RELEASE_CHANGED', '页面与 Host release 不匹配，请刷新后重试');
        let page = pages.get(pageId);
        if (page && page.token !== params.token) throw new NexusError('CLIENT_PAGE_UNVERIFIED', '页面身份已存在，凭据不匹配');
        if (!page) { page = { id: pageId, token: randomUUID(), release: pageRelease, lastSeen: Date.now(), closed: false, pending: new Map() }; pages.set(pageId, page); }
        page.lastSeen = Date.now(); page.closed = false;
        for (const arrived of arrivals) arrived();
        // New pages must reach the same real state, with exactly the same hashes.
        for (const handle of active.values()) {
          const item = generations.get(handle);
          if (!item || item.pages.has(pageId)) continue;
          item.pages.add(pageId);
          void command(page, item, 'stage').then(() => command(page!, item, 'commit')).then(ack => evidence('page-reconciled', item, { ack }))
            .catch(error => { item.state = 'unknown'; void evidence('page-reconcile-unknown', item, { pageId, error: String(error) }); });
        }
        const inventory = Array.isArray(params.inventory) ? params.inventory.map(object) : [];
        const retireHandles = inventory.filter(item => typeof item.handle === 'string' && !generations.has(item.handle)).map(item => item.handle);
        return { ok: true, value: { pageId, token: page.token, release: page.release, retireHandles } };
      }
      const page = verifyPage(params);
      if (endpoint === 'poll') {
        if (!page.pending.size) await new Promise<void>(resolvePoll => {
          const done = () => { clearTimeout(timer); requestSignal.removeEventListener('abort', done); if (page.wake === done) page.wake = undefined; resolvePoll(); };
          const timer = setTimeout(done, 20_000); timer.unref?.(); page.wake = done;
          requestSignal.addEventListener('abort', done, { once: true });
          if (requestSignal.aborted) done();
        });
        page.lastSeen = Date.now();
        return { ok: true, value: { commands: [...page.pending.values()] } };
      }
      if (endpoint === 'ack') {
        const commandId = required(params.commandId, 'commandId'), pending = page.pending.get(commandId);
        if (!pending) {
          const prior = receipts.get(commandId);
          if (prior?.pageId === page.id) return { ok: true, value: { accepted: true, idempotent: true } };
          throw new NexusError('CLIENT_ACK_UNEXPECTED', '回执不属于该页面的待确认命令');
        }
        if (params.handle !== pending.handle || params.digest !== pending.digest || typeof params.ok !== 'boolean') throw new NexusError('CLIENT_ACK_MISMATCH', '回执与精确 owner/generation/artifact 摘要不匹配');
        const ack: Ack = { pageId: page.id, commandId, handle: pending.handle, digest: pending.digest, ok: params.ok,
          state: String(params.state ?? 'unknown'), ...(Array.isArray(params.resources) ? { resources: params.resources } : {}),
          ...(typeof params.fiberState === 'number' ? { fiberState: params.fiberState } : {}),
          ...(typeof params.error === 'string' ? { error: params.error.slice(0, 16_384) } : {}) };
        receipts.set(commandId, ack); page.pending.delete(commandId);
        waiting.get(commandId)?.resolve(ack); waiting.delete(commandId);
        const item = generations.get(pending.handle);
        if (item) {
          if (pending.kind === 'dispose' && ack.ok && ack.state === 'disposed') {
            item.disposedPages.add(page.id);
            if ([...item.pages].every(id => item.disposedPages.has(id))) {
              item.state = 'disposed';
              if (active.get(item.manifest.owner) === item.manifest.handle) active.delete(item.manifest.owner);
              for (const artifact of item.artifacts) artifacts.delete(artifact.key);
              item.artifacts.length = 0;
            }
          }
          await evidence('browser-ack', item, { command: pending.kind, ack });
        }
        return { ok: true, value: { accepted: true } };
      }
      if (endpoint === 'status') return { ok: true, value: status() };
      if (endpoint === 'goodbye') {
        const clean = params.disposed === true;
        const disposedHandles = Array.isArray(params.disposedHandles) ? params.disposedHandles.map(object) : [];
        page.closed = true; page.wake?.();
        for (const item of generations.values()) if (item.pages.has(page.id) && item.state !== 'disposed') {
          const confirmed = clean && disposedHandles.some(value => value.handle === item.manifest.handle && value.digest === item.manifest.digest && value.state === 'disposed');
          if (confirmed) item.pages.delete(page.id); else item.state = 'unknown';
          await evidence(confirmed ? 'page-disposed' : 'page-left-unknown', item, { pageId: page.id });
        }
        return { ok: true, value: { closed: true } };
      }
      throw new NexusError('UNKNOWN_ACTION', '未知客户端代际协议动作');
    } catch (error) {
      return { ok: false, error: { code: error instanceof NexusError ? error.code : 'CLIENT_BRIDGE_FAILED',
        message: String(error instanceof Error ? error.message : error), details: error instanceof NexusError ? object(error.details) : {} } };
    }
  });
  const releaseRoute = connection.fetch.register({ path: BUNDLE_ROUTE, methods: ['GET', 'HEAD'], requestBody: 'buffered',
    async fetch(request: Request) {
      const url = new URL(request.url), artifact = artifacts.get(url.searchParams.get('artifact') ?? '');
      if (!artifact || artifact.hash !== url.searchParams.get('sha256')) return new Response('Unknown immutable artifact', { status: 404 });
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(artifact.bytes), { headers: {
        'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff', 'content-length': String(artifact.bytes.length),
        etag: `"${artifact.hash}"`,
      } });
    },
  });
  function status(): JsonRecord {
    return { pages: [...pages.values()].map(page => ({ id: page.id, release: page.release, online: !page.closed && Date.now() - page.lastSeen < LEASE_MS,
      pending: [...page.pending.values()].map(({ manifest: _manifest, ...command }) => command) })),
    generations: [...generations.values()].map(item => ({ handle: item.manifest.handle, owner: item.manifest.owner,
      generation: item.manifest.generation, digest: item.manifest.digest, state: item.state, pages: [...item.pages], facts: item.facts })) };
  }
  async function dispose(): Promise<void> {
    if (closing) return;
    // Keep the ACK endpoint alive until all exact browser cleanup has settled.
    closing = true;
    const results = await Promise.allSettled([...generations.values()].filter(item => item.state !== 'disposed').map(disposeItem));
    for (const page of pages.values()) page.wake?.();
    for (const pending of waiting.values()) pending.reject(new NexusError('DISPOSED', '客户端桥已关闭，未确认状态保留在回执中'));
    waiting.clear();
    await releaseRoute(); await releaseRpc();
    signal.removeEventListener('abort', onAbort);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new NexusError('CLIENT_DISPOSAL_UNKNOWN', '部分浏览器未确认释放；已保留精确残留证据', { errors: failures.map(result => String(result.reason)) });
  }
  const onAbort = () => { void dispose().catch(error => ctx.logger?.error('Nexus client generation disposal remains uncertain', String(error))); };
  signal.addEventListener('abort', onAbort, { once: true });
  return { stage, status, dispose };
}
