import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { adaptAgentClient } from './adapt-agent-client.mjs';
import { adaptReaderClient } from './adapt-reader-client.mjs';
import { parseFactory } from './original-factory.mjs';
import { vendoredOriginal } from './vendored-original.mjs';
import { suppressManagedUpdateUi } from './managed-updates.mjs';
import { workflowNotices } from './workflow-notices.mjs';
import { buildCodinputClient } from './build-codinput.mjs';
import { nativeEditorExtensions } from '../src/shared/editor-extensions.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const output = join(root, 'lib', 'original-client');
const hostOutput = join(root, 'lib', 'original');
await mkdir(output, { recursive: true });
await mkdir(hostOutput, { recursive: true });
await workflowNotices(root);

// Read the literal manifest without executing repository source or published
// client code. TypeScript's parser is already a pinned project dependency.
const manifestText = await readFile(join(root, 'src/client/originals-manifest.ts'), 'utf8');
const manifestAst = ts.createSourceFile('originals-manifest.ts', manifestText, ts.ScriptTarget.Latest, true);
let originals;
function findManifest(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(manifestAst) === 'ORIGINAL_PLUGINS') {
    if (!ts.isArrayLiteralExpression(node.initializer)) throw new Error('ORIGINAL_PLUGINS must remain a literal array');
    originals = node.initializer.elements.map(element => {
      if (!ts.isObjectLiteralExpression(element)) throw new Error('Original manifest must contain literal objects');
      return Object.fromEntries(element.properties.map(property => {
        if (!ts.isPropertyAssignment(property)) throw new Error('Original manifest cannot use spreads or methods');
        const value = property.initializer;
        const key = ts.isIdentifier(property.name) ? property.name.text : property.name.text;
        if (ts.isStringLiteralLike(value)) return [key, value.text];
        if (value.kind === ts.SyntaxKind.TrueKeyword) return [key, true];
        if (value.kind === ts.SyntaxKind.FalseKeyword) return [key, false];
        throw new Error(`Original manifest ${key} must be a scalar literal`);
      }));
    });
  }
  ts.forEachChild(node, findManifest);
}
findManifest(manifestAst);
if (!originals?.length) throw new Error('No fixed original plugin manifest found');

