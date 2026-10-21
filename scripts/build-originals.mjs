import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { adaptAgentClient } from './adapt-agent-client.mjs';
import { adaptReaderClient } from './adapt-reader-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const output = join(root, 'lib', 'original-client');
const hostOutput = join(root, 'lib', 'original');
await mkdir(output, { recursive: true });
await mkdir(hostOutput, { recursive: true });

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

function parseFactory(source, packageName) {
  const ast = ts.createSourceFile(`${packageName}.js`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let factory;
  let registrations = 0;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'window.__ModuleLoader__.load') {
      registrations += 1;
      const argument = node.arguments[0];
      if (!argument || !ts.isObjectLiteralExpression(argument)) throw new Error(`${packageName}: expected a literal module registration`);
      const property = argument.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(ast) === 'factory');
      factory = property && property.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (registrations !== 1 || !factory || !(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) {
    throw new Error(`${packageName}: expected exactly one published client factory`);
  }
  const requireName = factory.parameters[0]?.name.getText(ast);
  const requires = new Set();
  function references(node) {
    if (node !== factory && ts.isFunctionLike(node)) {
      if (node.parameters?.some(parameter => parameter.name.getText(ast) === requireName)) return;
      if (node.name?.getText(ast) === requireName) return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === requireName && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      requires.add(node.arguments[0].text);
    }
    ts.forEachChild(node, references);
  }
  if (requireName) references(factory);
  return { factory: factory.getText(ast), requires: [...requires].sort() };
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
  return adaptAgentClient(replaceOnce(factory, anchor, `${anchor}
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
  source = replaceOnce(source, 'function cu(e){return e.defaultPlacement()!==`sidebar`}',
    'function cu(e){return true}', 'Context fixed conversation placement gate');
  source = replaceOnce(source, 'let s=cu(e),c=o!==`tab`;',
    'let s=true,c=false;', 'Context single conversation surface');
  source = replaceOnce(source, 'Ml(e)||Nl(n(`tab.context`))',
    'nexusNativeNavigation.openView(r,"context",a===null?"":String(a))',
    'Context message jump uses native session view action');
  source = replaceOnce(source, 'Nl(i(`tab.fleet`))||Ml(e)',
    'nexusNativeNavigation.openView(o,"fleet","")',
    'Context fleet jump uses native session view action');
  const oldChromeClick = 'function Nl(e){let t=document.querySelectorAll(`button[role="tab"]`);for(let n of t)if(n.textContent.trim()===e)return n.getAttribute(`aria-selected`)!==`true`&&n.click(),!0;return!1}';
  source = replaceOnce(source, oldChromeClick, 'function Nl(){return false}',
    'Context remove obsolete chrome-click helper');
  const placementChoice = '(0,d.jsx)(qs,{label:t(`settings.placement`),value:n.placement,disabled:i,options:[{id:`all`,label:t(`placement.all`)},{id:`tab`,label:t(`placement.tab`)},{id:`sidebar`,label:t(`placement.sidebar`)}],onPick:e=>{r?.(`defaultPlacement`,e)}}),';
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

async function addHost(id, packageName, version, subpath = '.') {
  const specifier = subpath === '.' ? packageName : `${packageName}${subpath.slice(1)}`;
  const filename = `${id}.js`;
  if (id === 'thoughtdag' || id === 'synapse') {
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
  });
}

async function addClient(definition, installed) {
  const { directory, manifest } = installed;
  const clientFile = exportedFile(manifest, './client');
  if (!clientFile) throw new Error(`${manifest.name}: no original client export`);
  const source = await readFile(join(directory, clientFile), 'utf8');
  const parsed = parseFactory(source, manifest.name);
  let factory = parsed.factory;
  const adaptations = [];
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
  const filename = `${definition.id}.js`;
  await writeFile(join(output, filename),
    `// Original published client: ${manifest.name}@${manifest.version}\n`
    + '// Original license is included under notices/originals.\n'
    + `const factory = ${factory};\nexport default factory;\n`);
  for (const prerequisite of manifest.dsh?.client?.inject ?? []) clientPrerequisites.add(prerequisite);
  clientRows.push({
    id: definition.id, packageName: manifest.name, version: manifest.version,
    requires: parsed.requires, filename, adaptations,
    publishedSha256: createHash('sha256').update(source).digest('hex'),
    factorySha256: createHash('sha256').update(factory).digest('hex'),
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
  };
  await writeFile(join(noticeDirectory, 'SOURCE.json'), JSON.stringify(info, null, 2) + '\n');
  notices.push(info);
}

for (const definition of originals) {
  const installed = await packageRoot(definition.packageName);
  if (installed.manifest.version !== definition.version) {
    throw new Error(`${definition.packageName}: expected ${definition.version}, installed ${installed.manifest.version}`);
  }
  await addHost(definition.id, definition.packageName, definition.version);
  await copyNotice(installed, definition.id);
  if (definition.client) await addClient(definition, installed);
}

const mnemon = await packageRoot('dsh-mnemon');
await addHost('mnemon-bundle', 'dsh-mnemon', mnemon.manifest.version, './bundle');
await addHost('agency-agents-remote', '@michengai/dsh-agency-agents', '1.2.7', './remote');

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
