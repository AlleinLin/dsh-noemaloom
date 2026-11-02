// Actual official Desktop, disposable profile, local model only. This harness
// never reads or closes the user's profile or installed Desktop process.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectTarget, until, completeSyntheticOnboarding } from './desktop-cdp.mjs';
import { sourceIdentity } from '../tools/acceptance/core.mjs';

const executable = join(process.env.NEXUS_DSH_ROOT, 'DeepSeek Harness.exe');
const cli = join(process.env.NEXUS_DSH_ROOT, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
const packagePath = resolve(process.argv[2]);
const source = await sourceIdentity(process.cwd());
const temporary = await mkdtemp(join(tmpdir(), 'nexus-original-desktop-'));
const home = join(temporary, 'home'), workspace = join(temporary, 'workspace');
const profile = join(home, 'profiles/desktop'), token = randomUUID();
const output = resolve('evidence/private-delayed-message');
await mkdir(profile, { recursive: true }); await mkdir(workspace); await mkdir(output, { recursive: true });
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'nexus-disposable-desktop-profile', private: true,
  dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|CREDENTIAL)/i.test(k)));
Object.assign(env, { DSH_HOME: home, DSH_AGENTS_HOME: join(temporary, 'agents'), MNEMON_DATA_DIR: join(temporary, 'mnemon'), ELECTRON_RUN_AS_NODE: '1' });
const version = spawnSync(executable, ['--expose-internals', cli, '--version'], { env, windowsHide: true, encoding: 'utf8', timeout: 30000 });
assert.equal(version.stdout.trim(), '0.2.1-rc.5'); assert.equal(version.status, 0);
const install = spawn(executable, ['--expose-internals', cli, 'plugin', '--profile', 'desktop', 'add', '--ignore-scripts', '--save-exact', packagePath],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let installOutput = ''; install.stdout.on('data', b => { installOutput += b; }); install.stderr.on('data', b => { installOutput += b; });
const installCode = await new Promise((done, fail) => { install.once('error', fail); install.once('close', done); });
await writeFile(join(output, 'install.log'), installOutput); assert.equal(installCode, 0, installOutput.slice(-3000));
for (const file of ['lib/index.js', 'lib/client.js']) {
  const digest = b => createHash('sha256').update(b).digest('hex');
  assert.equal(digest(await readFile(join(profile, 'node_modules/dsh-noemaloom', file))), digest(await readFile(file)));
}
await copyFile('tests/fixtures/scheduled-desktop-host.mjs', join(profile, 'node_modules/dsh-noemaloom/lib/original/scheduled-fixture.js'));
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
- insert:
    - id: noemaloom-scheduled-fixture
      name: dsh-noemaloom/original/scheduled-fixture
      config: ${JSON.stringify({ token, temporary, workspace })}
`);
delete env.ELECTRON_RUN_AS_NODE;
let c, processId, port;
async function start() {
  const userData = join(temporary, `electron-${Date.now()}`); await mkdir(userData);
  const child = spawn(executable, [`--user-data-dir=${userData}`, '--remote-debugging-port=0'], { env, windowsHide: false, detached: true, stdio: 'ignore' });
  child.unref(); processId = child.pid;
  const text = await until(async () => { try { return await readFile(join(userData, 'DevToolsActivePort'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }, 60000);
  port = Number(text.split('\n')[0]);
  await writeFile(join(output, 'state.json'), JSON.stringify({ temporary, home, workspace, userData, port, pid: processId, token }));
  // Keep a browser-level connection even if host startup/onboarding fails, so
  // the marked error window can be closed without touching any other Desktop.
  c = await connectTarget(await (await fetch(`http://127.0.0.1:${port}/json/version`)).json());
  await completeSyntheticOnboarding(port);
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  c.close(); c = await connectTarget(tabs.find(t => t.url.startsWith('dsh-app://app')));
  await c.call('Page.bringToFront');
  await until(() => c.evaluate('window.dshDesktop?.protocolVersion===1 && !!document.querySelector("button")'), 60000);
}
async function close() {
  if (!c) return;
  await c.call('Browser.close').catch(() => {}); c.close(); c = undefined;
  await until(() => { try { process.kill(processId, 0); return false; } catch (e) { if (e.code === 'ESRCH') return true; throw e; } }, 30000);
}
const report = { host: version.stdout.trim(), sourceHash: source.sha256, copiedUserData: false, remoteModelRequests: 0, cases: [] };
async function save() {
  report.sourceUnchangedDuringRun = (await sourceIdentity(process.cwd())).sha256 === source.sha256;
  report.passed = report.cases.length === 6 && report.cases.every(row => row.passed) && report.sourceUnchangedDuringRun;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
async function check(name, work) {
  try { report.cases.push({ name, passed: true, observed: await work() }); }
  catch (e) {
    report.cases.push({ name, passed: false, error: e.stack, text: c && await c.evaluate('document.body.innerText.slice(-6000)').catch(() => '') });
    throw e;
  } finally { await save(); }
}
async function fixture(body) {
  const result = await c.evaluate(`fetch('/__noemaloom_scheduled_fixture',{method:'POST',headers:{'content-type':'application/json','x-noemaloom-fixture':${JSON.stringify(token)}},body:${JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status,text:await r.text()}))`);
  assert.equal(result.status, 200, result.text); return JSON.parse(result.text);
}
const selector = s => `document.querySelector(${JSON.stringify(s)})`;
async function click(expression) {
  const point = await until(() => c.evaluate(`(()=>{const e=(${expression});if(!e)return;e.scrollIntoView({block:'nearest',behavior:'instant'});const r=e.getBoundingClientRect(),p={x:r.x+r.width/2,y:r.y+r.height/2};return r.width&&r.height&&e.contains(document.elementFromPoint(p.x,p.y))&&p})()`), 15000);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.call('Input.dispatchMouseEvent', { type, ...point, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
}
async function replace(s, text) {
  await click(selector(s));
  for (const type of ['keyDown','keyUp']) await c.call('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await c.call('Input.insertText', { text });
}
async function schedule(id, text, minutes = '0.05') {
  await click(selector(`[data-nexus-delayed-message-session="${id}"] button`));
  await until(() => c.evaluate('!!document.querySelector("dialog.nexus-delayed-message-dialog textarea")'), 15000);
  await replace('dialog input[aria-label="延时时长（分钟）"]', minutes);
  await replace('dialog textarea[aria-label="延时发送内容"]', text);
  await click(`[...document.querySelectorAll('dialog.nexus-delayed-message-dialog button')].find(e=>e.innerText==='安排发送')`);
  await until(() => c.evaluate('document.querySelector("dialog.nexus-delayed-message-dialog")?.innerText.includes("已安排在")'), 15000);
}
async function dismiss() {
  // Native input dispatch returns before React finishes the pending cancel RPC.
  // Closing while busy is intentionally ignored; wait for the actual dialog
  // removal instead of immediately clicking a trigger behind its backdrop.
  await until(async () => {
    if (!await c.evaluate('!!document.querySelector("dialog.nexus-delayed-message-dialog")')) return true;
    await click(selector('[aria-label="关闭延时发送"]'));
    return !await c.evaluate('!!document.querySelector("dialog.nexus-delayed-message-dialog")');
  }, 15000);
}
async function waitDelivered(id, text) {
  return until(async () => {
    const value = await fixture({ action: 'snapshot' });
    const row = value.plans.find(row => row.value.sessionId === id && row.value.body === text);
    if (row?.value.status === 'failed' || row?.value.status === 'unknown') throw new Error(JSON.stringify(row));
    return row?.value.status === 'completed' && value.requests.some(r => r.sessionId === id && r.texts.some(t => t.includes(text))) && value;
  }, 60000);
}
let ids;
async function openChild() {
  if (await c.evaluate(`!!${selector(`[data-nexus-delayed-message-session="${ids.childId}"] button`)}`)) return;
  await click(`[...document.querySelectorAll('[role=tab]')].find(e=>e.innerText.trim()==='子智能体'&&e.getBoundingClientRect().width>0)`);
  await until(() => c.evaluate('!!document.querySelector("[data-tree-node],[data-graph-node]")'), 15000);
  const tree = await c.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.innerText.trim()==='树状图'&&e.getBoundingClientRect().width>0);if(!e)return false;e.setAttribute('data-delay-tree','');return true})()`);
  if (tree) await click(selector('[data-delay-tree]'));
  if (await c.evaluate(`!!${selector(`[data-tree-node="fold:${ids.parentId}"]`)}`)) await click(selector(`[data-tree-node="fold:${ids.parentId}"]`));
  await click(selector(`[data-tree-node="${ids.childId}"]`));
  await click(`[...document.querySelectorAll('button')].find(e=>e.innerText.trim()==='查看转录'&&e.getBoundingClientRect().width>0)`);
  await until(() => c.evaluate(`!!${selector(`[data-nexus-delayed-message-session="${ids.childId}"] button`)}`), 15000);
}
try {
  await start();
  await check('prepare a real native continuable child and wait until it is released', async () => {
    await click(`[...document.querySelectorAll('button')].find(e=>/^(新建会话|新会话|New session|New chat)$/.test((e.getAttribute('aria-label')||e.title||e.innerText||'').trim()))`);
    const parentId = await until(() => c.evaluate('document.querySelector("[data-nexus-delayed-message-session]")?.dataset.nexusDelayedMessageSession'), 20000);
    const value = await fixture({ action: 'prepare', parentId }); ids = value.ids;
    assert.equal(value.sessions[ids.childId].live, false); return { ids, cold: true };
  });
  await check('main composer schedule wakes idle main and model receives the fixed text', async () => {
    const text = `desktop-main-${randomUUID()}`; await schedule(ids.parentId, text);
    const value = await waitDelivered(ids.parentId, text);
    await until(() => c.evaluate('document.querySelector("dialog.nexus-delayed-message-dialog")?.innerText.includes("已送达")'), 10000);
    await dismiss(); return { id: ids.parentId, nativeMessages: value.sessions[ids.parentId].scheduled.length, text };
  });
  await check('cold child composer schedule resumes exact child and model receives the fixed text', async () => {
    await openChild();
    const before = await fixture({ action: 'snapshot' }); assert.equal(before.sessions[ids.childId].live, false);
    const text = `desktop-child-${randomUUID()}`; await schedule(ids.childId, text);
    const value = await waitDelivered(ids.childId, text);
    assert.equal(value.sessions[ids.childId].header.parentSession, ids.parentId);
    await until(() => c.evaluate('document.querySelector("dialog.nexus-delayed-message-dialog")?.innerText.includes("已送达")'), 10000);
    await writeFile(join(output, 'child-delivered.png'), Buffer.from((await c.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await dismiss(); return { id: ids.childId, originalParent: ids.parentId, nativeMessages: value.sessions[ids.childId].scheduled.length, text };
  });
  await check('cancelling child schedule removes its timer without sending', async () => {
    const text = `desktop-cancel-${randomUUID()}`; await schedule(ids.childId, text, '0.1');
    await click(`[...document.querySelectorAll('.nexus-delayed-message-plan')].find(e=>e.innerText.includes(${JSON.stringify(text)}))?.querySelector('button')`);
    await dismiss();
    const value = await fixture({ action: 'snapshot' });
    assert.equal(value.plans.find(r => r.value.body === text).value.status, 'revoked');
    return { text, revoked: true };
  });
  let restartText;
  await check('child schedule survives actual isolated Desktop shutdown and continues on restart', async () => {
    restartText = `desktop-restart-${randomUUID()}`; await schedule(ids.childId, restartText, '0.2'); await dismiss();
    await close(); await start();
    const value = await waitDelivered(ids.childId, restartText);
    assert.equal(value.sessions[ids.childId].header.parentSession, ids.parentId);
    return { id: ids.childId, originalParent: ids.parentId, text: restartText };
  });
  await check('replaying the completed request identity cannot duplicate native input', async () => {
    const before = await fixture({ action: 'snapshot' });
    const row = before.plans.find(r => r.value.body === restartText);
    const receipt = await fixture({ action: 'repeat', id: row.id });
    assert.equal(receipt.accepted, true);
    const after = await fixture({ action: 'snapshot' });
    assert.equal(after.sessions[ids.childId].scheduled.length, before.sessions[ids.childId].scheduled.length);
    assert(!after.requests.some(r => r.texts.some(t => t.includes('desktop-cancel-'))));
    return { sameMessageId: receipt.messageId, nativeCount: after.sessions[ids.childId].scheduled.length };
  });
  await writeFile(join(output, 'snapshot.json'), JSON.stringify(await fixture({ action: 'snapshot' }), null, 2));
  console.log(JSON.stringify(report));
} catch (e) {
  if (!report.cases.some(row => !row.passed)) report.cases.push({ name: 'isolated Desktop startup/lifecycle', passed: false, error: e.stack });
  throw e;
} finally { await save(); await close(); }
