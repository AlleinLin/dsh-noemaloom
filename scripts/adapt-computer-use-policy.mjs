import { readFile } from 'node:fs/promises';

function once(source, anchor, replacement, label) {
  const offset = source.indexOf(anchor);
  if (offset < 0 || source.indexOf(anchor, offset + anchor.length) !== -1) {
    throw new Error(`Computer-use ${label}: upstream anchor changed`);
  }
  return source.slice(0, offset) + replacement + source.slice(offset + anchor.length);
}

export function adaptComputerPolicyHost(source) {
  let result = once(source, "export const inject = bootstrapError === null ? ['tools', 'connection'] : ['connection'];",
    "export const inject = bootstrapError === null ? ['tools', 'connection', 'agents', 'sessions', 'sandboxPolicy', 'approval'] : ['connection'];",
    'native policy service lifetime with diagnostic-only degraded mode');
  result = once(result,
    'const defineTracedTool = (definition) => defineTool(withTrace(definition));',
    `const nexusComputerPolicy = createComputerUsePolicy(ctx, { requireGrant, execution, resolveBrowserEndpoint });
  const defineTracedTool = (definition) => defineTool(withTrace(nexusComputerPolicy.wrap(definition)));`, 'tool ownership');
  result = once(result, 'assertBackendArgs(cmd, args);', `assertBackendArgs(cmd, args);
    if (cmd !== 'launch' && movesDesktop(cmd, args)) await nexusComputerPolicy.desktop(exec, cmd, args);
    requireGrant(exec);
    exec.signal.throwIfAborted();`, 'desktop native policy');
  result = once(result,
    "const managed = managedBrowsers.get(String(sessionKey)) ?? [...managedBrowsers.values()][0];",
    'const managed = managedBrowsers.get(String(sessionKey));', 'browser session ownership');
  result = once(result, 'async function browserSessionFor(sessionKey, endpoint) {',
    'async function browserSessionFor(sessionKey, endpoint, exec) {', 'CDP execution identity');
  result = once(result, 'const connection = new CdpConnection({ endpoint });',
    `const connection = new CdpConnection({ endpoint, signal: exec.signal });
    nexusComputerPolicy.trackConnection(exec, endpoint, connection);`, 'CDP startup cancellation');
  result = once(result, 'if (existing !== undefined && existing.connection.connected) return existing;',
    `if (existing !== undefined && existing.connection.connected) {
      nexusComputerPolicy.trackConnection(exec, endpoint, existing.connection);
      return existing;
    }`, 'CDP reused channel cancellation');
  for (const [anchor, replacement] of [
    ['const tabs = await session.tabs({ timeoutMs: args.timeout_ms });', 'const tabs = await session.tabs({ timeoutMs: args.timeout_ms, signal: exec.signal });'],
    ['const tabs = await session.tabs({ timeoutMs: 2000 });', 'const tabs = await session.tabs({ timeoutMs: 2000, signal: exec.signal });'],
    ['const now = await session.tabs({ timeoutMs: 2000 });', 'const now = await session.tabs({ timeoutMs: 2000, signal: exec.signal });'],
  ]) result = once(result, anchor, replacement, 'CDP target-list execution cancellation');
  const anchor = 'browser = await browserSessionFor(sessionKey, endpoint);';
  if (result.split(anchor).length !== 3) throw new Error('Computer-use expected two CDP tool call sites');
  result = result.replaceAll(anchor, 'browser = await browserSessionFor(sessionKey, endpoint, exec);');
  result = once(result, `const result = await call(exec, 'launch', {
        target: args.target,
        arguments: Array.isArray(args.arguments) ? args.arguments.map((a) => String(a)) : undefined,
        waitSeconds: args.wait_seconds,
        refresh: args.refresh_discovery === true ? true : undefined,
      }, { timeoutMs: Math.max(actionTimeoutMs, 40_000) });`,
    'const result = await nexusComputerPolicy.launch(exec, args, call);', 'resolved launch approval');
  return "import { createComputerUsePolicy } from './internal/nexus-policy.mjs';\n" + result;
}

