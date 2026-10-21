import { createHash } from 'node:crypto';
import ts from 'typescript';

const REVIEWED_HOST_SHA256 = '97db3817e8cd18581fe3222d264f1ad8038fc774c603197159a3d54ac008ef75';
const ORIGINAL_WHY_IMPORT = "why = await import('./why.mjs')";
const ADAPTED_WHY_IMPORT = "why = await import(new URL('./why.mjs', import.meta.resolve('dsh-thoughtdag')).href)";
const parse = source => {
  const ast = ts.createSourceFile('thoughtdag-host.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error('ThoughtDAG host adapter: invalid JavaScript');
  return ast;
};
function replaceOnce(source, anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`ThoughtDAG host ${label}: reviewed anchor changed`);
  }
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}
function replaceFunction(source, name, replacement) {
  const ast = parse(source);
  const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (nodes.length !== 1) throw new Error(`ThoughtDAG host: expected one ${name}`);
  return source.slice(0, nodes[0].getStart(ast)) + replacement + source.slice(nodes[0].end);
}

/** Reviewed package adaptation only; never executes the original plugin. */
export function adaptThoughtdagHost(original) {
  if (createHash('sha256').update(original).digest('hex') !== REVIEWED_HOST_SHA256) {
    throw new Error('ThoughtDAG host adapter requires the reviewed 0.5.21 host SHA256');
  }
  let adapted = original;
  const change = (anchor, replacement, label) => {
    adapted = replaceOnce(adapted, anchor, replacement, label);
  };
  change("const __dirname = fileURLToPath(new URL('.', import.meta.url))",
    "const __dirname = fileURLToPath(new URL('.', import.meta.resolve('dsh-thoughtdag')))", 'runtime location');
  change(ORIGINAL_WHY_IMPORT, ADAPTED_WHY_IMPORT, 'why library');
  change('let registeredProviders = []', 'const nexusState = config.nexusState', 'scoped providers');
  const providers = [];
  const providerAst = parse(adapted);
  const visit = node => {
    if (ts.isIdentifier(node) && node.text === 'registeredProviders') providers.push([node.getStart(providerAst), node.end]);
    ts.forEachChild(node, visit);
  };
  visit(providerAst);
  if (providers.length !== 4) throw new Error('ThoughtDAG host: original four provider references changed');
  for (const [start, end] of providers.reverse()) {
    adapted = adapted.slice(0, start) + 'nexusState.providers' + adapted.slice(end);
  }
  adapted = replaceFunction(adapted, 'eventsOfSession', `async function eventsOfSession(ctx, id) {
  return ctx.nexusCanvas.eventsOfSession(id)
}`);
  change('async function agentOf(ctx, id) {',
    'async function agentOf(ctx, id) {\n  ctx.nexusCanvas.assertSession(id)', 'native agent membership');
  change('const canvasTurns = new Map()', 'const canvasTurns = new Set()\nlet nexusGeneration = 0',
    'independent request lifetime');
  adapted = replaceFunction(adapted, 'personDecides', `async function personDecides(id, sessionId, entry, signal, kind) {
  let timer, onAbort
  const decision = new Promise(resolve => {
    pendingApprovals.set(id, { resolve, sessionId, kind, scopeKey: entry.scopeKey, entry })
  })
  const closed = new Promise(resolve => {
    timer = setInterval(() => { if (!entry.active || entry.isClosed()) resolve('closed') }, 500)
    timer.unref?.()
  })
  const aborted = new Promise(resolve => {
    if (!signal) return
    if (signal.aborted) resolve('aborted')
    else {
      onAbort = () => resolve('aborted')
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  try {
    const answer = await Promise.race([decision, closed, aborted])
    if (signal?.aborted) return 'aborted'
    if (!entry.active || entry.turn === null || entry.current() !== entry.turn) {
      return kind === 'form' ? 'cancelled' : 'rejected'
    }
    if (entry.isClosed()) return 'closed'
    return answer
  } finally {
    pendingApprovals.delete(id)
    clearInterval(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}`);
  adapted = replaceFunction(adapted, 'canvasTurnOf', `function canvasTurnOf(agent) {
  return [...canvasTurns].find(entry => entry.active && !entry.isClosed() && entry.answerApprovals
    && entry.agent === agent && entry.sessionId === agent?.id
    && entry.turn !== null && entry.current() === entry.turn) ?? null
}

// A standing allowance belongs to this live agent and this exact native
// canvas scope. Another tier, a resumed agent or a sibling request cannot use it.
function rulesFor(entry) {
  let scopes = sessionRules.get(entry.agent)
  if (!scopes) sessionRules.set(entry.agent, scopes = new Map())
  let rules = scopes.get(entry.scopeKey)
  if (!rules) scopes.set(entry.scopeKey, rules = new Set())
  return rules
}`);
  // Keep both upstream answerers, the exact tool argument key and all form
  // normalisation. Only the rule store's owning identity changes.
  change('sessionRules.get(sessionId)?.has(rule)', 'rulesFor(entry).has(rule)', 'standing allowance lookup');
  change('      if (!sessionRules.has(sessionId)) sessionRules.set(sessionId, new Set())\n      sessionRules.get(sessionId).add(rule)',
    '      rulesFor(entry).add(rule)', 'standing allowance ownership');
  change('async function runAgentTurn(ctx, body, emit, isClosed, { answerApprovals = true } = {}) {',
    'async function runAgentTurn(ctx, body, emit, isClosed, { answerApprovals = true } = {}) {\n  ctx.nexusCanvas.assertHarness(body?.harness)\n  const generation = nexusGeneration',
    'turn native membership');
  change('const turnEntry = { emit, isClosed, calls: new Map(), turn: null, current: () => null }',
    'const turnEntry = { emit, isClosed, sessionId, answerApprovals, scopeKey: ctx.nexusCanvas.scopeKey, active: true, calls: new Map(), turn: null, current: () => null, cancel: () => {}, finish: () => {} }',
    'turn identity');
  change('  if (answerApprovals) canvasTurns.set(sessionId, turnEntry)\n', '', 'defer registration');
  change('  const restorePermission = canvasPermission(ctx, agent, body?.harness?.permission, emit)',
    `  if (generation !== nexusGeneration || isClosed()) throw new Error('canvas request closed')
  turnEntry.agent = agent
  turnEntry.cancel = () => {
    if (turnEntry.turn !== null && turnEntry.current() === turnEntry.turn) {
      try { agent.cancel({ kind: 'user' }) } catch { /* best effort */ }
    }
  }
  let restorePermission = null
  const releasePermission = () => {
    const restore = restorePermission
    restorePermission = null
    restore?.()
  }`, 'permission starts with owned turn');
  change('  const finished = new Promise(resolve => { done = resolve })',
    '  const finished = new Promise(resolve => { done = resolve })\n  turnEntry.finish = () => { turnEntry.active = false; done() }',
    'unload completion');
  change('  const claimTurn = (turn) => { ourTurn = turn; turnEntry.turn = turn }',
    `  const claimTurn = (turn) => {
    ourTurn = turn
    turnEntry.turn = turn
    if (turnEntry.active && generation === nexusGeneration && !isClosed()) {
      restorePermission = canvasPermission(ctx, agent, body?.harness?.permission, emit)
    }
  }`, 'permission exact turn ownership');
  change("    if (event.type === 'turn/start') {\n      currentTurn = event.data?.turn ?? null",
    `    if (event.type === 'turn/start') {
      if (ourTurn !== null && event.data?.turn !== ourTurn) releasePermission()
      currentTurn = event.data?.turn ?? null`, 'permission before another turn');
  change("    } else if (event.type === 'turn/end') {\n      done()",
    "    } else if (event.type === 'turn/end') {\n      releasePermission()\n      currentTurn = null\n      done()", 'permission immediately on own completion');
  change('  try {\n    const inheritsSessionContext',
    '  let timeoutHandle, closeHandle\n  try {\n    canvasTurns.add(turnEntry)\n    const inheritsSessionContext', 'register active request');
  change('    const timeout = new Promise(resolve => setTimeout(resolve, 20 * 60 * 1000))',
    '    const timeout = new Promise(resolve => { timeoutHandle = setTimeout(resolve, 20 * 60 * 1000); timeoutHandle.unref?.() })',
    'bounded timeout handle');
  change("    const closed = new Promise(resolve => { const t = setInterval(() => { if (isClosed()) { clearInterval(t); resolve() } }, 500); finished.then(() => clearInterval(t)) })",
    '    const closed = new Promise(resolve => { closeHandle = setInterval(() => { if (isClosed()) resolve() }, 500); closeHandle.unref?.() })',
    'close monitor lifetime');
  change("    if (isClosed()) { try { agent.cancel({ kind: 'user' }) } catch { /* best effort */ } }",
    '    if (isClosed()) turnEntry.cancel()', 'cancel only owned turn');
  change("  } finally {\n    if (typeof off === 'function') off()",
    "  } finally {\n    turnEntry.active = false\n    clearTimeout(timeoutHandle)\n    clearInterval(closeHandle)\n    if (typeof off === 'function') off()", 'release request timers');
  change('    if (canvasTurns.get(sessionId) === turnEntry) canvasTurns.delete(sessionId)',
    `    canvasTurns.delete(turnEntry)
    for (const pending of pendingApprovals.values()) {
      if (pending.entry === turnEntry) pending.resolve(pending.kind === 'form' ? 'cancelled' : 'rejected')
    }`, 'release owned waiters');
  change('    restorePermission?.()', '    releasePermission()', 'permission cleanup');
  change('        const pending = pendingApprovals.get(id)',
    `        const pending = pendingApprovals.get(id)
        if (pending && pending.scopeKey !== nexusState.scopeKey) return sendJson(res, 404, { error: 'no such pending approval' })`,
    'answer exact scope');
  change('export async function apply(ctx, config) {',
    'export async function apply(ctx, config) {\n  nexusGeneration++', 'root lifecycle generation');
  change('  installApprovalAnswerer(ctx)',
    `  installApprovalAnswerer(ctx)
  ctx.on('agent/disposed', ({ agent }) => {
    sessionRules.delete(agent)
    for (const entry of canvasTurns) {
      if (entry.agent !== agent) continue
      entry.cancel()
      entry.finish()
    }
    for (const pending of pendingApprovals.values()) {
      if (pending.entry.agent === agent) pending.resolve(pending.kind === 'form' ? 'cancelled' : 'rejected')
    }
  })`, 'live agent disposal');
  adapted += `
// The Nexus root owns this original module's request lifecycle.
export function disposeNexusState() {
  nexusGeneration++
  for (const pending of pendingApprovals.values()) pending.resolve(pending.kind === 'form' ? 'cancelled' : 'rejected')
  pendingApprovals.clear()
  for (const entry of canvasTurns) {
    entry.cancel()
    entry.finish()
  }
  canvasTurns.clear()
  sessionRules.clear()
}
`;
  const originalAst = parse(original), adaptedAst = parse(adapted);
  const changed = new Set(['eventsOfSession', 'agentOf', 'personDecides', 'canvasTurnOf', 'installApprovalAnswerer', 'runAgentTurn', 'apply']);
  for (const node of originalAst.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name || changed.has(node.name.text)) continue;
    const after = adaptedAst.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === node.name.text);
    let afterText = after?.getText(adaptedAst);
    if (node.name.text === 'installWhyLayer' && afterText) {
      afterText = replaceOnce(afterText, ADAPTED_WHY_IMPORT, ORIGINAL_WHY_IMPORT, 'restore reviewed why library import');
    }
    if (afterText !== node.getText(originalAst)) {
      throw new Error(`ThoughtDAG host adapter changed original implementation: ${node.name.text}`);
    }
  }
  return adapted;
}
