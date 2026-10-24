import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
export const HOST_BOUNDARIES = [
  'packages/core/agent-loop/src', 'packages/core/agent/src', 'packages/core/session/src',
  'packages/core/tools/src', 'packages/subagent/subagent/src', 'packages/subagent/tool-subagent/src',
  'packages/compaction/compaction-basic/src', 'packages/compaction/compaction/src',
  'packages/llm/llm/src', 'packages/llm/llm-retry/src',
  'packages/context/agent-instructions/src', 'packages/client/connection/src',
  'packages/session/session-projection/src', 'packages/session/session-stats/src',
  ...['service.ts', 'stores.ts', 'tab-domain.ts', 'session-view.ts', 'session-views.ts', 'persistence.ts']
    .map(file => `packages/client/ui-sidebar-right/src/client/${file}`),
];

/** Full local Git comparison avoids GitHub's 300-file compare response limit. Never checks out or edits source. */
export async function reviewHostSource(repository, base, target) {
  if (![base, target].every(value => /^[a-f0-9]{40}$/.test(value ?? ''))) throw new Error('Use resolved 40-character release commit ids');
  const git = async args => (await exec('git', ['-C', repository, ...args],
    { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })).stdout.trim();
  for (const revision of [base, target]) await git(['rev-parse', '--verify', `${revision}^{commit}`]);
  const files = (await git(['diff', '--name-only', base, target, '--'])).split(/\r?\n/).filter(Boolean);
  const boundaries = [];
  // Sequential to keep partial-clone lazy fetches out of one another's Git locks.
  for (const path of HOST_BOUNDARIES) {
    const before = await git(['rev-parse', '--verify', `${base}:${path}`]);
    const after = await git(['rev-parse', '--verify', `${target}:${path}`]);
    boundaries.push({ path, baseObject: before, targetObject: after, unchanged: before === after });
  }
  return { schemaVersion: 1, base, target, method: 'complete-local-git-diff-and-object-identities',
    changedFileCount: files.length, changedFiles: files, boundaries };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 8 || ['--repo', '--base', '--target', '--output'].some((key, i) => args[i * 2] !== key))
    throw new Error('Usage: node scripts/review-host-source.mjs --repo <public-checkout> --base <commit> --target <commit> --output <report.json>');
  const report = await reviewHostSource(args[1], args[3], args[5]);
  await writeFile(args[7], JSON.stringify(report, null, 2) + '\n');
  console.log(`Compared ${report.changedFileCount} files and ${report.boundaries.length} source boundaries.`);
}
