import { createHash } from 'node:crypto';
import { realpath, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, extname } from 'node:path';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { approveEscalation } from '@deepseek-ai/dsh-sandbox';

const authorities = new WeakMap();
const failure = (code, message) => new HarnessError(`[${code}] ${message}`, code);
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pathIdentity = path => process.platform === 'win32' ? path.toLowerCase() : path;
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
function checkedArguments(value) {
  if (!Array.isArray(value) || value.some(arg => typeof arg !== 'string' || arg.includes('\0'))
    || Buffer.byteLength(JSON.stringify(value)) > 65536) {
    throw failure('NX_COMPUTER_PLAN_INVALID', 'The exact launch argv must be strings without NUL and fit 64 KiB.');
  }
  return [...value];
}
async function executableIdentity(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw failure('NX_COMPUTER_TARGET_UNVERIFIABLE', 'An absolute executable path is required before native approval.');
  }
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isFile()) throw failure('NX_COMPUTER_TARGET_UNVERIFIABLE', 'The launch target is not a regular file.');
  return { path: canonical, bytes: info.size, sha256: createHash('sha256').update(await readFile(canonical)).digest('hex') };
}
function authority(exec) {
  const value = authorities.get(exec);
  if (!value) throw failure('NX_COMPUTER_AUTHORITY_UNAVAILABLE', 'The native computer tool execution owner is unavailable.');
  value.assertCurrent();
  return value;
}

/**
 * Called by the adapted original launcher after it computes the exact spawn
 * argv. Its returned canonical plan is the argv the original launcher uses.
 */
