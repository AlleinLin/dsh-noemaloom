import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { NexusError, type NexusServices, type JsonRecord, type DispatchContext } from '../../ports/contracts.js';
import { hostAuthority } from '../../host/host-adapter.js';
import { PairingService } from './remote/pairing.js';
import { base64UrlDecode, fingerprintOfSpki, randomBase64Url, tokenHash, verifyEs256 } from './remote/crypto.js';
import { decodeClientFrame, encodeFrame } from './remote/envelope.js';

interface DeviceAuthorization extends JsonRecord { capabilities: string[]; workspaceRoot: string; sessionIds?: string[]; }
interface NativeDevice extends JsonRecord { deviceId: string; tokenHash: string; publicKey: string; fingerprint: string; name: string; revoked: boolean; pairedAt: string; lastSeenAt: string; capabilities?: string[]; workspaceRoot?: string; sessionIds?: string[]; }
interface Peer { socket: WebSocket; deviceId?: string; nonce?: { value: string; expiresAt: number }; pairingAuthorization?: DeviceAuthorization; seq: number; capabilities: Set<string>; protocol: 'native-v1' | 'web-v1'; controller: AbortController; signal: AbortSignal; }
const object = (input: unknown): JsonRecord => input && typeof input === 'object' && !Array.isArray(input) ? input as JsonRecord : {};
const unpairedMethods = new Set(['hello', 'pair.begin', 'pair.finish']);
const readMethods = new Set(['session.list', 'session.titles', 'session.snapshot', 'session.history', 'session.history.deep', 'session.permissions', 'session.models', 'presets.list', 'jobs.list', 'tasks.snapshot', 'tasks.options', 'resources.list', 'usage.summary']);
export const REMOTE_WRITE_METHODS = ['session.prompt', 'session.interrupt', 'session.attachment', 'session.setPermission', 'session.setModel', 'session.create', 'session.fork', 'approval.resolve', 'question.answer', 'tasks.apply'] as const;
const todoActions: Record<string, string> = { create: 'todo/create', update: 'todo/update', archive: 'todo/archive', remove: 'todo/remove', import: 'todo/import' };
export function remoteDeviceCapabilities(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > REMOTE_WRITE_METHODS.length || input.some(value => typeof value !== 'string' || !(REMOTE_WRITE_METHODS as readonly string[]).includes(value))) throw new NexusError('INVALID_ARGUMENT', '远程设备权限必须为明确支持的逐项操作');
  return [...new Set(input as string[])];
}
function stableRequestId(params: JsonRecord): string {
  if (typeof params.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(params.requestId)) throw new NexusError('INVALID_ARGUMENT', '写操作必须携带重试时保持不变的 requestId');
  return params.requestId;
}
function businessParams(params: JsonRecord): JsonRecord {
  const { actorId: _actor, permissions: _permissions, workspaceRoot: _workspace, ownerIntent: _intent, context: _context, signal: _signal, cwd: _cwd, projectRoot: _project, ...safe } = params;
  return safe;
}

