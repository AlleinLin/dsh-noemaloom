/**
 * Genuine DAP acceptance. Run only after source freeze, independently of unit tests.
 * Uses the same production DebugRuntime, AdapterCache, configuration and adapters.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess';
import { DebugRuntime } from '../src/host/debug/runtime.js';
import { AdapterCache } from '../src/host/debug/cache.js';
import { resolveLaunch } from '../src/host/debug/configuration.js';
import type { DebugBroker } from '../src/host/debug/process.js';

const args = process.argv.slice(2), output = args[args.indexOf('--output') + 1];
if (!output) throw new Error('--output is required');
const seed = args.includes('--seed') ? args[args.indexOf('--seed') + 1] : undefined;
const directory = await mkdtemp(join(tmpdir(), 'nexus-dap-acceptance-'));
const fixtures = join(directory, 'workspace'), cacheRoot = join(directory, 'cache');
await cp(resolve('tests/fixtures/debug'), fixtures, { recursive: true });
await cp(join(fixtures, 'ts/dependency'), join(fixtures, 'node_modules/nexus-debug-fixture'), { recursive: true });
await mkdir(cacheRoot);
const managed = new Set<ReturnType<typeof spawn>>(), rangeHandles = new Set<any>(), commands: Array<{ command: string; args: string[]; stdout: string; stderr: string }> = [];
// Acceptance-only broker: production always uses the official provider.
const broker: DebugBroker = {
  async resolveExecutable(command) {
    if (command === 'node') return process.execPath;
    return command;
  },
  async spawn(spec, _scope, signal) {
    const env = { ...scrubbedParentEnv() };
    for (const [key, value] of Object.entries(spec.env ?? {})) { if (value === undefined) delete env[key]; else env[key] = value; }
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const diagnostic = { command: spec.command.split(/[\\/]/).at(-1)!, args: spec.args.map(value => value.startsWith(directory) ? `<fixture>/${value.slice(directory.length + 1).replaceAll('\\', '/')}` : value), stdout: '', stderr: '' };
    managed.add(child); commands.push(diagnostic);
    // These are synthetic programs with no credentials. Keep bounded raw
    // transport diagnostics in private acceptance evidence, never the UI.
    child.stdout.on('data', bytes => { diagnostic.stdout = (diagnostic.stdout + bytes.toString()).slice(-8192); });
    child.stderr.on('data', bytes => { diagnostic.stderr = (diagnostic.stderr + bytes.toString()).slice(-8192); });
    const done = new Promise<{ exitCode: number | null }>((resolveDone, reject) => { child.once('error', reject); child.once('close', exitCode => { managed.delete(child); resolveDone({ exitCode }); }); });
    let terminated = false;
    const terminate = async () => {
      if (terminated) { await done.catch(() => {}); return; } terminated = true;
      if (child.pid && managed.has(child)) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
          await new Promise<void>(resolveKill => { killer.once('error', () => resolveKill()); killer.once('close', () => resolveKill()); });
        } else child.kill('SIGKILL');
      }
      await done.catch(() => {}); rangeHandles.delete(handle);
    };
    const handle = { pid: child.pid, input: child.stdin!, output: child.stdout!, stderr: child.stderr!, done, terminate };
    rangeHandles.add(handle);
    const abort = () => { void terminate(); }; signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) void terminate();
    void done.catch(() => {}).finally(() => signal.removeEventListener('abort', abort));
    return handle;
  },
};
const manifest = JSON.parse(await readFile('assets/debug-adapters.json', 'utf8'));
const runtime = new DebugRuntime({ broker, cache: new AdapterCache(cacheRoot, manifest.artifacts, seed), workRoot: join(cacheRoot, 'runs') });
const plan = JSON.parse(await readFile('tests/fixtures/debug/acceptance-plan.json', 'utf8'));
const results: any[] = [];
async function poll(scope: any, predicate: (state: any) => boolean, timeout = 180000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    const state = await runtime.snapshot(scope, 0);
    // Exercise the production paging contract; Node can emit over 200
    // loadedSource events before the target's final stdout.
    let page = state;
    for (let count = 0; page.events.length === 200 && count < 4; count++) {
      page = await runtime.snapshot(scope, page.cursor);
      state.events.push(...page.events);
      state.snapshot = page.snapshot; state.cursor = page.cursor;
    }
    last = state;
    if (state.snapshot?.phase === 'failed') throw new Error(state.snapshot.failure?.message ?? 'Debug runtime failed');
    if (predicate(state)) return state;
    if (state.snapshot?.phase === 'terminated') throw new Error(`Debug target terminated before the expected state: ${JSON.stringify(state)}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`Real DAP acceptance timed out: ${JSON.stringify(last)}`);
}
try {
  for (const fixture of plan.cases) {
    const source = join(fixtures, fixture.source), scope = { sessionId: `acceptance-${fixture.language}`, workspaceRoot: fixtures };
    const launch = await resolveLaunch({ type: fixture.type, request: 'launch', program: source, cwd: dirname(source) }, scope, source);
    console.log(`Starting genuine ${fixture.language} DAP acceptance`);
    const started = await runtime.start(scope, launch, { [source]: [{ line: fixture.line }] });
    let state = await poll(scope, state => state.snapshot?.phase === 'stopped');
    assert(state.events.some((event: any) => event.event === 'breakpoints' && event.body.breakpoints.some((point: any) => point.verified && point.line === fixture.line))
      || state.events.some((event: any) => event.event === 'breakpoint' && event.body.breakpoint?.verified && event.body.breakpoint?.line === fixture.line), 'A real verified source breakpoint is required');
    const stoppedGeneration = state.snapshot!.generation;
    const threads = await runtime.request(scope, 'threads');
    assert(threads.threads.length > 0, 'real threads');
    const threadId = state.snapshot!.stopped!.threadId ?? threads.threads[0].id;
    const stack = await runtime.request(scope, 'stackTrace', { threadId }, stoppedGeneration);
    assert(stack.stackFrames.length > 0, 'real stack');
    const first = stack.stackFrames.find((frame: any) => frame.source?.path?.replaceAll('\\', '/').toLowerCase() === source.replaceAll('\\', '/').toLowerCase());
    assert(first, 'Stopped stack must map to original fixture source');
    const scopes = await runtime.request(scope, 'scopes', { frameId: first.id }, stoppedGeneration);
    let found: any;
    const variableEvidence = [];
    for (const item of scopes.scopes.slice(0, 12)) {
      const variables = await runtime.request(scope, 'variables', { variablesReference: item.variablesReference }, stoppedGeneration);
      variableEvidence.push(...variables.variables.filter((variable: any) => variable.name.toLowerCase() === plan.variable));
      found ??= variables.variables.find((variable: any) => variable.name.toLowerCase() === plan.variable && String(variable.value) === plan.expectedValue);
    }
    assert(found, 'Real locals must contain value=21');
    await runtime.request(scope, 'next', { threadId }, stoppedGeneration);
    state = await poll(scope, state => state.snapshot?.phase === 'stopped' && state.snapshot.generation !== stoppedGeneration);
    const stepStack = await runtime.request(scope, 'stackTrace', { threadId: state.snapshot!.stopped?.threadId ?? threadId }, state.snapshot!.generation);
    assert(stepStack.stackFrames.length > 0 && stepStack.stackFrames[0].line !== first.line, 'Real single-step must change the source location');
    await runtime.request(scope, 'continue', { threadId: state.snapshot!.stopped?.threadId ?? threadId }, state.snapshot!.generation);
    state = await poll(scope, state => state.snapshot?.phase === 'terminated');
    assert(state.events.some((event: any) => event.event === 'output' && event.body.output.includes(plan.expectedOutput)), 'Target must actually print answer=42');
    await runtime.stop(scope);
    assert.equal(managed.size, 0, 'Owned top-level subprocesses must exit');
    assert.equal(rangeHandles.size, 0, 'All owned process handles must finish cleanup');
    assert.equal((await readdir(join(cacheRoot, 'runs'))).length, 0, 'Owned debug build directories must be removed');
    results.push({ language: fixture.language, runId: started.id, source: fixture.source,
      sourceSha256: createHash('sha256').update(await readFile(source)).digest('hex'),
      verifiedBreakpoint: true, stopped: true, threads: threads.threads.length, sourceStack: true,
      variables: variableEvidence.map((value: any) => ({ name: value.name, value: value.value })), stepped: true,
      output: plan.expectedOutput, terminated: true, ownedCleanup: true });
  }
} catch (error) {
  results.push({ passed: false, error: error instanceof Error ? error.message : 'Debug acceptance failed' });
  process.exitCode = 1;
} finally {
  await runtime.dispose().catch(() => { process.exitCode = 1; });
  await Promise.allSettled([...rangeHandles].map(handle => handle.terminate()));
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'debug-result.json'), JSON.stringify({ schema: 1, genuineProtocol: true, passed: results.length === 4 && !process.exitCode,
    platform: process.platform, node: process.version, results, commands, ownedProcessesRemaining: managed.size }, null, 2) + '\n');
  await rm(directory, { recursive: true, force: true });
}
