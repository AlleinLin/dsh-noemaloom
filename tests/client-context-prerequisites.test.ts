import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { isValidElement } from 'react';
import { contextActionDraft, contextActionRequiresSession, contextViewPrerequisites, recoveryMessageBoundaries, recoveryWorkspaceNotice } from '../src/client/context-prerequisites.js';
import { contextContentBoundary } from '../src/client/domain-views.js';
import { ClientError, createNexusApi } from '../src/client/transport.js';
import type { ActionDraft, ClientContext, Data, NexusScope, ViewContext } from '../src/client/types.js';
import { createContextModule } from '../src/domain/context/index.js';
import { createDispatcher, type Dispatcher } from '../src/domain/operations/index.js';
import { createRecoveryModule } from '../src/domain/recovery/index.js';
import { createAtomicStore } from '../src/domain/storage/index.js';
import { NexusError, type NexusRequest, type NexusServices } from '../src/ports/contracts.js';

async function fixture(t: TestContext, overlap = false) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-client-context-prerequisites-'));
  const workspace = overlap ? root : join(root, 'workspace');
  if (!overlap) await mkdir(workspace);
  let dispatcher: Dispatcher;
  const calls: Array<{ domain: string; action: string; params: Data }> = [];
  const services: NexusServices = {
    store: createAtomicStore(join(root, 'store')), workspaceRoot: workspace, dataDir: join(root, 'data'),
    executor: { async run() { throw new Error('This client contract must not execute external programs'); } },
    host: {
      async facts() { return {}; }, async approve() { return true; }, async secret() { return undefined; },
      async model() { throw new Error('This client contract must not call a provider'); },
      async spawn() { throw new Error('This client contract must not spawn a model'); },
      async sessions(action, params) {
        if (action !== 'snapshot') throw new Error('This client contract must not change host sessions');
        return { id: params.sessionId, sessionId: params.sessionId, events: [
          { seq: 0, type: 'user/message', directUser: true, content: [{ type: 'text', text: 'First recovery preview boundary' }] },
          { seq: 10, type: 'turn/end', turn: 0 },
          { seq: 17, type: 'user/message', directUser: true, content: [{ type: 'text', text: 'Later recovery preview boundary' }] },
        ] };
      },
    },
    emit() {},
    async invoke(domain, request, context) {
      const result = await dispatcher.dispatch(domain, request, context);
      if (!result.ok) throw new NexusError(result.error!.code, result.error!.message, result.error!.details);
      return result.data;
    },
  };
  const context = createContextModule(services);
  const recovery = createRecoveryModule(services);
  dispatcher = createDispatcher(services, [context, recovery]);
  // The transport consumes the real Dispatcher response, including its public
  // INTERNAL/details.domainCode projection. Only Connection RPC is in-process.
  const host: ClientContext = {
    connection: { rpc: {
      async call(_channel, _endpoint, input, signal) {
        const envelope = input as { scope?: NexusScope; payload: NexusRequest & { params: Data } };
        const { domain, ...params } = envelope.payload.params;
        const request = { ...envelope.payload, params };
        calls.push({ domain, action: request.action, params });
        return { ok: true, value: await dispatcher.dispatch(domain, request, {
          actorId: 'fixture-user', sessionId: envelope.scope?.sessionId, signal,
        }) };
      },
    } },
    slots: { inject() {}, register() {} },
    effect() {},
  };
  const api = createNexusApi(host);
  t.after(async () => {
    api.dispose();
    try { await dispatcher.dispose(); }
    finally {
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('nexus-client-context-prerequisites-')) throw new Error('Unexpected fixture cleanup path');
      await rm(root, { recursive: true, force: true });
    }
  });
  return { context, api, calls };
}

test('every empty-session context tab requests only the real workspace overview', async t => {
  const f = await fixture(t);
  for (const sessionId of [undefined, '', ' \t ']) {
    for (const tab of ['compression', 'cache', 'epochs', 'prefix', 'policy']) {
      const selected = contextViewPrerequisites(sessionId, tab);
      assert.equal(selected.hasSession, false);
      const queries = Object.values(selected.queries).filter(query => query.enabled);
      assert.equal(queries.length, 1);
      const overview = await f.api.call<Data>('context', queries[0].action, queries[0].params);
      assert.deepEqual(overview.sessions, []);
      assert.equal(overview.actualCacheHit, null, 'Workspace inventory is not a provider cache observation');
      assert.equal(overview.observations, undefined);
      assert.equal(overview.cacheReadShare, undefined);
    }
  }
  assert.ok(f.calls.every(call => call.action === 'overview'));
});

