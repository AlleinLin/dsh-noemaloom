import type { CoreMessage } from './index.js';
import { NexusError, type JsonRecord } from '../../../ports/contracts.js';

/** Structural public DSH Message contract; the host keeps ownership of its
 * branded ids and attachment refs. Unknown blocks are retained verbatim. */
export interface NativeMessage {
  id: string;
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: JsonRecord[];
  source: JsonRecord;
  toolCallId?: string;
  [key: string]: unknown;
}
export interface NativeSurfaceNode {
  seq: number;
  message: NativeMessage;
  summaryOfBlockId?: string;
}
export interface NativeCoreMessage extends CoreMessage {
  nativeSeq: number;
  nativeMessageId: string;
  nativeBlockIndex: number;
  nativeMessage: NativeMessage;
  nativeProtected?: boolean;
  rawOpenaiContent?: unknown;
}

/** Flatten only for the kernel. Every native source, id, provider replay
 * field and media ref is carried on the original, and no tool arg is parsed
 * then reserialized. "#" is the kernel's documented shared-base delimiter. */
export function nativeToCore(nodes: NativeSurfaceNode[]): NativeCoreMessage[] {
  const toolNames = new Map<string, string>();
  for (const node of nodes) {
    if (!node || !Number.isSafeInteger(node.seq) || node.seq < 0 || typeof node.message?.id !== 'string'
        || !['system', 'developer', 'user', 'assistant', 'tool'].includes(node.message.role)
        || !Array.isArray(node.message.content) || node.message.content.some(block => !block || typeof block !== 'object')
        || !node.message.source || typeof node.message.source !== 'object') {
      throw new NexusError('CTX_NATIVE_MESSAGE_INVALID', 'DSH 原生消息或事件序号无效');
    }
    for (const block of node.message.content) {
    if (block.type === 'tool-call' && typeof block.id === 'string') toolNames.set(block.id, String(block.name ?? ''));
    }
  }
  const result: NativeCoreMessage[] = [];
  for (const node of nodes) {
    const message = node.message;
    if (!Number.isSafeInteger(node.seq) || node.seq < 0 || typeof message?.id !== 'string' || !Array.isArray(message.content)) {
      throw new NexusError('CTX_NATIVE_MESSAGE_INVALID', 'DSH 原生消息或事件序号无效');
    }
    const blocks = message.content.length ? message.content : [{ type: 'text', text: '' }];
    blocks.forEach((block, index) => {
      const opaque = !['text', 'reasoning', 'tool-call'].includes(String(block.type));
      const role: CoreMessage['role'] = message.role === 'developer' ? 'system' : message.role;
      const core: NativeCoreMessage = {
        id: `dsh:${message.id}#${index}`, role,
        contentType: block.type === 'tool-call' ? 'tool-call' : message.role === 'tool' ? 'tool-result' : block.type === 'reasoning' ? 'reasoning' : 'text',
        text: block.type === 'tool-call' ? String(block.arguments ?? '')
          : typeof block.text === 'string' ? block.text : `[DSH ${String(block.type)} retained as original attachment/block]`,
        nativeSeq: node.seq, nativeMessageId: message.id, nativeBlockIndex: index,
        nativeMessage: structuredClone(message),
        nativeProtected: message.role === 'developer' || message.role === 'system' || opaque,
      };
      if (block.type === 'tool-call') { core.toolName = String(block.name ?? ''); core.toolCallId = String(block.id ?? ''); }
      else if (message.role === 'tool') { core.toolCallId = message.toolCallId; core.toolName = toolNames.get(message.toolCallId ?? ''); }
      if (opaque) core.rawOpenaiContent = { type: 'file', nexusOriginalAvailable: true };
      if (node.summaryOfBlockId) core.summaryOfBlockId = node.summaryOfBlockId;
      result.push(core);
    });
  }
  return result;
}

/** Reconstructs an auxiliary request projection with native blocks unchanged
 * except text that the kernel deliberately rendered. Formal main history
 * mutations must use the official CompactionEngine transaction instead. */
export function coreToNative(messages: CoreMessage[]): (NativeMessage | JsonRecord)[] {
  const output: (NativeMessage | JsonRecord)[] = [];
  const positions = new Map<string, number>();
  for (const item of messages) {
    const core = item as Partial<NativeCoreMessage> & CoreMessage;
    if (core.nativeMessage && core.nativeMessageId !== undefined && core.nativeBlockIndex !== undefined) {
      let position = positions.get(core.nativeMessageId);
      if (position === undefined) {
        position = output.length; positions.set(core.nativeMessageId, position);
        output.push(structuredClone(core.nativeMessage));
      }
      const native = output[position] as NativeMessage;
      const original = native.content[core.nativeBlockIndex];
      if (original && (original.type === 'text' || original.type === 'reasoning') && typeof core.text === 'string') {
        native.content[core.nativeBlockIndex] = { ...original, text: core.text };
      }
      continue;
    }
    if (core.contentType === 'tool-call') throw new NexusError('CTX_NATIVE_SOURCE_MISSING', '结构化工具调用缺失原生来源，拒绝猜测协议');
    output.push({ role: core.role === 'system' ? 'user' : core.role, content: [{ type: 'text', text: core.text ?? '' }] });
  }
  return output;
}

export function nativeSpan(messages: CoreMessage[], effectiveIds: string[]) {
  const ids = new Set(effectiveIds);
  const selected = messages.filter(m => ids.has(m.id)) as NativeCoreMessage[];
  if (selected.length !== ids.size || selected.some(m => !Number.isSafeInteger(m.nativeSeq))) {
    throw new NexusError('CTX_NATIVE_SPAN_MISSING', '折叠来源不能映射到当前 DSH 表层');
  }
  const seqs = [...new Set(selected.map(m => m.nativeSeq))];
  const allSeqs = [...new Set((messages as NativeCoreMessage[]).map(m => m.nativeSeq))];
  const first = allSeqs.indexOf(seqs[0]);
  const last = allSeqs.indexOf(seqs.at(-1)!);
  if (first < 0 || last < first || allSeqs.slice(first, last + 1).some(seq => !seqs.includes(seq))) {
    throw new NexusError('CTX_NATIVE_PROTECTED_GAP', '正式事务不得跨过未选择或受保护的表层消息');
  }
  const allAtSeq = messages.filter(m => seqs.includes((m as NativeCoreMessage).nativeSeq));
  if (allAtSeq.some(m => !ids.has(m.id))) throw new NexusError('CTX_NATIVE_PARTIAL_MESSAGE', '正式宿主事务要求完整消息边界，不能只隐藏其中一块');
  // Sequence numbers are log positions, NOT current surface order. A prior
  // replacement can put seq 900 before seq 40; preserve the surface order.
  return { startSeq: seqs[0], endSeq: seqs.at(-1)!, sourceSeqs: seqs };
}
