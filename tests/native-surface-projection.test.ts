import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionSeq, type SessionEvent, type SurfaceOp } from '@deepseek-ai/dsh-session';
import { nativeSurfaceProjection } from '../src/host/compaction.js';

type MessageFixture = {
  id: string;
  role: 'system' | 'developer' | 'assistant' | 'user';
  source: Record<string, unknown>;
  content: Record<string, unknown>[];
};

function message(
  role: MessageFixture['role'],
  id: string,
  content: MessageFixture['content'] = [],
): MessageFixture {
  return {
    id, role, content,
    source: role === 'system' ? { kind: 'system-prompt' }
      : role === 'assistant' ? {
        kind: 'model', provider: 'projection-provider', model: 'projection-model',
        replayState: { response: { id: `${id}-response`, parts: ['原文', '', 0, null] } },
      } : { kind: 'user' },
  };
}

function surfaceEvent(
  seq: number,
  original: MessageFixture,
  surfaceOp: SurfaceOp = 'append',
  sourceSeqs: readonly number[] = [],
): SessionEvent {
  return {
    type: `${original.role}/message`, seq: SessionSeq(seq), time: 1700000000000 + seq, surfaceOp,
    ...(sourceSeqs.length ? { sourceEventSeqs: sourceSeqs.map(SessionSeq) } : {}),
    data: original.role === 'user' ? original : {
      turn: 0, step: 0, message: original,
      ...(original.role === 'assistant' ? { stream: [] } : {}),
    },
  } as unknown as SessionEvent;
}

test('native surface projection retains detached exact empty messages omitted by derivation', () => {
  let state = nativeSurfaceProjection.init();
  for (const [index, role] of (['system', 'developer', 'assistant'] as const).entries()) {
    const original = message(role, `empty-${role}`);
    const expected = structuredClone(original);
    state = nativeSurfaceProjection.apply(state, surfaceEvent(index * 3 + 1, original));
    const retained = state.nodes.at(-1)!.emptyMessage!;

    assert.deepEqual(retained, expected);
    assert.notEqual(retained, original);
    assert.notEqual(retained.source, original.source);
    assert.notEqual(retained.content, original.content);

    original.source.kind = 'changed-after-publication';
    original.content.push({ type: 'text', text: 'changed-after-publication' });
    if (role === 'assistant') {
      const replay = original.source.replayState as { response: { parts: unknown[] } };
      replay.response.parts.push('changed-after-publication');
    }
    assert.deepEqual(retained, expected);
  }
  assert.deepEqual(state.nodes.map(node => [node.seq, node.messageId]), [
    [1, 'empty-system'], [4, 'empty-developer'], [7, 'empty-assistant'],
  ]);
});

test('native surface projection keeps only identity and position for nonempty or whitespace content', () => {
  const originals = [
    message('system', 'nonempty-system', [{ type: 'text', text: 'system instructions' }]),
    message('developer', 'whitespace-developer', [{ type: 'text', text: ' \t\r\n ' }]),
    message('assistant', 'whitespace-assistant', [{ type: 'text', text: '\n\t ' }]),
    message('user', 'empty-user'),
  ];
  const state = originals.reduce(
    (current, original, index) => nativeSurfaceProjection.apply(current, surfaceEvent(index * 4 + 2, original)),
    nativeSurfaceProjection.init(),
  );

  assert.deepEqual(state.nodes, [
    { seq: 2, messageId: 'nonempty-system' },
    { seq: 6, messageId: 'whitespace-developer' },
    { seq: 10, messageId: 'whitespace-assistant' },
    { seq: 14, messageId: 'empty-user' },
  ]);
});

test('native surface replacements discard shadowed empty payloads using current ordered endpoints', () => {
  const emptyHead = message('system', 'empty-head');
  const ordinary = message('user', 'ordinary', [{ type: 'text', text: 'original user text' }]);
  const emptyMiddle = message('assistant', 'empty-middle');
  const emptyTail = message('developer', 'empty-tail');
  let state = nativeSurfaceProjection.init();
  for (const [index, original] of [emptyHead, ordinary, emptyMiddle, emptyTail].entries()) {
    state = nativeSurfaceProjection.apply(state, surfaceEvent((index + 1) * 10, original));
  }
  const initial = structuredClone(state);
  const appended = message('user', 'appended', [{ type: 'text', text: 'later user text' }]);
  const afterAppend = nativeSurfaceProjection.apply(state, surfaceEvent(50, appended));
  assert.deepEqual(state, initial);
  assert.deepEqual(afterAppend.nodes.slice(0, -1), initial.nodes);

  const replacement = message('developer', 'empty-replacement');
  const afterReplacement = nativeSurfaceProjection.apply(afterAppend, surfaceEvent(60, replacement, {
    op: 'replace', startSeq: SessionSeq(20), endSeq: SessionSeq(30),
  }, [20, 30]));
  assert.deepEqual(afterAppend.nodes.map(node => node.seq), [10, 20, 30, 40, 50]);
  assert.deepEqual(afterReplacement.nodes, [
    { seq: 10, messageId: emptyHead.id, emptyMessage: emptyHead },
    { seq: 60, messageId: replacement.id, emptyMessage: replacement },
    { seq: 40, messageId: emptyTail.id, emptyMessage: emptyTail },
    { seq: 50, messageId: appended.id },
  ]);
  const beforeSecondReplacement = structuredClone(afterReplacement);

  // Seq 60 lies between the current endpoints even though it exceeds endSeq.
  const whitespace = message('user', 'whitespace-replacement', [{ type: 'text', text: ' \r\n\t ' }]);
  const cleared = nativeSurfaceProjection.apply(afterReplacement, surfaceEvent(70, whitespace, {
    op: 'replace', startSeq: SessionSeq(10), endSeq: SessionSeq(40),
  }, [10, 60, 40]));
  assert.deepEqual(afterReplacement, beforeSecondReplacement);
  assert.deepEqual(cleared.nodes, [
    { seq: 70, messageId: whitespace.id },
    { seq: 50, messageId: appended.id },
  ]);

  const currentEmpty = message('developer', 'current-empty');
  const final = nativeSurfaceProjection.apply(cleared, surfaceEvent(80, currentEmpty));
  assert.deepEqual(cleared.nodes.map(node => node.seq), [70, 50]);
  assert.deepEqual(final.nodes, [
    { seq: 70, messageId: whitespace.id },
    { seq: 50, messageId: appended.id },
    { seq: 80, messageId: currentEmpty.id, emptyMessage: currentEmpty },
  ]);
  assert.equal(final.lastSurfaceSeq, 80);
});
