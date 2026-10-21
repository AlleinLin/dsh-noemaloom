import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createQualityModule, createReviewModule, createArtifactModule } from '../../src/domain/quality/index.js';
import { RULES, scanTypeScript } from '../../src/domain/quality/rules.js';
import { createScopeModule, withScopePolicy } from '../../src/domain/scope.js';
import { workspaceModules } from '../../src/domain/workspace-runtime.js';
import { customRuleApplies, scanCustomRules, validateCustomRule } from '../../src/domain/quality/custom-rules.js';
import { SVG_TYPES, renderSvg, validateSvg } from '../../src/domain/artifacts/diagrams.js';
import { NexusError, type NexusServices, type StoredRecord, type NexusStore, type NexusModule } from '../../src/ports/contracts.js';

class MemoryStore implements NexusStore {
  private data = new Map<string, StoredRecord>();
  async get<T>(collection: string, id: string): Promise<StoredRecord<T> | undefined> { return structuredClone(this.data.get(`${collection}/${id}`)) as StoredRecord<T> | undefined; }
  async put<T>(collection: string, id: string, value: T, expectedRevision?: number): Promise<StoredRecord<T>> {
    const previous = this.data.get(`${collection}/${id}`);
    if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) throw new NexusError('REVISION_CONFLICT', 'CAS');
    const record = { id, revision: (previous?.revision ?? 0) + 1, value: structuredClone(value), updatedAt: new Date().toISOString() };
    this.data.set(`${collection}/${id}`, record); return structuredClone(record);
  }
  async list<T>(collection: string): Promise<StoredRecord<T>[]> { return [...this.data.entries()].filter(([key]) => key.startsWith(`${collection}/`)).map(([, value]) => structuredClone(value) as StoredRecord<T>); }
  async remove(collection: string, id: string): Promise<boolean> { return this.data.delete(`${collection}/${id}`); }
}

async function fixture(): Promise<{ root: string; services: NexusServices; modules: Map<string, NexusModule>; cleanup(): Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-quality-fixture-'));
  const store = new MemoryStore(); const modules = new Map<string, NexusModule>();
  const services: NexusServices = {
    store, workspaceRoot: root, dataDir: path.join(root, '.private-data'), packageRoot: path.resolve(import.meta.dirname, '../..'), emit() {},
    executor: { async run(command, args, options) {
      const started = Date.now();
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: options?.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = ''; let cancelled = false;
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        if (options?.stdin) child.stdin.end(options.stdin); else child.stdin.end();
        const abort = () => { cancelled = true; child.kill(); };
        options?.signal?.addEventListener('abort', abort, { once: true });
        child.once('error', reject); child.once('close', exitCode => { options?.signal?.removeEventListener('abort', abort); resolve({ exitCode, stdout, stderr, cancelled, durationMs: Date.now() - started }); });
      });
    } },
    host: { async facts() { return {}; }, async approve() { return true; }, async secret() { return undefined; }, async sessions() { throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', 'fixture'); }, async spawn() { throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', 'fixture'); }, async model(request) {
      if (request.role === 'independent-verifier') return { text: '{"verdict":"supported","reason":"fixture evidence"}' };
      return { text: '{"findings":[],"completedPaths":["example.ts"],"limitations":[]}', usage: { outputTokens: 10 } };
    } },
    async invoke(domain, request, context) { const module = modules.get(domain); if (!module) throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', domain); return module.dispatch(request, context); },
  };
  modules.set('scope', createScopeModule(services)); modules.set('quality', createQualityModule(services)); modules.set('review', createReviewModule(services)); modules.set('artifact', createArtifactModule(services));
  return { root, services, modules, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('quality discovery never evaluates project JS config and reports package-manager conflicts', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'package.json'), '{"packageManager":"pnpm@10","scripts":{"test":"echo real"}}');
    await fs.writeFile(path.join(f.root, 'package-lock.json'), '{}');
    await fs.writeFile(path.join(f.root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    await fs.writeFile(path.join(f.root, 'eslint.config.js'), 'throw new Error("must not evaluate")');
    const row = await f.modules.get('quality')!.dispatch({ action: 'discover' }) as { value: { configs: Array<{ method: string }>; conflicts: Array<{ subject: string }> } };
    assert(row.value.configs.some(config => config.method === 'observed-not-evaluated'));
    assert(row.value.conflicts.some(conflict => conflict.subject === 'package-manager'));
  } finally { await f.cleanup(); }
});

