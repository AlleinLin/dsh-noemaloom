import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseDesktopProjectionArguments, projectDesktopObservation } from '../tools/acceptance/desktop-projection.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const memoryId = 'nexus-e2e-memory-round9';
const graphId = '12345678-1234-4234-8234-123456789abc';
const graphTitle = 'nexus-e2e-graph-round9';
const identity = { packageSha256: 'a'.repeat(64), sourceHash: 'b'.repeat(64), memoryId };
const privateText = 'private-marker-never-public';
const record = (id = memoryId) => ({
  id, revision: 2, lifecycle: 'current', track: 'facts', layer: 'knowledge',
  kind: 'fact', authority: 'candidate', validation: 'unverified', confidence: 'unknown',
  importance: 'normal', title: `${privateText}-title`, body: `${privateText}-正文`,
  scope: { sensitivity: 'private', sharing: 'local', ownerId: privateText, projectId: privateText },
  origin: { actorId: privateText }, evidence: [{ excerpt: privateText }],
  unknownPrivateField: privateText,
});
const rpc = (domain, action, data, extra = {}) => ({
  status: 200, path: '/api/nexus/rpc',
  method: ['save', 'commit', 'update', 'forget'].includes(action) ? 'nexus.command' : 'nexus.query',
  action, domain, bodyTruncated: false,
  body: JSON.stringify({
    type: 'server-response', rpcId: privateText,
    result: {
      ok: true,
      value: {
        ok: true, data, receipt: { outcome: 'succeeded', effects: privateText },
        requestId: privateText, traceId: privateText, warnings: [privateText],
      },
    },
  }),
  ...extra,
});
const project = (observation, options = identity) => projectDesktopObservation(
  Buffer.from(JSON.stringify(observation), 'utf8'), options,
);

test('desktop evidence publishes actual probe facts and explicit renderer metadata only', () => {
  const runtime = { node: 'v22.19.0', modules: '137', napi: '10', platform: 'win32', arch: 'x64' };
  const storage = {
    backend: 'node:sqlite-worker', sqlite: '3.50.2', userVersion: 1,
    synchronous: 'FULL', journalMode: 'WAL', integrity: 'ok',
    worker: { ...runtime, threadIsolated: true, privateExtra: privateText },
    database: privateText,
  };
  const observation = {
    actualInstalledRenderer: false, desktopPreloadPresent: true, desktopProtocolVersion: 1,
    rendererLocation: { protocol: 'dsh-app:', hostname: 'app', secret: privateText },
    viewport: { width: 1440, height: 1000, devicePixelRatio: 1.25, privateExtra: privateText },
    observedAt: '2026-10-20T12:00:00.000Z',
    endpoint: privateText, url: privateText, title: privateText, text: privateText,
    controls: [{ text: privateText }], userAgent: privateText, runtime: { privateExtra: privateText },
    providers: [privateText], profile: privateText, workspace: privateText,
    errors: [
      { name: 'TypeError', message: privateText, stack: privateText },
      { name: privateText, message: privateText },
      { source: 'console', message: privateText },
    ],
    failedResponses: [{ path: privateText, status: 500 }],
    nexusResponses: [
      rpc(undefined, 'probe', {
        protocolVersion: 1, runtime: { ...runtime, privateExtra: privateText }, storage,
        providers: [privateText], profile: privateText, workspaceRoot: privateText,
      }, { method: 'host.probe' }),
      rpc('memory', 'list', { items: [record('other-private-record')] }),
      rpc(undefined, 'snapshot', { facts: { runtime, storage, profile: privateText } }, { method: 'nexus.snapshot' }),
    ],
  };
  const bytes = Buffer.from(`\uFEFF${JSON.stringify(observation)}\n`, 'utf8');
  const result = projectDesktopObservation(bytes, identity);
  assert.equal(result.observationSha256, sha256(bytes));
  assert.equal(result.packageSha256, identity.packageSha256);
  assert.equal(result.sourceHash, identity.sourceHash);
  assert.equal(result.actualInstalledRenderer, false);
  assert.equal(result.desktopProtocolVersion, 1);
  assert.equal(result.rendererProtocol, 'dsh-app:');
  assert.equal(result.rendererHostname, 'app');
  assert.deepEqual(result.viewport, { width: 1440, height: 1000, devicePixelRatio: 1.25 });
  assert.deepEqual(result.errors, { count: 3, names: ['TypeError'] });
  assert.equal(result.responses.length, 1);
  assert.deepEqual(result.responses[0].result.value.data, {
    protocolVersion: 1, runtime,
    storage: {
      backend: 'node:sqlite-worker', sqlite: '3.50.2', userVersion: 1,
      synchronous: 'FULL', journalMode: 'WAL', integrity: 'ok',
      worker: { ...runtime, threadIsolated: true },
    },
  });
  assert.equal(JSON.stringify(result).includes(privateText), false);
  assert.equal(Object.hasOwn(result, 'passed'), false);
});

