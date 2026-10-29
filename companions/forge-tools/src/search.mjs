import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Gate, abort, waitWithSignal } from './engine.mjs';
import { boundedInt } from './host-files.mjs';

// Shared across plugin scopes: returning a timeout must never let repeated calls
// create unbounded children whose termination the OS has not acknowledged.
const managedChildren = new Set(), unconfirmedChildren = new Set();
const maxManagedChildren = 16, maxUnconfirmedChildren = 2;
const quietError = () => {};
function releaseChild() { managedChildren.delete(this); unconfirmedChildren.delete(this); }

// Only this fixed source is evaluated. Paths and the pattern arrive as JSON on
// stdin; arbitrary glob compilation runs in a bounded, killable process.
const globFilterSource = String.raw`
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 32 * 1024 * 1024) { console.error('Glob input is too large'); process.exit(2); }
});
process.stdin.on('end', () => {
  try {
    const { files, pattern, limit } = JSON.parse(input);
    input = '';
    let total = 0, emitted = 0;
    for (const name of files) {
      if (!path.matchesGlob(name, pattern)) continue;
      total++;
      if (emitted < limit) { process.stdout.write(JSON.stringify({ path: name }) + '\n'); emitted++; }
    }
    process.stdout.write(JSON.stringify({ total }) + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 2; }
});
`;

function searchDeadline(signal, lifecycle, timeoutMs) {
  const controller = new AbortController();
  const expires = performance.now() + timeoutMs;
  const expire = () => {
    const error = new Error(`Search exceeded ${timeoutMs} ms; narrow path/glob`);
    error.name = 'TimeoutError'; controller.abort(error);
  };
  const timer = setTimeout(expire, timeoutMs);
  timer.unref?.();
  const combined = AbortSignal.any([...(signal ? [signal] : []), lifecycle, controller.signal]);
  return {
    signal: combined,
    check() { if (performance.now() >= expires && !controller.signal.aborted) expire(); abort(combined); },
    close() { clearTimeout(timer); },
  };
}

export async function resolveRg(explicit) {
  if (explicit) { await access(explicit); return explicit; }
  if (process.platform === 'win32' && process.arch === 'x64') {
    const bundled = fileURLToPath(new URL('../bin/rg.exe', import.meta.url));
    try { await access(bundled); return bundled; } catch {}
    const development = fileURLToPath(new URL('../node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe', import.meta.url));
    try { await access(development); return development; } catch {}
  }
  return 'rg';
}

/**
 * Launch only ripgrep or the fixed Node glob filter. No shell, config file,
 * preprocessor, or model-supplied executable is involved.
 */