const customRuleInput = (patch: Record<string, unknown> = {}) => ({
  summary: '禁止 TODO 标记', message: '完成此处遗留任务', severityDefault: 'warning', matchMode: 'contains',
  matchText: 'TODO', fileGlobs: ['src/**/*.ts'], caseSensitive: true, ...patch,
});

test('quality rule counts use a complete catalog even when the RPC envelope supplies its default 20 rows', async () => {
  const f = await fixture();
  try {
    const quality = f.modules.get('quality')!;
    const first: any = await quality.dispatch({ action: 'catalog', limit: 20 });
    assert.equal(first.items.length, 20); assert.equal(first.total, RULES.length); assert.equal(first.truncated, true);
    const requested: any = await quality.dispatch({ action: 'catalog', limit: 20, params: { limit: 100 } });
    assert.equal(requested.items.length, RULES.length);
    const complete: any = await quality.dispatch({ action: 'catalog', limit: 20, params: { complete: true } });
    assert.equal(complete.items.length, RULES.length); assert.equal(complete.total, RULES.length);
    assert.equal(complete.truncated, false); assert.equal(complete.cursor, null);
  } finally { await f.cleanup(); }
});

test('unexecuted type and semantic rules remain coverage limits instead of a false quality pass', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'example.ts'), 'export const value = 1;\n');
    const quality = f.modules.get('quality')!;
    const plan: any = await quality.dispatch({ action: 'plan', params: {
      mode: 'full', layers: ['syntax'], ruleIds: ['hlt.ts.no-debugger', 'hlt.ts.no-floating-promises', 'hlt.error.cause-loss'],
    } });
    assert(plan.unknown.some((message: string) => message.includes('hlt.ts.no-floating-promises')));
    assert(plan.unknown.some((message: string) => message.includes('hlt.error.cause-loss')));
    const run: any = await quality.dispatch({ action: 'run', params: { planId: plan.id, planHash: plan.planHash } });
    assert.equal(run.diagnostics.length, 0); assert.equal(run.status, 'partial'); assert.equal(run.verification, 'unknown');
    const gate: any = await quality.dispatch({ action: 'gate', params: { evidenceRefs: [run.id], policy: { requiredLayers: ['syntax'] } } });
    assert.equal(gate.decision, 'unknown');
    const supported: any = await quality.dispatch({ action: 'plan', params: { mode: 'full', layers: ['syntax'], ruleIds: ['hlt.ts.no-debugger'] } });
    const verified: any = await quality.dispatch({ action: 'run', params: { planId: supported.id, planHash: supported.planHash } });
    assert.equal(verified.verification, 'passed');
  } finally { await f.cleanup(); }
});

