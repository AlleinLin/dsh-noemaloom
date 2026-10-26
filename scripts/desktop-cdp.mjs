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

// Call only after the caller validates its disposable desktop-smoke profile.
// A fresh Desktop opens the native account onboarding above the main window.
// Skip account setup in that profile; no credentials or model calls are used.
export async function completeSyntheticOnboarding(port) {
  // Electron creates the hidden main target before its welcome target.
  // A single enumeration can miss onboarding and leave every input test
  // operating against a hidden window. Observe a settled main window or
  // handle the actual welcome page before returning.
  let welcome, visibleSince;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    welcome = targets.find(row => row.type === 'page'
      && row.url.startsWith('file:') && row.url.endsWith('/renderer/welcome.html'));
    if (welcome) break;
    const main = targets.find(row => row.type === 'page' && row.url.startsWith('dsh-app://app'));
    let visible = false;
    if (main) {
      const connection = await connectTarget(main);
      try { visible = await connection.evaluate(`document.visibilityState === 'visible' && window.dshDesktop?.protocolVersion === 1`); }
      finally { connection.close(); }
    }
    if (!visible) visibleSince = undefined;
    else if (visibleSince === undefined) visibleSince = Date.now();
    else if (Date.now() - visibleSince >= 5_000) break;
    await delay(200);
  }
  if (!welcome) return { present: false, accountSetupSkipped: false };
  const cdp = await connectTarget(welcome);
  try {
    // The skip button belongs to the API-key step and is mounted while hidden
    // on the initial login screen. Enter that step before invoking its action.
    await cdp.evaluate(`(() => {
      const button = document.getElementById('api-key');
      if (button && button.getBoundingClientRect().width > 0) button.click();
    })()`);
    const clicked = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(node =>
        /^(稍后配置|Set up later|Skip for now)$/i.test(node.textContent.trim())
        && node.getBoundingClientRect().width > 0);
      if (!button) return false;
      button.click(); return true;
    })()`);
    if (!clicked) throw new Error('Synthetic Desktop onboarding has no explicit skip-account action');
    return { present: true, accountSetupSkipped: true };
  } finally { cdp.close(); }
}
