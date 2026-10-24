import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HOST_BOUNDARIES, reviewHostSource } from '../scripts/review-host-source.mjs';

test('host source review retains more than 300 paths and verifies the exact native source objects', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'noemaloom-host-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const exec = promisify(execFile);
  const git = async (...args) => (await exec('git', ['-C', directory, ...args], { windowsHide: true })).stdout.trim();
  await git('init', '--quiet'); await git('config', 'user.name', 'Source Review Test');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  for (const path of HOST_BOUNDARIES) {
    const file = path.endsWith('.ts') ? path : `${path}/index.ts`;
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await writeFile(join(directory, file), 'export const before = true;\n');
  }
  await git('add', '.'); await git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline');
  const base = await git('rev-parse', 'HEAD');
  const changed = `${HOST_BOUNDARIES[0]}/index.ts`;
  await writeFile(join(directory, changed), 'export const before = false;\n');
  await mkdir(join(directory, 'changes'));
  for (let i = 0; i < 340; i++) await writeFile(join(directory, `changes/${i}.txt`), 'change\n');
  await git('add', '.'); await git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'candidate');
  const target = await git('rev-parse', 'HEAD');
  const report = await reviewHostSource(directory, base, target);
  assert.equal(report.changedFileCount, 341);
  assert.ok(report.changedFiles.includes(changed));
  assert.equal(report.boundaries.filter(row => !row.unchanged).length, 1);
  assert.equal(report.boundaries[0].path, HOST_BOUNDARIES[0]);
  assert.equal(report.boundaries[0].unchanged, false);
  await assert.rejects(reviewHostSource(directory, '--all', target), /commit ids/);
});
