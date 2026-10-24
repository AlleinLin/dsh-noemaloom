import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parseFactory } from '../scripts/original-factory.mjs';
import { adaptComputerUseClient } from '../scripts/adapt-new-originals.mjs';
import { launchValidationBrowser } from '../scripts/desktop-browser.mjs';
import { until } from '../scripts/desktop-cdp.mjs';

test('Codinput native input seats render the real computer chip with isolated session actions and live slot lifecycle', {
  timeout: 90_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'noemaloom-seats-'));
  let launched;
  try {
    const factory = adaptComputerUseClient(parseFactory(
      await readFile('vendor/computer-use/client.js', 'utf8'), '@local/dsh-computer-use').factory);
    const bundle = await build({ entryPoints: ['tests/fixtures/codinput-seats.tsx'],
      bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome120',
      jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
      plugins: [{ name: 'actual-computer-client', setup(builder) {
        builder.onResolve({ filter: /^nexus:test-computer-client$/ }, () => ({ path: 'client', namespace: 'native-fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'native-fixture' }, () => ({
          contents: `import * as React from 'react'; export const original=(${factory})(name=>{if(name==='react')return React;throw new Error(name)});`,
          resolveDir: resolve('.'), loader: 'js',
        }));
      } }],
    });
    await writeFile(join(directory, 'fixture.js'), bundle.outputFiles[0].contents);
    await writeFile(join(directory, 'fixture.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>');
    launched = await launchValidationBrowser({
      executable: process.env.NEXUS_BROWSER_EXECUTABLE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      directory, url: pathToFileURL(join(directory, 'fixture.html')).href,
    });
    const cdp = launched.cdp;
    await until(() => cdp.evaluate('!!window.__seats && document.querySelectorAll(".dsh-cu-chip[data-state=off]").length===2'), 8000);
    assert.deepEqual(await cdp.evaluate(`Array.from(document.querySelectorAll('section')).map(s=>({
      id:s.dataset.session, chips:s.querySelectorAll('.dsh-cu-chip').length,
      witnesses:s.querySelectorAll('[data-witness]').length, first:s.querySelector('[data-first]')?.dataset.first,
      witness:s.querySelector('[data-witness]')?.textContent,
      ordered:!!(s.querySelector('[data-first]').compareDocumentPosition(s.querySelector('[data-witness]'))&Node.DOCUMENT_POSITION_FOLLOWING)
    }))`), ['main', 'child'].map(id => ({ id, chips: 1, witnesses: 1, first: id,
      witness: `preferred:${id}:context-${id}`, ordered: true })));
    const click = async selector => {
      const point = await cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp.call('Input.dispatchMouseEvent', {
        type, ...point, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }),
      });
    };
    await click('[data-session=child] .dsh-cu-chip');
    await until(() => cdp.evaluate('!!document.querySelector("[data-session=child] .dsh-cu-chip[data-state=on]")'), 3000);
    assert.equal(await cdp.evaluate('document.querySelector("[data-session=main] .dsh-cu-chip").dataset.state'), 'off');
    await click('[data-session=main] [data-witness]');
    await click('[data-session=child] [data-witness]');
    const snapshot = await cdp.evaluate('window.__seats.snapshot()');
    assert.deepEqual(snapshot.actions, ['main', 'child']);
    assert.deepEqual(snapshot.requests.filter(row => row.method === 'POST').map(row => row.payload),
      [{ sessionId: 'child', enabled: true }]);
    assert.ok(snapshot.requests.every(row => row.path === '/api/plugins/dsh-noemaloom/computer-use/state'));
    assert.deepEqual(snapshot.injectCalls, ['main', 'child']);
    await cdp.evaluate('window.__seats.removePreferred()');
    await until(() => cdp.evaluate('document.querySelectorAll("[data-witness=base]").length===2'), 3000);
    await cdp.evaluate('window.__seats.switchChild()');
    await until(() => cdp.evaluate('!!document.querySelector("[data-session=replacement] .dsh-cu-chip[data-state=off]")'), 3000);
    assert.equal(await cdp.evaluate('document.querySelector("[data-session=child]")'), null);
    assert.equal(await cdp.evaluate('document.querySelector("[data-session=replacement] [data-witness]").textContent'), 'base:replacement:context-replacement');
    await cdp.evaluate('window.__seats.dispose()');
    assert.equal(await cdp.evaluate('document.querySelectorAll(".dsh-cu-chip,#dsh-computer-use-style").length'), 0);
  } finally {
    await launched?.close();
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('noemaloom-seats-'))
      throw new Error('Unexpected cleanup target');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
