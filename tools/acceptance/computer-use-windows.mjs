/**
 * Real Windows worker acceptance, without loading DSH or touching a user app.
 *
 * node tools/acceptance/computer-use-windows.mjs --output <directory>
 * node tools/acceptance/computer-use-windows.mjs --fixture-input --output <directory>
 *
 * The default mode only runs the doctor, worker health and window enumeration.
 * --fixture-input additionally writes through UI Automation into this process's
 * own WinForms fixture, reads the exact value back and captures only its window.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sourceIdentity } from './core.mjs';

const args = process.argv.slice(2), allowed = new Set(['--output', '--fixture-input']);
let output = join(tmpdir(), `nexus-computer-acceptance-${randomUUID()}`);
for (let index = 0; index < args.length; index++) {
  if (!allowed.has(args[index])) throw new Error(`Unknown argument: ${args[index]}`);
  if (args[index] === '--output') {
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--output needs a directory');
    output = resolve(args[++index]);
  }
}
if (process.platform !== 'win32') throw new Error('This command validates the actual Windows backend and requires Windows.');
await mkdir(output, { recursive: true });
const repository = fileURLToPath(new URL('../../', import.meta.url));
const source = await sourceIdentity(repository);
const root = fileURLToPath(new URL('../../lib/original/computer-use/', import.meta.url));
const { collectDoctorReport } = await import(pathToFileURL(join(root, 'internal/doctor.mjs')).href);
const { PowerShellBackend, resolvePowerShell } = await import(pathToFileURL(join(root, 'backend/bridge.js')).href);
const { verifyRelease } = await import(pathToFileURL(join(root, 'internal/release-manifest.mjs')).href);
const report = {
  mode: args.includes('--fixture-input') ? 'own-window-input' : 'passive',
  startedAt: new Date().toISOString(),
  packageRoot: root,
  ok: false,
  checks: {},
  sourceHash: source.sha256,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
};
const backend = new PowerShellBackend({ timeoutMs: 40_000 });
let fixture;
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

async function createFixture() {
  const title = `Nexus acceptance ${randomUUID()}`, editorName = 'NexusFixtureEditor';
  const script = join(output, 'fixture.ps1');
  // The generated values contain no shell syntax. -File receives a literal
  // argument array; neither the path nor the script goes through a shell.
  await writeFile(script, `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FixtureWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
}
'@
$form = New-Object System.Windows.Forms.Form
$form.Text = '${title}'
$form.ClientSize = New-Object System.Drawing.Size(560, 220)
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$editor = New-Object System.Windows.Forms.TextBox
$editor.Name = '${editorName}'
$editor.AccessibleName = '${editorName}'
$editor.Multiline = $true
$editor.Dock = [System.Windows.Forms.DockStyle]::Fill
$form.Controls.Add($editor)
$form.Add_Shown({
  # A hidden PowerShell console must not hide its independently owned fixture.
  [void][FixtureWindow]::ShowWindow($form.Handle, 9)
  [Console]::Out.WriteLine((@{ pid = $PID; hwnd = $form.Handle.ToInt64(); visible = [FixtureWindow]::IsWindowVisible($form.Handle) } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
})
[System.Windows.Forms.Application]::Run($form)
`, 'utf8');
  fixture = spawn(resolvePowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-File', script],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let launchError, text = '', stderr = '';
  fixture.on('error', error => { launchError = error; });
  fixture.stdout.setEncoding('utf8').on('data', chunk => { text += chunk; });
  fixture.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (launchError) throw launchError;
    if (fixture.exitCode !== null) throw new Error(`Fixture exited early: ${stderr.slice(-2000)}`);
    const line = text.split(/\r?\n/u).find(value => value.startsWith('{"'));
    if (line) {
      const identity = JSON.parse(line);
      if (Number(identity.pid) !== fixture.pid || !Number.isSafeInteger(identity.hwnd) || identity.hwnd <= 0) {
        throw new Error('Fixture supplied an invalid native identity');
      }
      return { ...identity, title, editorName };
    }
    await wait(250);
  }
  throw new Error(`Fixture did not publish its native window within 20 seconds: ${stderr.slice(-2000)}`);
}
async function ownWindow(identity) {
  if (!fixture || fixture.exitCode !== null) throw new Error('The fixture process is no longer alive');
  for (let attempt = 0; attempt < 20; attempt++) {
    if (fixture.exitCode !== null) throw new Error('The fixture exited while awaiting its visible window');
    const list = await backend.request('windows', { filter: identity.title });
    const rows = list.windows.filter(row => Number(row.pid) === identity.pid && Number(row.hwnd) === identity.hwnd && row.title === identity.title);
    if (rows.length === 1) return rows[0];
    if (attempt === 19) {
      report.checks.fixtureIdentityFailure = {
        expected: identity,
        // Never export titles or identities belonging to other applications.
        observedOwnWindows: list.windows.filter(row => Number(row.pid) === identity.pid),
      };
      throw new Error('The exact fixture process, title and HWND did not identify one visible window within 10 seconds');
    }
    await wait(500);
  }
}

try {
  const release = verifyRelease(root);
  report.checks.doctor = collectDoctorReport({ packageRoot: root, mode: 'offline', release, requireReleaseManifest: true });
  if (!report.checks.doctor.ok) throw new Error('Offline doctor has blocking findings; inspect report.json');
  await backend.start();
  const health = await backend.request('health', {});
  const windows = await backend.request('windows', {});
  report.checks.worker = { alive: backend.alive, generation: backend.info?.generation, pid: backend.info?.pid,
    protocol: backend.info?.protocol, health, visibleWindows: windows.windows.length };
  if (!backend.alive || !health.interactive) throw new Error('Worker did not report an interactive desktop');
  if (args.includes('--fixture-input')) {
    const identity = await createFixture();
    await ownWindow(identity);
    const tree = await backend.request('uitree', { hwnd: identity.hwnd, maxDepth: 6, maxNodes: 120 });
    const editable = tree.nodes.filter(node => (node.automationId === identity.editorName || node.name === identity.editorName)
      && node.patterns.includes('value'));
    if (editable.length !== 1) throw new Error('The own-window fixture must expose exactly one named UIA ValuePattern editor');
    const node = editable[0], marker = `Nexus Windows UIA ${randomUUID()} 中文验证`;
    const target = { hwnd: identity.hwnd, name: node.name, controlType: node.controlType, automationId: node.automationId };
    await ownWindow(identity);
    await backend.request('uiact', { ...target, action: 'set_value', value: marker });
    await ownWindow(identity);
    const read = await backend.request('uiact', { ...target, action: 'get_value' });
    if (read.value !== marker) throw new Error('UIA fixture text did not round-trip exactly');
    await ownWindow(identity);
    const screenshot = join(output, 'fixture-window.png');
    const captured = await backend.request('screenshot', { window: identity.hwnd, path: screenshot });
    if (!(captured.width > 0 && captured.height > 0)) throw new Error('Own-window screenshot has no usable pixels');
    report.checks.fixture = { ...identity, uiaValueRoundTrip: true, marker, screenshot,
      width: captured.width, height: captured.height };
  }
  report.ok = true;
} catch (error) {
  report.error = { message: error.message, code: error.code ?? null, dispatched: error.dispatched ?? null };
  process.exitCode = 1;
} finally {
  // A process handle, never a global key sequence or title-based process kill.
  if (fixture && fixture.exitCode === null) {
    const exited = new Promise(resolveExit => fixture.once('exit', resolveExit));
    fixture.kill();
    await Promise.race([exited, wait(5000)]);
  }
  await backend.dispose();
  report.finishedAt = new Date().toISOString();
  report.sourceUnchangedDuringRun = (await sourceIdentity(repository)).sha256 === source.sha256;
  if (!report.sourceUnchangedDuringRun) { report.ok = false; process.exitCode = 1; }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: report.ok, mode: report.mode, report: join(output, 'report.json') }));
}
