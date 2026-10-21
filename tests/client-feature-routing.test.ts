import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { ViewContext } from '../src/client/types.js';

type RoutingFixture =
  typeof import('../src/client/feature-page.js') & typeof import('../src/client/catalog.js')
  & typeof import('../src/client/scope-views.js') & typeof import('../src/client/global-feature-view.js')
  & typeof import('../src/client/views.js') & typeof import('../src/client/domain-views.js')
  & typeof import('../src/client/i18n.js') & typeof import('../src/client/localized-text.js')
  & typeof import('../src/client/types.js') & typeof import('../src/client/QualityWorkbench.js')
  & typeof import('../src/client/ContextWorkbench.js');

// Exercise the real client module graph through its CSS boundary. Re-exporting
// the components in one bundle keeps reference equality and one language store.
const bundled = await build({
  stdin: {
    contents: `
      export { FeaturePage } from './feature-page.tsx';
      export { capability, isAuxiliaryPage, normalizeCatalog, pagesForScope } from './catalog.ts';
      export { GlobalOverview } from './scope-views.tsx';
      export { GlobalFeatureView, globalFeatureRecords } from './global-feature-view.tsx';
      export { OrchestrationView } from './views.tsx';
      export { ContextView, QualityView, RecoveryView, ResourcesView } from './domain-views.tsx';
      export { getLanguage, setLanguage } from './i18n.ts';
      export { isLocalizedText, localizedText } from './localized-text.ts';
      export { titleOf } from './types.ts';
      export { qualityPlanParams, reviewPreviewParams } from './QualityWorkbench.tsx';
      export { compressionBlockState, compressionBlockRange, cacheEvidenceSummary, compressionResultSummary } from './ContextWorkbench.tsx';
    `,
    resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)),
    sourcefile: 'client-feature-routing-fixture.ts',
    loader: 'ts',
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22',
  packages: 'external', loader: { '.css': 'text' }, logLevel: 'silent',
});
const fixtureModule: { exports: unknown } = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0]!.text)(
  createRequire(import.meta.url), fixtureModule, fixtureModule.exports,
);
const {
  FeaturePage, capability, isAuxiliaryPage, normalizeCatalog, pagesForScope,
  GlobalOverview, GlobalFeatureView, globalFeatureRecords, OrchestrationView,
  ContextView, QualityView, RecoveryView, ResourcesView, getLanguage, setLanguage,
  isLocalizedText, localizedText, titleOf, qualityPlanParams, reviewPreviewParams,
  compressionBlockState, compressionBlockRange, cacheEvidenceSummary, compressionResultSummary,
} = fixtureModule.exports as RoutingFixture;

test('workbench selections reach plan and preview without turning empty paths into an empty review', () => {
  const plan = qualityPlanParams('full', '', ['hlt.ts.no-debugger'], ['syntax'], []);
  assert.deepEqual(plan.ruleIds, ['hlt.ts.no-debugger']);
  assert.equal('paths' in plan, false);
  assert.deepEqual(qualityPlanParams('changed', 'src/a.ts\nsrc/a.ts\n', [], ['syntax'], []).paths, ['src/a.ts']);
  const preview = reviewPreviewParams({ mode: 'worktree', vcs: 'git', paths: '', contextPaths: 'src/types.ts',
    rulePaths: 'AGENTS.md\n.nexus/review.md\nAGENTS.md', rounds: 2, oldRef: '', newRef: '' });
  assert.equal('selectedPaths' in preview, false);
  assert.deepEqual(preview.rulePaths, ['AGENTS.md', '.nexus/review.md']);
  assert.deepEqual(preview.contextPaths, ['src/types.ts']);
  assert.equal(preview.rounds, 2);
});

