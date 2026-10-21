import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionModule, DEEP_QUESTION, parseCompanion, THOROUGH_PROMPT } from '../src/domain/insights/companion.js';
import { conversationSurface } from '../src/domain/insights/conversation.js';
import { companionFixture, deferred } from './companion-fixture.js';

test('full surface includes tool arguments/results and children while excluding private reasoning and credential forms', () => {
  const packets = [{ sessionId: 'main', status: 'running', events: [
    { seq: 0, type: 'user/message', data: { message: { id: 'human', source: { kind: 'user' }, content: [{ type: 'text', text: '真实任务' }] } } },
    { seq: 1, type: 'tool/call', data: { name: 'read', arguments: { path: 'source.ts', access_token: 'test-access-hidden', refresh_token: 'test-refresh-hidden', apiToken: 'test-camel-hidden', DEEPSEEK_API_KEY: 'test-env-hidden' } } },
    { seq: 2, type: 'tool/result', data: { content: 'tool-fact DEEPSEEK_API_KEY=test-string-hidden\n{"access_token":"test-json-hidden"}', chunks: Array.from({ length: 150 }, (_, i) => `part-${i}`) } },
    { seq: 3, type: 'assistant/message', data: { content: [{ type: 'reasoning', text: 'private-hidden' }, { type: 'text', text: '可见解释' }] } },
  ] }, { sessionId: 'child', parentId: 'main', status: 'idle', events: [{ seq: 0, type: 'assistant/message', data: { content: 'child-fact' } }] }];
  const surface = conversationSurface('main', packets, [], 20000, 4000, 12), text = surface.chunks.join('');
  assert.match(text, /source.ts/); assert.match(text, /tool-fact/); assert.match(text, /child-fact/); assert.match(text, /part-149/);
  assert.doesNotMatch(text, /test-access-hidden|test-refresh-hidden|test-camel-hidden|test-env-hidden|test-string-hidden|test-json-hidden|private-hidden/);
  assert.equal(surface.coverage.complete, true); assert.equal(surface.coverage.eventCount, 5);
  const overflow = conversationSurface('main', packets, [], 10, 100, 12);
  assert.equal(overflow.coverage.complete, false); assert.deepEqual(overflow.chunks, []);
  let deep: any = 'leaf'; for (let i = 0; i < 40; i++) deep = { nested: deep };
  const nested = conversationSurface('main', [{ sessionId: 'main', status: 'idle', events: [{ seq: 8, data: deep }] }], [], 10000, 1000, 20);
  assert.equal(nested.coverage.complete, false); assert.match(nested.coverage.unavailable[0].reason, /32/);
  const withQuestions = structuredClone(packets);
  withQuestions[0].events.push({ seq: 9, type: 'user/message', data: { message: { id: 'questions', source: { kind: 'user' }, content: [{ type: 'text', text: THOROUGH_PROMPT }] } } } as any);
  assert.equal(conversationSurface('main', withQuestions, [], 20000, 4000, 12).taskKey, surface.taskKey);
});

test('structured phase requires existing references and completed research without a started proposal', () => {
  const valid = { phase: 'ready-to-propose', researchComplete: true, proposalStarted: false, phaseEvidence: ['main#2'], note: null, reflection: null, taskSummary: 'task' };
  assert.equal(parseCompanion(JSON.stringify(valid), new Set(['main#2'])).phase, 'ready-to-propose');
  assert.throws(() => parseCompanion(JSON.stringify({ ...valid, proposalStarted: true }), new Set(['main#2'])), /合同/);
  assert.throws(() => parseCompanion(JSON.stringify(valid), new Set(['main#1'])), /合同/);
});

