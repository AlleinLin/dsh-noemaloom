import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';
import { parseDocument } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });
const blockSize = 512;
const maxArchiveBytes = 256 * 1024 * 1024;
const maxTarBytes = 768 * 1024 * 1024;
const maxEntries = 30_000;
const hostModules = new Set([...builtinModules.map(name => name.replace(/^node:/u, '')), 'electron']);
const rootFiles = new Set(['package.json', 'README.md', 'README.en.md', 'LICENSE', 'LICENSE-ORIGINAL', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'sources.lock.json', 'cordis.patch.yml', 'cordis.presets.patch.yml']);
for (const directory of ['agent-instructions', 'tool-subagent', 'agent-procedures', 'nexus-terminal', 'compaction-basic']) {
  for (const file of ['LICENSE', 'SOURCE.json']) rootFiles.add(`vendor/${directory}/${file}`);
}
const runtimePrefixes = ['lib/', 'locale/', 'assets/', 'notices/', 'vendor/memory-cognition/', 'vendor/memsearch/'];
const privateDirectories = new Set(['.git', '.codegraph', 'node_modules', '__pycache__', '.venv', 'venv', '.dsh', '.codex', '.claude', '.ssh', '.aws', '.azure', '.gnupg', '.cache', 'profile', 'profiles', 'sessions', 'private-sessions']);
const requiredFiles = [
  'package.json', 'lib/index.js', 'lib/client.js', 'lib/compaction.js', 'lib/preset-runtime.js',
  'lib/project-rules.js', 'lib/subagent.js',
  'lib/native/agent-procedures.js', 'lib/native/dshell-terminal-bridge.js',
  'lib/native/dshell-mode.js', 'lib/native/dshell-ssh.js', 'lib/native/dshell-ssh-helper.js', 'lib/native/dshell-pty-console.js',
  'lib/native-capabilities-manifest.json',
  'vendor/agent-procedures/LICENSE', 'vendor/agent-procedures/SOURCE.json',
  'vendor/nexus-terminal/LICENSE', 'vendor/nexus-terminal/SOURCE.json',
  'vendor/agent-instructions/LICENSE', 'vendor/agent-instructions/SOURCE.json',
  'vendor/tool-subagent/LICENSE', 'vendor/tool-subagent/SOURCE.json',
  'vendor/compaction-basic/LICENSE', 'vendor/compaction-basic/SOURCE.json',
  'lib/workers/storage-worker.js', 'lib/workers/file-memory-parser.mjs', 'lib/workers/isolated-extension.js',
  'lib/build-info.json', 'cordis.patch.yml', 'cordis.presets.patch.yml',
  'locale/zh-CN.json', 'locale/en.json', 'locale/ru.json', 'assets/icon.svg',
  'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'sources.lock.json',
  'notices/step-pause/LICENSE', 'notices/step-pause/SOURCE.json',
  'notices/step-pause/index.upstream.js', 'notices/step-pause/package.upstream.json',
  'vendor/memory-cognition/nexus_bridge.py', 'vendor/memory-cognition/utf8_boot.py',
  'vendor/memory-cognition/package.json', 'vendor/memory-cognition/LICENSE',
  'vendor/memory-cognition/md_cg/__init__.py', 'vendor/memory-cognition/md_cg/mcp_server.py',
  'vendor/memory-cognition/md_cg/mdcos.py', 'vendor/memory-cognition/md_cg/cond_template.json',
  'vendor/memory-cognition/md_cg/semantic/atoms.json', 'vendor/memory-cognition/md_cg/lexicon/cedict_en_zh.json',
  'vendor/memory-cognition/data/policy.json', 'vendor/memory-cognition/hive/id_charset_blocks.txt',
  'vendor/memsearch/nexus_bridge.py', 'vendor/memsearch/pyproject.toml', 'vendor/memsearch/LICENSE',
  'vendor/memsearch/src/memsearch/__init__.py',
  ...['memory_to_skill', 'project_review', 'user_profile'].map(name => `vendor/memsearch/src/memsearch/prompts/${name}.txt`),
];

