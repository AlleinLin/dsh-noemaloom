import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseDocument } from 'yaml';

const require = createRequire(import.meta.url);

test('Noemaloom registers under its repository name and all composed modules resolve', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const info = JSON.parse(await readFile('lib/build-info.json', 'utf8'));
  assert.equal(manifest.name, 'dsh-noemaloom');
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[''].name, manifest.name);
  assert.equal(info.package, manifest.name);
  assert.equal((await import('../lib/index.js')).name, manifest.name);
  for (const locale of ['zh-CN', 'en', 'ru']) {
    const data = JSON.parse(await readFile(`locale/${locale}.json`, 'utf8'));
    assert.equal(data.meta.title, manifest.name);
  }
  const names = new Set();
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'name' || key === 'use') && typeof item === 'string') {
        assert.equal(item.startsWith('@local/dsh-nexus'), false, item);
        if (item === manifest.name || item.startsWith(`${manifest.name}/`)) names.add(item);
      }
      walk(item);
    }
  };
  for (const file of ['cordis.patch.yml', 'cordis.presets.patch.yml']) {
    const document = parseDocument(await readFile(file, 'utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
    });
    assert.deepEqual(document.errors, [], file);
    walk(document.toJS());
  }
  assert(names.has('dsh-noemaloom'));
  assert(names.has('dsh-noemaloom/subagent'));
  assert(names.has('dsh-noemaloom/compaction'));
  assert(names.has('dsh-noemaloom/native/agent-procedures'));
  assert(names.size > 30, 'original capabilities must remain in the composition');
  for (const name of names) assert(require.resolve(name), name);
  const client = await readFile('lib/client.js', 'utf8');
  assert(client.includes('id:"dsh-noemaloom"'));
  assert(client.includes('dsh-noemaloom-client'));
  assert(!client.includes('@local/dsh-nexus/'), 'no former package imports in the client');
});
