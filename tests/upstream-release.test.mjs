import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { checkHostRelease, checkUpstreams, classifyVersion, compareVersions, discoverHostPackages } from '../scripts/check-upstreams.mjs';
import { EXPECTED_DSH_VERSION, EXPECTED_DSH_REVISION } from '../src/shared/host-compatibility.ts';

const sha = 'a'.repeat(40), other = 'b'.repeat(40);
const release = (version, overrides = {}) => ({
  tag_name: `dsh-v${version}`, published_at: '2026-10-23T15:26:39Z',
  html_url: `https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v${version}`,
  target_commitish: 'master', prerelease: version.includes('-'), ...overrides,
});

test('version precedence handles RCs, stable releases, numeric identifiers and build metadata', () => {
  assert.equal(classifyVersion('0.2.1-rc.2', '0.2.1-rc.3'), 'upgrade');
  assert.equal(classifyVersion('0.2.1-rc.9', '0.2.1-rc.10'), 'upgrade');
  assert.equal(classifyVersion('0.2.1', '0.2.1-rc.3'), 'older-tag');
  assert.equal(classifyVersion('0.2.1-rc.3', '0.2.1'), 'upgrade');
  assert.equal(classifyVersion('1.0.0+a', '1.0.0+b'), 'unchanged');
  assert.equal(classifyVersion('0.2.1-rc.02', '0.2.1-rc.3'), 'review');
  assert.equal(classifyVersion(undefined, '1.0.0'), 'unavailable');
  assert.equal(classifyVersion('snapshot', '1.0.0'), 'review');
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 1; i < ordered.length; i++) assert.equal(compareVersions(ordered[i - 1], ordered[i]), -1);
});

test('host detection includes published RCs and resolves the exact tag instead of mutable master', async () => {
  const report = await checkHostRelease({
    fetchJson: async url => {
      assert.match(url, /releases\?per_page=100&page=1$/);
      return [release('0.2.1-rc.2'), release('0.3.0', { draft: true }), release('0.2.1-rc.10'),
        release('99.0.0', { published_at: null }), release('5.0.0', { tag_name: 'plugin-v5.0.0' })];
    },
    remoteTag: async (url, tag) => {
      assert.equal(url, 'https://github.com/deepseek-ai/deepseek-harness');
      assert.equal(tag, 'dsh-v0.2.1-rc.10'); return sha;
    },
  });
  assert.equal(report.version, '0.2.1-rc.10');
  assert.equal(report.revision, sha);
  assert.equal(report.compatibility, 'not-validated');
  assert.equal(report.prerelease, true);
});

test('release pagination cannot silently omit releases or claim success on a failed tag lookup', async () => {
  const urls = [];
  const result = await checkHostRelease({
    fetchJson: async url => { urls.push(url); return urls.length === 1 ? Array.from({ length: 100 }, () => release('0.2.1-rc.2')) : [release('0.2.1-rc.3')]; },
    remoteTag: async () => sha,
  });
  assert.equal(urls.length, 2); assert.equal(result.version, '0.2.1-rc.3');
  const failed = await checkHostRelease({ fetchJson: async () => [release('0.2.1-rc.3')], remoteTag: async () => null });
  assert.equal(failed.status, 'unavailable'); assert.match(failed.error, /resolved/);
  const unavailable = await checkHostRelease({ fetchJson: async () => { throw new Error('HTTP 403'); } });
  assert.equal(unavailable.status, 'unavailable'); assert.match(unavailable.error, /403/);
});

