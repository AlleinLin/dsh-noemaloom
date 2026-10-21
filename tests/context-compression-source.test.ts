import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCKED_REF, defaultConfig } from '../src/adapters/upstream/billion/index.js';
import { nativeToCore, type NativeSurfaceNode } from '../src/adapters/upstream/billion/native.js';
import { boundedCompressionSource } from '../src/domain/context/compression-source.js';

const message = (seq: number, text = 'faithful source '.repeat(20)): NativeSurfaceNode => ({
  seq, message: { id: `m${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
});
function source(nodes: NativeSurfaceNode[], window = 20000) {
  const messages = nativeToCore(nodes);
  const refs = Object.fromEntries(messages.map((item, index) => [item.id, `M${index + 1}`]));
  const cfg = defaultConfig(window, { preserveRecentMessages: 2, preserveRecentTokens: 0 });
  return { messages, refs, cfg, read: () => boundedCompressionSource(messages, refs, cfg, window) };
}
const head = () => message(0, 'Stable exact prefix. '.repeat(150));
const tail = () => [message(90), message(91)];

test('bounded source includes whole native messages and all parallel tool call/result pairs', () => {
  const calls: NativeSurfaceNode = { seq: 2, message: { id: 'calls', role: 'assistant',
    source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [
      { type: 'text', text: 'Start two independent tools.' },
      { type: 'tool-call', id: 'a', name: 'read_a', arguments: '{}' },
      { type: 'tool-call', id: 'b', name: 'read_b', arguments: '{}' },
    ] } };
  const result = (seq: number, id: string): NativeSurfaceNode => ({ seq, message: { id: `result-${id}`,
    role: 'tool', source: { kind: 'tool' }, toolCallId: id, content: [{ type: 'text', text: 'Verified result '.repeat(40) }] } });
  const f = source([head(), message(1), calls, result(3, 'b'), result(4, 'a'), message(5), ...tail()]);
  const bounded = f.read();
  assert.deepEqual(bounded.messages.filter(item => item.toolCallId).map(item => item.toolCallId), ['a', 'b', 'b', 'a']);
  assert.equal(bounded.messages.some(item => item.ref === f.refs[f.messages[0]!.id]), false);
  assert.equal(bounded.messages.some(item => item.ref === f.refs[f.messages.at(-1)!.id]), false);
  assert.equal(JSON.stringify(bounded.messages).includes('nativeMessage'), false);
});

test('protected gaps and oversized native messages are skipped without joining noncontiguous source ranges', () => {
  for (const blocked of ['protected', 'oversized', 'blocked-ref'] as const) {
    const f = source([head(), message(1), message(2), message(3), ...tail()]);
    if (blocked === 'protected') f.messages[2]!.nativeProtected = true;
    else if (blocked === 'blocked-ref') f.refs[f.messages[2]!.id] = BLOCKED_REF;
    else f.messages[2]!.text = 'oversized '.repeat(10000);
    const result = f.read();
    assert.deepEqual(result.messages.map(item => item.ref), [f.refs[f.messages[1]!.id]]);
    assert.ok(JSON.stringify(result.messages).length <= result.sourceBudgetTokens);
  }
  const f = source([head(), message(1, 'oversized '.repeat(10000)), message(2), message(3), ...tail()]);
  assert.deepEqual(f.read().messages.map(item => item.ref), [f.refs[f.messages[2]!.id], f.refs[f.messages[3]!.id]]);
});

test('orphan tool results, incomplete recent pairs and disallowed official boundaries are never offered', () => {
  const orphan: NativeSurfaceNode = { seq: 1, message: { id: 'orphan', role: 'tool', source: { kind: 'tool' },
    toolCallId: 'missing', content: [{ type: 'text', text: 'Orphan must remain exact.' }] } };
  const open: NativeSurfaceNode = { seq: 5, message: { id: 'open', role: 'assistant',
    source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    content: [{ type: 'tool-call', id: 'open-call', name: 'read', arguments: '{}' }] } };
  const f = source([head(), orphan, message(2), message(3), open, ...tail()]);
  const result = f.read();
  assert.equal(result.messages.some(item => item.toolCallId), false);
  assert.deepEqual(result.messages.map(item => item.ref), [f.refs[f.messages[2]!.id], f.refs[f.messages[3]!.id]]);
  const forbidden = boundedCompressionSource(f.messages, f.refs, f.cfg, 20000, { starts: [0], ends: [91] });
  assert.equal(forbidden.messages.length, 0);
  assert.equal(forbidden.reason, 'no-safe-bounded-range');
});