test('native assembled assistant messages exclude duplicate streams and private compact reasoning while failed visible prefixes remain', () => {
  const packets = [{ sessionId: 'main', status: 'idle', events: [
    { seq: 1, type: 'assistant/message', data: { message: { role: 'assistant',
      content: [{ type: 'reasoning', text: 'test-private-body' }, { type: 'text', text: 'Visible committed explanation' }],
      source: { kind: 'model', replayState: { content: { private: 'test-private-replay' } } } },
      stream: [
        { type: 'text-chunks', texts: ['Visible committed explanation'] },
        { type: 'reasoning-chunks', texts: ['test-private-compact'] },
        { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'test-private-delta' } },
      ] } },
    { seq: 2, type: 'assistant/attempt', data: { stream: [
      { type: 'text-chunks', texts: ['Visible failed prefix'] },
      { type: 'reasoning-chunks', texts: ['test-private-failed-compact'] },
      { type: 'chunk', chunk: { type: 'thinking-delta', text: 'test-private-failed-delta' } },
      { type: 'chunk', chunk: { type: 'tool-call-delta', name: 'read', argumentsDelta: '{"path":"source.ts"}' } },
    ] } },
  ] }];
  const surface = conversationSurface('main', packets, [], 20000, 12000, 12), text = surface.chunks.join('');
  assert.equal(text.split('Visible committed explanation').length - 1, 1);
  assert.match(text, /Visible failed prefix/); assert.match(text, /source.ts/);
  assert.doesNotMatch(text, /test-private-/);
  assert.equal(surface.coverage.complete, true); assert.equal(surface.coverage.eventCount, 2);
});

test('preplanning and review invoke the deep question once each; cached reads never call a model', async () => {
  const f = companionFixture();
  const first = await f.dispatch('observe');
  assert.equal(first.state, 'ready'); assert.ok(first.note);
  assert.equal(f.calls.filter(c => c.role === 'companion-reflection').length, 1);
  assert.ok(f.calls.find(c => c.role === 'companion-reflection').system.includes(DEEP_QUESTION));
  await f.dispatch('get', {}, f.owner); await f.dispatch('observe');
  assert.equal(f.calls.length, 2);
  f.seq(2); f.phase('review'); await f.dispatch('observe', { checkpoint: 'turn-end' });
  f.seq(3); await f.dispatch('observe', { checkpoint: 'turn-end' });
  assert.equal(f.calls.filter(c => c.role === 'companion-reflection').length, 2);
  assert.equal(f.calls.every(c => c.readOnly && !c.allowChildren), true);
});

test('background and pre-step checks share one in-flight request; disable invalidates old epochs without stale writes', async () => {
  const f = companionFixture({ reflection: false }), entered = deferred(), release = deferred();
  f.produce(async request => { entered.resolve(); await release.promise; return { provider: request.provider, model: request.model,
    text: JSON.stringify({ phase: 'unknown', researchComplete: false, proposalStarted: false, phaseEvidence: [], note: null, reflection: null, taskSummary: 'old' }) }; });
  const first = f.dispatch('observe'), second = f.dispatch('observe', { checkpoint: 'turn-end' });
  await entered.promise; assert.equal(f.calls.length, 1);
  await f.store.put('scope-settings', 'global/auxiliary', { enabled: false, defaults: {} }, 1);
  await f.dispatch('invalidate'); release.resolve();
  await Promise.allSettled([first, second]);
  const current = await f.dispatch('get', {}, f.owner);
  assert.equal(current.enabled, false); assert.notEqual(current.state, 'ready'); assert.equal(current.gate, undefined);
});

test('concurrent sessions preserve both recent and known ledgers at workspace scope', async () => {
  const f = companionFixture({ reflection: false }), other = { ...f.context, sessionId: 'other' };
  const values = await Promise.all([f.dispatch('observe'), f.dispatch('observe', {}, other)]);
  assert.ok(values.every(v => v.state === 'ready' && v.note));
  await Promise.all([
    f.dispatch('answer', { noteId: values[0].noteId, choice: 'known' }, f.owner),
    f.dispatch('answer', { noteId: values[1].noteId, choice: 'known' }, { ...other, actorId: 'connection-owner' }),
  ]);
  const memory = (await f.store.list<any>('companion-topics'))[0].value;
  assert.deepEqual(new Set(memory.recent.map((n: any) => n.topic)), new Set(['验证-main', '验证-other']));
  assert.deepEqual(new Set(memory.known.map((n: any) => n.topic)), new Set(['验证-main', '验证-other']));
  f.seq(2); await f.dispatch('observe', { checkpoint: 'turn-end' });
  assert.equal((await f.dispatch('get', {}, f.owner)).note, null);
});

