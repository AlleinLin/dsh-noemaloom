import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Invoke Node entry points directly: nested npm.cmd invocations can end a
// Windows command chain after the build while returning a successful status.
const cwd = fileURLToPath(new URL('../', import.meta.url));
for (const args of [
  ['scripts/build.mjs'],
  ['node_modules/typescript/bin/tsc', '--noEmit'],
  ['scripts/run-tests.mjs', ...(process.env.NOEMALOOM_CHECK_RUN_ID
    ? ['--id', process.env.NOEMALOOM_CHECK_RUN_ID] : [])],
  ['scripts/verify-artifacts.mjs'],
]) {
  console.log(`\nChecking: node ${args.join(' ')}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', value => resolve(value ?? 1));
  });
  if (code !== 0) process.exit(code);
}
