import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { configureOpsComposition } from '../scripts/ops-composition.mjs';

const rows = document => document.flatMap(entry => Array.isArray(entry.insert) ? entry.insert : []);
const find = (document, id) => rows(document).find(row => row.id === id);

test('OPS keeps small read-only search tools available in Native and PTC scopes', async () => {
  const [upstream, composed] = await Promise.all([
    readFile('node_modules/dsh-ops/cordis.patch.yml', 'utf8'),
    readFile('cordis.patch.yml', 'utf8'),
  ]);
  const generatedOps = parse(configureOpsComposition(upstream));
  const generatedComposition = parse(composed);

  for (const document of [generatedOps, generatedComposition]) {
    assert.deepEqual(find(document, 'dsh-ops').config.ptc.alwaysLoaded, ['grep', 'glob']);
    assert.deepEqual(find(document, 'dsh-ops').config.discovery.alwaysLoaded, ['grep', 'glob']);
    assert.notEqual(find(document, 'dsh-ops').config.discovery.enabled, false);
  }
});

test('OPS alwaysLoaded generation rejects missing upstream settings instead of silently dropping defaults', async () => {
  const upstream = await readFile('node_modules/dsh-ops/cordis.patch.yml', 'utf8');
  assert.throws(
    () => configureOpsComposition(upstream.replace('        ptc:', '        retired:')),
    /Missing dsh-ops enabled setting: ptc/,
  );
});
