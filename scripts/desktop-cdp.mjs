// Validation only: connect to a dedicated, isolated Electron debug endpoint.
export async function connectTarget(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const pending = new Map();
  const listeners = new Set();
  let sequence = 0;
  socket.addEventListener('message', event => {
    const result = JSON.parse(event.data);
    if (result.method) {
      for (const listener of listeners) listener(result.method, result.params);
      return;
    }
    const waiter = pending.get(result.id);
    if (!waiter) return;
    pending.delete(result.id);
    clearTimeout(waiter.timer);
    if (result.error) waiter.reject(new Error(result.error.message));
    else waiter.resolve(result.result);
  });
  return {
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Electron validation timed out: ${method}`));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.call('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    },
    close() { socket.close(); },
  };
}

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(operation, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value) return value;
    await delay(200);
  }
  throw new Error('Isolated Desktop validation condition timed out');
}
