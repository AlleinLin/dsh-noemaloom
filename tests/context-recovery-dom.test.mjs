import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { until } from '../scripts/desktop-cdp.mjs';
import { launchValidationBrowser } from '../scripts/desktop-browser.mjs';

const browser = process.env.NEXUS_BROWSER_EXECUTABLE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test('the real recovery dialog lets a narrow-screen child resume its exact step and unlocks after acknowledgement', {
  skip: existsSync(browser) ? false : 'Local Chromium required', timeout: 60000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-context-recovery-'));
  let launched;
  try {
    const bundle = await build({
      entryPoints: ['tests/fixtures/context-recovery.tsx'], bundle: true, write: false, format: 'iife',
      platform: 'browser', target: 'chrome120', loader: { '.css': 'text' }, logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    await writeFile(join(directory, 'fixture.js'), bundle.outputFiles[0].contents);
    await writeFile(join(directory, 'fixture.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>');
    launched = await launchValidationBrowser({ executable: browser, directory, url: pathToFileURL(join(directory, 'fixture.html')).href });
    const cdp = launched.cdp;
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 420, height: 650, deviceScaleFactor: 1, mobile: false });
    await until(() => cdp.evaluate('!!window.__recovery'), 5000);
    const click = async selector => {
      const point = await cdp.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
        e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.call('Input.dispatchMouseEvent', {
        type, ...point, button: 'left', clickCount: 1,
      });
    };
    await click('[data-nexus-compaction-control="paused-child"] > button');
    await until(() => cdp.evaluate('!!document.querySelector("dialog:modal") && document.querySelector("dialog").innerText.includes("恢复当前步骤")'), 5000);
    const state = await cdp.evaluate(`(() => { const d=document.querySelector('dialog'), r=d.getBoundingClientRect();
      return {session:d.dataset.nexusCompactionSession,text:d.innerText,width:r.width,right:r.right,left:r.x,
        buttons:[...d.querySelectorAll('button')].map(b=>({text:b.textContent,disabled:b.disabled}))}; })()`);
    assert.equal(state.session, 'paused-child');
    assert.match(state.text, /窗口未知/); assert.doesNotMatch(state.text, /0\.0%/);
    assert.ok(state.left >= 0 && state.right <= 420);
    assert.equal(state.buttons.find(button => button.text === '立即压缩').disabled, true);
    assert.equal(state.buttons.find(button => button.text === '恢复当前步骤').disabled, false);
    // Select by the actual label, then use native pointer input on that button.
    await cdp.evaluate(`[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='恢复当前步骤').id='resume-step'`);
    await click('#resume-step'); await click('#resume-step');
    assert.equal((await cdp.evaluate('window.__recovery.calls()')).filter(call => call.action === 'maintenance/resume').length, 1);
    assert.equal(await cdp.evaluate('document.querySelector("#resume-step").disabled'), true);
    await cdp.evaluate('window.__recovery.finish()');
    await until(() => cdp.evaluate('!document.querySelector("#resume-step")'), 5000);
    const calls = await cdp.evaluate('window.__recovery.calls()');
    assert.ok(calls.every(call => call.scope.sessionId === 'paused-child'));
    assert.ok(calls.filter(call => call.action === 'maintenance/resume').every(call => call.requestId.startsWith('context-resume:')));
    assert.equal(calls.some(call => call.action === 'maintenance/compact'), false);
    await click('dialog [aria-label="关闭上下文压缩"]');
    await until(() => cdp.evaluate('!document.querySelector("dialog:modal")'), 2000);
    await cdp.evaluate('window.__recovery.dispose()');
  } finally {
    await launched?.close();
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('nexus-context-recovery-')) {
      throw new Error('Unexpected cleanup target');
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
