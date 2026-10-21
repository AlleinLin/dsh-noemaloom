import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { adaptTerminalSource, replaceAnchor } from '../vendor/nexus-terminal/nexus-adapter/adapt-source.mjs';
import { effectiveHook, initializeProcedures, installProceduresHook } from '../vendor/agent-procedures/nexus-adapter/index.mjs';
import { directoryCommand, quotePowerShell, windowsPromptInit, windowsShellBootstrap, localShellPlan, spawnHostPty, terminalStartupDetail, desktopConsolePlan, completeWindows } from '../vendor/nexus-terminal/nexus-adapter/platform.ts';
import { spawn } from 'node:child_process';
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { runConsoleBridge } from '../vendor/nexus-terminal/nexus-adapter/pty-console.mjs';
import ts from 'typescript';
import { terminalWorkspaceRoot, prepareTerminalRoot } from '../vendor/nexus-terminal/nexus-adapter/terminal-workspace.ts';

const root = resolve('vendor/nexus-terminal');

test('native adapters fail closed when an upstream anchor moves or is duplicated', () => {
  assert.throws(() => replaceAnchor('abc', 'd', 'x', 'upgrade'), /upstream anchor changed/);
  assert.throws(() => replaceAnchor('a a', 'a', 'x', 'upgrade'), /upstream anchor changed/);
});

test('all native source adaptations apply to the preserved upstream tree', async () => {
  const sources = [
    'packages/dshell/terminal-bridge/src/pty.ts', 'packages/dshell/terminal-bridge/src/index.ts',
    'packages/dshell/files/src/route.ts', 'packages/dshell/mode/src/client/completion.ts',
    'packages/dshell/std/src/contracts.ts', 'packages/dshell/ssh/src/connection.ts',
    'packages/dshell/commands/src/index.ts',
    'packages/dshell/mode/src/index.ts', 'packages/dshell/mode/src/terminal-mode.ts',
    'packages/dshell/mode/src/terminal-mode-protocol.ts',
    'packages/dshell/mode/src/client/terminal-mode.ts', 'packages/dshell/mode/src/client/terminal-section.ts',
  ];
  for (const source of sources) {
    const path = join(root, source);
    const original = await readFile(path, 'utf8');
    const adapted = adaptTerminalSource(path, original, root);
    assert.notEqual(adapted, original);
    assert.equal(await readFile(path, 'utf8'), original);
  }
});