export function runRg(executable, argv, { cwd, signal, maxBytes = 8 * 1024 * 1024,
  timeoutMs = 30000, delimiter = '\n', onLine = () => {}, maxRecordBytes = 1024 * 1024,
  killGraceMs = 250, spawnProcess = spawn, input, nodeMode = false } = {}) {
  abort(signal);
  if (delimiter.length !== 1) throw new Error('Search record delimiter must be one character');
  return new Promise((resolve, reject) => {
    if (input !== undefined && Buffer.byteLength(input) > 32 * 1024 * 1024) {
      reject(new Error('Glob filter input exceeds 32 MiB; narrow the search root')); return;
    }
    if (managedChildren.size >= maxManagedChildren || unconfirmedChildren.size >= maxUnconfirmedChildren) {
      reject(new Error('Search processes are still awaiting OS termination; wait or restart DSH before retrying'));
      return;
    }
    const child = spawnProcess(executable, argv, { cwd, shell: false, windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, RIPGREP_CONFIG_PATH: '', NO_COLOR: '1',
        ...(nodeMode ? { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '', NODE_PATH: '' } : {}) } });
    managedChildren.add(child);
    child.once('close', releaseChild);
    let buffer = '', stderr = '', total = 0, recordBytes = 0;
    let truncated = false, failure, settled = false, stopping = false, grace;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(grace);
      signal?.removeEventListener('abort', onAbort);
      child.stdout?.removeListener('data', onData);
      child.stderr?.removeListener('data', onStderr);
      child.stdout?.removeListener('error', onError);
      child.stderr?.removeListener('error', onError);
      child.stdin?.removeListener('error', onError);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      // A late native error after forced teardown must never become an unhandled event.
      child.on('error', quietError);
      child.stdout?.on('error', quietError);
      child.stderr?.on('error', quietError);
      child.stdin?.on('error', quietError);
      buffer = '';
      error ? reject(error) : resolve({ truncated, stderr, bytes: total });
    };
    const stop = error => {
      if (error && !failure) failure = error;
      if (stopping || settled) return;
      stopping = true;
      try { child.kill(); } catch (error) { failure ??= error; }
      if (settled) return;
      child.stdin?.destroy();
      // Windows filter drivers can delay termination/pipe close indefinitely. Bound our
      // own lifetime even when the OS does not acknowledge that the child has exited.
      grace = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        if (settled) return;
        unconfirmedChildren.add(child);
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref?.();
        finish(failure ?? new Error('Search process did not close after termination'));
      }, killGraceMs);
      grace.unref?.();
    };
    const onAbort = () => stop(signal.reason ?? new Error('Search aborted'));
    const onData = chunk => {
      if (settled || stopping) return;
      total += Buffer.byteLength(chunk);
      if (total > maxBytes) { truncated = true; stop(); return; }
      buffer += chunk;
      let split;
      while ((split = buffer.indexOf(delimiter)) >= 0) {
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
        recordBytes = Buffer.byteLength(line);
        if (recordBytes > maxRecordBytes) { truncated = true; stop(); return; }
        try {
          if (onLine(line) === false) { truncated = true; stop(); return; }
          if (settled || stopping) return;
        } catch (error) { stop(error); return; }
      }
      recordBytes = Buffer.byteLength(buffer);
      if (recordBytes > maxRecordBytes) { truncated = true; stop(); }
    };
    const onStderr = chunk => {
      if (!settled && !stopping) stderr = (stderr + chunk).slice(-12000);
    };
    const onError = error => { stop(error); };
    const onClose = code => {
      if (settled) return;
      if (failure) return finish(failure);
      if (signal?.aborted) return finish(signal.reason ?? new Error('Search aborted'));
      if (!truncated && code !== 0 && code !== 1) return finish(new Error(`ripgrep exited ${code}: ${stderr}`));
      if (buffer && !truncated) {
        try { if (onLine(buffer) === false) truncated = true; } catch (error) { return finish(error); }
      }
      if (failure || signal?.aborted) return finish(failure ?? signal.reason ?? new Error('Search aborted'));
      finish();
    };
    const timer = setTimeout(() => stop(new Error(`Search exceeded ${timeoutMs} ms; narrow path/glob`)), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onStderr);
    child.on('error', onError);
    child.on('close', onClose);
    child.stdout?.on('error', onError);
    child.stderr?.on('error', onError);
    child.stdin?.on('error', onError);
    // Abort can happen inside spawn/registration as well as before this function.
    if (signal?.aborted) onAbort();
    else if (input !== undefined) child.stdin?.end(input);
  });
}

const rgText = field => field?.text ?? (field?.bytes ? Buffer.from(field.bytes, 'base64').toString('utf8') : '');
const copyString = value => Buffer.from(value, 'utf16le').toString('utf16le');
function searchString(value, label) {
  if (typeof value !== 'string' || value.length > 32768)
    throw new Error(`${label} must be a string of at most 32768 characters`);
}

