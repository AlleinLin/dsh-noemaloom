import type {
  AbsorbRecord,
  CompressionBlock,
  CompressionState,
  Config,
  CoreMessage,
  ProcessTurnResult,
} from "./types.js";
import type { MessageContentStore, StoredEntry } from "./content-store.js";
import type { RenderStrategy } from "./render-refs.js";

/** The archive and all facts used by one pure kernel invocation share this stamp. */
export interface IndexedArchiveStamp {
  sessionKey: string;
  headRevision: number;
  archiveRoot: string;
}
export type IndexedCoverageKind = "direct" | "effective" | "inherited";
export type IndexedIdMatch = "exact" | "base";
export type IndexedCarrierFate = "active" | "inactive" | "orphan";
export type IndexedBlockHeader = Omit<
  CompressionBlock,
  "directMessageIds" | "effectiveMessageIds" | "directBlockIds"
>;

/** Counts describe the complete immutable archive, never the current projection. */
export interface IndexedBlockFacts {
  header: IndexedBlockHeader;
  directCount: number;
  effectiveCount: number;
  childCount: number;
  /** Any committed consumer prevents automatic resurrection, even if inactive. */
  consumed: boolean;
  refSpan?: { startRef: string; endRef: string };
}

/**
 * Synchronous, immutable, per-call facts. The host resolves storage I/O BEFORE
 * calling the kernel. Functions must throw ARCHIVE_FACT_MISSING for an
 * unprepared lookup; an unavailable fact is never equivalent to false.
 *
 * Methods may inspect candidates or indexed pages already prepared for this
 * invocation. They must not scan the complete archive, perform hidden I/O, or
 * return a Promise. Every lookup is scoped by stamp.
 */
export interface IndexedArchiveFacts {
  readonly storageMode: "indexed-v1";
  readonly stamp: IndexedArchiveStamp;
  /** First never-issued numeric ref, persisted atomically with new aliases. */
  readonly nextRefIndex: number;
  /** Complete block count at invocation entry, including inactive history.
   *  Supplied by the archive; never inferred from the loaded projection. */
  readonly totalBlockCount: number;
  block(blockId: string): IndexedBlockFacts | undefined;
  contains(
    blockId: string,
    kind: IndexedCoverageKind,
    id: string,
    match: IndexedIdMatch,
  ): boolean;
  /** Number of exact raw members matching id; base aliases may have many parts. */
  coverageCount(blockId: string, kind: IndexedCoverageKind, id: string, match: IndexedIdMatch): number;
  intersect(
    blockId: string,
    kind: IndexedCoverageKind,
    candidates: readonly string[],
    match: IndexedIdMatch,
  ): string[];
  /** Membership at pipeline entry, BEFORE sync changes active flags. */
  inactiveClaim(baseId: string): boolean;
  /** Any historical block claims this base id; refs alone do not claim ids. */
  claimed(baseId: string): boolean;
  /**
   * First free positive h-root instance suffix at or above start. This query
   * uses a prepared exact gap index, not a loop through historical integers.
   * The kernel handles the bounded live/prior exclusions.
   */
  nextAvailableSuffix(root: string, start: number): number;
  /** Session-scoped existence, including consumed/expanded historical blocks. */
  knownBlock(blockId: string): boolean;
  /**
   * Candidate canonical ancestors, nearest first, for prepared block ids.
   * May include entry-inactive ancestors that sync revives this turn; callers
   * overlay current working headers and filter current activity.
   */
  activeAncestors(blockId: string): readonly string[];
  /** Fates are queried only for call ids / quoted ranges present this turn. */
  carrierFate(callId: string | undefined, rangeKeys: readonly string[], bareName: boolean): IndexedCarrierFate;
  /** Exact live ranges for this carrier; undefined preserves legacy no-range calls. */
  carrierLiveRanges(callId: string | undefined, rangeKeys: readonly string[], bareName: boolean): readonly string[] | undefined;
  /** Relevant immutable headers; the kernel overlays this turn's active changes. */
  carrierBlocks(callId: string | undefined, rangeKeys: readonly string[], bareName: boolean): readonly IndexedBlockFacts[];
  /** Only current input refs need be prepared; historical tombstones stay cold. */
  deadRef(ref: string): boolean;
  /**
   * Exact recorded-dead membership strictly inside a numeric ref interval.
   * Endpoints are current/prepared refs or newly allocated refs at/above
   * nextRefIndex. excluded contains exact initially loaded tombstone aliases
   * lifted by this invocation; other aliases of the same numeric ref remain.
   * Prepare bounded numeric successor witnesses; never
   * enumerate historical tombstones or compare raw m-ref keys lexically.
   */
  hasDeadRefBetween(lo: number, hi: number, excluded?: readonly string[]): boolean;
}

