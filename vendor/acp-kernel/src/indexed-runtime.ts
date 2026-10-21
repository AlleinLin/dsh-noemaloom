import type { CompressionBlock, CompressionState } from "./types.js";
import type { MessageContentStore } from "./content-store.js";
import { refToIndex, orderedRefPair } from "./refs.js";
import { createContentStore } from "./content-store.js";
import type {
  IndexedArchiveFacts, IndexedBlockFacts, IndexedCoverageKind,
  IndexedCoverageRecipe, IndexedIdMatch, IndexedStateDelta, IndexedWorkingState,
} from "./indexed-types.js";

export interface IndexedRuntime {
  archive: IndexedArchiveFacts;
  nextRefIndex: number;
  recipes: Map<string, IndexedCoverageRecipe>;
  initial: IndexedWorkingState;
  initialContent: MessageContentStore;
  reconciledMessageIds?: string[];
  /** Gap-index certified ids allocated locally; no historical block owns them. */
  unclaimedBases: Set<string>;
}
const runtimes = new WeakMap<CompressionState, IndexedRuntime>();
const base = (id: string) => { const at = id.indexOf("#"); return at > 0 ? id.slice(0, at) : id; };
/** Storage failures must abort rather than turn into ordinary range rejection. */
export function rethrowArchiveFailure(error: unknown): void {
  if (typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" && error.code.startsWith("ARCHIVE_")) throw error;
}
export function indexedRuntime(state: CompressionState): IndexedRuntime | undefined {
  const runtime = runtimes.get(state);
  if (!runtime && "indexedProjection" in state) {
    throw Object.assign(new Error("Indexed working projection has no bound archive facts"), { code: "ARCHIVE_PROJECTION_MISUSE" });
  }
  return runtime;
}
export function bindIndexedState<T extends CompressionState>(state: T, runtime: IndexedRuntime): T {
  runtimes.set(state, runtime);
  return state;
}
export function inheritIndexedState<T extends CompressionState>(from: CompressionState, to: T): T {
  const runtime = indexedRuntime(from);
  if (runtime) bindIndexedState(to, runtime);
  return to;
}
export function createIndexedRuntime(
  state: IndexedWorkingState,
  archive: IndexedArchiveFacts,
  contentStore: MessageContentStore,
): IndexedRuntime {
  const projectedBlockCount = new Set(state.blocks.map(block => block.blockId)).size;
  if (state.indexedProjection !== "indexed-v1" || archive.storageMode !== "indexed-v1"
      || !archive.stamp.sessionKey || !archive.stamp.archiveRoot
      || !Number.isSafeInteger(archive.stamp.headRevision) || archive.stamp.headRevision < 0
      || !Number.isSafeInteger(archive.nextRefIndex) || archive.nextRefIndex < 1
      || !Number.isSafeInteger(archive.totalBlockCount) || archive.totalBlockCount < 0
      || archive.totalBlockCount < projectedBlockCount) {
    throw Object.assign(new Error("Invalid indexed archive stamp/counter/block count"), { code: "ARCHIVE_FACT_INVALID" });
  }
  for (const ref of Object.values(state.messageRefs.byRaw)) {
    const index = refToIndex(ref);
    if (index !== null && index >= archive.nextRefIndex) {
      throw Object.assign(new Error("Indexed ref counter would reissue a permanent alias"), { code: "ARCHIVE_FACT_INVALID" });
    }
  }
  const runtime: IndexedRuntime = {
    archive, nextRefIndex: archive.nextRefIndex, recipes: new Map(), unclaimedBases: new Set(),
    initial: structuredClone(state), initialContent: structuredClone(contentStore),
  };
  bindIndexedState(state, runtime);
  return runtime;
}
/** Bind an already-hydrated projection for standalone pure view helpers. */
export function bindIndexedArchive(
  state: IndexedWorkingState, archive: IndexedArchiveFacts,
  contentStore: MessageContentStore = createContentStore(),
): IndexedWorkingState {
  createIndexedRuntime(state, archive, contentStore);
  return state;
}
export function indexedBlockFacts(state: CompressionState, blockId: string): IndexedBlockFacts | undefined {
  const runtime = indexedRuntime(state);
  const block = state.blocks.find(b => b.blockId === blockId);
  const recipe = runtime?.recipes.get(blockId);
  if (recipe && block) {
    if (recipe.childBlockIds.length === 0) {
      const { directMessageIds: _d, effectiveMessageIds: _e, directBlockIds: _c, ...header } = block;
      const excluded = new Set(recipe.excludedMessageIds ?? []);
      const effective = [...new Set([...recipe.directMessageIds, ...recipe.additionalEffectiveMessageIds ?? []])]
        .filter(id => !excluded.has(id));
      const refs = effective.map(id => state.messageRefs.byRaw[id])
        .filter((ref): ref is string => typeof ref === "string" && refToIndex(ref) !== null)
        .sort((a, b) => refToIndex(a)! - refToIndex(b)!);
      const ownSpan = block.startRef && block.endRef
        && refToIndex(block.startRef) !== null && refToIndex(block.endRef) !== null
        ? orderedRefPair(block.startRef, block.endRef) : undefined;
      return { header, directCount: recipe.directMessageIds.length, effectiveCount: effective.length,
        childCount: 0, consumed: indexedConsumed(state, blockId),
        ...(ownSpan ? { refSpan: { startRef: ownSpan[0], endRef: ownSpan[1] } }
          : refs.length ? { refSpan: { startRef: refs[0]!, endRef: refs[refs.length - 1]! } } : {}) };
    }
    // Exact cardinality and effective min/max require the archive's persistent
    // union operation. Child counts/spans cannot be added: roots may overlap,
    // and an integrity hole may withdraw either endpoint. Commit the recipe and
    // prepare fresh facts before requesting this block's complete metadata.
    throw Object.assign(new Error(`Commit indexed recipe ${blockId} before requesting complete block facts`),
      { code: "ARCHIVE_RECIPE_UNCOMMITTED" });
  }
  if (runtime) {
    const facts = runtime.archive.block(blockId);
    if (!facts && block) throw Object.assign(new Error(`Missing block facts ${blockId}`), { code: "ARCHIVE_FACT_MISSING" });
    return facts;
  }
  if (!block) return undefined;
  const { directMessageIds, effectiveMessageIds, directBlockIds, ...header } = block;
  return { header, directCount: directMessageIds.length, effectiveCount: effectiveMessageIds.length,
    childCount: directBlockIds.length, consumed: state.blocks.some(b => b.directBlockIds.includes(blockId)) };
}
export function indexedContains(
  state: CompressionState, blockId: string, kind: IndexedCoverageKind,
  id: string, match: IndexedIdMatch,
): boolean {
  const runtime = indexedRuntime(state);
  const recipe = runtime?.recipes.get(blockId);
  if (recipe) {
    const equals = (candidate: string) => (match === "base" ? base(candidate) === base(id) : candidate === id);
    if (kind === "direct") return recipe.directMessageIds.some(equals);
    if (kind === "inherited") return recipe.childBlockIds.some(child =>
      indexedContains(state, child, "effective", id, match));
    return indexedEffectiveContains(state, blockId, id, match, new Set());
  }
  if (runtime?.unclaimedBases.has(base(id))) return false;
  if (runtime) return runtime.archive.contains(blockId, kind, id, match);
  const block = state.blocks.find(b => b.blockId === blockId);
  if (!block) return false;
  const equals = (candidate: string) => (match === "base" ? base(candidate) === base(id) : candidate === id);
  if (kind === "direct") return block.directMessageIds.some(equals);
  if (kind === "effective") return block.effectiveMessageIds.some(equals);
  return block.directBlockIds.some(child => indexedContains(state, child, "effective", id, match));
}
/** OR across roots preserves union membership even when child roots overlap. */
function indexedEffectiveContains(
  state: CompressionState, blockId: string, id: string, match: IndexedIdMatch,
  inheritedExclusions: ReadonlySet<string>,
): boolean {
  const runtime = indexedRuntime(state)!;
  const recipe = runtime.recipes.get(blockId);
  const equals = (candidate: string) => match === "base" ? base(candidate) === base(id) : candidate === id;
  if (recipe) {
    const excluded = new Set([...inheritedExclusions, ...recipe.excludedMessageIds ?? []]);
    if (match === "exact" && excluded.has(id)) return false;
    if ([...recipe.directMessageIds, ...recipe.additionalEffectiveMessageIds ?? []]
      .some(candidate => equals(candidate) && !excluded.has(candidate))) return true;
    return recipe.childBlockIds.some(child => indexedEffectiveContains(state, child, id, match, excluded));
  }
  if (runtime.unclaimedBases.has(base(id))) return false;
  if (!runtime.archive.contains(blockId, "effective", id, match)) return false;
  if (match === "exact") return !inheritedExclusions.has(id);
  const removed = [...inheritedExclusions].filter(candidate => equals(candidate)
    && runtime.archive.contains(blockId, "effective", candidate, "exact")).length;
  return removed === 0 || runtime.archive.coverageCount(blockId, "effective", id, "base") > removed;
}
export function indexedCoverageCount(
  state: CompressionState, blockId: string, kind: IndexedCoverageKind,
  id: string, match: IndexedIdMatch,
): number {
  const runtime = indexedRuntime(state);
  const recipe = runtime?.recipes.get(blockId);
  const equals = (candidate: string) => match === "base" ? base(candidate) === base(id) : candidate === id;
  if (recipe) {
    if (kind === "direct") return new Set(recipe.directMessageIds.filter(equals)).size;
    if (match === "exact") return indexedContains(state, blockId, kind, id, match) ? 1 : 0;
    if (recipe.childBlockIds.length === 0) {
      if (kind === "inherited") return 0;
      const excluded = new Set(recipe.excludedMessageIds ?? []);
      return new Set([...recipe.directMessageIds, ...recipe.additionalEffectiveMessageIds ?? []]
        .filter(candidate => equals(candidate) && !excluded.has(candidate))).size;
    }
    throw Object.assign(new Error(`Commit indexed recipe ${blockId} before requesting a union count`),
      { code: "ARCHIVE_RECIPE_UNCOMMITTED" });
  }
  if (runtime?.unclaimedBases.has(base(id))) return 0;
  if (runtime) return runtime.archive.coverageCount(blockId, kind, id, match);
  const block = state.blocks.find(candidate => candidate.blockId === blockId);
  if (!block) return 0;
  const members = kind === "direct" ? block.directMessageIds : kind === "effective"
    ? block.effectiveMessageIds : [...new Set(block.directBlockIds.flatMap(child =>
      state.blocks.find(candidate => candidate.blockId === child)?.effectiveMessageIds ?? []))];
  return members.filter(equals).length;
}
export function indexedIntersect(
  state: CompressionState, blockId: string, kind: IndexedCoverageKind,
  candidates: readonly string[], match: IndexedIdMatch,
): string[] {
  const runtime = indexedRuntime(state);
  if (runtime && !runtime.recipes.has(blockId)) return runtime.archive.intersect(blockId, kind,
    candidates.filter(id => !runtime.unclaimedBases.has(base(id))), match);
  return candidates.filter(id => indexedContains(state, blockId, kind, id, match));
}
export function indexedDirectCount(state: CompressionState, block: CompressionBlock): number {
  const runtime = indexedRuntime(state);
  return runtime?.recipes.has(block.blockId) ? runtime.recipes.get(block.blockId)!.directMessageIds.length
    : runtime ? indexedBlockFacts(state, block.blockId)!.directCount : block.directMessageIds.length;
}
export function indexedConsumed(state: CompressionState, blockId: string): boolean {
  const runtime = indexedRuntime(state);
  if (!runtime) return state.blocks.some(block => block.directBlockIds.includes(blockId));
  if ([...runtime.recipes.values()].some(recipe => recipe.childBlockIds.includes(blockId))) return true;
  if (runtime.recipes.has(blockId)) return false;
  const facts = runtime.archive.block(blockId);
  if (!facts) throw Object.assign(new Error(`Missing block facts ${blockId}`), { code: "ARCHIVE_FACT_MISSING" });
  return facts.consumed;
}
/** Overlay new canonical parents without querying unprepared newly minted ids. */
export function indexedActiveAncestorIds(state: CompressionState, blockId: string): string[] {
  const runtime = indexedRuntime(state);
  if (!runtime) throw Object.assign(new Error("Indexed ancestor lookup requires archive facts"), { code: "ARCHIVE_FACT_MISSING" });
  const archived = runtime.recipes.has(blockId) ? [] : runtime.archive.activeAncestors(blockId);
  const seen = new Set(archived);
  const out = [...archived].filter(id => state.blocks.find(block => block.blockId === id)?.active
    ?? runtime.archive.block(id)?.header.active);
  // Entry-active ancestors may have been consumed locally, so retain them in
  // the traversal frontier even when their current active flag is now false.
  let frontier = new Set([blockId, ...archived]);
  for (let pass = 0; pass < runtime.recipes.size; pass++) {
    const next = new Set<string>();
    for (const [id, recipe] of runtime.recipes) {
      if (seen.has(id) || !recipe.childBlockIds.some(child => frontier.has(child))) continue;
      seen.add(id); next.add(id);
      if (state.blocks.find(block => block.blockId === id)?.active) out.push(id);
    }
    if (!next.size) break;
    frontier = next;
  }
  return out;
}
export function recordIndexedBlock(
  state: CompressionState, block: CompressionBlock, exclusions: string[] = [],
  orderedPrefixMessageIds?: string[],
): void {
  const runtime = indexedRuntime(state);
  if (!runtime) return;
  const direct = new Set(block.directMessageIds);
  const additional = block.effectiveMessageIds.filter(id => !direct.has(id)
    && !block.directBlockIds.some(child => indexedContains(state, child, "effective", id, "exact")));
  runtime.recipes.set(block.blockId, {
    directMessageIds: [...block.directMessageIds], childBlockIds: [...block.directBlockIds],
    ...(orderedPrefixMessageIds ? { orderedPrefixMessageIds: [...orderedPrefixMessageIds] } : {}),
    ...(additional.length ? { additionalEffectiveMessageIds: additional } : {}),
    ...(exclusions.length ? { excludedMessageIds: [...exclusions] } : {}),
  });
}
const changedEntries = <T>(before: Record<string, T>, after: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(after).filter(([key, value]) => JSON.stringify(before[key]) !== JSON.stringify(value)));
export function finishIndexedState(
  runtime: IndexedRuntime, state: CompressionState, contentStore: MessageContentStore,
  replaceActiveSet: boolean = false,
): { workingState: IndexedWorkingState; delta: IndexedStateDelta } {
  const before = runtime.initial;
  const initialBlocks = new Map(before.blocks.map(block => [block.blockId, block]));
  const header = (block: CompressionBlock) => {
    const { directMessageIds: _d, effectiveMessageIds: _e, directBlockIds: _c, ...value } = block;
    return value;
  };
  const blocks = state.blocks.filter(block => (replaceActiveSet && block.active)
    || !initialBlocks.has(block.blockId)
    || JSON.stringify(header(initialBlocks.get(block.blockId)!)) !== JSON.stringify(header(block)))
    .map(block => ({ header: header(block), ...(runtime.recipes.has(block.blockId)
      ? { coverage: runtime.recipes.get(block.blockId)! } : {}) }));
  const previousDead = new Set(before.deadRefs ?? []);
  const currentDead = new Set(state.deadRefs ?? []);
  // deadRefs is a current-ref projection, so only explicit loaded tombstones lift.
  const previousAbsorbed = new Set((before.absorbed ?? []).map(record => JSON.stringify(record)));
  const { blocks: _b, messageRefs: _m, tokenSnapshot: _t, absorbed: _a, deadRefs: _d, ...rawHead } = state;
  const { indexedProjection: _projection, ...head } = rawHead as typeof rawHead & { indexedProjection?: string };
  const workingState = inheritIndexedState(state, { ...state, indexedProjection: "indexed-v1" as const });
  return { workingState, delta: {
    stamp: { ...runtime.archive.stamp }, head, nextRefIndex: runtime.nextRefIndex,
    refs: { byRaw: changedEntries(before.messageRefs.byRaw, state.messageRefs.byRaw),
      byRef: changedEntries(before.messageRefs.byRef, state.messageRefs.byRef) },
    ...(replaceActiveSet ? { replaceActiveSet: true } : {}),
    blocks, tokenSnapshot: changedEntries(before.tokenSnapshot, state.tokenSnapshot),
    deadRefs: { add: [...currentDead].filter(ref => !previousDead.has(ref)),
      lift: [...previousDead].filter(ref => !currentDead.has(ref)) },
    absorbed: (state.absorbed ?? []).filter(record => !previousAbsorbed.has(JSON.stringify(record))),
    contentEntries: changedEntries(runtime.initialContent.byRef, contentStore.byRef),
    contents: changedEntries(runtime.initialContent.byHash, contentStore.byHash),
  } };
}
