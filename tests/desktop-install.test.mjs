import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const installer = resolve('scripts/install-desktop.ps1');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const windows = { skip: process.platform !== 'win32' };
const oldName = '@local/dsh-nexus', newName = 'dsh-noemaloom';
// The runner uses PowerShell 7. A Windows PowerShell 5.1 child must discover its
// own built-in modules, rather than inherit incompatible Core module paths.
const fixtureEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
  PSModulePath: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/Modules'),
};

// Exercise the real PowerShell installer against an isolated CLI/profile.
// Native package-manager selection reconciliation is represented here; no
// invocation reaches the user's DSH executable, profile, or live processes.
async function fixture({ legacy = true, current = false, scenario = '', running = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'noemaloom-install-'));
  const harness = join(root, 'Harness with spaces'), home = join(root, 'home');
  const profile = join(home, 'profiles/desktop');
  const cliDir = join(harness, 'resources/runtime/cli/bin');
  const delivery = join(root, 'delivery');
  await Promise.all([mkdir(cliDir, { recursive: true }), mkdir(profile, { recursive: true }), mkdir(delivery)]);
  await writeFile(join(harness, 'DeepSeek Harness.exe'), '');
  await writeFile(join(delivery, 'install-desktop.ps1'), await readFile(installer));
  const payload = Buffer.from('synthetic archive for installer contract tests');
  const digest = sha256(payload), packageFile = `dsh-noemaloom-0.4.0-${digest}.tgz`;
  await writeFile(join(delivery, packageFile), payload);
  const keyFiles = Array.from({ length: 8 }, (_, index) => ({
    path: `lib/runtime-${index}.js`, sha256: sha256(`runtime-${index}`),
  }));
  await writeFile(join(delivery, 'install-manifest.json'), JSON.stringify({
    schemaVersion: 1, packageName: newName, version: '0.4.0', hostVersion: '0.2.1-rc.3',
    packageFile, packageSha256: digest, keyFiles,
  }));
  const initial = { name: 'isolated-installer-fixture', private: true,
    dependencies: { unrelated: '1.0.0', ...(legacy ? { [oldName]: 'file:old.tgz' } : {}),
      ...(current ? { [newName]: 'file:previous.tgz' } : {}) },
    dsh: { profile: { bundles: ['unrelated', ...(legacy ? [oldName] : []), ...(current ? [newName] : [])] } },
  };
  await writeFile(join(profile, 'package.json'), JSON.stringify(initial));
  const userData = join(profile, 'data/nexus/user-settings.json');
  await mkdir(join(profile, 'data/nexus'), { recursive: true });
  await writeFile(userData, '{"keep":"existing-settings-and-data"}\n');
  const patch = join(profile, 'cordis.patch.yml');
  await writeFile(patch, '- id: nexus\n  config:\n    modelWindowTokens: 1048576\n');
  await writeFile(join(cliDir, 'dsh.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0fixture-cli.mjs" %*\r\n`);
  await writeFile(join(cliDir, 'fixture-cli.mjs'), `
    import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
    import { join } from 'node:path';
    const args = process.argv.slice(2);
    const root = process.env.NOEMALOOM_INSTALL_FIXTURE;
    const profile = join(root, 'home/profiles/desktop');
    const scenario = process.env.NOEMALOOM_INSTALL_SCENARIO;
    await appendFile(join(root, 'calls.jsonl'), JSON.stringify(args) + '\\n');
    if (args[0] === '--version') { console.log('0.2.1-rc.3'); process.exit(0); }
    const oldName = '@local/dsh-nexus', newName = 'dsh-noemaloom';
    const manifestPath = join(profile, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (args[0] !== 'plugin' || args[1] !== '--profile' || args[2] !== 'desktop') process.exit(9);
    if (args[3] === 'add') {
      if (scenario === 'add-failure') process.exit(3);
      const packageRoot = join(profile, 'node_modules', newName);
      await mkdir(join(packageRoot, 'lib'), { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: newName, version: '0.4.0' }));
      for (let index = 0; index < 8; index++) await writeFile(join(packageRoot, 'lib', 'runtime-' + index + '.js'),
        scenario === 'bad-files' ? 'bad' : 'runtime-' + index);
      const newlyAdded = !Object.hasOwn(manifest.dependencies, newName);
      manifest.dependencies[newName] = 'file:' + args[4];
      if (newlyAdded) manifest.dsh.profile.bundles.push(newName);
    } else if (args[3] === 'remove') {
      if (args[4] === oldName && scenario === 'remove-failure') process.exit(4);
      delete manifest.dependencies[args[4]];
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== args[4]);
    } else process.exit(10);
    await writeFile(manifestPath, JSON.stringify(manifest));
  `);
  const wrapper = join(root, 'invoke.ps1');
  await writeFile(wrapper, `
param([string]$Installer, [string]$HarnessDirectory, [string]$Mode)
$ErrorActionPreference = 'Stop'
function Get-Process {
    param([string]$Name, [string]$ErrorAction)
    if ($env:NOEMALOOM_INSTALL_RUNNING -eq '1') { [pscustomobject]@{ Id = 12345 } }
}
if ($Mode -eq 'CheckOnly') { & $Installer -HarnessDirectory $HarnessDirectory -CheckOnly }
elseif ($Mode -eq 'VerifyOnly') { & $Installer -HarnessDirectory $HarnessDirectory -VerifyOnly }
else { & $Installer -HarnessDirectory $HarnessDirectory }
`);
  return {
    root, initial, home, delivery,
    run: mode => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper,
      '-Installer', join(delivery, 'install-desktop.ps1'), '-HarnessDirectory', harness, '-Mode', mode ?? 'Install'],
    { windowsHide: true, timeout: 60000, env: { ...fixtureEnvironment, DSH_HOME: home,
      NOEMALOOM_INSTALL_FIXTURE: root, NOEMALOOM_INSTALL_SCENARIO: scenario, NOEMALOOM_INSTALL_RUNNING: running ? '1' : '0' } }),
    profile: async () => JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')),
    calls: async () => (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse),
    assertData: async () => {
      assert.equal(await readFile(userData, 'utf8'), '{"keep":"existing-settings-and-data"}\n');
      assert.equal(await readFile(patch, 'utf8'), '- id: nexus\n  config:\n    modelWindowTokens: 1048576\n');
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test('Desktop rename precheck never modifies a profile or calls package management', windows, async t => {
  const f = await fixture();
  t.after(f.close);
  const result = JSON.parse((await f.run('CheckOnly')).stdout);
  assert.equal(result.packageName, newName);
  assert.equal(result.legacyMigrationRequired, true);
  assert.equal(result.profileModified, false);
  assert.deepEqual(await f.profile(), f.initial);
  assert.deepEqual(await f.calls(), [['--version']]);
  await f.assertData();
});

for (const options of [{ legacy: true }, { legacy: false }, { legacy: false, current: true }]) {
  test(`Desktop installs one Noemaloom registration: ${JSON.stringify(options)}`, windows, async t => {
    const f = await fixture(options);
    t.after(f.close);
    const result = JSON.parse((await f.run()).stdout);
    assert.equal(result.status, 'INSTALLED_AND_FILES_VERIFIED');
    assert.equal(result.packageName, newName);
    const profile = await f.profile();
    assert(!Object.hasOwn(profile.dependencies, oldName));
    assert(Object.hasOwn(profile.dependencies, newName));
    assert.equal(profile.dependencies.unrelated, '1.0.0');
    assert.deepEqual(profile.dsh.profile.bundles, ['unrelated', newName]);
    const operations = (await f.calls()).filter(args => args[0] === 'plugin');
    assert.deepEqual(operations.map(args => args[3]), options.legacy ? ['add', 'remove'] : ['add']);
    assert.equal(JSON.parse((await f.run('VerifyOnly')).stdout).status, 'INSTALLED_FILES_VERIFIED');
    assert.equal((await f.calls()).filter(args => args[0] === 'plugin').length, operations.length);
    await f.assertData();
  });
}

for (const scenario of ['add-failure', 'bad-files', 'remove-failure']) {
  test(`Desktop rename retains the old registration on ${scenario}`, windows, async t => {
    const f = await fixture({ scenario });
    t.after(f.close);
    await assert.rejects(f.run(), /failed|differs/i);
    assert.deepEqual(await f.profile(), f.initial);
    const operations = (await f.calls()).filter(args => args[0] === 'plugin');
    if (scenario === 'add-failure') assert.deepEqual(operations.map(args => args[3]), ['add']);
    else assert.equal(operations.at(-1)[4], newName, 'withdraw only the newly added replacement');
    await f.assertData();
  });
}

test('Desktop rename refuses installation while the host is running', windows, async t => {
  const f = await fixture({ running: true });
  t.after(f.close);
  await assert.rejects(f.run(), /Exit DeepSeek Harness completely/);
  assert.deepEqual(await f.profile(), f.initial);
  assert.deepEqual(await f.calls(), [['--version']]);
});