test('custom rule CRUD reaches the real scan, changes cache epochs and invalidates old plans', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'src'));
    const original = 'export const note = "TODO";\n// FIXME\n';
    await fs.writeFile(path.join(f.root, 'src/example.ts'), original);
    await fs.writeFile(path.join(f.root, 'outside.ts'), '// TODO\n');
    const quality = f.modules.get('quality')!;
    const created: any = await quality.dispatch({ action: 'rules/save', expectedRevision: 0, params: { rule: customRuleInput() } });
    const id = created.ruleId;
    assert.match(id, /^custom\./);
    const params = { mode: 'full', layers: ['syntax'], ruleIds: [id, id] };
    const first: any = await quality.dispatch({ action: 'plan', params });
    assert.deepEqual(first.ruleIds, [id]);
    assert.deepEqual(first.files.map((item: any) => item.path), ['src/example.ts']);
    const firstRun: any = await quality.dispatch({ action: 'run', params: { planId: first.id, planHash: first.planHash } });
    assert.equal(firstRun.diagnostics.length, 1); assert.equal(firstRun.diagnostics[0].ruleId, id);
    assert.equal(firstRun.diagnostics[0].severity, 'warning'); assert.equal(firstRun.diagnostics[0].message, '完成此处遗留任务');
    assert.equal(firstRun.diagnostics[0].range.startLine, 1);
    assert(firstRun.receipts.some((item: any) => item.tools?.includes('nexus-literal/v1')));
    assert.equal(await fs.readFile(path.join(f.root, 'src/example.ts'), 'utf8'), original);
    await quality.dispatch({ action: 'rules/save', expectedRevision: 1, params: {
      ruleId: id, rule: customRuleInput({ summary: '禁止 FIXME', matchText: 'FIXME', severityDefault: 'error' }),
    } });
    await assert.rejects(() => quality.dispatch({ action: 'run', params: { planId: first.id, planHash: first.planHash } }),
      (error: unknown) => (error as NexusError).code === 'SNAPSHOT_STALE');
    const second: any = await quality.dispatch({ action: 'plan', params });
    assert.notEqual(second.epoch, first.epoch);
    const secondRun: any = await quality.dispatch({ action: 'run', params: { planId: second.id, planHash: second.planHash } });
    assert.equal(secondRun.diagnostics.length, 1); assert.equal(secondRun.diagnostics[0].range.startLine, 2);
    assert.equal(secondRun.diagnostics[0].severity, 'error'); assert.equal(secondRun.verification, 'failed');
    const explanation: any = await quality.dispatch({ action: 'explain', params: { ruleIds: [id] } });
    assert.match(explanation.items[0].content, /FIXME/);
    await quality.dispatch({ action: 'rules/delete', expectedRevision: 2, params: { ruleId: id } });
    await assert.rejects(() => quality.dispatch({ action: 'plan', params }), (error: unknown) => (error as NexusError).code === 'INVALID_ARGUMENT');
    const catalog: any = await quality.dispatch({ action: 'catalog', params: { complete: true } });
    assert.equal(catalog.total, RULES.length); assert.equal(catalog.localRevision, 0);
  } finally { await f.cleanup(); }
});

test('missing-text rules run on empty UTF-8 documents and report a real file-level finding', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'docs'));
    await fs.writeFile(path.join(f.root, 'docs/empty.md'), '');
    await fs.writeFile(path.join(f.root, 'docs/complete.md'), 'COPYRIGHT fixture\n');
    const quality = f.modules.get('quality')!;
    const created: any = await quality.dispatch({ action: 'rules/save', expectedRevision: 0, params: {
      rule: customRuleInput({ matchMode: 'missing', matchText: 'copyright', fileGlobs: ['docs/**/*.md'], caseSensitive: false }),
    } });
    const plan: any = await quality.dispatch({ action: 'plan', params: { mode: 'full', ruleIds: [created.ruleId], layers: ['syntax'] } });
    assert.equal(plan.files.length, 2);
    const run: any = await quality.dispatch({ action: 'run', params: { planId: plan.id, planHash: plan.planHash } });
    assert.equal(run.diagnostics.length, 1); assert.equal(run.diagnostics[0].path, 'docs/empty.md');
    assert.deepEqual(run.diagnostics[0].range, { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, unit: 'utf16' });
    assert.equal(run.status, 'completed'); assert.equal(run.coverage.unknown.length, 0);
    const omitted: any = await quality.dispatch({ action: 'plan', params: { mode: 'full', ruleIds: [created.ruleId], layers: [] } });
    assert(omitted.unknown.some((message: string) => message.includes('未启用该层')));
  } finally { await f.cleanup(); }
});

test('custom matchers use literal text and bounded globs, reject empty conditions and preserve UTF-16 ranges', () => {
  const rule = validateCustomRule({ ruleId: 'custom.fixture', ...customRuleInput({ matchText: 'A+B[0]', caseSensitive: false }) });
  assert.equal(customRuleApplies(rule, 'src/file.ts'), true);
  assert.equal(customRuleApplies(rule, 'src/nested/file.ts'), true);
  assert.equal(customRuleApplies(rule, 'file.ts'), false);
  assert.equal(customRuleApplies(rule, 'src/file.tsx'), false);
  assert.equal(scanCustomRules('src/file.ts', 'AAB0', [rule]).diagnostics.length, 0);
  const result = scanCustomRules('src/file.ts', '😀 a+b[0]\nA+B[0]', [rule]);
  assert.equal(result.diagnostics.length, 2);
  assert.equal(result.diagnostics[0]!.range.startColumn, 4);
  assert.equal(result.diagnostics[1]!.range.startLine, 2);
  assert.notEqual(result.diagnostics[0]!.fingerprint, result.diagnostics[1]!.fingerprint);
  assert.equal(scanCustomRules('src/file.ts', '', [rule]).diagnostics.length, 0);
  const truncated = scanCustomRules('src/file.ts', 'A+B[0]'.repeat(1001), [rule]);
  assert.equal(truncated.diagnostics.length, 1000); assert.equal(truncated.unknown.length, 1);
  for (const patch of [{ matchText: '' }, { matchText: ' \n\t' }, { matchText: 'x'.repeat(2049) }, { fileGlobs: [] },
    { fileGlobs: ['../*.ts'] }, { fileGlobs: ['src/***.ts'] }, { fileGlobs: ['src/[ab].ts'] },
    { fileGlobs: ['C:/src/*.ts'] }, { matchMode: 'regex' }, { ruleId: 'hlt.ts.no-debugger' }]) {
    assert.throws(() => validateCustomRule({ ruleId: 'custom.fixture', ...customRuleInput(), ...patch }),
      (error: unknown) => (error as NexusError).code === 'INVALID_ARGUMENT');
  }
});

