import { NexusError, type Capability, type DispatchContext, type JsonRecord, type NexusModule, type NexusRequest, type NexusServices } from '../../ports/contracts.js';
import { AgentLibrary } from '../resources/agents/library.js';
import { CliService } from '../integrations/cli/index.js';
import { AdvisorService } from './advisors.js';
import { CollaborationService } from './collaboration.js';
import { OrchestrationService } from './orchestration-service.js';
import { validatePlan } from './plan.js';
import { compilePlanAdaptations, saveCompiledPlan } from './adaptation-compiler.js';
import { Productivity } from './productivity.js';
import { WorkflowScheduler } from './scheduler.js';
import { GithubTaskBoard } from './github-board.js';
import type { TaskPlan } from './types.js';
import { newId, object, required, text } from './util.js';

interface Runtime {
  scheduler: WorkflowScheduler; agents: AgentLibrary; cli: CliService; collaboration: CollaborationService;
  productivity: Productivity; orchestration: OrchestrationService; advisor: AdvisorService; ready: Promise<void>;
  github: GithubTaskBoard;
}
const runtimes = new WeakMap<NexusServices, Runtime>();
function runtime(services: NexusServices): Runtime {
  const existing = runtimes.get(services); if (existing) return existing;
  const scheduler = new WorkflowScheduler(services);
  const value: Runtime = { scheduler, agents: new AgentLibrary(services), cli: new CliService(services), collaboration: new CollaborationService(services), productivity: new Productivity(services), orchestration: new OrchestrationService(services), advisor: new AdvisorService(services, scheduler), github: new GithubTaskBoard(services, scheduler), ready: scheduler.initialize() };
  runtimes.set(services, value); return value;
}
function capability(action: string, description: string, mutating = false, properties: JsonRecord = {}, requiredFields: string[] = [], permission?: string): Capability {
  return { action, description, mutating, permission, schema: { type: 'object', properties, required: requiredFields, additionalProperties: false } };
}
const string = { type: 'string' }, number = { type: 'number' }, boolean = { type: 'boolean' }, record = { type: 'object', additionalProperties: true }, strings = { type: 'array', items: string };
const runId = { runId: string };
const todoFields = { id: string, content: string, scope: { enum: ['life', 'work', 'project', 'daily', 'session'] }, status: { enum: ['pending', 'doing', 'blocked', 'done', 'cancelled'] }, quadrant: { type: 'integer', minimum: 1, maximum: 4 }, due: string, date: string, category: string, projectId: string, branch: string, linkedNodeId: string, completionEvidenceRefs: strings, expectedRevision: number, source: record };
const agentFields = { id: string, name: string, description: string, persona: string, body: string, category: string, emoji: string, locale: { enum: ['zh', 'en'] }, enabled: boolean, tags: strings, license: string, expectedRevision: number };
const workflowCapabilities: Capability[] = [
  capability('discover', '发现最多三项相关工作流能力；只返回 schema，不执行业务', false, { query: string, names: strings }),
  capability('plan', '校验并冻结任务 DAG、范围、模型路由、ownership、预算和适用学习版本；不会执行节点。editor 仅保存布局。inputRefs 可用 node:<上游ID> 传递本 Run 成功上游产物，须有依赖路径；data 边同时声明此输入。', true, { goal: string, scope: string, nodes: { type: 'array', minItems: 1, items: record }, edges: { type: 'array', items: record }, budgets: record, deliveryContract: record, authorizationRefs: strings, adaptations: record, editor: record }, ['goal', 'nodes']),
  capability('plans/list', '列出本会话版本化计划', false, { limit: number }),
  capability('prompt/on-turn', '宿主回合事件推进当前会话的提示词调度', true, { sessionId: string, turn: number }, ['sessionId', 'turn']),
  capability('plan/get', '读取冻结计划及修订', false, { planId: string }, ['planId']),
  capability('run', '将计划放入统一 Run；按幂等键启动正式宿主执行', true, { planId: string, idempotencyKey: string }, ['planId']),
  capability('list', '列出本会话任务运行与状态', false, { limit: number }),
  capability('status', '读取节点、预算、证据、模型实际身份及副作用状态', false, runId, ['runId']),
  capability('wait', '有界等待 Run 修订变化；最多 60 秒', false, { ...runId, afterRevision: number, timeoutMs: number }, ['runId']),
  capability('cancel', '通过原 exact activation handle 取消并等待后代；未知状态不冒充已取消', true, { ...runId, nodeId: string, reason: string }, ['runId']),
  capability('pause', '暂停新节点派发，保存现有任务和预算', true, runId, ['runId']),
  capability('resume', '显式恢复原计划及剩余预算；未知副作用必须先 reconcile', true, { ...runId, completedNodeIds: strings, evidenceRefs: strings }, ['runId']),
  capability('retry', '同范围有限重试，保留所有付费 attempt 和无关已过证据', true, { ...runId, nodeIds: strings }, ['runId']),
  capability('reconcile', '只查询原 activation 或原工具 requestId 的持久收据；无收据保持效果未知，不重新执行工具或新建代理', true, runId, ['runId']),
  capability('evidence/export', '导出脱敏 Run、事件、证据 refs、版本及许可清单', false, runId, ['runId']),
  capability('artifact/get', '按需获取 Run 结果正文并校验 hash', false, { artifactId: string }, ['artifactId']),
  ...['list', 'create', 'update', 'archive', 'remove', 'import', 'export'].map(action => capability(`todo/${action}`, '四目标待办、四象限、有效日期、证据完成、Markdown 标签和 CAS', !['list', 'export'].includes(action), { ...todoFields, query: string, today: string, limit: number, legacyTags: record, originalBody: string }, action === 'create' ? ['content'] : [])),
  ...['list', 'get', 'create', 'update', 'apply', 'revoke', 'pause', 'injections', 'tick'].map(action => capability(`prompt/${action}`, '版本化提示词与有来源、可撤销的定次/连续注入', !['list', 'get', 'injections'].includes(action), { id: string, templateId: string, name: string, content: string, description: string, category: string, tags: strings, enabled: boolean, bindings: record, query: string, schedule: { enum: ['once', 'rounds', 'every', 'continuous', 'immediate'] }, rounds: number, everyTurns: number, sessionId: string, expectedRevision: number, turn: number })),
  capability('models/list', '从正式宿主枚举精确模型身份；能力、价格和实际身份未知保持 unknown', false),
  ...['list', 'resolve', 'select'].map(action => capability(`routes/${action}`, '确定性模型策略、硬过滤、严格候选池、费用未知和亲和性预览', action === 'select', { reference: string, nodeId: string, roleId: string, prompt: string, policy: record, approvedPool: { type: 'array', items: { anyOf: [record, string] } }, inputTokens: number, maxOutputTokens: number, unknownCostPolicy: record, currentAffinity: record, hysteresisThreshold: number, remainingBudget: record, allowedRegions: strings, authorizationRef: string, allowedExecutorIds: strings, toolSchemaTokens: number, retriesReserved: number, promptEpoch: string, toolSurfaceEpoch: string, rendererVersion: string, cacheNamespace: string, excludedModelKeys: strings, excludedContextLineageIds: strings })),
  ...['list', 'get', 'save', 'validate', 'compile', 'catalog', 'framework', 'roles', 'generate', 'validate_leaf', 'leaves/list', 'leaves/get', 'leaves/generation', 'compile_leaf'].map(action => capability(`blueprints/${action}`, 'Metis 16 框架、26 角色、蓝图保护门与有版本来源的三轴生成方法读取/编译；接同一 TaskPlan/Run', ['save', 'compile', 'generate', 'compile_leaf'].includes(action), { id: string, blueprintId: string, blueprint: record, goal: string, shape: record, prompts: record, oracles: record, allowAgents: boolean, expectedRevision: number, authorizationRefs: strings, budgets: record, maxOutputTokens: number, approvedPool: { type: 'array', items: { anyOf: [record, string] } }, unknownCostPolicy: record, requireObservedRoutes: boolean, requireDifferentModel: boolean, remainingBudget: record, allowedRegions: strings, allowedExecutorIds: strings, input: record, leaf: record, leafId: string, leafHash: string, generationId: string, generationAttempt: { type: 'integer', minimum: 1, maximum: 2 }, rolePolicies: record, adaptations: record })),
  ...['settings', 'settings/get', 'list', 'active', 'propose', 'save', 'trial', 'retire', 'rollback', 'history', 'application', 'applications/list', 'applications/get', 'evaluation', 'evaluate'].map(action => capability(`adaptations/${action}`, '默认关闭的有界学习、确定性 holdout、编译器归因快照、回归与可逆晋升；application 只读', !['list', 'active', 'settings/get', 'history', 'application', 'applications/list', 'applications/get'].includes(action), { id: string, runId: string, enabled: boolean, projectTrusted: boolean, holdoutPercent: { type: 'number', minimum: 0, maximum: 100 }, adaptation: record, record, expectedRevision: number, regressionRunId: string, regressionEvidenceRefs: strings, revision: number, turnId: string })),
  capability('handoff', '生成跨模型有界交接与原始产物引用，不转发签名 thinking', false, { input: record }),
  ...['list', 'get', 'import', 'freeze', 'analyze', 'run', 'review', 'comment', 'close', 'reopen', 'pull'].map(action => capability(`github/${action}`, 'GitHub Issue 任务板：冻结 prompt、同一 Run 分析/实施/独立审查、显式外部评论/PR/关闭', !['list', 'get'].includes(action), { taskId: string, connectionId: string, owner: string, repo: string, number, state: string, page: number, prompt: string, route: record, budgets: record, idempotencyKey: string, expectedRevision: number, title: string, body: string, head: string, base: string, draft: boolean })),
  ...['discover', 'catalog', 'create', 'status', 'plan', 'transition', 'artifact', 'review', 'template', 'validate', 'export', 'import', 'evidence', 'cancel'].map(action => capability(`engineering/${action}`, '工程生命周期、必要文档、双向追踪与冷审查同一 Run 接线', !['discover', 'catalog', 'status', 'validate', 'export', 'evidence'].includes(action), { input: record })),
];
export function createWorkflowModule(services: NexusServices): NexusModule {
  const rt = runtime(services);
  return {
    id: 'workflow', capabilities: workflowCapabilities,
    async dispatch(request: NexusRequest, context: DispatchContext = {}): Promise<unknown> {
      await rt.ready;
      const p = request.params ?? {}, action = request.action;
      if (action === 'prompt/on-turn') {
        if (context.actorId !== 'nexus-workflow-hook' || p.sessionId !== context.sessionId) throw new NexusError('PERMISSION_DENIED', '仅允许宿主当前会话回合事件');
        await rt.productivity.onTurn(String(p.sessionId), Number(p.turn));
        return { accepted: true };
      }
      if (action === 'discover') {
        const names = Array.isArray(p.names) ? p.names as string[] : [];
        return workflowCapabilities.filter(c => names.length ? names.includes(c.action) : `${c.action} ${c.description}`.includes(String(p.query ?? ''))).slice(0, names.length ? 5 : 3);
      }
      if (action.startsWith('todo/')) return rt.productivity.todo(request, context);
      if (action.startsWith('prompt/')) return rt.productivity.prompt(request, context);
      if (action.startsWith('blueprints/')) return rt.orchestration.blueprints(request, context);
      if (action.startsWith('routes/')) return rt.orchestration.routes(request, context);
      if (action.startsWith('adaptations/')) return rt.orchestration.adaptations(request, context);
      if (action.startsWith('github/')) return rt.github.dispatch(request, context);
      if (action === 'models/list') return rt.orchestration.models();
      if (action === 'handoff') return rt.orchestration.handoff(object(p.input ?? p));
      if (action.startsWith('engineering/')) return services.invoke('quality', { ...request, action: `lifecycle/${action.slice(12)}`, params: p.input ? object(p.input) : p }, context);
      if (action === 'plan') {
        const plan = validatePlan(p, { ...context, workspaceRoot: context.workspaceRoot ?? services.workspaceRoot });
        await compilePlanAdaptations(services, plan, p, context);
        return saveCompiledPlan(services, plan);
      }
      if (action === 'plans/list') return (await services.store.list<TaskPlan>('workflow-plans')).filter(row => !context.sessionId || row.value.ownerSessionId === context.sessionId).slice(-Math.min(200, Number(p.limit ?? 50))).reverse();
      if (action === 'plan/get') {
        const row = await required<TaskPlan>(services, 'workflow-plans', text(p.planId, 'planId', 128));
        if (context.sessionId && row.value.ownerSessionId !== context.sessionId) throw new NexusError('SCOPE_MISMATCH', '计划属于其他会话');
        return row;
      }
      if (action === 'run') return rt.scheduler.start(text(p.planId, 'planId', 128), typeof p.idempotencyKey === 'string' ? p.idempotencyKey : request.requestId ?? newId('run-request'), context);
      if (action === 'list') return (await services.store.list<{ ownerSessionId: string }>('workflow-runs')).filter(row => !context.sessionId || row.value.ownerSessionId === context.sessionId).slice(-Math.min(200, Number(p.limit ?? 50))).reverse();
      if (action === 'artifact/get') {
        const row = await required<{ runId: string; content: string }>(services, 'workflow-artifacts', text(p.artifactId, 'artifactId', 128));
        await rt.scheduler.get(row.value.runId, context); return row;
      }
      const id = text(p.runId ?? request.target?.id, 'runId', 128);
      if (action === 'status') return rt.scheduler.get(id, context);
      if (action === 'wait') return rt.scheduler.wait(id, context, Number(p.afterRevision ?? 0), Number(p.timeoutMs ?? 30000));
      if (action === 'cancel') return rt.scheduler.cancel(id, context, typeof p.nodeId === 'string' ? p.nodeId : undefined, typeof p.reason === 'string' ? p.reason : '用户取消');
      if (action === 'pause') return rt.scheduler.pause(id, context);
      if (action === 'resume') return rt.scheduler.resume(id, context, p);
      if (action === 'retry') return rt.scheduler.retry(id, context, Array.isArray(p.nodeIds) ? p.nodeIds as string[] : undefined);
      if (action === 'reconcile') return rt.scheduler.reconcile(id, context);
      if (action === 'evidence/export') return rt.scheduler.export(id, context);
      throw new NexusError('INVALID_ARGUMENT', `未知 workflow action ${action}`);
    },
    dispose: () => rt.scheduler.dispose(),
  };
}

