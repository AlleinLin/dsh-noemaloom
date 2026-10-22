export interface PollEnvironment {
  visible(): boolean;
  subscribe(listener: () => void): () => void;
  later(callback: () => void, delay: number): unknown;
  cancel(timer: unknown): void;
}
const browserEnvironment: PollEnvironment = {
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  subscribe(listener) {
    if (typeof document === 'undefined') return () => {};
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
  later: (callback, delay) => setTimeout(callback, delay),
  cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Read-only refreshes: one request at a time, no hidden-window wakeups or
 * catch-up bursts. Visibility never cancels a mutation or a native agent. */
export function visiblePoll(run: (signal: AbortSignal) => Promise<unknown>, options: {
  delay(): number; onError?(error: unknown): void; environment?: PollEnvironment;
}) {
  const environment = options.environment ?? browserEnvironment;
  const controller = new AbortController();
  let timer: unknown, running = false, requested = false, failures = 0;
  const clear = () => { if (timer !== undefined) environment.cancel(timer); timer = undefined; };
  const refresh = () => {
    clear();
    if (controller.signal.aborted) return;
    requested = true;
    if (!running && environment.visible()) void execute();
  };
  const execute = async () => {
    running = true; requested = false;
    try { await run(controller.signal); failures = 0; }
    catch (error) {
      failures = Math.min(6, failures + 1);
      if (!controller.signal.aborted) {
        try { options.onError?.(error); } catch { /* A read observer cannot break scheduling. */ }
      }
    } finally {
      running = false;
      if (!controller.signal.aborted && environment.visible()) {
        // Collapse all events arriving during a read into at most one follow-up.
        const delay = requested && !failures ? 0
          : Math.min(120000, Math.max(25, options.delay()) * 2 ** failures);
        timer = environment.later(() => { timer = undefined; refresh(); }, delay);
      }
    }
  };
  const unsubscribe = environment.subscribe(() => {
    if (environment.visible()) refresh();
    else clear();
  });
  refresh();
  return {
    refresh,
    dispose() {
      controller.abort(new DOMException('界面读取生命周期已结束', 'AbortError'));
      clear(); unsubscribe();
    },
  };
}

/** Event-driven projections: tokenize/serialize only the latest snapshot in a
 * burst. There is no interval and therefore no idle timer. */
export function visibleBatch(flush: () => void, delay = 100, environment = browserEnvironment) {
  let timer: unknown, pending = false, disposed = false;
  const clear = () => { if (timer !== undefined) environment.cancel(timer); timer = undefined; };
  const request = () => {
    if (disposed) return;
    pending = true;
    if (timer !== undefined || !environment.visible()) return;
    timer = environment.later(() => {
      timer = undefined;
      if (disposed || !environment.visible()) return;
      pending = false; flush();
    }, delay);
  };
  const unsubscribe = environment.subscribe(() => {
    if (!environment.visible()) clear();
    else if (pending) request();
  });
  return { request, dispose() { disposed = true; clear(); unsubscribe(); } };
}

/** Sample only this presentation's source. The native conversation keeps its
 * original unthrottled store, input and execution lifecycle. */
export function sampledSource<T>(source: { getSnapshot(): T; subscribe(listener: () => void): () => void }, delay = 200) {
  let current = source.getSnapshot(), stop: (() => void) | undefined;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => listeners.size ? current : source.getSnapshot(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!stop) {
        const batch = visibleBatch(() => {
          const next = source.getSnapshot();
          if (current !== next) { current = next; for (const notify of listeners) notify(); }
        }, delay);
        stop = source.subscribe(batch.request);
        const remove = stop;
        stop = () => { remove(); batch.dispose(); };
        current = source.getSnapshot();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { stop?.(); stop = undefined; }
      };
    },
  };
}
