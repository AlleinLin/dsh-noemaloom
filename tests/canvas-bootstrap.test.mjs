import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import vm from 'node:vm';

const bootstrap = await readFile(new URL('../src/client/canvas-bootstrap.js', import.meta.url), 'utf8');

// Independent backing services are shared between isolated Window realms,
// just as Chromium storage is shared between same-origin iframes. The tests
// execute the shipped bootstrap, not a copy of its prefixing implementation.
class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(String(key)) ?? null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
  clear() { this.values.clear(); }
}

function fixture() {
  const storage = new MemoryStorage();
  const databases = new Map();
  const hostIdb = {
    open(name) {
      if (!databases.has(String(name))) databases.set(String(name), new Map());
      const values = databases.get(String(name));
      return { put: (key, value) => values.set(key, value), get: key => values.get(key) };
    },
    deleteDatabase(name) { databases.delete(String(name)); },
  };
  const frame = (level, id, canvas = 'thoughtdag') => {
    const location = new URL(`http://localhost/${canvas}/?${new URLSearchParams({ nexusLevel: level, nexusId: id })}`);
    const requests = [], sources = [], documentEvents = [], listeners = new Map(), parent = {};
    const bodyAttributes = new Set(), themeProperties = new Map();
    let browserVisibility = 'visible';
    class FrameDocument {
      body = { toggleAttribute(key, on) { if (on) bodyAttributes.add(key); else bodyAttributes.delete(key); } };
      documentElement = { dataset: {}, style: { setProperty(key, value) { themeProperties.set(key, value); } } };
      get visibilityState() { return browserVisibility; }
      get hidden() { return browserVisibility === 'hidden'; }
      dispatchEvent(event) { documentEvents.push(event.type); return true; }
    }
    class FrameEventSource {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      readyState = FrameEventSource.OPEN;
      constructor(input, options) { this.url = String(input); this.options = options; sources.push(this); }
      close() { this.readyState = FrameEventSource.CLOSED; }
    }
    const context = {
      URL, URLSearchParams, Request, AbortController, DOMException, Event, console, location, parent,
      Document: FrameDocument, EventSource: FrameEventSource, document: new FrameDocument(),
      localStorage: storage,
      // A separate factory object models the iframe's own realm; its backing
      // database service is shared with the host and all the other frames.
      indexedDB: {
        open: hostIdb.open.bind(hostIdb),
        deleteDatabase: hostIdb.deleteDatabase.bind(hostIdb),
      },
      fetch(input, init) {
        requests.push({ input, init });
        return Promise.resolve({ ok: true });
      },
      addEventListener(type, listener) { listeners.set(type, listener); },
    };
    context.window = context;
    vm.runInNewContext(bootstrap, context, { filename: 'canvas-bootstrap.js' });
    const post = (data, overrides = {}) => listeners.get('message')({
      source: parent, origin: location.origin, data: { source: 'nexus-canvas', ...data }, ...overrides,
    });
    return {
      context, requests, sources, listeners, parent, bodyAttributes, themeProperties, documentEvents, post,
      OriginalEventSource: FrameEventSource,
      setBrowserVisibility(value) { browserVisibility = value; },
    };
  };
  return { storage, databases, hostIdb, frame };
}

test('canvas storage survives frame reloads while isolating tiers, siblings, and host values', () => {
  const f = fixture();
  f.storage.setItem('draft', 'host draft');
  const global = f.frame('global', 'global');
  const workspace = f.frame('workspace', 'same-id');
  const session = f.frame('session', 'same-id');
  const sibling = f.frame('session', 'other-id');
  for (const [name, value] of [['global', global], ['workspace', workspace], ['session', session], ['sibling', sibling]]) {
    value.context.localStorage.setItem('draft', name);
    value.context.localStorage.setItem('zero', 0);
    assert.equal(value.context.localStorage.length, 2);
    assert.deepEqual([value.context.localStorage.key(0), value.context.localStorage.key(1)].sort(), ['draft', 'zero']);
    assert.equal(value.context.localStorage.getItem('draft'), name);
    assert.equal(value.context.localStorage.getItem('zero'), '0');
  }
  assert.equal(f.storage.getItem('draft'), 'host draft', 'host data is neither read nor overwritten');
  assert.equal(f.frame('session', 'same-id').context.localStorage.getItem('draft'), 'session', 'same scope reload restores its own draft');
  session.context.localStorage.clear();
  assert.equal(session.context.localStorage.length, 0);
  assert.equal(workspace.context.localStorage.getItem('draft'), 'workspace');
  assert.equal(sibling.context.localStorage.getItem('draft'), 'sibling');
  assert.equal(global.context.localStorage.getItem('draft'), 'global');
  assert.equal(f.storage.getItem('draft'), 'host draft');
});