/** Frozen iOS protocol v1 with one owner dispatcher, P-256 identity and revocation. */
export function createNativeRemoteBridge(services: NexusServices) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024, perMessageDeflate: false });
  const pairing = new PairingService(), webPairing = new PairingService(), peers = new Set<Peer>();
  const tickets = new Map<string, { protocol: Peer['protocol']; expiresAt: number; authorization: DeviceAuthorization }>();
  let disposed = false;
  const send = (peer: Peer, frame: Parameters<typeof encodeFrame>[0]) => { if (peer.socket.readyState === 1) peer.socket.send(encodeFrame(frame)); };
  async function authenticate(token: string | undefined) {
    if (!token) return undefined;
    const hash = tokenHash(token);
    return (await services.store.list<NativeDevice>('nativeRemoteDevices')).find(row => !row.value.revoked && row.value.tokenHash === hash)?.value;
  }
  async function canonical(path: string) {
    const current = await realpath(resolve(path));
    return process.platform === 'win32' ? current.toLowerCase() : current;
  }
  async function trustedContext(peer: Peer, device: NativeDevice, method: string, params: JsonRecord): Promise<DispatchContext> {
    const workspaceRoot = device.workspaceRoot ?? services.workspaceRoot;
    if (await canonical(workspaceRoot) !== await canonical(services.workspaceRoot)) throw new NexusError('SCOPE_MISMATCH', '设备授权不属于当前服务器工作区');
    if (params.sessionId !== undefined && (typeof params.sessionId !== 'string' || !params.sessionId.trim())) throw new NexusError('INVALID_ARGUMENT', 'sessionId 必须为非空会话标识');
    const explicit = typeof params.sessionId === 'string' ? params.sessionId
      : method.startsWith('session.') && !['session.list', 'session.titles', 'session.create', 'session.models'].includes(method) && typeof params.id === 'string' ? params.id : undefined;
    const sessionId = explicit ?? device.sessionIds?.[0];
    const context: DispatchContext = { actorId: `remote:${peer.protocol}:${device.deviceId}`, workspaceRoot, sessionId, signal: peer.signal, permissions: new Set() };
    if (['session.snapshot', 'session.history', 'session.history.deep', 'session.prompt', 'session.interrupt', 'session.attachment', 'session.permissions', 'session.setPermission', 'session.setModel', 'session.fork', 'approval.resolve', 'question.answer'].includes(method) && !sessionId) throw new NexusError('INVALID_ARGUMENT', '此操作需要明确的已授权 sessionId');
    if (sessionId) {
      if (device.sessionIds?.length && !device.sessionIds.includes(sessionId)) throw new NexusError('SCOPE_MISMATCH', '会话不在设备的服务器授权范围');
      const info = object(await hostAuthority.run(context, () => services.host.sessions('info', { sessionId })));
      const cwd = info.cwd ?? object(info.header).cwd;
      if (typeof cwd !== 'string' || await canonical(cwd) !== await canonical(workspaceRoot)) throw new NexusError('SCOPE_MISMATCH', '目标会话不属于设备绑定的工作区');
    }
    return context;
  }
  async function allowNewSession(device: NativeDevice, result: unknown) {
    if (!device.sessionIds?.length) return;
    const response = object(result), sessionId = response.sessionId ?? response.id;
    if (typeof sessionId !== 'string') throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '宿主未报告新会话身份');
    const latest = await services.store.get<NativeDevice>('nativeRemoteDevices', device.deviceId);
    if (!latest || latest.value.revoked) throw new NexusError('unpaired', '设备已撤销');
    await services.store.put('nativeRemoteDevices', latest.id, { ...latest.value, sessionIds: [...new Set([...(latest.value.sessionIds ?? []), sessionId])] }, latest.revision);
  }
  async function call(peer: Peer, method: string, rawParams: JsonRecord): Promise<unknown> {
    peer.signal.throwIfAborted();
    const params = businessParams(rawParams);
    if (!unpairedMethods.has(method) && !peer.deviceId) throw new NexusError('unpaired', '设备尚未配对');
    let device: NativeDevice | undefined;
    if (peer.deviceId) {
      const row = await services.store.get<NativeDevice>('nativeRemoteDevices', peer.deviceId);
      if (!row || row.value.revoked || (row.value.protocol ?? 'native-v1') !== peer.protocol) { peer.socket.close(4003, 'revoked'); throw new NexusError('unpaired', '设备已撤销或不属于此协议'); }
      device = row.value;
      try { await services.store.put('nativeRemoteDevices', row.id, { ...row.value, lastSeenAt: new Date().toISOString() }, row.revision); }
      catch (error) {
        if (!(error instanceof NexusError) || error.code !== 'REVISION_CONFLICT') throw error;
        const latest = await services.store.get<NativeDevice>('nativeRemoteDevices', row.id);
        if (!latest || latest.value.revoked) { peer.socket.close(4003, 'revoked'); throw new NexusError('unpaired', '设备已撤销'); }
        device = latest.value;
      }
    }
    let context: DispatchContext | undefined;
    if (!unpairedMethods.has(method)) {
      if (!device) throw new NexusError('unpaired', '设备尚未配对');
      if (!readMethods.has(method) && !(device.capabilities ?? []).includes(method)) throw new NexusError('PERMISSION_DENIED', '设备没有此操作的服务器授权');
      context = await trustedContext(peer, device, method, params);
    }
    const invoke = (domain: string, action: string, input = params, extra: { requestId?: string; expectedRevision?: number; target?: { id: string } } = {}, permissions: ReadonlySet<string> = new Set<string>()) =>
      services.invoke(domain, { action, params: input, ...extra }, { ...context, permissions });
    const host = async (action: string, write = false, input = params): Promise<unknown> => {
      const intent = `remote.${method}`;
      const authority = { ...context, ownerIntent: write ? intent : undefined, permissions: new Set(write ? [intent] : []) };
      const target = context?.sessionId;
      const supplied: JsonRecord = { ...input, ...(target ? { sessionId: target } : {}) };
      if (write) {
        supplied.requestId = `remote:${device!.deviceId}:${stableRequestId(params)}`;
        if (method === 'session.create' || method === 'session.fork') supplied.correlationId = supplied.requestId;
      }
      return hostAuthority.run(authority, async () => {
        if (write && !await services.host.approve(intent, target ?? String(context?.workspaceRoot), { actorId: context?.actorId, sessionId: target, requestId: params.requestId, method, protocol: peer.protocol })) throw new NexusError('PERMISSION_DENIED', '宿主拒绝远程精确操作');
        return services.host.sessions(action, supplied);
      });
    };
    switch (method) {
      case 'hello':
        if (params.proto !== 1) throw new NexusError('proto-unsupported', '仅支持 protocol v1');
        peer.capabilities = new Set(Array.isArray(params.cap) ? params.cap.filter(value => typeof value === 'string') as string[] : []);
        return { proto: 1, minor: 11, server: peer.protocol === 'native-v1' ? 'dsh-remote-bridge' : 'dsh-nexus-web-remote', protocol: peer.protocol, capabilities: ['session.snapshot.page.v1', 'session.snapshot.since.v1', 'questions.v1', 'approvals.v1', 'nexus.tasks.v1', 'nexus.resources.v1', 'nexus.usage.v1'], grantedMethods: device ? [...readMethods, ...(device.capabilities ?? [])] : [], resume: 'snapshot', auth: peer.deviceId ? 'paired' : 'unpaired' };
      case 'pair.begin': {
        const service = peer.protocol === 'native-v1' ? pairing : webPairing;
        const key = typeof params.token === 'string' ? tokenHash(params.token) : '';
        const ticket = tickets.get(key);
        if (typeof params.token !== 'string' || !ticket || ticket.protocol !== peer.protocol || ticket.expiresAt <= Date.now() || !service.consumeToken(params.token)) throw new NexusError('token-invalid', '配对码无效、协议不匹配、已过期或已使用');
        tickets.delete(key); peer.pairingAuthorization = ticket.authorization;
        const nonce = service.issueNonce(); peer.nonce = nonce; return { nonce: nonce.value, expiresAt: nonce.expiresAt };
      }
      case 'pair.finish': {
        const nonce = peer.nonce, authorization = peer.pairingAuthorization; peer.nonce = undefined; peer.pairingAuthorization = undefined;
        const service = peer.protocol === 'native-v1' ? pairing : webPairing;
        if (!nonce || !authorization || !service.consumeNonce(nonce.value) || nonce.expiresAt <= Date.now()) throw new NexusError('nonce-invalid', '配对挑战已过期或使用');
        if (typeof params.devicePubKey !== 'string' || typeof params.signature !== 'string') throw new NexusError('invalid-args', '缺少 devicePubKey 或 signature');
        const raw = base64UrlDecode(nonce.value);
        if (!(raw && verifyEs256(params.devicePubKey, params.signature, raw)) && !verifyEs256(params.devicePubKey, params.signature, Buffer.from(nonce.value))) throw new NexusError('signature-invalid', 'P-256签名验证失败');
        const fingerprint = fingerprintOfSpki(params.devicePubKey);
        if (!fingerprint) throw new NexusError('invalid-args', '设备公钥无效');
        const deviceId = randomUUID(), deviceToken = randomBase64Url(32), now = new Date().toISOString();
        await services.store.put<NativeDevice>('nativeRemoteDevices', deviceId, { deviceId, tokenHash: tokenHash(deviceToken), publicKey: params.devicePubKey, fingerprint, name: typeof params.name === 'string' ? params.name.slice(0, 120) : peer.protocol === 'native-v1' ? '原生手机' : 'Web 设备', protocol: peer.protocol, ...authorization, pairedAt: now, lastSeenAt: now, revoked: false }, 0);
        peer.deviceId = deviceId; services.emit('connections.device.changed', { deviceId, state: 'paired', protocol: peer.protocol }); return { deviceId, deviceToken, grantedMethods: [...readMethods, ...authorization.capabilities] };
      }
      case 'session.list': case 'session.titles': {
        const result = await host('list', false, { ...params, projectRoot: context!.workspaceRoot, titlesOnly: method === 'session.titles' });
        const items = Array.isArray(result) ? result : Array.isArray(object(result).items) ? object(result).items as unknown[] : [];
        const allowed: JsonRecord[] = [];
        for (const value of items) {
          const item = object(value), id = String(item.sessionId ?? item.id ?? ''), cwd = item.cwd ?? object(item.header).cwd;
          if (!id || device!.sessionIds?.length && !device!.sessionIds.includes(id) || typeof cwd !== 'string') continue;
          if (await canonical(cwd) === await canonical(context!.workspaceRoot!)) allowed.push(item);
        }
        return Array.isArray(result) ? allowed : { ...object(result), items: allowed };
      }
      case 'session.snapshot': case 'session.history': case 'session.history.deep': return host('snapshot');
      case 'session.prompt': return host('prompt', true);
      case 'session.interrupt': return host('cancel', true);
      case 'session.attachment': return host('attachment', true);
      case 'session.permissions': return host('permissions');
      case 'session.setPermission': return host('setPermission', true);
      case 'session.models': return host('models.list');
      case 'session.setModel': return host('model.select', true);
      case 'session.create': case 'session.fork': {
        if (!(device!.capabilities ?? []).includes('session.setModel') && ['provider', 'model', 'route', 'reasoningEffort'].some(key => params[key] !== undefined)) throw new NexusError('PERMISSION_DENIED', '创建或分叉时选择模型需要独立的模型选择授权');
        const { parentId: _parentId, ...creation } = params;
        const input = { ...creation, cwd: context!.workspaceRoot, allowChildren: false, ...(!(device!.capabilities ?? []).includes('session.setPermission') ? { readOnly: true } : {}) };
        const result = await host(method === 'session.create' ? 'create' : 'fork', true, input);
        await allowNewSession(device!, result); return result;
      }
      case 'presets.list': return invoke('presets', 'list');
      case 'approval.resolve': return host('approval.resolve', true);
      case 'question.answer': return host('question.answer', true);
      case 'jobs.list': return invoke('runtime', 'jobs.list', { ...params, ...(context?.sessionId ? { sessionId: context.sessionId } : {}) });
      case 'tasks.snapshot': return invoke('workflow', 'todo/list');
      case 'tasks.options': return { actions: Object.keys(todoActions), statuses: ['pending', 'doing', 'blocked', 'done', 'cancelled'], scopes: ['life', 'work', 'project', 'daily', 'session'], quadrants: [1, 2, 3, 4], concurrency: 'expectedRevision', requestIdentity: 'stable-requestId', writable: (device!.capabilities ?? []).includes('tasks.apply') };
      case 'tasks.apply': {
        const action = typeof params.action === 'string' && Object.hasOwn(todoActions, params.action) ? todoActions[params.action] : undefined;
        if (!action) throw new NexusError('INVALID_ARGUMENT', '待办写入仅支持 create/update/archive/remove/import');
        const requestId = stableRequestId(params);
        const { action: _action, requestId: _requestId, target: _target, params: _nested, ...input } = businessParams(object(params.params ?? params));
        const id = object(params.target).id ?? input.id ?? params.id;
        if (object(params.target).id !== undefined && input.id !== undefined && object(params.target).id !== input.id) throw new NexusError('SCOPE_MISMATCH', '待办 target 与 params.id 不一致');
        const revision = params.expectedRevision ?? input.expectedRevision;
        if (revision !== undefined && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)) throw new NexusError('INVALID_ARGUMENT', 'expectedRevision 必须为非负安全整数');
        if (['todo/update', 'todo/archive', 'todo/remove'].includes(action) && (typeof id !== 'string' || !id || revision === undefined)) throw new NexusError('INVALID_ARGUMENT', '修改待办须携带 target id 与当前 expectedRevision');
        return invoke('workflow', action, input, { requestId, expectedRevision: revision as number | undefined, ...(typeof id === 'string' ? { target: { id } } : {}) }, new Set([`workflow.${action}`]));
      }
      case 'resources.list': return invoke('resources', 'list');
      case 'usage.summary': return invoke('usage', 'summary', { ...params, ...(context?.sessionId ? { sessionId: context.sessionId } : {}) });
      default: throw new NexusError('unknown-method', `未注册原生远程方法: ${method}`);
    }
  }
  return {
    issueToken(protocol: 'native-v1' | 'web-v1' = 'native-v1', authorization: { capabilities?: unknown; sessionId?: string; workspaceRoot?: string } = {}) {
      for (const [key, pending] of tickets) if (pending.expiresAt <= Date.now()) tickets.delete(key);
      const ticket = (protocol === 'native-v1' ? pairing : webPairing).issueToken();
      tickets.set(tokenHash(ticket.value), { protocol, expiresAt: ticket.expiresAt, authorization: { capabilities: remoteDeviceCapabilities(authorization.capabilities), workspaceRoot: authorization.workspaceRoot ?? services.workspaceRoot, ...(authorization.sessionId ? { sessionIds: [authorization.sessionId] } : {}) } });
      return ticket;
    },
    publish(topic: string, payload: unknown) {
      // Events invalidate a scoped snapshot; model text, credentials, paths and
      // mutation payloads never leave the Host through this broadcast channel.
      void Promise.allSettled([...peers].map(async peer => {
        if (!peer.deviceId || peer.signal.aborted) return;
        const row = await services.store.get<NativeDevice>('nativeRemoteDevices', peer.deviceId);
        if (!row || row.value.revoked || (row.value.protocol ?? 'native-v1') !== peer.protocol) { peer.socket.close(4003, 'revoked'); return; }
        const sessionId = object(payload).sessionId;
        if (row.value.sessionIds?.length && typeof sessionId === 'string' && !row.value.sessionIds.includes(sessionId)) return;
        send(peer, { t: 'ev', seq: ++peer.seq, m: topic, p: { changed: true } });
      }));
    },
    async devices() { return (await services.store.list<NativeDevice>('nativeRemoteDevices')).map(row => ({ deviceId: row.id, name: row.value.name, fingerprint: row.value.fingerprint, pairedAt: row.value.pairedAt, lastSeenAt: row.value.lastSeenAt, revoked: row.value.revoked, online: [...peers].some(peer => peer.deviceId === row.id), protocol: row.value.protocol ?? 'native-v1', capabilities: row.value.capabilities ?? [], sessionIds: row.value.sessionIds ?? null, revision: row.revision })); },
    async revoke(deviceId: string) {
      const row = await services.store.get<NativeDevice>('nativeRemoteDevices', deviceId);
      if (!row) throw new NexusError('NOT_FOUND', '原生设备不存在');
      await services.store.put('nativeRemoteDevices', deviceId, { ...row.value, revoked: true }, row.revision);
      for (const peer of peers) if (peer.deviceId === deviceId) peer.socket.close(4003, 'revoked');
      return { deviceId, revoked: true };
    },
    async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      if (disposed) { socket.end('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n'); return; }
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ios/v1' && url.pathname !== '/nexus/web/v1') { socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n'); return; }
      const header = request.headers.authorization, token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token') ?? undefined;
      const device = await authenticate(token);
      server.handleUpgrade(request, socket, head, ws => {
        const protocol = url.pathname === '/ios/v1' ? 'native-v1' : 'web-v1';
        const controller = new AbortController(), signal = services.signal ? AbortSignal.any([controller.signal, services.signal]) : controller.signal;
        const peer: Peer = { socket: ws, deviceId: device?.protocol === protocol || (!device?.protocol && protocol === 'native-v1') ? device?.deviceId : undefined, protocol, seq: 0, capabilities: new Set(), controller, signal }; peers.add(peer);
        let queue: Promise<unknown> = Promise.resolve();
        ws.on('message', data => {
          queue = queue.catch(() => undefined).then(async () => {
            const decoded = decodeClientFrame(data.toString());
            if (!decoded.ok) { send(peer, { t: 'res', id: decoded.id, ok: false, e: { code: decoded.code, msg: decoded.msg } }); return; }
            const frame = decoded.frame;
            if (frame.t === 'ping') { send(peer, { t: 'pong', ts: frame.ts }); return; }
            if (frame.t === 'pong') return;
            try { const result = await call(peer, frame.m, { ...frame.p }); send(peer, { t: 'res', id: frame.id, ok: true, r: result }); }
            catch (error) { send(peer, { t: 'res', id: frame.id, ok: false, e: { code: error instanceof NexusError ? error.code : 'internal', msg: error instanceof NexusError ? error.message : '远程调用失败' } }); }
          });
        });
        const ended = () => { controller.abort(); peer.pairingAuthorization = undefined; peers.delete(peer); };
        ws.on('close', ended); ws.on('error', ended);
      });
    },
    dispose() { disposed = true; for (const peer of peers) { peer.controller.abort(); peer.socket.close(1001, 'plugin disposed'); } peers.clear(); tickets.clear(); server.close(); },
  };
}

export type NativeRemoteBridge = ReturnType<typeof createNativeRemoteBridge>;
