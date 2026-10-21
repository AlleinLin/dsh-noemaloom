import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, access, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { connectTarget, delay, until } from './desktop-cdp.mjs';

// Run against an already launched, disposable Desktop, once per old/new
// package. Never opens a real profile or sends a conversation/model request.
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const statePath = option('--state'), outputPath = option('--output');
if (!statePath || !outputPath) throw new Error('Usage: node scripts/desktop-dock-regression.mjs --state <synthetic-smoke-state.json> --output <new-report.json> [--native-only]');
const output = resolve(outputPath);
try { await access(output); throw new Error(`Evidence already exists: ${output}`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const state = JSON.parse(await readFile(statePath, 'utf8'));
const temporary = relative(tmpdir(), state.temporary);
if (!temporary || temporary.startsWith('..') || !temporary.startsWith('nexus-original-desktop-'))
  throw new Error('Only a desktop-smoke synthetic profile is eligible');
const profile = JSON.parse(await readFile(join(state.productHome, 'profiles/desktop/package.json'), 'utf8'));
if (profile.name !== 'nexus-disposable-desktop-profile') throw new Error('Synthetic profile marker missing');
const targets = await (await fetch(`http://127.0.0.1:${state.port}/json/list`)).json();
const target = targets.find(row => row.type === 'page' && row.url.startsWith('dsh-app://app'));
if (!target) throw new Error('Synthetic Desktop page not available');
const cdp = await connectTarget(target);
await cdp.call('Runtime.enable');
const report = { schemaVersion: 1, statePath: resolve(statePath), startedAt: new Date().toISOString(),
  copiedUserData: false, modelRequestsSent: 0, cases: [], inputAttempts: [] };
const checks = async (name, callback) => {
  const started = Date.now();
  try { const result = await callback(); report.cases.push({ name, passed: true, elapsedMs: Date.now() - started, ...result }); }
  catch (error) {
    let diagnostic;
    try { diagnostic = await nativeSnapshot(); } catch (failure) { diagnostic = { unresponsive: true, error: failure.message }; }
    report.cases.push({ name, passed: false, elapsedMs: Date.now() - started, error: error.message, diagnostic });
  }
};
async function point(selector, fixture = false, optional = false) {
  return cdp.evaluate(`(() => {
    const frame = ${fixture ? 'window.__nexusDockRegression.frame' : 'null'};
    const owner = frame ? frame.contentDocument : document;
    const element = [...owner.querySelectorAll(${JSON.stringify(selector)})].find(node => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden'
        && !node.closest('[hidden],[inert]');
    });
    if (!element) {
      if (${optional}) return null;
      throw new Error('Visible target missing: ' + ${JSON.stringify(selector)});
    }
    const rect = element.getBoundingClientRect(), origin = frame?.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + Math.min(rect.height / 2, 60);
    const hit = owner.elementFromPoint(x, y);
    return { x: x + (origin?.left ?? 0), y: y + (origin?.top ?? 0),
      hit: hit === element || element.contains(hit), hitTag: hit?.tagName,
      hitId: hit?.id, hitClass: hit?.className,
      hitPath: hit && [...(function*(){ for(let node=hit;node;node=node.parentElement) yield node.tagName+'#'+node.id+'.'+node.className; })()].slice(0,6),
      inert: !!element.closest('[inert]'), pointerEvents: getComputedStyle(element).pointerEvents,
      visibilityState: owner.visibilityState };
  })()`);
}
async function waitHit(selector, fixture = false) {
  return until(async () => {
    const position = await point(selector, fixture, true);
    return position?.hit ? position : undefined;
  }, 5000);
}
async function waitDockPresentation(expanded) {
  return until(() => cdp.evaluate(`(() => {
    const panel = window.__nexusR24NativeProbe?.panel
      ?? [...document.querySelectorAll('[data-sidebar-right-panel]')].find(node => !node.closest('[hidden]'));
    const dock = panel?.querySelector('.nexus-native-dock-tree[data-dockkit-host="dock"]');
    if (!dock || panel.hasAttribute('data-sidebar-right-open') !== ${expanded}) return false;
    const visibility = getComputedStyle(dock).visibility;
    const moving = panel.getAnimations({subtree:true}).some(animation =>
      'transitionProperty' in animation && animation.transitionProperty === 'transform'
      && (animation.playState === 'running' || animation.pending));
    return visibility === ${JSON.stringify(expanded ? 'visible' : 'hidden')} && !moving;
  })()`), 5000);
}
const scrollTop = (selector, fixture) => cdp.evaluate(`(() => {
  const owner = ${fixture ? 'window.__nexusDockRegression.owner' : 'document'};
  return owner.querySelector(${JSON.stringify(selector)})?.scrollTop;
})()`);
async function click(selector, fixture = false) {
  const position = await point(selector, fixture);
  report.inputAttempts.push({ action: 'click', selector, fixture, ...position });
  assert.equal(position.hit, true, `Mouse target is blocked: ${selector}`);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: position.x, y: position.y });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: position.x, y: position.y, button: 'left', clickCount: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: position.x, y: position.y, button: 'left', clickCount: 1 });
  await delay(100);
  return position;
}
async function wheel(selector, fixture = false) {
  const position = await point(selector, fixture);
  const before = await scrollTop(selector, fixture);
  report.inputAttempts.push({ action: 'wheel', selector, fixture, ...position });
  assert.equal(position.hit, true, `Wheel target is blocked: ${selector}`);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: position.x, y: position.y });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: position.x, y: position.y, deltaY: 240, deltaX: 0 });
  await until(async () => await scrollTop(selector, fixture) > before, 3000);
  return position;
}
async function escape() {
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await delay(100);
}
const trigger = '.nexus-native-dock-controls > button, .nexus-native-dock-controls > summary';
const nativeSnapshot = () => cdp.evaluate(`(() => {
  const panel = window.__nexusR24NativeProbe?.panel;
  const menu = panel?.querySelector('.nexus-native-dock-menu');
  return { clicks: window.__nexusR24NativeProbe?.clicks ?? 0,
    scrollTop: document.getElementById('nexus-r24-native-scroll')?.scrollTop ?? 0,
    open: !!menu && (menu.matches(':popover-open') || menu.parentElement.matches('details[open]')),
    panelOpen: panel?.hasAttribute('data-sidebar-right-open'),
    pointerEvents: panel && getComputedStyle(panel).pointerEvents,
    bodyInert: document.body.inert, bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
    rootInert: document.documentElement.inert, rootPointerEvents: getComputedStyle(document.documentElement).pointerEvents,
    visibilityState: document.visibilityState, hasFocus: document.hasFocus(),
    inertCount: document.querySelectorAll('[inert]').length,
    menuRect: menu ? (() => { const r=menu.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })() : undefined,
    pointerCaptures: document.querySelectorAll('[data-dockkit-pointer]').length };
})()`);
try {
  // Hidden Electron windows can acknowledge clicks but stall wheel/compositor
  // input. Use the same foreground step as desktop-smoke before any input.
  await checks('foreground the isolated renderer before sending input', async () => {
    await cdp.call('Page.bringToFront');
    report.foreground = { afterBringToFront: await cdp.evaluate('document.visibilityState') };
    if (report.foreground.afterBringToFront !== 'visible') {
      try {
        // Restrict restoration to the Browser window belonging to this
        // validated synthetic page; never enumerate or alter other windows.
        const window = await cdp.call('Browser.getWindowForTarget', { targetId: target.id });
        report.foreground.windowId = window.windowId;
        report.foreground.originalBounds = window.bounds;
        await cdp.call('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal' } });
        await cdp.call('Page.bringToFront');
      } catch (error) { report.foreground.restoreError = error.message; }
    }
    report.rendererStart = await until(() => cdp.evaluate(`document.visibilityState === 'visible'
      && ({visibilityState:document.visibilityState, hasFocus:document.hasFocus()})`), 3000)
      .catch(() => { throw new Error('Synthetic Desktop remains hidden after foreground/restore; no input cases were run'); });
    assert.equal(report.rendererStart.visibilityState, 'visible');
    return report.rendererStart;
  });
  if (!report.cases.at(-1).passed) throw new Error(report.cases.at(-1).error);
  await checks('open a synthetic native conversation and its dock without submitting a message', async () => {
    const alreadyVisible = await cdp.evaluate(`!![...document.querySelectorAll('.nexus-native-dock-controls')].find(node => {
      const rect=node.getBoundingClientRect(); return rect.width>0 && rect.height>0 && getComputedStyle(node).visibility!=='hidden' && !node.closest('[hidden]');
    })`);
    if (!alreadyVisible) {
      const create = await cdp.evaluate(`(() => {
        const button=[...document.querySelectorAll('button')].find(node =>
          /^(新建会话|新会话|New session|New chat)$/.test((node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || '').trim()));
        if(button) button.setAttribute('data-nexus-r24-new-session','');
        return !!button;
      })()`);
      assert.equal(create, true, 'native New session control must be available');
      await click('[data-nexus-r24-new-session]');
      await waitHit('[data-sidebar-right-expand]');
      await click('[data-sidebar-right-expand]');
      await until(async () => cdp.evaluate(`!![...document.querySelectorAll('.nexus-native-dock-controls')].find(node => {
        const rect=node.getBoundingClientRect();return rect.width>0&&rect.height>0&&getComputedStyle(node).visibility!=='hidden'&&!node.closest('[hidden]');
      })`), 10000);
    }
    await waitDockPresentation(true);
    const sessionId = await cdp.evaluate(`(() => {
      const control=[...document.querySelectorAll('.nexus-native-dock-controls')].find(node => {
        const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(node).visibility!=='hidden'&&!node.closest('[hidden]');
      });
      return control?.closest('[data-sidebar-right-session]')?.dataset.sidebarRightSession;
    })()`);
    assert.match(sessionId ?? '', /^[a-zA-Z0-9-]+$/, 'visible dock must belong to a real session identity');
    let archive;
    const sessionRoot = join(state.productHome, 'sessions');
    for (const row of await readdir(sessionRoot, { withFileTypes: true })) {
      if (!row.isDirectory()) continue;
      const candidate = join(sessionRoot, row.name, sessionId, 'session.v4.jsonl.zstd');
      try { await access(candidate); archive = candidate; break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    assert.ok(archive, 'session must have its official persisted archive before testing the sidebar');
    report.nativeOwner = { sessionId, archive, trigger: await point(trigger) };
    return { usedNativeNewSession: !alreadyVisible, sentMessages: 0, modelRequestsSent: 0, ...report.nativeOwner };
  });
  await checks('native sidebar has a visible layout trigger and interactive probe', async () => {
    await point(trigger);
    await cdp.evaluate(`(() => {
      const control = [...document.querySelectorAll('.nexus-native-dock-controls')].find(node => {
        const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0
          && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[hidden],[inert]');
      });
      const panel = control.closest('[data-sidebar-right-panel]');
      const pane = panel.querySelector('.nexus-native-dock-portal[aria-hidden="false"]')
        ?? panel.querySelector('[data-dockkit-pane]');
      const probe = document.createElement('div');
      probe.id = 'nexus-r24-native-probe';
      probe.style.cssText = 'position:absolute;left:16px;top:110px;width:180px;z-index:30;background:#eee;color:#111;padding:8px';
      probe.innerHTML = '<button id="nexus-r24-native-target" type="button" style="width:160px;height:36px">R24交互探针</button><div id="nexus-r24-native-scroll" style="height:180px;width:160px;overflow:auto;margin-top:12px"><div style="height:2000px">R24滚动探针</div></div>';
      pane.append(probe);
      const state = window.__nexusR24NativeProbe = { clicks: 0, panel, probe };
      probe.querySelector('button').addEventListener('click', () => { state.clicks++; });
    })()`);
    const hit = await click('#nexus-r24-native-target');
    await wheel('#nexus-r24-native-scroll');
    const result = await nativeSnapshot();
    assert.equal(result.clicks, 1); assert.ok(result.scrollTop > 0);
    return { hit, result };
  });
  await checks('opening layout preserves clicks and wheel, and outside pointer dismisses', async () => {
    const before = await nativeSnapshot();
    await click(trigger);
    assert.equal((await nativeSnapshot()).open, true);
    const menuHit = await point('.nexus-native-dock-menu button:not(:disabled)');
    const hit = await click('#nexus-r24-native-target');
    const wheelHit = await wheel('#nexus-r24-native-scroll');
    const result = await nativeSnapshot();
    report.openingInteraction = { before, menuHit, hit, wheelHit, result };
    assert.equal(result.clicks, before.clicks + 1);
    assert.ok(result.scrollTop > before.scrollTop);
    assert.equal(result.open, false, 'outside pointer must dismiss the layout popover');
    assert.equal(menuHit.hit, true, 'layout actions must be hit-testable within the native chrome');
    return { before, menuHit, hit, wheelHit, result };
  });
  await checks('diagnose blocked mouse trigger with auxiliary keyboard activation', async () => {
    const hit = await point(trigger);
    if (hit.hit) return { skipped: true, reason: 'native mouse target is hit-testable' };
    await cdp.evaluate(`(() => {
      const panel=window.__nexusR24NativeProbe?.panel;
      panel?.querySelector('.nexus-native-dock-controls > summary,.nexus-native-dock-controls > button')?.focus();
    })()`);
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await delay(100);
    const result = await nativeSnapshot();
    const menuHit = result.open ? await point('.nexus-native-dock-menu button:not(:disabled)') : undefined;
    return { activation: 'keyboard-only diagnostic; does not satisfy mouse regression', hit, menuHit, result };
  });
  await checks('Escape dismisses without leaving the pane inert or capturing input', async () => {
    if ((await nativeSnapshot()).open) await click(trigger);
    await click(trigger); await escape();
    const before = await nativeSnapshot();
    await click('#nexus-r24-native-target');
    const result = await nativeSnapshot();
    assert.equal(result.open, false); assert.equal(result.clicks, before.clicks + 1);
    assert.equal(result.bodyInert, false); assert.equal(result.pointerCaptures, 0);
    return { result };
  });
  await checks('collapse and reopen on the same page releases the menu and preserves input', async () => {
    if (!(await nativeSnapshot()).open) await click(trigger);
    await waitHit('[data-sidebar-right-toggle]');
    await click('[data-sidebar-right-toggle]');
    await waitDockPresentation(false);
    await waitHit('[data-sidebar-right-expand]');
    await click('[data-sidebar-right-expand]');
    await waitDockPresentation(true);
    await waitHit(trigger);
    await waitHit('#nexus-r24-native-target');
    const before = await nativeSnapshot();
    const hit = await click('#nexus-r24-native-target');
    const wheelHit = await wheel('#nexus-r24-native-scroll');
    const result = await nativeSnapshot();
    report.reopenedInteraction = { before, hit, wheelHit, result };
    assert.equal(result.clicks, before.clicks + 1);
    assert.ok(result.scrollTop > before.scrollTop);
    assert.equal(result.open, false, 'hidden owner must dismiss its menu');
    return { hit, wheelHit, result };
  });
  await cdp.evaluate(`window.__nexusR24NativeProbe?.probe.remove(); delete window.__nexusR24NativeProbe;`);

  if (!args.includes('--native-only')) {
    const fixture = await build({
      entryPoints: ['tests/fixtures/native-dock-popover.tsx'], bundle: true, write: false,
      platform: 'browser', format: 'iife', target: 'es2022', jsx: 'automatic', logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'fixture-css', setup(builder) {
        builder.onLoad({ filter: /\.css$/ }, async file => ({ loader: 'text', contents: await readFile(file.path, 'utf8') }));
      } }],
    });
    await cdp.evaluate(fixture.outputFiles[0].text);
    const snapshot = () => cdp.evaluate('window.__nexusDockRegression.snapshot()');
    await checks('production popover escapes clipped chrome and does not start native drag', async () => {
      await waitHit(trigger, true);
      await click(trigger, true);
      await until(async () => (await snapshot()).open, 3000);
      const menuHit = await point('#nexus-r24-action', true);
      assert.equal(menuHit.hit, true);
      await click('#nexus-r24-action', true);
      await until(async () => !(await snapshot()).open, 3000);
      const result = await snapshot();
      assert.equal(result.open, false); assert.equal(result.drags, 0);
      return { menuHit, result };
    });
    for (const [name, expression] of [
      ['hidden retained owner', '__nexusDockRegression.active(false)'],
      ['changed owner identity', '__nexusDockRegression.identity("synthetic-owner-b")'],
      ['component unmount', '__nexusDockRegression.mounted(false)'],
    ]) await checks(`production popover cleans up on ${name}`, async () => {
      await cdp.evaluate('__nexusDockRegression.active(true); __nexusDockRegression.mounted(true);');
      await waitHit(trigger, true);
      await click(trigger, true);
      await until(async () => (await snapshot()).open, 3000);
      await cdp.evaluate(expression);
      await until(async () => !(await snapshot()).open, 3000);
      const before = await snapshot();
      assert.equal(before.open, false);
      await waitHit('#nexus-r24-target', true);
      await click('#nexus-r24-target', true);
      await wheel('#nexus-r24-scroll', true);
      const result = await snapshot();
      assert.equal(result.clicks, before.clicks + 1);
      assert.ok(result.scrollTop > before.scrollTop);
      assert.equal(result.bodyInert, false);
      if (name === 'component unmount') assert.equal(result.menus, 0);
      return { result };
    });
    await cdp.evaluate('__nexusDockRegression.dispose()');
  }
} finally {
  try { report.rendererEnd = await cdp.evaluate('({visibilityState:document.visibilityState,hasFocus:document.hasFocus()})'); }
  catch {}
  try { await cdp.evaluate('window.__nexusR24NativeProbe?.probe.remove(); delete window.__nexusR24NativeProbe; window.__nexusDockRegression?.dispose();'); }
  catch {}
  cdp.close();
  report.finishedAt = new Date().toISOString();
  report.passed = report.cases.length > 0 && report.cases.every(row => row.passed);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify({ output, passed: report.passed, cases: report.cases.map(({ name, passed }) => ({ name, passed })) }, null, 2));
if (!report.passed) process.exitCode = 1;
