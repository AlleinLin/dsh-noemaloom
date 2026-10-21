import test from 'node:test';
import assert from 'node:assert/strict';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { availableChildModels, childModelGuidance, resolveChildModelOptions } from '../src/host/child-models.js';
import { childCatalogHarness } from './fixtures/child-model-catalog.js';

test('child model defaults use the highest adapter-ordered effort for omitted, empty, whitespace and null values', async t => {
  const { llm } = await childCatalogHarness(t);
  for (const effort of [undefined, '', ' \t ', null]) {
    const options = await resolveChildModelOptions(llm, { provider: 'fixture', model: 'deep', reasoningEffort: ReasoningEffortId('quick'), maxTokens: 64 }, effort);
    assert.equal(options.reasoningEffort, 'maximum');
    assert.equal(options.maxTokens, 64);
  }
  assert.equal((await resolveChildModelOptions(llm, { provider: 'fixture', model: 'compact' }, '')).reasoningEffort, 'high');
});

test('explicit valid child effort is preserved; wrong model and unsupported effort return available codes before sending', async t => {
  const { llm } = await childCatalogHarness(t);
  assert.equal((await resolveChildModelOptions(llm, { provider: 'fixture', model: 'deep' }, 'thorough')).reasoningEffort, 'thorough');
  for (const [provider, model, effort] of [['fixture', 'invented', ''], ['absent', 'deep', ''], ['fixture', 'compact', 'ultra']]) {
    await assert.rejects(resolveChildModelOptions(llm, { provider, model }, effort), (error: any) => {
      assert.equal(error.code, 'CHILD_MODEL_SELECTION_INVALID');
      assert.match(error.message, /fixture\/deep/);
      assert.deepEqual(error.details.availableModels.map((item: any) => item.code), ['fixture/deep', 'fixture/compact', 'fixture/plain']);
      return true;
    });
  }
});

test('non-reasoning child models omit effort and authorized discovery never advertises other routes', async t => {
  const { llm } = await childCatalogHarness(t);
  const options = await resolveChildModelOptions(llm, { provider: 'fixture', model: 'plain', reasoningEffort: ReasoningEffortId('high') }, '');
  assert(!('reasoningEffort' in options));
  const items = await availableChildModels(llm, [{ provider: 'fixture', model: 'compact' }, { provider: 'fixture', model: 'invented' }]);
  assert.deepEqual(items.map(item => item.code), ['fixture/compact']);
  assert.match(childModelGuidance(items), /省略或空白时=high/);
  assert(!childModelGuidance(items).includes('fixture/deep'));
  const controller = new AbortController();
  controller.abort(new Error('cancel fixture lookup'));
  await assert.rejects(resolveChildModelOptions(llm, { provider: 'fixture', model: 'deep' }, '', controller.signal), /cancel fixture lookup/);
});
