import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { resolve } from 'node:path';
import { NexusError, requiredString, recordParams, type JsonRecord, type NexusModule, type NexusServices, type DispatchContext } from '../../ports/contracts.js';
import { createSshService, importSshConfig, type SshHost } from './ssh.js';
import { safeRequest, type NetworkGrant } from '../../adapters/search/network.js';
import { sha256 } from '../files/paths.js';
import { createNativeRemoteBridge, remoteDeviceCapabilities, type NativeRemoteBridge } from './native-remote.js';

const actions = ['list', 'get', 'save', 'remove', 'test', 'test.batch', 'ssh.import.preview', 'ssh.import.apply', 'ssh.connect', 'ssh.disconnect', 'ssh.exec', 'ssh.sftp', 'ssh.forward.start', 'ssh.forward.list', 'ssh.forward.stop', 'ssh.cluster', 'native.pair.token', 'native.devices', 'native.revoke', 'remote.hello', 'remote.pair', 'remote.accept', 'remote.connect', 'remote.disconnect', 'remote.status', 'remote.invoke', 'remote.devices', 'remote.revoke', 'github.request', 'github.issues', 'github.issue.create', 'github.issue.update', 'github.issue.comment', 'github.pulls', 'github.pull', 'channel.send', 'channel.history', 'notification.send'];
const object = (input: unknown): JsonRecord => input && typeof input === 'object' && !Array.isArray(input) ? input as JsonRecord : {};
const forbidden = /^(?:password|passphrase|privateKey|apiKey|cookie|token|secret|authorization)$/i;

function secretFree(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) { if (forbidden.test(key)) throw new NexusError('INVALID_ARGUMENT', `配置 ${key} 必须改为宿主凭据引用`); secretFree(child); }
}
function constantEqual(left: string, right: string): boolean { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }

