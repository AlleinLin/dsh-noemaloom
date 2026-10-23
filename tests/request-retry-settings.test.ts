import assert from 'node:assert/strict';
import test from 'node:test';
import { createScopeModule } from '../src/domain/scope.js';
import { REQUEST_RETRY_DEFAULTS, REQUEST_RETRY_FEATURE, requestRetryDelay, resolveRequestRetryOptions, validateRequestRetryConfig } from '../src/shared/request-retry.js';
import type { DispatchContext } from '../src/ports/contracts.js';
import { stepProgressServices } from './step-progress-fixture.js';

test('request retry settings inherit live through all three scopes and only the user may change them', async () => {
  const { services } = stepProgressServices(), module = createScopeModule(services);
  const global: DispatchContext = { scopeLevel: 'global', actorId: 'connection-owner', permissions: new Set(['scope.configure', 'scope.reset']) };
  const workspace: DispatchContext = { ...global, scopeLevel: 'workspace', workspaceRoot: process.cwd() };
  const child: DispatchContext = { ...workspace, scopeLevel: 'session', sessionId: 'retry-child' };
  const read = async (ctx: DispatchContext) => resolveRequestRetryOptions((await module.dispatch({ action: 'settings', params: { feature: REQUEST_RETRY_FEATURE } }, ctx) as any).effective);
  const save = (ctx: DispatchContext, config: any, expectedRevision = 0) =>
    module.dispatch({ action: 'configure', params: { feature: REQUEST_RETRY_FEATURE, config }, expectedRevision }, ctx);
  assert.deepEqual(await read(child), REQUEST_RETRY_DEFAULTS);
  await save(global, { defaults: { mode: 'custom', maxRetries: 8, initialDelayMs: 1000, maxDelayMs: 60_000 } });
  await save(workspace, { defaults: { algorithm: 'linear' } });
  await save(child, { defaults: { maxRetries: 2 } });
  assert.deepEqual(await read(child), { ...REQUEST_RETRY_DEFAULTS, mode: 'custom', maxRetries: 2, algorithm: 'linear', initialDelayMs: 1000, maxDelayMs: 60_000 });
  assert.equal((await read({ ...child, sessionId: 'another-child' })).maxRetries, 8);
  await save(global, { defaults: { mode: 'custom', maxRetries: 12, initialDelayMs: 2000, maxDelayMs: 60_000 } }, 1);
  assert.equal((await read(child)).initialDelayMs, 2000);
  await module.dispatch({ action: 'reset', params: { feature: REQUEST_RETRY_FEATURE }, expectedRevision: 1 }, child);
  assert.equal((await read(child)).maxRetries, 12);
  await assert.rejects(save({ ...child, actorId: 'native-tool' }, { defaults: { mode: 'custom' } }), /仅由用户/);
  await assert.rejects(save({ ...workspace, permissions: new Set() }, {}), /仅由用户/);
  await assert.rejects(save(child, { defaults: { maxDelayMs: 1000 } }), /初始间隔/);
  assert.equal((await read(child)).maxDelayMs, 60_000, 'invalid inherited bounds never persist');
});

test('retry validation rejects unsafe values and unknown algorithms without silently normalizing them', () => {
  for (const config of [
    { defaults: { maxRetries: -1 } }, { defaults: { maxRetries: 101 } }, { defaults: { maxRetries: 1.2 } },
    { defaults: { algorithm: 'surprise' } }, { defaults: { mode: 'always' } },
    { defaults: { initialDelayMs: Infinity } }, { defaults: { maxDelayMs: 86_400_001 } },
    { defaults: { multiplier: 0 } }, { defaults: { jitterRatio: NaN } }, { defaults: { jitterRatio: 1.1 } },
    { defaults: { retryOpaqueProviderErrors: 'true' } }, { defaults: { extra: true } }, { extra: true },
  ]) assert.ok(validateRequestRetryConfig(config), JSON.stringify(config));
  assert.equal(resolveRequestRetryOptions({ enabled: false }).mode, 'disabled');
  assert.equal(resolveRequestRetryOptions({ defaults: { maxRetries: 0 } }).maxRetries, 0);
});

test('new and legacy profiles default to 64 retries without a PI opt-in', () => {
  const options = resolveRequestRetryOptions({});
  assert.equal(options.mode, 'custom');
  assert.equal(options.maxRetries, 64);
  assert.equal(options.retryOpaqueProviderErrors, true);
  assert.equal(resolveRequestRetryOptions({ defaults: { mode: 'inherit' } }).maxRetries, 64);
});

test('fixed, linear and exponential algorithms obey cap, jitter and Retry-After', () => {
  const settings = { ...REQUEST_RETRY_DEFAULTS, initialDelayMs: 1000, maxDelayMs: 5000, jitterRatio: 0 };
  const series = (algorithm: 'fixed' | 'linear' | 'exponential') =>
    Array.from({ length: 5 }, (_, index) => requestRetryDelay({ ...settings, algorithm }, index));
  assert.deepEqual(series('fixed'), [1000, 1000, 1000, 1000, 1000]);
  assert.deepEqual(series('linear'), [1000, 2000, 3000, 4000, 5000]);
  assert.deepEqual(series('exponential'), [1000, 2000, 4000, 5000, 5000]);
  assert.equal(requestRetryDelay({ ...settings, multiplier: 3 }, 2), 5000);
  assert.equal(requestRetryDelay({ ...settings, jitterRatio: 0.2 }, 0, undefined, () => 0), 800);
  assert.equal(requestRetryDelay({ ...settings, jitterRatio: 0.2 }, 0, undefined, () => 1), 1200);
  assert.equal(requestRetryDelay({ ...settings, jitterRatio: 1 }, 4, undefined, () => 1), 5000);
  assert.equal(requestRetryDelay(settings, 0, 4321), 4321);
  assert.equal(requestRetryDelay(settings, 0, 5001), 5001, 'provider minimum outlives the algorithm cap');
  assert.equal(requestRetryDelay(settings, 0, 86_400_001), 86_400_001);
  assert.equal(requestRetryDelay(settings, 0, 2_147_483_648), 2_147_483_648);
  assert.equal(requestRetryDelay(settings, 0, Number.MAX_SAFE_INTEGER + 1), undefined);
  assert.equal(requestRetryDelay(settings, 10000), 5000);
  assert.equal(requestRetryDelay({ ...settings, initialDelayMs: 0, maxDelayMs: 0 }, 10000), 0);
});
