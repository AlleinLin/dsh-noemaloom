import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { lstat, mkdir, readFile, realpath, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { NexusError } from '../../ports/contracts.js';
import { createServer } from 'node:net';
import { sha256 } from './canonical.js';

export interface LeaseOptions {
  lockTimeoutMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  retryMs?: number;
}

interface Owner {
  schemaVersion: 1;
  token: string;
  pid: number;
  host: string;
  createdAt: string;
}

const queues = new Map<string, Promise<void>>();

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new NexusError('CANCELLED', '操作已取消。');
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  abortIfNeeded(signal);
  await new Promise<void>((accept, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', cancel);
      accept();
    };
    const timer = setTimeout(done, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(new NexusError('CANCELLED', '操作已取消。'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

/** Shared by store instances in this process; the filesystem lease also covers other processes. */
async function localQueue<T>(key: string, work: () => Promise<T>, signal: AbortSignal | undefined, deadline: number): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>((accept) => { unlock = accept; });
  const tail = prior.then(() => current);
  queues.set(key, tail);
  try {
    abortIfNeeded(signal);
    await new Promise<void>((accept, reject) => {
      const cancel = () => finish(new NexusError('CANCELLED', '操作已取消。'));
      const timer = setTimeout(() => finish(new NexusError('RATE_LIMITED', '等待资源租约超时。')), Math.max(0, deadline - Date.now()));
      const finish = (error?: unknown) => {
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        error ? reject(error) : accept();
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      void prior.then(() => finish(), finish);
    });
    abortIfNeeded(signal);
    if (Date.now() >= deadline) throw new NexusError('RATE_LIMITED', '等待资源租约超时。');
    return await work();
  } finally {
    unlock();
    // A cancelled waiter leaves a resolved link behind its predecessor. Never
    // remove that predecessor from the queue while its write is still active.
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  }
}

async function readOwner(directory: string): Promise<Owner | undefined> {
  try {
    const owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')) as Owner | null;
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return undefined;
    return owner.schemaVersion === 1 && typeof owner.token === 'string'
      && Number.isSafeInteger(owner.pid) && owner.pid > 0
      && typeof owner.host === 'string' ? owner : undefined;
  } catch (error) {
    if (errno(error) === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function livingOwner(owner: Owner): boolean {
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    // Lack of permission to signal is evidence the process exists.
    return errno(error) === 'EPERM' || errno(error) === 'EACCES';
  }
}

async function expired(directory: string, leaseMs: number): Promise<boolean> {
  const owner = await readOwner(directory);
  // A suspended local process may miss heartbeats. Never steal its live write lease.
  if (owner && livingOwner(owner)) return false;
  try {
    const info = await stat(owner ? join(directory, 'owner.json') : directory);
    return Date.now() - info.mtimeMs > leaseMs;
  } catch (error) {
    if (errno(error) === 'ENOENT') return false;
    throw error;
  }
}

async function removeOwnedDirectory(directory: string, token: string): Promise<void> {
  if ((await readOwner(directory))?.token !== token) return;
  try {
    await unlink(join(directory, 'owner.json'));
    await rmdir(directory);
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
}

/** A kernel-owned mutex has no torn owner file and vanishes on process exit. */
async function recoveryMutex(directory: string, work: () => Promise<void>): Promise<void> {
  if (process.platform !== 'win32' && process.platform !== 'linux') return work();
  const name = `dsh-nexus-recovery-${sha256(process.platform === 'win32' ? directory.toLowerCase() : directory)}`;
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : `\0${name}`;
  const server = createServer(socket => socket.destroy());
  const acquired = await new Promise<boolean>((accept, reject) => {
    const error = (cause: NodeJS.ErrnoException) => cause.code === 'EADDRINUSE' ? accept(false) : reject(cause);
    server.once('error', error);
    server.listen({ path: endpoint, exclusive: true }, () => { server.off('error', error); accept(true); });
  });
  if (!acquired) return;
  server.unref();
  try { await work(); }
  finally { await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); }
}

/**
 * No recursive deletion is used: a lease owns exactly one owner.json file.
 * The separate recovery guard serializes stale-lock recovery and is itself leased.
 */
async function recover(directory: string, leaseMs: number): Promise<void> {
  return recoveryMutex(directory, () => recoverUnderMutex(directory, leaseMs));
}

async function recoverUnderMutex(directory: string, leaseMs: number): Promise<void> {
  const guard = `${directory}.recovery`;
  const token = randomUUID();
  const owner: Owner = { schemaVersion: 1, token, pid: process.pid, host: hostname(), createdAt: new Date().toISOString() };
  try {
    await mkdir(guard);
  } catch (error) {
    if (errno(error) !== 'EEXIST') throw error;
    // A dead recovery owner cannot perform a store write. Remove its small guard,
    // then compete normally on the next iteration rather than assuming ownership.
    if (await expired(guard, leaseMs)) {
      const old = await readOwner(guard);
      if (old && !livingOwner(old)) await removeOwnedDirectory(guard, old.token);
      else if (!old) {
        const directoryInfo = await lstat(guard);
        const ownerPath = join(guard, 'owner.json');
        const broken = await lstat(ownerPath).catch(error => { if (errno(error) !== 'ENOENT') throw error; });
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
          || (broken && (!broken.isFile() || broken.isSymbolicLink()))) {
          throw new NexusError('INTEGRITY_FAILED', '恢复租约不是普通目录或文件。');
        }
        // Recheck after the filesystem reads: an owner that has completed its
        // file must never be mistaken for the corrupt file we inspected.
        if (await readOwner(guard) || !(await expired(guard, leaseMs))) return;
        await unlink(ownerPath).catch(error => { if (errno(error) !== 'ENOENT') throw error; });
        await rmdir(guard).catch(error => {
          if (errno(error) !== 'ENOENT' && errno(error) !== 'ENOTEMPTY') throw error;
        });
      }
    }
    return;
  }
  try {
    await writeFile(join(guard, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    if (!(await expired(directory, leaseMs))) return;
    const old = await readOwner(directory);
    if (old && !livingOwner(old)) await removeOwnedDirectory(directory, old.token);
    else if (!old) {
      // An interrupted owner-file creation leaves an empty directory.
      await unlink(join(directory, 'owner.json')).catch((error: unknown) => {
        if (errno(error) !== 'ENOENT') throw error;
      });
      await rmdir(directory).catch((error: unknown) => {
        if (errno(error) !== 'ENOENT' && errno(error) !== 'ENOTEMPTY') throw error;
      });
    }
  } finally {
    await removeOwnedDirectory(guard, token);
  }
}

export interface Lease {
  /** Check immediately before committing an atomic replacement. */
  assertOwned(): Promise<void>;
}

export interface LeaseManager {
  withLease<T>(resource: string, work: (lease: Lease) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export function createLeaseManager(root: string, options: LeaseOptions = {}): LeaseManager {
  const absoluteRoot = resolve(root);
  const leaseMs = options.leaseMs ?? 30_000;
  const timeoutMs = options.lockTimeoutMs ?? 60_000;
  const heartbeatMs = options.heartbeatMs ?? Math.max(25, Math.floor(leaseMs / 3));
  const retryMs = options.retryMs ?? 25;
  if ([leaseMs, timeoutMs, heartbeatMs, retryMs].some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new NexusError('INVALID_ARGUMENT', '租约时限必须为正数。');
  }
  return {
    async withLease<T>(resource: string, work: (lease: Lease) => Promise<T>, signal?: AbortSignal): Promise<T> {
      const beganAt = Date.now();
      abortIfNeeded(signal);
      await mkdir(absoluteRoot, { recursive: true });
      const rootInfo = await lstat(absoluteRoot);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new NexusError('INTEGRITY_FAILED', '租约目录不是受支持的普通目录。');
      }
      // Parent junctions and Windows path casing must identify one kernel
      // mutex and one local queue for the same physical lease directory.
      const directory = join(await realpath(absoluteRoot), `${sha256(resource)}.lock`);
      const queueKey = process.platform === 'win32' ? directory.toLowerCase() : directory;
      return localQueue(queueKey, async () => {
        abortIfNeeded(signal);
        await mkdir(dirname(directory), { recursive: true });
        const rootInfo = await lstat(absoluteRoot);
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
          throw new NexusError('INTEGRITY_FAILED', '租约目录不是受支持的普通目录。');
        }
        const token = randomUUID();
        const owner: Owner = { schemaVersion: 1, token, pid: process.pid, host: hostname(), createdAt: new Date().toISOString() };
        for (;;) {
          abortIfNeeded(signal);
          try {
            await mkdir(directory);
            try {
              await writeFile(join(directory, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
            } catch (error) {
              await rmdir(directory).catch(() => undefined);
              throw error;
            }
            break;
          } catch (error) {
            if (errno(error) !== 'EEXIST') throw error;
            await recover(directory, leaseMs);
            if (Date.now() - beganAt >= timeoutMs) {
              throw new NexusError('RATE_LIMITED', '资源正在被另一项操作使用，请稍后重试。', { retryAfterMs: retryMs });
            }
            await pause(retryMs, signal);
          }
        }
        let heartbeatFailed = false;
        let beating: Promise<void> = Promise.resolve();
        const timer = setInterval(() => {
          beating = beating.then(async () => {
            if ((await readOwner(directory))?.token !== token) {
              heartbeatFailed = true;
              return;
            }
            const now = new Date();
            await utimes(join(directory, 'owner.json'), now, now);
          }).catch(() => { heartbeatFailed = true; });
        }, heartbeatMs);
        timer.unref();
        const lease: Lease = {
          async assertOwned(): Promise<void> {
            if (heartbeatFailed || (await readOwner(directory))?.token !== token) {
              throw new NexusError('INTEGRITY_FAILED', '资源租约已失效，写入未提交。');
            }
          },
        };
        try {
          return await work(lease);
        } finally {
          clearInterval(timer);
          await beating;
          await removeOwnedDirectory(directory, token);
        }
      }, signal, beganAt + timeoutMs);
    },
  };
}
