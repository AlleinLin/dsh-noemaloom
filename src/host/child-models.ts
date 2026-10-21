import { ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { AgentOptions } from '@deepseek-ai/dsh-agent';
import { NexusError } from '../ports/contracts.js';

export interface ChildModelRoute { provider: string; model: string }
export interface ChildModelChoice extends ChildModelRoute {
  code: string;
  reasoningEfforts: string[];
  highestReasoningEffort: string | null;
  reasoningState: 'selectable' | 'unsupported' | 'unknown';
}
type ChildLlm = Pick<LlmRuntime, 'listProviders' | 'listModels' | 'resolveModelInfo' | 'resolveCallConfig'>;
type ChildModelOptions = Omit<AgentOptions, 'reasoningEffort'> & { reasoningEffort?: string };

/** Empty optional strings from model tool calls mean omission, never an effort id. */
export function optionalChildField(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new NexusError('INVALID_ARGUMENT', `${field} 必须为字符串`);
  return value.trim() || undefined;
}

/** Only publish registered routes within the session's existing authorization. */
export async function availableChildModels(llm: ChildLlm, routes?: readonly ChildModelRoute[], signal?: AbortSignal): Promise<ChildModelChoice[]> {
  signal?.throwIfAborted();
  const items: ChildModelChoice[] = [];
  const seen = new Set<string>();
  for (const provider of llm.listProviders()) {
    if (routes !== undefined && !routes.some(route => route.provider === provider.id)) continue;
    const models = (await llm.listModels(provider.id)).map(model => model.id)
      .filter(model => routes === undefined || routes.some(route => route.provider === provider.id && route.model === model));
    for (const model of models) {
      signal?.throwIfAborted();
      const key = JSON.stringify([provider.id, model]);
      if (seen.has(key)) continue;
      seen.add(key);
      let reasoningEfforts: string[] = [], reasoningState: ChildModelChoice['reasoningState'] = 'unknown';
      try {
        const info = await llm.resolveModelInfo(provider.id, model, signal);
        // The official contract orders opaque ids from least to greatest.
        reasoningEfforts = info.reasoning?.efforts.map(effort => String(effort.id)) ?? [];
        reasoningState = reasoningEfforts.length ? 'selectable' : 'unsupported';
      } catch { signal?.throwIfAborted(); }
      items.push({ provider: provider.id, model, code: `${provider.id}/${model}`, reasoningEfforts,
        highestReasoningEffort: reasoningEfforts.at(-1) ?? null, reasoningState });
    }
  }
  signal?.throwIfAborted();
  return items;
}

export function childModelGuidance(items: readonly ChildModelChoice[]): string {
  return '子智能体可用模型代号（精确 provider/model，勿猜名称）：\n'
    + (items.map(item => `${item.code} | provider=${JSON.stringify(item.provider)} model=${JSON.stringify(item.model)}`
      + ` | reasoning_effort=${item.reasoningEfforts.join(', ') || item.reasoningState}`
      + ` | 省略或空白时=${item.highestReasoningEffort ?? (item.reasoningState === 'unsupported' ? '不发送 effort（模型不支持）' : '元数据未知，创建前需解析')}`).join('\n') || '（无可选模型）')
    + '\nprovider 与 model 成对填写；同时省略则沿用有效路由。reasoning_effort 省略、null、空串或纯空白时自动使用所选模型支持的最高强度；非空值按原值校验。不支持 effort 的模型不发送该字段。此目录不证明凭据有效，认证由实际调用核验。';
}

/** Resolve before any activation: preserve explicit effort, otherwise use the model's maximum. */
export async function resolveChildModelOptions(
  llm: ChildLlm, options: ChildModelOptions, requestedEffort: unknown, signal?: AbortSignal,
  discoveryRoutes?: readonly ChildModelRoute[],
): Promise<AgentOptions> {
  const availableModels = await availableChildModels(llm, discoveryRoutes, signal);
  const guidance = childModelGuidance(availableModels);
  const provider = optionalChildField(options.provider, 'provider'), model = optionalChildField(options.model, 'model');
  try {
    if (!provider || !model) throw new Error('子智能体需要有效的 provider/model');
    if (!llm.listProviders().some(item => item.id === provider)) throw new Error('provider 未注册');
    if (!(await llm.listModels(provider)).some(item => item.id === model)) throw new Error('model 不在当前宿主公布的可用目录中');
    const info = await llm.resolveModelInfo(provider, model, signal);
    const explicit = optionalChildField(requestedEffort, 'reasoning_effort');
    const effort = explicit ?? info.reasoning?.efforts.at(-1)?.id;
    // Discard inherited/configured effort when the caller left it blank.
    const { reasoningEffort: _oldEffort, ...rest } = options;
    const candidate = { ...rest, provider, model, ...(effort ? { reasoningEffort: ReasoningEffortId(String(effort)) } : {}) };
    return { ...candidate, ...await llm.resolveCallConfig(candidate, signal) };
  } catch (error) {
    signal?.throwIfAborted();
    throw new NexusError('CHILD_MODEL_SELECTION_INVALID', `子智能体模型或思考强度无效；请使用下列精确代号和支持值。\n${guidance}`, {
      provider: provider ?? null, model: model ?? null, availableModels,
      reason: error instanceof NexusError ? error.code : 'route-or-effort-not-supported',
    });
  }
}
