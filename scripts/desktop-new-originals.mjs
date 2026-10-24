import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { connectTarget, until } from './desktop-cdp.mjs';
import { sourceIdentity } from '../tools/acceptance/core.mjs';
import { EXPECTED_DSH_VERSION } from '../src/shared/host-compatibility.ts';

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (!args.includes('--state') || !args.includes('--output')) throw new Error('Usage: node scripts/desktop-new-originals.mjs --state <synthetic-state.json> --output <report.json>');
const state = JSON.parse(await readFile(option('--state'), 'utf8'));
const temp = relative(tmpdir(), state.temporary);
if (!temp || temp.startsWith('..') || !temp.startsWith('nexus-original-desktop-'))
  throw new Error('Only a synthetic desktop-smoke profile is eligible');
const profile = JSON.parse(await readFile(join(state.productHome, 'profiles/desktop/package.json'), 'utf8'));
if (profile.name !== 'nexus-disposable-desktop-profile') throw new Error('Synthetic profile marker missing');
if (!state.fixtureSessionId) throw new Error('Run desktop-resume.mjs --seed against the stopped synthetic profile before validating native session headers');
const source = await sourceIdentity(resolve('.'));
const targets = await (await fetch(`http://127.0.0.1:${state.port}/json/list`)).json();
const cdp = await connectTarget(targets.find(row => row.type === 'page' && row.url.startsWith('dsh-app://app')));
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), sourceHash: source.sha256,
  host: EXPECTED_DSH_VERSION, copiedUserData: false, modelRequestsSent: 0, desktopInputsSent: 0, cases: [], requests: [] };
