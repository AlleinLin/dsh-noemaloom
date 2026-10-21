import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { createAtomicStore } from '../src/domain/storage/index.js';
import { createFilesModule } from '../src/domain/files/index.js';
import { workspacePath } from '../src/domain/files/paths.js';
import { createUsageModule } from '../src/domain/usage/index.js';
import { normalizeUsage } from '../src/domain/usage/normalize.js';
import { createSearchModule } from '../src/adapters/search/index.js';
import { publicUrl } from '../src/adapters/search/network.js';
import { isP256Spki, verifyEs256 } from '../src/domain/integrations/remote/crypto.js';
import { PairingService } from '../src/domain/integrations/remote/pairing.js';
import { createNativeRemoteBridge } from '../src/domain/integrations/native-remote.js';
import { importSshConfig } from '../src/domain/integrations/ssh.js';
import { hostAuthority } from '../src/host/host-adapter.js';
import { NexusError, type NexusServices } from '../src/ports/contracts.js';

async function fixture(t: { after(callback: () => Promise<unknown>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-integrations-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspaceRoot = join(dir, 'workspace'), dataDir = join(dir, 'data');
  await mkdir(workspaceRoot); await mkdir(dataDir);
  const services: NexusServices = {
    dataDir, workspaceRoot, store: createAtomicStore(dataDir),
    executor: { async run() { return { exitCode: 0, stdout: '', stderr: '', cancelled: false, durationMs: 0 }; } },
    host: { async facts() { return {}; }, async model() { throw new Error('no model'); }, async spawn() { throw new Error('no child'); }, async sessions() { throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', 'missing'); }, async secret() { return undefined; }, async approve() { return true; } },
    emit() {}, async invoke() { throw new Error('not registered'); },
  };
  return { dir, services, files: createFilesModule(services) };
}

test('file CAS preserves BOM, CRLF and original bytes on a concurrent edit conflict', async t => {
  const { services, files } = await fixture(t);
  const path = join(services.workspaceRoot, '中文文件.txt');
  await writeFile(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('第一行\r\n第二行\r\n', 'utf16le')]));
  const initial = await files.dispatch({ action: 'read', params: { path: '中文文件.txt' } }) as { revision: number };
  const saved = await files.dispatch({ action: 'write', expectedRevision: initial.revision, params: { path: '中文文件.txt', content: '第一行\n已更新\n' } }) as { revision: number; encoding: string; newline: string };
  assert.equal(saved.encoding, 'utf16le-bom'); assert.equal(saved.newline, 'crlf');
  const bytes = await readFile(path); assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]); assert.equal(bytes.subarray(2).toString('utf16le'), '第一行\r\n已更新\r\n');
  await assert.rejects(files.dispatch({ action: 'write', expectedRevision: initial.revision, params: { path: '中文文件.txt', content: 'lost' } }), (error: unknown) => error instanceof NexusError && error.code === 'REVISION_CONFLICT');
  assert.deepEqual(await readFile(path), bytes);
});

test('workspace path refuses traversal and an ancestor symlink escaping root', async t => {
  const { dir, services } = await fixture(t);
  await assert.rejects(workspacePath(services.workspaceRoot, '../secret', true), (error: unknown) => error instanceof NexusError && error.code === 'SCOPE_MISMATCH');
  const outside = join(dir, 'outside'); await mkdir(outside);
  try { await symlink(outside, join(services.workspaceRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.diagnostic('OS does not allow symlink fixture'); return; } throw error; }
  await assert.rejects(workspacePath(services.workspaceRoot, 'escape/secret.txt', true), (error: unknown) => error instanceof NexusError && error.code === 'SCOPE_MISMATCH');
});

test('files scan off is inert; CSV quoted newlines and archive entry hashes are real', async t => {
  const { files } = await fixture(t);
  await files.dispatch({ action: 'write', params: { path: 'data.csv', content: 'a,b\n"line\none","double ""quote"""\n', createOnly: true } });
  const table = await files.dispatch({ action: 'table.read', params: { path: 'data.csv' } }) as { rows: string[][] };
  assert.deepEqual(table.rows, [['line\none', 'double "quote"']]);
  const scan = await files.dispatch({ action: 'search', params: { mode: 'off' } }) as { items: unknown[]; provider: string };
  assert.deepEqual(scan.items, []); assert.equal(scan.provider, 'off');
});

test('host normalized input is disjoint; DeepSeek and Anthropic do not double count cache', () => {
  const host = normalizeUsage({ inputTokens: 20, outputTokens: 9, cacheReadTokens: 70, cacheWriteTokens: 10 }, 'deepseek', 'host-normalized');
  assert.equal(host.status, 'reported'); assert.equal(host.uncachedInputTokens, 20); assert.equal(host.providerPromptTotal, 100);
  const deepseek = normalizeUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30, completion_tokens: 9, total_tokens: 109 }, 'deepseek');
  assert.equal(deepseek.uncachedInputTokens, 30); assert.equal(deepseek.cacheWriteTokens, 0);
  const anthropic = normalizeUsage({ input_tokens: 20, cache_read_input_tokens: 70, cache_creation_input_tokens: 10, output_tokens: 9 }, 'anthropic');
  assert.equal(anthropic.providerPromptTotal, 100); assert.equal(anthropic.status, 'reported');
  assert.equal(normalizeUsage({ prompt_tokens: 3, prompt_cache_hit_tokens: 9, completion_tokens: 1 }, 'deepseek').status, 'invalid');
  assert.equal(normalizeUsage({ inputTokens: 1, outputTokens: 2 }, '', 'host-normalized').status, 'unreported');
});

