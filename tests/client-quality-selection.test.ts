import assert from 'node:assert/strict';
import test from 'node:test';
import { qualityRuleSelection } from '../src/client/quality-rule-model.js';

test('quality selection counts distinct available rules, excludes unknown IDs and ignores search-page size', () => {
  const complete = Array.from({ length: 35 }, (_, index) => ({ ruleId: `rule-${index}` }));
  const selected = complete.map(rule => rule.ruleId);
  const result = qualityRuleSelection([...selected, selected[0], 'custom.deleted'], complete);
  assert.equal(result.valid.length, 35);
  assert.deepEqual(result.unknown, ['custom.deleted']);
  assert.deepEqual(qualityRuleSelection([], complete), { valid: [], unknown: [] });
  assert.deepEqual(qualityRuleSelection(undefined, complete), { valid: [], unknown: [] });
});
