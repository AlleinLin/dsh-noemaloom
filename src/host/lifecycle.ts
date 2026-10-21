import { NexusError } from '../ports/contracts.js';

/** Owns admitted work and awaits it at plugin disposal. */
export class OperationController {
  readonly controller = new AbortController();
  private accepting = true;
  private jobs = new Set<Promise<unknown>>();
  private routeDisposer?: () => Promise<void>;
  private disposal?: Promise<void>;
  setRouteDisposer(dispose: () => Promise<void>): void { this.routeDisposer = dispose; }
  async run<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.accepting) throw new NexusError('CANCELLED', 'Nexus 正在停用');
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    combined.throwIfAborted();
    const job = Promise.resolve().then(() => work(combined));
    this.jobs.add(job);
    try { return await job; } finally { this.jobs.delete(job); }
  }
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.accepting = false;
      let routeError: unknown;
      try { await this.routeDisposer?.(); } catch (error) { routeError = error; }
      this.controller.abort(new NexusError('CANCELLED', 'Nexus 插件已停用'));
      await Promise.allSettled([...this.jobs]);
      if (routeError) throw routeError;
    })();
  }
}
