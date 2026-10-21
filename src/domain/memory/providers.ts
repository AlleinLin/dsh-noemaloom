import { NexusError, type DispatchContext, type JsonRecord, type NexusServices } from '../../ports/contracts.js';
import type { MemoryProviderAdapter, MemorySpaceAuthority, MemorySpace, MemoryProviderConnection } from '../../../vendor/mnemon-providers/shared/sdk.ts';
import { HindsightProvider } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-hindsight/src/driver.ts';
import { OpenVikingProvider } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-openviking/src/driver.ts';
import { Mem0Provider } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-mem0/src/driver.ts';
import { HonchoProvider } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-honcho/src/driver.ts';
import { RetainDbProvider } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-retaindb/src/driver.ts';
import { SupermemoryProvider } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-supermemory/src/driver.ts';
import { HolographicProvider } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-holographic/src/driver.ts';
import { ByteRoverProvider } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-byterover/src/driver.ts';
import { MnemonNativeProvider } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-mnemon-native/src/driver.ts';
import { descriptor as hindsight } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-hindsight/src/descriptor.ts';
import { descriptor as openviking } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-openviking/src/descriptor.ts';
import { descriptor as mem0 } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-mem0/src/descriptor.ts';
import { descriptor as honcho } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-honcho/src/descriptor.ts';
import { descriptor as retaindb } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-retaindb/src/descriptor.ts';
import { descriptor as supermemory } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-supermemory/src/descriptor.ts';
import { descriptor as holographic } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-holographic/src/descriptor.ts';
import { descriptor as byterover } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-byterover/src/descriptor.ts';
import { descriptor as native } from '../../../vendor/mnemon-providers/dsh-mnemon-provider-mnemon-native/src/descriptor.ts';
import { assertNoSecret, digest, projectId, stableJson } from './types.js';

