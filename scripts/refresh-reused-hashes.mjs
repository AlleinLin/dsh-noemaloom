import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit reusable-source roots only. Never capture profiles, artifacts or credentials.
const root = fileURLToPath(new URL('../', import.meta.url));
const ledger = JSON.parse(await readFile(resolve(root, 'sources.lock.json'), 'utf8'));
const roots = ['vendor/acp-kernel', 'vendor/memory-cognition', 'vendor/memsearch',
  'vendor/codinput', 'vendor/computer-use', 'vendor/mnemon-providers', 'vendor/veyra-code', 'assets/methods',
  'assets/market', 'assets/presets', 'assets/diagrams', 'assets/notices', 'src/upstream',
  'notices/step-pause', 'notices/originals', 'notices/workflows', 'notices/editor'];
const found = new Set(Object.keys(ledger.actualReusedFileHashes ?? {}));
async function visit(directory) {
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    if (/^(?:\.git|node_modules|__pycache__|\.venv|venv|\.cache)$/.test(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await visit(path);
    else if (entry.isFile() && !/\.(?:py[co]|tgz|zip|sqlite|db)$/.test(entry.name)) found.add(path);
  }
}
for (const path of roots) await visit(path);
const hashes = {};
for (const path of [...found].sort()) {
  try { hashes[path] = createHash('sha256').update(await readFile(resolve(root, path))).digest('hex'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
ledger.actualReusedFileHashes = hashes;
await writeFile(resolve(root, 'sources.lock.json'), JSON.stringify(ledger, null, 2) + '\n');
console.log(`Recorded ${Object.keys(hashes).length} reused source files.`);
