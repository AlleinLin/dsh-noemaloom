/**
 * Bounded, reproducible fault injection. Does not slow the computer, touch
 * security software, flush OS caches or claim to reproduce minifilter/WMI load.
 * Run from the project root: node --expose-gc scripts/stress-resilience.mjs
 * Add --wait-timeout-expiry to also sample after a complete historical 30-second
 * timeout window (the entire script should still complete within 60 seconds).
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostFiles } from '../src/host-files.mjs';
import { SearchEngine } from '../src/search.mjs';
import { PowerShellTools } from '../src/pwsh.mjs';
import { environment } from '../tests/helpers.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const report = {
  measuredAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  os: `${os.type()} ${os.release()}`,
  methodology: {
    fileLatency: 'Artificial delay at actual SDK filesystem provider boundaries, with an AbortSignal deadline. Baseline is the official read resolve/stat/readText sequence, not a GUI/model latency measurement.',
    memory: 'Synthetic unique files and search output; repeated construct/churn/dispose, explicit GC, and post-disposal heap samples. RSS is recorded separately and is not interpreted as retained JavaScript heap.',
    powerShell: 'Actual DSH SDK subprocess/PwshLocalExecutor; persistent mode only in the temporary danger-full-access test context.',
    cpuSluggishness: 'One isolated Node child blocks only its own event loop for 120 ms while a read has a 20 ms cancellation deadline. Records timer callback lateness; does not claim JavaScript can interrupt a blocked event loop.',
  },
  limitations: [
    'Not measured on the company workstation; does not reproduce four security products, kernel minifilters or WMI traffic. The isolated event-loop block is a finite CPU scheduling simulation, not a whole-computer slowdown.',
    'Finite endurance tests can detect bounded-cache violations and obvious growth; they cannot prove absence of every memory leak.',
    'A warm cache can avoid provider I/O within its TTL. Fresh/expired reads and actual writes still depend on the underlying provider and disk.',
    'AbortSignal cannot force arbitrary non-cooperative filesystem implementations to complete immediately. The late-completion case explicitly measures that limitation.',
    'Cache byte counters estimate retained content/metadata; temporary I/O buffers, V8 overhead, SDK state, subprocesses and PowerShell user variables are separate.',
  ],
  checks: [],
};
const started = performance.now();
const cleanups = [];
const execFileAsync = promisify(execFile);
const round = value => +value.toFixed(3);
const execution = agent => ({ agent, signal: new AbortController().signal });

async function check(name, operation) {
  const at = performance.now();
  try {
    const detail = await operation();
    report.checks.push({ name, status: 'passed', elapsedMs: round(performance.now() - at), ...detail });
  } catch (error) {
    report.checks.push({ name, status: 'failed', elapsedMs: round(performance.now() - at),
      error: `${error.name}: ${error.message}`, stack: error.stack });
  }
}

async function withDeadline(operation, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`injected deadline ${ms} ms`)), ms);
  const at = performance.now();
  try {
    const value = await operation(controller.signal);
    return { status: 'completed', elapsedMs: round(performance.now() - at), value };
  }
  catch (error) { return { status: 'rejected', elapsedMs: round(performance.now() - at),
    error: `${error.name}: ${error.message}`, deadlineTriggered: controller.signal.aborted }; }
  finally { clearTimeout(timer); }
}

function syntheticContext({ loadDelayMs = 0, cooperate = true, payloadBytes = 2048 } = {}) {
  const root = path.join(os.tmpdir(), 'forge-synthetic-only');
  const counters = { resolve: 0, stat: 0, readText: 0, readBytes: 0, observations: 0 };
  const body = async (target, signal) => {
    if (loadDelayMs) await delay(loadDelayMs, undefined, cooperate ? { signal } : {});
    return `${target.targetKey}:${'x'.repeat(payloadBytes)}\n`;
  };
  const ctx = {
    workingDirectory: { ensure: async () => root },
    emit() { counters.observations++; },
    fs: {
      resolve: async (file, options) => {
        counters.resolve++;
        options?.signal?.throwIfAborted();
        return { targetKey: file, displayPath: path.join(root, file) };
      },
      stat: async (_target, signal) => {
        counters.stat++; signal?.throwIfAborted();
        return { type: 'file', size: payloadBytes, version: 'synthetic-v1' };
      },
      readText: async (target, signal) => {
        counters.readText++;
        return body(target, signal);
      },
      readBytes: async (target, signal, maxBytes) => {
        counters.readBytes++;
        const bytes = Buffer.from(await body(target, signal));
        if (bytes.byteLength > maxBytes) {
          const error = new Error('Synthetic read exceeds bound'); error.code = 'FS_TOO_LARGE';
          throw error;
        }
        return bytes;
      },
      processPath: target => target.displayPath,
      processPathFromHostPath: value => value,
    },
  };
  return { ctx, counters, root };
}

// A fake rg runner isolates cache retention from disk throughput and does not
// launch children. Real rg and its timeout/kill path have separate integration tests.
async function syntheticRg(_executable, argv, options) {
  options.signal?.throwIfAborted();
  let truncated = false, bytes = 0;
  const emit = line => {
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > options.maxBytes) { truncated = true; return false; }
    if (options.onLine(line) === false) { truncated = true; return false; }
    return true;
  };
  if (argv.includes('--files')) {
    for (let i = 0; i < 1000; i++)
      if (!emit(`./src/component-${i}.ts`)) break;
  } else {
    const needle = argv[argv.indexOf('--regexp') + 1];
    for (let i = 0; i < 32; i++)
      if (!emit(JSON.stringify({ type: 'match', data: {
        path: { text: `./src/${i}.ts` }, line_number: i + 1,
        lines: { text: `${needle}:${'search-data-'.repeat(24)}\n` },
      } }))) break;
  }
  options.signal?.throwIfAborted();
  return { truncated, stderr: '', bytes };
}

function memorySample(cycle) {
  global.gc?.(); global.gc?.();
  const memory = process.memoryUsage();
  return { cycle, heapUsed: memory.heapUsed, external: memory.external,
    arrayBuffers: memory.arrayBuffers, rss: memory.rss };
}

function slope(samples, field) {
  const meanX = samples.reduce((sum, row) => sum + row.cycle, 0) / samples.length;
  const meanY = samples.reduce((sum, row) => sum + row[field], 0) / samples.length;
  return samples.reduce((sum, row) => sum + (row.cycle - meanX) * (row[field] - meanY), 0) /
    samples.reduce((sum, row) => sum + (row.cycle - meanX) ** 2, 0);
}

try {
  const env = await environment({ after: fn => cleanups.push(fn) }, { config: { cacheTtlMs: 30000 } });

  await check('SDK baseline exceeds deadline; a previously warm Forge read avoids delayed provider calls', async () => {
    await writeFile(path.join(env.root, 'latency.txt'), 'latency-fixture\n'.repeat(64));
    const files = new HostFiles(env.ctx, { ttlMs: 30000, watch: false });
    const originals = new Map(), calls = { resolve: 0, stat: 0, readText: 0, readBytes: 0 };
    try {
      await files.read({ file_path: 'latency.txt' }, execution(env.agent));
      for (const method of Object.keys(calls)) {
        const original = env.ctx.fs[method]; originals.set(method, original);
        env.ctx.fs[method] = async function (...args) {
          calls[method]++;
          const signal = method === 'resolve' ? args[1]?.signal : args[1];
          await delay(180, undefined, { signal });
          return original.apply(this, args);
        };
      }
      const baseline = await withDeadline(async signal => {
        const target = await env.ctx.fs.resolve('latency.txt', { cwd: env.root, signal });
        await env.ctx.fs.stat(target, signal);
        return env.ctx.fs.readText(target, signal);
      }, 60);
      const callsAfterBaseline = { ...calls };
      const warm = await withDeadline(signal =>
        files.read({ file_path: 'latency.txt' }, { agent: env.agent, signal }), 60);
      assert.equal(baseline.status, 'rejected');
      assert.equal(baseline.deadlineTriggered, true);
      assert.equal(warm.status, 'completed');
      assert.deepEqual(calls, callsAfterBaseline);
      assert.equal(warm.value.lines[0].text, 'latency-fixture');
      return { injectedDelayPerProviderCallMs: 180, deadlineMs: 60, ttlMs: 30000,
        baseline, warm: { status: warm.status, elapsedMs: warm.elapsedMs },
        providerCalls: calls, metrics: files.metrics() };
    } finally {
      for (const [method, original] of originals) env.ctx.fs[method] = original;
      files.dispose();
    }
  });

  await check('Aborted slow provider load releases queue and never fills the cache', async () => {
    const { ctx, counters } = syntheticContext({ loadDelayMs: 500 });
    const files = new HostFiles(ctx, { ttlMs: 30000, watch: false, concurrency: 1 });
    try {
      const active = withDeadline(signal =>
        files.read({ file_path: 'slow.txt' }, { agent: {}, signal }), 35);
      await delay(5);
      const queued = await Promise.all(Array.from({ length: 16 }, (_, i) =>
        withDeadline(signal => files.read({ file_path: `queued-${i}.txt` }, { agent: {}, signal }), 15)));
      const result = await active;
      assert.equal(result.status, 'rejected');
      assert.equal(result.deadlineTriggered, true);
      assert.ok(result.elapsedMs < 300, `cooperative cancellation took ${result.elapsedMs} ms`);
      for (const row of queued) {
        assert.equal(row.status, 'rejected');
        assert.equal(row.deadlineTriggered, true);
        assert.ok(row.elapsedMs < 300);
      }
      await new Promise(resolve => setImmediate(resolve));
      const metrics = files.metrics();
      assert.equal(metrics.cacheEntries, 0);
      assert.equal(metrics.pendingReads, 0);
      assert.equal(metrics.activeIo, 0);
      assert.equal(metrics.queuedIo, 0);
      assert.equal(counters.observations, 0);
      return { result, queuedCancellations: queued.length,
        maxQueuedCancellationMs: Math.max(...queued.map(row => row.elapsedMs)), provider: counters, metrics };
    } finally { files.dispose(); }
  });

  await check('Non-cooperative late provider completion is rejected and cannot resurrect a disposed cache', async () => {
    const { ctx, counters } = syntheticContext({ loadDelayMs: 150, cooperate: false });
    const files = new HostFiles(ctx, { ttlMs: 30000, watch: false });
    const controller = new AbortController();
    const at = performance.now();
    const reading = files.read({ file_path: 'late.txt' }, { agent: {}, signal: controller.signal });
    await delay(25);
    controller.abort(new Error('late-provider-abort'));
    files.dispose();
    await assert.rejects(reading);
    const callerElapsedMs = round(performance.now() - at), immediatelyAfterAbort = files.metrics();
    assert.ok(callerElapsedMs < 120, `caller waited for non-cooperative provider: ${callerElapsedMs} ms`);
    assert.equal(immediatelyAfterAbort.cacheEntries, 0);
    assert.equal(immediatelyAfterAbort.activeIo, 1);
    await delay(170);
    const settledElapsedMs = round(performance.now() - at), metrics = files.metrics();
    assert.equal(metrics.cacheEntries, 0);
    assert.equal(metrics.pendingReads, 0);
    assert.equal(metrics.activeIo, 0);
    assert.equal(counters.observations, 0);
    await assert.rejects(files.read({ file_path: 'reuse.txt' }, execution({})));
    return { injectedNonCooperativeReadMs: 150, abortAfterMs: 25, callerElapsedMs, settledElapsedMs,
      immediatelyAfterAbort, provider: counters, metrics,
      interpretation: 'Caller cancellation returns promptly. The underlying operation retains its concurrency slot until settled; late completion cannot publish/cache data or reuse a disposed service.' };
  });

  await check('Isolated blocked event loop records a late deadline callback without publishing a late read', async () => {
    const hostFilesUrl = new URL('../src/host-files.mjs', import.meta.url).href;
    const source = `
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { HostFiles } from ${JSON.stringify(hostFilesUrl)};
let observations = 0, providerStarted = false;
const ctx = {
  workingDirectory: { ensure: async () => 'synthetic-cpu-root' },
  emit() { observations++; },
  fs: {
    resolve: async file => ({ targetKey: file, displayPath: file }),
    stat: async () => ({ type: 'file', size: 8, version: 'v1' }),
    readBytes: async () => { providerStarted = true; await delay(200); return Buffer.from('CPUtest\\n'); },
    processPath: target => target.displayPath,
  },
};
const files = new HostFiles(ctx, { ttlMs: 30000, watch: false });
const controller = new AbortController();
const requestedDeadlineMs = 20, requestedBlockMs = 120;
const at = performance.now();
let deadlineCallbackMs;
const reason = new Error('injected CPU deadline'); reason.code = 'FORGE_TEST_DEADLINE';
const timer = setTimeout(() => {
  deadlineCallbackMs = performance.now() - at;
  controller.abort(reason);
}, requestedDeadlineMs);
const reading = files.read({ file_path: 'cpu.txt' }, { agent: {}, signal: controller.signal });
await new Promise(resolve => setImmediate(resolve));
assert.equal(providerStarted, true);
const blockedAt = performance.now();
while (performance.now() - blockedAt < requestedBlockMs) { /* isolate CPU stall to this child */ }
const actualBlockMs = performance.now() - blockedAt;
let rejected;
try { await reading; } catch (error) { rejected = error; }
clearTimeout(timer);
assert.equal(rejected?.code, 'FORGE_TEST_DEADLINE');
assert.ok(deadlineCallbackMs >= requestedBlockMs);
const callerElapsedMs = performance.now() - at;
const immediatelyAfterDeadline = files.metrics();
await delay(230);
const afterUnderlyingCompletion = files.metrics();
assert.equal(afterUnderlyingCompletion.cacheEntries, 0);
assert.equal(afterUnderlyingCompletion.pendingReads, 0);
assert.equal(afterUnderlyingCompletion.activeIo, 0);
assert.equal(observations, 0);
files.dispose();
console.log(JSON.stringify({
  requestedDeadlineMs, requestedBlockMs, actualBlockMs, deadlineCallbackMs,
  timerLatenessMs: deadlineCallbackMs - requestedDeadlineMs,
  callerElapsedMs, deadlineClassified: true, observations,
  immediatelyAfterDeadline, afterUnderlyingCompletion,
  interpretation: 'A blocked JavaScript event loop delays deadline callbacks. Once runnable, cancellation wins and the eventual provider result cannot publish an observation or fill the cache.',
}));
`;
    const outcome = await execFileAsync(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: project, timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true,
    });
    return { ...JSON.parse(outcome.stdout.trim()), isolatedChildTimeoutMs: 5000 };
  });

  await check('Unique-file/search cache churn stays within configured counts and budgets', async () => {
    const samples = [];
    const memoryCaseStarted = performance.now();
    const beforeChurn = memorySample(-1);
    let largestFileBytes = 0, largestFileEntries = 0, largestSnapshots = 0, largestQueries = 0;
    let largestSnapshotBytes = 0, largestQueryBytes = 0;
    const fileBudget = 128 * 1024, cycles = 24;
    for (let cycle = 0; cycle < cycles; cycle++) {
      const { ctx, root } = syntheticContext();
      const files = new HostFiles(ctx, { ttlMs: 30000, watch: false,
        cacheBytes: fileBudget, cacheFileBytes: 4096 });
      const search = new SearchEngine({ ttlMs: 30000, maxSnapshots: 4, maxSnapshotBytes: 256 * 1024 }, syntheticRg);
      try {
        for (let file = 0; file < 400; file++)
          await files.read({ file_path: `cycle-${cycle}-file-${file}.txt`, limit: 1 }, execution({}));
        for (let query = 0; query < 12; query++) {
          await search.files(path.join(root, `root-${query}`));
          await search.grep(root, { pattern: `cycle-${cycle}-query-${query}`, limit: 32 });
        }
        const fm = files.metrics(), sm = search.metrics();
        assert.ok(fm.cacheBytes <= fileBudget);
        assert.ok(fm.cacheEntries <= 4096);
        assert.ok(sm.snapshots <= 4);
        assert.ok(sm.queryEntries <= 8);
        assert.ok(sm.snapshots > 0, 'fixture must exercise retained snapshots');
        assert.ok(sm.snapshotBytes > 0 && sm.snapshotBytes <= 256 * 1024);
        assert.ok(sm.queryBytes <= 8 * 1024 * 1024);
        largestFileBytes = Math.max(largestFileBytes, fm.cacheBytes);
        largestFileEntries = Math.max(largestFileEntries, fm.cacheEntries);
        largestSnapshots = Math.max(largestSnapshots, sm.snapshots);
        largestQueries = Math.max(largestQueries, sm.queryEntries);
        largestSnapshotBytes = Math.max(largestSnapshotBytes, sm.snapshotBytes);
        largestQueryBytes = Math.max(largestQueryBytes, sm.queryBytes);
      } finally { files.dispose(); await search.dispose(); }
      assert.equal(files.metrics().cacheEntries, 0);
      assert.equal(files.metrics().watchers, 0);
      assert.equal(search.metrics().snapshots, 0);
      assert.equal(search.metrics().queryEntries, 0);
      // A new turn lets settled promise closures go out of scope before GC.
      await new Promise(resolve => setImmediate(resolve));
      samples.push(memorySample(cycle));
    }
    const tail = samples.slice(-12);
    const tailSlope = slope(tail, 'heapUsed');
    const heapRange = Math.max(...tail.map(row => row.heapUsed)) - Math.min(...tail.map(row => row.heapUsed));
    const cooldownStarted = performance.now();
    await delay(2000);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const afterCooldown = memorySample(cycles);
    const cooldown = {
      elapsedMs: round(performance.now() - cooldownStarted),
      eventLoopTurns: 2,
      afterDispose: afterCooldown,
      heapDeltaFromBeforeChurn: afterCooldown.heapUsed - beforeChurn.heapUsed,
      heapDeltaFromLastImmediateSample: afterCooldown.heapUsed - samples.at(-1).heapUsed,
      interpretation: 'The baseline-to-cooldown difference includes JIT/code caches and runtime warmup; it is not automatically a retained plugin object leak.',
    };
    let timeoutExpiry;
    if (process.argv.includes('--wait-timeout-expiry')) {
      const expiryStarted = performance.now();
      const requestedWaitMs = Math.max(0, 30050 - (performance.now() - memoryCaseStarted));
      if (requestedWaitMs > 0) await delay(requestedWaitMs);
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      const afterExpiry = memorySample(cycles + 1);
      timeoutExpiry = {
        historicalTimeoutWindowMs: 30000,
        requestedWaitMs: round(requestedWaitMs),
        actualAdditionalWaitMs: round(performance.now() - expiryStarted),
        elapsedFromMemoryCaseStartMs: round(performance.now() - memoryCaseStarted),
        afterExpiry,
        heapDeltaFromBeforeChurn: afterExpiry.heapUsed - beforeChurn.heapUsed,
        heapDeltaFromCooldown: afterExpiry.heapUsed - afterCooldown.heapUsed,
        interpretation: 'An optional finite sample after historical timeout signals would have expired; a smaller heap helps separate temporary runtime retention from persistent growth, without proving absence of all leaks.',
      };
    }
    if (global.gc) {
      // This is a coarse regression guard, not a proof that every object dies.
      assert.ok(tailSlope < 256 * 1024, `late post-GC heap slope ${tailSlope} bytes/cycle`);
      assert.ok(heapRange < 8 * 1024 * 1024, `late post-GC heap range ${heapRange} bytes`);
      assert.ok(afterCooldown.heapUsed - beforeChurn.heapUsed < 8 * 1024 * 1024,
        `cooldown post-GC heap grew ${afterCooldown.heapUsed - beforeChurn.heapUsed} bytes`);
    }
    return { cycles, uniqueFileLoads: cycles * 400, uniqueSearchPairs: cycles * 12,
      explicitGc: !!global.gc, bounds: { fileBudget, fileEntryCap: 4096, snapshots: 4,
        snapshotBudget: 256 * 1024, queries: 8, queryBudget: 8 * 1024 * 1024 },
      observedMaxima: { fileBytes: largestFileBytes, fileEntries: largestFileEntries,
        snapshots: largestSnapshots, queries: largestQueries,
        snapshotBytes: largestSnapshotBytes, queryBytes: largestQueryBytes },
      beforeChurn,
      postDisposeMemorySamples: samples,
      cooldown,
      ...(timeoutExpiry ? { timeoutExpiry } : {}),
      lateHeap: { sampleCount: tail.length, slopeBytesPerCycle: round(tailSlope), rangeBytes: heapRange,
        heuristicGuards: { maxSlopeBytesPerCycle: 256 * 1024, maxRangeBytes: 8 * 1024 * 1024 } },
      interpretation: 'Only JavaScript heap after dispose/GC is checked for late growth. RSS may stay reserved by V8/native allocators after collection.' };
  });

  await check('Real persistent PowerShell endurance, cancellation recovery and disposal', async () => {
    if (!env.ctx.shell.pwshPath)
      return { skipped: true, reason: 'PowerShell executable unavailable in actual SDK shell service.' };
    const files = new HostFiles(env.ctx, { watch: false });
    const shell = new PowerShellTools(env.ctx, files, { idleMs: 60000, maxOutputChars: 4096 });
    const exec = execution(env.agent), times = [];
    try {
      await shell.execute({ command: 'Write-Output WARMUP', timeout_ms: 10000 }, exec);
      for (let i = 0; i < 80; i++) {
        const at = performance.now();
        const result = await shell.execute({ command: `Write-Output 'ITERATION-${i}'`, timeout_ms: 5000 }, exec);
        assert.equal(result.exitCode, 0);
        assert.match(result.stdout, new RegExp(`ITERATION-${i}`));
        assert.ok(result.stdout.length <= 4096);
        assert.ok(shell.metrics().residentProcesses <= 1);
        times.push(performance.now() - at);
      }
      const cancellations = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        const controller = new AbortController();
        const at = performance.now();
        const running = shell.execute({ command: 'Start-Sleep -Seconds 30', timeout_ms: 5000 },
          { ...exec, signal: controller.signal });
        await delay(35); controller.abort(new Error(`stress-cancel-${attempt}`));
        const cancelled = await running;
        assert.equal(cancelled.aborted, true);
        assert.equal(cancelled.stateLost, true);
        const recovered = await shell.execute({ command: 'Write-Output RECOVERED', timeout_ms: 10000 }, exec);
        assert.equal(recovered.exitCode, 0);
        assert.match(recovered.stdout, /RECOVERED/);
        assert.ok(shell.metrics().residentProcesses <= 1);
        cancellations.push({ attempt, elapsedIncludingRestartMs: round(performance.now() - at) });
      }
      const beforeDispose = shell.metrics();
      await shell.dispose();
      const afterDispose = shell.metrics();
      assert.equal(afterDispose.residentProcesses, 0);
      return { successfulRepeatedCalls: 80, cancellationRecoveryCycles: 4,
        warmCallMedianMs: round([...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]),
        beforeDispose, afterDispose, cancellations,
        interpretation: 'Resident process count is plugin ownership state; actual managed subprocess disposal is awaited. User-created variables/functions can intentionally retain PowerShell memory until session reset/idle shutdown.' };
    } finally { await shell.dispose(); files.dispose(); }
  });
} catch (error) {
  report.checks.push({ name: 'Harness initialization', status: 'failed', error: `${error.name}: ${error.message}`,
    stack: error.stack });
} finally {
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); }
    catch (error) { report.checks.push({ name: 'Harness cleanup', status: 'failed', error: error.message }); }
  }
  report.elapsedMs = round(performance.now() - started);
  report.passed = report.checks.every(row => row.status === 'passed');
  await mkdir(path.join(project, 'docs'), { recursive: true });
  const output = path.join(project, 'docs', 'resilience-results.json');
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, elapsedMs: report.elapsedMs, report: output,
    checks: report.checks.map(({ name, status, error }) => ({ name, status, ...(error ? { error } : {}) })) }, null, 2));
  if (!report.passed) process.exitCode = 1;
}
