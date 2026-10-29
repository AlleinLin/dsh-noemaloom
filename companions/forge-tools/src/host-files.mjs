import path from 'node:path';
import { watch } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Gate, abort, hash, waitWithSignal } from './engine.mjs';
import { resolvePolicy, mapFsError } from './safety.mjs';

function fail(message, code = 'FS_IO_ERROR') {
  const error = new Error(message); error.code = code; return error;
}

export class HostFiles {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = { cacheBytes: 64 * 1024 * 1024, cacheFileBytes: 2 * 1024 * 1024,
      ttlMs: 1000, concurrency: 4, watch: true, ...config };
    this.cache = new Map();
    this.pending = new Map();
    this.watchers = new Map();
    this.gate = new Gate(this.config.concurrency);
    this.bytes = 0;
    this.epoch = 0;
    this.disposed = false;
    this.lifecycle = new AbortController();
    this.stats = { hits: 0, validatedHits: 0, misses: 0, merged: 0, providerReads: 0, providerWrites: 0, invalidations: 0 };
  }
  execution(exec) {
    const signal = exec.signal
      ? AbortSignal.any([exec.signal, this.lifecycle.signal]) : this.lifecycle.signal;
    abort(signal);
    return { ...exec, signal };
  }
  async cwd(exec) {
    const current = this.execution(exec);
    const cwd = await this.gate.run(() =>
      this.ctx.workingDirectory.ensure(current.agent, current.signal), current.signal);
    abort(current.signal);
    return cwd;
  }
  clear() { this.cache.clear(); this.bytes = 0; this.epoch++; this.stats.invalidations++; this.onInvalidate?.(); }
  invalidateTarget(target) {
    for (const [key, entry] of this.cache) {
      if (entry.target.targetKey === target.targetKey) {
        this.bytes -= entry.size; this.cache.delete(key);
      }
    }
    this.epoch++; this.stats.invalidations++; this.onInvalidate?.();
  }
  invalidatePath(file) {
    const includes = candidate => {
      const relative = path.relative(file, candidate);
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    };
    for (const [key, entry] of this.cache) {
      const [cwd, input] = JSON.parse(key);
      if (includes(path.resolve(cwd, input)) || includes(this.ctx.fs.processPath(entry.target))) {
        this.bytes -= entry.size; this.cache.delete(key);
      }
    }
    this.epoch++; this.stats.invalidations++; this.onInvalidate?.();
  }
  ensureWatch(cwd) {
    if (!this.config.watch || this.watchers.has(cwd) || this.disposed) return;
    // Only watch when the provider explicitly maps the host directory to its execution world.
    // Remote filesystems still work, with TTL-based invalidation.
    if (this.ctx.fs.processPathFromHostPath(cwd) !== cwd) return;
    try {
      while (this.watchers.size >= 8) {
        const first = this.watchers.keys().next().value;
        this.watchers.get(first)?.close(); this.watchers.delete(first); this.clear();
      }
      const watcher = watch(cwd, { recursive: true, persistent: false }, (_event, file) => {
        if (!this.disposed && this.watchers.get(cwd) === watcher)
          file ? this.invalidatePath(path.resolve(cwd, file.toString())) : this.clear();
      });
      watcher.on('error', () => {
        watcher.close();
        if (this.disposed || this.watchers.get(cwd) !== watcher) return;
        this.clear(); this.watchers.set(cwd, null);
      });
      this.watchers.set(cwd, watcher);
    } catch { this.watchers.set(cwd, null); }
  }
  put(key, entry, epoch) {
    if (epoch !== this.epoch || this.disposed || this.config.ttlMs === 0) return;
    if (Buffer.byteLength(entry.text) > this.config.cacheFileBytes) return;
    // Account conservatively for UTF-16 strings and entry/key metadata, not just
    // UTF-8 payload bytes. V8/Map overhead and the host process remain separate.
    const size = 512 + 2 * (key.length + entry.text.length + String(entry.version).length +
      String(entry.target.targetKey).length + String(entry.target.displayPath ?? '').length +
      (entry.sha256?.length ?? 0));
    if (size > this.config.cacheBytes) return;
    const old = this.cache.get(key);
    if (old) this.bytes -= old.size;
    this.cache.delete(key);
    this.cache.set(key, { ...entry, size, at: performance.now() });
    this.bytes += size;
    while (this.bytes > this.config.cacheBytes || this.cache.size > 4096) {
      const first = this.cache.keys().next().value;
      this.bytes -= this.cache.get(first).size; this.cache.delete(first);
    }
  }
  async read(args, exec) {
    const current = this.execution(exec);
    return waitWithSignal(this.readInternal(args, current, exec.signal), current.signal);
  }
  async readInternal(args, exec, ownerSignal) {
    const offset = args.offset ?? 1, limit = args.limit ?? 2000;
    if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1 || limit > 2000)
      throw new Error('offset must be >=1; limit must be between 1 and 2000');
    if (!args.file_path?.trim()) throw new Error('file_path must be nonempty');
    const cwd = await this.cwd(exec);
    this.ensureWatch(cwd);
    // The input key is separate from the provider's opaque FsTargetKey.
    const key = JSON.stringify([cwd, args.file_path]);
    if (args.fresh) {
      const stale = this.cache.get(key);
      if (stale) { this.bytes -= stale.size; this.cache.delete(key); }
      // An earlier read must not put its old body back after a fresh request,
      // including when the new file became too large to cache or disappeared.
      this.epoch++;
    }
    const previous = !args.fresh && this.config.ttlMs > 0 && this.cache.get(key);
    let entry = previous;
    if (entry && performance.now() - entry.at < this.config.ttlMs) {
      this.stats.hits++;
      this.cache.delete(key); this.cache.set(key, entry);
    } else {
      this.stats.misses++;
      const load = async () => {
        const epoch = this.epoch;
        const target = await this.ctx.fs.resolve(args.file_path, { cwd, signal: exec.signal });
        abort(exec.signal);
        const info = await this.ctx.fs.stat(target, exec.signal);
        abort(exec.signal);
        if (!info) {
          this.ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
          throw fail(`File does not exist: ${target.displayPath}`, 'FS_NOT_FOUND');
        }
        if (info.type !== 'file') throw fail('Use list_directory for directories', 'FS_NOT_REGULAR_FILE');
        if (previous && previous.target.targetKey === target.targetKey && previous.version === info.version) {
          this.stats.validatedHits++;
          const result = { ...previous, target };
          this.put(key, result, epoch);
          return result;
        }
        if (info.size === undefined || info.size > this.config.cacheFileBytes) {
          return { target, version: info.version, stream: true };
        }
        this.stats.providerReads++;
        let raw;
        try {
          // The official bounded byte API also limits files that grow after
          // stat. readText alone could allocate the entire enlarged file.
          raw = await this.ctx.fs.readBytes(target, exec.signal, this.config.cacheFileBytes);
        } catch (error) {
          abort(exec.signal);
          if (error.code === 'FS_TOO_LARGE') return { target, version: info.version, stream: true };
          throw error;
        }
        abort(exec.signal);
        if (raw.byteLength > this.config.cacheFileBytes)
          return { target, version: info.version, stream: true };
        if (raw.subarray(0, 8192).includes(0))
          throw fail(`Cannot read binary file: ${target.displayPath}`, 'FS_NOT_TEXT');
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
        catch { throw fail(`Invalid UTF-8 text: ${target.displayPath}`, 'FS_NOT_TEXT'); }
        const result = { target, version: info.version, text, sha256: hash(text) };
        this.put(key, result, epoch);
        return result;
      };
      // Signal-owned loads are merged only within the same execution signal.
      const inFlight = this.pending.get(key);
      if (!args.fresh && inFlight && inFlight.signal === ownerSignal) {
        this.stats.merged++; entry = await inFlight.promise;
      } else {
        const promise = this.gate.run(load, exec.signal);
        const slot = { signal: ownerSignal, promise };
        if (!args.fresh) this.pending.set(key, slot);
        try { entry = await promise; }
        finally { if (this.pending.get(key) === slot) this.pending.delete(key); }
      }
    }
    abort(exec.signal);
    const window = entry.stream
      ? await this.gate.run(async () => {
        const chunks = await this.ctx.fs.streamText(entry.target, exec.signal);
        try {
          abort(exec.signal);
          return await readWindow(chunks, offset, limit, exec.signal, true);
        } catch (error) {
          await chunks.return?.();
          throw error;
        }
      }, exec.signal)
      : await readWindow([entry.text], offset, limit, exec.signal);
    abort(exec.signal);
    // Record the version actually associated with the text, including cache hits.
    // Never turn an old cached body into a new authoritative observation.
    this.ctx.emit('fs/observed', entry.target, { kind: 'present', version: entry.version }, exec);
    return { path: this.ctx.fs.processPath(entry.target), offset, ...window,
      cache: entry.stream ? 'stream' : args.fresh ? 'fresh' : 'bounded',
      ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }) };
  }
  async mutate(kind, args, exec) {
    exec = this.execution(exec);
    // Preparatory reads/approval hooks may ignore cancellation. Let their
    // caller stop waiting without releasing actual provider capacity or
    // continuing toward publication when they eventually return.
    const cwd = await waitWithSignal(this.cwd(exec), exec.signal);
    const target = await waitWithSignal(this.gate.run(() =>
      this.ctx.fs.resolve(args.file_path, { cwd, signal: exec.signal }), exec.signal), exec.signal);
    abort(exec.signal);
    const policy = await waitWithSignal(
      resolvePolicy(this.ctx, kind, args, exec, this.ctx.fs.sandboxMode !== undefined), exec.signal);
    abort(exec.signal);
    // The provider enforces mode and re-resolves symlinks in its critical section.
    const intent = await waitWithSignal(
      this.ctx.waterfall(`fs/${kind}-intent`, target, exec, () => undefined), exec.signal);
    abort(exec.signal);
    return this.gate.run(async () => {
      this.invalidateTarget(target);
      try {
        const outcome = kind === 'write'
          ? await this.ctx.fs.writeText(target, args.content, intent, exec.signal, policy)
          : await this.ctx.fs.editText(target, {
            oldString: args.old_string, newString: args.new_string, replaceAll: args.replace_all ?? false,
          }, intent, exec.signal, policy);
        // Once publication has happened, cancellation cannot undo it. Preserve
        // a confirmed commit rather than report a false failed/rolled-back write.
        this.stats.providerWrites++;
        if (!this.disposed)
          this.ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec);
        return { path: this.ctx.fs.processPath(target), ...outcome,
          changed: outcome.before !== outcome.after, sha256: hash(outcome.after) };
      } catch (error) {
        const mapped = mapFsError(error, policy);
        // A provider can fail while probing the file after atomic publication.
        // The error alone therefore cannot establish that nothing was written.
        let failure = mapped instanceof Error ? mapped : fail(String(mapped));
        try { failure.commitState = 'unknown'; }
        catch {
          const wrapper = fail(failure.message, failure.code);
          wrapper.cause = failure; wrapper.commitState = 'unknown'; failure = wrapper;
        }
        throw failure;
      }
      finally { this.invalidateTarget(target); }
    }, exec.signal);
  }
  async list(args, exec) {
    const current = this.execution(exec);
    return waitWithSignal(this.listInternal(args, current), current.signal);
  }
  async listInternal(args, exec) {
    const limit = boundedInt(args.limit, 500, 1, 5000);
    const cwd = await this.cwd(exec);
    const { target, entries } = await this.gate.run(async () => {
      const target = await this.ctx.fs.resolve(args.path ?? '.', { cwd, signal: exec.signal });
      abort(exec.signal);
      const entries = await this.ctx.fs.listDir(target, exec.signal);
      abort(exec.signal);
      return { target, entries };
    }, exec.signal);
    return { path: target.displayPath, total: entries.length, truncated: entries.length > limit,
      entries: entries.slice(0, limit).map(e => ({ name: e.name, type: e.type, ...(e.size === undefined ? {} : { size: e.size }) })) };
  }
  async searchRoot(args, exec) {
    const current = this.execution(exec);
    return waitWithSignal(this.searchRootInternal(args, current), current.signal);
  }
  async searchRootInternal(args, exec) {
    const cwd = await this.cwd(exec);
    this.ensureWatch(cwd);
    return this.gate.run(async () => {
      const target = await this.ctx.fs.resolve(args.path ?? '.', { cwd, signal: exec.signal });
      abort(exec.signal);
      const root = this.ctx.fs.processPath(target);
      if (this.ctx.fs.processPathFromHostPath(root) !== root)
        throw new Error('Bundled search requires a host-local filesystem provider');
      const info = await this.ctx.fs.stat(target, exec.signal);
      abort(exec.signal);
      if (!info || info.type !== 'directory')
        throw new Error('Search path must be a directory; use glob for a file filter');
      return root;
    }, exec.signal);
  }
  metrics() { return { ...this.stats, cacheBytes: this.bytes, cacheEntries: this.cache.size,
    pendingReads: this.pending.size, activeIo: this.gate.active, queuedIo: this.gate.queue.length,
    cacheAccounting: 'UTF-16 strings plus estimated entry metadata; excludes active I/O and host runtime',
    ttlMs: this.config.ttlMs, watchers: [...this.watchers.values()].filter(Boolean).length }; }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const reason = fail('File tools have been disposed', 'FS_DISPOSED');
    this.lifecycle.abort(reason);
    this.gate.close(reason);
    for (const watcher of this.watchers.values()) watcher?.close();
    this.watchers.clear(); this.pending.clear(); this.clear();
  }
}