test('memory save commit update read and expand select only the exact canary and hash returned text', () => {
  const selected = record();
  const responses = ['save', 'commit', 'update'].map(action => rpc('memory', action, {
    committed: true, duplicate: false, record: selected,
    receipt: { state: 'committed', committed: true, recordIds: [memoryId, privateText], privateExtra: privateText },
    otherRecord: record('other-private-record'),
  }));
  responses.push(rpc('memory', 'read', selected));
  responses.push(rpc('memory', 'expand', {
    ...selected, body: '文', totalChars: selected.body.length, nextOffset: 1, truncated: true,
  }));
  responses.push(rpc('memory', 'read', record('nexus-e2e-other')));
  responses.push(rpc('memory', 'save', { committed: true, record: record('other-private-record') }));
  responses.push(rpc('memory', 'read', { record: selected }));
  const result = project({ nexusResponses: responses });
  for (let index = 0; index < 5; index++) assert.equal(result.responses[index].canaryMatched, true);
  for (let index = 5; index < 8; index++) {
    assert.equal(result.responses[index].canaryMatched, false);
    assert.equal(Object.hasOwn(result.responses[index].result.value, 'data'), false);
    assert.equal(Object.hasOwn(result.responses[index].result.value, 'receipt'), false);
  }
  const saved = result.responses[0].result.value.data;
  assert.equal(saved.record.id, memoryId);
  assert.equal(saved.record.revision, 2);
  assert.equal(saved.record.lifecycle, 'current');
  assert.deepEqual(saved.record.title, {
    sha256: sha256(selected.title), length: selected.title.length, utf8Bytes: Buffer.byteLength(selected.title),
  });
  assert.deepEqual(saved.record.body, {
    sha256: sha256(selected.body), length: selected.body.length, utf8Bytes: Buffer.byteLength(selected.body),
  });
  assert.equal(saved.record.classification.track, 'facts');
  assert.deepEqual(saved.receipt, { committed: true, state: 'committed' });
  assert.deepEqual(result.responses[0].result.value.receipt, { outcome: 'succeeded' });
  assert.equal(result.responses[3].result.value.data.id, memoryId);
  assert.equal(result.responses[4].result.value.data.truncated, true);
  assert.equal(result.responses[4].result.value.data.body.sha256, sha256('文'));
  const serialized = JSON.stringify(result);
  for (const marker of [privateText, 'other-private-record', 'nexus-e2e-other', 'origin', 'evidence'])
    assert.equal(serialized.includes(marker), false);
});

