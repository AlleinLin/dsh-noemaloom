import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { adaptSynapseClient } from './adapt-synapse-client.mjs';
import { adaptThoughtdagClient, reviewedThoughtdagHtml, THOUGHTDAG_CLIENT_ASSET, THOUGHTDAG_SOURCE_ASSET } from './adapt-thoughtdag-client.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(project, 'package.json'));
const sha256 = source => createHash('sha256').update(source).digest('hex');

function replaceOnce(source, anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`${label}: original anchor changed; refusing an unreviewed adaptation`);
  }
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

function replaceFunction(source, name, replacement) {
  const ast = ts.createSourceFile('original-canvas.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (functions.length !== 1) throw new Error(`Canvas function ${name}: expected exactly one original declaration`);
  const original = functions[0];
  return source.slice(0, original.getStart(ast)) + replacement + source.slice(original.end);
}

function replaceProviderReferences(source) {
  const ast = ts.createSourceFile('thoughtdag.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  function visit(node) {
    if (ts.isIdentifier(node) && node.text === 'registeredProviders') edits.push([node.getStart(ast), node.end]);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (edits.length !== 4) throw new Error('ThoughtDAG providers: original four request references changed');
  for (const [start, end] of edits.reverse()) source = source.slice(0, start) + 'nexusState.providers' + source.slice(end);
  return source;
}

async function report(directory, manifest, original, adapted, changes, additional = {}) {
  await writeFile(join(directory, 'adapter.json'), JSON.stringify({
    package: manifest.name, version: manifest.version,
    sourceSha256: sha256(original), adaptedSha256: sha256(adapted), changes, ...additional,
  }, null, 2) + '\n');
}

async function buildSynapse() {
  const root = dirname(require.resolve('dsh-synapse'));
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.version !== '0.4.2') throw new Error('Synapse adapter requires reviewed version 0.4.2');
  const original = await readFile(join(root, 'index.js'), 'utf8');
  const adapted = replaceOnce(original, 'const store = new WorkspaceStore(config?.dataFile)',
    'const store = config.nexusStore', 'Synapse original request-scoped store');
  const output = join(project, 'lib/canvas-original/synapse');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'index.js'), adapted);
  const client = adaptSynapseClient(await readFile(join(root, 'app.js'), 'utf8'));
  await writeFile(join(output, 'app.js'), client.source);
  await copyFile(join(root, 'styles.css'), join(output, 'styles.css'));
  await copyFile(join(project, 'assets/icon.svg'), join(output, 'deepseek-mark.svg'));
  await report(output, manifest, original, adapted, [
    'Replace one store constructor with a request-scoped original WorkspaceStore proxy.',
    'Use the shared Nexus icon for the original application mark.',
    ...client.changes,
  ], { client: { sourceSha256: client.sourceSha256, adaptedSha256: client.adaptedSha256 } });
}

