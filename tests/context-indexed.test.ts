import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContextArchive } from '../src/domain/context/archive.js';
import type { ContextArchiveHead } from '../src/domain/context/archive-types.js';
import type { ContextSession } from '../src/domain/context/types.js';
import { AtomicStore } from '../src/domain/storage/index.js';
import type { StoredRecord } from '../src/ports/contracts.js';
import { buildCompressibleRanges } from '../vendor/acp-kernel/src/recommend.js';
import {
  activeAncestorIds, baseIdOf, bindIndexedArchive, countMessageTokens, createContentStore, createCore,
  createInitialState, defaultConfig, highestUsedIndex, indexToRef,
  markBlockRestoredInline, refToIndex, renderNudgeText, resolveBoundaries, summaryMessageId, syncBlocks,
  type CompressionBlock, type CompressionState, type CoreMessage, type NudgeDecision,
} from '../vendor/acp-kernel/src/index.js';
import type {
  IndexedArchiveFacts, IndexedBlockFacts, IndexedCoverageKind, IndexedIdMatch,
  IndexedProcessTurnInput, IndexedStateDelta, IndexedWorkingState,
} from '../vendor/acp-kernel/src/indexed-types.js';

/**
 * Small, independent full-state oracle. The tests intentionally hydrate facts
 * from their fixture arrays; the archive-scale runner separately measures real
 * indexed storage. No production path may use this test-only archive builder.
 */
function factsFor(state: CompressionState): IndexedArchiveFacts {
  const blocks = new Map(state.blocks.map(block => [block.blockId, structuredClone(block)]));
  const consumed = new Set(state.blocks.flatMap(block => block.directBlockIds));
  const inactive = new Set(state.blocks.filter(block => !block.active)
    .flatMap(block => block.effectiveMessageIds.map(baseIdOf)));
  const claimed = new Set(state.blocks.flatMap(block => block.effectiveMessageIds.map(baseIdOf)));
  const dead = new Set(state.deadRefs ?? []);
  const spanFor = (block: CompressionBlock) => {
    const stored = [block.startRef, block.endRef];
    const refs = stored.every(ref => typeof ref === 'string' && /^m\d+$/.test(ref))
      ? stored as string[] : block.effectiveMessageIds.map(id => state.messageRefs.byRaw[id])
        .filter(ref => typeof ref === 'string' && /^m\d+$/.test(ref));
    if (!refs.length) return undefined;
    const sorted = [...refs].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    return { startRef: sorted[0], endRef: sorted[sorted.length - 1] };
  };
  const ancestorsFor = (blockId: string) => {
    const result: string[] = [], seen = new Set([blockId]);
    let frontier = [blockId];
    while (frontier.length) {
      const parents = state.blocks.filter(block => !seen.has(block.blockId)
        && block.directBlockIds.some(child => frontier.includes(child)));
      for (const parent of parents) {
        seen.add(parent.blockId);
        // Facts retain inactive canonical tops that this invocation's sync
        // can revive; the runtime filters their current active headers.
        if (parent.active || !consumed.has(parent.blockId) && !parent.expanded) result.push(parent.blockId);
      }
      frontier = parents.map(block => block.blockId);
    }
    return result;
  };
  const values = (blockId: string, kind: IndexedCoverageKind): string[] => {
    const block = blocks.get(blockId);
    if (!block) return [];
    if (kind === 'direct') return block.directMessageIds;
    if (kind === 'effective') return block.effectiveMessageIds;
    return [...new Set(block.directBlockIds.flatMap(childId => values(childId, 'effective')))];
  };
  const contains = (blockId: string, kind: IndexedCoverageKind, id: string, match: IndexedIdMatch) =>
    values(blockId, kind).some(candidate => match === 'base' ? baseIdOf(candidate) === baseIdOf(id) : candidate === id);
  return Object.freeze({
    storageMode: 'indexed-v1' as const,
    totalBlockCount: state.blocks.length,
    stamp: Object.freeze({ sessionKey: 'independent-indexed-kernel-oracle', headRevision: 7, archiveRoot: 'fixture-root-7' }),
    nextRefIndex: highestUsedIndex(state.messageRefs) + 1,
    block(blockId: string): IndexedBlockFacts | undefined {
      const block = blocks.get(blockId);
      if (!block) return undefined;
      const { directMessageIds, effectiveMessageIds, directBlockIds, ...header } = block;
      return { header: structuredClone(header), directCount: directMessageIds.length,
        effectiveCount: effectiveMessageIds.length, childCount: directBlockIds.length,
        consumed: consumed.has(blockId), refSpan: spanFor(block) };
    },
    contains,
    coverageCount(blockId: string, kind: IndexedCoverageKind, id: string, match: IndexedIdMatch) {
      return values(blockId, kind).filter(candidate => match === 'base' ? baseIdOf(candidate) === baseIdOf(id) : candidate === id).length;
    },
    intersect(blockId: string, kind: IndexedCoverageKind, candidates: readonly string[], match: IndexedIdMatch) {
      return candidates.filter(id => contains(blockId, kind, id, match));
    },
    inactiveClaim(id: string) { return inactive.has(baseIdOf(id)); },
    claimed(id: string) { return claimed.has(baseIdOf(id)); },
    nextAvailableSuffix(root: string, start: number) {
      let candidate = start;
      while (claimed.has(`${root}_${candidate}`)) candidate++;
      return candidate;
    },
    knownBlock(blockId: string) { return blocks.has(blockId); },
    carrierFate(callId: string | undefined, rangeKeys: readonly string[], bareName: boolean) {
      if (callId && state.blocks.some(block => block.active && block.compressCallId === callId)) return 'active';
      if (callId && state.blocks.some(block => block.compressCallId === callId)) return 'inactive';
      if (!callId || bareName) return 'orphan';
      const hasRange = (block: CompressionBlock) => Boolean(block.compressCallId && block.startRef && block.endRef
        && rangeKeys.includes(`${block.startRef}::${block.endRef}`));
      if (state.blocks.some(block => block.active && hasRange(block))) return 'active';
      if (state.blocks.some(hasRange)) return 'inactive';
      return 'orphan';
    },
    carrierLiveRanges(callId: string | undefined, rangeKeys: readonly string[], bareName: boolean) {
      const active = state.blocks.filter(block => block.active && block.compressCallId
        && (bareName ? block.compressCallId === callId : block.compressCallId === callId
          || Boolean(block.startRef && block.endRef && rangeKeys.includes(`${block.startRef}::${block.endRef}`))));
      if (active.some(block => block.compressCallId === callId && (!block.startRef || !block.endRef))) return undefined;
      return [...new Set(active.filter(block => block.startRef && block.endRef).map(block => `${block.startRef}::${block.endRef}`))];
    },
    carrierBlocks(callId: string | undefined, rangeKeys: readonly string[], bareName: boolean) {
      return state.blocks.filter(block => block.compressCallId
        && (block.compressCallId === callId || !bareName && block.startRef && block.endRef
          && rangeKeys.includes(`${block.startRef}::${block.endRef}`)))
        .map(block => {
          const { directMessageIds, effectiveMessageIds, directBlockIds, ...header } = block;
          return { header: structuredClone(header), directCount: directMessageIds.length,
            effectiveCount: effectiveMessageIds.length, childCount: directBlockIds.length,
            consumed: consumed.has(block.blockId), refSpan: spanFor(block) };
        });
    },
    activeAncestors(blockId: string) { return ancestorsFor(blockId); },
    deadRef(ref: string) { return dead.has(ref); },
    hasDeadRefBetween(lo: number, hi: number, excluded: readonly string[] = []) {
      return [...dead].some(ref => {
        const match = /^m(\d+)$/i.exec(ref);
        if (!match || excluded.includes(ref)) return false;
        const value = Number(match[1]);
        return value > lo && value < hi;
      });
    },
  });
}

