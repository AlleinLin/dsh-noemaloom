import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDebugModule, validateBreakpoints } from '../src/domain/debug/index.js';
import { resolveLaunch, launchConfigurations } from '../src/host/debug/configuration.js';
import { withScopePolicy } from '../src/domain/scope.js';
import { NexusError, type NexusServices, type NexusStore, type StoredRecord } from '../src/ports/contracts.js';
function memoryStore(): NexusStore {
  const rows = new Map<string, StoredRecord<any>>();
  return {
    async get<T>(collection: string, id: string) { return rows.get(`${collection}/${id}`) as StoredRecord<T> | undefined; },
    async put<T>(collection: string, id: string, value: T, expected?: number) {
      const key = `${collection}/${id}`, previous = rows.get(key);
      if (expected !== undefined && expected !== (previous?.revision ?? 0)) throw new NexusError('REVISION_CONFLICT', 'revision changed');
      const row = { id, revision: (previous?.revision ?? 0) + 1, value, updatedAt: new Date().toISOString() };
      rows.set(key, row); return row;
    },
    async list<T>(collection: string) { return [...rows.entries()].filter(([key]) => key.startsWith(`${collection}/`)).map(([, row]) => row as StoredRecord<T>); },
    async remove(collection, id) { return rows.delete(`${collection}/${id}`); },
  };
}
test('launch JSONC, variables, secret-free labels and loopback attach restrictions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-debug-config-')), program = join(root, 'main.py');
  try {
    await writeFile(program, 'value=21\n'); await mkdir(join(root, '.vscode'));
    await writeFile(join(root, '.vscode/launch.json'), '{// comment\n"configurations":[{"name":"Python","type":"debugpy","program":"${file}","env":{"TEST_ONLY":"literal-hidden-value"}},]}');
    const scope = { sessionId: 'session', workspaceRoot: root };
    const configs = await launchConfigurations(scope, program);
    assert.equal(configs.length, 1);
    assert.equal((await resolveLaunch(configs[0], scope, program)).program, await realpath(program));
    await assert.rejects(resolveLaunch({ type: 'debugpy', program: '${command:pickProcess}' }, scope, program), /Unsupported/);
    await assert.rejects(resolveLaunch({ type: 'debugpy', request: 'attach', connect: { host: 'example.invalid', port: 5678 } }, scope), /loopback/);
    await assert.rejects(resolveLaunch({ type: 'debugpy', program: '../outside.py' }, scope), /工作区/);
    const services = { workspaceRoot: root, store: memoryStore() } as NexusServices;
    const module = createDebugModule(services);
    const listed = await module.dispatch({ action: 'configurations', params: { path: program } }, { actorId: 'connection-owner', workspaceRoot: root }) as any;
    assert(!JSON.stringify(listed).includes('literal-hidden-value'));
    await assert.rejects(module.dispatch({ action: 'configurations', params: { path: program } }, { actorId: 'native-tool' }), /认证用户/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('workspace drafts survive session changes, enforce CAS and can be recreated after removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-debug-draft-')), other = await mkdtemp(join(tmpdir(), 'nexus-debug-draft-other-'));
  await writeFile(join(root, 'a.ts'), 'disk'); await writeFile(join(other, 'a.ts'), 'other');
  const services = { workspaceRoot: root, store: memoryStore() } as NexusServices, module = createDebugModule(services);
  const context = { actorId: 'connection-owner', sessionId: 'first', workspaceRoot: root };
  const params = { path: 'a.ts', content: 'draft', baseHash: 'a'.repeat(64) };
  try {
    const saved = await module.dispatch({ action: 'draft.put', params, expectedRevision: 0 }, context) as any;
    await assert.rejects(module.dispatch({ action: 'draft.put', params, expectedRevision: 0 }, context), /revision/);
    const read = await module.dispatch({ action: 'draft.get', params: { path: 'a.ts' } }, { ...context, sessionId: 'second' }) as any;
    assert.equal(read.draft.content, 'draft');
    const isolated = await module.dispatch({ action: 'draft.get', params: { path: 'a.ts' } }, { ...context, workspaceRoot: other }) as any;
    assert.equal(isolated.draft, null);
    const removed = await module.dispatch({ action: 'draft.remove', params: { path: 'a.ts' }, expectedRevision: saved.revision }, context) as any;
    const next = await module.dispatch({ action: 'draft.put', params, expectedRevision: removed.revision }, context) as any;
    assert(next.revision > removed.revision);
    await assert.rejects(module.dispatch({ action: 'draft.put', params: { ...params, content: 'x'.repeat(512 * 1024 + 1) } }, context), /512/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});
test('breakpoint schema rejects duplicate lines and disabling debug still permits stop', async () => {
  assert.throws(() => validateBreakpoints([{ line: 1 }, { line: 1 }]), /重复/);
  assert.throws(() => validateBreakpoints([{ line: -1 }]), /行号/);
  const root = await mkdtemp(join(tmpdir(), 'nexus-debug-disable-'));
  let stopped = 0;
  const services = { workspaceRoot: root, store: memoryStore(), debug: { async stop() { stopped++; return { stopped: true }; } } } as unknown as NexusServices;
  try {
    await services.store.put('scope-settings', 'global/debug', { enabled: false });
    const module = withScopePolicy(createDebugModule(services), services);
    await module.dispatch({ action: 'stop' }, { actorId: 'connection-owner', sessionId: 'one', workspaceRoot: root });
    assert.equal(stopped, 1);
    await assert.rejects(module.dispatch({ action: 'start' }, { actorId: 'connection-owner', sessionId: 'one', workspaceRoot: root }), /停用/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
