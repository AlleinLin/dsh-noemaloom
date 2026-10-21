import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { THOROUGH_PROMPT } from '../src/domain/insights/prompts.js';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/client/Companion.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', loader: { '.css': 'text' }, logLevel: 'silent' });
const fixture = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0]!.text)(createRequire(import.meta.url), fixture, fixture.exports);
const { quoteCompanion, sendThoroughPrompt } = fixture.exports as typeof import('../src/client/Companion.js');

function inputFixture() {
  let draft = '', revision = 0, submits = 0, persisted = 0;
  const actions = {
    captureInsertion() { return { draftRev: revision }; },
    insertText(text: string, span: any) { if (span.draftRev !== revision) return false; draft += text; revision++; return true; },
    persistDraft() { persisted++; }, submit() { submits++; },
    setDraft() { throw new Error('whole draft replacement must not be used'); },
  };
  return { actions, state: () => ({ draft, draftRev: revision, phase: 'plain', attachmentIds: [] }), type(text: string) { draft = text; revision++; },
    result: () => ({ draft, submits, persisted }) };
}
test('Learn more needs no RPC and quoting edits only the revision-guarded draft, never submits', () => {
  const f = inputFixture(); f.type('existing text');
  assert.equal(quoteCompanion(f.actions, f.state(), { text: 'fact', explanation: 'why' }), true);
  assert.match(f.result().draft, /existing text/); assert.match(f.result().draft, /You should know/);
  assert.equal(f.result().submits, 0); assert.equal(f.result().persisted, 1);
});
test('four questions use the captured native revision once and refuse intervening text, attachments or submission', () => {
  const f = inputFixture(), span = f.actions.captureInsertion(), latch = { current: false }, stale = f.state();
  f.type('user typed during authorization');
  assert.equal(sendThoroughPrompt(f.actions, stale, THOROUGH_PROMPT, latch, span), false);
  assert.equal(f.result().draft, 'user typed during authorization'); assert.equal(f.result().submits, 0);
  f.type(''); const fresh = f.actions.captureInsertion();
  assert.equal(sendThoroughPrompt(f.actions, { ...f.state(), attachmentIds: ['attachment'] }, THOROUGH_PROMPT, latch, fresh), false);
  assert.equal(sendThoroughPrompt(f.actions, f.state(), THOROUGH_PROMPT, latch, fresh), true);
  assert.equal(sendThoroughPrompt(f.actions, f.state(), THOROUGH_PROMPT, latch, fresh), false);
  assert.equal(f.result().submits, 1); assert.equal(f.result().draft, THOROUGH_PROMPT);
});
