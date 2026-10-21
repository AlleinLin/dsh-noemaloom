import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { createLeaseManager } from '../src/domain/storage/lease.js';
import { sha256 } from '../src/domain/storage/canonical.js';

test('Windows lease directory teardown permission races retry without replaying work', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'nexus-lease-windows-race-'));
  const original = fs.mkdir;
  let denied = 0, writes = 0;
  t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
    if (String(args[0]).endsWith('.lock') && denied++ < 2) {
      throw Object.assign(new Error('directory is pending deletion'), { code: denied === 1 ? 'EPERM' : 'EACCES' });
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await createLeaseManager(root, { retryMs: 1, lockTimeoutMs: 500 }).withLease('record', async lease => {
      writes++;
      await lease.assertOwned();
    });
    assert.equal(writes, 1);
    assert.equal(denied, 3);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Windows owner-file permission errors fail without treating them as another writer', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'nexus-lease-windows-acl-'));
  const original = fs.writeFile;
  let attempts = 0, writes = 0;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).endsWith('owner.json')) {
      attempts++;
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(createLeaseManager(root).withLease('record', async () => { writes++; }), { code: 'EACCES' });
    assert.equal(attempts, 1);
    assert.equal(writes, 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Windows recovery waits through delete-pending owner reads and enters only after the other owner releases', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'nexus-lease-windows-owner-race-'));
  const directory = join(await fs.realpath(root), `${sha256('record')}.lock`);
  await fs.mkdir(directory);
  await fs.writeFile(join(directory, 'owner.json'), JSON.stringify({
    schemaVersion: 1, token: 'other-owner', pid: process.pid, host: hostname(), createdAt: new Date().toISOString(),
  }));
  const original = fs.readFile;
  let denied = 0, writes = 0;
  let observed!: () => void;
  const observedBothDenials = new Promise<void>(resolve => { observed = resolve; });
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === join(directory, 'owner.json') && denied < 2) {
      denied++;
      if (denied === 2) observed();
      throw Object.assign(new Error('owner is pending deletion'), { code: denied === 1 ? 'EPERM' : 'EACCES' });
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  const contender = createLeaseManager(root, { retryMs: 2, lockTimeoutMs: 1000 }).withLease('record', async lease => {
    writes++;
    await lease.assertOwned();
  });
  try {
    await Promise.race([
      observedBothDenials,
      contender.then(() => { throw new Error('writer entered before both contention observations'); }),
    ]);
    assert.equal(writes, 0, 'a permission error never grants or steals ownership');
    await fs.unlink(join(directory, 'owner.json'));
    await fs.rmdir(directory);
    await contender;
    assert.equal(denied, 2);
    assert.equal(writes, 1);
  } finally {
    await contender.catch(() => {});
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
