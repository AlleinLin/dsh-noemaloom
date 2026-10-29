import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import YAML from 'yaml';

const parse = source => YAML.parse(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ js: value }) }] });
const flatten = entries => entries.flatMap(entry => [entry, ...(entry.group ? flatten(entry.config ?? []) : [])]);

test('Desktop bundle replaces standard directly and preserves other tools and image capability', async () => {
  const source = parse(await readFile('research/host-installed/dsh-web-app/presets/standard.patch.yml', 'utf8'))[0].insert[0];
  assert.deepEqual(await readdir('presets'), ['forge-tools.patch.yml']);
  for (const filename of ['cordis.patch.yml', 'presets/forge-tools.patch.yml']) {
    const generated = parse(await readFile(filename, 'utf8'));
    assert.equal(generated.length, 1);
    const [entry] = generated;
    assert.equal(entry.id, 'preset-standard');
    assert.equal(entry.insert, undefined);
    assert.equal(entry.config.id, 'standard');
    assert.equal(entry.config.order, source.config.order);
    assert.deepEqual(Object.keys(entry.config), ['id', 'order', 'plugins']);
    const original = flatten(source.config.plugins);
    const rows = flatten(entry.config.plugins);
    for (const originalRow of original) {
      if (['tool-pwsh', 'tool-fs', 'tool-fs-search'].includes(originalRow.id)) continue;
      assert.deepEqual(rows.find(row => row.id === originalRow.id), originalRow, originalRow.id);
    }
    const own = rows.find(row => row.name === '@local/dsh-forge-tools');
    assert.ok(own);
    assert.equal(Object.hasOwn(own.config, 'shellOnly'), false);
    const fs = rows.find(row => row.id === 'tool-fs');
    assert.deepEqual(fs.config, { read: false, write: false, edit: false, readImage: true });
    assert.equal(rows.some(row => ['tool-pwsh', 'tool-fs-search'].includes(row.id)), false);
    const ids = rows.map(row => row.id);
    assert.equal(new Set(ids).size, ids.length);
  }
});
