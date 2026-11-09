import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';
import { adaptCodinputSource, buildCodinputClient } from '../scripts/build-codinput.mjs';

async function loadAdapted(file, dependencies, globals = {}) {
  const original = await readFile(`vendor/codinput/${file}`);
  const source = adaptCodinputSource(file, original);
  const { code } = await transform(source, { loader: file.endsWith('x') ? 'tsx' : 'ts', jsx: 'automatic', format: 'cjs', target: 'es2021' });
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, ...globals,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected test dependency: ${name}`);
      return dependencies[name];
    },
  });
  return module.exports;
}

test('concurrent main/child editors keep keyboard, draft, caret and composition events with their owner', async () => {
  let handlers, onUpdate;
  const timers = [];
  const noop = () => ({});
  const api = await loadAdapted('src/client/cm.ts', {
    '@codemirror/commands': { history: noop, historyKeymap: [], defaultKeymap: [], indentWithTab: {} },
    '@codemirror/state': {
      Annotation: { define: noop }, Compartment: class { of() {} },
    },
    '@codemirror/view': {
      EditorView: {
        domEventHandlers(value) { handlers = value; },
        updateListener: { of(value) { onUpdate = value; } },
        editable: { of: noop }, theme: noop,
      },
      highlightActiveLine: noop, highlightActiveLineGutter: noop, lineNumbers: noop,
      drawSelection: noop, dropCursor: noop, placeholder: noop, keymap: { of: noop },
    },
    './prefs': {},
  }, { setTimeout(callback) { timers.push(callback); } });
  const main = {}, child = {}, events = [];
  const hooks = owner => ({
    onKeydown() { events.push(`${owner}:key`); return true; },
    onCompositionChange(value) { events.push(`${owner}:composition:${value}`); },
    onFocusChange(value) { events.push(`${owner}:focus:${value}`); },
    onLocalChange(text) { events.push(`${owner}:draft:${text}`); },
    onCaret(text, head) { events.push(`${owner}:caret:${head}`); },
  });
  const mainHooks = hooks('main'), childHooks = hooks('child');
  api.createEditorExtensions({ lineNumbers: true, editable: true, fontFamily: 'monospace', placeholder: '' });
  api.setActiveEditorHooks(main, mainHooks);
  api.setActiveEditorHooks(child, childHooks);
  assert.equal(handlers.keydown({}, main), true);
  assert.equal(handlers.keydown({}, child), true);
  handlers.compositionstart({}, main);
  handlers.compositionend({}, main);
  handlers.focus({}, child);
  onUpdate({
    view: main, docChanged: true, selectionSet: false, transactions: [],
    state: { doc: { toString: () => 'main draft' }, selection: { main: { head: 5 } } },
  });
  api.clearActiveEditorHooks(child, childHooks);
  for (const callback of timers) callback();
  assert.deepEqual(events, [
    'main:key', 'child:key', 'main:composition:true', 'child:focus:true',
    'main:draft:main draft', 'main:caret:5', 'main:composition:false',
  ]);
  assert.equal(handlers.keydown({}, child), false);
  assert.equal(handlers.keydown({}, main), true);
  const restoredHooks = hooks('restored');
  api.setActiveEditorHooks(main, restoredHooks);
  api.clearActiveEditorHooks(main, mainHooks);
  assert.equal(handlers.keydown({}, main), true);
  assert.equal(events.at(-1), 'restored:key');
});

test('toggle command cleanup uses explicit composer ownership and preserves newly edited drafts', async () => {
  const timers = [], cleared = [], commands = [];
  let enabled = true;
  const diagnostic = { __dshCodinputSessionId: 'child', __dshCodinputShell: {} };
  const api = await loadAdapted('src/client/command.ts', {
    './services': { stash: {
      sessions: { scope: id => id },
      conversation: { input: { for: id => ({ setDraft: text => cleared.push([id, text]) }) } },
    } },
    './prefs': { loadPrefs: () => ({ enabled }), savePrefs: value => { enabled = value.enabled; } },
    './sideinput': { carriedSessionIds: () => [], requestSidebarTabClose() {} },
    './i18n': { t: value => value }, './icons': {},
    './diag': { diagWindow: () => diagnostic, runGuarded: (scope, action) => action() },
  }, { setTimeout(callback) { timers.push(callback); } });
  api.registerCodinputCommand({
    inject(names, callback) { callback({ commandUi: { register: command => commands.push(command) } }); },
    effect(factory) { factory(); },
  });
  let snapshot = { draft: '/codinput', draftRev: 3 };
  const keyboard = { get snapshot() { return snapshot; } };
  api.rememberCommandOrigin('main', keyboard);
  commands[0].ui.run();
  timers.shift()();
  assert.deepEqual(cleared, [['main', '']]);
  api.rememberCommandOrigin('main', keyboard);
  commands[0].ui.run();
  snapshot = { draft: 'new work', draftRev: 4 };
  timers.shift()();
  commands[0].ui.run(); // No explicit owner must never use the diagnostic child.
  timers.shift()();
  assert.deepEqual(cleared, [['main', '']]);
});

test('Codinput declares the connection service required by the subagent model adapter', async () => {
  const source = adaptCodinputSource('src/client/index.tsx', await readFile('vendor/codinput/src/client/index.tsx'));
  assert.ok(source.includes("export const inject = ['slots', 'conversation', 'connection']"));
});

test('addressed subagent model selection uses authenticated host RPC while main sessions retain official directory writes', async () => {
  const calls = [];
  const store = { getSnapshot: () => ({ current: null, groups: [], failures: [], status: 'ready', error: null }) };
  const officialSelect = async selection => { officialSelect.last = selection; };
  const directories = {
    child: { store, load: async () => {}, select: async () => { throw new Error('official child select must not run'); } },
    main: { store, load: async () => {}, select: officialSelect },
  };
  const api = await loadAdapted('src/client/modeldir.ts', {
    './services': {
      stash: {
        sessions: { subagentAddress: id => id === 'child' ? { parentSessionId: 'main', childId: 'child' } : undefined },
        modelDirectories: { directoryFor: id => directories[id] },
        connection: { rpc: { async call(channel, endpoint, payload) { calls.push({ channel, endpoint, payload }); return { ok: true, value: { ok: true, data: { sessionId: 'child' } } }; } } },
      },
    },
    './diag': { diagDebug() {} },
  });
  const child = api.getSessionDirectory('child');
  await child.select({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, '/api');
  assert.equal(calls[0].endpoint, 'nexus/rpc');
  assert.equal(calls[0].payload.scope.level, 'session');
  assert.equal(calls[0].payload.scope.sessionId, 'child');
  assert.equal(calls[0].payload.payload.params.domain, 'agents');
  assert.equal(calls[0].payload.payload.action, 'session/model.select');
  assert.equal(calls[0].payload.payload.params.sessionId, 'child');
  assert.equal(calls[0].payload.payload.params.provider, 'deepseek');
  assert.equal(calls[0].payload.payload.params.model, 'deepseek-chat');
  assert.equal(calls[0].payload.payload.params.reasoningEffort, 'high');
  const main = api.getSessionDirectory('main');
  assert.equal(main.select, officialSelect);
  await main.select({ provider: 'deepseek', model: 'deepseek-reasoner' });
  assert.deepEqual(officialSelect.last, { provider: 'deepseek', model: 'deepseek-reasoner' });
});

test('addressed subagent model selection also detects the rc.5 session-list projection', async () => {
  const calls = [];
  const directories = {
    child: { store: {}, load: async () => {}, select: async () => { throw new Error('official child select must not run'); } },
  };
  const api = await loadAdapted('src/client/modeldir.ts', {
    './services': {
      stash: {
        sessions: {
          list: {
            getSnapshot: () => ({ byId: { child: { origin: 'subagent', parentId: 'main' } } }),
          },
        },
        modelDirectories: { directoryFor: id => directories[id] },
        connection: {
          rpc: {
            async call(channel, endpoint, payload) {
              calls.push({ channel, endpoint, payload });
              return { ok: true, value: { ok: true, data: { sessionId: 'child' } } };
            },
          },
        },
      },
    },
    './diag': { diagDebug() {} },
  });
  await api.getSessionDirectory('child').select({ provider: 'anthropic', model: 'claude-opus-5-5' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.payload.params.sessionId, 'child');
  assert.equal(calls[0].payload.payload.params.model, 'claude-opus-5-5');
});

test('model picker reaches the registered agents capability through the real RPC route', async () => {
  const { createAgentsModule } = await import('../src/domain/workflow/index.ts');
  const { registerRpcRoute } = await import('../src/host/routes.ts');
  const { OperationController } = await import('../src/host/lifecycle.ts');
  const calls = [];
  const services = {
    workspaceRoot: process.cwd(),
    store: { async list() { return []; }, async get() { return undefined; } },
    emit() {},
    host: { async sessions(action, params) { calls.push({ action, params }); return { sessionId: params.sessionId }; } },
  };
  const agents = createAgentsModule(services);
  let route;
  const ctx = {
    get: name => name === 'sessions' ? { get: id => ({ header: { id, cwd: process.cwd() } }) } : undefined,
    connection: { fetch: { register(value) { route = value; return async () => {}; } } },
  };
  const controller = new OperationController();
  registerRpcRoute(ctx, {
    services,
    capabilities: domain => domain === agents.id ? agents.capabilities : [],
    async dispatch(domain, payload, context) {
      assert.equal(domain, agents.id);
      return { ok: true, data: await agents.dispatch(payload, context) };
    },
  }, controller, 65536);
  const api = await loadAdapted('src/client/modeldir.ts', {
    './services': { stash: {
      sessions: { subagentAddress: () => ({ parentSessionId: 'main' }) },
      modelDirectories: { directoryFor: () => ({ store: {}, load: async () => {} }) },
      connection: { rpc: { async call(channel, method, payload) {
        const response = await route.fetch(new Request(`http://fixture.invalid${channel}/${method}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'picker', method, payload }),
        }));
        return (await response.json()).result;
      } } },
    } },
    './diag': { diagDebug() {} },
  });
  try {
    await api.getSessionDirectory('child').select({ provider: 'hjmclaude', model: 'claude-opus-5-5' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'model.select');
    assert.equal(calls[0].params.sessionId, 'child');
    assert.equal(calls[0].params.model, 'claude-opus-5-5');
  } finally {
    await controller.dispose();
  }
});

