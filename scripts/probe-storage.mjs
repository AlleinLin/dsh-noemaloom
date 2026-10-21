import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { cpus, freemem, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createSqliteStore } from '../src/domain/storage/sqlite.ts';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] : null;

if (argv.includes('--crash-child')) {
  const store = await createSqliteStore(option('--directory'), packageRoot);
  for (let index = 0; index < 1000000; index++) {
    await store.put('crash-journal', `row-${String(index).padStart(8, '0')}`, { index, hash: hash({ index }) }, 0);
    // An acknowledged entry has already received SQLite's FULL-synchronous COMMIT.
    if (index % 64 === 0) process.send?.({ committed: index + 1 });
  }
  await store.close();
  process.exit(0);
}

const count = Number(option('--records', '100000'));
assert(Number.isSafeInteger(count) && count >= 100000 && count <= 1000000, 'The probe must contain at least 100000 actual records');
const output = resolve(option('--output', join(packageRoot, 'evidence', 'storage-100k.json')));
const directory = await mkdtemp(join(tmpdir(), 'nexus-sqlite-probe-'));
const startedAt = new Date().toISOString();
const observations = { fixture: 'temporary-generated-data', machineBackupCreated: false, applicationProfileAccessed: false };
let store, child;
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
try {
  store = await createSqliteStore(directory, packageRoot);
  observations.facts = await store.facts();
  assert.equal(observations.facts.backend, 'node:sqlite-worker');
  assert.equal(observations.facts.integrity, 'ok');
  const started = performance.now();
  const writeBatchTimes = [];
  for (let offset = 0; offset < count; offset += 128) {
    const batchStart = performance.now();
    await Promise.all(Array.from({ length: Math.min(128, count - offset) }, (_, position) => {
      const index = offset + position;
      return store.put('probe-records', `record-${String(index).padStart(8, '0')}`, {
        index, kind: index % 2 ? 'task' : 'usage',
        payload: `中文/emoji-🧭-${index}-${'x'.repeat(256)}`,
        logicalCallId: `call-${Math.floor(index / 3)}`, attemptId: `attempt-${index}`,
      }, 0);
    }));
    writeBatchTimes.push(performance.now() - batchStart);
    if (offset && offset % 12800 === 0) console.log(JSON.stringify({ phase: 'write', committed: Math.min(offset + 128, count), expected: count }));
  }
  observations.writes = { records: count, elapsedMs: performance.now() - started,
    batchSize: 128, batchP50Ms: percentile(writeBatchTimes, 0.5), batchP95Ms: percentile(writeBatchTimes, 0.95) };
  const readTimes = [];
  for (let sample = 0; sample < 1000; sample++) {
    const index = (sample * 7919) % count, start = performance.now();
    const row = await store.get('probe-records', `record-${String(index).padStart(8, '0')}`);
    assert.equal(row?.value.index, index);
    assert.equal(row.revision, 1);
    readTimes.push(performance.now() - start);
  }
  observations.pointReads = { samples: readTimes.length, p50Ms: percentile(readTimes, 0.5), p95Ms: percentile(readTimes, 0.95), maxMs: Math.max(...readTimes) };
  const listStart = performance.now();
  const rows = await store.list('probe-records');
  assert.equal(rows.length, count);
  observations.fullScan = { records: rows.length, elapsedMs: performance.now() - listStart, includesStructuredCloneAndJsonDecoding: true };
  for (let index = 0; index < 1000; index++) {
    await Promise.all([
      store.put('task-append', `task-${index}`, { index, state: 'queued', evidenceRefs: [] }, 0),
      store.put('usage-append', `usage-${index}`, { index, reported: false, inputTokens: null, cost: null }, 0),
    ]);
  }
  assert.equal((await store.list('task-append')).length, 1000);
  assert.equal((await store.list('usage-append')).length, 1000);
  const compacted = { originalHashes: rows.slice(0, 32).map(row => hash(row.value)), sourceIds: rows.slice(0, 32).map(row => row.id), epoch: 1, committed: true };
  await store.put('compression-commits', 'atomic-envelope', { ...compacted, hash: hash(compacted) }, 0);
  const races = await Promise.allSettled(Array.from({ length: 16 }, (_, index) => store.put('compression-commits', 'atomic-envelope', { winner: index }, 1)));
  assert.equal(races.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(races.filter(result => result.status === 'rejected' && result.reason.code === 'REVISION_CONFLICT').length, 15);
  observations.concurrentCas = { contenders: 16, commits: 1, conflicts: 15 };
  await store.close(); store = undefined;

  let acknowledged = 0;
  child = fork(scriptPath, ['--crash-child', '--directory', directory], { execArgv: process.execArgv, cwd: packageRoot, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const crashStart = performance.now();
  await new Promise((resolveCrash, rejectCrash) => {
    const timer = setTimeout(() => { child.kill(); rejectCrash(new Error('Crash child did not commit within 60 seconds')); }, 60000);
    child.on('message', message => {
      acknowledged = Math.max(acknowledged, Number(message.committed ?? 0));
      if (acknowledged >= 257) child.kill('SIGKILL');
    });
    child.once('error', error => { clearTimeout(timer); rejectCrash(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); acknowledged >= 257 ? resolveCrash({ code, signal }) : rejectCrash(new Error(`Crash child exited before commit: ${code}/${signal}`)); });
  });
  child = undefined;
  store = await createSqliteStore(directory, packageRoot);
  const recovered = await store.list('crash-journal');
  assert(recovered.length >= acknowledged);
  for (let index = 0; index < acknowledged; index++) {
    assert.equal(recovered[index].value.index, index);
    assert.equal(recovered[index].value.hash, hash({ index }));
  }
  const factsAfterCrash = await store.facts();
  assert.equal(factsAfterCrash.integrity, 'ok');
  assert.equal((await store.get('probe-records', 'record-00000000')).value.index, 0);
  observations.abruptTermination = { actualProcessKilled: true, acknowledged, recovered: recovered.length, integrity: factsAfterCrash.integrity, elapsedMs: performance.now() - crashStart };
  observations.continuousAppend = { tasks: 1000, usageAttempts: 1000, reportedUsageInvented: false };
  observations.scope = 'SQLite storage envelope, worker responsiveness and acknowledged durability; not a claim that all domain compaction semantics passed';
  observations.completed = true;
} catch (error) {
  observations.completed = false;
  observations.error = { name: error.name, code: error.code, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  delay.disable();
  child?.kill('SIGKILL');
  await store?.close().catch(error => { observations.closeError = error.message; process.exitCode = 1; });
  observations.eventLoop = { meanMs: Number.isFinite(delay.mean) ? delay.mean / 1e6 : null, p95Ms: delay.percentile(95) / 1e6, maxMs: delay.max / 1e6 };
  observations.runtime = { label: option('--runtime-label', 'current-node'), executable: process.execPath, node: process.version, modulesAbi: process.versions.modules, sqlite: process.versions.sqlite, platform: platform(), osRelease: release(), cpus: cpus().map(cpu => cpu.model), totalMemoryBytes: totalmem(), freeMemoryBytes: freemem() };
  observations.startedAt = startedAt;
  observations.finishedAt = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(observations, null, 2) + '\n');
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert(basename(directory).startsWith('nexus-sqlite-probe-'));
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ output, completed: observations.completed, records: count, runtime: observations.runtime.label }));
}
