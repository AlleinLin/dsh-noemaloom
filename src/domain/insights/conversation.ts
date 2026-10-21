import { analysisHash } from './surface.js';
import { SECRET_KEY, redactString } from '../operations/index.js';
import { canonicalJson, sha256 } from '../storage/index.js';
import { THOROUGH_PROMPT } from './prompts.js';
import { isHumanInputMessage } from '../../shared/step-pause.js';

export interface ConversationPacket { sessionId: string; parentId?: string; status: string; events: any[] }
export interface ConversationCoverage {
  sessions: Array<{ sessionId: string; parentId?: string; status: string; events: number; throughSeq: number }>;
  unavailable: Array<{ sessionId: string; reason: string }>;
  chars: number; eventCount: number; complete: boolean; boundary: string;
}
export interface ConversationSurface { chunks: string[]; hash: string; taskKey: string; coverage: ConversationCoverage; rootThroughSeq: number }
export const CONTEXT_BOUNDARY = '全部可访问的本会话及同工作区原生subagent后代事件，含正文、工具调用参数/结果、生命周期及附件引用。已组装助手正文保留一次，省略其重复原始stream。排除私有思考、供应商不透明replay状态、凭据、二进制附件内容和未被宿主持久化的数据；不读取fork/其他工作区/磁盘文件。超过总预算或无法读取的会话会明确标记，不能声称完整。';
function scrub(value: any, omitted: { depth: boolean }, depth = 0): any {
  if (depth > 32) { omitted.depth = true; return '[nested-data-depth-limit]'; }
  if (typeof value === 'string') return redactString(value, Infinity);
  if (!value || typeof value !== 'object') return value;
  if (/^(?:reasoning|thinking|redacted_thinking)(?:[-_](?:delta|chunks))?$/.test(value.type ?? '')) return { type: value.type, omitted: 'private-reasoning' };
  if (Array.isArray(value)) return value.map(v => scrub(v, omitted, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
    k === 'replayState' ? '[omitted-provider-replay]'
      : SECRET_KEY.test(k) || /^(?:dataBase64|base64|bytes)$/i.test(k) ? '[REDACTED]' : scrub(v, omitted, depth + 1)]));
}
function projectEvent(event: any) {
  // The formal assistant/message stores its assembled body and exact raw
  // stream together. Attempt-only streams have no body and remain included.
  if (event.type !== 'assistant/message' || !Array.isArray(event.data?.message?.content) || !Array.isArray(event.data?.stream)) return event;
  return { ...event, data: { ...event.data, stream: { omitted: 'duplicate-stream', records: event.data.stream.length } } };
}
/** Walk forward so unchanged chunk prefixes keep the same bytes and cache key.
 * A long single tool event is split, never silently clipped to its last lines. */
export function conversationSurface(root: string, packets: ConversationPacket[], unavailable: ConversationCoverage['unavailable'],
  maxChars: number, chunkChars: number, maxChunks: number): ConversationSurface {
  const chunks: string[] = [], sessions: ConversationCoverage['sessions'] = [];
  let chars = 0, eventCount = 0, current = '', overflow = false, rootThroughSeq = -1;
  const inaccessible = [...unavailable];
  let latestUser: any;
  for (const packet of packets) {
    if (current) { chunks.push(current); current = ''; }
    const throughSeq = packet.events.reduce((max, e) => Math.max(max, Number.isSafeInteger(e.seq) ? e.seq : -1), -1);
    sessions.push({ sessionId: packet.sessionId, parentId: packet.parentId, status: packet.status, events: packet.events.length, throughSeq });
    if (packet.sessionId === root) rootThroughSeq = throughSeq;
    for (const event of packet.events) {
      eventCount++;
      const message = event.data?.message ?? event.data;
      if (packet.sessionId === root && event.type === 'user/message' && isHumanInputMessage(message)) {
        const humanText = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
          ? message.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n') : '';
        if (humanText !== THOROUGH_PROMPT) latestUser = message;
      }
      const omitted = { depth: false };
      const line = JSON.stringify({ sessionId: packet.sessionId, parentId: packet.parentId, ...scrub(projectEvent(event), omitted) }) + '\n';
      if (omitted.depth) inaccessible.push({ sessionId: packet.sessionId, reason: `事件#${event.seq}的嵌套深度超过32层，无法完整展开` });
      chars += line.length;
      if (chars > maxChars) { overflow = true; continue; }
      let offset = 0;
      while (offset < line.length) {
        const remaining = chunkChars - current.length;
        current += line.slice(offset, offset + remaining); offset += remaining;
        if (current.length >= chunkChars) { chunks.push(current); current = ''; }
      }
    }
  }
  if (current) chunks.push(current);
  if (chunks.length > maxChunks) overflow = true;
  const coverage = { sessions, unavailable: inaccessible, chars, eventCount, complete: !overflow && !inaccessible.length, boundary: CONTEXT_BOUNDARY };
  return { chunks: overflow ? [] : chunks, hash: analysisHash({ chunks, unavailable: inaccessible }),
    // Dispatcher admission clones sort object keys; durable native messages
    // retain their original order. Both representations identify one task.
    taskKey: sha256(canonicalJson(latestUser ? { id: latestUser.id, content: latestUser.content } : { root, first: packets[0]?.events[0] })),
    coverage, rootThroughSeq };
}
