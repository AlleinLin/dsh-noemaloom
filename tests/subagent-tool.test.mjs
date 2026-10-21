import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { apply } from '../vendor/tool-subagent/index.js';
import { childCatalogHarness } from './fixtures/child-model-catalog.ts';

async function toolHarness(t, selectionEnabled = true) {
  const { llm } = await childCatalogHarness(t);
  const definitions = new Map(), listeners = new Map(), disposers = [], started = [];
  const routes = [{ provider: 'fixture', model: 'deep' }, { provider: 'fixture', model: 'compact' }, { provider: 'fixture', model: 'plain' }];
  const provider = { name: 'spawn', capabilities: { agentOptions: true, depthLimit: true }, inheritsParentContext: false };
  const ctx = {
    get: name => ({ llm, subagentModelSelection: {} })[name],
    tools: {
      register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); },
      get: name => definitions.get(name),
    },
    on(name, handler) {
      const group = listeners.get(name) ?? [];
      group.push(handler); listeners.set(name, group);
    },
    effect(setup) { const dispose = setup(); disposers.push(dispose); return dispose; },
    sessionProjections: { register() {}, stateOf: () => routes },
    systemPrompt: { section() {}, context() {}, getSectionOrder: () => 0, getContextOrder: () => 0 },
    subagents: {
      getProvider: () => provider, resolveMaxDepth: () => 1,
      async startActivation(options) { started.push(options); return { childId: `fixture-child-${started.length}` }; },
    },
  };
  const parent = { options: { provider: 'fixture', model: 'deep', reasoningEffort: 'quick' }, session: { requestHeader() {} } };
  await apply(ctx, { provider: 'spawn', modelSelectionSettings: selectionEnabled }, { firstLiveSeq: 0, eventAt() {}, header: {} });
  t.after(() => { for (const dispose of disposers.reverse()) dispose(); });
  const call = async (name, args) => {
    const tool = definitions.get(name);
    assert(tool, `tool ${name} must exist`);
    validateJsonSchemaValue(tool.parameters, args);
    const value = await tool.execute(args, { agent: parent, signal: new AbortController().signal });
    validateJsonSchemaValue(tool.output.schema, value);
    return { tool, value };
  };
  return { call, listeners, started, parent };
}

test('the real delegation tool accepts the screenshot empty effort and returns the actual maximum and available codes', async t => {
  const h = await toolHarness(t);
  for (const effort of ['', ' \t ', null, undefined]) {
    const { value, tool } = await h.call('subagent', {
      prompt: 'synthetic task', description: 'metadata only fixture', provider: 'fixture', model: 'deep',
      ...(effort === undefined ? {} : { reasoning_effort: effort }),
    });
    assert.equal(h.started.at(-1).request.agentOptions.reasoningEffort, 'maximum');
    assert.equal(value.selectedModel.reasoning_effort, 'maximum');
    assert.match(tool.output.render({}, value)[0].text, /fixture\/compact/);
    assert.match(tool.description, /最高思考强度/);
  }
  await h.call('subagent', { prompt: 'synthetic task', description: 'explicit effort', provider: 'fixture', model: 'compact', reasoning_effort: 'low' });
  assert.equal(h.started.at(-1).request.agentOptions.reasoningEffort, 'low');
  await h.call('subagent', { prompt: 'synthetic task', description: 'plain model', provider: 'fixture', model: 'plain', reasoning_effort: '' });
  assert(!('reasoningEffort' in h.started.at(-1).request.agentOptions));
});

test('model listing treats blank filters as omitted and invalid delegation returns codes with zero activations', async t => {
  const h = await toolHarness(t);
  for (const args of [{}, { provider: '', model: '' }, { provider: 'fixture', model: '' }, { provider: 'fixture', model: '  ' }]) {
    const { value, tool } = await h.call('list_subagent_models', args);
    assert.match(value, /fixture\/deep/);
    assert.match(value, /maximum/);
    assert.match(tool.description, /不创建子智能体/);
  }
  for (const fields of [
    { provider: 'fixture', model: 'invented', reasoning_effort: '' },
    { provider: 'fixture', model: 'compact', reasoning_effort: 'ultra' },
    { provider: 'fixture', model: '' },
  ]) await assert.rejects(h.call('subagent', { prompt: 'synthetic task', description: 'invalid route', ...fields }), /fixture\/deep/);
  assert.equal(h.started.length, 0);
});

test('available model codes enter the parent request automatically and inheritance also defaults to maximum', async t => {
  const h = await toolHarness(t);
  const assemble = h.listeners.get('system-prompt/assemble')[0];
  const assembled = await assemble({}, { signal: new AbortController().signal }, async () => ({ sections: [], contexts: [], tools: [], variables: {} }));
  assert.match(assembled.contexts[0].text, /fixture\/deep/);
  assert.match(assembled.contexts[0].text, /省略或空白时=maximum/);
  const fixed = await toolHarness(t, false);
  await fixed.call('subagent', { prompt: 'synthetic task', description: 'inherit route' });
  assert.equal(fixed.started[0].request.agentOptions.reasoningEffort, 'maximum');
  await assert.rejects(fixed.call('subagent', { prompt: 'synthetic task', description: 'unauthorized switch', provider: 'fixture', model: 'compact' }), /disabled/);
  assert.equal(fixed.started.length, 1);
});
