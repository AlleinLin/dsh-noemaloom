interface Version { owner?: object; seq?: number }
interface CacheOptions<T> {
  load(id: string): Promise<T>;
  version(id: string): Version;
  weight(value: T): number;
  now?: () => number;
  maxEntries?: number;
  maxBytes?: number;
  archiveTtlMs?: number;
}
interface Entry<T> {
  version: Version; expires: number; bytes: number; promise: Promise<T>;
}
const same = (a: Version, b: Version) => a.owner === b.owner && a.seq === b.seq;

/** Read-only, bounded archive reuse. Authorization stays with every caller. */
export class CanvasArchiveCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private bytes = 0;
  private readonly now: () => number;
  constructor(private readonly options: CacheOptions<T>) { this.now = options.now ?? Date.now; }
  read(id: string): Promise<T> {
    const version = this.options.version(id);
    const existing = this.entries.get(id);
    if (existing && same(existing.version, version) && existing.expires > this.now()) {
      this.entries.delete(id);
      this.entries.set(id, existing);
      return existing.promise;
    }
    if (existing) this.remove(id, existing);
    const entry: Entry<T> = {
      version, bytes: 0,
      expires: version.owner && Number.isSafeInteger(version.seq) ? Infinity : this.now() + (this.options.archiveTtlMs ?? 1_500),
      promise: undefined as unknown as Promise<T>,
    };
    entry.promise = Promise.resolve().then(() => this.options.load(id)).then(value => {
      if (this.entries.get(id) !== entry) return value;
      if (!same(version, this.options.version(id))) { this.remove(id, entry); return value; }
      const bytes = this.options.weight(value);
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > (this.options.maxBytes ?? 32 * 1024 * 1024)) {
        this.remove(id, entry);
        return value;
      }
      entry.bytes = bytes;
      this.bytes += entry.bytes;
      if (!version.owner || !Number.isSafeInteger(version.seq))
        entry.expires = this.now() + (this.options.archiveTtlMs ?? 1_500);
      this.trim();
      return value;
    }).catch(error => { this.remove(id, entry); throw error; });
    this.entries.set(id, entry);
    this.trim();
    return entry.promise;
  }
  private remove(id: string, entry: Entry<T>) {
    if (this.entries.get(id) !== entry) return;
    this.entries.delete(id);
    this.bytes -= entry.bytes;
  }
  private trim() {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= (this.options.maxEntries ?? 24) && this.bytes <= (this.options.maxBytes ?? 32 * 1024 * 1024)) break;
      this.remove(id, entry);
    }
  }
  clear() { this.entries.clear(); this.bytes = 0; }
}