const pending = new Set();
cdp.onEvent((method, params) => {
  if (method !== 'Network.requestWillBeSent' || !params.request.url.includes('/api/plugins/dsh-noemaloom/computer-use/state')) return;
  const request = params.request;
  report.requests.push({ method: request.method, path: new URL(request.url).pathname,
    ...(request.postData ? { body: JSON.parse(request.postData) } : {}) });
});
await cdp.call('Runtime.enable');
await cdp.call('Network.enable');
await cdp.call('Page.bringToFront');
const visible = selector => cdp.evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>{
  const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.closest('[hidden],[inert]')&&getComputedStyle(e).visibility!=='hidden'});
  if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,state:e.dataset.state,disabled:e.disabled,aria:e.getAttribute('aria-label'),text:e.innerText}})()`);
const click = async selector => {
  // Wait for real hit testing after the native sidebar/guide transitions.
  // A visible box can still be offscreen or moving while the shell settles.
  const point = await until(async () => {
    const first = await visible(selector);
    if (!first) return;
    const stable = await cdp.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
    const next = await visible(selector);
    if (!stable || !next || Math.abs(first.x-next.x) > 1 || Math.abs(first.y-next.y) > 1) return;
    const hit = await cdp.evaluate(`(()=>{const hit=document.elementFromPoint(${next.x},${next.y});return !!hit?.closest(${JSON.stringify(selector)})})()`);
    return hit ? next : undefined;
  }, 10000);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp.call('Input.dispatchMouseEvent', {
    type, x: point.x, y: point.y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }),
  });
};
async function check(name, action) {
  try { report.cases.push({ name, passed: true, observed: await action() }); }
  catch (error) { report.cases.push({ name, passed: false, error: error.stack ?? error.message }); }
}
try {
  await check('open the offline native fixture without submitting a model request', async () => {
    await click(`[data-row-key="session:${state.fixtureSessionId}"]`);
    const text = await until(() => cdp.evaluate(`document.body.innerText.includes('这是本地构造的测试记录，没有请求任何模型。')`), 10000);
    assert.equal(text, true);
    return { sessionId: state.fixtureSessionId, syntheticArchive: true };
  });
  await check('native rc3 composer retains the original session computer switch', async () => {
    if (!await visible('.dsh-cu-chip')) {
      const created = await cdp.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>/^(新建会话|新会话|New session|New chat)$/.test((e.getAttribute('aria-label')||e.title||e.innerText||'').trim()));if(!e)return false;e.setAttribute('data-noemaloom-create-session','');return true})()`);
      assert.equal(created, true);
      await click('[data-noemaloom-create-session]');
    }
    const chip = await until(() => visible('.dsh-cu-chip[data-state=off]:not(:disabled)'), 15000);
    assert.equal(chip.state, 'off');
    assert.equal(await cdp.evaluate('!!document.querySelector(".dci-surface .dsh-cu-chip")'), true);
    return chip;
  });
  await check('original switch toggles only its exact session through the authenticated connection', async () => {
    await click('.dsh-cu-chip[data-state=off]:not(:disabled)');
    await until(() => visible('.dsh-cu-chip[data-state=on]:not(:disabled)'), 8000);
    const write = report.requests.find(row => row.method === 'POST' && row.body?.enabled === true);
    assert.ok(write?.body?.sessionId);
    pending.add(write.body.sessionId);
    await click('.dsh-cu-chip[data-state=on]:not(:disabled)');
    await until(() => visible('.dsh-cu-chip[data-state=off]:not(:disabled)'), 8000);
    const off = report.requests.find(row => row.method === 'POST' && row.body?.enabled === false);
    assert.equal(off?.body?.sessionId, write.body.sessionId);
    pending.delete(write.body.sessionId);
    return { sessionId: write.body.sessionId, enabledThenDisabled: true, route: write.path };
  });
  await check('native input and desktop keep the Claude theme and bounded input layout', async () => {
    const result = await cdp.evaluate(`(()=>{const chip=document.querySelector('.dci-surface .dsh-cu-chip'),surface=chip?.closest('.dci-surface'),r=surface?.getBoundingClientRect();return{
      chipRadius:chip?getComputedStyle(chip).borderRadius:null,chipColor:chip?getComputedStyle(chip).color:null,
      themeRadius:getComputedStyle(document.body).getPropertyValue('--dsw-radius-md').trim(),
      theme:getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim(),
      width:r?.width,right:r?.right,viewport:innerWidth,inputCount:document.querySelectorAll('.dci-surface .cm-editor').length}})()`);
    assert.equal(result.themeRadius, '9px');
    assert.equal(result.chipRadius, result.themeRadius);
    assert.ok(result.theme);
    assert.ok(result.width > 200 && result.right <= result.viewport + 1);
    assert.ok(result.inputCount > 0);
    return result;
  });
  await check('native rc3 header retains its own view action menus', async () => {
    const selector = 'button[class*="_viewsMore"]';
    await until(() => visible(selector), 8000);
    await click(selector);
    await until(() => cdp.evaluate(`!!document.querySelector('button[class*="_viewsMore"][aria-expanded=true]')`), 3000);
    const items = await cdp.evaluate(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemcheckbox]')).map(e=>e.innerText)`);
    assert.ok(items.length > 0, 'native view menu must expose its actual entries');
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await until(() => cdp.evaluate(`!document.querySelector('button[class*="_viewsMore"][aria-expanded=true]')`), 3000);
    return { items, closedByEscape: true };
  });
  await check('native Start guide keeps compact original entries and an operable shell menu', async () => {
    if (!await visible('[data-sidebar-right-guide-entry="terminal"]')) {
      if (await visible('[data-sidebar-right-expand]')) await click('[data-sidebar-right-expand]');
      else {
        const start = await cdp.evaluate(`(()=>{const e=[...document.querySelectorAll('[role=tab]')].find(e=>e.innerText.trim()==='开始');if(!e)return false;e.setAttribute('data-noemaloom-start-guide','');return true})()`);
        assert.equal(start, true);
        await click('[data-noemaloom-start-guide]');
      }
    }
    await until(() => visible('[data-sidebar-right-guide-entry="terminal"]'), 5000);
    const entries = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-sidebar-right-guide-entry]')).map(e=>{
      const r=e.getBoundingClientRect(),s=getComputedStyle(e);return{id:e.getAttribute('data-sidebar-right-guide-entry'),text:e.innerText,
        width:r.width,height:r.height,fontSize:s.fontSize,background:s.backgroundColor,viewport:innerWidth,right:r.right};
    }).filter(e=>e.width>0&&e.height>0)`);
    assert.ok(entries.length >= 5);
    for (const entry of entries) {
      assert.equal(entry.height, 44, `${entry.id} must use the compact native row`);
      assert.ok(entry.right <= entry.viewport + 1, `${entry.id} must stay inside its pane`);
    }
    const guideWidth = await cdp.evaluate(`document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open=true]').getBoundingClientRect().width`);
    assert.ok(guideWidth >= 300 && guideWidth <= 360, 'native default panels leave room for conversation');
    const tracks = await cdp.evaluate(`(()=>{
      const panel=document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open=true]');
      const frame=panel.closest('[class$="_frame"]'),col=panel.closest('[class$="_rightbarCol"]');
      const center=frame.querySelector(':scope > [class$="_centerCol"]');
      return{panel:panel.getBoundingClientRect().toJSON(),column:col.getBoundingClientRect().toJSON(),
        center:center.getBoundingClientRect().toJSON(),grid:getComputedStyle(frame).gridTemplateColumns};
    })()`);
    assert.ok(Math.abs(tracks.column.width-guideWidth) <= 1, 'the shell must not reserve a wider empty track');
    assert.ok(Math.abs(tracks.center.right-tracks.column.left) <= 1, 'conversation must extend to the guide boundary');
    const responsive = [];
    try {
      for (const width of [960, 1440]) {
        await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false });
        const observed = await until(() => cdp.evaluate(`(()=>{
          const panel=document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open=true]');
          const col=panel?.closest('[class$="_rightbarCol"]'),r=panel?.getBoundingClientRect(),c=col?.getBoundingClientRect();
          const frame=panel?.closest('[class$="_frame"]');
          const sidebar=parseFloat(getComputedStyle(frame).getPropertyValue('--dsh-windows-sidebar-width'))||0;
          const expected=Math.round(Math.max(300,Math.min((innerWidth-sidebar)*.3,360)));
          return r&&c&&Math.abs(r.width-expected)<1&&Math.abs(c.width-r.width)<1
            &&{viewport:innerWidth,panel:r.width,column:c.width,right:c.right,expected};
        })()`), 5000);
        assert.ok(observed.right <= observed.viewport + 1);
        responsive.push(observed);
      }
    } finally { await cdp.call('Emulation.clearDeviceMetricsOverride'); }
    const more = await visible('[data-sidebar-right-guide] button[aria-label="更多工具"]');
    assert.ok(more, 'the original More tools launcher remains present');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-sidebar-right-guide] button[aria-label="更多工具"]').getBoundingClientRect().height`), 44);
    await click('[data-sidebar-right-guide-entry="terminal"] button[aria-haspopup="menu"]');
    await until(() => cdp.evaluate(`!!document.querySelector('[data-sidebar-right-guide-entry="terminal"] button[aria-expanded=true]')`), 5000);
    const shells = await cdp.evaluate(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).map(e=>e.innerText)`);
    assert.ok(shells.length > 0, 'original Shell menu must retain its native choices');
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await click('[data-sidebar-right-guide-entry="files"]');
    const restored = await until(() => cdp.evaluate(`(()=>{
      const panel=document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open=true]');
      if(!panel)return false;const width=panel.getBoundingClientRect().width,configured=parseFloat(panel.style.width);
      const col=panel.closest('[class$="_rightbarCol"]');
      return width===configured&&width>=300&&width<=360&&Math.abs(col.getBoundingClientRect().width-width)<1&&{width,configured};
    })()`), 8000);
    // Exercise the real native handle, then double-click to resume automatic sizing.
    const handle = '[data-side="rightbar"]';
    const origin = await until(() => visible(handle), 5000);
    for (const event of [
      { type: 'mouseMoved', x: origin.x, y: origin.y },
      { type: 'mousePressed', x: origin.x, y: origin.y, button: 'left', clickCount: 1 },
      { type: 'mouseMoved', x: origin.x-100, y: origin.y, button: 'left', buttons: 1 },
      { type: 'mouseReleased', x: origin.x-100, y: origin.y, button: 'left', clickCount: 1 },
    ]) await cdp.call('Input.dispatchMouseEvent', event);
    const dragged = await until(() => cdp.evaluate(`(()=>{
      const p=document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open=true]');
      const width=p?.getBoundingClientRect().width;
      return width>${restored.width + 70}&&{width,column:p.closest('[class$="_rightbarCol"]').getBoundingClientRect().width};
    })()`), 5000);
    assert.ok(Math.abs(dragged.width-dragged.column)<1);
    const reset = await until(() => visible(handle), 5000);
    for (const type of ['mousePressed','mouseReleased']) await cdp.call('Input.dispatchMouseEvent', {
      type,x:reset.x,y:reset.y,button:'left',clickCount:2,
    });
    const automatic = await until(() => cdp.evaluate(`(()=>{
      const p=document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open=true]');
      const width=p?.getBoundingClientRect().width;return width>=300&&width<=360&&{width};
    })()`), 5000);
    return { entries, guideWidth, tracks, responsive, shells, fileDefault: restored, nativeDrag: dragged, automaticReset: automatic };
  });
  await check('native fullscreen covers conversation chrome and restores the automatic tool width', async () => {
    const before = await cdp.evaluate(`document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open=true]').getBoundingClientRect().width`);
    await click('[data-sidebar-right-panel] [data-sidebar-right-mode="fullscreen"]');
    const fullscreen = await until(() => cdp.evaluate(`(()=>{
      const p=document.querySelector('[data-sidebar-right-panel="fullscreen"][data-sidebar-right-open=true]');
      if(!p)return false;const r=p.getBoundingClientRect(),s=getComputedStyle(p);
      const points=[[r.left+60,r.top+12],[r.left+80,r.top+180],[r.right-20,r.bottom-30]];
      const hits=points.map(([x,y])=>({x,y,inPanel:!!document.elementFromPoint(x,y)?.closest('[data-sidebar-right-panel="fullscreen"]')}));
      return r.width>${before}+100&&hits.every(p=>p.inPanel)&&{
        width:r.width,height:r.height,left:r.left,right:r.right,background:s.backgroundColor,
        layer:getComputedStyle(p.closest('[data-rightbar-col]')).zIndex,hits};
    })()`), 5000);
    assert.notEqual(fullscreen.background, 'rgba(0, 0, 0, 0)');
    assert.ok(Number(fullscreen.layer) > 7, 'fullscreen must cover the sticky conversation tabs');
    await click('[data-sidebar-right-panel] [data-sidebar-right-mode="push"]');
    const restored = await until(() => cdp.evaluate(`(()=>{
      const p=document.querySelector('[data-sidebar-right-panel="push"][data-sidebar-right-open=true]');
      const r=p?.getBoundingClientRect();return r&&Math.abs(r.width-${before})<1&&{width:r.width};
    })()`), 5000);
    return { before, fullscreen, restored };
  });
} finally {
  // Retire only grants enabled by this isolated test. No desktop tool is executed.
  for (const sessionId of pending) {
    try { await cdp.evaluate(`fetch('/api/plugins/dsh-noemaloom/computer-use/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:${JSON.stringify(sessionId)},enabled:false})})`); }
    catch (error) { report.cleanupError = error.message; }
  }
  report.finishedAt = new Date().toISOString();
  report.sourceUnchangedDuringRun = (await sourceIdentity(resolve('.'))).sha256 === source.sha256;
  const output = resolve(option('--output'));
  await mkdir(dirname(output), { recursive: true });
  try {
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
    await writeFile(output.replace(/\.json$/u, '') + '.png', Buffer.from(screenshot.data, 'base64'));
  } catch (error) { report.screenshotError = error.message; }
  report.passed = report.cases.every(row => row.passed) && !report.cleanupError
    && !report.screenshotError && report.sourceUnchangedDuringRun;
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  cdp.close();
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.map(({ name, passed }) => ({ name, passed })) }, null, 2));
process.exitCode = report.passed ? 0 : 1;
