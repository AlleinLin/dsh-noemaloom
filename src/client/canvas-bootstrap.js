/* Runs inside the original canvas document, before any original application. */
(() => {
  const query = new URLSearchParams(location.search);
  const level = query.get('nexusLevel');
  const id = query.get('nexusId');
  if (!['global', 'workspace', 'session'].includes(level) || !id) throw new Error('Canvas scope is required');
  const prefix = `nexus:canvas:${level}:${encodeURIComponent(id)}:`;
  document.documentElement.dataset.nexusCanvas = location.pathname?.startsWith('/synapse/') ? 'synapse' : 'thoughtdag';
  const storage = window.localStorage;
  const keys = () => Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(key => key?.startsWith(prefix));
  // This document has its own Window/IndexedDBFactory realm. The host and
  // other canvas frames keep their untouched storage objects.
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    get length() { return keys().length; },
    key: index => keys()[index]?.slice(prefix.length) ?? null,
    getItem: key => storage.getItem(prefix + key),
    setItem: (key, value) => storage.setItem(prefix + key, String(value)),
    removeItem: key => storage.removeItem(prefix + key),
    clear: () => keys().forEach(key => storage.removeItem(key)),
  } });
  for (const method of ['open', 'deleteDatabase']) {
    const invoke = indexedDB[method].bind(indexedDB);
    indexedDB[method] = (name, ...args) => invoke(prefix + name, ...args);
  }
  let active = true;
  const resume = new Set();
  // A CSS-hidden iframe otherwise remains "visible" to its own document.
  // Keep the original applications' existing visibility-aware pollers honest.
  const visibility = typeof Document === 'function' ? Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')?.get : undefined;
  const originalVisibility = document.visibilityState;
  const actualVisibility = () => visibility ? visibility.call(document) : originalVisibility ?? 'visible';
  try {
    Object.defineProperties(document, {
      visibilityState: { configurable: true, get: () => active ? actualVisibility() : 'hidden' },
      hidden: { configurable: true, get: () => !active || actualVisibility() === 'hidden' },
    });
  } catch { /* A host with non-configurable descriptors still gets the GET gate. */ }
  const waitUntilActive = signal => new Promise((resolve, reject) => {
    if (active) return resolve();
    const stop = () => { resume.delete(ready); signal?.removeEventListener('abort', abort); };
    const ready = () => { stop(); resolve(); };
    const abort = () => {
      stop();
      reject(signal?.reason ?? (typeof DOMException === 'function'
        ? new DOMException('Canvas read cancelled', 'AbortError') : Object.assign(new Error('Canvas read cancelled'), { name: 'AbortError' })));
    };
    if (signal?.aborted) return abort();
    resume.add(ready);
    signal?.addEventListener('abort', abort, { once: true });
  });
  const scopedUrl = input => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (url.origin !== location.origin || !/^\/(?:thoughtdag|synapse)\//.test(url.pathname)) return undefined;
    url.searchParams.set('nexusLevel', level);
    url.searchParams.set('nexusId', id);
    return url;
  };
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = scopedUrl(input);
    if (url) {
      const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      // Pause only original history/projection reads. Persistence, an already
      // submitted turn, its SSE stream, and request timeouts retain their life.
      if (!active && method === 'GET' && /^\/(?:thoughtdag\/api\/(?:sessions|disksessions|roots)|synapse\/api\/workspaces)(?:\/|$)/.test(url.pathname)) {
        await waitUntilActive(init?.signal ?? (input instanceof Request ? input.signal : undefined));
      }
      return fetchOriginal(input instanceof Request ? new Request(url, input) : url, init);
    }
    return fetchOriginal(input, init);
  };
  const OriginalEventSource = window.EventSource;
  if (typeof OriginalEventSource === 'function') window.EventSource = class extends OriginalEventSource {
    constructor(input, options) { super(scopedUrl(input)?.href ?? input, options); }
  };
  const setTheme = dark => { document.body?.toggleAttribute('data-ds-dark-theme', dark); document.documentElement.dataset.theme = dark ? 'dark' : 'light'; };
  addEventListener('message', event => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.source !== 'nexus-canvas') return;
    if (typeof event.data.active === 'boolean' && active !== event.data.active) {
      active = event.data.active;
      if (active) for (const ready of [...resume]) ready();
      if (typeof Event === 'function') document.dispatchEvent?.(new Event('visibilitychange'));
    }
    if (typeof event.data.dark === 'boolean') setTheme(event.data.dark);
    const tokens = event.data.tokens?.[event.data.dark === true ? 'dark' : 'light'];
    if (tokens && typeof tokens === 'object') for (const [key, value] of Object.entries(tokens)) {
      if (key.startsWith('--dsw-') && typeof value === 'string') document.documentElement.style.setProperty(key, value);
    }
  });
})();
