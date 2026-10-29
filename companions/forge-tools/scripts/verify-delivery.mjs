import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'forge-delivery-check-'));
function run(executable, args, env) {
  const result = spawnSync(executable, args, { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}
async function assertAbsent(target) {
  await assert.rejects(access(target), error => error.code === 'ENOENT', `${target} must not exist`);
}
try {
  run('tar', ['-xf', path.join(root, 'delivery/dsh-forge-tools-0.1.5-win-x64.zip'), '-C', temporary]);
  const payload = await readdir(temporary);
  assert.ok(!payload.some(filename => /\.(?:png|jpe?g|webp|gif|bmp|ico|svg|avif)$/i.test(filename)),
    'Desktop archive must not ship screenshots or other images');
  assert.deepEqual(payload.filter(filename => filename.endsWith('.tgz')), ['local-dsh-forge-tools-0.1.5.tgz'],
    'Desktop delivery must contain exactly one complete Tools package');
  assert.ok(!payload.some(filename => /^cli(?:-pwsh)?\.patch\.yml$/i.test(filename)),
    'Desktop delivery must not contain CLI overlays');
  const packageInventory = JSON.parse(await readFile(path.join(temporary, 'package-inventory.json'), 'utf8'));
  assert.equal(packageInventory.packages.length, 1, 'Inventory must advertise one complete package');
  assert.equal(packageInventory.packages[0].filename, 'local-dsh-forge-tools-0.1.5.tgz');
  const tarball = path.join(temporary, packageInventory.packages[0].filename);
  const tarFiles = run('tar', ['-tf', tarball], process.env).trim().split(/\r?\n/);
  assert.ok(!tarFiles.some(filename => /\.(?:png|jpe?g|webp|gif|bmp|ico|svg|avif)$/i.test(filename)),
    'The npm package must not ship screenshot evidence or other images');
  assert.ok(!tarFiles.some(filename => /(?:^|\/)(?:forge-pwsh\.patch\.yml|pwsh-plugin\.[cm]?js)$/i.test(filename)),
    'The npm package must not expose a partial PowerShell entry point or preset');
  assert.deepEqual(tarFiles.map(filename => filename.replace(/^package\//, '')).sort(),
    packageInventory.packages[0].files.slice().sort(), 'Actual tgz files must match the packaged inventory');
  const checkedFiles = new Set();
  const sums = await readFile(path.join(temporary, 'SHA256SUMS.txt'), 'utf8');
  for (const line of sums.trim().split(/\r?\n/)) {
    const [expected, filename] = line.split('  ');
    assert.ok(filename && !filename.includes('/') && !filename.includes('\\'));
    const actual = createHash('sha256').update(await readFile(path.join(temporary, filename))).digest('hex');
    assert.equal(actual, expected, filename);
    checkedFiles.add(filename);
  }
  assert.deepEqual(payload.filter(filename => filename !== 'SHA256SUMS.txt').sort(), [...checkedFiles].sort(),
    'Every archive payload must be covered by SHA256SUMS.txt');
  const installerPath = path.join(temporary, 'Install.ps1');
  const examplePath = path.join(temporary, 'Install-Example.ps1');
  await access(examplePath);
  await access(path.join(temporary, 'INSTALL_FOR_AI.md'));
  const installerBytes = await readFile(installerPath);
  const installerHash = createHash('sha256').update(installerBytes).digest('hex');
  const installer = installerBytes.toString('utf8');
  assert.ok(!/\$Profile\b/.test(installer), 'Installer must use Desktop exclusively');
  assert.match(installer, /'--profile', 'desktop'/);
  const install = process.env.FORGE_DSH_ROOT ?? 'D:/Program Files/DeepSeek Harness';
  const dshCommand = path.join(install, 'resources/runtime/cli/bin/dsh.cmd');
  const guardHome = path.join(temporary, 'guard-home');
  const guardAgentsHome = path.join(temporary, 'guard-agents');
  await assertAbsent(guardHome);
  await assertAbsent(guardAgentsHome);
  const inventory = run('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$items = @(Microsoft.PowerShell.Management\\Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue); Write-Output ('FORGE_DESKTOP_COUNT=' + $items.Count)"],
    process.env);
  const inventoryMatch = /^FORGE_DESKTOP_COUNT=(\d+)\s*$/m.exec(inventory);
  assert.ok(inventoryMatch, 'Real process inventory must return its count sentinel');
  const desktopRunning = Number(inventoryMatch[1]) > 0;
  if (desktopRunning) {
    const guardResult = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      installerPath, '-Variant', 'Tools', '-DshCommand', dshCommand], {
      env: { ...process.env, DSH_HOME: guardHome, DSH_AGENTS_HOME: guardAgentsHome, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.notEqual(guardResult.status, 0, 'The unmodified installer must reject the actual running Desktop');
    assert.match(`${guardResult.stdout}${guardResult.stderr}`, /Please fully exit DeepSeek Harness Desktop/,
      'No test process inventory is used for the direct guard case');
    console.log('Actual running-Desktop guard verified with the untouched ZIP installer; guard homes were never created.');
  } else {
    console.log('No Desktop is running: real running-Desktop guard case explicitly skipped. Both full-package installer entry points will run directly without a process inventory stub.');
  }
  await assertAbsent(guardHome);
  await assertAbsent(guardAgentsHome);

  // The user's Desktop owns another home. Test the actual packaged installer
  // against two new homes without changing that process or shipping a bypass.
  const harnessPath = path.join(temporary, 'isolated-installer-harness.ps1');
  if (desktopRunning) await writeFile(harnessPath, `param(
    [Parameter(Mandatory=$true)][string]$InstallerPath,
    [Parameter(Mandatory=$true)][ValidateSet('Tools','PowerShell')][string]$Variant,
    [Parameter(Mandatory=$true)][string]$DshCommand,
    [Parameter(Mandatory=$true)][string]$ExpectedDshHome,
    [Parameter(Mandatory=$true)][string]$ExpectedAgentsHome
)
$ErrorActionPreference = 'Stop'
$inventoryStubState = [pscustomobject]@{ Calls = 0 }
function Get-Process {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][ValidateSet('DeepSeek Harness')][string]$Name)
    if ($PSBoundParameters.Count -ne 2 -or -not $PSBoundParameters.ContainsKey('ErrorAction') -or
        $Name -cne 'DeepSeek Harness' -or "$($PSBoundParameters.ErrorAction)" -cne 'SilentlyContinue') {
        throw 'Unexpected process inventory request in isolated installer test'
    }
    $actualDshHome = [IO.Path]::GetFullPath($env:DSH_HOME)
    $actualAgentsHome = [IO.Path]::GetFullPath($env:DSH_AGENTS_HOME)
    if (-not [string]::Equals($actualDshHome, [IO.Path]::GetFullPath($ExpectedDshHome), [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($actualAgentsHome, [IO.Path]::GetFullPath($ExpectedAgentsHome), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Process inventory stub may only be used for its exact fresh isolated test homes'
    }
    $inventoryStubState.Calls++
    return @()
}
& $InstallerPath -Variant $Variant -DshCommand $DshCommand
if ($inventoryStubState.Calls -ne 1) { throw 'Expected exactly one isolated process inventory call' }
`);
  if (desktopRunning)
    console.log('Offline installation scope: test-only Get-Process stub returns empty only for DeepSeek Harness in the exact fresh isolated homes. The ZIP installer, checksum, bundled CLI and package manager are unmodified.');
  for (const variant of ['Tools', 'PowerShell']) {
    const env = { ...process.env, DSH_HOME: path.join(temporary, `product-home-${variant}`),
      DSH_AGENTS_HOME: path.join(temporary, `agents-${variant}`), ELECTRON_RUN_AS_NODE: '1' };
    await assertAbsent(env.DSH_HOME);
    await assertAbsent(env.DSH_AGENTS_HOME);
    const profile = path.join(env.DSH_HOME, 'profiles', 'desktop');
    // Electron owns this reserved profile. Reproduce its exact initProfile
    // template only in the isolated test home; never ask CLI to launch it.
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop', private: true, dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2) + '\n');
    await writeFile(path.join(profile, 'cordis.patch.yml'),
      '# Your patch layer for this dsh profile, applied after every bundle layer:\n'
      + '# a top-level YAML array of loader patch entries (id-targeted config\n'
      + '# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n');
    await writeFile(path.join(profile, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
    const installerArgs = desktopRunning
      ? ['-File', harnessPath, '-InstallerPath', examplePath, '-Variant', variant, '-DshCommand', dshCommand,
        '-ExpectedDshHome', env.DSH_HOME, '-ExpectedAgentsHome', env.DSH_AGENTS_HOME]
      : ['-File', examplePath, '-Variant', variant, '-DshCommand', dshCommand];
    const result = run('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', ...installerArgs], env);
    console.log(result.trim());
    const config = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8'));
    const packageName = '@local/dsh-forge-tools';
    assert.ok(config.dsh.profile.bundles.includes(packageName), `Desktop configuration must enable ${packageName}`);
    assert.ok(Object.hasOwn(config.dependencies, packageName), `Desktop must install ${packageName}`);
    assert.ok(!Object.hasOwn(config.dependencies, '@local/dsh-forge-pwsh'),
      'The legacy PowerShell selector must not install the retired partial package');
    assert.ok(!config.dsh.profile.bundles.includes('@local/dsh-forge-pwsh'));
    const installedRoot = path.join(profile, 'node_modules', packageName);
    const installed = JSON.parse(await readFile(path.join(installedRoot, 'package.json'), 'utf8'));
    assert.equal(installed.name, packageName);
    assert.equal(installed.version, '0.1.5');
    await access(path.join(installedRoot, 'bin/rg.exe'));
    assert.match(run(path.join(installedRoot, 'bin/rg.exe'), ['--version'], env), /^ripgrep /);
    const patch = await readFile(path.join(installedRoot, 'cordis.patch.yml'), 'utf8');
    assert.match(patch, /id: preset-standard\b/, 'Full Tools must replace the official standard composition');
    assert.match(patch, /name: ['"]?@local\/dsh-forge-tools['"]?/);
    assert.ok(!/\bshellOnly:/.test(patch), 'The shipped preset must have no partial-operation mode');
    for (const operation of ['read', 'write', 'edit'])
      assert.match(patch, new RegExp(`\\b${operation}: false\\b`), `Original ${operation} must be disabled`);
    assert.match(patch, /\breadImage: true\b/, 'Original image tool must remain available');
    assert.ok(!/@deepseek-ai\/dsh-tool-(?:fs-search|pwsh)\b/.test(patch),
      'Original file search and PowerShell plugins must be replaced');
    await assertAbsent(path.join(installedRoot, 'presets/forge-pwsh.patch.yml'));
    await assertAbsent(path.join(installedRoot, 'lib/pwsh-plugin.js'));
    assert.equal(createHash('sha256').update(await readFile(installerPath)).digest('hex'), installerHash,
      'The verified ZIP installer must remain byte-for-byte unchanged');
    console.log(JSON.stringify({ variant, legacyPowerShellAlias: variant === 'PowerShell',
      fullToolsResourcesAndReplacementManifest: 'passed',
      exampleScript: 'passed', offlineInstall: 'passed', installedPackage: installed.name,
      version: installed.version, enabledBundles: config.dsh.profile.bundles,
      processInventoryStub: desktopRunning, runningDesktopGuard: desktopRunning ? 'passed with actual processes' : 'skipped: no Desktop running',
      scope: desktopRunning ? 'Fresh isolated homes only; actual running-Desktop rejection verified separately.'
        : 'Fresh isolated homes; untouched installer invoked directly without process inventory stub.' }));
  }
  console.log(`Image-free single-package Desktop archive, all payload checksums, and Tools plus legacy PowerShell installer entry points in isolated homes passed. ${
    desktopRunning ? 'Actual running-Desktop guard passed; installation cases used the explicitly scoped test-only process inventory stub.'
      : 'Running-Desktop guard explicitly skipped because none was running; installation cases used no process inventory stub.'}`);
} finally {
  const relative = path.relative(os.tmpdir(), temporary);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(temporary).startsWith('forge-delivery-check-'))
    throw new Error('Unsafe temporary delivery cleanup path');
  await rm(temporary, { recursive: true, force: true });
}