export function adaptAppLaunchEntry(source) {
  let result = once(source, 'async execute(args) {\n      return launchApp({',
    'async execute(args, exec) {\n      return launchApp({', 'app execution identity');
  result = once(result, 'powershell: settings.powershell,',
    `powershell: settings.powershell,
        signal: exec.signal,
        authorize: plan => authorizeNativeAppLaunch(exec, plan),`, 'exact app argv authorization');
  return "import { authorizeNativeAppLaunch } from './nexus-policy.mjs';\n" + result;
}

export function adaptAppLaunchRuntime(source) {
  let result = once(source, 'const cwd = options.cwd && existsSync(options.cwd) ? options.cwd : undefined;',
    "let cwd = options.cwd;\n  if (cwd !== undefined && (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory())) throw new Error('[NX_COMPUTER_TARGET_UNVERIFIABLE] The requested cwd does not exist as an absolute directory.');", 'app cwd');
  result = once(result, 'const args = resolved.viaExplorer', 'let args = resolved.viaExplorer', 'canonical app argv');
  result = once(result, 'let child = null;\n  let spawnError = null;',
    `if (typeof options.authorize !== 'function' || !options.signal) throw new Error('[NX_COMPUTER_AUTHORITY_UNAVAILABLE] The native execution authorization is unavailable.');
  const approved = await options.authorize({ file: resolved.file, arguments: args, cwd,
    viaExplorer: resolved.viaExplorer, target: resolved.target,
    inspectWindows: options.verifyWindow !== false, powershell: options.powershell });
  resolved.file = approved.file;
  args = approved.arguments;
  cwd = approved.cwd;
  options.powershell = approved.powershell;
  options.signal.throwIfAborted();
  let child = null;
  let spawnError = null;`, 'app dispatch boundary');
  result = once(result, 'if (slice > 0) await new Promise((resolve) => setTimeout(resolve, slice));',
    `if (options.signal.aborted) break;
    if (slice > 0) await new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); options.signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, slice);
      options.signal.addEventListener('abort', finish, { once: true });
      if (options.signal.aborted) finish();
    });
    if (options.signal.aborted) break;`, 'app observation cancellation');
  result = once(result,
    'inspection = await inspectWindowsAsync(pid, imageName, options.powershell, launchedAt);',
    'inspection = await inspectWindowsAsync(pid, imageName, options.powershell, launchedAt, options.signal);', 'app inspection cancellation');
  result = once(result, "const hint = state === 'launch-failed'",
    "const hint = options.signal.aborted\n    ? 'The launch was dispatched before cancellation; the application may remain running. Observe its existing pid/window and do not replay the launch.'\n    : state === 'launch-failed'", 'app truthful cancellation receipt');
  result = once(result,
    "export function inspectWindowsAsync(pid, imageName, powershell = 'powershell.exe', since = 0) {",
    "export function inspectWindowsAsync(pid, imageName, powershell = 'powershell.exe', since = 0, signal) {", 'inspection signal');
  return once(result,
    "child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });",
    "child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, signal });", 'inspection child cancellation');
}

export function adaptCdpConnection(source) {
  let result = once(source, "this.endpoint = String(options.endpoint ?? '');",
    "this.endpoint = String(options.endpoint ?? '');\n    this.nexusStartupSignal = options.signal;", 'CDP signal owner');
  result = once(result, "this.state = 'connecting';",
    "this.nexusStartupSignal?.throwIfAborted();\n    this.state = 'connecting';", 'CDP pre-discovery cancel');
  result = once(result,
    'this.negotiated = await discoverEndpoint(this.endpoint, { timeoutMs: Math.min(this.connectTimeoutMs, 2000) });',
    `this.negotiated = await discoverEndpoint(this.endpoint, {
      timeoutMs: Math.min(this.connectTimeoutMs, 2000), signal: this.nexusStartupSignal });
    this.nexusStartupSignal?.throwIfAborted();`, 'CDP pre-socket cancel');
  result = once(result, 'const response = await fetchImpl(url, { signal: controller.signal });',
    "const response = await fetchImpl(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });", 'CDP HTTP cancellation');
  result = once(result, 'async function fetchJson(url, { fetchImpl, timeoutMs, what }) {',
    'async function fetchJson(url, { fetchImpl, timeoutMs, what, signal }) {', 'CDP discovery cancellation');
  result = once(result,
    'what: `the debugging endpoint at ${target.url}` });',
    'what: `the debugging endpoint at ${target.url}`, signal: options.signal });', 'CDP discovery forwarding');
  result = once(result, 'what: `the target list at ${target.url}` });',
    'what: `the target list at ${target.url}`, signal: options.signal });', 'CDP target-list cancellation');
  result = once(result, 'if (!isLoopbackHost(socketUrl.hostname)) {',
    `if (!['ws:', 'wss:'].includes(socketUrl.protocol)
    || socketUrl.username || socketUrl.password
    || socketUrl.hostname.toLowerCase() !== target.host.toLowerCase()
    || Number(socketUrl.port || (socketUrl.protocol === 'wss:' ? 443 : 80)) !== target.port) {
    throw new CdpError('The discovered WebSocket is not on the exact approved debugging origin.', 'ENDPOINT_NOT_LOCAL');
  }
  if (!isLoopbackHost(socketUrl.hostname)) {`, 'CDP exact discovery origin');
  result = once(result, 'async send(method, params = {}, options = {}) {',
    `async send(method, params = {}, options = {}) {
    this.nexusCallSignal?.throwIfAborted();
    options = { ...options, signal: options.signal && this.nexusCallSignal
      ? AbortSignal.any([options.signal, this.nexusCallSignal]) : options.signal ?? this.nexusCallSignal };`, 'CDP all requests cancellation');
  return result;
}

