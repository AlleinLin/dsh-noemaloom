import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalizeSourceMap } from '../scripts/canonicalize-sourcemap.mjs';
import { inspectArtifactSafety } from '../scripts/audit-package.mjs';

test('merged native client sources retain mapping targets across duplicate indices and lines', () => {
  const source = {
    version: 3, sources: ['../src/shared.ts', '../src/shared.ts', '../src/other.ts'],
    sourcesContent: ['shared', 'shared', 'other'], names: [],
    mappings: 'AAAA,CCAA,CCAA;ADAA', ignoreList: [0, 1, 2],
  };
  const canonical = canonicalizeSourceMap(source);
  assert.deepEqual(canonical.sources, ['../src/shared.ts', '../src/other.ts']);
  assert.deepEqual(canonical.sourcesContent, ['shared', 'other']);
  assert.equal(canonical.mappings, 'AAAA,CAAA,CCAA;ADAA');
  assert.deepEqual(canonical.ignoreList, [0, 1]);
  assert.equal(source.mappings, 'AAAA,CCAA,CCAA;ADAA');
  assert.equal(source.sources.length, 3);
});

test('canonical source identities with conflicting embedded text fail the build', () => {
  assert.throws(() => canonicalizeSourceMap({
    version: 3, sources: ['../src/shared.ts', '../src/nested/../shared.ts'],
    sourcesContent: ['first', 'different'], names: [], mappings: '',
  }), /Conflicting source map contents/);
});

test('upstream synthetic key fixture review is exact and source-only', async () => {
  const file = 'vendor/nexus-terminal/packages/dshell/ssh/tests/local-keys.spec.ts';
  const bytes = await readFile(file);
  const runtime = inspectArtifactSafety(file, bytes);
  assert.ok(runtime.findings.some(finding => finding.rule === 'private-key-material'));
  const source = inspectArtifactSafety(file, bytes, { syntheticSource: true, localUserPaths: false });
  assert.deepEqual(source.findings, []);
  assert.ok(source.reviewedMatches.some(review => review.reviewId === 'dshell-local-key-filter-fixture'));
  const changed = inspectArtifactSafety(file, Buffer.concat([bytes, Buffer.from('\n')]),
    { syntheticSource: true, localUserPaths: false });
  assert.ok(changed.findings.some(finding => finding.rule === 'private-key-material'));
});
