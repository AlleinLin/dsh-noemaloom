import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { adaptThoughtdagClient, THOUGHTDAG_SOURCE_ASSET } from '../scripts/adapt-thoughtdag-client.mjs';
import { adaptThoughtdagHost } from '../scripts/adapt-thoughtdag-host.mjs';

const require = createRequire(import.meta.url);
const host = await readFile(require.resolve('dsh-thoughtdag'), 'utf8');
const source = await readFile(join(dirname(dirname(require.resolve('dsh-thoughtdag'))), 'dist-app', THOUGHTDAG_SOURCE_ASSET), 'utf8');
function functions(text) {
  const ast = ts.createSourceFile('reviewed.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return new Map(ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name).map(node => [node.name.text, node.getText(ast)]));
}

test('the reviewed standalone update entry performs no version fetch, state update or toast', async () => {
  const before = functions(source), after = functions(adaptThoughtdagClient(source).source);
  const calls = [];
  const bootPluginUpdateCheck = vm.runInNewContext(`(${after.get('g0e')})`, {
    fetch: (...args) => { calls.push(['fetch', args]); },
    oe: { getState: () => ({ setPluginUpdate: (...args) => calls.push(['update', args]) }) },
    Fe: (...args) => calls.push(['toast', args]),
  });
  await bootPluginUpdateCheck('/thoughtdag/api');
  await bootPluginUpdateCheck('https://localhost/thoughtdag/api/');
  assert.deepEqual(calls, []);
  for (const name of ['Fe', 'l0e', 'u0e']) assert.ok(before.has(name), `reviewed upstream function ${name} exists`);
  assert.equal(after.get('Fe'), before.get('Fe'), 'ordinary info/error toast implementation is byte-identical');
  assert.equal(after.get('l0e'), before.get('l0e'), 'upstream release announcement implementation is byte-identical');
  assert.equal(after.get('u0e'), before.get('u0e'), 'the release history remains byte-identical');
});

test('ThoughtDAG host retains the real web search, argument key, form answerer and permission implementation', () => {
  const before = functions(host), adapted = adaptThoughtdagHost(host), after = functions(adapted);
  for (const name of ['webSearchFor', 'harnessStream', 'stepKey', 'canvasPermission']) {
    assert.ok(before.has(name), `reviewed upstream function ${name} exists`);
    assert.equal(after.get(name), before.get(name), `${name} retains the complete upstream implementation`);
  }
  assert.match(after.get('installApprovalAnswerer'), /ctx\.on\('user-questions\/request'/);
  assert.match(after.get('installApprovalAnswerer'), /return \{ answers \}/);
  assert.match(after.get('apply'), /path === '\/permission-modes'/);
  assert.match(after.get('disposeNexusState'), /sessionRules\.clear\(\)/);
});

test('the actual upstream web search path calls the native service and returns cited sources', async () => {
  const run = vm.runInNewContext(`(${functions(adaptThoughtdagHost(host)).get('webSearchFor')})`, {
    SEARCH_RESULTS: 5, AbortSignal,
  });
  const queries = [], sources = [], frames = [];
  const result = await run({
    web: { async search(query, signal) {
      queries.push({ query, signal });
      return { sources: [{ url: 'https://example.invalid/result', title: 'Local fixture', snippet: 'fixture result', publishedAt: '2026-10-21' }] };
    } },
  }, { arguments: '{"query":"fixture query"}' }, sources, frame => frames.push(frame));
  assert.equal(queries.length, 1);
  assert.equal(queries[0].query.query, 'fixture query');
  assert.equal(queries[0].query.maxResults, 5);
  assert.ok(queries[0].signal instanceof AbortSignal);
  assert.equal(sources[0].url, 'https://example.invalid/result');
  assert.match(result.text, /\[1\] Local fixture/);
  assert.equal(frames[0].tool.name, 'web_search');
});

test('the decision waiter releases its real abort listener and timer on decisions, aborts, close and unload', async () => {
  const text = functions(adaptThoughtdagHost(host)).get('personDecides');
  for (const outcome of ['decision', 'aborted', 'closed', 'unload', 'ended']) {
    const pendingApprovals = new Map(), timers = new Set(), controller = new AbortController();
    let isClosed = false, currentTurn = 1;
    const run = vm.runInNewContext(`(${text})`, {
      pendingApprovals,
      setInterval(callback) { const timer = { callback, unref() {} }; timers.add(timer); return timer; },
      clearInterval(timer) { timers.delete(timer); },
    });
    const entry = { scopeKey: 'workspace:wa', active: true, turn: 1, current: () => currentTurn, isClosed: () => isClosed };
    const promise = run('id', 'a', entry, controller.signal, 'form');
    assert.equal(pendingApprovals.get('id').kind, 'form');
    assert.equal(pendingApprovals.get('id').scopeKey, entry.scopeKey);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    if (outcome === 'decision') pendingApprovals.get('id').resolve({ answers: [] });
    if (outcome === 'aborted') controller.abort();
    if (outcome === 'closed') { isClosed = true; [...timers][0].callback(); }
    if (outcome === 'unload') pendingApprovals.get('id').resolve('cancelled');
    if (outcome === 'ended') { currentTurn = 2; pendingApprovals.get('id').resolve({ answers: [] }); }
    const result = await promise;
    if (outcome !== 'decision') assert.equal(result, ['unload', 'ended'].includes(outcome) ? 'cancelled' : outcome);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, outcome);
    assert.equal(timers.size, 0, outcome);
    assert.equal(pendingApprovals.size, 0, outcome);
  }
});
