import { readFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
for (const required of ['lib/index.js', 'lib/client.js', 'lib/compaction.js', 'lib/project-rules.js', 'lib/subagent.js', 'lib/preset-runtime.js', 'cordis.patch.yml', 'cordis.presets.patch.yml', 'locale/zh-CN.json', 'locale/en.json', 'locale/ru.json', 'assets/icon.svg', 'LICENSE', 'NOTICE']) {
  assert((await readFile(required)).length > 0, `Missing or empty artifact: ${required}`);
}
const browser = await readFile('lib/client.js', 'utf8');
const buildInfo = JSON.parse(await readFile('lib/build-info.json', 'utf8'));
assert(!buildInfo.clientInputs.some(path => path.includes('node_modules/monaco-editor/')), 'Monaco must be outside the main client bundle');
const editor = JSON.parse(await readFile('lib/editor/manifest.json', 'utf8'));
assert.equal(editor.monaco, '0.57.0');
assert.deepEqual(Object.keys(editor.workers).sort(), ['core', 'css', 'html', 'json', 'typescript']);
for (const file of [editor.entry, editor.css, ...Object.values(editor.workers)]) assert(editor.assets.some(asset => asset.file === file), `Editor allowlist missing ${file}`);
for (const asset of editor.assets) {
  assert(!asset.file.includes('..') && /^[A-Za-z0-9_./-]+$/.test(asset.file), 'Unsafe editor asset name');
  assert.equal(createHash('sha256').update(await readFile(`lib/editor/${asset.file}`)).digest('hex'), asset.sha256, `Editor bytes differ: ${asset.file}`);
}
assert(browser.startsWith('window.__ModuleLoader__.load('), 'Client must be official lazy factory');
assert(!/\brequire\(["'](?:node:|fs["']|child_process|path["'])/.test(browser), 'Browser contains host module');
assert(!/react\.production\.min|__SECRET_INTERNALS/.test(browser), 'React must use shared module identity');
assert(manifest.engines.dsh === '0.2.1-rc.2', 'DSH version must be exact');
assert.deepEqual(manifest.dsh.bundle.patch, ['./cordis.patch.yml', './cordis.presets.patch.yml'], 'Both official composition patches must be installed');
assert.equal(manifest.exports['./native/*'], './lib/native/*.js', 'Native capabilities must have formal package exports');
const native = JSON.parse(await readFile('lib/native-capabilities-manifest.json', 'utf8'));
assert.equal(native.clients.length, 7, 'All original dshell client faces must be retained');
assert.equal(native.hosts.length, 11, 'All original dshell host packages must be retained');
for (const row of native.hosts) assert((await readFile(`lib/native/${row.id}.js`)).length > 0, `Missing native host: ${row.id}`);
assert.equal(native.consolePtyBridge.filename, 'lib/native/dshell-pty-console.js');
const consoleBridge = await readFile(native.consolePtyBridge.filename, 'utf8');
assert.match(consoleBridge, /stdio: 'inherit', shell: false/);
assert.doesNotMatch(consoleBridge, /@deepseek-ai|node-pty|sandbox\.confine/);
console.log(JSON.stringify({ verified: true, package: manifest.name, checks: ['factory', 'browser-isolation', 'shared-react', 'manifest-resources'] }));
