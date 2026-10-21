import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { seedParams } from '../src/client/catalog.js';
import { memoryReadDescriptor, memoryScopeLabel, resolveDetailRead } from '../src/client/detail-read.js';
import { rows, type ActionDraft, type DomainDefinition, type InspectionRead } from '../src/client/types.js';
import { createMemoryModule } from '../src/domain/memory/index.js';
import { createAtomicStore } from '../src/domain/storage/index.js';
import type { NexusModule, NexusServices } from '../src/ports/contracts.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nexus-client-memory-contract-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const services = (): NexusServices => ({
    store: createAtomicStore(join(root, 'state')), workspaceRoot: workspace, dataDir: join(root, 'data'),
    executor: { async run() { throw new Error('Client memory contract must not execute external programs'); } },
    host: {
      async facts() { return {}; }, async approve() { return true; }, async secret() { return undefined; },
      async model() { throw new Error('Client memory contract must not call a model'); },
      async spawn() { throw new Error('Client memory contract must not spawn a model'); },
      async sessions() { throw new Error('Client memory contract must not alter host sessions'); },
    },
    emit() {}, async invoke() { throw new Error('Unregistered module'); },
  });
  let module = createMemoryModule(services());
  return {
    workspace,
    get module() { return module; },
    async reopen() { await module.dispose?.(); module = createMemoryModule(services()); },
    async cleanup() {
      try { await module.dispose?.(); }
      finally {
        if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('nexus-client-memory-contract-')) throw new Error('Unexpected fixture cleanup path');
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

function resolveMemoryRead(module: NexusModule, read: InspectionRead | undefined): ActionDraft {
  const draft = resolveDetailRead([{ id: module.id, capabilities: module.capabilities }], { domain: 'memory', read });
  assert.ok(draft, 'The real memory capability catalog must accept this explicit read descriptor');
  return draft;
}

async function dispatchRead(module: NexusModule, draft: ActionDraft): Promise<any> {
  return module.dispatch({ action: draft.action, params: draft.params, ...(draft.id === undefined ? {} : { target: { id: draft.id } }) });
}

test('the client memory seed saves, reads, reopens and forgets a real Markdown record', async () => {
  const f = await fixture();
  try {
    const seed = seedParams('memory', 'save');
    seed.record.title = '客户端离线记忆合同';
    seed.record.body = '新增记忆使用合法默认值，正文应在模块重建后保留。';
    const saved = await f.module.dispatch({ action: 'save', params: seed }) as any;
    assert.equal(saved.committed, true);
    assert.equal(saved.record.track, 'facts');
    assert.equal(saved.record.layer, 'knowledge');
    const read = resolveMemoryRead(f.module, memoryReadDescriptor(saved.record, 'library'));
    assert.equal(read.action, 'read');
    const initial = await dispatchRead(f.module, read);
    assert.equal(initial.id, saved.record.id);
    assert.equal(initial.body, seed.record.body);
    assert.equal(memoryScopeLabel(initial.scope), '项目');

    await f.reopen();
    const reopened = await dispatchRead(f.module, resolveMemoryRead(f.module, memoryReadDescriptor(saved.record, 'library')));
    assert.equal(reopened.body, seed.record.body);
    assert.equal(reopened.revision, initial.revision);
    await f.module.dispatch({ action: 'forget', target: { id: reopened.id }, expectedRevision: reopened.revision });
    const forgotten = await dispatchRead(f.module, read);
    assert.equal(forgotten.lifecycle, 'tombstoned');
    assert.equal(forgotten.revision, reopened.revision + 1);
    assert.equal(forgotten.body, reopened.body, 'Forget preserves its tombstone rather than claiming physical deletion');
    assert.equal(seedParams('memory', 'save').record.title, '', 'Editing one draft must not alter future defaults');
  } finally { await f.cleanup(); }
});

test('file memory search and source rows read the document version instead of the chunk identity', async () => {
  const f = await fixture();
  try {
    const text = '# 文件来源\n文件约束唯一词：保留 sourceHash 和原始行号。\n';
    await writeFile(join(f.workspace, 'MEMORY.md'), text);
    await f.module.dispatch({ action: 'file_refresh', params: { background: false } });
    const sources = rows(await f.module.dispatch({ action: 'sources' }));
    assert.equal(sources.length, 1, 'The documents collection must reach the source list');
    const sourceRead = resolveMemoryRead(f.module, memoryReadDescriptor(sources[0], 'sources'));
    assert.equal(sourceRead.action, 'file_read');
    assert.equal(sourceRead.id, undefined);
    assert.equal((await dispatchRead(f.module, sourceRead)).text, text);

    const result = await f.module.dispatch({ action: 'search', params: { query: '文件约束唯一词' } });
    const chunk = rows(result).find(item => item.source === 'file_memory');
    assert.ok(chunk);
    assert.notEqual(chunk.id, chunk.documentId);
    const read = resolveMemoryRead(f.module, memoryReadDescriptor(chunk, 'search'));
    assert.deepEqual(read.params, { documentId: chunk.documentId, sourceHash: chunk.sourceHash });
    assert.equal(read.id, undefined, 'A chunk id must not override the document through target.id');
    const document = await dispatchRead(f.module, read);
    assert.equal(document.documentId, chunk.documentId);
    assert.equal(document.sourceHash, chunk.sourceHash);
    assert.equal(document.binding, 'pinned');
    assert.equal(document.text, text);
  } finally { await f.cleanup(); }
});

test('detail reads require an explicit descriptor and a capability marked read only', () => {
  const read: InspectionRead = { choices: ['read'], params: { id: 'mem-1' }, targetId: 'mem-1' };
  const catalog = (mutating?: boolean): DomainDefinition[] => [{ id: 'memory', capabilities: [{ action: 'read', description: 'read', ...(mutating === undefined ? {} : { mutating }) }] }];
  assert.equal(resolveDetailRead(catalog(false), { domain: 'memory' }), undefined);
  assert.equal(resolveDetailRead(catalog(false), { read }), undefined);
  assert.equal(resolveDetailRead([], { domain: 'memory', read }), undefined);
  assert.equal(resolveDetailRead(catalog(), { domain: 'memory', read }), undefined);
  assert.equal(resolveDetailRead(catalog(true), { domain: 'memory', read }), undefined);
  assert.equal(resolveDetailRead([{ id: 'memory', capabilities: [{ action: 'get', description: 'unrelated', mutating: false }] }], { domain: 'memory', read }), undefined);
});

test('detail reads select a registered read candidate and preserve its params and target', () => {
  const catalog: DomainDefinition[] = [{
    id: 'memory', capabilities: [
      { action: 'read', description: 'not read only', mutating: true },
      { action: 'expand', description: 'read the record', mutating: false },
      { action: 'get', description: 'unrelated', mutating: false },
    ],
  }];
  const params = { id: 'mem-local', offset: 3, maxChars: 20 };
  const draft = resolveDetailRead(catalog, { domain: 'memory', read: { choices: ['absent', 'read', 'expand'], params, targetId: 'mem-local' } });
  assert.deepEqual(draft, { domain: 'memory', action: 'expand', params, id: 'mem-local' });
  assert.notEqual(draft?.params, params, 'A later action draft must not replace fields on the inspection descriptor');
});

test('session, plan and run reads retain their source specific action and identity fields', () => {
  const catalog: DomainDefinition[] = [
    { id: 'agents', capabilities: [{ action: 'session/get', description: 'session', mutating: false }] },
    { id: 'workflow', capabilities: [{ action: 'plan/get', description: 'plan', mutating: false }, { action: 'status', description: 'run', mutating: false }] },
  ];
  for (const [domain, action, params] of [
    ['agents', 'session/get', { sessionId: 'session-original' }],
    ['workflow', 'plan/get', { planId: 'plan-original' }],
    ['workflow', 'status', { runId: 'run-original' }],
  ] as const) {
    const draft = resolveDetailRead(catalog, { domain, read: { choices: [action], params } });
    assert.equal(draft?.id, undefined, 'Dedicated source fields must not be converted to a generic target');
    assert.deepEqual(draft, { domain, action, params });
  }
});

test('memory read descriptors distinguish local records, file chunks and unknown providers', () => {
  assert.deepEqual(memoryReadDescriptor({ id: 'mem-local', source: 'local-markdown' }, 'search'), {
    choices: ['read', 'expand'], params: { id: 'mem-local' }, targetId: 'mem-local',
  });
  assert.deepEqual(memoryReadDescriptor({ documentId: 'filemem-document' }, 'sources'), {
    choices: ['file_read'], params: { documentId: 'filemem-document' },
  });
  assert.equal(memoryReadDescriptor({ id: 'filemem-document:12', source: 'file_memory' }, 'search'), undefined, 'A document identity must be supplied explicitly');
  assert.equal(memoryReadDescriptor({ id: 'provider-space:record', source: 'external-provider' }, 'search'), undefined);
  assert.equal(memoryReadDescriptor({ id: 'provider-space:record', source: 'external-provider' }, 'library'), undefined);
  assert.equal(memoryReadDescriptor({ id: 'filemem-document:12', documentId: 'filemem-document', source: 'file_memory' }, 'library'), undefined);
  assert.equal(memoryReadDescriptor({ documentId: 'external-document', source: 'external-provider' }, 'sources'), undefined);
  assert.equal(memoryReadDescriptor({ id: 'provider-space:record' }, 'providers'), undefined);
  assert.equal(memoryReadDescriptor({ id: 'review-id' }, 'review'), undefined);
  assert.equal(memoryReadDescriptor({ path: 'not-a-memory-id' }, 'library'), undefined);
});

test('memory scope labels render only a known kind and cannot expose scope metadata', () => {
  const scope = { kind: 'project', ownerId: 'private-owner', projectId: 'D:/private/project', pathSelector: ['private/path'] };
  assert.equal(memoryScopeLabel(scope), '项目');
  for (const kind of ['user', 'project', 'session', 'team', 'reusable']) {
    assert.equal(typeof memoryScopeLabel({ ...scope, kind }), 'string');
    assert.doesNotMatch(memoryScopeLabel({ ...scope, kind }), /private/u);
  }
  for (const unknown of [undefined, null, [], {}, { kind: scope }, { kind: 'private-owner' }, 'toString', '__proto__']) {
    assert.equal(memoryScopeLabel(unknown), '范围未报告');
  }
});
