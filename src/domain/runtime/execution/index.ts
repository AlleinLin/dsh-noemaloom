import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { NexusError, type ExecutionOptions, type NexusExecutor, type NexusHost } from '../../../ports/contracts.js';
import type { HostContext } from '../../../host/types.js';

/**
 * The sole subprocess broker. Uses the host execution world, resolved sandbox,
 * and its managed-range termination; never node:child_process.
 */
export function createHostExecutor(
  ctx: HostContext, host: NexusHost, workspaceRoot: string, pluginSignal?: AbortSignal,
  trustedScope?: () => { workspaceRoot?: string; sessionId?: string; managedRoots?: string[] },
): NexusExecutor & { dispose(): Promise<void> } {
  const handles = new Set<any>();
  return {
    async run(command: string, args: string[], options: ExecutionOptions = {}) {
      if (!command || command.includes('\0') || !Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0'))) {
        throw new NexusError('INVALID_ARGUMENT', '可执行文件及参数无效');
      }
      const subprocess = ctx.get('subprocess');
      const policyService = ctx.get('sandboxPolicy');
      if (!subprocess?.spawn || !subprocess?.resolveExecutable || !policyService?.resolve) {
        throw new NexusError('DEPENDENCY_MISSING', '需要 DSH subprocess 与 sandboxPolicy 服务');
      }
      const authority = trustedScope?.();
      const cwd = await realpath(resolve(options.cwd ?? authority?.workspaceRoot ?? workspaceRoot));
      const roots = (await Promise.all([authority?.workspaceRoot ?? workspaceRoot, ...(authority?.managedRoots ?? [])].map(root =>
        realpath(root).catch(error => { if (error?.code === 'ENOENT') return undefined; throw error; })))).filter((root): root is string => Boolean(root));
      if (!roots.some(root => { const rel = relative(root, cwd); return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel); })) throw new NexusError('PERMISSION_DENIED', '命令目录超出当前工作区和已授权托管目录');
      const approved = await host.approve('runtime.execute', cwd, { command, args, cwd });
      if (!approved) throw new NexusError('PERMISSION_DENIED', '宿主未授权此命令');
      const own = new AbortController();
      const signals = [own.signal, options.signal, pluginSignal].filter(Boolean) as AbortSignal[];
      const signal = AbortSignal.any(signals);
      const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 120000, 1), 3600000);
      const timeout = setTimeout(() => own.abort(new NexusError('CANCELLED', '命令超时')), timeoutMs);
      timeout.unref();
      const started = performance.now();
      let handle: any;
      let outputTimer: ReturnType<typeof setInterval> | undefined;
      let flushOutput = () => {};
      try {
        const env = options.env ?? {};
        for (const name of Object.keys(env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^DSH_/i.test(name)) throw new NexusError('INVALID_ARGUMENT', '环境变量名称不允许');
        }
        const executable = await subprocess.resolveExecutable(command, env, signal);
        const session = authority?.sessionId ? ctx.get('agents')?.get?.(authority.sessionId)?.session : undefined;
        const policy = policyService.resolve(session ? { session } : undefined);
        let argv: string[] = [executable, ...args];
        if (policy.mode !== 'danger-full-access') {
          const sandbox = ctx.get('sandbox');
          if (!sandbox?.confine) throw new NexusError('DEPENDENCY_MISSING', '当前文件策略需要 DSH sandbox 执行器');
          const confined = await sandbox.confine(argv, policy, signal);
          argv = confined.argv;
          if (!Array.isArray(argv) || !argv.length) throw new NexusError('HOST_CONTRACT_UNSUPPORTED', 'sandbox 未返回受限 argv');
        }
        const maxBytes = Math.min(Math.max(options.maxOutputBytes ?? 65536, 1024), 4 * 1024 * 1024);
        handle = subprocess.spawn({
          argv, cwd, env, signal, graceMs: 2000,
          stdio: { stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin }, stdout: { maxBytes }, stderr: { maxBytes } },
        });
        handles.add(handle);
        if (options.onOutput) {
          const offsets = { stdout: 0, stderr: 0 };
          flushOutput = () => {
            for (const stream of ['stdout', 'stderr'] as const) {
              try {
                const output = handle.collected[stream]?.readFrom(offsets[stream]);
                if (!output) continue;
                offsets[stream] = output.nextOffset;
                if (!output.text && !output.lossy) continue;
                // Observers cannot consume collected output or affect process life.
                try {
                  void Promise.resolve(options.onOutput!({
                    stream, text: output.text, nextOffset: output.nextOffset, lossy: output.lossy,
                  })).catch(() => undefined);
                } catch { /* A presentation failure must not stop the command. */ }
              } catch { /* Final collected reads retain their existing error semantics. */ }
            }
          };
          flushOutput();
          outputTimer = setInterval(flushOutput, 100);
          outputTimer.unref();
        }
        const outcome = await handle.done;
        await handle.waitForExit();
        flushOutput();
        const stdout = handle.collected.stdout?.readFrom(0);
        const stderr = handle.collected.stderr?.readFrom(0);
        return {
          exitCode: outcome.exitCode ?? null, stdout: stdout?.text ?? '', stderr: stderr?.text ?? '',
          cancelled: signal.aborted, durationMs: Math.round(performance.now() - started),
          truncated: Boolean(stdout?.lossy || stderr?.lossy),
        };
      } finally {
        clearTimeout(timeout);
        if (outputTimer) clearInterval(outputTimer);
        if (handle) {
          try {
            if (signal.aborted) handle.terminate();
            await handle.waitForExit();
          } finally {
            flushOutput();
            handles.delete(handle);
          }
        }
      }
    },
    async dispose() {
      const active = [...handles];
      for (const handle of active) handle.terminate();
      await Promise.allSettled(active.map(handle => handle.waitForExit()));
      handles.clear();
    },
  };
}