test('matching host packages use exact release versions; separate Cordis and other plugins use their own tags', async () => {
  const calls = [], sources = [
    { id: 'host', package: '@deepseek-ai/dsh-session', kind: 'host-peer', pinned: { version: '0.2.1-rc.2' } },
    { id: 'cordis', package: '@deepseek-ai/cordis', kind: 'host-peer', pinned: { version: '4.0.5' } },
    { id: 'plugin', package: 'dsh-example', kind: 'npm-runtime', pinned: { version: '1.0.0' } },
  ];
  const rows = await checkUpstreams(sources, { hostRelease: { status: 'observed', version: '0.2.1-rc.3' },
    fetchJson: async url => { calls.push(url); return { version: url.includes('dsh-session') ? '0.2.1-rc.3' : url.includes('cordis') ? '4.0.5' : '1.0.0' }; } });
  assert.ok(calls.some(url => url.endsWith('/0.2.1-rc.3')));
  assert.equal(rows.find(row => row.id === 'host').npm.decision, 'upgrade');
  assert.equal(rows.find(row => row.id === 'cordis').npm.selector, 'latest');
  const failed = await checkUpstreams([sources[0]], { hostRelease: { status: 'unavailable', error: 'offline' },
    fetchJson: async () => { assert.fail('must not fall back to misleading latest'); } });
  assert.match(failed[0].npmError, /offline/);
  const mismatch = await checkUpstreams([sources[0]], { hostRelease: { status: 'observed', version: '0.2.1-rc.3' },
    fetchJson: async () => ({ name: 'unrelated', version: '0.2.1-rc.3' }) });
  assert.match(mismatch[0].npmError, /mismatch/);
});

test('source checking deduplicates network calls and separates pinned drift from last observation', async () => {
  let npm = 0, git = 0;
  const base = { package: 'dsh-test', repository: 'https://github.com/example/source', pinned: { version: '1.0.0', revision: other }, observed: { head: sha } };
  const rows = await checkUpstreams([{ ...base, id: 'a' }, { ...base, id: 'b' }, { id: 'archive' }], {
    fetchJson: async () => { npm++; return { version: '1.1.0' }; },
    remoteHead: async () => { git++; return sha; },
  });
  assert.equal(npm, 1); assert.equal(git, 1);
  assert.equal(rows[0].git.changed, false); assert.equal(rows[0].git.differsFromPinned, true);
  assert.match(rows.find(row => row.id === 'archive').unavailable, /not supplied/);
  const failed = await checkUpstreams([{ id: 'bad', repository: base.repository }], { remoteHead: async () => null });
  assert.match(failed[0].gitError, /HEAD was not resolved/); assert.equal(failed[0].git, undefined);
});

test('a vendored kernel compares the published container version without replacing its own identity', async () => {
  const source = { id: 'kernel', package: 'billion-context',
    pinned: { version: '0.0.161', publishedPackageVersion: '0.1.206' } };
  const rows = await checkUpstreams([source], {
    fetchJson: async () => ({ name: 'billion-context', version: '0.1.206' }),
  });
  assert.equal(rows[0].npm.decision, 'unchanged');
  assert.equal(rows[0].npm.comparedPinnedVersion, '0.1.206');
  assert.equal(source.pinned.version, '0.0.161');
});

test('host inventory includes client-only injections and dev-only native dependencies without changing pins', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const ledger = JSON.parse(await readFile('upstreams.json', 'utf8'));
  const before = JSON.stringify(ledger);
  const sourceLock = JSON.parse(await readFile('sources.lock.json', 'utf8'));
  assert.equal(manifest.engines.dsh, EXPECTED_DSH_VERSION);
  assert.equal(ledger.policy.hostVersion, EXPECTED_DSH_VERSION);
  assert.equal(sourceLock.host.release, EXPECTED_DSH_VERSION);
  assert.equal(sourceLock.host.commit, EXPECTED_DSH_REVISION);
  const rows = discoverHostPackages(manifest, ledger.hostPackages, { hostVersion: ledger.policy.hostVersion });
  for (const name of manifest.dsh.client.inject) assert.ok(rows.some(row => row.package === name), name);
  for (const name of Object.keys(manifest.devDependencies).filter(name => name.startsWith('@deepseek-ai/')))
    assert.ok(rows.some(row => row.package === name), name);
  assert.equal(JSON.stringify(ledger), before);
  assert.throws(() => discoverHostPackages({ dependencies: { '@deepseek-ai/dsh-agent': '2.0.0' } }, ledger.hostPackages), /mismatch/);
});

test('private source-only runtimes are checked through Git without querying a nonexistent npm package', async () => {
  const rows = await checkUpstreams([{ id: 'computer', package: '@local/dsh-computer-use',
    repository: 'https://github.com/LJL454/dsh-computer-use', pinned: { revision: sha } }], {
    fetchJson: async () => assert.fail('private source must not query npm'),
    remoteHead: async () => sha,
  });
  assert.match(rows[0].npmNotApplicable, /source-only/);
  assert.equal(rows[0].git.differsFromPinned, false);
  assert.equal(rows[0].npmError, undefined);
});
