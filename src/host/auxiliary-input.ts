import type { ModelRequest } from '../ports/contracts.js';
import type { NativeMessage } from '../adapters/upstream/billion/native.js';
import { NEXUS_SOURCE } from './source.js';

type TextRequest = Pick<ModelRequest, 'system' | 'prompt' | 'messages' | 'logicalCallId'>;
const DEFAULT_CALL_ID = `call_${'0'.repeat(36)}`;
export const SUMMARY_ENVELOPE_HEADROOM = 1024;
export const SUMMARY_PREPARATION_HEADROOM = 3072;

/** Use the same message envelope for selection and the actual host request. */
export function auxiliaryInputMessages(request: TextRequest, logicalCallId = request.logicalCallId ?? DEFAULT_CALL_ID): NativeMessage[] {
  const messages = request.messages ?? [{ role: 'user' as const, content: request.prompt }];
  return [
    ...(request.system ? [{ id: `aux_${logicalCallId}_system`, role: 'system' as const,
      content: [{ type: 'text', text: request.system }], source: { kind: 'system-prompt' } }] : []),
    ...messages.map((message, index) => ({
      id: `aux_${logicalCallId}_${index}`, role: message.role,
      content: [{ type: 'text', text: message.content }],
      source: message.role === 'system' ? { kind: 'system-prompt' }
        : message.role === 'assistant' ? { kind: 'model', provider: 'nexus-composed-context', model: 'authored-assistant-context' }
        : { kind: NEXUS_SOURCE, meta: { purpose: 'auxiliary-model-input' } },
    })),
  ];
}

export function summaryEnvelopeBudget(envelope: { system?: string; messages: unknown[]; tools?: unknown[] },
  windowTokens: number, outputReserveTokens: number, preparationHeadroom = 0) {
  const inputUpperEstimate = Buffer.byteLength(JSON.stringify({
    system: envelope.system ?? '', messages: envelope.messages, tools: envelope.tools ?? [],
  }), 'utf8');
  return {
    inputUpperEstimate, outputReserveTokens, windowTokens,
    headroomTokens: SUMMARY_ENVELOPE_HEADROOM + preparationHeadroom,
    fits: inputUpperEstimate + outputReserveTokens + SUMMARY_ENVELOPE_HEADROOM + preparationHeadroom < windowTokens,
  };
}

export function summaryRequestBudget(request: TextRequest, windowTokens: number, outputReserveTokens: number) {
  return summaryEnvelopeBudget({ messages: auxiliaryInputMessages(request) },
    windowTokens, outputReserveTokens, SUMMARY_PREPARATION_HEADROOM);
}
