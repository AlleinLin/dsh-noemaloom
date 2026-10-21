import test from 'node:test';
import assert from 'node:assert/strict';
import { auxiliaryCatalog, auxiliaryModel, auxiliarySettings, validateAuxiliaryConfig } from '../src/domain/insights/auxiliary.js';
import { NexusError } from '../src/ports/contracts.js';
import { scopeKeys } from '../src/domain/scope.js';
import { companionFixture, routes } from './companion-fixture.js';

test('auxiliary choices use the published catalog, supported maximum effort and explicit unsupported omission', async () => {
  const f = companionFixture({ routes });
  assert.equal((await auxiliaryCatalog(f.services))[0].highest, 'high');
  await assert.rejects(validateAuxiliaryConfig(f.services, { defaults: { routes: [{ provider: 'local', model: 'invented' }] } }), /未知型号/);
  await assert.rejects(validateAuxiliaryConfig(f.services, { defaults: { routes: [{ ...routes[0], reasoningEffort: 'ultra' }] } }), /reasoning_effort/);
  await assert.rejects(validateAuxiliaryConfig(f.services, { defaults: { reflectionSystem: '' } }), /系统提示词/);
  f.produce(async request => ({ text: 'valid', provider: request.provider, model: request.model }));
  await auxiliaryModel(f.services, f.context, { role: 'fixture', prompt: 'evidence' });
  assert.equal(f.calls[0].reasoningEffort, 'high');
  assert.equal(f.calls[0].independentRoute, true); assert.equal(f.calls[0].allowChildren, false);
  await f.store.put('scope-settings', 'global/auxiliary', { defaults: { routes: [routes[1]] } }, 1);
  await auxiliaryModel(f.services, f.context, { role: 'fixture', prompt: 'evidence' });
  assert.equal(f.calls[1].reasoningEffort, undefined);
});

test('explicit empty routes cannot inherit a live or legacy model; scope overrides preserve parent fields', async () => {
  const f = companionFixture({ routes: [] });
  await f.store.put('scope-settings', 'global/insights', { defaults: { provider: 'local', model: 'first' } }, 0);
  assert.deepEqual((await auxiliarySettings(f.services, f.context)).routes, []);
  await assert.rejects(auxiliaryModel(f.services, f.context, { role: 'fixture', prompt: 'x', provider: 'current', model: 'session' }), /尚未选择/);
  assert.equal(f.calls.length, 0);
  await f.store.put('scope-settings', 'global/auxiliary', { defaults: { reflection: false } }, 1);
  assert.deepEqual((await auxiliarySettings(f.services, f.context)).routes, [routes[0]]);
  const keys = scopeKeys(f.services.workspaceRoot, f.context);
  await f.store.put('scope-settings', `${keys[1]}/auxiliary`, { defaults: { maxCallsPerDay: 7 } }, 0);
  await f.store.put('scope-settings', `${keys[2]}/auxiliary`, { defaults: { routes: [routes[1]] } }, 0);
  const config = await auxiliarySettings(f.services, f.context);
  assert.deepEqual(config.routes, [routes[1]]); assert.equal(config.reflection, false); assert.equal(config.maxCallsPerDay, 7);
});

test('invalid output and provider errors advance through only the selected routes with visible reasons', async () => {
  const f = companionFixture({ routes });
  f.produce(async request => ({ text: request.model === 'first' ? 'invalid' : 'valid', provider: request.provider, model: request.model }));
  const result = await auxiliaryModel(f.services, f.context, { role: 'fixture', prompt: 'x' }, { validate(text) {
    if (text !== 'valid') throw new NexusError('INVALID_MODEL_OUTPUT', 'bad output');
  } });
  assert.deepEqual(f.calls.map(r => r.model), ['first', 'second']);
  assert.equal(result.attempts[0].code, 'INVALID_MODEL_OUTPUT');
  assert.equal(result.attempts[1].state, 'succeeded');
  assert.equal(f.calls[1].reasoningEffort, undefined);
});

test('user cancellation never falls back and the shared daily budget spans every auxiliary consumer', async () => {
  const f = companionFixture({ routes, maxCallsPerDay: 1 }), controller = new AbortController();
  f.produce(async () => { controller.abort(); throw new Error('cancelled'); });
  await assert.rejects(auxiliaryModel(f.services, f.context, { role: 'fixture', prompt: 'x', signal: controller.signal }));
  assert.equal(f.calls.length, 1);
  f.produce(async request => ({ text: 'valid', provider: request.provider, model: request.model }));
  await assert.rejects(auxiliaryModel(f.services, f.context, { role: 'other-consumer', prompt: 'x' }), /全部独立辅助模型/);
  assert.equal(f.calls.length, 1);
});

test('oversized complete request fails before provider dispatch rather than silently cutting its tail', async () => {
  const f = companionFixture({ maxInputTokens: 4000 });
  await assert.rejects(auxiliaryModel(f.services, f.context, { role: 'fixture', prompt: '汉'.repeat(4000) }), /保守输入预算超限/);
  assert.equal(f.calls.length, 0);
});

test('shared output budgets include thinking, preserve explicit lower caps and follow the published route allowance', async () => {
  const f = companionFixture();
  f.produce(async request => ({ text: 'valid', provider: request.provider, model: request.model }));
  assert.equal((await auxiliarySettings(f.services, f.context)).maxOutputTokens, 32768);
  assert.equal((await auxiliarySettings(f.services, f.context)).maxInputTokens, 256000);
  await auxiliaryModel(f.services, f.context, { role: 'fixture', prompt: 'evidence' });
  assert.equal(f.calls[0].maxTokens, 32768);
  await auxiliaryModel(f.services, f.context, { role: 'fixture', prompt: 'evidence', maxTokens: 1600 });
  assert.equal(f.calls[1].maxTokens, 1600, 'an explicitly requested lower allowance is retained');
  await f.store.put('scope-settings', 'global/auxiliary', { defaults: { routes: [routes[0]], maxOutputTokens: 1800 } }, 1);
  await auxiliaryModel(f.services, f.context, { role: 'fixture', prompt: 'evidence', maxTokens: 32768 });
  assert.equal(f.calls[2].maxTokens, 1800, 'a saved user budget is never silently raised');
  await f.store.put('scope-settings', 'global/auxiliary', { defaults: { routes: [routes[0]], maxOutputTokens: 65536 } }, 2);
  const sessions = f.services.host.sessions;
  f.services.host.sessions = async (action, params) => {
    const result: any = await sessions(action, params);
    return action === 'models/list' ? { ...result, items: result.items.map((item: any) => ({
      ...item, capabilities: { ...item.capabilities, maxOutputTokens: { state: 'declared', value: 8192 } },
    })) } : result;
  };
  await auxiliaryModel(f.services, f.context, { role: 'fixture', prompt: 'evidence' });
  assert.equal(f.calls[3].maxTokens, 8192);
  await validateAuxiliaryConfig(f.services, { defaults: { maxOutputTokens: 65536, maxInputTokens: 1000000 } });
  await assert.rejects(validateAuxiliaryConfig(f.services, { defaults: { maxOutputTokens: 65537 } }), /允许范围/);
});