async function packageRoot(packageName) {
  let directory;
  try { directory = dirname(require.resolve(`${packageName}/package.json`)); }
  catch { directory = dirname(require.resolve(packageName)); }
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (manifest.name === packageName) return { directory, manifest };
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate installed original ${packageName}`);
    directory = parent;
  }
}

function exportedFile(manifest, subpath) {
  const select = value => typeof value === 'string' ? value : value && (select(value.default) ?? select(value.import));
  const value = select(manifest.exports?.[subpath]);
  return value ?? (subpath === '.' ? manifest.main ?? 'index.js' : undefined);
}

function replaceOnce(source, anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`${label}: original anchor changed; refusing an unreviewed adaptation`);
  }
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

function adaptSidebar(factory) {
  const anchor = 'ctx.effect(() => registerBuiltins(ctx, service), "dsh-better-sidebar: register built-in tabs and viewers");';
  // Route new supported resources to documentPreviews. The upstream editor
  // remains available for existing tabs and file formats it alone supports.
  const routed = replaceOnce(factory, 'return file !== void 0 && !hostOwnedPath(file.path);',
    `return file !== void 0 && !hostOwnedPath(file.path) && !${JSON.stringify(nativeEditorExtensions)}.includes(file.path.split(/[\\\\/]/).pop().split(".").pop().toLowerCase());`,
    'Better Sidebar yields supported files to the native Monaco renderer');
  return adaptAgentClient(replaceOnce(routed, anchor, `${anchor}
      // Nexus integration: the original full tree/graph and the native right
      // sidebar share the original store, service, telemetry and context.
      ctx.slots.inject("conversation.view", () => ctx.slots.register({
        name: "conversation.view", id: "nexus.agents", order: 15,
        label: () => ctx.locale.getSnapshot?.().active === "zh" ? "子智能体" : "Agents"
      }, function NexusOriginalSubagentView(props) {
        return react_jsx_runtime.jsx(SubagentView, {
          sessionId: props.sessionId, active: props.active !== false,
          ctx, store: sidebarStore
        });
      }));`, 'Better Sidebar full agent view'));
}

function adaptContext(factory) {
  let source = replaceOnce(factory, 'var t={exports:{}}',
    'const nexusNativeNavigation=e("@local/dsh-nexus/original-navigation");var t={exports:{}}',
    'Context native navigation module');
  source = replaceOnce(source, 'function _u(e){return e.defaultPlacement()!==`sidebar`}',
    'function _u(e){return true}', 'Context fixed conversation placement gate');
  source = replaceOnce(source, 'let s=_u(e),c=o!==`tab`;',
    'let s=true,c=false;', 'Context single conversation surface');
  source = replaceOnce(source, 'Vl(e)||Hl(n(`tab.context`))',
    'nexusNativeNavigation.openView(r,"context",a===null?"":String(a))',
    'Context message jump uses native session view action');
  source = replaceOnce(source, 'Hl(i(`tab.fleet`))||Vl(e)',
    'nexusNativeNavigation.openView(o,"fleet","")',
    'Context fleet jump uses native session view action');
  const oldChromeClick = 'function Hl(e){let t=document.querySelectorAll(`button[role="tab"]`);for(let n of t)if(n.textContent.trim()===e)return n.getAttribute(`aria-selected`)!==`true`&&n.click(),!0;return!1}';
  source = replaceOnce(source, oldChromeClick, 'function Hl(){return false}',
    'Context remove obsolete chrome-click helper');
  const placementChoice = '(0,d.jsx)($s,{label:t(`settings.placement`),value:n.placement,disabled:i,options:[{id:`all`,label:t(`placement.all`)},{id:`tab`,label:t(`placement.tab`)},{id:`sidebar`,label:t(`placement.sidebar`)}],onPick:e=>{r?.(`defaultPlacement`,e)}}),';
  source = replaceOnce(source, placementChoice, '', 'Context remove inactive placement preference');
  return source;
}

function adaptReader(factory) {
  let source = replaceOnce(factory, 'const shell = ctx.conversation?.input?.shell?.(sessionId);',
    'const actx = ctx.sessions.scope(sessionId);\n'
    + '\t\t\t\t\t\t\t\t\tconst shell = actx === undefined ? undefined : ctx.conversation?.input?.for?.(actx);',
    'Reader rc.2 sanctioned session input facade');
  source = replaceOnce(source, 'return fillComposerDom(text);', 'return false;',
    'Reader remove obsolete composer DOM fallback');
  return adaptReaderClient(source);
}

const clientRows = [];
const hostRows = [];
const notices = [];
const clientPrerequisites = new Set();

async function addHost(id, packageName, version, subpath = '.', installed) {
  let specifier = subpath === '.' ? packageName : `${packageName}${subpath.slice(1)}`;
  const filename = `${id}.js`;
  if (installed?.source) {
    // Preserve the original CommonJS module under .cjs in our ESM package.
    // This wrapper only forwards exports; the upstream host stays untouched.
    if (installed.manifest.type === 'module') throw new Error(`${packageName}: expected the reviewed CommonJS host`);
    specifier = `./${id}.cjs`;
    await copyFile(join(installed.directory, exportedFile(installed.manifest, subpath)), join(hostOutput, `${id}.cjs`));
    await writeFile(join(hostOutput, filename),
      `// Original ${packageName}@${version}, commit ${installed.source.revision}.\n`
      + `import original from ${JSON.stringify(specifier)};\n`
      + 'export const { name, inject, apply } = original;\nexport default original;\n');
  } else if (id === 'openspec') {
    await writeFile(join(hostOutput, filename),
      `// Original ${packageName}@${version}; canonical skills with the packaged Windows-safe CLI path.\n`
      + `import * as original from ${JSON.stringify(specifier)};\n`
      + `import { fileURLToPath } from "node:url";\n`
      + `export * from ${JSON.stringify(specifier)};\n`
      + `const cli = fileURLToPath(new URL('../bin/openspec.js', import.meta.resolve('@fission-ai/openspec')));\n`
      + `const path = cli.replaceAll(String.fromCharCode(92), '/');\n`
      + `const quote = process.platform === 'win32' ? "'" + path.replaceAll("'", "''") + "'" : "'" + path.replaceAll("'", "'\\\\''") + "'";\n`
      + `const command = 'node ' + quote;\n`
      + `export function apply(ctx, config) {\n`
      + `  const registry = ctx.skills;\n`
      + `  const skills = new Proxy(registry, { get(target, key) {\n`
      + `    if (key === "register") return definition => registry.register({ ...definition, content: definition.content.replace(/\\bopenspec(?=\\s+(?:(?:store|new|status|instructions|list|show|validate|archive|doctor|context|schemas|view|init|update|config|completion|feedback|telemetry)\\b|--(?:version|help)\\b))/g, () => command) });\n`
      + `    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;\n`
      + `  } });\n`
      + `  return original.apply(new Proxy(ctx, { get(target, key) { return key === "skills" ? skills : Reflect.get(target, key); } }), config);\n`
      + `}\n`);
  } else if (id === 'ponytail') {
    await writeFile(join(hostOutput, filename),
      `// Original ${packageName}@${version}; optional services use the public scoped lookup.\n`
      + `import * as original from ${JSON.stringify(specifier)};\n`
      + `export * from ${JSON.stringify(specifier)};\n`
      + `export function apply(ctx, config) {\n`
      + `  return original.apply(new Proxy(ctx, { get(target, key) {\n`
      + `    if (key === 'settings' || key === 'profileContext') return target.get(key, false);\n`
      + `    return Reflect.get(target, key);\n`
      + `  } }), config);\n`
      + `}\n`);
  } else if (id === 'karpathy') {
    const original = await readFile(join((await packageRoot(packageName)).directory, 'index.js'), 'utf8');
    const adapted = replaceOnce(original, "new URL('./skills/', import.meta.url)",
      "new URL('../../assets/methods/karpathy/skills/', import.meta.url)",
      'Karpathy original skill provider asset root');
    await writeFile(join(hostOutput, filename), adapted);
  } else if (id === 'thoughtdag' || id === 'synapse') {
    const applyName = id === 'thoughtdag' ? 'applyThoughtdag' : 'applySynapse';
    await writeFile(join(hostOutput, filename),
      `// Original ${packageName}@${version}, scoped by the shared desktop canvas host.\n`
      + `import { inject as originalInject } from ${JSON.stringify(specifier)};\n`
      + `export { name } from ${JSON.stringify(specifier)};\n`
      + `export const inject = [...new Set([...originalInject, "sessionQuery", "workspaceRegistry", "profileContext"])];\n`
      + `export { ${applyName} as apply } from "../canvases.js";\n`);
  } else {
    await writeFile(join(hostOutput, filename),
      `// Original ${packageName}@${version}; preserve the original host module and assets.\n`
      + `import * as original from ${JSON.stringify(specifier)};\n`
      + `export * from ${JSON.stringify(specifier)};\n`
      + 'export default original.default ?? original;\n');
  }
  hostRows.push({
    id, packageName, version, specifier,
    export: `./original/${id}`, target: `./lib/original/${filename}`,
    ...(installed?.source ? { revision: installed.source.revision, upstreamSha256: installed.source.files['lib/index.js'], commonjsTarget: `./lib/original/${id}.cjs` } : {}),
  });
}

