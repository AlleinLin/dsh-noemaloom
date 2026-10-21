import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as React from 'react';
import ts from 'typescript';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import { adaptReaderClient, installNativeReader } from '../scripts/adapt-reader-client.mjs';

// This contract projects static slot components, not DOM lifecycles. Keep the
// shared React element vocabulary without loading the old React 18 SSR renderer.
const sharedReact = {
  ...React,
  memo: component => component,
  useRef: value => ({ current: value }),
  useMemo: create => create(),
  useCallback: callback => callback,
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
};
function projectSlotTree(element) {
  if (Array.isArray(element)) return element.map(projectSlotTree);
  if (!React.isValidElement(element)) return element;
  if (typeof element.type === 'function') return projectSlotTree(element.type(element.props));
  return React.cloneElement(element, undefined, projectSlotTree(element.props.children));
}
function slotText(element) {
  if (Array.isArray(element)) return element.map(slotText).join('');
  if (React.isValidElement(element)) return slotText(element.props.children);
  return typeof element === 'string' || typeof element === 'number' ? String(element) : '';
}

async function publishedFactory() {
  const source = await readFile(new URL('../node_modules/dsh-better-display/lib/client.js', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('reader.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let factory;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'window.__ModuleLoader__.load') {
      factory = node.arguments[0].properties.find(node => node.name?.getText(ast) === 'factory')?.initializer.getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(factory);
  return factory;
}

test('Reader registration moves into native assistant presentation and migrates only an old reader selection', async () => {
  const adapted = adaptReaderClient(await publishedFactory());
  const ast = ts.createSourceFile('adapted.js', `const factory = ${adapted};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.deepEqual(ast.parseDiagnostics, []);
  const body = ast.statements[0].declarationList.declarations[0].initializer.body;
  const apply = body.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'apply').getText(ast);
  const migration = body.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'installReaderEntry').getText(ast);
  assert.ok(apply.includes('installNativeReader(ctx, prefs, readerInject)'));
  assert.equal(apply.includes('id: "reader"'), false);
  assert.equal(apply.includes('installOfficialSlots(ctx)'), false);
  assert.ok(migration.includes('view === "reader" ? "chat" : null'));
  assert.equal(migration.includes('ReaderEntryPolicy'), false);
  // The original session APIs, composer transaction and file actions survive.
  for (const capability of ['readAttachment', 'fillComposer', 'forkAt', 'officialPreviewFile', 'openDeliverableFile']) {
    assert.ok(apply.includes(capability), capability);
  }
  const settings = body.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'SettingsSection').getText(ast);
  assert.equal(settings.includes('"data-better-display-auto-fold"'), false);
  assert.ok(settings.includes('"data-better-display-motion"'));
  assert.equal(adapted.includes('var ReaderEntryPolicy'), false);
  assert.throws(() => adaptReaderClient(adapted), /Reader session capability injection changed/);
});

test('Native assistant replacement preserves injected hooks, isolated child ownership, election and cleanup', () => {
  const slots = new SlotCore();
  const stopOwner = slots.register({ name: 'root', children: {
    'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
  } }, () => null);
  slots.inject = (_name, callback) => callback();
  const nativeComponent = () => null;
  const nativePresentation = {};
  const stopNative = slots.register({
    name: 'conversation.chat.node', key: 'assistant-step', locale: 'chat',
    inject: () => ({ hooks: { presentation: nativePresentation } }),
    children: {
      'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' },
      'conversation.chat.message.images': { kind: 'single', scope: 'session' },
    },
  }, nativeComponent);
  const mirrored = [];
  let released = 0;
  const install = vm.runInNewContext(`(${installNativeReader.toString()})`, {
    Date, Map, Object, Error,
    react: { memo: component => component },
    translatedComponent: entry => entry.component,
    mirrorOfficialSlot: (_slots, source, target) => {
      mirrored.push([source, target]);
      return () => { released++; };
    },
  });
  const readerServices = { fillComposer() {} };
  const stop = install({ slots }, {}, () => readerServices);
  const elected = slots.entriesOfSlot('conversation.chat.node')[0];
  assert.notEqual(elected.component, nativeComponent);
  assert.equal(elected.locale, 'chat');
  const injected = elected.inject('session');
  assert.equal(injected.hooks.presentation, nativePresentation);
  assert.equal(injected.readerServices, readerServices);
  assert.equal(slots.spec('dsh-better-display.block').kind, 'chain');
  assert.equal(mirrored.length, 2);
  assert.ok(mirrored.every(([source, target]) => source !== target));
  assert.ok(slots.spec('conversation.chat.reasoning.body'));
  assert.equal(slots.entriesOfSlot('conversation.chat.turnTail')[0].options.id, 'nexus-reader-produced-files');
  stop();
  assert.equal(released, 2);
  assert.equal(slots.entriesOfSlot('conversation.chat.node')[0].component, nativeComponent);
  assert.equal(slots.spec('dsh-better-display.block'), undefined);
  assert.equal(slots.entriesOfSlot('conversation.chat.turnTail').length, 0);
  stopNative();
  stopOwner();
});

test('Reader body respects native split groups, closing mentions, original image loader and one interruption marker', () => {
  const entries = [];
  const nativeCalls = [];
  const readerCalls = [];
  const producedCalls = [];
  const imageLoader = () => {};
  const receiptLoader = () => {};
  const turn = { status: 'closed' };
  const finalNode = { seq: 20 };
  const Native = props => {
    nativeCalls.push(props);
    return React.createElement('span', {
      'data-native': props.node.data.blocks.map(block => block.kind).join(',') || 'stopped',
    });
  };
  const nativeEntry = {
    component: Native, options: { key: 'assistant-step' },
    children: {
      'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' },
      'conversation.chat.message.images': { kind: 'single', scope: 'session' },
    },
  };
  const slots = {
    entriesOfSlot: () => [nativeEntry],
    register(options, component) { entries.push({ options, component }); return () => {}; },
    inject(_name, callback) { return callback(); },
  };
  const install = vm.runInNewContext(`(${installNativeReader.toString()})`, {
    Date, Map, Object, Error, react: sharedReact,
    translatedComponent: entry => entry.component,
    mirrorOfficialSlot: () => () => {},
    usePinnedSelection: () => [],
    useMotionAllowed: () => false,
    frostedGlassOf: () => false,
    Reader_module_css_default: { answer: 'answer' },
    StreamMotionContext: React.createContext({}),
    Blocks: props => { readerCalls.push(props); return React.createElement('p', null, props.blocks.map(block => block.text).join('')); },
    showDeliverablesRow: (status, paths) => status === 'closed' && paths.length > 0,
    deliverableOpenModeOf: value => value === 'sidebar' ? 'sidebar' : 'external',
    DeliverablesRow: props => { producedCalls.push(props); return React.createElement('span', null, props.deliverables.join(',')); },
  });
  const preference = { motion: false };
  const prefs = { subscribe: () => () => {}, getSnapshot: () => preference };
  const readerServices = { loadImage: receiptLoader, fillComposer() {}, openFile() {} };
  install({ slots }, prefs, () => readerServices);
  const enhanced = entries.find(entry => entry.options.key === 'assistant-step');
  const node = {
    key: 'step-1', kind: 'assistant-step', location: { kind: 'turn', turn },
    data: {
      status: 'interrupted', step: 1, finalNode,
      blocks: [
        { kind: 'reasoning', text: 'thoughts' },
        { kind: 'text', text: 'answer' },
        { kind: 'image', attachment: { attachmentId: 'image-1' } },
        { kind: 'tool-call', callId: 'call-1' },
        { kind: 'other', block: { type: 'mcp-app', html: '<p>app</p>' } },
      ],
    },
  };
  const mentions = {};
  const useDisclosure = () => ({ expanded: false });
  const useGroupAction = () => ({ current: null });
  const turnProcess = { open: false };
  const tree = projectSlotTree(React.createElement(enhanced.component, {
    ...enhanced.options.inject('session'),
    node, groupPart: 'response', loadImage: imageLoader, useDisclosure, useGroupAction, turnProcess,
    useTurnData: () => ({ closing: { finalNode } }),
    fileMentions(owner) {
      assert.equal(owner.turn, turn);
      assert.equal(owner.seq, 20);
      assert.equal(owner.openFile, readerServices.openFile);
      return mentions;
    },
    renderSlotChain() {},
  }));
  assert.equal(tree.props.children.props['data-nexus-chat-display'], true);
  assert.ok(slotText(tree).includes('answer'));
  assert.equal(slotText(tree).includes('thoughts'), false);
  assert.deepEqual(readerCalls.flatMap(call => Array.from(call.blocks, block => block.kind)), ['text', 'other']);
  assert.ok(readerCalls.every(call => call.fileMentions === mentions));
  assert.equal(nativeCalls.length, 2, 'Native image rendering and exactly one stop marker');
  assert.deepEqual(Array.from(nativeCalls[0].node.data.blocks, block => block.kind), ['image']);
  for (const call of nativeCalls) {
    assert.equal(call.loadImage, imageLoader);
    assert.equal(call.useDisclosure, useDisclosure);
    assert.equal(call.useGroupAction, useGroupAction);
    assert.equal(call.turnProcess, turnProcess);
  }
  assert.equal(nativeCalls[1].node.data.status, 'interrupted');
  assert.equal(nativeCalls[1].node.data.blocks.length, 0);
  assert.equal(node.data.blocks.length, 5, 'The projection and incoming owner remain untouched');
  const produced = entries.find(entry => entry.options.id === 'nexus-reader-produced-files');
  const fileTurn = { status: 'closed', data: { get: () => ({ produced: [
    { seq: 10, path: 'first.ts' }, { seq: 12, path: 'first.ts' },
    { seq: 21, path: 'later.ts' }, { seq: 18, path: 'second.ts' },
  ] }) } };
  const files = projectSlotTree(React.createElement(produced.component, {
    ...produced.options.inject('session'), turn: fileTurn, seq: 20,
  }));
  assert.equal(slotText(files), 'first.ts,second.ts');
  assert.deepEqual(Array.from(producedCalls[0].deliverables), ['first.ts', 'second.ts']);
  assert.equal(producedCalls[0].openFile, readerServices.openFile);
});