test('memory forget publishes only the selected tombstone and retains standard reviewed validation', () => {
  const forgotten = { ...record(), revision: 3, lifecycle: 'tombstoned', validation: 'reviewed' };
  const result = project({ nexusResponses: [
    rpc('memory', 'forget', { committed: true, record: forgotten }),
    rpc('memory', 'forget', { committed: true, record: { ...forgotten, id: 'nexus-e2e-other-forget' } }),
    rpc('memory', 'forget', { committed: true, record: { ...forgotten, id: 'other-private-record' } }),
  ] });
  const response = result.responses[0];
  assert.equal(response.action, 'forget');
  assert.equal(response.method, 'nexus.command');
  assert.equal(response.canaryMatched, true);
  assert.equal(response.result.value.data.committed, true);
  assert.equal(response.result.value.data.record.id, memoryId);
  assert.equal(response.result.value.data.record.revision, 3);
  assert.equal(response.result.value.data.record.lifecycle, 'tombstoned');
  assert.equal(response.result.value.data.record.classification.validation, 'reviewed');
  for (const unknown of result.responses.slice(1)) {
    assert.equal(unknown.canaryMatched, false);
    assert.equal(Object.hasOwn(unknown.result.value, 'data'), false);
    assert.equal(Object.hasOwn(unknown.result.value, 'receipt'), false);
  }
  const serialized = JSON.stringify(result);
  for (const marker of [privateText, 'nexus-e2e-other-forget', 'other-private-record'])
    assert.equal(serialized.includes(marker), false);
});

test('HTTP carrier and business failures remain distinct and cannot publish successful-looking canary data', () => {
  const selected = record();
  const make = (httpStatus, carrierOk, businessOk) => rpc('memory', 'save', undefined, {
    status: httpStatus,
    body: JSON.stringify({
      result: {
        ok: carrierOk, error: { code: 'nexus/bad-request', message: privateText },
        value: {
          ok: businessOk, data: { committed: true, record: selected },
          receipt: { outcome: 'succeeded', effects: privateText },
          error: { code: 'INVALID_ARGUMENT', name: 'NexusError', message: privateText, details: privateText },
        },
      },
    }),
  });
  const result = project({ nexusResponses: [
    make(200, true, false), make(200, false, true), make(503, true, true),
    rpc('memory', 'save', { committed: true, record: selected }, { bodyTruncated: true }),
    rpc('memory', 'read', selected, { body: '{private-marker' }),
    rpc('memory', 'read', selected, { body: JSON.stringify({ result: { value: { ok: true, data: selected } } }) }),
    rpc('memory', 'read', selected, { status: undefined }),
    rpc('memory', 'read', selected, { bodyTruncated: undefined }),
    rpc('memory', 'save', undefined, { body: JSON.stringify({
      result: { ok: true, value: {
        ok: false, receipt: { outcome: 'failed', effects: privateText },
        error: { code: 'REVISION_CONFLICT', message: privateText },
      } },
    }) }),
  ] });
  assert.equal(result.responses[0].httpStatus, 200);
  assert.equal(result.responses[0].result.ok, true);
  assert.equal(result.responses[0].result.value.ok, false);
  assert.deepEqual(result.responses[0].result.value.error, { code: 'INVALID_ARGUMENT', name: 'NexusError' });
  assert.equal(result.responses[1].result.ok, false);
  assert.equal(result.responses[1].result.value.ok, true);
  assert.equal(result.responses[2].httpStatus, 503);
  assert.equal(result.responses[2].result.value.ok, true);
  assert.equal(result.responses[3].bodyTruncated, true);
  assert.equal(result.responses[4].bodyParsed, false);
  assert.equal(Object.hasOwn(result.responses[5].result, 'ok'), false);
  assert.deepEqual(result.responses[8].result.value.receipt, { outcome: 'failed' });
  for (const [index, response] of result.responses.entries()) {
    assert.equal(response.canaryMatched, false);
    if (response.result?.value) {
      assert.equal(Object.hasOwn(response.result.value, 'data'), false);
      if (index !== 8) assert.equal(Object.hasOwn(response.result.value, 'receipt'), false);
    }
  }
  assert.equal(JSON.stringify(result).includes(privateText), false);
  assert.equal(JSON.stringify(result).includes('"passed"'), false);
});

