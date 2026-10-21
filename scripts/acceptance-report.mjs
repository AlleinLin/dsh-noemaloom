import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE_SHA256, sha256, slash, json, optionalJson, filesUnder, sourceIdentity, readFrozenDefinitions, readJUnit, validateReceipt, evaluateObservation } from '../tools/acceptance/core.mjs';
import { domainCandidates, sourceCandidates, webSubpackages, testBindings, idsInTitle } from '../tools/acceptance/coverage-map.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--strict')) throw new Error('Usage: node scripts/acceptance-report.mjs [--strict]');
const specification = join(root, 'docs', 'specification');
const { baseline, definitions } = await readFrozenDefinitions(specification);
if (sourceCandidates.length !== 36 || new Set(sourceCandidates.map(item => item.id)).size !== 36 || webSubpackages.length !== 19 || new Set(webSubpackages.map(item => item.name)).size !== 19) throw new Error('The frozen source and subpackage coverage identities must remain 36 / 19 and unique');
const identity = await sourceIdentity(root);
const receipts = [];
for (const path of await filesUnder(join(root, 'evidence', 'receipts'))) {
  if (!path.endsWith('.json')) continue;
  try {
    const receipt = await json(path);
    const validated = await validateReceipt(root, receipt, identity.sha256);
    if (receipt.sourceUnchangedDuringRun === false) validated.reasons.push('source-changed-during-run');
    validated.valid = validated.reasons.length === 0;
    receipts.push({ receipt, ...validated, path: slash(relative(root, path)) });
  } catch (error) { receipts.push({ receipt: { id: slash(relative(root, path)) }, valid: false, reasons: [`invalid-receipt:${error.message}`], observed: new Map(), path: slash(relative(root, path)) }); }
}
const testCases = [];
for (const item of receipts.filter(item => item.valid && item.receipt.kind === 'domain-test')) {
  for (const [path, bytes] of item.observed) {
    if (!path.endsWith('.xml')) continue;
    for (const testCase of readJUnit(bytes.toString('utf8'))) testCases.push({ ...testCase, receipt: item.receipt.id, path, exitCode: item.receipt.exitCode });
  }
}
const existing = async path => { try { await access(join(root, path)); return true; } catch { return false; } };
const localTestDefinitions = [];
for (const path of await filesUnder(join(root, 'tests'))) {
  if (!/\.test\.[cm]?[jt]sx?$/u.test(path)) continue;
  const text = await readFile(path, 'utf8');
  for (const match of text.matchAll(/\btest\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*?)\1/gu)) {
    localTestDefinitions.push({ file: slash(relative(root, path)), title: match[2].replace(/\\(['"`\\])/gu, '$1') });
  }
}
const bindings = [...testBindings];
for (const test of localTestDefinitions) {
  const ids = idsInTitle(test.title);
  if (ids.length && !bindings.some(binding => binding.file === test.file && binding.title === test.title)) bindings.push({ ...test, ids, coverage: 'partial', kind: 'domain-test' });
}
const baselineIds = new Set(definitions.map(item => item.id));
const mappingIssues = [];
for (const binding of bindings) {
  if (!localTestDefinitions.some(test => test.file === binding.file && test.title === binding.title)) mappingIssues.push({ kind: 'test-definition-missing-or-renamed', file: binding.file, title: binding.title, ids: binding.ids });
  for (const id of binding.ids) if (!baselineIds.has(id)) mappingIssues.push({ kind: 'mapped-id-outside-frozen-baseline', file: binding.file, title: binding.title, id });
}
const overrides = await optionalJson(join(root, 'tools', 'acceptance', 'requirements.json'), { schemaVersion: 1, requirements: [] });
if (overrides.schemaVersion !== 1 || !Array.isArray(overrides.requirements)) throw new Error('Invalid explicit proof requirements');
for (const requirement of overrides.requirements) if (!baselineIds.has(requirement.id) || !Array.isArray(requirement.requiredKinds) || !requirement.requiredKinds.length) throw new Error(`Invalid explicit proof requirement: ${requirement.id}`);
const requirementFor = definition => {
  const explicit = overrides.requirements.find(item => item.id === definition.id);
  if (explicit) return explicit;
  const text = definition.originalText;
  let kinds;
  if (/^UI-|^RUN-AT|^EXT-AT/u.test(definition.id)) kinds = ['desktop'];
  else if (/^DEV-|^REL-/u.test(definition.id)) kinds = ['integration'];
  else if (/^HOST-/u.test(definition.id)) kinds = ['host-contract'];
  else if (/线上|在线canary|配对在线|TTFT及置信区间|配对报告/u.test(text)) kinds = ['cache-experiment'];
  else kinds = ['domain-test'];
  return { id: definition.id, requiredKinds: kinds, resource: kinds.includes('cache-experiment') ? '需要已授权的实际模型账户和可配对 workload' : null };
};
const resultDefinitions = [];
for (const definition of definitions) {
  const candidates = domainCandidates.filter(group => group.prefixes.some(prefix => definition.id.startsWith(prefix)));
  const proofRequirement = requirementFor(definition);
  const evidence = [];
  for (const binding of bindings.filter(binding => binding.ids.includes(definition.id))) {
    const sourcePresent = localTestDefinitions.some(test => test.file === binding.file && test.title === binding.title);
    const matched = sourcePresent ? testCases.filter(test => test.name === binding.title) : [];
    const unique = matched.length === 1;
    evidence.push({ kind: 'domain-test', coverage: binding.coverage, file: binding.file, test: binding.title,
      status: unique ? matched[0].status : matched.length > 1 ? 'ambiguous-test-title' : sourcePresent ? 'not_executed' : 'missing-test-definition',
      receipt: unique ? matched[0].receipt : null, artifact: unique ? matched[0].path : null,
      commandExitCode: unique ? matched[0].exitCode : null, definitionReviewed: binding.coverage === 'complete' });
  }
  for (const item of receipts.filter(item => item.valid)) {
    for (const assertion of (item.receipt.assertions ?? []).filter(assertion => assertion.id === definition.id)) {
      const checks = (assertion.checks ?? []).map(check => evaluateObservation(check, item.observed));
      const kind = item.receipt.kind;
      const issues = [];
      if (assertion.definitionSha256 !== definition.sha256) issues.push('claim-not-bound-to-frozen-definition');
      if (!checks.length) issues.push('empty-observation-checks');
      if (kind === 'desktop' && (item.receipt.environment?.observedFrom !== 'desktop-process' || item.receipt.environment?.hostVersion !== '0.2.1-rc.2' || !item.receipt.environment?.node || !item.receipt.environment?.abi)) issues.push('missing-actual-desktop-runtime-facts');
      if (['online-model', 'cache-experiment'].includes(kind) && (item.receipt.environment?.synthetic !== false || !(item.receipt.actualModelCalls > 0) || !Array.isArray(item.receipt.providerRequestIds) || !item.receipt.providerRequestIds.length)) issues.push('missing-actual-provider-attempt-evidence');
      if (kind === 'cache-experiment' && !(item.receipt.pairedSampleCount > 0)) issues.push('missing-paired-samples');
      if (item.receipt.exitCode !== undefined && item.receipt.exitCode !== 0) issues.push('command-failed');
      evidence.push({ kind, coverage: assertion.coverage ?? 'partial', receipt: item.receipt.id, artifact: item.path, status: issues.length ? 'invalid-claim' : checks.every(check => check.passed) ? 'passed' : 'failed', checks, issues, definitionReviewed: assertion.definitionSha256 === definition.sha256 });
    }
  }
  const successful = evidence.filter(item => item.status === 'passed');
  const completeKinds = new Set(successful.filter(item => item.coverage === 'complete' && item.definitionReviewed && (item.commandExitCode === undefined || item.commandExitCode === null || item.commandExitCode === 0)).map(item => item.kind));
  const missingKinds = proofRequirement.requiredKinds.filter(kind => !completeKinds.has(kind));
  const failed = evidence.some(item => item.status === 'failed' || item.status === 'invalid-claim');
  const status = failed ? 'failed' : !missingKinds.length ? 'passed' : successful.length ? 'partial_evidence' : 'not_executed';
  resultDefinitions.push({ ...definition, status, packages: [...new Set(candidates.flatMap(item => item.packages))], implementationCandidates: [...new Set(candidates.flatMap(item => item.files))],
    requiredKinds: proofRequirement.requiredKinds, missingKinds, resource: proofRequirement.resource, remaining: [...new Set(candidates.map(item => item.needs))], evidence });
}
const summarize = values => values.reduce((counts, value) => ({ ...counts, [value.status]: (counts[value.status] ?? 0) + 1 }), {});
const provenance = await optionalJson(join(root, 'sources.lock.json'), { units: [], dshWebSubpackages: [] });
const evaluateCompletionClaims = (collection, id, identityField, expectedIdentity) => {
  const claims = [];
  for (const item of receipts.filter(item => item.valid)) for (const claim of item.receipt[collection] ?? []) {
    if (claim.id !== id) continue;
    const checks = (claim.checks ?? []).map(check => evaluateObservation(check, item.observed));
    const valid = typeof expectedIdentity === 'string' && expectedIdentity.length > 0 && claim[identityField] === expectedIdentity && claim.coverage === 'complete' && checks.length > 0 && (item.receipt.exitCode === undefined || item.receipt.exitCode === 0);
    claims.push({ receipt: item.receipt.id, status: valid && checks.every(check => check.passed) ? 'passed' : 'failed', checks });
  }
  return { status: claims.some(claim => claim.status === 'failed') ? 'failed' : claims.some(claim => claim.status === 'passed') ? 'passed' : 'requires_concrete_completion_evidence', claims };
};
const unitCoverage = [];
for (const unit of sourceCandidates) {
  const source = provenance.units.find(row => row.id === unit.id);
  unitCoverage.push({ ...unit, ...evaluateCompletionClaims('sourceAssertions', unit.id, 'sourceContentIdentity', source?.source?.contentIdentity),
    sourceIdentityPresent: typeof source?.source?.contentIdentity === 'string' && /^(?:git:[0-9a-f]{40}|snapshot-sha256:[0-9a-f]{64})$/u.test(source.source.contentIdentity),
    sourceIdentity: source?.source ?? null, paths: await Promise.all(unit.files.map(async path => ({ path, present: await existing(path) }))) });
}
const subpackageCoverage = await Promise.all(webSubpackages.map(async item => {
  const locked = provenance.dshWebSubpackages?.find(row => row.directory === item.name);
  return { ...item, ...evaluateCompletionClaims('subpackageAssertions', item.name, 'manifestSha256', locked?.manifestSha256), paths: await Promise.all(item.files.map(async path => ({ path, present: await existing(path) }))), sourceLockPresent: Boolean(locked) };
}));
const sourceProblems = unitCoverage.filter(item => !item.sourceIdentityPresent || item.paths.some(path => !path.present));
const checkpoints = await json(join(specification, 'specs', 'development-checkpoints.json'));
if (checkpoints.checkpoints.length !== 62 || new Set(checkpoints.checkpoints.map(item => item.id)).size !== 62) throw new Error('The frozen 62 checkpoints must remain complete and unique');
const checkpointCoverage = checkpoints.checkpoints.map(checkpoint => ({ id: checkpoint.id, packageId: checkpoint.packageId, title: checkpoint.title, definitionOfDone: checkpoint.definitionOfDone,
  definitionOfDoneSha256: sha256(checkpoint.definitionOfDone), ...evaluateCompletionClaims('checkpointAssertions', checkpoint.id, 'definitionOfDoneSha256', sha256(checkpoint.definitionOfDone)), evidencePath: checkpoint.evidencePath, sourceUnits: checkpoint.sourceUnits, requiredVerification: checkpoint.verification }));
const summary = summarize(resultDefinitions);
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), scope: 'Frozen assertions with content-bound observed evidence; implementation candidates and partial tests are not completion',
  baselineSha256: BASELINE_SHA256, count: baseline.count, sourceIdentity: identity,
  outcome: summary.passed === 769 && sourceProblems.length === 0 && mappingIssues.length === 0 && unitCoverage.every(item => item.status === 'passed') && subpackageCoverage.every(item => item.status === 'passed') && checkpointCoverage.every(item => item.status === 'passed') ? 'passed' : 'incomplete',
  summary, sourceUnits: unitCoverage, dshWebSubpackages: subpackageCoverage, checkpoints: checkpointCoverage, mappingIssues,
  evidenceReceipts: receipts.map(item => ({ id: item.receipt.id, path: item.path, kind: item.receipt.kind, valid: item.valid, reasons: item.reasons })),
  testSummary: { declaredTests: localTestDefinitions.length, observedCases: testCases.length, observed: summarize(testCases), mappedBindings: bindings.length },
  definitions: resultDefinitions,
};
await mkdir(join(root, 'evidence'), { recursive: true }); await mkdir(join(root, 'docs', 'coverage'), { recursive: true });
await writeFile(join(root, 'evidence', 'acceptance-ledger.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(join(root, 'docs', 'coverage', 'source-coverage.json'), JSON.stringify({ sourceIdentity: identity, units: unitCoverage, dshWebSubpackages: subpackageCoverage, checkpoints: checkpointCoverage }, null, 2) + '\n');
const cell = value => String(value ?? '').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
const lines = [
  '# DSH Nexus 实际验收证据报告', '',
  `生成时间：${report.generatedAt}。当前结果：**${report.outcome}**。冻结基线 ${baseline.count} 条，SHA-256 \`${BASELINE_SHA256}\`。`, '',
  '本报告读取实际结果文件并校验内容哈希和源码身份。候选模块、文档校验、测试文件存在、安装命令返回 0 均不等于完整功能通过。冻结定义未删改；局部断言证据保留为 partial_evidence。', '',
  `源码身份：\`${identity.sha256}\`。通过 ${summary.passed ?? 0}；局部证据 ${summary.partial_evidence ?? 0}；失败 ${summary.failed ?? 0}；未执行 ${summary.not_executed ?? 0}。`, '',
  '## 验证材料', '', '| 材料 | 类型 | 是否有效 | 失效原因 |', '|---|---|---|---|',
  ...receipts.map(item => `| ${cell(item.path)} | ${cell(item.receipt.kind)} | ${item.valid ? '是' : '否'} | ${cell(item.reasons.join('; '))} |`), '',
  `已声明本地测试 ${localTestDefinitions.length} 项；已观察 JUnit 用例 ${testCases.length} 项。JUnit 的 fixture 运行与真实 Host/模型证据分别记录。`, '',
  '## 来源与待补证据', '', '| 来源 | 精确来源身份 | 入口候选 | 必须补齐 |', '|---|---|---|---|',
  ...unitCoverage.map(item => `| ${item.id} / ${item.status} | ${item.sourceIdentityPresent ? cell(item.sourceIdentity.contentIdentity) : '缺失'} | ${cell(item.paths.map(path => `${path.present ? '' : '缺失:'}${path.path}`).join(', '))} | ${cell(item.remaining)} |`), '',
  '## 19 子包范围', '', '| 子包 | 完整范围 | 入口候选 |', '|---|---|---|',
  ...subpackageCoverage.map(item => `| ${item.name} / ${item.status} | ${cell(item.scope)} | ${cell(item.files.join(', '))} |`), '',
  '## 逐条冻结断言', '', '| ID | 状态 | 所需证据 | 实测材料/测试 | 原始断言 |', '|---|---|---|---|---|',
  ...resultDefinitions.map(item => `| ${item.id} | ${item.status} | ${cell(item.missingKinds.join(', ') || '已满足')} | ${cell(item.evidence.map(evidence => `${evidence.test ?? evidence.receipt}:${evidence.status}/${evidence.coverage}`).join('; '))} | ${cell(item.originalText)} |`), '',
  '## 62 检查点', '', '检查点保留原始完成判据。仅引用执行包或存在目录不能把检查点改为 completed；其运行证据须在逐条断言和原 evidencePath 中核对。', '',
  ...checkpointCoverage.map(item => `- ${item.id} / ${item.packageId} / ${item.status}：${item.title}。完成判据：${item.definitionOfDone}`), '',
  '## 映射问题', '', ...(mappingIssues.length ? mappingIssues.map(item => `- ${cell(JSON.stringify(item))}`) : ['无缺失或重命名测试绑定。']), '',
];
await writeFile(join(root, 'docs', 'coverage', '实际验收报告.md'), lines.join('\n'));
console.log(JSON.stringify({ outcome: report.outcome, baseline: baseline.count, summary, receipts: receipts.length, mappingIssues: mappingIssues.length, sourceIdentity: identity.sha256 }));
if (args.includes('--strict') && report.outcome !== 'passed') process.exitCode = 1;
