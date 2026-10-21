import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const output = join(root, 'build');
await mkdir(output, { recursive: true });
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this script with npm run pack:delivery.');
const info = JSON.parse(await readFile('lib/build-info.json', 'utf8'));
if (info.package !== manifest.name || info.version !== manifest.version)
  throw new Error('Build identity differs from package.json; run npm run build first.');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const packedText = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', output,
  ], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `npm pack exited ${code}`)));
});
const results = JSON.parse(packedText);
const packed = results[0];
if (results.length !== 1 || basename(packed.filename) !== packed.filename || !packed.filename.endsWith('.tgz'))
  throw new Error('npm pack returned an unexpected filename.');
const packageBytes = await readFile(join(output, packed.filename));
const digest = sha256(packageBytes);
const isWorkbench = manifest.name === '@local/dsh-nexus';
let packageFile = packed.filename;
const deliverables = [];
if (isWorkbench) {
  const { auditPackage } = await import('./audit-package.mjs');
  const audit = await auditPackage({
    packagePath: join(output, packageFile), expectedManifest: manifest,
    npmFiles: packed.files, outputPath: join(output, 'package-audit.json'),
  });
  if (!audit.report.passed)
    throw new Error(`Package audit failed: ${audit.report.violations.length} findings; see build/package-audit.json.`);
  packageFile = `local-dsh-nexus-${manifest.version}-${digest}.tgz`;
  await rename(join(output, packed.filename), join(output, packageFile));
  const keyFiles = await Promise.all([
    'lib/index.js', 'lib/client.js', 'lib/compaction.js', 'lib/project-rules.js',
    'lib/subagent.js', 'lib/preset-runtime.js', 'cordis.patch.yml', 'cordis.presets.patch.yml',
  ].map(async path => ({ path, sha256: sha256(await readFile(path)) })));
  await writeFile(join(output, 'install-manifest.json'), JSON.stringify({
    schemaVersion: 1, packageName: manifest.name, version: manifest.version,
    platform: 'win32-x64', hostVersion: manifest.engines.dsh, profile: 'desktop',
    packageFile, packageSha256: digest, keyFiles,
  }, null, 2) + '\n');
  await copyFile('scripts/install-desktop.ps1', join(output, 'install-desktop.ps1'));
  deliverables.push('package-audit.json', 'install-manifest.json', 'install-desktop.ps1');
} else {
  const files = new Set(packed.files.map(file => file.path));
  for (const required of ['lib/index.js', 'bin/rg.exe', 'cordis.patch.yml', 'LICENSE', 'THIRD-PARTY-NOTICES.md'])
    if (!files.has(required)) throw new Error(`Package missing: ${required}`);
  for (const file of files)
    if (/(?:^|\/)(?:node_modules|src|tests|research|scripts)\//u.test(file))
      throw new Error(`Development-only file in runtime package: ${file}`);
  await copyFile('scripts/install.ps1', join(output, 'Install.ps1'));
  await copyFile('scripts/install-example.ps1', join(output, 'Install-Example.ps1'));
  deliverables.push('Install.ps1', 'Install-Example.ps1');
}
await copyFile('docs/BUILDING.md', join(output, 'BUILDING.md'));
deliverables.push(packageFile, 'BUILDING.md');
const checksums = [];
for (const file of deliverables.sort())
  checksums.push(`${sha256(await readFile(join(output, file)))}  ${file}`);
await writeFile(join(output, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
console.log(JSON.stringify({ package: manifest.name, packageFile, sha256: digest, files: packed.files.length, output }, null, 2));