/**
 * Arrays and maps here contain ONLY the current turn's hydrated working set.
 * Historical coverage remains in archive roots. This value is not a durable
 * CompressionState snapshot and MUST NOT replace the archive in storage.
 */
export interface IndexedWorkingState extends CompressionState {
  readonly indexedProjection: "indexed-v1";
}

export interface IndexedProcessTurnInput {
  storageMode: "indexed-v1";
  workingState: IndexedWorkingState;
  archive: IndexedArchiveFacts;
  messages: CoreMessage[];
  config: Config;
  tokenCount: number;
  renderTags?: RenderStrategy;
  contentStore?: MessageContentStore;
  applyView?: CoreMessage[];
}

/** An immutable full-coverage recipe; child roots are shared, never flattened. */
export interface IndexedCoverageRecipe {
  directMessageIds: string[];
  /** Surviving current-range raw ids precede child coverage in Set order. */
  orderedPrefixMessageIds?: string[];
  /** Current raw members owned by a non-consumed block; these are not direct. */
  additionalEffectiveMessageIds?: string[];
  childBlockIds: string[];
  /** Exact raw holes withdrawn by the shared integrity gate; never base ranges. */
  excludedMessageIds?: string[];
}
export interface IndexedBlockDelta {
  header: IndexedBlockHeader;
  /** Present only for a newly allocated block; existing roots stay unchanged. */
  coverage?: IndexedCoverageRecipe;
}
export type IndexedHeadState = Omit<
  CompressionState,
  "blocks" | "messageRefs" | "tokenSnapshot" | "absorbed" | "deadRefs"
>;
export interface IndexedStateDelta {
  stamp: IndexedArchiveStamp;
  head: IndexedHeadState;
  nextRefIndex: number;
  refs: { byRaw: Record<string, string>; byRef: Record<string, string> };
  /**
   * Process-turn only: active headers in blocks are the complete new active
   * set, including unchanged candidates. Omitted means patch changed ids.
   */
  replaceActiveSet?: boolean;
  blocks: IndexedBlockDelta[];
  tokenSnapshot: Record<string, number>;
  deadRefs: { add: string[]; lift: string[] };
  absorbed: AbsorbRecord[];
  contentEntries: Record<string, StoredEntry>;
  contents: Record<string, string>;
}
export interface IndexedProcessTurnResult extends Omit<ProcessTurnResult, "state" | "contentStore"> {
  storageMode: "indexed-v1";
  workingState: IndexedWorkingState;
  contentStore: MessageContentStore;
  /** Exact post-reconciliation ids, aligned with input messages before pruning. */
  reconciledMessageIds: string[];
  delta: IndexedStateDelta;
}

export interface IndexedApplyCompressionInput {
  storageMode: "indexed-v1";
  workingState: IndexedWorkingState;
  archive: IndexedArchiveFacts;
  ranges: {
    startRef: string;
    endRef: string;
    summary: string;
    topic?: string;
    compressCallId?: string;
    summaryMaxChars?: number;
  }[];
  messages: CoreMessage[];
  config: Config;
  protectedMessageIds?: Set<string>;
  contentStore?: MessageContentStore;
}
export interface IndexedApplyCompressionResult {
  storageMode: "indexed-v1";
  workingState: IndexedWorkingState;
  delta: IndexedStateDelta;
  result: import("./types.js").ApplyCompressionResult["result"];
}