export interface NexusConnectionsModule extends NexusModule { nativeRemote: NativeRemoteBridge; }
export function createConnectionsModule(services: NexusServices): NexusConnectionsModule {
  const ssh = createSshService(services), remoteStates = new Map<string, JsonRecord>(), nativeRemote = createNativeRemoteBridge(services);
  async function config(id: string) { const row = await services.store.get<JsonRecord>('connections', id); if (!row) throw new NexusError('NOT_FOUND', '连接不存在'); return row; }
  async function httpConnection(id: string, path: string, body: JsonRecord | undefined, context?: DispatchContext, method = body ? 'POST' : 'GET') {
    const saved = await config(id), value = saved.value;
    const origin = new URL(requiredString(value, 'origin'));
    const grant = (await services.store.get<NetworkGrant>('connectionNetworkGrants', id))?.value;
    if (origin.protocol !== 'https:' && grant?.origin !== origin.origin) throw new NexusError('PERMISSION_DENIED', '带凭据的连接必须使用 HTTPS，或拥有精确的本地网络授权');
    const endpoint = new URL(path, origin);
    if (endpoint.origin !== origin.origin) throw new NexusError('SCOPE_MISMATCH', '连接路径必须同源');
    const reference = typeof value.credentialRef === 'string' ? value.credentialRef : undefined;
    const credential = reference ? await services.host.secret(reference) : undefined;
    if (reference && !credential) throw new NexusError('AUTH_REQUIRED', '连接凭据尚未配置', { credentialRef: reference });
    const response = await safeRequest(endpoint.href, { method, headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: context?.signal, maxRedirects: 0, timeoutMs: 15000, networkGrant: grant });
    try { return JSON.parse(response.body) as unknown; } catch { throw new NexusError('PROVIDER_INVALID_RESPONSE', '连接返回非 JSON 响应'); }
  }
  async function github(action: string, params: JsonRecord, context?: DispatchContext) {
    const id = requiredString(params, 'id'), saved = await config(id);
    if (saved.value.type !== 'github') throw new NexusError('INVALID_ARGUMENT', '请选择 GitHub 类型连接');
    const owner = requiredString(params, 'owner'), repo = requiredString(params, 'repo');
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) throw new NexusError('INVALID_ARGUMENT', 'GitHub owner/repo 无效');
    const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const number = () => { const value = params.number; if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new NexusError('INVALID_ARGUMENT', 'GitHub number 须为正整数'); return value; };
    let path: string, method = 'GET', body: JsonRecord | undefined;
    switch (action) {
      case 'issues': path = `${root}/issues?state=${params.state === 'closed' ? 'closed' : 'open'}&per_page=100&page=${Number(params.page ?? 1)}`; break;
      case 'issue.create': path = `${root}/issues`; method = 'POST'; body = { title: requiredString(params, 'title'), body: String(params.body ?? ''), ...(Array.isArray(params.labels) ? { labels: params.labels } : {}) }; break;
      case 'issue.update': path = `${root}/issues/${number()}`; method = 'PATCH'; body = { ...(typeof params.title === 'string' ? { title: params.title } : {}), ...(typeof params.body === 'string' ? { body: params.body } : {}), ...(['open', 'closed'].includes(String(params.state)) ? { state: params.state } : {}) }; break;
      case 'issue.comment': path = `${root}/issues/${number()}/comments`; method = 'POST'; body = { body: requiredString(params, 'body') }; break;
      case 'pulls': path = `${root}/pulls?state=${params.state === 'closed' ? 'closed' : 'open'}&per_page=100`; break;
      case 'pull': path = `${root}/pulls/${number()}`; break;
      case 'request': {
        path = requiredString(params, 'path');
        if (!path.startsWith(`${root}/`) || path.includes('..') || !['GET', 'POST', 'PATCH'].includes(String(params.method ?? 'GET'))) throw new NexusError('SCOPE_MISMATCH', 'GitHub 请求限于所选仓库与受支持方法');
        method = String(params.method ?? 'GET'); body = method === 'GET' ? undefined : object(params.body); break;
      }
      default: throw new NexusError('ACTION_NOT_FOUND', '未知 GitHub 操作');
    }
    if (method !== 'GET' && !await services.host.approve(`connections.github.${action}`, `${owner}/${repo}`, { path, method, title: body?.title, sessionId: context?.sessionId })) throw new NexusError('PERMISSION_DENIED', 'GitHub写入未获授权');
    const ref = requiredString(saved.value, 'credentialRef'), credential = await services.host.secret(ref);
    if (!credential) throw new NexusError('AUTH_REQUIRED', 'GitHub凭据尚未配置', { credentialRef: ref });
    const origin = new URL(String(saved.value.origin ?? 'https://api.github.com'));
    const endpoint = new URL(path, origin);
    if (endpoint.origin !== origin.origin || endpoint.protocol !== 'https:') throw new NexusError('PERMISSION_DENIED', 'GitHub端点无效');
    const response = await safeRequest(endpoint.href, { method, headers: { authorization: `Bearer ${credential}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'user-agent': 'DSH-Nexus', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: context?.signal, maxRedirects: 0 });
    let result: unknown; try { result = JSON.parse(response.body); } catch { throw new NexusError('PROVIDER_INVALID_RESPONSE', 'GitHub返回无效JSON'); }
    const receipt = { operationId: randomUUID(), connectionId: id, action, owner, repo, method, observedAt: new Date().toISOString(), result };
    if (method !== 'GET') await services.store.put('connectionAudit', receipt.operationId, { ...receipt, result: undefined });
    return receipt;
  }
  return {
    id: 'connections',
    nativeRemote,
    capabilities: actions.map(action => ({ action, description: `连接与远程 ${action}`, mutating: /save|remove|apply|connect|exec|sftp|forward|cluster|pair|accept|revoke|send|create|update|comment/.test(action) || ['remote.invoke', 'github.request'].includes(action) })),
    async dispatch(request, context) {
      const params = recordParams(request), action = request.action;
      if (action.startsWith('github.')) return github(action.slice(7), params, context);
      if (action.startsWith('ssh.') && !action.startsWith('ssh.import.')) return ssh.dispatch(action.slice(4), params, context);
      switch (action) {
        case 'list': return { items: await Promise.all((await services.store.list<JsonRecord>('connections')).map(async row => ({ ...row, value: { ...row.value, credentialConfigured: typeof row.value.credentialRef === 'string' ? Boolean(await services.host.secret(row.value.credentialRef)) : false, status: remoteStates.get(row.id)?.state ?? 'idle' } }))) };
        case 'get': return config(requiredString(params, 'id'));
        case 'save': {
          secretFree(params); const id = typeof params.id === 'string' ? params.id : randomUUID(), type = requiredString(params, 'type');
          if (!['ssh', 'remote', 'github', 'channel', 'mcp', 'webhook'].includes(type)) throw new NexusError('INVALID_ARGUMENT', '连接类型无效');
          if (type === 'ssh') {
            const hostname = requiredString(params, 'hostname'), username = requiredString(params, 'username'), port = Number(params.port ?? 22);
            if (/[\0\r\n]/.test(hostname + username) || !Number.isInteger(port) || port < 1 || port > 65535) throw new NexusError('INVALID_ARGUMENT', 'SSH主机或端口无效');
            if (params.proxyCommand) throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', 'ProxyCommand 已保留供导入预览；当前受控 SSH 使用 ProxyJump 连接引用');
          } else {
            const origin = new URL(requiredString(params, 'origin'));
            if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new NexusError('INVALID_ARGUMENT', '网络连接须为不含凭据与路径的 HTTP(S) origin');
            if (params.allowPrivateNetwork === true) {
              const addresses = await lookup(origin.hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true });
              if (!await services.host.approve('connections.private-network', origin.origin, { addresses: addresses.map(value => value.address), unencrypted: origin.protocol === 'http:' })) throw new NexusError('PERMISSION_DENIED', '指定 origin 与网络地址未获批准');
              const currentGrant = await services.store.get('connectionNetworkGrants', id);
              await services.store.put('connectionNetworkGrants', id, { origin: origin.origin, addresses: addresses.map(value => value.address) }, currentGrant?.revision ?? 0);
            } else if (origin.protocol !== 'https:') throw new NexusError('PERMISSION_DENIED', 'HTTP本地连接需显式授权精确origin与地址');
          }
          const previous = await services.store.get<JsonRecord>('connections', id);
          if (previous) await ssh.invalidate(id);
          const saved = await services.store.put('connections', id, { ...params, id, ...(type === 'ssh' ? { forwardAgent: params.forwardAgent === true } : {}) }, request.expectedRevision);
          services.emit('connections.changed', { id, revision: saved.revision }); return saved;
        }
        case 'remove': { const id = requiredString(params, 'id'); await ssh.invalidate(id); remoteStates.delete(id); return { removed: await services.store.remove('connections', id, request.expectedRevision) }; }
        case 'test': {
          const id = requiredString(params, 'id'), row = await config(id);
          if (row.value.type === 'ssh') return ssh.dispatch('test', params, context);
          if (row.value.type === 'github') { const result = await httpConnection(id, '/user', undefined, context); return { id, authenticated: true, profile: object(result).login, observedAt: new Date().toISOString() }; }
          if (row.value.type === 'remote') return httpConnection(id, '/api/nexus/rpc', { protocolVersion: 1, method: 'connections', scope: { workspaceId: 'default' }, payload: { action: 'remote.hello', params: { protocolVersion: 1 } } }, context);
          return { id, status: 'configured', networkTested: false, reason: '该连接测试需显式发送测试内容' };
        }
        case 'test.batch': {
          if (!Array.isArray(params.ids) || params.ids.length > 128) throw new NexusError('INVALID_ARGUMENT', 'ids无效');
          const results = []; for (const id of params.ids) try { const row = await config(String(id)); results.push({ id, result: row.value.type === 'ssh' ? await ssh.dispatch('test', { id }, context) : await httpConnection(String(id), '/user', undefined, context) }); } catch (error) { results.push({ id, error: { code: error instanceof NexusError ? error.code : 'CONNECTION_FAILED' } }); }
          return { items: results };
        }
        case 'ssh.import.preview': {
          const path = resolve(requiredString(params, 'path'));
          if (!await services.host.approve('connections.ssh.config.read', path, { include: true, sessionId: context?.sessionId })) throw new NexusError('PERMISSION_DENIED', 'SSH配置导入读取未获批准');
          const preview = await importSshConfig(path), previewId = randomUUID();
          await services.store.put('sshImportPreviews', previewId, { ...preview, expiresAt: Date.now() + 600000 }); return { previewId, ...preview };
        }
        case 'ssh.import.apply': {
          const row = await services.store.get<{ hosts: JsonRecord[]; expiresAt: number }>('sshImportPreviews', requiredString(params, 'previewId'));
          if (!row || row.value.expiresAt < Date.now()) throw new NexusError('SEARCH_STALE', 'SSH导入预览已过期');
          const selected = Array.isArray(params.ids) ? new Set(params.ids) : undefined, receipts = [];
          for (const host of row.value.hosts.filter(host => !selected || selected.has(host.id))) {
            const id = String(host.id), previous = await services.store.get('connections', id);
            if (previous) { receipts.push({ id, status: 'skipped', reason: 'exists' }); continue; }
            await services.store.put('connections', id, { ...host, enabled: false, imported: true, status: 'credentials-required' }, 0); receipts.push({ id, status: 'imported', configured: false });
          }
          return { items: receipts };
        }
        case 'native.pair.token': {
          const capabilities = remoteDeviceCapabilities(params.capabilities);
          if (!await services.host.approve('connections.remote.pair', '原生手机协议 v1', { sessionId: context?.sessionId, capabilities, defaultAccess: 'read-only', workspaceRoot: context?.workspaceRoot ?? services.workspaceRoot })) throw new NexusError('PERMISSION_DENIED', '原生设备配对未获批准');
          const ticket = nativeRemote.issueToken('native-v1', { capabilities, sessionId: context?.sessionId, workspaceRoot: context?.workspaceRoot ?? services.workspaceRoot });
          return { protocol: 'native-v1', path: '/ios/v1', token: ticket.value, expiresAt: ticket.expiresAt, oneTime: true, signature: 'ES256/P-256' };
        }
        case 'native.devices': return { items: await nativeRemote.devices() };
        case 'native.revoke': return nativeRemote.revoke(requiredString(params, 'deviceId'));
        case 'remote.hello': return { protocolVersion: 1, product: 'DSH Nexus', instanceId: sha256(services.dataDir).slice(0, 24), authentication: 'host-connection-and-device-token', capabilities: ['pair', 'tasks', 'sessions', 'approvals', 'resources', 'usage'], observedAt: new Date().toISOString() };
        case 'remote.pair': {
          const capabilities = remoteDeviceCapabilities(params.capabilities);
          if (!await services.host.approve('connections.remote.pair', String(params.name ?? '新设备'), { sessionId: context?.sessionId, capabilities, defaultAccess: 'read-only', workspaceRoot: context?.workspaceRoot ?? services.workspaceRoot })) throw new NexusError('PERMISSION_DENIED', '远程配对未获批准');
          const ticket = nativeRemote.issueToken('web-v1', { capabilities, sessionId: context?.sessionId, workspaceRoot: context?.workspaceRoot ?? services.workspaceRoot });
          return { protocol: 'web-v1', path: '/nexus/web/v1', token: ticket.value, expiresAt: ticket.expiresAt, oneTime: true, signature: 'ES256/P-256' };
        }
        case 'remote.accept': {
          throw new NexusError('AUTH_REQUIRED', 'Web 配对通过 /nexus/web/v1 的 pair.begin + pair.finish 完成 P-256 认证', { path: '/nexus/web/v1', methods: ['hello', 'pair.begin', 'pair.finish'] });
        }
        case 'remote.devices': return { items: (await nativeRemote.devices()).filter(row => row.protocol === 'web-v1') };
        case 'remote.revoke': return nativeRemote.revoke(requiredString(params, 'deviceId'));
        case 'remote.connect': {
          const id = requiredString(params, 'id'), response = object(await httpConnection(id, '/api/nexus/rpc', { protocolVersion: 1, method: 'connections', scope: { workspaceId: params.workspaceId ?? 'default' }, payload: { action: 'remote.hello', params: { protocolVersion: 1 } } }, context));
          const result = object(response.result ?? response.data ?? response);
          if (result.protocolVersion !== 1) throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '远程握手协议不匹配', { expected: 1 });
          const state = { id, state: 'connected', protocolVersion: 1, connectedAt: new Date().toISOString(), remote: result };
          remoteStates.set(id, state); services.emit('connections.remote.changed', { id, state: 'connected' }); return state;
        }
        case 'remote.disconnect': { const id = requiredString(params, 'id'); remoteStates.delete(id); return { id, state: 'disconnected' }; }
        case 'remote.status': return { items: [...remoteStates.values()] };
        case 'remote.invoke': {
          const id = requiredString(params, 'id'), method = requiredString(params, 'method'), payload = object(params.payload);
          if (!['tasks', 'sessions', 'approvals', 'resources', 'usage', 'workflow', 'memory'].includes(method)) throw new NexusError('PERMISSION_DENIED', '该领域不能由远程转发执行');
          if (!remoteStates.has(id)) throw new NexusError('CONNECTION_REQUIRED', '先完成远程握手');
          return httpConnection(id, '/api/nexus/rpc', { protocolVersion: 1, method, scope: { workspaceId: params.workspaceId ?? 'default' }, payload }, context);
        }
        case 'channel.send': {
          const id = requiredString(params, 'id'), row = await config(id), content = requiredString(params, 'content');
          if (!['channel', 'webhook'].includes(String(row.value.type))) throw new NexusError('INVALID_ARGUMENT', '请选择渠道连接');
          if (!await services.host.approve('connections.channel.send', String(row.value.name ?? id), { contentPreview: content.slice(0, 100), attachmentCount: Array.isArray(params.attachments) ? params.attachments.length : 0, sessionId: context?.sessionId })) throw new NexusError('PERMISSION_DENIED', '渠道发送未获批准');
          const endpoint = new URL(String(row.value.path ?? '/'), String(row.value.origin));
          const reference = String(row.value.credentialRef ?? ''), key = reference ? await services.host.secret(reference) : undefined;
          const result = await safeRequest(endpoint.href, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ content, ...(params.threadId ? { threadId: params.threadId } : {}), ...(Array.isArray(params.attachments) ? { attachments: params.attachments } : {}) }), signal: context?.signal, maxRedirects: 0 });
          const receipt = { id: request.requestId ?? randomUUID(), connectionId: id, sentAt: new Date().toISOString(), contentHash: sha256(content), state: 'delivered', responseBytes: Buffer.byteLength(result.body) };
          await services.store.put('channelDeliveries', receipt.id, receipt, 0); return receipt;
        }
        case 'channel.history': return { items: (await services.store.list<JsonRecord>('channelDeliveries')).filter(row => !params.id || row.value.connectionId === params.id) };
        case 'notification.send': return services.host.sessions('notification.send', { ...params, sessionId: context?.sessionId });
        default: throw new NexusError('ACTION_NOT_FOUND', `未知连接操作: ${action}`);
      }
    },
    async dispose() { await ssh.dispose(); nativeRemote.dispose(); remoteStates.clear(); },
  };
}