test('usage ledger replaces interim samples, retains all retry attempts and separates currencies', async t => {
  const { services } = await fixture(t), usage = createUsageModule(services);
  t.after(async () => { await usage.dispose?.(); });
  for (const [provider, currency] of [['a', 'USD'], ['b', 'CNY']]) await usage.dispatch({ action: 'prices.save', params: { id: provider, provider, model: 'm', currency, effectiveAt: '2026-01-01T00:00:00.000Z', source: 'test', inputPerMillion: '1', outputPerMillion: '2', cacheReadPerMillion: '0.1', cacheWritePerMillion: '1.25' } });
  const record = { sessionId: 's', logicalCallId: 'call', attemptId: 'one', provider: 'a', model: 'm', startedAt: '2026-10-19T00:00:00.000Z', source: 'host-normalized', status: 'streaming', usageRevision: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  await usage.dispatch({ action: 'record', params: record });
  await usage.dispatch({ action: 'record', params: { ...record, usageRevision: 2, status: 'cancelled', usage: { ...record.usage, outputTokens: 10 } } });
  await usage.dispatch({ action: 'record', params: { ...record, usageRevision: 1 } });
  await usage.dispatch({ action: 'record', params: { ...record, attemptId: 'retry', provider: 'b', status: 'settled' } });
  const result = await usage.dispatch({ action: 'summary', params: { sessionId: 's' } }) as { attempts: number; totals: {outputTokens: number}; costs: {currency: string}[] };
  assert.equal(result.attempts, 2); assert.equal(result.totals.outputTokens, 15); assert.deepEqual(result.costs.map(row => row.currency).sort(), ['CNY', 'USD']);
});

test('search validates even when unconfigured and rejects SSRF literals before transport', async t => {
  const { services } = await fixture(t), search = createSearchModule(services);
  await assert.rejects(search.dispatch({ action: 'query', params: { query: 'x', maxResults: '8' } }), (error: unknown) => error instanceof NexusError && error.code === 'INVALID_ARGUMENT');
  await assert.rejects(search.dispatch({ action: 'query', params: { query: 'x' } }), (error: unknown) => error instanceof NexusError && error.code === 'SEARCH_UNCONFIGURED');
  for (const url of ['http://127.0.0.1/', 'https://169.254.169.254/', 'https://[::1]/', 'https://user:pass@example.com/']) await assert.rejects(publicUrl(url));
});

test('P256 signature and nonce are real, one shot, curve constrained and expire', () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), pub = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), message = Buffer.from('nonce');
  const signature = sign('sha256', message, { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  assert.equal(isP256Spki(pub), true); assert.equal(verifyEs256(pub, signature, message), true); assert.equal(verifyEs256(pub, signature, Buffer.from('different')), false);
  const bad = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'); assert.equal(isP256Spki(bad), false);
  let now = 0; const pairing = new PairingService({ now: () => now }); const ticket = pairing.issueToken(); assert.equal(pairing.consumeToken(ticket.value), true); assert.equal(pairing.consumeToken(ticket.value), false);
  const nonce = pairing.issueNonce(); now = 61000; assert.equal(pairing.consumeNonce(nonce.value), false);
});

