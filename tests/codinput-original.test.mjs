import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';
import { parse } from 'yaml';
import { parseFactory } from '../scripts/original-factory.mjs';
import { vendoredOriginal } from '../scripts/vendored-original.mjs';
import { ORIGINAL_PLUGINS } from '../src/client/originals-manifest.ts';
import { ORIGINAL_HOST_IDS } from '../src/host/originals.ts';

const root = process.cwd(), require = createRequire(import.meta.url);
const revision = 'a32da33ce4d50616bf490d360ae3dfe784e8aa50';
const definition = ORIGINAL_PLUGINS.find(entry => entry.packageName === 'dsh-codinput');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('Codinput retains its pinned source, formal host registration and complete bundled dependency licenses', async () => {
  assert.ok(definition);
  assert.deepEqual(definition, {
    id: 'codinput', packageName: 'dsh-codinput', version: '0.3.2',
    role: 'input', client: true, vendor: 'vendor/codinput', revision,
  });
  assert.ok(ORIGINAL_HOST_IDS.includes('codinput'));
  const installed = await vendoredOriginal(root, definition);
  assert.equal(installed.source.revision, revision);
  assert.equal(installed.source.license, 'MIT');
  const lock = JSON.parse(await readFile('sources.lock.json', 'utf8'));
  const unit = lock.units.find(entry => entry.id === 'SRC-38');
  assert.equal(unit.source.revision, revision);
  assert.equal(lock.actualReusedFileHashes['vendor/codinput/SOURCE.json'],
    sha256(await readFile('vendor/codinput/SOURCE.json')));
  for (const name of ['LICENSE', 'NOTICE']) {
    assert.deepEqual(await readFile(`notices/originals/codinput/${name}`),
      await readFile(join(installed.directory, name)));
  }
  for (const [path, expected] of Object.entries(installed.source.dependencyLicenseFiles)) {
    assert.equal(sha256(await readFile(`notices/originals/codinput/dependencies/${path}`)), expected, path);
  }
  const licenses = JSON.parse(await readFile(installed.source.dependencyNotices, 'utf8'));
  assert.equal(licenses.length, 13);
  assert.equal(licenses.find(entry => entry.packageName === 'dompurify').license, '(MPL-2.0 OR Apache-2.0)');
  const patch = parse(await readFile('cordis.patch.yml', 'utf8'));
  assert.deepEqual(patch.flatMap(row => row.insert ?? []).find(row => row.id === 'dsh-codinput'), {
    id: 'dsh-codinput', name: 'dsh-noemaloom/original/codinput', config: {},
  });
  const originalHost = require('../vendor/codinput/lib/index.js');
  assert.equal(originalHost.name, 'dsh-codinput');
  assert.deepEqual(originalHost.inject, []);
  assert.equal(typeof originalHost.apply, 'function');
});

test('factory extraction preserves the published bytes and rejects duplicate registrations', async () => {
  const published = await readFile('vendor/codinput/lib/client.js', 'utf8');
  const parsed = parseFactory(published, 'dsh-codinput');
  assert.deepEqual(parsed.requires, ['react', 'react-dom', 'react/jsx-runtime']);
  assert.equal(`window.__ModuleLoader__.load({ id: "dsh-codinput", factory: ${parsed.factory} })\n`, published);
  assert.throws(() => parseFactory(`${published}\n${published}`, 'dsh-codinput'), /exactly one/);
  assert.deepEqual(parseFactory(
    'window.__ModuleLoader__.load({factory: require => { require("react"); function inner(require) { require("private"); } }})',
    'shadowed-require',
  ).requires, ['react']);
});