test('custom rule mutations enforce ownership, CAS and global-workspace-session inheritance in the real scoped runtime', async () => {
  const f = await fixture();
  try {
    const [scopedQuality] = await workspaceModules(f.services, [createQualityModule]);
    const quality = withScopePolicy(scopedQuality!, f.services);
    f.modules.set('quality', quality);
    const otherRoot = path.join(f.root, 'other'); await fs.mkdir(otherRoot);
    const global = { scopeLevel: 'global' as const, workspaceRoot: f.root };
    const workspace = { scopeLevel: 'workspace' as const, workspaceRoot: f.root };
    const other = { scopeLevel: 'workspace' as const, workspaceRoot: otherRoot };
    const first = { scopeLevel: 'session' as const, workspaceRoot: f.root, sessionId: 'first' };
    const second = { scopeLevel: 'session' as const, workspaceRoot: f.root, sessionId: 'second' };
    const save = (context: typeof global | typeof workspace | typeof first, revision: number, ruleId?: string, patch = {}) =>
      quality!.dispatch({ action: 'rules/save', expectedRevision: revision, params: { ...(ruleId ? { ruleId } : {}), rule: customRuleInput(patch) } }, context) as Promise<any>;
    const catalog = (context: typeof global | typeof workspace | typeof first) =>
      quality!.dispatch({ action: 'catalog', params: { complete: true } }, context) as Promise<any>;
    const inherited = await save(global, 0);
    const inWorkspace = (await catalog(workspace)).items.find((rule: any) => rule.ruleId === inherited.ruleId);
    assert.equal(inWorkspace.ownerScope, 'global'); assert.equal(inWorkspace.editable, false);
    await assert.rejects(() => save(workspace, 0, inherited.ruleId), (error: unknown) => (error as NexusError).code === 'PERMISSION_DENIED');
    await assert.rejects(() => quality!.dispatch({ action: 'rules/delete', expectedRevision: 0, params: { ruleId: inherited.ruleId } }, workspace),
      (error: unknown) => (error as NexusError).code === 'PERMISSION_DENIED');
    await assert.rejects(() => quality!.dispatch({ action: 'rules/delete', expectedRevision: 0, params: { ruleId: RULES[0]!.ruleId } }, global),
      (error: unknown) => (error as NexusError).code === 'REVISION_CONFLICT');
    await assert.rejects(() => save(global, 1, RULES[0]!.ruleId), (error: unknown) => (error as NexusError).code === 'PERMISSION_DENIED');
    await assert.rejects(() => save(global, 0), (error: unknown) => (error as NexusError).code === 'REVISION_CONFLICT');
    const local = await save(workspace, 0);
    const privateRule = await save(first, 0);
    assert.equal((await catalog(first)).total, RULES.length + 3);
    assert.equal((await catalog(second)).total, RULES.length + 2);
    assert.equal((await catalog(other)).total, RULES.length + 1);
    await f.modules.get('scope')!.dispatch({ action: 'configure', expectedRevision: 0, params: {
      feature: 'quality', config: { defaults: { plan: { ruleIds: [inherited.ruleId] } } },
    } }, global);
    await fs.mkdir(path.join(f.root, 'src')); await fs.writeFile(path.join(f.root, 'src/run.ts'), '// TODO\n');
    const plan: any = await quality.dispatch({ action: 'plan', params: { mode: 'full', layers: ['syntax'] } }, first);
    assert.deepEqual(plan.ruleIds, [inherited.ruleId], 'the live inherited selection must reach the actual plan');
    const run: any = await quality.dispatch({ action: 'run', params: { planId: plan.id, planHash: plan.planHash } }, first);
    assert.equal(run.diagnostics.length, 1); assert.equal(run.diagnostics[0].ruleId, inherited.ruleId);
    for (const context of [second, other, workspace]) {
      await assert.rejects(() => quality.dispatch({ action: 'run', params: { planId: plan.id, planHash: plan.planHash } }, context),
        (error: unknown) => ['NOT_FOUND', 'SCOPE_MISMATCH'].includes((error as NexusError).code));
    }
    await save(global, 1, inherited.ruleId, { summary: '上层定义已修改' });
    assert.equal((await catalog(first)).items.find((rule: any) => rule.ruleId === inherited.ruleId).summary, '上层定义已修改');
    await quality!.dispatch({ action: 'rules/delete', expectedRevision: 1, params: { ruleId: privateRule.ruleId } }, first);
    assert.equal((await catalog(first)).total, RULES.length + 2);
    await quality!.dispatch({ action: 'rules/delete', expectedRevision: 1, params: { ruleId: local.ruleId } }, workspace);
    assert.equal((await catalog(first)).total, RULES.length + 1);
    assert.equal((await catalog(other)).total, RULES.length + 1);
    await assert.rejects(() => quality!.dispatch({ action: 'rules/save', expectedRevision: 2, params: {
      rule: { ...customRuleInput(), ruleId: RULES[0]!.ruleId },
    } }, global), (error: unknown) => (error as NexusError).code === 'INVALID_ARGUMENT');
    await quality!.dispose?.();
  } finally { await f.cleanup(); }
});