test('scope identifiers containing separators, escapes and Unicode remain distinct', () => {
  const f = fixture();
  const ids = ['a:b', 'a%3Ab', 'a/b', 'a%2Fb', '工作区:一', '工作区%3A一'];
  for (const id of ids) f.frame('session', id).context.localStorage.setItem('graph', id);
  for (const id of ids) assert.equal(f.frame('session', id).context.localStorage.getItem('graph'), id);
});

test('database open, reload and delete affect only the requesting canvas scope', () => {
  const f = fixture();
  f.hostIdb.open('thoughtdag').put('node', 'host');
  const a = f.frame('session', 'a');
  const b = f.frame('session', 'b');
  const workspace = f.frame('workspace', 'a');
  a.context.indexedDB.open('thoughtdag').put('node', 'session a');
  b.context.indexedDB.open('thoughtdag').put('node', 'session b');
  workspace.context.indexedDB.open('thoughtdag').put('node', 'workspace a');
  assert.equal(f.frame('session', 'a').context.indexedDB.open('thoughtdag').get('node'), 'session a');
  a.context.indexedDB.deleteDatabase('thoughtdag');
  assert.equal(a.context.indexedDB.open('thoughtdag').get('node'), undefined);
  assert.equal(b.context.indexedDB.open('thoughtdag').get('node'), 'session b');
  assert.equal(workspace.context.indexedDB.open('thoughtdag').get('node'), 'workspace a');
  assert.equal(f.hostIdb.open('thoughtdag').get('node'), 'host', 'frame DB deletion never reaches an unprefixed host DB');
});

test('fetch scope follows absolute, relative, and Request inputs without losing request semantics', async () => {
  const f = fixture();
  const { context, requests } = f.frame('session', 'session a');
  const headers = { 'content-type': 'application/json', 'x-request': 'canvas' };
  await context.fetch('/synapse/api/sessions/sync?since=4&nexusId=other', { method: 'POST', headers, body: '{"value":1}' });
  const first = requests.at(-1);
  const firstUrl = new URL(String(first.input));
  assert.equal(firstUrl.searchParams.get('nexusLevel'), 'session');
  assert.equal(firstUrl.searchParams.get('nexusId'), 'session a', 'a supplied query cannot silently switch scope');
  assert.equal(firstUrl.searchParams.get('since'), '4');
  assert.equal(first.init.method, 'POST');
  assert.equal(first.init.body, '{"value":1}');
  assert.equal(first.init.headers, headers);
  const source = new Request('http://localhost/thoughtdag/api/sessions/a/followup', {
    method: 'POST', headers: { 'x-preserved': 'yes' }, body: 'question',
  });
  await context.fetch(source);
  const rewritten = requests.at(-1).input;
  assert.equal(new URL(rewritten.url).searchParams.get('nexusId'), 'session a');
  assert.equal(rewritten.method, 'POST');
  assert.equal(rewritten.headers.get('x-preserved'), 'yes');
  assert.equal(await rewritten.text(), 'question');
  await context.fetch('api/models?mode=full');
  assert.equal(new URL(String(requests.at(-1).input)).pathname, '/thoughtdag/api/models');
  const external = 'https://example.invalid/thoughtdag/api/models';
  await context.fetch(external);
  assert.equal(requests.at(-1).input, external, 'external requests retain the original URL');
  await context.fetch('/api/host-settings');
  assert.equal(requests.at(-1).input, '/api/host-settings', 'host API requests do not inherit a canvas scope');
});

test('theme messages require both the real parent window and its origin', () => {
  const f = fixture();
  const { context, parent, listeners, bodyAttributes } = f.frame('session', 'a');
  const message = listeners.get('message');
  message({ source: {}, origin: context.location.origin, data: { source: 'nexus-canvas', dark: true } });
  message({ source: parent, origin: 'https://example.invalid', data: { source: 'nexus-canvas', dark: true } });
  assert.equal(bodyAttributes.has('data-ds-dark-theme'), false);
  message({ source: parent, origin: context.location.origin, data: { source: 'nexus-canvas', dark: true } });
  assert.equal(bodyAttributes.has('data-ds-dark-theme'), true);
  assert.equal(context.document.documentElement.dataset.theme, 'dark');
});

