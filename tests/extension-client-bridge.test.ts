import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtensionClientBridge } from '../src/host/extension-client-bridge.js';
import type { NexusServices, NexusStore, StoredRecord } from '../src/ports/contracts.js';

/** Protocol fixture only: real browser/Fiber acceptance remains an integration check. */
test('client protocol requires exact owner/page/release/digest receipts before staging and immutable bundle access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-client-protocol-'));
  const controller = new AbortController();
  let rpc: any, route: any;
  const rows = new Map<string, StoredRecord<any>>();
  const store: NexusStore = {
    async get<T>(collection: string, id: string) { return rows.get(`${collection}:${id}`) as StoredRecord<T> | undefined; },
    async list<T>(collection: string) { return [...rows].filter(([key]) => key.startsWith(`${collection}:`)).map(([, value]) => value as StoredRecord<T>); },
    async put<T>(collection: string, id: string, value: T) {
      const row = { id, value, revision: 1, updatedAt: new Date().toISOString() };
      rows.set(`${collection}:${id}`, row); return row;
    },
    async remove(collection, id) { return rows.delete(`${collection}:${id}`); },
  };
  const services = { store, emit() {} } as unknown as NexusServices;
  const release = { version: 'fixture-release', commit: 'fixture-commit' };
  const connection = {
    rpc: { handle(_channel: string, handler: any) { rpc = handler; return async () => {}; } },
    fetch: { register(value: any) { route = value; return async () => {}; } },
  };
  const context = {
    get(name: string) { return name === 'connection' ? connection : name === 'clientModules' ? { graph: () => ({ release }) } : undefined; },
  } as any;
  const bridge = createExtensionClientBridge(context, () => services, controller.signal);
  const invoke = (endpoint: string, payload: any, principal = 'owner') => rpc(endpoint, payload, new AbortController().signal, { principal: { kind: principal } });
  try {
    await mkdir(join(root, 'lib'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@fixture/client-extension', dsh: { client: { platform: 'web' } } }));
    await writeFile(join(root, 'lib', 'client.js'), 'window.__ModuleLoader__.load({id:"@fixture/client-extension",factory:()=>({apply(){}})});');
    assert.equal((await invoke('hello', { pageId: 'page', release }, 'api')).ok, false);
    assert.equal((await invoke('hello', { pageId: 'page', release: { ...release, commit: 'other' } })).ok, false);
    const hello = await invoke('hello', { pageId: 'page', release });
    const page = { pageId: 'page', token: hello.value.token };
    let ready = false;
    const pending = bridge.stage({ owner: 'fixture:extension', generation: 1, packageRoot: root, entry: join(root, 'lib', 'client.js') })
      .then(value => { ready = true; return value; });
    const polled = await invoke('poll', page);
    const command = polled.value.commands[0];
    assert.equal(command.kind, 'stage');
    assert.equal(ready, false);
    assert.equal((await invoke('ack', { ...page, commandId: command.id, handle: command.handle, digest: 'wrong', ok: true, state: 'staged', fiberState: 2 })).ok, false);
    assert.equal(ready, false);
    const artifact = command.manifest.artifacts[0];
    const source = await route.fetch(new Request(new URL(artifact.url, 'http://localhost/')));
    assert.equal(source.status, 200);
    assert.match(await source.text(), /__DSH_NEXUS_EXTENSION_BUNDLES__/);
    const wrongUrl = new URL(artifact.url, 'http://localhost/');
    wrongUrl.searchParams.set('sha256', 'wrong');
    assert.equal((await route.fetch(new Request(wrongUrl))).status, 404);
    await invoke('ack', { ...page, commandId: command.id, handle: command.handle, digest: command.digest,
      ok: true, state: 'staged', fiberState: 2, resources: [{ kind: 'slots', installed: false }] });
    const staged = await pending;
    assert.equal(staged.ready, true);
    const committing = staged.commit();
    const commit = (await invoke('poll', page)).value.commands[0];
    assert.equal(commit.kind, 'commit');
    await invoke('ack', { ...page, commandId: commit.id, handle: commit.handle, digest: commit.digest, ok: true, state: 'active', fiberState: 2 });
    await committing;
    const disposing = staged.dispose();
    const dispose = (await invoke('poll', page)).value.commands[0];
    assert.equal(dispose.kind, 'dispose');
    await invoke('ack', { ...page, commandId: dispose.id, handle: dispose.handle, digest: dispose.digest, ok: true, state: 'disposed', resources: [] });
    await disposing;
    assert.equal((await route.fetch(new Request(new URL(artifact.url, 'http://localhost/')))).status, 404);
    const receipts = await store.list('extension-client-receipts');
    assert.ok(receipts.length >= 5);
  } finally {
    await bridge.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