function workingFor(state: CompressionState, messages: CoreMessage[], extraIds: string[] = [], loadedBlockIds?: string[]): IndexedWorkingState {
  const ids = new Set([...messages.map(message => message.id), ...extraIds]);
  const byRaw = Object.fromEntries(Object.entries(state.messageRefs.byRaw).filter(([id]) => ids.has(id)));
  const refs = new Set(Object.values(byRaw));
  return {
    ...structuredClone(state), indexedProjection: 'indexed-v1',
    blocks: state.blocks.filter(block => !loadedBlockIds || loadedBlockIds.includes(block.blockId)).map(block => ({
      ...structuredClone(block),
      directMessageIds: block.directMessageIds.filter(id => ids.has(id)),
      effectiveMessageIds: block.effectiveMessageIds.filter(id => ids.has(id)),
      directBlockIds: [...block.directBlockIds],
    })),
    messageRefs: { byRaw, byRef: Object.fromEntries(Object.entries(state.messageRefs.byRef).filter(([ref]) => refs.has(ref))) },
    tokenSnapshot: Object.fromEntries(Object.entries(state.tokenSnapshot).filter(([ref]) => refs.has(ref))),
    deadRefs: state.deadRefs?.filter(ref => refs.has(ref)),
    absorbed: (state.absorbed ?? []).filter(record => messages.some(message => message.toolCallId === record.toolCallId)),
  };
}

const policy = defaultConfig(100_000, {
  compress: { minCompressRange: 0, minSummaryLength: 1, maxSummaryLength: 4000 },
  preserveRecentMessages: 0, preserveRecentTokens: 0,
  tiers: { enabled: true, tier2Trigger: 2, tier3Trigger: 3 },
});
const text = (id: string, value = id, role: CoreMessage['role'] = 'assistant'): CoreMessage =>
  ({ id, role, contentType: 'text', text: value });
const pinned = text('fixture-objective', 'Keep exact original source data and permanent aliases.', 'user');
const tokenCount = (messages: CoreMessage[]) => messages.reduce((sum, message) => sum + countMessageTokens(message), 0);
function addRefs(state: CompressionState, ids: string[]): CompressionState {
  const next = structuredClone(state);
  let cursor = highestUsedIndex(next.messageRefs) + 1;
  for (const id of ids) if (!next.messageRefs.byRaw[id]) {
    const ref = indexToRef(cursor++);
    next.messageRefs.byRaw[id] = ref; next.messageRefs.byRef[ref] = id;
  }
  return next;
}
function block(blockId: string, ids: string[], extra: Partial<CompressionBlock> = {}): CompressionBlock {
  return {
    blockId, runId: `r${blockId.slice(1)}`, tier: 1,
    summary: `Fixture summary ${blockId}; original bytes stay in their permanent source objects.`,
    directMessageIds: [...ids], effectiveMessageIds: [...ids], directBlockIds: [],
    compressedTokens: 400, createdAt: 1_700_000_000_000, survivedCount: 0, generation: 'young', active: true,
    ...extra,
  };
}
function withBlocks(blocks: CompressionBlock[], ids: string[]): CompressionState {
  const state = addRefs(createInitialState(), [pinned.id, ...ids]);
  state.blocks = structuredClone(blocks);
  state.nextBlockId = Math.max(0, ...blocks.map(value => Number(value.blockId.slice(1)))) + 1;
  state.nextRunId = state.nextBlockId;
  return state;
}
function blockHeader(value: CompressionBlock) {
  const { directMessageIds: _d, effectiveMessageIds: _e, directBlockIds: _c, createdAt: _clock, ...header } = value;
  return header;
}
function applyDelta(before: CompressionState, delta: IndexedStateDelta): CompressionState {
  const deadRefs = [...new Set([...(before.deadRefs ?? []).filter(ref => !delta.deadRefs.lift.includes(ref)), ...delta.deadRefs.add])];
  const result: CompressionState = { ...structuredClone(before), ...structuredClone(delta.head),
    messageRefs: {
      byRaw: { ...before.messageRefs.byRaw, ...delta.refs.byRaw },
      byRef: { ...before.messageRefs.byRef, ...delta.refs.byRef },
    },
    tokenSnapshot: { ...before.tokenSnapshot, ...delta.tokenSnapshot },
    absorbed: [...structuredClone(before.absorbed ?? []), ...structuredClone(delta.absorbed)],
    deadRefs: deadRefs.length ? deadRefs : undefined,
  };
  const blocks = new Map(result.blocks.map(value => [value.blockId, value]));
  if (delta.replaceActiveSet) {
    const active = new Set(delta.blocks.filter(item => item.header.active).map(item => item.header.blockId));
    for (const [id, value] of blocks) blocks.set(id, { ...value, active: active.has(id) });
  }
  for (const item of delta.blocks) {
    const old = blocks.get(item.header.blockId);
    if (old) {
      assert.equal(item.coverage, undefined, `an existing immutable coverage root must not be replaced: ${old.blockId}`);
      blocks.set(old.blockId, { ...old, ...structuredClone(item.header) });
    } else {
      assert.ok(item.coverage, `new block ${item.header.blockId} must carry an immutable coverage recipe`);
      const excluded = new Set(item.coverage.excludedMessageIds ?? []);
      const ids = [...new Set([...(item.coverage.orderedPrefixMessageIds
        ?? [...item.coverage.directMessageIds, ...(item.coverage.additionalEffectiveMessageIds ?? [])]),
        ...item.coverage.childBlockIds.flatMap(child => {
          assert.ok(blocks.has(child), `unknown recipe child ${child}`);
          return blocks.get(child)!.effectiveMessageIds;
        })])].filter(id => !excluded.has(id));
      blocks.set(item.header.blockId, { ...structuredClone(item.header),
        directMessageIds: [...item.coverage.directMessageIds], directBlockIds: [...item.coverage.childBlockIds],
        effectiveMessageIds: ids });
    }
  }
  result.blocks = [...blocks.values()];
  return result;
}
function assertProcessParity(state: CompressionState, messages: CoreMessage[],
  overrides: Partial<Omit<IndexedProcessTurnInput, 'storageMode' | 'workingState' | 'archive' | 'messages'>> = {},
  loadedBlockIds?: string[],
  compareNudge: (indexed: NudgeDecision, full: NudgeDecision) => void = (indexed, full) => assert.deepEqual(indexed, full)) {
  const core = createCore();
  const before = structuredClone(state);
  const contentStore = overrides.contentStore ?? createContentStore();
  const input = { config: policy, tokenCount: tokenCount(messages), renderTags: 'none' as const, ...overrides,
    messages: structuredClone(messages), contentStore: structuredClone(contentStore) };
  const full = core.processTurn({ ...input, state: structuredClone(state) });
  const archive = factsFor(state);
  const indexed = core.processTurn({ ...input, messages: structuredClone(messages),
    storageMode: 'indexed-v1', workingState: workingFor(state, [...messages, ...(overrides.applyView ?? [])], [], loadedBlockIds), archive });
  const reconstructed = applyDelta(state, indexed.delta);
  assert.equal(indexed.storageMode, 'indexed-v1');
  assert.equal(Object.hasOwn(indexed, 'state'), false, 'indexed output must never look like a durable full snapshot');
  assert.deepEqual(indexed.messages, full.messages);
  const indexedNudge = indexed.nudge, fullNudge = full.nudge;
  assert.ok(indexedNudge, 'indexed process fixture must return nudge diagnostics');
  assert.ok(fullNudge, 'full process fixture must return nudge diagnostics');
  compareNudge(indexedNudge, fullNudge);
  assert.deepEqual(indexed.terminalEscape, full.terminalEscape);
  assert.equal(indexed.truncationSkipped, full.truncationSkipped);
  assert.deepEqual(indexed.contentStore, full.contentStore);
  assert.deepEqual(reconstructed.blocks.map(blockHeader), full.state.blocks.map(blockHeader));
  assert.deepEqual(indexed.workingState.lastPassIds, full.state.lastPassIds);
  assert.deepEqual(indexed.workingState.stats, full.state.stats);
  assert.deepEqual(indexed.workingState.nudge, full.state.nudge);
  assert.deepEqual(indexed.delta.stamp, archive.stamp);
  assert.ok(indexed.delta.nextRefIndex >= archive.nextRefIndex);
  for (const [id, ref] of Object.entries(indexed.workingState.messageRefs.byRaw)) {
    assert.equal(ref, full.state.messageRefs.byRaw[id]);
    if (ref !== 'BLOCKED') assert.equal(indexed.workingState.messageRefs.byRef[ref], id);
  }
  assert.deepEqual(reconstructed.messageRefs, full.state.messageRefs);
  assert.deepEqual([...(reconstructed.deadRefs ?? [])].sort(), [...(full.state.deadRefs ?? [])].sort());
  assert.deepEqual(reconstructed.absorbed, full.state.absorbed);
  assert.equal(reconstructed.nextBlockId, full.state.nextBlockId);
  assert.equal(reconstructed.nextRunId, full.state.nextRunId);
  assert.deepEqual(state, before, 'neither kernel lane may mutate the persisted input fixture');
  return { full, indexed, reconstructed };
}