test('engineering document discovery stops at the first existing project rule document', async () => {
  const f = await fixture();
  try {
    for (const name of ['DEEPSEEK.md', 'CLAUDE.md', 'AGENT.md', 'AGENTS.md']) {
      await fs.writeFile(path.join(f.root, name), `# ${name}\nProject rules.\n`);
    }
    const result = await f.modules.get('quality')!.dispatch({ action: 'lifecycle/discover' }) as {
      sources: Array<{ path: string; hash: string }>; gaps: string[];
    };
    assert(result.sources.some(source => source.path === 'DEEPSEEK.md' && source.hash.length === 64));
    for (const name of ['CLAUDE.md', 'AGENT.md', 'AGENTS.md']) {
      assert(!result.sources.some(source => source.path === name));
      assert(!result.gaps.includes(name));
    }
    for (const name of ['DEEPSEEK.md', 'AGENT.md', 'AGENTS.md', 'CLAUDE.md']) {
      const selected = await f.modules.get('quality')!.dispatch({ action: 'lifecycle/discover' }) as {
        ruleDocument: string | null; sources: Array<{ path: string }>;
      };
      assert.equal(selected.ruleDocument, name);
      assert.deepEqual(selected.sources.filter(source => ['DEEPSEEK.md', 'AGENT.md', 'AGENTS.md', 'CLAUDE.md'].includes(source.path)).map(source => source.path), [name]);
      await fs.unlink(path.join(f.root, name));
    }
    const missing = await f.modules.get('quality')!.dispatch({ action: 'lifecycle/discover' }) as { gaps: string[] };
    assert(missing.gaps.includes('DEEPSEEK.md'));
  } finally { await f.cleanup(); }
});

test('AST statement rule counts statements, stable occurrence fingerprints survive line shifts', () => {
  const twenty = `const f=()=>{\n${Array.from({ length: 20 }, (_, index) => `const a${index}=1;`).join('\n\n')}\n};`;
  const thirtyOne = `const f=()=>{${Array.from({ length: 31 }, (_, index) => `const a${index}=1;`).join('')}};`;
  assert.equal(scanTypeScript('example.ts', twenty).diagnostics.some(item => item.ruleId === 'hlt.ts.function-max-statements'), false);
  assert.equal(scanTypeScript('example.ts', thirtyOne).diagnostics.some(item => item.ruleId === 'hlt.ts.function-max-statements'), true);
  const before = scanTypeScript('example.ts', 'debugger;\ndebugger;').diagnostics.filter(item => item.ruleId === 'hlt.ts.no-debugger');
  const after = scanTypeScript('example.ts', '// moved\n\n debugger;\ndebugger;').diagnostics.filter(item => item.ruleId === 'hlt.ts.no-debugger');
  assert.equal(before.length, 2); assert.notEqual(before[0]!.fingerprint, before[1]!.fingerprint);
  assert.deepEqual(before.map(item => item.fingerprint), after.map(item => item.fingerprint));
});

