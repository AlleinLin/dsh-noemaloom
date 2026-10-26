import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SkillRegistry } from '@deepseek-ai/dsh-skill';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as superpowers from '../lib/original/superpowers.js';
import * as ponytail from '../lib/original/ponytail.js';
import * as openspec from '../lib/original/openspec.js';
import * as karpathy from '../lib/original/karpathy.js';
import { checkUpstreams, classifyVersion } from '../scripts/check-upstreams.mjs';
import { suppressManagedUpdateUi } from '../scripts/managed-updates.mjs';
import { parseFactory } from '../scripts/original-factory.mjs';
import ts from 'typescript';

test('original workflow providers work in the real rc.3 skill registry and unload cleanly', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-workflows-'));
  const root = new Context(), fibers = [];
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  let skills, prompts;
  const base = root.plugin({ name: 'workflow-test-base', apply(ctx) {
    skills = new SkillRegistry(ctx);
    prompts = new SystemPrompt(ctx, { includeHarnessIdentity: false });
    ctx.provide('profileContext', { dir: directory });
    ctx.provide('settings', { describe: () => [{ ns: 'ponytail', value: {}, revision: 1 }],
      async mutate() { throw new Error('No test is allowed to mutate real settings.'); } });
  } }); fibers.push(base); await base.await(); assert.equal(base.state, 2);
  for (const [module, config] of [[superpowers, { disabled: { brainstorming: true }, language: 'en' }],
    [ponytail, { defaultMode: 'lite', skillDescriptionLang: 'en' }], [openspec, {}], [karpathy, {}]]) {
    const fiber = root.plugin(module, config); fibers.push(fiber); await fiber.await();
    assert.equal(fiber.state, 2, `${module.name} must mount, not stay pending`);
  }
  const listed = await skills.list();
  assert.equal(listed.filter(row => row.provider === 'superpowers').length, 15);
  assert.deepEqual(listed.find(row => row.name === 'brainstorming').invocation,
    { modelInvocable: false, userInvocable: false }, 'disabled skill is excluded by both invocation consumers');
  assert.equal(listed.filter(row => row.provider === 'ponytail').length, 6);
  assert.equal(listed.filter(row => row.name.startsWith('openspec-')).length, 12);
  assert.equal(listed.filter(row => row.name.startsWith('opsx-')).length, 12);
  assert.equal(listed.find(row => row.name === 'opsx-apply').invocation.modelInvocable, false);
  assert.match((await skills.get('ponytail-review')).content, /review/i);
  assert.match((await skills.get('writing-plans')).content, /plan/i);
  assert.match((await skills.get('karpathy-guidelines')).content, /Think Before Coding/);
  const first = await prompts.assemble(), second = await prompts.assemble();
  assert.match(first.sections.find(row => row.name === 'ponytail').text, /level: lite/);
  assert.deepEqual(first.sections, second.sections, 'unchanged turns retain stable prompt prefix');
  for (const fiber of fibers.splice(1).reverse()) await fiber.dispose();
  assert.deepEqual(await skills.list(), []);
  assert.equal((await prompts.assemble()).sections.some(row => row.name === 'ponytail'), false);
});

