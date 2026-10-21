import { defineTool } from '@deepseek-ai/dsh-tools';
import { NexusError } from '../ports/contracts.js';
import { SELF_COMPACTION_TOOL } from '../shared/context-compaction.js';
import { nativeCompactionFor } from './compaction-binding.js';
import { toHarnessError } from './native-diagnostics.js';
import type { HostContext } from './types.js';

/** One global definition uses the exact Agent binding. Preset providers never
 * register duplicate global tools, and normal child filters/denies still apply. */
export function registerSelfCompactionTool(ctx: HostContext): () => void {
  return ctx.get('tools').register(defineTool({
    name: SELF_COMPACTION_TOOL,
    description: '查询或手动压缩当前调用智能体自己的原生会话。子智能体只能压缩自己，不能指定父会话、同级会话、lane、provider或策略。'
      + 'action=status 无生成请求，返回当前有效模型窗口、占用估计（含缓存输入、系统提示、工具schema、待接纳输入和输出预留）、用户自动阈值、独立压缩模型及维护状态；可附requestId查原操作收据。'
      + 'action=compact 需要稳定requestId；用原生事务为安全连续范围生成限窗摘要并提交，保留最近完整工具配对和稳定前缀。当前调用及未闭合工具配对不可压缩。'
      + '只读子任务可以使用自身维护，但显式工具deny和激活授权仍有效。不能修改用户自动策略；关闭自动提前压缩不影响手动操作，观察/停用模式仍禁止正式修改。'
      + '相同requestId复用已完成回执；状态未知时先查status及原requestId，compact原ID仅对账，不重放摘要或替换。确认终止后才能使用新的明确意图。'
      + 'busy、无安全范围、压后仍超限或未知效果均返回原因与恢复办法，不保证成功；不能把wait/失败当作已压缩。此工具不重放已完成工具，不重发效果未知的模型请求。'
      + '原文可用nexus_context的decompress/peek按正式引用只读检索。',
    parameters: {
      action: { type: 'string', enum: ['status', 'compact'], required: true },
      requestId: { type: 'string', description: 'compact必填的1–160字符稳定意图标识；status可用原ID查收据。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      try {
        if (!exec.agent || !args || typeof args !== 'object' || Object.keys(args).some(key => !['action', 'requestId'].includes(key))) {
          throw new NexusError('PERMISSION_DENIED', '自身压缩不接受目标会话或策略参数，且必须有原生调用智能体');
        }
        const provider = nativeCompactionFor(exec.agent);
        if (!provider?.selfCompaction) throw new NexusError('CTX_NATIVE_PROVIDER_UNAVAILABLE', '当前调用智能体没有准确绑定的原生压缩所有者；请检查本会话preset配置');
        return await provider.selfCompaction(exec.agent, args, exec.signal);
      } catch (error) { throw toHarnessError(error, { phase: 'self-context-maintenance', signalAborted: exec.signal.aborted }); }
    },
  }));
}
