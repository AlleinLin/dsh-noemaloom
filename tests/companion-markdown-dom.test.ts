import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('companion Markdown renders safely in the real browser DOM and fits the native conversation column', {
  skip: browser ? false : 'A local Chromium browser is required to exercise the real DOM sanitizer',
  timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-companion-markdown-'));
  try {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL('./fixtures/companion-markdown.tsx', import.meta.url))],
      bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome120',
      loader: { '.css': 'text' }, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
    });
    await writeFile(join(directory, 'fixture.js'), bundle.outputFiles[0].contents);
    await writeFile(join(directory, 'fixture.html'), `<!doctype html><html><head><meta charset="utf-8">
      <style>body{background:#262624;color:#eee}ul,ol{list-style:none;margin:0;padding:0}*,::before,::after{box-sizing:border-box}</style>
      </head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
    const { stdout } = await promisify(execFile)(browser!, [
      '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(directory, 'browser')}`, '--allow-file-access-from-files',
      '--virtual-time-budget=3000', '--dump-dom', pathToFileURL(join(directory, 'fixture.html')).href,
    ], { encoding: 'utf8', timeout: 22000, maxBuffer: 1024 * 1024, windowsHide: true });
    const encoded = /data-nexus-fixture="([A-Za-z0-9+/=]+)"/.exec(stdout)?.[1];
    assert.ok(encoded, 'The local Markdown regression must publish a structured result');
    const result = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    assert.equal(result.ok, true, result.error);
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('nexus-companion-markdown-'))
      throw new Error('Unexpected fixture cleanup path');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