async function addClient(definition, installed) {
  const { directory, manifest } = installed;
  const clientFile = exportedFile(manifest, './client');
  if (!clientFile) throw new Error(`${manifest.name}: no original client export`);
  const source = await readFile(join(directory, clientFile), 'utf8');
  const parsed = parseFactory(source, manifest.name);
  if (installed.source && parsed.requires.some(name => !['react', 'react-dom', 'react/jsx-runtime'].includes(name))) {
    throw new Error(`${manifest.name}: unreviewed external client dependency`);
  }
  let factory = parsed.factory;
  const adaptations = [];
  let rebuiltDependencies;
  if (definition.id === 'codinput') {
    const rebuilt = await buildCodinputClient();
    factory = rebuilt.factory;
    parsed.requires = rebuilt.requires;
    adaptations.push(...rebuilt.adaptations);
    rebuiltDependencies = rebuilt.dependencies;
    for (const dependency of rebuiltDependencies) {
      const destination = join(root, 'notices/originals/codinput/adapted-dependencies', dependency.name.replaceAll('/', '__'));
      await mkdir(destination, { recursive: true });
      for (const file of Object.keys(dependency.files))
        await copyFile(join(root, dependency.installedPath, file), join(destination, file));
    }
    await writeFile(join(root, 'notices/originals/codinput/adapted-dependencies/SOURCE.json'),
      JSON.stringify(rebuiltDependencies, null, 2) + '\n');
  }
  if (manifest.name === 'dsh-better-sidebar') {
    factory = adaptSidebar(factory);
    parsed.requires.push('@local/dsh-nexus/agent-insights');
    factory = replaceOnce(factory, 'absolute/home/me/x.txt', 'absolute/workspace/x.txt', 'Sidebar generic path documentation');
    factory = replaceOnce(factory, 'vscode://file//home/u/f.ts` or `vscode://file/C:/Users/u/f.ts',
      'vscode://file//workspace/f.ts` or `vscode://file/C:/work/f.ts', 'Sidebar generic editor URL documentation');
    adaptations.push('original-SubagentView-conversation-slot-with-shared-store');
  }
  if (manifest.name === '@linxin666/dsh-client-ui-task-board') {
    const example = '/home/me/project';
    if (factory.split(example).length !== 3) throw new Error('Task board two documented path placeholders changed');
    factory = factory.replaceAll(example, '/workspace/project');
    adaptations.push('generic-project-path-placeholders-without-user-home');
  }
  if (manifest.name === 'dsh-context') {
    factory = adaptContext(factory);
    parsed.requires.push('@local/dsh-nexus/original-navigation');
    adaptations.push('single-original-context-and-fleet-conversation-surface', 'native-session-view-navigation-without-DOM-clicks');
  }
  if (manifest.name === 'dsh-better-display') {
    factory = adaptReader(factory);
    adaptations.push('rc2-SessionInputResolver-for-scoped-context', 'remove-obsolete-composer-DOM-fallback',
      'reader-enhancements-in-native-assistant-step', 'single-native-chat-view-with-reader-selection-migration');
  }
  const managed = suppressManagedUpdateUi(manifest.name, factory);
  factory = managed.source;
  adaptations.push(...managed.changes);
  const filename = `${definition.id}.js`;
  await writeFile(join(output, filename),
    `// Original published client: ${manifest.name}@${manifest.version}\n`
    + '// Original license is included under notices/originals.\n'
    + `const factory = ${factory};\nexport default factory;\n`);
  for (const prerequisite of manifest.dsh?.client?.inject ?? []) clientPrerequisites.add(prerequisite);
  clientRows.push({
    id: definition.id, packageName: manifest.name, version: manifest.version,
    requires: parsed.requires, filename, adaptations,
    ...(rebuiltDependencies ? { rebuiltDependencies } : {}),
    publishedSha256: createHash('sha256').update(source).digest('hex'),
    factorySha256: createHash('sha256').update(factory).digest('hex'),
    ...(installed.source ? { revision: installed.source.revision, source: definition.vendor } : {}),
  });
}