function waitFor(state, signal) {
  abort(signal);
  if (state.settled) return state.error ? Promise.reject(state.error) : Promise.resolve(state.value);
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(signal.reason); };
    const waiter = {
      resolve: value => { cleanup(); resolve(value); },
      reject: error => { cleanup(); reject(error); },
    };
    const cleanup = () => {
      signal.removeEventListener('abort', cancel);
      state.waiters.delete(waiter);
    };
    state.waiters.add(waiter);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export class SearchEngine {
  constructor(config = {}, runner = runRg, resolveExecutable = resolveRg, filterRunner = runRg) {
    this.config = { threads: 2, ttlMs: 1000, maxSnapshots: 8, maxSnapshotBytes: 16 * 1024 * 1024,
      maxSnapshotFiles: 50000, maxQueryBytes: 8 * 1024 * 1024, maxQueries: 8,
      timeoutMs: 30000, shutdownWaitMs: 1000, ...config };
    for (const [field, min, max] of [
      ['threads', 1, 16], ['ttlMs', 0, 3600000], ['maxSnapshots', 0, 64],
      ['maxSnapshotBytes', 256, 64 * 1024 * 1024], ['maxSnapshotFiles', 1, 200000],
      ['maxQueryBytes', 256, 64 * 1024 * 1024], ['maxQueries', 0, 64], ['timeoutMs', 1, 600000],
      ['shutdownWaitMs', 1, 10000],
    ]) boundedInt(this.config[field], undefined, min, max);
    this.runner = runner;
    this.filterRunner = filterRunner;
    this.gate = new Gate(2);
    this.snapshots = new Map();
    this.queries = new Map();
    this.generation = 0;
    this.snapshotBytes = 0;
    this.queryBytes = 0;
    this.running = new Set();
    this.lifecycle = new AbortController();
    const readiness = this.readiness = { settled: false, waiters: new Set() };
    const settle = (error, value) => {
      readiness.settled = true; readiness.error = error; readiness.value = value;
      for (const waiter of readiness.waiters) error ? waiter.reject(error) : waiter.resolve(value);
    };
    // One subscription only: timed-out calls remove their readiness waiter rather
    // than accumulate .then callbacks on a filesystem access that never completes.
    Promise.resolve(resolveExecutable(this.config.rgPath)).then(
      value => settle(undefined, value), error => settle(error),
    );
    this.stats = { processes: 0, snapshotHits: 0, queryHits: 0, enumerations: 0, globFilters: 0 };
  }
  invalidate() {
    this.generation++; this.snapshots.clear(); this.queries.clear();
    this.snapshotBytes = 0; this.queryBytes = 0;
  }
  prune(cache, bytesField, limit, budget) {
    const now = performance.now();
    for (const [key, entry] of cache) {
      if (now - entry.at >= this.config.ttlMs) {
        cache.delete(key); this[bytesField] -= entry.bytes;
      }
    }
    while (cache.size > limit || this[bytesField] > budget) {
      const key = cache.keys().next().value;
      this[bytesField] -= cache.get(key).bytes; cache.delete(key);
    }
  }
  remember(cache, key, entry, bytesField, limit, budget) {
    if (this.config.ttlMs <= 0 || entry.bytes > budget || key.length > 32768) return;
    const previous = cache.get(key);
    if (previous) this[bytesField] -= previous.bytes;
    cache.delete(key); cache.set(key, entry); this[bytesField] += entry.bytes;
    this.prune(cache, bytesField, limit, budget);
  }
  flags(args) {
    const flags = ['--no-config', '--color', 'never', '--no-mmap', '--threads', String(this.config.threads)];
    if (args.hidden) flags.push('--hidden');
    if (args.no_ignore) flags.push('--no-ignore');
    if (args.glob) flags.push('--glob', args.glob);
    // The last override wins in ripgrep: keep this after user filters.
    flags.push('--glob', '!**/.git/**');
    return flags;
  }
  async execute(argv, options, runner = this.runner) {
    const deadline = searchDeadline(options.signal, this.lifecycle.signal, this.config.timeoutMs);
    const signal = deadline.signal;
    const operation = this.gate.run(async () => {
      const executable = options.executable ?? await waitFor(this.readiness, signal);
      deadline.check();
      this.stats.processes++;
      return runner(executable, argv, { ...options, signal });
    }, signal);
    this.running.add(operation);
    operation.then(() => this.running.delete(operation), () => this.running.delete(operation));
    try {
      const result = await waitWithSignal(operation, signal);
      deadline.check(); return result;
    } finally { deadline.close(); }
  }
  async files(root, args = {}, signal) {
    abort(signal); abort(this.lifecycle.signal);
    searchString(root, 'Search root');
    args = { fresh: !!args.fresh, hidden: !!args.hidden, no_ignore: !!args.no_ignore };
    const key = JSON.stringify([root, !!args.hidden, !!args.no_ignore]);
    this.prune(this.snapshots, 'snapshotBytes', this.config.maxSnapshots, this.config.maxSnapshotBytes);
    const existing = this.snapshots.get(key);
    if (!args.fresh && existing && performance.now() - existing.at < this.config.ttlMs) {
      this.stats.snapshotHits++; return existing;
    }
    const generation = this.generation, files = [];
    let bytes = key.length * 2 + 128;
    this.stats.enumerations++;
    const result = await this.execute([...this.flags({ ...args, glob: undefined }), '--files', '--null', '--', '.'], {
      cwd: root, signal, maxBytes: this.config.maxSnapshotBytes, delimiter: '\0',
      onLine: line => {
        const name = copyString(line.replaceAll('\\', '/').replace(/^\.\//, ''));
        const size = name.length * 2 + 128;
        if (files.length >= this.config.maxSnapshotFiles || bytes + size > this.config.maxSnapshotBytes) return false;
        bytes += size; files.push(name);
      },
    });
    abort(signal); abort(this.lifecycle.signal);
    const snapshot = { files, bytes, generation, at: performance.now(), truncated: result.truncated };
    if (!result.truncated && generation === this.generation) {
      this.remember(this.snapshots, key, snapshot, 'snapshotBytes',
        this.config.maxSnapshots, this.config.maxSnapshotBytes);
    }
    return snapshot;
  }
  async glob(root, args, signal) {
    abort(signal); abort(this.lifecycle.signal);
    searchString(root, 'Search root');
    searchString(args.pattern, 'Glob pattern');
    const limit = boundedInt(args.limit, 500, 1, 5000);
    args = { pattern: args.pattern, fresh: !!args.fresh, hidden: !!args.hidden, no_ignore: !!args.no_ignore };
    const deadline = searchDeadline(signal, this.lifecycle.signal, this.config.timeoutMs);
    try {
      const key = JSON.stringify(['glob', root, args.pattern, args.hidden, args.no_ignore, limit]);
      this.prune(this.snapshots, 'snapshotBytes', this.config.maxSnapshots, this.config.maxSnapshotBytes);
      const cached = this.snapshots.get(key);
      if (!args.fresh && cached) {
        this.stats.snapshotHits++;
        const result = { ...structuredClone(cached.value), snapshotAgeMs: Math.round(performance.now() - cached.at) };
        deadline.check(); return result;
      }
      const snapshot = await this.files(root, args, deadline.signal);
      deadline.check();
      const generation = snapshot.generation, matches = [];
      let total, bytes = key.length * 2 + 256, capped = false;
      this.stats.globFilters++;
      const result = await this.execute(['--max-old-space-size=64', '--max-semi-space-size=4',
        '--stack-size=512', '--eval', globFilterSource], {
        executable: process.execPath, cwd: root, signal: deadline.signal, nodeMode: true,
        input: JSON.stringify({ files: snapshot.files, pattern: args.pattern, limit }),
        maxBytes: this.config.maxSnapshotBytes,
        onLine: line => {
          const record = JSON.parse(line);
          if (typeof record.path === 'string') {
            searchString(record.path, 'Glob result path');
            const size = record.path.length * 2 + 128;
            if (matches.length >= limit || bytes + size > this.config.maxSnapshotBytes) { capped = true; return false; }
            bytes += size; matches.push(copyString(record.path));
          } else if (Number.isSafeInteger(record.total) && record.total >= matches.length
            && record.total <= snapshot.files.length) total = record.total;
          else throw new Error('Invalid glob filter response');
        },
      }, this.filterRunner);
      deadline.check();
      if (total === undefined && !result.truncated && !capped) throw new Error('Glob filter ended without a result summary');
      total ??= matches.length;
      const at = performance.now();
      const value = { files: matches, total,
        truncated: snapshot.truncated || result.truncated || capped || total > limit, order: 'filesystem' };
      if (generation === this.generation && !snapshot.truncated && !result.truncated && !capped) {
        const entry = { value: structuredClone(value), bytes, at: snapshot.at };
        deadline.check();
        this.remember(this.snapshots, key, entry,
          'snapshotBytes', this.config.maxSnapshots, this.config.maxSnapshotBytes);
      }
      deadline.check();
      return { ...value, snapshotAgeMs: Math.round(at - snapshot.at) };
    } finally { deadline.close(); }
  }
  async grep(root, args, signal) {
    abort(signal); abort(this.lifecycle.signal);
    searchString(root, 'Search root'); searchString(args.pattern, 'Search pattern');
    if (args.glob !== undefined && args.glob !== null) searchString(args.glob, 'Search glob');
    const limit = boundedInt(args.limit ?? args.head_limit, 100, 1, 2000);
    args = { pattern: args.pattern, glob: args.glob ?? '', hidden: !!args.hidden, no_ignore: !!args.no_ignore,
      ignore_case: !!(args.ignore_case ?? args['-i']), fixed_strings: !!args.fixed_strings,
      multiline: !!args.multiline, output_mode: args.output_mode === 'files_with_matches' ? 'files_with_matches' : 'content',
      fresh: !!args.fresh };
    // Cache only fields which actually affect the query. An ignored argument or
    // fresh:true must not retain an arbitrarily large model-supplied object.
    const queryKey = JSON.stringify([root, args.pattern, args.glob ?? '', !!args.hidden, !!args.no_ignore,
      !!(args.ignore_case ?? args['-i']), !!args.fixed_strings, !!args.multiline,
      args.output_mode === 'files_with_matches', limit]);
    this.prune(this.queries, 'queryBytes', this.config.maxQueries, this.config.maxQueryBytes);
    const cached = this.queries.get(queryKey);
    if (!args.fresh && cached && performance.now() - cached.at < this.config.ttlMs) {
      this.stats.queryHits++; return { ...structuredClone(cached.value), cache: 'bounded' };
    }
    const generation = this.generation;
    const maxLine = 2000, matches = [], paths = new Set();
    let responseBytes = 128;
    const flags = [...this.flags(args), '--json', '--line-number', '--max-filesize', '8M', '--max-count', String(limit)];
    if (args.ignore_case ?? args['-i']) flags.push('--ignore-case');
    if (args.fixed_strings) flags.push('--fixed-strings');
    if (args.multiline) flags.push('--multiline');
    flags.push('--regexp', args.pattern, '--', '.');
    const result = await this.execute(flags, {
      cwd: root, signal, maxBytes: 8 * 1024 * 1024,
      onLine: line => {
        if (!line) return;
        const event = JSON.parse(line);
        if (event.type !== 'match') return;
        const data = event.data, file = copyString(rgText(data.path)), text = rgText(data.lines);
        const match = { path: file, line: data.line_number ?? 0,
          text: copyString(text.replace(/\r?\n$/, '').slice(0, maxLine)), truncated: text.length > maxLine };
        const bytes = (file.length + match.text.length) * 2 + 192;
        if (responseBytes + bytes > this.config.maxQueryBytes) return false;
        responseBytes += bytes;
        paths.add(file);
        matches.push(match);
        return matches.length < limit;
      },
    });
    abort(signal); abort(this.lifecycle.signal);
    const value = args.output_mode === 'files_with_matches'
      ? { files: [...paths], truncated: result.truncated }
      : { matches, truncated: result.truncated, ...(result.stderr ? { warnings: result.stderr } : {}) };
    if (generation === this.generation && !result.stderr) {
      this.remember(this.queries, queryKey, {
        value: structuredClone(value), bytes: responseBytes + queryKey.length * 2 + 128, at: performance.now(),
      }, 'queryBytes', this.config.maxQueries, this.config.maxQueryBytes);
    }
    return value;
  }
  metrics() {
    this.prune(this.snapshots, 'snapshotBytes', this.config.maxSnapshots, this.config.maxSnapshotBytes);
    this.prune(this.queries, 'queryBytes', this.config.maxQueries, this.config.maxQueryBytes);
    return { ...this.stats, snapshots: this.snapshots.size, queryEntries: this.queries.size,
      snapshotBytes: this.snapshotBytes, queryBytes: this.queryBytes, running: this.running.size,
      gate: this.gate.metrics(), managedProcesses: managedChildren.size,
      unconfirmedProcesses: unconfirmedChildren.size, processLimit: maxManagedChildren,
      quarantineLimit: maxUnconfirmedChildren };
  }
  dispose() {
    if (this.disposal) return this.disposal;
    const reason = new Error('Plugin disposed');
    this.gate.close(reason);
    this.lifecycle.abort(reason);
    this.invalidate();
    this.disposal = new Promise(resolve => {
      const timer = setTimeout(resolve, this.config.shutdownWaitMs);
      Promise.allSettled([...this.running]).then(() => { clearTimeout(timer); resolve(); });
    });
    return this.disposal;
  }
}
