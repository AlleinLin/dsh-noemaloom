import ts from 'typescript';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, isAbsolute } from 'node:path';
import { workspacePath } from '../../domain/files/paths.js';
import { NexusError } from '../../ports/contracts.js';
import type { DebugLanguage, DebugLaunch, DebugScope } from '../../shared/debug.js';

const languages: Record<string, DebugLanguage> = { node: 'node', 'pwa-node': 'node', node2: 'node', python: 'python', debugpy: 'python', java: 'java', coreclr: 'csharp', lldb: 'rust', codelldb: 'rust' };
export function debugLanguage(config: DebugLaunch): DebugLanguage {
  const language = languages[String(config.type)];
  if (!language) throw new NexusError('FORMAT_UNSUPPORTED', `Debug type ${config.type} requires local VS Code`);
  return language;
}
export async function launchConfigurations(scope: DebugScope, file?: string) {
  let configurations: DebugLaunch[] = [];
  try {
    const path = await workspacePath(scope.workspaceRoot, '.vscode/launch.json');
    const source = await readFile(path, 'utf8');
    if (source.length > 1024 * 1024) throw new Error('launch.json exceeds 1 MiB');
    const parsed = ts.parseConfigFileTextToJson(path, source);
    if (parsed.error) throw new Error('Invalid launch.json JSONC');
    if (!Array.isArray(parsed.config.configurations ?? [])) throw new Error('launch.json configurations must be an array');
    configurations = (parsed.config.configurations ?? []).map((item: DebugLaunch) => ({ ...item,
      supported: Boolean(languages[String(item.type)]) && languages[String(item.type)] !== 'rust' && !item.preLaunchTask && !item.postDebugTask }));
  } catch (error) {
    if (error instanceof NexusError && error.code === 'NOT_FOUND') { /* defaults below */ }
    else throw error;
  }
  if (!configurations.length && file) {
    const suffix = extname(file).toLowerCase();
    const type = /\.(?:[cm]?[jt]sx?)$/.test(suffix) ? 'pwa-node' : suffix === '.py' ? 'debugpy' : suffix === '.java' ? 'java' : suffix === '.cs' ? 'coreclr' : undefined;
    if (type) configurations.push({ name: `Debug ${basename(file)}`, type, request: 'launch', program: file });
  }
  return configurations;
}
/** Only implemented VS Code variables are expanded. No extension commands. */
export async function resolveLaunch(raw: DebugLaunch, scope: DebugScope, file?: string): Promise<DebugLaunch> {
  const source = { ...raw, ...(process.platform === 'win32' ? raw.windows : raw.linux) };
  delete source.windows; delete source.linux; delete source.osx; delete source.supported;
  if (source.preLaunchTask || source.postDebugTask) throw new NexusError('FORMAT_UNSUPPORTED', 'Extension/shell tasks need local VS Code; use the built-in language build or a prepared program');
  const active = file ? await workspacePath(scope.workspaceRoot, file) : undefined;
  const variables: Record<string, string | undefined> = {
    workspaceFolder: scope.workspaceRoot, workspaceFolderBasename: basename(scope.workspaceRoot), file: active,
    relativeFile: active ? relative(scope.workspaceRoot, active) : undefined,
    relativeFileDirname: active ? dirname(relative(scope.workspaceRoot, active)) : undefined,
    fileDirname: active ? dirname(active) : undefined, fileBasename: active ? basename(active) : undefined,
    fileBasenameNoExtension: active ? basename(active, extname(active)) : undefined, pathSeparator: process.platform === 'win32' ? '\\' : '/',
  };
  function expand(value: any): any {
    if (typeof value === 'string') return value.replace(/\$\{([^}]+)\}/g, (_all, key: string) => {
      const result = key.startsWith('env:') ? process.env[key.slice(4)] : variables[key];
      if (result === undefined || key.startsWith('command:') || key.startsWith('input:')) throw new NexusError('FORMAT_UNSUPPORTED', `Unsupported/unavailable launch variable: ${key}`);
      return result;
    });
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
    return value;
  }
  const config = expand(source) as DebugLaunch;
  debugLanguage(config);
  if (config.request && !['launch', 'attach'].includes(config.request)) throw new Error('Unsupported debug request');
  config.request ??= 'launch';
  config.cwd = await workspacePath(scope.workspaceRoot, config.cwd ?? '.');
  if (config.program) config.program = await workspacePath(scope.workspaceRoot, config.program);
  if (config.args && (!Array.isArray(config.args) || config.args.some(value => typeof value !== 'string'))) throw new Error('Debug args must be strings');
  if (config.env && (Array.isArray(config.env) || Object.values(config.env).some(value => value !== null && typeof value !== 'string'))) throw new Error('Debug env values must be strings/null');
  if (config.env && Object.keys(config.env).some(key => /^DSH_/i.test(key))) throw new Error('DSH environment forwarding is not permitted');
  if (config.request === 'attach') {
    if (config.processId) throw new NexusError('FORMAT_UNSUPPORTED', 'Process pickers/attach by PID require local VS Code; use explicit loopback port');
    const endpoint = config.connect ?? config;
    const host = endpoint.host ?? config.address ?? config.hostName ?? '127.0.0.1';
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Attach is restricted to loopback');
    const port = endpoint.port ?? config.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Attach needs an explicit loopback port');
  }
  if (config.console && !['internalConsole', 'integratedTerminal'].includes(config.console)) throw new Error('Use local VS Code for external terminal launch');
  return config;
}
export async function projectFile(root: string, suffix: string): Promise<string | undefined> {
  const found = (await readdir(root)).filter(name => name.endsWith(suffix));
  if (found.length > 1) throw new Error(`Multiple ${suffix} projects; select program/project in launch.json`);
  return found[0] ? join(root, found[0]) : undefined;
}
