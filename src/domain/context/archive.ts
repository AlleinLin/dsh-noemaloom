import { randomUUID } from 'node:crypto';
import type { CompressionBlock, CompressionState, CoreMessage, FoldEvent } from '../../../vendor/acp-kernel/src/index.js';
import type { StoredEntry } from '../../../vendor/acp-kernel/src/content-store.js';
import type { IndexedBlockDelta, IndexedStateDelta } from '../../../vendor/acp-kernel/src/indexed-types.js';
import { NexusError, type NexusStore, type StoredRecord } from '../../ports/contracts.js';
import { canonicalJson, jsonClone, sha256 } from '../storage/canonical.js';
import type { ContextSession, OriginalRef } from './types.js';
import { ArchivePages, type ArchiveIndexRoot } from './archive-pages.js';
import { prepareArchiveFacts } from './archive-facts.js';
import { deadRefNumber, deadRefOrderKey } from './archive-types.js';
import type { ArchiveBlockHead, ArchiveChildSelector, ArchiveClaim, ArchiveCommitOptions, ArchiveCommitProof, ArchiveHydrateOptions,
  ArchiveKernelHead, ArchiveOutboxItem, ArchiveOwnerNode, ArchiveRoots, ArchiveWorking,
  ContextArchiveHead, ContextArchiveRepository } from './archive-types.js';

export type * from './archive-types.js';
export { ArchivePages } from './archive-pages.js';

const SESSIONS = 'context.sessions';
const hash = (value: unknown) => sha256(canonicalJson(value));
const base = (id: string) => id.indexOf('#') > 0 ? id.slice(0, id.indexOf('#')) : id;
const numberKey = (n: number) => String(n).padStart(16, '0');
const versionKey = (sourceId: string, sourceHash: string) => canonicalJson([sourceId, sourceHash]);
const headState = (state: CompressionState): ArchiveKernelHead => {
  const { blocks: _blocks, messageRefs: _refs, tokenSnapshot: _tokens, absorbed: _absorbed,
    deadRefs: _dead, indexedProjection: _projection, ...scalars } = state as CompressionState & { indexedProjection?: string };
  return jsonClone(scalars);
};
const sessionHead = (session: ContextSession): ContextArchiveHead['session'] => {
  const { schemaVersion: _schema, state: _state, originals: _originals, contentStore: _contents,
    folds: _folds, ...metadata } = session;
  return jsonClone(metadata);
};
const blockHeader = (block: CompressionBlock) => {
  const { directMessageIds: _direct, effectiveMessageIds: _effective, directBlockIds: _children, ...header } = block;
  return header;
};
const archiveHeader = (head: ArchiveBlockHead) => ({
  blockId: head.blockId, runId: head.runId, tier: head.tier, topic: head.topic,
  summary: head.summary, compressedTokens: head.compressedTokens, createdAt: head.createdAt,
  survivedCount: head.survivedCount, generation: head.generation, active: head.active,
  expanded: head.expanded, restoredInline: head.restoredInline, durationMs: head.durationMs,
  compressCallId: head.compressCallId, startRef: head.startRef, endRef: head.endRef,
});
const plainState = (head: ContextArchiveHead): CompressionState => ({
  ...jsonClone(head.kernel), blocks: [], messageRefs: { byRaw: {}, byRef: {} },
  tokenSnapshot: {}, absorbed: [], deadRefs: [],
});
const asSession = (head: ContextArchiveHead): ContextSession => ({
  ...jsonClone(head.session), schemaVersion: 1, state: plainState(head), originals: [],
  contentStore: { version: 1, byHash: {}, byRef: {} }, folds: [],
});
function assertSafeCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new NexusError('CTX_ARCHIVE_CORRUPT', `无效归档计数 ${name}`);
}
function assertHead(head: ContextArchiveHead, key: string): void {
  if (head.schemaVersion !== 2 || head.key !== key || head.session.key !== key
      || head.session.owner !== 'nexus/acp-kernel' || !head.roots || typeof head.kernelRoot !== 'string') {
    throw new NexusError('CTX_ARCHIVE_CORRUPT', '上下文归档根校验失败', { key });
  }
  if (head.deadRefOrderVersion !== undefined && head.deadRefOrderVersion !== 1) {
    throw new NexusError('CTX_ARCHIVE_CORRUPT', '无效的归档死引用索引版本');
  }
  for (const [name, value] of Object.entries({ originals: head.originalCount, blocks: head.blockCount,
    folds: head.foldCount, ccr: head.ccrCount, nextRef: head.nextMessageRef,
    stateGeneration: head.stateGeneration, ownerEpoch: head.ownerEpoch })) assertSafeCount(value, name);
}
function assertDeadRefOrderReady(head: ContextArchiveHead): void {
  if (head.deadRefOrderVersion !== 1
      && (head.roots.deadRefs !== undefined || head.roots.deadRefOrder !== undefined)) {
    throw new NexusError('CTX_ARCHIVE_INDEX_MIGRATION_REQUIRED',
      '死引用数值索引需要一次性迁移，请先执行 context/recover', { key: head.key, action: 'context/recover' });
  }
}

/**
 * Archive V2 keeps the mutable CAS record independent of historical size.
 * Pages and bodies written before a failed CAS remain unreachable; only roots
 * in a successfully committed head confer authority on prepared writes.
 */
