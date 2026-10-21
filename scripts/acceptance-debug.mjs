import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { sourceIdentity, sha256 } from '../tools/acceptance/core.mjs';

const args = process.argv.slice(2), idAt = args.indexOf('--id'), seedAt = args.indexOf('--seed');
const id = idAt < 0 ? undefined : args[idAt + 1];
if (!id || !/^[a-z0-9][a-z0-9._-]{0,80}$/.test(id) || args.some((value, index) => !['--id', '--seed'].includes(value) && ![idAt + 1, seedAt + 1].includes(index)))
  throw new Error('Usage: npm run acceptance:debug -- --id <new-id> [--seed <verified-download-directory>]');
const output = join('evidence/runs', id), receipt = join('evidence/receipts', `${id}.json`);
try { await access(receipt); throw new Error('Use a fresh evidence id'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(output, { recursive: true }); await mkdir('evidence/receipts', { recursive: true });
const before = await sourceIdentity(resolve('.')), startedAt = new Date().toISOString();
let log = '';
const outcome = await new Promise(resolveRun => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tools/debug-acceptance.ts', '--output', resolve(output), ...(seedAt >= 0 ? ['--seed', resolve(args[seedAt + 1])] : [])],
    { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const append = bytes => { const text = bytes.toString(); log = (log + text).slice(-1024 * 1024); process.stdout.write(text); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  child.once('error', () => resolveRun({ exitCode: 1, failure: 'runner-startup' }));
  child.once('close', (code, signal) => resolveRun({ exitCode: code ?? 1, signal }));
});
await writeFile(join(output, 'debug.stdout.log'), log);
const after = await sourceIdentity(resolve('.'));
const artifacts = [];
for (const path of [join(output, 'debug.stdout.log'), join(output, 'debug-result.json')]) {
  try { artifacts.push({ path: path.replaceAll('\\', '/'), sha256: sha256(await readFile(path)) }); } catch {}
}
await writeFile(receipt, JSON.stringify({ schemaVersion: 1, id, kind: 'real-four-language-dap', sourceHash: before.sha256,
  sourceUnchangedDuringRun: before.sha256 === after.sha256, startedAt, finishedAt: new Date().toISOString(), ...outcome, artifacts }, null, 2) + '\n');
process.exitCode = outcome.exitCode || (before.sha256 === after.sha256 ? 0 : 1);
