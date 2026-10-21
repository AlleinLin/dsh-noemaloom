import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  NexusError,
  isNexusError,
  type Capability,
  type DispatchContext,
  type JsonRecord,
  type NexusModule,
  type NexusRequest,
  type NexusServices,
} from '../../ports/contracts.js';
import { canonicalJson, createLeaseManager, jsonClone, sha256 } from '../storage/index.js';
import { classifyFailure } from '../../shared/error-codes.js';

export interface NexusFailure {
  code: string;
  diagnosticCode?: string;
  phase?: string;
  message: string;
  retryable: boolean;
  details: unknown;
  operationId: string | null;
  traceId: string;
  effects: unknown;
}

export interface OperationReceipt {
  id: string;
  requestId: string;
  operationId: string | null;
  requestDigest: string;
  outcome: 'succeeded' | 'failed';
  effects: unknown;
  timestamp: string;
}

/** The single public response shape for native tools, Connection RPC and UI. */
export interface NexusResponse<T = unknown> {
  ok: boolean;
  requestId: string | null;
  operationId: string | null;
  data: T | null;
  receipt: OperationReceipt | null;
  warnings: string[];
  page: { nextCursor: string | null; truncated: boolean };
  evidenceLevel: 'observed' | 'persisted';
  traceId: string;
  error: NexusFailure | null;
}

export interface RegisteredCapability extends Capability {
  domain: string;
}

interface Registration {
  module: NexusModule;
  actions: ReadonlyMap<string, Readonly<Capability>>;
  token: symbol;
}

interface IntentRecord {
  schemaVersion: 1;
  requestId: string;
  requestDigest: string;
  scopeDigest: string;
  state: 'started' | 'finished';
  startedAt: string;
  traceId: string;
  response?: NexusResponse;
}

const RECEIPTS = '__nexus_operation_receipts_v1';
const RETRYABLE = new Set(['RATE_LIMITED', 'UPSTREAM_UNAVAILABLE', 'RESYNC_REQUIRED']);
export const SECRET_KEY = /(?:secret|password|passwd|authorization|cookie|(?:^|[_-])token(?:$|[_-])|(?:access|refresh|api|auth|id)[_-]?token|api[_-]?key|private[_-]?key|credential|access[_-]?key)/i;
const REQUEST_KEYS = new Set(['action', 'requestId', 'target', 'params', 'expectedRevision', 'cursor', 'limit']);
const CATALOG_CAPABILITIES: Capability[] = [
  { action: 'capabilities', description: '列出已注册的真实领域与动作权限。' },
  { action: 'list', description: '分页列出已注册的真实领域与动作。' },
  { action: 'search', description: '搜索领域能力及其描述。' },
  { action: 'describe', description: '读取指定领域或动作的合同。' },
  { action: 'read', description: '读取指定领域或动作的合同。' },
];

