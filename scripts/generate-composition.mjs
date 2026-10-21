import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { nativeComposition } from './native-composition.mjs';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
function packageRoot(name) {
  let current = dirname(require.resolve(name));
  for (;;) {
    try {
      const pkg = require(join(current, 'package.json'));
      if (pkg.name === name) return { root: current, pkg };
    } catch {}
    const parent = dirname(current);
    if (parent === current) throw new Error(`Package root unavailable: ${name}`);
    current = parent;
  }
}
const mnemon = packageRoot('dsh-mnemon');
Object.assign(manifest.dependencies, Object.fromEntries(Object.entries(mnemon.pkg.dependencies).filter(([name]) => name.startsWith('dsh-mnemon-'))));
manifest.exports['./original/*'] = './lib/original/*.js';
manifest.exports['./native/*'] = './lib/native/*.js';
const prerequisites = new Set(manifest.dsh.client.inject);
prerequisites.add('@deepseek-ai/dsh-client-modules');
for (const name of Object.keys(manifest.dependencies)) {
  if (!/^(?:dsh-|@(?:anionex|linxin666|michengai)\/dsh-)/.test(name) || name === 'dsh-skin-market') continue;
  for (const prerequisite of packageRoot(name).pkg.dsh?.client?.inject ?? []) {
    // Mnemon's client SDK is shared inside our factory bridge, not loaded a
    // second time as an independent browser plugin.
    if (prerequisite.startsWith('@deepseek-ai/')) prerequisites.add(prerequisite);
  }
}
manifest.dsh.client.inject = [...prerequisites].sort();
await writeFile(new URL('package.json', root), JSON.stringify(manifest, null, 2) + '\n');
const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
lock.version = manifest.version;
lock.packages[''].version = manifest.version;
lock.packages[''].dependencies = manifest.dependencies;
await writeFile(new URL('package-lock.json', root), JSON.stringify(lock, null, 2) + '\n');

const entries = [
  ['better-sidebar', 'better-sidebar'], ['dsh-context', 'context'],
  ['dsh-better-display', 'better-display'], ['ui-task-board', 'task-board'],
  ['ui-git-graph', 'git-graph'], ['usage', 'usage'],
  ['agency-agents-remote', 'agency-agents-remote'], ['agency-agents', 'agency-agents'],
  ['turn-rewind', 'turn-rewind'], ['thoughtdag', 'thoughtdag'], ['synapse', 'synapse'],
];
let patch = "# Unified desktop composition. Original host entries retain their native IDs.\n- insert:\n    - id: nexus\n      name: '@local/dsh-nexus'\n";
for (const [id, name] of entries) {
  patch += `    - id: ${id}\n      name: '@local/dsh-nexus/original/${name}'\n`;
  if (id === 'dsh-context') patch += "      config:\n        defaultPlacement: tab\n        fleetTab: show\n";
  if (id === 'thoughtdag') patch += "      config:\n        mountPrefix: /thoughtdag\n        whyTools: true\n        whyPrompt: true\n";
}
const memoryPatch = (await readFile(join(mnemon.root, 'cordis.patch.yml'), 'utf8'))
  .replace(/\bdsh-mnemon\/bundle\b/g, '@local/dsh-nexus/original/mnemon-bundle')
  .replace(/\bdsh-mnemon-([\w-]+)/g, '@local/dsh-nexus/original/mnemon-$1')
  .replace(/\bname: dsh-mnemon\b/g, 'name: @local/dsh-nexus/original/mnemon')
  .replace(/\b(name|use): (@local\/[^\r\n]+)/g, "$1: '$2'");
patch += '\n' + memoryPatch;
patch += '\n' + await nativeComposition();
await writeFile(new URL('cordis.patch.yml', root), patch);
