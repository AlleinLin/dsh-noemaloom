import ts from 'typescript';
import { connect, type Socket } from 'node:net';
import { mkdir, readFile, cp, readdir, stat, rm, realpath, symlink } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AdapterCache, tree } from './cache.js';
import { FramedProtocol } from './protocol.js';
import { runDebugProcess, type DebugBroker, type DebugProcess, type DebugProcessSpec } from './process.js';
import { debugLanguage, projectFile } from './configuration.js';
import { workspacePath, within } from '../../domain/files/paths.js';
import type { DebugLaunch, DebugScope } from '../../shared/debug.js';

export interface AdapterConnection {
  protocol: FramedProtocol;
  launch: DebugLaunch;
  /** js-debug uses additional DAP connections for actual Node targets. */
  connectChild?: () => Promise<FramedProtocol>;
  spawnTerminal(args: any): Promise<{ processId?: number }>;
  dispose(): Promise<void>;
}
export interface AdapterOptions {
  broker: DebugBroker; cache: AdapterCache; workRoot: string;
  output(category: string, output: string): void;
  /** Trusted native composition seam only; no marketplace, RPC code, or extension host. */
  rust?: (config: DebugLaunch, scope: DebugScope, signal: AbortSignal) => Promise<AdapterConnection>;
}
export class DebugCleanupError extends Error {}
/** No process is created outside this ownership object, including reverse DAP launches. */
export async function openAdapter(options: AdapterOptions, config: DebugLaunch, scope: DebugScope, signal: AbortSignal): Promise<AdapterConnection> {
  if (debugLanguage(config) === 'rust') {
    if (!options.rust) throw new Error('Rust adapter extension point is not configured; open this project in local VS Code');
    return options.rust(config, scope, signal);
  }
  const { broker, cache, output } = options;
  const processes = new Set<DebugProcess>(), protocols = new Set<FramedProtocol>(), sockets = new Set<Socket>();
  const directory = join(options.workRoot, randomUUID());
  await mkdir(directory, { recursive: true });
  let disposed = false, disposal: Promise<void> | undefined;
  const spawn = async (spec: DebugProcessSpec, pipe = false) => {
    signal.throwIfAborted();
    if (processes.size >= 64) throw new Error('Debugger owned process budget exceeded');
    const child = await broker.spawn(spec, scope, signal);
    if (disposed) {
      try { await child.terminate(); } catch { throw new DebugCleanupError('Late debugger process cleanup could not be confirmed'); }
      throw new Error('Debug session closed during preparation');
    }
    processes.add(child);
    child.stderr.on('data', () => {}); // Adapter diagnostics can contain launch environment; never publish them.
    if (!pipe) child.output.on('data', bytes => output('console', bytes.toString().slice(0, 8192)));
    // A top-level exit does not prove that its provider-managed descendants exited.
    void child.done.catch(() => {});
    return child;
  };
  const pipe = (child: DebugProcess, kind: 'dap' | 'lsp' = 'dap') => {
    const protocol = new FramedProtocol(child.output, child.input, kind); protocols.add(protocol); return protocol;
  };
  const tcp = async (port: number) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid loopback adapter port');
    const socket = connect({ host: '127.0.0.1', port }); sockets.add(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Loopback adapter connection timed out')); }, 15000);
      const abort = () => { socket.destroy(); reject(new Error('Debug connection cancelled')); };
      signal.addEventListener('abort', abort, { once: true });
      socket.once('connect', () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); });
      socket.once('error', error => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error); });
    });
    const protocol = new FramedProtocol(socket, socket); protocols.add(protocol); return protocol;
  };
  const dispose = () => disposal ??= (async () => {
    disposed = true;
    for (const protocol of protocols) protocol.close();
    for (const socket of sockets) socket.destroy();
    const results = await Promise.allSettled([...processes].map(child => child.terminate()));
    processes.clear(); protocols.clear(); sockets.clear();
    if (results.some(result => result.status === 'rejected')) throw new DebugCleanupError('Owned debugger cleanup could not be confirmed');
    const root = await realpath(options.workRoot), owned = await realpath(directory);
    if (owned === root || !within(root, owned)) throw new DebugCleanupError('Debugger cleanup directory escaped managed storage');
    await rm(owned, { recursive: true, force: true });
  })().catch(error => { throw error instanceof DebugCleanupError ? error : new DebugCleanupError('Debugger build storage cleanup failed'); });
  const spawnTerminal = async (args: any) => {
    if (!Array.isArray(args.args) || !args.args.length || args.args.some((item: any) => typeof item !== 'string')) throw new Error('Invalid runInTerminal arguments');
    if (args.argsCanBeInterpretedByShell) throw new Error('Shell-interpreted terminal requests require local VS Code');
    const cwd = await workspacePath(scope.workspaceRoot, args.cwd ?? config.cwd ?? '.');
    const env = terminalEnvironment(args.env);
    const child = await spawn({ command: args.args[0], args: args.args.slice(1), cwd, env });
    return { processId: child.pid };
  };
  try {
    let protocol: FramedProtocol, connectChild: (() => Promise<FramedProtocol>) | undefined;
    const launch: DebugLaunch = { ...config, console: 'internalConsole' };
    delete launch.name; delete launch.windows; delete launch.linux; delete launch.osx;
    const language = debugLanguage(config), cwd = config.cwd ?? scope.workspaceRoot;
    if (language === 'node') {
      if (config.request !== 'attach') {
        if (!config.program) throw new Error('Node launch needs a program');
        if (/\.[cm]?tsx?$/.test(config.program)) {
          const compiled = await compileTypeScript(config.program, scope, directory);
          launch.program = compiled.program;
          // DAP paths are native paths, but js-debug's glob matcher expects
          // POSIX separators even on Windows.
          launch.outFiles = ['js', 'mjs', 'cjs'].map(extension => `${compiled.outDir.replaceAll('\\', '/')}/**/*.${extension}`);
          launch.sourceMaps = true;
          // Short programs can finish before their map has been discovered.
          // Await source-map installation before releasing the target.
          launch.pauseForSourceMap = true;
          launch.resolveSourceMapLocations = [directory, scope.workspaceRoot].map(path => `${path.replaceAll('\\', '/')}/**`);
        }
      }
      const entry = await cache.find('node', path => path.endsWith('/src/dapDebugServer.js'), signal);
      const node = await broker.resolveExecutable(config.nodePath ?? 'node', {}, signal);
      const child = await spawn({ command: node, args: [entry, '0', '127.0.0.1'], cwd }, true);
      const port = await new Promise<number>((resolve, reject) => {
        let bytes = '';
        const timer = setTimeout(() => { cleanup(); reject(new Error('Node adapter did not publish a loopback port')); }, 20000);
        const abort = () => { cleanup(); reject(new Error('Node adapter startup cancelled')); };
        const listener = (chunk: Buffer) => {
          bytes = (bytes + chunk.toString()).slice(-8192);
          const match = /Debug server listening at [^\r\n]*:(\d+)/.exec(bytes);
          if (match) { cleanup(); resolve(Number(match[1])); }
        };
        const cleanup = () => { clearTimeout(timer); child.output.off('data', listener); signal.removeEventListener('abort', abort); };
        child.output.on('data', listener);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        void child.done.then(() => { cleanup(); reject(new Error('Node adapter exited during startup')); }, () => { cleanup(); reject(new Error('Node adapter startup failed')); });
      });
      protocol = await tcp(port); connectChild = () => tcp(port);
      launch.type = 'pwa-node'; launch.runtimeExecutable ??= node;
      launch.autoAttachChildProcesses = true;
    } else if (language === 'python') {
      const python = config.pythonPath ?? (Array.isArray(config.python) ? config.python[0] : config.python) ?? 'python';
      if (typeof python !== 'string') throw new Error('Python interpreter must be an executable path');
      const version = await runDebugProcess(broker, { command: python, args: ['-c', 'import sys; print("%s%s" % sys.version_info[:2])'], cwd }, scope, signal, 15000);
      const abi = version.trim();
      if (!/^3(?:10|11|12|13|14)$/.test(abi)) throw new Error('Pinned debugpy supports CPython 3.10–3.14 x64');
      const root = await cache.ensure(`python-${abi}`, signal);
      protocol = pipe(await spawn({ command: python, args: ['-m', 'debugpy.adapter'], cwd, env: { PYTHONPATH: root } }, true));
      launch.type = 'python'; launch.python = [python]; launch.justMyCode ??= true;
      delete launch.pythonPath;
    } else if (language === 'csharp') {
      if (config.request !== 'attach' && !config.program?.endsWith('.dll') && !config.program?.endsWith('.exe')) {
        const project = config.project ? await workspacePath(scope.workspaceRoot, config.project) : await projectFile(config.program ? dirname(config.program) : cwd, '.csproj');
        if (!project) throw new Error('C# default launch needs one .csproj beside the selected source, or an explicit program DLL');
        const dotnet = config.dotnetPath ?? 'dotnet', outDir = join(directory, 'dotnet');
        await runDebugProcess(broker, { command: dotnet, args: ['build', project, '--configuration', 'Debug', '--output', outDir, '-p:DebugType=portable', '-p:Optimize=false', '--nologo'], cwd }, scope, signal);
        const result = await runDebugProcess(broker, { command: dotnet, args: ['msbuild', project, '-getProperty:TargetFileName', '-nologo'], cwd }, scope, signal, 30000);
        const filename = result.trim().split(/\r?\n/).at(-1)!;
        if (!/^[^\\/:]+\.(dll|exe)$/.test(filename)) throw new Error('Could not resolve the C# target assembly');
        launch.program = join(outDir, filename);
      }
      delete launch.project; delete launch.dotnetPath;
      const entry = await cache.find('csharp', path => path.endsWith('/netcoredbg.exe'), signal);
      protocol = pipe(await spawn({ command: entry, args: ['--interpreter=vscode'], cwd }, true));
      launch.type = 'coreclr';
    } else {
      const [serverRoot, java, bundle] = await Promise.all([
        cache.ensure('jdtls', signal),
        cache.find('java-runtime', path => path.endsWith('/bin/java.exe'), signal),
        cache.find('java-debug', path => path.endsWith('/server/com.microsoft.java.debug.plugin-0.53.2.jar'), signal),
      ]);
      const launcher = (await tree(join(serverRoot, 'plugins'))).find(path => /org\.eclipse\.equinox\.launcher_[^/\\]+\.jar$/.test(path));
      if (!launcher) throw new Error('JDTLS launcher is missing');
      const writableConfig = join(directory, 'jdtls-config');
      await cp(join(serverRoot, 'config_win'), writableConfig, { recursive: true });
      const lsp = pipe(await spawn({ command: java, args: [
        '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4', '-Declipse.product=org.eclipse.jdt.ls.core.product',
        `-Dosgi.install.area=${pathToFileURL(`${serverRoot}/`).href}`,
        '-Dlog.level=WARNING', '-Xmx768m', '--add-modules=ALL-SYSTEM', '--add-opens', 'java.base/java.util=ALL-UNNAMED',
        '--add-opens', 'java.base/java.lang=ALL-UNNAMED', '-jar', launcher, '-configuration', writableConfig, '-data', join(directory, 'jdtls-data'),
      ], cwd }, true), 'lsp');
      lsp.on('message', request => {
        if (request.id === undefined || !request.method) return;
        if (request.method === 'workspace/configuration') lsp.respond(request, (request.params?.items ?? []).map(() => ({ java: { autobuild: { enabled: true } } })));
        else if (request.method === 'workspace/applyEdit') lsp.respond(request, { applied: false, failureReason: 'Use the native file editor for edits' });
        else lsp.respond(request, null);
      });
      await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(scope.workspaceRoot).href,
        workspaceFolders: [{ uri: pathToFileURL(scope.workspaceRoot).href, name: basename(scope.workspaceRoot) }],
        capabilities: { workspace: { configuration: true, workspaceFolders: true }, window: { workDoneProgress: true } },
        initializationOptions: { bundles: [bundle], workspaceFolders: [pathToFileURL(scope.workspaceRoot).href],
          settings: { java: { configuration: { updateBuildConfiguration: 'automatic' }, import: { gradle: { enabled: true }, maven: { enabled: true } }, autobuild: { enabled: true } } } },
      }, 120000);
      lsp.notify('initialized', {});
      const command = (name: string, args: any[] = []) => lsp.request('workspace/executeCommand', { command: name, arguments: args }, 120000);
      if (config.request !== 'attach' && config.program?.endsWith('.java') && !config.classPaths) {
        // Plain Java sources need debug information even before JDT project import finishes.
        const sources = (await sourceFiles(dirname(config.program), '.java')).map(path => path);
        const outDir = join(directory, 'java-classes'); await mkdir(outDir);
        await runDebugProcess(broker, { command: config.javacPath ?? 'javac', args: ['-g', '-d', outDir, ...sources], cwd }, scope, signal);
        const source = await readFile(config.program, 'utf8');
        launch.mainClass ??= `${/\bpackage\s+([\w.]+)\s*;/.exec(source)?.[1] ? `${/\bpackage\s+([\w.]+)\s*;/.exec(source)![1]}.` : ''}${basename(config.program, '.java')}`;
        launch.classPaths = [outDir]; launch.sourcePaths = [scope.workspaceRoot, dirname(config.program)];
      } else if (config.request !== 'attach') {
        // Project resolution is awaited via the official JDTLS command, not a guessed sleep.
        const mains = await command('vscode.java.resolveMainClass', [pathToFileURL(scope.workspaceRoot).href]);
        const chosen = Array.isArray(mains) ? mains.find((item: any) => !config.mainClass || item.mainClass === config.mainClass) : undefined;
        launch.mainClass ??= chosen?.mainClass; launch.projectName ??= chosen?.projectName;
        if (!launch.mainClass) throw new Error('Select mainClass in launch.json for this Java project');
        if (!launch.classPaths) {
          const paths = await command('vscode.java.resolveClasspath', [launch.mainClass, launch.projectName ?? '']);
          launch.modulePaths = paths?.[0] ?? []; launch.classPaths = paths?.[1] ?? [];
        }
        launch.javaExec ??= await command('vscode.java.resolveJavaExecutable', [launch.mainClass, launch.projectName ?? '']) ?? 'java';
      }
      const port = await command('vscode.java.startDebugSession');
      protocol = await tcp(port);
      launch.type = 'java'; launch.javaExec ??= config.javaPath ?? 'java'; launch.shorteningCommandLine = 'none';
      delete launch.program; delete launch.javacPath; delete launch.javaPath;
    }
    return { protocol, launch, connectChild, spawnTerminal, dispose };
  } catch (error) { await dispose(); throw error; }
}
function terminalEnvironment(value: any): Record<string, string | undefined> {
  if (!value) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid terminal environment');
  const output: Record<string, string | undefined> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^DSH_/i.test(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || item !== null && typeof item !== 'string') throw new Error('Invalid terminal environment entry');
    output[key] = item === null ? undefined : item as string;
  }
  return output;
}
async function sourceFiles(root: string, suffix: string) {
  const files: string[] = []; let visited = 0, bytes = 0;
  const scan = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 20000) throw new Error('Debug source scan exceeds budget; select a prepared program');
      if (['node_modules', '.git', '.nexus', '.venv', 'venv', 'bin', 'obj', 'target'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile() && path.endsWith(suffix)) {
        files.push(path); bytes += (await stat(path)).size;
        if (files.length > 500 || bytes > 64 * 1024 * 1024) throw new Error('Debug build supports up to500 sources /64 MiB; select a prepared program');
      }
    }
  };
  await scan(root);
  if (!files.length) throw new Error('No source files found for debug build');
  return files;
}
async function compileTypeScript(program: string, scope: DebugScope, directory: string) {
  const configFile = ts.findConfigFile(dirname(program), ts.sys.fileExists);
  let parsed: ts.ParsedCommandLine | undefined;
  if (configFile && within(scope.workspaceRoot, configFile)) {
    const source = ts.readConfigFile(configFile, ts.sys.readFile);
    if (source.error) throw new Error('Invalid tsconfig.json');
    parsed = ts.parseJsonConfigFileContent(source.config, ts.sys, dirname(configFile));
    if (parsed.errors.length) throw new Error('tsconfig.json could not be resolved');
  }
  const outDir = join(directory, 'typescript'), rootDir = parsed?.options.rootDir ?? scope.workspaceRoot;
  if (!within(scope.workspaceRoot, rootDir) || !within(rootDir, program)) throw new Error('TypeScript rootDir must contain the program within the workspace');
  const sources = parsed?.fileNames ?? await sourceFiles(dirname(program), extname(program));
  if (sources.length > 2000 || sources.some(path => !within(scope.workspaceRoot, path))) throw new Error('TypeScript debug source set exceeds the workspace/budget');
  const module = parsed?.options.module ?? ts.ModuleKind.NodeNext;
  const options: ts.CompilerOptions = { ...parsed?.options, target: parsed?.options.target ?? ts.ScriptTarget.ES2022,
    module, moduleResolution: parsed?.options.moduleResolution ?? (module === ts.ModuleKind.NodeNext ? ts.ModuleResolutionKind.NodeNext : module === ts.ModuleKind.Node16 ? ts.ModuleResolutionKind.Node16 : undefined), rootDir, outDir,
    sourceMap: true, inlineSources: true, declaration: false, declarationMap: false, noEmit: false, noEmitOnError: false,
    incremental: false, composite: false, tsBuildInfoFile: undefined, rewriteRelativeImportExtensions: true };
  if ([ts.JsxEmit.Preserve, ts.JsxEmit.ReactNative].includes(options.jsx!)) throw new Error('Preserved JSX needs a project build task in local VS Code');
  // TypeScript's host reads dependencies for type resolution, but executable outputs are confined to managed storage.
  const host = ts.createCompilerHost(options), writer = host.writeFile;
  host.writeFile = (file, text, bom, error, source) => {
    if (!within(outDir, file)) throw new Error('TypeScript emit attempted to leave debug build storage');
    writer(file, text, bom, error, source);
  };
  const build = ts.createProgram(sources, options, host);
  const emitted = build.emit();
  if (emitted.emitSkipped) throw new Error('TypeScript debug build did not emit JavaScript');
  await preserveNodeResolution(scope.workspaceRoot, rootDir, outDir, sources);
  const extension = program.endsWith('.mts') ? '.mjs' : program.endsWith('.cts') ? '.cjs' : '.js';
  return { outDir, program: join(outDir, relative(rootDir, program).replace(/\.[cm]?tsx?$/, extension)) };
}
/** Keep Node's package/type and bare-import lookup beside managed emit without copying dependencies. */
async function preserveNodeResolution(workspace: string, rootDir: string, outDir: string, sources: string[]) {
  const copyContext = async (source: string, target: string, inherited = false) => {
    await mkdir(target, { recursive: true });
    for (const name of ['package.json', 'node_modules']) {
      let directory = source;
      while (within(workspace, directory)) {
        const candidate = join(directory, name);
        let info;
        try { info = await stat(candidate); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
        if (info) {
          const canonical = await realpath(candidate);
          if (!within(workspace, canonical)) throw new Error('TypeScript runtime dependency must stay inside the workspace; select a prepared program');
          if (name === 'package.json') {
            if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid or oversized Node package metadata');
            await cp(canonical, join(target, name));
          } else {
            if (!info.isDirectory()) throw new Error('Invalid local node_modules directory');
            // Node rm removes a junction itself; its workspace target is never part of the owned build tree.
            await symlink(canonical, join(target, name), process.platform === 'win32' ? 'junction' : 'dir');
          }
          break;
        }
        if (!inherited || directory === workspace) break;
        const parent = dirname(directory); if (parent === directory) break; directory = parent;
      }
    }
  };
  await copyContext(rootDir, outDir, true);
  const directories = new Set<string>();
  for (const source of sources) {
    let directory = dirname(source);
    while (within(rootDir, directory) && directory !== rootDir) {
      directories.add(directory);
      if (directories.size > 20000) throw new Error('TypeScript package lookup exceeds budget');
      const parent = dirname(directory); if (parent === directory) break; directory = parent;
    }
  }
  for (const directory of directories) await copyContext(directory, join(outDir, relative(rootDir, directory)));
}