// Reviewed against the preserved upstream sources. An exception applies only
// to this rule, package-relative source path and complete unchanged source line.
// It never exempts a file, vendor tree, credential value or another path.
const reviewedSourceLines = [
  {
    id: 'memsearch-cli-embedding-key-reference',
    file: 'vendor/memsearch/src/memsearch/cli.py', rule: 'literal-credential-value',
    text: ['    "api_key"', ': "embedding.api_key",'].join(''),
    reason: 'Upstream CLI parameter maps to a dotted configuration field; this is a field reference.',
  },
  {
    id: 'mdcg-tilde-expansion-example',
    file: 'vendor/memory-cognition/md_cg/datapath.py', rule: 'absolute-user-path',
    text: '# 收敛代价（如实）：POSIX 上 MDCG_ROOT=~someone/mem 从「展开成 /home/someone/mem」',
    reason: 'Upstream comment explains generic named-user tilde expansion; it contains no machine identity.',
  },
  {
    id: 'mdcg-workspace-slug-example',
    file: 'vendor/memory-cognition/md_cg/session5.py', rule: 'absolute-user-path',
    text: '        /home/x/y → home_x_y',
    reason: 'Upstream pure-function docstring demonstrates path-to-slug normalization.',
  },
  {
    id: 'mdcg-forbidden-user-path-policy',
    file: 'vendor/memory-cognition/md_cg/interop.py', rule: 'absolute-user-path',
    text: '    (re.compile(r"/Users/|/home/"), "本机绝对路径（unix 家目录）"),',
    reason: 'Upstream security expression rejects user-home paths; it is policy syntax, not a user path.',
  },
  ...['vendor/nexus-terminal/packages/dshell/buffer/src/service.ts', 'lib/native/dshell-buffer.js'].map(file => ({
    id: 'dshell-pipe-world-example', file, rule: 'absolute-user-path',
    text: '   * ends in /home/reader" for a peer that lives elsewhere, so the panel takes',
    reason: 'Preserved upstream comment uses a generic reader home to explain local/remote namespace separation.',
  })),
  {
    id: 'dshell-session-directory-example',
    file: 'vendor/nexus-terminal/packages/dshell/files/src/route.ts', rule: 'absolute-user-path',
    text: " * `/home/reader` on the device is somebody else's directory or nobody's.",
    reason: 'Preserved upstream comment explains why a local example directory cannot identify a remote directory.',
  },
  {
    id: 'dshell-completion-example',
    file: 'vendor/nexus-terminal/packages/dshell/mode/src/client/completion.ts', rule: 'absolute-user-path',
    text: ' * `cd /home/wp<Tab>` had nowhere to go and Tab simply moved focus out.',
    reason: 'Preserved upstream comment is a path-completion keystroke example, not a path read from this machine.',
  },
  {
    id: 'dshell-mount-alias-example',
    file: 'vendor/nexus-terminal/packages/dshell/ssh/src/mount.ts', rule: 'absolute-user-path',
    text: '   * alias `read notes.md` asks the device for `/home/reader/notes.md`: a',
    reason: 'Preserved upstream comment demonstrates remote path aliasing with a generic reader directory.',
  },
];

// This fixed, public, key-shaped test string exercises file filtering only.
// Review requires both the complete unchanged fixture file and exact block.
// It is accepted only in synthetic source delivery, never a runtime package.
const reviewedSyntheticKeyFixture = {
  file: 'vendor/nexus-terminal/packages/dshell/ssh/tests/local-keys.spec.ts',
  fileSha256: 'f00f9c8abdf93a8e901179a797278f6449e0583839b703d0692270ed70e4a47c',
  blockSha256: '20c37c1e330853dc548068329aafcee66f6a2a28475b6fee9372f84c300df1e5',
};

/** Path-only exclusions are also used by the source ZIP collector. Public
 * certificates and .env.example remain source files; private material is
 * detected from its content instead of rejecting every .key/.pem extension. */
export function privatePathReason(path) {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean);
  if (parts.some(part => privateDirectories.has(part.toLowerCase()))) return 'private-or-generated-directory';
  if (parts.some(part => /^private-desktop-inspection(?:[._-]|$)/iu.test(part))) return 'private-desktop-inspection';
  const name = parts.at(-1) ?? '';
  // This preserved upstream file implements the credential vault; its content
  // is scanned by the same credential rules as every other source member.
  if (path.replaceAll('\\', '/') === 'vendor/nexus-terminal/packages/dshell/ssh/src/credentials.ts') return null;
  if (/^\.env(?:\..*)?$/iu.test(name) && !/^\.env\.(?:example|sample|template)$/iu.test(name)) return 'environment-configuration';
  if (/^(?:\.npmrc|\.pypirc|\.netrc|_netrc|\.credentials.*|credentials(?:\.[^.]+)?|auth\.json|accounts\.json|master\.key|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.ppk)?)$/iu.test(name)) return 'credential-file';
  if (/\.(?:pfx|p12|jks|keystore|bak|pyc|pyo|sqlite(?:3)?(?:-(?:wal|shm))?|db(?:-(?:wal|shm))?)$/iu.test(name)) return 'private-state-or-backup';
  if (/(?:recovery-snapshot|profile-copy|machine-backup)/iu.test(name)) return 'machine-backup';
  return null;
}

function placeholder(value, syntheticSource = false) {
  const payload = syntheticSource ? value.replace(/^(?:sk-(?:proj-|ant-api\d+-)?|gh[pousr]_|github_pat_|xox[baprs]-)/u, '') : value;
  return /^(?:test|fake|dummy|example|placeholder|redacted|your[-_]|change[-_]?me|not[-_]?a[-_]?real)[-_a-z0-9]*$/iu.test(value)
    || syntheticSource && /^(?:test|fake|dummy|example|placeholder|redacted)(?:[-_]|$)/iu.test(payload)
    || /^(?:pass(?:word)?|secret|token|undefined|null)$/iu.test(value)
    || /^(.)\1{11,}$/u.test(payload)
    || /^AKIAIOSFODNN7EXAMPLE$/u.test(value)
    || /EXAMPLEKEY$/u.test(value)
    || value.includes('${') || value.includes('<') || value.includes('>');
}

