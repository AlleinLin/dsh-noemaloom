import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateObservation, readFrozenDefinitions, readJUnit, sha256, validateReceipt } from '../core.mjs';
import { idsInTitle } from '../coverage-map.mjs';

test('all 769 frozen acceptance definitions retain their exact document lines and aggregate hash', async () => {
  const { baseline, definitions } = await readFrozenDefinitions(fileURLToPath(new URL('../../../docs/specification/', import.meta.url)));
  assert.equal(baseline.count, 769);
  assert.equal(definitions.length, 769);
  assert.equal(new Set(definitions.map(item => item.id)).size, 769);
  assert(definitions.every(item => item.originalText.trim() && item.line > 0));
});

test('acceptance evidence parser retains failed/skipped cases and rejects entities', () => {
  const rows = readJUnit('<testsuite><testcase name="a &amp; b" time="0.1"></testcase><testcase name="failure"><failure message="real" /></testcase><testcase name="skip"><skipped /></testcase></testsuite>');
  assert.deepEqual(rows.map(row => [row.name, row.status]), [['a & b', 'passed'], ['failure', 'failed'], ['skip', 'skipped']]);
  assert.throws(() => readJUnit('<!DOCTYPE x [<!ENTITY y SYSTEM "file:///private">]><testcase name="x" />'));
});

test('JUnit quoted comparison signs and self-closing cases never consume neighboring failures', () => {
  const rows = readJUnit(`<testsuite>
    <testcase name="preserveRecentMessages > 0" />
    <testcase name='effective >= threshold' />
    <testcase name="T2->T3 and /> text" />
    <testcase name="failed > bound"><failure message="actual > expected" /></testcase>
    <testcase name="error"><error /></testcase>
    <testcase name="skipped"><skipped /></testcase>
    <testcase name="failed and skipped"><skipped /><failure /></testcase>
    <testcase name="&lt;think> &amp;#62; &#62; &#x3e; &quot; &apos;" />
  </testsuite>`);
  assert.deepEqual(rows.map(row => [row.name, row.status]), [
    ['preserveRecentMessages > 0', 'passed'], ['effective >= threshold', 'passed'],
    ['T2->T3 and /> text', 'passed'], ['failed > bound', 'failed'],
    ['error', 'failed'], ['skipped', 'skipped'], ['failed and skipped', 'failed'],
    [`<think> &#62; > > " '`, 'passed'],
  ]);
  assert.throws(() => readJUnit('<!DOCTYPE testsuite><testcase name="x" />'));
  assert.throws(() => readJUnit('<!ENTITY x "value"><testcase name="x" />'));
});

test('acceptance receipts reject stale source, changed artifacts and missing stability evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-acceptance-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'evidence'));
  const bytes = Buffer.from('{"actual":7}');
  await writeFile(join(root, 'evidence', 'observed.json'), bytes);
  const receipt = { schemaVersion: 1, id: 'observed', kind: 'domain-test', sourceHash: 'current-source',
    sourceUnchangedDuringRun: true, startedAt: '2026-10-19T00:00:00.000Z', finishedAt: '2026-10-19T00:00:01.000Z',
    artifacts: [{ path: 'evidence/observed.json', sha256: sha256(bytes) }] };
  assert.equal((await validateReceipt(root, receipt, 'current-source')).valid, true);
  assert.equal((await validateReceipt(root, { ...receipt, artifactErrors: [{ path: 'evidence/promised.json', code: 'ENOENT' }] }, 'current-source')).valid, false);
  assert.equal((await validateReceipt(root, receipt, 'new-source')).valid, false);
  assert.equal((await validateReceipt(root, { ...receipt, sourceUnchangedDuringRun: undefined }, 'current-source')).valid, false);
  await writeFile(join(root, 'evidence', 'observed.json'), '{"actual":8}');
  assert.equal((await validateReceipt(root, receipt, 'current-source')).valid, false);
  assert.equal((await validateReceipt(root, { ...receipt, artifacts: [{ path: '../outside', sha256: sha256(bytes) }] }, 'current-source')).valid, false);
});

test('acceptance observations compute from actual saved values and never trust typed PASS', () => {
  const observed = new Map([['observation.json', Buffer.from('{"runtime":{"modelCalls":3,"status":"failed"}}')]]);
  const check = { artifact: 'observation.json', description: 'all physical calls', expectedDescription: 'three calls', pointer: '/runtime/modelCalls', operator: 'equals', expected: 3 };
  assert.equal(evaluateObservation(check, observed).passed, true);
  assert.equal(evaluateObservation({ ...check, pointer: '/runtime/status', expected: 'passed', passed: true }, observed).passed, false);
  assert.equal(evaluateObservation({ ...check, pointer: '/missing', expected: undefined }, observed).passed, false);
  assert.equal(evaluateObservation({ ...check, pointer: '/toString', operator: 'nonempty' }, observed).passed, false);
  assert.equal(evaluateObservation({ ...check, operator: 'at-least', expected: '2' }, observed).passed, false);
});

test('abbreviated ID titles map explicit IDs while ranges remain partial candidates', () => {
  assert.deepEqual(idsInTitle('MMR-025/026/027 shape'), ['MMR-025', 'MMR-026', 'MMR-027']);
  assert.deepEqual(idsInTitle('MMR-039..043 independence'), ['MMR-039', 'MMR-040', 'MMR-041', 'MMR-042', 'MMR-043']);
});
