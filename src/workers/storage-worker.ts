import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';

interface StorageWorkerData { database: string; mode?: 'integrity'; }
interface WorkerRequest { id: number; operation: string; collection?: string; recordId?: string; value?: string; expectedRevision?: number; }
const { DatabaseSync } = await import('node:sqlite');
const integrityReader = (workerData as StorageWorkerData).mode === 'integrity';
const database = new DatabaseSync((workerData as StorageWorkerData).database, { readOnly: integrityReader });
// Manual diagnostics never alter schema, journal mode or another connection's WAL.
if (integrityReader) database.exec('PRAGMA busy_timeout=1000; PRAGMA query_only=ON;');
else database.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=30000;
  CREATE TABLE IF NOT EXISTS nexus_records(
    collection TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
    value TEXT, checksum TEXT NOT NULL, updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(collection,id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS nexus_records_collection_live ON nexus_records(collection,deleted,id);
  PRAGMA user_version=1;
`);
const select = integrityReader ? undefined : database.prepare('SELECT * FROM nexus_records WHERE collection=? AND id=?');
const list = integrityReader ? undefined : database.prepare('SELECT * FROM nexus_records WHERE collection=? AND deleted=0 ORDER BY id');
const upsert = integrityReader ? undefined : database.prepare(`INSERT INTO nexus_records(collection,id,revision,value,checksum,updated_at,deleted) VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(collection,id) DO UPDATE SET revision=excluded.revision,value=excluded.value,checksum=excluded.checksum,updated_at=excluded.updated_at,deleted=excluded.deleted`);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const serialize = (row: any) => {
  if (!row || row.deleted) return undefined;
  if (digest(row.value) !== row.checksum) throw Object.assign(new Error('SQLite record checksum mismatch'), { code: 'INTEGRITY_FAILED' });
  return { id: row.id, revision: row.revision, value: JSON.parse(row.value), updatedAt: row.updated_at };
};
parentPort!.on('message', (request: WorkerRequest) => {
  let transaction = false;
  try {
    let result: unknown;
    if (integrityReader !== (request.operation === 'integrity') && request.operation !== 'close') {
      if (integrityReader || request.operation === 'integrity') throw Object.assign(new Error('Full integrity scans require the isolated diagnostic worker'), { code: 'PERMISSION_DENIED' });
    }
    if (request.operation === 'facts') {
      result = { backend: 'node:sqlite-worker', sqlite: (database.prepare('select sqlite_version() as version').get() as any).version,
        userVersion: (database.prepare('PRAGMA user_version').get() as any).user_version,
        synchronous: (database.prepare('PRAGMA synchronous').get() as any).synchronous === 2 ? 'FULL' : 'OTHER',
        journalMode: String((database.prepare('PRAGMA journal_mode').get() as any).journal_mode).toUpperCase(), integrity: 'not-checked',
        worker: { node: process.version, modules: process.versions.modules, napi: process.versions.napi, platform: process.platform, arch: process.arch, threadIsolated: true } };
    } else if (request.operation === 'integrity') {
      const messages = (database.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>).map(row => row.integrity_check);
      result = { integrity: messages.length === 1 && messages[0] === 'ok' ? 'ok' : 'failed', messages,
        check: 'PRAGMA integrity_check', scope: 'sqlite-structure', snapshot: 'read-only-connection' };
    } else if (request.operation === 'get') {
      result = serialize(select!.get(request.collection!, request.recordId!));
    } else if (request.operation === 'list') {
      result = list!.all(request.collection!).map(serialize);
    } else if (request.operation === 'put' || request.operation === 'remove') {
      database.exec('BEGIN IMMEDIATE');
      transaction = true;
      const previous: any = select!.get(request.collection!, request.recordId!);
      const currentRevision = previous?.revision ?? 0;
      if (request.expectedRevision !== undefined && request.expectedRevision !== currentRevision) {
        throw Object.assign(new Error('记录已被其他写入更新'), { code: 'REVISION_CONFLICT', details: { expectedRevision: request.expectedRevision, currentRevision } });
      }
      if (request.operation === 'remove' && (!previous || previous.deleted)) result = false;
      else {
        const revision = currentRevision + 1;
        const updatedAt = new Date().toISOString();
        const value = request.operation === 'remove' ? 'null' : request.value!;
        upsert!.run(request.collection!, request.recordId!, revision, value, digest(value), updatedAt, request.operation === 'remove' ? 1 : 0);
        result = request.operation === 'remove' ? true : { id: request.recordId!, revision, value: JSON.parse(value), updatedAt };
      }
      database.exec('COMMIT');
      transaction = false;
    } else if (request.operation === 'close') {
      if (!integrityReader) database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      database.close();
      parentPort!.postMessage({ id: request.id, ok: true, result: true });
      parentPort!.close();
      return;
    } else throw Object.assign(new Error('Unknown storage operation'), { code: 'INVALID_ARGUMENT' });
    parentPort!.postMessage({ id: request.id, ok: true, result });
  } catch (error: any) {
    if (transaction) { try { database.exec('ROLLBACK'); } catch {} }
    parentPort!.postMessage({ id: request.id, ok: false, error: { code: error.code ?? 'INTERNAL', message: error.message, details: error.details } });
  }
});
parentPort!.postMessage({ ready: true });
