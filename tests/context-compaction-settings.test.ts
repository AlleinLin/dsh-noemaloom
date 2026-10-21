import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAtomicStore } from '../src/domain/storage/index.js';
import { createScopeModule } from '../src/domain/scope.js';
import { resolveContextCompactionOptions } from '../src/shared/context-compaction.js';
import type { DispatchContext, NexusServices } from '../src/ports/contracts.js';

test('compression policy remains a sparse user-owned overlay with independent exact summary routes', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nexus-context-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const metadataReads: any[] = [];
  const services = { store: createAtomicStore(dir), workspaceRoot: dir,
    host: { async sessions(action: string, params: any) {
      assert.equal(action, 'models/info'); metadataReads.push(params);
      return { contextWindow: params.model === 'large' ? 1000000 : 0 };
    } } } as unknown as NexusServices;
  const module = createScopeModule(services);
  const global: DispatchContext = { scopeLevel: 'global', actorId: 'connection-owner', permissions: new Set(['scope.configure', 'scope.reset']) };
  const workspace: DispatchContext = { ...global, scopeLevel: 'workspace', workspaceRoot: dir };
  const session: DispatchContext = { ...workspace, scopeLevel: 'session', sessionId: 'child' };
  const read = (ctx: DispatchContext) => module.dispatch({ action: 'settings', params: { feature: 'context-compaction' } }, ctx) as Promise<any>;
  const configure = (ctx: DispatchContext, config: any, expectedRevision = 0) => module.dispatch({
    action: 'configure', params: { feature: 'context-compaction', config }, expectedRevision,
  }, ctx);
  assert.deepEqual(resolveContextCompactionOptions((await read(session)).effective), { enabled: true, thresholdPercent: 80, summaryModel: null });
  await configure(global, { defaults: { thresholdPercent: 70, summaryModel: { provider: 'exact', model: 'large' } } });
  await configure(workspace, { enabled: false });
  await configure(session, { defaults: { thresholdPercent: 65 } });
  assert.deepEqual(resolveContextCompactionOptions((await read(session)).effective), {
    enabled: false, thresholdPercent: 65, summaryModel: { provider: 'exact', model: 'large' },
  });
  await configure(global, { defaults: { thresholdPercent: 90, summaryModel: { provider: 'exact', model: 'large' } } }, 1);
  assert.equal(resolveContextCompactionOptions((await read(session)).effective).thresholdPercent, 65);
  await configure(session, { defaults: { summaryModel: null } }, 1);
  assert.equal(resolveContextCompactionOptions((await read(session)).effective).summaryModel, null);
  assert.equal(resolveContextCompactionOptions((await read(session)).effective).thresholdPercent, 90);
  const local = await read(session);
  await module.dispatch({ action: 'reset', params: { feature: 'context-compaction' }, expectedRevision: local.local.revision }, session);
  assert.deepEqual(resolveContextCompactionOptions((await read(session)).effective).summaryModel, { provider: 'exact', model: 'large' });
  assert.deepEqual(metadataReads, [{ provider: 'exact', model: 'large' }, { provider: 'exact', model: 'large' }]);
  for (const config of [{ defaults: { thresholdPercent: 9 } }, { defaults: { thresholdPercent: 95.1 } },
    { defaults: { summaryModel: { provider: 'exact' } } }, { defaults: { summaryModel: { provider: 'exact', model: 'unknown' } } }]) {
    await assert.rejects(configure(global, config, 2));
  }
  await assert.rejects(configure({ ...session, actorId: 'native-tool' }, { enabled: true }), /仅由用户/);
  await assert.rejects(configure({ ...global, permissions: new Set() }, { enabled: true }), /仅由用户/);
});