const agentCapabilities: Capability[] = [
  capability('models/list', '查询宿主当前可用的精确 provider/model 代号与 reasoningEffort 支持值；不创建子智能体、不发送模型请求。创建时省略或留空 reasoning_effort 自动采用所选模型最高支持强度。', false),
  capability('discover', '发现最多三项专家/协作能力；无发送或执行副作用', false, { query: string, names: strings }),
  capability('engines', '读取普通子代理/原生团队/独立会话/外部 CLI 的实际可用性', false),
  capability('list', '专家目录：完整双语原文、23 分类、来源、关键词和启用状态；正文按需读取', false, { query: string, category: string, enabled: boolean, source: string, locale: string, offset: number, limit: number }),
  capability('get', '读取专家 persona 正文及许可', false, { id: string }, ['id']),
  ...['create', 'update', 'enable', 'disable', 'delete'].map(a => capability(a, '专家自定义、CAS、启停和历史保留软删除', true, agentFields)),
  capability('spawn', '专家咨询编译到同一 TaskPlan/Run，默认不允许递归；先用 models/list 取得精确模型代号。route.provider/model 成对填写；route.reasoningEffort 省略或空白采用该模型最高支持强度，显式值须受支持。', true, { expertId: string, prompt: string, route: record, budgets: record, idempotencyKey: string, useDisabledOnce: boolean }, ['expertId', 'prompt']),
  ...['list', 'get', 'create', 'update', 'plan', 'delete'].map(a => capability(`teams/${a}`, '五种内置专家团及自定义 2–8 人协作；选团/计划不自动发送', ['create', 'update', 'plan', 'delete'].includes(a), { id: string, teamId: string, name: string, description: string, goal: string, constraints: string, deliveryRequirements: string, members: { type: 'array', items: record }, examples: strings, enabled: boolean, prompt: string, route: record, budgets: record, useDisabledOnce: boolean, expectedRevision: number, locale: string, coordinatorMode: string, coordinatorPrompt: string, coordinatorTemplateId: string, engine: string })),
  ...['list', 'get', 'snapshot', 'status', 'create', 'spawn', 'fork', 'fork.lookup', 'open', 'wake', 'continue', 'resume', 'rename', 'prompt', 'inject', 'cancel', 'model.select', 'models.select', 'permissions', 'setPermission', 'activation/status'].map(a => capability(`session/${a}`, '正式宿主持久会话、完整事件、消息回执、取消和模型/权限控制；不伪造 user 消息。session/spawn 前用 models/list 查精确模型代号，provider/model 成对填写；reasoning_effort（兼容 reasoningEffort）省略或空白自动采用所选模型最高支持强度，非空显式值须受支持。', !['list', 'get', 'snapshot', 'status', 'fork.lookup', 'permissions', 'activation/status'].includes(a), { sessionId: string, activationId: string, prompt: string, text: string, title: string, name: string, cwd: string, provider: string, model: string, reasoningEffort: string, reasoning_effort: string, maxTokens: number, agentPreset: string, parentId: string, keepInbox: boolean, requestId: string, correlationId: string, childSessionId: string, boundary: number, atSeq: number, expectedRevision: string, workspaceId: string, mode: string, permission: string, readOnly: boolean, allowChildren: boolean, maxDepth: number, allowedCapabilityIds: strings })),
  ...['create', 'list', 'join', 'leave', 'send', 'messages', 'read', 'delete', 'dissolve', 'kick', 'presence'].map(a => capability(`room/${a}`, '持久房间、带来源消息、回执、成员与 presence；在线不等于执行确认', !['list', 'messages', 'presence'].includes(a), { roomId: string, name: string, scope: string, projectId: string, sessionId: string, messageId: string, body: string, subject: string, attachments: { type: 'array' }, nodeId: string, runId: string, target: string, replyTo: string, mentions: strings, idempotencyKey: string, authorized: boolean, afterSeq: number, limit: number }, [], a === 'send' ? 'agents:message' : undefined)),
  ...['declare', 'status', 'release'].map(a => capability(`claim/${a}`, '文件/服务声明、已声明/已观察来源、冲突与租约；不是 OS 锁', a !== 'status', { id: string, resourceKind: string, resource: string, path: string, nodeId: string, runId: string, intent: string, leaseMs: number, source: string, exclusive: boolean, baseRevision: string, reason: string, expectedRevision: number })),
  ...['create', 'list', 'evaluate', 'notes', 'adopt', 'ignore', 'reopen', 'steer', 'enable', 'disable'].map(a => capability(`advisor/${a}`, '独立旁观评审、严重度、采纳/忽略/重开与有来源 steer 草稿', !['list', 'notes'].includes(a), { id: string, advisorId: string, name: string, enabled: boolean, autoEvaluate: boolean, role: string, route: record, scope: string, projectId: string, text: string, messages: { type: 'array', items: record }, noteId: string, evidenceRefs: strings, adopted: boolean })),
  ...['adapters', 'describe', 'register', 'allowlist', 'plan', 'dispatch', 'execute', 'status', 'wait', 'cancel', 'resume', 'continue'].map(a => capability(`cli/${a}`, 'Kimi/Codex/Grok/Hermes 及白名单自定义 CLI；同一 Run、长 prompt 文件/stdin、ChildResult 验证', !['adapters', 'describe', 'status', 'wait'].includes(a), { id: string, adapterId: string, adapter: record, binaries: strings, jobId: string, runId: string, nodeId: string, prompt: string, cwd: string, sessionId: string, model: string, images: strings, envReferences: record, timeoutMs: number, scope: string, idempotencyKey: string, expectedRevision: number })),
];
export function createAgentsModule(services: NexusServices): NexusModule {
  const rt = runtime(services);
  return {
    id: 'agents', capabilities: agentCapabilities,
    async dispatch(request: NexusRequest, context: DispatchContext = {}): Promise<unknown> {
      await rt.ready;
      const p = request.params ?? {}, action = request.action;
      if (action === 'models/list') return rt.orchestration.models();
      if (action === 'discover') {
        const names = Array.isArray(p.names) ? p.names as string[] : [];
        return agentCapabilities.filter(c => names.length ? names.includes(c.action) : `${c.action} ${c.description}`.includes(String(p.query ?? ''))).slice(0, names.length ? 5 : 3);
      }
      if (action === 'engines') {
        const facts = await services.host.facts(), available = Array.isArray(facts.capabilities) ? facts.capabilities as string[] : [];
        return [
          { id: 'subagent', state: available.includes('subagents') ? 'available' : 'unsupported', reason: '正式 startActivation + caller delivery + exact dispose' },
          { id: 'native-team', state: available.includes('nativeTeam') ? 'available' : 'unsupported', reason: '要求宿主正式团队服务；当前选择普通代理可保留同目标职责协作' },
          { id: 'session', state: available.includes('sessions') ? 'available' : 'unsupported', reason: '宿主持久独立会话，可由人接管' },
          { id: 'cli', state: 'configured', adapters: await rt.cli.list(), reason: '运行前探测可执行文件、权限与真实 ChildResult' },
        ];
      }
      if (action.startsWith('room/')) return rt.collaboration.room(request, context);
      if (action.startsWith('claim/')) return rt.collaboration.claim(request, context);
      if (action.startsWith('advisor/')) return rt.advisor.dispatch(request, context);
      if (action === 'list') return rt.agents.list(p);
      if (action === 'get') return rt.agents.get(text(p.id ?? request.target?.id, 'id', 128));
      if (action === 'create' || action === 'update') return rt.agents.save(p, request.expectedRevision ?? Number(p.expectedRevision));
      if (['enable', 'disable', 'delete'].includes(action)) return rt.agents.setState(text(p.id ?? request.target?.id, 'id', 128), action === 'delete' ? { deleted: true, enabled: false } : { enabled: action === 'enable' }, request.expectedRevision ?? Number(p.expectedRevision));
      if (action === 'teams/list') return rt.agents.teams(p.locale === 'en' ? 'en' : 'zh');
      if (action === 'teams/get') return rt.agents.team(text(p.teamId ?? p.id, 'teamId', 128));
      if (action === 'teams/create' || action === 'teams/update') return rt.agents.saveTeam(p, request.expectedRevision ?? Number(p.expectedRevision));
      if (action === 'teams/plan') {
        if (p.engine === 'native-team') {
          const facts = await services.host.facts();
          if (!Array.isArray(facts.capabilities) || !facts.capabilities.includes('nativeTeam')) throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '宿主没有正式 native team 服务；请显式选择 subagent 保留同目标协作');
        }
        const plan = await rt.agents.planTeam(p, context); return services.store.put('workflow-plans', plan.id, plan, 0);
      }
      if (action === 'teams/delete') {
        const id = text(p.teamId ?? p.id, 'teamId', 128), team = await rt.agents.team(id), row = await services.store.get('agent-teams', id);
        return services.store.put('agent-teams', id, { ...team, deleted: true, enabled: false }, row ? request.expectedRevision ?? Number(p.expectedRevision) : 0);
      }
      if (action === 'spawn') {
        const expert = await rt.agents.get(text(p.expertId, 'expertId', 128));
        if (!expert.enabled && !p.useDisabledOnce) throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '专家已停用');
        const persona = expert.translations.zh ?? expert.translations.en ?? Object.values(expert.translations)[0]!;
        const plan = validatePlan({ goal: text(p.prompt, 'prompt', 20000), nodes: [{ id: 'expert', kind: 'agent', role: expert.id, expertId: expert.id, system: `${persona.body}\n\n本角色无递归权限，仅执行冻结任务；不能因 persona 获得额外工具。`, prompt: p.prompt, route: p.route, allowChildren: false }], budgets: p.budgets }, { ...context, workspaceRoot: context.workspaceRoot ?? services.workspaceRoot });
        await services.store.put('workflow-plans', plan.id, plan, 0);
        return rt.scheduler.start(plan.id, String(p.idempotencyKey ?? request.requestId ?? newId('expert-request')), context);
      }
      if (action.startsWith('session/')) return services.host.sessions(action.slice(8), { ...p, requestId: p.requestId ?? request.requestId, source: { kind: 'plugin', id: 'dsh-nexus' }, parentId: p.parentId ?? context.sessionId });
      if (action === 'cli/adapters') return rt.cli.list();
      if (action === 'cli/describe') return rt.cli.describe(p, context);
      if (action === 'cli/register') return rt.cli.register(p, request.expectedRevision ?? Number(p.expectedRevision));
      if (action === 'cli/allowlist') return rt.cli.allow(p);
      if (action === 'cli/execute') return rt.cli.execute(p, context);
      if (['cli/plan', 'cli/dispatch', 'cli/resume', 'cli/continue'].includes(action)) {
        await rt.cli.adapter(text(p.adapterId, 'adapterId', 128));
        const plan = validatePlan({ goal: text(p.prompt, 'prompt', 200000), nodes: [{ id: 'cli', kind: 'cli', params: p, cwd: p.cwd, writeClaims: [context.workspaceRoot ?? services.workspaceRoot] }], budgets: { maxModelCalls: 1, maxConcurrent: 1 } }, context);
        const row = await services.store.put('workflow-plans', plan.id, plan, 0);
        if (action === 'cli/plan') return row;
        return rt.scheduler.start(plan.id, String(p.idempotencyKey ?? request.requestId ?? newId('cli-request')), context);
      }
      if (action === 'cli/status') return p.runId ? rt.scheduler.get(String(p.runId), context) : rt.cli.status(text(p.jobId, 'jobId', 128), context);
      if (action === 'cli/wait') return rt.scheduler.wait(text(p.runId, 'runId', 128), context);
      if (action === 'cli/cancel') return rt.scheduler.cancel(text(p.runId, 'runId', 128), context);
      throw new NexusError('INVALID_ARGUMENT', `未知 agents action ${action}`);
    },
  };
}
export async function onWorkflowTurn(services: NexusServices, sessionId: string, turn: number): Promise<void> {
  const rt = runtime(services); await rt.ready; await rt.productivity.onTurn(sessionId, turn);
}
export { WorkflowScheduler, validatePlan };
export type * from './types.js';