export function boundedInt(value, fallback, min, max) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`Expected integer ${min}..${max}`);
  return result;
}

async function readWindow(chunks, offset, limit, signal, stopEarly = false) {
  const lines = [];
  let carry = '', number = 0, used = 0, totalLines = 0, truncated = false, endedWithNewline = false;
  const add = raw => {
    number++; totalLines++;
    if (number < offset || lines.length >= limit) { if (number >= offset) truncated = true; return; }
    const clipped = raw.replace(/\r$/, '').slice(0, 2000);
    // A V8 substring can retain its entire multi-megabyte parent body after
    // cache eviction. Copy only the bounded returned window; UTF-16 preserves
    // code units exactly, including a surrogate at the truncation boundary.
    const text = Buffer.from(clipped, 'utf16le').toString('utf16le');
    if (used + Buffer.byteLength(text) > 60000) { truncated = true; return; }
    used += Buffer.byteLength(text);
    lines.push({ number, text });
    if (raw.length > 2000) truncated = true;
  };
  let partial = false;
  readChunks: for await (const chunk of chunks) {
    abort(signal);
    endedWithNewline = chunk.endsWith('\n');
    let start = 0, next;
    while ((next = chunk.indexOf('\n', start)) >= 0) {
      add(carry + chunk.slice(start, next)); carry = ''; start = next + 1;
      if (stopEarly && (number >= offset + limit || used >= 58000)) {
        partial = true; truncated = true; break readChunks;
      }
    }
    // Bound a single enormous line while continuing to count subsequent lines.
    carry = (carry + chunk.slice(start)).slice(0, 60001);
    if (stopEarly && carry.length > 60000 && number + 1 >= offset) {
      add(carry); partial = true; truncated = true; break;
    }
  }
  if (!partial) add(carry);
  return { lines, totalLines: partial ? null : totalLines, truncated };
}

export function renderFileRead(value) {
  return `<path>${value.path}</path>\n<type>file</type>\n<content>\n${
    value.lines.map(line => `${line.number}\t${line.text}`).join('\n')}\n</content>\n${
    value.truncated ? '[truncated; continue with offset/limit]\n' : ''}[totalLines=${value.totalLines ?? 'unknown (stream stopped after requested window)'}${value.sha256 ? ` sha256=${value.sha256}` : ''}]`;
}
