import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside, sha256, slash, sourceIdentity } from './core.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2), boundary = args.indexOf('--');
if (boundary < 0) throw new Error('Usage: node tools/acceptance/run-command.mjs --id <id> --kind <kind> [--artifact <relative-file>] -- <program> <args...>');
const options = { artifacts: [] };
for (let index = 0; index < boundary; index += 2) {
  const key = args[index], value = args[index + 1];
  if (!value) throw new Error(`Missing ${key} value`);
  if (key === '--artifact') options.artifacts.push(value);
  else if (key === '--id') options.id = value;
  else if (key === '--kind') options.kind = value;
  else throw new Error(`Unknown option: ${key}`);
}
if (!/^[a-z0-9][a-z0-9._-]{0,80}$/u.test(options.id ?? '') || !/^[a-z][a-z-]+$/u.test(options.kind ?? '')) throw new Error('An evidence id and kind are required');
const [command, ...commandArgs] = args.slice(boundary + 1);
if (!command) throw new Error('Missing program');
if (commandArgs.some(value => /(?:api[-_]?key|authorization|password|secret|bearer)[=:]/iu.test(value))) throw new Error('Credentials must not be supplied in the recorded argv');
const source = await sourceIdentity(root), startedAt = new Date().toISOString();
const dir = join(root, 'evidence', 'runs', options.id);
await mkdir(dir, { recursive: true }); await mkdir(join(root, 'evidence', 'receipts'), { recursive: true });
const stdout = [], stderr = [];
let byteLength = 0, truncated = false;
const cap = 32 * 1024 * 1024;
const capture = (target, chunk) => { const bytes = Buffer.from(chunk); if (byteLength < cap) target.push(bytes.subarray(0, cap - byteLength)); byteLength += bytes.length; if (byteLength > cap) truncated = true; };
const child = spawn(command === 'node' ? process.execPath : command, commandArgs, { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', chunk => { capture(stdout, chunk); process.stdout.write(chunk); });
child.stderr.on('data', chunk => { capture(stderr, chunk); process.stderr.write(chunk); });
const result = await new Promise(resolveResult => {
  child.once('error', error => resolveResult({ exitCode: null, signal: null, error: error.message }));
  child.once('close', (exitCode, signal) => resolveResult({ exitCode, signal }));
});
await writeFile(join(dir, 'stdout.log'), Buffer.concat(stdout)); await writeFile(join(dir, 'stderr.log'), Buffer.concat(stderr));
const artifacts = [], artifactErrors = [];
for (const name of new Set([slash(relative(root, join(dir, 'stdout.log'))), slash(relative(root, join(dir, 'stderr.log'))), ...options.artifacts])) {
  try {
    const bytes = await readFile(inside(root, name));
    artifacts.push({ path: slash(name), sha256: sha256(bytes), bytes: bytes.length });
  } catch (error) {
    // Preserve the command's observed exit and logs even when it failed before
    // producing its promised result. Missing evidence can never become a pass.
    artifactErrors.push({ path: slash(name), code: error.code ?? 'ARTIFACT_UNREADABLE' });
  }
}
const afterSource = await sourceIdentity(root);
const receipt = { schemaVersion: 1, id: options.id, kind: options.kind, sourceHash: source.sha256,
  sourceUnchangedDuringRun: source.sha256 === afterSource.sha256, startedAt, finishedAt: new Date().toISOString(),
  command: [command, ...commandArgs], ...result, outputTruncated: truncated, observedOutputBytes: byteLength, artifacts, artifactErrors };
await writeFile(join(root, 'evidence', 'receipts', `${options.id}.json`), JSON.stringify(receipt, null, 2) + '\n');
process.exitCode = result.exitCode === 0 && receipt.sourceUnchangedDuringRun && artifactErrors.length === 0 ? 0 : 1;
