import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { adaptCrossSessionHost } from './adapt-cross-session.mjs';

export async function buildCrossSessionHost(root, installed, output) {
  const runtime = join(output, 'cross-session-approval-runtime'), hashes = {};
  async function copy(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) { await copy(join(directory, entry.name), relative + '/'); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.js')) throw new Error(`Unreviewed cross-session runtime asset: ${relative}`);
      const destination = join(runtime, relative), bytes = await readFile(join(directory, entry.name));
      hashes[relative] = createHash('sha256').update(bytes).digest('hex');
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, relative === 'index.js' ? adaptCrossSessionHost(bytes.toString('utf8')) : bytes);
    }
  }
  await copy(join(installed.directory, 'lib'));
  await copyFile(join(root, 'src/host/cross-session-tools.mjs'), join(runtime, 'nexus-tools.mjs'));
  return { specifier: './cross-session-approval-runtime/index.js',
    adaptations: ['shared-mailbox-cross-root-authority-and-receipts', 'no-agent-message-human-impersonation',
      'same-human-stop-and-cold-resume-guards', 'durable-mutation-execution-receipts',
      'approval-notice-terminal-cancellation-and-provider-drain'],
    upstreamFiles: hashes };
}