test('safe fix preview rejects user edits and rollback never overwrites subsequent changes', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'example.ts'), 'debugger;\nexport const value = 1;\n');
    const quality = f.modules.get('quality')!;
    const plan = await quality.dispatch({ action: 'plan', params: { paths: ['example.ts'], layers: ['syntax'], ruleIds: ['hlt.ts.no-debugger'] } }) as { id: string; planHash: string };
    const run = await quality.dispatch({ action: 'run', params: { planId: plan.id, planHash: plan.planHash } }) as { id: string; diagnostics: Array<{ occurrenceId: string }> };
    const preview = await quality.dispatch({ action: 'fix_preview', params: { runId: run.id, diagnosticIds: [run.diagnostics[0]!.occurrenceId] } }) as { id: string; previewHash: string };
    await fs.writeFile(path.join(f.root, 'example.ts'), '// user edit\ndebugger;\n');
    await assert.rejects(() => quality.dispatch({ action: 'fix_apply', params: { previewId: preview.id, previewHash: preview.previewHash } }), (error: unknown) => (error as NexusError).code === 'REVISION_CONFLICT');
    assert.equal(await fs.readFile(path.join(f.root, 'example.ts'), 'utf8'), '// user edit\ndebugger;\n');
  } finally { await f.cleanup(); }
});

test('gate refuses missing layers and out-of-scope old diagnostics never become resolved', async () => {
  const f = await fixture();
  try {
    const quality = f.modules.get('quality')!;
    const decision = await quality.dispatch({ action: 'gate', params: { evidenceRefs: [] } }) as { decision: string; unknowns: string[] };
    assert.equal(decision.decision, 'unknown'); assert(decision.unknowns.length);
    const common = { root: f.root, snapshotId: 'snapshot', epoch: 'epoch', stale: { value: false, reasons: [] }, status: 'completed', coverage: { layers: [], files: [], unknown: [] } };
    await f.services.store.put('quality.reports', 'old', { ...common, id: 'old', diagnostics: [{ fingerprint: 'one', path: 'old.ts', range: { startLine: 1 } }] });
    await f.services.store.put('quality.reports', 'next', { ...common, id: 'next', diagnostics: [] });
    const diff = await quality.dispatch({ action: 'diff', params: { baselineRef: 'old', candidateRef: 'next' } }) as { resolved: unknown[]; outOfScope: unknown[] };
    assert.equal(diff.resolved.length, 0); assert.equal(diff.outOfScope.length, 1);
  } finally { await f.cleanup(); }
});