async function buildThoughtdag() {
  const entry = require.resolve('dsh-thoughtdag');
  const root = dirname(dirname(entry));
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.version !== '0.5.20') throw new Error('ThoughtDAG adapter requires reviewed version 0.5.20');
  const original = await readFile(entry, 'utf8');
  let adapted = replaceOnce(original,
    "const __dirname = fileURLToPath(new URL('.', import.meta.url))",
    "const __dirname = fileURLToPath(new URL('.', import.meta.resolve('dsh-thoughtdag')))",
    'ThoughtDAG original asset/runtime location');
  adapted = replaceOnce(adapted, "why = await import('./why.mjs')",
    "why = await import(new URL('./why.mjs', import.meta.resolve('dsh-thoughtdag')).href)",
    'ThoughtDAG original why library');
  adapted = replaceOnce(adapted, 'let registeredProviders = []', 'const nexusState = config.nexusState',
    'ThoughtDAG scoped provider state');
  adapted = replaceProviderReferences(adapted);
  adapted = replaceFunction(adapted, 'eventsOfSession', `async function eventsOfSession(ctx, id) {
  return ctx.nexusCanvas.eventsOfSession(id)
}`);
  adapted = replaceOnce(adapted, 'async function agentOf(ctx, id) {',
    'async function agentOf(ctx, id) {\n  ctx.nexusCanvas.assertSession(id)',
    'ThoughtDAG native agent membership');
  adapted = replaceOnce(adapted,
    'async function runAgentTurn(ctx, body, emit, isClosed, { answerApprovals = true } = {}) {',
    'async function runAgentTurn(ctx, body, emit, isClosed, { answerApprovals = true } = {}) {\n  ctx.nexusCanvas.assertHarness(body?.harness)',
    'ThoughtDAG turn membership');
  adapted = replaceOnce(adapted, 'const canvasTurns = new Map()', 'const canvasTurns = new Set()',
    'ThoughtDAG independent canvas requests');
  adapted = replaceFunction(adapted, 'installApprovalAnswerer', `function installApprovalAnswerer(ctx) {
  ctx.on('approval/request', async function (req, next) {
    const entry = [...canvasTurns].find(item => item.answerApprovals
      && item.sessionId === req?.agent?.id && item.turn !== null && item.current() === item.turn)
    if (!entry) return next()
    const id = 'td-' + randomUUID()
    const call = req.callId !== undefined ? entry.calls.get(req.callId) : undefined
    const name = call?.name ?? req.toolName
    entry.emit({ approval: {
      id, toolName: req.toolName, callId: req.callId ?? null, reason: req.reason ?? null,
      name, query: call ? toolQuery(name, call.arguments) : '',
      arguments: typeof call?.arguments === 'string' ? call.arguments : (call?.arguments ? JSON.stringify(call.arguments) : null),
    } })
    let timer, onAbort
    const decision = new Promise(resolve => {
      pendingApprovals.set(id, { resolve, sessionId: req.agent.id, scopeKey: entry.scopeKey })
    })
    const closed = new Promise(resolve => {
      timer = setInterval(() => { if (entry.isClosed()) resolve('closed') }, 500)
      timer.unref?.()
    })
    const aborted = new Promise(resolve => {
      if (!req.signal) return
      if (req.signal.aborted) resolve('aborted')
      else {
        onAbort = () => resolve('aborted')
        req.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    try {
      const r = await Promise.race([decision, closed, aborted])
      if (r === 'closed') return next()
      const outcome = r === 'aborted' ? 'cancelled' : r
      entry.emit({ approvalDecided: { id, outcome } })
      return outcome
    } finally {
      pendingApprovals.delete(id)
      clearInterval(timer)
      if (onAbort) req.signal.removeEventListener('abort', onAbort)
    }
  }, true)
}`);
  adapted = replaceOnce(adapted,
    'const turnEntry = { emit, isClosed, calls: new Map(), turn: null, current: () => null }',
    'const turnEntry = { emit, isClosed, sessionId, answerApprovals, scopeKey: ctx.nexusCanvas.scopeKey, calls: new Map(), turn: null, current: () => null, cancel: () => {}, finish: () => {} }',
    'ThoughtDAG canvas turn scope');
  adapted = replaceOnce(adapted, '  if (answerApprovals) canvasTurns.set(sessionId, turnEntry)\n', '',
    'ThoughtDAG defer turn registration until setup is ready');
  adapted = replaceOnce(adapted, '  const agent = await agentOf(ctx, sessionId)',
    `  const agent = await agentOf(ctx, sessionId)
  turnEntry.cancel = () => {
    if (turnEntry.turn !== null && turnEntry.current() === turnEntry.turn) {
      try { agent.cancel({ kind: 'user' }) } catch { /* best effort */ }
    }
  }`, 'ThoughtDAG cancel only the owned active turn');
  adapted = replaceOnce(adapted, '  const finished = new Promise(resolve => { done = resolve })',
    '  const finished = new Promise(resolve => { done = resolve })\n  turnEntry.finish = () => done()',
    'ThoughtDAG unload completion');
  adapted = replaceOnce(adapted, '  try {\n    const inheritsSessionContext',
    '  let timeoutHandle, closeHandle\n  try {\n    canvasTurns.add(turnEntry)\n    const inheritsSessionContext',
    'ThoughtDAG active request lifetime');
  adapted = replaceOnce(adapted,
    '    const timeout = new Promise(resolve => setTimeout(resolve, 20 * 60 * 1000))',
    '    const timeout = new Promise(resolve => { timeoutHandle = setTimeout(resolve, 20 * 60 * 1000); timeoutHandle.unref?.() })',
    'ThoughtDAG bounded timeout handle');
  adapted = replaceOnce(adapted,
    "    const closed = new Promise(resolve => { const t = setInterval(() => { if (isClosed()) { clearInterval(t); resolve() } }, 500); finished.then(() => clearInterval(t)) })",
    '    const closed = new Promise(resolve => { closeHandle = setInterval(() => { if (isClosed()) resolve() }, 500); closeHandle.unref?.() })',
    'ThoughtDAG close monitor lifetime');
  adapted = replaceOnce(adapted,
    "    if (isClosed()) { try { agent.cancel({ kind: 'user' }) } catch { /* best effort */ } }",
    '    if (isClosed()) turnEntry.cancel()',
    'ThoughtDAG closing a canvas cannot cancel another user turn');
  adapted = replaceOnce(adapted, "  } finally {\n    if (typeof off === 'function') off()",
    "  } finally {\n    clearTimeout(timeoutHandle)\n    clearInterval(closeHandle)\n    if (typeof off === 'function') off()",
    'ThoughtDAG release request timers');
  adapted = replaceOnce(adapted, '    if (canvasTurns.get(sessionId) === turnEntry) canvasTurns.delete(sessionId)',
    '    canvasTurns.delete(turnEntry)', 'ThoughtDAG release only the owned request');
  adapted = replaceOnce(adapted, '        const pending = pendingApprovals.get(id)',
    `        const pending = pendingApprovals.get(id)
        if (pending && pending.scopeKey !== nexusState.scopeKey) return sendJson(res, 404, { error: 'no such pending approval' })`,
    'ThoughtDAG approval cannot cross scope');
  adapted += `
// The Nexus root owns this original module's request lifecycle.
export function disposeNexusState() {
  for (const pending of pendingApprovals.values()) pending.resolve('rejected')
  pendingApprovals.clear()
  for (const entry of canvasTurns) {
    entry.cancel()
    entry.finish()
  }
  canvasTurns.clear()
}
`;
  const output = join(project, 'lib/canvas-original/thoughtdag');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'index.js'), adapted);
  const client = adaptThoughtdagClient(await readFile(join(root, 'dist-app', THOUGHTDAG_SOURCE_ASSET), 'utf8'));
  const html = reviewedThoughtdagHtml(await readFile(join(root, 'dist-app/index.html'), 'utf8'));
  await mkdir(join(output, 'dist-app/assets'), { recursive: true });
  await writeFile(join(output, 'dist-app', THOUGHTDAG_CLIENT_ASSET), client.source);
  await writeFile(join(output, 'dist-app/index.html'), html);
  await report(output, manifest, original, adapted, [
    'Keep original SPA, runtime, backup helper, package metadata, and why library locations.',
    'Use native scoped session-query archives; remove the unscoped profile scan fallback.',
    'Scope browser model registrations and approval responses by native canvas identity.',
    'Track concurrent canvas turns independently and cancel only an owned active turn.',
    'Release timers, abort listeners, active turns, and pending approvals on completion/unload.',
    ...client.changes,
  ], {
    client: {
      asset: THOUGHTDAG_CLIENT_ASSET,
      sourceAsset: THOUGHTDAG_SOURCE_ASSET,
      sourceSha256: client.sourceSha256,
      adaptedSha256: client.adaptedSha256,
      htmlSha256: sha256(html),
      overlayFiles: ['dist-app/index.html', `dist-app/${THOUGHTDAG_CLIENT_ASSET}`],
    },
  });
}

export async function buildCanvases() {
  await buildSynapse();
  await buildThoughtdag();
  await copyFile(join(project, 'src/client/canvas-bootstrap.js'), join(project, 'lib/canvas-bootstrap.js'));
  await copyFile(join(project, 'src/client/canvas-theme.css'), join(project, 'lib/canvas-theme.css'));
}
