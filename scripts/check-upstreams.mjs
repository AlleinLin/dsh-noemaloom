import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const HOST_REPOSITORY = 'https://github.com/deepseek-ai/deepseek-harness';
const HOST_API = 'https://api.github.com/repos/deepseek-ai/deepseek-harness';
const parseVersion = value => typeof value === 'string'
  ? value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*))*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/) : null;
const numericCompare = (a, b) => BigInt(a) === BigInt(b) ? 0 : BigInt(a) > BigInt(b) ? 1 : -1;

/** SemVer precedence, including numbered prereleases; build metadata is not precedence. */
export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 1; i <= 3; i++) {
    const result = numericCompare(a[i], b[i]);
    if (result) return result;
  }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
  const ap = a[4].split('.'), bp = b[4].split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined || bp[i] === undefined) return ap[i] === undefined ? -1 : 1;
    if (ap[i] === bp[i]) continue;
    const an = /^\d+$/.test(ap[i]), bn = /^\d+$/.test(bp[i]);
    if (an && bn) return numericCompare(ap[i], bp[i]);
    if (an !== bn) return an ? -1 : 1;
    return ap[i] > bp[i] ? 1 : -1;
  }
  return 0;
}

export function classifyVersion(pinned, latest) {
  if (!pinned || !latest) return 'unavailable';
  if (pinned === latest) return 'unchanged';
  const comparison = compareVersions(pinned, latest);
  return comparison === null ? 'review' : comparison === 0 ? 'unchanged' : comparison < 0 ? 'upgrade' : 'older-tag';
}

