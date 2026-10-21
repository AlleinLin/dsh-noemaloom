import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { build } from 'esbuild';
import ts from 'typescript';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';

const contexts = new Map<React.Context<any>, any>();
const effects: (() => unknown)[] = [];
const sharedReact = {
  ...React,
  useCallback: (callback: unknown) => callback,
  useContext: (context: React.Context<any>) => contexts.get(context) ?? false,
  useEffect: (effect: () => unknown) => { effects.push(effect); },
  useLayoutEffect() {},
};
const bundled = await build({
  stdin: {
    contents: `export * from './subagent-conversation-views.tsx'; export * from './native-dock-views.tsx';`,
    resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'ts',
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22',
  packages: 'external', logLevel: 'silent',
});
const fixtureModule: { exports: any } = { exports: {} };
const require = createRequire(import.meta.url);
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(
  (name: string) => name === 'react' ? sharedReact : require(name), fixtureModule, fixtureModule.exports,
);
const { createNativeDockViewProvider, NativeSubagentViewScope, installNativeSubagentConversationViews } = fixtureModule.exports;

// Read the shipped native entry points, so the fixture exercises the actual
// fixed-chat local view contract instead of a parallel implementation of it.
async function nativeFunction(packageName: string, name: string) {
  const source = await readFile(new URL(`../node_modules/${packageName}/lib/client.js`, import.meta.url), 'utf8');
  const ast = ts.createSourceFile('native.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, name);
  return found;
}
const nativePanelSource = await nativeFunction('@deepseek-ai/dsh-client-ui-subagent', 'ConversationSlotPanel');
const nativeViewsSource = await nativeFunction('@deepseek-ai/dsh-client-ui-conversation', 'DefaultConversationViews');
const NativePanel = new Function('FixedChatConversationView', `return (${nativePanelSource})`)(() => null);
const NativeViews = new Function('react', 'react_jsx_runtime', 'resolveActiveView', 'conversationPhase',
  'ConversationRoot_module_css_default', `return (${nativeViewsSource})`)(
  sharedReact, require('react/jsx-runtime'),
  (tabs: any[], selected: string | null) => tabs.find(tab => tab.id === selected) ?? tabs.find(tab => tab.id === 'chat'),
  () => 'active', { viewArea: 'native-view-area' },
);

function slotsFixture() {
  const core = new SlotCore() as any;
  core.register({ name: 'root', children: { 'sidebar.chat.conversation': { kind: 'single', scope: 'session' } } }, () => null);
  core.registerFactory({ name: 'conversation.content', scope: 'session', children: {
    'conversation.session': { kind: 'single', scope: 'session' },
  } }, () => null);
  core.inject = (_name: string, callback: () => unknown) => callback();
  return core;
}
function visit(node: any, callback: (element: React.ReactElement<any>) => void): void {
  if (Array.isArray(node)) return node.forEach(child => visit(child, callback));
  if (!React.isValidElement<any>(node)) return;
  callback(node);
  visit(node.props.children, callback);
}

test('real native subagent occurrence switches only its selected child session and keeps embedded composer ownership', () => {
  const slots = slotsFixture();
  slots.register({ name: 'sidebar.chat.conversation' }, NativePanel);
  const store = { spec: { persist: 'dsh.conversation' } };
  const inject = () => ({});
  slots.register({ name: 'conversation.session', store, inject, children: {
    'conversation.view': { kind: 'list', scope: 'session' },
  } }, NativeViews);
  const activations: any[] = [];
  const retainCalls: any[] = [];
  const provider = createNativeDockViewProvider({ slots,
    sessions: { retain: (...args: any[]) => { retainCalls.push(args); throw new Error('must use the existing child reference'); } },
    uiConversation: { binding: (id: string) => ({ activate: (view: string) => activations.push([id, view]) }) },
  });
  const adaptedOwner = slots.entriesOfSlot('conversation.session')[0];
  assert.equal(adaptedOwner.store, store);
  assert.equal(adaptedOwner.inject, inject);
  const childBinding = { key: 'child-A', parentSessionId: 'parent-A' };
  const calls: any[] = [];
  let occurrence: any;
  const panelProps = {
    sessionId: 'child-A', binding: childBinding,
    useSession: (selector: any) => selector({ blank: false, awaitingFirstTurn: false, openState: 'open' }),
    useConversation: (selector: any) => selector({ activeTargets: new Set(['child-A']) }),
    useSessions: (selector: any) => selector({ byId: { 'child-A': { blank: false } } }),
    renderFactorySlot: (key: string, owner: any, options: any) => {
      occurrence = { key, owner, options }; return null;
    },
  };
  const panel = slots.entriesOfSlot('sidebar.chat.conversation')[0].component(panelProps);
  panel.type(panel.props);
  assert.equal(occurrence.key, 'conversation.content');
  assert.deepEqual(occurrence.owner, { variant: 'embedded', phase: 'active', hero: false });
  const local = occurrence.options.slots.views({ renderSlot: (key: string, owner: any) => {
    calls.push([key, owner]); return null;
  } });
  assert.equal(local.type, NativeSubagentViewScope.Provider);
  assert.deepEqual(calls, [['conversation.session', {}]], 'Do not keep native fixed-chat override');
  assert.equal(panel.props.binding, childBinding);

  const state = { view: null as string | null };
  const views = [
    { id: 'chat', label: '对话' }, { id: 'trajectory', label: '轨迹' },
    { id: 'context', label: '上下文' }, { id: 'graph', label: '图谱' },
  ];
  const openCalls: any[] = [];
  const rendered: any[] = [];
  const owner: any = {
    sessionId: 'child-A', binding: childBinding,
    useConversationViews: (selector: any) => selector(views),
    useStore: (selector: any) => selector(state),
    useSession: panelProps.useSession, useConversation: panelProps.useConversation,
    useInspectCall: (selector: any) => selector(() => {}),
    inputActions: {}, actions: { completeViewRequest() {} }, bindDraftPersistence() {},
    openView: (id: string) => { state.view = id; openCalls.push(['child-A', childBinding, id]); },
    renderSlot: (key: string, props: any, options: any) => {
      rendered.push({ sessionId: owner.sessionId, binding: owner.binding, key, props, options }); return null;
    },
  };
  // A regular main occurrence remains the unmodified native component.
  contexts.set(NativeSubagentViewScope, false);
  const main = adaptedOwner.component({ ...owner, sessionId: 'parent-A' });
  assert.equal(main.type, NativeViews);
  assert.equal(main.props.view, undefined);

  contexts.set(NativeSubagentViewScope, true);
  const renderChild = () => {
    effects.length = 0;
    const wrapped = adaptedOwner.component(owner);
    const tree = wrapped.type(wrapped.props);
    effects.forEach(effect => effect());
    const buttons: any[] = [];
    visit(tree, element => { if (element.type === 'button') buttons.push(element); });
    const native = tree.props.children[1];
    assert.equal(native.type, NativeViews);
    assert.equal(native.props.binding, childBinding);
    native.type(native.props);
    return buttons;
  };
  try {
    let buttons = renderChild();
    assert.deepEqual(buttons.map(button => button.props.children), ['对话', '轨迹', '上下文']);
    assert.equal(rendered.at(-1).options.only, 'chat');
    buttons.find(button => button.props['data-nexus-subagent-view'] === 'trajectory').props.onClick();
    buttons = renderChild();
    assert.equal(rendered.at(-1).options.only, 'trajectory');
    assert.equal(buttons[1].props['aria-selected'], true);
    buttons[2].props.onClick();
    renderChild();
    assert.equal(rendered.at(-1).options.only, 'context');
    assert.ok(rendered.every(call => call.sessionId === 'child-A' && call.binding === childBinding));
    assert.deepEqual(openCalls.map(call => [call[0], call[2]]), [['child-A', 'trajectory'], ['child-A', 'context']]);
    assert.deepEqual(activations, [['child-A', 'chat'], ['child-A', 'trajectory'], ['child-A', 'context']]);
    assert.deepEqual(retainCalls, []);
  } finally {
    contexts.clear(); effects.length = 0; provider.dispose();
  }
  assert.equal(slots.entriesOfSlot('sidebar.chat.conversation')[0].component, NativePanel);
  assert.equal(slots.entriesOfSlot('conversation.session')[0].component, NativeViews);
});

test('subagent adaptation waits for the native component registration after its slot declaration', async () => {
  const slots = slotsFixture();
  const dispose = installNativeSubagentConversationViews({ slots });
  slots.register({ name: 'sidebar.chat.conversation' }, NativePanel);
  await Promise.resolve();
  assert.notEqual(slots.entriesOfSlot('sidebar.chat.conversation')[0].component, NativePanel);
  dispose();
  assert.equal(slots.entriesOfSlot('sidebar.chat.conversation')[0].component, NativePanel);
});