/** Findings never contain the matched secret or a source excerpt. This is a
 * static shape scan, not an assertion that credentials were authenticated. */
export function inspectContentSafety(bytes, { localUserPaths = true, syntheticSource = false, filePath, reviewedMatches = [] } = {}) {
  const original = bytes.toString('utf8');
  const lines = original.split(/\r?\n/u);
  const findings = [];
  const recordLine = (rule, line) => {
    const review = reviewedSourceLines.find(item => item.rule === rule && item.file === filePath && item.text === lines[line - 1]);
    if (review) {
      if (!reviewedMatches.some(item => item.reviewId === review.id && item.line === line)) {
        reviewedMatches.push({ reviewId: review.id, rule, line, reason: review.reason });
      }
      return;
    }
    if (!findings.some(item => item.rule === rule && item.line === line)) findings.push({ rule, line });
  };
  const record = (rule, index) => recordLine(rule, original.slice(0, index).split('\n').length);
  const tokenPatterns = [
    ['provider-api-token', /\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/gu],
    ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu],
    ['signed-token', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/gu],
  ];
  for (const [rule, pattern] of tokenPatterns) {
    for (const match of original.matchAll(pattern)) if (!placeholder(match[0], syntheticSource)) record(rule, match.index);
  }
  const assignments = /(?<![\p{ID_Continue}$])(?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)(?![\p{ID_Continue}$])["']?)\s*[:=]\s*["']((?:Bearer\s+)?[A-Za-z0-9_./+=~!@#$%^&*()-]{12,})["']/giu;
  for (const match of original.matchAll(assignments)) {
    if (!placeholder(match[1].replace(/^Bearer\s+/iu, ''), syntheticSource)) record('literal-credential-value', match.index);
  }
  const privateKeys = /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----([\s\S]{1,32768}?)-----END \1-----/gu;
  for (const match of original.matchAll(privateKeys)) {
    const payload = match[2].replace(/\\[rn]|[\r\n\s]/gu, '');
    if (/^[A-Za-z0-9+/=]{64,}$/u.test(payload) && !placeholder(payload)) {
      if (syntheticSource && filePath === reviewedSyntheticKeyFixture.file
        && sha256(bytes) === reviewedSyntheticKeyFixture.fileSha256
        && sha256(Buffer.from(match[0])) === reviewedSyntheticKeyFixture.blockSha256) {
        reviewedMatches.push({ reviewId: 'dshell-local-key-filter-fixture', rule: 'private-key-material',
          line: original.slice(0, match.index).split('\n').length,
          reason: 'Exact unchanged public synthetic key-shaped file-filter fixture; accepted only in source ZIP.' });
      } else record('private-key-material', match.index);
    }
  }
  for (const match of original.matchAll(/\bhttps?:\/\/([^/@\s:"']+):([^/@\s"']{8,})@/gu)) {
    if (!placeholder(match[2])) record('url-credential', match.index);
  }
  if (localUserPaths) {
    const harmlessUsers = /^(?:user|username|yourname|example|test|runner|nobody|public|default|all users|<[^>]+>|\$\{[^}]+\}|%[^%]+%)$/iu;
    const paths = /(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|\/(?:Users|home)\/)([^\\/\s"'<>:]+)(?=[\\/]|\b)/gu;
    const currentUserHome = homedir().replaceAll('\\', '/').replace(/\/$/u, '').toLowerCase();
    for (let index = 0; index < lines.length; index++) {
      // Preserve source line identity while recognizing escaped literal paths.
      const normalized = lines[index].replace(/\\u005[cC]/gu, '\\').replace(/\\u002[fF]/gu, '/').replace(/\\{2,}/gu, '\\').replace(/\\\//gu, '/');
      for (const match of normalized.matchAll(paths)) {
        if (!harmlessUsers.test(match[1])) recordLine('absolute-user-path', index + 1);
      }
      if (currentUserHome.length > 3 && normalized.replaceAll('\\', '/').toLowerCase().includes(currentUserHome)) recordLine('absolute-user-path', index + 1);
    }
  }
  return findings;
}

function sourceMapPath(mapPath, sourceRoot, source) {
  if (typeof source !== 'string' || !source || /[\\\u0000-\u001f]/u.test(source)
    || typeof sourceRoot !== 'string' || /[\\\u0000-\u001f]/u.test(sourceRoot)
    || /^(?:\/|[A-Za-z][A-Za-z0-9+.-]*:)/u.test(source) || /^(?:\/|[A-Za-z][A-Za-z0-9+.-]*:)/u.test(sourceRoot)) throw new Error('Source map names must be relative package source paths');
  const path = posix.normalize(posix.join(posix.dirname(mapPath), sourceRoot, source));
  if (!path || path === '..' || path.startsWith('../') || path.startsWith('/') || /^[A-Za-z]:/u.test(path)) throw new Error('Source map names escape the package source namespace');
  return path;
}

function parseSourceMapJson(filePath, bytes) {
  const text = decoder.decode(bytes);
  const value = JSON.parse(text);
  // JSON.parse retains only the last duplicate property. Reject duplicates
  // before any content can disappear from the scan, including nested metadata.
  const syntax = ts.parseJsonText(filePath, text);
  if (syntax.parseDiagnostics.length) throw new Error('Invalid source map JSON');
  const visit = node => {
    if (ts.isObjectLiteralExpression(node)) {
      const keys = new Set();
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) throw new Error('Invalid source map JSON property');
        if (keys.has(property.name.text)) throw new Error('Duplicate source map JSON property');
        keys.add(property.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return value;
}

/** Source-map payloads are decoded and scanned under each original source's
 * relative name. Metadata is scanned separately; no whole-map exception exists. */
export function inspectArtifactSafety(filePath, bytes, options = {}) {
  const reviewedMatches = [], findings = [], sources = [];
  if (!filePath.endsWith('.map')) {
    findings.push(...inspectContentSafety(bytes, { ...options, filePath, reviewedMatches }));
    return { findings, reviewedMatches, sources };
  }
  let map;
  try { map = parseSourceMapJson(filePath, bytes); }
  catch { throw new Error('Invalid or duplicate-property source map JSON'); }
  if (!map || map.version !== 3 || !Array.isArray(map.sources) || !Array.isArray(map.sourcesContent)
    || map.sources.length !== map.sourcesContent.length || map.sources.length > maxEntries
    || map.sourcesContent.some(content => typeof content !== 'string') || map.sourceRoot !== undefined && typeof map.sourceRoot !== 'string'
    || map.sections !== undefined) throw new Error('Source maps must contain a complete flat source list with embedded source text');
  const { sourcesContent, ...metadata } = map;
  findings.push(...inspectContentSafety(Buffer.from(JSON.stringify(metadata)), { ...options, filePath, reviewedMatches }));
  const seen = new Set();
  for (let index = 0; index < map.sources.length; index++) {
    const source = sourceMapPath(filePath, map.sourceRoot ?? '', map.sources[index]);
    if (seen.has(source)) throw new Error('Duplicate source map source identity');
    seen.add(source);
    const content = Buffer.from(sourcesContent[index]);
    const sourceReviews = [];
    findings.push(...inspectContentSafety(content, { ...options, filePath: source, reviewedMatches: sourceReviews }).map(finding => ({ ...finding, source })));
    reviewedMatches.push(...sourceReviews.map(review => ({ ...review, source })));
    sources.push({ source, bytes: content.length, sha256: sha256(content) });
  }
  return { findings, reviewedMatches, sources };
}

function fieldText(header, start, length) {
  const field = header.subarray(start, start + length);
  const zero = field.indexOf(0);
  if (zero >= 0 && field.subarray(zero).some(byte => byte !== 0)) throw new Error('Noncanonical NUL in tar header');
  return decoder.decode(zero < 0 ? field : field.subarray(0, zero));
}

function tarNumber(field) {
  if (field[0] & 0x80) {
    if (field[0] & 0x40) throw new Error('Negative tar numeric field');
    let number = BigInt(field[0] & 0x7f);
    for (const byte of field.subarray(1)) number = number * 256n + BigInt(byte);
    if (number > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Oversized tar numeric field');
    return Number(number);
  }
  const text = field.toString('ascii').replace(/\0.*$/su, '').trim();
  if (!/^[0-7]*$/u.test(text)) throw new Error('Invalid tar numeric field');
  const number = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Oversized tar numeric field');
  return number;
}

function readPax(bytes) {
  const result = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) throw new Error('Invalid PAX length');
    const count = bytes.subarray(offset, space).toString('ascii');
    if (!/^[1-9]\d*$/u.test(count)) throw new Error('Invalid PAX length');
    const length = Number(count);
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > bytes.length || bytes[offset + length - 1] !== 0x0a) throw new Error('Truncated PAX record');
    const record = decoder.decode(bytes.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf('=');
    if (equals < 1) throw new Error('Invalid PAX assignment');
    const key = record.slice(0, equals);
    if (key.startsWith('GNU.sparse.') || key === 'SCHILY.filetype') throw new Error('Sparse or special PAX entries are not allowed');
    result[key] = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

function memberPath(name, directory) {
  if (!name || /[\\\u0000-\u001f\u007f]/u.test(name) || name.startsWith('/') || /^[A-Za-z]:/u.test(name)) throw new Error('Unsafe tar member path');
  const canonical = directory ? name.replace(/\/$/u, '') : name;
  const parts = canonical.split('/');
  if (parts[0] !== 'package' || parts.some(part => !part || part === '.' || part === '..'
    || /[<>:"|?*]/u.test(part) || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw new Error('Tar member is outside the canonical package namespace');
  if (parts.length === 1 && !directory) throw new Error('Package root must be a directory');
  return parts.slice(1).join('/');
}

/** Parse regular ustar/PAX/GNU-longname members without extracting any file. */
function readTar(bytes) {
  if (bytes.length % blockSize !== 0) throw new Error('Tar length is not block aligned');
  const entries = [];
  const seen = new Set();
  const fileKeys = new Set(), requiredDirectories = new Set();
  let offset = 0, globalPax = {}, nextPax = {}, longName = null, metadataCount = 0;
  while (offset + blockSize <= bytes.length) {
    const header = bytes.subarray(offset, offset + blockSize);
    if (header.every(byte => byte === 0)) {
      if (offset + blockSize * 2 > bytes.length || bytes.subarray(offset).some(byte => byte !== 0)) throw new Error('Invalid tar terminator or trailing payload');
      if (Object.keys(nextPax).length || longName !== null) throw new Error('Dangling tar metadata');
      return { entries, metadataCount };
    }
    const expected = tarNumber(header.subarray(148, 156));
    let unsigned = 0, signed = 0;
    for (let index = 0; index < blockSize; index++) {
      const byte = index >= 148 && index < 156 ? 0x20 : header[index];
      unsigned += byte;
      signed += byte > 127 ? byte - 256 : byte;
    }
    if (expected !== unsigned && expected !== signed) throw new Error('Tar header checksum mismatch');
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = fieldText(header, 345, 155);
    const basicName = `${prefix ? `${prefix}/` : ''}${fieldText(header, 0, 100)}`;
    const metadata = ['x', 'g', 'L'].includes(type);
    const pax = { ...globalPax, ...nextPax };
    let size = tarNumber(header.subarray(124, 136));
    if (!metadata && pax.size !== undefined) {
      if (!/^\d+$/u.test(pax.size) || !Number.isSafeInteger(Number(pax.size))) throw new Error('Invalid PAX member size');
      size = Number(pax.size);
    }
    const start = offset + blockSize, end = start + size;
    const nextOffset = start + Math.ceil(size / blockSize) * blockSize;
    if (size > maxTarBytes || end > bytes.length || nextOffset > bytes.length) throw new Error('Truncated tar member');
    if (bytes.subarray(end, nextOffset).some(byte => byte !== 0)) throw new Error('Nonzero tar padding');
    const data = bytes.subarray(start, end);
    offset = nextOffset;
    if (metadata) {
      if (++metadataCount > maxEntries) throw new Error('Too many tar metadata records');
      if (type === 'L') {
        const zero = data.indexOf(0);
        if (zero >= 0 && data.subarray(zero).some(byte => byte !== 0)) throw new Error('Invalid GNU longname');
        longName = decoder.decode(zero < 0 ? data : data.subarray(0, zero));
      } else if (type === 'g') globalPax = { ...globalPax, ...readPax(data) };
      else nextPax = { ...nextPax, ...readPax(data) };
      continue;
    }
    if (type !== '0' && type !== '5') throw new Error('Tar links, devices and other special entries are not allowed');
    if (fieldText(header, 157, 100) || pax.linkpath) throw new Error('Unexpected tar link target');
    if (type === '5' && size !== 0) throw new Error('Tar directory has a payload');
    if (tarNumber(header.subarray(100, 108)) & 0o7000) throw new Error('Privileged tar member mode is not allowed');
    const path = memberPath(pax.path ?? longName ?? basicName, type === '5');
    const key = path.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate or Windows-colliding tar member');
    if (type === '0' && requiredDirectories.has(key)) throw new Error('Tar file collides with an existing directory');
    const parts = key.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/');
      if (fileKeys.has(parent)) throw new Error('Tar member descends through a regular file');
      requiredDirectories.add(parent);
    }
    seen.add(key);
    if (type === '0') fileKeys.add(key);
    if (entries.length >= maxEntries) throw new Error('Too many tar members');
    entries.push({ path, type: type === '5' ? 'directory' : 'file', data, size });
    nextPax = {};
    longName = null;
  }
  throw new Error('Tar is missing its end blocks');
}

function exportTargets(value, result = []) {
  if (typeof value === 'string') result.push(value);
  else if (value === null) return result;
  else if (Array.isArray(value)) for (const item of value) exportTargets(item, result);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) exportTargets(item, result);
  else throw new Error('Invalid package exports shape');
  return result;
}

function targetPattern(target) {
  if (!target.startsWith('./') || /[\\\u0000-\u001f]/u.test(target) || target.slice(2).split('/').some(part => !part || part === '.' || part === '..' || part === 'node_modules')) throw new Error('Unsafe package export target');
  return new RegExp(`^${target.slice(2).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('(.+)')}$`, 'u');
}

function propertyName(node) {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : null;
}

function inspectClient(text, name) {
  const source = ts.createSourceFile('client.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length || source.statements.length !== 1 || !ts.isExpressionStatement(source.statements[0])) throw new Error('Client is not a single valid official loader expression');
  const call = source.statements[0].expression;
  if (!ts.isCallExpression(call) || call.expression.getText(source) !== 'window.__ModuleLoader__.load' || call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0])) throw new Error('Missing official client loader');
  const properties = call.arguments[0].properties;
  if (properties.length !== 2 || properties.some(item => !ts.isPropertyAssignment(item))) throw new Error('Invalid client loader descriptor');
  const byName = new Map(properties.map(item => [propertyName(item.name), item.initializer]));
  const id = byName.get('id'), factory = byName.get('factory');
  if (!id || !ts.isStringLiteral(id) || id.text !== name || !factory || !(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))
    || factory.parameters.length !== 1 || !ts.isIdentifier(factory.parameters[0].name) || factory.parameters[0].name.text !== 'require'
    || !ts.isBlock(factory.body) || factory.modifiers?.some(item => item.kind === ts.SyntaxKind.AsyncKeyword) || factory.asteriskToken) throw new Error('Invalid client module identity or lazy factory');
  const last = factory.body.statements.at(-1);
  if (!last || !ts.isReturnStatement(last) || last.expression?.getText(source) !== 'module.exports') throw new Error('Client factory does not return module.exports');
  const imports = new Set();
  const visit = node => {
    if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression) && /^(?:require|__require)$/u.test(node.expression.text) || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) throw new Error('Unresolved dynamic module in browser factory');
      const module = node.arguments[0].text;
      if (module.startsWith('node:') || hostModules.has(module)) throw new Error('Browser factory imports a host module');
      imports.add(module);
    }
    ts.forEachChild(node, visit);
  };
  visit(factory.body);
  if (!imports.has('react') && !imports.has('react/jsx-runtime')) throw new Error('Client does not use the shared React module');
  if (/__SECRET_INTERNALS|__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE|react\.(?:production|development)(?:\.min)?\.js/u.test(text)) throw new Error('Client contains a bundled React implementation');
  return { id: id.text, lazyFactory: true, executedFactory: false, externalModules: [...imports].sort() };
}

function parseYaml(bytes) {
  const document = parseDocument(decoder.decode(bytes), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  if (document.errors.length) throw new Error('Invalid bundle patch YAML');
  return document.toJS({ maxAliasCount: 100 });
}

function objects(value, result = []) {
  if (Array.isArray(value)) for (const item of value) objects(item, result);
  else if (value && typeof value === 'object') {
    result.push(value);
    for (const item of Object.values(value)) objects(item, result);
  }
  return result;
}

async function writeEvidence(outputPath, report) {
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);
  await writeFile(`${outputPath}.sha256`, `${sha256(bytes)}  ${basename(outputPath)}\n`);
  return sha256(bytes);
}

export async function auditPackage({ packagePath, outputPath = resolve(root, 'evidence/package-audit.json'), expectedManifest, npmFiles } = {}) {
  if (!packagePath) throw new Error('A .tgz package path is required');
  const report = {
    schemaVersion: 1, kind: 'package-audit', generatedAt: new Date().toISOString(),
    packageFile: basename(packagePath), packageSha256: null, packageBytes: null,
    auditedActualTarball: true, extractedFiles: false, executedPackageCode: false,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    passed: false, checks: {}, violations: [], files: [],
  };
  const fail = (rule, file, message, extra = {}) => report.violations.push({ rule, ...(file ? { file } : {}), message, ...extra });
  const check = (name, action) => {
    const before = report.violations.length;
    try { action(); } catch (error) { fail(name, null, error.message); }
    report.checks[name] = report.violations.length === before;
  };
  let entries = [], files = new Map(), manifest = null;
  try {
    const info = await stat(packagePath);
    if (!info.isFile() || info.size > maxArchiveBytes) throw new Error('Package must be a bounded regular .tgz file');
    const packageBytes = await readFile(packagePath);
    report.packageSha256 = sha256(packageBytes);
    report.packageBytes = packageBytes.length;
    const parsed = readTar(gunzipSync(packageBytes, { maxOutputLength: maxTarBytes }));
    entries = parsed.entries;
    files = new Map(entries.filter(entry => entry.type === 'file').map(entry => [entry.path, entry]));
    report.tar = { format: 'gzip+ustar/pax', metadataRecords: parsed.metadataCount, members: entries.length, regularFiles: files.size, uncompressedFileBytes: [...files.values()].reduce((sum, entry) => sum + entry.size, 0) };
    report.files = [...files.values()].map(entry => ({ path: entry.path, bytes: entry.size, sha256: sha256(entry.data) })).sort((a, b) => a.path.localeCompare(b.path, 'en'));
    report.checks.tarIntegrityAndSafePaths = true;
  } catch (error) {
    report.checks.tarIntegrityAndSafePaths = false;
    fail('tarIntegrityAndSafePaths', null, error.code ? `Cannot read package (${error.code})` : error.message);
  }
  if (report.checks.tarIntegrityAndSafePaths) {
    check('runtimeOnlyContents', () => {
      for (const entry of entries) {
        if (!entry.path && entry.type === 'directory') continue;
        const reason = privatePathReason(entry.path);
        if (reason) fail('runtimeOnlyContents', entry.path, reason);
        const allowed = rootFiles.has(entry.path) || runtimePrefixes.some(prefix => entry.path.startsWith(prefix) || entry.type === 'directory' && entry.path === prefix.slice(0, -1))
          || entry.type === 'directory' && ['vendor', 'vendor/agent-instructions', 'vendor/tool-subagent', 'vendor/agent-procedures', 'vendor/nexus-terminal', 'vendor/compaction-basic'].includes(entry.path);
        if (!allowed) fail('runtimeOnlyContents', entry.path, 'File is outside the runtime package allowlist');
        if (/(?:^|\/)(?:tests?|__tests__|research|plugin-sources)(?:\/|$)/iu.test(entry.path) || /(?:^|\/)(?:test_.*\.py|.*(?:\.test|\.spec)\.[cm]?[jt]sx?)$/iu.test(entry.path)) fail('runtimeOnlyContents', entry.path, 'Research repository or test payload is not an install runtime');
      }
    });
    check('credentialAndUserPathScan', () => {
      let scannedBytes = 0;
      const reviewedMatches = [], sourceMaps = [];
      for (const entry of files.values()) {
        scannedBytes += entry.size;
        let result;
        try { result = inspectArtifactSafety(entry.path, entry.data); }
        catch (error) { fail('credentialAndUserPathScan', entry.path, error.message); continue; }
        for (const finding of result.findings) fail('credentialAndUserPathScan', entry.path, finding.rule, {
          ...(finding.line ? { line: finding.line } : {}), ...(finding.source ? { source: finding.source } : {}),
        });
        reviewedMatches.push(...result.reviewedMatches.map(review => ({ file: entry.path, ...review })));
        if (result.sources.length) sourceMaps.push({ file: entry.path, sources: result.sources });
      }
      report.contentScan = {
        files: files.size, bytes: scannedBytes, matchedValuesRecorded: false,
        rules: ['private-key-material', 'provider-api-token', 'aws-access-key', 'signed-token', 'literal-credential-value', 'url-credential', 'absolute-user-path'],
        reviewedMatchPolicy: 'exact-rule-source-path-and-complete-unchanged-source-line',
        reviewedMatches, sourceMaps,
      };
    });
    check('requiredRuntimeResources', () => {
      for (const path of requiredFiles) if (!files.get(path)?.size) fail('requiredRuntimeResources', path, 'Missing or empty required runtime file');
    });
    check('packageManifest', () => {
      manifest = JSON.parse(decoder.decode(files.get('package.json')?.data ?? Buffer.alloc(0)));
      if (manifest.name !== '@local/dsh-nexus' || typeof manifest.version !== 'string' || !manifest.version || manifest.type !== 'module' || manifest.private !== true) throw new Error('Unexpected package identity/type/privacy');
      if (manifest.engines?.dsh !== '0.2.1-rc.2') throw new Error('Package must target exact DSH 0.2.1-rc.2');
      if (expectedManifest && (manifest.name !== expectedManifest.name || manifest.version !== expectedManifest.version || JSON.stringify(manifest.exports) !== JSON.stringify(expectedManifest.exports) || JSON.stringify(manifest.dsh) !== JSON.stringify(expectedManifest.dsh))) throw new Error('Tarball manifest differs from the packing source manifest');
      report.package = { name: manifest.name, version: manifest.version, dsh: manifest.engines.dsh };
    });
    check('exports', () => {
      if (!manifest?.exports || typeof manifest.exports !== 'object') throw new Error('Package exports are missing');
      const required = { '.': './lib/index.js', './compaction': './lib/compaction.js', './preset-runtime': './lib/preset-runtime.js', './project-rules': './lib/project-rules.js', './subagent': './lib/subagent.js', './client': './lib/client.js', './icon': './assets/icon.svg', './locale/*.json': './locale/*.json' };
      for (const [key, target] of Object.entries(required)) if (manifest.exports[key] !== target) fail('exports', 'package.json', `Missing required export ${key}`);
      const targets = exportTargets(manifest.exports);
      for (const target of targets) {
        const pattern = targetPattern(target);
        if (![...files.values()].some(entry => entry.size && pattern.test(entry.path))) fail('exports', 'package.json', `Export target has no nonempty regular file: ${target}`);
      }
      report.exportTargets = targets;
    });
    check('bundlePatches', () => {
      if (JSON.stringify(manifest?.dsh?.bundle?.patch) !== JSON.stringify(['./cordis.patch.yml', './cordis.presets.patch.yml'])) throw new Error('Both official composition patches must be declared in order');
      const host = parseYaml(files.get('cordis.patch.yml')?.data ?? Buffer.alloc(0));
      if (!Array.isArray(host) || !host.some(row => Array.isArray(row.insert) && row.insert.some(item => item.id === 'nexus' && item.name === manifest.name))) throw new Error('Host patch does not install the Nexus host row');
      const presets = parseYaml(files.get('cordis.presets.patch.yml')?.data ?? Buffer.alloc(0));
      if (!Array.isArray(presets)) throw new Error('Preset patch must be an array');
      for (const id of ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis']) {
        const row = presets.find(item => item.id === id);
        if (!row || !objects(row).some(item => item.name === `${manifest.name}/compaction`)) fail('bundlePatches', 'cordis.presets.patch.yml', `Missing compaction replacement for ${id}`);
      }
      const inserted = presets.flatMap(row => Array.isArray(row.insert) ? row.insert : []);
      for (const id of ['suite.windows-coding', 'suite.windows-gitbash', 'suite.adaptive-standard']) {
        const row = inserted.find(item => item.config?.id === id);
        if (!row || !objects(row).some(item => item.name === `${manifest.name}/compaction`) || !objects(row).some(item => item.name === `${manifest.name}/preset-runtime`)) fail('bundlePatches', 'cordis.presets.patch.yml', `Missing runtime/compaction composition for ${id}`);
      }
    });
    check('clientFactoryAndIsolation', () => { report.client = inspectClient(decoder.decode(files.get('lib/client.js')?.data ?? Buffer.alloc(0)), manifest?.name); });
    check('localeAndBuildIdentity', () => {
      for (const path of ['locale/zh-CN.json', 'locale/en.json', 'locale/ru.json']) {
        const value = JSON.parse(decoder.decode(files.get(path)?.data ?? Buffer.alloc(0)));
        if (!value || typeof value !== 'object' || !Object.keys(value).length) fail('localeAndBuildIdentity', path, 'Locale must be a nonempty JSON dictionary');
      }
      const info = JSON.parse(decoder.decode(files.get('lib/build-info.json')?.data ?? Buffer.alloc(0)));
      if (info.package !== manifest?.name || info.version !== manifest?.version || info.dsh !== '0.2.1-rc.2') throw new Error('Build identity does not match the tarball manifest');
      for (const path of ['lib/index.js', 'lib/client.js']) if (info[path] !== sha256(files.get(path)?.data ?? Buffer.alloc(0))) fail('localeAndBuildIdentity', path, 'Build identity SHA does not match actual packaged bytes');
    });
    check('provenance', () => {
      const lock = JSON.parse(decoder.decode(files.get('sources.lock.json')?.data ?? Buffer.alloc(0)));
      if (lock.sourceCount !== 37 || lock.dshWebSubpackageCount !== 19 || lock.host?.release !== '0.2.1-rc.2'
        || lock.acceptance?.count !== 769 || lock.acceptance?.sha256 !== '113bc7b9b60b4bf44d3645dc07209a3c65148ecddf54ac5dd7cba696b8049e1a') throw new Error('Packaged source identity or frozen acceptance provenance is incomplete');
      if (!Array.isArray(lock.units) || lock.units.length !== 37 || new Set(lock.units.map(unit => unit.id)).size !== 37) throw new Error('Packaged source provenance must identify all 37 sources');
      const progress = JSON.parse(decoder.decode(files.get('notices/step-pause/SOURCE.json')?.data ?? Buffer.alloc(0)));
      if (progress.revision !== 'eeb93a7ff027e4beba94b8089dfb72dfe45b2550' || progress.license !== 'MIT') throw new Error('Step progress source identity is missing');
      for (const [name, identity] of Object.entries(progress.files ?? {})) {
        const path = `notices/step-pause/${name}`, expected = lock.actualReusedFileHashes?.[path];
        if (!expected || identity.sha256 !== expected || sha256(files.get(path)?.data ?? Buffer.alloc(0)) !== expected) throw new Error(`Step progress upstream evidence changed: ${path}`);
      }
      for (const id of ['DSH-agent-procedures', 'Nexus-Aethra/Nexus-Terminal']) {
        if (!lock.nativeArchives?.some(source => source.identity === id && /^[a-f0-9]{64}$/u.test(source.sha256))) throw new Error(`Missing native archive provenance: ${id}`);
      }
    });
    if (npmFiles) check('npmMetadataAgreement', () => {
      if (!Array.isArray(npmFiles)) throw new Error('npm pack metadata did not provide its file list');
      const listed = new Set();
      for (const item of npmFiles) {
        const entry = files.get(item.path);
        if (!entry || listed.has(item.path) || typeof item.size === 'number' && item.size !== entry.size) fail('npmMetadataAgreement', item.path, 'npm pack metadata differs from actual tar member');
        listed.add(item.path);
      }
      for (const path of files.keys()) if (!listed.has(path)) fail('npmMetadataAgreement', path, 'Actual tar member is absent from npm pack metadata');
    });
  }
  report.passed = Object.keys(report.checks).length > 0 && Object.values(report.checks).every(Boolean) && report.violations.length === 0;
  const evidenceSha256 = await writeEvidence(outputPath, report);
  return { report, evidenceSha256, outputPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let packagePath, outputPath;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--output') outputPath = args[++index];
    else if (args[index] === '--package') packagePath = args[++index];
    else if (!args[index].startsWith('-') && !packagePath) packagePath = args[index];
    else throw new Error('Usage: node scripts/audit-package.mjs <package.tgz> [--output evidence/package-audit.json]');
  }
  if (!packagePath || args.at(-1) === '--output' || args.at(-1) === '--package') throw new Error('A package path and values for options are required');
  const result = await auditPackage({ packagePath: resolve(packagePath), ...(outputPath ? { outputPath: resolve(outputPath) } : {}) });
  console.log(JSON.stringify({ passed: result.report.passed, packageFile: result.report.packageFile, packageSha256: result.report.packageSha256, evidenceFile: basename(result.outputPath), evidenceSha256: result.evidenceSha256, checks: result.report.checks, violations: result.report.violations }, null, 2));
  if (!result.report.passed) process.exitCode = 1;
}
