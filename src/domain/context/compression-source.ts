import { BLOCKED_REF, type Config, type CoreMessage } from '../../adapters/upstream/billion/index.js';
import type { NativeCoreMessage } from '../../adapters/upstream/billion/native.js';
import { canonicalJson } from './cache.js';

/** Only contiguous complete native messages with closed tool exchanges are
 * exposed to the auxiliary model. Keep the stable head and the recent tail.
 * Size the serialized data, not the much smaller rendered-text estimate:
 * native originals are deliberately not duplicated into this request. */
export function boundedCompressionSource(messages: CoreMessage[], refs: Record<string, string>, cfg: Config, windowTokens: number,
  boundaries: { starts?: number[]; ends?: number[] } = {}) {
  const budget = Math.max(0, Math.floor(windowTokens * 0.45) - 2048);
  const groups: NativeCoreMessage[][] = [];
  for (const message of messages as NativeCoreMessage[]) {
    if (groups.at(-1)?.[0]?.nativeSeq === message.nativeSeq) groups.at(-1)!.push(message);
    else groups.push([message]);
  }
  const view = (group: NativeCoreMessage[]) => group.map(message => ({
    ref: refs[message.id], role: message.role, contentType: message.contentType,
    text: message.text, ...(message.toolName ? { toolName: message.toolName } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
  }));
  const match = (name: string, pattern: string) => pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
  const safeStarts = boundaries.starts ? new Set(boundaries.starts) : undefined;
  const safeEnds = boundaries.ends ? new Set(boundaries.ends) : undefined;
  const orphanGroups = new Set<number>();
  let tail = groups.length, recentTokens = 0, recentMessages = 0;
  while (tail > 0 && (recentMessages < Math.max(2, cfg.preserveRecentMessages)
    || recentTokens < cfg.preserveRecentTokens)) {
    const group = groups[--tail]!;
    recentMessages += group.length;
    recentTokens += Math.ceil(group.reduce((n, item) => n + (item.text?.length ?? 0), 0) / 3);
  }
  // Never cut a tool exchange at the retained-tail boundary.
  const outstanding = new Set<string>();
  const balanced = new Set<number>([0]);
  for (let i = 0; i < groups.length; i++) {
    for (const message of groups[i]!) {
      if (message.contentType === 'tool-call') {
        if (!message.toolCallId || outstanding.has(message.toolCallId)) orphanGroups.add(i);
        else outstanding.add(message.toolCallId);
      }
      if (message.contentType === 'tool-result') {
        if (!message.toolCallId || !outstanding.delete(message.toolCallId)) orphanGroups.add(i);
      }
    }
    if (!outstanding.size) balanced.add(i + 1);
  }
  while (tail > 0 && !balanced.has(tail)) tail--;
  let start = 0;
  // A bounded unchanged initial prefix helps preserve a reusable cache anchor.
  let prefixTokens = 0;
  while (start < tail && (start === 0 || prefixTokens < Math.min(1024, windowTokens * 0.02))) {
    prefixTokens += Math.ceil(canonicalJson(view(groups[start]!)).length / 3); start++;
  }
  while (start < tail && (!balanced.has(start) || safeStarts && !safeStarts.has(groups[start]![0]!.nativeSeq))) start++;
  let selected: ReturnType<typeof view> = [], selectedStart = start;
  let lastBalanced: typeof selected = [];
  for (let i = start; i < tail; i++) {
    const group = groups[i]!;
    const protectedGroup = orphanGroups.has(i) || group.some(message => message.nativeProtected || !refs[message.id] || refs[message.id] === BLOCKED_REF
      || message.role === 'system' || (message.toolName && cfg.protectedTools.some(pattern => match(message.toolName!, pattern))));
    const next = [...selected, ...view(group)];
    if (protectedGroup || Buffer.byteLength(canonicalJson(next), 'utf8') > budget) {
      if (lastBalanced.length) break;
      selected = []; selectedStart = i + 1;
      while (selectedStart < tail && (!balanced.has(selectedStart) || safeStarts && !safeStarts.has(groups[selectedStart]![0]!.nativeSeq))) selectedStart++;
      continue;
    }
    if (i < selectedStart) continue;
    selected = next;
    if (balanced.has(i + 1) && (!safeEnds || safeEnds.has(group[0]!.nativeSeq))) lastBalanced = selected;
  }
  return { messages: lastBalanced, reason: lastBalanced.length ? undefined : 'no-safe-bounded-range',
    sourceBudgetTokens: budget, retainedRecentNativeMessages: groups.length - tail, stablePrefixNativeMessages: start };
}
