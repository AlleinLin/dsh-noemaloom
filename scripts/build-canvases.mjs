import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptSynapseClient } from './adapt-synapse-client.mjs';
import { adaptThoughtdagHost } from './adapt-thoughtdag-host.mjs';
import { adaptThoughtdagClient, reviewedThoughtdagHtml, THOUGHTDAG_CLIENT_ASSET, THOUGHTDAG_SOURCE_ASSET } from './adapt-thoughtdag-client.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(project, 'package.json'));
const sha256 = source => createHash('sha256').update(source).digest('hex');

function replaceOnce(source, anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`${label}: original anchor changed; refusing an unreviewed adaptation`);
  }
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

async function report(directory, manifest, original, adapted, changes, additional = {}) {
  await writeFile(join(directory, 'adapter.json'), JSON.stringify({
    package: manifest.name, version: manifest.version,
    sourceSha256: sha256(original), adaptedSha256: sha256(adapted), changes, ...additional,
  }, null, 2) + '\n');
}

async function buildSynapse() {
  const root = dirname(require.resolve('dsh-synapse'));
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.version !== '0.4.2') throw new Error('Synapse adapter requires reviewed version 0.4.2');
  const original = await readFile(join(root, 'index.js'), 'utf8');
  const adapted = replaceOnce(original, 'const store = new WorkspaceStore(config?.dataFile)',
    'const store = config.nexusStore', 'Synapse original request-scoped store');
  const output = join(project, 'lib/canvas-original/synapse');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'index.js'), adapted);
  const client = adaptSynapseClient(await readFile(join(root, 'app.js'), 'utf8'));
  await writeFile(join(output, 'app.js'), client.source);
  await copyFile(join(root, 'styles.css'), join(output, 'styles.css'));
  await copyFile(join(project, 'assets/icon.svg'), join(output, 'deepseek-mark.svg'));
  await report(output, manifest, original, adapted, [
    'Replace one store constructor with a request-scoped original WorkspaceStore proxy.',
    'Use the shared Nexus icon for the original application mark.',
    ...client.changes,
  ], { client: { sourceSha256: client.sourceSha256, adaptedSha256: client.adaptedSha256 } });
}

async function buildThoughtdag() {
  const entry = require.resolve('dsh-thoughtdag');
  const root = dirname(dirname(entry));
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.version !== '0.5.21') throw new Error('ThoughtDAG adapter requires reviewed version 0.5.21');
  const original = await readFile(entry, 'utf8');
  const adapted = adaptThoughtdagHost(original);
  const output = join(project, 'lib/canvas-original/thoughtdag');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'index.js'), adapted);
  const client = adaptThoughtdagClient(await readFile(join(root, 'dist-app', THOUGHTDAG_SOURCE_ASSET), 'utf8'));
  const html = reviewedThoughtdagHtml(await readFile(join(root, 'dist-app/index.html'), 'utf8'));
  await mkdir(join(output, 'dist-app/assets'), { recursive: true });
  await writeFile(join(output, 'dist-app', THOUGHTDAG_CLIENT_ASSET), client.source);
  await writeFile(join(output, 'dist-app/index.html'), html);
  await report(output, manifest, original, adapted, [
    'Keep original SPA, runtime, backup helper, package metadata, and why library locations.',
    'Use native scoped session-query archives; remove the unscoped profile scan fallback.',
    'Scope browser model registrations and approval responses by native canvas identity.',
    'Track concurrent canvas turns independently and cancel only an owned active turn.',
    'Release timers, abort listeners, active turns, and pending approvals on completion/unload.',
    'Preserve upstream exact step allowances, native question forms, permission modes, and web search.',
    'Apply temporary permission presets only after claiming the exact owned turn and restore at its end.',
    ...client.changes,
  ], {
    client: {
      asset: THOUGHTDAG_CLIENT_ASSET,
      sourceAsset: THOUGHTDAG_SOURCE_ASSET,
      sourceSha256: client.sourceSha256,
      adaptedSha256: client.adaptedSha256,
      htmlSha256: sha256(html),
      overlayFiles: ['dist-app/index.html', `dist-app/${THOUGHTDAG_CLIENT_ASSET}`],
    },
  });
}

export async function buildCanvases() {
  await buildSynapse();
  await buildThoughtdag();
  await copyFile(join(project, 'src/client/canvas-bootstrap.js'), join(project, 'lib/canvas-bootstrap.js'));
  await copyFile(join(project, 'src/client/canvas-theme.css'), join(project, 'lib/canvas-theme.css'));
}
