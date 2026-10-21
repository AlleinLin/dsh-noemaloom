import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { createDispatcher } from '../src/domain/operations/index.js';
import { createHostAdapter, hostAuthority } from '../src/host/host-adapter.js';
import type { HostContext } from '../src/host/types.js';
import { companionFixture, deferred } from './companion-fixture.js';

test('native user admission and durable persistence retain one task and its visible companion results across dispatcher cloning', async t => {
  const f = companionFixture(), root = new Context();
  const dataDir = await mkdtemp(join(tmpdir(), 'nexus-native-companion-identity-'));
  const id = SessionId('main'), workspaceRoot = process.cwd();
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd: workspaceRoot,
  });
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  const message = createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'Research a reliable plan and keep its acceptance criteria visible.' }],
  });
  assert.equal(Object.isFrozen(message), true);
  assert.deepEqual(Object.keys(message.content[0]), ['type', 'text']);
  let host!: ReturnType<typeof createHostAdapter>;
  const fiber = root.plugin({ name: 'native-companion-identity', apply(owner: Context) {
    const ctx = owner as unknown as HostContext;
    ctx.provide('sessionQuery', {
      async readSession(sessionId: string) {
        assert.equal(sessionId, id);
        return { session: session.header, events: session.snapshotEvents(), inheritedEventCount: 0 };
      },
      async listSessions() { return [{ header: session.header }]; },
    });
    host = createHostAdapter(ctx, {}, workspaceRoot, new AbortController().signal);
  } });
  await fiber.await();
  assert.equal(fiber.state, 2);
  const surfaces: any[] = [], originalSessions = f.services.host.sessions;
  f.services.host.sessions = async (action, params) => {
    if (action !== 'companion.surface') return originalSessions(action, params);
    const surface = await host.sessions(action, params);
    surfaces.push(surface);
    return surface;
  };
  const dispatcher = createDispatcher({ ...f.services, dataDir, workspaceRoot });
  dispatcher.register(f.module);
  host.connect(dispatcher.services);
  const entered = deferred(), release = deferred();
  let observing: Promise<any> | undefined;
  t.after(async () => {
    release.resolve();
    await observing?.catch(() => undefined);
    await dispatcher.dispose();
    await host.dispose();
    await fiber.dispose();
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    assert.ok(basename(dataDir).startsWith('nexus-native-companion-identity-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  const authority = { ...f.context, workspaceRoot, permissions: new Set(['companion.observe']) };
  const observe = (params: Record<string, unknown> = {}) => hostAuthority.run(authority, () =>
    dispatcher.services.invoke('companion', {
      action: 'observe', params, requestId: `native-companion-identity:${randomUUID()}`,
    }, authority)) as Promise<any>;
  const first = await observe({ admitted: [message] });
  assert.equal(first.state, 'ready');
  assert.equal(first.assessment.phase, 'preplanning');
  assert.ok(first.note);
  assert.ok(first.reflection);
  assert.deepEqual(first.reflectionStages, ['preplanning']);
  const admitted = surfaces[0].packets[0].events.find((event: any) => event.transientAdmission).data;
  assert.equal(admitted.id, message.id);
  assert.deepEqual(Object.keys(admitted.content[0]), ['text', 'type'], 'the formal dispatcher actually canonicalizes native message keys');
  session.append('user/message', message, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  f.produce(async request => {
    assert.equal(request.role, 'companion-assessment', 'the same preplanning reflection must not be generated again');
    entered.resolve();
    await release.promise;
    return { provider: request.provider, model: request.model, text: JSON.stringify({
      phase: 'research', researchComplete: false, proposalStarted: false, phaseEvidence: ['main#1'],
      note: null, reflection: null, taskSummary: 'Research continues.',
    }) };
  });
  observing = observe();
  await Promise.race([entered.promise, observing.then(value => {
    throw new Error(`the next observation finished before entering assessment: ${value.state}`);
  })]);
  const checking = (await f.store.list<any>('companion-state'))[0].value;
  assert.equal(checking.state, 'checking');
  assert.equal(checking.taskKey, first.taskKey);
  assert.deepEqual(checking.note, first.note);
  assert.deepEqual(checking.reflection, first.reflection);
  assert.deepEqual(checking.reflectionStages, ['preplanning']);
  const persisted = surfaces[1].packets[0].events.find((event: any) => event.type === 'user/message').data;
  assert.deepEqual(Object.keys(persisted.content[0]), ['type', 'text'], 'native persistence retains the original message representation');
  release.resolve();
  const second = await observing;
  assert.equal(second.state, 'ready');
  assert.equal(second.taskKey, first.taskKey);
  assert.deepEqual(second.note, first.note);
  assert.deepEqual(second.reflection, first.reflection);
  assert.deepEqual(second.reflectionStages, ['preplanning']);
  assert.equal(f.calls.filter(call => call.role === 'companion-reflection').length, 1);
});
