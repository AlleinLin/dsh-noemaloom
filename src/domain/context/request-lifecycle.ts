import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';

export interface ContextRequestOwner {
  version: 1;
  pid: number;
  hostname: string;
  processInstanceId: string;
  token: string;
}
const KEY = Symbol.for('dsh-nexus.context.request-lifecycle.v1');
interface Runtime { instanceId: string; active: Set<string> }
function runtime(): Runtime {
  const root = globalThis as typeof globalThis & { [KEY]?: Runtime };
  return root[KEY] ??= { instanceId: randomUUID(), active: new Set() };
}
function key(dataDir: string, token: string): string { return `${path.resolve(dataDir).toLowerCase()}\0${token}`; }
export function beginContextRequest(dataDir: string): { owner: ContextRequestOwner; end(): void } {
  const current = runtime(), token = randomUUID();
  const owner: ContextRequestOwner = { version: 1, pid: process.pid, hostname: hostname(), processInstanceId: current.instanceId, token };
  current.active.add(key(dataDir, token));
  return { owner, end: () => { current.active.delete(key(dataDir, token)); } };
}
export function validContextRequestOwner(value: unknown): value is ContextRequestOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as ContextRequestOwner;
  return owner.version === 1 && Number.isSafeInteger(owner.pid) && owner.pid > 0
    && typeof owner.hostname === 'string' && owner.hostname.length > 0 && owner.hostname.length < 256
    && /^[a-f0-9-]{36}$/.test(owner.processInstanceId) && /^[a-f0-9-]{36}$/.test(owner.token);
}
/** No timestamp expiry: another live process may be suspended or awaiting a provider. */
export function contextRequestState(dataDir: string, owner: ContextRequestOwner | undefined): 'active' | 'ended' | 'unproven' {
  if (!validContextRequestOwner(owner) || owner.hostname !== hostname()) return 'unproven';
  const current = runtime();
  if (owner.pid === process.pid) {
    // All bundles in this process share the same Symbol runtime. A different
    // instance with this PID belongs to an earlier process that reused the PID.
    return owner.processInstanceId === current.instanceId && current.active.has(key(dataDir, owner.token))
      ? 'active' : 'ended';
  }
  try { process.kill(owner.pid, 0); return 'active'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'ended' : 'unproven'; }
}
