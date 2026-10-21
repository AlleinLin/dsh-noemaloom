import type { CompressionBlock, CompressionState, CoreMessage } from '../../../vendor/acp-kernel/src/index.js';
import type { StoredEntry } from '../../../vendor/acp-kernel/src/content-store.js';
import type { IndexedArchiveFacts, IndexedStateDelta } from '../../../vendor/acp-kernel/src/indexed-types.js';
import { NexusError, type StoredRecord } from '../../ports/contracts.js';
import type { ContextSession, OriginalRef } from './types.js';
import type { ArchiveIndexRoot } from './archive-pages.js';

export type { ArchiveIndexRoot } from './archive-pages.js';

/** Match the kernel's tombstone parser, including case and numeric aliases. */
export function deadRefNumber(ref: string): number | null {
  const match = /^m(\d+)$/i.exec(ref);
  return match ? Number(match[1]) : null;
}

/** Positive IEEE754 bytes preserve numeric order, including zero and Infinity. */
export function deadRefOrderKey(value: number): string {
  if (value < 0 || !(Number.isInteger(value) || value === Infinity)) {
    throw new NexusError('CTX_ARCHIVE_CORRUPT', '无效的归档死引用数值');
  }
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeDoubleBE(value === 0 ? 0 : value);
  return bytes.toString('hex');
}

export function deadRefOrderNumber(key: string): number {
  if (!/^[0-9a-f]{16}$/.test(key)) throw new NexusError('CTX_ARCHIVE_CORRUPT', '无效的归档死引用排序键');
  const value = Buffer.from(key, 'hex').readDoubleBE();
  if (deadRefOrderKey(value) !== key) throw new NexusError('CTX_ARCHIVE_CORRUPT', '无效的归档死引用排序键');
  return value;
}

export interface ArchiveClaim {
  firstBlockId: string;
  /** Diagnostic only; exact current activity is read through witnesses. */
  permanentInactive?: boolean;
  inactiveWitnesses?: ArchiveIndexRoot;
}

/** Fixed-size node in a block's balanced immediate-child selector index. */
export interface ArchiveChildSelector {
  bases?: ArchiveIndexRoot;
  childId?: string;
  left?: string;
  right?: string;
}

/** All historical cardinality lives behind these fixed-size root pointers. */
export interface ArchiveRoots {
  originals?: ArchiveIndexRoot;
  versions?: ArchiveIndexRoot;
  sourceIds?: ArchiveIndexRoot;
  ordinals?: ArchiveIndexRoot;
  rawToRef?: ArchiveIndexRoot;
  refToRaw?: ArchiveIndexRoot;
  tokens?: ArchiveIndexRoot;
  ccr?: ArchiveIndexRoot;
  blocks?: ArchiveIndexRoot;
  activeBlocks?: ArchiveIndexRoot;
  absorbed?: ArchiveIndexRoot;
  deadRefs?: ArchiveIndexRoot;
  /** Numeric parser value -> positive count of distinct exact raw tombstones. */
  deadRefOrder?: ArchiveIndexRoot;
  owners?: ArchiveIndexRoot;
  /** Base ID -> paged membership set of stable canonical component IDs. */
  candidates?: ArchiveIndexRoot;
  /** Canonical descendant block ID -> paged stable component membership. */
  lineageCandidates?: ArchiveIndexRoot;
  /** Explicitly restored active consumed blocks, cleared by the next sync. */
  transientCandidates?: ArchiveIndexRoot;
  transientAncestors?: ArchiveIndexRoot;
  claims?: ArchiveIndexRoot;
  gaps?: ArchiveIndexRoot;
  proofs?: ArchiveIndexRoot;
  outbox?: ArchiveIndexRoot;
  nativeAliases?: ArchiveIndexRoot;
  folds?: ArchiveIndexRoot;
  carriers?: ArchiveIndexRoot;
  ranges?: ArchiveIndexRoot;
  parents?: ArchiveIndexRoot;
}

export type ArchiveKernelHead = Omit<CompressionState,
  'blocks' | 'messageRefs' | 'tokenSnapshot' | 'absorbed' | 'deadRefs'>;

