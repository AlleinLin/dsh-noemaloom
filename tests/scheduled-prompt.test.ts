import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createScheduledPromptDelivery } from '../src/host/scheduled-prompt.js';
import { stepProgressServices, deferred } from './step-progress-fixture.js';

function fixture() {
  const f = stepProgressServices(), live = new Map<string, any>(), headers = new Map<string, any>();
  const logs = new Map<string, any[]>(), resumed: string[] = [], deliveries: any[] = [];
  let mode = 'continuable', uncertain = false, beforeSend: (() => Promise<void>) | undefined;
  const header = (id: string) => headers.get(id) ?? { id, origin: 'user' };
  const append = (id: string, message: any) => {
    const events = logs.get(id) ?? [];
    events.push({ seq: events.length, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] } });
    logs.set(id, events); deliveries.push({ id, message });
  };
  const parent = { id: 'parent', session: { header: header('parent') }, followup(m: any) { append('parent', m); } };
  live.set('parent', parent);
  headers.set('child', { id: 'child', origin: 'subagent', parentSession: 'parent' });
  const ctx: any = { get(name: string) {
    if (name === 'sessionPersistence') return { stat: async (id: string) => ({ header: header(id) }) };
    if (name === 'subagents') return {
      listChildren: async () => [{ id: 'child', mode }],
      async [deliverSubagentPrompt](owner: any, id: string, content: any, source: any, _signal: AbortSignal, delivery: string) {
        assert.equal(owner, parent); assert.equal(delivery, 'queue');
        await beforeSend?.();
        const message = createUserMessage({ content, source });
        append(id, message);
        if (uncertain) throw new Error('accepted but response lost');
        return message.id;
      },
    };
  } };
  const bridge = () => createScheduledPromptDelivery(ctx, f.stop.signal, () => f.services, id => live.get(id),
    async id => { resumed.push(id); assert.equal(id, 'parent', 'cold native child must never use root resume'); live.set(id, parent); return parent as any; },
    async id => ({ session: header(id), inheritedEventCount: 0, events: structuredClone(logs.get(id) ?? []) }),
    async () => ({ flushed: true }));
  return { ...f, bridge, live, headers, logs, resumed, deliveries,
    mode(value: string) { mode = value; }, uncertain() { uncertain = true; },
    beforeSend(fn: () => Promise<void>) { beforeSend = fn; } };
}
const params = { sessionId: 'child', requestId: 'plan-1', text: 'scheduled fixed text' };

test('released native child routes through its exact parent, wakes, and deduplicates after plugin restart', async () => {
  const f = fixture(), bridge = f.bridge();
  assert.equal(f.live.has('child'), false);
  const first = await bridge.dispatch(params);
  assert.equal(first.accepted, true); assert.equal(first.durable, true); assert.equal(first.wakesAgent, true);
  assert.equal(f.deliveries[0].id, 'child'); assert.equal(f.resumed.length, 0);
  const second = await f.bridge().dispatch(params);
  assert.equal(second.messageId, first.messageId);
  assert.equal(f.deliveries.length, 1);
  await assert.rejects(bridge.dispatch({ ...params, text: 'different text' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('cold ordinary parent can be loaded without converting the native child into a root', async () => {
  const f = fixture(); f.live.delete('parent');
  assert.equal((await f.bridge().dispatch(params)).accepted, true);
  assert.deepEqual(f.resumed, ['parent']);
  assert.equal(f.deliveries[0].id, 'child');
});

test('cold nested parent waits visibly and rejects one-shot continuations without sending', async () => {
  const f = fixture(); f.live.delete('parent');
  f.headers.set('parent', { id: 'parent', origin: 'subagent', parentSession: 'grandparent' });
  const receipt = await f.bridge().dispatch(params);
  assert.equal(receipt.state, 'waiting'); assert.equal(f.deliveries.length, 0); assert.equal(f.resumed.length, 0);
  f.mode('one-shot');
  await assert.rejects(f.bridge().dispatch(params), { code: 'NOT_RESUMABLE' });
  assert.equal(f.deliveries.length, 0);
});

test('lost child acceptance reply is reconciled by the original native source marker and never resent', async () => {
  const f = fixture(); f.uncertain();
  const first = await f.bridge().dispatch(params);
  assert.equal(first.accepted, true);
  assert.equal((await f.bridge().dispatch(params)).messageId, first.messageId);
  assert.equal(f.deliveries.length, 1);
});

test('crash at dispatch boundary remains unknown when no native acceptance can be proved', async () => {
  const f = fixture();
  await f.bridge().dispatch(params);
  f.logs.clear();
  const receipt = await f.bridge().dispatch(params);
  assert.equal(receipt.state, 'unknown'); assert.equal(receipt.accepted, false);
  assert.equal(f.deliveries.length, 1);
});

test('concurrent due timers and retries issue a single native child prompt', async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  f.beforeSend(async () => { entered.resolve(); await gate.promise; });
  const bridge = f.bridge(), first = bridge.dispatch(params);
  await entered.promise;
  const second = bridge.dispatch(params); gate.resolve();
  assert.equal((await first).accepted, true); assert.equal((await second).accepted, true);
  assert.equal(f.deliveries.length, 1);
});

test('ordinary idle main session receives a waking followup', async () => {
  const f = fixture();
  assert.equal((await f.bridge().dispatch({ ...params, sessionId: 'parent' })).accepted, true);
  assert.equal(f.deliveries[0].id, 'parent');
});
