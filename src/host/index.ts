import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values';
import { createSqliteStore } from '../domain/storage/sqlite.js';
import { createDispatcher } from '../domain/operations/index.js';
import { registerDomainModules } from '../domain/index.js';
import { createHostExecutor } from '../domain/runtime/execution/index.js';
import { NexusError, type NexusServices } from '../ports/contracts.js';
import { toHarnessError } from './native-diagnostics.js';
import { registerCanvasAssets } from './canvases.js';
import { createHostAdapter, hostAuthority } from './host-adapter.js';
import { OperationController } from './lifecycle.js';
import { registerRpcRoute } from './routes.js';
import { registerMemoryHooks } from './hooks.js';
import { registerInsightsHook } from './insights-hook.js';
import { registerCompanionHook } from './companion-hook.js';
import { registerLiveCommands } from './live-commands.js';
import { registerAutonomyHook } from './autonomy-hook.js';
import { registerStepPauseHook } from './step-pause-hook.js';
import type { HostContext, NexusConfig } from './types.js';
export { hostAuthority } from './host-adapter.js';

export const name = 'dsh-nexus';
// Keep both dependencies declared so a provider change rebuilds this consumer.
// The registration context below carries its injected webServer into rc.2 RPC.
export const inject = ['connection', 'tools', 'webServer'];
export const Config = schema.object({
  dataDir: schema.string().description('Nexus 数据目录；省略时取当前宿主 profile/data/nexus。'),
  workspaceRoot: schema.string().description('默认工作区；会话操作仍使用宿主会话权限根。'),
  maxRequestBytes: schema.number().min(1024).max(16777216).default(1048576),
  maxOutputBytes: schema.number().min(1024).max(4194304).default(65536),
  modelWindowTokens: schema.number().min(1024).default(131072),
  modelRoutes: schema.dict(schema.object({
    provider: schema.string().required(), model: schema.string().required(),
    reasoningEffort: schema.string(), credentialScope: schema.string(),
  })).default({}),
});

function isToolOutput(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && isJsonValue(value);
}

/**
 * rc.2 Connection captures a Cordis shadow Context in its RPC/fetch getters.
 * Carry this consumer's public webServer capability as derived metadata so the
 * RPC HTTP route resolves it without changing Connection's sibling origin.
 * extend() preserves the consumer fiber, which owns registration and cleanup.
 * Create this context per activation; never retain handles across an unload.
 */
export function createConnectionRegistrationContext<T extends Context>(ctx: T): T {
  if (!Context.is(ctx)) throw new NexusError('HOST_CONTRACT_UNSUPPORTED', 'Connection 注册需要正式 Cordis Context');
  const webServer: unknown = Reflect.get(ctx, 'webServer');
  if (webServer === null || (typeof webServer !== 'object' && typeof webServer !== 'function')
    || typeof Reflect.get(webServer, 'register') !== 'function') {
    throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', 'Connection 独立通道需要已注入的 webServer.register');
  }
  return ctx.extend({ webServer });
}

async function installedPackageRoot(): Promise<string> {
  let candidate = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    const manifest = await readFile(join(candidate, 'package.json'), 'utf8').then(text => JSON.parse(text)).catch(() => undefined);
    if (manifest?.name === '@local/dsh-nexus') return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '无法定位 Nexus 自身安装包资源根');
}

