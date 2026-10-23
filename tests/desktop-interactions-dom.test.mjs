import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { adaptCodinputSource } from '../scripts/build-codinput.mjs';
import { until } from '../scripts/desktop-cdp.mjs';
import { launchValidationBrowser } from '../scripts/desktop-browser.mjs';

const browser = process.env.NEXUS_BROWSER_EXECUTABLE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test('desktop renderer menu anchor, native tab gestures and resizable agent dialog use their real DOM paths', {
  skip: existsSync(browser) ? false : 'Local Chromium required', timeout: 90000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-interactions-'));
  let launched, cdp;
  try {
    const upstream = await readFile('vendor/codinput/src/client/index.tsx');
    const adapted = adaptCodinputSource('src/client/index.tsx', upstream);
    const block = /runGuarded\('draggate.install',[\s\S]+?\n  \}\);/.exec(adapted)?.[0] ?? '';
    const bundle = await build({
      entryPoints: ['tests/fixtures/desktop-interactions.tsx'], bundle: true, write: false, format: 'iife',
      platform: 'browser', target: 'chrome120', loader: { '.css': 'text' }, logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'adapted-vendor-gesture', setup(builder) {
        builder.onResolve({ filter: /^nexus:test-drag-gate$/ }, () => ({ path: 'gate', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: `export function installGate() { const runGuarded = (_,callback) => callback(); ${block} }`, loader: 'ts',
        }));
      } }],
    });
    await writeFile(join(directory, 'fixture.js'), bundle.outputFiles[0].contents);
    await writeFile(join(directory, 'fixture.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>');
    launched = await launchValidationBrowser({
      executable: browser, directory, url: pathToFileURL(join(directory, 'fixture.html')).href,
    });
    cdp = launched.cdp;
    const exceptions = [];
    cdp.onEvent((method, params) => { if (method === 'Runtime.exceptionThrown') exceptions.push(params.exceptionDetails?.exception?.description); });
    await cdp.call('Runtime.enable');
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await until(() => cdp.evaluate('!!window.__interactions'), 5000);
    const rect = selector => cdp.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; })()`);
    const mouse = async (type, x, y, pressed = false) => cdp.call('Input.dispatchMouseEvent', {
      type, x, y, ...(type === 'mouseMoved' ? { buttons: pressed ? 1 : 0 } : { button: 'left', clickCount: 1 }),
    });
    const click = async selector => {
      const r = await rect(selector), x = r.x + r.width / 2, y = r.y + Math.min(15, r.height / 2);
      await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y);
    };
    await click('.nexus-native-dock-controls > button');
    await until(() => cdp.evaluate('!!document.querySelector(":popover-open")'), 2000);
    const menu = await rect('.nexus-native-dock-menu'), trigger = await rect('.nexus-native-dock-controls > button');
    assert.ok(Math.abs(menu.right - trigger.right) <= 2, 'menu must anchor to its trigger, not viewport origin');
    assert.ok(menu.y >= trigger.bottom && menu.bottom <= 792);
    await click('#outside');
    await until(() => cdp.evaluate('!document.querySelector(":popover-open")'), 2000);
    const tab = await rect('[data-dockkit-tab]'), x = tab.x + 15, y = tab.y + 15;
    await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y);
    await mouse('mouseMoved', x - 80, y + 60, true); await mouse('mouseReleased', x - 80, y + 60);
    const drag = await cdp.evaluate('window.__interactions.snapshot()');
    assert.equal(drag.tabPresses, 1, 'vendor document capture must not swallow native tab press');
    assert.ok(drag.tabMoves > 0);
    await click('.nexus-agent-suggestion');
    await until(() => cdp.evaluate('!!document.querySelector("dialog:modal")'), 3000);
    const dialog = await rect('.nexus-insight-dialog');
    assert.ok(dialog.width >= 900 && dialog.height <= 768, 'dialog must escape graph scale and column width');
    assert.equal(await cdp.evaluate('getComputedStyle(document.querySelector(".nexus-insight-columns")).gridTemplateColumns.split(" ").length'), 2);
    // Real pointer input on the production resize handle; never assign style from the test.
    const grip = await rect('.nexus-insight-resize'), gx = grip.x + grip.width / 2, gy = grip.y + grip.height / 2;
    await cdp.evaluate(`window.__resizeEvents=[]; for(const type of ['pointerdown','pointermove','pointerup','gotpointercapture','lostpointercapture'])
      document.addEventListener(type,e=>window.__resizeEvents.push({type,target:e.target.className,x:e.clientX,y:e.clientY,button:e.button,buttons:e.buttons,id:e.pointerId}),true);
      `);
    await mouse('mouseMoved', gx, gy);
    await mouse('mousePressed', gx, gy);
    await mouse('mouseMoved', gx - 200, gy - 130, true);
    await mouse('mouseReleased', gx - 200, gy - 130);
    await until(async () => (await rect('.nexus-insight-dialog')).width < dialog.width - 100, 3000).catch(async error => {
      const detail = await cdp.evaluate(`({events:window.__resizeEvents,style:document.querySelector('.nexus-insight-dialog').getAttribute('style'),
        hit:document.elementFromPoint(${gx},${gy})?.outerHTML?.slice(0,400)})`);
      throw new Error(error.message + ': ' + JSON.stringify({ dialog, grip, detail, exceptions }));
    });
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 420, height: 650, deviceScaleFactor: 1, mobile: false });
    await until(async () => (await rect('.nexus-insight-dialog')).width <= 388, 3000);
    const narrow = await rect('.nexus-insight-dialog');
    assert.ok(narrow.x >= 0 && narrow.right <= 420 && narrow.bottom <= 650);
    assert.equal(await cdp.evaluate('getComputedStyle(document.querySelector(".nexus-insight-columns")).gridTemplateColumns.split(" ").length'), 1);
    const facts = await cdp.evaluate('window.__interactions.snapshot()');
    assert.equal(facts.canvasClicks, 0, 'dialog interactions must not bubble into graph navigation');
    assert.ok(facts.calls.every(call => call.method !== 'nexus.command'), 'opening a viewer must never start a model or compaction');
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await until(() => cdp.evaluate('!document.querySelector("dialog:modal")'), 2000);
    assert.equal(await cdp.evaluate('document.elementFromPoint(30,630)?.closest("[inert]") !== null'), false);
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await click('.nexus-agent-suggestion');
    await until(() => cdp.evaluate('!!document.querySelector("dialog:modal")'), 2000);
    await cdp.evaluate('window.__interactions.active(false)');
    await until(() => cdp.evaluate('!document.querySelector("dialog:modal")'), 2000);
    await cdp.evaluate('window.__interactions.dispose()');
  } finally {
    await launched?.close();
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('nexus-interactions-')) throw new Error('Unexpected cleanup target');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
