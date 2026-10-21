import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const browser = [
  process.env.NEXUS_BROWSER_EXECUTABLE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

test('real slot wrappers retain hero ownership, official default wordmark, sticky chrome, and responsive settings', {
  skip: browser ? false : 'A local Chromium browser is required for DOM layout; NEXUS_BROWSER_EXECUTABLE can select one',
  timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-native-appearance-dom-'));
  try {
    const fixture = fileURLToPath(new URL('./fixtures/native-appearance-dom.tsx', import.meta.url));
    const bundle = await build({
      entryPoints: [fixture], bundle: true, write: false, format: 'iife', platform: 'browser',
      target: 'chrome120', minify: true, loader: { '.png': 'dataurl' }, logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    await writeFile(join(directory, 'fixture.js'), bundle.outputFiles[0].contents);
    await writeFile(join(directory, 'fixture.html'), await readFile(new URL('./fixtures/native-appearance-dom.html', import.meta.url)));
    for (const name of ['native-chrome.css', 'theme.css']) {
      await writeFile(join(directory, name), await readFile(new URL(`../src/client/${name}`, import.meta.url)));
    }
    const { stdout } = await promisify(execFile)(browser!, [
      '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(directory, 'browser')}`, '--allow-file-access-from-files',
      '--virtual-time-budget=8000', '--dump-dom', pathToFileURL(join(directory, 'fixture.html')).href,
    ], { encoding: 'utf8', timeout: 22000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const encoded = /data-nexus-fixture="([A-Za-z0-9+/=]+)"/.exec(stdout)?.[1];
    assert.ok(encoded, 'The local browser fixture must finish and publish a structured result');
    const result = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    assert.equal(result.ok, true, result.error);
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('nexus-native-appearance-dom-')) throw new Error('Unexpected fixture cleanup path');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
