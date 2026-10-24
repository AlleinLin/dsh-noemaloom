import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import { InputSlotSeat } from '../../vendor/codinput/src/client/components/InputSlotSeat';
import { stash } from '../../vendor/codinput/src/client/services';
// Test module contains the exact adapted published factory.
// @ts-expect-error Virtual module is supplied by the test bundler.
import { original } from 'nexus:test-computer-client';

const core = new SlotCore();
core.register({ name: 'root', children: {
  'conversation.input.left': { kind: 'list', scope: 'session' },
  'conversation.input.right': { kind: 'list', scope: 'session' },
} }, () => null);
stash.slots = core as any;
const requests: any[] = [], toggles = new Map<string, boolean>(), disposers: (() => void)[] = [];
window.fetch = (async (input: string, init?: RequestInit) => {
  const url = new URL(input, 'https://fixture.invalid');
  const payload = init?.body ? JSON.parse(String(init.body)) : null;
  const sessionId = payload?.sessionId ?? url.searchParams.get('sessionId');
  requests.push({ path: url.pathname, sessionId, method: init?.method ?? 'GET', payload });
  if (payload) toggles.set(sessionId, payload.enabled);
  return new Response(JSON.stringify({ enabled: toggles.get(sessionId) ?? false, supported: true,
    control: { state: toggles.get(sessionId) ? 'ready' : 'off' } }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;
original.apply({
  slots: { inject(_name: string, factory: () => () => void) { disposers.push(factory()); },
    register: core.register.bind(core) },
  effect(factory: () => () => void) { const dispose = factory(); if (dispose) disposers.push(dispose); },
});
const injectCalls: string[] = [];
function Witness(props: any) {
  const value = props.useEvidence((snapshot: string) => snapshot);
  return <button data-witness={props.label} onClick={() => props.inputActions.send(props.sessionId)}>
    {`${props.label}:${props.sessionId}:${value}`}
  </button>;
}
const addWitness = (label: string, order: number, priority = 0) => core.register({
  name: 'conversation.input.right', id: 'evidence', order, priority,
  inject(sessionId: string) { injectCalls.push(sessionId); return { label,
    hooks: { evidence: { getSnapshot: () => `context-${sessionId}`, subscribe: () => () => {} } } }; },
}, Witness);
const removeBase = addWitness('base', 10);
let removePreferred: (() => void) | undefined = addWitness('preferred', 10, -1);
const removeFirst = core.register({ name: 'conversation.input.right', id: 'first', order: -5 },
  (props: any) => <span data-first={props.sessionId}>first</span>);
const actions: string[] = [];
const standard = { inputActions: { send(sessionId: string) { actions.push(sessionId); } } };
const root = createRoot(document.getElementById('root')!);
let ids = ['main', 'child'];
const draw = () => flushSync(() => root.render(<>{ids.map(sessionId =>
  <section data-session={sessionId} key={sessionId}>
    <InputSlotSeat slot="conversation.input.left" sessionId={sessionId} standard={standard} />
    <InputSlotSeat slot="conversation.input.right" sessionId={sessionId} standard={standard} />
  </section>)}</>));
draw();
(window as any).__seats = {
  snapshot: () => ({ requests, actions, injectCalls }),
  removePreferred() { removePreferred?.(); removePreferred = undefined; },
  switchChild() { ids = ['main', 'replacement']; draw(); },
  dispose() {
    flushSync(() => root.unmount());
    disposers.reverse().forEach(dispose => dispose());
    removeBase(); removePreferred?.(); removeFirst();
  },
};