export function createContextArchive(store: NexusStore): ContextArchiveRepository {
  const pagesFor = (key: string) => new ArchivePages(store, key);
  const pagesByWorking = new WeakMap<ArchiveWorking, ArchivePages>();
  const workingPages = (working: ArchiveWorking): ArchivePages => {
    let pages = pagesByWorking.get(working);
    if (!pages) {
      pages = pagesFor(working.session.key);
      pagesByWorking.set(working, pages);
    }
    return pages;
  };

  async function putImmutable<T>(collection: string, id: string, value: T): Promise<void> {
    const prior = await store.get<T>(collection, id);
    if (prior) {
      if (hash(prior.value) !== hash(value)) throw new NexusError('CTX_ARCHIVE_CORRUPT', '不可变归档对象冲突', { collection, id });
      return;
    }
    try { await store.put(collection, id, value, 0); }
    catch (error) {
      if (!(error instanceof NexusError) || error.code !== 'REVISION_CONFLICT') throw error;
      const raced = await store.get<T>(collection, id);
      if (!raced || hash(raced.value) !== hash(value)) throw error;
    }
  }
  async function changeDeadRefCount(p: ArchivePages, root: ArchiveIndexRoot | undefined,
    ref: string, change: 1 | -1): Promise<ArchiveIndexRoot | undefined> {
    const numeric = deadRefNumber(ref);
    if (numeric === null) return root;
    const key = deadRefOrderKey(numeric);
    const stored = await p.get<unknown>(root, key);
    if (stored !== undefined && (typeof stored !== 'number' || !Number.isSafeInteger(stored) || stored < 1)) {
      throw new NexusError('CTX_ARCHIVE_CORRUPT', '归档死引用别名计数无效');
    }
    const count = (stored as number | undefined) ?? 0;
    const next = count + change;
    if (!Number.isSafeInteger(next) || next < 0) {
      throw new NexusError('CTX_ARCHIVE_CORRUPT', '归档死引用别名计数不一致');
    }
    return next === 0 ? p.delete(root, key) : p.set(root, key, next);
  }
  async function setDeadRef(working: ArchiveWorking, ref: string, dead: boolean): Promise<void> {
    const p = workingPages(working);
    const previous = await p.get<unknown>(working.roots.deadRefs, ref);
    if (previous !== undefined && previous !== true) throw new NexusError('CTX_ARCHIVE_CORRUPT', '归档死引用标记无效');
    if ((previous === true) === dead) return;
    // Exact aliases transition independently; the numeric witness survives
    // until the last archived spelling of that number has been lifted.
    const order = await changeDeadRefCount(p, working.roots.deadRefOrder, ref, dead ? 1 : -1);
    const raw = dead ? await p.set(working.roots.deadRefs, ref, true) : await p.delete(working.roots.deadRefs, ref);
    working.roots.deadRefs = raw;
    working.roots.deadRefOrder = order;
  }
  async function object(key: string, value: unknown): Promise<{ objectId: string; contentHash: string }> {
    const contentHash = hash(value);
    const objectId = `${key}.${contentHash}`;
    await putImmutable('context.objects', objectId, { schemaVersion: 1, sessionKey: key, contentHash, value });
    return { objectId, contentHash };
  }
  async function original(head: ContextArchiveHead, id: string): Promise<OriginalRef | undefined> {
    return pagesFor(head.key).get(head.roots.originals, id);
  }
  async function version(head: ContextArchiveHead, sourceId: string, sourceHash: string): Promise<OriginalRef | undefined> {
    const p = pagesFor(head.key);
    const id = await p.get<string>(head.roots.versions, versionKey(sourceId, sourceHash));
    return id === undefined ? undefined : p.get<OriginalRef>(head.roots.originals, id);
  }
  async function byRef(head: ContextArchiveHead, ref: string): Promise<OriginalRef | undefined> {
    const p = pagesFor(head.key);
    const id = await p.get<string>(head.roots.refToRaw, ref);
    return id === undefined ? undefined : p.get<OriginalRef>(head.roots.originals, id);
  }
  async function readOriginal(head: ContextArchiveHead, ref: OriginalRef): Promise<CoreMessage> {
    const record = await store.get<{ sessionKey: string; contentHash: string; value: CoreMessage }>('context.objects', ref.objectId);
    if (!record || record.value.sessionKey !== head.key) {
      throw new NexusError('CTX_SOURCE_MISSING', `缺失原文 ${ref.id}`, { ref: ref.id, objectId: ref.objectId });
    }
    if (record.value.contentHash !== ref.contentHash || hash(record.value.value) !== ref.contentHash
        || record.value.value.id !== ref.id || ref.objectId !== `${head.key}.${ref.contentHash}`) {
      throw new NexusError('CTX_SOURCE_CORRUPT', `原文完整性校验失败 ${ref.id}`);
    }
    return record.value.value;
  }
  async function readContent(head: ContextArchiveHead, contentHash: string): Promise<string | undefined> {
    const record = await store.get<{ sessionKey: string; hash: string; text: string }>('context.contents', `${head.key}.${contentHash}`);
    if (!record) return undefined;
    if (record.value.sessionKey !== head.key || record.value.hash !== contentHash
        || typeof record.value.text !== 'string' || sha256(record.value.text) !== contentHash) {
      throw new NexusError('CTX_SOURCE_CORRUPT', 'CCR 正文完整性校验失败', { hash: contentHash });
    }
    return record.value.text;
  }
  async function getOwner(p: ArchivePages, roots: ArchiveRoots, rawId: string): Promise<ArchiveOwnerNode | undefined> {
    const posting = await p.get<ArchiveIndexRoot>(roots.candidates, base(rawId));
    const candidates: ArchiveOwnerNode[] = [];
    for await (const [id] of p.entries(posting)) candidates.push(await resolveOwner(p, roots, id));
    if (!candidates.length) return undefined;
    return { ...candidates[0]!, eligibleBlockIds: [...new Set(candidates
      .map(node => node.eligibleBlockId).filter((id): id is string => !!id))] };
  }
  async function resolveOwner(p: ArchivePages, roots: ArchiveRoots, id: string): Promise<ArchiveOwnerNode> {
    const initial = await p.get<ArchiveOwnerNode>(roots.owners, id);
    if (!initial) throw new NexusError('CTX_ARCHIVE_CORRUPT', '覆盖所有者节点缺失', { id });
    let node: ArchiveOwnerNode = initial;
    let hops = 0;
    while (node.parent) {
      if (++hops > 64) throw new NexusError('CTX_ARCHIVE_CORRUPT', '覆盖所有者索引存在环或深度超限');
      const next: ArchiveOwnerNode | undefined = await p.get<ArchiveOwnerNode>(roots.owners, node.parent);
      if (!next || next.historicalWeight < node.historicalWeight * 2) {
        throw new NexusError('CTX_ARCHIVE_CORRUPT', '覆盖所有者未满足按大小合并约束', { id: node.id });
      }
      node = next;
    }
    return node;
  }
  async function readBlockHead(p: ArchivePages, roots: ArchiveRoots, id: string): Promise<ArchiveBlockHead | undefined> {
    const head = await p.get<ArchiveBlockHead>(roots.blocks, id);
    return head ? { ...head, active: await p.get(roots.activeBlocks, id) === true } : undefined;
  }
  async function addRef(working: ArchiveWorking, ref: OriginalRef): Promise<void> {
    const p = workingPages(working);
    const old = await p.get<OriginalRef>(working.roots.originals, ref.id);
    if (old && hash({ ...old, messageRef: undefined }) !== hash({ ...ref, messageRef: undefined })) {
      throw new NexusError('CTX_MESSAGE_ID_COLLISION', '永久来源标识不可覆盖', { id: ref.id });
    }
    if (!old) {
      if (ref.ordinal !== working.nextOrdinal) throw new NexusError('CTX_ARCHIVE_CORRUPT', '原文序号必须连续追加');
      working.nextOrdinal++;
      working.roots.ordinals = await p.set(working.roots.ordinals, numberKey(ref.ordinal), ref.id);
    }
    working.roots.originals = await p.set(working.roots.originals, ref.id, ref);
    // A reconciled instance may share the host source/hash of its ancestor.
    // The canonical source-version mapping remains first-write-wins.
    const version = versionKey(ref.sourceId, ref.sourceHash ?? ref.contentHash);
    if (await p.get(working.roots.versions, version) === undefined) {
      working.roots.versions = await p.set(working.roots.versions, version, ref.id);
    }
    working.roots.sourceIds = await p.set(working.roots.sourceIds, ref.sourceId, true);
    const nativeId = ref.nativeMessageId ?? /^dsh:(.+?)(?:#|$)/.exec(ref.sourceId)?.[1];
    if (nativeId && await p.get(working.roots.nativeAliases, `source:${nativeId}`) === undefined) {
      working.roots.nativeAliases = await p.set(working.roots.nativeAliases, `source:${nativeId}`, ref.id);
    }
    working.originalRefs.set(ref.id, ref);
    const current = working.session.originals.findIndex(item => item.id === ref.id);
    if (current < 0) working.session.originals.push(ref); else working.session.originals[current] = ref;
  }
  async function bindAlias(working: ArchiveWorking, raw: string, ref: string): Promise<void> {
    const p = workingPages(working);
    const oldRef = await p.get<string>(working.roots.rawToRef, raw);
    if (ref === 'BLOCKED') {
      // Hard protection may temporarily replace the live forward alias while
      // the permanent reverse numeric alias remains retrievable.
      working.roots.rawToRef = await p.set(working.roots.rawToRef, raw, ref);
      return;
    }
    if (!/^m\d+$/.test(ref)) return;
    const oldRaw = await p.get<string>(working.roots.refToRaw, ref);
    const oldForwardIsOwned = oldRef && oldRef !== 'BLOCKED' && oldRef !== ref
      ? await p.get<string>(working.roots.refToRaw, oldRef) === raw : true;
    if (!oldForwardIsOwned || oldRaw && oldRaw !== raw) {
      throw new NexusError('CTX_REF_REASSIGNED', '永久消息引用不可重新绑定', { raw, ref, oldRef, oldRaw });
    }
    working.roots.rawToRef = await p.set(working.roots.rawToRef, raw, ref);
    working.roots.refToRaw = await p.set(working.roots.refToRaw, ref, raw);
    working.nextMessageRef = Math.max(working.nextMessageRef, Number(ref.slice(1)) + 1);
    const source = working.originalRefs.get(raw) ?? await p.get<OriginalRef>(working.roots.originals, raw);
    if (source && !source.messageRef) await addRef(working, { ...source, messageRef: ref });
  }
  async function bindReverse(working: ArchiveWorking, ref: string, raw: string): Promise<void> {
    if (!/^m\d+$/.test(ref)) return;
    const p = workingPages(working);
    const previous = await p.get<string>(working.roots.refToRaw, ref);
    if (previous && previous !== raw) throw new NexusError('CTX_REF_REASSIGNED', '永久反向引用不可覆盖');
    working.roots.refToRaw = await p.set(working.roots.refToRaw, ref, raw);
    working.nextMessageRef = Math.max(working.nextMessageRef, Number(ref.slice(1)) + 1);
    const source = working.originalRefs.get(raw) ?? await p.get<OriginalRef>(working.roots.originals, raw);
    if (source && !source.messageRef) await addRef(working, { ...source, messageRef: ref });
  }
  async function persistContent(working: ArchiveWorking, entries: Record<string, StoredEntry>, contents: Record<string, string>): Promise<void> {
    const p = workingPages(working);
    for (const [contentHash, text] of Object.entries(contents)) {
      if (sha256(text) !== contentHash) throw new NexusError('CTX_SOURCE_CORRUPT', 'CCR 正文哈希不匹配');
      await putImmutable('context.contents', `${working.session.key}.${contentHash}`, {
        schemaVersion: 1, sessionKey: working.session.key, hash: contentHash, text,
      });
    }
    for (const [ref, entry] of Object.entries(entries)) {
      const prior = await p.get<StoredEntry>(working.roots.ccr, ref);
      if (prior && hash(prior) !== hash(entry)) throw new NexusError('CTX_REF_REASSIGNED', 'CCR 永久引用不可覆盖', { ref });
      if (!prior) working.roots.ccr = await p.set(working.roots.ccr, ref, entry);
    }
    working.session.contentStore.byHash = {};
  }

  async function merge<T>(p: ArchivePages, first: ArchiveIndexRoot | undefined,
    second: ArchiveIndexRoot | undefined): Promise<ArchiveIndexRoot | undefined> {
    if (!first) return second;
    if (!second || first.pageId === second.pageId) return first;
    let result = first.count >= second.count ? first : second;
    const smaller = first.count >= second.count ? second : first;
    for await (const [key, value] of p.entries<T>(smaller)) result = await p.set(result, key, value);
    return result;
  }
  async function rootForIds(p: ArchivePages, ids: string[]): Promise<ArchiveIndexRoot | undefined> {
    let result: ArchiveIndexRoot | undefined;
    for (const id of ids) result = await p.set(result, id, true);
    return result;
  }
  async function rootForSequence(p: ArchivePages, ids: string[]): Promise<ArchiveIndexRoot | undefined> {
    let result: ArchiveIndexRoot | undefined;
    for (const [index, id] of ids.entries()) result = await p.set(result, numberKey(index), id);
    return result;
  }
  async function baseCounts(p: ArchivePages, exact: ArchiveIndexRoot | undefined): Promise<ArchiveIndexRoot | undefined> {
    let result: ArchiveIndexRoot | undefined;
    for await (const [id] of p.entries(exact)) {
      const normalized = base(id);
      const count = await p.get<number>(result, normalized) ?? 0;
      result = await p.set(result, normalized, count + 1);
    }
    return result;
  }
  async function mergeCoverage(p: ArchivePages, left: ArchiveIndexRoot | undefined, leftBase: ArchiveIndexRoot | undefined,
    right: ArchiveIndexRoot | undefined, rightBase: ArchiveIndexRoot | undefined):
    Promise<{ exact?: ArchiveIndexRoot; bases?: ArchiveIndexRoot }> {
    if (!left) return { exact: right, bases: rightBase };
    if (!right || left.pageId === right.pageId) return { exact: left, bases: leftBase };
    const larger = left.count >= right.count ? left : right;
    const smaller = left.count >= right.count ? right : left;
    let exact = larger;
    let bases = left.count >= right.count ? leftBase : rightBase;
    for await (const [id] of p.entries(smaller)) {
      if (await p.get(exact, id) !== undefined) continue;
      exact = await p.set(exact, id, true);
      const normalized = base(id);
      bases = await p.set(bases, normalized, (await p.get<number>(bases, normalized) ?? 0) + 1);
    }
    return { exact, bases };
  }
  async function claimSuffix(working: ArchiveWorking, id: string): Promise<void> {
    const match = /^h_([0-9a-f]{16})(?:_(\d+))?$/.exec(base(id));
    if (!match || !match[2]) return;
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return;
    const root = `h_${match[1]}`;
    const prefix = `${root}\0`;
    const key = `${prefix}${numberKey(suffix)}`;
    const p = workingPages(working);
    const position = await p.rank(working.roots.gaps, key);
    const left = position ? await p.at<{ root: string; start: number; end: number }>(working.roots.gaps, position - 1) : undefined;
    const right = await p.at<{ root: string; start: number; end: number }>(working.roots.gaps, position);
    if (left?.[1].root === root && left[1].end >= suffix || right?.[1].root === root && right[1].start === suffix) return;
    let start = suffix; let end = suffix;
    if (left?.[1].root === root && left[1].end + 1 === suffix) {
      start = left[1].start;
      working.roots.gaps = await p.delete(working.roots.gaps, left[0]);
    }
    if (right?.[1].root === root && right[1].start === suffix + 1) {
      end = right[1].end;
      working.roots.gaps = await p.delete(working.roots.gaps, right[0]);
    }
    working.roots.gaps = await p.set(working.roots.gaps, `${prefix}${numberKey(start)}`, { root, start, end });
  }
  async function claimSource(working: ArchiveWorking, id: string, blockId: string): Promise<void> {
    const p = workingPages(working);
    const normalized = base(id);
    if (await p.get(working.roots.claims, normalized) === undefined) {
      working.roots.claims = await p.set(working.roots.claims, normalized, { firstBlockId: blockId });
    }
    await claimSuffix(working, normalized);
  }
  async function permanentInactive(working: ArchiveWorking, normalized: string, blockId: string): Promise<void> {
    const p = workingPages(working);
    const claim = await p.get<ArchiveClaim>(working.roots.claims, normalized);
    const inactiveWitnesses = await p.set(claim?.inactiveWitnesses, blockId, true);
    working.roots.claims = await p.set(working.roots.claims, normalized,
      { firstBlockId: claim?.firstBlockId ?? blockId, permanentInactive: true, inactiveWitnesses } satisfies ArchiveClaim);
    if (!claim) await claimSuffix(working, normalized);
  }
  async function childLookup(p: ArchivePages, children: ArchiveBlockHead[]): Promise<ArchiveIndexRoot | undefined> {
    const unique = [...new Map(children.map(child => [child.blockId, child])).values()];
    let lookup: ArchiveIndexRoot | undefined;
    const build = async (from: number, to: number, key: string): Promise<ArchiveIndexRoot | undefined> => {
      if (to - from === 1) {
        const child = unique[from]!;
        lookup = await p.set(lookup, key, { bases: child.baseCoverage, childId: child.blockId } satisfies ArchiveChildSelector);
        return child.baseCoverage;
      }
      const middle = from + Math.floor((to - from) / 2);
      const left = `${key}0`; const right = `${key}1`;
      const leftBases = await build(from, middle, left);
      const rightBases = await build(middle, to, right);
      const bases = await merge(p, leftBases, rightBases);
      lookup = await p.set(lookup, key, { bases, left, right } satisfies ArchiveChildSelector);
      return bases;
    };
    if (unique.length) await build(0, unique.length, 'n');
    return lookup;
  }
  type PostingIndex = 'candidates' | 'lineageCandidates' | 'transientCandidates' | 'transientAncestors';
  async function posting(working: ArchiveWorking, index: PostingIndex, key: string,
    member: string, present: boolean): Promise<void> {
    const p = workingPages(working);
    const previous = await p.get<ArchiveIndexRoot>(working.roots[index], key);
    const next = present ? await p.set(previous, member, true) : await p.delete(previous, member);
    working.roots[index] = next ? await p.set(working.roots[index], key, next)
      : await p.delete(working.roots[index], key);
  }
  async function setBlockActivity(working: ArchiveWorking, head: ArchiveBlockHead,
    active: boolean, replacingActiveSet = false): Promise<void> {
    const p = workingPages(working);
    const wasActive = await p.get(working.roots.activeBlocks, head.blockId) === true;
    working.roots.activeBlocks = active ? await p.set(working.roots.activeBlocks, head.blockId, true)
      : await p.delete(working.roots.activeBlocks, head.blockId);
    // Only explicit operations preserve temporary activity on consumed blocks.
    // A process-turn replacement drops both transient roots in constant time.
    if (!replacingActiveSet && wasActive !== active
      && await p.get(working.roots.parents, head.blockId) === true) {
      for await (const [normalized] of p.entries(head.baseCoverage)) {
        await posting(working, 'transientCandidates', normalized, head.blockId, active);
      }
      for await (const [descendant] of p.entries(head.lineageCoverage)) {
        await posting(working, 'transientAncestors', descendant, head.blockId, active);
      }
    }
    const cached = working.blockHeads.get(head.blockId);
    if (cached) working.blockHeads.set(head.blockId, { ...cached, active });
  }
  async function canonicalOwner(working: ArchiveWorking, blockId: string,
    effectiveBase: ArchiveIndexRoot | undefined, lineage: ArchiveIndexRoot | undefined,
    inheritedBase: ArchiveIndexRoot | undefined, children: ArchiveBlockHead[],
    ownBases: Set<string>, excludedBases: Set<string>,
    explicitFull = false): Promise<{ ownerRoot: string; lineageDistances?: ArchiveIndexRoot; lineageDistanceOffset: number }> {
    const p = workingPages(working);
    const unique = new Map<string, ArchiveOwnerNode>();
    const branches: ArchiveBlockHead[] = [];
    for (const child of children) {
      const owner = child.ownerRoot ? await resolveOwner(p, working.roots, child.ownerRoot) : undefined;
      if (owner?.eligibleBlockId === child.blockId) unique.set(owner.id, owner);
      else branches.push(child);
    }
    const nodes = [...unique.values()].sort((a, b) =>
      b.historicalWeight - a.historicalWeight || (a.id < b.id ? -1 : 1));
    const seedWeight = 1 + ownBases.size + branches.reduce((sum, child) =>
      sum + (child.baseCoverage?.count ?? 0) + (child.lineageCoverage?.count ?? 0) + 1, 0);
    const weight = nodes.reduce((sum, node) => sum + node.historicalWeight, seedWeight);
    assertSafeCount(weight, 'owner historical weight');
    working.ownerEpoch++;
    const winner = nodes[0] ?? { id: `component:${blockId}`, size: 0, historicalWeight: 0,
      distanceOffset: -1, memberBlocks: undefined };
    const distanceOffset = winner.distanceOffset + 1;
    let memberBlocks = winner.memberBlocks;
    const addDistance = async (descendant: string, distance: number): Promise<void> => {
      if (!Number.isSafeInteger(distance) || distance < 0) throw new NexusError('CTX_ARCHIVE_CORRUPT', '块血缘距离无效');
      const prior = await p.get<number>(memberBlocks, descendant);
      if (prior === undefined || distance < prior + distanceOffset) {
        memberBlocks = await p.set(memberBlocks, descendant, distance - distanceOffset);
      }
    };
    for (const loser of nodes.slice(1)) {
      for await (const [normalized] of p.entries(loser.memberBases)) {
        await posting(working, 'candidates', normalized, loser.id, false);
        if (await p.get(effectiveBase, normalized) !== undefined) {
          await posting(working, 'candidates', normalized, winner.id, true);
        } else await permanentInactive(working, normalized, loser.eligibleBlockId!);
      }
      for await (const [descendant, residual] of p.entries<number>(loser.memberBlocks)) {
        await addDistance(descendant, residual + loser.distanceOffset + 1);
        await posting(working, 'lineageCandidates', descendant, loser.id, false);
        await posting(working, 'lineageCandidates', descendant, winner.id, true);
      }
      working.roots.owners = await p.set(working.roots.owners, loser.id, {
        ...loser, parent: winner.id, joinedAt: working.ownerEpoch,
      } satisfies ArchiveOwnerNode);
    }
    // Reusing a historical child starts a branch. It does not consume that
    // child's other current parents or steal their independent component.
    for (const child of branches) {
      for await (const [normalized] of p.entries(child.baseCoverage)) {
        if (await p.get(effectiveBase, normalized) !== undefined) {
          await posting(working, 'candidates', normalized, winner.id, true);
        } else await permanentInactive(working, normalized, child.blockId);
      }
      for await (const [descendant, residual] of p.entries<number>(child.lineageDistances)) {
        await addDistance(descendant, residual + child.lineageDistanceOffset + 1);
        await posting(working, 'lineageCandidates', descendant, winner.id, true);
      }
    }
    for (const normalized of ownBases) {
      if (await p.get(effectiveBase, normalized) !== undefined) {
        await posting(working, 'candidates', normalized, winner.id, true);
      }
    }
    const removed = explicitFull && nodes[0]
      ? p.entries(nodes[0].memberBases)
      : (async function* () { for (const id of excludedBases) yield [id, true] as const; })();
    for await (const [normalized] of removed) {
      if (await p.get(effectiveBase, normalized) !== undefined) continue;
      if (nodes[0]?.eligibleBlockId && await p.get(nodes[0].memberBases, normalized) !== undefined
        && await p.get(inheritedBase, normalized) !== undefined) {
        await permanentInactive(working, normalized, nodes[0].eligibleBlockId);
      }
      await posting(working, 'candidates', normalized, winner.id, false);
    }
    await addDistance(blockId, 0);
    if ((memberBlocks?.count ?? 0) !== (lineage?.count ?? 0) + 1) {
      throw new NexusError('CTX_ARCHIVE_CORRUPT', '块血缘距离索引与精确闭包不一致', { blockId });
    }
    await posting(working, 'lineageCandidates', blockId, winner.id, true);
    working.roots.owners = await p.set(working.roots.owners, winner.id, {
      id: winner.id, size: nodes.reduce((sum, node) => sum + node.size, 1),
      historicalWeight: weight, epoch: working.ownerEpoch, eligibleBlockId: blockId,
      memberBases: effectiveBase, memberBlocks, distanceOffset,
    } satisfies ArchiveOwnerNode);
    return { ownerRoot: winner.id, lineageDistances: memberBlocks, lineageDistanceOffset: distanceOffset };
  }
  async function retireExpandedOwner(working: ArchiveWorking, head: ArchiveBlockHead): Promise<void> {
    if (!head.ownerRoot) return;
    const p = workingPages(working);
    const owner = await resolveOwner(p, working.roots, head.ownerRoot);
    if (owner.eligibleBlockId !== head.blockId) return;
    for await (const [normalized] of p.entries(owner.memberBases)) {
      await permanentInactive(working, normalized, head.blockId);
      await posting(working, 'candidates', normalized, owner.id, false);
    }
    for await (const [descendant] of p.entries(owner.memberBlocks)) {
      await posting(working, 'lineageCandidates', descendant, owner.id, false);
    }
    working.roots.owners = await p.set(working.roots.owners, owner.id, {
      ...owner, eligibleBlockId: undefined, memberBases: undefined, memberBlocks: undefined,
    } satisfies ArchiveOwnerNode);
  }
  async function persistBlock(working: ArchiveWorking, delta: IndexedBlockDelta,
    fullBlock?: CompressionBlock, replacingActiveSet = false): Promise<void> {
    const p = workingPages(working);
    const old = await readBlockHead(p, working.roots, delta.header.blockId);
    let next: ArchiveBlockHead;
    if (old) {
      if (delta.coverage) {
        if (!fullBlock) throw new NexusError('CTX_BLOCK_TOPOLOGY_IMMUTABLE', '已有块的来源与血缘不可覆盖');
        const sameSequence = async (root: ArchiveIndexRoot | undefined, ids: string[]): Promise<boolean> => {
          if ((root?.count ?? 0) !== ids.length) return false;
          for (const [index, id] of ids.entries()) if (await p.get(root, numberKey(index)) !== id) return false;
          return true;
        };
        let sameEffective = new Set(fullBlock.effectiveMessageIds).size === old.coverageCount;
        const baseline = working.baseline.state.blocks.find(block => block.blockId === old.blockId);
        if (baseline && hash(baseline.effectiveMessageIds) !== hash(fullBlock.effectiveMessageIds)) sameEffective = false;
        for (const id of fullBlock.effectiveMessageIds) {
          if (await p.get(old.coverage, id) === undefined) { sameEffective = false; break; }
        }
        if (!sameEffective || !await sameSequence(old.directSequence, fullBlock.directMessageIds)
          || !await sameSequence(old.childSequence, fullBlock.directBlockIds)) {
          throw new NexusError('CTX_BLOCK_TOPOLOGY_IMMUTABLE', '已有块的来源与血缘不可覆盖', { blockId: old.blockId });
        }
      }
      next = { ...old, ...delta.header };
    } else {
      if (!delta.coverage && !fullBlock) {
        throw new NexusError('CTX_BLOCK_TOPOLOGY_MISSING', '新块缺少来源与血缘配方', { blockId: delta.header.blockId });
      }
      const directIds = delta.coverage?.directMessageIds ?? fullBlock?.directMessageIds ?? [];
      const children = delta.coverage?.childBlockIds ?? fullBlock?.directBlockIds ?? [];
      const additional = (delta.coverage as { additionalEffectiveMessageIds?: string[] } | undefined)?.additionalEffectiveMessageIds ?? [];
      const effectiveOrderPrefix = fullBlock ? undefined
        : (delta.coverage as { orderedPrefixMessageIds?: string[] } | undefined)?.orderedPrefixMessageIds;
      const excluded = (delta.coverage as { excludedMessageIds?: string[] } | undefined)?.excludedMessageIds ?? [];
      const excludedSet = new Set(excluded);
      const direct = await rootForIds(p, directIds);
      const directBase = await baseCounts(p, direct);
      const directSequence = await rootForSequence(p, directIds);
      const childSequence = await rootForSequence(p, children);
      const effectivePrefix = effectiveOrderPrefix ? await rootForSequence(p, effectiveOrderPrefix) : undefined;
      let inherited: ArchiveIndexRoot | undefined;
      let inheritedBase: ArchiveIndexRoot | undefined;
      let lineage: ArchiveIndexRoot | undefined;
      let order: ArchiveIndexRoot | undefined;
      let coverageRefs: ArchiveIndexRoot | undefined;
      let sequence: ArchiveIndexRoot | undefined;
      const childHeads: ArchiveBlockHead[] = [];
      for (const childId of children) {
        const child = await readBlockHead(p, working.roots, childId);
        if (!child) throw new NexusError('CTX_CHILD_MISSING', `缺失子块 ${childId}`);
        childHeads.push(child);
        const inheritedUnion = await mergeCoverage(p, inherited, inheritedBase, child.coverage, child.baseCoverage);
        inherited = inheritedUnion.exact;
        inheritedBase = inheritedUnion.bases;
        order = await merge<string>(p, order, child.coverageOrder);
        coverageRefs = await merge<string>(p, coverageRefs, child.coverageRefs);
        lineage = await merge<boolean>(p, lineage, child.lineageCoverage);
        lineage = await p.set(lineage, childId, true);
        working.roots.parents = await p.set(working.roots.parents, childId, true);
        await setBlockActivity(working, child, false, replacingActiveSet);
      }
      const effectiveUnion = await mergeCoverage(p, direct, directBase, inherited, inheritedBase);
      let effective = effectiveUnion.exact;
      let effectiveBase = effectiveUnion.bases;
      for (const id of [...directIds, ...additional]) {
        const source = working.originalRefs.get(id) ?? await p.get<OriginalRef>(working.roots.originals, id);
        if (!source && !id.startsWith('acp_summary_')) throw new NexusError('CTX_SOURCE_MISSING', `块来源不存在 ${id}`);
        if (source) order = await p.set(order, numberKey(source.ordinal), id);
        const messageRef = await p.get<string>(working.roots.rawToRef, id);
        if (messageRef && /^m\d+$/.test(messageRef)) coverageRefs = await p.set(coverageRefs, numberKey(Number(messageRef.slice(1))), messageRef);
        if (!excludedSet.has(id) && (!fullBlock || fullBlock.effectiveMessageIds.includes(id))) {
          await claimSource(working, id, delta.header.blockId);
        }
        if (additional.includes(id) && await p.get(effective, id) === undefined) {
          effective = await p.set(effective, id, true);
          const normalized = base(id);
          effectiveBase = await p.set(effectiveBase, normalized, (await p.get<number>(effectiveBase, normalized) ?? 0) + 1);
        }
      }
      // A legacy full block can contain a carefully protected effective set
      // which is smaller than direct+children. Migration preserves it exactly.
      if (fullBlock) {
        effective = await rootForIds(p, fullBlock.effectiveMessageIds);
        effectiveBase = await baseCounts(p, effective);
        order = undefined;
        coverageRefs = undefined;
        for (const [index, id] of fullBlock.effectiveMessageIds.entries()) {
          const source = await p.get<OriginalRef>(working.roots.originals, id);
          if (source) order = await p.set(order, numberKey(source.ordinal), id);
          const messageRef = await p.get<string>(working.roots.rawToRef, id);
          if (messageRef && /^m\d+$/.test(messageRef)) coverageRefs = await p.set(coverageRefs, numberKey(Number(messageRef.slice(1))), messageRef);
          sequence = await p.set(sequence, numberKey(index), id);
          if (!directIds.includes(id)) await claimSource(working, id, delta.header.blockId);
        }
      }
      for (const id of excluded) {
        const existed = await p.get(effective, id) !== undefined;
        effective = await p.delete(effective, id);
        const source = await p.get<OriginalRef>(working.roots.originals, id);
        if (source) order = await p.delete(order, numberKey(source.ordinal));
        const messageRef = await p.get<string>(working.roots.rawToRef, id);
        if (messageRef && /^m\d+$/.test(messageRef)) coverageRefs = await p.delete(coverageRefs, numberKey(Number(messageRef.slice(1))));
        const normalized = base(id);
        if (existed) {
          const count = await p.get<number>(effectiveBase, normalized);
          if (!count) throw new NexusError('CTX_ARCHIVE_CORRUPT', '来源 base 计数缺失');
          effectiveBase = count === 1 ? await p.delete(effectiveBase, normalized)
            : await p.set(effectiveBase, normalized, count - 1);
        }
        // canonicalOwner records the exact old covering child as a witness
        // when this hole removes the component's last occurrence of a base.
      }
      const body = { schemaVersion: 2, sessionKey: working.session.key, blockId: delta.header.blockId,
        directMessageIds: directIds, directBlockIds: children, coverage: effective,
        inheritedCoverage: inherited, lineageCoverage: lineage, effectiveOrderPrefix };
      const bodyHash = hash(body);
      const bodyObjectId = `${working.session.key}.${bodyHash}`;
      await putImmutable('context.archive.blocks', bodyObjectId, body);
      const ownBases = new Set((fullBlock ? fullBlock.effectiveMessageIds : [...directIds, ...additional]).map(base));
      const ownership = await canonicalOwner(working, delta.header.blockId, effectiveBase, lineage,
        inheritedBase, childHeads, ownBases, new Set(excluded.map(base)), !!fullBlock);
      next = { ...delta.header, directSequence, childSequence, childCount: children.length,
        childLookup: await childLookup(p, childHeads),
        directCoverage: direct, directBaseCoverage: directBase, coverage: effective,
        baseCoverage: effectiveBase, inheritedCoverage: inherited, inheritedBaseCoverage: inheritedBase,
        coverageOrder: order, coverageRefs, effectiveSequence: sequence, effectivePrefix,
        hasEffectivePrefix: effectiveOrderPrefix !== undefined,
        lineageCoverage: lineage, coverageCount: effective?.count ?? 0,
        bodyObjectId, bodyHash, ...ownership };
    }
    if (next.expanded && !old?.expanded) await retireExpandedOwner(working, next);
    working.roots.blocks = await p.set(working.roots.blocks, next.blockId, next);
    await setBlockActivity(working, next, next.active, replacingActiveSet);
    if (next.compressCallId) working.roots.carriers = await p.set(working.roots.carriers, `${next.compressCallId}\0${next.blockId}`, next.blockId);
    if (next.startRef && next.endRef) working.roots.ranges = await p.set(working.roots.ranges, `${next.startRef}::${next.endRef}\0${next.blockId}`, next.blockId);
    working.blockHeads.set(next.blockId, next);
    // Preserve the longstanding content address for summary artifacts.
    await object(working.session.key, { kind: 'compression-summary', text: next.summary });
  }

  async function blockReceipt(working: ArchiveWorking, block: ArchiveBlockHead, revision: number, requestId?: string): Promise<void> {
    block = { ...block, active: await workingPages(working).get(working.stored.value.roots.activeBlocks, block.blockId) === true };
    const id = `${working.session.key}.${block.blockId}`;
    const prior = await store.get<Record<string, unknown>>('context.blocks', id);
    if (typeof prior?.value.committedRevision === 'number' && prior.value.committedRevision > revision) return;
    const summaryHash = sha256(block.summary);
    const summaryRevision = prior ? Number(prior.value.summaryRevision ?? 0) + (prior.value.summaryHash === summaryHash ? 0 : 1) : 1;
    await store.put('context.blocks', id, {
      schemaVersion: 2, sessionKey: working.session.key, sessionId: working.session.sessionId,
      branchId: working.session.branchId, blockId: block.blockId, runId: block.runId,
      tier: block.tier, generation: block.generation, summaryText: block.summary, summaryHash,
      summaryRevision, summaryArtifactId: `${working.session.key}.${hash({ kind: 'compression-summary', text: block.summary })}`,
      directMessageCount: block.directCoverage?.count ?? 0, directMessageRoot: block.directSequence ?? null,
      directBlockCount: block.childCount, directBlockRoot: block.childSequence ?? null,
      effectiveCount: block.coverageCount, sourceIntegrityRoot: block.coverage?.pageId ?? null,
      sourceOrderRoot: block.coverageOrder?.pageId ?? null, canonicalLineageRoot: block.lineageCoverage?.pageId ?? null,
      active: block.active, expanded: block.expanded ?? false, restoredInline: block.restoredInline ?? false,
      status: block.expanded || block.restoredInline ? 'restored' : block.active ? 'active' : 'superseded',
      committedRevision: revision, controllerEpoch: String(working.session.epochs.compressionEpoch),
      stateRevision: working.session.epochs.compressionEpoch,
      createdByRequestId: prior?.value.createdByRequestId ?? requestId ?? null,
      createdAt: prior?.value.createdAt ?? new Date(block.createdAt).toISOString(),
      updatedAt: new Date().toISOString(), originalEstimatedTokens: block.compressedTokens,
      renderAnchor: { kind: block.childCount ? 'existing-summary' : 'direct-range', messageRef: block.startRef ?? null },
      doctrineVersion: 'billion-acp-0.0.136', rendererVersion: 'nexus-acp-v1',
    }, prior?.revision ?? 0);
  }
  async function drainInternal(working: ArchiveWorking): Promise<void> {
    const p = workingPages(working);
    const pending: Array<[string, ArchiveOutboxItem]> = [];
    for await (const entry of p.entries<ArchiveOutboxItem>(working.roots.outbox)) {
      if (entry[1].kind === 'context.block-metadata' || entry[1].kind === 'context.transaction-metadata') pending.push(entry);
    }
    for (const [key, item] of pending) {
      const proof = await p.get<ArchiveCommitProof>(working.stored.value.roots.proofs, item.commitId);
      if (!proof) throw new NexusError('CTX_ARCHIVE_CORRUPT', '持久效果缺少已提交历史证明', { id: item.id });
      if (item.kind === 'context.block-metadata') {
        const payload = item.payload as { blockId?: unknown; blockHead?: ArchiveBlockHead };
        if (typeof payload.blockId !== 'string' || item.id !== `block:${item.commitId}:${payload.blockId}`) {
          throw new NexusError('CTX_ARCHIVE_CORRUPT', '块收据持久效果格式无效');
        }
        const block = payload.blockHead ?? await p.get<ArchiveBlockHead>(working.stored.value.roots.blocks, payload.blockId);
        if (!block) throw new NexusError('CTX_BLOCK_NOT_FOUND', '待恢复块收据缺少归档头');
        if (block.blockId !== payload.blockId) throw new NexusError('CTX_ARCHIVE_CORRUPT', '块收据身份不匹配');
        await blockReceipt(working, block, proof.beforeRevision + 1, proof.requestId);
      } else {
        if (item.id !== `transaction:${item.commitId}`) throw new NexusError('CTX_ARCHIVE_CORRUPT', '事务收据持久效果格式无效');
        const id = `${working.session.key}.${item.commitId}`;
        const record = await store.get<Record<string, unknown>>('context.transactions', id);
        await store.put('context.transactions', id, {
          ...record?.value, schemaVersion: 2, sessionKey: working.session.key, commitId: item.commitId,
          requestId: proof.requestId, status: 'committed', kind: proof.kind,
          beforeRevision: proof.beforeRevision, committedRevision: proof.beforeRevision + 1,
          kernelRoot: proof.kernelHash, stateGeneration: proof.stateGeneration,
        }, record?.revision ?? 0);
      }
      working.roots.outbox = await p.delete(working.roots.outbox, key);
    }
  }

  async function commitDelta(working: ArchiveWorking, delta: IndexedStateDelta): Promise<void> {
    if (delta.stamp.sessionKey !== working.session.key || delta.stamp.headRevision !== working.stored.revision
        || delta.stamp.archiveRoot !== working.stored.value.kernelRoot) {
      throw new NexusError('CTX_ARCHIVE_STALE', '内核增量不属于当前归档根');
    }
    await bindOriginalRefs(working, working.ingestedMessages);
    const p = workingPages(working);
    for (const [raw, ref] of Object.entries(delta.refs.byRaw)) await bindAlias(working, raw, ref);
    for (const [ref, raw] of Object.entries(delta.refs.byRef)) await bindReverse(working, ref, raw);
    for (const [ref, tokens] of Object.entries(delta.tokenSnapshot)) {
      const previous = await p.get<number>(working.roots.tokens, ref);
      if (previous !== undefined && previous !== tokens) throw new NexusError('CTX_REF_REASSIGNED', '首见 token 快照不可覆盖');
      if (previous === undefined) working.roots.tokens = await p.set(working.roots.tokens, ref, tokens);
    }
    for (const ref of delta.deadRefs.add) await setDeadRef(working, ref, true);
    for (const ref of delta.deadRefs.lift) await setDeadRef(working, ref, false);
    for (const absorbed of delta.absorbed) working.roots.absorbed = await p.set(working.roots.absorbed, absorbed.toolCallId, absorbed);
    await persistContent(working, delta.contentEntries, delta.contents);
    if (delta.replaceActiveSet) {
      working.roots.transientCandidates = undefined;
      working.roots.transientAncestors = undefined;
    }
    for (const block of delta.blocks) await persistBlock(working, block, undefined, delta.replaceActiveSet === true);
    if (delta.replaceActiveSet) {
      working.roots.activeBlocks = await rootForIds(p,
        delta.blocks.filter(block => block.header.active).map(block => block.header.blockId));
      for (const [id, head] of working.blockHeads) working.blockHeads.set(id,
        { ...head, active: await p.get(working.roots.activeBlocks, id) === true });
    }
    working.preparedBlockIds = [...new Set([...(working.preparedBlockIds ?? []), ...delta.blocks.map(block => block.header.blockId)])];
    working.preparedDelta = true;
    working.nextMessageRef = Math.max(working.nextMessageRef, delta.nextRefIndex);
    Object.assign(working.session.state, jsonClone(delta.head));
    if (working.pendingDelta === delta) delete working.pendingDelta;
  }

  function createWorking(stored: StoredRecord<ContextArchiveHead>): ArchiveWorking {
    assertHead(stored.value, stored.id);
    const session = asSession(stored.value);
    return { stored, session, roots: jsonClone(stored.value.roots), full: false,
      nextOrdinal: stored.value.originalCount, nextMessageRef: stored.value.nextMessageRef,
      ownerEpoch: stored.value.ownerEpoch, baseline: jsonClone(session),
      originalRefs: new Map(), blockHeads: new Map() };
  }
  async function hydrateWorking(stored: StoredRecord<ContextArchiveHead>, incoming?: Array<CoreMessage | string>,
    options: ArchiveHydrateOptions = {}): Promise<ArchiveWorking> {
    const working = createWorking(stored);
    assertDeadRefOrderReady(stored.value);
    const session = working.session;
    if (options.headOnly) return working;
    const p = workingPages(working);
    const candidates = incoming ?? session.liveMessageIds ?? [];
    const rawIds = candidates.map(message => typeof message === 'string' ? message : message.id);
    const blocks = new Set(options.blockIds ?? []);
    for (const rawId of rawIds) {
      const ref = await p.get<OriginalRef>(working.roots.originals, rawId);
      if (ref) { working.originalRefs.set(rawId, ref); session.originals.push(ref); }
      const owner = await getOwner(p, working.roots, rawId);
      for (const id of owner?.eligibleBlockIds ?? (owner?.eligibleBlockId ? [owner.eligibleBlockId] : [])) blocks.add(id);
      const transient = await p.get<ArchiveIndexRoot>(working.roots.transientCandidates, base(rawId));
      for await (const [id] of p.entries(transient)) blocks.add(id);
      if (rawId.startsWith('acp_summary_')) blocks.add(rawId.slice('acp_summary_'.length));
    }
    for (const blockId of blocks) {
      const block = await readBlockHead(p, working.roots, blockId);
      if (!block) continue;
      working.blockHeads.set(blockId, block);
      // This is a bounded projection, never the immutable complete coverage.
      const direct: string[] = []; const effective: string[] = [];
      for (const rawId of rawIds) {
        if (await p.get(block.directCoverage, rawId) !== undefined) direct.push(rawId);
        if (await p.get(block.coverage, rawId) !== undefined) effective.push(rawId);
      }
      session.state.blocks.push({ ...archiveHeader(block),
        directMessageIds: direct, effectiveMessageIds: effective, directBlockIds: [] });
    }
    for (const rawId of rawIds) {
      const ref = await p.get<string>(working.roots.rawToRef, rawId);
      if (ref) {
        session.state.messageRefs.byRaw[rawId] = ref;
        if (ref !== 'BLOCKED') session.state.messageRefs.byRef[ref] = rawId;
        const token = await p.get<number>(working.roots.tokens, ref);
        if (token !== undefined) session.state.tokenSnapshot[ref] = token;
        const entry = await p.get<StoredEntry>(working.roots.ccr, ref);
        if (entry) session.contentStore.byRef[ref] = entry;
      }
    }
    working.baseline = jsonClone(session);
    return working;
  }
  async function loadFull(stored: StoredRecord<ContextArchiveHead>): Promise<ArchiveWorking> {
    const working = await hydrateWorking(stored, [], { headOnly: true });
    const p = workingPages(working);
    working.full = true;
    delete (working.session.state as CompressionState & { indexedProjection?: string }).indexedProjection;
    for await (const [, id] of p.entries<string>(working.roots.ordinals)) {
      const ref = await p.get<OriginalRef>(working.roots.originals, id);
      if (!ref) throw new NexusError('CTX_ARCHIVE_CORRUPT', '原文序号索引悬空', { id });
      working.originalRefs.set(id, ref); working.session.originals.push(ref);
    }
    for await (const [id, rawHead] of p.entries<ArchiveBlockHead>(working.roots.blocks)) {
      const head = { ...rawHead, active: await p.get(working.roots.activeBlocks, id) === true };
      working.blockHeads.set(id, head);
      const record = await store.get<{ sessionKey: string; blockId: string }>('context.archive.blocks', head.bodyObjectId);
      if (!record || record.value.sessionKey !== stored.id || record.value.blockId !== id || hash(record.value) !== head.bodyHash) {
        throw new NexusError('CTX_ARCHIVE_CORRUPT', '不可变块血缘正文校验失败', { id });
      }
    }
    // Full kernel order is a Set seeded by this range's surviving raw prefix,
    // followed by each consumed child's effective array in canonical order.
    // Cold arrays are expanded only by this explicit full-load operation.
    const sequences = new Map<string, string[]>();
    const visiting = new Set<string>();
    const expand = async (head: ArchiveBlockHead): Promise<string[]> => {
      const cached = sequences.get(head.blockId);
      if (cached) return cached;
      if (visiting.has(head.blockId)) throw new NexusError('CTX_LINEAGE_CYCLE', '不可变块血缘存在环');
      visiting.add(head.blockId);
      const ordered: string[] = [];
      const seen = new Set<string>();
      const append = async (id: string): Promise<void> => {
        if (!seen.has(id) && await p.get(head.coverage, id) !== undefined) {
          seen.add(id); ordered.push(id);
        }
      };
      if (head.effectiveSequence) {
        for await (const [, id] of p.entries<string>(head.effectiveSequence)) await append(id);
      } else {
        const prefix = head.hasEffectivePrefix ? head.effectivePrefix : head.directSequence;
        for await (const [, id] of p.entries<string>(prefix)) await append(id);
        for await (const [, childId] of p.entries<string>(head.childSequence)) {
          const child = working.blockHeads.get(childId);
          if (!child) throw new NexusError('CTX_CHILD_MISSING', `缺失子块 ${childId}`);
          for (const id of await expand(child)) await append(id);
        }
      }
      if (ordered.length !== head.coverageCount) {
        throw new NexusError('CTX_ARCHIVE_CORRUPT', '块来源顺序配方与精确覆盖集合不一致', { blockId: head.blockId,
          sequenceCount: ordered.length, coverageCount: head.coverageCount });
      }
      visiting.delete(head.blockId);
      sequences.set(head.blockId, ordered);
      return ordered;
    };
    for (const head of working.blockHeads.values()) {
      const effective = await expand(head);
      const directMessageIds: string[] = [];
      const directBlockIds: string[] = [];
      for await (const [, id] of p.entries<string>(head.directSequence)) directMessageIds.push(id);
      for await (const [, id] of p.entries<string>(head.childSequence)) directBlockIds.push(id);
      working.session.state.blocks.push({ ...archiveHeader(head),
        directMessageIds, directBlockIds,
        effectiveMessageIds: effective });
    }
    for await (const [raw, ref] of p.entries<string>(working.roots.rawToRef)) working.session.state.messageRefs.byRaw[raw] = ref;
    for await (const [ref, raw] of p.entries<string>(working.roots.refToRaw)) working.session.state.messageRefs.byRef[ref] = raw;
    for await (const [ref, token] of p.entries<number>(working.roots.tokens)) working.session.state.tokenSnapshot[ref] = token;
    for await (const [ref, entry] of p.entries<StoredEntry>(working.roots.ccr)) working.session.contentStore.byRef[ref] = entry;
    for await (const [ref] of p.entries(working.roots.deadRefs)) working.session.state.deadRefs!.push(ref);
    for await (const [, absorbed] of p.entries<NonNullable<CompressionState['absorbed']>[number]>(working.roots.absorbed)) working.session.state.absorbed!.push(absorbed);
    for await (const [, fold] of p.entries<FoldEvent>(working.roots.folds)) working.session.folds.push(fold);
    working.session.state.blocks.sort((a, b) => Number(a.blockId.slice(1)) - Number(b.blockId.slice(1)));
    working.baseline = jsonClone(working.session);
    return working;
  }

  async function ingest(working: ArchiveWorking, messages: CoreMessage[]): Promise<CoreMessage[]> {
    if (!Array.isArray(messages) || messages.length > 200_000
        || Buffer.byteLength(canonicalJson(messages)) > 64 * 1024 * 1024) {
      throw new NexusError('CTX_MESSAGES_INVALID', '上下文输入超过支持范围');
    }
    const ids = new Set<string>(); const result: CoreMessage[] = [];
    const p = workingPages(working);
    for (const candidate of messages) {
      if (!candidate || typeof candidate.id !== 'string' || !candidate.id || ids.has(candidate.id)
          || !['system', 'user', 'assistant', 'tool'].includes(candidate.role)
          || !['text', 'tool-call', 'tool-result', 'reasoning'].includes(candidate.contentType)
          || candidate.text !== undefined && typeof candidate.text !== 'string') {
        throw new NexusError('CTX_MESSAGE_INVALID', '消息 id/role/contentType/text 无效或重复');
      }
      ids.add(candidate.id);
      const sourceId = candidate.id; const sourceHash = hash(candidate);
      const exact = await p.get<OriginalRef>(working.roots.originals, sourceId);
      if (exact?.contentHash === sourceHash) {
        working.originalRefs.set(exact.id, exact);
        if (!working.session.originals.some(item => item.id === exact.id)) working.session.originals.push(exact);
        result.push(jsonClone(candidate));
        continue;
      }
      const priorId = await p.get<string>(working.roots.versions, versionKey(sourceId, sourceHash));
      if (priorId) {
        const prior = await p.get<OriginalRef>(working.roots.originals, priorId);
        if (!prior) throw new NexusError('CTX_ARCHIVE_CORRUPT', '原文版本索引悬空');
        working.originalRefs.set(prior.id, prior);
        if (!working.session.originals.some(item => item.id === prior.id)) working.session.originals.push(prior);
        result.push({ ...candidate, id: prior.id });
        continue;
      }
      const changed = await p.get(working.roots.sourceIds, sourceId) !== undefined
        || await p.get(working.roots.originals, sourceId) !== undefined;
      let id = changed ? `${sourceId}@${sourceHash.slice(0, 16)}` : sourceId;
      if (await p.get(working.roots.originals, id) !== undefined) id = `${sourceId}@${sourceHash}`;
      if (await p.get(working.roots.originals, id) !== undefined) throw new NexusError('CTX_MESSAGE_ID_COLLISION', '新原文版本与永久来源标识冲突');
      const message = { ...candidate, id };
      const body = await object(working.session.key, message);
      await addRef(working, { ...body, id, sourceId, sourceHash, ordinal: working.nextOrdinal,
        nativeMessageId: (candidate as CoreMessage & { nativeMessageId?: string }).nativeMessageId });
      result.push(message);
    }
    working.session.liveMessageIds = result.map(message => message.id);
    working.ingestedMessages = result.map(message => jsonClone(message));
    return result;
  }
  async function bindOriginalRefs(working: ArchiveWorking, messages: CoreMessage[] = []): Promise<void> {
    const state = working.session.state;
    // Reconciliation supplies an explicit index-aligned mapping. The kernel's
    // lastPassIds intentionally describes the PRE-pipeline inbound surface.
    const minted = working.reconciledMessageIds;
    if (messages.length && minted?.length === messages.length) {
      for (let index = 0; index < messages.length; index++) {
        const input = messages[index]!; const id = minted[index]!;
        if (id === input.id || working.originalRefs.has(id)) continue;
        const source = working.originalRefs.get(input.id);
        if (!source) throw new NexusError('CTX_SOURCE_MISSING', '重分配实例缺少原文', { id: input.id });
        const p = workingPages(working);
        const prior = await p.get<OriginalRef>(working.roots.originals, id);
        if (!prior) {
          const body = await object(working.session.key, { ...input, id });
          await addRef(working, { ...source, ...body, id, ordinal: working.nextOrdinal, messageRef: undefined });
        }
        if (working.session.liveMessageIds?.[index] === input.id) working.session.liveMessageIds[index] = id;
      }
    }
    for (const [raw, ref] of Object.entries(state.messageRefs.byRaw)) await bindAlias(working, raw, ref);
  }

  async function commitFullDiff(working: ArchiveWorking): Promise<void> {
    const before = working.baseline;
    const after = working.session;
    const p = workingPages(working);
    for (const ref of after.originals) {
      const old = working.originalRefs.get(ref.id);
      if (!old || hash(old) !== hash(ref)) await addRef(working, ref);
    }
    for (const [raw, ref] of Object.entries(after.state.messageRefs.byRaw)) await bindAlias(working, raw, ref);
    // A protected forward alias may be BLOCKED while an older issued numeric
    // reverse alias remains valid forever.
    for (const [ref, raw] of Object.entries(after.state.messageRefs.byRef)) {
      await bindReverse(working, ref, raw);
    }
    for (const [ref, tokens] of Object.entries(after.state.tokenSnapshot)) {
      if (before.state.tokenSnapshot[ref] === tokens) continue;
      const prior = await p.get<number>(working.roots.tokens, ref);
      if (prior !== undefined && prior !== tokens) throw new NexusError('CTX_REF_REASSIGNED', '首见 token 快照不可覆盖');
      working.roots.tokens = await p.set(working.roots.tokens, ref, tokens);
    }
    const oldBlocks = new Map(before.state.blocks.map(block => [block.blockId, block]));
    // New canonical children precede their parents in the kernel. Existing
    // refold-in-place blocks retain ID but receive a fresh immutable body.
    const pending = [...after.state.blocks];
    const visiting = new Set<string>();
    const done = new Set<string>();
    const persist = async (block: CompressionBlock): Promise<void> => {
      if (done.has(block.blockId)) return;
      if (visiting.has(block.blockId)) throw new NexusError('CTX_LINEAGE_CYCLE', '块血缘存在环');
      visiting.add(block.blockId);
      for (const id of block.directBlockIds) {
        const child = pending.find(item => item.blockId === id);
        if (child) await persist(child);
        else if (!await p.get(working.roots.blocks, id)) throw new NexusError('CTX_CHILD_MISSING', `缺失子块 ${id}`);
      }
      const prior = oldBlocks.get(block.blockId);
      if (!prior || hash(prior) !== hash(block)) await persistBlock(working,
        { header: blockHeader(block), coverage: { directMessageIds: block.directMessageIds, childBlockIds: block.directBlockIds } }, block);
      visiting.delete(block.blockId); done.add(block.blockId);
    };
    for (const block of pending) await persist(block);
    // Explicit full operations supply the complete logical activity snapshot,
    // including deliberately restored consumed children pending the next sync.
    working.roots.activeBlocks = undefined;
    working.roots.transientCandidates = undefined;
    working.roots.transientAncestors = undefined;
    for (const block of pending) {
      const head = await p.get<ArchiveBlockHead>(working.roots.blocks, block.blockId);
      if (head) await setBlockActivity(working, head, block.active);
    }
    const oldDead = new Set(before.state.deadRefs ?? []); const newDead = new Set(after.state.deadRefs ?? []);
    for (const ref of newDead) if (!oldDead.has(ref)) await setDeadRef(working, ref, true);
    for (const ref of oldDead) if (!newDead.has(ref)) await setDeadRef(working, ref, false);
    for (const absorbed of after.state.absorbed ?? []) {
      if (hash(before.state.absorbed?.find(item => item.toolCallId === absorbed.toolCallId) ?? null) !== hash(absorbed)) {
        working.roots.absorbed = await p.set(working.roots.absorbed, absorbed.toolCallId, absorbed);
      }
    }
    await persistContent(working, after.contentStore.byRef, after.contentStore.byHash);
    for (let index = before.folds.length; index < after.folds.length; index++) working.roots.folds = await p.set(working.roots.folds, numberKey(index), after.folds[index]);
  }

  async function commit(working: ArchiveWorking, options: ArchiveCommitOptions = {}): Promise<StoredRecord<ContextArchiveHead>> {
    await drainInternal(working);
    const deltaBlockIds = working.pendingDelta?.blocks.map(block => block.header.blockId);
    const fullBlockIds = working.full ? working.session.state.blocks.filter(block => {
        const prior = working.baseline.state.blocks.find(item => item.blockId === block.blockId);
        return !prior || hash(prior) !== hash(block);
      }).map(block => block.blockId) : [];
    const changedBlocks = [...new Set([...(working.preparedBlockIds ?? []), ...(deltaBlockIds ?? fullBlockIds)])];
    const hadDelta = Boolean(working.pendingDelta || working.preparedDelta);
    if (working.pendingDelta) await commitDelta(working, working.pendingDelta);
    if (working.full && !hadDelta) await commitFullDiff(working);
    else {
      await bindOriginalRefs(working);
      await persistContent(working, working.session.contentStore.byRef, working.session.contentStore.byHash);
      // Head-only calls may append a fold receipt but cannot overwrite cold
      // arrays with their empty working projection.
      for (let index = working.baseline.folds.length; index < working.session.folds.length; index++) {
        working.roots.folds = await workingPages(working).set(working.roots.folds,
          numberKey(working.stored.value.foldCount + index - working.baseline.folds.length), working.session.folds[index]);
      }
    }
    const previous = working.stored.value;
    const kernel = headState(working.session.state);
    const kernelIdentity = { kernel, nextMessageRef: working.nextMessageRef,
      originals: working.roots.originals, versions: working.roots.versions, rawToRef: working.roots.rawToRef,
      refToRaw: working.roots.refToRaw, tokens: working.roots.tokens, blocks: working.roots.blocks,
      ccr: working.roots.ccr, absorbed: working.roots.absorbed, deadRefs: working.roots.deadRefs,
      deadRefOrder: working.roots.deadRefOrder, deadRefOrderVersion: 1,
      activeBlocks: working.roots.activeBlocks, owners: working.roots.owners,
      candidates: working.roots.candidates, lineageCandidates: working.roots.lineageCandidates,
      transientCandidates: working.roots.transientCandidates, transientAncestors: working.roots.transientAncestors,
      claims: working.roots.claims, gaps: working.roots.gaps };
    const kernelRoot = hash(kernelIdentity);
    const changed = kernelRoot !== previous.kernelRoot;
    working.session.updatedAt = new Date().toISOString();
    let next: ContextArchiveHead = { ...previous, session: sessionHead(working.session), kernel,
      roots: working.roots, originalCount: working.nextOrdinal,
      blockCount: working.roots.blocks?.count ?? 0, ccrCount: working.roots.ccr?.count ?? 0,
      foldCount: working.roots.folds?.count ?? 0, nextMessageRef: working.nextMessageRef,
      kernelRoot, stateGeneration: previous.stateGeneration + (changed ? 1 : 0),
      ownerEpoch: working.ownerEpoch, deadRefOrderVersion: 1 };
    delete (next as ContextArchiveHead & { activeBlockIds?: unknown }).activeBlockIds;
    let transaction: StoredRecord<Record<string, unknown>> | undefined;
    let commitId: string | undefined;
    const pendingEffects: ArchiveOutboxItem[] = [];
    if (options.requestId || options.outbox?.length) {
      const id = options.requestId ?? randomUUID();
      commitId = id;
      const proof: ArchiveCommitProof = { schemaVersion: 2, sessionKey: next.key, id,
        requestId: options.requestId, kind: options.kind ?? 'context-commit', beforeRevision: working.stored.revision,
        parentCommitId: previous.latestCommitId, rootsHash: hash(working.roots), kernelHash: kernelRoot,
        stateGeneration: next.stateGeneration, originalCount: next.originalCount,
        blockCount: next.blockCount, at: new Date().toISOString() };
      const existing = await workingPages(working).get<ArchiveCommitProof>(working.roots.proofs, id);
      if (existing && existing.kernelHash !== proof.kernelHash) throw new NexusError('CTX_COMMIT_ID_REUSED', '提交请求标识已绑定其他内核根');
      working.roots.proofs = await workingPages(working).set(working.roots.proofs, id, existing ?? proof);
      const effects = [...(options.outbox ?? []), ...changedBlocks.map(blockId => ({
        id: `block:${id}:${blockId}`, kind: 'context.block-metadata',
        payload: { blockId, requestId: options.requestId, blockHead: working.blockHeads.get(blockId) },
      })), { id: `transaction:${id}`, kind: 'context.transaction-metadata', payload: { requestId: options.requestId } }];
      for (const item of effects) {
        const outbox = { ...item, commitId: id } satisfies ArchiveOutboxItem;
        const old = await workingPages(working).get<ArchiveOutboxItem>(working.roots.outbox, item.id);
        if (old && hash(old) !== hash(outbox)) throw new NexusError('CTX_OUTBOX_ID_REUSED', '未确认的持久效果标识不可覆盖', { id: item.id });
        pendingEffects.push(outbox);
        working.roots.outbox = await workingPages(working).set(working.roots.outbox, item.id, outbox);
      }
      next = { ...next, roots: working.roots, latestCommitId: id };
      const transactionId = `${next.key}.${id}`;
      const prior = await store.get<Record<string, unknown>>('context.transactions', transactionId);
      if (prior?.value.status !== 'committed') transaction = await store.put('context.transactions', transactionId, {
        schemaVersion: 2, sessionKey: next.key, requestId: options.requestId, commitId: id,
        status: 'prepared', kind: options.kind ?? 'context-commit', beforeRevision: working.stored.revision,
        kernelRoot, stateGeneration: next.stateGeneration, proofRoot: working.roots.proofs,
        createdAt: prior?.value.createdAt ?? new Date().toISOString(),
      }, prior?.revision ?? 0);
    }
    assertHead(next, working.stored.id);
    const committed = await store.put(SESSIONS, working.stored.id, next, working.stored.revision);
    working.stored.revision = committed.revision;
    working.stored.updatedAt = committed.updatedAt;
    working.stored.value = committed.value;
    working.roots = jsonClone(committed.value.roots);
    working.baseline = jsonClone(working.session);
    working.preparedBlockIds = [];
    working.preparedDelta = false;
    if (commitId) {
      try {
        for (const blockId of changedBlocks) {
          const block = working.blockHeads.get(blockId);
          if (block) await blockReceipt(working, block, committed.revision, options.requestId);
        }
        if (transaction) await store.put('context.transactions', transaction.id, {
          ...transaction.value, status: 'committed', committedRevision: committed.revision,
        }, transaction.revision);
        // Delivery acknowledgement is intentionally a second small root CAS.
        // A crash before it leaves durable, replayable outbox evidence.
        for (const effect of pendingEffects) {
          if (effect.id === `transaction:${commitId}` && effect.kind === 'context.transaction-metadata'
              || changedBlocks.some(id => effect.id === `block:${commitId}:${id}`) && effect.kind === 'context.block-metadata') {
            working.roots.outbox = await workingPages(working).delete(working.roots.outbox, effect.id);
          }
        }
        if (working.roots.outbox?.pageId !== working.stored.value.roots.outbox?.pageId) {
          const acknowledged = await store.put(SESSIONS, working.stored.id,
            { ...working.stored.value, roots: working.roots }, working.stored.revision);
          working.stored.revision = acknowledged.revision;
          working.stored.updatedAt = acknowledged.updatedAt;
          working.stored.value = acknowledged.value;
          return acknowledged;
        }
      } catch (error) {
        throw new NexusError('PARTIAL_EFFECT', '上下文归档根已提交，持久收据待恢复', {
          transactionId: `${next.key}.${commitId}`, committedRevision: working.stored.revision,
          effects: { state: 'committed', receipt: 'reconciliation-required' },
          causeCode: error instanceof NexusError ? error.code : 'INTERNAL',
        });
      }
    }
    return committed;
  }

  async function migrate(stored: StoredRecord<ContextSession>): Promise<StoredRecord<ContextArchiveHead>> {
    const legacy = stored.value;
    if (legacy.schemaVersion !== 1 || legacy.key !== stored.id) throw new NexusError('CTX_ARCHIVE_CORRUPT', '旧版上下文封装校验失败');
    const empty: ContextArchiveHead = { schemaVersion: 2, key: legacy.key, session: sessionHead(legacy),
      kernel: headState(legacy.state), roots: {}, originalCount: 0, blockCount: 0, ccrCount: 0, foldCount: 0,
      nextMessageRef: 1, kernelRoot: '', stateGeneration: 0, ownerEpoch: 0, deadRefOrderVersion: 1,
      migration: { fromSchemaVersion: 1, sourceRevision: stored.revision, sourceHash: hash(legacy), at: new Date().toISOString() } };
    const fake = { id: stored.id, revision: stored.revision, updatedAt: stored.updatedAt, value: empty };
    const working = await hydrateWorking(fake, [], { headOnly: true });
    working.full = true;
    working.session = jsonClone(legacy);
    working.baseline = { ...jsonClone(legacy), originals: [], state: {
      ...plainState(empty), nudge: jsonClone(legacy.state.nudge), stats: jsonClone(legacy.state.stats),
    }, contentStore: { version: 1, byHash: {}, byRef: {} }, folds: [] };
    const refs = [...legacy.originals].sort((a, b) => a.ordinal - b.ordinal);
    for (let index = 0; index < refs.length; index++) {
      const ref = refs[index]!;
      if (ref.ordinal !== index) throw new NexusError('CTX_ARCHIVE_CORRUPT', '旧版原文序号不连续');
      await addRef(working, ref);
    }
    return commit(working, { requestId: `archive-v2-migration:${stored.revision}`, kind: 'archive-v2-migration' });
  }
  async function open(key: string, create: () => ContextSession | Promise<ContextSession>): Promise<StoredRecord<ContextArchiveHead>> {
    const stored = await store.get<ContextArchiveHead | ContextSession>(SESSIONS, key);
    if (stored) {
      if ('deleted' in stored.value && stored.value.deleted || stored.value.schemaVersion === 2 && stored.value.session.deleted) {
        throw new NexusError('CTX_DATA_DELETED', '该上下文数据已按用户要求删除');
      }
      if (stored.value.schemaVersion === 2) {
        assertHead(stored.value, key);
        assertDeadRefOrderReady(stored.value);
        return stored as StoredRecord<ContextArchiveHead>;
      }
      return migrate(stored as StoredRecord<ContextSession>);
    }
    const value = await create();
    if (value.key !== key) throw new NexusError('CTX_ARCHIVE_CORRUPT', '创建上下文身份不匹配');
    // Initial synthetic/import fixtures may contain history; the same
    // one-time migration path applies, without an intermediate V1 disk write.
    return migrate({ id: key, revision: 0, value, updatedAt: new Date().toISOString() });
  }

  async function rebuildDeadRefOrder(key: string, expectedRevision?: number): Promise<number | undefined> {
    const stored = await store.get<ContextArchiveHead | ContextSession>(SESSIONS, key);
    const revision = stored?.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      throw new NexusError('REVISION_CONFLICT', '上下文状态已更新', { expected: expectedRevision, actual: revision });
    }
    // V1 and newly created sessions use the existing complete import path.
    if (!stored || stored.value.schemaVersion !== 2) return undefined;
    assertHead(stored.value, key);
    if (stored.value.session.deleted) throw new NexusError('CTX_DATA_DELETED', '该上下文数据已按用户要求删除');
    if (stored.value.deadRefOrderVersion === 1
        || stored.value.roots.deadRefs === undefined && stored.value.roots.deadRefOrder === undefined) return undefined;
    // This is the sole compatibility path allowed to enumerate tombstones.
    // It reads only the raw metadata index, never historical block bodies.
    const working = createWorking(stored as StoredRecord<ContextArchiveHead>);
    const p = workingPages(working);
    let order: ArchiveIndexRoot | undefined;
    for await (const [ref, value] of p.entries<unknown>(working.roots.deadRefs)) {
      if (value !== true) throw new NexusError('CTX_ARCHIVE_CORRUPT', '归档死引用标记无效');
      order = await changeDeadRefCount(p, order, ref, 1);
    }
    working.roots.deadRefOrder = order;
    const committed = await commit(working, {
      requestId: `archive-dead-ref-order-v1:${stored.revision}`, kind: 'archive-dead-ref-order-v1',
    });
    return committed.revision;
  }

  const repository: ContextArchiveRepository = {
    open, rebuildDeadRefOrder, hydrateWorking, loadFull, ingest, bindOriginalRefs, commit, commitDelta,
    fork(working) {
      const forked: ArchiveWorking = { ...working, stored: jsonClone(working.stored), session: jsonClone(working.session),
        roots: jsonClone(working.roots), baseline: jsonClone(working.baseline),
        originalRefs: new Map([...working.originalRefs].map(([id, ref]) => [id, jsonClone(ref)])),
        blockHeads: new Map([...working.blockHeads].map(([id, block]) => [id, jsonClone(block)])),
        ingestedMessages: working.ingestedMessages ? jsonClone(working.ingestedMessages) : undefined,
        reconciledMessageIds: working.reconciledMessageIds ? [...working.reconciledMessageIds] : undefined,
        preparedBlockIds: working.preparedBlockIds ? [...working.preparedBlockIds] : undefined,
        pendingDelta: working.pendingDelta ? jsonClone(working.pendingDelta) : undefined,
        kernelContext: undefined };
      // The roots remain independent. Verified immutable page bytes can be
      // shared safely within the bounded working scope.
      pagesByWorking.set(forked, workingPages(working));
      return forked;
    },
    forkWorking(working) { return repository.fork(working); },
    async prepareKernel(working, messages, extraBlockIds) {
      // A fresh projection deliberately severs the previous invocation's
      // WeakMap-bound uncommitted recipes. New facts address prepared roots.
      working.session.state = jsonClone(working.session.state);
      if (!working.full) (working.session.state as CompressionState & { indexedProjection?: string }).indexedProjection = 'indexed-v1';
      const facts = await prepareArchiveFacts(store, workingPages(working), working, messages, extraBlockIds);
      working.kernelContext = facts;
      return facts;
    },
    original, version, byRef, readOriginal, readContent,
    async ccr(head, ref) { return pagesFor(head.key).get(head.roots.ccr, ref); },
    async blockHead(head, blockId) { return readBlockHead(pagesFor(head.key), head.roots, blockId); },
    async *coverage(head, blockId) {
      const p = pagesFor(head.key);
      const block = await p.get<ArchiveBlockHead>(head.roots.blocks, blockId);
      if (!block) throw new NexusError('CTX_BLOCK_NOT_FOUND', `未知块 ${blockId}`);
      for await (const [, rawId] of p.entries<string>(block.coverageOrder)) {
        const ref = await p.get<OriginalRef>(head.roots.originals, rawId);
        if (!ref) throw new NexusError('CTX_SOURCE_MISSING', `块来源缺失 ${rawId}`);
        yield ref;
      }
    },
    async owner(head, rawId) { return getOwner(pagesFor(head.key), head.roots, rawId); },
    async claim(head, rawId) { return await pagesFor(head.key).get(head.roots.claims, base(rawId)) !== undefined; },
    async suffixGap(head, root, start) {
      if (!/^h_[0-9a-f]{16}$/.test(root) || !Number.isSafeInteger(start) || start < 1) {
        throw new NexusError('INVALID_ARGUMENT', '无效的实例后缀查询');
      }
      const p = pagesFor(head.key);
      const key = `${root}\0${numberKey(start)}`;
      const rank = await p.rank(head.roots.gaps, key);
      const left = rank ? await p.at<{ root: string; start: number; end: number }>(head.roots.gaps, rank - 1) : undefined;
      const right = await p.at<{ root: string; start: number; end: number }>(head.roots.gaps, rank);
      const interval = left?.[1].root === root && left[1].end >= start ? left[1]
        : right?.[1].root === root && right[1].start === start ? right[1] : undefined;
      return interval ? interval.end + 1 : start;
    },
    async proof(head, id) { return pagesFor(head.key).get(head.roots.proofs, id); },
    async *pendingOutbox(head) { for await (const [, item] of pagesFor(head.key).entries<ArchiveOutboxItem>(head.roots.outbox)) yield item; },
    async acknowledgeOutbox(working, id) { working.roots.outbox = await workingPages(working).delete(working.roots.outbox, id); },
    async putNativeAlias(working, hostId, value) { working.roots.nativeAliases = await workingPages(working).set(working.roots.nativeAliases, hostId, value); },
    async getNativeAlias<T>(head: ContextArchiveHead, hostId: string) { return pagesFor(head.key).get<T>(head.roots.nativeAliases, hostId); },
    async delete(working) {
      // Explicit deletion is allowed to enumerate the user's requested
      // session. Page IDs are session-prefixed even when payloads match.
      const previous = working.stored.value;
      const now = new Date().toISOString();
      const tombstone: ContextArchiveHead = {
        schemaVersion: 2, key: previous.key,
        session: { key: previous.key, sessionId: previous.session.sessionId, branchId: previous.session.branchId,
          purpose: previous.session.purpose, lane: previous.session.lane, workspaceRoot: previous.session.workspaceRoot,
          mode: previous.session.mode, owner: 'nexus/acp-kernel', inFlight: [], outputReserveTokens: 0,
          createdAt: previous.session.createdAt, updatedAt: now, deleted: true,
          epochs: { promptEpoch: 0, toolSurfaceEpoch: 0, memorySnapshotEpoch: 0, routeEpoch: 0,
            serializationEpoch: 0, compressionEpoch: 0 } },
        kernel: { nudge: { lastPerMessageNudgeTokens: 0, lastNudgeShownTokens: 0,
          baselineTokens: 0, anchors: {}, lastShownByTier: {} }, stats: { tokensCompressed: 0, compressionCount: 0 },
          nextBlockId: 1, nextRunId: 1 },
        roots: {}, originalCount: 0, blockCount: 0, foldCount: 0, ccrCount: 0,
        nextMessageRef: 1, kernelRoot: hash({ deleted: true, key: previous.key }),
        stateGeneration: previous.stateGeneration + 1, ownerEpoch: 0, deadRefOrderVersion: 1,
      };
      const saved = await store.put(SESSIONS, working.stored.id, tombstone, working.stored.revision);
      working.stored.revision = saved.revision;
      working.stored.value = saved.value;
      working.stored.updatedAt = saved.updatedAt;
      for (const collection of ['context.archive.pages', 'context.archive.blocks']) {
        for (const record of await store.list<{ sessionKey?: string }>(collection)) {
          if (record.value.sessionKey === working.session.key) await store.remove(collection, record.id, record.revision);
        }
      }
      working.roots = {};
      working.originalRefs.clear(); working.blockHeads.clear();
    },
  };
  return repository;
}
