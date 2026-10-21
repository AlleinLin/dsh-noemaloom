import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCK_PANE_LIMIT, advanceDock, dockLayoutFingerprint, dockPaneIds, inheritedDockTemplate, nativeDockLayoutCompatible, parseTargetAddress, planDockDrop,
  planDockSplit, readDockPreferences, readDockSurface, shouldRestoreDockBackup, targetAddress, type DockLayout,
} from '../src/client/dock-model.js';

const pane = (id: string, tab: string) => ({ kind: 'pane' as const, id, host: 'dock' as const, tabs: [tab], activeTabId: tab });
const tab = (id: string, kind = 'file') => ({ id, kind, contentId: `dsh-resource://file/${id}`, title: id });
const initial = (): DockLayout => ({
  nodes: { pane1: pane('pane1', 'tab2') }, tabs: { tab2: tab('tab2') }, rootId: 'pane1',
  activePaneId: 'pane1', floats: [], expanded: true, mode: 'push',
});
function nested(): DockLayout {
  return {
    ...initial(), rootId: 'split7',
    nodes: {
      pane1: pane('pane1', 'tab2'), pane3: pane('pane3', 'tab4'), pane5: pane('pane5', 'tab6'),
      split7: { kind: 'split', id: 'split7', axis: 'row', children: ['pane1', 'split8'], sizes: [.5, .5] },
      split8: { kind: 'split', id: 'split8', axis: 'column', children: ['pane3', 'pane5'], sizes: [.35, .65] },
    },
    tabs: { tab2: tab('tab2'), tab4: tab('tab4', 'terminal'), tab6: tab('tab6', 'browser') },
  };
}
const minting = () => { let next = 10; return (prefix: string) => `${prefix}${++next}`; };
const seed = (id: string) => ({ id, kind: 'guide', contentId: 'sidebar://guide', title: '打开内容' });

test('nested rows and columns restore with native identities and fresh undo history', () => {
  const history = { past: [], future: [] };
  const value = readDockSurface({ layout: nested(), minted: 8 }, history)!;
  assert.deepEqual(dockPaneIds(value.layout), ['pane1', 'pane3', 'pane5']);
  assert.equal(value.layout.tabs.tab4.kind, 'terminal');
  assert.equal(value.layout.tabs.tab6.kind, 'browser');
  assert.equal(value.history, history);
  assert.equal(value.minted, 8);
});

test('restoration rejects cycles, orphaned tabs, duplicate tab membership and impossible minted ids', () => {
  const cycle = nested();
  (cycle.nodes.split8 as any).children[1] = 'split7';
  assert.equal(readDockSurface({ layout: cycle, minted: 8 }, {}), undefined);
  const orphan = nested();
  orphan.tabs.tab9 = tab('tab9');
  assert.equal(readDockSurface({ layout: orphan, minted: 9 }, {}), undefined);
  const duplicate = nested();
  (duplicate.nodes.pane5 as any).tabs = ['tab2'];
  (duplicate.nodes.pane5 as any).activeTabId = 'tab2';
  assert.equal(readDockSurface({ layout: duplicate, minted: 8 }, {}), undefined);
  assert.equal(readDockSurface({ layout: nested(), minted: 7 }, {}), undefined);
});

test('restoration validates sizes and floating resource ownership', () => {
  const badSizes = nested();
  (badSizes.nodes.split8 as any).sizes = [.2, .2];
  assert.equal(readDockSurface({ layout: badSizes, minted: 8 }, {}), undefined);
  const floating = nested();
  floating.nodes.float9 = { ...pane('float9', 'tab10'), host: 'float', rect: { x: 0, y: 0, width: 400, height: 300 } };
  floating.floats = ['float9'];
  floating.tabs.tab10 = tab('tab10', 'terminal');
  assert.ok(readDockSurface({ layout: floating, minted: 10 }, {}));
  (floating.nodes.float9 as any).rect.width = -1;
  assert.equal(readDockSurface({ layout: floating, minted: 10 }, {}), undefined);
});

test('six-pane budget is enforced while nested four-pane layouts remain expandable', () => {
  const state = nested();
  state.nodes.pane9 = pane('pane9', 'tab10');
  (state.nodes.split8 as any).children.push('pane9');
  (state.nodes.split8 as any).sizes = [.3, .3, .4];
  state.tabs.tab10 = tab('tab10');
  const split = planDockSplit(state, minting(), 'pane3', 'column', seed);
  assert.equal(split[0].axis, 'column');
  assert.equal(split[1].type, 'openTab');
  assert.equal(split[1].tab.kind, 'guide');
  for (const [id, tabId] of [['pane11', 'tab12'], ['pane13', 'tab14']]) {
    state.nodes[id] = pane(id, tabId);
    state.tabs[tabId] = tab(tabId);
    (state.nodes.split8 as any).children.push(id);
  }
  assert.equal(dockPaneIds(state).length, DOCK_PANE_LIMIT);
  assert.deepEqual(planDockSplit(state, minting(), 'pane1', 'row', seed), []);
  assert.deepEqual(planDockDrop(state, minting(), 'tab2', 'pane3', 'top', seed), []);
  assert.equal(planDockDrop(state, minting(), 'tab2', 'pane3', 'center', seed)[0].type, 'moveTab');
});

