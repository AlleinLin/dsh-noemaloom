import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { registerCompanionConversation } from '../../src/client/Companion.js';
import type { ClientContext, Data } from '../../src/client/types.js';

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const ready: Data = { state: 'ready', enabled: true, suggestionsEnabled: true, callsToday: 1,
  noteId: 'note', note: { text: '工作正常', explanation: '已恢复' } };
let root: ReturnType<typeof createRoot> | undefined, dispose: (() => void) | undefined;
const metrics: Data = {};
void (async () => {
  let Entry: any, inputRenders = 0, hostGeneration = 1;
  let session = { sessionId: 'main', running: false, header: { origin: 'user' }, token: 0 };
  const listeners = new Set<() => void>(), generations = new Set<() => void>();
  const calls: Array<{ action: string; signal: AbortSignal; done(value: Data): void; fail(error: Error): void }> = [];
  const ctx = {
    connection: {
      generation: { getSnapshot: () => ({ id: hostGeneration }), subscribe(fn: () => void) { generations.add(fn); return () => { generations.delete(fn); }; } },
      rpc: { call(_channel: string, _endpoint: string, raw: any, signal: AbortSignal) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('signal is aborted without reason', 'AbortError')), { once: true });
          calls.push({ action: raw.payload.action, signal, done: value => resolve({ ok: true, value }), fail: reject });
        });
      } },
    },
    slots: { inject(_name: string, callback: () => any) { return callback(); }, register(_options: any, component: any) { Entry = component; return () => {}; } },
    effect() {},
  } as unknown as ClientContext;
  const useSession = (selector: (value: typeof session) => any) => React.useSyncExternalStore(
    React.useCallback((fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, []),
    () => selector(session));
  const useInput = () => { inputRenders++; return { phase: 'plain', draft: '', attachmentIds: [] }; };
  const update = (running: boolean) => flushSync(() => { session = { ...session, running, token: session.token + 1 }; for (const fn of listeners) fn(); });
  const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
  try {
    dispose = registerCompanionConversation(ctx);
    root = createRoot(document.getElementById('root')!);
    flushSync(() => root!.render(<Entry sessionId="main" useSession={useSession} useInput={useInput} inputActions={{}} />));
    await settle(); expect(calls.length === 1, 'Initial mount should make one read');
    const first = calls[0];
    update(true); await settle();
    expect(!first.signal.aborted, 'Native running changes must not cancel the auxiliary read or mutation lifetime');
    first.done(ready); await settle();
    for (const call of calls.slice(1)) if (call.action === 'get') call.done(ready);
    await settle();
    expect(document.querySelector('[data-nexus-note-learn]'), 'The initial auxiliary result should remain usable');
    expect(!document.querySelector('[role=alert]'), 'An internal lifecycle abort must not become a sticky error');
    const before = inputRenders;
    for (let i = 0; i < 200; i++) update(true);
    await settle();
    metrics.tokenUpdates = 200; metrics.auxiliaryRendersDuringTokens = inputRenders - before;
    expect(inputRenders === before, 'Unrelated streaming tokens must not rerender the input auxiliary component');
    const retry = document.querySelector<HTMLButtonElement>('[data-nexus-companion-retry]')!;
    flushSync(() => retry.click()); await settle();
    const mutation = calls.findLast(call => call.action === 'retry')!;
    expect(mutation, 'Retry should issue one explicit auxiliary command');
    update(false); await settle();
    expect(!mutation.signal.aborted, 'Running transitions must not abort an authorized action');
    mutation.done(ready); await settle();
    expect(!retry.disabled, 'The action must release its busy state');
    for (const call of calls) if (call.action === 'get') call.done(ready);
    document.dispatchEvent(new Event('visibilitychange')); await settle();
    const pending = calls.at(-1)!;
    hostGeneration++; for (const fn of generations) fn();
    await settle();
    expect(pending.signal.aborted, 'Reconnect must retire the previous generation');
    const fresh = calls.at(-1)!;
    expect(fresh !== pending && !fresh.signal.aborted, 'Reconnect must start a fresh read, without reusing the aborted promise');
    fresh.done(ready); await settle();
    expect(!document.querySelector('[role=alert]'), 'A successful read must clear an older connection failure');
    document.dispatchEvent(new Event('visibilitychange')); await settle();
    calls.at(-1)!.fail(new DOMException('The user aborted a request.', 'AbortError')); await settle();
    expect(document.querySelector('[role=alert]')?.textContent?.includes('未收到本地取消信号'), 'Real unattributed remote aborts must remain visible');
    document.dispatchEvent(new Event('visibilitychange')); await settle();
    calls.at(-1)!.done(ready); await settle();
    expect(!document.querySelector('[role=alert]'), 'Recovery must clear the displayed failure');
    flushSync(() => root!.unmount()); root = undefined; dispose(); dispose = undefined;
    expect(listeners.size === 0 && generations.size === 0, 'Unmount must release every external subscription');
    document.body.setAttribute('data-nexus-fixture', btoa(JSON.stringify({ ok: true, metrics })));
  } catch (error) {
    document.body.setAttribute('data-nexus-fixture', btoa(JSON.stringify({ ok: false,
      error: error instanceof Error ? error.stack : String(error), metrics })));
  } finally { root?.unmount(); dispose?.(); }
})();