test('EventSource keeps native behavior and exact canvas scope, including when its frame is inactive', () => {
  const f = fixture();
  const frame = f.frame('workspace', '工程:a /1');
  const { context, sources, OriginalEventSource, post } = frame;
  const options = { withCredentials: true };
  post({ active: false });
  const stream = new context.EventSource('/synapse/api/live?after=7&nexusId=foreign&nexusLevel=global', options);
  assert.equal(sources.length, 1, 'an inactive frame can open its live event stream immediately');
  assert.ok(stream instanceof OriginalEventSource);
  assert.ok(stream instanceof context.EventSource);
  assert.equal(context.EventSource.OPEN, OriginalEventSource.OPEN, 'native static state constants remain available');
  const url = new URL(stream.url);
  assert.equal(url.pathname, '/synapse/api/live');
  assert.equal(url.searchParams.get('nexusLevel'), 'workspace');
  assert.equal(url.searchParams.get('nexusId'), '工程:a /1');
  assert.equal(url.searchParams.get('after'), '7');
  assert.equal(stream.options, options);
  const relative = new context.EventSource('api/sessions/a/live');
  assert.equal(new URL(relative.url).pathname, '/thoughtdag/api/sessions/a/live');
  assert.equal(new URL(relative.url).searchParams.get('nexusId'), '工程:a /1');
  const external = 'https://model.invalid/thoughtdag/api/live';
  assert.equal(new context.EventSource(external).url, external, 'external SSE keeps its original address');
  const native = '/api/session/events';
  assert.equal(new context.EventSource(native).url, native, 'native host SSE is not rewritten');
  post({ active: true });
  assert.equal(stream.readyState, OriginalEventSource.OPEN, 'visibility does not close an existing stream');
  stream.close();
  assert.equal(stream.readyState, OriginalEventSource.CLOSED);
});

test('inactive frames pause history and projection GETs, then resume each request once with its scope', { timeout: 5_000 }, async () => {
  const f = fixture();
  const frame = f.frame('session', 'a /1');
  const { context, requests, post, documentEvents } = frame;
  post({ active: false });
  assert.equal(context.document.visibilityState, 'hidden');
  assert.equal(context.document.hidden, true);
  const waiting = [
    context.fetch('/thoughtdag/api/sessions?since=2'),
    context.fetch('/thoughtdag/api/disksessions/a/log'),
    context.fetch('/thoughtdag/api/roots/claude/list'),
    context.fetch('/synapse/api/workspaces'),
    context.fetch(new Request('http://localhost/synapse/api/workspaces/graph-a', { headers: { 'x-read': 'preserved' } })),
  ];
  await Promise.resolve();
  assert.equal(requests.length, 0, 'hidden history pollers do not hit the host');

  post({ active: false });
  assert.equal(documentEvents.length, 1, 'repeated inactive messages do not repeat visibility transitions');
  post({ active: true });
  await Promise.all(waiting);
  assert.equal(requests.length, waiting.length);
  for (const request of requests) {
    const url = new URL(request.input instanceof Request ? request.input.url : String(request.input));
    assert.equal(url.searchParams.get('nexusLevel'), 'session');
    assert.equal(url.searchParams.get('nexusId'), 'a /1');
  }
  assert.equal(new URL(String(requests[0].input)).searchParams.get('since'), '2');
  assert.equal(requests.at(-1).input.headers.get('x-read'), 'preserved');
  assert.equal(context.document.hidden, false);
  assert.equal(context.document.visibilityState, 'visible');
  assert.deepEqual(documentEvents, ['visibilitychange', 'visibilitychange']);
  post({ active: true });
  await Promise.resolve();
  assert.equal(requests.length, waiting.length, 'repeated resume messages cannot duplicate reads');
});

test('inactive frames keep writes, submitted turns, model discovery, and unrelated reads flowing', { timeout: 5_000 }, async () => {
  const f = fixture();
  const { context, requests, post } = f.frame('session', 'a');
  await context.fetch('/thoughtdag/api/sessions/a/log');
  post({ active: false });
  const body = '{"question":"continue"}';
  await Promise.all([
    context.fetch('/thoughtdag/api/sessions/a/followup', { method: 'POST', body }),
    context.fetch('/thoughtdag/api/stream', { method: 'POST', body }),
    context.fetch('/synapse/api/workspaces/graph-a', { method: 'POST', body }),
    context.fetch('/thoughtdag/api/models'),
    context.fetch('/api/session-list'),
    context.fetch('https://outside.invalid/thoughtdag/api/sessions'),
  ]);
  assert.equal(requests.length, 7, 'only background history reads wait for visibility');
  assert.equal(requests[1].init.body, body);
  assert.equal(requests[2].init.method, 'POST');
  assert.equal(requests[3].init.body, body);
  assert.equal(requests[5].input, '/api/session-list');
  assert.equal(requests[6].input, 'https://outside.invalid/thoughtdag/api/sessions');
});