test('delivery factory is rebuilt from adapted source and bundles the patched sanitizer', async () => {
  const rebuilt = await buildCodinputClient();
  assert.equal(rebuilt.dependencies.find(pkg => pkg.name === 'dompurify').version, '3.4.17');
  assert.ok(rebuilt.inputs.includes('vendor/codinput/src/client/cm.ts'));
  assert.ok(rebuilt.adaptations.includes('editor-view-scoped-hooks'));
  assert.ok(rebuilt.adaptations.includes('viewport-bounded-scrollable-menus'));
  assert.ok(rebuilt.adaptations.includes('subagent-model-selection-via-authenticated-host-rpc'));
  assert.ok(rebuilt.adaptations.includes('codinput-connection-injection-for-model-selection'));
  assert.ok(rebuilt.requires.every(name => ['react', 'react-dom', 'react/jsx-runtime'].includes(name)));
});

test('long model menus fit the available desktop viewport and keep native wheel scrolling', async () => {
  const element = {
    style: {},
    offsetWidth: 280,
    getBoundingClientRect: () => ({ width: 280 }),
    querySelector: () => ({ scrollHeight: 2400 }),
  };
  let menuPosition = null;
  const jsx = (type, props) => ({ type, props });
  const api = await loadAdapted('src/client/components/MenuSurface.tsx', {
    react: {
      useRef: () => ({ current: element }),
      useState: () => [menuPosition, update => { menuPosition = update(menuPosition); }],
      useLayoutEffect: effect => effect(), useEffect() {},
    },
    'react-dom': { createPortal: node => node },
    'react/jsx-runtime': { jsx, jsxs: jsx },
  }, { document: { body: {} }, requestAnimationFrame: () => 1, window: { innerHeight: 500, innerWidth: 900, addEventListener() {} } });
  const props = {
    anchor: { getBoundingClientRect: () => ({ left: 50, right: 330, top: 45, bottom: 75 }) },
    side: 'top', children: 'long model catalog', onClose() {},
  };
  api.MenuSurface(props); // The layout effect measures, then React renders its state update.
  const rendered = api.MenuSurface(props);
  const height = parseFloat(element.style.height), top = rendered.props.style.top;
  assert.ok(top >= 12 && top + height <= 488, 'menu must stay inside the viewport');
  assert.ok(height > 300, 'a crowded preferred side must use the roomier side');
  let stopped = false;
  rendered.props.children.props.onWheel({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true); // No preventDefault: the menu retains native scrolling.
});