interface SpaceConfig extends JsonRecord {
  id: string; providerId: string; projectId: string; enabled: boolean;
  connection: Record<string, string | number | boolean>;
  secretRefs: Record<string, string>; generation: number; name: string;
}
const descriptors = [hindsight, openviking, mem0, honcho, retaindb, supermemory, holographic, byterover, native];
export class MemoryProviders {
  constructor(private services: NexusServices) {}
  async catalog(root: string): Promise<JsonRecord> {
    const configured = (await this.services.store.list<SpaceConfig>('memory-spaces')).map(entry => entry.value).filter(config => config.projectId === projectId(root));
    return { items: descriptors.map(item => ({ ...item, icon: undefined, fields: item.fields.map(field => ({ ...field, value: undefined })), state: configured.some(config => config.providerId === item.id && config.enabled) ? 'configured_pending_probe' : 'not_configured' })), spaces: configured.map(config => ({ ...config, connection: this.publicConnection(config), secretRefs: Object.fromEntries(Object.keys(config.secretRefs).map(key => [key, 'configured_reference'])) })) };
  }
  private publicConnection(config: SpaceConfig): JsonRecord {
    const secretKeys = descriptors.find(item => item.id === config.providerId)?.fields.filter(field => field.input === 'secret').map(field => field.key) ?? [];
    return Object.fromEntries(Object.entries(config.connection).filter(([key]) => !secretKeys.includes(key) && !/key|token|password|secret/iu.test(key)));
  }
  async configure(root: string, params: JsonRecord, ctx?: DispatchContext): Promise<JsonRecord> {
    const providerId = String(params.providerId ?? '');
    const descriptor = descriptors.find(item => item.id === providerId);
    if (!descriptor) throw new NexusError('INVALID_PROVIDER', '未知记忆服务');
    const connection = (params.connection ?? {}) as SpaceConfig['connection'];
    const secretRefs = (params.secretRefs ?? {}) as Record<string, string>;
    assertNoSecret(connection);
    for (const field of descriptor.fields) {
      if (field.input === 'secret' && field.key in connection) throw new NexusError('SECRET_REFERENCE_REQUIRED', '凭据只能通过宿主 credentialRef 保存');
    }
    if (connection.endpoint) {
      const url = new URL(String(connection.endpoint));
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.username || url.password || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) throw new NexusError('INVALID_ENDPOINT', '远程记忆服务必须使用 HTTPS；本机服务允许回环 HTTP');
    }
    const id = String(params.id ?? `space_${digest(stableJson({ providerId, projectId: projectId(root), connection })).slice(7, 31)}`);
    const current = await this.services.store.get<SpaceConfig>('memory-spaces', id);
    if (current && current.value.projectId !== projectId(root)) throw new NexusError('ACCESS_DENIED', '不能修改其他项目空间');
    const value: SpaceConfig = { id, providerId, projectId: projectId(root), name: String(params.name ?? descriptor.label), enabled: params.enabled !== false, connection, secretRefs, generation: (current?.value.generation ?? 0) + 1 };
    const stored = await this.services.store.put('memory-spaces', id, value, current?.revision);
    return { committed: true, id, revision: stored.revision, generation: value.generation, state: value.enabled ? 'configured_pending_probe' : 'disabled' };
  }
  async call(root: string, action: string, params: JsonRecord, ctx?: DispatchContext): Promise<unknown> {
    const configRecord = await this.services.store.get<SpaceConfig>('memory-spaces', String(params.spaceId ?? params.id ?? ''));
    if (!configRecord || configRecord.value.projectId !== projectId(root)) throw new NexusError('NOT_CONFIGURED', '请先为当前项目配置记忆空间');
    const config = configRecord.value;
    if (!config.enabled) throw new NexusError('MODULE_DISABLED', '该记忆空间已停用；数据未删除');
    const connection: MemoryProviderConnection = { ...config.connection };
    for (const [key, reference] of Object.entries(config.secretRefs)) {
      const secret = await this.services.host.secret(reference);
      if (!secret) throw new NexusError('CREDENTIAL_MISSING', '宿主无法解析配置的凭据引用', { field: key });
      connection[key] = secret;
    }
    const space = { id: config.id, name: config.name, provider: { id: config.providerId, typeId: config.providerId, settings: config.connection }, active: true } as unknown as MemorySpace;
    const authority: MemorySpaceAuthority = {
      runner: { effectiveDataDir: () => this.services.dataDir },
      list: () => [space],
      providerConnection: id => { if (id !== config.id) throw new NexusError('ACCESS_DENIED', '空间不属于当前调用'); return connection; },
    };
    const safeFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const base = connection.endpoint ? new URL(String(connection.endpoint)) : undefined;
      if (base && url.origin !== base.origin) throw new NexusError('NETWORK_SCOPE_DENIED', '拒绝跨源发送记忆服务凭据');
      const response = await fetch(input, { ...init, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) throw new NexusError('REDIRECT_DENIED', '记忆服务重定向需重新配置目标');
      const length = Number(response.headers.get('content-length') ?? '0');
      if (length > 4 * 1024 * 1024) throw new NexusError('RESPONSE_TOO_LARGE', '记忆服务响应超过4MiB');
      return response;
    };
    const options = { fetch: safeFetch, requestTimeoutMs: Number(params.timeoutMs ?? 15000) };
    const broker = async (command: string, args: readonly string[], exec: { cwd?: string; signal?: AbortSignal; timeoutMs: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv }) => {
      const result = await this.services.executor.run(command, [...args], { ...exec, env: Object.fromEntries(Object.entries(exec.env ?? {}).filter((pair): pair is [string, string] => pair[1] !== undefined)) });
      if (result.cancelled) throw new NexusError('CANCELLED', '记忆服务调用已取消');
      return result;
    };
    const nativeRunner = {
      runText: async (args: readonly string[], nativeOptions: { signal?: AbortSignal; store?: string; maxOutputBytes?: number } = {}) => {
        const result = await broker(String(connection.command ?? 'mnemon'), ['--data-dir', this.services.dataDir, ...args], { signal: nativeOptions.signal, timeoutMs: 30000, maxOutputBytes: nativeOptions.maxOutputBytes });
        if (result.exitCode !== 0) throw new NexusError('DEPENDENCY_FAILED', 'Mnemon Native CLI 调用失败', { exitCode: result.exitCode });
        return result.stdout;
      },
      runJson: async (args: readonly string[], opts?: { signal?: AbortSignal; store?: string; maxOutputBytes?: number }) => JSON.parse(await nativeRunner.runText(args, opts)),
    };
    const constructors: Record<string, () => MemoryProviderAdapter> = {
      hindsight: () => new HindsightProvider(authority, options),
      openviking: () => new OpenVikingProvider(authority, options),
      mem0: () => new Mem0Provider(authority, options), honcho: () => new HonchoProvider(authority, options),
      retaindb: () => new RetainDbProvider(authority, options), supermemory: () => new SupermemoryProvider(authority, options),
      holographic: () => new HolographicProvider(authority), byterover: () => new ByteRoverProvider(authority, { process: broker }),
      'mnemon-native': () => new MnemonNativeProvider(nativeRunner),
    };
    const provider = constructors[config.providerId]?.();
    if (!provider) throw new NexusError('PROVIDER_UNAVAILABLE', '该服务没有可加载驱动');
    const signal = ctx?.signal;
    try {
      switch (action) {
        case 'probe': case 'status': return { spaceId: config.id, generation: config.generation, ...await provider.status(space, signal) };
        case 'discover': if (!provider.discover) throw new NexusError('UNSUPPORTED_CAPABILITY', '该服务不支持空间发现'); return { items: await provider.discover(connection, signal) };
        case 'search': return provider.search(space, { query: String(params.query ?? ''), limit: Math.min(50, Number(params.limit ?? 8)) } as never, signal);
        case 'list': return { items: await provider.list(space, { limit: Math.min(200, Number(params.limit ?? 20)) }, signal) };
        case 'read': if (!provider.get) throw new NexusError('UNSUPPORTED_CAPABILITY', '该服务没有精确读取接口'); return provider.get(space, String(params.externalId ?? ''), signal);
        case 'graph': return provider.graph(space, signal);
        case 'related': if (!provider.related) throw new NexusError('UNSUPPORTED_CAPABILITY', '该服务不支持关系展开'); return provider.related(space, String(params.externalId ?? ''), Math.min(3, Number(params.depth ?? 1)), undefined, signal);
        case 'remember': {
          assertNoSecret(params.content);
          if (!await this.services.host.approve('memory.provider.write', config.id, { contentHash: digest(String(params.content)), providerId: provider.id })) throw new NexusError('APPROVAL_REQUIRED', '远程记忆写入需要授权');
          const operationId = `provider_op_${digest(stableJson({ space: config.id, content: params.content })).slice(7, 31)}`;
          await this.services.store.put('memory-provider-operations', operationId, { state: 'sending', spaceId: config.id, generation: config.generation });
          try {
            const receipt = await provider.remember(space, { content: String(params.content), category: String(params.category ?? 'general'), tags: params.tags ?? [] } as never, signal);
            await this.services.store.put('memory-provider-operations', operationId, { state: 'accepted', receipt, spaceId: config.id });
            return { state: 'queued', committed: false, operationId, providerReceipt: receipt, message: '服务已受理；可检索后才视为已生成记忆' };
          } catch (error) {
            await this.services.store.put('memory-provider-operations', operationId, { state: 'unknown_remote', spaceId: config.id });
            throw new NexusError('UNKNOWN_REMOTE', '远程写入结果未知，请先查询操作，勿盲目重发', { operationId });
          }
        }
        case 'reflect': case 'pages': case 'page': case 'operation': case 'seed': {
          if (config.providerId !== 'hindsight') throw new NexusError('UNSUPPORTED_CAPABILITY', '该原生端点仅属于 Hindsight；其他服务不能冒充相同语义');
          const endpoint = String(connection.endpoint ?? '').replace(/\/+$/u, '');
          const bank = `/v1/default/banks/${encodeURIComponent(String(connection.bankId ?? 'default'))}`;
          const token = String(connection.apiKey ?? '').replace(/^Bearer\s+/iu, '');
          const headers = new Headers({ 'Content-Type': 'application/json' });
          if (token) headers.set('Authorization', `Bearer ${token}`);
          let path: string, body: unknown;
          if (action === 'reflect') {
            if (!await this.services.host.approve('memory.hindsight.reflect', config.id, { budget: params.budget ?? 'mid' })) throw new NexusError('APPROVAL_REQUIRED', '远端反思会产生模型费用，需要授权');
            path = `${bank}/reflect`; body = { query: String(params.query ?? ''), budget: String(params.budget ?? connection.budget ?? 'mid'), ...(params.context ? { context: String(params.context) } : {}) };
          } else if (action === 'pages') path = `${bank}/mental-models`;
          else if (action === 'page') path = `${bank}/mental-models/${encodeURIComponent(String(params.externalId ?? ''))}`;
          else if (action === 'operation') path = `/v1/default/operations/${encodeURIComponent(String(params.operationId ?? ''))}`;
          else {
            if (params.confirmBudget !== true) throw new NexusError('BUDGET_APPROVAL_REQUIRED', '远端seed需要明确范围与预算');
            path = `${bank}/mental-models`; body = { name: String(params.name ?? 'Project initiative'), source_query: String(params.query ?? '') };
          }
          const timeout = AbortSignal.timeout(Math.min(330000, Math.max(1000, Number(params.timeoutMs ?? (action === 'reflect' ? 120000 : 15000)))));
          const response = await safeFetch(`${endpoint}${path}`, { method: body ? 'POST' : 'GET', headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, ...(body ? { body: JSON.stringify(body) } : {}) });
          if (!response.ok) throw new NexusError('PROVIDER_HTTP_ERROR', `Hindsight 返回 HTTP ${response.status}`, { action, supportedByConfiguredServer: false });
          const payload = await response.json();
          return { providerId: 'hindsight', action, payload, source: 'provider-native', usage: (payload as JsonRecord).usage ?? null, usageStatus: (payload as JsonRecord).usage ? 'reported' : 'unreported' };
        }
        case 'forget': if (!provider.forget) throw new NexusError('UNSUPPORTED_CAPABILITY', '该服务不支持遗忘'); if (!await this.services.host.approve('memory.provider.forget', config.id)) throw new NexusError('APPROVAL_REQUIRED', '需要遗忘授权'); return provider.forget(space, String(params.externalId ?? ''), signal);
        default: throw new NexusError('UNKNOWN_ACTION', '未知 Provider 操作');
      }
    } finally { await provider.dispose?.(); }
  }
}