async function fetchPublicJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000), headers: { 'User-Agent': 'dsh-noemaloom-upstream-audit' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

async function publicRef(url, tag) {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(url)) throw new Error('Unsupported public repository URL');
  if (tag !== undefined && !/^dsh-v[\da-zA-Z.+-]+$/.test(tag)) throw new Error('Invalid DSH release tag');
  const refs = tag ? [`refs/tags/${tag}`, `refs/tags/${tag}^{}`] : ['HEAD'];
  const result = await exec('git', ['-c', 'credential.interactive=false', '-c', 'credential.helper=', 'ls-remote', url, ...refs],
    { cwd: root, timeout: 30_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const rows = result.stdout.trim().split(/\r?\n/).map(line => line.split(/\s+/));
  const ref = tag ? `refs/tags/${tag}` : 'HEAD';
  const sha = rows.find(row => row[1] === `${ref}^{}`)?.[0] ?? rows.find(row => row[1] === ref)?.[0];
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error(`Remote did not return ${ref}`);
  return sha;
}

/** Inspect published releases (including RCs), never /releases/latest or mutable master as a release. */
export async function checkHostRelease({ fetchJson = fetchPublicJson, remoteTag = publicRef } = {}) {
  try {
    const releases = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await fetchJson(`${HOST_API}/releases?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('Invalid GitHub releases response');
      releases.push(...batch);
      if (batch.length < 100) break;
      if (page === 10) throw new Error('Release pagination limit reached; newest release is unconfirmed');
    }
    const eligible = releases.filter(row => !row.draft && row.published_at
      && /^dsh-v/.test(row.tag_name ?? '') && parseVersion(row.tag_name.slice(5)));
    eligible.sort((a, b) => compareVersions(b.tag_name.slice(5), a.tag_name.slice(5)));
    const release = eligible[0];
    if (!release) throw new Error('No published DSH version tag found');
    const revision = await remoteTag(HOST_REPOSITORY, release.tag_name);
    if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('Published release tag could not be resolved');
    return {
      status: 'observed', repository: HOST_REPOSITORY, version: release.tag_name.slice(5),
      tag: release.tag_name, revision, publishedAt: release.published_at, prerelease: !!release.prerelease,
      url: release.html_url, channel: 'published-including-prereleases', compatibility: 'not-validated',
    };
  } catch (error) { return { status: 'unavailable', error: error.message }; }
}

/** Complete the manifest's host boundary: direct dependencies, peers, dev tools and client injections. */
export function discoverHostPackages(manifest, existing, { hostVersion, baselineRevision } = {}) {
  const names = new Map();
  for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (name.startsWith('@deepseek-ai/')) {
        const row = names.get(name) ?? { version, declaredIn: [] };
        if (row.version !== version) throw new Error(`Conflicting host versions for ${name}`);
        row.declaredIn.push(section);
        names.set(name, row);
      }
    }
  }
  for (const name of manifest.dsh?.client?.inject ?? []) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue;
    const row = names.get(name) ?? { version: hostVersion, declaredIn: [] };
    row.declaredIn.push('dsh.client.inject');
    names.set(name, row);
  }
  const rows = new Map(existing.map(row => [row.package, row]));
  for (const [name, declaration] of names) {
    if (!declaration.version) throw new Error(`No host baseline version for ${name}`);
    const previous = rows.get(name);
    if (previous && previous.pinned?.version !== declaration.version) throw new Error(`Ledger/manifest host version mismatch: ${name}`);
    rows.set(name, previous ? { ...previous, declaredIn: declaration.declaredIn } : {
      id: `host:${name}`, package: name, kind: 'host-peer', repository: HOST_REPOSITORY,
      pinned: { version: declaration.version, ...(baselineRevision ? { revision: baselineRevision } : {}) },
      observed: {}, declaredIn: declaration.declaredIn,
      decision: 'Host boundary dependency; upgrade only with a validated matching Desktop release.',
    });
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function checkUpstreams(sources, { fetchJson = fetchPublicJson, remoteHead = publicRef, hostRelease } = {}) {
  const npmCache = new Map(), gitCache = new Map(), rows = [];
  let next = 0;
  const cached = (cache, key, action) => {
    if (!cache.has(key)) cache.set(key, Promise.resolve().then(action));
    return cache.get(key);
  };
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, async () => {
    while (next < sources.length) {
      const source = sources[next++], row = { id: source.id };
      const localPackage = source.package?.startsWith('@local/');
      if (localPackage) row.npmNotApplicable = 'Private source-only runtime; Git revision and vendored file hashes are the release identity.';
      if (source.package && !localPackage) try {
        const sameHost = source.kind === 'host-peer' && source.package.startsWith('@deepseek-ai/dsh-');
        if (sameHost && hostRelease && hostRelease.status !== 'observed') throw new Error(`DSH release unavailable: ${hostRelease.error}`);
        const requestedVersion = sameHost && hostRelease?.status === 'observed' ? hostRelease.version : 'latest';
        const url = `https://registry.npmjs.org/${encodeURIComponent(source.package)}/${encodeURIComponent(requestedVersion)}`;
        const latest = await cached(npmCache, url, () => fetchJson(url));
        if (!parseVersion(latest.version) || (latest.name !== undefined && latest.name !== source.package)
          || (requestedVersion !== 'latest' && latest.version !== requestedVersion)) throw new Error(`Registry package/version mismatch: ${source.package}@${requestedVersion}`);
        const pinnedPackageVersion = source.pinned?.publishedPackageVersion ?? source.pinned?.version;
        row.npm = { version: latest.version, integrity: latest.dist?.integrity ?? null,
          selector: requestedVersion, comparedPinnedVersion: pinnedPackageVersion ?? null,
          decision: classifyVersion(pinnedPackageVersion, latest.version) };
      } catch (error) { row.npmError = error.message; }
      if (source.repository) try {
        const head = await cached(gitCache, source.repository, () => remoteHead(source.repository));
        if (!/^[a-f0-9]{40}$/.test(head ?? '')) throw new Error('Remote HEAD was not resolved');
        row.git = { head, changed: source.observed?.head ? head !== source.observed.head : null,
          differsFromPinned: source.pinned?.revision ? head !== source.pinned.revision : null };
      } catch (error) { row.gitError = `Public repository check failed: ${error.message}`; }
      if (!source.package && !source.repository) row.unavailable = 'Upstream location was not supplied.';
      rows.push(row);
    }
  }));
  const failures = outcomes.filter(row => row.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(row => row.reason), 'Upstream worker failed; report would be incomplete');
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node scripts/check-upstreams.mjs --output <report.json>');
  const ledger = JSON.parse(await readFile(new URL('../upstreams.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const hostPackages = discoverHostPackages(manifest, ledger.hostPackages, { hostVersion: ledger.policy.hostVersion });
  const hostRelease = await checkHostRelease();
  const sources = [...ledger.sources, ...ledger.npmPlugins, ...hostPackages];
  const report = { schemaVersion: 2, checkedAt: new Date().toISOString(), supportedHost: ledger.policy.hostVersion,
    hostRelease, sources: await checkUpstreams(sources, { hostRelease }) };
  await writeFile(args[1], JSON.stringify(report, null, 2) + '\n');
  console.log(`Checked ${report.sources.length} entries. Release: ${hostRelease.version ?? hostRelease.error}. Pins were not changed. Report: ${args[1]}`);
}
