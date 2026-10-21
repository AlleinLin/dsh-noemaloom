import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { apply, loadBaselineInstructions } from '../vendor/agent-instructions/index.mjs';

const candidates = ['DEEPSEEK.md', 'AGENT.md', 'AGENTS.md', 'CLAUDE.md'];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-project-rules-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  await mkdir(join(cwd, '.git'));
  const reads = [], probes = [];
  const inside = path => {
    const rel = relative(root, resolve(path));
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !/^[A-Za-z]:/u.test(rel);
  };
  const fs = {
    async resolve(path) { return resolve(path); },
    async stat(path) {
      probes.push(path);
      // The consumer harness must never inspect the user's real global rules.
      if (!inside(path)) return undefined;
      try {
        const info = await stat(path);
        return { type: info.isFile() ? 'file' : 'directory', size: info.size, version: String(info.mtimeMs) };
      } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    },
    async *streamText(path) {
      assert(inside(path));
      reads.push(path); yield await readFile(path, 'utf8');
    },
  };
  const options = { cwd, dshHome: join(root, 'home'), agentsHome: join(root, 'agents'), maxBytes: 65536 };
  return { cwd, root, reads, probes, fs, options };
}

test('rule reader falls back in exact order and never probes or reads later project candidates after a hit', async t => {
  const f = await fixture(t);
  for (const name of [...candidates, 'CLAUDE.local.md']) await writeFile(join(f.cwd, name), `RULE:${name}`);
  for (let index = 0; index < candidates.length; index++) {
    f.reads.length = 0; f.probes.length = 0;
    const rendered = await loadBaselineInstructions(f.options, f.fs);
    assert(rendered.text.includes(`RULE:${candidates[index]}`));
    assert.deepEqual(f.reads.map(path => basename(path)), [candidates[index]]);
    const projectProbes = f.probes.filter(path => candidates.some(name => path === join(f.cwd, name)));
    assert.deepEqual(projectProbes.map(path => basename(path)), candidates.slice(0, index + 1));
    await unlink(join(f.cwd, candidates[index]));
  }
  f.reads.length = 0;
  assert.equal(await loadBaselineInstructions(f.options, f.fs), undefined);
  assert.deepEqual(f.reads, []);
});

test('each nested directory selects its own first match and an empty higher file still wins', async t => {
  const f = await fixture(t);
  const nested = join(f.cwd, 'nested');
  await mkdir(nested);
  await writeFile(join(f.cwd, 'AGENTS.md'), 'ROOT-SELECTED');
  await writeFile(join(f.cwd, 'CLAUDE.md'), 'ROOT-HIDDEN');
  await writeFile(join(nested, 'DEEPSEEK.md'), '');
  await writeFile(join(nested, 'AGENT.md'), 'NESTED-HIDDEN');
  const rendered = await loadBaselineInstructions({ ...f.options, cwd: nested }, f.fs);
  assert(rendered.text.includes('ROOT-SELECTED'));
  assert(!rendered.text.includes('HIDDEN'));
  assert.deepEqual(f.reads, [join(f.cwd, 'AGENTS.md'), join(nested, 'DEEPSEEK.md')]);
  await unlink(join(nested, 'DEEPSEEK.md'));
  f.reads.length = 0;
  const refreshed = await loadBaselineInstructions({ ...f.options, cwd: nested }, f.fs);
  assert(refreshed.text.includes('NESTED-HIDDEN'));
  assert.deepEqual(f.reads, [join(f.cwd, 'AGENTS.md'), join(nested, 'AGENT.md')]);
});

test('an unavailable higher candidate prevents probing or reading fallback rules', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'AGENT.md'), 'MUST-NOT-LOAD');
  const provider = {
    ...f.fs,
    async stat(path) {
      if (path === join(f.cwd, 'DEEPSEEK.md')) {
        f.probes.push(path);
        throw Object.assign(new Error('synthetic denied metadata'), { code: 'EACCES' });
      }
      return f.fs.stat(path);
    },
  };
  assert.equal(await loadBaselineInstructions(f.options, provider), undefined);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.probes.filter(path => candidates.some(name => path === join(f.cwd, name))), [join(f.cwd, 'DEEPSEEK.md')]);
});

test('the pre-step consumer replaces a loaded fallback when a higher rule appears and falls back after deletion', async t => {
  const f = await fixture(t);
  const handlers = new Map(), disposers = [];
  const events = [];
  const agent = {
    session: { surface: { nodes: [] }, eventAt: seq => events[seq] },
    inbox: {
      nextStep: [],
      remove(id) { this.nextStep = this.nextStep.filter(message => message.id !== id); },
      prepend(_queue, message) { this.nextStep.unshift(message); },
      replace(id, message) { this.nextStep.splice(this.nextStep.findIndex(item => item.id === id), 1, message); },
    },
  };
  const ctx = {
    get: name => name === 'fs' ? f.fs : undefined,
    workingDirectory: { ensure: async () => f.cwd },
    effect: setup => disposers.push(setup()),
    on: (name, handler) => handlers.set(name, handler),
  };
  apply(ctx, { maxBytes: 65536 });
  t.after(() => { for (const dispose of disposers) dispose(); });
  const consume = async () => {
    f.reads.length = 0; f.probes.length = 0;
    const decision = await handlers.get('agent/pre-step')(
      { agent, messages: [], step: 2, signal: new AbortController().signal },
      async () => ({ kind: 'continue', messages: [] }),
    );
    for (const message of decision.messages) {
      agent.session.surface.nodes.push(events.length);
      events.push({ type: 'user/message', data: message });
    }
    return decision.messages;
  };
  await writeFile(join(f.cwd, 'AGENT.md'), 'FALLBACK');
  await writeFile(join(f.cwd, 'AGENTS.md'), 'HIDDEN');
  let messages = await consume();
  assert.deepEqual(messages.flatMap(message => message.source.changes).map(change => [change.action, change.path]), [['set', 'AGENT.md']]);
  assert.deepEqual(f.reads, [join(f.cwd, 'AGENT.md')]);
  await writeFile(join(f.cwd, 'DEEPSEEK.md'), 'PREFERRED');
  messages = await consume();
  assert.deepEqual(messages.flatMap(message => message.source.changes).map(change => [change.action, change.path]),
    [['set', 'DEEPSEEK.md'], ['remove', 'AGENT.md']]);
  assert.deepEqual(f.reads, [join(f.cwd, 'DEEPSEEK.md')]);
  assert(!f.probes.includes(join(f.cwd, 'AGENT.md')));
  assert(!f.probes.includes(join(f.cwd, 'AGENTS.md')));
  assert.deepEqual(await consume(), []);
  assert.deepEqual(f.reads, []);
  await unlink(join(f.cwd, 'DEEPSEEK.md'));
  messages = await consume();
  assert.deepEqual(messages.flatMap(message => message.source.changes).map(change => [change.action, change.path]),
    [['remove', 'DEEPSEEK.md'], ['set', 'AGENT.md']]);
  assert.deepEqual(f.reads, [join(f.cwd, 'AGENT.md')]);
  assert(!f.probes.includes(join(f.cwd, 'AGENTS.md')));
});
