import { NexusError, type NexusStore } from '../../ports/contracts.js';
import type { AbsorbRecord, CoreMessage } from '../../../vendor/acp-kernel/src/types.js';
import type { StoredEntry } from '../../../vendor/acp-kernel/src/content-store.js';
import type {
  IndexedArchiveFacts, IndexedBlockFacts, IndexedBlockHeader, IndexedCarrierFate,
  IndexedCoverageKind, IndexedIdMatch,
} from '../../../vendor/acp-kernel/src/indexed-types.js';
import { BLOCKED_REF, indexToRef, orderedRefPair, refToIndex } from '../../../vendor/acp-kernel/src/refs.js';
import type { ArchiveIndexRoot, ArchivePages } from './archive-pages.js';
import { deadRefNumber, deadRefOrderKey, deadRefOrderNumber } from './archive-types.js';
import type { ArchiveBlockHead, ArchiveChildSelector, ArchiveClaim, ArchiveOwnerNode, ArchiveWorking } from './archive-types.js';

const HASH_ROOT = /^h_([0-9a-f]{16})(?:_\d+)?(?:#.*)?$/;
const SUMMARY_PREFIX = 'acp_summary_';
const KINDS: readonly IndexedCoverageKind[] = ['direct', 'effective', 'inherited'];
const base = (id: string): string => {
  const at = id.indexOf('#');
  return at > 0 ? id.slice(0, at) : id;
};
const suffixKey = (root: string, suffix: number): string => `${root}\0${String(suffix).padStart(16, '0')}`;

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new NexusError('ARCHIVE_FACT_INVALID', message, details);
}
function missing(kind: string, id: string): never {
  throw new NexusError('ARCHIVE_FACT_MISSING', `Unprepared archive ${kind}: ${id}`);
}
function count(value: unknown, description: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`Invalid archive ${description}`);
  return value as number;
}
function header(head: ArchiveBlockHead): IndexedBlockHeader {
  return {
    blockId: head.blockId, runId: head.runId, tier: head.tier, topic: head.topic,
    summary: head.summary, compressedTokens: head.compressedTokens, createdAt: head.createdAt,
    survivedCount: head.survivedCount, generation: head.generation, active: head.active,
    expanded: head.expanded, restoredInline: head.restoredInline, durationMs: head.durationMs,
    compressCallId: head.compressCallId, startRef: head.startRef, endRef: head.endRef,
  };
}

interface SuffixInterval { root: string; start: number; end: number }
interface OwnerFacts { active: boolean; inactive: boolean; candidates: readonly string[] }
interface CoverageFacts {
  direct: { exact: Map<string, number>; base: Map<string, number> };
  effective: { exact: Map<string, number>; base: Map<string, number> };
  inherited: { exact: Map<string, number>; base: Map<string, number> };
}
const emptyCoverage = (): CoverageFacts => ({
  direct: { exact: new Map(), base: new Map() },
  effective: { exact: new Map(), base: new Map() },
  inherited: { exact: new Map(), base: new Map() },
});

/**
 * Prepare only the finite current invocation's evidence. Historical membership
 * stays behind immutable indexes; synchronous kernel lookups cannot trigger I/O.
 */