/** The CAS root contains current request metadata, never historical maps. */
export interface ContextArchiveHead {
  schemaVersion: 2;
  key: string;
  session: Omit<ContextSession, 'schemaVersion' | 'state' | 'originals' | 'contentStore' | 'folds'>;
  kernel: ArchiveKernelHead;
  roots: ArchiveRoots;
  originalCount: number;
  blockCount: number;
  foldCount: number;
  ccrCount: number;
  nextMessageRef: number;
  kernelRoot: string;
  stateGeneration: number;
  ownerEpoch: number;
  /** Certifies that the counted numeric tombstone index matches deadRefs. */
  deadRefOrderVersion?: 1;
  latestCommitId?: string;
  migration?: { fromSchemaVersion: 1; sourceRevision: number; sourceHash: string; at: string };
}

export interface ArchiveBlockHead {
  blockId: string;
  runId: string;
  tier: CompressionBlock['tier'];
  topic?: string;
  summary: string;
  compressedTokens: number;
  createdAt: number;
  survivedCount: number;
  generation: CompressionBlock['generation'];
  active: boolean;
  expanded?: boolean;
  restoredInline?: boolean;
  durationMs?: number;
  compressCallId?: string;
  startRef?: string;
  endRef?: string;
  /** Immutable canonical lineage is separate from the owner forest. */
  directSequence?: ArchiveIndexRoot;
  childSequence?: ArchiveIndexRoot;
  childCount: number;
  childLookup?: ArchiveIndexRoot;
  coverage?: ArchiveIndexRoot;
  coverageCount: number;
  /** Source ordering is original ingestion ordinal, not a min/max proxy. */
  coverageOrder?: ArchiveIndexRoot;
  coverageRefs?: ArchiveIndexRoot;
  effectiveSequence?: ArchiveIndexRoot;
  /** Exact ordered range prefix; expanded only by explicit full hydration. */
  effectivePrefix?: ArchiveIndexRoot;
  hasEffectivePrefix?: boolean;
  directCoverage?: ArchiveIndexRoot;
  directBaseCoverage?: ArchiveIndexRoot;
  baseCoverage?: ArchiveIndexRoot;
  inheritedCoverage?: ArchiveIndexRoot;
  inheritedBaseCoverage?: ArchiveIndexRoot;
  /** Exact canonical child-transitive closure, independent of owner union. */
  lineageCoverage?: ArchiveIndexRoot;
  /** Immutable shortest-distance snapshot, including this block at zero. */
  lineageDistances?: ArchiveIndexRoot;
  lineageDistanceOffset: number;
  ownerRoot?: string;
  bodyObjectId: string;
  bodyHash: string;
}

/** Canonical consumption forest; sharing a source never joins components. */
export interface ArchiveOwnerNode {
  id: string;
  parent?: string;
  /** Monotonic historical incidence mass used for small-to-large merging. */
  historicalWeight: number;
  /** Kept as a scalar diagnostic count; historicalWeight determines rank. */
  size: number;
  inactiveClaim?: boolean;
  inactiveEpoch?: number;
  /** Root event epoch at the moment this component joined its parent. */
  joinedAt?: number;
  epoch?: number;
  /** Exact current top's base membership, never an inline historical list. */
  memberBases?: ArchiveIndexRoot;
  /** Descendant -> shortest distance minus distanceOffset, including top. */
  memberBlocks?: ArchiveIndexRoot;
  distanceOffset: number;
  /** Only this root's unconsumed canonical top can be a candidate. */
  eligibleBlockId?: string;
  /** Query-only aggregate; never persisted on component nodes. */
  eligibleBlockIds?: string[];
}

export interface ArchiveCommitProof {
  schemaVersion: 2;
  sessionKey: string;
  id: string;
  requestId?: string;
  kind: string;
  beforeRevision: number;
  /** Immutable evidence of THIS commit, independent of the latest state. */
  parentCommitId?: string;
  rootsHash: string;
  kernelHash: string;
  stateGeneration: number;
  originalCount: number;
  blockCount: number;
  at: string;
}

export interface ArchiveOutboxItem {
  id: string;
  commitId: string;
  kind: string;
  payload: unknown;
}