test('all eight original SVG types are standalone safe and paint-only theme preserves geometry', () => {
  for (const type of SVG_TYPES) {
    const ir = { type, title: '中文图示', nodes: [{ id: 'a', label: '用户', kind: 'actor' }, { id: 'b', label: '服务' }], edges: [{ from: 'a', to: 'b', label: '请求' }] };
    const light = renderSvg(ir, 'light'); const dark = renderSvg(ir, 'dark');
    assert.equal(validateSvg(light).safe, true, type);
    assert.equal(light.replace(/#[0-9a-f]{6}/g, '#PAINT'), dark.replace(/#[0-9a-f]{6}/g, '#PAINT'));
  }
  assert.equal(validateSvg('<svg><title>x</title><desc>x</desc><script>bad()</script></svg>').safe, false);
});

test('real Git review distinguishes staged snapshot from later working-tree content', async () => {
  const f = await fixture();
  try {
    const git = (args: string[]) => f.services.executor.run('git', args, { cwd: f.root });
    assert.equal((await git(['init'])).exitCode, 0);
    await git(['config', 'user.email', 'fixture@example.invalid']); await git(['config', 'user.name', 'Nexus Fixture']);
    await fs.writeFile(path.join(f.root, 'example.ts'), 'export const value = 1;\n');
    await git(['add', 'example.ts']); assert.equal((await git(['commit', '-m', 'fixture'])).exitCode, 0);
    await fs.writeFile(path.join(f.root, 'example.ts'), 'export const value = 2;\n'); await git(['add', 'example.ts']);
    await fs.writeFile(path.join(f.root, 'example.ts'), 'export const value = 3;\n');
    const review = f.modules.get('review')!;
    const staged = await review.dispatch({ action: 'preview', params: { mode: 'staged' } }) as { snapshot: { files: Array<{ right: { text: string } }> } };
    assert(staged.snapshot.files[0]!.right.text.includes('= 2'));
    const unstaged = await review.dispatch({ action: 'preview', params: { mode: 'unstaged' } }) as { snapshot: { files: Array<{ left: { text: string }; right: { text: string } }> } };
    assert(unstaged.snapshot.files[0]!.left.text.includes('= 2'));
    assert(unstaged.snapshot.files[0]!.right.text.includes('= 3'));
  } finally { await f.cleanup(); }
});

test('declarative workflow rejects cycles, parallel write conflict and unbounded retry', async () => {
  const f = await fixture();
  try {
    const quality = f.modules.get('quality')!;
    for (const nodes of [
      [{ id: 'a', kind: 'tool', dependsOn: ['b'] }, { id: 'b', kind: 'tool', dependsOn: ['a'] }],
      [{ id: 'a', kind: 'tool', writeClaims: ['file.ts'] }, { id: 'b', kind: 'tool', writeClaims: ['file.ts'] }],
      [{ id: 'a', kind: 'tool', retry: 100 }],
    ]) await assert.rejects(() => quality.dispatch({ action: 'lifecycle/template', params: { operation: 'validate', definition: { nodes } } }));
  } finally { await f.cleanup(); }
});

test('adopted quality rules and configured severity govern later plans and cached diagnostics', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'example.ts'), 'debugger;\nexport const value = 1;\n');
    const quality = f.modules.get('quality')!;
    const adoption: any = await quality.dispatch({ action: 'adopt', params: { selection: ['hlt.ts.no-debugger'] } });
    await quality.dispatch({ action: 'init', params: { previewId: adoption.id, previewHash: adoption.previewHash } });
    const params = { mode: 'full', paths: ['example.ts'], layers: ['syntax'] };
    const first: any = await quality.dispatch({ action: 'plan', params });
    assert.deepEqual(first.ruleIds, ['hlt.ts.no-debugger']);
    assert.equal(first.ruleSelectionSource.kind, 'project-file');
    assert.equal(first.ruleSelectionSource.path, '.nexus/quality.json');
    const errorRun: any = await quality.dispatch({ action: 'run', params: { planId: first.id, planHash: first.planHash } });
    assert.equal(errorRun.diagnostics[0].severity, 'error');
    await fs.writeFile(path.join(f.root, '.nexus/quality.json'), JSON.stringify({ schema: 'nexus-quality/v1', rules: { 'hlt.ts.no-debugger': { severity: 'warning' } } }));
    const second: any = await quality.dispatch({ action: 'plan', params });
    assert.notEqual(first.epoch, second.epoch);
    const warningRun: any = await quality.dispatch({ action: 'run', params: { planId: second.id, planHash: second.planHash } });
    assert.equal(warningRun.diagnostics[0].severity, 'warning');
    assert.equal(warningRun.summary.errors, 0); assert.equal(warningRun.summary.warnings, 1);
    const empty: any = await quality.dispatch({ action: 'plan', params: { ...params, ruleIds: [] } });
    assert.deepEqual(empty.ruleIds, []); assert.equal(empty.ruleSelectionSource.kind, 'selected-input');
    const emptyRun: any = await quality.dispatch({ action: 'run', params: { planId: empty.id, planHash: empty.planHash } });
    assert.equal(emptyRun.diagnostics.length, 0);
    await fs.writeFile(path.join(f.root, '.nexus/quality.json'), '{"rules":{"hlt.ts.no-debugger":{"severity":"off"}}}');
    assert.deepEqual((await quality.dispatch({ action: 'plan', params }) as any).ruleIds, []);
    await fs.writeFile(path.join(f.root, '.nexus/quality.json'), '{"rules":{"unknown-rule":{"severity":"error"}}}');
    await assert.rejects(() => quality.dispatch({ action: 'rules/settings' }), (error: unknown) => (error as NexusError).code === 'INVALID_ARGUMENT');
    await fs.writeFile(path.join(f.root, '.nexus/quality.json'), '{"rules":');
    await assert.rejects(() => quality.dispatch({ action: 'plan', params }), (error: unknown) => (error as NexusError).code === 'INVALID_ARGUMENT');
  } finally { await f.cleanup(); }
});

