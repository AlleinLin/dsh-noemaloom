import { canonicalHeader } from '@deepseek-ai/dsh-session';
import { renderPrompt, renderContextSections, joinContextSections } from '@deepseek-ai/dsh-system-prompt';
import { effectiveSettings } from '../domain/scope.js';
import { NexusError } from '../ports/contracts.js';
import { CONTEXT_COMPACTION_FEATURE, resolveContextCompactionOptions } from '../shared/context-compaction.js';
import { classifyFailure, failureMetadata } from '../shared/error-codes.js';

export interface ContextAdmission { assembly?: any; messages?: any[]; route?: any }
export async function summaryModelPolicy(ctx: any, agent: any, signal: AbortSignal, pressure: Awaited<ReturnType<typeof measureContextPressure>>) {
  const route = pressure.summaryModel ?? { provider: pressure.provider, model: pressure.model };
  try {
    const llm = ctx.get('llm');
    const info = await llm.resolveModelInfo(route.provider, route.model, signal);
    const prepared = typeof llm.prepareCall === 'function' ? await llm.prepareCall(route, signal) : undefined;
    const window = prepared?.context?.contextWindow ?? info.context?.contextWindow;
    if (!Number.isSafeInteger(window) || window <= 0) throw new NexusError('CTX_MODEL_WINDOW_UNKNOWN', '压缩模型没有有效窗口');
    return { provider: prepared?.config?.provider ?? route.provider, model: prepared?.config?.model ?? route.model, summaryWindowTokens: window,
      summaryMaxTokens: Math.max(128, Math.min(16000, Math.floor(window / 8), Math.floor(pressure.windowTokens / 8))) };
  } catch (error) {
    const diagnosis = classifyFailure(error, { phase: 'summary-model-preparation', signalAborted: signal.aborted });
    throw new NexusError('CTX_SUMMARY_MODEL_UNAVAILABLE', '用户所选压缩模型不可用或窗口未知；会话模型未更改。请在上下文设置中修正压缩模型后重试',
      { provider: route.provider, model: route.model, failure: { code: diagnosis.canonicalCode,
        diagnosticCode: diagnosis.diagnosticCode, ...failureMetadata(error) } });
  }
}
/** A projection of one next request, never cumulative billing or historical capacity. */
export async function measureContextPressure(ctx: any, agent: any, signal: AbortSignal, admission: ContextAdmission = {}) {
  const services = ctx.get('nexus').services;
  const scope = { sessionId: agent.id, scopeLevel: 'session' as const, workspaceRoot: agent.session.header.cwd };
  const [settings, context] = await Promise.all([
    effectiveSettings(services.store, scope.workspaceRoot, scope, CONTEXT_COMPACTION_FEATURE),
    effectiveSettings(services.store, scope.workspaceRoot, scope, 'context'),
  ]);
  const options = resolveContextCompactionOptions(settings.effective);
  const previous = agent.session.requestHeader();
  // The request waterfall supplies the current route. A status query uses the
  // live Agent options, retaining only same-route resolved envelope defaults.
  const live = admission.route ?? agent.options;
  const sameRoute = previous?.config?.provider === live?.provider && previous?.config?.model === live?.model;
  const route = admission.route ?? { ...(sameRoute ? previous?.config : {}), ...live };
  if (!route?.provider || !route?.model) throw new NexusError('CTX_MODEL_WINDOW_UNKNOWN', '当前会话尚无有效模型路由；配置模型后重试');
  const llm = ctx.get('llm');
  const metadata = await llm.resolveModelInfo(route.provider, route.model, signal);
  const prepared = typeof llm.prepareCall === 'function' ? await llm.prepareCall(route, signal) : undefined;
  const effectiveRoute = prepared?.config ?? route;
  const windowTokens = prepared?.context?.contextWindow ?? metadata.context?.contextWindow;
  if (!Number.isSafeInteger(windowTokens) || windowTokens <= 0) throw new NexusError('CTX_MODEL_WINDOW_UNKNOWN', '当前有效模型未声明窗口；请修正模型目录配置后重试');
  const header = canonicalHeader({
    config: effectiveRoute,
    ...(prepared?.adapterDefaults ? { adapterDefaults: prepared.adapterDefaults }
      : sameRoute && previous?.adapterDefaults ? { adapterDefaults: previous.adapterDefaults } : {}),
    tools: admission.assembly?.tools ?? previous?.tools ?? [],
  });
  const meter = ctx.get('tokenMeter');
  const measured = meter.measure(agent.session, header);
  const currentMessages = agent.session.deriveMessages();
  let additionalTokens = 0;
  if (admission.assembly) {
    const prompt = renderPrompt(admission.assembly);
    const oldSystem = currentMessages.find((message: any) => message.role === 'system');
    // A new series after replacement can re-materialize the prompt; price its
    // replacement once, while retained developer/system nodes stay in meter.
    const systemTokens = prompt ? meter.estimateMessage({ role: 'system', content: [{ type: 'text', text: prompt }] }) : 0;
    additionalTokens += systemTokens - (oldSystem ? meter.estimateMessage(oldSystem) : 0);
    const dynamic = joinContextSections(renderContextSections(admission.assembly));
    // Runtime-context replacement is owned by the loop. Count a fresh changed
    // snapshot conservatively; do not subtract an unrelated earlier snapshot.
    if (dynamic && !currentMessages.some((message: any) => message.source?.kind === 'runtime-context'
      && message.content?.some((block: any) => block.type === 'text' && block.text === dynamic))) {
      additionalTokens += meter.estimateMessage({ role: 'user', content: [{ type: 'text', text: dynamic }] });
    }
  }
  const present = new Set(currentMessages.map((message: any) => message.id));
  for (const message of admission.messages ?? []) if (!present.has(message.id) && message.source?.kind !== 'runtime-context') {
    additionalTokens += meter.estimateMessage(message);
  }
  const reserve = effectiveRoute.maxTokens ?? metadata.defaultMaxTokens ?? 0;
  if (!Number.isSafeInteger(reserve) || reserve < 0) throw new NexusError('CTX_OUTPUT_RESERVE_INVALID', '当前输出预算无效，请修正模型配置');
  const inputTokens = Math.max(0, measured.totalTokens + additionalTokens);
  return {
    ...options, enabled: options.enabled && context.effective.enabled !== false,
    automaticEnabled: options.enabled, compressionAllowed: context.effective.enabled !== false,
    provider: effectiveRoute.provider, model: effectiveRoute.model, windowTokens, inputTokens,
    outputReserveTokens: reserve, occupiedTokens: inputTokens + reserve,
    occupancyPercent: (inputTokens + reserve) / windowTokens * 100,
    thresholdTokens: Math.floor(windowTokens * options.thresholdPercent / 100),
    evidence: measured.baseline.kind === 'usage' ? 'usage-calibrated-estimate' : 'estimate',
    logRevision: Number(measured.logRevision), surfaceTokens: measured.surfaceTokens,
    pendingInputTokens: Math.max(0, additionalTokens), header,
  };
}