test('the operation prerequisite matches the real domain session boundary and keeps workspace operations available', async t => {
  const f = await fixture(t);
  for (const capability of f.context.capabilities.filter(item => !item.action.startsWith('native/'))) {
    const draft: ActionDraft = { domain: 'context', action: capability.action };
    const selected = contextActionDraft(draft, '  ');
    if (contextActionRequiresSession(capability.action)) {
      assert.equal(selected, undefined, `Missing-session ${capability.action} must not reach the action dialog`);
      await assert.rejects(f.context.dispatch({ action: capability.action }), error => error instanceof NexusError && error.code === 'CTX_SESSION_REQUIRED');
    } else {
      assert.equal(selected, draft);
      const result = await f.api.call<Data>(draft.domain, draft.action);
      assert.ok(Array.isArray(result.sessions));
    }
  }
  const usage: ActionDraft = { domain: 'usage', action: 'summary' };
  assert.equal(contextActionDraft(usage, ''), usage, 'Global usage remains available without a context session');
});

test('a selected session retains real status, cache, prefix diagnostics and scoped policy changes', async t => {
  const f = await fixture(t);
  for (const tab of ['compression', 'cache', 'epochs', 'prefix', 'policy']) {
    const selected = contextViewPrerequisites(' \tfixture-session  ', tab);
    const queries = Object.values(selected.queries).filter(query => query.enabled);
    for (const query of queries) {
      assert.deepEqual(query.params, { sessionId: 'fixture-session' });
      if (query.action === 'wire/diff') {
        const empty = await f.api.call<Data>('context', query.action, query.params);
        assert.equal(empty.state, 'not-observed');
        assert.equal(empty.cacheHitProven, false);
      } else {
        const data = await f.api.call<Data>('context', query.action, query.params);
        if (query.action === 'status' || query.action === 'cache/report') assert.equal(data.sessionId, 'fixture-session');
        if (query.action === 'epochs/get') assert.ok(data.epochs);
        if (query.action === 'policy/get') assert.equal(data.mode, 'auto');
        if (query.action === 'cache/report') {
          assert.equal(data.evidence, 'unobserved');
          assert.equal(data.coverage.attempts, 0);
          assert.equal(data.cacheReadShare, null);
        }
      }
    }
  }
  const draft = contextActionDraft({ domain: 'context', action: 'policy', params: { mode: 'observe' } }, ' fixture-session ');
  assert.ok(draft);
  await f.api.call(draft.domain, draft.action, draft.params, { mutating: true });
  const selected = await f.api.call<Data>('context', 'status', { sessionId: 'fixture-session' });
  const other = await f.api.call<Data>('context', 'status', { sessionId: 'other-session' });
  assert.equal(selected.mode, 'observe');
  assert.equal(other.mode, 'auto', 'The selected session must not be replaced by an implicit host scope');
});

test('the production React query boundary retires data and action closures when session or action changes', async t => {
  const f = await fixture(t);
  const view: ViewContext = {
    api: f.api, catalog: [{ id: 'context', capabilities: f.context.capabilities }],
    probe: {}, scope: {}, refreshToken: 0,
    inspect() {}, action() {}, notify() {}, navigate() {}, openNativeSession() {},
  };
  const before = contextContentBoundary(view, 'session-A', 'compression');
  const after = contextContentBoundary(view, 'session-B', 'compression');
  const cache = contextContentBoundary(view, 'session-B', 'cache');
  const prefix = contextContentBoundary(view, 'session-B', 'prefix');
  assert.equal(isValidElement(before), true);
  assert.equal(before.type, after.type);
  assert.notEqual(before.key, after.key, 'React must unmount A hooks and row callbacks before mounting B');
  assert.notEqual(cache.key, prefix.key, 'Cache data and errors must not survive as wire/diff results');
  assert.notEqual(before.key, contextContentBoundary(view, ' session-A ', 'epochs', 1).key, 'Epochs has its own read contract and cannot reuse status data');
  assert.notEqual(after.key, contextContentBoundary({ ...view, scope: { workspaceId: 'other-workspace' } }, 'session-B', 'compression').key);

  // Consume the actual keyed child's identity through the same action adapter
  // and real Dispatcher used by its row controls. Even a previously scheduled
  // A callback retains A; it cannot combine B with A's selected object.
  const retiredDraft = contextActionDraft({ domain: 'context', action: 'policy', params: { mode: 'observe' } }, before.props.prerequisites.sessionId);
  assert.ok(retiredDraft);
  await f.api.call(retiredDraft.domain, retiredDraft.action, retiredDraft.params, { mutating: true });
  const oldSession = await f.api.call<Data>('context', 'status', { sessionId: before.props.prerequisites.sessionId });
  const newSession = await f.api.call<Data>('context', 'status', { sessionId: after.props.prerequisites.sessionId });
  assert.equal(oldSession.sessionId, 'session-A');
  assert.equal(oldSession.mode, 'observe');
  assert.equal(newSession.sessionId, 'session-B');
  assert.equal(newSession.mode, 'auto');
});

