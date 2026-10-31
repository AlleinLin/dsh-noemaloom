import { spawn, spawnSync, execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const install = process.env.FORGE_DSH_ROOT ?? 'D:/Program Files/DeepSeek Harness';
const executable = path.join(install, 'DeepSeek Harness.exe');
const runtime = path.join(install, 'resources/app.asar/dsh');
const host = path.join(runtime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js');
const cli = path.join(runtime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
const primaryRuntime = path.join(install, 'resources/runtime/primary-runtime');
const pnpm = path.join(primaryRuntime, 'dependencies/pnpm/bin/pnpm.mjs');
const nodeBin = path.join(install, 'resources/runtime/bin');
await access(executable);
const packageManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const runtimeVersion = spawnSync(executable, ['--expose-internals', cli, '--version'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8', windowsHide: true, timeout: 30000,
});
assert.equal(runtimeVersion.status, 0, 'Official Desktop must report its own version');
assert.equal(runtimeVersion.stdout.trim(), packageManifest.engines.dsh,
  'Do not spoof the Desktop version or use an unreviewed SDK');
for (const section of ['peerDependencies', 'devDependencies'])
  for (const [name, version] of Object.entries(packageManifest[section]))
    if (name.startsWith('@deepseek-ai/dsh-'))
      assert.equal(version, packageManifest.engines.dsh, `${name}: SDK/engine drift`);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'forge-desktop-host-'));
const report = {
  host: '0.2.1-rc.5',
  platform: 'win32-x64',
  installedRuntime: install,
  validation: 'Actual installed Desktop Host entry point and IPC lifecycle, using isolated DSH_HOME/profiles/desktop. This check does not launch the Electron GUI.',
  privacy: 'No real user profile, credentials, conversations or model requests are used.',
  cases: [],
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const redact = text => text
  .replace(/https?:\/\/[^\s"'<>]+/gi, '[url redacted]')
  .replace(/(token|authorization|password|secret)[^\r\n]*/gi, '$1=[redacted]');

function launch(env, args) {
  const result = spawnSync(executable, ['--expose-internals', cli, ...args], {
    env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  if (result.status !== 0)
    throw new Error(`${args.join(' ')} failed: ${redact(result.stderr || result.stdout || '').slice(0, 2000)}`);
  return result.stdout;
}

async function audit(env, label) {
  const profile = path.join(env.DSH_HOME, 'profiles/desktop');
  const resultFile = path.join(temporary, `${label}-audit.json`);
  const pluginFile = path.join(temporary, `${label}-audit.mjs`);
  // The audit lives only in this temporary profile. It does not create an Agent
  // or make a model request; public preset revision leases expose scoped tools.
  await writeFile(pluginFile, `import{writeFile}from'node:fs/promises';
export const inject=['agentPresets','tools'];
export function apply(ctx){const timer=setTimeout(async()=>{
 const report={profile:ctx.get('profileContext')?.name,presets:[],scopes:[]};
 try{
  report.defaultPreset=(await ctx.agentPresets.resolve()).id;
  report.presets=await ctx.agentPresets.list();
  let lease;
  try{
   lease=await ctx.agentPresets.acquireScope('standard');
   report.scopes.push({id:'standard',names:ctx.tools.schemas(lease.key).map(x=>x.name).sort(),
    readDescription:ctx.tools.get('read',lease.key)?.description,
    writeDescription:ctx.tools.get('write',lease.key)?.description,
    editDescription:ctx.tools.get('edit',lease.key)?.description,
    globDescription:ctx.tools.get('glob',lease.key)?.description,
    grepDescription:ctx.tools.get('grep',lease.key)?.description,
    pwshDescription:ctx.tools.get('pwsh',lease.key)?.description});
  }finally{await lease?.[Symbol.asyncDispose]();}
 }catch(error){report.error=String(error.message);}
 await writeFile(${JSON.stringify(resultFile)},JSON.stringify(report,null,2));
},500);ctx.effect(()=>()=>clearTimeout(timer));}
`);
  await writeFile(path.join(profile, 'cordis.patch.yml'),
    `- insert:\n    - id: forge-test-audit\n      name: ${JSON.stringify(pluginFile.replaceAll('\\', '/'))}\n`);

  // Match the shell's DesktopHostProcess.start(), including the immutable
  // runtime, primary dependencies, package manager and private IPC channel.
  const child = spawn(executable, [
    '--expose-internals', host, runtime, profile, primaryRuntime, pnpm, nodeBin,
  ], {
    cwd: profile, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  let exit;
  let ready = false;
  let shutdownComplete = false;
  child.stdout.on('data', data => { output = (output + data).slice(-20000); });
  child.stderr.on('data', data => { output = (output + data).slice(-20000); });
  child.on('message', message => {
    // The ready URL and platform-session messages can carry localhost auth
    // tokens. Deliberately retain no message bodies or URLs.
    if (message?.type === 'ready') ready = true;
    if (message?.type === 'shutdown-complete') shutdownComplete = true;
    if (message?.type === 'fatal') output += `\n${redact(String(message.message))}`;
  });
  child.on('error', error => { output += `\n${redact(error.message)}`; });
  const closed = new Promise(resolve => child.once('close', code => { exit = code; resolve(); }));
  let result;
  try {
    for (let i = 0; i < 400; i++) {
      if (ready) {
        try { result = JSON.parse(await readFile(resultFile, 'utf8')); break; }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      }
      if (exit !== undefined) break;
      await pause(100);
    }
    if (!result) throw new Error(`Desktop Host audit did not complete: ${redact(output).slice(-3000)}`);
  } finally {
    if (exit === undefined && child.connected)
      await new Promise(resolve => child.send({ type: 'shutdown' }, () => resolve()));
    if (exit === undefined) await Promise.race([closed, pause(10000)]);
    if (exit === undefined) {
      await new Promise(resolve => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true }, () => resolve()));
      await closed;
    }
  }
  assert.equal(exit, 0, `${label}: Desktop Host did not exit cleanly`);
  assert.equal(shutdownComplete, true, `${label}: Desktop Host did not acknowledge teardown`);
  assert.equal(result.profile, 'desktop', `${label}: wrong runtime profile`);
  assert.equal(result.error, undefined, `${label}: ${result.error}`);
  assert.equal(result.defaultPreset, 'standard', `${label}: default preset identity changed`);
  assert.ok(result.presets.every(entry => !entry.broken), JSON.stringify(result.presets));
  assert.equal(result.presets.filter(entry => entry.id === 'standard').length, 1);
  result.lifecycle = { ready: true, shutdownAcknowledged: true, exitCode: exit };
  return result;
}

try {
  for (const [variant, pkg, packageName] of [
    ['Tools', 'local-dsh-forge-tools-0.1.6.tgz', '@local/dsh-forge-tools'],
  ]) {
    const home = path.join(temporary, variant);
    const env = {
      ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1',
      DSH_AGENTS_HOME: path.join(home, 'agents'),
      DSH_CLIENT_VERSION: '0.2.1-rc.5',
    };
    // The CLI deliberately refuses to launch the Electron-owned desktop
    // profile. Reproduce Desktop's exact initProfile files in this isolated
    // home; subsequent checks boot the real desktop-host/index.js.
    const profile = path.join(home, 'profiles/desktop');
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop', private: true, dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2) + '\n');
    await writeFile(path.join(profile, 'cordis.patch.yml'), '[]\n');
    await writeFile(path.join(profile, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
    const original = await audit(env, `${variant}-original`);
    const baseline = original.scopes[0];
    const installed = launch(env, ['plugin', '--profile', 'desktop', 'add',
      '--offline', '--ignore-scripts', '--save-exact', path.join(root, 'delivery', pkg)]);
    assert.ok(!/missing peer|issues with peer dependencies/i.test(installed));
    const active = await audit(env, `${variant}-installed`);
    const own = active.scopes[0];
    assert.deepEqual(active.presets.map(entry => entry.id).sort(),
      original.presets.map(entry => entry.id).sort(), 'No extra preset selection should be required');
    for (const tool of baseline.names)
      assert.ok(own.names.includes(tool), `${variant}: lost original tool ${tool}`);
    for (const required of ['read', 'write', 'edit', 'glob', 'grep', 'read_image',
      'job_list', 'pwsh', 'pwsh_run', 'forge_status'])
      assert.ok(own.names.includes(required), `${variant}: missing ${required}`);
    assert.match(own.pwshDescription, /literal|native|PowerShell 7/);
    assert.notEqual(own.pwshDescription, baseline.pwshDescription);
    for (const required of ['read_many', 'batch_edit', 'list_directory'])
      assert.ok(own.names.includes(required), `${variant}: missing full Tools operation ${required}`);
    assert.match(own.readDescription, /bounded cache/);
    for (const field of ['readDescription', 'writeDescription', 'editDescription',
      'globDescription', 'grepDescription', 'pwshDescription'])
      assert.notEqual(own[field], baseline[field], `${variant}: ${field} still uses the original tool`);
    assert.equal(baseline.names.length, 31, 'The validated rc.5 Desktop baseline has 31 tools');
    assert.equal(own.names.length, 36, 'The full Tools package must expose all 36 tools');

    launch(env, ['plugin', '--profile', 'desktop', 'remove', packageName]);
    const restored = await audit(env, `${variant}-uninstalled`);
    assert.deepEqual(restored.scopes, original.scopes, `${variant}: original tools were not restored`);
    assert.deepEqual(restored.presets, original.presets, `${variant}: original preset roster was not restored`);
    const manifest = JSON.parse(await readFile(path.join(home, 'profiles/desktop/package.json'), 'utf8'));
    assert.ok(!Object.hasOwn(manifest.dependencies ?? {}, packageName));
    assert.ok(!manifest.dsh?.profile?.bundles?.includes(packageName));
    report.cases.push({
      variant, package: pkg, profile: 'desktop', preset: 'standard',
      offlineInstall: 'passed', defaultPresetActivation: 'passed',
      noPresetSwitchRequired: true, originalToolsPreserved: true,
      originalToolCount: baseline.names.length, replacementToolCount: own.names.length,
      scopedTools: own.names, lifecycle: active.lifecycle,
      uninstallRollback: 'passed',
    });
  }
  report.result = 'passed';
  await mkdir('docs', { recursive: true });
  await writeFile('docs/host-validation.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  const relative = path.relative(os.tmpdir(), temporary);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(temporary).startsWith('forge-desktop-host-'))
    throw new Error('Unsafe temporary home cleanup path');
  await rm(temporary, { recursive: true, force: true });
}
