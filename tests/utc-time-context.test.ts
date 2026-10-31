import assert from 'node:assert/strict';
import test from 'node:test';
import { formatUtcModelContext, registerUtcTimeContext, UTC_TIME_CONTEXT_NAME } from '../src/host/utc-time-context.js';
import type { HostContext } from '../src/host/types.js';

function fixture() {
  const listeners = new Map<string, Function>();
  const ctx = {
    on(name: string, callback: Function) {
      listeners.set(name, callback);
      return () => listeners.delete(name);
    },
  } as unknown as HostContext;
  return { ctx, listeners };
}

test('UTC model context is deterministic and never discloses a local zone', () => {
  const text = formatUtcModelContext(new Date('2026-11-01T02:05:44.705Z'));
  assert.match(text, /UTC\/GMT/);
  assert.match(text, /2026-11-01T02:05:44\.705Z/);
  assert.doesNotMatch(text, /Asia\/Shanghai|\+08:00|北京时间|宿主|浏览器/);
  assert.match(text, /scheduler requires a time zone, submit UTC/);
});

test('assembly replaces time-bearing sections, contexts, and variables', async () => {
  const { ctx, listeners } = fixture();
  const dispose = registerUtcTimeContext(ctx);
  const listener = listeners.get('system-prompt/assemble');
  assert.ok(listener);
  const base = {
    sections: [
      { name: 'host-timezone', text: 'Host timezone: Asia/Shanghai' },
      { name: 'keep-policy', text: 'Keep this policy.' },
      { name: 'currentDate', text: 'Current date: 2026-11-01' },
    ],
    contexts: [
      { name: 'clientTimeZone', text: 'clientTimeZone=Asia/Shanghai' },
      { name: 'keep-context', text: 'Keep this context.' },
    ],
    tools: [],
    variables: { hostTimeZone: 'Asia/Shanghai', model: 'test-model' },
  };
  const assembly = await listener!(
    base,
    {},
    async () => base,
  );
  assert.deepEqual(assembly.sections.map((entry: any) => entry.name), ['keep-policy']);
  assert.deepEqual(assembly.contexts.map((entry: any) => entry.name), ['keep-context', UTC_TIME_CONTEXT_NAME]);
  assert.deepEqual(assembly.variables, { model: 'test-model' });
  assert.match(assembly.contexts.at(-1).text, /UTC\/GMT/);
  dispose();
});

test('disabled UTC context leaves assembly untouched and does not register a listener', async () => {
  const { ctx, listeners } = fixture();
  const dispose = registerUtcTimeContext(ctx, false);
  assert.equal(listeners.has('system-prompt/assemble'), false);
  dispose();
});
