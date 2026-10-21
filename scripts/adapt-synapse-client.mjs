import { createHash } from 'node:crypto';
import ts from 'typescript';

// Reviewed published dsh-synapse@0.4.2 app.js. Refuse an upstream change rather
// than silently applying an incomplete shell adapter to a different client.
const REVIEWED_SHA256 = '3107ad9a74de80da03f7c3420f69e715a18afb8d19270ab8aa10e2698a8fc530';
const digest = source => createHash('sha256').update(source).digest('hex');
const parse = source => {
  const ast = ts.createSourceFile('synapse-original.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error('Synapse client adapter: invalid original/adapted JavaScript');
  return ast;
};
const one = (values, label) => {
  if (values.length !== 1) throw new Error(`Synapse client adapter: expected one ${label}, got ${values.length}`);
  return values[0];
};
function namedFunction(ast, name) {
  return one(ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name), `function ${name}`);
}
function replaceOnce(source, anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`Synapse client adapter: ${label} original anchor changed`);
  }
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

/** Adapt the published canvas in the build output; never mutate node_modules. */
export function adaptSynapseClient(original) {
  if (digest(original) !== REVIEWED_SHA256) throw new Error('Synapse client adapter requires the reviewed 0.4.2 client SHA256');
  const ast = parse(original);
  const edits = [];
  const replaceNode = (node, text) => edits.push({ start: node.getStart(ast), end: node.end, text });
  const replaceFunction = (name, text) => replaceNode(namedFunction(ast, name), text);
  const render = namedFunction(ast, 'render');
  const renderStatements = render.body.statements;
  const variable = name => one(renderStatements.filter(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name)
      && declaration.name.text === name)), `render variable ${name}`);
  const htmlAssignment = one(renderStatements.filter(statement => ts.isExpressionStatement(statement)
    && ts.isBinaryExpression(statement.expression)
    && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && statement.expression.left.getText(ast) === 'app.innerHTML'), 'render app.innerHTML assignment');
  if (!htmlAssignment.getText(ast).includes('<aside class="sidebar">')
    || !htmlAssignment.getText(ast).includes('${canvasTabs}${view}')) {
    throw new Error('Synapse client adapter: reviewed full-shell template changed');
  }

  // Only the original map surface remains. All original DOM listeners and
  // post-render drag/connector/camera/inspector reconciliation stay in place.
  replaceNode(variable('view'), 'const view = renderCanvas()');
  for (const name of ['choices', 'selectedWorkspaceId', 'detailAvailable', 'canvasTabs']) replaceNode(variable(name), '');
  replaceNode(htmlAssignment, `app.innerHTML = \`<main class="nexus-synapse-canvas"><header class="nexus-synapse-toolbar">\${canvasControls}</header><section class="main-stage nexus-synapse-stage">\${state.error ? \`<div class="status-message" role="alert"><span>\${escapeHtml(state.error)}</span><button data-action="dismiss-error" aria-label="关闭" title="关闭">×</button></div>\` : ''}\${view}\${selectionFollowupButton()}</section></main>\``);
  replaceFunction('renderThread', `function renderThread() {
  return renderCanvas()
}`);
  replaceFunction('draftCard', `function draftCard() {
  // DSH owns the only main composer. Native intents never mount a second one.
  return ''
}`);
  replaceFunction('openNewSession', `function openNewSession() {
  state.error = ''
  post('synapse:compose', { kind: 'new', workspaceId: state.selectedDshWorkspaceId })
}`);
  replaceFunction('openContinue', `function openContinue(parent, anchorId = undefined, text = '') {
  if (parent.dshSessionId === null) return setError('该节点没有关联的 DSH 会话')
  state.activeId = parent.id
  state.error = ''
  post('synapse:compose', { kind: 'continue', sessionId: parent.dshSessionId, text, anchorId })
}`);
  replaceFunction('openBranch', `function openBranch(parent, atSeq = undefined, anchorId = undefined) {
  if (parent.dshSessionId === null) return setError('该节点没有关联的 DSH 会话')
  state.activeId = parent.id
  state.error = ''
  post('synapse:compose', {
    kind: 'branch', sessionId: parent.dshSessionId, anchorId,
    ...(Number.isInteger(atSeq) ? { atSeq } : {}),
  })
}`);
  // New bindings are appended as declarations before the original listener;
  // they only reconcile original projection/anchor state after host success.
  const messageListeners = [];
  function findMessages(node) {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && node.expression.expression.getText(ast) === 'window.addEventListener'
      && ts.isStringLiteralLike(node.expression.arguments[0])
      && node.expression.arguments[0].text === 'message') messageListeners.push(node);
    ts.forEachChild(node, findMessages);
  }
  findMessages(ast);
  const messageListener = one(messageListeners, 'original message listener');
  replaceNode(messageListener, `async function nexusComposerOpened(data) {
  const session = data.session
  if (!session || typeof session.id !== 'string') return
  if (data.kind === 'branch' && typeof data.anchorId === 'string') {
    rememberBranchAnchor(session.id, data.anchorId)
  }
  // The host already created/forked and opened the real session. Its ordinary
  // projection provides the thread; this acknowledgement never sends a turn.
  await refreshProjection()
  const thread = state.workspace?.threads.find(item => item.dshSessionId === session.id)
  if (thread && data.kind === 'branch' && typeof data.anchorId === 'string') {
    rememberBranchAnchor(thread.id, data.anchorId)
  }
  if (canReplaceView()) render()
}

${messageListener.getText(ast)}`);

  edits.sort((left, right) => right.start - left.start);
  for (let index = 1; index < edits.length; index++) {
    if (edits[index].end > edits[index - 1].start) throw new Error('Synapse client adapter: overlapping original AST edits');
  }
  let adapted = original;
  for (const edit of edits) adapted = adapted.slice(0, edit.start) + edit.text + adapted.slice(edit.end);
  adapted = replaceOnce(adapted,
    `if (threads.length === 0 && state.draft?.kind !== 'new') return \`<section class="empty-canvas"><strong>当前工作目录还没有 DSH 对话。</strong><p>点击新会话，在画布中输入第一条消息。</p><div><button class="primary" type="button" data-action="create-session">新建会话</button></div></section>\``,
    `if (threads.length === 0) return \`<section class="empty-canvas"><strong>暂无会话记录</strong><div><button class="primary" type="button" data-action="create-session">新建会话</button></div></section>\``,
    'original canvas empty state');
  adapted = replaceOnce(adapted,
    "if (button.dataset.action === 'show-thread' && thread !== undefined) { state.activeId = thread.id; state.mode = 'thread'; state.detailTargetCardId = button.dataset.card ?? null; render(); void loadThreadHistory(thread) }",
    `if (button.dataset.action === 'show-thread' && thread?.dshSessionId) {
      const card = state.canvasCardsById?.get(button.dataset.card)
      const seq = card?.answer?.sourceSeq ?? latestMessage(thread, 'assistant')?.sourceSeq
      post('synapse:open-session', { sessionId: thread.dshSessionId, ...(Number.isInteger(seq) ? { seq } : {}) })
    }`,
    'original detail-page entry becomes native session navigation');
  adapted = replaceOnce(adapted,
    "card.parentId = state.branchAnchors.get(card.dshThreadId) ?? inheritedTurn?.id ?? null",
    "card.parentId = state.branchAnchors.get(card.dshThreadId) ?? state.branchAnchors.get(sourceThread?.dshSessionId) ?? inheritedTurn?.id ?? null",
    'original branch anchor resolves before its projected thread arrives');
  adapted = replaceOnce(adapted,
    "  if (data.type === 'synapse:map-opened') {",
    "  if (data.type === 'synapse:composer-opened') { void nexusComposerOpened(data).catch(setError); return }\n  if (data.type === 'synapse:map-opened') {",
    'native composer acknowledgement');
  // Retain the original attribution/helper bodies where useful, but prevent
  // an accidental legacy submit event from invoking the old model send path.
  adapted = replaceOnce(adapted,
    "app.addEventListener('submit', event => {",
    "app.addEventListener('submit', event => {\n  event.preventDefault()\n  return\n  // Legacy source below is retained for attribution; the native composer owns submission.",
    'disable legacy embedded submission');
  assertSynapseCanvasAdapter(original, adapted);
  return {
    source: adapted,
    changes: [
      'AST-replace the complete Synapse shell with its original canvas, controls, inspector, and status surface.',
      'Remove the duplicate session/workspace sidebar, view switch, detail tab, detail chat, and graph draft composer.',
      'Route new/continue/branch intents to the native DSH composer without prompting or changing original graph mechanics.',
      'Route original detail links to native session navigation with the original card sequence anchor.',
      'Reconcile native composer-opened acknowledgements through original projection and durable branch-anchor state.',
      'Disable unreachable legacy embedded form submission while retaining original source attribution.',
      'Use a short empty state and native new-session action.',
    ],
    sourceSha256: digest(original),
    adaptedSha256: digest(adapted),
  };
}