test('top-edge drag backfills a sole tab and uses native column operations', () => {
  const ops = planDockDrop(initial(), minting(), 'tab2', 'pane1', 'top', seed);
  assert.equal(ops[0].type, 'split');
  assert.equal(ops[0].axis, 'column');
  assert.equal(ops[0].direction, 'before');
  assert.equal(ops[1].type, 'openTab');
  assert.equal(ops[1].paneId, 'pane1');
  assert.equal(ops[2].type, 'moveTab');
  assert.equal(ops[2].toPaneId, ops[0].newPaneId);
});

test('floating terminal docking uses unfloat and page duplicates retain native uniqueness', () => {
  const state = nested();
  state.nodes.float9 = { ...pane('float9', 'tab10'), host: 'float', rect: { x: 0, y: 0, width: 400, height: 300 } };
  state.floats = ['float9'];
  state.tabs.tab10 = tab('tab10', 'terminal');
  assert.equal(planDockDrop(state, minting(), 'tab10', 'pane1', 'bottom', seed).at(-1).type, 'unfloat');
  state.tabs.tab2 = { ...state.tabs.tab2, kind: 'files', contentId: 'sidebar://files' };
  state.tabs.tab4 = { ...state.tabs.tab4, kind: 'files', contentId: 'sidebar://files' };
  assert.deepEqual(planDockDrop(state, minting(), 'tab2', 'pane3', 'center', seed),
    [{ type: 'closeTab', tabId: 'tab2' }, { type: 'focusTab', tabId: 'tab4' }]);
});

test('native record receives user operations and settlement as one history entry', () => {
  const state = initial();
  const surface = { layout: state, minted: 2, history: { original: true } };
  const calls: any[] = [];
  const kit: any = {
    replay(layout: any, ops: any) { calls.push(['replay', layout, ops]); return { ...layout, expanded: false }; },
    planSettle(layout: any, _mint: any, makeTab: any) { calls.push(['settle', layout, makeTab]); return [{ type: 'merge', paneId: 'pane3' }]; },
    record(history: any, layout: any, ops: any) {
      calls.push(['record', history, layout, ops]);
      return { state: layout, history: { recorded: true } };
    },
  };
  const next = advanceDock(surface, kit, (_layout, mint) => [{ type: 'focusPane', paneId: mint('pane') }], seed);
  assert.equal(next.minted, 3);
  assert.equal(calls[1][2], undefined); // Collapsed native layouts are not seeded.
  assert.deepEqual(calls[2][3], [{ type: 'focusPane', paneId: 'pane3' }, { type: 'merge', paneId: 'pane3' }]);
  assert.equal(calls[2][1], surface.history);
  assert.equal(calls[2][2], state);
  assert.deepEqual(next.history, { recorded: true });
});

test('target addresses preserve fixed single-agent identities across reloads', () => {
  const target = { type: 'agent', id: 'agent/root/worker-a', title: '数据库代理', binding: 'fixed' as const, sessionId: 'session-a', params: { view: 'context' } };
  assert.deepEqual(parseTargetAddress(targetAddress(target)), target);
  assert.equal(parseTargetAddress('dsh-resource://file/project.ts'), undefined);
  assert.equal(parseTargetAddress('dsh-resource://nexus-dock/%broken'), undefined);
  assert.throws(() => targetAddress({ type: 'agent', id: 'worker', title: '代理', binding: 'fixed' }));
});

test('layout inheritance resolves session then workspace then global and rejects unknown templates', () => {
  const preferences = readDockPreferences({
    global: 'conversation-agents', workspace: { ws: 'review', other: 'invalid' }, session: { s: 'watch' },
  });
  assert.equal(inheritedDockTemplate(preferences, 's', 'ws'), 'watch');
  assert.equal(inheritedDockTemplate(preferences, 'new', 'ws'), 'review');
  assert.equal(inheritedDockTemplate(preferences, 'new', 'elsewhere'), 'conversation-agents');
  assert.equal(preferences.workspace.other, undefined);
});

test('installing over a live native file or terminal never replays an older docking backup', () => {
  const live = { layout: initial(), minted: 2, history: {} };
  assert.equal(shouldRestoreDockBackup(live), false);
  live.layout.tabs.tab2 = { ...live.layout.tabs.tab2, kind: 'terminal' };
  assert.equal(shouldRestoreDockBackup(live), false);
  live.layout.tabs.tab2 = seed('tab2');
  assert.equal(shouldRestoreDockBackup(live), true);
  assert.equal(shouldRestoreDockBackup(undefined), true);
});

test('native compatibility checks exclude columns and nested trees without depending on key ordering', () => {
  assert.equal(nativeDockLayoutCompatible(initial()), true);
  assert.equal(nativeDockLayoutCompatible(nested()), false);
  const two = nested();
  two.rootId = 'split7';
  (two.nodes.split7 as any).children = ['pane1', 'pane3'];
  delete two.nodes.split8;
  delete two.nodes.pane5;
  delete two.tabs.tab6;
  assert.equal(nativeDockLayoutCompatible(two), true);
  (two.nodes.split7 as any).axis = 'column';
  assert.equal(nativeDockLayoutCompatible(two), false);
  const same = initial();
  const value = same.tabs.tab2;
  const reordered = { ...same, nodes: { pane1: { ...same.nodes.pane1 } },
    tabs: { tab2: { title: value.title, contentId: value.contentId, kind: value.kind, id: value.id } } };
  assert.equal(dockLayoutFingerprint(same), dockLayoutFingerprint(reordered));
});
