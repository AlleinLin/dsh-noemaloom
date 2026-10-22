import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { adaptSynapseClient } from '../scripts/adapt-synapse-client.mjs';

const require = createRequire(import.meta.url);
const original = await readFile(join(dirname(require.resolve('dsh-synapse')), 'app.js'), 'utf8');
const adapted = adaptSynapseClient(original).source;
function fixture() {
  const ast = ts.createSourceFile('synapse.js', adapted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  // Execute the lifecycle from the actual adapted shipping source, not a copy.
  const statements = ast.statements.filter(node => {
    const source = node.getText(ast);
    return source.startsWith('let __nexusSynapse') || source.startsWith('function __nexusSynapse')
      || source.startsWith('async function __nexusSynapse') || source.includes('__nexusSynapseProjectionMessage);')
      || source.includes('__nexusSynapseProjectionVisibility);') || source.includes('__nexusSynapseProjectionDispose);')
      || source === '__nexusSynapseProjectionSchedule();';
  }).map(node => node.getText(ast)).join('\n');
  let calls = 0, serial = 0, finish;
  const windowListeners = new Map(), documentListeners = new Map(), timers = new Map();
  const window = { parent: {}, location: { origin: 'https://dsh.test' },
    addEventListener: (name, fn) => windowListeners.set(name, fn),
    removeEventListener: name => windowListeners.delete(name) };
  const document = { hidden: false, addEventListener: (name, fn) => documentListeners.set(name, fn),
    removeEventListener: name => documentListeners.delete(name) };
  vm.runInNewContext(statements, {
    window, document, clearTimeout: id => timers.delete(id),
    setTimeout(fn) { const id = ++serial; timers.set(id, fn); return id; },
    pollProjection() { calls++; return new Promise(resolve => { finish = resolve; }); },
    setError: error => assert.fail(String(error)),
  });
  return {
    timers, windowListeners, documentListeners, calls: () => calls,
    async finish() { finish(); await Promise.resolve(); await Promise.resolve(); },
    message(active, origin = window.location.origin, source = window.parent) {
      windowListeners.get('message')({ source, origin, data: { source: 'nexus-canvas', active } });
    },
    show(visible) { document.hidden = !visible; documentListeners.get('visibilitychange')(); },
  };
}
test('a retained hidden original Synapse iframe makes no polls even when its own document is visible', async () => {
  const f = fixture();
  assert.equal(f.timers.size, 0); assert.equal(f.calls(), 0);
  f.message(true, 'https://other.test'); f.message(true, 'https://dsh.test', {});
  assert.equal(f.calls(), 0, 'Only the exact same-origin parent can activate the original poll');
  f.message(true); assert.equal(f.calls(), 1);
  for (let i = 0; i < 1000; i++) f.message(true);
  assert.equal(f.calls(), 1); assert.equal(f.timers.size, 0);
  f.message(false); await f.finish(); assert.equal(f.timers.size, 0);
  f.message(true); assert.equal(f.calls(), 2); await f.finish();
  assert.equal(f.timers.size, 1);
  f.show(false); assert.equal(f.timers.size, 0);
  f.show(true); assert.equal(f.calls(), 3); await f.finish();
  f.windowListeners.get('pagehide')();
  assert.equal(f.timers.size, 0); assert.equal(f.windowListeners.size, 0); assert.equal(f.documentListeners.size, 0);
});
test('the original projection reader still owns gestures, refresh and its busy guard', () => {
  assert.match(adapted, /if \(!__nexusSynapseProjectionVisible\(\) \|\| polling \|\| document.hidden \|\| !canReplaceView\(\)\) return/);
  assert.doesNotMatch(adapted, /window\.setInterval\(\(\) => \{ void pollProjection\(\) \}, 1_000\)/);
  assert.match(adapted, /await refreshProjection\(\)/);
});
