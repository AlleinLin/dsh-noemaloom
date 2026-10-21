/** Wire vocabulary for read-only command observers. No execution lives here. */
export interface LiveCommand {
  id: string;
  source: 'native' | 'runtime';
  sessionId: string;
  callId?: string;
  rootCallId?: string;
  tool: string;
  label: string;
  state: string;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  detail?: string;
  outputAvailable?: boolean;
}
export interface CommandChunk {
  cursor: number;
  nextCursor: number;
  stream: 'stdout' | 'stderr' | 'log';
  text: string;
  lossy?: boolean;
}
export interface CommandOutputPage {
  id: string;
  chunks: CommandChunk[];
  nextCursor: number;
  lossy?: boolean;
  hasMore?: boolean;
  available?: boolean;
}
export interface CommandOutput {
  id: string;
  cursor: number;
  chunks: CommandChunk[];
  lossy: boolean;
}
export const emptyCommandOutput = (id: string): CommandOutput => ({ id, cursor: 0, chunks: [], lossy: false });
/** Repeated pages, late responses and reconnects must never duplicate output. */
export function appendCommandOutput(previous: CommandOutput, page: CommandOutputPage, maxChars = 262144): CommandOutput {
  if (previous.id !== page.id) return previous;
  let cursor = previous.cursor;
  let discontinuity = false;
  const additions: CommandChunk[] = [];
  for (const chunk of page.chunks) {
    if (chunk.nextCursor <= cursor) continue;
    if (chunk.cursor > cursor) discontinuity = true;
    if (chunk.cursor < cursor) {
      const bytes = new TextEncoder().encode(chunk.text);
      let start = cursor - chunk.cursor;
      while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) { start++; discontinuity = true; }
      additions.push({ ...chunk, cursor: chunk.cursor + start, text: new TextDecoder().decode(bytes.subarray(start)) });
    } else additions.push(chunk);
    cursor = chunk.nextCursor;
  }
  const chunks = [...previous.chunks, ...additions];
  let chars = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
  let lossy = previous.lossy || discontinuity || Boolean(page.lossy) || additions.some(chunk => chunk.lossy);
  while (chars > maxChars && chunks.length > 1) {
    chars -= chunks.shift()!.text.length;
    lossy = true;
  }
  if (chars > maxChars && chunks[0]) {
    chunks[0] = { ...chunks[0], text: chunks[0].text.slice(-maxChars) };
    lossy = true;
  }
  return { id: previous.id, cursor: Math.max(previous.cursor, page.nextCursor), chunks, lossy };
}
export function commandExitCode(detail?: string): number | undefined {
  const match = /(?:exit(?:\s+code)?|code)\s*[:=]\s*(-?\d+)/i.exec(detail ?? '');
  return match ? Number(match[1]) : undefined;
}
export function isCommandTool(name: string): boolean {
  return /^(?:bash|powershell|pwsh|shell|shell_command|exec_command|terminal_send)$/i.test(name);
}