export async function authorizeNativeAppLaunch(exec, proposed) {
  const owner = authority(exec);
  let executable = proposed.file;
  if (proposed.viaExplorer) {
    const windowsRoot = process.env.SystemRoot;
    if (!windowsRoot || !isAbsolute(windowsRoot)) {
      throw failure('NX_COMPUTER_TARGET_UNVERIFIABLE', 'The native Windows shell path cannot be established.');
    }
    executable = join(windowsRoot, 'explorer.exe');
  }
  const program = await executableIdentity(executable);
  const cwd = await realpath(proposed.cwd ?? exec.agent.session.header.cwd);
  if (!(await stat(cwd)).isDirectory()) throw failure('NX_COMPUTER_PLAN_INVALID', 'The launch cwd is not a directory.');
  const argv = checkedArguments(proposed.arguments);
  let inspection;
  if (proposed.inspectWindows !== false) {
    const windowsRoot = process.env.SystemRoot;
    inspection = await executableIdentity(proposed.powershell
      ?? (windowsRoot && join(windowsRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')));
  }
  let targetIdentity;
  if (proposed.viaExplorer) {
    if (typeof proposed.target !== 'string' || proposed.target.includes('\0')) {
      throw failure('NX_COMPUTER_TARGET_UNVERIFIABLE', 'The exact shell activation target is unavailable.');
    }
    if (isAbsolute(proposed.target)) targetIdentity = await executableIdentity(proposed.target);
    else if (!/^shell:AppsFolder\\[^\x00-\x1f]+$/i.test(proposed.target)) {
      let url;
      try { url = new URL(proposed.target); } catch { /* fail closed below */ }
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw failure('NX_COMPUTER_TARGET_UNVERIFIABLE', 'This shell target has no verifiable file, HTTP(S) URL or Store activation identity.');
      }
    }
  } else if (!['.exe', '.com'].includes(extname(program.path).toLowerCase())) {
    throw failure('NX_COMPUTER_TARGET_UNVERIFIABLE', 'Direct Windows launch requires an existing executable; script interpreter selection cannot be verified.');
  }
  const plan = freeze({ kind: 'native-process-launch', program, argv, cwd,
    shellActivation: proposed.viaExplorer === true, requestedTarget: proposed.target,
    ...(targetIdentity ? { shellTargetFile: targetIdentity } : {}),
    ...(inspection ? { windowObservationProgram: inspection } : {}) });
  await owner.authorize(plan);
  const current = await executableIdentity(program.path);
  if (fingerprint(current) !== fingerprint(program) || pathIdentity(await realpath(cwd)) !== pathIdentity(cwd)) {
    throw failure('NX_COMPUTER_TARGET_CHANGED', 'The approved executable or cwd changed; no process was started.');
  }
  if (targetIdentity && fingerprint(await executableIdentity(targetIdentity.path)) !== fingerprint(targetIdentity)) {
    throw failure('NX_COMPUTER_TARGET_CHANGED', 'The approved shell target file changed; no process was started.');
  }
  if (inspection && fingerprint(await executableIdentity(inspection.path)) !== fingerprint(inspection)) {
    throw failure('NX_COMPUTER_TARGET_CHANGED', 'The approved window-observation executable changed; no process was started.');
  }
  owner.assertCurrent();
  return { file: program.path, arguments: argv, cwd, ...(inspection ? { powershell: inspection.path } : {}) };
}

/**
 * One owner for native session identity, the original grant/revoke table and
 * native sandbox escalation. ToolRuntime's existing guards run before this
 * wrapper; no second tool registration or shadow execution lane is created.
 */
export function createComputerUsePolicy(ctx, { requireGrant, execution, resolveBrowserEndpoint }) {
  const browserCalls = new Map();
  async function ownBrowserCall(exec) {
    const key = String(exec.agent.id), previous = browserCalls.get(key) ?? Promise.resolve();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const tail = previous.then(() => held);
    browserCalls.set(key, tail);
    const finish = () => {
      release();
      if (browserCalls.get(key) === tail) void tail.then(() => {
        if (browserCalls.get(key) === tail) browserCalls.delete(key);
      });
    };
    let onAbort;
    try {
      await Promise.race([previous, new Promise((_, reject) => {
        onAbort = () => reject(exec.signal.reason ?? failure('NX_COMPUTER_CANCELLED', 'The browser call was cancelled before dispatch.'));
        exec.signal.addEventListener('abort', onAbort, { once: true });
        if (exec.signal.aborted) onAbort();
      })]);
      exec.signal.throwIfAborted();
      return finish;
    } catch (error) {
      finish();
      throw error;
    } finally {
      exec.signal.removeEventListener('abort', onAbort);
    }
  }
  function assertCurrent(exec, expectedArgs) {
    exec.signal.throwIfAborted();
    const agent = exec.agent;
    if (!agent || ctx.get('agents')?.get?.(agent.id) !== agent
      || ctx.get('sessions')?.get?.(agent.id) !== agent.session) {
      throw failure('NX_COMPUTER_CALLER_STALE', 'The exact live native Agent and Session are required.');
    }
    if (expectedArgs !== undefined && fingerprint(exec.arguments) !== expectedArgs) {
      throw failure('NX_COMPUTER_ARGUMENTS_CHANGED', 'The guarded tool arguments changed during authorization.');
    }
    requireGrant(exec);
  }
  async function authorize(exec, plan, expectedArgs) {
    assertCurrent(exec, expectedArgs);
    const policyService = ctx.get('sandboxPolicy');
    const policy = policyService?.resolve?.({ session: exec.agent.session });
    if (!policy || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)
      || typeof policy.workspaceRoot !== 'string') {
      throw failure('NX_COMPUTER_POLICY_UNAVAILABLE', 'Native sandbox policy is unavailable; no host action was dispatched.');
    }
    const root = await realpath(policy.workspaceRoot);
    const exact = JSON.stringify(plan);
    if (Buffer.byteLength(exact) > 65536) throw failure('NX_COMPUTER_PLAN_INVALID', 'The exact action plan exceeds 64 KiB.');
    await approveEscalation({
      requestedMode: 'danger-full-access', effectiveMode: policy.mode, subject: 'desktop operation',
      justification: `This GUI/CDP operation cannot enforce file confinement. Authorize only this exact operation (sha256=${fingerprint(plan)}): ${exact}`,
    }, { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: exec.name, signal: exec.signal });
    const current = policyService.resolve({ session: exec.agent.session });
    if (current.mode !== policy.mode || pathIdentity(await realpath(current.workspaceRoot)) !== pathIdentity(root)) {
      throw failure('NX_COMPUTER_POLICY_CHANGED', 'Native policy changed during authorization; the operation was not dispatched.');
    }
    assertCurrent(exec, expectedArgs);
  }
  return {
    wrap(definition) {
      const controlled = definition.name === 'app_launch' || definition.name.startsWith('browser_')
        || definition.name.startsWith('computer_') && definition.name !== 'computer_stop';
      if (!controlled) return definition;
      const original = definition.execute;
      return { ...definition, async execute(args, exec) {
        const expectedArgs = fingerprint(exec.arguments);
        assertCurrent(exec, expectedArgs);
        const exactArgs = freeze(structuredClone(args));
        return execution.runSessionCall(exec, { timeoutMs: 360000, label: definition.name }, async ({ signal }) => {
          const scoped = { ...exec, name: definition.name, signal };
          const cleanups = [];
          const owner = {
            assertCurrent: () => assertCurrent(scoped, expectedArgs),
            authorize: plan => authorize(scoped, plan, expectedArgs),
            cleanups,
            endpoint: undefined,
            desktopAuthorized: false,
          };
          authorities.set(scoped, owner);
          try {
            if (definition.name.startsWith('computer_') && definition.name !== 'computer_launch') {
              // Even a read can write a capture or activate a window while
              // resolving a cited frame. Approve the whole exact native tool.
              await owner.authorize(freeze({ kind: 'native-desktop-tool', tool: definition.name, arguments: exactArgs }));
              owner.desktopAuthorized = true;
            }
            if (definition.name.startsWith('browser_')) {
              cleanups.push(await ownBrowserCall(scoped));
              const endpoint = resolveBrowserEndpoint(String(exec.agent.id));
              if (endpoint) {
                const url = new URL(endpoint);
                if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
                  || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
                  throw failure('NX_COMPUTER_ENDPOINT_UNVERIFIABLE', 'Only an explicit plain loopback CDP origin is authorized.');
                }
                owner.endpoint = endpoint;
                await owner.authorize(freeze({ kind: 'native-browser-cdp', endpoint, tool: definition.name, arguments: exactArgs }));
              }
            }
            owner.assertCurrent();
            return await original.call(this, exactArgs, scoped);
          } finally {
            for (const cleanup of cleanups.reverse()) cleanup();
            authorities.delete(scoped);
          }
        });
      } };
    },
    async desktop(exec, command, args) {
      const owner = authority(exec);
      if (!owner.desktopAuthorized) {
        await owner.authorize(freeze({ kind: 'native-desktop-action', command, arguments: structuredClone(args) }));
      }
      owner.assertCurrent();
    },
    async launch(exec, args, call) {
      const owner = authority(exec);
      const request = { target: args.target, arguments: args.arguments ?? [], cwd: exec.agent.session.header.cwd,
        waitSeconds: args.wait_seconds, refresh: args.refresh_discovery === true };
      const plan = await call(exec, 'nexus_launch_plan', request, { timeoutMs: 40000 });
      if (!plan || plan.version !== 1 || typeof plan.executable !== 'string'
        || !isAbsolute(plan.executable) || !/^[a-f0-9]{64}$/i.test(plan.executableSha256 ?? '')) {
        throw failure('NX_COMPUTER_TARGET_UNVERIFIABLE', 'The Windows worker could not establish the actual launch executable and argv.');
      }
      checkedArguments(plan.argv);
      const program = await executableIdentity(plan.executable);
      if (pathIdentity(program.path) !== pathIdentity(plan.executable) || program.sha256 !== plan.executableSha256
        || typeof plan.cwd !== 'string' || pathIdentity(await realpath(plan.cwd)) !== pathIdentity(plan.cwd)) {
        throw failure('NX_COMPUTER_TARGET_UNVERIFIABLE', 'The worker launch plan does not identify canonical executable bytes and cwd.');
      }
      for (const target of [plan.targetIdentity, plan.shortcut?.target].filter(Boolean)) {
        const identity = await executableIdentity(target.path);
        if (pathIdentity(identity.path) !== pathIdentity(target.path) || identity.sha256 !== target.sha256) {
          throw failure('NX_COMPUTER_TARGET_UNVERIFIABLE', 'The worker launch target or shortcut bytes cannot be verified.');
        }
      }
      await owner.authorize(freeze({ kind: 'native-resolved-launch', plan }));
      owner.assertCurrent();
      return call(exec, 'launch', { ...request, nexusExpectedPlan: plan }, { timeoutMs: 40000 });
    },
    trackConnection(exec, endpoint, connection) {
      const owner = authority(exec);
      if (owner.endpoint !== endpoint || resolveBrowserEndpoint(String(exec.agent.id)) !== endpoint) {
        throw failure('NX_COMPUTER_ENDPOINT_UNVERIFIABLE', 'The CDP channel has no unchanged exact native authorization.');
      }
      connection.nexusCallSignal = exec.signal;
      const abort = () => connection.close('The native tool/session was cancelled', 'CDP_CANCELLED');
      exec.signal.addEventListener('abort', abort, { once: true });
      owner.cleanups.push(() => {
        exec.signal.removeEventListener('abort', abort);
        if (connection.nexusCallSignal === exec.signal) connection.nexusCallSignal = undefined;
      });
      exec.signal.throwIfAborted();
    },
  };
}
