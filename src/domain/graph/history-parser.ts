/**
 * Canonical read-only projections adapted from ThoughtDAG's Claude/Codex/Pi/
 * DSH session collectors. Keep tool observations separate from model claims;
 * discard hidden reasoning, retain complete JSONL records and native trees.
 */
import { NexusError } from '../../ports/contracts.js';
import { hash, sha256 } from '../../upstream/thoughtdag/graph.js';
import type { CanonicalSession, HistorySource, HistoryTurn, ObservedTool } from './types.js';

type Rec = Record<string, any>;
const obj = (value: unknown): Rec => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Rec : {};
const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(item => item && ['text', 'input_text', 'output_text'].includes(item.type)).map(item => item.text ?? '').join('\n');
};
const jsonArguments = (value: unknown): unknown => {
  if (typeof value !== 'string') return value ?? {};
  try { return JSON.parse(value); } catch { return { raw: value }; }
};

export function toolOperation(name: string): ObservedTool['op'] {
  if (/^(read|read_file|readfile|view|open|file_read)$/i.test(name) || /(?:^|[._])read(?:_|$)/i.test(name)) return 'read';
  if (/edit|patch|replace|update_file/i.test(name)) return 'edit';
  if (/write|create_file|save_file/i.test(name)) return 'write';
  if (/delete|remove_file|unlink/i.test(name)) return 'delete';
  if (/exec|shell|bash|terminal|command/i.test(name)) return 'run';
  return 'other';
}

export function toolArtifacts(name: string, argumentsValue: unknown): string[] {
  const args = obj(jsonArguments(argumentsValue));
  const result: string[] = [];
  for (const field of ['path', 'file_path', 'filePath', 'filename', 'url', 'uri', 'artifactId']) if (typeof args[field] === 'string') result.push(args[field]);
  for (const field of ['paths', 'files']) if (Array.isArray(args[field])) for (const path of args[field]) if (typeof path === 'string') result.push(path);
  const patch = typeof argumentsValue === 'string' ? argumentsValue : [args.patch, args.input, args.raw].find(value => typeof value === 'string');
  if (/patch/i.test(name) && patch) for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) result.push(match[1].trim());
  return [...new Set(result)];
}

