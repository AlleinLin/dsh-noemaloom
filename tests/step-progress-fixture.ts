import { NexusError, type NexusServices, type NexusStore, type StoredRecord } from '../src/ports/contracts.js';

/** Real scope/settings dispatch uses this revisioned store; no external service. */
export function stepProgressServices() {
  const rows = new Map<string, StoredRecord>();
  const store: NexusStore = {
    async get<T>(collection: string, id: string) { return structuredClone(rows.get(`${collection}/${id}`)) as StoredRecord<T> | undefined; },
    async list<T>(collection: string) { return [...rows].filter(([key]) => key.startsWith(`${collection}/`)).map(([, value]) => structuredClone(value)) as StoredRecord<T>[]; },
    async put<T>(collection: string, id: string, value: T, revision?: number) {
      const key = `${collection}/${id}`, old = rows.get(key);
      if (revision !== undefined && revision !== (old?.revision ?? 0)) throw new NexusError('REVISION_CONFLICT', 'Changed');
      const result = { id, value: structuredClone(value), revision: (old?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
      rows.set(key, result); return structuredClone(result);
    },
    async remove(collection, id, revision) {
      const key = `${collection}/${id}`, old = rows.get(key);
      if (revision !== undefined && revision !== (old?.revision ?? 0)) throw new NexusError('REVISION_CONFLICT', 'Changed');
      return rows.delete(key);
    },
  };
  const stop = new AbortController();
  const services = { store, signal: stop.signal, workspaceRoot: process.cwd(), emit() {} } as unknown as NexusServices;
  return { store, services, stop };
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
