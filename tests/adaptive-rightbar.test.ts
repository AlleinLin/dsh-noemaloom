import test from 'node:test';
import assert from 'node:assert/strict';
import { installAdaptiveRightbar } from '../src/client/adaptive-rightbar.js';

function fixture(saved?: string) {
  const values = new Map<string, string>(saved ? [['dsh-noemaloom:rightbar-width:v1', saved]] : []);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const info = { viewportWidth: 1279, sidebar: 280, narrowExpanded: false,
    rightbar: null as number | null, rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false };
  const actions = {
    setRightbar(px: number) { info.rightbar = Math.min(Math.max(300, px), Math.max(300, info.viewportWidth * .7)); },
    setViewportWidth(px: number) { info.viewportWidth = px; if (px < 1024) info.narrowExpanded = false; },
    toggleSidebar() { info.sidebar = info.sidebar ? 0 : 280; },
    setSidebar(px: number) { info.sidebar = px; },
    openRightbar(track: boolean, fullscreen: boolean) {
      info.rightbar ??= Math.round(info.viewportWidth * .45);
      info.rightbarShown = true; info.rightbarTrack = track; info.rightbarFullscreen = fullscreen;
    },
  };
  const instance = { actions, store: { update() {} }, getSnapshot: () => ({ layoutInfo: info }) };
  const ctx: any = {
    slots: { entriesOfSlot: () => [{ component: { name: 'AppFrame' }, store: { create: () => instance } }] },
    layout: { panels: actions },
  };
  return { ctx, info, actions, storage, values };
}

test('native rightbar defaults leave conversation space and follow viewport and sidebar changes', () => {
  const f = fixture();
  const stop = installAdaptiveRightbar(f.ctx, f.storage);
  assert.equal(f.info.rightbar, null, 'install must not open or size an unused panel');
  f.actions.openRightbar(true, false);
  assert.equal(f.info.rightbar, 300);
  f.actions.setViewportWidth(1440);
  assert.equal(f.info.rightbar, 348);
  f.actions.toggleSidebar();
  assert.equal(f.info.rightbar, 360);
  f.actions.setViewportWidth(960);
  assert.equal(f.info.rightbar, 300);
  f.actions.setViewportWidth(2560);
  assert.equal(f.info.rightbar, 360);
  stop();
});

test('a native user resize remains authoritative across tool opens, viewport changes and reloads', () => {
  const f = fixture();
  const stop = installAdaptiveRightbar(f.ctx, f.storage);
  f.actions.openRightbar(true, false);
  f.actions.setRightbar(480);
  f.actions.openRightbar(true, false);
  f.actions.setViewportWidth(1600);
  assert.equal(f.info.rightbar, 480);
  assert.equal(f.values.get('dsh-noemaloom:rightbar-width:v1'), '480');
  stop();
  const restored = fixture('480');
  const stopRestored = installAdaptiveRightbar(restored.ctx, restored.storage);
  restored.actions.openRightbar(true, false);
  assert.equal(restored.info.rightbar, 480);
  stopRestored();
});

test('fullscreen presentation stays native and closing does not reopen the panel during resize', () => {
  const f = fixture();
  const stop = installAdaptiveRightbar(f.ctx, f.storage);
  f.actions.openRightbar(false, true);
  assert.equal(f.info.rightbarFullscreen, true);
  assert.equal(f.info.rightbarTrack, false);
  f.info.rightbarShown = false;
  f.actions.setViewportWidth(1440);
  assert.equal(f.info.rightbarShown, false);
  assert.equal(f.info.rightbarFullscreen, true);
  f.actions.openRightbar(true, false);
  assert.equal(f.info.rightbar, 348);
  assert.equal(f.info.rightbarFullscreen, false);
  stop();
});

test('unavailable native ownership or invalid saved widths cannot replace layout behavior', () => {
  const f = fixture('Infinity');
  f.ctx.layout.panels = {};
  const original = f.actions.openRightbar;
  installAdaptiveRightbar(f.ctx, f.storage)();
  assert.equal(f.actions.openRightbar, original);
  f.ctx.layout.panels = f.actions;
  const stop = installAdaptiveRightbar(f.ctx, f.storage);
  f.actions.openRightbar(true, false);
  assert.equal(f.info.rightbar, 300);
  stop();
  assert.equal(f.actions.openRightbar, original);
});

test('blocked persistence leaves resizing functional and cleanup preserves a later owner', () => {
  const f = fixture();
  const stop = installAdaptiveRightbar(f.ctx, {
    getItem() { throw new Error('unavailable'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('unavailable'); },
  });
  f.actions.setRightbar(420);
  f.actions.openRightbar(true, false);
  assert.equal(f.info.rightbar, 420);
  const later = () => {};
  f.actions.setRightbar = later;
  stop();
  assert.equal(f.actions.setRightbar, later);
});