async function copyNotice(installed, id) {
  const { directory, manifest } = installed;
  const noticeDirectory = join(root, 'notices', 'originals', id);
  await mkdir(noticeDirectory, { recursive: true });
  let found = false;
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'NOTICE', 'NOTICE.md']) {
    try { await copyFile(join(directory, filename), join(noticeDirectory, filename)); found = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const info = {
    packageName: manifest.name, version: manifest.version,
    license: manifest.license ?? null, repository: manifest.repository ?? null,
    upstreamLicenseFile: found,
    ...(installed.source ? {
      revision: installed.source.revision, source: `vendor/${id}/SOURCE.json`,
      clientSha256: installed.source.files['lib/client.js'], hostSha256: installed.source.files['lib/index.js'],
      dependencyNotices: installed.source.dependencyNotices,
    } : {}),
  };
  await writeFile(join(noticeDirectory, 'SOURCE.json'), JSON.stringify(info, null, 2) + '\n');
  notices.push(info);
}

for (const definition of originals) {
  const installed = definition.vendor ? await vendoredOriginal(root, definition) : await packageRoot(definition.packageName);
  if (installed.manifest.version !== definition.version) {
    throw new Error(`${definition.packageName}: expected ${definition.version}, installed ${installed.manifest.version}`);
  }
  await addHost(definition.id, definition.packageName, definition.version, '.', installed);
  await copyNotice(installed, definition.id);
  if (definition.client) await addClient(definition, installed);
}

const mnemon = await packageRoot('dsh-mnemon');
await addHost('mnemon-bundle', 'dsh-mnemon', mnemon.manifest.version, './bundle');
await addHost('agency-agents-remote', '@michengai/dsh-agency-agents', '1.2.9', './remote');

// The original Starter's full source/strategy/provider closure is fixed by its
// own exact dependency versions. Each host remains a formal Loader entry.
for (const [packageName, version] of Object.entries(mnemon.manifest.dependencies ?? {})
  .filter(([name]) => name.startsWith('dsh-mnemon-'))) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error(`Unpinned Mnemon component ${packageName}: ${version}`);
  const installed = await packageRoot(packageName);
  if (installed.manifest.version !== version) throw new Error(`${packageName}: expected ${version}, installed ${installed.manifest.version}`);
  const id = packageName.replace(/^dsh-/, '');
  await addHost(id, packageName, version);
  await copyNotice(installed, id);
  if (installed.manifest.dsh?.client) await addClient({ id }, installed);
}

