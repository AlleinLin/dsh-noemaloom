import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

export const BASELINE_SHA256 = '113bc7b9b60b4bf44d3645dc07209a3c65148ecddf54ac5dd7cba696b8049e1a';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const slash = value => value.split(sep).join('/');
export const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, ''));
export async function optionalJson(path, fallback = null) {
  try { return await json(path); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function inside(root, path) {
  const target = resolve(root, path), rel = relative(resolve(root), target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root) === target || /^[A-Za-z]:/u.test(rel)) throw new Error(`Evidence path must stay inside the delivery root: ${path}`);
  return target;
}
export async function filesUnder(directory) {
  const out = [];
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) out.push(...await filesUnder(path));
      else if (entry.isFile()) out.push(path);
      else throw new Error(`Delivery evidence/source cannot silently follow a link: ${path}`);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return out.sort();
}
/** Evidence hashes the actual implementation and tests, excluding mutable logs,
 * package output and the report itself. No user profile or machine data is read. */
export async function sourceIdentity(root) {
  const entries = [];
  for (const directory of ['src', 'tests', 'vendor', 'assets', 'locale', 'scripts', 'tools', 'evidence/runners']) {
    for (const path of await filesUnder(join(root, directory))) entries.push({ path: slash(relative(root, path)), sha256: sha256(await readFile(path)) });
  }
  for (const name of ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'cordis.patch.yml', 'cordis.presets.patch.yml', 'tsconfig.json', 'sources.lock.json']) {
    try { entries.push({ path: name, sha256: sha256(await readFile(join(root, name))) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { algorithm: 'sha256:path-and-content-v1', sha256: sha256(JSON.stringify(entries)), files: entries.length };
}
export async function readFrozenDefinitions(specification) {
  const baseline = await json(join(specification, 'acceptance-baseline.json'));
  if (baseline.count !== 769 || baseline.definitions.length !== 769 || baseline.sha256 !== BASELINE_SHA256 || sha256(JSON.stringify(baseline.definitions)) !== BASELINE_SHA256) throw new Error('Frozen acceptance baseline changed');
  const docs = new Map();
  const definitions = [];
  const seen = new Set();
  for (const item of baseline.definitions) {
    if (seen.has(item.id)) throw new Error(`Duplicate frozen assertion: ${item.id}`);
    seen.add(item.id);
    if (!docs.has(item.document)) docs.set(item.document, (await readFile(join(specification, item.document), 'utf8')).split(/\r?\n/u));
    const escaped = item.id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = new RegExp(`^\\s*(?:\\|\\s*|-\\s*\\*\\*|\\*\\*)${escaped}\\b`, 'u');
    const found = docs.get(item.document).flatMap((text, index) => pattern.test(text) ? [{ text, line: index + 1 }] : []);
    if (found.length !== 1 || sha256(found[0].text.trim()) !== item.sha256) throw new Error(`Frozen assertion removed, duplicated or changed: ${item.id}`);
    definitions.push({ ...item, line: found[0].line, originalText: found[0].text });
  }
  return { baseline, definitions };
}
const xmlDecode = value => value.replace(/&(?:(lt|gt|quot|apos|amp)|#(?:x([0-9a-f]+)|(\d+)));/giu,
  (_, named, hex, decimal) => named
    ? ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[named.toLowerCase()]
    : String.fromCodePoint(parseInt(hex ?? decimal, hex ? 16 : 10)));
function attrs(text) {
  return Object.fromEntries([...text.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)].map(match => [match[1], xmlDecode(match[2] ?? match[3])]));
}
/** Node's JUnit reporter is the only XML producer accepted here. DTD/entities are
 * rejected, and failure/skipped elements never become passed tests. */
export function readJUnit(xml) {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error('JUnit DTD/entities are not allowed');
  return [...xml.matchAll(/<testcase\b((?:"[^"]*"|'[^']*'|[^<>"'])*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu)].map(match => {
    const properties = attrs(match[1]), body = match[2] ?? '';
    return { name: properties.name ?? '', file: properties.file ?? properties.classname ?? null, durationSeconds: Number(properties.time) || 0,
      status: /<(?:failure|error)\b/u.test(body) ? 'failed' : /<skipped\b/u.test(body) ? 'skipped' : 'passed' };
  });
}
export async function validateReceipt(root, receipt, currentSourceHash) {
  const reasons = [];
  if (receipt.schemaVersion !== 1 || typeof receipt.id !== 'string' || !receipt.id || !receipt.kind) reasons.push('invalid-receipt-schema');
  if (receipt.sourceHash !== currentSourceHash) reasons.push('stale-or-missing-source-hash');
  if (receipt.sourceUnchangedDuringRun !== true) reasons.push('missing-or-failed-source-stability-observation');
  if (!receipt.startedAt || !receipt.finishedAt || !Number.isFinite(Date.parse(receipt.startedAt)) || !Number.isFinite(Date.parse(receipt.finishedAt)) || Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)) reasons.push('invalid-run-time');
  if (!Array.isArray(receipt.artifacts) || !receipt.artifacts.length) reasons.push('missing-observed-artifact');
  if (receipt.artifactErrors !== undefined && (!Array.isArray(receipt.artifactErrors) || receipt.artifactErrors.length)) reasons.push('requested-artifact-unavailable');
  const observed = new Map();
  for (const artifact of receipt.artifacts ?? []) {
    try {
      if (typeof artifact.path !== 'string' || !/^[a-f0-9]{64}$/u.test(artifact.sha256 ?? '')) throw new Error('invalid artifact');
      const path = inside(root, artifact.path);
      if (!(await lstat(path)).isFile()) throw new Error('not a regular artifact file');
      const bytes = await readFile(path);
      if (sha256(bytes) !== artifact.sha256) throw new Error('artifact hash mismatch');
      observed.set(artifact.path, bytes);
    } catch { reasons.push(`missing-or-changed-artifact:${String(artifact.path)}`); }
  }
  return { valid: reasons.length === 0, reasons, observed };
}
export function pointer(value, path) {
  if (path === '') return value;
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('Observation uses RFC6901 JSON pointer');
  return path.slice(1).split('/').reduce((at, key) => {
    const field = key.replace(/~1/gu, '/').replace(/~0/gu, '~');
    return at !== null && typeof at === 'object' && Object.hasOwn(at, field) ? at[field] : undefined;
  }, value);
}
/** Read actual saved observation values rather than trusting a hand-written
 * "PASS". Equality, limits and required field predicates remain reviewable. */
export function evaluateObservation(check, observed) {
  const bytes = observed.get(check.artifact);
  if (!bytes || !check.description || !check.expectedDescription || typeof check.pointer !== 'string') return { passed: false, reason: 'missing-observation-contract' };
  let actual;
  try { actual = pointer(JSON.parse(bytes.toString('utf8')), check.pointer); } catch { return { passed: false, reason: 'invalid-observation-json' }; }
  if (actual === undefined) return { passed: false, reason: 'observed-field-missing' };
  if (check.operator !== 'nonempty' && check.expected === undefined) return { passed: false, reason: 'missing-expected-value' };
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let passed = false;
  switch (check.operator) {
    case 'equals': passed = equal(actual, check.expected); break;
    case 'not-equals': passed = actual !== undefined && !equal(actual, check.expected); break;
    case 'at-least': passed = typeof actual === 'number' && Number.isFinite(actual) && typeof check.expected === 'number' && Number.isFinite(check.expected) && actual >= check.expected; break;
    case 'at-most': passed = typeof actual === 'number' && Number.isFinite(actual) && typeof check.expected === 'number' && Number.isFinite(check.expected) && actual <= check.expected; break;
    case 'includes': passed = (Array.isArray(actual) || typeof actual === 'string') && actual.includes(check.expected); break;
    case 'nonempty': passed = (Array.isArray(actual) || typeof actual === 'string') && actual.length > 0; break;
    default: return { passed: false, reason: 'unknown-observation-operator' };
  }
  return { passed, actual, expected: check.expected, operator: check.operator, description: check.description, artifact: check.artifact, pointer: check.pointer };
}
