import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryModule } from '../src/domain/memory/index.js';
import { createAtomicStore } from '../src/domain/storage/index.js';
import type { NexusServices } from '../src/ports/contracts.js';
import { digest } from '../src/domain/memory/types.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nexus-memory-fixture-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const services: NexusServices = {
    store: createAtomicStore(join(root, 'state')), workspaceRoot: workspace, dataDir: join(root, 'data'),
    executor: { async run() { throw new Error('Unit fixture must not execute external programs'); } },
    host: {
      async facts() { return {}; }, async approve() { return true; }, async secret() { return undefined; },
      async model() { throw new Error('Unit fixture must not call a model'); },
      async spawn() { throw new Error('Unit fixture must not spawn a model'); },
      async sessions() { throw new Error('Unit fixture must not alter host sessions'); },
    },
    emit() {}, async invoke() { throw new Error('Unregistered module'); },
  };
  const module = createMemoryModule(services);
  return { root, workspace, services, module, cleanup: async () => { await module.dispose?.(); await rm(root, { recursive: true, force: true }); } };
}
test('MEMORY.md and nested MEMORY retain bytes and pinned versions while hash refresh detects edits', async () => {
  const f = await fixture();
  try {
    const original = '---\nunknown_field: preserve\n---\n# 工程状态\n编译器路径 src/engine.ts，参数42。\n';
    await writeFile(join(f.workspace, 'MEMORY.md'), original);
    await mkdir(join(f.workspace, 'MEMORY'));
    await writeFile(join(f.workspace, 'MEMORY', 'decisions.md'), '# 决策\n任务队列使用单实例，错误保持原始代码。');
    const scan = await f.module.dispatch({ action: 'file_refresh' }) as any;
    assert.equal(scan.coverage.complete, true);
    assert.equal(await readFile(join(f.workspace, 'MEMORY.md'), 'utf8'), original);
    const search = await f.module.dispatch({ action: 'search', params: { query: '参数42' } }) as any;
    assert.equal(search.items.length, 1);
    const citation = search.items[0];
    assert.equal(citation.reference.locator.startLine, 1);
    const pinned = await f.module.dispatch({ action: 'file_read', params: { documentId: citation.documentId, sourceHash: citation.sourceHash } }) as any;
    assert.equal(pinned.text, original);
    await writeFile(join(f.workspace, 'MEMORY.md'), original.replace('参数42', '参数43'));
    await f.module.dispatch({ action: 'file_refresh' });
    const old = await f.module.dispatch({ action: 'file_read', params: { documentId: citation.documentId, sourceHash: citation.sourceHash } }) as any;
    assert.equal(old.text, original);
    const current = await f.module.dispatch({ action: 'file_read', params: { documentId: citation.documentId } }) as any;
    assert.match(current.text, /参数43/u);
    assert.notEqual(current.sourceHash, old.sourceHash);
  } finally { await f.cleanup(); }
});
test('memory CAS preserves draft on conflict and rejects secrets before Markdown persistence', async () => {
  const f = await fixture();
  try {
    const save = await f.module.dispatch({ action: 'save', params: { title: '工程约定', body: '仅在本项目使用严格模式' } }) as any;
    const id = save.record.id;
    const edited = await f.module.dispatch({ action: 'update', target: { id }, expectedRevision: 1, params: { patch: { body: '已更新的约定' } } }) as any;
    assert.equal(edited.record.revision, 2);
    await assert.rejects(f.module.dispatch({ action: 'update', target: { id }, expectedRevision: 1, params: { patch: { body: '过期草稿' } } }), (error: any) => error.code === 'REVISION_CONFLICT' && error.details.draft.body === '过期草稿');
    await assert.rejects(f.module.dispatch({ action: 'save', params: { title: '凭据', body: `sk-${'q'.repeat(32)}` } }), (error: any) => error.code === 'SECRET_REJECTED');
    const list = await f.module.dispatch({ action: 'list' }) as any;
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].body, '已更新的约定');
  } finally { await f.cleanup(); }
});
test('fixed snapshot remains byte stable after new memory; explicit refresh advances epoch', async () => {
  const f = await fixture();
  try {
    const deliveries: any[] = [];
    f.services.host.sessions = async (action, params) => {
      assert.equal(action, 'memory.refresh'); deliveries.push(params);
      return { accepted: true, durable: true, messageId: 'refresh-message', deliveryEvidence: { inboxPending: true } };
    };
    await f.module.dispatch({ action: 'save', params: { title: '固定约束', body: '约束一', authority: 'derived', validation: 'reviewed', evidence: [{ type: 'human_attestation', uri: 'human:fixture' }] } });
    const one = await f.module.dispatch({ action: 'snapshot' }, { sessionId: 's1' }) as any;
    await f.module.dispatch({ action: 'save', params: { title: '新增约束', body: '约束二', authority: 'derived' } });
    const two = await f.module.dispatch({ action: 'snapshot' }, { sessionId: 's1' }) as any;
    assert.equal(two.bytes, one.bytes); assert.equal(two.memorySnapshotHash, one.memorySnapshotHash);
    const refreshed = await f.module.dispatch({ action: 'refresh', requestId: 'refresh-s1' }, { sessionId: 's1' }) as any;
    assert.equal(refreshed.memorySnapshotEpoch, one.memorySnapshotEpoch + 1);
    assert.notEqual(refreshed.memorySnapshotHash, one.memorySnapshotHash);
    assert.equal(refreshed.appended, true);
    assert.match(deliveries[0].bytes, /约束二/u);
    assert.equal((await f.module.dispatch({ action: 'refresh', requestId: 'refresh-s1' }, { sessionId: 's1' }) as any).duplicate, true);
    assert.equal(deliveries.length, 1);
  } finally { await f.cleanup(); }
});
test('unconfirmed memory append preserves the pinned epoch and reconciles the exact pending candidate', async () => {
  const f = await fixture();
  try {
    await f.module.dispatch({ action: 'save', params: { title: '刷新前约束', body: '原始约束', authority: 'derived' } });
    const before = await f.module.dispatch({ action: 'snapshot' }, { sessionId: 's1' }) as any;
    const deliveries: any[] = [];
    let confirmed = false;
    f.services.host.sessions = async (action, params) => {
      assert.equal(action, 'memory.refresh'); deliveries.push(params);
      return { accepted: confirmed, durable: confirmed, messageId: 'exact-message' };
    };
    const request = { action: 'refresh', requestId: 'refresh-unconfirmed' };
    await assert.rejects(f.module.dispatch(request, { sessionId: 's1' }), (error: any) => error.code === 'DELIVERY_UNCONFIRMED');
    const unchanged = await f.module.dispatch({ action: 'snapshot' }, { sessionId: 's1' }) as any;
    assert.equal(unchanged.memorySnapshotEpoch, before.memorySnapshotEpoch);
    await f.module.dispatch({ action: 'save', params: { title: '稍后修改', body: '后来的字节不可混入待确认候选', authority: 'derived' } });
    confirmed = true;
    const result = await f.module.dispatch(request, { sessionId: 's1' }) as any;
    assert.equal(result.memorySnapshotEpoch, before.memorySnapshotEpoch + 1);
    assert.deepEqual(deliveries[1], deliveries[0]);
    assert.doesNotMatch(deliveries[1].bytes, /后来的字节/u);
  } finally { await f.cleanup(); }
});
test('secret file chunks are quarantined and not copied into pinned raw blob', async () => {
  const f = await fixture();
  try {
    const raw = `# 凭据\nsk-${'v'.repeat(32)}\n`;
    await writeFile(join(f.workspace, 'MEMORY.md'), raw);
    await f.module.dispatch({ action: 'file_refresh' });
    const result = await f.module.dispatch({ action: 'search', params: { query: '' } }) as any;
    assert.equal(result.items.length, 0);
    assert.equal(await f.services.store.get('memory-file-versions', digest(raw).slice(7)), undefined);
  } finally { await f.cleanup(); }
});
test('unknown advanced methods and self-declared host authority fail closed before process launch', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.module.dispatch({ action: 'advanced', params: { capabilityId: 'cognition.identity', method: 'shell' } }), (error: any) => error.code === 'UNKNOWN_METHOD');
    await assert.rejects(f.module.dispatch({ action: 'advanced', params: { capabilityId: 'cognition.identity', method: 'observe', args: { actor: 'admin' } } }), (error: any) => error.code === 'TRUSTED_FIELD_REJECTED');
  } finally { await f.cleanup(); }
});
test('external Markdown edits are preserved and block a later CAS save', async () => {
  const f = await fixture();
  try {
    const saved = await f.module.dispatch({ action: 'save', params: { title: '外部编辑', body: '原始正文' } }) as any;
    const path = join(f.services.dataDir, 'memory', 'records', `${saved.record.id}.md`);
    const edited = (await readFile(path, 'utf8')).replace('原始正文', '外部修改正文');
    await writeFile(path, edited);
    await assert.rejects(f.module.dispatch({ action: 'update', target: { id: saved.record.id }, expectedRevision: 1, params: { patch: { body: '覆盖草稿' } } }), (error: any) => error.code === 'EXTERNAL_CHANGE');
    assert.equal(await readFile(path, 'utf8'), edited);
  } finally { await f.cleanup(); }
});
test('concurrent approval commits a proposal once and keeps the reviewed evidence', async () => {
  const f = await fixture();
  try {
    const proposed = await f.module.dispatch({ action: 'propose', params: { title: '候选', body: '应保留的依据', evidence: [{ type: 'file_range', uri: 'src/main.ts:3' }] } }, { actorId: 'producer' }) as any;
    const responses = await Promise.all([1, 2].map(() => f.module.dispatch({ action: 'review', params: { proposalId: proposed.proposalId, decision: 'accept' } }, { actorId: 'reviewer' }))) as any[];
    assert.equal(responses.filter(response => response.duplicate).length, 1);
    const result = await f.module.dispatch({ action: 'list' }) as any;
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].validation, 'reviewed');
    assert.equal(result.items[0].evidence[0].uri, 'src/main.ts:3');
  } finally { await f.cleanup(); }
});
test('concurrent completed-turn capture has one logical record with original identity', async () => {
  const f = await fixture();
  try {
    const params = { originSessionId: 'session-a', originTurnId: 'turn-1', summary: '用户确认工程使用 SQLite。', status: 'completed' };
    await Promise.all([1, 2].map(() => f.module.dispatch({ action: 'capture', params }, { sessionId: 'session-a', actorId: 'host-capture' })));
    const result = await f.module.dispatch({ action: 'list' }, { sessionId: 'session-a', actorId: 'host-capture' }) as any;
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].origin.kind, 'capture');
    assert.equal(result.items[0].origin.turnId, 'turn-1');
    await assert.rejects(f.module.dispatch({ action: 'capture', params }, { sessionId: 'different-session' }), (error: any) => error.code === 'SOURCE_SCOPE_DENIED');
  } finally { await f.cleanup(); }
});
test('revoked file memory stops future search and exact read without claiming historical retraction', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, 'MEMORY.md'), '# 撤销来源\n该项目约束仅在撤销前可被发送。');
    await f.module.dispatch({ action: 'file_refresh' });
    const before = await f.module.dispatch({ action: 'search', params: { query: '项目约束' } }) as any;
    const id = before.items[0].documentId;
    const receipt = await f.module.dispatch({ action: 'revoke', target: { id }, params: { reason: '来源撤销' } }) as any;
    assert.equal(receipt.futureSendingBlocked, true);
    assert.equal(receipt.historicalModelRecall, 'cannot_retract');
    const after = await f.module.dispatch({ action: 'search', params: { query: '项目约束' } }) as any;
    assert.equal(after.items.length, 0);
    await assert.rejects(f.module.dispatch({ action: 'file_read', params: { documentId: id } }), (error: any) => error.code === 'REVOKED');
  } finally { await f.cleanup(); }
});
