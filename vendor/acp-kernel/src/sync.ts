import { baseIdOf, summaryMessageId } from "./prune.js";
import { indexedBlockFacts, indexedConsumed, indexedContains, indexedRuntime, inheritIndexedState } from "./indexed-runtime.js";
import type { CompressionState, CoreMessage } from "./types.js";

export interface SyncResult {
  state: CompressionState;
  deactivated: string[];
}

export function syncBlocks(
  messages: CoreMessage[],
  state: CompressionState,
): SyncResult {
  const runtime = indexedRuntime(state);
  const presentIds = new Set(messages.map((message) => message.id));
  const presentBases = new Set<string>();
  // Subid coverage only applies to messages that actually carry a string id.
  // Id-less host-shaped entries were silently digested by every release
  // before 0.0.90 (presentIds merely held undefined and no has() ever
  // matched); baseIdOf would throw on them and hard-crash processTurn (#421).
  for (const message of messages) {
    if (typeof message.id === "string") presentBases.add(baseIdOf(message.id));
  }
  const exactCandidates = runtime
    ? [...presentIds].filter((id) => typeof id === "string")
    : [];
  const baseCandidates = runtime ? [...presentBases] : [];
  const deactivated: string[] = [];
  // Deep-clone (not just `{...state}`) so the caller's input state is never
  // mutated: processTurn stamps `state.nudge.*` and reassigns `messageRefs`,
  // and block sub-arrays must not alias the input. Previously nudge/stats/
  // messageRefs were shared references → input-state mutation leak.
  const result: CompressionState = {
    ...(runtime ? state : {}),
    blocks: state.blocks.map((block) => ({
      ...block,
      directMessageIds: [...block.directMessageIds],
      effectiveMessageIds: [...block.effectiveMessageIds],
      directBlockIds: [...block.directBlockIds],
    })),
    messageRefs: {
      byRaw: { ...state.messageRefs.byRaw },
      byRef: { ...state.messageRefs.byRef },
    },
    // Snapshot is keyed by ref with primitive values — shallow copy suffices.
    tokenSnapshot: { ...(state.tokenSnapshot ?? {}) },
    nudge: {
      ...state.nudge, anchors: { ...state.nudge.anchors },
      ...(runtime ? { lastShownByTier: { ...state.nudge.lastShownByTier } } : {}),
    },
    stats: { ...state.stats },
    absorbed: (state.absorbed ?? []).map((record) => ({ ...record })),
    rules: (state.rules ?? []).map((rule) => ({ ...rule })),
    nextRuleId: state.nextRuleId,
    terminalStreak: state.terminalStreak,
    nextBlockId: state.nextBlockId,
    nextRunId: state.nextRunId,
    deadRefs: state.deadRefs ? [...state.deadRefs] : undefined,
    ...(runtime ? {
      lastPassIds: state.lastPassIds ? [...state.lastPassIds] : undefined,
      hiddenOrphanRefs: state.hiddenOrphanRefs ? [...state.hiddenOrphanRefs] : undefined,
    } : {}),
  };
  if (runtime) inheritIndexedState(state, result);

  // Refs are additive (assignRefs never removes them from messageRefs), so
  // prune the snapshot by currently-present message refs — otherwise it grows
  // unboundedly as messages are compressed/deleted across a long session.
  const liveRefs = new Set(
    messages
      .map((m) => result.messageRefs.byRaw[m.id])
      .filter((r): r is string => typeof r === "string"),
  );
  if (Object.keys(result.tokenSnapshot).length !== liveRefs.size) {
    const pruned: Record<string, number> = {};
    for (const [ref, n] of Object.entries(result.tokenSnapshot)) {
      if (liveRefs.has(ref)) pruned[ref] = n;
    }
    result.tokenSnapshot = pruned;
  }

  const consumedBlockIds = new Set<string>();
  if (!runtime) {
    for (const block of result.blocks) {
      for (const consumedId of block.directBlockIds) {
        consumedBlockIds.add(consumedId);
      }
    }
  }

  for (const block of result.blocks) {
    if (runtime ? indexedConsumed(result, block.blockId) : consumedBlockIds.has(block.blockId)) {
      block.active = false;
      continue;
    }
    // Host-set `expanded` = the user explicitly decompressed this block, so its
    // deactivated state is intentional. Re-activating it here would re-fold the
    // already-restored messages next turn (double cost + lost originals). Keep
    // it inactive; a fresh compress of the same range creates a NEW block.
    if (block.expanded) {
      block.active = false;
      continue;
    }
    block.active = true;
    // A block whose raw messages were replaced by its rendered summary
    // (pruned view) is still present — the summary IS the block's visible
    // representation. Without this, hosts passing pruned views would lose
    // block activity every turn.
    let stillPresent = presentIds.has(summaryMessageId(block.blockId));
    if (!stillPresent && runtime) {
      const facts = indexedBlockFacts(result, block.blockId);
      if (!facts) {
        throw Object.assign(new Error(`Missing indexed sync facts for ${block.blockId}`), { code: "ARCHIVE_FACT_MISSING" });
      }
      stillPresent = facts.effectiveCount > 0
        && (exactCandidates.some((id) =>
          indexedContains(result, block.blockId, "effective", id, "exact"))
          || baseCandidates.some((id) =>
            indexedContains(result, block.blockId, "effective", id, "base")));
    } else if (!stillPresent) {
      stillPresent = block.effectiveMessageIds.some((id) => presentBases.has(baseIdOf(id)));
    }
    if (!stillPresent) {
      block.active = false;
      deactivated.push(block.blockId);
    }
  }

  return { state: result, deactivated };
}
