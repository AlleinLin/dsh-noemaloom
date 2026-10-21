import type { Readable, Writable } from 'node:stream';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NexusError, type NexusHost } from '../../ports/contracts.js';
import type { HostContext } from '../types.js';
import type { DebugScope } from '../../shared/debug.js';
import { workspacePath } from '../../domain/files/paths.js';
import { redactString } from '../../domain/operations/index.js';

export interface DebugProcess {
  pid?: number; input: Writable; output: Readable; stderr: Readable;
  done: Promise<{ exitCode: number | null }>; terminate(): Promise<void>;
}
export interface DebugProcessSpec { command: string; args: string[]; cwd: string; env?: Record<string, string | undefined> }
export interface DebugBroker {
  resolveExecutable(command: string, env: Record<string, string | undefined>, signal: AbortSignal): Promise<string>;
  spawn(spec: DebugProcessSpec, scope: DebugScope, signal: AbortSignal): Promise<DebugProcess>;
}
export function createDebugBroker(ctx: HostContext, host: NexusHost, managedRoot: string): DebugBroker {
  return {
    async resolveExecutable(command, env, signal) {
      const subprocess = ctx.get('subprocess');
      if (!subprocess?.resolveExecutable) throw new NexusError('DEPENDENCY_MISSING', 'Executable resolution provider unavailable');
      return subprocess.resolveExecutable(command, env, signal);
    },
    async spawn(spec, scope, signal) {
      const subprocess = ctx.get('subprocess'), policies = ctx.get('sandboxPolicy');
      if (!subprocess?.spawn || !policies?.resolve) throw new NexusError('DEPENDENCY_MISSING', 'DSH subprocess/sandboxPolicy unavailable');
      if (!spec.command || [spec.command, ...spec.args].some(value => typeof value !== 'string' || value.includes('\0'))) throw new NexusError('INVALID_ARGUMENT', 'Invalid executable arguments');
      const cwd = await realpath(resolve(spec.cwd));
      try { await workspacePath(scope.workspaceRoot, cwd); }
      catch { await workspacePath(managedRoot, cwd); }
      const env = spec.env ?? {};
      if (Object.keys(env).some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^DSH_/i.test(key))) throw new NexusError('INVALID_ARGUMENT', 'Debug environment key is not allowed');
      if (!await host.approve('debug.execute', cwd, { command: spec.command, args: spec.args, sessionId: scope.sessionId })) throw new NexusError('PERMISSION_DENIED', 'Debugger process was not authorized');
      const executable = await subprocess.resolveExecutable(spec.command, env, signal);
      const session = ctx.get('agents')?.get?.(scope.sessionId)?.session;
      const policy = policies.resolve(session ? { session } : undefined);
      let argv = [executable, ...spec.args];
      if (policy.mode !== 'danger-full-access') {
        const sandbox = ctx.get('sandbox');
        if (!sandbox?.confine) throw new NexusError('DEPENDENCY_MISSING', 'Sandbox execution provider unavailable');
        argv = [...(await sandbox.confine(argv, policy, signal)).argv];
      }
      const handle = subprocess.spawn({ argv, cwd, env, signal, graceMs: 1500,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } });
      if (!handle.stdin || !handle.stdout || !handle.stderr) { handle.terminate(); throw new Error('Debug protocol pipes unavailable'); }
      return {
        pid: handle.pid, input: handle.stdin, output: handle.stdout, stderr: handle.stderr,
        done: handle.done,
        async terminate() {
          handle.terminate();
          if (!await handle.waitForExit(AbortSignal.timeout(15000))) throw new Error('Owned debugger range did not exit within 15 seconds');
        },
      };
    },
  };
}
export async function runDebugProcess(broker: DebugBroker, spec: DebugProcessSpec, scope: DebugScope, signal: AbortSignal, timeoutMs = 120000) {
  const stop = new AbortController(), combined = AbortSignal.any([signal, stop.signal]);
  const timer = setTimeout(() => stop.abort(new Error('Debug preparation timed out')), timeoutMs);
  let child: DebugProcess;
  try { child = await broker.spawn(spec, scope, combined); } catch (error) { clearTimeout(timer); throw error; }
  let stdout = '', stderr = '';
  child.output.on('data', bytes => { stdout = (stdout + bytes.toString()).slice(-262144); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-32768); });
  try {
    const result = await child.done;
    if (result.exitCode !== 0) throw new Error(`Debug preparation exited ${result.exitCode}: ${redactString(stderr || stdout, 2000)}`);
    return stdout;
  } finally { clearTimeout(timer); await child.terminate(); }
}
