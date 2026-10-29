import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const tests = (await readdir(new URL('../tests/', import.meta.url)))
  .filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`);
for (const args of [['scripts/build.mjs'], ['--test', ...tests]]) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', result => resolve(result ?? 1));
  });
  if (code) process.exit(code);
}