test('paused reads honor abort signals and release waiters on abort or resume', { timeout: 5_000 }, async () => {
  const f = fixture();
  const { context, requests, post } = f.frame('session', 'a');
  post({ active: false });
  const abort = new AbortController();
  const reason = new Error('caller cancelled history');
  const paused = context.fetch('/thoughtdag/api/sessions/a/log', { signal: abort.signal });
  assert.equal(getEventListeners(abort.signal, 'abort').length, 1);
  const rejection = assert.rejects(paused, error => error === reason);
  abort.abort(reason);
  await rejection;
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0, 'cancelled read removes its listener');
  assert.equal(requests.length, 0);

  const alreadyAborted = context.fetch('/synapse/api/workspaces', { signal: abort.signal });
  await assert.rejects(alreadyAborted, error => error === reason);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0, 'an already cancelled read never installs a waiter');

  const sourceAbort = new AbortController();
  const sourceRequest = new Request('http://localhost/thoughtdag/api/disksessions/a/log', { signal: sourceAbort.signal });
  const sourcePending = context.fetch(sourceRequest);
  const sourceRejection = assert.rejects(sourcePending, error => error.name === 'AbortError');
  sourceAbort.abort();
  await sourceRejection;
  assert.equal(getEventListeners(sourceRequest.signal, 'abort').length, 0);

  const resumeSignal = new AbortController();
  const resumable = context.fetch('/synapse/api/workspaces', { signal: resumeSignal.signal });
  assert.equal(getEventListeners(resumeSignal.signal, 'abort').length, 1);
  post({ active: true });
  await resumable;
  assert.equal(getEventListeners(resumeSignal.signal, 'abort').length, 0, 'resumed read removes its wait listener');
  assert.equal(requests.length, 1, 'cancelled requests are not revived by the next active message');
  assert.equal(requests[0].init.signal, resumeSignal.signal);
});

test('an explicit init signal overrides the Request signal while waiting for visibility', { timeout: 5_000 }, async () => {
  const f = fixture();
  const { context, requests, post } = f.frame('session', 'a');
  post({ active: false });
  const original = new AbortController();
  original.abort(new Error('replaced request signal'));
  const replacement = new AbortController();
  const source = new Request('http://localhost/thoughtdag/api/sessions', { signal: original.signal });
  const pending = context.fetch(source, { signal: replacement.signal });
  assert.equal(getEventListeners(replacement.signal, 'abort').length, 1);
  assert.equal(requests.length, 0);
  post({ active: true });
  await pending;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.signal, replacement.signal);
  assert.equal(getEventListeners(replacement.signal, 'abort').length, 0);
});

test('visibility messages require the real parent, its origin, and the canvas channel', { timeout: 5_000 }, async () => {
  const f = fixture();
  const frame = f.frame('session', 'a');
  const { context, requests, post, documentEvents } = frame;
  post({ active: false }, { source: {} });
  post({ active: false }, { origin: 'https://outside.invalid' });
  post({ source: 'unrelated', active: false });
  assert.equal(context.document.hidden, false);
  assert.deepEqual(documentEvents, []);
  await context.fetch('/synapse/api/workspaces');
  assert.equal(requests.length, 1, 'untrusted messages cannot suspend reads');
  post({ active: false });
  const pending = context.fetch('/synapse/api/workspaces');
  post({ active: true }, { source: {} });
  post({ active: true }, { origin: 'https://outside.invalid' });
  post({ source: 'unrelated', active: true });
  await Promise.resolve();
  assert.equal(requests.length, 1, 'untrusted messages cannot resume a hidden frame');
  post({ active: true });
  await pending;
  assert.equal(requests.length, 2);
  frame.setBrowserVisibility('hidden');
  assert.equal(context.document.visibilityState, 'hidden', 'the real browser visibility remains authoritative while active');
  assert.equal(context.document.hidden, true);
});

test('a canvas opened without valid scope stops before touching shared storage', () => {
  const storage = new MemoryStorage();
  const context = {
    URLSearchParams, location: new URL('http://localhost/thoughtdag/'),
    localStorage: storage,
  };
  context.window = context;
  assert.throws(() => vm.runInNewContext(bootstrap, context), /Canvas scope is required/);
  assert.equal(context.localStorage, storage);
  assert.equal(storage.length, 0);
});