test('review rule documents become captured auxiliary source and enter the actual model input', async () => {
  const f = await fixture();
  try {
    const git = (args: string[]) => f.services.executor.run('git', args, { cwd: f.root });
    assert.equal((await git(['init'])).exitCode, 0);
    await git(['config', 'user.email', 'fixture@example.invalid']); await git(['config', 'user.name', 'Nexus Fixture']);
    await fs.writeFile(path.join(f.root, 'example.ts'), 'export const value = 1;\n');
    await git(['add', 'example.ts']); await git(['commit', '-m', 'fixture']);
    await fs.writeFile(path.join(f.root, 'AGENTS.md'), 'REVIEW_POLICY_FIXTURE: check boundary ownership.\n');
    const prompts: string[] = [], model = f.services.host.model;
    f.services.host.model = async request => { prompts.push(request.prompt); return model(request); };
    const review = f.modules.get('review')!;
    const preview: any = await review.dispatch({ action: 'preview', params: { mode: 'project', rulePaths: ['AGENTS.md'] } });
    assert.equal(preview.snapshot.root, await fs.realpath(f.root));
    const rule = preview.snapshot.files.find((file: any) => file.path === 'AGENTS.md');
    assert.equal(rule.primary, false); assert.equal(rule.state, 'captured');
    assert.match(rule.right.text, /REVIEW_POLICY_FIXTURE/);
    const run: any = await review.dispatch({ action: 'execute', params: { previewId: preview.id, previewHash: preview.previewHash } });
    assert(prompts.some(prompt => prompt.includes('REVIEW_POLICY_FIXTURE') && prompt.includes('"auxiliary"')));
    assert.equal(run.coverage.some((file: any) => file.path === 'AGENTS.md'), false);
    const evidence: any = await review.dispatch({ action: 'evidence', params: { runId: run.id } });
    assert.equal(evidence.files.find((file: any) => file.path === 'AGENTS.md').right.hash, rule.right.hash);
  } finally { await f.cleanup(); }
});

test('SVN review captures selected rule documents as auxiliary sources and reports missing rules', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'example.ts'), 'export const value = 2;\n');
    await fs.writeFile(path.join(f.root, 'AGENTS.md'), 'SVN_REVIEW_POLICY_FIXTURE\n');
    f.services.executor.run = async (command, args) => {
      assert.equal(command, 'svn');
      const stdout = args[0] === 'info'
        ? '<info><entry revision="10"><url>https://example.invalid/repo/trunk</url><repository><root>https://example.invalid/repo</root><uuid>fixture-uuid</uuid></repository></entry></info>'
        : args[0] === 'status' ? '<status><target path="."><entry path="example.ts"><wc-status item="modified" revision="10"/></entry></target></status>'
          : args[0] === 'proplist' ? '<properties/>'
            : 'export const value = 1;\n';
      return { exitCode: 0, stdout, stderr: '', durationMs: 0, cancelled: false };
    };
    const preview: any = await f.modules.get('review')!.dispatch({ action: 'preview', params: {
      vcs: 'svn', mode: 'worktree', rulePaths: ['AGENTS.md', 'missing-rules.md'],
    } });
    assert(preview.snapshot.files.some((file: any) => file.path === 'example.ts' && file.primary));
    const rule = preview.snapshot.files.find((file: any) => file.path === 'AGENTS.md');
    assert.equal(rule.primary, false); assert.equal(rule.state, 'captured');
    assert.match(rule.right.text, /SVN_REVIEW_POLICY_FIXTURE/);
    const missing = preview.snapshot.files.find((file: any) => file.path === 'missing-rules.md');
    assert.equal(missing.primary, false); assert.equal(missing.state, 'blocked');
  } finally { await f.cleanup(); }
});
