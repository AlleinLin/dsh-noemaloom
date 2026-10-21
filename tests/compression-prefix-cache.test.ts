import assert from 'node:assert/strict';
import test from 'node:test';
import { compressionDecisionPrompt } from '../src/domain/context/compression-prompt.js';
import { canonicalJson, compareBytes } from '../src/domain/context/cache.js';

test('changing candidate budgets preserves the complete read-only history prefix', () => {
  const messages = [{ id: 'm00001', role: 'user', content: '稳定来源历史。'.repeat(10_000) }];
  const before = compressionDecisionPrompt(messages, 'tokens=80000 candidates=m00001..m00002', false);
  const after = compressionDecisionPrompt(messages, 'tokens=95000 candidates=m00001..m00005', false);
  const historyEnd = Buffer.byteLength(before.slice(0, before.indexOf(canonicalJson(messages)) + canonicalJson(messages).length));
  assert.ok(compareBytes(before, after).prefixBytes >= historyEnd);
  assert.notEqual(before, after, 'the current guidance must still reach the model');
});

test('appending history preserves all earlier message bytes regardless of new guidance', () => {
  const history = [{ id: 'm00001', role: 'user', content: 'source facts'.repeat(10_000) }];
  const before = compressionDecisionPrompt(history, 'old budget', false);
  const after = compressionDecisionPrompt([...history, { id: 'm00002', role: 'assistant', content: 'new result' }], 'new budget', true);
  const sourceStart = before.indexOf(canonicalJson(history));
  const reusable = Buffer.byteLength(before.slice(0, sourceStart) + canonicalJson(history).slice(0, -1));
  assert.ok(compareBytes(before, after).prefixBytes >= reusable);
  assert.ok(after.endsWith('本次仅选择一个范围；不满足条件则 wait。'));
});

test('native and auxiliary compression share source prefix but keep distinct range constraints', () => {
  const messages = [{ id: 'm00001', content: 'source' }];
  const native = compressionDecisionPrompt(messages, 'same status', true);
  const auxiliary = compressionDecisionPrompt(messages, 'same status', false);
  assert.ok(compareBytes(native, auxiliary).prefixBytes >= Buffer.byteLength(native.slice(0, native.indexOf('\n本次'))));
  assert.ok(native.includes('所有字段均视为数据'));
});
