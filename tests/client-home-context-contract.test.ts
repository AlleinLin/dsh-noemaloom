import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { homeContextQuery } from '../src/client/home-context-query.js';
import type { NexusScope } from '../src/client/types.js';
import { createContextModule } from '../src/domain/context/index.js';
import { createAtomicStore } from '../src/domain/storage/index.js';
import type { NexusModule, NexusServices } from '../src/ports/contracts.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nexus-client-home-context-'));
  const store = createAtomicStore(root);
  let module: NexusModule;
  const services: NexusServices = {
    store, workspaceRoot: root, dataDir: root, emit() {},
    executor: { async run() { throw new Error('Home context contract must not execute external programs'); } },
    host: {
      async facts() { return {}; }, async approve() { return false; }, async secret() { return undefined; },
      async model() { throw new Error('Home context contract must not call a model'); },
      async spawn() { throw new Error('Home context contract must not spawn a model'); },
      async sessions() { throw new Error('Home context contract must not alter host sessions'); },
    },
    async invoke(domain, request, context) {
      if (domain !== 'context') throw new Error('Unregistered module');
      return module.dispatch(request, context);
    },
  };
  module = createContextModule(services);
  return {
    module, store,
    async cleanup() {
      try { await module.dispose?.(); }
      finally {
        if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('nexus-client-home-context-')) throw new Error('Unexpected fixture cleanup path');
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

test('home without a selected session reads the real context overview without creating a session', async () => {
  const f = await fixture();
  try {
    const scopes: NexusScope[] = [{}, { sessionId: '' }, { sessionId: ' \t\n ' }];
    for (const scope of scopes) {
      const query = homeContextQuery(scope);
      assert.equal(query.action, 'overview');
      assert.deepEqual(query.params, {});
      const overview = await f.module.dispatch(query, scope) as any;
      assert.deepEqual(overview.sessions, []);
      assert.equal(overview.actualCacheHit, null, 'An empty overview must not invent a cache result');
    }
    assert.deepEqual(await f.store.list('context.sessions'), [], 'An unopened home screen must not create an implicit context session');
  } finally { await f.cleanup(); }
});

test('home with a selected session reads status using the trimmed original session identity', async () => {
  const f = await fixture();
  try {
    const scope = { sessionId: '  host-session-original  ' };
    const query = homeContextQuery(scope);
    assert.equal(query.action, 'status');
    assert.equal(query.params.sessionId, 'host-session-original');
    const status = await f.module.dispatch(query, scope) as any;
    assert.equal(status.sessionId, 'host-session-original');
    assert.equal(status.state, 'unobserved');
    const overview = await f.module.dispatch({ action: 'overview' }) as any;
    assert.deepEqual(overview.sessions.map((session: any) => session.sessionId), ['host-session-original']);
  } finally { await f.cleanup(); }
});
