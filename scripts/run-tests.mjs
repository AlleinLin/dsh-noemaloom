import { readdir, readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { sourceIdentity, sha256 } from '../tools/acceptance/core.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--id'
  || !/^[a-z0-9][a-z0-9._-]{0,80}$/u.test(args[1])))
  throw new Error('Usage: node scripts/run-tests.mjs [--id <new-run-id>]');
const runId = args[1] ?? 'tests';
const directory = args.length ? join('evidence', 'runs', runId) : 'evidence';
const junitPath = join(directory, 'tests.junit.xml');
const stdoutPath = join(directory, 'tests.stdout.log');
const receiptPath = join('evidence', 'receipts', args.length ? `${runId}.json` : 'test.json');
if (args.length) {
  let exists = false;
  try { await access(receiptPath); exists = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) throw new Error(`Run id already has a receipt: ${runId}; choose a new id to preserve previous evidence`);
}

async function discover(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await discover(path));
    else if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) found.push(path);
  }
  return found;
}
const candidates = (await Promise.all(['tests', 'vendor/acp-kernel/tests', 'tools/acceptance/test'].map(discover))).flat().sort();
const nodeTests = [], otherTests = [];
for (const path of candidates) {
  const source = await readFile(path, 'utf8');
  (/\bfrom\s+['"](?:vitest|bun:test)['"]/.test(source) ? otherTests : nodeTests).push(path);
}
if (otherTests.length) throw new Error(`Tests require another runner: ${otherTests.join(', ')}`);
if (!nodeTests.length) throw new Error('No tests discovered');
await mkdir('evidence/receipts', { recursive: true });
await mkdir(directory, { recursive: true });
const source = await sourceIdentity(resolve('.'));
const startedAt = new Date().toISOString();
const log = createWriteStream(stdoutPath);
console.log(`Running ${nodeTests.length} discovered test files; JUnit: ${junitPath}`);
const child = spawn(process.execPath, [
  '--import', 'tsx', '--test', '--test-concurrency=4',
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=junit', `--test-reporter-destination=${junitPath}`,
  ...nodeTests,
], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
child.stdout.on('data', chunk => { process.stdout.write(chunk); log.write(chunk); });
child.stderr.on('data', chunk => { process.stderr.write(chunk); log.write(chunk); });
const outcome = await new Promise(resolveRun => {
  child.once('error', error => { log.write(`${error.stack ?? error.message}\n`); resolveRun({ exitCode: 1, spawnError: error.message }); });
  child.once('close', (code, signal) => resolveRun({ exitCode: code ?? 1, signal }));
});
log.end();
await finished(log);
const after = await sourceIdentity(resolve('.'));
const artifacts = [];
for (const path of [junitPath, stdoutPath]) {
  try { artifacts.push({ path: path.replaceAll('\\', '/'), sha256: sha256(await readFile(path)) }); } catch {}
}
await writeFile(receiptPath, JSON.stringify({
  schemaVersion: 1, id: runId, kind: 'domain-test', sourceHash: source.sha256,
  startedAt, finishedAt: new Date().toISOString(), ...outcome,
  sourceUnchangedDuringRun: after.sha256 === source.sha256,
  runtime: { node: process.version, modules: process.versions.modules, platform: process.platform, arch: process.arch },
  discoveredTests: nodeTests, testConcurrency: 4, artifacts,
}, null, 2) + '\n');
process.exitCode = outcome.exitCode || (after.sha256 === source.sha256 ? 0 : 1);