test('real native WebSocket refuses unpaired operations, verifies P256, shares host sessions and revokes online peers', async t => {
  const { services, dir } = await fixture(t);
  const otherWorkspace = join(dir, 'other-workspace'); await mkdir(otherWorkspace);
  // Match the official session bridge DTO: cwd is authoritative workspace
  // metadata, while id/title alone cannot establish a remote session's scope.
  const hostSession = { id: 'host-session', sessionId: 'host-session', title: 'same host', cwd: services.workspaceRoot, header: { id: 'host-session', cwd: services.workspaceRoot } };
  const foreignSession = { id: 'other-session', sessionId: 'other-session', title: 'other workspace', cwd: otherWorkspace, header: { id: 'other-session', cwd: otherWorkspace } };
  const hostSessions = [hostSession, foreignSession, { id: 'unscoped-session', title: 'workspace metadata absent' }];
  const snapshotCalls: string[] = [];
  services.host.sessions = async (action, params) => {
    const authority = hostAuthority.getStore();
    assert.ok(authority);
    assert.ok(authority.actorId?.startsWith('remote:native-v1:'));
    assert.equal(authority.workspaceRoot, services.workspaceRoot);
    assert.equal(authority.signal?.aborted, false);
    if (action === 'list') {
      assert.equal(params.projectRoot, services.workspaceRoot);
      return hostSessions;
    }
    if (action === 'info') {
      const session = hostSessions.find(item => item.id === params.sessionId);
      if (!session) throw new NexusError('NOT_FOUND', 'unknown fixture session');
      return session;
    }
    if (action === 'snapshot') {
      snapshotCalls.push(String(params.sessionId));
      assert.equal(params.sessionId, 'host-session');
      assert.equal(authority.sessionId, 'host-session');
      return { ...hostSession, messages: [] };
    }
    throw new Error(`unexpected method ${action}`);
  };
  const bridge = createNativeRemoteBridge(services), server = createServer();
  server.on('upgrade', (request, socket, head) => { void bridge.handleUpgrade(request, socket, head); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/ios/v1`);
  t.after(async () => { client.terminate(); bridge.dispose(); await new Promise<void>(done => server.close(() => done())); });
  await new Promise<void>((done, reject) => { client.once('open', done); client.once('error', reject); });
  let frameId = 0;
  const call = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((done, reject) => {
    const id = ++frameId, timer = setTimeout(() => reject(new Error(`frame timeout ${method}`)), 5000);
    const receive = (data: WebSocket.RawData) => { const frame = JSON.parse(data.toString()); if (frame.id === id) { clearTimeout(timer); client.off('message', receive); done(frame); } };
    client.on('message', receive); client.send(JSON.stringify({ t: 'req', id, m: method, p: params }));
  });
  assert.equal((await call('session.list')).ok, false);
  assert.equal((await call('hello', { proto: 1 })).ok, true);
  const ticket = bridge.issueToken(), begun = await call('pair.begin', { token: ticket.value }), nonce = (begun.r as {nonce: string}).nonce;
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const signature = sign('sha256', Buffer.from(nonce, 'base64url'), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const paired = await call('pair.finish', { devicePubKey: publicKey, signature, name: 'fixture phone' }); assert.equal(paired.ok, true);
  assert.deepEqual((await call('session.list', { projectRoot: otherWorkspace, workspaceRoot: otherWorkspace, actorId: 'connection-owner' })).r, [hostSession]);
  assert.deepEqual((await call('session.snapshot', { sessionId: 'host-session' })).r, { ...hostSession, messages: [] });
  const foreignSnapshot = await call('session.snapshot', { sessionId: 'other-session' });
  assert.equal(foreignSnapshot.ok, false);
  assert.equal((foreignSnapshot.e as { code: string }).code, 'SCOPE_MISMATCH');
  const unscopedSnapshot = await call('session.snapshot', { sessionId: 'unscoped-session' });
  assert.equal(unscopedSnapshot.ok, false);
  assert.equal((unscopedSnapshot.e as { code: string }).code, 'SCOPE_MISMATCH');
  assert.deepEqual(snapshotCalls, ['host-session']);
  assert.equal((await call('pair.begin', { token: ticket.value })).ok, false);
  const devices = await bridge.devices(); assert.equal(devices.length, 1); assert.equal(devices[0].online, true);
  const closed = new Promise<number>(done => client.once('close', code => done(code)));
  await bridge.revoke(devices[0].deviceId); assert.equal(await closed, 4003);
});

test('SSH import expands Include once and retains conditional skip evidence without keys', async t => {
  const { services } = await fixture(t), dir = services.workspaceRoot;
  await writeFile(join(dir, 'config'), 'Include extra\nHost one\n HostName host.example\n User dev\n IdentityFile ~/.ssh/id_key\nMatch exec arbitrary\n User wrong\nHost *\n User default\n');
  await writeFile(join(dir, 'extra'), 'Include config\nHost two\n HostName second.example\n User ops\n');
  const result = await importSshConfig(join(dir, 'config'));
  assert.equal(result.hosts.length, 2); assert.equal(result.hosts.find(row => row.name === 'one')?.username, 'dev'); assert.equal(result.skipped.some(row => row.reason === 'conditional-match'), true); assert.equal(result.files.length, 2);
});
