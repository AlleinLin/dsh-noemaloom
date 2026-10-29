import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const abort = signal => signal?.throwIfAborted();
export const errorText = error => `${error.code ?? error.name ?? 'ERROR'}: ${error.message}`;

// Cancel the wait, not the underlying operation. Callers must keep scarce I/O
// slots occupied until an uncooperative provider actually settles.
export function waitWithSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) {
    // The caller may already have started the provider before observing abort.
    // Observe its eventual rejection even though this caller stops waiting.
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason ?? new Error('Operation aborted'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      callback(value);
    };
    const cancel = () => finish(reject, signal.reason ?? new Error('Operation aborted'));
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

export class Gate {
  constructor(limit = 4, maxQueued = 128) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(maxQueued) || maxQueued < 0)
      throw new Error('Gate limits must be integers: active >= 1, queued >= 0');
    this.limit = limit; this.maxQueued = maxQueued; this.active = 0; this.queue = [];
    this.closed = false;
  }
  async run(operation, signal) {
    abort(signal);
    if (this.closed) throw this.reason;
    if (this.active >= this.limit) {
      if (this.queue.length >= this.maxQueued) {
        const error = new Error(`Tool queue is full (${this.maxQueued} waiting); wait for pending operations or cancel them`);
        error.code = 'FORGE_QUEUE_FULL';
        throw error;
      }
      await new Promise((resolve, reject) => {
        const entry = { resolve, reject };
        const cancel = () => {
          const i = this.queue.indexOf(entry);
          if (i >= 0) this.queue.splice(i, 1);
          entry.cleanup();
          reject(signal.reason ?? new Error('Queued operation aborted'));
        };
        entry.cleanup = () => signal?.removeEventListener('abort', cancel);
        signal?.addEventListener('abort', cancel, { once: true });
        this.queue.push(entry);
      });
    } else this.active++;
    try {
      abort(signal);
      if (this.closed) throw this.reason;
      return await operation();
    }
    finally {
      const next = this.queue.shift();
      if (next) { next.cleanup(); next.resolve(); }
      else this.active--;
    }
  }
  close(reason = new Error('Tool queue disposed')) {
    if (this.closed) return;
    this.closed = true; this.reason = reason;
    for (const entry of this.queue.splice(0)) {
      entry.cleanup(); entry.reject(reason);
    }
  }
  metrics() { return { active: this.active, queued: this.queue.length, maxQueued: this.maxQueued, closed: this.closed }; }
}