/** Build-time invariants over the actual output, without executing app code. */
function assertSynapseCanvasAdapter(original, adapted) {
  const originalAst = parse(original), adaptedAst = parse(adapted);
  const get = (ast, name) => namedFunction(ast, name).getText(ast);
  for (const name of [
    'conversationCard', 'conversationGraphView', 'layoutConversationGraph', 'canvasConnectors',
    'renderCardInspector', 'syncCanvasViewport', 'installDragging', 'bindDragHandle',
    'refreshCardConnectors', 'zoomCanvasAtCenter', 'focusActiveCard', 'persistCollapsedCards',
  ]) {
    if (get(originalAst, name) !== get(adaptedAst, name)) {
      throw new Error(`Synapse client adapter changed original graph behavior: ${name}`);
    }
  }
  const rendered = ['render', 'renderCanvas', 'renderThread', 'draftCard', 'renderCardInspector']
    .map(name => get(adaptedAst, name)).join('\n');
  for (const forbidden of [
    '<aside class="sidebar">', 'class="view-switch"', 'class="canvas-tabs"', 'class="message-composer"',
    '<textarea', 'class="synapse-shell', 'first-session-card',
  ]) if (rendered.includes(forbidden)) throw new Error(`Synapse canvas output still contains duplicate shell/composer: ${forbidden}`);
  if (/\b(?:state\.mode\s*=\s*['"]thread['"]|renderThread\(\)\s*:\s*renderCanvas)/.test(adapted)) {
    throw new Error('Synapse client adapter retained a duplicate detail-page entry');
  }
  for (const name of ['openNewSession', 'openContinue', 'openBranch', 'nexusComposerOpened']) {
    const body = get(adaptedAst, name);
    if (/\b(?:prompt|sendMessage|submitDraft|dshRpc)\s*\(/.test(body)) {
      throw new Error(`Synapse client adapter attempted to send a model turn from ${name}`);
    }
  }
}
