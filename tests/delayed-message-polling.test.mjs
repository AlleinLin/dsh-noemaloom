import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const browser = process.env.NEXUS_BROWSER_EXECUTABLE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test('delayed message status accepts slow replies without overlapping polls or starving the visible result', {
  skip: existsSync(browser) ? false : 'Local Chromium required', timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-delayed-polling-'));
  try {
    const bundle = await build({
      entryPoints: ['tests/fixtures/delayed-message-polling.tsx'], bundle: true, write: false,
      format: 'iife', platform: 'browser', target: 'chrome120', logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    await writeFile(join(directory, 'fixture.js'), bundle.outputFiles[0].contents);
    await writeFile(join(directory, 'fixture.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>');
    const { stdout } = await promisify(execFile)(browser, [
      '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(directory, 'browser')}`, '--allow-file-access-from-files',
      '--virtual-time-budget=10000', '--dump-dom', pathToFileURL(join(directory, 'fixture.html')).href,
    ], { windowsHide: true, encoding: 'utf8', timeout: 22000, maxBuffer: 1024 * 1024 });
    const encoded = /data-delayed-fixture="([A-Za-z0-9+/=]+)"/.exec(stdout)?.[1];
    assert(encoded, 'Browser must publish its actual dialog result');
    const result = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    assert.equal(result.delivered, true, JSON.stringify(result));
    assert.equal(result.maximumPending, 1, JSON.stringify(result));
    assert(result.calls >= 2, JSON.stringify(result));
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('nexus-delayed-polling-')) {
      throw new Error('Unexpected fixture cleanup path');
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
