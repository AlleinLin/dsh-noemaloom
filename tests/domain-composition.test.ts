import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { registerDomainModules } from '../src/domain/index.js';
import { createDispatcher } from '../src/domain/operations/index.js';
import { createAtomicStore } from '../src/domain/storage/index.js';
import type { NexusServices } from '../src/ports/contracts.js';

test('production domain composition registers every domain and exposes files.diff once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-domain-composition-'));
  const unavailable = async (): Promise<never> => {
    throw new Error('Domain composition must not call host services or execute processes');
  };
  const base: Omit<NexusServices, 'invoke'> = {
    store: createAtomicStore(directory),
    dataDir: directory,
    workspaceRoot: directory,
    host: {
      facts: unavailable,
      model: unavailable,
      spawn: unavailable,
      sessions: unavailable,
      secret: unavailable,
      approve: unavailable,
    },
    executor: { run: unavailable },
    emit() {},
  };
  const dispatcher = createDispatcher(base);
  t.after(async () => {
    try { await dispatcher.dispose(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });

  await registerDomainModules(dispatcher.services, module => { dispatcher.register(module); });

  const productionDomains = dispatcher.capabilities().filter(item => item.domain !== 'catalog');
  assert.deepEqual([...new Set(productionDomains.map(item => item.domain))].sort(), [
    'agents', 'artifact', 'autonomy', 'companion', 'connections', 'context', 'extensions', 'files', 'graph', 'insights', 'memory',
    'presets', 'quality', 'recovery', 'resources', 'review', 'runtime', 'scope', 'search', 'usage', 'workflow',
  ]);
  const diff = dispatcher.capabilities('files').filter(item => item.action === 'diff');
  assert.equal(diff.length, 1);
  const described = await dispatcher.dispatch('catalog', { action: 'describe', target: { id: 'files.diff' } });
  assert.equal(described.ok, true);
  assert.deepEqual(described.data, { capabilities: diff });
  const companion = dispatcher.capabilities('companion');
  assert.deepEqual(companion.map(item => item.action).sort(), [
    'answer', 'catalog', 'gate', 'get', 'invalidate', 'observe', 'retry', 'settings', 'wait-gate',
  ]);
  assert.deepEqual(companion.filter(item => item.mutating).map(item => item.action).sort(), [
    'answer', 'gate', 'invalidate', 'observe', 'retry',
  ], 'cached reads and gate waiting remain queries; model checks and user decisions are declared mutations');
  const companionDescription = await dispatcher.dispatch('catalog', { action: 'describe', target: { id: 'companion.observe' } });
  assert.equal(companionDescription.ok, true);
  assert.deepEqual(companionDescription.data, { capabilities: companion.filter(item => item.action === 'observe') });
});
