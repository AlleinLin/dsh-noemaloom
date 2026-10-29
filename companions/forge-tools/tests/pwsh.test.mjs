import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { environment } from './helpers.mjs';
import { inspectCommand, nativeCommand } from '../src/pwsh.mjs';
import { PowerShellTools } from '../src/pwsh.mjs';

test('real persistent pwsh Unicode, state, unterminated output, native failure and cmdlet errors', async t => {
  const { execute } = await environment(t);
  const initial = await execute('pwsh', { command: "$persistentValue = '中文 😀'; function Get-ForgeValue { $persistentValue }; Get-ForgeValue" });
  assert.equal(initial.mode, 'persistent'); assert.match(initial.stdout, /中文 😀/);
  const next = await execute('pwsh', { command: 'Get-ForgeValue; [Console]::Out.Write("tail"); [Console]::Error.Write("errtail")' });
  assert.match(next.stdout, /中文 😀/); assert.match(next.stdout, /tail/); assert.match(next.stderr, /errtail/);
  const native = await execute('pwsh', { command: '& node -e "process.exit(7)"' });
  assert.equal(native.exitCode, 7);
  const error = await execute('pwsh', { command: "Get-Item -LiteralPath 'does-not-exist-123'" });
  assert.equal(error.exitCode, 1); assert.match(error.stderr, /does not exist|Cannot find/);
  assert.equal((await execute('pwsh', { command: 'Write-Output recovered' })).exitCode, 0);
});

test('pwsh_run literal argv round trip with Chinese, $, quotes, newlines and brackets', async t => {
  const { execute } = await environment(t);
  const values = ['a b', "it's", '$env:SECRET', '`ticks`', '中文 😀', '[x]', 'a"b', 'line1\nline2', ''];
  const result = await execute('pwsh_run', { file: process.execPath,
    args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...values] });
  assert.equal(result.exitCode, 0); assert.deepEqual(JSON.parse(result.stdout.trim()), values);
  assert.equal(result.mode, 'isolated');
});

test('active cancellation kills and resets resident; cancelled queued calls return promptly', async t => {
  const { execute } = await environment(t);
  await execute('pwsh', { command: '1' });
  const first = execute('pwsh', { command: 'Start-Sleep -Milliseconds 500; "done"' });
  await delay(20);
  const queued = new AbortController();
  const started = performance.now();
  const second = execute('pwsh', { command: '"SHOULD_NOT_RUN"' }, queued.signal);
  queued.abort(new Error('queued-cancel'));
  await assert.rejects(second, /queued-cancel/);
  assert.ok(performance.now() - started < 300);
  assert.equal((await first).exitCode, 0);
  const controller = new AbortController();
  const active = execute('pwsh', { command: 'Start-Sleep -Seconds 30' }, controller.signal);
  await delay(50); controller.abort(new Error('active-cancel'));
  const cancelled = await active;
  assert.equal(cancelled.aborted, true); assert.equal(cancelled.stateLost, true);
  const recovered = await execute('pwsh', { command: '"new worker"' });
  assert.match(recovered.stdout, /new worker/);
});

test('timeout clears persistent state; huge output stays bounded', async t => {
  const { execute } = await environment(t, { config: { maxOutputChars: 2048 } });
  const large = await execute('pwsh', { command: '[Console]::Out.Write("x" * 100000)' });
  assert.ok(large.stdout.length <= 2048); assert.equal(large.truncated, true);
  const result = await execute('pwsh', { command: 'Start-Sleep -Seconds 20', timeout_ms: 50 });
  assert.equal(result.timedOut, true); assert.equal(result.stateLost, true);
  assert.equal((await execute('pwsh', { command: '"ok"' })).exitCode, 0);
});

test('restricted mode never starts resident subprocess and preserves sandbox facts', async () => {
  let spawns = 0, executions = 0;
  const ctx = {
    sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: '.' }) },
    subprocess: { spawn() { spawns++; throw new Error('must not spawn'); } },
    shell: { pwshPath: 'pwsh', sandboxMode: 'read-only',
      resolve: request => request,
      execute: async spec => { executions++; assert.equal(spec.sandboxPolicy.mode, 'read-only'); return {
        result: async () => ({ exitCode: 1, timedOut: false, aborted: false, stdout: { text: '', truncated: false },
          stderr: { text: 'denied', truncated: false }, sandbox: { mode: 'read-only', denied: true } }),
        done: Promise.resolve(),
      }; },
    },
  };
  const service = new PowerShellTools(ctx, { clear() {}, cwd: async () => '.' });
  const result = await service.execute({ command: '"test"' }, { agent: { session: {} }, signal: new AbortController().signal });
  assert.equal(result.mode, 'isolated'); assert.equal(result.sandbox.denied, true);
  assert.equal(spawns, 0); assert.equal(executions, 1);
  await service.dispose();
});

test('Bash diagnostics and literal quoting do not silently rewrite commands', () => {
  assert.ok(inspectCommand('export X=abc\nrm -rf out').length >= 2);
  assert.equal(nativeCommand('node', ["a'b", '$x']), "& 'node' @('a''b', '$x')");
  assert.equal(inspectCommand('$env:X = "abc"; Write-Output $env:X').length, 0);
});

test('background uses official job hooks, owns cancellation and reports final output', async t => {
  const { ctx, execute } = await environment(t);
  const jobs = [];
  ctx.provide('jobs', { start(spec) {
    const hooks = spec.run();
    assert.ok(hooks.done instanceof Promise);
    assert.equal(typeof hooks.cancel, 'function');
    jobs.push({ spec, hooks });
    return 'test-job-id';
  } });
  const controller = new AbortController();
  const result = await execute('pwsh', { command: 'Start-Sleep -Milliseconds 50; "BACKGROUND"', run_in_background: true }, controller.signal);
  assert.equal(result.jobId, 'test-job-id');
  assert.equal(jobs[0].spec.owner, 'test-agent');
  controller.abort();
  const outcome = await jobs[0].hooks.done;
  assert.equal(outcome.status, 'completed');
  assert.match(jobs[0].spec.output[0].read(0).text, /BACKGROUND/);
});