test('compression and cache evidence use actual domain fields and preserve missing coverage', () => {
  const block = { blockId: 'b2', active: false, effectiveMessageIds: ['raw1', 'raw2'] };
  assert.equal(compressionBlockState(block), '已由后续压缩合并');
  assert.equal(compressionBlockState({ ...block, active: true }), '压缩生效中');
  assert.equal(compressionBlockState({ ...block, restoredInline: true }), '原文已恢复');
  assert.equal(compressionBlockState({ ...block, expanded: true }), '已展开');
  assert.deepEqual(compressionBlockRange(block, { byRaw: { raw1: 'm1', raw2: 'm2' } }), { startRef: 'm1', endRef: 'm2' });
  const actual = cacheEvidenceSummary({ evidence: 'provider-reported', coverage: { reported: 1, attempts: 3, missing: 2 },
    cacheReadShare: .75, report: { totals: { input: 400, cached: 300, output: null } } });
  assert.equal(actual.observed, true); assert.equal(actual.share, .75);
  assert.equal(actual.totals.cached, 300); assert.equal(actual.totals.output, null); assert.equal(actual.coverage.missing, 2);
  const absent = cacheEvidenceSummary({ evidence: 'unobserved', coverage: { reported: 0, attempts: 1, missing: 1 },
    cacheReadShare: 0, report: { totals: { input: 0, cached: 0 } } });
  assert.equal(absent.observed, false); assert.equal(absent.share, null); assert.deepEqual(absent.totals, {});
  assert.equal(compressionResultSummary({ decision: 'wait', applied: false, reason: 'no-candidate' }).text, '当前无需压缩');
  assert.equal(compressionResultSummary({ decision: 'compress', applied: { blocksCreated: 0, errors: ['protected range'] } }).text, '未新增压缩块');
  assert.deepEqual(compressionResultSummary({ blocksCreated: 1, errors: ['another range blocked'] }).errors, ['another range blocked']);
});

const context = (level: 'global' | 'workspace' | 'session') => ({ scope: { level, workspaceId: level === 'global' ? undefined : 'workspace-A',
  sessionId: level === 'session' ? 'session-A' : undefined } }) as ViewContext;

test('global feature navigation reaches the real feature views without an implicit project summary', () => {
  const global = context('global');
  const expected = { orchestration: OrchestrationView, resources: ResourcesView, extensions: ResourcesView };
  for (const [page, type] of Object.entries(expected)) {
    const element = FeaturePage({ context: global, page: page as keyof typeof expected });
    assert.equal(element?.type, type, page);
    assert.equal(element?.props.context.scope.level, 'global');
  }
  for (const page of ['quality', 'review', 'recovery'] as const) {
    const element = FeaturePage({ context: global, page });
    assert.equal(element?.type, GlobalFeatureView);
    assert.equal(element?.props.page, page, 'The source query and visible table must use the selected feature');
  }
  for (const { id: page } of pagesForScope('global')) {
    assert.notEqual(FeaturePage({ context: global, page })?.type, GlobalOverview, page);
    assert.equal(FeaturePage({ context: global, page, summary: true })?.type, GlobalOverview, page);
  }
});

test('workspace and conversation pages retain their own implementations even when a summary is requested', () => {
  for (const level of ['workspace', 'session'] as const) {
    const view = context(level);
    for (const [page, type] of [['quality', QualityView], ['review', QualityView], ['recovery', RecoveryView]] as const) {
      const element = FeaturePage({ context: view, page, summary: true });
      assert.equal(element?.type, type);
      assert.equal(element?.props.context, view);
    }
  }
  assert.equal(FeaturePage({ context: context('session'), page: 'cache' })?.type, ContextView);
  assert.equal(FeaturePage({ context: context('workspace'), page: 'cache' }), null);
});

test('search, recovery and resource controls retire their state when the native scope identity changes', () => {
  for (const page of ['search', 'recovery', 'resources'] as const) {
    const before = context('session');
    const nextSession = { ...before, scope: { ...before.scope, sessionId: 'session-B' } };
    const nextWorkspace = { ...before, scope: { ...before.scope, workspaceId: 'workspace-B' } };
    const a = FeaturePage({ context: before, page })!;
    assert.equal(a.type, FeaturePage({ context: nextSession, page })!.type);
    assert.notEqual(a.key, FeaturePage({ context: nextSession, page })!.key, `${page}: retire old session selections and requests`);
    assert.notEqual(a.key, FeaturePage({ context: nextWorkspace, page })!.key, `${page}: retire old workspace callbacks`);
  }
});

test('original interfaces cannot be replaced by a generic Nexus page at another scope', () => {
  for (const level of ['global', 'workspace', 'session'] as const) {
    for (const page of ['engineering', 'tasks', 'memory', 'knowledge', 'graph', 'context', 'usage'] as const) {
      assert.equal(isAuxiliaryPage(page, level), false, `${level}/${page}`);
      assert.equal(FeaturePage({ context: context(level), page }), null, `${level}/${page}`);
    }
  }
  assert.equal(isAuxiliaryPage('connections', 'session'), false);
  assert.equal(isAuxiliaryPage('extensions', 'workspace'), false);
  assert.equal(isAuxiliaryPage('cache', 'global'), false);
});