export async function createNexusRuntime(ctx: HostContext, config: NexusConfig = {}, compose = registerDomainModules) {
  const profile = ctx.get('profileContext');
  const dataDir = config.dataDir ?? (profile?.dir ? join(profile.dir, 'data', 'nexus') : undefined);
  if (!dataDir || !isAbsolute(dataDir)) throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '需要明确 dataDir 或正式 profileContext.dir');
  const workspaceRoot = await realpath(resolve(config.workspaceRoot ?? profile?.cwd ?? process.cwd()));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const controller = new OperationController();
  const packageRoot = await installedPackageRoot();
  const store = await createSqliteStore(dataDir, packageRoot);
  const initializationCleanup: Array<() => unknown | Promise<unknown>> = [() => store.close()];
  try {
  if (!Context.is(ctx)) throw new NexusError('HOST_CONTRACT_UNSUPPORTED', 'Connection 注册需要正式 Cordis Context');
  const registrationContext = createConnectionRegistrationContext(ctx);
  const host = createHostAdapter(registrationContext, config, workspaceRoot, controller.controller.signal);
  initializationCleanup.push(() => host.dispose());
  const executor = createHostExecutor(ctx, host, workspaceRoot, controller.controller.signal, () => {
    const authority = hostAuthority.getStore();
    return { workspaceRoot: authority?.workspaceRoot, sessionId: authority?.sessionId,
      managedRoots: [join(dataDir, 'extension-cache')] };
  });
  initializationCleanup.push(() => executor.dispose());
  const remoteBridges: any[] = [];
  const remoteDisposers: Array<() => unknown> = [];
  initializationCleanup.push(async () => { for (const dispose of remoteDisposers.reverse()) await dispose(); });
  const base: Omit<NexusServices, 'invoke'> = {
    dataDir, workspaceRoot, packageRoot,
    store, host, executor, signal: controller.controller.signal,
    emit(event, data) {
      ctx.emit?.('nexus/event', { event, data });
      for (const remote of remoteBridges) remote.publish(event, data);
    },
  };
  const dispatcher = createDispatcher(base);
  initializationCleanup.push(() => dispatcher.dispose(), () => controller.dispose());
  host.connect(dispatcher.services, domain => dispatcher.capabilities(domain));
  await compose(dispatcher.services, module => {
    dispatcher.register(module);
    const remote = (module as any).nativeRemote;
    if (!remote) return;
    const webServer = ctx.get('webServer');
    if (!webServer?.registerUpgrade) {
      ctx.logger?.warn('Nexus remote transport unavailable: webServer.registerUpgrade missing');
      return;
    }
    for (const path of ['/ios/v1', '/nexus/web/v1']) {
      remoteDisposers.push(webServer.registerUpgrade({
        path, handler: (request: any, socket: any, head: any) => remote.handleUpgrade(request, socket, head),
      }));
    }
    remoteBridges.push(remote);
  });
  await host.initialize();
  // Mnemon owns automatic memory injection/recall/capture. Keep the unique
  // workflow turn hook without running a second automatic memory pipeline.
  registerMemoryHooks(ctx, dispatcher.services, controller, { memory: false });
  const stopInsights = registerInsightsHook(ctx, dispatcher.services, controller);
  initializationCleanup.push(stopInsights);
  const stopCompanion = registerCompanionHook(ctx, dispatcher.services, controller);
  initializationCleanup.push(stopCompanion);
  const stopAutonomy = registerAutonomyHook(ctx, dispatcher.services, controller);
  initializationCleanup.push(stopAutonomy);
  const stopStepPause = registerStepPauseHook(ctx, dispatcher.services);
  initializationCleanup.push(stopStepPause);
  const stopLiveCommands = registerLiveCommands(registrationContext);
  initializationCleanup.push(stopLiveCommands);
  controller.setRouteDisposer(registerRpcRoute(ctx, dispatcher, controller, config.maxRequestBytes ?? 1048576));
  const tools = ctx.get('tools');
  const domains = [...new Set(dispatcher.capabilities().map(item => item.domain))].sort();
  const disposers: Array<() => unknown> = [];
  initializationCleanup.push(async () => { for (const dispose of disposers.reverse()) await dispose(); });
  for (const domain of domains) {
    const tool = defineTool({
      name: `nexus_${domain}`,
      description: `DSH Nexus ${domain} 统一操作。先用 nexus_catalog 查询动作合同；写操作必须 requestId，文件与执行权限由宿主核验。`
        + ' 失败结果包含原领域 error.code、统一 error.diagnosticCode、traceId 和副作用状态；存在未知副作用时先核实收据，不能自动重复写操作。'
        + (domain === 'agents' ? ' 创建子智能体前可用 models/list 查询精确 provider/model 代号和支持的思考强度。provider/model 成对填写；reasoning_effort 或 reasoningEffort 省略或空白时自动使用所选模型最高支持强度，显式值须受支持；无效选择返回可用目录。' : '')
        + (domain === 'autonomy' ? ' 自主规划的 get/list/settings 读取缓存。计划审批、修改、暂停及恢复由用户界面操作；模型不得自行批准、绕过审批或重复投递状态未知的步骤。' : ''),
      parameters: {
        action: {
          type: 'string', required: true,
          enum: dispatcher.capabilities(domain).filter(item => !item.action.startsWith('native/')).map(item => item.action).sort(),
        },
        requestId: { type: 'string', description: '写操作必填的稳定意图标识。' },
        target: { type: 'object', additionalProperties: true, properties: { id: { type: 'string' } } },
        params: { type: 'object', additionalProperties: true },
        expectedRevision: { type: 'integer', description: '非负资源代际；由 dispatcher 校验。' },
        cursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        limit: { type: 'integer', description: '每页 1 至 200 项；由 dispatcher 校验。' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        try {
        if (args.action.startsWith('native/')) throw new NexusError('PERMISSION_DENIED', '原生宿主提交不通过模型工具调用');
        const context = {
          scopeLevel: exec.agent?.id ? 'session' as const : 'workspace' as const,
          signal: exec.signal, actorId: 'native-tool', sessionId: exec.agent?.id,
          workspaceRoot: exec.agent?.session?.header?.cwd ?? workspaceRoot,
          toolExecution: exec,
        };
        const result = await controller.run(exec.signal, () => hostAuthority.run(context, () => dispatcher.dispatch(domain, args, context)));
        if (!isToolOutput(result)) throw new NexusError('HOST_CONTRACT_UNSUPPORTED', 'Nexus 工具返回值必须为无损 JSON 对象');
        return result;
        } catch (error) {
          throw toHarnessError(error, { phase: `tool:${domain}.${args.action}`, signalAborted: Boolean(exec.signal?.aborted) });
        }
      },
    });
    disposers.push(tools.register(tool));
  }
  let disposal: Promise<void> | undefined;
  return {
    dispatcher, services: dispatcher.services,
    dispose() {
      return disposal ??= (async () => {
        const failures: unknown[] = [];
        for (const cleanup of [
          stopLiveCommands, stopStepPause, stopAutonomy, stopCompanion, stopInsights, ...remoteDisposers.slice().reverse(), () => controller.dispose(), () => host.dispose(),
          () => executor.dispose(), ...disposers.slice().reverse(), () => dispatcher.dispose(), () => store.close(),
        ]) {
          try { await cleanup(); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new NexusError('PARTIAL_EFFECT', 'Nexus 停用后仍有未确认清理结果', { failures: failures.length });
      })();
    },
  };
  } catch (error) {
    for (const cleanup of initializationCleanup.reverse()) {
      try { await cleanup(); } catch (cleanupError) { ctx.logger?.warn('Nexus startup cleanup failed', cleanupError instanceof Error ? cleanupError.message : 'INTERNAL'); }
    }
    throw error;
  }
}

export async function apply(ctx: HostContext, config: NexusConfig = {}): Promise<void> {
  registerCanvasAssets(ctx);
  const runtime = await createNexusRuntime(ctx, config);
  try {
    ctx.effect(() => () => runtime.dispose(), 'nexus: owned runtime');
    ctx.provide('nexus', runtime);
  } catch (error) {
    // The owner can unload while asynchronous initialization is still running.
    // A rejected effect/provision must not strand the completed worker runtime.
    try { await runtime.dispose(); }
    catch (cleanupError) { ctx.logger?.warn('Nexus unowned runtime cleanup failed', cleanupError instanceof Error ? cleanupError.message : 'INTERNAL'); }
    throw error;
  }
}