test('packaged OpenSpec CLI runs inside a Windows-style workspace without global installation', async t => {
  const directory = await mkdtemp(join(tmpdir(), "nexus openspec ' workspace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../bin/openspec.js', import.meta.resolve('@fission-ai/openspec')));
  const exec = promisify(execFile), env = { ...process.env, OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', CI: 'true' };
  const version = await exec(process.execPath, [cli, '--version'], { cwd: directory, env, windowsHide: true, timeout: 30_000 });
  assert.match(version.stdout, /1\.15\.0/);
  await exec(process.execPath, [cli, 'init', '--tools', 'none'], { cwd: directory, env, windowsHide: true, timeout: 30_000 });
  assert.match(await readFile(join(directory, 'openspec/config.yaml'), 'utf8'), /schema:/);
  const definitions = [];
  openspec.apply({ skills: { register: value => definitions.push(value) } });
  assert.equal(definitions.length, 24);
  const skill = definitions.find(row => row.name === 'openspec-new-change');
  assert.match(skill.content, /node '[^']+\/bin\/openspec\.js' new change/);
  assert.doesNotMatch(skill.content, /`openspec new change/);
  assert.match(dirname(cli), /bin$/);
});

test('weekly inventory covers all source units, native archives and complete runtime plugin closure', async () => {
  const inventory = JSON.parse(await readFile('upstreams.json', 'utf8'));
  const sources = JSON.parse(await readFile('sources.lock.json', 'utf8'));
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  for (const source of sources.units) assert.ok(inventory.sources.some(row => row.id === source.id), source.id);
  for (const archive of sources.nativeArchives) assert.ok(inventory.sources.some(row => row.id === `archive:${archive.identity}`));
  for (const [name, version] of Object.entries(pkg.dependencies).filter(([name]) => /dsh-/.test(name) && !name.startsWith('@deepseek-ai/'))) {
    assert.equal(inventory.npmPlugins.find(row => row.package === name)?.pinned.version, version, name);
  }
  assert.equal(inventory.policy.independentUpdateUi, false);
  assert.equal(inventory.sources.find(row => row.id === 'archive:DSH-agent-procedures').repository, null);
  assert.equal(classifyVersion('0.2.5', '0.1.16'), 'older-tag');
  const report = await checkUpstreams([{ id: 'offline', package: 'dsh-test' }, { id: 'archive' }],
    { fetchJson: async () => { throw new Error('network unavailable'); } });
  assert.match(report.find(row => row.id === 'offline').npmError, /network/);
  assert.match(report.find(row => row.id === 'archive').unavailable, /not supplied/);
});

test('managed update adapters remove independent update entry points and reject upstream drift', async () => {
  for (const name of ['dsh-context', 'dsh-mnemon', '@michengai/dsh-agency-agents']) {
    const source = await readFile(`node_modules/${name}/lib/client.js`, 'utf8');
    const original = parseFactory(source, name).factory;
    const result = suppressManagedUpdateUi(name, original);
    const ast = ts.createSourceFile(`${name}.js`, result.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.deepEqual(ast.parseDiagnostics, []);
    assert.ok(result.changes.length);
    if (name === 'dsh-mnemon') {
      assert.match(result.source, /function VersionDialog\(\)\{return null\}/);
      assert.doesNotMatch(result.source, /action:.*t\("versions.checkAction"\)/);
      assert.match(result.source, /providers/, 'memory functionality remains');
    }
    if (name === 'dsh-context') assert.match(result.source, /function Zc\(\)\{return Promise.resolve\(null\)\}/);
    if (name.includes('agency')) {
      assert.match(result.source, /function Tc\(\)\{return null\}/);
      let bootstrap;
      const findBootstrap = node => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === 'Ec') bootstrap = node;
        ts.forEachChild(node, findBootstrap);
      };
      findBootstrap(ast);
      assert.ok(bootstrap);
      // Execute the retained bootstrap in a realm with no DOM/network globals.
      // It must install neither the updater's observer nor its eager GET.
      const dispose = Function(`${bootstrap.getText(ast)}; return Ec({})`)();
      assert.equal(typeof dispose, 'function');
      assert.doesNotThrow(dispose);
    }
    const symbols = { 'dsh-context': ['el', 'Zc'], 'dsh-mnemon': ['VersionDialog'], '@michengai/dsh-agency-agents': ['Tc', 'Ec'] }[name];
    for (const symbol of symbols) {
      const drifted = original.replace(`function ${symbol}(`, `function renamed_${symbol}(`);
      assert.notEqual(drifted, original, 'the mutation must rename this package’s actual managed updater');
      assert.throws(() => suppressManagedUpdateUi(name, drifted), /anchor|unique/);
    }
  }
});
