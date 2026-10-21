import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Context, CordisError, type Fiber } from '@deepseek-ai/cordis';
import * as connectionPlugin from '@deepseek-ai/dsh-client-connection';
import { createConnectionRegistrationContext, inject as nexusInject } from '../src/host/index.js';

interface PhysicalRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler(request: IncomingMessage, response: ServerResponse): void | Promise<void>;
}

async function harness(t: TestContext) {
  const root = new Context();
  const physicalRoutes = new Map<string, PhysicalRoute>();
  const dispatches: string[] = [];
  const failures: unknown[] = [];
  const fibers: Fiber[] = [];
  let credentialRecord: unknown;

  // This is a Node HTTP carrier fixture, not the official WebServer. Cordis,
  // Connection's registries, HTTP bridge, trust checks and cookie auth are real.
  const carrier = {
    host: '127.0.0.1',
    protocol: 'http:',
    register(route: PhysicalRoute) {
      assert.equal(physicalRoutes.has(route.path), false, 'physical paths have one owner');
      physicalRoutes.set(route.path, route);
      return () => {
        if (physicalRoutes.get(route.path) === route) physicalRoutes.delete(route.path);
      };
    },
  };
  const server = createServer((request, response) => {
    void dispatch(request, response).catch(error => {
      failures.push(error);
      if (response.headersSent) response.destroy(error instanceof Error ? error : undefined);
      else {
        response.writeHead(500);
        response.end('fixture dispatch failed');
      }
    });
  });

  async function dispatch(request: IncomingMessage, response: ServerResponse) {
    const pathname = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    if (pathname === '/') {
      if (root.connection.authorizeIndex(request, response)) {
        response.writeHead(200);
        response.end('fixture index');
      }
      return;
    }
    const routes = [...physicalRoutes.values()];
    const route = routes.find(candidate => candidate.kind === 'exact' && candidate.path === pathname)
      ?? routes.find(candidate => candidate.kind === 'prefix'
        && (pathname === candidate.path || pathname.startsWith(`${candidate.path}/`)));
    if (!route) {
      response.writeHead(404);
      response.end('fixture route not found');
      return;
    }
    dispatches.push(route.path);
    await route.handler(request, response);
  }

  function mount(plugin: Parameters<Context['plugin']>[0]) {
    const fiber = root.plugin(plugin);
    fibers.push(fiber);
    return fiber;
  }

  t.after(async () => {
    for (const fiber of fibers.reverse()) {
      try { await fiber.dispose(); } catch (error) { failures.push(error); }
    }
    if (server.listening) {
      const closed = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
      server.closeAllConnections();
      await closed;
    }
    assert.equal(physicalRoutes.size, 0, 'fixture teardown removes every physical route');
    assert.deepEqual(failures, []);
  });

  const provider = mount({
    name: 'nexus-owner-contract-fixture-services',
    apply(ctx: Context) {
      ctx.provide('credentials', {
        async modifyRecord(_key: unknown, mutate: (current: unknown) => Promise<unknown>) {
          const next = await mutate(credentialRecord);
          if (next !== undefined) credentialRecord = next;
          return credentialRecord;
        },
      });
      ctx.provide('tools', {});
      ctx.provide('webServer', carrier);
    },
  });
  await provider.await();
  assert.equal(provider.state, 2);

  // The official Connection is a sibling, with its own credentials-only inject.
  // No webServer capability is added to its ancestors or its source context.
  const connection = mount(connectionPlugin);
  await connection.await();
  assert.equal(connection.state, 2);
  assert.equal(connection.parent.fiber, root.fiber);
  assert.equal(Object.hasOwn(root, 'webServer'), false);
  assert.equal(Object.hasOwn(connection.ctx, 'webServer'), false);
  const service = root.connection;
  assert.ok(service instanceof connectionPlugin.HostConnectionService);
  assert.equal(physicalRoutes.get('/api')?.kind, 'prefix');
  assert.equal(physicalRoutes.get('/connect')?.kind, 'exact');

  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { reject(error); };
    server.once('error', failed);
    server.listen(0, carrier.host, () => {
      server.off('error', failed);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(new URL(path, origin), {
      ...init, redirect: 'manual', signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, headers: response.headers, body: await response.text() };
  }

  async function login() {
    const response = await request(service.authenticatedUrl(`${origin}/`));
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), './');
    const setCookie = response.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookie = setCookie.split(';')[0];
    assert.ok(cookie);
    assert.equal((await request('/', { headers: { cookie } })).status, 200);
    return cookie;
  }

  return { root, service, connection, physicalRoutes, dispatches, mount, request, login };
}

