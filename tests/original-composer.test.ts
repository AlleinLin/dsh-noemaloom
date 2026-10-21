import assert from 'node:assert/strict';
import test from 'node:test';
import { openOriginalComposer } from '../src/client/original-navigation.js';

function fixture(status = 'applied') {
  const calls: unknown[][] = [];
  const binding = { ctx: { sessionId: 'session-a' } };
  const reference = { binding, ready: Promise.resolve(), release() { calls.push(['release']); } };
  const ctx: any = {
    get(name: string) {
      if (name === 'sessions') return {
        retain(id: string, options: unknown) { calls.push(['retain', id, options]); return reference; },
      };
      if (name === 'conversation') return {
        input: {
          requestDraftInitialization(target: unknown, options: unknown) {
            calls.push(['draft', target, options]);
            return status;
          },
          for(target: unknown) {
            assert.equal(target, binding.ctx);
            return { focus() { calls.push(['focus']); } };
          },
        },
      };
      throw new Error(`Unexpected capability: ${name}`);
    },
    uiWorkspace: { openSession(id: string) { calls.push(['open', id]); } },
    layout: { selectPanel(id: unknown) { calls.push(['panel', id]); } },
  };
  return { ctx, calls, reference, binding };
}

test('graph continuation uses the native draft transaction and focus without submitting', async () => {
  const f = fixture();
  const result = await openOriginalComposer(f.ctx, 'session-a', 'selected passage');
  assert.equal(result.draftStatus, 'applied');
  assert.deepEqual(f.calls.find(row => row[0] === 'draft'),
    ['draft', f.binding, { prompt: 'selected passage', clearPreviousDraft: false }]);
  assert.deepEqual(f.calls.filter(row => row[0] !== 'retain' && row[0] !== 'draft'),
    [['open', 'session-a'], ['panel', null], ['focus'], ['release']]);
});

test('existing native drafts and blocked input transactions remain intact', async () => {
  for (const status of ['preserved', 'blocked']) {
    const f = fixture(status);
    assert.deepEqual(await openOriginalComposer(f.ctx, 'session-a', 'graph selection'), { draftStatus: status });
    assert.equal(f.calls.filter(row => row[0] === 'draft').length, 1);
    assert.equal(f.calls.filter(row => row[0] === 'release').length, 1);
    assert.equal((f.calls.find(row => row[0] === 'draft')?.[2] as any).clearPreviousDraft, false);
  }
});

test('opening a graph branch without text keeps the native draft untouched', async () => {
  const f = fixture();
  assert.deepEqual(await openOriginalComposer(f.ctx, 'session-a'), { draftStatus: 'unchanged' });
  assert.equal(f.calls.some(row => row[0] === 'draft'), false);
  assert.equal(f.calls.filter(row => row[0] === 'focus').length, 1);
});

test('a failed native binding releases its retained session and never initializes input', async () => {
  const f = fixture();
  f.reference.ready = Promise.reject(new Error('binding unavailable'));
  await assert.rejects(openOriginalComposer(f.ctx, 'session-a', 'text'), /binding unavailable/);
  assert.deepEqual(f.calls.map(row => row[0]), ['retain', 'release']);
});
