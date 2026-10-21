/** Bound an owned read even when its carrier ignores AbortSignal. Late
 * resolutions/rejections are observed but cannot settle the retired read. */
export async function boundedRead<T>(read: (signal: AbortSignal) => Promise<T>, options: {
  signal?: AbortSignal;
  timeoutMs: number;
  timeout: () => Error;
  cancelled: () => Error;
}): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => {
      const error = options.cancelled();
      reject(error);
      controller.abort(error);
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) { cancel(); return; }
    timer = setTimeout(() => {
      const error = options.timeout();
      reject(error);
      controller.abort(error);
    }, options.timeoutMs);
  });
  try {
    return await Promise.race([
      stopped,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return read(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
