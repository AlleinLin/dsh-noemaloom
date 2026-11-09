import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolsService, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import { NexusError } from '../ports/contracts.js';

/** A service call uses the official batch executor without claiming a model step. */
export async function executeSingleTool(tools: ToolsService, input: {
  callId: ToolCallId; name: string; arguments: unknown; signal: AbortSignal; agent?: Agent;
}): Promise<ToolExecutionResult> {
  const batch = await tools.execute({
    calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
    signal: input.signal, ...(input.agent ? { agent: input.agent } : {}),
  });
  if (batch.results.length !== 1 || batch.results[0]?.callId !== input.callId) {
    throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '工具批次未返回身份匹配的唯一执行结果；不可重复执行');
  }
  return batch.results[0].result;
}
