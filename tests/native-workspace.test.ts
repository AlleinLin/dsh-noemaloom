import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationViewId, nativePanels, navigateNative, openNativeSession, panelKey, registerNativePanels } from '../src/client/native-workspace.js';

test('native entries share main keys, retain the host sidebar/tree/chat and retract only their own seats', () => {
  const host = [{ name: 'sidebar' }, { name: 'sidebar.workspaces' }, { name: 'main', key: 'conversation' }];
  const entries: any[] = [...host];
  const ctx: any = { slots: {
    inject(_name: string, callback: () => unknown) { return callback(); },
    register(options: any, component: any) {
      const entry = { ...options, component }; entries.push(entry);
      return () => entries.splice(entries.indexOf(entry), 1);
    },
  } };
  const stop = registerNativePanels(ctx, {
    panel: page => `panel:${page}`, icon: icon => `icon:${icon}`,
    settings: 'settings', theme: 'theme', conversation: page => `conversation:${page}`, brand: 'brand',
  });
  assert.equal(entries.filter(entry => entry.name === 'sidebar').length, 1);
  assert.equal(entries.filter(entry => entry.name === 'sidebar.workspaces').length, 1);
  assert.equal(entries.filter(entry => entry.key === 'conversation').length, 1);
  assert.equal(entries.some(entry => entry.key === 'nexus'), false);
  assert.equal(nativePanels.some(entry => ['sessions', 'home'].includes(entry.id)), false);
  for (const entry of nativePanels) {
    assert.ok(entries.some(seat => seat.name === 'main' && seat.key === panelKey(entry.id)));
    assert.ok(entries.some(seat => seat.name === 'sidebar.panellist' && seat.id === panelKey(entry.id)));
  }
  const views = entries.filter(entry => entry.name === 'conversation.view');
  assert.deepEqual(views.map(entry => [entry.id, entry.label()]), [
    ['nexus.orchestration', '执行计划'], ['nexus.cache', '压缩与恢复'], ['nexus.quality', '质量检查'],
    ['nexus.review', '代码审查'], ['nexus.recovery', '恢复点'], ['nexus.resources', '会话产物'], ['nexus.search', '会话搜索'],
  ]);
  for (const view of views) {
    assert.deepEqual(view.inject('native-session'), { sessionId: 'native-session' });
    assert.equal(view.component, `conversation:${view.id.slice('nexus.'.length)}`);
  }
  assert.equal(entries.some(entry => entry.id === 'nexus.tools'), false);
  assert.equal(entries.some(entry => entry.name === 'conversation.session.header.actions'), false);
  assert.equal(entries.filter(entry => entry.name === 'sidebar.panellist').length, 2);
  assert.ok(entries.some(entry => entry.name === 'settings.section'));
  stop();
  assert.deepEqual(entries, host);
});

test('generated brand shadows official marks without replacing host registrations or the wordmark', () => {
  const entries: any[] = [
    { name: 'sidebar.brand.mark', priority: 0, component: 'official-whale' },
    { name: 'sidebar.brand.name', priority: 0, component: 'official-wordmark' },
  ];
  const ctx: any = { slots: {
    inject(_name: string, callback: () => unknown) { return callback(); },
    register(options: any, component: any) {
      // Match the host's single-slot collision and lowest-priority election.
      if (options.name.endsWith('.brand.mark')) {
        assert.equal(entries.some(entry => entry.name === options.name
          && (entry.priority ?? 0) === (options.priority ?? 0)), false);
      }
      const entry = { ...options, component };
      entries.push(entry);
      return () => entries.splice(entries.indexOf(entry), 1);
    },
  } };
  const elected = (name: string) => entries.filter(entry => entry.name === name)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))[0]?.component;
  const stop = registerNativePanels(ctx, {
    panel: level => level, icon: name => name, settings: 'settings',
    theme: 'theme', conversation: page => `conversation:${page}`, brand: 'generated-brand',
  });
  assert.equal(elected('sidebar.brand.mark'), 'generated-brand');
  assert.equal(elected('conversation.hero.brand.mark'), 'generated-brand');
  assert.equal(elected('sidebar.brand.name'), 'official-wordmark');
  stop();
  assert.equal(elected('sidebar.brand.mark'), 'official-whale');
  assert.equal(elected('conversation.hero.brand.mark'), undefined); // Host hero fallback resumes.
  assert.equal(elected('sidebar.brand.name'), 'official-wordmark');
});

test('conversation tools navigate directly to independent native views and retain original context', () => {
  const calls: string[] = [], openView = (id: string) => calls.push(id);
  const ctx: any = {};
  for (const page of ['orchestration', 'cache', 'quality', 'review', 'recovery', 'resources', 'search'] as const) {
    navigateNative(ctx, page, openView);
    assert.equal(calls.at(-1), conversationViewId(page));
  }
  navigateNative(ctx, 'context', openView);
  assert.equal(calls.at(-1), 'context');
  assert.equal(calls.includes('nexus.tools'), false);
});

test('chat, new session and model controls stay with native workspace navigation', () => {
  const calls: any[] = [];
  let selection: any = { sessionId: 'original-session' };
  const listeners = new Set<() => void>();
  const ctx: any = {
    layout: { selectPanel: (id: unknown) => calls.push(['panel', id]) },
    uiWorkspace: {
      openSession(id: string) { selection = { sessionId: id }; for (const listener of listeners) listener(); calls.push(['open', id]); },
      startSession() { calls.push(['new']); },
      selection: { getSnapshot: () => selection, subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); } },
    },
  };
  navigateNative(ctx, 'sessions');
  navigateNative(ctx, 'home');
  navigateNative(ctx, 'memory');
  navigateNative(ctx, 'settings');
  let observed = selection.sessionId;
  const stop = ctx.uiWorkspace.selection.subscribe(() => { observed = ctx.uiWorkspace.selection.getSnapshot().sessionId; });
  openNativeSession(ctx, 'another-native-session');
  assert.equal(observed, 'another-native-session');
  assert.deepEqual(calls, [['panel', null], ['new'], ['panel', 'mnemon'], ['panel', 'settings'], ['open', 'another-native-session']]);
  stop();
  assert.equal(listeners.size, 0);
});
