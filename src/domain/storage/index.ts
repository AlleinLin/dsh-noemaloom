import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, readdir, unlink, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { NexusError, type NexusStore, type StoredRecord } from '../../ports/contracts.js';
import { canonicalJson, jsonClone, sha256 } from './canonical.js';
import { createLeaseManager, type LeaseManager, type LeaseOptions } from './lease.js';
import { atomicReplace } from './atomic-replace.js';

export { canonicalJson, jsonClone, sha256 } from './canonical.js';
export { createLeaseManager, type Lease, type LeaseManager, type LeaseOptions } from './lease.js';

interface DiskRecord {
  schemaVersion: 1;
  collection: string;
  id: string;
  revision: number;
  updatedAt: string;
  deleted: boolean;
  value: unknown;
  checksum: string;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function assertName(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) {
    throw new NexusError('INVALID_ARGUMENT', `${name} 必须是长度不超过 4096 的非空字符串。`);
  }
}

function assertRevision(value?: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new NexusError('INVALID_ARGUMENT', 'expectedRevision 必须为非负整数。');
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Windows does not expose directory fsync through Node; file fsync plus
    // same-directory rename is still used. Other I/O errors must fail the commit.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR'].includes(errorCode(error) ?? '')) throw error;
  } finally {
    await handle?.close();
  }
}

async function safeDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new NexusError('INTEGRITY_FAILED', '持久化目录不是受支持的普通目录。');
  }
}

/**
 * Every resource is one checksummed, atomic JSON replacement. Tombstones preserve
 * monotonic revisions; unfinished .tmp files are never considered committed data.
 */
export class AtomicStore implements NexusStore {
  readonly root: string;
  private readonly leases: LeaseManager;

  constructor(dataDir: string, options: LeaseOptions = {}) {
    this.root = join(resolve(dataDir), 'store-v1');
    this.leases = createLeaseManager(join(this.root, 'leases'), options);
  }

  private location(collection: string, id: string): string {
    assertName(collection, 'collection');
    assertName(id, 'id');
    return join(this.root, 'records', sha256(collection), `${sha256(id)}.json`);
  }

  private async readDisk(collection: string, id: string): Promise<DiskRecord | undefined> {
    const location = this.location(collection, id);
    let text: string;
    try {
      const info = await lstat(location);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new NexusError('INTEGRITY_FAILED', '持久化记录不是受支持的普通文件。', { collection, id });
      }
      text = await readFile(location, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
    let record: DiskRecord;
    try {
      record = JSON.parse(text) as DiskRecord;
      const { checksum, ...body } = record;
      if (record.schemaVersion !== 1 || record.collection !== collection || record.id !== id
        || !Number.isSafeInteger(record.revision) || record.revision < 1
        || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))
        || typeof record.deleted !== 'boolean' || !Object.hasOwn(record, 'value')
        || checksum !== sha256(canonicalJson(body))) {
        throw new Error('invalid record');
      }
    } catch {
      throw new NexusError('INTEGRITY_FAILED', '持久化记录校验失败；原件已保留，未执行覆盖。', { collection, id });
    }
    return record;
  }

  private publicRecord<T>(record: DiskRecord): StoredRecord<T> {
    return { id: record.id, revision: record.revision, value: jsonClone(record.value) as T, updatedAt: record.updatedAt };
  }

  async get<T = unknown>(collection: string, id: string): Promise<StoredRecord<T> | undefined> {
    const record = await this.readDisk(collection, id);
    return record && !record.deleted ? this.publicRecord<T>(record) : undefined;
  }

  async list<T = unknown>(collection: string): Promise<StoredRecord<T>[]> {
    assertName(collection, 'collection');
    const directory = join(this.root, 'records', sha256(collection));
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
    const result: StoredRecord<T>[] = [];
    for (const name of names.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      let id: unknown;
      try {
        id = (JSON.parse(await readFile(join(directory, name), 'utf8')) as DiskRecord).id;
      } catch {
        throw new NexusError('INTEGRITY_FAILED', '持久化集合包含不可解析的记录；原件已保留。', { collection });
      }
      if (typeof id !== 'string' || `${sha256(id)}.json` !== name) {
        throw new NexusError('INTEGRITY_FAILED', '持久化记录身份校验失败；原件已保留。', { collection });
      }
      const record = await this.readDisk(collection, id);
      if (record && !record.deleted) result.push(this.publicRecord<T>(record));
    }
    return result.sort((left, right) => left.id.localeCompare(right.id, 'en'));
  }

  private async commit(collection: string, id: string, value: unknown, deleted: boolean, expectedRevision?: number): Promise<DiskRecord | undefined> {
    const location = this.location(collection, id);
    assertRevision(expectedRevision);
    const normalizedValue = jsonClone(value);
    await safeDirectory(this.root);
    await safeDirectory(join(this.root, 'records'));
    await safeDirectory(join(this.root, 'leases'));
    return this.leases.withLease(`${collection}\0${id}`, async (lease) => {
      const before = await this.readDisk(collection, id);
      const actualRevision = before?.revision ?? 0;
      if (expectedRevision !== undefined && actualRevision !== expectedRevision) {
        throw new NexusError('REVISION_CONFLICT', '记录已被其他操作修改，请重新加载后合并。', {
          collection, id, expectedRevision, currentRevision: actualRevision, deleted: before?.deleted ?? false,
        });
      }
      if (deleted && (!before || before.deleted)) return undefined;
      if (actualRevision >= Number.MAX_SAFE_INTEGER) {
        throw new NexusError('INTEGRITY_FAILED', '记录 revision 已到达安全整数边界。');
      }
      const body: Omit<DiskRecord, 'checksum'> = {
        schemaVersion: 1,
        collection,
        id,
        revision: actualRevision + 1,
        updatedAt: new Date().toISOString(),
        deleted,
        value: normalizedValue,
      };
      const record: DiskRecord = { ...body, checksum: sha256(canonicalJson(body)) };
      const serialized = canonicalJson(record);
      const directory = dirname(location);
      await safeDirectory(directory);
      const temporary = join(directory, `.${sha256(id)}.${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        if (await readFile(temporary, 'utf8') !== serialized) {
          throw new NexusError('INTEGRITY_FAILED', '临时记录校验失败，写入未提交。');
        }
        await atomicReplace(temporary, location, lease);
        await syncDirectory(directory);
        const verified = await this.readDisk(collection, id);
        if (verified?.checksum !== record.checksum || verified.revision !== record.revision) {
          throw new NexusError('INTEGRITY_FAILED', '写入后的持久化记录未通过核验。');
        }
        return verified;
      } finally {
        await handle?.close();
        await unlink(temporary).catch((error: unknown) => {
          if (errorCode(error) !== 'ENOENT') throw error;
        });
      }
    });
  }

  async put<T = unknown>(collection: string, id: string, value: T, expectedRevision?: number): Promise<StoredRecord<T>> {
    const record = await this.commit(collection, id, value, false, expectedRevision);
    return this.publicRecord<T>(record!);
  }

  async remove(collection: string, id: string, expectedRevision?: number): Promise<boolean> {
    return (await this.commit(collection, id, null, true, expectedRevision)) !== undefined;
  }
}

export function createAtomicStore(dataDir: string, options: LeaseOptions = {}): NexusStore {
  return new AtomicStore(dataDir, options);
}