test('recovery overlap survives the real public error projection while ledger and conversation preview remain usable', async t => {
  const f = await fixture(t, true);
  let failure: unknown;
  try { await f.api.call('recovery', 'list'); }
  catch (error) { failure = error; }
  assert.ok(failure instanceof ClientError);
  assert.equal(failure.code, 'STATE_WORKSPACE_OVERLAP');
  const notice = recoveryWorkspaceNotice(failure);
  assert.equal(notice, '当前工作区与恢复状态目录重叠，文件恢复暂不可用；请在宿主打开独立项目目录后重试。');
  assert.equal(f.calls.filter(call => call.domain === 'recovery' && call.action === 'list').length, 1);

  const ledger = await f.api.call<Data>('recovery', 'operations');
  assert.deepEqual(ledger.items, []);
  const plan = await f.api.call<Data>('recovery', 'plan', {
    mode: 'conversation-only', sessionId: 'fixture-session', openingMessageSeq: 0,
  }, { mutating: true });
  assert.equal(plan.mode, 'conversation-only');
  assert.equal(plan.boundary.sessionId, 'fixture-session');
  assert.equal(plan.filePlan, undefined, 'Conversation recovery must not bypass the file guard or capture user files');
  assert.ok(plan.digest);
});

test('the workspace overlap notice ignores arbitrary diagnostics and exposes no paths', () => {
  const error = new ClientError('INTERNAL', 'private workspace path', {
    domainCode: 'STATE_WORKSPACE_OVERLAP', domainDetails: { workspace: 'D:/private/project', state: 'D:/private/state' },
  });
  assert.doesNotMatch(recoveryWorkspaceNotice(error)!, /private|D:|state|workspace/);
  for (const other of [undefined, null, new Error('STATE_WORKSPACE_OVERLAP'), { code: 'STATE_WORKSPACE_OVERLAP' }, { details: { domainCode: 'OTHER_ERROR' } }]) {
    assert.equal(recoveryWorkspaceNotice(other), undefined);
  }
});

test('recovery controls use the selected durable direct-user sequence rather than a fixed zero or injected event', async t => {
  const f = await fixture(t);
  const snapshot: Data = { sessionId: 'fixture-session', events: [
    { seq: 0, type: 'user/message', directUser: true, content: [{ type: 'text', text: 'First boundary' }] },
    { seq: 17, type: 'user/message', directUser: true, content: [{ type: 'text', text: 'Later boundary' }] },
    { seq: 18, type: 'user/message', directUser: true, injected: true },
    { seq: 19, type: 'assistant/message', directUser: true },
    { seq: -1, type: 'user/message', directUser: true },
  ] };
  const choices = recoveryMessageBoundaries(snapshot, 'fixture-session');
  assert.deepEqual(choices.map(row => row.seq), [0, 17]);
  assert.match(choices[1].label, /Later boundary/);
  assert.deepEqual(recoveryMessageBoundaries(snapshot, 'other-session'), []);
  const plan = await f.api.call<Data>('recovery', 'plan', {
    mode: 'conversation-only', sessionId: 'fixture-session', openingMessageSeq: choices[1].seq,
  }, { mutating: true });
  assert.equal(plan.boundary.openingMessageSeq, 17);
});
