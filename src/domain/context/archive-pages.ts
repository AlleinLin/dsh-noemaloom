import { NexusError, type NexusStore, type StoredRecord } from '../../ports/contracts.js';
import { canonicalJson, jsonClone, sha256 } from '../storage/canonical.js';

/** An immutable snapshot. An undefined root denotes the empty index. */
export interface ArchiveIndexRoot {
  pageId: string;
  height: number;
  count: number;
  first: string;
  last: string;
}

type Entry = [string, unknown];
type LeafDraft = { kind: 'leaf'; entries: Entry[] };
type BranchDraft = { kind: 'branch'; children: ArchiveIndexRoot[] };
type Draft = LeafDraft | BranchDraft;
interface PageBase {
  schemaVersion: 1;
  sessionKey: string;
  hash: string;
  height: number;
  count: number;
  first: string;
  last: string;
}
type LeafPage = PageBase & LeafDraft;
type BranchPage = PageBase & BranchDraft;
type Page = LeafPage | BranchPage;
type CachedPage = { page: Page; bytes: number };
type Operation = { pages: Map<string, CachedPage>; bytes: number };
type Removal = { changed: false } | { changed: true; draft: Draft | undefined };

const COLLECTION = 'context.archive.pages';
const CAPACITY = 32;
const MINIMUM = 16;
const CACHE_CAPACITY = 128;
const CACHE_BYTE_CAPACITY = 4 * 1024 * 1024;
// With a minimum fanout of 16, a taller tree cannot have a safe integer count.
const MAX_HEIGHT = 12;
const REFERENCE_FIELDS = ['pageId', 'height', 'count', 'first', 'last'];
const BASE_FIELDS = ['schemaVersion', 'sessionKey', 'hash', 'height', 'count', 'first', 'last', 'kind'];

function fail(message: string): never {
  throw new NexusError('INTEGRITY_FAILED', `Archive index: ${message}`);
}

function argument(message: string): never {
  throw new NexusError('INVALID_ARGUMENT', `Archive index: ${message}`);
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fields(value: Record<string, unknown>, names: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === names.length && names.every(name => Object.hasOwn(value, name));
}

function key(value: unknown): asserts value is string {
  if (typeof value !== 'string') argument('keys and range boundaries must be strings.');
}

function sumCounts(children: readonly ArchiveIndexRoot[]): number {
  let count = 0;
  for (const child of children) {
    count += child.count;
    if (!Number.isSafeInteger(count)) fail('subtree count exceeds the safe integer range.');
  }
  return count;
}

function sameReference(left: ArchiveIndexRoot, right: ArchiveIndexRoot): boolean {
  return left.pageId === right.pageId && left.height === right.height && left.count === right.count
    && left.first === right.first && left.last === right.last;
}

function lowerBound(entries: readonly Entry[], target: string): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const middle = Math.floor((lo + hi) / 2);
    if (entries[middle][0] < target) lo = middle + 1;
    else hi = middle;
  }
  return lo;
}

/** First subtree whose last key is >= target; children.length means after all. */
function childBound(children: readonly ArchiveIndexRoot[], target: string): number {
  let lo = 0;
  let hi = children.length;
  while (lo < hi) {
    const middle = Math.floor((lo + hi) / 2);
    if (children[middle].last < target) lo = middle + 1;
    else hi = middle;
  }
  return lo;
}

function width(draft: Draft): number {
  return draft.kind === 'leaf' ? draft.entries.length : draft.children.length;
}

function draftOf(page: Page): Draft {
  return page.kind === 'leaf'
    ? { kind: 'leaf', entries: page.entries.slice() }
    : { kind: 'branch', children: page.children.slice() };
}

function combine(left: Draft, right: Draft): Draft {
  if (left.kind === 'leaf' && right.kind === 'leaf') {
    return { kind: 'leaf', entries: [...left.entries, ...right.entries] };
  }
  if (left.kind === 'branch' && right.kind === 'branch') {
    return { kind: 'branch', children: [...left.children, ...right.children] };
  }
  return fail('siblings have different page kinds.');
}

function split(draft: Draft, offset: number): [Draft, Draft] {
  return draft.kind === 'leaf'
    ? [{ kind: 'leaf', entries: draft.entries.slice(0, offset) },
      { kind: 'leaf', entries: draft.entries.slice(offset) }]
    : [{ kind: 'branch', children: draft.children.slice(0, offset) },
      { kind: 'branch', children: draft.children.slice(offset) }];
}

