import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFactory } from './original-factory.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendorRoot = join(root, 'vendor/codinput');
const patches = JSON.parse(await readFile(new URL('./codinput-patches.json', import.meta.url), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export const CODINPUT_ADAPTATIONS = [
  'editor-view-scoped-hooks',
  'command-menu-current-draft-revision',
  'explicit-command-owner-and-draft-revision-guard',
  'viewport-bounded-scrollable-menus',
  'theme-primary-send-control',
  'rebuild-with-pinned-safe-dependencies',
  'preserve-native-tab-pointer-gestures',
  'restored-context-surface-estimate',
  'native-left-right-input-slots-from-reviewed-upstream-0.3.8',
];

/** Fail closed when upstream changes; the recorded vendor itself stays verbatim. */
export function adaptCodinputSource(file, bytes) {
  const patch = patches.find(entry => entry.file === file);
  if (!patch) return bytes.toString('utf8');
  if (sha256(bytes) !== patch.upstreamSha256) throw new Error(`Codinput adaptation source changed: ${file}`);
  let source = bytes.toString('utf8').replaceAll('\r\n', '\n');
  for (const { before, after } of patch.replacements) {
    if (source.split(before).length !== 2) throw new Error(`Codinput adaptation anchor changed: ${file}`);
    source = source.replace(before, after);
  }
  return source;
}

/** Rebuild the original surface with narrow fixes and audited npm dependencies. */
export async function buildCodinputClient() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['vendor/codinput/src/client/index.tsx'],
    outfile: 'codinput.js',
    write: false,
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2021',
    jsx: 'automatic',
    minify: true,
    legalComments: 'none',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    metafile: true,
    logLevel: 'silent',
    plugins: [{
      name: 'verified-codinput-adaptations',
      setup(builder) {
        builder.onResolve({ filter: /^nexus:context-occupancy$/ }, () => ({
          path: join(root, 'src/shared/context-occupancy.ts'),
        }));
        builder.onLoad({ filter: /[/\\]vendor[/\\]codinput[/\\]src[/\\].*\.[jt]sx?$/ }, async args => ({
          contents: adaptCodinputSource(relative(vendorRoot, args.path).replaceAll('\\', '/'), await readFile(args.path)),
          loader: args.path.endsWith('x') ? 'tsx' : 'ts',
        }));
      },
    }],
    banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-codinput", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;' },
    footer: { js: 'return module.exports; } })' },
  });
  const parsed = parseFactory(result.outputFiles[0].text, 'dsh-codinput');
  if (parsed.requires.some(name => !['react', 'react-dom', 'react/jsx-runtime'].includes(name)))
    throw new Error('Codinput rebuild introduced an unreviewed external dependency');
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const inputs = Object.keys(result.metafile.inputs).sort();
  const packagePaths = new Set();
  for (const input of inputs) {
    const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (match) packagePaths.add(match[1]);
  }
  const dependencies = [];
  for (const installedPath of [...packagePaths].sort()) {
    const directory = resolve(root, installedPath);
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const pinned = lock.packages[installedPath];
    if (!pinned?.integrity || pinned.version !== pkg.version)
      throw new Error(`Codinput dependency lock mismatch: ${installedPath}`);
    const licenseFiles = (await readdir(directory)).filter(file => /^(?:licen[cs]e(?:[.-].*)?|copying|notice(?:[.-].*)?)$/i.test(file));
    if (!licenseFiles.length) throw new Error(`Codinput dependency license missing: ${pkg.name}`);
    const files = {};
    for (const file of licenseFiles) files[file] = sha256(await readFile(join(directory, file)));
    dependencies.push({
      name: pkg.name, version: pkg.version, license: pkg.license,
      installedPath, resolved: pinned.resolved, integrity: pinned.integrity, files,
    });
  }
  if (dependencies.find(pkg => pkg.name === 'dompurify')?.version !== '3.4.17')
    throw new Error('Codinput must bundle the patched DOMPurify version');
  return { ...parsed, inputs, dependencies, adaptations: CODINPUT_ADAPTATIONS };
}
