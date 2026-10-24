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
async function fixture({ legacy = true, current = false, scenario = '', running = false,
  hostVersion = '0.2.1-rc.3', upgradeScenario = '', example = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'noemaloom-install-'));
  const harness = join(root, 'Harness with spaces'), home = join(root, 'home');
  const profile = join(home, 'profiles/desktop');
  const cliDir = join(harness, 'resources/runtime/cli/bin');
  const delivery = join(root, 'delivery');
  await Promise.all([mkdir(cliDir, { recursive: true }), mkdir(profile, { recursive: true }), mkdir(delivery)]);
  await writeFile(join(harness, 'DeepSeek Harness.exe'), '');
  await writeFile(join(delivery, 'install-desktop.ps1'), await readFile(installer));
  await writeFile(join(delivery, 'install-example.ps1'), await readFile('scripts/install-desktop-example.ps1'));
  await writeFile(join(root, 'host-version.txt'), hostVersion);
  const hostPayload = Buffer.from('isolated official-installer test payload');
  const hostInstaller = join(root, 'official fixture installer.exe');
  await writeFile(hostInstaller, hostPayload);
  const hostUpgrade = {
    ...JSON.parse(await readFile('scripts/desktop-host-release.json', 'utf8')),
    size: hostPayload.length,
    sha512: createHash('sha512').update(hostPayload).digest('base64'),
  };
  const payload = Buffer.from('synthetic archive for installer contract tests');
  const digest = sha256(payload), packageFile = `dsh-noemaloom-0.4.0-${digest}.tgz`;
  await writeFile(join(delivery, packageFile), payload);
  const keyFiles = Array.from({ length: 8 }, (_, index) => ({
    path: `lib/runtime-${index}.js`, sha256: sha256(`runtime-${index}`),
  }));
  await writeFile(join(delivery, 'install-manifest.json'), JSON.stringify({
    schemaVersion: 1, packageName: newName, version: '0.4.0', hostVersion: '0.2.1-rc.3',
    packageFile, packageSha256: digest, keyFiles,
    hostUpgrade,
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
    if (args[0] === '--version') { console.log(await readFile(join(root,'host-version.txt'),'utf8')); process.exit(0); }
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
param([string]$Installer, [string]$HarnessDirectory, [string]$Mode, [string]$HostInstallerPath)
$ErrorActionPreference = 'Stop'
function Get-Process {
    param([string]$Name, [string]$ErrorAction)
    if ($env:NOEMALOOM_INSTALL_RUNNING -eq '1' -or
        (Test-Path -LiteralPath (Join-Path $env:NOEMALOOM_INSTALL_FIXTURE 'started-during-download'))) {
        [pscustomobject]@{ Id = 12345 }
    }
}
function Record-Upgrade($Value) {
    $json = $Value | ConvertTo-Json -Compress
    Add-Content -LiteralPath (Join-Path $env:NOEMALOOM_INSTALL_FIXTURE 'upgrade-calls.jsonl') -Value $json
}
function Invoke-WebRequest {
    param([switch]$UseBasicParsing,[string]$Uri,[string]$OutFile,[int]$TimeoutSec)
    $global:noemaloomFixtureDownloads++
    Record-Upgrade @{ operation='download'; url=$Uri; attempt=$global:noemaloomFixtureDownloads }
    if ($env:NOEMALOOM_UPGRADE_SCENARIO -eq 'download-failure' -or
        ($env:NOEMALOOM_UPGRADE_SCENARIO -eq 'download-retry' -and $global:noemaloomFixtureDownloads -lt 3)) { throw 'fixture network unavailable' }
    [IO.File]::Copy((Join-Path $env:NOEMALOOM_INSTALL_FIXTURE 'official fixture installer.exe'),$OutFile,$true)
    if ($env:NOEMALOOM_UPGRADE_SCENARIO -eq 'bad-download') { [IO.File]::WriteAllText($OutFile,'tampered') }
    if ($env:NOEMALOOM_UPGRADE_SCENARIO -eq 'host-starts') {
        [IO.File]::WriteAllText((Join-Path $env:NOEMALOOM_INSTALL_FIXTURE 'started-during-download'),'1')
    }
}
function Start-Sleep { param([int]$Seconds) Record-Upgrade @{operation='backoff';seconds=$Seconds} }
function Get-AuthenticodeSignature {
    param([string]$LiteralPath)
    Record-Upgrade @{operation='signature';path=$LiteralPath}
    $cert = [pscustomobject]@{}
    $cert | Add-Member -MemberType ScriptMethod -Name GetNameInfo -Value {
        param($NameType,$ForIssuer)
        if ($env:NOEMALOOM_UPGRADE_SCENARIO -eq 'wrong-publisher') { return 'Unrelated publisher' }
        return 'Hangzhou DeepSeek Artificial Intelligence Co., Ltd.'
    }
    [pscustomobject]@{Status=$(if($env:NOEMALOOM_UPGRADE_SCENARIO -eq 'bad-signature'){'NotSigned'}else{'Valid'});SignerCertificate=$cert}
}
function Start-Process {
    param([string]$FilePath,[string]$ArgumentList,[string]$WindowStyle,[switch]$PassThru,[switch]$Wait)
    Record-Upgrade @{operation='install-host';file=$FilePath;arguments=$ArgumentList;windowStyle=$WindowStyle;wait=[bool]$Wait}
    if ($env:NOEMALOOM_UPGRADE_SCENARIO -eq 'installer-failure') { return [pscustomobject]@{ExitCode=2} }
    if ($env:NOEMALOOM_UPGRADE_SCENARIO -ne 'wrong-version') {
        [IO.File]::WriteAllText((Join-Path $env:NOEMALOOM_INSTALL_FIXTURE 'host-version.txt'),'0.2.1-rc.3')
    }
    [pscustomobject]@{ExitCode=0}
}
$global:noemaloomFixtureDownloads=0
$options=@{HarnessDirectory=$HarnessDirectory}
if ($Mode -eq 'CheckOnly') { $options.CheckOnly=$true }
if ($Mode -eq 'VerifyOnly') { $options.VerifyOnly=$true }
if ($HostInstallerPath) { $options.HostInstallerPath=$HostInstallerPath }
& $Installer @options
`);
  return {
    root, initial, home, delivery, harness, hostInstaller,
    run: (mode, offline = false) => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper,
      '-Installer', join(delivery, example ? 'install-example.ps1' : 'install-desktop.ps1'), '-HarnessDirectory', harness, '-Mode', mode ?? 'Install',
      ...(offline ? ['-HostInstallerPath', hostInstaller] : [])],
    { windowsHide: true, timeout: 60000, env: { ...fixtureEnvironment, DSH_HOME: home,
      LOCALAPPDATA: join(root,'cache'), NOEMALOOM_INSTALL_FIXTURE: root,
      NOEMALOOM_INSTALL_SCENARIO: scenario, NOEMALOOM_UPGRADE_SCENARIO: upgradeScenario,
      NOEMALOOM_INSTALL_RUNNING: running ? '1' : '0' } }),
    profile: async () => JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')),
    calls: async () => (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse),
    upgradeCalls: async () => {
      try { return (await readFile(join(root, 'upgrade-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line.replace(/^\uFEFF/u,''))); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
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

const outputJson = text => JSON.parse(text.slice(text.indexOf('{')));

test('old Desktop precheck reports the pinned upgrade without downloading or changing data', windows, async t => {
  const f = await fixture({ hostVersion: '0.2.1-rc.2' });
  t.after(f.close);
  const result = outputJson((await f.run('CheckOnly')).stdout);
  assert.equal(result.hostVersion, '0.2.1-rc.2');
  assert.equal(result.targetHostVersion, '0.2.1-rc.3');
  assert.equal(result.hostUpgradeRequired, true);
  assert.equal(result.hostUpgrade.url, 'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.1-rc.3-win-x64.exe');
  assert.deepEqual(await f.upgradeCalls(), []);
  assert.deepEqual(await f.profile(), f.initial);
});

for (const hostVersion of ['0.2.0', '0.2.1-rc.2', '0.2.1-beta.10']) {
  test(`old Desktop ${hostVersion} upgrades in its original directory before plugin migration`, windows, async t => {
    const f = await fixture({ hostVersion });
    t.after(f.close);
    const result = outputJson((await f.run()).stdout);
    assert.equal(result.hostUpgraded, true);
    assert.equal(result.previousHostVersion, hostVersion);
    assert.equal(result.hostVersion, '0.2.1-rc.3');
    const calls = await f.upgradeCalls();
    assert.deepEqual(calls.map(row => row.operation), ['download','signature','install-host']);
    assert.equal(calls.at(-1).arguments, `/S /D=${f.harness}`);
    assert.equal(calls.at(-1).windowStyle, 'Hidden');
    assert.equal(calls.at(-1).wait, true);
    assert.deepEqual((await f.calls()).map(row => row[0]), ['--version','--version','plugin','plugin']);
    await f.assertData();
  });
}

for (const hostVersion of ['0.2.1-rc.10', '0.2.1', '0.3.0', '0.2.1-rc.3+build', '0.2.1-rc.02', 'unknown']) {
  test(`Desktop ${hostVersion} is never downgraded or guessed compatible`, windows, async t => {
    const f = await fixture({ hostVersion });
    t.after(f.close);
    await assert.rejects(f.run(), /requires exactly|Cannot compare|Invalid numeric/i);
    assert.deepEqual(await f.upgradeCalls(), []);
    assert.deepEqual(await f.profile(), f.initial);
  });
}

for (const mode of ['VerifyOnly','Install']) {
  test(`old Desktop ${mode} refuses mutation while verification-only or running`, windows, async t => {
    const f = await fixture({ hostVersion: '0.2.1-rc.2', running: mode === 'Install' });
    t.after(f.close);
    await assert.rejects(f.run(mode), /VerifyOnly never upgrades|Exit DeepSeek Harness completely/);
    assert.deepEqual(await f.upgradeCalls(), []);
    assert.deepEqual(await f.profile(), f.initial);
  });
}

for (const [upgradeScenario, expectedError] of [
  ['download-failure', /download failed after 3 attempts/],
  ['bad-download', /size mismatch/],
  ['bad-signature', /valid DeepSeek publisher signature/],
  ['wrong-publisher', /valid DeepSeek publisher signature/],
  ['installer-failure', /upgrade failed: exit 2/],
  ['wrong-version', /required bundled CLI version/],
  ['host-starts', /started while preparing/],
]) {
  test(`Desktop upgrade ${upgradeScenario} cannot reach plugin installation or change its data`, windows, async t => {
    const f = await fixture({ hostVersion: '0.2.1-rc.2', upgradeScenario });
    t.after(f.close);
    await assert.rejects(f.run(), expectedError);
    const upgradeCalls = await f.upgradeCalls();
    assert.equal(upgradeCalls.filter(row => row.operation === 'install-host').length,
      ['installer-failure','wrong-version'].includes(upgradeScenario) ? 1 : 0);
    assert.equal((await f.calls()).filter(row => row[0] === 'plugin').length, 0);
    assert.deepEqual(await f.profile(), f.initial);
    await f.assertData();
  });
}

test('Desktop download retries with backoff, verifies once, and reuses the verified cache', windows, async t => {
  const f = await fixture({ hostVersion: '0.2.1-rc.2', upgradeScenario: 'download-retry' });
  t.after(f.close);
  await f.run();
  const calls = await f.upgradeCalls();
  assert.equal(calls.filter(row => row.operation === 'download').length, 3);
  assert.deepEqual(calls.filter(row => row.operation === 'backoff').map(row => row.seconds), [2,4]);
  await writeFile(join(f.root,'host-version.txt'),'0.2.1-rc.2');
  await f.run();
  assert.equal((await f.upgradeCalls()).filter(row => row.operation === 'download').length, 3);
  await f.assertData();
});

test('delivery example forwards an offline official installer and readonly modes', windows, async t => {
  const f = await fixture({ hostVersion: '0.2.1-rc.2', example: true });
  t.after(f.close);
  await f.run('CheckOnly',true);
  assert.deepEqual(await f.upgradeCalls(), []);
  const result = outputJson((await f.run('Install',true)).stdout);
  assert.equal(result.hostUpgraded, true);
  assert.deepEqual((await f.upgradeCalls()).map(row => row.operation), ['signature','install-host']);
  assert.equal((await f.upgradeCalls())[1].file, f.hostInstaller);
  assert.equal(outputJson((await f.run('VerifyOnly')).stdout).status, 'INSTALLED_FILES_VERIFIED');
});

test('invalid pinned download metadata and corrupted offline installers are rejected', windows, async t => {
  for (const kind of ['metadata','offline']) {
    const f = await fixture({ hostVersion:'0.2.1-rc.2' });
    t.after(f.close);
    if (kind === 'metadata') {
      const path = join(f.delivery,'install-manifest.json');
      const manifest = JSON.parse(await readFile(path,'utf8'));
      manifest.hostUpgrade.url='https://unrelated.invalid/installer.exe';
      await writeFile(path,JSON.stringify(manifest));
    } else await writeFile(f.hostInstaller,'corrupted');
    await assert.rejects(f.run('Install',kind === 'offline'), /Invalid pinned|size mismatch/);
    assert.deepEqual(await f.upgradeCalls(), []);
    assert.deepEqual(await f.profile(),f.initial);
  }
});
