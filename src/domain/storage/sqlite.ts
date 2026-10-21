import { Worker } from 'node:worker_threads';
import { mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NexusError, type JsonRecord, type NexusStore, type StoredRecord } from '../../ports/contracts.js';
import { canonicalJson } from './canonical.js';

export class SqliteStore implements NexusStore {
  private counter = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: unknown): void }>();
  private closed = false;
  private closing = false;
  private terminalFailure: unknown;
  private closePromise?: Promise<void>;
  private integritySource?: { workerUrl: URL; database: string };
  private integrityState: JsonRecord = { state: 'not-checked', mode: 'manual-only' };
  private integrityRun?: { promise: Promise<JsonRecord>; cancel(): Promise<void> };
  readonly ready: Promise<void>;
  constructor(private worker: Worker) {
    this.ready = new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        worker.off('message', first); worker.off('error', failed); worker.off('exit', exited);
        error ? reject(error) : resolve();
      };
      const first = (message: any) => { if (message.ready) finish(); };
      const failed = (error: unknown) => finish(error);
      const exited = (code: number) => finish(new NexusError('INTERNAL', `存储 worker 在就绪前退出 ${code}`));
      worker.on('message', first);
      worker.once('error', failed);
      worker.once('exit', exited);
    });
    worker.on('message', message => {
      if (!message.id) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new NexusError(message.error.code, message.error.message, message.error.details));
    });
    worker.on('error', error => this.fail(error));
    worker.on('exit', code => { if (!this.closed) this.fail(new NexusError('INTERNAL', `SQLite worker 已退出 ${code}`)); });
  }
  private fail(error: unknown): void { this.terminalFailure ??= error; this.rejectAll(this.terminalFailure); }
  private rejectAll(error: unknown): void { for (const item of this.pending.values()) item.reject(error); this.pending.clear(); }
  private async call(operation: string, collection?: string, recordId?: string, value?: unknown, expectedRevision?: number): Promise<any> {
    await this.ready;
    if (this.closed) throw new NexusError('CANCELLED', '存储已关闭');
    if (this.terminalFailure) throw this.terminalFailure;
    if (this.closing && operation !== 'close') throw new NexusError('CANCELLED', '存储正在关闭');
    for (const [name, input] of [['collection', collection], ['id', recordId]] as const) {
      if (input !== undefined && (!input || input.length > 4096 || input.includes('\0'))) throw new NexusError('INVALID_ARGUMENT', `${name} 无效`);
    }
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new NexusError('INVALID_ARGUMENT', 'expectedRevision 无效');
    const payload = value === undefined ? {} : { value: canonicalJson(value) };
    const id = ++this.counter;
    const result = new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    try { this.worker.postMessage({ id, operation, collection, recordId, ...payload, expectedRevision }); }
    catch (error) { this.pending.get(id)?.reject(error); this.pending.delete(id); }
    return result;
  }
  get<T = unknown>(collection: string, id: string): Promise<StoredRecord<T> | undefined> { return this.call('get', collection, id); }
  list<T = unknown>(collection: string): Promise<StoredRecord<T>[]> { return this.call('list', collection); }
  put<T = unknown>(collection: string, id: string, value: T, expectedRevision?: number): Promise<StoredRecord<T>> { return this.call('put', collection, id, value, expectedRevision); }
  remove(collection: string, id: string, expectedRevision?: number): Promise<boolean> { return this.call('remove', collection, id, undefined, expectedRevision); }
  async facts(): Promise<JsonRecord> {
    return { ...await this.call('facts'), integrity: this.integrityState.state, integrityCheck: { ...this.integrityState } };
  }
  /** The existing bundle also supports an isolated, explicitly requested scan. */
  useIntegrityWorker(workerUrl: URL, database: string): void { this.integritySource = { workerUrl, database }; }
  checkIntegrity(): Promise<JsonRecord> {
    if (this.closed || this.closing) return Promise.reject(new NexusError('CANCELLED', '存储已关闭或正在关闭'));
    if (this.integrityRun) return this.integrityRun.promise;
    if (!this.integritySource) return Promise.reject(new NexusError('HOST_CONTRACT_UNSUPPORTED', '当前存储不支持独立完整性检查'));
    const startedAt = new Date().toISOString(), started = Date.now();
    let worker: Worker;
    try { worker = new Worker(this.integritySource.workerUrl, { workerData: { database: this.integritySource.database, mode: 'integrity' } }); }
    catch (error) {
      this.integrityState = { state: 'error', mode: 'manual-only', startedAt, code: 'STORAGE_INTEGRITY_START_FAILED' };
      return Promise.reject(error);
    }
    let resolve!: (value: JsonRecord) => void, reject!: (error: unknown) => void, finishing: Promise<void> | undefined;
    const promise = new Promise<JsonRecord>((accept, fail) => { resolve = accept; reject = fail; });
    // A disconnected client does not release ownership. Retries join this scan
    // until its worker actually exits, and cannot multiply expensive scans.
    void promise.catch(() => {});
    this.integrityState = { state: 'running', mode: 'manual-only', startedAt };
    const finish = (result?: JsonRecord, error?: unknown): Promise<void> => {
      if (finishing) return finishing;
      finishing = (async () => {
        try { await worker.terminate(); }
        catch (terminationError) { error ??= terminationError; }
        const completedAt = new Date().toISOString(), durationMs = Date.now() - started;
        this.integrityState = error
          ? { state: error instanceof NexusError && error.code === 'CANCELLED' ? 'cancelled' : 'error',
            mode: 'manual-only', startedAt, completedAt, durationMs, code: error instanceof NexusError ? error.code : 'STORAGE_INTEGRITY_FAILED' }
          : { ...result, state: result!.integrity, mode: 'manual-only', startedAt, completedAt, durationMs };
        this.integrityRun = undefined;
        error ? reject(error) : resolve({ ...this.integrityState });
      })();
      return finishing;
    };
    this.integrityRun = { promise, cancel: () => finish(undefined, new NexusError('CANCELLED', '手动完整性检查已取消')) };
    worker.on('message', message => {
      if (finishing) return;
      if (message.ready) {
        try { worker.postMessage({ id: 1, operation: 'integrity' }); }
        catch (error) { void finish(undefined, error); }
      } else if (message.id === 1) {
        if (!message.ok) void finish(undefined, new NexusError(message.error.code, message.error.message, message.error.details));
        else if (!message.result || !['ok', 'failed'].includes(message.result.integrity)
            || !Array.isArray(message.result.messages) || !message.result.messages.length
            || message.result.messages.some((value: unknown) => typeof value !== 'string')
            || (message.result.integrity === 'ok') !== (message.result.messages.length === 1 && message.result.messages[0] === 'ok')) {
          void finish(undefined, new NexusError('INTEGRITY_FAILED', '完整性检查未返回有效结果'));
        } else void finish(message.result);
      }
    });
    worker.once('error', error => { void finish(undefined, error); });
    worker.once('exit', code => { if (!finishing) void finish(undefined, new NexusError('INTERNAL', `完整性检查 worker 意外退出 ${code}`)); });
    return promise;
  }
  async cancelIntegrityCheck(): Promise<JsonRecord> {
    await this.integrityRun?.cancel();
    return { ...this.integrityState };
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    return this.closePromise = this.finishClose();
  }
  private async finishClose(): Promise<void> {
    if (this.closed) return;
    let closeFailed = false;
    try { await this.cancelIntegrityCheck(); await this.call('close'); }
    catch (error) { closeFailed = true; throw error; }
    finally {
      this.closed = true;
      this.rejectAll(new NexusError('CANCELLED', '存储已关闭'));
      try { await this.worker.terminate(); }
      catch (error) { if (!closeFailed) throw error; }
    }
  }
}
/** SQLite is deliberately loaded at runtime in the actual Desktop Node ABI. */
export async function createSqliteStore(dataDir: string, packageRoot: string): Promise<SqliteStore> {
  try { await import('node:sqlite'); }
  catch { throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '此 DSH Node 运行时不支持 node:sqlite；不能把 JSON fallback 冒充事务库'); }
  const directory = join(dataDir, 'database');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new NexusError('PERMISSION_DENIED', '数据库目录不能为链接');
  const workerUrl = pathToFileURL(join(packageRoot, 'lib', 'workers', 'storage-worker.js'));
  const database = join(directory, 'nexus.sqlite');
  const worker = new Worker(workerUrl, { workerData: { database } });
  try {
    const store = new SqliteStore(worker);
    await store.ready;
    await store.facts();
    store.useIntegrityWorker(workerUrl, database);
    return store;
  } catch (error) {
    try { await worker.terminate(); } catch { /* Preserve the initialization error. */ }
    throw error;
  }
}
