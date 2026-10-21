import { sessionWorkspaceRoot } from './session-metadata.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { NexusError, type Capability, type ChildActivation, type DispatchContext, type JsonRecord, type ModelRequest, type ModelResult, type NexusHost, type NexusServices } from '../ports/contracts.js';
import type { HostContext, NexusConfig } from './types.js';
import { createSessionBridge } from './session-bridge.js';
import { createExtensionBridge } from './extension-bridge.js';
import { resourceHostAction } from './resource-services.js';
import { installExecutionPolicy, type ExecutionPolicy } from './execution-policy.js';
import { coreToNative, nativeToCore, type NativeMessage } from '../adapters/upstream/billion/native.js';
import { NEXUS_SOURCE } from './source.js';
import { createExtensionClientBridge } from './extension-client-bridge.js';
import { HostAttemptTracker, type ExplicitAttempt } from './attempt-policy.js';
import { optionalChildField, resolveChildModelOptions } from './child-models.js';
import { beginContextRequest } from '../domain/context/request-lifecycle.js';
import { analysisSurface } from '../domain/insights/surface.js';
import { join } from 'node:path';
import { ObservationOutbox } from './observation-outbox.js';
import { recordRecoveryDiagnostic, registerRequestRecovery } from './request-recovery.js';
import { annotateNativeFailure, nativeErrorIdentity, nativeFailureFacts, toHarnessError, toNativeLlmError } from './native-diagnostics.js';
import { classifyFailure } from '../shared/error-codes.js';
import { workspaceIdentity } from '../domain/workspace-runtime.js';
import { nativeCompactionFor } from './compaction-binding.js';

export const hostAuthority = new AsyncLocalStorage<DispatchContext & { ownerIntent?: string; toolExecution?: any }>();

function requireService(ctx: HostContext, name: string, method: string): any {
  const service = ctx.get(name);
  if (typeof service?.[method] !== 'function') throw new NexusError('DEPENDENCY_MISSING', `DSH ${name}.${method} 服务不可用`);
  return service;
}

