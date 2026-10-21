import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptOriginalClientContext, originalSlotOptions } from '../src/client/original-surface-adapter.js';
import { navigateNative } from '../src/client/native-workspace.js';

test('original views retain component, injector, native services and disposable registration', () => {
  const entries: any[] = [];
  const nativeSlots = {
    inject(_name: string, callback: () => unknown) { return callback(); },
    register(options: any, component: unknown) {
      const entry = { options, component };
      entries.push(entry);
      return () => { entries.splice(entries.indexOf(entry), 1); };
    },
  };
  const fiber = {};
  const sessions = {};
  const ctx: any = {
    fiber, sessions, slots: nativeSlots,
    extend(meta: unknown) { return Object.assign(Object.create(this), meta); },
  };
  const adapted = adaptOriginalClientContext(ctx, 'dsh-context');
  assert.equal(adapted, adaptOriginalClientContext(ctx, 'dsh-context'));
  assert.equal(adapted.fiber, fiber);
  assert.equal(adapted.sessions, sessions);
  assert.equal(ctx.slots, nativeSlots, 'The parent service must not change');
  const inject = () => ({ original: true });
  const component = () => null;
  const stop = adapted.slots.inject('conversation.view', () => adapted.slots.register({
    name: 'conversation.view', id: 'context', order: 200, inject,
  }, component));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].options.inject, inject);
  assert.equal(entries[0].component, component);
  assert.equal(entries[0].options.order, 20);
  stop();
  assert.equal(entries.length, 0);
});

test('context duplicate pane is declined without removing other original native panes', () => {
  assert.equal(originalSlotOptions('dsh-context', {
    name: 'sidebar.right.pane.tab', key: 'dsh-context',
  }), undefined);
  const files = { name: 'sidebar.right.pane.tab', key: 'dsh-better-sidebar:editor' };
  assert.equal(originalSlotOptions('dsh-better-sidebar', files), files);
  const originalMain = { name: 'main', key: 'thoughtdag' };
  assert.equal(originalSlotOptions('dsh-thoughtdag', originalMain), originalMain);
  assert.equal(originalSlotOptions('dsh-better-display', { name: 'conversation.view', id: 'reader' }), undefined);
});

test('feature navigation uses the native owning entry instead of another copy of a feature', () => {
  const calls: unknown[][] = [];
  const ctx: any = {
    layout: { selectPanel: (id: string) => calls.push(['panel', id]) },
    get: (name: string) => name === 'sidebarRight' ? { openTab: (kind: string) => calls.push(['right', kind]) } : undefined,
  };
  const openView = (id: string) => calls.push(['view', id]);
  navigateNative(ctx, 'engineering', openView);
  navigateNative(ctx, 'tasks', openView);
  navigateNative(ctx, 'context', openView);
  navigateNative(ctx, 'graph', openView);
  assert.deepEqual(calls, [
    ['right', 'files'], ['panel', 'task-board'], ['view', 'context'], ['view', 'nexus.thoughtdag'],
  ]);
  assert.throws(() => navigateNative(ctx, 'context'), /请在会话中打开/);
});
