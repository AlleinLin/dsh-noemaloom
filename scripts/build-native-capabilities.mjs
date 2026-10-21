import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptTerminalSource } from '../vendor/nexus-terminal/nexus-adapter/adapt-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const terminalRoot = join(root, 'vendor/nexus-terminal');
export const NATIVE_PACKAGES = ['std', 'storage', 'bundle', 'conversation', 'terminal-bridge', 'mode', 'commands', 'ssh', 'buffer', 'files', 'usage'];
export const NATIVE_CLIENTS = ['conversation', 'terminal-bridge', 'mode', 'ssh', 'buffer', 'files', 'usage'];
const reviewedSources = {
  'packages/dshell/terminal-bridge/src/pty.ts': '374634d08386ec4ef450a28ab5d0bd23911b11beb3d954d610c93852402af165',
  'packages/dshell/terminal-bridge/src/index.ts': 'f0fd766c6414049343de964df440b5e37e073b3e2c4307490eafb92ad6e7a8c1',
  'packages/dshell/files/src/route.ts': 'ee2875e843272796e34b62e575fb48057a4befa2b3e251449e434a95c68bc762',
  'packages/dshell/mode/src/client/completion.ts': '7379d042c7ac18ee1d04b619c0c8d640bf2c76b4deeb74dc066ccf1a92f27d98',
  'packages/dshell/std/src/contracts.ts': '26f76481d7ed44ce29831aee751d96d585e700ad2dc36afb911cab335805575b',
  'packages/dshell/ssh/src/connection.ts': 'cd883c9c9ad2ba278eef90dd2e33522c90cdc3df1bcb7c66b8b5419a7f42a8b2',
  'packages/dshell/commands/src/index.ts': '5ab8edd905035b18204a1b6b3c8557696240ec283a4c4ae2c3efb46f88577a51',
  'packages/dshell/mode/src/index.ts': 'db58034d381918ebb2b5c8a8020a06cc5a8a331eff343a2ebc0b2598a14011fc',
  'packages/dshell/mode/src/terminal-mode.ts': 'c14b7a680127d40d86eff29d26ad32548b8915040557ed41de06ab8056a86f96',
  'packages/dshell/mode/src/terminal-mode-protocol.ts': '32d4d471cb628e3cb31794a7b70aefac863421fe44877d0970320071200c28ab',
  'packages/dshell/mode/src/client/terminal-mode.ts': '0e7a2a8e765597f2a8d3c1735550d02ae768e7802e5a6bea21f33f0ef69722d4',
  'packages/dshell/mode/src/client/terminal-section.ts': 'ea3ce756f70cfd369b644dc25a8d472a3f7c7ad327c63bbc946e24a34fabeab5',
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
const clientShared = ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/*'];
const sourcePlugin = (host = false) => ({
  name: 'native-dshell-preserved-upstream',
  setup(builder) {
    builder.onResolve({ filter: /^@nexus-aethra\/dshell-/ }, args => {
      const match = /^@nexus-aethra\/dshell-([^/]+)(?:\/(.*))?$/u.exec(args.path);
      if (!match || !NATIVE_PACKAGES.includes(match[1])) throw new Error(`Unknown dshell package: ${args.path}`);
      if (host) return { path: `./dshell-${match[1]}.js`, external: true };
      return { path: join(terminalRoot, 'packages/dshell', match[1], 'src', match[2] === 'client' ? 'client/index.ts' : 'index.ts') };
    });
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
      if (!args.path.startsWith(terminalRoot + '\\') && !args.path.startsWith(terminalRoot + '/')) return;
      const source = await readFile(args.path, 'utf8');
      return { contents: adaptTerminalSource(args.path, source, terminalRoot), loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' };
    });
    builder.onLoad({ filter: /\.css$/ }, async args => ({
      contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))}`, loader: 'js',
    }));
  },
});

async function copyTree(source, target) {
  await mkdir(target, { recursive: true });
  for (const item of await readdir(source, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error('Native runtime resources cannot contain symbolic links');
    if (item.isDirectory()) await copyTree(join(source, item.name), join(target, item.name));
    else if (item.isFile()) await copyFile(join(source, item.name), join(target, item.name));
  }
}

async function copyNativeNotices(inputs) {
  const packages = new Map();
  for (const input of inputs) {
    if (!input.replaceAll('\\', '/').includes('node_modules/')) continue;
    let directory = dirname(resolve(root, input));
    while (directory !== dirname(directory)) {
      try {
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (manifest.name && manifest.version) { packages.set(directory, manifest); break; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      directory = dirname(directory);
    }
  }
  // These are host externals introduced by the native capability, and remain
  // separately installed packages rather than code inlined into the bundle.
  for (const id of ['@deepseek-ai/dsh-ssh', '@xyflow/react']) {
    const directory = join(root, 'node_modules', id);
    packages.set(directory, JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')));
  }
  const index = [];
  for (const [directory, manifest] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const target = join(root, 'notices/native', manifest.name.replaceAll('/', '__'));
    await mkdir(target, { recursive: true });
    const licenses = [];
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (!item.isFile() || !/^(?:licen[cs]e|notice|copying)(?:[.-].*)?$/iu.test(item.name)) continue;
      await copyFile(join(directory, item.name), join(target, item.name));
      licenses.push(item.name);
    }
    if (licenses.length === 0) throw new Error(`Native bundled dependency has no license file: ${manifest.name}`);
    const source = { name: manifest.name, version: manifest.version, license: manifest.license ?? null,
      repository: manifest.repository ?? null, licenseFiles: licenses };
    await writeFile(join(target, 'SOURCE.json'), JSON.stringify(source, null, 2) + '\n');
    index.push(source);
  }
  await writeFile(join(root, 'notices/native/index.json'), JSON.stringify(index, null, 2) + '\n');
}

export async function buildNativeCapabilities() {
  for (const [path, hash] of Object.entries(reviewedSources)) {
    if (sha256(await readFile(join(terminalRoot, path))) !== hash) {
      throw new Error(`${path}: original source hash changed; review the native adaptation before upgrading`);
    }
  }
  const output = join(root, 'lib/native');
  await mkdir(output, { recursive: true });
  await mkdir(join(root, 'lib/native-client'), { recursive: true });
  const hostShared = ['@deepseek-ai/*', 'node:*', 'ws', 'ssh2', 'zod'];
  const hosts = [];
  const bundledInputs = new Set();
  const remember = result => { for (const input of Object.keys(result.metafile.inputs)) bundledInputs.add(input); };
  for (const id of NATIVE_PACKAGES) {
    const result = await build({
      entryPoints: [join(terminalRoot, 'packages/dshell', id, 'src/index.ts')],
      outfile: join(output, `dshell-${id}.js`), bundle: true, platform: 'node', format: 'esm',
      target: 'node22', sourcemap: true, metafile: true, external: hostShared, plugins: [sourcePlugin(true)],
    });
    remember(result);
    hosts.push({ id: `dshell-${id}`, upstream: `@nexus-aethra/dshell-${id}`, version: '0.1.14',
      export: `./native/dshell-${id}`, inputs: Object.keys(result.metafile.inputs).sort() });
  }
  const helper = await build({
    entryPoints: [join(terminalRoot, 'packages/dshell/ssh/src/helper-entry.ts')],
    outfile: join(output, 'dshell-ssh-helper.js'), bundle: true, platform: 'node', format: 'esm',
    target: 'node20', sourcemap: true, packages: 'bundle', metafile: true,
  });
  remember(helper);
  await copyFile(join(terminalRoot, 'nexus-adapter/pty-console.mjs'), join(output, 'dshell-pty-console.js'));
  await build({
    entryPoints: [join(root, 'vendor/agent-procedures/nexus-adapter/index.mjs')],
    outfile: join(output, 'agent-procedures.js'), bundle: true, platform: 'node', format: 'esm',
    target: 'node22', sourcemap: true, packages: 'external',
  });
  await copyTree(join(root, 'vendor/agent-procedures/tools'), join(output, 'procedures/tools'));
  await copyTree(join(root, 'vendor/agent-procedures/templates'), join(output, 'procedures/templates'));
  for (const project of ['agent-procedures', 'nexus-terminal']) {
    await mkdir(join(output, project === 'agent-procedures' ? 'procedures' : 'dshell'), { recursive: true });
    for (const file of ['LICENSE', 'SOURCE.json']) await copyFile(join(root, 'vendor', project, file),
      join(output, project === 'agent-procedures' ? 'procedures' : 'dshell', file));
  }
  const clients = [];
  for (const id of NATIVE_CLIENTS) {
    const filename = join(root, 'lib/native-client', `dshell-${id}.js`);
    const result = await build({
      entryPoints: [join(terminalRoot, 'packages/dshell', id, 'src/client/index.ts')],
      outfile: filename, bundle: true, platform: 'browser', format: 'cjs', target: 'es2022',
      jsx: 'automatic', jsxImportSource: 'react', sourcemap: true, metafile: true,
      external: clientShared, plugins: [sourcePlugin()], loader: { '.png': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"' },
      banner: { js: 'export default function nativeFactory(require) { var module = { exports: {} }; var exports = module.exports;' },
      footer: { js: 'return module.exports;\n}' },
    });
    remember(result);
    const imports = Object.values(result.metafile.outputs).flatMap(item => item.imports.filter(value => value.external).map(value => value.path));
    clients.push({ id: `dshell-${id}`, packageName: `@nexus-aethra/dshell-${id}`, version: '0.1.14',
      requires: [...new Set(imports)].sort(), filename: relative(root, filename).replaceAll('\\', '/') });
  }
  await writeFile(join(root, 'src/client/native-capabilities.generated.js'),
    '// Generated by scripts/build-native-capabilities.mjs. Do not edit.\n'
    + clients.map((row, index) => `import factory${index} from ${JSON.stringify(`../../${row.filename}`)};`).join('\n')
    + '\nexport default [\n' + clients.map((row, index) => `  { ...${JSON.stringify(row)}, factory: factory${index} }`).join(',\n') + '\n];\n');
  await writeFile(join(root, 'lib/native-capabilities-manifest.json'), JSON.stringify({
    schema: 1, hosts, clients, reviewedSources,
    archives: await Promise.all(['agent-procedures', 'nexus-terminal'].map(async id => JSON.parse(await readFile(join(root, 'vendor', id, 'SOURCE.json'), 'utf8')))),
    localPtyProvider: '@deepseek-ai/dsh-subprocess:spawnTerminal',
    consolePtyBridge: { filename: 'lib/native/dshell-pty-console.js', platform: 'win32-electron',
      runtime: 'resources/runtime/primary-runtime/dependencies/node/bin/node.exe',
      child: 'unchanged sandbox argv; inherited stdio/env/cwd; shell:false' },
    permissionChain: ['session owner', 'sandboxPolicy.resolve', 'sandbox.confine', 'workingDirectory.ensure', 'subprocess.spawnTerminal'],
  }, null, 2) + '\n');
  await copyNativeNotices(bundledInputs);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildNativeCapabilities();