export interface ArchiveCommitOptions {
  requestId?: string;
  kind?: string;
  /** Observation effects become reachable atomically with the root CAS. */
  outbox?: Array<{ id: string; kind: string; payload: unknown }>;
}

export interface ArchiveHydrateOptions {
  /** Explicit block operations may load these immutable canonical bodies. */
  blockIds?: string[];
  /** Head-only complete/epochs/wire paths perform no archive hydration. */
  headOnly?: boolean;
}

export interface ArchiveWorking {
  stored: StoredRecord<ContextArchiveHead>;
  session: ContextSession;
  full: boolean;
  /** Roots can reference prepared immutable pages before the head CAS. */
  roots: ArchiveRoots;
  nextOrdinal: number;
  nextMessageRef: number;
  ownerEpoch: number;
  baseline: ContextSession;
  originalRefs: Map<string, OriginalRef>;
  blockHeads: Map<string, ArchiveBlockHead>;
  kernelContext?: IndexedArchiveFacts;
  pendingDelta?: IndexedStateDelta;
  reconciledMessageIds?: string[];
  ingestedMessages?: CoreMessage[];
  preparedBlockIds?: string[];
  preparedDelta?: boolean;
}

export interface ContextArchiveRepository {
  open(key: string, create: () => ContextSession | Promise<ContextSession>): Promise<StoredRecord<ContextArchiveHead>>;
  /** Explicit recovery only; validates the pre-migration revision even on no-op. */
  rebuildDeadRefOrder(key: string, expectedRevision?: number): Promise<number | undefined>;
  hydrateWorking(stored: StoredRecord<ContextArchiveHead>, incoming?: Array<CoreMessage | string>,
    options?: ArchiveHydrateOptions): Promise<ArchiveWorking>;
  loadFull(stored: StoredRecord<ContextArchiveHead>): Promise<ArchiveWorking>;
  ingest(working: ArchiveWorking, messages: CoreMessage[]): Promise<CoreMessage[]>;
  bindOriginalRefs(working: ArchiveWorking, messages?: CoreMessage[]): Promise<void>;
  prepareKernel(working: ArchiveWorking, messages: CoreMessage[], extraBlockIds?: string[]): Promise<IndexedArchiveFacts>;
  commitDelta(working: ArchiveWorking, delta: IndexedStateDelta): Promise<void>;
  fork(working: ArchiveWorking): ArchiveWorking;
  forkWorking(working: ArchiveWorking): ArchiveWorking;
  commit(working: ArchiveWorking, options?: ArchiveCommitOptions): Promise<StoredRecord<ContextArchiveHead>>;
  original(head: ContextArchiveHead, id: string): Promise<OriginalRef | undefined>;
  version(head: ContextArchiveHead, sourceId: string, sourceHash: string): Promise<OriginalRef | undefined>;
  byRef(head: ContextArchiveHead, ref: string): Promise<OriginalRef | undefined>;
  readOriginal(head: ContextArchiveHead, ref: OriginalRef): Promise<CoreMessage>;
  ccr(head: ContextArchiveHead, ref: string): Promise<StoredEntry | undefined>;
  readContent(head: ContextArchiveHead, hash: string): Promise<string | undefined>;
  blockHead(head: ContextArchiveHead, blockId: string): Promise<ArchiveBlockHead | undefined>;
  coverage(head: ContextArchiveHead, blockId: string): AsyncGenerator<OriginalRef>;
  owner(head: ContextArchiveHead, rawId: string): Promise<ArchiveOwnerNode | undefined>;
  claim(head: ContextArchiveHead, rawId: string): Promise<boolean>;
  suffixGap(head: ContextArchiveHead, root: string, start: number): Promise<number>;
  proof(head: ContextArchiveHead, id: string): Promise<ArchiveCommitProof | undefined>;
  pendingOutbox(head: ContextArchiveHead): AsyncGenerator<ArchiveOutboxItem>;
  acknowledgeOutbox(working: ArchiveWorking, id: string): Promise<void>;
  putNativeAlias(working: ArchiveWorking, hostId: string, value: unknown): Promise<void>;
  getNativeAlias<T = unknown>(head: ContextArchiveHead, hostId: string): Promise<T | undefined>;
  delete(working: ArchiveWorking): Promise<void>;
}
