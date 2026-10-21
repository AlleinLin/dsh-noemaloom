import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createLeaseManager } from '../src/domain/storage/lease.js';
import { sha256 } from '../src/domain/storage/canonical.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('lease did not settle')), 2000); })]); }
  finally { clearTimeout(timer); }
}

test('cancelled and timed out queued writers settle without passing a live predecessor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-lease-lifecycle-'));
  const entered = deferred(), release = deferred();
  const manager = createLeaseManager(root, { lockTimeoutMs: 80 });
  const owner = manager.withLease('shared', async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let writes = 0;
  try {
    const signal = new AbortController();
    const cancelled = manager.withLease('shared', async () => { writes++; }, signal.signal);
    signal.abort();
    await assert.rejects(bounded(cancelled), (error: any) => error.code === 'CANCELLED');
    await assert.rejects(bounded(manager.withLease('shared', async () => { writes++; })), (error: any) => error.code === 'RATE_LIMITED');
    assert.equal(writes, 0);
    release.resolve();
    await owner;
    await manager.withLease('shared', async () => { writes++; });
    assert.equal(writes, 1);
  } finally { release.resolve(); await owner; await rm(root, { recursive: true, force: true }); }
});

for (const payload of ['{"schemaVersion":', 'null', '[]', '"invalid-owner"']) test(`an expired recovery guard with invalid owner ${payload} does not block stale-lock recovery`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-lease-guard-'));
  const directory = join(root, `${sha256('resource')}.lock`);
  const guard = `${directory}.recovery`;
  try {
    await mkdir(directory); await mkdir(guard);
    await writeFile(join(guard, 'owner.json'), payload);
    const old = new Date(Date.now() - 20_000);
    await utimes(directory, old, old); await utimes(join(guard, 'owner.json'), old, old); await utimes(guard, old, old);
    let entered = false;
    await bounded(createLeaseManager(root, { leaseMs: 10, heartbeatMs: 5, retryMs: 2, lockTimeoutMs: 1000 }).withLease('resource', async lease => {
      await lease.assertOwned(); entered = true;
    }));
    assert.equal(entered, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('two processes recover a torn guard without deleting a new recovery owner or overlapping writers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-lease-processes-'));
  const directory = join(root, `${sha256('resource')}.lock`), guard = `${directory}.recovery`;
  try {
    await mkdir(directory); await mkdir(guard); await writeFile(join(guard, 'owner.json'), '{');
    const old = new Date(Date.now() - 20_000);
    await utimes(directory, old, old); await utimes(guard, old, old);
    const code = `
      import {appendFile} from 'node:fs/promises';
      import {join} from 'node:path';
      import {createLeaseManager} from ${JSON.stringify(new URL('../src/domain/storage/lease.ts', import.meta.url).href)};
      const root=process.argv[1];
      await createLeaseManager(root,{leaseMs:10,heartbeatMs:5,retryMs:2,lockTimeoutMs:5000})
        .withLease('resource',async lease=>{
          await lease.assertOwned();
          await appendFile(join(root,'events.jsonl'),JSON.stringify({kind:'begin',pid:process.pid})+'\\n');
          await new Promise(resolve=>setTimeout(resolve,40));
          await lease.assertOwned();
          await appendFile(join(root,'events.jsonl'),JSON.stringify({kind:'end',pid:process.pid})+'\\n');
        });
    `;
    const launch = (path = root) => new Promise<void>((accept, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code, path], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', data => { stderr += data; });
      child.once('error', reject);
      child.once('exit', status => status === 0 ? accept() : reject(new Error(stderr || `lease child exit ${status}`)));
    });
    await Promise.all([launch(), launch(process.platform === 'win32' ? root.toLowerCase() : root)]);
    const rows = (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map(row => row.kind), ['begin', 'end', 'begin', 'end']);
    assert.notEqual(rows[0].pid, rows[2].pid);
  } finally { await rm(root, { recursive: true, force: true }); }
});