test('graph UUID selection requires the exact synthetic title and publishes only flat whitelist data', () => {
  const options = { ...identity, graphId, graphTitle };
  const selected = {
    id: graphId, title: graphTitle, revision: 4, layoutRevision: 1, archived: false,
    nodes: [{ question: privateText, versions: [{ text: privateText }] }],
    edges: [{ quote: privateText }], materials: [{ content: privateText }],
    workspaceRoot: privateText, profile: privateText, privateExtra: privateText,
  };
  const result = project({ nexusResponses: [
    rpc('graph', 'create', selected),
    rpc('graph', 'get', selected),
    rpc('graph', 'get', { ...selected, title: privateText }),
    rpc('graph', 'get', { ...selected, id: 'nexus-e2e-other-graph' }),
    rpc('graph', 'get', { record: selected }),
    rpc('graph', 'list', { items: [selected] }),
  ] }, options);
  assert.equal(result.responses.length, 5);
  for (const response of result.responses.slice(0, 2)) {
    assert.equal(response.canaryMatched, true);
    assert.deepEqual(response.result.value.data, {
      id: graphId,
      title: { sha256: sha256(graphTitle), length: graphTitle.length, utf8Bytes: Buffer.byteLength(graphTitle) },
      revision: 4, layoutRevision: 1, archived: false, nodeCount: 1, edgeCount: 1, materialCount: 1,
    });
  }
  for (const response of result.responses.slice(2)) {
    assert.equal(response.canaryMatched, false);
    assert.equal(Object.hasOwn(response.result.value, 'data'), false);
  }
  assert.equal(JSON.stringify(result).includes(privateText), false);
  assert.equal(JSON.stringify(result).includes(graphTitle), false);
  const withoutSelection = project({ nexusResponses: [rpc('graph', 'get', selected)] });
  assert.deepEqual(withoutSelection.responses, []);
});

test('missing or unknown facts are omitted and private hostname or SQLite diagnostics are hashes', () => {
  const result = project({
    desktopProtocolVersion: null,
    rendererLocation: { protocol: 'https:', hostname: privateText },
    nexusResponses: [
    rpc(undefined, 'probe', {
      runtime: { node: privateText, modules: privateText, napi: null, platform: privateText, arch: privateText },
      storage: { backend: privateText, sqlite: privateText, integrity: privateText, worker: { node: privateText } },
    }, { method: 'host.probe' }),
    ],
  });
  assert.equal(Object.hasOwn(result, 'actualInstalledRenderer'), false);
  assert.equal(result.desktopProtocolVersion, null);
  assert.deepEqual(result.rendererHostname, {
    sha256: sha256(privateText), length: privateText.length, utf8Bytes: Buffer.byteLength(privateText),
  });
  const data = result.responses[0].result.value.data;
  assert.equal(Object.hasOwn(data, 'runtime'), false);
  assert.equal(Object.hasOwn(data.storage, 'worker'), false);
  assert.deepEqual(data.storage.integrity, {
    sha256: sha256(privateText), length: privateText.length, utf8Bytes: Buffer.byteLength(privateText),
  });
  assert.equal(JSON.stringify(result).includes(privateText), false);
});

test('CLI rejects broad selections missing hashes unknown options and incomplete graph bindings', () => {
  const args = [
    '--input', 'private.json', '--output', 'public.json',
    '--package-sha256', identity.packageSha256, '--source-hash', identity.sourceHash,
    '--memory-id', memoryId,
  ];
  assert.deepEqual(parseDesktopProjectionArguments(args), {
    input: 'private.json', output: 'public.json', ...identity,
  });
  assert.deepEqual(parseDesktopProjectionArguments([...args, '--graph-id', graphId, '--graph-title', graphTitle]), {
    input: 'private.json', output: 'public.json', ...identity, graphId, graphTitle,
  });
  for (const invalid of [
    [...args, '--input', 'duplicate.json'],
    [...args, '--unknown', 'private-value'],
    [...args, '--graph-id', graphId],
    [...args, '--graph-title', graphTitle],
    [...args, '--graph-id', graphId, '--graph-title', 'private-title'],
    [...args.slice(0, -1), 'ordinary-memory'],
    [...args.slice(0, -1), 'nexus-e2e-'],
    [...args.slice(0, 5), 'invalid-hash', ...args.slice(6)],
    args.slice(0, -1),
  ]) assert.throws(() => parseDesktopProjectionArguments(invalid), TypeError);
  assert.throws(() => projectDesktopObservation(Buffer.from('{private-marker'), identity), TypeError);
  assert.throws(() => projectDesktopObservation(Buffer.from('[]'), identity), TypeError);
});