const orderedClients = [];
const byPackage = new Map(clientRows.map(entry => [entry.packageName, entry]));
const visiting = new Set();
const visited = new Set();
function orderClient(entry) {
  if (visited.has(entry.packageName)) return;
  if (visiting.has(entry.packageName)) throw new Error(`Original client dependency cycle: ${entry.packageName}`);
  visiting.add(entry.packageName);
  for (const specifier of entry.requires) {
    const dependency = byPackage.get(specifier.replace(/\/client$/, ''));
    if (dependency) orderClient(dependency);
  }
  visiting.delete(entry.packageName);
  visited.add(entry.packageName);
  orderedClients.push(entry);
}
for (const entry of clientRows) orderClient(entry);
const imports = orderedClients.map((entry, index) => `import factory${index} from ${JSON.stringify(`../../lib/original-client/${entry.filename}`)};`);
const rows = orderedClients.map((entry, index) => `  ${JSON.stringify({
  id: entry.id, packageName: entry.packageName, version: entry.version, requires: entry.requires,
}).slice(0, -1)}, factory: factory${index} }`);
await writeFile(join(root, 'src/client/originals.generated.js'),
  '// Generated by scripts/build-originals.mjs. Do not edit.\n'
  + imports.join('\n') + '\nexport default [\n' + rows.join(',\n') + '\n];\n');

const report = {
  schema: 1,
  hostExports: Object.fromEntries(hostRows.map(entry => [entry.export, entry.target])),
  clientPrerequisites: [...clientPrerequisites].sort(),
  hosts: hostRows,
  clients: orderedClients,
  notices,
  excludedClientShims: ['dsh-thoughtdag: body fixed overlay', 'dsh-synapse: body fullscreen overlay'],
};
await writeFile(join(root, 'lib/originals-manifest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Original plugins: ${hostRows.length} host modules, ${clientRows.length} original client factories`);
console.log(`Original manifest: ${relative(root, join(root, 'lib/originals-manifest.json'))}`);