test('only owner choices release a pending gate and restart expires persisted gates without another wait', async () => {
  const f = companionFixture({ reflection: false }); f.phase('ready-to-propose');
  const ready = await f.dispatch('observe'); assert.equal(ready.gate.state, 'pending');
  await assert.rejects(f.dispatch('gate', { gateId: ready.gate.id, choice: 'sent' }), /用户/);
  await f.dispatch('gate', { gateId: ready.gate.id, choice: 'skipped' }, f.owner);
  const waited = await f.dispatch('wait-gate'); assert.equal(waited.gate.state, 'skipped');
  f.seq(2); const again = await f.dispatch('observe', { checkpoint: 'turn-end' }); assert.equal(again.gate, undefined);
  const row = (await f.store.list<any>('companion-state'))[0];
  await f.store.put('companion-state', row.id, { ...row.value, gate: { ...ready.gate, expiresAt: Date.now() - 1 } }, row.revision);
  const restarted = createCompanionModule(f.services);
  const expired: any = await restarted.dispatch({ action: 'get' }, f.owner);
  assert.equal(expired.gate.state, 'expired'); assert.ok(expired.decidedGates.includes(ready.gate.id));
  const unauthorized: any = await restarted.dispatch({ action: 'gate', params: { gateId: ready.gate.id, choice: 'authorize' } }, f.owner);
  assert.equal(unauthorized.authorized, false); await restarted.dispose?.();
});

test('all three auxiliary mechanisms disabled perform no requests even with valid routes', async () => {
  const f = companionFixture({ suggestions: false, reflection: false, planningPrompt: false });
  assert.equal((await f.dispatch('observe')).state, 'disabled'); assert.equal(f.calls.length, 0);
});

test('full long context uses cached leaf summaries and hierarchical reductions without choosing only its tail', async () => {
  const f = companionFixture({ reflection: false, maxInputTokens: 24000, maxContextChars: 200000, maxChunks: 128 });
  const originalSessions = f.services.host.sessions;
  let end = 5;
  f.services.host.sessions = async (action, params) => action === 'companion.surface'
    ? { packets: Array.from({ length: end }, (_, i) => ({ sessionId: i ? `child-${i}` : 'main', parentId: i ? 'main' : undefined, status: 'idle',
      events: [{ seq: 0, type: i ? 'tool/result' : 'user/message', data: { message: { id: `m-${i}`, source: { kind: 'user' }, content: [{ type: 'text', text: `leaf-${i} ${'evidence '.repeat(900)}` }] } } }] })), unavailable: [] }
    : originalSessions(action, params);
  f.produce(async request => ({ provider: request.provider, model: request.model, text: request.role === 'companion-context'
    ? `all covered ${request.prompt.match(/leaf-\d+/g)?.join(',') ?? 'reductions'} ${'summary '.repeat(100)}`
    : JSON.stringify({ phase: 'unknown', researchComplete: false, proposalStarted: false, phaseEvidence: [], reflection: null, taskSummary: 'all leaves', note: null }) }));
  const first = await f.dispatch('observe');
  assert.equal(first.state, 'ready'); assert.equal(first.contextMode, 'summarized');
  const firstMap = f.calls.filter(c => c.role === 'companion-context').length;
  assert.ok(firstMap >= 5); assert.ok(f.calls.some(c => c.prompt.includes('leaf-0')));
  end = 6; await f.dispatch('observe', { checkpoint: 'turn-end' });
  const secondMap = f.calls.filter(c => c.role === 'companion-context').length - firstMap;
  assert.ok(secondMap < firstMap, 'unchanged prefix leaves use persistent cache');
});
