import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
for (const folder of ['lib', 'bin', 'locale', 'presets', 'delivery']) await mkdir(folder, { recursive: true });
await build({ entryPoints: ['src/index.mjs'], outfile: 'lib/index.js', bundle: true,
  platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: false });
await unlink('lib/index.js.map').catch(error => { if (error.code !== 'ENOENT') throw error; });
await copyFile('node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe', 'bin/rg.exe');
await copyFile('node_modules/@vscode/ripgrep-win32-x64/LICENSE', 'bin/RIPGREP-LICENSE.txt');
await copyFile('research/licenses/UPSTREAM-LICENSES.txt', 'bin/UPSTREAM-LICENSES.txt');
const standard = await readFile('research/host-installed/dsh-web-app/presets/standard.patch.yml', 'utf8');
for (const anchor of [
  "          - id: tool-pwsh\n            name: '@deepseek-ai/dsh-tool-pwsh'\n            disabled: !!js process.platform !== 'win32'",
  "          - id: tool-fs\n            name: '@deepseek-ai/dsh-tool-fs'",
  "          - id: tool-fs-search\n            name: '@deepseek-ai/dsh-tool-fs-search'\n            config:\n              sampleOverCapGlobResults: false\n",
]) {
  if (standard.split(anchor).length !== 2)
    throw new Error('Reviewed official Desktop standard composition changed; re-review before building');
}
const preset = standard
  .replace("          - id: tool-pwsh\n            name: '@deepseek-ai/dsh-tool-pwsh'\n            disabled: !!js process.platform !== 'win32'",
    "          - id: forge-tools\n            name: '@local/dsh-forge-tools'\n            config:\n              cacheTtlMs: 1000\n              searchThreads: 2\n              persistentPwsh: true")
  .replace("          - id: tool-fs\n            name: '@deepseek-ai/dsh-tool-fs'",
    "          - id: tool-fs\n            name: '@deepseek-ai/dsh-tool-fs'\n            config:\n              read: false\n              write: false\n              edit: false\n              readImage: true")
  .replace("          - id: tool-fs-search\n            name: '@deepseek-ai/dsh-tool-fs-search'\n            config:\n              sampleOverCapGlobResults: false\n", '');
const marker = '        plugins:\n';
const start = preset.indexOf(marker);
if (start < 0) throw new Error('Installed standard preset format changed');
const plugins = preset.slice(start + marker.length).split('\n')
  .map(line => line.startsWith('    ') ? line.slice(4) : line).join('\n');
// A bundle overlay updates the shipped row without creating another preset or
// persisting a copy in the user's profile. Removing the bundle restores it.
await writeFile('presets/forge-tools.patch.yml',
  '# Desktop: replace tools inside the official standard preset.\n- id: preset-standard\n  config:\n    id: standard\n    order: 1\n    plugins:\n' + plugins);
for (const oldPreset of ['presets/forge-pwsh.patch.yml', 'presets/cli.patch.yml', 'presets/cli-pwsh.patch.yml']) {
  await unlink(oldPreset).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
await writeFile('cordis.patch.yml', await readFile('presets/forge-tools.patch.yml', 'utf8'));
await writeFile('locale/zh-CN.json', JSON.stringify({ meta: { title: 'Forge 高性能工具集', description: '减少重复文件 I/O，增强 Windows PowerShell。' } }, null, 2));
await writeFile('locale/en-US.json', JSON.stringify({ meta: { title: 'Forge Tools', description: 'Bounded file cache, native search and Windows PowerShell tools.' } }, null, 2));
await copyFile('locale/zh-CN.json', 'locale/zh.json');
await copyFile('locale/en-US.json', 'locale/en.json');
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');
await writeFile('lib/build-info.json', JSON.stringify({
  package: manifest.name, version: manifest.version, host: manifest.engines.dsh,
  platform: 'win32-x64', node: process.version, builtAt: new Date().toISOString(),
  upstream: '1f81c047fc48fa190a683e469daa699857e9afe8',
  sha256: { host: await sha256('lib/index.js'), ripgrep: await sha256('bin/rg.exe') },
}, null, 2) + '\n');
console.log('Built Desktop standard-preset replacement and portable Windows x64 ripgrep.');