test('official sibling Connection still needs a derived consumer registration context', async t => {
  const h = await harness(t);
  const baseline = [...h.physicalRoutes.keys()].sort();
  let directObserved = false;
  const direct = h.mount({
    name: 'nexus-owner-contract-direct-consumer',
    inject: nexusInject,
    apply(ctx: Context) {
      // Even explicit consumer injection does not change Connection's origin.
      assert.ok(nexusInject.includes('webServer'));
      assert.equal(Object.hasOwn(ctx, 'webServer'), false);
      assert.throws(() => ctx.connection.rpc.handle('/nexus-owner-direct', async () => ({
        ok: true, value: null,
      })), /cannot get property "webServer" without inject/);
      assert.equal(Object.hasOwn(ctx, 'webServer'), false);
      directObserved = true;
    },
  });
  await direct.await();
  assert.equal(direct.state, 2);
  assert.equal(directObserved, true);
  assert.deepEqual([...h.physicalRoutes.keys()].sort(), baseline);

  let missingObserved = false;
  const missing = h.mount({
    name: 'nexus-owner-contract-missing-consumer-injection',
    inject: ['connection', 'tools'],
    apply(ctx: Context) {
      assert.throws(() => createConnectionRegistrationContext(ctx),
        /cannot get property "webServer" without inject/);
      assert.equal(Object.hasOwn(ctx, 'webServer'), false);
      missingObserved = true;
    },
  });
  await missing.await();
  assert.equal(missing.state, 2);
  assert.equal(missingObserved, true);
  assert.deepEqual([...h.physicalRoutes.keys()].sort(), baseline);
  assert.equal(Object.hasOwn(h.root, 'webServer'), false);
  assert.equal(h.connection.state, 2);
});

