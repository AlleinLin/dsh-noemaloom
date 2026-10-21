// Continue only the disposable Desktop created by desktop-smoke.mjs.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdDecompressSync, zstdCompressSync, constants as zstdConstants } from 'node:zlib';
import { Session } from '@deepseek-ai/dsh-session';
import { until } from './desktop-cdp.mjs';

const evidence = resolve('evidence/private-desktop-inspection');
const statePath = join(evidence, 'smoke-state.json');
const state = JSON.parse(await readFile(statePath, 'utf8'));
const insideTemp = relative(tmpdir(), state.temporary);
if (!insideTemp || insideTemp.startsWith('..') || !insideTemp.startsWith('nexus-original-desktop-'))
  throw new Error('Only the synthetic Desktop profile is eligible');
const profile = join(state.productHome, 'profiles/desktop');
if (JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).name !== 'nexus-disposable-desktop-profile')
  throw new Error('Disposable profile marker missing');
try { process.kill(state.pid, 0); throw new Error('Close the synthetic Desktop before reinstalling'); }
catch (error) { if (error.code !== 'ESRCH') throw error; }

// Materialize an offline archive with the official Session event validator.
// This is synthetic history; no prompt is submitted and no provider is called.
if (process.argv.includes('--seed')) {
  const targetIndex = process.argv.indexOf('--session-id');
  const targetId = targetIndex < 0 ? undefined : process.argv[targetIndex + 1];
  async function seed(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (await seed(path)) return true; }
      else if (entry.name === 'session.v4.jsonl.zstd') {
        const lines = zstdDecompressSync(await readFile(path)).toString().trim().split('\n');
        const { type: _type, ...header } = JSON.parse(lines[0]);
        if (targetId && header.id !== targetId) continue;
        // Repair only archives created by this fixture, never arbitrary history.
        const ownFixture = lines.slice(1).some(line => {
          const event = JSON.parse(line);
          return event.type === 'user/message' && event.data?.id === 'fixture-user';
        });
        if (lines.length !== 1 && !ownFixture) continue;
        const session = Session.create(header.id, [], header);
        session.append('turn/start', { turn: 1 });
        session.append('user/message', { id: 'fixture-user', role: 'user', source: { kind: 'user' },
          content: [{ type: 'text', text: '离线桌面验收样例：查看原生会话工具。' }] }, { surfaceOp: 'append' });
        session.append('step/start', { turn: 1, step: 1 });
        session.append('assistant/message', { turn: 1, step: 1, stream: [],
          message: { id: 'fixture-assistant', role: 'assistant', source: { kind: 'model', provider: 'offline-fixture', model: 'offline-fixture' },
            content: [{ type: 'text', text: '这是本地构造的测试记录，没有请求任何模型。' }] } }, { surfaceOp: 'append' });
        session.append('step/end', { turn: 1, step: 1 });
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
        // The official archive scanner reads the first independent zstd frame
        // as exactly one header line. Events must start in a separate frame.
        const options = { params: { [zstdConstants.ZSTD_c_checksumFlag]: 1 } };
        await writeFile(path, Buffer.concat([
          zstdCompressSync(Buffer.from(`${lines[0]}\n`), options),
          zstdCompressSync(Buffer.from(`${session.snapshotEvents().map(event => JSON.stringify(event)).join('\n')}\n`), options),
        ]));
        const registryPath = join(state.productHome, 'storages/workspace.json');
        const registry = JSON.parse(await readFile(registryPath, 'utf8'));
        const workspaceRows = Object.values(registry.tables?.workspaces ?? {});
        const owner = workspaceRows.find(row => row && Array.isArray(row.sessionIds)
          && (row.sessionIds.includes(header.id) || row.path === header.cwd));
        if (owner && !owner.sessionIds.includes(header.id)) {
          owner.sessionIds.push(header.id);
          await writeFile(registryPath, JSON.stringify(registry, null, 2));
        }
        // Invalidate only this disposable fixture's previously rejected entry.
        if (!/^[a-zA-Z0-9-]+$/.test(header.id)) throw new Error('Invalid synthetic session identity');
        await unlink(join(state.productHome, 'storages/session_projcache/sessions', `${header.id}.json`))
          .catch(error => { if (error.code !== 'ENOENT') throw error; });
        state.fixtureSessionId = header.id;
        return true;
      }
    }
    return false;
  }
  if (!await seed(join(state.productHome, 'sessions'))) throw new Error('No empty synthetic archive available');
}
const harnessDirectory = process.env.NEXUS_DSH_ROOT ?? join(process.env.ProgramFiles ?? 'C:/Program Files', 'DeepSeek Harness');
const executable = join(harnessDirectory, 'DeepSeek Harness.exe');
const cli = join(harnessDirectory, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|CREDENTIAL)/i.test(key)));
Object.assign(env, { DSH_HOME: state.productHome, DSH_AGENTS_HOME: join(state.temporary, 'agents'), MNEMON_DATA_DIR: join(state.temporary, 'mnemon'), ELECTRON_RUN_AS_NODE: '1' });
// pnpm may reuse the old file: dependency when a same-version tarball is
// overwritten at the same path. The shipping installer already uses a digest
// filename; use that same immutable identity for disposable verification.
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const packageBytes = await readFile(resolve(`artifacts/local-dsh-nexus-${manifest.version}.tgz`));
const packageDigest = createHash('sha256').update(packageBytes).digest('hex');
const packagePath = join(state.temporary, `local-dsh-nexus-${packageDigest}.tgz`);
await writeFile(packagePath, packageBytes);
const installer = spawn(executable, ['--expose-internals', cli, 'plugin', '--profile', 'desktop', 'add', '--ignore-scripts', '--save-exact', packagePath],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
installer.stdout.on('data', bytes => { output += bytes; }); installer.stderr.on('data', bytes => { output += bytes; });
const exit = await new Promise((accept, reject) => { installer.once('error', reject); installer.once('close', accept); });
await writeFile(join(evidence, 'resume-install.log'), output);
if (exit !== 0) throw new Error(`Synthetic install failed: ${exit}`);
for (const file of ['lib/client.js', 'lib/canvases.js', 'lib/canvas-original/thoughtdag/dist-app/assets/nexus-entry.js']) {
  const expected = createHash('sha256').update(await readFile(resolve(file))).digest('hex');
  const actual = createHash('sha256').update(await readFile(join(profile, 'node_modules/@local/dsh-nexus', file))).digest('hex');
  if (actual !== expected) throw new Error(`Synthetic Desktop installed stale files: ${file}`);
}
delete env.ELECTRON_RUN_AS_NODE;
// Separate Chromium data avoids an old DevToolsActivePort discovery race.
state.userData = join(state.temporary, `electron-${Date.now()}`);
await mkdir(state.userData);
const child = spawn(executable, [`--user-data-dir=${state.userData}`, '--remote-debugging-port=0'], { env, windowsHide: true, detached: true, stdio: 'ignore' });
child.unref(); state.pid = child.pid;
const text = await until(async () => { try { return await readFile(join(state.userData, 'DevToolsActivePort'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }, 60000);
state.port = Number(text.split('\n')[0]);
await writeFile(statePath, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ pid: state.pid, port: state.port, fixtureSessionId: state.fixtureSessionId, modelRequestsSent: 0 }));