export function redactString(text: string, maxLength = 8192): string {
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|sk-ant|ghp|github_pat|glpat)[-_][A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/("(?:[\w.-]*[_-])?(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[REDACTED]"')
    .replace(/\b((?:[\w.-]*[_-])?(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s<>"']+/gi, (candidate) => {
      try {
        const url = new URL(candidate);
        if (url.username) url.username = 'REDACTED';
        if (url.password) url.password = 'REDACTED';
        // Even unrecognized query names can carry account credentials.
        if (url.search) url.search = '?[REDACTED]';
        if (url.hash) url.hash = '#[REDACTED]';
        return url.toString();
      } catch {
        return '[REDACTED_URL]';
      }
    })
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, '[USER_HOME]')
    .replace(/\/(?:home|Users)\/[^/\s]+/g, '[USER_HOME]')
    .slice(0, maxLength);
}

/** Exceptions and effect diagnostics pass here; arbitrary stacks are never returned. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[REDACTED_DEPTH]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactSecrets(item, depth + 1));
  if (typeof value === 'object') {
    const result: JsonRecord = Object.create(null);
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      result[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactSecrets(item, depth + 1);
    }
    return result;
  }
  return null;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDomain(value: string): string {
  if (typeof value !== 'string' || !/^(?:nexus_)?[a-z][a-z0-9_-]{0,127}$/.test(value)) {
    throw new NexusError('INVALID_ARGUMENT', '领域名称无效。');
  }
  return value.replace(/^nexus_/, '');
}

function normalizeRequest(input: NexusRequest): NexusRequest {
  if (!isRecord(input)) throw new NexusError('INVALID_ARGUMENT', '请求必须是 JSON 对象。');
  if (Object.keys(input).some((key) => !REQUEST_KEYS.has(key))) {
    throw new NexusError('INVALID_ARGUMENT', '请求含有未知字段。');
  }
  if (typeof input.action !== 'string' || !input.action.trim() || input.action.length > 256) {
    throw new NexusError('INVALID_ARGUMENT', 'action 必须是非空字符串。');
  }
  if (input.requestId !== undefined && (typeof input.requestId !== 'string'
    || !input.requestId.trim() || input.requestId.length > 512 || /[\u0000-\u001f]/.test(input.requestId))) {
    throw new NexusError('INVALID_ARGUMENT', 'requestId 必须是有效的非空意图标识。');
  }
  if (input.params !== undefined && !isRecord(input.params)) throw new NexusError('INVALID_ARGUMENT', 'params 必须是对象。');
  if (input.target !== undefined && (!isRecord(input.target)
    || (input.target.id !== undefined && typeof input.target.id !== 'string'))) {
    throw new NexusError('INVALID_ARGUMENT', 'target 必须是带可选字符串 id 的对象。');
  }
  if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) {
    throw new NexusError('INVALID_ARGUMENT', 'expectedRevision 必须为非负整数。');
  }
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200)) {
    throw new NexusError('INVALID_ARGUMENT', 'limit 必须为 1 至 200 之间的整数。');
  }
  if (input.cursor !== undefined && input.cursor !== null && (typeof input.cursor !== 'string' || input.cursor.length > 8192)) {
    throw new NexusError('INVALID_ARGUMENT', 'cursor 必须为字符串或 null。');
  }
  return jsonClone({
    action: input.action,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    target: input.target ?? {},
    params: input.params ?? {},
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    cursor: input.cursor ?? null,
    limit: input.limit ?? 20,
  });
}

function responseBase(requestId: string | null, traceId: string): NexusResponse {
  return {
    ok: true,
    requestId,
    operationId: null,
    data: null,
    receipt: null,
    warnings: [],
    page: { nextCursor: null, truncated: false },
    evidenceLevel: 'observed',
    traceId,
    error: null,
  };
}

function failed(error: unknown, requestId: string | null, traceId: string, mutating = false): NexusResponse {
  const known = isNexusError(error);
  // Domain codes are part of the public diagnostic contract. Do not erase a
  // CTX_* failure merely because it was added after this dispatcher.
  const code = known ? error.code : 'INTERNAL';
  const diagnosis = classifyFailure(error, { phase: 'domain-dispatch' });
  const originalDetails = known ? error.details : undefined;
  const details = redactSecrets(originalDetails);
  const effectState = isRecord(originalDetails) && originalDetails.effects !== undefined
    ? redactSecrets(originalDetails.effects)
    : mutating ? { state: 'unknown', verificationRequired: true } : [];
  const operationId = isRecord(originalDetails) && typeof originalDetails.operationId === 'string'
    ? originalDetails.operationId : null;
  return {
    ...responseBase(requestId, traceId),
    ok: false,
    operationId,
    error: {
      code,
      diagnosticCode: diagnosis.diagnosticCode,
      phase: diagnosis.phase,
      message: code === 'INTERNAL' ? '操作失败，请使用 traceId 检查脱敏诊断。' : redactString((error as NexusError).message),
      retryable: RETRYABLE.has(code),
      details,
      operationId,
      traceId,
      effects: effectState,
    },
  };
}

function succeeded(data: unknown, requestId: string | null, traceId: string): NexusResponse {
  const response = responseBase(requestId, traceId);
  response.data = data === undefined ? null : jsonClone(data);
  if (isRecord(data)) {
    if (typeof data.operationId === 'string') response.operationId = data.operationId;
    if (Array.isArray(data.warnings)) response.warnings = data.warnings.filter((item): item is string => typeof item === 'string').map(redactString);
    const page = isRecord(data.page) ? data.page : data;
    if (typeof page.nextCursor === 'string') response.page.nextCursor = page.nextCursor;
    if (page.truncated === true) response.page.truncated = true;
  }
  return response;
}

export class Dispatcher {
  readonly services: NexusServices;
  private readonly registry = new Map<string, Registration>();
  private readonly context = new AsyncLocalStorage<DispatchContext>();
  private readonly parentIntents = new AsyncLocalStorage<{ requestId: string; nextChild: number }>();
  private readonly executingIntents = new AsyncLocalStorage<ReadonlySet<string>>();
  private readonly leases;
  private readonly active = new Set<Promise<unknown>>();
  private quiescing = false;
  private disposed = false;

  constructor(private readonly base: Omit<NexusServices, 'invoke'>, modules: NexusModule[] = []) {
    this.leases = createLeaseManager(join(base.dataDir, 'operations-v1', 'leases'));
    const dispatcher = this;
    this.services = {
      ...base,
      get signal() { return dispatcher.context.getStore()?.signal ?? base.signal; },
      async readReceipt(requestId, context) { return dispatcher.readReceipt(requestId, context); },
      async invoke(domain, request, context) {
        let intent = request;
        const parent = dispatcher.parentIntents.getStore();
        const normalizedDomain = normalizeDomain(domain);
        const capability = dispatcher.registry.get(normalizedDomain)?.actions.get(request.action);
        if (parent && capability?.mutating && request.requestId === undefined) {
          const normalized = normalizeRequest(request);
          intent = { ...request, requestId: `child_${sha256(canonicalJson({
            parentRequestId: parent.requestId, ordinal: parent.nextChild++,
            domain: normalizedDomain, request: normalized,
          }))}` };
        }
        const result = await dispatcher.dispatch(domain, intent, context);
        if (!result.ok) {
          throw new NexusError(result.error!.code, result.error!.message, {
            ...(isRecord(result.error!.details) ? result.error!.details : {}),
            operationId: result.operationId,
            effects: result.error!.effects,
            traceId: result.traceId,
          });
        }
        return result.data;
      },
    };
    for (const module of modules) this.register(module);
  }

  register(module: NexusModule): () => void {
    if (this.quiescing || this.disposed) throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '分发器正在停用，不能注册模块。');
    const id = normalizeDomain(module.id);
    if (this.registry.has(id)) throw new NexusError('INVALID_ARGUMENT', `领域 ${id} 已注册。`);
    if (!Array.isArray(module.capabilities) || typeof module.dispatch !== 'function') {
      throw new NexusError('INVALID_ARGUMENT', '模块缺少能力声明或分发函数。');
    }
    const actions = new Map<string, Readonly<Capability>>();
    for (const input of module.capabilities) {
      if (typeof input.action !== 'string' || !input.action.trim() || actions.has(input.action)
        || typeof input.description !== 'string'
        || (input.permission !== undefined && (typeof input.permission !== 'string' || !input.permission.trim()))
        || (input.mutating !== undefined && typeof input.mutating !== 'boolean')) {
        throw new NexusError('INVALID_ARGUMENT', `领域 ${id} 包含无效或重复的能力声明。`);
      }
      // Copy metadata so later mutation of an upstream module cannot lower its permissions.
      actions.set(input.action, Object.freeze(jsonClone(input)));
    }
    const token = Symbol(id);
    this.registry.set(id, { module, actions, token });
    return () => {
      if (this.registry.get(id)?.token === token) this.registry.delete(id);
    };
  }

  capabilities(domain?: string): RegisteredCapability[] {
    const filter = domain === undefined ? undefined : normalizeDomain(domain);
    const result: RegisteredCapability[] = [];
    for (const [id, registration] of this.registry) {
      if (filter && id !== filter) continue;
      for (const action of registration.actions.values()) result.push({ domain: id, ...jsonClone(action) });
    }
    if (!this.registry.has('catalog') && (!filter || filter === 'catalog')) {
      for (const action of CATALOG_CAPABILITIES) result.push({ domain: 'catalog', ...jsonClone(action) });
    }
    return result.sort((left, right) => `${left.domain}.${left.action}`.localeCompare(`${right.domain}.${right.action}`, 'en'));
  }

  private dispatchContext(explicit?: DispatchContext): DispatchContext {
    const inherited = this.context.getStore();
    const source = explicit ?? inherited ?? {};
    return {
      ...source,
      actorId: source.actorId ?? inherited?.actorId ?? 'host-owner',
      workspaceRoot: source.workspaceRoot ?? inherited?.workspaceRoot ?? this.base.workspaceRoot,
      signal: source.signal ?? inherited?.signal ?? this.base.signal,
      // A caller can supply verified permissions through the trusted port only.
      // Nothing from request.params or RPC scope is consulted here.
      permissions: source.permissions === undefined
        ? inherited?.permissions === undefined ? undefined : new Set(inherited.permissions)
        : new Set(source.permissions),
    };
  }

  private async scope(context: DispatchContext): Promise<{ digest: string; actorId: string; workspace: string }> {
    const workspace = resolve(context.workspaceRoot ?? this.base.workspaceRoot);
    let canonicalWorkspace: string;
    try {
      canonicalWorkspace = await realpath(workspace);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      canonicalWorkspace = workspace;
    }
    const actorId = context.actorId ?? 'host-owner';
    return { digest: sha256(canonicalJson({ actorId, workspace: canonicalWorkspace,
      ...(context.scopeLevel || context.sessionId ? { level: context.scopeLevel ?? 'session', sessionId: context.sessionId ?? null } : {}),
    })), actorId, workspace: canonicalWorkspace };
  }

  private async authorize(domain: string, capability: Readonly<Capability>, request: NexusRequest, context: DispatchContext): Promise<void> {
    const permission = capability.permission ?? (capability.mutating ? `nexus:${domain}:${capability.action}` : undefined);
    if (!permission) return;
    if (context.permissions?.has(permission) || context.permissions?.has(`${domain}.${capability.action}`)) return;
    const resource = `${context.workspaceRoot ?? this.base.workspaceRoot}#${domain}/${request.target?.id ?? '*'}`;
    let accepted: boolean;
    try {
      accepted = await this.base.host.approve(permission, resource, {
        domain,
        action: capability.action,
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        ...(context.actorId ? { actorId: context.actorId } : {}),
        ...(request.requestId ? { requestId: request.requestId } : {}),
        ...(request.target?.id ? { targetId: request.target.id } : {}),
        ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
      });
    } catch {
      throw new NexusError('PERMISSION_REQUIRED', '宿主未能提供所需范围的授权。', { permission, domain, action: capability.action });
    }
    if (!accepted) throw new NexusError('PERMISSION_DENIED', '宿主拒绝了当前动作。', { permission, domain, action: capability.action });
  }

  private async catalog(request: NexusRequest): Promise<unknown> {
    const params = request.params ?? {};
    const domain = typeof params.domain === 'string' ? params.domain : undefined;
    let available = this.capabilities(domain);
    const reference = request.target?.id;
    const action = typeof params.action === 'string' ? params.action : undefined;
    if (request.action === 'describe' || request.action === 'read') {
      if (reference) available = available.filter((item) => item.domain === reference || `${item.domain}.${item.action}` === reference);
      if (action) available = available.filter((item) => item.action === action);
      if (!available.length) throw new NexusError('NOT_FOUND', '未找到已注册的能力。');
      return { capabilities: available };
    }
    if (request.action === 'search') {
      const query = typeof params.query === 'string' ? params.query.toLocaleLowerCase() : '';
      available = available.filter((item) => `${item.domain}.${item.action} ${item.description}`.toLocaleLowerCase().includes(query));
    }
    const catalogDigest = sha256(canonicalJson(available));
    let offset = 0;
    if (request.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')) as { digest: string; offset: number };
        if (cursor.digest !== catalogDigest) throw new NexusError('RESYNC_REQUIRED', '能力目录已变化，请重新读取。');
        if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > available.length) throw new Error('invalid offset');
        offset = cursor.offset;
      } catch (error) {
        if (isNexusError(error)) throw error;
        throw new NexusError('INVALID_ARGUMENT', '能力目录分页游标无效。');
      }
    }
    const limit = request.limit ?? 20;
    const nextOffset = offset + limit;
    const nextCursor = nextOffset < available.length
      ? Buffer.from(canonicalJson({ digest: catalogDigest, offset: nextOffset })).toString('base64url') : null;
    return { capabilities: available.slice(offset, nextOffset), total: available.length, page: { nextCursor, truncated: nextCursor !== null } };
  }

  dispatch(domain: string, request: NexusRequest, context?: DispatchContext): Promise<NexusResponse> {
    const running = this.perform(domain, request, context);
    this.active.add(running);
    void running.finally(() => this.active.delete(running)).catch(() => undefined);
    return running;
  }

  /** Public alias; internal services.invoke unwraps the same envelope. */
  invoke(domain: string, request: NexusRequest, context?: DispatchContext): Promise<NexusResponse> {
    return this.dispatch(domain, request, context);
  }

  private async perform(domainInput: string, input: NexusRequest, explicit?: DispatchContext): Promise<NexusResponse> {
    const traceId = `trace_${randomUUID()}`;
    let requestId = typeof input?.requestId === 'string' ? input.requestId : null;
    try {
      const domain = normalizeDomain(domainInput);
      const request = normalizeRequest(input);
      requestId = request.requestId ?? null;
      const context = this.dispatchContext(explicit);
      if (context.signal?.aborted) throw new NexusError('CANCELLED', '操作已取消。');
      if (this.disposed) throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '分发器已停用。');
      const registration = this.registry.get(domain);
      const capability = registration?.actions.get(request.action)
        ?? (domain === 'catalog' && !registration ? CATALOG_CAPABILITIES.find((item) => item.action === request.action) : undefined);
      if (!capability) throw new NexusError('NOT_FOUND', '未找到已注册的领域动作。', { domain, action: request.action });
      if (this.quiescing && capability.mutating) throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '分发器正在停止接收新写操作。');
      if (capability.mutating && !requestId) throw new NexusError('INVALID_ARGUMENT', '写操作必须提供 requestId。');
      await this.authorize(domain, capability, request, context);
      const execute = async (): Promise<unknown> => {
        if (context.signal?.aborted) throw new NexusError('CANCELLED', '操作已取消。');
        const invoke = () => this.context.run(context, () => registration
          ? registration.module.dispatch(request, context)
          : this.catalog(request));
        return capability.mutating && request.requestId
          ? this.parentIntents.run({ requestId: request.requestId, nextChild: 0 }, invoke)
          : invoke();
      };
      if (!capability.mutating) {
        try {
          return succeeded(await execute(), requestId, traceId);
        } catch (error) {
          return failed(error, requestId, traceId);
        }
      }
      const scope = await this.scope(context);
      const id = sha256(canonicalJson({ scope: scope.digest, requestId }));
      const { requestId: _intentId, ...intent } = request;
      const digest = sha256(canonicalJson({ domain, request: intent }));
      if (this.executingIntents.getStore()?.has(id)) {
        throw new NexusError('IDEMPOTENCY_CONFLICT', '子动作必须使用独立的 requestId，不能复用正在执行的父意图。');
      }
      return await this.leases.withLease(id, async (lease) => {
        const prior = await this.base.store.get<IntentRecord>(RECEIPTS, id);
        if (!prior && (context.scopeLevel || context.sessionId)) {
          const legacyDigest = sha256(canonicalJson({ actorId: scope.actorId, workspace: scope.workspace }));
          const legacyId = sha256(canonicalJson({ scope: legacyDigest, requestId }));
          const legacy = await this.base.store.get<IntentRecord>(RECEIPTS, legacyId);
          if (legacy) throw new NexusError('PARTIAL_EFFECT', '发现旧版本未绑定会话的操作回执，请核验后使用新的请求标识', {
            receiptId: legacyId, effects: { state: 'unknown', verificationRequired: true, automaticReplay: false },
          });
        }
        if (prior) {
          const saved = prior.value;
          if (saved.schemaVersion !== 1 || saved.scopeDigest !== scope.digest || saved.requestId !== requestId) {
            throw new NexusError('INTEGRITY_FAILED', '动作回执身份校验失败。');
          }
          if (saved.requestDigest !== digest) throw new NexusError('IDEMPOTENCY_CONFLICT', '该 requestId 已用于不同意图，请生成新的 requestId。');
          if (saved.state === 'finished' && saved.response) return jsonClone(saved.response);
          // A previous process may have committed an external effect before dying.
          // Domain recovery must inspect that effect; automatic replay is unsafe.
          throw new NexusError('PARTIAL_EFFECT', '先前执行已中断，必须核验其效果后再决定后续动作。', {
            receiptId: id,
            originalTraceId: saved.traceId,
            effects: { state: 'unknown', verificationRequired: true, automaticReplay: false },
          });
        }
        const intentRecord: IntentRecord = {
          schemaVersion: 1,
          requestId: requestId!,
          requestDigest: digest,
          scopeDigest: scope.digest,
          state: 'started',
          startedAt: new Date().toISOString(),
          traceId,
        };
        const started = await this.base.store.put(RECEIPTS, id, intentRecord, 0);
        let response: NexusResponse;
        try {
          const activeIntents = new Set(this.executingIntents.getStore());
          activeIntents.add(id);
          response = succeeded(await this.executingIntents.run(activeIntents, execute), requestId, traceId);
        } catch (error) {
          response = failed(error, requestId, traceId, true);
        }
        const effects = response.ok
          ? isRecord(response.data) && response.data.effects !== undefined
            ? redactSecrets(response.data.effects)
            : { state: 'handler_returned', domainOutcome: isRecord(response.data) ? response.data.domainOutcome ?? null : null }
          : response.error!.effects;
        response.receipt = {
          id,
          requestId: requestId!,
          operationId: response.operationId,
          requestDigest: digest,
          outcome: response.ok ? 'succeeded' : 'failed',
          effects,
          timestamp: new Date().toISOString(),
        };
        response.evidenceLevel = 'persisted';
        // Redaction accumulates untrusted keys in null-prototype dictionaries.
        // Canonicalize the complete public value before storing and returning it
        // so the first response and JSON receipt replay have identical shapes.
        response = jsonClone(response);
        await lease.assertOwned();
        try {
          await this.base.store.put(RECEIPTS, id, { ...intentRecord, state: 'finished', response } satisfies IntentRecord, started.revision);
        } catch {
          // The durable started intent prevents a second execution after this gap.
          throw new NexusError('PARTIAL_EFFECT', '动作已执行，但最终回执未能持久化；请先核验效果。', {
            receiptId: id,
            effects: { state: 'unknown', verificationRequired: true, automaticReplay: false },
          });
        }
        try {
          this.base.emit('nexus.operation.committed', {
            receiptId: id, domain, action: request.action, requestId, traceId, ok: response.ok, operationId: response.operationId,
          });
        } catch {
          // Observers cannot roll back an already durable receipt or change its result.
        }
        return response;
      }, context.signal);
    } catch (error) {
      return failed(error, requestId, traceId);
    }
  }

  /** Receipt lookup is scoped exactly like execution; it never searches another actor. */
  async readReceipt(requestId: string, explicit?: DispatchContext): Promise<NexusResponse | undefined> {
    const context = this.dispatchContext(explicit);
    const scope = await this.scope(context);
    const id = sha256(canonicalJson({ scope: scope.digest, requestId }));
    const record = await this.base.store.get<IntentRecord>(RECEIPTS, id);
    if (!record || record.value.state !== 'finished') return undefined;
    return record.value.response ? jsonClone(record.value.response) : undefined;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.quiescing = true;
    await Promise.allSettled([...this.active]);
    const failures: unknown[] = [];
    for (const registration of [...this.registry.values()].reverse()) {
      try { await registration.module.dispose?.(); } catch (error) { failures.push(error); }
    }
    this.registry.clear();
    this.disposed = true;
    if (failures.length) throw new NexusError('INTERNAL', '部分领域资源未能完成清理。', { failedDisposers: failures.length });
  }
}

export function createDispatcher(base: Omit<NexusServices, 'invoke'>, modules: NexusModule[] = []): Dispatcher {
  return new Dispatcher(base, modules);
}