export async function prepareArchiveFacts(
  _store: NexusStore,
  pages: ArchivePages,
  working: ArchiveWorking,
  messages: CoreMessage[],
  extraBlockIds: string[] = [],
): Promise<IndexedArchiveFacts> {
  const roots = structuredClone(working.roots);
  const state = working.session.state;
  // Protection has no numeric inverse. Older projections could accidentally
  // expose their last protected id under this sentinel.
  delete state.messageRefs.byRef[BLOCKED_REF];
  const heads = new Map<string, ArchiveBlockHead | undefined>();
  const blocks = new Map<string, IndexedBlockFacts | undefined>();
  const coverage = new Map<string, CoverageFacts>();
  const candidates = new Set<string>();
  const claims = new Map<string, boolean>();
  const ownerFacts = new Map<string, OwnerFacts>();
  const dead = new Map<string, boolean>();
  const suffixes = new Map<string, Map<number, number>>();
  const ancestors = new Map<string, readonly string[]>();
  const byCall = new Map<string, readonly string[]>();
  const preparedCalls = new Set<string>();
  const loaded = new Map<string, Map<string, Promise<unknown>>>();
  const projectedBlocks = new Set(state.blocks.map(block => block.blockId));
  if (!Number.isSafeInteger(working.nextMessageRef) || working.nextMessageRef < 1) {
    invalid('Invalid archive next-ref counter');
  }

  const get = async <T>(root: ArchiveIndexRoot | undefined, key: string): Promise<T | undefined> => {
    if (!root) return undefined;
    let cache = loaded.get(root.pageId);
    if (!cache) { cache = new Map(); loaded.set(root.pageId, cache); }
    let value = cache.get(key);
    if (!value) { value = pages.get(root, key); cache.set(key, value); }
    return await value as T | undefined;
  };
  const addCandidate = (id: string | undefined): void => {
    if (typeof id !== 'string' || !id) return;
    candidates.add(id); candidates.add(base(id));
  };
  const loadEvidenceHead = async (id: string): Promise<ArchiveBlockHead | undefined> => {
    const head = working.blockHeads.get(id) ?? await get<ArchiveBlockHead>(roots.blocks, id);
    if (head && head.blockId !== id) invalid('Archive block identity mismatch', { id });
    if (head) {
      if (head.coverageCount !== (head.coverage?.count ?? 0)) invalid('Archive coverage count differs from its root', { id });
      if (head.coverage && !head.baseCoverage || head.directCoverage && !head.directBaseCoverage
        || head.inheritedCoverage && !head.inheritedBaseCoverage) invalid('Archive base coverage count root is missing', { id });
    }
    const active = await get<unknown>(roots.activeBlocks, id);
    if (active !== undefined && active !== true) invalid('Archive active index is not a membership flag', { id });
    if (active === true && !head) invalid('Archive active index points to a missing block', { id });
    return head ? { ...head, active: active === true } : undefined;
  };
  const loadHead = async (id: string): Promise<ArchiveBlockHead | undefined> => {
    if (!heads.has(id)) {
      const head = await loadEvidenceHead(id);
      heads.set(id, head ? structuredClone(head) : undefined);
      addCandidate(`${SUMMARY_PREFIX}${id}`);
    }
    return heads.get(id);
  };
  const membershipRoot = (head: ArchiveBlockHead, kind: IndexedCoverageKind,
    match: IndexedIdMatch): ArchiveIndexRoot | undefined => {
    if (kind === 'direct') return match === 'exact' ? head.directCoverage : head.directBaseCoverage;
    if (kind === 'effective') return match === 'exact' ? head.coverage : head.baseCoverage;
    return match === 'exact' ? head.inheritedCoverage : head.inheritedBaseCoverage;
  };
  const readCoverage = async (head: ArchiveBlockHead | undefined, kind: IndexedCoverageKind,
    id: string, match: IndexedIdMatch): Promise<number> => {
    if (!head) return 0;
    const value = await get<unknown>(membershipRoot(head, kind, match), match === 'base' ? base(id) : id);
    if (value === undefined) return 0;
    if (match === 'exact') {
      if (value !== true) invalid('Exact archive coverage is not a membership flag', { blockId: head.blockId });
      return 1;
    }
    const result = count(value, 'base coverage count');
    if (result === 0) invalid('Archive base coverage contains an empty member', { blockId: head.blockId });
    return result;
  };
  const resolveComponent = async (id: string): Promise<ArchiveOwnerNode> => {
    let ownerId = id;
    const visited = new Set<string>();
    let childWeight = 0;
    while (ownerId) {
      if (visited.has(ownerId) || visited.size >= 64) invalid('Archive owner cycle or excessive depth');
      visited.add(ownerId);
      const node = await get<ArchiveOwnerNode>(roots.owners, ownerId);
      if (!node || node.id !== ownerId) invalid('Archive owner node is missing', { id: ownerId });
      const weight = count(node.historicalWeight, 'owner historical weight');
      if (weight < 1 || childWeight > 0 && weight < childWeight * 2) invalid('Archive owner violates union by weight');
      if (!node.parent) return node;
      childWeight = weight;
      ownerId = node.parent;
    }
    return invalid('Archive component has no canonical root', { id });
  };
  const loadOwner = async (id: string): Promise<OwnerFacts> => {
    const normalized = base(id);
    const previous = ownerFacts.get(normalized);
    if (previous) return previous;
    const claim = await get<ArchiveClaim>(roots.claims, normalized);
    if (claim !== undefined && (!claim || typeof claim.firstBlockId !== 'string')) {
      invalid('Archive claim has no exact first-block evidence');
    }
    let inactive = false;
    let active = false;
    const verified: string[] = [];
    // Per base, visit each matching block once and prune selector subtrees
    // without that base. Dense DAG cost includes the true matching edges E,
    // as well as matching blocks K and indexed point/selector lookups.
    const visited = new Map<string, boolean>();
    const visiting = new Set<string>();
    const inspectCoverage = async (blockId: string): Promise<boolean> => {
      if (visited.has(blockId)) return visited.get(blockId)!;
      if (visiting.has(blockId)) invalid('Archive canonical child lookup contains a cycle', { blockId });
      const head = await loadEvidenceHead(blockId);
      if (!head) invalid('Archive coverage witness block is missing', { blockId });
      if (await readCoverage(head, 'effective', normalized, 'base') === 0) {
        visited.set(blockId, false);
        return false;
      }
      if (!head.active) { visited.set(blockId, true); return true; }
      active = true;
      verified.push(blockId);
      // An active historical child is part of the exact entry surface, even
      // when reached through a retirement witness rather than a top posting.
      await loadHead(blockId);
      visiting.add(blockId);
      const selectorPath = new Set<string>();
      const inspectSelector = async (key: string, depth: number): Promise<boolean> => {
        if (depth > 64 || selectorPath.has(key)) invalid('Archive child selector contains a cycle or excessive depth');
        const node = await get<ArchiveChildSelector>(head.childLookup, key);
        if (!node) invalid('Archive canonical child selector node is missing', { blockId, key });
        const member = await get<unknown>(node.bases, normalized);
        if (member === undefined) return false;
        if (member !== true && (!Number.isSafeInteger(member) || (member as number) < 1)) {
          invalid('Archive child selector base membership is invalid', { blockId, key });
        }
        selectorPath.add(key);
        let found: boolean;
        if (typeof node.childId === 'string') {
          if (node.left !== undefined || node.right !== undefined) invalid('Archive child selector leaf has branches');
          found = await inspectCoverage(node.childId);
        } else {
          if (typeof node.left !== 'string' || typeof node.right !== 'string') {
            invalid('Archive child selector branch has no children');
          }
          found = await inspectSelector(node.left, depth + 1) || await inspectSelector(node.right, depth + 1);
        }
        selectorPath.delete(key);
        return found;
      };
      const found = head.childLookup ? await inspectSelector('n', 0) : false;
      if (head.childCount > 0 && !head.childLookup) invalid('Archive canonical child lookup is missing', { blockId });
      visiting.delete(blockId);
      visited.set(blockId, found);
      return found;
    };
    const postingRoot = await get<ArchiveIndexRoot>(roots.candidates, normalized);
    // This is the exact subtree addressed by one current base, not a global
    // owner/active enumeration. All K real matching postings are prepared.
    for await (const [componentId, member] of pages.entries<unknown>(postingRoot, {
      limit: postingRoot?.count ?? 0,
    })) {
      if (member !== true) invalid('Archive candidate posting is not a membership flag');
      const component = await resolveComponent(componentId);
      if (component.id !== componentId || !component.eligibleBlockId) invalid('Archive candidate is not a current canonical component');
      const blockId = component.eligibleBlockId;
      const head = await loadHead(blockId);
      if (!head || head.expanded) invalid('Archive candidate canonical top is missing or expanded', { blockId });
      if (await readCoverage(head, 'effective', normalized, 'base') === 0) {
        invalid('Archive candidate posting has no exact base membership', { blockId });
      }
      verified.push(blockId);
      if (head.active) active = true;
      if (!inactive) inactive = await inspectCoverage(blockId);
    }
    {
      const transientRoot = await get<ArchiveIndexRoot>(roots.transientCandidates, normalized);
      for await (const [blockId, member] of pages.entries<unknown>(transientRoot, {
        limit: transientRoot?.count ?? 0,
      })) {
        if (member !== true) invalid('Archive transient candidate is not a membership flag');
        const head = await loadHead(blockId);
        if (!head?.active) invalid('Archive transient candidate is not currently active', { blockId });
        if (await readCoverage(head, 'effective', normalized, 'base') === 0) {
          invalid('Archive transient candidate has no exact base membership', { blockId });
        }
        verified.push(blockId);
        active = true;
        if (!inactive) inactive = await inspectCoverage(blockId);
      }
    }
    // Retired tops and holes keep exact block witnesses. A sticky component
    // event cannot prove current inactivity after a legal inline restore.
    // Persisted block topology/effective coverage is immutable; refold changes
    // header text/flags only, so witness membership and occupied suffixes stay
    // valid. The repository rejects a prior id's replacement coverage recipe.
    if (!inactive) {
      for await (const [blockId, member] of pages.entries<unknown>(claim?.inactiveWitnesses, {
        limit: claim?.inactiveWitnesses?.count ?? 0,
      })) {
        if (member !== true) invalid('Archive inactive witness is not a membership flag');
        inactive = await inspectCoverage(blockId);
        if (inactive) break;
      }
    }
    if (verified.length && !claim) invalid('Archive candidate source has no historical claim', { id: normalized });
    claims.set(normalized, active || inactive);
    const result: OwnerFacts = { active, inactive, candidates: Object.freeze([...new Set(verified)]) };
    ownerFacts.set(normalized, result);
    return result;
  };
  const loadRef = async (ref: string): Promise<void> => {
    if (ref === BLOCKED_REF) return;
    if (!dead.has(ref)) {
      const tombstone = await get<unknown>(roots.deadRefs, ref);
      if (tombstone !== undefined && tombstone !== true) invalid('Archive tombstone is not a membership flag');
      dead.set(ref, tombstone === true);
      if (tombstone === true && !state.deadRefs?.includes(ref)) (state.deadRefs ??= []).push(ref);
    }
    const token = await get<number>(roots.tokens, ref);
    if (token !== undefined) state.tokenSnapshot[ref] = count(token, 'token snapshot');
    const entry = await get<StoredEntry>(roots.ccr, ref);
    if (entry) working.session.contentStore.byRef[ref] = structuredClone(entry);
  };
  const projectAlias = async (id: string): Promise<void> => {
    const persisted = await get<string>(roots.rawToRef, id);
    const projected = state.messageRefs.byRaw[id];
    if (projected && persisted && projected !== persisted) invalid('Archive raw alias changed', { id });
    const ref = persisted ?? projected;
    if (!ref) return;
    state.messageRefs.byRaw[id] = ref;
    if (ref === BLOCKED_REF) return;
    const numeric = refToIndex(ref);
    if (numeric === null || indexToRef(numeric) !== ref || numeric >= working.nextMessageRef) {
      invalid('Archive alias is not an issued canonical ref', { ref });
    }
    const reverse = await get<string>(roots.refToRaw, ref);
    if (persisted && reverse === undefined) invalid('Archive numeric ref has no reverse alias', { ref });
    if (reverse !== undefined && reverse !== id) invalid('Archive ref alias changed', { ref });
    const existing = state.messageRefs.byRef[ref];
    if (existing !== undefined && existing !== id) invalid('Projected ref alias changed', { ref });
    state.messageRefs.byRef[ref] = id;
    await loadRef(ref);
  };
  const prefixBlocks = async (root: ArchiveIndexRoot | undefined, prefix: string): Promise<readonly string[]> => {
    const found: string[] = [];
    for await (const [key, id] of pages.entries<string>(root, {
      from: prefix, to: `${prefix.slice(0, -1)}\x01`, limit: root?.count ?? 0,
    })) {
      if (!key.startsWith(prefix) || typeof id !== 'string') invalid('Invalid archive carrier index');
      if (!await loadHead(id)) invalid('Archive carrier points to a missing block', { id });
      found.push(id);
    }
    return Object.freeze([...new Set(found)]);
  };
  for (const message of messages) addCandidate(message.id);
  for (const id of Object.keys(state.messageRefs.byRaw)) addCandidate(id);
  for (const id of Object.values(state.messageRefs.byRef)) addCandidate(id);
  for (const block of state.blocks) {
    await loadHead(block.blockId);
    // These arrays are already bounded current projections, never the archive
    // head's historical direct/effective lists.
    for (const id of block.directMessageIds) addCandidate(id);
    for (const id of block.effectiveMessageIds) addCandidate(id);
  }
  for (const message of messages) {
    if (message.id?.startsWith(SUMMARY_PREFIX)) await loadHead(message.id.slice(SUMMARY_PREFIX.length));
    if (message.summaryOfBlockId) await loadHead(message.summaryOfBlockId);
    if (message.toolCallId) {
      const absorbed = await get<AbsorbRecord>(roots.absorbed, message.toolCallId);
      if (absorbed && !state.absorbed?.some(record => record.toolCallId === absorbed.toolCallId)) {
        (state.absorbed ??= []).push(structuredClone(absorbed));
        addCandidate(absorbed.callMessageId); addCandidate(absorbed.resultMessageId);
      }
    }
    // The product's config() fixes the same pure predicate to the canonical
    // bare name. Arbitrary tools may reuse call ids and must not enumerate
    // unrelated historical carriers. A different unprepared predicate fails
    // through ARCHIVE_FACT_MISSING instead of returning fabricated evidence.
    if (message.contentType !== 'tool-call' || message.toolName !== 'compress' || !message.toolCallId) continue;
    if (!preparedCalls.has(message.toolCallId)) {
      byCall.set(message.toolCallId, await prefixBlocks(roots.carriers, `${message.toolCallId}\0`));
      preparedCalls.add(message.toolCallId);
    }
  }
  for (const value of extraBlockIds) {
    const block = /^b0*(\d+)$/i.exec(value.trim());
    if (block) { await loadHead(`b${Number(block[1])}`); continue; }
    const numeric = refToIndex(value);
    if (numeric === null) continue;
    const canonical = indexToRef(numeric);
    const rawId = await get<string>(roots.refToRaw, canonical) ?? state.messageRefs.byRef[canonical];
    if (rawId) {
      addCandidate(rawId);
      state.messageRefs.byRef[canonical] = rawId;
    }
    await loadRef(canonical);
  }

  // Owner lookup may expose an inactive top block eligible for resurrection.
  // The finite candidate set can grow only by one summary alias per such head.
  const ownerPrepared = new Set<string>();
  for (const id of candidates) {
    const normalized = base(id);
    if (ownerPrepared.has(normalized)) continue;
    ownerPrepared.add(normalized);
    await loadOwner(normalized);
  }

  // Reproduce the kernel's bounded live/prior exclusion walk. Each archived
  // occupied run is skipped with rank/at; no historical integer is enumerated.
  const nextSuffix = async (root: string, start: number): Promise<number> => {
    if (!Number.isSafeInteger(start) || start < 1) invalid('Invalid suffix request');
    let prepared = suffixes.get(root);
    if (!prepared) { prepared = new Map(); suffixes.set(root, prepared); }
    if (prepared.has(start)) return prepared.get(start)!;
    const key = suffixKey(root, start);
    const rank = await pages.rank(roots.gaps, key);
    const left = rank > 0 ? await pages.at<SuffixInterval>(roots.gaps, rank - 1) : undefined;
    const right = await pages.at<SuffixInterval>(roots.gaps, rank);
    const validate = (entry: [string, SuffixInterval] | undefined): SuffixInterval | undefined => {
      if (!entry) return undefined;
      const interval = entry[1];
      if (typeof interval?.root !== 'string' || !Number.isSafeInteger(interval.start)
        || !Number.isSafeInteger(interval.end) || interval.start < 1 || interval.end < interval.start
        || entry[0] !== suffixKey(interval.root, interval.start)) invalid('Invalid archive suffix interval');
      return interval;
    };
    const before = validate(left);
    const after = validate(right);
    let available = start;
    if (before?.root === root && before.end >= start) available = before.end + 1;
    else if (after?.root === root && after.start === start) available = after.end + 1;
    if (!Number.isSafeInteger(available)) invalid('Archive suffix space exhausted');
    prepared.set(start, available);
    return available;
  };
  const activeClaim = async (id: string): Promise<boolean> => {
    if ((await loadOwner(id)).active) return true;
    // Explicit summaries and carriers can address an entry-active header
    // independently of its ordinary raw candidate posting.
    for (const head of heads.values()) {
      if (head?.active && await readCoverage(head, 'effective', id, 'base') > 0) return true;
    }
    return false;
  };
  const prepareSuffixes = async (): Promise<void> => {
    if (!state.lastPassIds) return;
    const prior = new Set(state.lastPassIds);
    const groups = new Map<string, CoreMessage[]>();
    for (const message of messages) {
      if (typeof message.id !== 'string') continue;
      const match = HASH_ROOT.exec(message.id);
      if (!match) continue;
      const root = `h_${match[1]}`;
      let group = groups.get(root);
      if (!group) { group = []; groups.set(root, group); }
      group.push(message);
    }
    for (const [root, group] of groups) {
      const entryClaims = new Map<string, { active: boolean; inactive: boolean }>();
      for (const message of group) {
        const normalized = base(message.id);
        if (!entryClaims.has(normalized)) entryClaims.set(normalized, {
          active: await activeClaim(normalized), inactive: (await loadOwner(normalized)).inactive,
        });
      }
      if (![...entryClaims.values()].some(fact => fact.active || fact.inactive)) continue;
      const continues = group.some(message => prior.has(message.id));
      const live = new Set(group.map(message => base(message.id)));
      let cursor = 1;
      for (const message of group) {
        const entry = entryClaims.get(base(message.id))!;
        if (prior.has(message.id) || !entry.active && !(entry.inactive && continues)) continue;
        for (;;) {
          cursor = await nextSuffix(root, cursor);
          const candidate = `${root}_${cursor}`;
          addCandidate(candidate);
          const owner = await loadOwner(candidate);
          if (!live.has(candidate) && !prior.has(candidate) && !await activeClaim(candidate)
            && !owner.inactive && !claims.get(candidate)) break;
          cursor++;
          if (!Number.isSafeInteger(cursor)) invalid('Archive suffix space exhausted');
        }
        const hash = message.id.indexOf('#');
        const minted = `${root}_${cursor}${hash > 0 ? message.id.slice(hash) : ''}`;
        addCandidate(minted);
        await loadOwner(minted);
        live.add(base(minted));
        cursor++;
      }
    }
  };

  // Address each exact block's reverse canonical postings. Independent DAG
  // branches remain independent candidates; raw coverage never proves lineage.
  const prepareAncestors = async (id: string): Promise<void> => {
    if (ancestors.has(id)) return;
    const postingRoot = await get<ArchiveIndexRoot>(roots.lineageCandidates, id);
    const matching = new Map<string, number>();
    const addAncestor = async (head: ArchiveBlockHead): Promise<void> => {
      const residual = await get<number>(head.lineageDistances, id);
      const offset = head.lineageDistanceOffset;
      if (!Number.isSafeInteger(residual) || !Number.isSafeInteger(offset)) {
        invalid('Archive canonical ancestry distance is missing', { id, blockId: head.blockId });
      }
      const distance = residual! + offset;
      if (!Number.isSafeInteger(distance) || distance < 1) {
        invalid('Archive canonical ancestry distance is invalid', { id, blockId: head.blockId });
      }
      matching.set(head.blockId, distance);
    };
    for await (const [componentId, member] of pages.entries<unknown>(postingRoot, {
      limit: postingRoot?.count ?? 0,
    })) {
      if (member !== true) invalid('Archive lineage posting is not a membership flag');
      const component = await resolveComponent(componentId);
      if (component.id !== componentId || !component.eligibleBlockId) invalid('Archive lineage candidate is not a canonical component');
      const head = await loadHead(component.eligibleBlockId);
      if (!head || head.expanded) invalid('Archive lineage canonical top is missing or expanded');
      if (id === head.blockId) continue;
      if (await get<boolean>(head.lineageCoverage, id) !== true) {
        invalid('Archive lineage posting has no exact canonical ancestry', { id, blockId: head.blockId });
      }
      await addAncestor(head);
    }
    {
      const transientRoot = await get<ArchiveIndexRoot>(roots.transientAncestors, id);
      for await (const [blockId, member] of pages.entries<unknown>(transientRoot, {
        limit: transientRoot?.count ?? 0,
      })) {
        if (member !== true) invalid('Archive transient ancestor is not a membership flag');
        const head = await loadHead(blockId);
        if (!head?.active || id === blockId) invalid('Archive transient ancestor is not currently active', { blockId });
        if (await get<boolean>(head.lineageCoverage, id) !== true) {
          invalid('Archive transient ancestor has no exact canonical ancestry', { id, blockId });
        }
        await addAncestor(head);
      }
    }
    // Keep entry-inactive tops as candidates: sync can revive them during this
    // invocation. Kernel callers filter these ids using the current headers.
    const byBlockId = (a: string, b: string): number =>
      Number(a.slice(1)) - Number(b.slice(1)) || (a < b ? -1 : a > b ? 1 : 0);
    // Residual distances plus a scalar offset preserve full BFS edge distance
    // without rescanning or shifting a historical winner's lineage.
    const nearest = [...matching.keys()].sort((a, b) => matching.get(a)! - matching.get(b)! || byBlockId(a, b));
    ancestors.set(id, Object.freeze(nearest));
  };
  for (;;) {
    const previousHeads = heads.size;
    const previousCandidates = candidates.size;
    for (const id of candidates) await loadOwner(id);
    for (const id of heads.keys()) await prepareAncestors(id);
    if (heads.size === previousHeads && candidates.size === previousCandidates) break;
  }
  // Match the exact entry-active projection, including explicitly addressed
  // transient summaries/carriers, before reproducing the kernel's remint walk.
  await prepareSuffixes();
  for (;;) {
    const previousHeads = heads.size;
    const previousCandidates = candidates.size;
    for (const id of candidates) await loadOwner(id);
    for (const id of heads.keys()) await prepareAncestors(id);
    if (heads.size === previousHeads && candidates.size === previousCandidates) break;
  }

  // Complete every finite candidate before freezing. New aliases may have CCR
  // metadata even when no historical compression block claims their base.
  for (const id of candidates) {
    await loadOwner(id);
    await projectAlias(id);
  }
  for (const ref of Object.keys(state.messageRefs.byRef)) await loadRef(ref);
  for (const ref of state.deadRefs ?? []) if (!dead.has(ref)) await loadRef(ref);
  for (const [id, head] of heads) {
    const memberships = emptyCoverage();
    for (const candidate of candidates) {
      for (const kind of KINDS) {
        memberships[kind].exact.set(candidate, await readCoverage(head, kind, candidate, 'exact'));
        const normalized = base(candidate);
        if (!memberships[kind].base.has(normalized)) {
          memberships[kind].base.set(normalized, await readCoverage(head, kind, normalized, 'base'));
        }
      }
    }
    coverage.set(id, memberships);
    if (!head) { blocks.set(id, undefined); continue; }
    const consumed = await get<unknown>(roots.parents, id);
    if (consumed !== undefined && consumed !== true) {
      invalid('Invalid canonical parent index', { id });
    }
    let span: { startRef: string; endRef: string } | undefined;
    // This is the effective-coverage fallback. The kernel's display helper
    // separately prefers the requested numeric range in header.start/end.
    if (head.coverageRefs?.count) {
      const first = await pages.at<string>(head.coverageRefs, 0);
      const last = await pages.at<string>(head.coverageRefs, head.coverageRefs.count - 1);
      if (!first || !last) invalid('Archive coverage ref endpoints are missing', { id });
      if (refToIndex(first[1]) !== null && refToIndex(last[1]) !== null) {
        const pair = orderedRefPair(first[1], last[1]);
        span = { startRef: pair[0], endRef: pair[1] };
      } else invalid('Archive coverage ref endpoint is invalid', { id });
    }
    const facts: IndexedBlockFacts = {
      header: Object.freeze(header(head)),
      directCount: count(head.directCoverage?.count ?? 0, 'direct coverage count'),
      effectiveCount: count(head.coverageCount, 'effective coverage count'),
      childCount: count(head.childCount, 'canonical child count'), consumed: consumed === true,
      ...(span ? { refSpan: Object.freeze(span) } : {}),
    };
    blocks.set(id, Object.freeze(facts));
    working.blockHeads.set(id, structuredClone(head));
    const normalizedCandidates = [...candidates];
    const projection = {
      ...header(head),
      directMessageIds: normalizedCandidates.filter(candidate => memberships.direct.exact.get(candidate)! > 0),
      effectiveMessageIds: normalizedCandidates.filter(candidate => memberships.effective.exact.get(candidate)! > 0),
      directBlockIds: [],
    };
    if (projectedBlocks.has(id)) {
      const position = state.blocks.findIndex(block => block.blockId === id);
      state.blocks[position] = projection;
    } else { state.blocks.push(projection); projectedBlocks.add(id); }
  }

  // Current endpoints partition the numeric ref space. One witness in each
  // open gap proves every interval whose endpoints were prepared, while point
  // counts retain cold aliases of a projected ref (m1 and m00001, for example).
  // Neither evidence form hydrates historical raw tombstones into the state.
  const intervalAnchors = new Set<number>();
  const addIntervalAnchor = (ref: string | undefined): void => {
    if (ref === undefined) return;
    const numeric = deadRefNumber(ref);
    if (numeric !== null) intervalAnchors.add(numeric);
  };
  for (const ref of Object.keys(state.messageRefs.byRef)) addIntervalAnchor(ref);
  for (const ref of Object.values(state.messageRefs.byRaw)) addIntervalAnchor(ref);
  for (const ref of dead.keys()) addIntervalAnchor(ref);
  for (const value of extraBlockIds) addIntervalAnchor(value);
  for (const head of heads.values()) {
    addIntervalAnchor(head?.startRef);
    addIntervalAnchor(head?.endRef);
  }
  for (const block of blocks.values()) {
    addIntervalAnchor(block?.refSpan?.startRef);
    addIntervalAnchor(block?.refSpan?.endRef);
  }
  // assignRefs runs once and allocates at most one ref per input message.
  // Existing future inverse slots can only skip this finite loaded set.
  const futureInverseSlots = Object.keys(state.messageRefs.byRef).filter(ref => {
    const numeric = refToIndex(ref);
    return numeric !== null && indexToRef(numeric) === ref && numeric >= working.nextMessageRef;
  }).length;
  const potentialRefEnd = working.nextMessageRef + messages.length + futureInverseSlots;
  if (!Number.isSafeInteger(potentialRefEnd)) invalid('Archive current ref allocation bound is invalid');
  for (let numeric = working.nextMessageRef; numeric <= potentialRefEnd; numeric++) intervalAnchors.add(numeric);

  const storedHead = working.stored.value;
  if (storedHead.deadRefOrderVersion !== 1
    && (storedHead.roots.deadRefs !== undefined || storedHead.roots.deadRefOrder !== undefined)) {
    missing('numeric dead-ref index', working.session.key);
  }
  const orderedAnchors = [...intervalAnchors].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const numericDeadCounts = new Map<number, number>();
  const coldDeadWitnesses: number[] = [];
  const orderCount = (value: unknown): number => {
    if (value === undefined) return 0;
    const result = count(value, 'numeric tombstone alias count');
    if (result < 1) invalid('Archive numeric tombstone has no aliases');
    return result;
  };
  for (const numeric of orderedAnchors) {
    numericDeadCounts.set(numeric, orderCount(await get<unknown>(roots.deadRefOrder, deadRefOrderKey(numeric))));
  }
  if (roots.deadRefOrder) {
    for (let position = 1; position < orderedAnchors.length; position++) {
      const left = orderedAnchors[position - 1];
      const right = orderedAnchors[position];
      if (right - left <= 1) continue;
      // All stored order keys have exactly 16 hex characters. Appending NUL
      // gives the strict successor insertion rank without rounding left + 1.
      const rank = await pages.rank(roots.deadRefOrder, `${deadRefOrderKey(left)}\0`);
      const entry = await pages.at<unknown>(roots.deadRefOrder, rank);
      if (!entry) continue;
      if (orderCount(entry[1]) < 1) invalid('Archive numeric tombstone successor has no aliases');
      const numeric = deadRefOrderNumber(entry[0]);
      if (!(numeric > left)) invalid('Archive numeric tombstone successor is not ordered');
      if (numeric < right) coldDeadWitnesses.push(numeric);
    }
  }
  const entryDeadAliases = new Set(state.deadRefs ?? []);
  const loadedDeadCounts = new Map<number, number>();
  for (const ref of entryDeadAliases) {
    if (dead.get(ref) !== true) continue;
    const numeric = deadRefNumber(ref);
    if (numeric !== null) loadedDeadCounts.set(numeric, (loadedDeadCounts.get(numeric) ?? 0) + 1);
  }
  for (const [numeric, loadedCount] of loadedDeadCounts) {
    if ((numericDeadCounts.get(numeric) ?? 0) < loadedCount) {
      invalid('Archive numeric tombstone count omits a loaded alias');
    }
  }
  const firstAfter = (values: readonly number[], target: number): number => {
    let lo = 0;
    let hi = values.length;
    while (lo < hi) {
      const middle = lo + Math.floor((hi - lo) / 2);
      if (values[middle] <= target) lo = middle + 1;
      else hi = middle;
    }
    return lo;
  };
  const hasDeadRefBetween = (lo: number, hi: number, excluded: readonly string[] = []): boolean => {
    if (!(Number.isInteger(lo) || lo === Infinity) || !(Number.isInteger(hi) || hi === Infinity) || lo < 0 || hi < 0) {
      return missing('dead-ref interval', `${lo}/${hi}`);
    }
    if (hi <= lo + 1) return false;
    if (!intervalAnchors.has(lo) || !intervalAnchors.has(hi)) {
      return missing('dead-ref interval', `${lo}/${hi}`);
    }
    const excludedCounts = new Map<number, number>();
    for (const ref of new Set(excluded)) {
      if (!entryDeadAliases.has(ref)) return missing('lifted dead-ref alias', ref);
      if (dead.get(ref) !== true) continue;
      const numeric = deadRefNumber(ref);
      if (numeric !== null) excludedCounts.set(numeric, (excludedCounts.get(numeric) ?? 0) + 1);
    }
    const witness = coldDeadWitnesses[firstAfter(coldDeadWitnesses, lo)];
    if (witness !== undefined && witness < hi) return true;
    for (let position = firstAfter(orderedAnchors, lo); position < orderedAnchors.length; position++) {
      const numeric = orderedAnchors[position];
      if (!(numeric < hi)) break;
      const remaining = numericDeadCounts.get(numeric)! - (excludedCounts.get(numeric) ?? 0);
      if (remaining < 0) invalid('Archive numeric tombstone exclusions exceed its alias count');
      if (remaining > 0) return true;
    }
    return false;
  };

  const requireBlock = (id: string): IndexedBlockFacts | undefined => {
    if (!blocks.has(id)) return missing('block', id);
    return blocks.get(id);
  };
  const coverageCount = (id: string, kind: IndexedCoverageKind, candidate: string, match: IndexedIdMatch): number => {
    requireBlock(id);
    const prepared = coverage.get(id)?.[kind]?.[match];
    const key = match === 'base' ? base(candidate) : candidate;
    if (!prepared?.has(key)) return missing(`${kind}/${match} coverage`, `${id}/${candidate}`);
    return prepared.get(key)!;
  };
  const carrierBlocks = (callId: string | undefined, _rangeKeys: readonly string[], bareName: boolean): readonly IndexedBlockFacts[] => {
    if (!callId) return Object.freeze([]);
    if (!preparedCalls.has(callId)) return missing('carrier call', callId);
    if (!bareName) return missing('carrier predicate', callId);
    // Bare-name carrier identity is solely its call id. Filtered args may
    // change quoted ranges without changing the complete prepared call set.
    const ids = new Set(byCall.get(callId));
    return Object.freeze([...ids].map(id => requireBlock(id)!));
  };
  const carrierDetails = (callId: string | undefined, rangeKeys: readonly string[], bareName: boolean): {
    fate: IndexedCarrierFate; liveRanges: readonly string[] | undefined;
  } => {
    const relevant = carrierBlocks(callId, rangeKeys, bareName);
    if (!callId) return { fate: 'orphan', liveRanges: Object.freeze([]) };
    const live = (facts: IndexedBlockFacts) => facts.header.active && !facts.consumed && !facts.header.expanded;
    const sameCall = relevant.filter(facts => facts.header.compressCallId === callId);
    const sameCallActive = sameCall.filter(live);
    let fate: IndexedCarrierFate = 'orphan';
    if (sameCallActive.length) fate = 'active';
    else if (sameCall.length) fate = 'inactive';
    if (sameCallActive.some(facts => facts.header.startRef === undefined || facts.header.endRef === undefined)) {
      return { fate, liveRanges: undefined };
    }
    const liveRanges = new Set<string>();
    for (const facts of sameCallActive) liveRanges.add(`${facts.header.startRef}::${facts.header.endRef}`);
    return { fate, liveRanges: Object.freeze([...liveRanges]) };
  };
  const facts: IndexedArchiveFacts = {
    storageMode: 'indexed-v1',
    stamp: Object.freeze({
      sessionKey: working.session.key,
      headRevision: working.stored.revision,
      archiveRoot: working.stored.value.kernelRoot,
    }),
    nextRefIndex: working.nextMessageRef,
    totalBlockCount: working.roots.blocks?.count ?? 0,
    block: requireBlock,
    coverageCount,
    contains: (id, kind, candidate, match) => coverageCount(id, kind, candidate, match) > 0,
    intersect: (id, kind, values, match) => values.filter(candidate => coverageCount(id, kind, candidate, match) > 0),
    inactiveClaim: id => ownerFacts.get(base(id))?.inactive ?? missing('inactive claim', id),
    claimed: id => claims.get(base(id)) ?? missing('claim', id),
    nextAvailableSuffix: (root, start) => suffixes.get(root)?.get(start) ?? missing('suffix gap', `${root}/${start}`),
    knownBlock: id => requireBlock(id) !== undefined,
    activeAncestors: id => ancestors.get(id) ?? missing('canonical ancestors', id),
    carrierBlocks,
    carrierFate: (callId, ranges, bareName) => carrierDetails(callId, ranges, bareName).fate,
    carrierLiveRanges: (callId, ranges, bareName) => carrierDetails(callId, ranges, bareName).liveRanges,
    deadRef: ref => dead.get(ref) ?? missing('dead ref', ref),
    hasDeadRefBetween,
  };
  return Object.freeze(facts);
}