test('derived registration preserves real Connection auth, routing and consumer teardown', async t => {
  const h = await harness(t);
  const channel = '/nexus-owner-contract';
  const fetchPath = '/api/nexus-owner-contract';
  const baseline = [...h.physicalRoutes.keys()].sort();
  const retained: {
    rpc?: connectionPlugin.HostConnectionRpc;
    fetch?: connectionPlugin.HostConnectionFetch;
    parent?: Context;
  } = {};
  const rpcCalls: Array<{ endpoint: string; payload: unknown; principal: string }> = [];
  const fetchCalls: string[] = [];
  const handler: connectionPlugin.ConnectionRpcHandler = async (endpoint, payload, signal, peer) => {
    assert.equal(signal.aborted, false);
    rpcCalls.push({ endpoint, payload, principal: peer.principal.kind });
    return { ok: true, value: { registered: true } };
  };
  const consumer = h.mount({
    name: 'nexus-owner-contract-derived-consumer',
    inject: nexusInject,
    apply(ctx: Context) {
      const owner = createConnectionRegistrationContext(ctx);
      assert.notEqual(owner, ctx);
      assert.equal(owner.fiber, ctx.fiber);
      assert.equal(Object.hasOwn(owner, 'webServer'), true);
      assert.equal(Object.hasOwn(ctx, 'webServer'), false);
      const connection = owner.connection;
      assert.ok(connection instanceof connectionPlugin.HostConnectionService);
      retained.parent = ctx;
      retained.rpc = connection.rpc;
      retained.fetch = connection.fetch;
      retained.rpc.handle(channel, handler);
      retained.fetch.register({
        path: fetchPath, methods: ['GET'], requestBody: 'buffered',
        async fetch(request) {
          fetchCalls.push(request.url);
          return Response.json({ registered: true, cursor: new URL(request.url).searchParams.get('cursor') });
        },
      });
      assert.equal(Object.hasOwn(ctx, 'webServer'), false);
    },
  });
  await consumer.await();
  assert.equal(consumer.state, 2);
  assert.equal(h.physicalRoutes.get(channel)?.kind, 'prefix');
  assert.equal(h.physicalRoutes.has(fetchPath), false, 'exact Fetch routes use Connection\'s /api bridge');
  assert.equal(Object.hasOwn(h.root, 'webServer'), false);
  const rpc = retained.rpc;
  const exactFetch = retained.fetch;
  const parent = retained.parent;
  assert.ok(rpc && exactFetch && parent);

  const envelope: connectionPlugin.ClientRequest = {
    type: 'client-request', rpcId: connectionPlugin.RpcId('nexus-owner-fixture'),
    method: 'echo', payload: { requested: true },
  };
  connectionPlugin.clientRequestSchema.parse(envelope);
  const post = (path: string, cookie?: string, body: unknown = envelope, extraHeaders = {}) => h.request(path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extraHeaders },
    body: JSON.stringify(body),
  });

  assert.equal((await post(`${channel}/echo`)).status, 401);
  assert.equal((await h.request(fetchPath)).status, 401);
  assert.deepEqual(rpcCalls, []);
  assert.deepEqual(fetchCalls, []);
  const cookie = await h.login();
  assert.equal((await post(`${channel}/echo`, `${cookie}tampered`)).status, 401);
  assert.equal((await post(`${channel}/echo`, cookie, envelope, { origin: 'http://untrusted.invalid' })).status, 403);
  assert.deepEqual(rpcCalls, []);

  const success = await post(`${channel}/echo`, cookie);
  assert.equal(success.status, 200);
  assert.deepEqual(connectionPlugin.serverResponseSchema.parse(JSON.parse(success.body)), {
    type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { registered: true } },
  });
  assert.deepEqual(rpcCalls, [{ endpoint: 'echo', payload: envelope.payload, principal: 'owner' }]);
  const dispatched = h.dispatches.length;
  assert.equal((await post(`${channel}-other/echo`, cookie)).status, 404);
  assert.equal(h.dispatches.length, dispatched, 'the carrier matches a whole channel prefix');
  for (const path of [channel, `${channel}/`, `${channel}/echo/`]) {
    assert.equal((await post(path, cookie)).status, 404);
  }
  assert.equal((await h.request(`${channel}/echo`, { headers: { cookie } })).status, 404);
  const mismatch = await post(`${channel}/echo`, cookie, { ...envelope, method: 'other' });
  assert.equal(mismatch.status, 200);
  const mismatchEnvelope = connectionPlugin.serverResponseSchema.parse(JSON.parse(mismatch.body));
  assert.equal(mismatchEnvelope.rpcId, envelope.rpcId);
  assert.equal(mismatchEnvelope.result.ok, false);
  if (!mismatchEnvelope.result.ok) assert.equal(mismatchEnvelope.result.error.code, 'gateway/bad-request');
  assert.equal(rpcCalls.length, 1);

  const exact = await h.request(`${fetchPath}?cursor=next`, { headers: { cookie } });
  assert.equal(exact.status, 200);
  assert.deepEqual(JSON.parse(exact.body), { registered: true, cursor: 'next' });
  for (const path of [`${fetchPath}/`, `${fetchPath}-other`]) {
    assert.equal((await h.request(path, { headers: { cookie } })).status, 404);
  }
  assert.equal((await h.request(fetchPath, { method: 'HEAD', headers: { cookie } })).status, 404);
  assert.equal((await post(fetchPath, cookie)).status, 404);
  assert.equal(fetchCalls.length, 1);

  await consumer.dispose();
  assert.deepEqual([...h.physicalRoutes.keys()].sort(), baseline);
  assert.equal((await post(`${channel}/echo`, cookie)).status, 404);
  assert.equal((await h.request(fetchPath, { headers: { cookie } })).status, 404);
  const inactive = (error: unknown) => error instanceof CordisError && error.code === 'INACTIVE_EFFECT';
  assert.throws(() => rpc.handle('/nexus-owner-retained', handler), inactive);
  const retainedFetchPath = '/api/nexus-owner-retained';
  assert.throws(() => exactFetch.register({
    path: retainedFetchPath, methods: ['GET'], requestBody: 'buffered',
    async fetch() { return Response.json({ leaked: true }); },
  }), inactive);
  assert.deepEqual([...h.physicalRoutes.keys()].sort(), baseline);
  assert.equal((await post('/nexus-owner-retained/echo', cookie)).status, 404);
  assert.equal((await h.request(retainedFetchPath, { headers: { cookie } })).status, 404);
  assert.equal(rpcCalls.length, 1);
  assert.equal(fetchCalls.length, 1);
  assert.equal(Object.hasOwn(parent, 'webServer'), false);
  assert.equal(Object.hasOwn(h.root, 'webServer'), false);
  assert.equal(h.connection.state, 2, 'the official sibling Connection remains active');
  assert.equal((await h.request('/', { headers: { cookie } })).status, 200);
});
