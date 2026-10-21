import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createSessionBridge } from '../src/host/session-bridge.js';
import { registerMemoryHooks } from '../src/host/hooks.js';
import { OperationController } from '../src/host/lifecycle.js';
import { STEP_PAUSE_PRODUCER } from '../src/shared/step-pause.js';
import { deferred, stepProgressServices } from './step-progress-fixture.js';

const human = () => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep the original user goal.' }] });
const notice = (visible = true) => createUserMessage({
  source: visible
    ? { kind: 'user', meta: { producer: STEP_PAUSE_PRODUCER, purpose: 'step-progress' } }
    : { kind: STEP_PAUSE_PRODUCER, meta: { producer: STEP_PAUSE_PRODUCER, purpose: 'step-progress' } },
  content: [{ type: 'text', text: 'Synthetic periodic progress instruction.' }],
});

test('session recovery projection marks visible and hidden progress notices as injected', async () => {
  const f = stepProgressServices();
  const messages = [human(), notice(), notice(false)];
  const events = messages.map((data, seq) => ({ seq, type: 'user/message', surfaceOp: 'append', data }));
  const ctx = { get(name: string) {
    if (name === 'agents') return { get: () => undefined };
    if (name === 'sessionQuery') return { async readSession() {
      return { session: { id: 's', cwd: process.cwd() }, inheritedEventCount: 0, events };
    } };
  } };
  const bridge = createSessionBridge(ctx as any, {}, process.cwd(), f.stop.signal, () => f.services);
  try {
    const result: any = await bridge.dispatch('snapshot', { sessionId: 's' });
    assert.deepEqual(result.events.map((event: any) => [event.directUser, event.injected]), [
      [true, false], [false, true], [false, true],
    ]);
    assert.deepEqual(result.events.map((event: any) => event.data), messages, 'canonical messages remain intact');
  } finally { await bridge.dispose(); }
});

test('memory recall and completed-turn capture keep the human goal while excluding visible progress instructions', async () => {
  const f = stepProgressServices(), controller = new OperationController();
  const handlers = new Map<string, (...args: any[]) => any>(), recalls: any[] = [], extraction: any[] = [];
  const captured = deferred<any>(), user = human(), progress = notice();
  const assistant = { id: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Verified result.' }] };
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: user },
    { seq: 2, type: 'user/message', data: progress },
    { seq: 3, type: 'assistant/message', data: { message: assistant } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const session = { id: 's', header: { cwd: process.cwd() }, firstLiveSeq: 0,
    deriveMessages: () => [user, progress, assistant] };
  const ctx = {
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); return () => handlers.delete(name); },
    get: () => ({ async readSession() { return { events }; } }),
    logger: { warn(_message: string, code: string) { assert.fail(`Unexpected memory failure: ${code}`); } },
  };
  await f.store.put('memory-settings', 'global', { autoInject: true, captureEnabled: true }, 0);
  f.services.invoke = async (_domain, request) => {
    if (request.action === 'recall') { recalls.push(request.params); return { items: [] }; }
    if (request.action === 'capture') { captured.resolve(request.params); return {}; }
    return {};
  };
  f.services.host = { async model(request: any) { extraction.push(request); return { text: 'Bounded verified summary.' }; } } as any;
  registerMemoryHooks(ctx as any, f.services, controller);
  try {
    const decision = { kind: 'enter', messages: [user, progress] };
    let nextCalls = 0;
    assert.equal(await handlers.get('agent/pre-step')!({
      agent: { id: 's', session }, messages: [user, progress], turn: 1, signal: f.stop.signal,
    }, async () => { nextCalls++; return decision; }), decision);
    assert.equal(recalls.length, 1);
    assert.equal(recalls[0].query, 'Keep the original user goal.');
    await handlers.get('agent/pre-step')!({
      agent: { id: 's', session }, messages: [progress], turn: 1, signal: f.stop.signal,
    }, async () => { nextCalls++; return decision; });
    assert.equal(recalls.length, 1, 'a progress notice alone cannot initiate task recall');
    assert.equal(nextCalls, 2);
    handlers.get('session/event')!(session, events.at(-1));
    const capture = await captured.promise;
    assert.equal(capture.summary, 'Bounded verified summary.');
    assert.equal(extraction.length, 1);
    assert.match(extraction[0].prompt, /Keep the original user goal/);
    assert.match(extraction[0].prompt, /Verified result/);
    assert.doesNotMatch(extraction[0].prompt, /Synthetic periodic progress/);
  } finally { await controller.dispose(); }
});
