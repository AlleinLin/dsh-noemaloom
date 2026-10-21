import { randomUUID } from 'node:crypto';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { NexusError, type DispatchContext, type NexusRequest } from '../ports/contracts.js';
import { hostAuthority } from './host-adapter.js';
import { redactSecrets, type Dispatcher, type NexusResponse } from '../domain/operations/index.js';
import type { HostContext } from './types.js';
import type { OperationController } from './lifecycle.js';
import { sessionWorkspaceRoot, workspaceRootById } from './session-metadata.js';
import { classifyFailure } from '../shared/error-codes.js';

const RPC_KEYS = new Set(['protocolVersion', 'method', 'scope', 'payload']);
function plain(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function carrierError(rpcId: string, message: string) {
  return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'nexus/bad-request', message, details: {} } } });
}
function success(data: unknown, requestId?: string): NexusResponse {
  return { ok: true, requestId: requestId ?? null, operationId: null, data, receipt: null, warnings: [], page: { nextCursor: null, truncated: false }, evidenceLevel: 'observed', traceId: `trace_${randomUUID()}`, error: null };
}
export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new NexusError('UNSUPPORTED_MEDIA_TYPE', '仅支持 JSON 请求');
  const announced = Number(request.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > maxBytes) throw new NexusError('PAYLOAD_TOO_LARGE', '请求超过大小上限');
  const reader = request.body?.getReader();
  if (!reader) throw new NexusError('INVALID_ARGUMENT', '请求正文为空');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new NexusError('PAYLOAD_TOO_LARGE', '请求超过大小上限'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new NexusError('INVALID_ARGUMENT', '请求不是有效 UTF-8 JSON'); }
}

/** Registration happens only through official owner-only exact Fetch routing. */
export function registerRpcRoute(ctx: HostContext, dispatcher: Dispatcher, controller: OperationController, maxBytes: number): () => Promise<void> {
  return ctx.connection.fetch.register({
    path: '/api/nexus/rpc', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let raw: unknown;
      try { raw = await readBoundedJson(request, maxBytes); }
      catch (error) {
        const code = error instanceof NexusError ? error.code : 'INVALID_ARGUMENT';
        return Response.json({ error: code }, { status: code === 'PAYLOAD_TOO_LARGE' ? 413 : code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : 400 });
      }
      const parsed = clientRequestSchema.safeParse(raw);
      if (!parsed.success) return Response.json({ error: 'invalid-envelope' }, { status: 400 });
      const envelope = parsed.data;
      if (envelope.method !== 'nexus/rpc') return carrierError(envelope.rpcId, '载体方法无效');
      const body = envelope.payload;
      if (!plain(body) || body.protocolVersion !== 1 || Object.keys(body).some(key => !RPC_KEYS.has(key))
        || typeof body.method !== 'string' || !plain(body.scope) || !plain(body.payload)
        || Object.keys(body.scope).some(key => !['level', 'sessionId', 'workspaceId'].includes(key))
        || (body.scope.sessionId !== undefined && (typeof body.scope.sessionId !== 'string' || !body.scope.sessionId.trim()))
        || (body.scope.workspaceId !== undefined && (typeof body.scope.workspaceId !== 'string' || !body.scope.workspaceId.trim()))
        || (body.scope.level !== undefined && !['global', 'workspace', 'session'].includes(body.scope.level))
        || (body.scope.level === 'global' && (body.scope.sessionId || body.scope.workspaceId))
        || (body.scope.level === 'session' && !body.scope.sessionId)
        || (body.scope.level === 'workspace' && body.scope.sessionId)) {
        return carrierError(envelope.rpcId, 'Nexus 协议或范围无效');
      }
      const payload = body.payload as NexusRequest;
      try {
        const result = await controller.run(request.signal, async signal => {
          const context: DispatchContext = { signal, actorId: 'connection-owner', sessionId: body.scope.sessionId,
            scopeLevel: body.scope.level ?? (body.scope.sessionId ? 'session' : 'workspace'),
            workspaceId: body.scope.workspaceId, workspaceRoot: dispatcher.services.workspaceRoot };
          if (body.method === 'host.probe') {
            if (payload.action !== 'probe') throw new NexusError('INVALID_ARGUMENT', 'probe action 无效');
            return success(await dispatcher.services.host.facts(), payload.requestId);
          }
          if (body.method === 'nexus.snapshot') {
            const capabilities = dispatcher.capabilities();
            const domains = [...new Set(capabilities.map(item => item.domain))].map(id => ({
              id, capabilities: capabilities.filter(item => item.domain === id),
            }));
            return success({ capabilities: { domains }, facts: await dispatcher.services.host.facts() }, payload.requestId);
          }
          if (!['nexus.command', 'nexus.query'].includes(body.method)) throw new NexusError('INVALID_ARGUMENT', '业务方法不在注册表中');
          const domain = payload.params?.domain;
          if (typeof domain !== 'string') throw new NexusError('INVALID_ARGUMENT', 'params.domain 必须为已注册领域');
          if (payload.action.startsWith('native/')) throw new NexusError('PERMISSION_DENIED', '原生宿主提交仅允许内部事务调用');
          const { domain: _reserved, ...params } = payload.params!;
          const capability = dispatcher.capabilities(domain).find(item => item.action === payload.action);
          if (!capability) throw new NexusError('NOT_FOUND', '此领域动作未注册');
          if (body.method === 'nexus.query' && capability.mutating) throw new NexusError('PERMISSION_DENIED', '查询载体不能执行写操作');
          if (context.sessionId) context.workspaceRoot = await sessionWorkspaceRoot(ctx, context.sessionId, signal);
          if (context.workspaceId && context.workspaceId !== 'default') {
            const workspaceRoot = await workspaceRootById(ctx, context.workspaceId, signal);
            if (context.sessionId && workspaceRoot.toLowerCase() !== context.workspaceRoot!.toLowerCase()) throw new NexusError('PERMISSION_DENIED', '会话不属于所选工作区');
            context.workspaceRoot = workspaceRoot;
          }
          if (context.scopeLevel === 'workspace' && body.scope.level && !context.workspaceId) throw new NexusError('INVALID_ARGUMENT', '请选择原生工作区');
          // This exact route has already passed Connection owner authentication.
          // A user's explicit command carries only its exact action intent.
          const permission = capability.permission ?? `${domain}.${payload.action}`;
          const authority = { ...context, permissions: new Set(body.method === 'nexus.command' ? [permission, `${domain}.${payload.action}`] : []), ownerIntent: body.method === 'nexus.command' ? `${domain}.${payload.action}` : undefined };
          return hostAuthority.run(authority, () => dispatcher.dispatch(domain, { ...payload, params }, authority));
        });
        return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: result } });
      } catch (error) {
        const code = error instanceof NexusError ? error.code : 'INTERNAL';
        const response = success(null, payload.requestId);
        response.ok = false;
        const diagnosis = classifyFailure(error, { phase: 'connection-rpc', signalAborted: request.signal.aborted });
        response.error = { code, diagnosticCode: diagnosis.diagnosticCode, phase: diagnosis.phase,
          message: error instanceof NexusError ? String(redactSecrets(error.message)) : diagnosis.message,
          retryable: false, details: null, operationId: null, traceId: response.traceId, effects: [] };
        return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: response } });
      }
    },
  });
}