export function adaptCdpState(source) {
  let result = once(source,
    'const listed = await listTargets(this.connection.endpoint, { timeoutMs: options.timeoutMs ?? 2000 });',
    `options.signal?.throwIfAborted();
    const listed = await listTargets(this.connection.endpoint, { timeoutMs: options.timeoutMs ?? 2000, signal: options.signal });
    options.signal?.throwIfAborted();`, 'CDP target-list signal');
  return once(result,
    'const sessionId = await this.connection.attach(targetId, { timeoutMs: options.timeoutMs });',
    'const sessionId = await this.connection.attach(targetId, { timeoutMs: options.timeoutMs, signal: options.signal });',
    'CDP attach signal');
}
export async function adaptComputerWorkerPolicy(source) {
  source = source.replaceAll('\r\n', '\n');
  const definitions = await readFile(new URL('../src/host/computer-use-launch-plan.ps1', import.meta.url), 'utf8');
  let result = once(source, 'function Do-Launch([object]$Arg) {',
    definitions + '\nfunction Do-Launch([object]$Arg) {', 'launch plan functions');
  result = once(result, '    $resolved = Resolve-LaunchTarget $target ($Arg.refresh -eq $true)',
    `    $nexusPlan = Assert-NexusLaunchPlan $Arg
    $resolved = Resolve-LaunchTarget $target ($Arg.refresh -eq $true)`, 'worker native launch permit');
  result = once(result, `        if ($resolved.kind -eq 'store') {
            # A packaged app has no executable path of its own: shell activation is
            # the only way in, and explorer is what performs it. The window will
            # therefore belong to the app, not to the process we get back.
            $proc = Start-Process -FilePath 'explorer.exe' -ArgumentList @($resolved.file) -PassThru -ErrorAction Stop
        } elseif ($argumentList.Count -gt 0) {
            $proc = Start-Process -FilePath $resolved.file -ArgumentList $argumentList -PassThru -ErrorAction Stop
        } else {
            $proc = Start-Process -FilePath $resolved.file -PassThru -ErrorAction Stop
        }`,
  `        $nexusPlan = Assert-NexusLaunchPlan $Arg
        if (@($nexusPlan.argv).Count -gt 0) {
            $proc = Start-Process -FilePath $nexusPlan.executable -ArgumentList $nexusPlan.windowsArgumentLine -WorkingDirectory $nexusPlan.cwd -PassThru -ErrorAction Stop
        } else {
            $proc = Start-Process -FilePath $nexusPlan.executable -WorkingDirectory $nexusPlan.cwd -PassThru -ErrorAction Stop
        }`, 'worker exact approved dispatch');
  return result;
}

export function adaptComputerWorkerDispatch(source) {
  return once(source, "    'launch'     = { param($a) Do-Launch $a }",
    "    'nexus_launch_plan' = { param($a) Get-NexusLaunchPlan $a }\n    'launch'     = { param($a) Do-Launch $a }", 'read-only launch planner');
}
