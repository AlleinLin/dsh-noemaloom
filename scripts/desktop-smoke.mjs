import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectTarget, until, completeSyntheticOnboarding } from './desktop-cdp.mjs';
import { EXPECTED_DSH_VERSION } from '../src/shared/host-compatibility.ts';
import { sourceIdentity } from '../tools/acceptance/core.mjs';

// Exercise the real Desktop executable in a fresh synthetic profile. Never
// copy the user's profile, submit a message, or contact a model endpoint.
const harnessDirectory = process.env.NEXUS_DSH_ROOT ?? join(process.env.ProgramFiles ?? 'C:/Program Files', 'DeepSeek Harness');
const executable = join(harnessDirectory, 'DeepSeek Harness.exe');
const cli = join(harnessDirectory, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const source = await sourceIdentity(resolve('.'));
const packagePath = resolve(process.argv[2] ?? `artifacts/dsh-noemaloom-${manifest.version}.tgz`);
const temporary = await mkdtemp(join(tmpdir(), 'nexus-original-desktop-'));
const productHome = join(temporary, 'home'), userData = join(temporary, 'electron');
const profile = join(productHome, 'profiles', 'desktop'), workspace = join(temporary, 'workspace');
const evidence = resolve('evidence/private-desktop-inspection');
await mkdir(profile, { recursive: true }); await mkdir(workspace); await mkdir(evidence, { recursive: true });
await writeFile(join(profile, 'package.json'), JSON.stringify({
  name: 'nexus-disposable-desktop-profile', private: true, dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}, null, 2));
await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|CREDENTIAL)/i.test(name)));
Object.assign(env, {
  DSH_HOME: productHome, DSH_AGENTS_HOME: join(temporary, 'agents'),
  MNEMON_DATA_DIR: join(temporary, 'mnemon'), ELECTRON_RUN_AS_NODE: '1',
});
const version = spawnSync(executable, ['--expose-internals', cli, '--version'],
  { env, windowsHide: true, encoding: 'utf8', timeout: 30_000 });
if (version.status !== 0 || version.stdout.trim() !== EXPECTED_DSH_VERSION
  || manifest.engines.dsh !== EXPECTED_DSH_VERSION)
  throw new Error(`Desktop release mismatch: ${version.stdout?.trim()}; expected ${EXPECTED_DSH_VERSION}`);
const runtime = spawnSync(executable, ['--expose-internals', '-e',
  'console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron,chrome:process.versions.chrome,abi:process.versions.modules}))'],
  { env, windowsHide: true, encoding: 'utf8', timeout: 30_000 });
if (runtime.status !== 0) throw new Error('Actual Desktop runtime could not be observed');
const environment = { observedFrom: 'desktop-process', hostVersion: version.stdout.trim(), ...JSON.parse(runtime.stdout.trim()) };
const installed = spawnSync(executable, ['--expose-internals', cli, 'plugin', '--profile', 'desktop', 'add', '--ignore-scripts', '--save-exact', packagePath],
  { env, windowsHide: true, encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
await writeFile(join(evidence, 'smoke-install.log'), (installed.stdout ?? '') + (installed.stderr ?? ''));
if (installed.status !== 0) throw new Error(`Disposable desktop install failed: ${installed.status}; inspect smoke-install.log`);
await writeFile(join(profile, 'cordis.patch.yml'), `
- id: session-title-llm
  disabled: true
- id: desktop-product-telemetry
  disabled: true
- id: product-analytics
  disabled: true
- id: workspace-controller
  config:
    documentsDirectory: ${JSON.stringify(workspace.replaceAll('\\', '/'))}
`);
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [`--user-data-dir=${userData}`, '--remote-debugging-port=0'], {
  // This GUI executable has no console. Its real interactive window must be
  // visible; STARTF_USESHOWWINDOW otherwise suppresses Electron's first show().
  env, windowsHide: false, detached: true, stdio: 'ignore',
});
child.unref();
const portText = await until(async () => {
  try { return await readFile(join(userData, 'DevToolsActivePort'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}, 60000);
const port = Number(portText.split('\n')[0]);
await writeFile(join(evidence, 'smoke-state.json'), JSON.stringify({ temporary, productHome, userData, workspace, pid: child.pid, port }, null, 2));
const target = await until(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return targets.find(row => row.type === 'page' && row.url.startsWith('dsh-app://app'));
}, 60000);
const onboarding = await completeSyntheticOnboarding(port);
const cdp = await connectTarget(target);
const diagnostics = [];
cdp.onEvent((method, params) => {
  if (method === 'Runtime.exceptionThrown' || method === 'Log.entryAdded'
    || method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(params.type)) {
    diagnostics.push({ method, params });
  }
});
await cdp.call('Runtime.enable'); await cdp.call('Log.enable');
const desktop = await until(() => cdp.evaluate(`window.dshDesktop?.protocolVersion===1 && !!document.querySelector('button')`), 60000);
await cdp.call('Page.bringToFront');
await until(() => cdp.evaluate(`document.visibilityState === 'visible'`), 10000);
const result = await cdp.evaluate(`({
  desktopProtocolVersion: window.dshDesktop.protocolVersion,
  title: document.title,
  controls: [...document.querySelectorAll('button,[role=tab]')].map(element=>({
    role: element.getAttribute('role'), label: element.getAttribute('aria-label'),
    title: element.getAttribute('title'), text: element.innerText?.slice(0,100)
  })).filter(row=>row.label||row.title||row.text),
  theme: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim(),
  brand: document.querySelectorAll('[data-nexus-brand-mark]').length
})`);
await cdp.call('Page.bringToFront');
const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
await writeFile(join(evidence, 'smoke-desktop.png'), Buffer.from(data, 'base64'));
await writeFile(join(evidence, 'smoke-bootstrap.json'), JSON.stringify({
  actualDesktop: desktop, modelRequestsSent: 0, copiedUserData: false, onboarding, result, environment,
  sourceHash: source.sha256,
  sourceUnchangedDuringRun: (await sourceIdentity(resolve('.'))).sha256 === source.sha256,
}, null, 2));
await writeFile(join(evidence, 'smoke-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
console.log(JSON.stringify({ port, pid: child.pid, actualDesktop: desktop, result }, null, 2));
// Keep this dedicated Desktop available for the remaining native interactions.
// The caller closes this synthetic instance after those checks.
cdp.close();