test('global context rows deduplicate inherited session lanes and preserve source identities', () => {
  const session = { sessionId: 'session-A', lane: 'main', purpose: 'main', blocks: 2 };
  const items = globalFeatureRecords({ items: [
    { id: 'workspace-A', title: 'A', counts: [
      { level: 'workspace', items: [session, { ...session, lane: 'side', blocks: 1 }] },
      { level: 'session', sessionId: 'session-A', items: [{ ...session, blocks: 3 }, { ...session, lane: 'side', blocks: 1 }] },
    ] },
    { id: 'workspace-B', title: 'B', counts: [{ level: 'workspace', items: [{ ...session, blocks: 7 }] }] },
  ] });
  assert.equal(items.length, 3);
  assert.equal(items[0].blocks, 3);
  assert.equal(items[0].workspaceId, 'workspace-A');
  assert.equal(items[0].sessionId, 'session-A');
  assert.equal(items[2].workspaceId, 'workspace-B');
  assert.equal(items[2].blocks, 7);
});

test('package descriptors select a language with regional and English fallback without stringifying unknown objects', () => {
  const descriptor = { en: 'English description', zh: '中文说明', 'zh-Hant': '繁體說明' };
  assert.equal(localizedText(descriptor, 'zh-CN'), '中文说明');
  assert.equal(localizedText(descriptor, 'zh_Hant_TW'), '繁體說明');
  assert.equal(localizedText(descriptor, 'ru'), 'English description');
  assert.equal(localizedText({ zh: '仅中文' }, 'ru'), '仅中文');
  assert.equal(localizedText({ en: 'English', zh: '' }, 'zh', 'fallback'), '');
  assert.equal(localizedText('verbatim', 'ru'), 'verbatim');
  assert.equal(localizedText({ summary: 'not a language descriptor' }, 'zh', 'fallback'), 'fallback');
  assert.equal(localizedText({ en: { text: 'invalid nested descriptor' } }, 'en', 'fallback'), 'fallback');
  assert.equal(localizedText(['not', 'a', 'descriptor'], 'en', 'fallback'), 'fallback');
  assert.equal(isLocalizedText({ en: 'English', zh: '中文' }), true);
  assert.equal(isLocalizedText({ en: 'English', count: 1 }), false);
  assert.equal(titleOf({ id: 'preset-A', name: { en: 'English preset', zh: '中文预设' } }, 'zh'), '中文预设');
  assert.equal(titleOf({ id: 'preset-A', name: { unsupported: {} } }, 'zh'), 'preset-A');
});

test('resource descriptor selection follows the active language and retains the original metadata', () => {
  const previous = getLanguage();
  const item = { id: 'preset-A', kind: 'preset', name: { en: 'English preset', zh: '中文预设' },
    description: { en: 'English description', zh: '中文说明' }, source: 'host', license: 'MIT' };
  const original = structuredClone(item);
  try {
    setLanguage('zh');
    assert.equal(titleOf(item), '中文预设');
    assert.equal(localizedText(item.description), '中文说明');
    setLanguage('en');
    assert.equal(titleOf(item), 'English preset');
    assert.equal(localizedText(item.description), 'English description');
    assert.equal(localizedText({ unexpected: { en: 'bad' } }, undefined, '查看来源、内容与配置'), '查看来源、内容与配置');
    assert.deepEqual(item, original);
  } finally { setLanguage(previous); }
});

test('capability normalization preserves multilingual descriptions and schema labels across language changes', () => {
  const previous = getLanguage();
  const snapshot = { domains: [{ id: 'resources', capabilities: [{
    action: 'get', description: { en: 'Read resource', zh: '读取资源说明' },
    schema: { type: 'object', required: ['name'], properties: {
      name: { type: 'string', title: { en: 'Resource name', zh: '资源名称' },
        description: { en: 'Choose a resource name', zh: '填写资源名称' } },
    } },
  }] }] };
  const original = structuredClone(snapshot);
  const definition = capability(normalizeCatalog(snapshot), 'resources', 'get');
  assert.ok(definition);
  try {
    setLanguage('zh');
    assert.equal(localizedText(definition.description), '读取资源说明');
    assert.equal(localizedText(definition.schema?.properties.name.title), '资源名称');
    assert.equal(localizedText(definition.schema?.properties.name.description), '填写资源名称');
    setLanguage('en');
    assert.equal(localizedText(definition.description), 'Read resource');
    assert.equal(localizedText(definition.schema?.properties.name.title), 'Resource name');
    assert.equal(localizedText(definition.schema?.properties.name.description), 'Choose a resource name');
    assert.deepEqual(snapshot, original);
  } finally { setLanguage(previous); }
});