test('the actual upstream factory registers the original composer, settings, sidebar and toggle command', async () => {
  const parsed = parseFactory(await readFile('vendor/codinput/lib/client.js', 'utf8'), 'dsh-codinput');
  const timers = [], console = { error() {} };
  const sandbox = vm.createContext({
    require(name) { assert.ok(parsed.requires.includes(name)); return require(name); },
    console,
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
  });
  // Module feature detection sees no browser; then apply receives the captured
  // browser faces. Rendering and native input behavior belong to Desktop QA.
  const original = vm.runInContext(`(${parsed.factory})(require)`, sandbox, { timeout: 5000 });
  assert.equal(original.name, 'dsh-codinput');
  assert.deepEqual(Array.from(original.inject), ['slots', 'conversation']);
  const prefs = new Map(), nodes = [], listeners = [];
  sandbox.window = {
    console,
    localStorage: { getItem: key => prefs.get(key) ?? null, setItem: (key, value) => prefs.set(key, value) },
  };
  sandbox.document = {
    getElementById: id => nodes.find(node => node.id === id),
    createElement: tag => ({ tag }),
    head: { appendChild: node => nodes.push(node) },
    addEventListener: (...args) => listeners.push(args),
  };
  const entries = [], tabs = [], commands = [], disposers = [];
  const slots = {
    register(options, component) {
      const entry = { options, component };
      entries.push(entry);
      return () => entries.splice(entries.indexOf(entry), 1);
    },
    onEntryError() {},
  };
  const services = {
    slots, conversation: { input: {} }, sessions: {}, commandUi: {
      register(command) { commands.push(command); return () => commands.splice(commands.indexOf(command), 1); },
    },
    sidebarRightTabs: { register(tab) { tabs.push(tab); return () => tabs.splice(tabs.indexOf(tab), 1); } },
    sidebarRight: {}, modelDirectories: {}, remote: {}, 'remote.session': {}, locale: {},
  };
  original.apply({
    slots,
    inject(names, callback) { return callback(Object.fromEntries(names.map(name => [name, services[name]]))); },
    effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose); },
  });
  const bar = entries.find(entry => entry.options.name === 'conversation.composer.bar');
  assert.equal(bar.component, original.CodinputBar);
  assert.equal(bar.options.priority, -1);
  assert.equal(bar.options.registrant, 'dsh-codinput');
  const settings = entries.find(entry => entry.options.name === 'settings.section');
  assert.equal(settings.options.id, 'codinput');
  assert.equal(settings.options.label(), 'Codinput');
  assert.equal(settings.options.order, 60);
  assert.ok(entries.some(entry => entry.options.name === 'sidebar.right.pane.tab' && entry.options.key === 'dsh-codinput'));
  assert.ok(entries.some(entry => entry.options.name === 'sidebar.right.pane.tab.title' && entry.options.key === 'dsh-codinput'));
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].id, 'dsh-codinput');
  assert.equal(tabs[0].kind, 'codinput');
  assert.equal(tabs[0].keepMounted, true);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'codinput');
  assert.equal(commands[0].ui.kind, 'action');
  assert.equal(commands[0].available(), true);
  assert.equal(nodes[0].id, 'dsh-codinput-styles');
  assert.ok(listeners.some(([event, , options]) => event === 'pointerdown' && options.capture));
  commands[0].ui.run();
  assert.equal(JSON.parse(prefs.get('dsh-codinput.prefs.v2')).enabled, false);
  assert.equal(entries.some(entry => entry.options.name === 'conversation.composer.bar'), false);
  commands[0].ui.run();
  const restored = entries.find(entry => entry.options.name === 'conversation.composer.bar');
  assert.equal(restored.component, bar.component);
  assert.equal(restored.options, bar.options);
  const defaults = JSON.parse(prefs.get('dsh-codinput.prefs.v2'));
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.sendHotkey, 'mod+enter');
  assert.equal(defaults.lineBreakHotkey, 'enter');
  assert.equal(defaults.lineNumbers, true);
  assert.equal(defaults.mode, 'normal');
  assert.equal(sandbox.window.__dshCodinputShell.apply, 'done');
  assert.deepEqual(Array.from(sandbox.window.__dshCodinputErrs), []);
  assert.ok(timers.every(timer => timer.delay === 80), 'successful registrations must not schedule retries');
  for (const dispose of disposers.reverse()) dispose();
});