async function withDeadRefArchive(deadRefs: string[],
  exercise: (repository: ReturnType<typeof createContextArchive>, store: AtomicStore,
    stored: StoredRecord<ContextArchiveHead>) => Promise<void>,
  issuedRefs: Record<string, string> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-indexed-dead-ref-boundary-'));
  try {
    const store = new AtomicStore(directory), repository = createContextArchive(store);
    const state = createInitialState(); state.deadRefs = [...deadRefs];
    state.messageRefs = { byRaw: { ...issuedRefs },
      byRef: Object.fromEntries(Object.entries(issuedRefs).map(([id, ref]) => [ref, id])) };
    const session: ContextSession = {
      schemaVersion: 1, key: 'dead-ref-boundary-fixture', sessionId: 'dead-ref-boundary-fixture',
      branchId: 'main', purpose: 'main', lane: 'main', workspaceRoot: directory,
      mode: 'auto', owner: 'nexus/acp-kernel', state, originals: [], contentStore: createContentStore(),
      epochs: { promptEpoch: 1, toolSurfaceEpoch: 1, memorySnapshotEpoch: 1,
        routeEpoch: 1, serializationEpoch: 1, compressionEpoch: 1 },
      inFlight: [], outputReserveTokens: 0, folds: [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const stored = await repository.open(session.key, () => structuredClone(session));
    await exercise(repository, store, stored);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function assertStoredDeadRefSegmentation(leftRef: string, rightRef: string, deadRefs: string[],
  split: boolean, lifted: string[] = []) {
  const endpointRefs: [string, string][] = [['range-left', leftRef], ['range-right', rightRef]];
  const issuedRefs = Object.fromEntries(endpointRefs.filter(([, ref]) => {
    const index = refToIndex(ref);
    return index !== null && indexToRef(index) === ref;
  }));
  await withDeadRefArchive(deadRefs, async (repository, _store, stored) => {
    const messages = [text('range-left', 'Left current message.'), text('range-right', 'Right current message.')];
    const state = createInitialState();
    state.messageRefs = { byRaw: { 'range-left': leftRef, 'range-right': rightRef },
      byRef: { [leftRef]: 'range-left', [rightRef]: 'range-right' } };
    state.deadRefs = deadRefs.filter(ref => !lifted.includes(ref));
    const working = await repository.hydrateWorking(stored, []);
    // Loaded exact aliases may be lifted during this invocation. Other raw
    // aliases at the same numeric position must remain cold archive witnesses.
    working.session.state.deadRefs = [...lifted];
    const facts = await repository.prepareKernel(working, [], [leftRef, rightRef]);
    const projection = workingFor(state, messages);
    projection.deadRefs = [...lifted];
    const indexedState = bindIndexedArchive(projection, facts);
    indexedState.deadRefs = [];
    const full = buildCompressibleRanges(messages, structuredClone(state), policy, new Set());
    const indexed = buildCompressibleRanges(messages, indexedState, policy, new Set());
    assert.deepEqual(indexed, full, 'real archived tombstones must preserve full-kernel range segmentation');
    assert.deepEqual(full.compressible.map(range => ({
      startRef: range.startRef, endRef: range.endRef, count: range.count, noMergeBefore: range.noMergeBefore === true,
    })), split
      ? [{ startRef: leftRef, endRef: leftRef, count: 1, noMergeBefore: false },
        { startRef: rightRef, endRef: rightRef, count: 1, noMergeBefore: true }]
      : [{ startRef: leftRef, endRef: rightRef, count: 2, noMergeBefore: false }]);
    assert.deepEqual(indexedState.deadRefs, [], 'cold aliases must not hydrate into the current tombstone projection');
  }, issuedRefs);
}

for (const fixture of [
  { name: 'crosses decimal ref width', left: 'm99998', right: 'm100001', dead: ['m100000'], split: true },
  { name: 'retains a cold leading-zero alias after exact lift', left: 'm00000', right: 'm00002',
    dead: ['m1', 'm00001'], lifted: ['m1'], split: true },
  { name: 'retains a cold case alias after exact lift', left: 'm00000', right: 'm00002',
    dead: ['m1', 'M00001'], lifted: ['m1'], split: true },
  { name: 'removes the hole when its sole raw alias is lifted', left: 'm00000', right: 'm00002',
    dead: ['m1'], lifted: ['m1'], split: false },
  { name: 'rounds an unsafe dead alias onto the live endpoint', left: 'm9007199254740992', right: 'm9007199254740996',
    dead: ['m9007199254740993'], split: false },
  { name: 'keeps an unsafe interior dead alias', left: 'm9007199254740992', right: 'm9007199254740996',
    dead: ['m9007199254740994'], split: true },
  { name: 'treats overflowed digit refs as an Infinity endpoint', left: 'm00002', right: `m${'9'.repeat(400)}`,
    dead: [`m${'8'.repeat(400)}`], split: false },
  { name: 'keeps finite dead refs below an Infinity endpoint', left: 'm00002', right: `m${'9'.repeat(400)}`,
    dead: ['m100000000000000000000'], split: true },
]) test(`indexed archive dead-ref segmentation ${fixture.name}`, async () => {
  await assertStoredDeadRefSegmentation(fixture.left, fixture.right, fixture.dead, fixture.split, fixture.lifted);
});

test('old V2 tombstones require explicit numeric-index migration and reject a stale retry', async () => {
  await withDeadRefArchive(['m100000', 'M0100000'], async (repository, store, ready) => {
    const oldHead = structuredClone(ready.value);
    delete oldHead.deadRefOrderVersion; delete oldHead.roots.deadRefOrder;
    const old = await store.put('context.sessions', ready.id, oldHead, ready.revision);
    const noCreate = (): never => { throw new Error('existing archive must not be recreated'); };
    await assert.rejects(repository.open(ready.id, noCreate), { code: 'CTX_ARCHIVE_INDEX_MIGRATION_REQUIRED' });
    await assert.rejects(repository.hydrateWorking(old, []), { code: 'CTX_ARCHIVE_INDEX_MIGRATION_REQUIRED' });
    await assert.rejects(repository.rebuildDeadRefOrder(ready.id, old.revision - 1), { code: 'REVISION_CONFLICT' });
    assert.deepEqual(await store.get<ContextArchiveHead>('context.sessions', ready.id), old,
      'stale migration must preserve the unready head revision and roots');
    const migratedRevision = await repository.rebuildDeadRefOrder(ready.id, old.revision);
    assert.equal(typeof migratedRevision, 'number');
    assert.ok(migratedRevision! > old.revision);
    const reopened = await repository.open(ready.id, noCreate);
    assert.equal(reopened.revision, migratedRevision);
    assert.equal(reopened.value.deadRefOrderVersion, 1);
    const working = await repository.hydrateWorking(reopened, []);
    const facts = await repository.prepareKernel(working, [], ['m99998', 'm100001']);
    assert.equal(facts.hasDeadRefBetween(99_998, 100_001), true);
    const full = await repository.loadFull(reopened);
    assert.deepEqual([...(full.session.state.deadRefs ?? [])].sort(), ['M0100000', 'm100000']);
    await assert.rejects(repository.rebuildDeadRefOrder(ready.id, old.revision), { code: 'REVISION_CONFLICT' });
    assert.equal(await repository.rebuildDeadRefOrder(ready.id, reopened.revision), undefined);
  });
});

for (const tier of [2, 3] as const) test(`indexed tier-${tier} nudge renders exact cold target counts from a thin projection`, () => {
  const targets = Array.from({ length: tier }, (_, index) => {
    const ids = Array.from({ length: 12 + index * 7 }, (_, source) => `tier-${tier}-cold-${index}-${source}`);
    return block(`b${index + 1}`, ids, { tier: tier === 2 ? 1 : 2,
      summary: `Distinct tier-${tier} summary ${index}. `.repeat(160) });
  });
  const state = withBlocks(targets, targets.flatMap(value => value.effectiveMessageIds));
  const messages = [pinned, ...targets.map(value => text(summaryMessageId(value.blockId), value.summary, 'system')),
    text('question', 'Continue with the selected summaries.', 'user')];
  const counts = Object.fromEntries(targets.map(value => [value.blockId, value.effectiveMessageIds.length]));
  const config = { ...policy, nudge: { ...policy.nudge, minPressureBenefitTokens: 1 } };
  const result = assertProcessParity(state, messages, { config, tokenCount: 80_000 }, undefined, (indexed, full) => {
    const headers = (decision: NudgeDecision) => ({ ...decision,
      tierTargetBlocks: decision.tierTargetBlocks?.map(value => {
        const { directMessageIds: _direct, effectiveMessageIds: _effective, directBlockIds: _children, ...header } = value;
        return header;
      }) });
    assert.equal(full.shouldInject, true); assert.equal(indexed.shouldInject, true);
    assert.equal(full.tier, tier); assert.equal(indexed.tier, tier);
    assert.deepEqual(indexed.tierTargetBlocks?.map(value => value.blockId), targets.map(value => value.blockId));
    assert.deepEqual(full.tierTargetBlockCounts, counts);
    assert.deepEqual(indexed.tierTargetBlockCounts, counts);
    assert.deepEqual(headers(indexed), headers(full), 'all nudge fields and target headers remain exact');
    assert.deepEqual(renderNudgeText(indexed), renderNudgeText(full), 'raw full and projected nudge inputs render identical guidance');
    for (const value of indexed.tierTargetBlocks ?? []) {
      assert.deepEqual(value.directMessageIds, []);
      assert.deepEqual(value.effectiveMessageIds, []);
      assert.deepEqual(value.directBlockIds, []);
    }
  });
  const nudge = result.indexed.nudge;
  assert.ok(nudge, 'selected tier fixture must return nudge diagnostics');
  assert.equal(nudge.tier, tier);
});

test('indexed turn keeps full-kernel bytes, permanent refs and exact payload keys on replay', () => {
  const originals = [pinned, text('fact-a', '{"id":"semantic-id","createdAt":"literal-source-value"}\n中文 🧭'),
    text('fact-b', 'Exact tabs:\tspaces:  two\nline two'),
    text('current-payload', '{"id":"live-semantic-id","createdAt":"literal-live-source-value"}\n中文 🧭'),
    text('question', 'Continue with the retained facts.', 'user')];
  const state = withBlocks([block('b1', ['fact-a', 'fact-b'])], originals.slice(1).map(message => message.id));
  state.lastPassIds = originals.map(message => message.id);
  const first = assertProcessParity(state, originals);
  assert.ok(first.indexed.messages.some(message => message.id === summaryMessageId('b1')));
  assert.ok(!first.indexed.messages.some(message => message.id === 'fact-a'));
  const replay = assertProcessParity(first.reconstructed, originals);
  assert.deepEqual(replay.indexed.messages, first.indexed.messages);
  assert.equal(replay.indexed.workingState.messageRefs.byRaw['fact-a'], state.messageRefs.byRaw['fact-a']);
  assert.equal(replay.indexed.messages.find(message => message.id === 'current-payload')!.text, originals[3].text);
  assert.equal(originals[1].text, '{"id":"semantic-id","createdAt":"literal-source-value"}\n中文 🧭');
});

test('indexed counter reserves cold aliases while the current projection stays small', () => {
  const state = addRefs(createInitialState(), [pinned.id, 'current', 'cold-original']);
  state.messageRefs.byRaw['cold-original'] = 'm70000';
  delete state.messageRefs.byRef.m00003;
  state.messageRefs.byRef.m70000 = 'cold-original';
  state.deadRefs = ['m69999'];
  const current = [pinned, text('current'), text('new-live')];
  const result = assertProcessParity(state, current);
  assert.equal(result.indexed.workingState.messageRefs.byRaw['new-live'], 'm70001');
  assert.equal(result.indexed.delta.nextRefIndex, 70_002);
  assert.equal(result.indexed.workingState.messageRefs.byRef.m70000, undefined);
  assert.equal(result.indexed.delta.refs.byRef.m70001, 'new-live');
  assert.equal(result.indexed.delta.refs.byRef.m00003, undefined);
  const afterColdRebuild = assertProcessParity(result.reconstructed, [...current, text('next-live')]);
  assert.equal(afterColdRebuild.indexed.workingState.messageRefs.byRaw['next-live'], 'm70002');
});

test('indexed inactive rewind resurrects original coverage but continuing cluster remints the new instance', () => {
  const root = 'h_0123456789abcdef';
  const inactive = block('b1', [root], { active: false });
  const rewindState = withBlocks([inactive], [root]);
  rewindState.lastPassIds = [pinned.id, 'other-root'];
  const rewind = assertProcessParity(rewindState, [pinned, text(root), text('question', 'rewind', 'user')]);
  assert.equal(rewind.indexed.workingState.blocks[0].active, true);
  assert.ok(!rewind.indexed.messages.some(message => message.id === root));
  assert.ok(rewind.indexed.messages.some(message => message.id === summaryMessageId('b1')));

  const continuing = withBlocks([inactive, block('b2', [`${root}_2`], { active: false, expanded: true })],
    [root, `${root}_1`, `${root}_2`]);
  continuing.lastPassIds = [pinned.id, `${root}_1`];
  const extension = assertProcessParity(continuing, [pinned, text(`${root}_1`), text(`${root}#part`),
    text('question', 'new identical instance', 'user')]);
  assert.ok(extension.indexed.messages.some(message => message.id === `${root}_3#part`));
  assert.deepEqual(extension.indexed.reconciledMessageIds, [pinned.id, `${root}_1`, `${root}_3#part`, 'question']);
  assert.deepEqual(extension.indexed.workingState.lastPassIds, [pinned.id, `${root}_1`, `${root}#part`, 'question']);
  assert.equal(extension.indexed.workingState.blocks.find(value => value.blockId === 'b1')!.active, false);
  assert.equal(extension.indexed.workingState.blocks.find(value => value.blockId === 'b2')!.active, false);
  assert.ok(extension.indexed.delta.refs.byRaw[`${root}_3#part`]);
});

test('indexed sync preserves consumed and expanded tombstones across cold working-set reconstruction', () => {
  const state = withBlocks([
    block('b1', ['leaf-a'], { active: false }),
    block('b2', ['leaf-b'], { active: false, expanded: true }),
    block('b3', [], { tier: 2, directMessageIds: [], effectiveMessageIds: ['leaf-a'], directBlockIds: ['b1'], active: false }),
  ], ['leaf-a', 'leaf-b']);
  state.lastPassIds = [pinned.id, 'previous'];
  const result = assertProcessParity(state, [pinned, text('leaf-a'), text('leaf-b'), text('question', 'rewind', 'user')]);
  assert.equal(result.indexed.workingState.blocks.find(value => value.blockId === 'b1')!.active, false);
  assert.equal(result.indexed.workingState.blocks.find(value => value.blockId === 'b2')!.active, false);
  assert.equal(result.indexed.workingState.blocks.find(value => value.blockId === 'b3')!.active, true);
  assert.ok(result.indexed.messages.some(message => message.id === 'leaf-b'));
  assert.ok(result.indexed.messages.some(message => message.id === summaryMessageId('b3')));
});

test('indexed summary existence checks strip exact historical carriers and keep host-authored prefix collisions', () => {
  const state = withBlocks([
    block('b1', ['old-leaf'], { active: false }),
    block('b2', ['new-leaf'], { tier: 2, effectiveMessageIds: ['old-leaf', 'new-leaf'], directBlockIds: ['b1'] }),
  ], ['old-leaf', 'new-leaf']);
  state.lastPassIds = [pinned.id, 'new-leaf'];
  const result = assertProcessParity(state, [pinned,
    text(summaryMessageId('b1'), 'obsolete exact carrier', 'system'),
    text(summaryMessageId('b2'), 'current carrier text is replaced', 'system'),
    text('acp_summary_b999', 'This is a host-authored assistant message.'),
    text('question', 'what now?', 'user')], {}, ['b2']);
  assert.ok(!result.indexed.messages.some(message => message.id === summaryMessageId('b1')));
  assert.equal(result.indexed.messages.filter(message => message.id === summaryMessageId('b2')).length, 1);
  assert.ok(result.indexed.messages.some(message => message.id === 'acp_summary_b999' && message.role === 'assistant'));
});

test('indexed compression carriers use session call/range fate with the full kernel rules', () => {
  const state = withBlocks([
    block('b1', ['old'], { active: false, compressCallId: 'old-call', startRef: 'm00002', endRef: 'm00002' }),
    block('b2', ['live'], { compressCallId: 'live-call', startRef: 'm00003', endRef: 'm00003' }),
  ], ['old', 'live']);
  state.lastPassIds = [pinned.id, 'live'];
  const pair = (id: string, callId: string, name: string, ref: string): CoreMessage[] => [
    { id: `${id}-call`, role: 'assistant', contentType: 'tool-call', toolName: name, toolCallId: callId,
      text: JSON.stringify({ content: [{ startId: ref, endId: ref, summary: `carrier ${id}` }] }) },
    { id: `${id}-result`, role: 'tool', contentType: 'tool-result', toolName: name, toolCallId: callId, text: 'compressed' },
  ];
  const messages = [pinned, text('live'),
    ...pair('inactive', 'old-call', 'compress', 'm00002'),
    ...pair('foreign-inactive', 'different-host-id', 'mcp_compress', 'm00002'),
    ...pair('foreign-live', 'other-host-id', 'mcp_compress', 'm00003'),
    text('question', 'continue', 'user')];
  const result = assertProcessParity(state, messages, {
    config: { ...policy, isCompressTool: name => name === 'compress' || name === 'mcp_compress' },
  }, ['b2']);
  assert.ok(!result.indexed.messages.some(message => message.id === 'inactive-call'));
  assert.ok(!result.indexed.messages.some(message => message.id === 'foreign-inactive-call'));
  assert.ok(result.indexed.messages.some(message => message.id === 'foreign-live-call'));
});

test('indexed T3 compression emits child-root recipe without flattening cold child coverage', () => {
  const coldA = Array.from({ length: 24 }, (_, index) => `cold-a-${index}`);
  const coldB = Array.from({ length: 24 }, (_, index) => `cold-b-${index}`);
  const state = withBlocks([
    block('b1', coldA, { tier: 2 }),
    block('b2', coldB, { tier: 2 }),
  ], [...coldA, ...coldB]);
  const messages = [pinned, text(summaryMessageId('b1'), state.blocks[0].summary, 'system'),
    text(summaryMessageId('b2'), state.blocks[1].summary, 'system'), text('question', 'retain both summaries', 'user')];
  const core = createCore();
  const ranges = [{ startRef: 'b1', endRef: 'b2', summary: 'T3 fixture: preserve both child roots and their exact original sources.' }];
  const full = core.applyCompression({ state: structuredClone(state), messages: structuredClone(messages), config: policy, ranges });
  const workingState = workingFor(state, messages);
  assert.equal(workingState.blocks.flatMap(value => value.effectiveMessageIds).length, 0);
  const indexed = core.applyCompression({ storageMode: 'indexed-v1', workingState, archive: factsFor(state),
    messages: structuredClone(messages), config: policy, ranges });
  assert.equal(indexed.storageMode, 'indexed-v1');
  assert.equal(Object.hasOwn(indexed, 'state'), false);
  assert.deepEqual(indexed.result, full.result);
  assert.equal(indexed.result.blocksCreated, 1);
  const created = indexed.delta.blocks.find(value => value.header.blockId === 'b3')!;
  assert.ok(created);
  assert.equal(created.header.tier, 3);
  assert.deepEqual(created.coverage?.childBlockIds, ['b1', 'b2']);
  assert.deepEqual(created.coverage?.directMessageIds, []);
  assert.equal(indexed.workingState.blocks.find(value => value.blockId === 'b3')!.effectiveMessageIds.length, 0);
  assert.equal(full.state.blocks.find(value => value.blockId === 'b3')!.effectiveMessageIds.length, coldA.length + coldB.length);
  assert.deepEqual(indexed.workingState.blocks.map(blockHeader), full.state.blocks.map(blockHeader));
  assert.deepEqual(applyDelta(state, indexed.delta).blocks.find(value => value.blockId === 'b3')!.effectiveMessageIds,
    full.state.blocks.find(value => value.blockId === 'b3')!.effectiveMessageIds);
});

test('indexed recipe preserves current range order before cold child order under reordered input', () => {
  const state = withBlocks([
    block('b1', ['cold-a', 'live-a']),
    block('b2', ['cold-b', 'live-b']),
  ], ['cold-a', 'live-a', 'cold-b', 'live-b']);
  const messages = [pinned, text(summaryMessageId('b1'), state.blocks[0].summary, 'system'),
    text('live-b'), text('live-a'), text(summaryMessageId('b2'), state.blocks[1].summary, 'system'),
    text('question', 'Retain exact source sequence through promotion.', 'user')];
  const ranges = [{ startRef: 'b1', endRef: 'b2',
    summary: 'A promoted summary preserves the current reordered range before either cold child tail.' }];
  const core = createCore();
  const full = core.applyCompression({ state: structuredClone(state), messages: structuredClone(messages), config: policy, ranges });
  const indexed = core.applyCompression({ storageMode: 'indexed-v1', workingState: workingFor(state, messages),
    archive: factsFor(state), messages: structuredClone(messages), config: policy, ranges });
  assert.deepEqual(indexed.result, full.result);
  assert.equal(indexed.result.blocksCreated, 1);
  const expected = ['live-b', 'live-a', 'cold-a', 'cold-b'];
  assert.deepEqual(full.state.blocks.find(value => value.blockId === 'b3')!.effectiveMessageIds, expected);
  assert.deepEqual(indexed.delta.blocks.find(value => value.header.blockId === 'b3')!.coverage?.orderedPrefixMessageIds,
    ['live-b', 'live-a']);
  const restored = applyDelta(state, indexed.delta);
  assert.deepEqual(restored.blocks.find(value => value.blockId === 'b3')!.effectiveMessageIds, expected);
  assertProcessParity(restored, messages);
});

test('indexed ancestor restoration requires the loaded closure and preserves refold identity', () => {
  const state = withBlocks([
    block('b1', ['leaf-a', 'leaf-b'], { active: false }),
    block('b2', [], { tier: 2, active: false, effectiveMessageIds: ['leaf-a', 'leaf-b'], directBlockIds: ['b1'] }),
    block('b3', [], { tier: 3, effectiveMessageIds: ['leaf-a', 'leaf-b'], directBlockIds: ['b2'] }),
  ], ['leaf-a', 'leaf-b']);
  assert.deepEqual(activeAncestorIds(state, 'b1'), ['b3']);
  let restored = structuredClone(state);
  for (const blockId of ['b1', ...activeAncestorIds(restored, 'b1')]) restored = markBlockRestoredInline(restored, blockId).state;
  assert.equal(restored.blocks[0].restoredInline, true);
  assert.equal(restored.blocks[2].restoredInline, true);
  const messages: CoreMessage[] = [];
  const refoldConfig = { ...policy, compress: { ...policy.compress, minCompressRange: 1 } };
  const ranges = [{ startRef: restored.messageRefs.byRaw['leaf-a'], endRef: restored.messageRefs.byRaw['leaf-b'],
    summary: 'Re-folded exact original range after restoring its active ancestor chain.' }];
  const core = createCore();
  const unrestored = markBlockRestoredInline(structuredClone(state), 'b1').state;
  const rejectedFull = core.applyCompression({ state: unrestored, messages: structuredClone(messages), config: refoldConfig, ranges });
  const rejectedIndexed = core.applyCompression({ storageMode: 'indexed-v1',
    workingState: workingFor(unrestored, messages, ['leaf-a', 'leaf-b'], ['b1', 'b3']), archive: factsFor(unrestored),
    messages: structuredClone(messages), config: refoldConfig, ranges });
  assert.deepEqual(rejectedIndexed.result, rejectedFull.result);
  assert.equal(rejectedIndexed.result.blocksCreated, 0);
  assert.ok(rejectedIndexed.result.errors.some(error => error.includes('b3')));
  const full = core.applyCompression({ state: structuredClone(restored), messages: structuredClone(messages), config: refoldConfig, ranges });
  const indexed = core.applyCompression({ storageMode: 'indexed-v1',
    workingState: workingFor(restored, messages, ['leaf-a', 'leaf-b'], ['b1', 'b3']),
    archive: factsFor(restored), messages: structuredClone(messages), config: refoldConfig, ranges });
  assert.deepEqual(indexed.result, full.result);
  assert.equal(indexed.result.errors.length, 0);
  assert.equal(indexed.result.blocksCreated, 1);
  assert.deepEqual(applyDelta(restored, indexed.delta).blocks.map(blockHeader), full.state.blocks.map(blockHeader));
  assert.equal(indexed.workingState.nextBlockId, full.state.nextBlockId);
  assert.equal(indexed.workingState.nextBlockId, state.nextBlockId, 'restored ancestor is refolded in place');
  assert.equal(indexed.workingState.nextRunId, state.nextRunId + 1);
  assert.equal(indexed.workingState.blocks.find(value => value.blockId === 'b3')!.summary, ranges[0].summary);
  assert.equal(indexed.workingState.blocks.find(value => value.blockId === 'b3')!.restoredInline, false);
  assert.equal(indexed.delta.blocks.find(value => value.header.blockId === 'b3')!.coverage, undefined);
  assert.deepEqual(indexed.delta.refs, { byRaw: {}, byRef: {} });
  assert.equal(indexed.workingState.messageRefs.byRaw['leaf-a'], state.messageRefs.byRaw['leaf-a']);
});

test('an entry-inactive canonical top can revive before its consumed child boundary is resolved', () => {
  const state = withBlocks([
    block('b1', ['revived-child-source'], { active: false }),
    block('b2', [], { tier: 2, active: false, directBlockIds: ['b1'], effectiveMessageIds: ['revived-child-source'] }),
    block('b3', ['fresh-boundary-source'], { tier: 2 }),
  ], ['revived-child-source', 'fresh-boundary-source']);
  const messages = [pinned, text(summaryMessageId('b2'), state.blocks[1].summary, 'system'),
    text(summaryMessageId('b3'), state.blocks[2].summary, 'system'), text('question', 'Use the revived canonical boundary.', 'user')];
  const archive = factsFor(state);
  assert.deepEqual(archive.activeAncestors('b1'), ['b2']);
  assert.deepEqual(activeAncestorIds(state, 'b1'), []);
  const working = bindIndexedArchive(workingFor(state, messages, [], ['b1', 'b2', 'b3']), archive);
  assert.deepEqual(activeAncestorIds(working, 'b1'), []);
  const full = syncBlocks(structuredClone(messages), structuredClone(state)).state;
  const indexed = syncBlocks(structuredClone(messages), working).state;
  assert.equal(indexed.blocks.find(value => value.blockId === 'b2')!.active, true);
  assert.deepEqual(activeAncestorIds(indexed, 'b1'), ['b2']);
  const input = { startRef: 'b1', endRef: 'b3', messages: structuredClone(messages) };
  const expected = resolveBoundaries({ ...input, state: full });
  const actual = resolveBoundaries({ ...input, state: indexed });
  assert.deepEqual(actual, expected);
  assert.equal(actual.startIndex, 1); assert.equal(actual.endIndex, 2);
  assert.ok(actual.snappedBoundaries.some(value => value.includes('b1')));
});

test('missing prepared facts fail closed rather than treating unavailable historical knowledge as false', () => {
  const state = withBlocks([block('b1', ['cold-covered'], { active: false }),
    block('b2', ['live-covered'], { directBlockIds: ['b1'], effectiveMessageIds: ['cold-covered', 'live-covered'] })],
  ['cold-covered', 'live-covered']);
  state.lastPassIds = [pinned.id, 'previous'];
  const archive = factsFor(state);
  const unavailable: IndexedArchiveFacts = { ...archive,
    knownBlock() { throw Object.assign(new Error('known block fact was not prepared'), { code: 'ARCHIVE_FACT_MISSING' }); } };
  assert.throws(() => createCore().processTurn({ storageMode: 'indexed-v1',
    workingState: workingFor(state, [pinned, text('live-covered')], [], ['b2']), archive: unavailable,
    messages: [pinned, text('live-covered'), text(summaryMessageId('b1'), 'old summary', 'system')],
    config: policy, tokenCount: 100, renderTags: 'none', contentStore: createContentStore() }),
  { code: 'ARCHIVE_FACT_MISSING' });
});

test('indexed kernel accepts one supplied y candidate among overlapping independent components', () => {
  const shared = 'shared-x';
  const cold = Array.from({ length: 256 }, (_, index) => `independent-y-${index}`);
  const target = 'independent-target-y';
  const state = withBlocks([
    block('b1', [shared], { tier: 3, active: false }),
    block('b2', [target], { effectiveMessageIds: [shared, target], active: false }),
    ...cold.map((id, index) => block(`b${index + 100}`, [id], { effectiveMessageIds: [shared, id], active: false })),
  ], [shared, target, ...cold]);
  state.lastPassIds = [pinned.id, shared, 'question'];
  const messages = [pinned, text(target), text('question', 'Use only the matching independent component.', 'user')];
  const result = assertProcessParity(state, messages, {}, ['b2']);
  assert.equal(result.indexed.delta.replaceActiveSet, true);
  assert.deepEqual(result.indexed.workingState.blocks.filter(value => value.active).map(value => value.blockId), ['b2']);
  assert.deepEqual(result.indexed.delta.blocks.filter(value => value.header.active).map(value => value.header.blockId), ['b2']);
  assert.ok(result.indexed.delta.blocks.length <= 1, 'an active-set replacement must not emit cold sibling patches');
  assert.ok(result.indexed.messages.some(message => message.id === summaryMessageId('b2')));
  assert.ok(!result.indexed.messages.some(message => message.id === shared));
  assert.equal(result.reconstructed.blocks.filter(value => value.active).length, 1);
  assert.equal(result.reconstructed.blocks.find(value => value.blockId === 'b100')!.active, false);
});

test('bounded surface switch replaces a huge previous active set without emitting historical deactivation patches', () => {
  const previous = Array.from({ length: 1024 }, (_, index) => `previous-live-${index}`);
  const target = 'bounded-surface-target';
  const state = withBlocks([
    block('b1', [target]),
    ...previous.map((id, index) => block(`b${index + 100}`, [id])),
  ], [target, ...previous]);
  // lastPassIds is the previous invocation's input, not a durable active-id
  // cache. It is replaced by this fixed incoming surface in the returned head.
  state.lastPassIds = [pinned.id, ...previous];
  const messages = [pinned, text(target), text('question', 'Switch to this bounded current surface.', 'user')];
  const switched = assertProcessParity(state, messages, {}, ['b1']);
  assert.equal(switched.indexed.delta.replaceActiveSet, true);
  assert.deepEqual(switched.indexed.delta.blocks.filter(item => item.header.active).map(item => item.header.blockId), ['b1']);
  assert.ok(switched.indexed.delta.blocks.length <= 1);
  assert.deepEqual(switched.reconstructed.blocks.filter(value => value.active).map(value => value.blockId), ['b1']);
  assert.deepEqual(switched.indexed.delta.head.lastPassIds, messages.map(message => message.id));
  const replay = assertProcessParity(switched.reconstructed, messages, {}, ['b1']);
  assert.deepEqual(replay.indexed.messages, switched.indexed.messages);
  assert.equal(replay.indexed.delta.replaceActiveSet, true);
  assert.ok(replay.indexed.delta.blocks.length <= 1);
});

test('canonical DAG permits an inactive child reused by two active parents and deduplicates its exact sources', () => {
  const shared = ['shared-child-a', 'shared-child-b'];
  const state = withBlocks([
    block('b1', shared, { active: false }),
    block('b2', ['branch-left'], { tier: 2, directBlockIds: ['b1'],
      effectiveMessageIds: ['branch-left', ...shared] }),
    block('b3', ['branch-right'], { tier: 2, directBlockIds: ['b1'],
      effectiveMessageIds: ['branch-right', ...shared] }),
  ], [...shared, 'branch-left', 'branch-right']);
  state.lastPassIds = [pinned.id, 'branch-right', 'branch-left'];
  const messages = [pinned, text('branch-right'), text(summaryMessageId('b2'), state.blocks[1].summary, 'system'),
    text('branch-left'), text(summaryMessageId('b3'), state.blocks[2].summary, 'system'),
    text('question', 'Retain both canonical branches and shared child bytes.', 'user')];
  const projected = assertProcessParity(state, messages, {}, ['b2', 'b3']);
  assert.deepEqual(projected.reconstructed.blocks.filter(value => value.active).map(value => value.blockId), ['b2', 'b3']);
  assert.equal(projected.reconstructed.blocks[0].active, false);
  assert.deepEqual(factsFor(state).activeAncestors('b1'), ['b2', 'b3']);
  const ranges = [{ startRef: 'b2', endRef: 'b3', summary: 'Both branches retain the shared original child exactly once.' }];
  const core = createCore();
  const full = core.applyCompression({ state: structuredClone(state), messages: structuredClone(messages), config: policy, ranges });
  const indexed = core.applyCompression({ storageMode: 'indexed-v1', workingState: workingFor(state, messages, [], ['b2', 'b3']),
    archive: factsFor(state), messages: structuredClone(messages), config: policy, ranges });
  assert.deepEqual(indexed.result, full.result);
  assert.equal(indexed.result.blocksCreated, 1);
  const rebuilt = applyDelta(state, indexed.delta), created = rebuilt.blocks.find(value => value.blockId === 'b4')!;
  assert.deepEqual(created.effectiveMessageIds, full.state.blocks.find(value => value.blockId === 'b4')!.effectiveMessageIds);
  for (const id of shared) assert.equal(created.effectiveMessageIds.filter(value => value === id).length, 1);
  assert.deepEqual(indexed.delta.blocks.find(item => item.header.blockId === 'b4')!.coverage?.childBlockIds, ['b2', 'b3']);
  assert.deepEqual(rebuilt.blocks.filter(value => value.active).map(value => value.blockId), ['b4']);
  for (const id of ['b1', 'b2', 'b3']) assert.equal(rebuilt.blocks.find(value => value.blockId === id)!.active, false);
});

test('indexed kernel keeps a supplied long child chain and huge leaf coverage as selected promotion roots', () => {
  const cold = Array.from({ length: 1024 }, (_, index) => `huge-child-leaf-${index}`);
  const chain: CompressionBlock[] = [block('b1', cold, { tier: 3, active: false })];
  for (let index = 2; index <= 64; index++) chain.push(block(`b${index}`, [], {
    tier: 3, active: index === 64, directBlockIds: [`b${index - 1}`], effectiveMessageIds: [...cold],
  }));
  chain.push(block('b65', ['small-fresh-leaf'], { tier: 3 }));
  const state = withBlocks(chain, [...cold, 'small-fresh-leaf']);
  const messages = [pinned, text(summaryMessageId('b64'), chain[63].summary, 'system'),
    text(summaryMessageId('b65'), chain[64].summary, 'system'), text('question', 'Merge the two selected roots.', 'user')];
  const ranges = [{ startRef: 'b64', endRef: 'b65', summary: 'The huge cold chain and small fresh source remain independently recoverable.' }];
  const core = createCore();
  const full = core.applyCompression({ state: structuredClone(state), messages: structuredClone(messages), config: policy, ranges });
  const working = workingFor(state, messages, [], ['b64', 'b65']);
  assert.equal(working.blocks.length, 2);
  assert.equal(working.blocks.flatMap(value => value.effectiveMessageIds).length, 0);
  const indexed = core.applyCompression({ storageMode: 'indexed-v1', workingState: working, archive: factsFor(state),
    messages: structuredClone(messages), config: policy, ranges });
  assert.deepEqual(indexed.result, full.result);
  assert.equal(indexed.result.blocksCreated, 1);
  const recipe = indexed.delta.blocks.find(item => item.header.blockId === 'b66')!.coverage!;
  assert.deepEqual(recipe.childBlockIds, ['b64', 'b65']);
  assert.deepEqual(recipe.directMessageIds, []);
  assert.equal(recipe.orderedPrefixMessageIds?.length ?? 0, 0);
  assert.ok(indexed.delta.blocks.length <= 3);
  assert.equal(indexed.workingState.blocks.length, 3);
  assert.equal(indexed.workingState.blocks.flatMap(value => value.effectiveMessageIds).length, 0);
  const rebuilt = applyDelta(state, indexed.delta);
  assert.deepEqual(rebuilt.blocks.find(value => value.blockId === 'b66')!.effectiveMessageIds,
    full.state.blocks.find(value => value.blockId === 'b66')!.effectiveMessageIds);
  assert.deepEqual(rebuilt.blocks.filter(value => value.active).map(value => value.blockId), ['b66']);
  for (const id of ['b64', 'b65']) assert.equal(rebuilt.blocks.find(value => value.blockId === id)!.active, false);
});