export function createHostAdapter(ctx: HostContext, config: NexusConfig, workspaceRoot: string, pluginSignal: AbortSignal) {
  let services: NexusServices;
  let capabilities: (domain: string) => Capability[] = () => [];
  const children = new Set<any>();
  const observedChildRoutes = new Map<string, { provider: string; model: string }>();
  const auxiliaryAttempts = new WeakMap<object, ExplicitAttempt>();
  const removeRecovery = registerRequestRecovery(ctx);
  const attempts = new HostAttemptTracker(ctx, (options, facts) => {
    if (auxiliaryAttempts.get(options)?.isolated) {
      services?.emit('auxiliary/diagnostic', { ...facts, sessionId: options.sessionId });
      return Promise.resolve();
    }
    return recordRecoveryDiagnostic(ctx, String(options.sessionId ?? ''), facts);
  });
  const policies = new Map<string, ExecutionPolicy>();
  const removePolicy = installExecutionPolicy(ctx, policies, domain => capabilities(domain));
  const sessionBridge = createSessionBridge(ctx, config, workspaceRoot, pluginSignal, () => services);
  // Browser ACK transport remains alive while server generations release it.
  const clientLifetime = new AbortController();
  const clientBridge = ctx.get('connection')?.rpc?.handle && ctx.get('connection')?.fetch?.register
    ? createExtensionClientBridge(ctx, () => services, clientLifetime.signal) : undefined;
  const removeClientService = clientBridge ? ctx.provide('nexusExtensionClients', clientBridge) : undefined;
  const extensionBridge = createExtensionBridge(ctx, () => services, pluginSignal);
  const invoke = async (domain: string, action: string, params: JsonRecord, requestId?: string, signal?: AbortSignal) =>
    services.invoke(domain, { action, params, requestId }, { permissions: new Set([`${domain}.${action}`]), ...(signal ? { signal } : {}) });
  const routed = (request: ModelRequest) => {
    if (request.independentRoute) {
      if (!request.provider || !request.model) throw new NexusError('AUXILIARY_NOT_CONFIGURED', '独立辅助请求必须显式指定 provider/model');
      return { provider: request.provider, model: request.model, ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}) };
    }
    const role = config.modelRoutes?.[request.role];
    const parentId = request.parentId ?? request.sessionId ?? hostAuthority.getStore()?.sessionId;
    const parent = parentId ? ctx.get('agents')?.get?.(parentId) : undefined;
    const inherited = parent?.session?.requestHeader?.()?.config ?? parent?.options;
    const provider = request.provider ?? role?.provider ?? inherited?.provider;
    const model = request.model ?? role?.model ?? inherited?.model;
    if (!provider || !model) throw new NexusError('DEPENDENCY_MISSING', `角色 ${request.role} 尚未配置精确 provider/model 路由`);
    if (request.credentialScope && request.credentialScope !== role?.credentialScope) throw new NexusError('PERMISSION_DENIED', '凭据范围与已批准角色路由不匹配');
    return { provider, model, ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}), ...(request.reasoningEffort ?? role?.reasoningEffort ? { reasoningEffort: request.reasoningEffort ?? role?.reasoningEffort } : {}) };
  };
  const account = async (facts: JsonRecord, dispatchId: string): Promise<void> => {
    const signal = AbortSignal.timeout(5000);
    const sessionId = typeof facts.sessionId === 'string' ? facts.sessionId : undefined;
    let root: string | undefined;
    if (sessionId) { try { root = await sessionWorkspaceRoot(ctx, sessionId, signal); } catch { signal.throwIfAborted(); } }
    await services.invoke('usage', { action: 'record', params: facts, requestId: dispatchId },
      { scopeLevel: root ? 'session' : 'global', sessionId, workspaceRoot: root, permissions: new Set(['usage.record']), signal });
  };
  const observations = new ObservationOutbox(
    () => join(services.dataDir, 'observation-outbox'),
    async (kind, facts, dispatchId) => {
      if (kind === 'usage') { await account(facts, dispatchId); return; }
      await services.invoke('context', { action: 'complete', requestId: dispatchId, params: facts }, {
        actorId: 'native-model-observer', sessionId: String(facts.sessionId),
        signal: AbortSignal.timeout(5000), permissions: new Set(['context.complete']),
      });
    },
    (code, facts) => {
      ctx.logger?.warn('Nexus accounting observation', { code, ...facts });
      if (typeof facts?.sessionId === 'string') void recordRecoveryDiagnostic(ctx, facts.sessionId, {
        ...facts, diagnosticCode: code === 'OBSERVATION_DEFERRED' ? 'NX_OBSERVATION_DEFERRED' : 'NX_RECOVERY_FAILED',
        phase: 'accounting-observation', stopReason: code,
      });
    },
  );
  const host: NexusHost & { connect(services: NexusServices, catalog?: (domain: string) => Capability[]): void; initialize(): Promise<void>; dispose(): Promise<void> } = {
    connect(value, catalog) { services = value; if (catalog) capabilities = catalog; },
    async initialize() { await extensionBridge.restore(); await observations.start(); },
    async facts() {
      const profile = ctx.get('profileContext');
      const available = ['connection', 'tools', 'llm', 'agents', 'sessions', 'subagents', 'subprocess', 'sandboxPolicy', 'sandbox', 'credentials', 'approval', 'pluginManager', 'agentPresets'];
      const llm = ctx.get('llm');
      const policy = ctx.get('sandboxPolicy')?.resolve?.();
      return {
        protocolVersion: 1, pluginBuild: '0.4.0', expectedDshVersion: '0.2.1-rc.2',
        runtime: { node: process.version, modules: process.versions.modules, napi: process.versions.napi, platform: process.platform, arch: process.arch },
        profile: profile?.name ?? 'unprofiled', workspaceRoot,
        capabilities: available.filter(name => Boolean(ctx.get(name))),
        sandbox: policy ? { mode: policy.mode, workspaceRoot: policy.workspaceRoot } : null,
        providers: llm?.listProviders ? await llm.listProviders() : [],
        modelRoutes: config.modelRoutes ?? {},
        agentOptionsSupported: Boolean(ctx.get('subagents')?.startActivation),
        attemptPolicySupported: true,
        attemptBoundary: 'llm-runtime-stream',
        providerHttpAttempts: 'opaque',
        attemptTokenUpperBound: 'unavailable',
        attemptCostUpperBound: 'unavailable',
        accountingObservation: observations.status(),
        inheritAvailable: Boolean(hostAuthority.getStore()?.sessionId && ctx.get('agents')?.get?.(hostAuthority.getStore()?.sessionId)),
        extensionClients: clientBridge?.status() ?? { state: 'unavailable', reason: 'official-owner-connection-services-missing' },
        storage: services?.store && 'facts' in services.store ? await (services.store as any).facts() : { backend: 'uninitialized' },
      };
    },
    async model(request) {
      const llm = requireService(ctx, 'llm', 'prepareCall');
      let route = routed(request);
      if (request.independentRoute) {
        // Revalidate stale/forged UI routes at the official runtime boundary.
        route = await resolveChildModelOptions(llm, route, request.reasoningEffort, request.signal) as typeof route;
      }
      const agents = ctx.get('agents');
      const actorId = hostAuthority.getStore()?.sessionId ?? request.parentId ?? request.sessionId;
      const owner = attempts.ownerFor(request, actorId ? agents?.get?.(actorId) : undefined);
      const signal = AbortSignal.any([pluginSignal, request.signal ?? pluginSignal, ...(owner ? [owner.controller.signal] : [])]);
      signal.throwIfAborted();
      const attemptId = request.attemptId ?? `attempt_${randomUUID()}`;
      const logicalCallId = request.logicalCallId ?? `call_${randomUUID()}`;
      const sessionId = request.sessionId ?? `nexus-aux:${logicalCallId}`;
      const prepared = await llm.prepareCall(route, signal);
      const purpose = ['compression-auxiliary', 'compression-inband', 'memory-extraction', 'title', 'lint-repair', 'background-index', 'diagnostic-canary'].includes(request.role)
        ? request.role : request.role === 'reviewer' ? 'review' : 'workflow-planning';
      const inputMessages = request.messages ?? [{ role: 'user' as const, content: request.prompt }];
      const nativeMessages: NativeMessage[] = [
        ...(request.system ? [{ id: `aux_${logicalCallId}_system`, role: 'system' as const, content: [{ type: 'text', text: request.system }], source: { kind: 'system-prompt' } }] : []),
        ...inputMessages.map((message, index) => ({
          id: `aux_${logicalCallId}_${index}`, role: message.role,
          content: [{ type: 'text', text: message.content }],
          source: message.role === 'system' ? { kind: 'system-prompt' }
            : message.role === 'assistant' ? { kind: 'model', provider: 'nexus-composed-context', model: 'authored-assistant-context' }
            : { kind: NEXUS_SOURCE, meta: { purpose: 'auxiliary-model-input' } },
        })),
      ];
      if (request.images?.length) {
        if (request.images.length > 16) throw new NexusError('RESOURCE_LIMIT', '每次模型请求最多16张图片');
        const images = request.images.map(image => {
          if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mediaType)
            || image.dataBase64.length > 28 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.dataBase64)) throw new NexusError('INVALID_ARGUMENT', '模型图片必须是受限规范base64编码');
          return { data: Buffer.from(image.dataBase64, 'base64'), mediaType: image.mediaType, name: image.name };
        });
        const refs = await requireService(ctx, 'attachments', 'saveImages').saveImages(images);
        let lastUser = nativeMessages.findLast(message => message.role === 'user');
        if (!lastUser) { lastUser = { id: `aux_${logicalCallId}_images`, role: 'user', content: [], source: { kind: NEXUS_SOURCE } }; nativeMessages.push(lastUser); }
        for (const attachment of refs) lastUser.content.push({ type: 'image', attachment });
      }
      const cores = nativeToCore(nativeMessages.map((message, seq) => ({ seq, message })));
      const lifecycle = beginContextRequest(services.dataDir);
      let plan: any;
      try {
      plan = await invoke('context', 'prepare', {
        sessionId, purpose, lane: request.role, messages: cores,
        requestOwner: lifecycle.owner,
        system: '', tools: [],
        route: { providerId: route.provider, modelId: route.model },
        windowTokens: prepared.context?.contextWindow ?? config.modelWindowTokens ?? 131072,
        outputReserveTokens: request.maxTokens ?? 4096, attemptId, logicalCallId,
      }, `context-prepare:${attemptId}`);
      const options: any = {
        ...prepared.config, messages: coreToNative(plan.messages), system: plan.system,
        tools: [], signal, sessionId, purpose,
      };
      auxiliaryAttempts.set(options, { attemptId, logicalCallId, role: request.role, owner, isolated: request.independentRoute === true });
      const textBlocks = new Map<number, string>();
      let usage: JsonRecord | undefined;
      let terminal: any;
      try {
        for await (const chunk of prepared.stream(options)) {
          if (chunk.type === 'text-delta') {
            const index = chunk.index ?? 0;
            textBlocks.set(index, (textBlocks.get(index) ?? '') + chunk.text);
          }
          // block-end is the official assembled block. Prefer it over its
          // deltas, and never include private reasoning/tool-call blocks.
          else if (chunk.type === 'block-end' && chunk.block?.type === 'text') textBlocks.set(chunk.index ?? 0, chunk.block.text);
          else if (chunk.type === 'usage') usage = chunk.usage;
          else if (chunk.type === 'finish') terminal = chunk.reason;
        }
        const text = [...textBlocks].sort(([left], [right]) => left - right).map(([, value]) => value).join('');
        if (terminal?.kind !== 'stop') {
          const context = { phase: 'auxiliary-model-response', signalAborted: signal.aborted };
          const cause = terminal?.kind === 'max-tokens'
            ? { code: 'MODEL_OUTPUT_LIMIT' }
            : terminal?.kind === 'tool-calls'
              ? { code: 'INVALID_MODEL_OUTPUT' }
              : ['error', 'aborted'].includes(terminal?.kind) && terminal.failure
                ? terminal.failure : { code: 'HOST_CONTRACT_UNSUPPORTED' };
          const diagnosis = classifyFailure(cause, context);
          const failure = annotateNativeFailure(cause, context);
          const facts = { ...diagnosis, traceId: nativeErrorIdentity(failure).traceId, attemptId, logicalCallId,
            terminalKind: ['stop', 'max-tokens', 'tool-calls', 'error', 'aborted'].includes(terminal?.kind) ? terminal.kind : 'unsupported',
            ...(Number.isSafeInteger(options.maxTokens) ? { maxOutputTokens: options.maxTokens } : {}),
            ...Object.fromEntries(['inputTokens', 'outputTokens', 'reasoningTokens'].flatMap(key =>
              typeof usage?.[key] === 'number' && Number.isFinite(usage[key]) ? [[key, usage[key]]] : [])),
            outputTextChars: text.length };
          try { ctx.logger?.warn('Nexus auxiliary response incomplete', facts); } catch {}
          try { services.emit('auxiliary/diagnostic', { ...facts, sessionId }); } catch {}
          throw new NexusError(failure.code, failure.message, {
            ...facts,
            ...(failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.providerRetryAfterMs }),
          });
        }
        if (!text.trim()) throw new NexusError('EMPTY_RESPONSE', '辅助模型未返回正文', { phase: 'auxiliary-model-response', attemptId, logicalCallId });
        return { text, provider: route.provider, model: route.model, usage, evidence: { attemptId, logicalCallId, planId: plan.planId, prepared: true, observedRoute: { provider: prepared.config.provider, model: prepared.config.model }, observedRouteSource: 'official-prepared-registration' } };
      } finally {
        void observations.observe('context', { sessionId, purpose, lane: request.role, planId: plan.planId, attemptId, logicalCallId, usage, completion: 'final' })
          .catch(() => undefined);
      }
      } finally {
        lifecycle.end();
        if (plan?.planId) {
          try {
            await invoke('context', 'request/release', {
              sessionId, purpose, lane: request.role, planId: plan.planId,
            }, `context-release:${attemptId}`, AbortSignal.timeout(5000));
          } catch (error) {
            ctx.logger?.warn('Nexus context request release requires recovery', error instanceof NexusError ? error.code : 'INTERNAL');
          }
        }
      }
    },
    async spawn(request) {
      const subagents = requireService(ctx, 'subagents', 'startActivation');
      const agents = requireService(ctx, 'agents', 'get');
      const parentId = request.parentId ?? request.sessionId ?? hostAuthority.getStore()?.sessionId;
      const parent = parentId ? agents.get(parentId) : undefined;
      if (!parent) throw new NexusError('DEPENDENCY_MISSING', '启动正式子代理需要仍存活的父 Agent/sessionId');
      const owner = attempts.ownerFor(request, parent);
      if (owner && (typeof agents.isOwnedBy !== 'function' || typeof agents.currentInitiator !== 'function')) {
        throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '正式 Agent runtime ownership/initiator seam 不可用，不能保证后代 attempt 归属');
      }
      const parentPolicy = policies.get(parent.id) ?? parent.ctx?.get?.('nexusExecutionPolicy');
      if (parentPolicy?.allowChildren === false) throw new NexusError('PERMISSION_DENIED', '此代理没有继续委派权限');
      const signal = AbortSignal.any([pluginSignal, request.signal ?? pluginSignal, ...(owner ? [owner.controller.signal] : [])]);
      const route = await resolveChildModelOptions(requireService(ctx, 'llm', 'resolveCallConfig'), routed(request),
        optionalChildField(request.reasoning_effort, 'reasoning_effort') ?? optionalChildField(request.reasoningEffort, 'reasoningEffort')
          ?? optionalChildField(config.modelRoutes?.[request.role]?.reasoningEffort, 'configured reasoningEffort'), signal);
      const childId = `nexus_${randomUUID()}`;
      attempts.reserve(childId, owner);
      const policy: ExecutionPolicy = {
        readOnly: Boolean(parentPolicy?.readOnly || request.readOnly),
        allowChildren: request.allowChildren === true && parentPolicy?.allowChildren !== false,
        maxDepth: request.maxDepth ?? parentPolicy?.maxDepth,
        actorRole: request.actorRole ?? request.role,
        allowedCapabilityIds: request.allowedCapabilityIds?.filter(id => !parentPolicy?.allowedCapabilityIds?.length || parentPolicy.allowedCapabilityIds.includes(id)) ?? parentPolicy?.allowedCapabilityIds,
      };
      policies.set(childId, policy);
      let activation: any;
      try { activation = await attempts.withOwner(owner, () => subagents.startActivation({
        childId,
        provider: 'spawn', label: `Nexus · ${request.role}`,
        request: { parent, prompt: [{ type: 'text', text: [request.system, request.prompt].filter(Boolean).join('\n\n') }], agentOptions: route, ...(policy.maxDepth === undefined ? {} : { maxDepth: policy.maxDepth }), ...(request.agentPreset ? { agentPreset: request.agentPreset } : {}), ...(request.cwd ? { cwd: request.cwd } : {}) },
        signal, delivery: 'caller',
      })); } catch (error) {
        policies.delete(childId);
        attempts.release(childId, owner);
        await attempts.finish(owner);
        throw error;
      }
      children.add(activation);
      const settlement = Promise.resolve(activation.result);
      void settlement.catch(() => undefined);
      let disposePromise: Promise<void> | undefined;
      const dispose = () => disposePromise ??= Promise.resolve().then(() => activation.dispose()).finally(() => {
        children.delete(activation);
        attempts.release(activation.childId, owner);
      });
      attempts.attach(owner, dispose);
      try {
        await services.store.put('host-session-policies', activation.childId, policy, 0);
        await services.store.put('host-activations', activation.childId, { id: activation.childId, sessionId: activation.childId, kind: 'subagent', state: 'running', updatedAt: new Date().toISOString() }, 0);
      } catch (error) {
        let cleanupFailed = false;
        try { await dispose(); } catch { cleanupFailed = true; }
        await attempts.finish(owner);
        throw new NexusError('PARTIAL_EFFECT', cleanupFailed
          ? '子代理曾启动，但持久回执及精确激活回收未完成'
          : '子代理曾启动，但持久回执未完成；已请求并等待精确激活回收', { childId: activation.childId, cleanupFailed });
      }
      const abort = () => { void dispose().catch(error => ctx.logger?.warn('Nexus child cleanup failed', error?.code ?? 'INTERNAL')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const result = settlement.then(async (result: any): Promise<ModelResult> => {
        await attempts.finish(owner);
        const child = agents.get(activation.childId);
        const headerRoute = child?.session?.requestHeader?.()?.config;
        const observed = headerRoute ?? observedChildRoutes.get(activation.childId);
        const evidence = { childId: activation.childId, stopReason: result.stopReason, structured: result.structured, delivery: 'caller', requestedRoute: route,
          ...(observed?.provider && observed?.model ? { observedRoute: { provider: observed.provider, model: observed.model }, observedRouteSource: headerRoute ? 'official-child-request-header' : 'official-llm-stream' } : { observedRouteState: 'unknown' }) };
        const previous = await services.store.get('host-activations', activation.childId);
        await services.store.put('host-activations', activation.childId, { id: activation.childId, sessionId: activation.childId, kind: 'subagent', state: result.stopReason === 'completed' ? 'succeeded' : result.stopReason === 'aborted' ? 'cancelled' : 'failed', stopReason: result.stopReason, evidence, updatedAt: new Date().toISOString() }, previous?.revision);
        if (result.stopReason !== 'completed') throw new NexusError(result.stopReason === 'aborted' ? 'CANCELLED' : 'UPSTREAM_UNAVAILABLE', result.diagnostic ?? `子代理以 ${result.stopReason} 结束`);
        return {
          text: (result.output ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join(''),
          ...(observed?.provider && observed?.model ? { provider: observed.provider, model: observed.model } : {}),
          evidence,
        };
      }, async (error: unknown) => {
        await attempts.finish(owner);
        throw error;
      }).finally(() => { signal.removeEventListener('abort', abort); });
      // Consumers still receive the exact owned activation disposal capability.
      return { id: activation.childId, result, dispose } satisfies ChildActivation;
    },
    async sessions(action, params) {
      const resource = await resourceHostAction(ctx, action, params);
      if (resource.handled) return resource.result;
      if (extensionBridge.handles(action)) return extensionBridge.call(action, params);
      if (sessionBridge.handles(action)) return sessionBridge.dispatch(action, params);
      const sessionId = String(params.sessionId ?? params.id ?? '');
      switch (action) {
        case 'companion.surface': {
          const authority = hostAuthority.getStore();
          if (authority?.sessionId !== sessionId || authority.actorId !== 'nexus-companion-hook' && authority.actorId !== 'connection-owner') throw new NexusError('SCOPE_MISMATCH', '旁路上下文只读取已授权当前会话');
          const signal = authority.signal ?? pluginSignal;
          const query = requireService(ctx, 'sessionQuery', 'readSession');
          const root = await query.readSession(sessionId);
          signal.throwIfAborted();
          const records = await query.listSessions(signal);
          const selected = new Map<string, any>([[sessionId, root.session]]);
          const unavailable: Array<{ sessionId: string; reason: string }> = [];
          for (let changed = true; changed;) {
            changed = false;
            for (const record of records) {
              const h = record.header, parent = h.parentSession ?? h.parentId;
              if (selected.has(h.id) || h.origin !== 'subagent' || !selected.has(parent)) continue;
              if (h.cwd && root.session.cwd && workspaceIdentity(h.cwd) !== workspaceIdentity(root.session.cwd)) {
                if (!unavailable.some(item => item.sessionId === h.id)) unavailable.push({ sessionId: h.id, reason: 'workspace-boundary' });
                continue;
              }
              selected.set(h.id, h); changed = true;
            }
          }
          const packets = [];
          for (const [id, header] of selected) {
            signal.throwIfAborted();
            if (packets.length >= 128) { unavailable.push({ sessionId: id, reason: 'session-count-budget' }); continue; }
            try {
              const snapshot = id === sessionId ? root : await query.readSession(id);
              let events = snapshot.events;
              if (id === sessionId && Array.isArray(params.admitted) && authority.actorId === 'nexus-companion-hook') {
                const ids = new Set(events.map((e: any) => (e.data?.message ?? e.data)?.id).filter(Boolean));
                const seq = events.reduce((max: number, e: any) => Math.max(max, e.seq ?? -1), -1);
                events = [...events, ...params.admitted.filter((m: any) => m?.role === 'user' && !ids.has(m.id)).map((m: any, index: number) => ({ seq: seq + index + 1, type: 'user/message', data: m, transientAdmission: true }))];
              }
              packets.push({ sessionId: id, parentId: header.parentSession ?? header.parentId,
                status: ctx.get('agents')?.get?.(id)?.status ?? 'persisted', events });
            } catch (error) {
              signal.throwIfAborted();
              unavailable.push({ sessionId: id, reason: error instanceof NexusError ? error.code : 'session-unavailable' });
            }
          }
          return { packets, unavailable };
        }
        case 'analysis.surface': {
          const authority = hostAuthority.getStore();
          if (authority?.sessionId && authority.sessionId !== sessionId) throw new NexusError('SCOPE_MISMATCH', '任务分析只读取当前会话');
          const snapshot = await requireService(ctx, 'sessionQuery', 'readSession').readSession(sessionId);
          const agent = ctx.get('agents')?.get?.(sessionId);
          return analysisSurface(sessionId, snapshot.events, agent?.status ?? 'persisted', Number(params.sinceSeq ?? -1));
        }
        case 'analysis.roster': {
          const records = await requireService(ctx, 'sessionQuery', 'listSessions').listSessions(pluginSignal);
          const ids = new Set<string>([sessionId]);
          // Only durable subagent lineage; a fork is a separate task.
          for (let changed = true; changed;) {
            changed = false;
            for (const record of records) {
              const h = record.header;
              if (!ids.has(h.id) && h.origin === 'subagent' && ids.has(h.parentSession ?? h.parentId)) { ids.add(h.id); changed = true; }
            }
          }
          return [...ids];
        }
        case 'context.compress': {
          const agent = ctx.get('agents')?.get?.(sessionId);
          if (!agent) throw new NexusError('SESSION_NOT_LIVE', '会话没有存活的 Agent；请先打开此会话');
          if (hostAuthority.getStore()?.actorId === 'connection-owner' && agent.status !== 'idle') {
            throw new NexusError('CTX_NATIVE_BUSY', '会话仍在执行，请在任务空闲后从页面压缩；未停止当前任务');
          }
          const direct = agent.ctx?.get?.('compaction');
          const compaction = typeof direct?.compactRanges === 'function' ? direct : nativeCompactionFor(agent);
          if (!compaction) throw new NexusError('DEPENDENCY_MISSING', '此会话未连接 Nexus 原生压缩 provider；请检查当前模式的插件配置');
          return compaction.compactRanges(agent, params, hostAuthority.getStore()?.signal ?? pluginSignal);
        }
        case 'models/list': case 'models.list': {
          const llm = requireService(ctx, 'llm', 'listModels');
          const providers = llm.listProviders();
          const directory = llm.listConfigurableProviders?.() ?? [];
          const items = [];
          for (const provider of providers) {
            const descriptor = directory.find((entry: any) => entry.provider === provider.id);
            for (const model of await llm.listModels(provider.id)) {
              let info: any, resolved = false;
              try { info = await llm.resolveModelInfo(provider.id, model.id); resolved = true; } catch { info = model; }
              const known = (value: unknown) => ({ state: value === undefined ? 'unknown' : 'declared', ...(value === undefined ? {} : { value }), source: 'official-provider-model-metadata', checkedAt: new Date().toISOString() });
              items.push({
                ref: { providerRouteId: provider.id, modelId: model.id, endpointIdentity: descriptor?.defaultBaseURL ?? `host-route:${provider.id}`, protocol: 'host-adapter' },
                provider: provider.id, model: model.id, name: model.name,
                code: `${provider.id}/${model.id}`,
                highestReasoningEffort: info.reasoning?.efforts?.at(-1)?.id ?? null,
                capabilities: {
                  text: known(info.inputModalities?.includes('text')), image: known(info.inputModalities?.includes('image')),
                  contextWindow: known(info.context?.contextWindow), maxOutputTokens: known(info.defaultMaxTokens),
                  reasoningEffort: known(resolved ? info.reasoning?.efforts?.map((effort: any) => effort.id) ?? [] : undefined),
                  streaming: { state: 'verified', value: true, source: 'DSH LlmRuntime.stream' },
                  cancellation: { state: 'verified', value: true, source: 'DSH GenerateOptions.signal' },
                },
                executorIds: ['dsh-subagent'], authorized: true,
                credentialAvailable: false, credentialState: 'unknown', credentialEvidence: 'registered route does not prove credential validity; upstream authenticates on call',
                health: 'unknown',
              });
            }
          }
          return { items, inheritance: 'live-parent-request-header', credentialVerification: 'upstream-on-call' };
        }
        case 'plugin.manager': {
          const manager = requireService(ctx, 'pluginManager', 'listPlugins');
          if (params.action === 'list') return manager.listPlugins();
          if (params.action === 'install') return manager.installBundle(params.specifier, { exact: true, enabled: params.enabled !== false });
          if (params.action === 'remove') return manager.removeBundle(params.name);
          throw new NexusError('INVALID_ARGUMENT', 'Plugin Manager action 无效');
        }
        default: throw new NexusError('HOST_CONTRACT_UNSUPPORTED', `宿主尚未提供 Nexus 所需的 ${action} 适配`);
      }
    },
    async secret(reference) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(reference)) throw new NexusError('INVALID_ARGUMENT', '凭据须使用命名引用');
      const credentials = requireService(ctx, 'credentials', 'resolve');
      return credentials.resolve(reference);
    },
    async approve(action, resource, details = {}) {
      const authority = hostAuthority.getStore();
      // Only a host-authenticated owner exact command creates this intent.
      if (authority?.actorId?.startsWith('remote:')) {
        if (authority.ownerIntent === action && authority.permissions?.has(action)) return true;
      } else if (authority?.ownerIntent && authority.permissions?.has(authority.ownerIntent)) {
        // Direct effects of this explicit owner command remain scoped to the
        // originating domain. Nested cross-domain writes require their own grant.
        const domain = authority.ownerIntent.split('.')[0];
        if (action.startsWith(`${domain}.`) || action.startsWith(`nexus:${domain}:`)
          || (action === 'runtime.execute' && ['quality', 'workflow', 'review', 'files', 'runtime', 'extensions'].includes(domain))) return true;
      }
      const sessionId = String(details.sessionId ?? authority?.sessionId ?? '');
      const agent = sessionId ? ctx.get('agents')?.get?.(sessionId) : undefined;
      const approval = ctx.get('approval');
      if (!agent || !approval?.request) return false;
      const outcome = await approval.request({
        agent, toolName: `nexus_${action.split('.')[0]}`, callId: authority?.toolExecution?.callId ?? `nexus-approval:${randomUUID()}`,
        reason: `${action}: ${resource}`, signal: authority?.signal ?? pluginSignal,
      });
      return outcome === 'allowed-once';
    },
    async dispose() {
      removePolicy();
      const outcomes = await Promise.allSettled([sessionBridge.dispose(), extensionBridge.dispose(),
        ...[...children].map(activation => activation.dispose())]);
      children.clear();
      attempts.dispose();
      removeRecovery();
      await observations.dispose();
      try { await clientBridge?.dispose(); } catch (error) { outcomes.push({ status: 'rejected', reason: error }); }
      clientLifetime.abort();
      removeClientService?.();
      const failed = outcomes.filter(item => item.status === 'rejected');
      if (failed.length) throw new NexusError('PARTIAL_EFFECT', '部分宿主资源尚未确认释放', { failures: failed.length });
    },
  };

  // Observe every actual host attempt, including main-loop retries and children.
  // The formal loop owns and freezes its input. This observer never edits it.
  ctx.on('llm/stream', (options: any, next: () => AsyncIterable<any>) => {
    const explicit = auxiliaryAttempts.get(options);
    return {
      async *[Symbol.asyncIterator]() {
        let identity: ReturnType<HostAttemptTracker['identity']> | undefined;
        try {
        identity = attempts.identity(options, explicit);
        if (options.sessionId && policies.has(options.sessionId) && options.provider && options.model) {
          observedChildRoutes.set(options.sessionId, { provider: options.provider, model: options.model });
        }
        const { attemptId, logicalCallId } = identity;
        const role = explicit?.role ?? (options.purpose === 'compaction' ? 'compression-inband' : options.purpose === 'session-title' ? 'title' : 'host');
        const plan: any = !explicit && !options.purpose && options.sessionId && services
          ? await invoke('context', 'inspect', { sessionId: options.sessionId, purpose: 'main', lane: 'main' }).catch(() => undefined) : undefined;
        yield* attempts.observe(options, next, identity, async facts => {
          await Promise.all([
            observations.observe('usage', { ...facts, role }),
            ...(plan?.id ? [observations.observe('context', {
              sessionId: options.sessionId, purpose: 'main', lane: 'main', planId: plan.id, attemptId, logicalCallId, usage: facts.usage, completion: 'final',
            })] : []),
          ]);
        });
        } catch (error) {
          const context = { phase: 'llm-stream-middleware',
            signalAborted: Boolean(options.signal?.aborted || identity?.owner?.controller.signal.aborted) };
          const diagnosis = classifyFailure(error, context);
          const diagnostic = {
            ...diagnosis, ...nativeFailureFacts(error, options.signal),
            diagnosticCode: diagnosis.diagnosticCode, phase: context.phase,
            attemptId: identity?.attemptId, logicalCallId: identity?.logicalCallId,
            signalAborted: context.signalAborted, traceId: nativeErrorIdentity(error).traceId,
          };
          if (explicit?.isolated) services.emit('auxiliary/diagnostic', { ...diagnostic, sessionId: options.sessionId });
          else await recordRecoveryDiagnostic(ctx, String(options.sessionId ?? ''), diagnostic);
          throw toNativeLlmError(error, context);
        }
      },
    };
  });
  return host;
}
