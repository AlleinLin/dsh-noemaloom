import { defineTool } from '@deepseek-ai/dsh-tools';
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values';
import schema from '@deepseek-ai/schemastery';
import { randomUUID } from 'node:crypto';
import { NexusError, type NexusServices } from '../../../ports/contracts.js';
import { hostAuthority } from '../../../host/host-adapter.js';
import type { HostContext } from '../../../host/types.js';

export const name = 'nexus-preset-runtime';
export const inject = ['nexus', 'tools'];
export const Config = schema.object({
  presetId: schema.string().required(),
  shellId: schema.string().default('platform-default'),
  registerShell: schema.boolean().default(false),
});
interface PresetHostConfig { presetId: string; shellId: string; registerShell: boolean; }

function isToolOutput(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && isJsonValue(value);
}

/** Registers in the preset scope, so each agent retains its exact generation. */
export function apply(ctx: HostContext, config: PresetHostConfig): void {
  const generationId = randomUUID();
  const nexus = ctx.get('nexus') as { services?: NexusServices } | NexusServices | undefined;
  const services = nexus && ('services' in nexus ? nexus.services : nexus) as NexusServices | undefined;
  if (!services?.invoke) throw new NexusError('DEPENDENCY_MISSING', 'Nexus preset 需要同 realm 的 nexus 服务');
  const tools = ctx.get('tools');
  if (config.registerShell) {
    const tool = defineTool({
      name: 'bash',
      description: '在已验证的 Git for Windows Bash 中执行命令。每次新建进程；cwd、变量、函数不会跨调用保留。后台任务有独立作业 ID。',
      parameters: {
        command: { type: 'string', required: true },
        cwd: { type: 'string' },
        background: { type: 'boolean' },
        timeoutMs: { type: 'number' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const context = {
          signal: exec.signal, actorId: exec.agent?.id ?? 'native-tool', sessionId: exec.agent?.session?.id ?? exec.agent?.id,
          workspaceRoot: exec.agent?.session?.header?.cwd ?? services.workspaceRoot, toolExecution: exec,
        };
        const result = await hostAuthority.run(context, () => services.invoke('runtime', {
          action: 'shell.run', requestId: randomUUID(), params: { ...args, shellId: config.shellId },
        }, context));
        if (!isToolOutput(result)) throw new NexusError('HOST_CONTRACT_UNSUPPORTED', 'Shell 工具返回值必须为无损 JSON 对象');
        return result;
      },
    });
    ctx.effect(() => tools.register(tool));
  }
  // Own configuration ledger; do not write fabricated events to host logs.
  ctx.on?.('session/created', (session: any) => {
    if (!session?.id) return;
    return services.store.put('preset-session-generation', session.id, {
      presetId: config.presetId, shellId: config.shellId, generationId,
      createdAt: new Date().toISOString(), wireSchemaPolicy: 'stable-within-epoch',
    }).catch(error => services.emit('presets.ledger.error', { sessionId: session.id, reason: String(error) }));
  });
}
