import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseFactory } from '../scripts/original-factory.mjs';
import { adaptAgentClient } from '../scripts/adapt-agent-client.mjs';

const published = await readFile('node_modules/dsh-better-sidebar/lib/client.js', 'utf8');
const original = parseFactory(published, 'dsh-better-sidebar').factory;
const adapted = adaptAgentClient(original);
test('a background pan suppresses its derived click but not subsequent agent, expand or control clicks', () => {
  // 0.28.2 contains the upstream fix; guard both published and adapted behavior.
  for (const [source, expected] of [[original, true], [adapted, true]]) {
    // Capture window listeners while exercising the real production closure.
    const start = source.indexOf('const onPointerDown =', source.indexOf('function TasksGraph('));
    const end = source.indexOf('const phaseFrames =', start);
    assert.ok(start > 0 && end > start);
    const listeners = new Map();
    const handlers = vm.runInNewContext(`(() => { ${source.slice(start, end)}; return {onPointerDown, clickAllowed}; })()`, {
      react: { useCallback: fn => fn }, travelRef: { current: 0 }, stopGlide() {},
      tfRef: { current: { x: 0, y: 0, k: 1 } }, touchedRef: { current: false },
      CLICK_TOLERANCE_PX: 4, setDragging() {}, setTf() {}, clampTf: value => value,
      panActiveRef: { current: false }, draggingRef: { current: false },
      pendingPanRef: { current: null },
      panBatcher: { schedule(fn) { fn(); }, flushNow() {} },
      window: { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) },
    });
    handlers.onPointerDown({ button: 0, clientX: 0, clientY: 0, target: { closest: () => null } });
    listeners.get('pointermove')({ clientX: 40, clientY: 30 });
    listeners.get('pointerup')();
    assert.equal(handlers.clickAllowed(), false);
    handlers.onPointerDown({ button: 0, target: { closest: selector => selector === '[data-graph-node]' ? {} : null } });
    assert.equal(handlers.clickAllowed(), expected, expected ? 'fixed agent/expand click admission' : 'old bug reproduced');
  }
});
test('viewing a child uses only the native resource controller, without prompt, resume, or compaction', () => {
  const begin = adapted.indexOf('function openTranscriptAside('), end = adapted.indexOf('//#endregion', begin);
  const calls = [];
  const open = new Function('hasTranscriptAside', 'subagentChatAddress', 'SUBAGENT_CHAT_KIND',
    `${adapted.slice(begin, end)}; return openTranscriptAside;`)(() => true, address => `native:${address.childSessionId}`, 'subagentchat');
  const controller = { openResource: (...args) => calls.push(args) };
  assert.equal(open({ get: name => { assert.equal(name, 'sidebarRight'); return controller; } }, { childSessionId: 'child' }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'native:child');
});