export function parseHistory(source: HistorySource, externalId: string, input: string | unknown[], options: {
  projectRoot?: string; complete?: boolean; cursorBytes?: number;
  seed?: CanonicalSession;
} = {}): CanonicalSession {
  let records: Rec[] = [];
  const warnings: CanonicalSession['warnings'] = [];
  let cursor = 0;
  let byteLength = 0;
  if (typeof input === 'string') {
    byteLength = Buffer.byteLength(input);
    if (byteLength > 128 * 1024 * 1024) throw new NexusError('CTX-IMPORT-LIMIT', '单个历史来源不能超过 128 MiB');
    const trimmed = input.trim();
    if (trimmed.startsWith('[')) {
      try { const parsed = JSON.parse(trimmed); if (Array.isArray(parsed)) records = parsed.map(obj); else throw new Error(); cursor = byteLength; }
      catch { throw new NexusError('CTX-HISTORY-FORMAT', '历史 JSON 数组无法解析'); }
    } else {
      const lines = input.split('\n');
      const completeLines = input.endsWith('\n') || options.complete ? lines.length : lines.length - 1;
      let position = 0;
      for (let index = 0; index < completeLines; index++) {
        const line = lines[index];
        const lineBytes = Buffer.byteLength(line) + (index < lines.length - 1 ? 1 : 0);
        if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new NexusError('CTX-IMPORT-LIMIT', '历史记录单行超过 8 MiB');
        if (line.trim()) {
          try { records.push(obj(JSON.parse(line))); }
          catch { warnings.push({ line: index + 1, offset: position, message: '完整行 JSON 损坏，已隔离该行' }); }
        }
        position += lineBytes; cursor = position;
      }
      if (!input.endsWith('\n') && !options.complete) warnings.push({ offset: cursor, message: '最后一行未完成，等待下次完整追加' });
    }
  } else {
    if (!Array.isArray(input) || input.length > 1_000_000) throw new NexusError('CTX-IMPORT-LIMIT', '历史记录数组无效或超过上限');
    records = input.map(obj); byteLength = Buffer.byteLength(JSON.stringify(input)); cursor = byteLength;
  }
  let projectRoot = options.projectRoot ?? options.seed?.projectRoot ?? source.projectRoots[0] ?? '';
  let identity = options.seed?.externalId ?? externalId;
  let parentSessionId: string | undefined = options.seed?.parentSessionId?.replace(`${source.id}:`, '');
  let title = options.seed?.title ?? '';
  const seededTurns = structuredClone(options.seed?.turns ?? []);
  let current: HistoryTurn | undefined = seededTurns.pop();
  const turns: HistoryTurn[] = seededTurns;
  const pending = new Map<string, { turn: HistoryTurn; tool: ObservedTool }>();
  const itemOwner = new Map<string, string>();
  const parentItem = new Map<string, string>();
  const turnExplicitParents = new Map<string, string>();
  for (const turn of [...turns, ...(current ? [current] : [])]) {
    for (const item of turn.itemIds ?? [turn.id]) itemOwner.set(item, turn.id);
    for (const tool of turn.tools) pending.set(tool.callId, { turn, tool });
  }
  const start = (id?: string, parent?: string, timestamp?: string): HistoryTurn => {
    if (current) { current.complete = true; turns.push(current); }
    current = { id: id || `turn:${turns.length + 1}`, question: '', answer: '', materials: [], tools: [], timestamp, complete: false, contentHash: '' };
    if (parent) turnExplicitParents.set(current.id, parent);
    return current;
  };
  const ensure = (id?: string, timestamp?: string) => current ?? start(id, undefined, timestamp);
  const appendQuestion = (text: string, id?: string, parent?: string, timestamp?: string): void => {
    if (!text) return;
    const turn = !current || current.question || current.answer ? start(id, parent, timestamp) : current;
    turn.question += text;
    if (!title) title = text.replace(/\s+/g, ' ').slice(0, 120);
    if (id) { itemOwner.set(id, turn.id); turn.itemIds ??= []; if (!turn.itemIds.includes(id)) turn.itemIds.push(id); }
  };
  const call = (name: string, id: string, args: unknown, timestamp?: string): void => {
    const turn = ensure(undefined, timestamp);
    const previous = pending.get(id);
    if (previous) return;
    const parsed = jsonArguments(args);
    const tool: ObservedTool = { callId: id, name, arguments: parsed, op: toolOperation(name), artifacts: toolArtifacts(name, args) };
    turn.tools.push(tool); pending.set(id, { turn, tool });
  };
  const result = (id: string, output: unknown, failed = false): void => {
    const match = pending.get(id);
    const content = typeof output === 'string' ? output : Array.isArray(output) ? textOf(output) : JSON.stringify(output ?? null);
    if (match) {
      match.tool.result = content;
      // An attempted edit rejected by a tool is evidence of the attempt,
      // never an observed filesystem change.
      if (failed) { match.tool.op = 'other'; match.tool.artifacts = []; }
    }
    else ensure().tools.push({ callId: id, name: 'unknown', arguments: {}, result: content, op: 'other', artifacts: [] });
  };
  const message = (role: string, content: unknown, id?: string, parent?: string, timestamp?: string): void => {
    const blocks: Rec[] = Array.isArray(content) ? content : [];
    if (role === 'user') {
      const text = textOf(content);
      // Tool-result-only user envelopes are not human questions.
      if (text) appendQuestion(text, id, parent, timestamp);
      for (const block of blocks) if (block.type === 'tool_result') result(String(block.tool_use_id ?? ''), block.content, block.is_error === true);
    } else if (role === 'assistant') {
      const turn = ensure(undefined, timestamp), text = textOf(content);
      if (text) turn.answer += `${turn.answer ? '\n' : ''}${text}`;
      if (id) { itemOwner.set(id, turn.id); turn.itemIds ??= []; if (!turn.itemIds.includes(id)) turn.itemIds.push(id); }
      for (const block of blocks) {
        if (block.type === 'tool_use' || block.type === 'toolCall') call(String(block.name ?? 'unknown'), String(block.id ?? `call:${hash(block).slice(0, 16)}`), block.input ?? block.arguments, timestamp);
      }
    } else if (role === 'toolResult' || role === 'tool') result(id ?? '', content);
  };
  for (let index = 0; index < records.length; index++) {
    const row = records[index], payload = obj(row.payload), data = obj(row.data), msg = obj(row.message);
    const timestamp = typeof row.timestamp === 'string' ? row.timestamp : typeof row.time === 'number' ? new Date(row.time).toISOString() : undefined;
    const rowId = typeof row.id === 'string' ? row.id : typeof row.uuid === 'string' ? row.uuid : undefined;
    if (rowId && typeof (row.parentId ?? row.parentUuid) === 'string') parentItem.set(rowId, row.parentId ?? row.parentUuid);
    if (typeof row.cwd === 'string') projectRoot = row.cwd;
    if (typeof row.customTitle === 'string') title = row.customTitle;
    if (source.kind === 'canvas' && typeof row.question === 'string') {
      appendQuestion(row.question, String(row.id ?? `turn:${index}`), row.parentId, timestamp);
      ensure().answer = String(row.answer ?? row.response ?? '');
      if (Array.isArray(row.materials)) ensure().materials = row.materials.filter((item: unknown) => typeof item === 'string');
      if (Array.isArray(row.tools)) for (const tool of row.tools) { call(tool.name, tool.callId ?? `call:${hash(tool)}`, tool.arguments, timestamp); if (tool.result !== undefined) result(tool.callId, tool.result); }
      continue;
    }
    if (source.kind === 'memory') {
      const text = typeof row.text === 'string' ? row.text : typeof row.content === 'string' ? row.content : '';
      if (text) { appendQuestion(String(row.title ?? '只读外部记忆'), rowId, undefined, timestamp); ensure().answer = text; }
      continue;
    }
    if (source.kind === 'claude-code') {
      if (row.isSidechain === true && !row.agentId) continue;
      if (typeof row.sessionId === 'string') identity = typeof row.agentId === 'string' ? row.agentId : row.sessionId;
      if (row.type === 'summary' && typeof row.summary === 'string' && !title) title = row.summary;
      if (row.type === 'user' || row.type === 'assistant') message(msg.role ?? row.type, msg.content, rowId, row.parentUuid, timestamp);
      continue;
    }
    if (source.kind === 'codex') {
      if (row.type === 'session_meta') { identity = payload.id ?? identity; projectRoot = payload.cwd ?? projectRoot; parentSessionId = payload.parent_thread_id; continue; }
      if (row.type === 'turn_context' && current && payload.turn_id && current.id !== payload.turn_id) start(payload.turn_id, undefined, timestamp);
      if (row.type === 'response_item') {
        if (payload.type === 'message' && ['user', 'assistant'].includes(payload.role)) message(payload.role, payload.content, payload.id, undefined, timestamp);
        if (payload.type === 'function_call' || payload.type === 'custom_tool_call') call(payload.name ?? 'unknown', payload.call_id ?? rowId ?? `call:${index}`, payload.arguments ?? payload.input, timestamp);
        if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') result(payload.call_id ?? '', payload.output);
      } else if (row.type === 'event_msg' && payload.type === 'task_complete' && current) current.complete = true;
      continue;
    }
    if (source.kind === 'pi') {
      if (row.type === 'session') { identity = row.id ?? identity; projectRoot = row.cwd ?? projectRoot; continue; }
      if (row.type === 'message') {
        if (msg.role === 'toolResult') result(msg.toolCallId ?? '', msg.content);
        else message(msg.role, msg.content, rowId, row.parentId, timestamp);
      }
      continue;
    }
    // DSH durable events use message content on user input / assistant output.
    if (row.type === 'session/header' || row.type === 'header' || row.type === 'session') {
      identity = data.id ?? row.sessionId ?? row.id ?? identity;
      projectRoot = data.cwd ?? obj(data.meta).cwd ?? obj(row.meta).cwd ?? projectRoot;
      parentSessionId = data.parentSession ?? row.parentSession;
    } else if (row.type === 'session/title') title = data.title ?? title;
    else if (row.type === 'tool/call') call(data.name ?? 'unknown', String(data.callId ?? row.seq ?? index), data.arguments, timestamp);
    else if (row.type === 'tool/result') result(String(obj(obj(data.message).source).callId ?? data.callId ?? ''), obj(data.message).content ?? data.result, !!data.error);
    else if (row.type === 'tool/code-dispatch' || row.type === 'tool/ptc-dispatch') {
      const callId = String(data.subCallId ?? `nested:${index}`);
      call(String(data.name ?? 'unknown'), callId, data.arguments, timestamp);
      result(callId, data.content, data.isError === true);
    }
    else if (row.type === 'turn/end' || row.type === 'turn/complete' || row.type === 'agent/idle') {
      if (current) { current.complete = true; if (Number.isSafeInteger(row.seq)) current.endSeq = row.seq; }
    }
    else {
      const envelope = obj(data.message ?? row.message ?? data);
      const role = envelope.role ?? (/(?:user|input)/.test(row.type ?? '') ? 'user' : /(?:assistant|response)/.test(row.type ?? '') ? 'assistant' : undefined);
      if (role === 'user' && row.type === 'user/message') {
        const messageSource = obj(envelope.source);
        if (messageSource.kind && messageSource.kind !== 'user') continue;
      }
      if (role) {
        message(role, envelope.content ?? envelope.text ?? data.text, String(data.turn ?? row.seq ?? index), undefined, timestamp);
        if (role === 'user' && current && Number.isSafeInteger(row.seq)) current.startSeq = row.seq;
      }
    }
  }
  if (current) { if (options.complete) current.complete = true; turns.push(current); }
  const actual = turns.filter(turn => turn.question || turn.answer || turn.tools.length);
  for (const turn of actual) {
    let parent = turnExplicitParents.get(turn.id);
    const seen = new Set<string>();
    while (parent && !itemOwner.has(parent) && !seen.has(parent)) { seen.add(parent); parent = parentItem.get(parent); }
    if (parent && itemOwner.has(parent) && itemOwner.get(parent) !== turn.id) turn.parentTurnId = itemOwner.get(parent);
    turn.contentHash = hash({ question: turn.question, answer: turn.answer, materials: turn.materials, tools: turn.tools, parentTurnId: turn.parentTurnId });
  }
  const id = `${source.id}:${identity}`;
  return { schemaVersion: 1, id, externalId: identity, sourceId: source.id, agent: source.kind,
    title: title || `${source.kind} ${identity}`, projectRoot, parentSessionId: parentSessionId ? `${source.id}:${parentSessionId}` : undefined,
    revision: sha256(actual.map(turn => `${turn.id}:${turn.contentHash}`).join('\n')), parserVersion: 'thoughtdag-nexus-history-v1',
    turns: actual, warnings, cursor: options.cursorBytes ?? cursor, byteLength, importedAt: new Date().toISOString(),
    changed: true, available: true, hidden: false };
}