/**
 * Ordered, path-copying B+tree. Only get/put are used; historical pages are never
 * overwritten or removed. Callers publish the returned root in their own atomic
 * session commit, after this operation succeeds.
 *
 * Keys use JavaScript's stable UTF-16 string ordering. Range starts are inclusive
 * and ends exclusive, also when reverse is true. Values use canonical JSON wire
 * semantics and are cloned at both ingress and egress.
 */
export class ArchivePages {
  // One instance belongs to one working scope and its forks. Only verified
  // immutable pages are retained; every lookup still receives its own root.
  private readonly cache: Operation = { pages: new Map(), bytes: 0 };

  constructor(private readonly store: NexusStore, private readonly sessionKey: string) {
    if (typeof sessionKey !== 'string' || sessionKey.length === 0 || sessionKey.length > 4031
      || sessionKey.includes('\0')) argument('sessionKey must be a nonempty store-safe string.');
  }

  private operation(): Operation {
    return this.cache;
  }

  private reference(value: unknown, child = false): ArchiveIndexRoot {
    if (!record(value) || !fields(value, REFERENCE_FIELDS)) fail('invalid root or child reference shape.');
    const { pageId, height, count, first, last } = value;
    if (typeof pageId !== 'string' || !pageId.startsWith(`${this.sessionKey}.`)
      || pageId.length !== this.sessionKey.length + 65
      || !/^[a-f0-9]{64}$/.test(pageId.slice(this.sessionKey.length + 1))
      || typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0 || height > MAX_HEIGHT
      || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1
      || typeof first !== 'string' || typeof last !== 'string'
      || (count === 1 ? first !== last : first >= last)) fail('invalid root or child reference metadata.');
    const minimum = child ? MINIMUM ** (height + 1) : height === 0 ? 1 : 2 * MINIMUM ** height;
    if (count < minimum || count > CAPACITY ** (height + 1)) fail('subtree count contradicts its height.');
    return { pageId, height, count, first, last };
  }

  private root(value: ArchiveIndexRoot | undefined): ArchiveIndexRoot | undefined {
    return value === undefined ? undefined : this.reference(value);
  }

  private ref(page: Page): ArchiveIndexRoot {
    return { pageId: `${this.sessionKey}.${page.hash}`, height: page.height, count: page.count,
      first: page.first, last: page.last };
  }

  private occupancy(page: Page, isRoot: boolean): void {
    const size = width(page);
    if (size > CAPACITY || size < (isRoot ? page.kind === 'leaf' ? 1 : 2 : MINIMUM)) {
      fail('page occupancy is outside B+tree bounds.');
    }
  }

