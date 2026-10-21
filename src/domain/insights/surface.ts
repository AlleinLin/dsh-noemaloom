import { createHash } from 'node:crypto';

export interface AnalysisLine { seq: number; kind: string; text: string; isError?: boolean }
export interface AnalysisSurface { sessionId: string; throughSeq: number; status: string; lines: AnalysisLine[]; truncated: boolean }
const clean = (text: string) => text.replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
  .replace(/\b(?:sk|ghp|github_pat)[-_][A-Za-z0-9_-]{8,}/g, '[REDACTED]')
  .replace(/\b((?:api[_-]?key|password|secret|authorization)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]');
function blocks(value: any): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n') : '';
}
/** Only committed user/assistant text and operation names, never private reasoning
 * or complete tool arguments/results. A fixed prefix plus an incremental tail
 * keeps auxiliary prompts stable and bounds their cost. */
export function analysisSurface(sessionId: string, events: any[], status: string, sinceSeq = -1): AnalysisSurface {
  const lines: AnalysisLine[] = [];
  let bytes = 0, truncated = false;
  for (let index = events.length - 1; index >= 0; index--) {
    const e = events[index], seq = Number(e.seq);
    if (!Number.isSafeInteger(seq) || seq <= sinceSeq) continue;
    const d = e.data ?? {}, message = d.message ?? d;
    let text = '';
    if (e.type === 'user/message' && (!message.source || message.source.kind === 'user')) text = blocks(message.content);
    else if (e.type === 'assistant/message' && !d.interrupted) text = blocks(message.content);
    else if (e.type === 'tool/call') text = `操作：${d.name ?? d.toolName ?? d.tool ?? 'unknown'}`;
    else if (e.type === 'tool/result') text = `操作回执：${d.name ?? d.toolName ?? 'tool'} · ${message.isError === true || d.error ? '失败' : '已返回（验收状态未确认）'}`;
    else if (e.type === 'turn/end') text = `回合结束：${d.reason?.kind ?? 'unknown'}`;
    if (!text.trim()) continue;
    text = clean(text).slice(0, 2000);
    if (lines.length >= 60 || bytes + text.length > 16000) { truncated = true; break; }
    bytes += text.length;
    lines.push({ seq, kind: e.type, text,
      ...(e.type === 'tool/result' && typeof message.isError === 'boolean' ? { isError: message.isError } : {}),
    });
  }
  return { sessionId, throughSeq: events.reduce((max, e) => Math.max(max, Number(e.seq) || 0), -1), status, lines: lines.reverse(), truncated };
}
export const analysisHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
