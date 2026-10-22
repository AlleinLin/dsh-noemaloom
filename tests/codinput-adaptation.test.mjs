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

test('delivery factory is rebuilt from adapted source and bundles the patched sanitizer', async () => {
  const rebuilt = await buildCodinputClient();
  assert.equal(rebuilt.dependencies.find(pkg => pkg.name === 'dompurify').version, '3.4.17');
  assert.ok(rebuilt.inputs.includes('vendor/codinput/src/client/cm.ts'));
  assert.ok(rebuilt.adaptations.includes('editor-view-scoped-hooks'));
  assert.ok(rebuilt.adaptations.includes('viewport-bounded-scrollable-menus'));
  assert.ok(rebuilt.requires.every(name => ['react', 'react-dom', 'react/jsx-runtime'].includes(name)));
});

test('long model menus fit the available desktop viewport and keep native wheel scrolling', async () => {
  const element = {
    style: {},
    getBoundingClientRect: () => ({ width: 280 }),
    querySelector: () => ({ scrollHeight: 2400 }),
  };
  const jsx = (type, props) => ({ type, props });
  const api = await loadAdapted('src/client/components/MenuSurface.tsx', {
    react: {
      useRef: () => ({ current: element }),
      useLayoutEffect: effect => effect(), useEffect() {},
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
  }, { window: { innerHeight: 500, innerWidth: 900, addEventListener() {} } });
  const rendered = api.MenuSurface({
    anchor: { left: 50, right: 330, top: 45, bottom: 75 },
    side: 'top', children: 'long model catalog', onClose() {},
  });
  const height = parseFloat(element.style.height), top = parseFloat(element.style.top);
  assert.ok(top >= 12 && top + height <= 488, 'menu must stay inside the viewport');
  assert.ok(height > 300, 'a crowded preferred side must use the roomier side');
  let stopped = false;
  rendered.props.children.props.onWheel({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true); // No preventDefault: the menu retains native scrolling.
});
