import { mkdir, readFile, writeFile, copyFile, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const delivery = path.join(root, 'delivery');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run with npm run pack:delivery');
if ((await readdir('presets')).some(file => /^cli(?:-pwsh)?\.patch\.yml$/i.test(file)))
  throw new Error('Run the Desktop build first: stale CLI overlays remain in presets');
await mkdir(delivery, { recursive: true });
const reportNames = ['BENCHMARK.md', 'benchmark.json', 'RESILIENCE.md', 'resilience-results.json',
  'RESEARCH.md', 'PERMISSIONS.md', 'VALIDATION.md', 'host-validation.json', 'compatibility-rc3.json'];
const controlledNames = new Set(['Install.ps1', 'Install-Example.ps1', 'INSTALL_FOR_AI.md',
  'README.md', 'package-inventory.json', 'SHA256SUMS.txt',
  'cli.patch.yml', 'cli-pwsh.patch.yml', 'desktop-validation.json', ...reportNames]);
function isControlledOutput(name) {
  return controlledNames.has(name)
    || /^local-dsh-forge-(?:tools|pwsh)-[^/\\]+\.tgz$/.test(name)
    || /^dsh-forge-tools-[^/\\]+-win-x64\.zip(?:\.sha256)?$/.test(name)
    || /^desktop-evidence-[^/\\]+\.(?:png|jpe?g|webp|gif)$/i.test(name);
}
// Regenerate controlled artifacts rather than inheriting files from an earlier delivery.
// Refuse unexpected entries so the archive helper cannot silently include unrelated files.
for (const entry of await readdir(delivery, { withFileTypes: true })) {
  if (!entry.isFile() || !isControlledOutput(entry.name))
    throw new Error(`Unexpected delivery entry; move it out before packaging: ${entry.name}`);
}
for (const entry of await readdir(delivery)) await rm(path.join(delivery, entry));
function pack(cwd) {
  const result = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', delivery],
    { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout)[0];
}
const full = pack(root);
await copyFile('scripts/install.ps1', path.join(delivery, 'Install.ps1'));
await copyFile('scripts/install-example.ps1', path.join(delivery, 'Install-Example.ps1'));
await copyFile('docs/INSTALL_FOR_AI.md', path.join(delivery, 'INSTALL_FOR_AI.md'));
await writeFile(path.join(delivery, 'README.md'), (await readFile('README.md', 'utf8'))
  .replace('(docs/BENCHMARK.md)', '(BENCHMARK.md)')
  .replace('(docs/RESEARCH.md)', '(RESEARCH.md)')
  .replace('(docs/INSTALL_FOR_AI.md)', '(INSTALL_FOR_AI.md)')
  .replace('(docs/PERMISSIONS.md)', '(PERMISSIONS.md)')
  .replace('(docs/RESILIENCE.md)', '(RESILIENCE.md)')
  .replace('(docs/VALIDATION.md)', '(VALIDATION.md)')
  .replace('(docs/desktop-validation.json)', '(desktop-validation.json)'));
for (const item of reportNames)
  await copyFile(`docs/${item}`, path.join(delivery, item));
try {
  await copyFile('docs/desktop-validation.json', path.join(delivery, 'desktop-validation.json'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const packages = [full];
const inventory = { host: manifest.engines.dsh, platform: 'win32-x64', target: 'desktop',
  packages: packages.map(p => ({ filename: p.filename, bytes: p.size, unpackedBytes: p.unpackedSize,
    files: p.files.map(file => file.path) })) };
for (const pkg of packages) {
  if (pkg.files.some(f => /(?:^|\/)(?:node_modules|research|tests|src|scripts)\//.test(f.path)))
    throw new Error('Unexpected development file in package');
  if (pkg.files.some(f => /(?:^|\/)cli(?:-pwsh)?\.patch\.yml$/i.test(f.path)))
    throw new Error('Desktop package must not contain a CLI overlay');
  if (pkg.files.some(f => /\.(?:png|jpe?g|webp|gif|bmp|ico|svg|avif)$/i.test(f.path)))
    throw new Error('Desktop package must not contain image evidence');
  if (pkg.files.some(f => /(?:^|\/)(?:forge-pwsh\.patch\.yml|pwsh-plugin\.[cm]?js)$/i.test(f.path)))
    throw new Error('Desktop package must not expose a partial PowerShell entry point or preset');
  if (!pkg.files.some(f => f.path === 'bin/rg.exe')) throw new Error('Portable search binary missing');
}
await writeFile(path.join(delivery, 'package-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
const files = (await readdir(delivery)).filter(file => !file.endsWith('.zip') && !file.endsWith('.sha256') && file !== 'SHA256SUMS.txt');
const sums = [];
for (const file of files.sort()) {
  if (!isControlledOutput(file) || /^cli(?:-pwsh)?\.patch\.yml$/i.test(file))
    throw new Error(`Unexpected Desktop payload: ${file}`);
  if (/\.(?:png|jpe?g|webp|gif|bmp|ico|svg|avif)$/i.test(file)
      || /^local-dsh-forge-pwsh-/.test(file))
    throw new Error(`Obsolete partial package or image evidence in Desktop payload: ${file}`);
  const bytes = await readFile(path.join(delivery, file));
  sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${file}`);
}
await writeFile(path.join(delivery, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
const archiveScript = path.join(root, 'scripts', 'create-archive.ps1');
const archive = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', archiveScript,
  '-DeliveryPath', delivery, '-Version', manifest.version], { encoding: 'utf8', windowsHide: true });
if (archive.status !== 0) throw new Error(archive.stderr || archive.stdout);
// Keep the requested handoff directory complete, including unpacked installers.
// Only generated, known filenames may be replaced; preserve unrelated files.
const buildDelivery = path.join(root, 'build');
await mkdir(buildDelivery, { recursive: true });
for (const entry of await readdir(buildDelivery, { withFileTypes: true })) {
  if (entry.isFile() && isControlledOutput(entry.name)) await rm(path.join(buildDelivery, entry.name));
}
for (const entry of await readdir(delivery, { withFileTypes: true })) {
  if (!entry.isFile() || !isControlledOutput(entry.name))
    throw new Error(`Unexpected Desktop handoff entry: ${entry.name}`);
  await copyFile(path.join(delivery, entry.name), path.join(buildDelivery, entry.name));
}
console.log(archive.stdout.trim());
console.log(`Build handoff: ${buildDelivery}`);
console.log(JSON.stringify(inventory, null, 2));
