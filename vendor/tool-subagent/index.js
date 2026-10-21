import z from "@deepseek-ai/schemastery";
import { scopeChainOf, scopeOf } from "@deepseek-ai/dsh-scope";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { assertSubagentMaxDepth, delegationDepthOf, parentAgentOptionsForDelegation } from "@deepseek-ai/dsh-subagent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { z as z$1 } from "zod";
// Nexus adaptation; exact upstream identity and MIT license are in SOURCE.json.
import { availableChildModels, childModelGuidance, optionalChildField, resolveChildModelOptions } from "../../src/host/child-models.js";
z.object({
	provider: z.string().min(1).required(),
	model: z.string().min(1).required()
});
/**
* Stable identity for one provider/model pair.
* @param route - Exact provider/model route.
* @returns Opaque key for equality checks.
*/
function modelRouteKey(route) {
	return `${route.provider}\0${route.model}`;
}
/**
* Reject malformed or duplicate route policy entries at a durable or configuration boundary.
* @param routes - Candidate exact routes to validate.
* @returns an assertion that the candidate is a validated exact-route array.
*/
function assertAllowedModelRoutes(routes) {
	if (!Array.isArray(routes)) throw new Error("subagent model selection requires an array of routes");
	const seen = /* @__PURE__ */ new Set();
	const candidates = routes;
	for (const candidate of candidates) {
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate) || !("provider" in candidate) || typeof candidate.provider !== "string" || !("model" in candidate) || typeof candidate.model !== "string" || candidate.provider.length === 0 || candidate.model.length === 0) throw new Error("subagent model selection requires non-empty provider and model ids");
		const route = {
			provider: candidate.provider,
			model: candidate.model
		};
		const key = modelRouteKey(route);
		if (seen.has(key)) throw new Error(`subagent model selection repeats route "${route.provider}/${route.model}"`);
		seen.add(key);
	}
}
/**
* Whether a call explicitly selects any child LLM value.
* @param request - Model-facing route fields from the tool call.
* @returns Whether at least one route or effort field is present.
*/
function hasDelegationModelRequest(request) {
	return request.provider !== void 0 || request.model !== void 0 || request.reasoning_effort !== void 0;
}
/** Reject an empty model-facing route value at the tool JSON boundary. */
function assertNonEmpty(value, field) {
	if (value !== void 0 && value.length === 0) throw new Error(`child LLM \`${field}\` must be non-empty`);
}
/**
* Merge model-supplied selection fields over configured child defaults.
* Provider and model form one route and must be supplied together. Changing
* that route without an effort clears the configured route-owned effort.
* @param parentOptions - Current parent values that supply missing child values.
* @param configured - Tool-instance child defaults.
* @param request - Model-facing route override.
* @param enabled - Whether this tool instance permits model-facing selection.
* @returns Child Agent options, preserving omission when no layer contributes one.
*/
function requestedAgentOptions(parentOptions, configured, request, enabled) {
	if (!hasDelegationModelRequest(request)) return configured;
	if (!enabled) throw new Error("child model selection is disabled for this tool instance");
	assertNonEmpty(request.provider, "provider");
	assertNonEmpty(request.model, "model");
	assertNonEmpty(request.reasoning_effort, "reasoning_effort");
	if (request.provider === void 0 !== (request.model === void 0)) throw new Error("child LLM `provider` and `model` must be supplied together");
	const baselineProvider = configured?.provider ?? parentOptions.provider;
	const baselineModel = configured?.model ?? parentOptions.model;
	const routeChanged = request.provider !== void 0 && (request.provider !== baselineProvider || request.model !== baselineModel);
	const { reasoningEffort: _configuredReasoningEffort, ...configuredWithoutReasoning } = configured ?? {};
	return {
		...routeChanged && request.reasoning_effort === void 0 ? configuredWithoutReasoning : configured,
		...request.provider === void 0 ? {} : {
			provider: request.provider,
			model: request.model
		},
		...request.reasoning_effort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(request.reasoning_effort) }
	};
}
/**
* Enforce a settings-owned route list at the operation that creates the child.
* Pure inheritance remains outside this policy because no model-facing choice
* occurred; any explicit route or effort field must resolve to an allowed route.
* @param policy - Selection authority captured for this Session.
* @param parentOptions - Current parent values that supply missing child values.
* @param requested - Effective child options after request/config merging.
* @param request - Model-facing selection fields from the tool call.
*/
function assertAllowedModelSelection(policy, parentOptions, requested, request) {
	if (policy === void 0 || !hasDelegationModelRequest(request)) return;
	const provider = requested?.provider ?? parentOptions.provider;
	const model = requested?.model ?? parentOptions.model;
	if (provider === void 0 || model === void 0) throw new Error("cannot select child LLM values without an effective provider and model");
	if (policy.routes.some((route) => route.provider === provider && route.model === model)) return;
	throw new Error(`child LLM route "${provider}/${model}" is not allowed for this Session`);
}
/**
* Whether configured Agent options require route validation before delegation.
* @param options - Tool-instance child defaults.
* @returns Whether configured provider, model, or effort values must be resolved.
*/
function hasConfiguredLlmSelection(options) {
	return options?.provider !== void 0 || options?.model !== void 0 || options?.reasoningEffort !== void 0;
}
/**
* Resolve an effective child route through its live adapter before the child is
* created. The LLM runtime owns provider lookup, exact-model metadata, effort
* validation, and adapter defaults.
* @param llm - Live LLM runtime.
* @param parentOptions - Current parent values whose compatible fields the child inherits.
* @param requested - Per-child options after request/config merging.
* @param signal - Tool-call cancellation signal.
* @param inheritParentReasoningEffort - Whether an omitted effort may inherit from the parent route.
*/
async function preflightChildLlmRoute(llm, parentOptions, requested, signal, inheritParentReasoningEffort = true) {
	const provider = requested?.provider ?? parentOptions.provider;
	const model = requested?.model ?? parentOptions.model;
	if (provider === void 0 || model === void 0) throw new Error("cannot select child LLM values without an effective provider and model");
	const routeChanged = provider !== parentOptions.provider || model !== parentOptions.model;
	const reasoningEffort = requested?.reasoningEffort ?? (inheritParentReasoningEffort && !routeChanged ? parentOptions.reasoningEffort : void 0);
	await llm.resolveCallConfig({
		provider,
		model,
		...reasoningEffort === void 0 ? {} : { reasoningEffort }
	}, signal);
}
//#endregion
//#region lib/types/list-models.js
/** Model-facing discovery of LLM routes available to child Agents. */
/** Resolve one registered provider with a model-correctable diagnostic. */
function registeredProvider(llm, policy, providerId) {
	const providers = llm.listProviders();
	const provider = providers.find((candidate) => candidate.id === providerId);
	if (provider !== void 0) return provider;
	const available = providers.filter((candidate) => policy.routes.some((route) => route.provider === candidate.id)).map((candidate) => candidate.id).join(", ") || "(none)";
	throw new Error(`LLM provider "${providerId}" is not registered; available providers: ${available}`);
}
/** Render one advertised or resolved model. */
function modelLine(provider, model) {
	return `${provider}/${model.id} — ${model.name}${model.description === void 0 ? "" : `: ${model.description}`}`;
}
/** Read the requested provider, advertised models, or exact-model efforts. */
async function listSubagentModels(ctx, policy, request, signal) {
	const llm = ctx.get("llm");
	if (llm === void 0) throw new Error("cannot discover child LLM routes because the `llm` service is unavailable");
	const provider = optionalChildField(request.provider, "provider");
	const model = optionalChildField(request.model, "model");
	const items = await availableChildModels(llm, policy.routes, signal);
	if (model !== void 0 && provider === void 0) throw new Error("model requires provider.\n" + childModelGuidance(items));
	const selected = items.filter(item => (provider === void 0 || item.provider === provider) && (model === void 0 || item.model === model));
	if ((provider !== void 0 || model !== void 0) && selected.length === 0) throw new Error("Requested child route is unavailable or not allowed for this Session.\n" + childModelGuidance(items));
	return childModelGuidance(selected);
}
/**
* Register `list_subagent_models` for one owning delegation-tool instance.
* @param ctx - Context whose tool registry owns the fixed discovery definition.
* @param policy - Route policy captured for this Session.
*/
function registerListSubagentModels(ctx, policy) {
	ctx.tools.register(defineTool({
		name: "list_subagent_models",
		description: "查看当前会话获准且已注册的子智能体模型代号及支持的 reasoning_effort，仅读取元数据，不创建子智能体、不发模型请求。无参数或空白 provider/model 列出全部可用代号；仅 provider 列出该路由；provider 与 model 同时填写检查精确模型。复制返回的独立 provider/model 字段，勿猜代号或把完整代号塞进 model。省略或留空 reasoning_effort 时，创建工具自动使用所选模型支持的最高强度。不支持 effort 的模型不发送该字段；目录不证明凭据有效。",
		parameters: {
			provider: {
				oneOf: [{ type: "string" }, { type: "null" }],
				description: "精确的 provider 代号；省略、null、空串或纯空白表示不过滤。"
			},
			model: {
				oneOf: [{ type: "string" }, { type: "null" }],
				description: "精确 model 代号，非空时须同时提供 provider；省略或空白列出模型及其全部支持的思考强度。"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, result) => [{
				type: "text",
				text: result
			}]
		},
		execute(args, exec) {
			return listSubagentModels(ctx, policy, args, exec.signal);
		}
	}));
}
//#endregion
//#region lib/types/preset-selection.js
/** Validates configured references and resolves model input against the allowlist. */
var SubagentPresetSelection = class {
	config;
	descriptions = [];
	constructor(config) {
		this.config = config;
		const { agentPreset, allowedAgentPresets } = config;
		if (allowedAgentPresets === void 0) return;
		if (new Set(allowedAgentPresets).size !== allowedAgentPresets.length) throw new Error("tool-subagent: allowedAgentPresets contains duplicate preset ids");
		if (agentPreset !== void 0 && !allowedAgentPresets.includes(agentPreset)) throw new Error("tool-subagent: agentPreset must be included in allowedAgentPresets");
	}
	/** Whether this tool requires the preset service and an independently composing provider. */
	get configured() {
		return this.config.agentPreset !== void 0 || this.config.allowedAgentPresets !== void 0;
	}
	/** Preset ids advertised in the model parameter. */
	get choices() {
		return this.config.allowedAgentPresets;
	}
	/** Model-visible selection guidance and configured preset descriptions. */
	get description() {
		return `Agent preset for this child. ${this.config.agentPreset === void 0 ? "Omit to inherit the parent agent's current preset." : `Omit to use ${this.config.agentPreset}.`}` + (this.descriptions.length === 0 ? "" : ` Available presets: ${this.descriptions.join("; ")}`);
	}
	/**
	* Read configured preset declarations before publishing the tool; mounting validates their activation.
	* @param ctx - Tool composition containing the preset service.
	*/
	async validate(ctx) {
		const presets = ctx.get("agentPresets");
		if (presets === void 0) throw new Error("tool-subagent: agent preset selection requires the agent-presets service");
		const ids = new Set([...this.config.agentPreset === void 0 ? [] : [this.config.agentPreset], ...this.config.allowedAgentPresets ?? []]);
		const descriptions = [];
		for (const id of ids) {
			const preset = await presets.readDocument(id);
			if (this.choices?.includes(id) && preset.description !== void 0) descriptions.push(`${id}: ${preset.description}`);
		}
		this.descriptions = descriptions;
	}
	/**
	* Reject independent selection for providers that inherit conversation history or lack support.
	* @param provider - Currently registered delegation provider.
	*/
	assertProvider(provider) {
		if (this.configured && (!provider.capabilities.agentPreset || provider.inheritsParentContext)) throw new Error(`tool-subagent: provider "${provider.name}" does not support independent agent preset selection`);
	}
	/**
	* Validate model input and apply the deployment default.
	* @param request - Model-supplied tool arguments.
	* @returns Selected preset id, or omission to inherit the parent.
	*/
	resolve(request) {
		const id = request.agent_preset;
		if (id === void 0) return this.config.agentPreset;
		if (this.choices === void 0) throw new Error("agent_preset selection is disabled for this tool instance");
		if (typeof id !== "string" || !this.choices.includes(id)) throw new Error(`agent_preset must be one of: ${this.choices.join(", ")}`);
		return id;
	}
};
/** Host-only projection of the durable model-selection policy. */
const subagentModelSelectionProjectionDefinition = {
	key: "subagentModelSelectionPolicy",
	stateVersion: 1,
	stateSchema: z$1.array(z$1.object({
		provider: z$1.string().min(1),
		model: z$1.string().min(1)
	}).strict()).min(1).nullable(),
	init: () => null,
	apply: (policy, event) => {
		if (policy !== null || event.type !== "subagent/model-selection-policy") return policy;
		const { allowedModels } = event.data;
		assertAllowedModelRoutes(allowedModels);
		if (allowedModels.length === 0) throw new Error("subagent/model-selection-policy requires at least one route");
		return allowedModels;
	}
};
/**
* Read the exact route list captured for a model-selectable definition.
* @param projections - registry that owns the policy projection.
* @param session - session whose durable decision is read.
* @returns a detached route list, or undefined for the fixed-route definition.
*/
function subagentModelSelectionPolicy(projections, session) {
	return projections.stateOf(session, "subagentModelSelectionPolicy")?.map((route) => ({ ...route }));
}
/**
* Append the route policy once, before its definition can reach a model request.
* @param projections - registry that owns the policy projection.
* @param session - session receiving the model-selectable definition.
* @param allowedModels - exact routes the definition may select explicitly.
*/
function recordSubagentModelSelection(projections, session, allowedModels) {
	if (subagentModelSelectionPolicy(projections, session) !== void 0) return;
	session.append("subagent/model-selection-policy", { allowedModels: allowedModels.map((route) => ({ ...route })) });
}
//#endregion
//#region lib/types/index.js
/**
* Model-facing delegation through one configured `ctx.subagents` provider.
* Provider lifecycle controls tool registration and context-sensitive schema
* wording. Every delegation starts a managed activation and returns its child
* id; the subagent runtime owns result delivery and resource cleanup.
* @module @deepseek-ai/dsh-tool-subagent
*/
const name = "tool-subagent";
const inject = [
	"tools",
	"subagents",
	"systemPrompt",
	"sessionProjections"
];
const delegationTools = /* @__PURE__ */ new Set();
const Config = z.object({
	provider: z.string().required(),
	toolName: z.string().default("subagent"),
	modelSelectionSettings: z.boolean().default(false),
	agentOptions: z.object({
		provider: z.string(),
		model: z.string(),
		reasoningEffort: z.string().min(1),
		maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
	}).default(void 0),
	agentPreset: z.string().min(1),
	allowedAgentPresets: z.array(z.string().min(1)).min(1).default(void 0),
	maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const("provider-managed")])
});
/**
* Model-facing wording from the provider's conversation-history descriptor
* ({@link SubagentProvider.inheritsParentContext}).
* A fresh child needs a standalone prompt; a forked child already sees the
* conversation's completed turns — telling the model to restate everything
* (or, worse, that the child "does not see this conversation") would be false
* for a fork.
* @param inheritsConversation - whether the child's conversation is seeded
*   with the parent's completed turns; this says nothing about tool, service,
*   scope, or authority inheritance.
* @returns the tool `description` and the `prompt` parameter description.
*/
function providerWording(inheritsConversation) {
	if (inheritsConversation) return {
		description: "Delegate a task to a subagent that inherits this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn). Use this when the subtask builds on this conversation's context — a follow-up analysis, a review, a continuation — without consuming this conversation's context for the work itself. You receive its result, not its intermediate steps.",
		promptDescription: "The task for the subagent. It already sees this conversation's completed turns, so build on them freely and state only what is new."
	};
	return {
		description: "Delegate a self-contained task to a subagent (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation's context. The subagent returns its result, not its intermediate steps.",
		promptDescription: "The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs."
	};
}
/**
* Install one delegation-tool composition.
* Standing preset choices are validated for each Agent before its tool is installed.
* @param ctx - Context that owns the registrations.
* @param config - delegation-tool configuration.
* @param session - unpublished Session supplied by a direct Agent setup; omit for a standing composition.
*/
async function apply(ctx, config, session) {
	for (const field of ["persona", "toolFilter"]) if (Object.hasOwn(config, field)) throw new Error(`tool-subagent: ${field} is no longer supported; configure persona and tool plugins in an Agent Preset and select it with agentPreset (spawn only)`);
	const presets = new SubagentPresetSelection(config);
	if (presets.configured && ctx.get("agentPresets") === void 0) throw new Error("tool-subagent: agent preset selection requires the agent-presets service");
	if (config.maxDepth !== "provider-managed") assertSubagentMaxDepth(config.maxDepth);
	const toolName = config.toolName ?? "subagent";
	const modelSelectionCapable = config.modelSelectionSettings === true;
	ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition);
	const assertSubagentProviderConfiguration = (subagentProvider) => {
		presets.assertProvider(subagentProvider);
		if (ctx.subagents.resolveMaxDepth(config.maxDepth) !== void 0 && !subagentProvider.capabilities.depthLimit) throw new Error(`tool-subagent: provider "${subagentProvider.name}" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider`);
		if (config.agentOptions !== void 0 && !subagentProvider.capabilities.agentOptions) throw new Error(`tool-subagent: provider "${subagentProvider.name}" does not support child agentOptions`);
		if (modelSelectionCapable && !subagentProvider.capabilities.agentOptions) throw new Error(`tool-subagent: provider "${subagentProvider.name}" does not support child model selection`);
	};
	ctx.on("subagent/provider-added", (subagentProvider) => {
		if (subagentProvider.name === config.provider) assertSubagentProviderConfiguration(subagentProvider);
	});
	const initialProvider = ctx.subagents.getProvider(config.provider);
	if (initialProvider !== void 0) assertSubagentProviderConfiguration(initialProvider);
	const install = (runtimeCtx, modelSelectionPolicy) => {
		const modelSelectionEnabled = modelSelectionPolicy !== void 0;
		if (modelSelectionPolicy !== void 0) registerListSubagentModels(runtimeCtx, modelSelectionPolicy);
		let mounted;
		const mount = (subagentProvider) => {
			assertSubagentProviderConfiguration(subagentProvider);
			const wording = providerWording(subagentProvider.inheritsParentContext);
			const providerRouteDefaults = subagentProvider.agentRouteDefaults;
			const choiceDescription = " reasoning_effort 省略、空串或纯空白时，自动使用所选模型支持的最高思考强度；显式非空值必须是该模型支持值，不支持 effort 的模型不发送该字段。"
				+ (modelSelectionEnabled ? " 可用代号会自动出现在请求上下文；也可先调用 list_subagent_models。provider/model 必须复制目录里的独立精确字段并成对填写，同时省略则使用配置/父级有效路由。无效代号会在创建前拒绝并返回可用代号，禁止猜测或自动改选其他模型。创建成功返回实际选用的路由、effort 和可用目录。" : " 当前会话不允许显式改选模型，使用有效的配置/父级路由。")
				+ (subagentProvider.inheritsParentContext ? " Changing the route can prevent provider-side reuse of the inherited conversation prefix." : "");
			const definition = defineTool({
				name: toolName,
				description: wording.description + " This tool starts an independently managed subagent and immediately returns its id. The runtime notifies you when it finishes." + (subagentProvider.prepareContinuable !== void 0 ? " The child reports results with `send_message`; use `send_message` to steer it while running or continue its conversation after it finishes." : " The completion notice includes its final answer. This backend does not accept follow-up messages.") + choiceDescription,
				parameters: {
					cwd: {
						type: "string",
						description: "Initial child working directory. Relative paths use your current directory; omitted inherits it. Later directory changes in either agent are independent."
					},
					description: {
						type: "string",
						required: true,
						description: "A short (3-5 word) description of the delegated task, for display."
					},
					prompt: {
						type: "string",
						required: true,
						description: wording.promptDescription
					},
					...presets.choices === void 0 ? {} : { agent_preset: {
						type: "string",
						enum: [...presets.choices],
						description: presets.description
					} },
					...modelSelectionEnabled ? {
						provider: {
							oneOf: [{ type: "string" }, { type: "null" }],
							description: "从自动提供的可用目录复制精确 provider 字段，与 model 成对填写；两者同时省略或空白使用有效默认路由，不猜写服务商名称。"
						},
						model: {
							oneOf: [{ type: "string" }, { type: "null" }],
							description: "从目录复制精确 model 字段，与 provider 成对填写；不要把 provider/model 完整代号作为 model。无效值返回当前可用代号，不会创建子智能体。"
						},
						reasoning_effort: {
							oneOf: [{ type: "string" }, { type: "null" }],
							description: "可选：仅接受该精确模型公布的强度代号。省略、空串或纯空白自动使用该模型支持的最高强度，包含切换模型后；非空显式值保留并校验。不支持 reasoning 的模型省略此字段。"
						}
					} : {}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							kind: {
								type: "string",
								required: true,
								const: "activation"
							},
							subagentId: {
								type: "string",
								required: true
							},
							selectedModel: { type: "object", required: true, additionalProperties: true },
							availableModels: { type: "array", required: true, items: { type: "object", additionalProperties: true } }
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: `started subagent ${value.subagentId}\n实际配置：${JSON.stringify(value.selectedModel)}\n${childModelGuidance(value.availableModels)}`
					}]
				},
				isConcurrencySafe: () => true,
				async execute(args, exec) {
					const parent = exec.agent;
					if (!parent) throw new Error("subagent tool requires a calling agent (exec.agent was undefined)");
					const agentPreset = presets.resolve(args);
					const llm = runtimeCtx.get("llm");
					const modelRequest = {
						provider: optionalChildField(args.provider, "provider"),
						model: optionalChildField(args.model, "model"),
						reasoning_effort: optionalChildField(args.reasoning_effort, "reasoning_effort")
					};
					const parentOptions = parentAgentOptionsForDelegation(parent);
					const requiresRoutePreflight = subagentProvider.capabilities.agentOptions;
					const discoveryRoutes = modelSelectionPolicy?.routes ?? [{
						provider: config.agentOptions?.provider ?? providerRouteDefaults?.provider ?? parentOptions.provider,
						model: config.agentOptions?.model ?? providerRouteDefaults?.model ?? parentOptions.model
					}];
					let requestedChildAgentOptions;
					try {
					requestedChildAgentOptions = requestedAgentOptions(parentOptions, providerRouteDefaults !== void 0 ? {
						...providerRouteDefaults,
						...config.agentOptions
					} : config.agentOptions, modelRequest, modelSelectionEnabled);
					assertAllowedModelSelection(modelSelectionPolicy, parentOptions, requestedChildAgentOptions, modelRequest);
					if (requiresRoutePreflight) {
						if (llm === void 0) throw new Error("cannot resolve the selected child LLM route because the `llm` service is unavailable");
						requestedChildAgentOptions = await resolveChildModelOptions(llm, { ...parentOptions, ...providerRouteDefaults, ...requestedChildAgentOptions }, modelRequest.reasoning_effort, exec.signal, discoveryRoutes);
						if (runtimeCtx.subagents.getProvider(config.provider) !== subagentProvider) throw new Error(`subagent provider "${config.provider}" changed while resolving the child LLM route; retry the delegation`);
					}
					} catch (error) {
						exec.signal.throwIfAborted();
						if (llm === void 0) throw error;
						throw new Error(`${error.message}\n${childModelGuidance(await availableChildModels(llm, discoveryRoutes, exec.signal))}`);
					}
					const availableModels = llm === void 0 ? [] : await availableChildModels(llm, discoveryRoutes, exec.signal);
					if (runtimeCtx.subagents.getProvider(config.provider) !== subagentProvider) throw new Error(`subagent provider "${config.provider}" changed; retry the delegation`);
					exec.signal.throwIfAborted();
					const maxDepth = runtimeCtx.subagents.resolveMaxDepth(config.maxDepth);
					const request = {
						...args.cwd === void 0 ? {} : { cwd: args.cwd },
						prompt: [{
							type: "text",
							text: args.prompt
						}],
						parent,
						...agentPreset === void 0 ? {} : { agentPreset },
						...requestedChildAgentOptions !== void 0 ? { agentOptions: requestedChildAgentOptions } : {},
						...maxDepth !== void 0 ? { maxDepth } : {}
					};
					return {
						kind: "activation",
						selectedModel: {
							provider: requestedChildAgentOptions?.provider ?? parentOptions.provider ?? null,
							model: requestedChildAgentOptions?.model ?? parentOptions.model ?? null,
							reasoning_effort: requestedChildAgentOptions?.reasoningEffort ?? null
						},
						availableModels,
						subagentId: (await runtimeCtx.subagents.startActivation({
							provider: config.provider,
							label: args.description,
							request,
							signal: exec.signal,
							delivery: "parent"
						})).childId
					};
				}
			});
			mounted = {
				subagentProvider,
				definition,
				disposeTool: runtimeCtx.effect(() => {
					const unregister = runtimeCtx.tools.register(definition);
					delegationTools.add(definition);
					return () => {
						delegationTools.delete(definition);
						unregister();
					};
				})
			};
		};
		runtimeCtx.on("subagent/provider-added", (subagentProvider) => {
			if (subagentProvider.name === config.provider && mounted === void 0) mount(subagentProvider);
		});
		runtimeCtx.on("subagent/provider-removed", (name) => {
			if (name !== config.provider || mounted === void 0) return;
			mounted.disposeTool();
			mounted = void 0;
		});
		const present = runtimeCtx.subagents.getProvider(config.provider);
		if (present !== void 0) mount(present);
		else runtimeCtx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? "subagent"}" tool will register when it appears`);
		runtimeCtx.on("system-prompt/assemble", async (_assembly, context, next) => {
			const result = await next();
			if (mounted === void 0 || runtimeCtx.tools.get(toolName, context.scope) !== mounted.definition) return result;
			if (result.contexts.some(item => item.name === "nexus:subagent-models")) return result;
			const llm = runtimeCtx.get("llm");
			if (llm === void 0) return result;
			const parentOptions = context.agent === void 0 ? {} : parentAgentOptionsForDelegation(context.agent);
			const routes = modelSelectionPolicy?.routes ?? [{
				provider: config.agentOptions?.provider ?? mounted.subagentProvider.agentRouteDefaults?.provider ?? parentOptions.provider,
				model: config.agentOptions?.model ?? mounted.subagentProvider.agentRouteDefaults?.model ?? parentOptions.model
			}];
			const choices = await availableChildModels(llm, routes, context.signal);
			return { ...result, contexts: [...result.contexts, {
				name: "nexus:subagent-models", text: childModelGuidance(choices), interpolate: false
			}] };
		});
		runtimeCtx.systemPrompt.section({
			name: `tool:${toolName}`,
			order: runtimeCtx.systemPrompt.getSectionOrder("TOOL_SUBAGENT"),
			text: (context) => {
				if (mounted === void 0) return "";
				const visible = [...delegationTools].filter((tool) => runtimeCtx.tools.get(tool.name, context.scope) === tool).map((tool) => tool.name).sort();
				if (visible[0] !== toolName) return "";
				return `Start independent delegations with ${visible.map((name) => `\`${name}\``).join(" or ")} together in one assistant message and continue useful work while they run.`;
			}
		});
		runtimeCtx.systemPrompt.context({
			name: `tool:${toolName}:depth`,
			order: runtimeCtx.systemPrompt.getContextOrder("SUBAGENT_DELEGATION"),
			text: (context) => {
				if (context.agent === void 0 || mounted === void 0 || runtimeCtx.tools.get(toolName, context.scope) !== mounted.definition) return "";
				const maxDepth = runtimeCtx.subagents.resolveMaxDepth(config.maxDepth);
				if (maxDepth === void 0) return "";
				const depth = delegationDepthOf(context.agent);
				if (depth < maxDepth) return "";
				return `Delegation depth for \`${toolName}\`: current ${depth}, maximum ${maxDepth}, remaining levels 0. Do not call \`${toolName}\` at this depth; carry out the work directly.`;
			}
		});
	};
	const compositionScope = scopeOf(ctx);
	if (presets.configured && (session !== void 0 || compositionScope === void 0)) await presets.validate(ctx);
	if (!modelSelectionCapable && (!presets.configured || session !== void 0 || compositionScope === void 0)) {
		install(ctx, void 0);
		return;
	}
	const settings = ctx.get("subagentModelSelection");
	if (modelSelectionCapable && settings === void 0) throw new Error("tool-subagent: `modelSelectionSettings` requires @deepseek-ai/dsh-tool-subagent/model-selection-settings in the Host scope");
	const selectForSession = (target) => {
		if (!modelSelectionCapable || settings === void 0) return void 0;
		const freshSession = target.firstLiveSeq === 0 && target.eventAt(SessionSeq(0))?.type !== "session/end-seed";
		let allowedModels = subagentModelSelectionPolicy(ctx.sessionProjections, target);
		if (allowedModels === void 0) {
			const parentId = target.header.origin === "subagent" ? target.header.parentSession : void 0;
			if (parentId !== void 0) {
				const sessions = ctx.get("sessions");
				if (sessions === void 0) throw new Error("tool-subagent: child model-selection inheritance requires the Session registry");
				const parent = sessions.get(parentId);
				allowedModels = parent === void 0 ? void 0 : subagentModelSelectionPolicy(ctx.sessionProjections, parent);
			} else if (freshSession) {
				const current = settings.current();
				allowedModels = current.enabled ? current.allowedModels : void 0;
			}
		}
		if (allowedModels !== void 0) recordSubagentModelSelection(ctx.sessionProjections, target, allowedModels);
		return allowedModels === void 0 ? void 0 : { routes: allowedModels };
	};
	if (session !== void 0) {
		install(ctx, selectForSession(session));
		return;
	}
	if (compositionScope === void 0) throw new Error("tool-subagent: standing `modelSelectionSettings` requires a scoped preset Context");
	const agents = ctx.get("agents");
	/* v8 ignore next -- shipped preset compositions always include the Agent registry. */
	if (agents === void 0) throw new Error("tool-subagent: standing `modelSelectionSettings` requires the Agent registry");
	const scopedInstalls = /* @__PURE__ */ new WeakMap();
	const installing = /* @__PURE__ */ new WeakSet();
	const belongsToComposition = (candidate) => scopeChainOf(scopeOf(candidate.ctx)).includes(compositionScope);
	const installScoped = (candidate) => {
		const existing = scopedInstalls.get(candidate);
		if (existing !== void 0) return existing;
		if (installing.has(candidate)) return;
		installing.add(candidate);
		let fiber;
		try {
			const policy = selectForSession(candidate.session);
			fiber = candidate.ctx.inject([
				"tools",
				"subagents",
				"systemPrompt"
			], async (runtimeCtx) => {
				if (presets.configured) await presets.validate(ctx);
				install(runtimeCtx, policy);
			});
		} finally {
			installing.delete(candidate);
		}
		scopedInstalls.set(candidate, fiber);
		return fiber;
	};
	const removeScoped = (candidate) => {
		const fiber = scopedInstalls.get(candidate);
		if (fiber === void 0) return;
		scopedInstalls.delete(candidate);
		/* v8 ignore next 3 -- Cordis Fiber disposal contains registration cleanup failures; this is the final diagnostic sink. */
		fiber.dispose().catch((error) => {
			ctx.logger.warn(`tool-subagent: failed to remove recomposed Agent "${candidate.id}" definitions: ${String(error)}`);
		});
	};
	const reconcileComposedAgents = () => {
		for (const candidate of agents.list()) if (belongsToComposition(candidate)) installScoped(candidate);
		else removeScoped(candidate);
	};
	ctx.on("agent/created", async ({ agent: created }) => {
		await installScoped(created);
	});
	ctx.on("agent/disposed", ({ agent: disposed }) => {
		removeScoped(disposed);
	});
	ctx.on("tools/change", reconcileComposedAgents);
	reconcileComposedAgents();
}
//#endregion
export { Config, apply, inject, name };
