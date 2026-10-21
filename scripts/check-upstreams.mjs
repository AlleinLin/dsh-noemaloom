import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const ledger = JSON.parse(await readFile(new URL('../upstreams.json', import.meta.url), 'utf8'));
const exec = promisify(execFile);
export function classifyVersion(pinned, latest) {
  if (!pinned || !latest) return 'unavailable';
  if (pinned === latest) return 'unchanged';
  const parts = text => text.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/)?.slice(1);
  const a = parts(pinned), b = parts(latest);
  if (!a || !b) return 'review';
  for (let i = 0; i < 3; i++) {
    if (+b[i] > +a[i]) return 'upgrade';
    if (+b[i] < +a[i]) return 'older-tag';
  }
  return 'review'; // prerelease ordering requires explicit compatibility review
}
export async function checkUpstreams(sources, { fetchJson, remoteHead } = {}) {
  fetchJson ??= async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  remoteHead ??= async url => {
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(url)) throw new Error('Unsupported public repository URL');
    const result = await exec('git', ['-c', 'credential.interactive=false', '-c', 'credential.helper=', 'ls-remote', url, 'HEAD'],
      { cwd: root, timeout: 30_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return result.stdout.match(/^([a-f0-9]{40})\s+HEAD/m)?.[1] ?? null;
  };
  const npmCache = new Map(), gitCache = new Map(), rows = [];
  let next = 0;
  const cached = (cache, key, action) => { if (!cache.has(key)) cache.set(key, action()); return cache.get(key); };
  await Promise.allSettled(Array.from({ length: 4 }, async () => {
    while (next < sources.length) {
      const source = sources[next++], row = { id: source.id };
      if (source.package) try {
        const latest = await cached(npmCache, source.package,
          () => fetchJson(`https://registry.npmjs.org/${encodeURIComponent(source.package)}/latest`));
        row.npm = { version: latest.version, integrity: latest.dist?.integrity ?? null,
          decision: classifyVersion(source.pinned?.version, latest.version) };
      } catch (error) { row.npmError = error.message; }
      if (source.repository) try {
        const head = await cached(gitCache, source.repository, () => remoteHead(source.repository));
        row.git = { head, changed: head !== source.observed?.head };
      } catch { row.gitError = 'Public repository could not be checked without credentials.'; }
      if (!source.package && !source.repository) row.unavailable = 'Upstream location was not supplied.';
      rows.push(row);
    }
  }));
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node scripts/check-upstreams.mjs --output <report.json>');
  const sources = [...ledger.sources, ...ledger.npmPlugins, ...ledger.hostPackages];
  const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), sources: await checkUpstreams(sources) };
  await writeFile(args[1], JSON.stringify(report, null, 2) + '\n');
  console.log(`Checked ${report.sources.length} entries. Pins were not changed. Report: ${args[1]}`);
}