  private decode(stored: StoredRecord<unknown>, expected: ArchiveIndexRoot): Page {
    if (stored.id !== expected.pageId || stored.revision !== 1) fail('immutable page identity or revision mismatch.');
    const value = stored.value;
    if (!record(value) || (value.kind !== 'leaf' && value.kind !== 'branch')
      || !fields(value, [...BASE_FIELDS, value.kind === 'leaf' ? 'entries' : 'children'])
      || value.schemaVersion !== 1 || value.sessionKey !== this.sessionKey
      || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)) fail('invalid page envelope.');
    const { hash, ...body } = value;
    let normalized: Page;
    try {
      if (sha256(canonicalJson(body)) !== hash) fail('page content hash mismatch.');
      normalized = jsonClone(value) as unknown as Page;
    } catch (error) {
      if (error instanceof NexusError && error.code === 'INTEGRITY_FAILED') throw error;
      return fail('page contains invalid JSON.');
    }
    const actual = this.reference(this.ref(normalized));
    if (!sameReference(actual, expected)) fail('page metadata differs from its parent reference.');
    if (normalized.kind === 'leaf') {
      if (normalized.height !== 0 || !Array.isArray(normalized.entries)
        || normalized.entries.length < 1 || normalized.entries.length > CAPACITY
        || normalized.entries.length !== normalized.count) fail('invalid leaf shape or count.');
      let previous: string | undefined;
      for (const item of normalized.entries) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string'
          || (previous !== undefined && previous >= item[0])) fail('leaf keys are invalid, duplicated, or unordered.');
        previous = item[0];
      }
      if (normalized.first !== normalized.entries[0][0]
        || normalized.last !== normalized.entries[normalized.entries.length - 1][0]) fail('leaf boundaries mismatch.');
    } else {
      if (normalized.height < 1 || !Array.isArray(normalized.children)
        || normalized.children.length < 2 || normalized.children.length > CAPACITY) fail('invalid branch shape.');
      let previous: ArchiveIndexRoot | undefined;
      for (const candidate of normalized.children) {
        const child = this.reference(candidate, true);
        if (child.height !== normalized.height - 1 || (previous && previous.last >= child.first)) {
          fail('child heights or ordered boundaries mismatch.');
        }
        previous = child;
      }
      if (sumCounts(normalized.children) !== normalized.count
        || normalized.first !== normalized.children[0].first
        || normalized.last !== normalized.children[normalized.children.length - 1].last) fail('branch metadata mismatch.');
    }
    return normalized;
  }

  private remember(operation: Operation, page: Page): void {
    const id = `${this.sessionKey}.${page.hash}`;
    const prior = operation.pages.get(id);
    if (prior) {
      if (prior.page !== page && canonicalJson(prior.page) !== canonicalJson(page)) {
        fail('content-address collision in the verified page cache.');
      }
      operation.pages.delete(id);
      operation.pages.set(id, prior);
      return;
    }
    const bytes = Buffer.byteLength(canonicalJson(page), 'utf8');
    if (bytes > CACHE_BYTE_CAPACITY) return;
    operation.pages.set(id, { page, bytes });
    operation.bytes += bytes;
    while (operation.pages.size > CACHE_CAPACITY || operation.bytes > CACHE_BYTE_CAPACITY) {
      const oldest = operation.pages.keys().next().value!;
      const removed = operation.pages.get(oldest)!;
      operation.pages.delete(oldest);
      operation.bytes -= removed.bytes;
    }
  }

  private async load(operation: Operation, reference: ArchiveIndexRoot, isRoot: boolean): Promise<Page> {
    let page = operation.pages.get(reference.pageId)?.page;
    if (page) {
      if (!sameReference(this.ref(page), reference)) fail('conflicting metadata for the same cached page.');
      this.remember(operation, page);
    } else {
      const stored = await this.store.get(COLLECTION, reference.pageId);
      if (!stored) fail(`missing page ${reference.pageId}.`);
      page = this.decode(stored, reference);
      this.remember(operation, page);
    }
    this.occupancy(page, isRoot);
    return page;
  }

  private async save(operation: Operation, draft: Draft): Promise<ArchiveIndexRoot> {
    let body: Omit<PageBase, 'hash'> & Draft;
    if (draft.kind === 'leaf') {
      if (draft.entries.length === 0 || draft.entries.length > CAPACITY) fail('cannot save an empty or overflowing leaf.');
      body = { schemaVersion: 1, sessionKey: this.sessionKey, height: 0,
        count: draft.entries.length, first: draft.entries[0][0], last: draft.entries[draft.entries.length - 1][0],
        kind: 'leaf', entries: draft.entries };
    } else {
      if (draft.children.length < 2 || draft.children.length > CAPACITY) fail('cannot save an empty, unary, or overflowing branch.');
      body = { schemaVersion: 1, sessionKey: this.sessionKey, height: draft.children[0].height + 1,
        count: sumCounts(draft.children), first: draft.children[0].first,
        last: draft.children[draft.children.length - 1].last, kind: 'branch', children: draft.children };
    }
    const page = { ...body, hash: sha256(canonicalJson(body)) } as Page;
    const reference = this.reference(this.ref(page));
    const cached = operation.pages.get(reference.pageId);
    if (cached) {
      if (canonicalJson(cached.page) !== canonicalJson(page)) fail('content-address collision in the verified page cache.');
      this.remember(operation, cached.page);
      return reference;
    }
    // Validate our own derived metadata before admitting any immutable record.
    this.decode({ id: reference.pageId, revision: 1, value: page, updatedAt: '' }, reference);
    let stored: StoredRecord<unknown>;
    try {
      stored = await this.store.put(COLLECTION, reference.pageId, page, 0);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'REVISION_CONFLICT') throw error;
      // Another writer may have independently produced the same immutable page.
      const existing = await this.store.get(COLLECTION, reference.pageId);
      if (!existing) fail('immutable page write conflicted, but the page is absent.');
      stored = existing;
    }
    const verified = this.decode(stored, reference);
    if (canonicalJson(verified) !== canonicalJson(page)) fail('immutable page write contains different content.');
    this.remember(operation, verified);
    return reference;
  }

  async get<T>(root: ArchiveIndexRoot | undefined, target: string): Promise<T | undefined> {
    key(target);
    let current = this.root(root);
    const operation = this.operation();
    let isRoot = true;
    while (current) {
      const page = await this.load(operation, current, isRoot);
      if (target < page.first || target > page.last) return undefined;
      if (page.kind === 'leaf') {
        const index = lowerBound(page.entries, target);
        return page.entries[index]?.[0] === target ? jsonClone(page.entries[index][1]) as T : undefined;
      }
      const index = childBound(page.children, target);
      current = page.children[index];
      if (current && target < current.first) return undefined;
      isRoot = false;
    }
    return undefined;
  }

  private async insert(operation: Operation, reference: ArchiveIndexRoot, target: string, value: unknown,
    isRoot: boolean): Promise<ArchiveIndexRoot[]> {
    const page = await this.load(operation, reference, isRoot);
    let draft: Draft;
    if (page.kind === 'leaf') {
      const entries = page.entries.slice();
      const index = lowerBound(entries, target);
      if (entries[index]?.[0] === target) {
        if (canonicalJson(entries[index][1]) === canonicalJson(value)) return [reference];
        entries[index] = [target, value];
      } else entries.splice(index, 0, [target, value]);
      draft = { kind: 'leaf', entries };
    } else {
      const children = page.children.slice();
      const index = Math.min(childBound(children, target), children.length - 1);
      const replacement = await this.insert(operation, children[index], target, value, false);
      if (replacement.length === 1 && sameReference(replacement[0], children[index])) return [reference];
      children.splice(index, 1, ...replacement);
      draft = { kind: 'branch', children };
    }
    if (width(draft) <= CAPACITY) return [await this.save(operation, draft)];
    const [left, right] = split(draft, MINIMUM);
    return [await this.save(operation, left), await this.save(operation, right)];
  }

  async set<T>(root: ArchiveIndexRoot | undefined, target: string, value: T): Promise<ArchiveIndexRoot> {
    key(target);
    const snapshot = this.root(root);
    const normalized = jsonClone(value);
    const operation = this.operation();
    if (!snapshot) return this.save(operation, { kind: 'leaf', entries: [[target, normalized]] });
    const replacement = await this.insert(operation, snapshot, target, normalized, true);
    return replacement.length === 1 ? replacement[0]
      : this.save(operation, { kind: 'branch', children: replacement });
  }

  /**
   * A changed child stays an in-memory draft until its parent fixes underflow,
   * so no underfull non-root page is ever persisted or exposed as a snapshot.
   */
  private async erase(operation: Operation, reference: ArchiveIndexRoot, target: string, isRoot: boolean): Promise<Removal> {
    const page = await this.load(operation, reference, isRoot);
    if (target < page.first || target > page.last) return { changed: false };
    if (page.kind === 'leaf') {
      const index = lowerBound(page.entries, target);
      if (page.entries[index]?.[0] !== target) return { changed: false };
      const entries = page.entries.slice();
      entries.splice(index, 1);
      return { changed: true, draft: entries.length ? { kind: 'leaf', entries } : undefined };
    }
    const children = page.children.slice();
    const index = childBound(children, target);
    if (index === children.length || target < children[index].first) return { changed: false };
    const result = await this.erase(operation, children[index], target, false);
    if (!result.changed) return result;
    if (!result.draft) {
      children.splice(index, 1);
    } else if (width(result.draft) >= MINIMUM) {
      children[index] = await this.save(operation, result.draft);
    } else {
      const child = result.draft;
      const left = index > 0 ? draftOf(await this.load(operation, children[index - 1], false)) : undefined;
      const right = index + 1 < children.length ? draftOf(await this.load(operation, children[index + 1], false)) : undefined;
      if (left && width(left) > MINIMUM) {
        const [remaining, borrowed] = split(left, width(left) - 1);
        children[index - 1] = await this.save(operation, remaining);
        children[index] = await this.save(operation, combine(borrowed, child));
      } else if (right && width(right) > MINIMUM) {
        const [borrowed, remaining] = split(right, 1);
        children[index] = await this.save(operation, combine(child, borrowed));
        children[index + 1] = await this.save(operation, remaining);
      } else if (left) {
        const merged = await this.save(operation, combine(left, child));
        children.splice(index - 1, 2, merged);
      } else if (right) {
        const merged = await this.save(operation, combine(child, right));
        children.splice(index, 2, merged);
      } else fail('an underfull non-root page has no sibling.');
    }
    return { changed: true, draft: children.length ? { kind: 'branch', children } : undefined };
  }

  async delete(root: ArchiveIndexRoot | undefined, target: string): Promise<ArchiveIndexRoot | undefined> {
    key(target);
    const snapshot = this.root(root);
    if (!snapshot) return undefined;
    const operation = this.operation();
    const result = await this.erase(operation, snapshot, target, true);
    if (!result.changed) return snapshot;
    if (!result.draft) return undefined;
    if (result.draft.kind === 'branch' && result.draft.children.length === 1) return result.draft.children[0];
    return this.save(operation, result.draft);
  }

  /** Zero-based lookup using subtree counts; never enumerates preceding leaves. */
  async at<T>(root: ArchiveIndexRoot | undefined, index: number): Promise<[string, T] | undefined> {
    if (!Number.isSafeInteger(index) || index < 0) argument('index must be a nonnegative safe integer.');
    let current = this.root(root);
    if (!current) return undefined;
    const operation = this.operation();
    let isRoot = true;
    let offset = index;
    while (current) {
      const page = await this.load(operation, current, isRoot);
      if (offset >= page.count) return undefined;
      if (page.kind === 'leaf') {
        const item = page.entries[offset];
        return [item[0], jsonClone(item[1]) as T];
      }
      let selected: ArchiveIndexRoot | undefined;
      for (const child of page.children) {
        if (offset < child.count) {
          selected = child;
          break;
        }
        offset -= child.count;
      }
      if (!selected) fail('subtree counts cannot locate a valid ordinal.');
      current = selected;
      isRoot = false;
    }
    return undefined;
  }

  /** Number of stored keys strictly less than target (the insertion rank). */
  async rank(root: ArchiveIndexRoot | undefined, target: string): Promise<number> {
    key(target);
    let current = this.root(root);
    const operation = this.operation();
    let result = 0;
    let isRoot = true;
    while (current) {
      const page = await this.load(operation, current, isRoot);
      if (target <= page.first) return result;
      if (target > page.last) return result + page.count;
      if (page.kind === 'leaf') return result + lowerBound(page.entries, target);
      const index = childBound(page.children, target);
      for (let before = 0; before < index; before++) result += page.children[before].count;
      current = page.children[index];
      isRoot = false;
    }
    return result;
  }

  entries<T>(root: ArchiveIndexRoot | undefined,
    options: { from?: string; to?: string; limit?: number; reverse?: boolean } = {}): AsyncGenerator<[string, T]> {
    const snapshot = this.root(root);
    if (options === null || typeof options !== 'object') argument('range options must be an object.');
    const { from, to, limit = Number.MAX_SAFE_INTEGER, reverse = false } = options;
    if (from !== undefined) key(from);
    if (to !== undefined) key(to);
    if (!Number.isSafeInteger(limit) || limit < 0) argument('limit must be a nonnegative safe integer.');
    if (typeof reverse !== 'boolean') argument('reverse must be a boolean.');
    return this.iterate<T>(snapshot, from, to, limit, reverse);
  }

  private async *iterate<T>(root: ArchiveIndexRoot | undefined, from: string | undefined, to: string | undefined,
    limit: number, reverse: boolean): AsyncGenerator<[string, T]> {
    if (!root || limit === 0 || (from !== undefined && to !== undefined && from >= to)) return;
    const operation = this.operation();
    let remaining = limit;
    const overlaps = (reference: ArchiveIndexRoot): boolean =>
      (from === undefined || reference.last >= from) && (to === undefined || reference.first < to);
    const visit = async function* (this: ArchivePages, reference: ArchiveIndexRoot,
      isRoot: boolean): AsyncGenerator<[string, T]> {
      if (remaining === 0 || (!isRoot && !overlaps(reference))) return;
      const page = await this.load(operation, reference, isRoot);
      if (!overlaps(reference)) return;
      if (page.kind === 'leaf') {
        const start = from === undefined ? 0 : lowerBound(page.entries, from);
        const end = to === undefined ? page.entries.length : lowerBound(page.entries, to);
        for (let offset = reverse ? end - 1 : start; reverse ? offset >= start : offset < end; offset += reverse ? -1 : 1) {
          if (remaining === 0) return;
          const [entryKey, value] = page.entries[offset];
          remaining--;
          yield [entryKey, jsonClone(value) as T];
        }
      } else {
        for (let index = reverse ? page.children.length - 1 : 0;
          reverse ? index >= 0 : index < page.children.length; index += reverse ? -1 : 1) {
          if (remaining === 0) return;
          const child = page.children[index];
          if (overlaps(child)) yield* visit.call(this, child, false);
        }
      }
    };
    yield* visit.call(this, root, true);
  }
}