test('Windows terminal root is independent and prepared only by the explicit action', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-terminal-root-'));
  try {
    const home = join(directory, 'home'), temporary = join(directory, 'scratch');
    await Promise.all([mkdir(home), mkdir(temporary)]);
    const root = terminalWorkspaceRoot(home);
    assert.equal(root, join(home, 'DSH-Terminal'));
    await assert.rejects(stat(root), { code: 'ENOENT' });
    await assert.rejects(prepareTerminalRoot(home, undefined, { home, temporary }), /fixed DSH terminal/);
    await prepareTerminalRoot(root, undefined, { home, temporary });
    const kept = join(root, 'existing.txt');
    await writeFile(kept, 'keep existing contents');
    await prepareTerminalRoot(root, undefined, { home, temporary });
    assert.equal(await readFile(kept, 'utf8'), 'keep existing contents');
    await assert.rejects(prepareTerminalRoot(root, undefined, { home, temporary: root }), /must not contain/);
    assert.equal(terminalWorkspaceRoot('/home/example', 'linux'), '/home/example');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('terminal route GET never prepares a directory and native admission refuses non-owner POST', async () => {
  const filename = join(root, 'packages/dshell/mode/src/terminal-mode.ts');
  const source = adaptTerminalSource(filename, await readFile(filename, 'utf8'), root);
  const ast = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
  let declaration = '';
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'createTerminalModeRoute') declaration = node.getText(ast).replace(/^export /u, '');
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(declaration);
  const compiled = ts.transpileModule(declaration, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText;
  const makeRoute = new Function('DSHELL_TERMINAL_MODE_PATH', 'respond', 'isMode',
    compiled + '\nreturn createTerminalModeRoute;')('/terminal-root',
    (body: unknown, status = 200) => Response.json(body, { status }), () => false);
  let preparations = 0;
  const route = makeRoute({ list: () => [], root: 'fixed-root', folded: false },
    { prepareRoot: async () => { preparations++; } });
  assert.equal((await route.fetch(new Request('http://localhost/terminal-root'))).status, 200);
  assert.equal(preparations, 0);

  // Use the shipped native carrier's exact method, including its admission
  // check, without constructing a transport or starting a server.
  const carrier = await readFile('node_modules/@deepseek-ai/dsh-client-connection/lib/index.js', 'utf8');
  const carrierAst = ts.createSourceFile('carrier.js', carrier, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let method = '';
  function findCarrier(node: ts.Node): void {
    if (ts.isMethodDeclaration(node) && node.name.getText(carrierAst) === 'createSharedFetchHandler') method = node.getText(carrierAst);
    ts.forEachChild(node, findCarrier);
  }
  findCarrier(carrierAst);
  assert.ok(method);
  const prototype = new Function(`return ({ ${method} });`)();
  const handler = prototype.createSharedFetchHandler.call({
    fetchRoutes: new Map([['/terminal-root', { ...route, methods: new Set(route.methods) }]]),
  }, 'api');
  const request = () => new Request('http://localhost/terminal-root',
    { method: 'POST', body: JSON.stringify({ action: 'prepare-root' }) });
  assert.equal((await handler.fetch(request(), { principal: { kind: 'delegate' } })).status, 403);
  assert.equal(preparations, 0);
  assert.equal((await handler.fetch(request(), { principal: { kind: 'owner' } })).status, 200);
  assert.equal(preparations, 1);
});

test('PowerShell paths preserve spaces, CJK, apostrophes and metacharacters as literal data', () => {
  assert.equal(quotePowerShell("D:\\中文 workspace\\a'b;$x"), "'D:\\中文 workspace\\a''b;$x'");
  assert.throws(() => quotePowerShell('C:\\work\rWrite-Output leaked'), /line break/);
  const init = windowsPromptInit(quotePowerShell('D:\\中文 workspace'));
  assert.match(init, /Set-Location -LiteralPath 'D:\\中文 workspace'/);
  assert.match(windowsShellBootstrap(), /NexusCwd=/);
  assert.match(windowsShellBootstrap(), /133;D;/);
  if (process.platform === 'win32') assert.match(directoryCommand('D:\\a b', false), /^Set-Location -LiteralPath 'D:\\a b'\r$/);
  assert.equal(directoryCommand("/tmp/a'b", true), "cd '/tmp/a'\\''b'\r");
});

test('PowerShell disables PSReadLine history before its first interactive prompt and keeps one bridge handshake', () => {
  const plan = localShellPlan('win32');
  assert.deepEqual(plan.argv.slice(1, 6), ['-NoLogo', '-NoProfile', '-NoExit', '-Command', windowsShellBootstrap()]);
  assert.equal(plan.argv.length, 6);
  const bootstrap = plan.argv[5]!;
  const historyOff = bootstrap.indexOf('Set-PSReadLineOption -HistorySaveStyle SaveNothing');
  const remove = bootstrap.indexOf('Remove-Module -Name PSReadLine -Force -ErrorAction Stop');
  const prompt = bootstrap.indexOf('function global:prompt');
  assert.ok(historyOff >= 0 && historyOff < remove && remove < prompt);
  assert.ok(bootstrap.indexOf('SetConsoleCtrlHandler([IntPtr]::Zero, $false)') > remove);
  assert.ok(bootstrap.indexOf('[Console]::TreatControlCAsInput = $false') < prompt);
  assert.match(bootstrap, /OutputEncoding/);
  assert.match(bootstrap, /catch .*exit 127/);
  assert.doesNotMatch(bootstrap, /[\r\n]/);
  const handshake = windowsPromptInit(quotePowerShell('D:\\a b 中文'));
  assert.equal(handshake.split('\r').length, 2);
  assert.match(handshake, /\[Console\]::Write/);
  assert.doesNotMatch(handshake, /PSReadLine|function global:prompt|OutputEncoding/);
  assert.deepEqual(localShellPlan('linux').argv, ['/bin/bash', '--noprofile', '--norc', '-i']);
});

test('Windows completion works in constrained language and treats the draft as data', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-completion-中文 '));
  try {
    await writeFile(join(directory, '补全文件.txt'), 'completion fixture');
    const run = async (_ctx: unknown, _agent: unknown, request: { command: string }) => {
      const child = spawn(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; " + request.command],
      { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '', stderr = '';
      child.stdout.on('data', bytes => { text += bytes; });
      child.stderr.on('data', bytes => { stderr += bytes; });
      const code = await new Promise<number | null>((resolveExit, reject) => {
        child.once('error', reject); child.once('close', resolveExit);
      });
      assert.equal(stderr, '');
      return { exitCode: code, stdout: { text } };
    };
    const line = 'Get-Content .\\补';
    const result = await completeWindows({} as any, {} as any, run as any, line, line.length, directory);
    assert.ok(result.candidates.some(candidate => candidate.name === '补全文件.txt'));
    assert.equal(result.start, 'Get-Content '.length);
    assert.equal(result.end, line.length);
    const attack = "Get-Content .\\补'; Set-Content -LiteralPath injected.txt -Value injected; #";
    await completeWindows({} as any, {} as any, run as any, attack, attack.length, directory);
    await assert.rejects(stat(join(directory, 'injected.txt')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Electron console plan preserves complete confinement argv and excludes other runtimes and direct shells', () => {
  const executable = 'D:\\Program Files\\Harness\\Harness.exe', helper = 'D:\\plugin space\\dshell-pty-console.js';
  const argv = [executable, 'D:\\Program Files\\Harness\\resources\\app.asar\\runner.js',
    '--workspace', "D:\\中文 workspace\\a'b;%TEMP%&$x", '--mode', 'workspace-write', '--', 'pwsh.exe', '-NoProfile'];
  const options = { platform: 'win32' as const, electron: '40.0', executable, helper };
  const plan = desktopConsolePlan(argv, options);
  assert.deepEqual(plan.argv, ['D:\\Program Files\\Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe',
    helper, '--', ...argv]);
  assert.deepEqual(plan.requiredFiles, plan.argv.slice(0, 2));
  assert.deepEqual(desktopConsolePlan(argv, { ...options, electron: undefined }).argv, argv);
  assert.deepEqual(desktopConsolePlan(argv, { ...options, platform: 'linux' }).argv, argv);
  assert.deepEqual(desktopConsolePlan(['pwsh.exe', '-NoProfile'], options).argv, ['pwsh.exe', '-NoProfile']);
});

test('console bridge inherits exact child argv and console handles, waits for close, and keeps Ctrl+C interactive', () => {
  const parent: any = Object.assign(new EventEmitter(), { exitCode: undefined, stderr: { write() {} } });
  const child: any = new EventEmitter();
  let killed = false, launched: any;
  child.kill = () => { killed = true; };
  const argv = ['runner.exe', 'runner.js', '--workspace', 'D:\\a & %b% 中文', '--', 'pwsh.exe'];
  runConsoleBridge(['--', ...argv], { parent, launch: (file: string, args: string[], options: any) => {
    launched = { file, args, options }; return child;
  } });
  assert.deepEqual(launched, { file: argv[0], args: argv.slice(1),
    options: { stdio: 'inherit', shell: false, windowsHide: true } });
  parent.emit('SIGINT'); parent.emit('SIGBREAK');
  assert.equal(killed, false);
  assert.equal(parent.exitCode, undefined);
  child.emit('exit', 23, null);
  assert.equal(parent.exitCode, undefined);
  child.emit('close', 23, null);
  assert.equal(parent.exitCode, 23);
  assert.equal(parent.listenerCount('SIGINT'), 0);
  assert.equal(parent.listenerCount('SIGBREAK'), 0);
});

test('console bridge surfaces spawn failure without an unrestricted fallback or a false success', () => {
  const messages: string[] = [];
  const parent: any = Object.assign(new EventEmitter(), { exitCode: undefined, stderr: { write: (text: string) => messages.push(text) } });
  const child = new EventEmitter();
  let launches = 0;
  runConsoleBridge(['--', 'missing-runner.exe'], { parent, launch: () => { launches++; return child; } });
  child.emit('error', new Error('spawn missing-runner.exe ENOENT'));
  child.emit('close', -4058, null);
  assert.equal(launches, 1);
  assert.equal(parent.exitCode, 127);
  assert.match(messages.join(''), /dsh-pty-console: spawn missing-runner\.exe ENOENT/);
});

test('local PTY uses native owner, sandbox confinement, cancellation, stream and signal contracts', async () => {
  const output = new PassThrough();
  let spawned: any, confined: any, eventGuard: any, signalValue: string | undefined;
  let finish!: (outcome: any) => void;
  const done = new Promise<any>(resolveDone => { finish = resolveDone; });
  const owner: any = { id: 'native-session', session: { header: { cwd: 'D:\\space 中文' } },
    ctx: { on(_name: string, handler: any) { eventGuard = handler; } } };
  const signal = new AbortController().signal;
  const policy = { mode: 'workspace-write', workspaceRoot: 'D:\\space 中文', sessionId: owner.id };
  const services: any = {
    sandboxPolicy: { defaultMode: 'workspace-write', resolve: ({ session }: any) => { assert.equal(session, owner.session); return policy; } },
    sessionProjections: { stateOf: () => 'workspace-write' },
    workingDirectory: { ensure: (agent: any) => { assert.equal(agent, owner); return owner.session.header.cwd; } },
    sandbox: { confine: (argv: string[], received: any, receivedSignal: AbortSignal) => {
      confined = received; assert.equal(receivedSignal, signal); return { argv: ['sandbox-runner', ...argv] };
    } },
    terminals: { hasOwnerActivity: () => true },
    subprocess: { spawnTerminal: async (spec: any) => {
      spawned = spec;
      return { pid: 421, output, done, write: async () => {}, resize: async () => {},
        terminate: async () => { finish({ exitCode: 0, signal: null }); },
        signalForeground: async (value: string) => { signalValue = value; return 422; } };
    } },
  };
  const ctx: any = { get: (name: string) => services[name] };
  const pty: any = await spawnHostPty(ctx, { sessionId: 'native-pty', type: 'shell', owner, signal } as any, 100, 30);
  assert.deepEqual(confined, policy);
  assert.equal(spawned.argv[0], 'sandbox-runner');
  assert.equal(spawned.cwd, owner.session.header.cwd);
  assert.equal(spawned.signal, signal);
  assert.equal(spawned.env.DSH_SESSION_ID, owner.id);
  assert.equal(spawned.env.DSH_PTY_SESSION_ID, 'native-pty');
  assert.equal(pty.pid, 421);
  const chunks: string[] = [];
  pty.onData((chunk: string) => chunks.push(chunk));
  const bytes = Buffer.from('中文');
  output.write(bytes.subarray(0, 2)); output.write(bytes.subarray(2));
  assert.equal(chunks.join(''), '中文');
  assert.equal(await pty.nexusSignal('SIGINT'), 422);
  assert.equal(signalValue, 'SIGINT');
  assert.throws(() => eventGuard('before', 'session/event', [owner.session, { type: 'sandbox/mode', data: { mode: 'danger-full-access' } }]), /Close persistent terminal/);
  pty.kill();
  await done;
});

test('local PTY startup diagnostics retain provider causes and redact terminal controls and credentials', () => {
  const detail = terminalStartupDetail(
    new Error('provider failed', { cause: Object.assign(new Error('spawn denied'), { code: 'EACCES' }) }),
    '\x1b]0;private title\x07\x1b[31mwindows-acl-run: launch failed\x1b[0m\npassword=example-only\n',
    'executable=C:\\Users\\example\\runner.exe; shell=pwsh.exe',
  );
  assert.match(detail, /provider failed ← EACCES: spawn denied/);
  assert.match(detail, /windows-acl-run: launch failed/);
  assert.match(detail, /password=\[REDACTED\]/);
  assert.match(detail, /executable=\[USER_HOME\]\\runner\.exe/);
  assert.doesNotMatch(detail, /\x1b|private title|example-only/);
  for (const [start, end] of [
    ['\x1b]2;', '\x1b\\'], ['\x9d2;', '\x9c'],
    ['\x1bP', '\x1b\\'], ['\x1b^', '\x1b\\'], ['\x1b_', '\x1b\\'],
    ['\x1bX', '\x1b\\'], ['\x90', '\x9c'], ['\x98', '\x9c'], ['\x9e', '\x9c'], ['\x9f', '\x9c'],
  ]) {
    const cleaned = terminalStartupDetail(undefined, `${start}private title${end}visible startup failure`, 'runner');
    assert.match(cleaned, /visible startup failure/);
    assert.doesNotMatch(cleaned, /private title|[\x1b\x90-\x9f]/);
  }
  assert.doesNotMatch(terminalStartupDetail(undefined, 'visible\n\x1b]0;private title', 'runner'), /private title/);
  assert.ok(terminalStartupDetail(undefined, 'x'.repeat(30000), 'runner').length <= 1600);
});

test('immediate PTY exit drains native output and provider rejection reaches original startup banner', async () => {
  for (const rejected of [false, true]) {
    const output = new PassThrough();
    let resolveDone!: (outcome: any) => void, rejectDone!: (error: Error) => void;
    const done = new Promise<any>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    const owner: any = { id: 'diagnostic-owner', session: {}, ctx: { on() {} } };
    const services: any = {
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'safe-root' }) },
      sessionProjections: {}, workingDirectory: { ensure: async () => 'safe-root' },
      sandbox: { confine: async (argv: string[]) => ({ argv: ['native-sandbox', ...argv] }) },
      subprocess: { spawnTerminal: async () => ({
        pid: 42, output, done, write: async () => {}, resize: async () => {},
        terminate: async () => {}, signalForeground: async () => 42,
      }) },
    };
    const pty = await spawnHostPty({ get: (name: string) => services[name] } as any,
      { owner, sessionId: 'diagnostic-pty' } as any, 100, 30);
    const chunks: string[] = [];
    const exited = new Promise<{ exitCode: number; detail?: string }>(resolve => { pty.onExit(resolve); });
    output.write('\x1b[31mwindows-acl-run: startup denied\x1b[0m\n');
    output.end();
    if (rejected) rejectDone(Object.assign(new Error('provider startup rejected'), { code: 'EACCES' }));
    else resolveDone({ exitCode: 127, signal: null });
    // Native output can arrive before LocalRawSession subscribes.
    pty.onData(text => { chunks.push(text); });
    const result = await exited;
    assert.equal(result.exitCode, rejected ? 1 : 127);
    assert.match(result.detail!, rejected ? /EACCES: provider startup rejected/ : /windows-acl-run: startup denied/);
    assert.equal(chunks.join(''), '\x1b[31mwindows-acl-run: startup denied\x1b[0m\n');
    const filename = join(root, 'packages/dshell/terminal-bridge/src/pty.ts');
    const adapted = adaptTerminalSource(filename, await readFile(filename, 'utf8'), root);
    assert.match(adapted, /this\.startupDetail = detail/);
  }
});

test('procedures hook preserves lazy lookup and respects explicit read-only instructions', async () => {
  const source = await readFile('vendor/agent-procedures/templates/AGENTS-snippet.md', 'utf8');
  const hook = effectiveHook(source);
  assert.match(hook, /不做启动式全库扫描/);
  assert.match(hook, /只读.*不修改 inbox/);
  assert.doesNotMatch(hook, /也照记不误/);
  assert.match(source, /也照记不误/);
});

test('procedures initialization is explicit, uses native FS guards, and preserves existing cards/rules', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'nexus-native-procedures-'));
  const resources = join(temporary, 'procedures');
  const files = new Map<string, string>([
    [join(temporary, 'AGENT.md'), '# User rules\n'],
    [join(resources, '工具-已有卡.md'), 'user card'],
  ]);
  const intents: string[] = [];
  const ctx: any = { fs: {
    resolve: async (path: string) => ({ targetKey: path }),
    stat: async ({ targetKey }: any) => files.has(targetKey) ? { type: 'file', version: 'v1' } : undefined,
    readText: async ({ targetKey }: any) => files.get(targetKey),
    writeText: async ({ targetKey }: any, content: string, intent: any) => { intents.push(intent.kind); files.set(targetKey, content); },
  } };
  const compiled = await readFile('vendor/agent-procedures/nexus-adapter/index.mjs', 'utf8');
  assert.doesNotMatch(compiled, /systemPrompt|tools\.register|AGENTS_HOME/);
  assert.equal((await initializeProcedures(ctx, temporary, undefined)).length, 4);
  assert.equal((await initializeProcedures(ctx, temporary, undefined)).length, 0);
  assert.deepEqual(await installProceduresHook(ctx, temporary, undefined), { filename: 'AGENT.md', changed: true });
  assert.deepEqual(await installProceduresHook(ctx, temporary, undefined), { filename: 'AGENT.md', changed: false });
  assert.ok(files.get(join(temporary, 'AGENT.md'))?.startsWith('# User rules\n'));
  assert.equal(files.has(join(temporary, 'DEEPSEEK.md')), false);
  assert.equal(files.get(join(resources, '工具-已有卡.md')), 'user card');
  assert.deepEqual(intents, ['createIfAbsent', 'createIfAbsent', 'createIfAbsent', 'createIfAbsent', 'replaceIfVersion']);
  await rm(temporary, { recursive: true, force: true });
});

test('original filesystem protection and native clients are retained', async () => {
  const fsSource = await readFile(join(root, 'packages/dshell/ssh/src/fs-routing.ts'), 'utf8');
  assert.match(fsSource, /class DshellFileSystem extends SandboxedFileSystem/);
  assert.match(fsSource, /remote === undefined[\s\S]*super\.writeText/);
  assert.match(fsSource, /mode === 'read-only'/);
  assert.match(fsSource, /this\.ctx\.sandboxPolicy\.resolve/);
  for (const id of ['mode', 'files', 'buffer', 'ssh', 'usage', 'conversation', 'terminal-bridge']) {
    const entries = await readdir(join(root, 'packages/dshell', id, 'src/client'));
    assert.ok(entries.includes('index.ts'));
  }
});
