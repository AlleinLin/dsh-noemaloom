import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { adaptComputerUseHost, adaptComputerUseDegraded } from './adapt-new-originals.mjs';
import {
  adaptComputerPolicyHost, adaptAppLaunchEntry, adaptAppLaunchRuntime, adaptCdpConnection,
  adaptCdpState, adaptComputerWorkerPolicy, adaptComputerWorkerDispatch,
} from './adapt-computer-use-policy.mjs';

/** Preserve the upstream closure and add authenticated routes/native policy at execution seams. */
export async function buildComputerUseHost(root, installed, output) {
  const runtime = join(output, 'computer-use');
  for (const path of Object.keys(installed.source.files)) {
    const destination = join(runtime, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(installed.directory, path), destination);
  }
  const source = await readFile(join(installed.directory, 'index.js'), 'utf8');
  const adapted = adaptComputerPolicyHost(adaptComputerUseHost(source));
  await writeFile(join(runtime, 'index.js'), adapted);
  const helper = await readFile(join(root, 'src/host/computer-use-routes.mjs'), 'utf8');
  await writeFile(join(runtime, 'internal/nexus-auth-routes.mjs'), helper);
  const policy = await readFile(join(root, 'src/host/computer-use-policy.mjs'), 'utf8');
  await writeFile(join(runtime, 'internal/nexus-policy.mjs'), policy);
  const policyFiles = {};
  for (const [path, adapt] of [
    ['internal/degraded.mjs', adaptComputerUseDegraded],
    ['internal/app-launch.mjs', adaptAppLaunchEntry],
    ['internal/app-launch.js', adaptAppLaunchRuntime],
    ['browser/connection.mjs', adaptCdpConnection],
    ['browser/state.mjs', adaptCdpState],
    ['backend/parts/07-frames.ps1', adaptComputerWorkerPolicy],
    ['backend/parts/13-main-loop.ps1', adaptComputerWorkerDispatch],
    ['backend/worker.ps1', async text => adaptComputerWorkerDispatch(await adaptComputerWorkerPolicy(text))],
  ]) {
    const text = await adapt(await readFile(join(installed.directory, path), 'utf8'));
    await writeFile(join(runtime, path), text);
    policyFiles[path] = createHash('sha256').update(text).digest('hex');
  }
  // Upstream supplies this source-only writer. It reads and hashes files; it
  // neither imports the desktop plugin nor starts a PowerShell backend.
  const { writeReleaseManifest } = await import(pathToFileURL(join(installed.directory, 'internal/release-manifest.mjs')).href);
  const { manifest } = writeReleaseManifest(runtime, { builtAt: '2026-10-26T00:00:00.000Z' });
  return {
    specifier: './computer-use/index.js',
    adaptations: ['rc3-owner-only-connection-fetch-routes', 'native-session-composer-grant-default-off',
      'native-sandbox-approval-for-exact-desktop-and-cdp-operations', 'same-session-app-launch-grant-and-cancellation',
      'worker-approved-launch-plan-revalidation', 'cdp-session-ownership-and-startup-cancellation'],
    adaptedHostSha256: createHash('sha256').update(adapted).digest('hex'),
    routeAdapterSha256: createHash('sha256').update(helper).digest('hex'),
    policyAdapterSha256: createHash('sha256').update(policy).digest('hex'),
    adaptedPolicyFiles: policyFiles,
    adaptedFiles: {
      'index.js': createHash('sha256').update(adapted).digest('hex'),
      'internal/nexus-auth-routes.mjs': createHash('sha256').update(helper).digest('hex'),
      'internal/nexus-policy.mjs': createHash('sha256').update(policy).digest('hex'),
      ...policyFiles,
    },
    releaseBuildId: manifest.releaseBuildId,
  };
}
