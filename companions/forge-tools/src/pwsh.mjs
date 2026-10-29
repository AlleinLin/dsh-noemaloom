import { randomUUID } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { performance } from 'node:perf_hooks';
import { abort, Gate, waitWithSignal } from './engine.mjs';
import { boundedInt } from './host-files.mjs';
import { resolvePolicy } from './safety.mjs';

export const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
export function nativeCommand(file, args = []) {
  if (!file || /[\0\r\n]/.test(file)) throw new Error('Invalid executable name');
  if (args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Arguments must be strings without NUL');
  // Literal strings avoid PowerShell interpolation of $, backticks, brackets, spaces and quotes.
  return `& ${psQuote(file)} @(${args.map(psQuote).join(', ')})`;
}

export function inspectCommand(command) {
  if (!command.trim() || command.includes('\0')) throw new Error('command must be nonempty and contain no NUL');
  const problems = [];
  if (/(?:^|\n)\s*(?:export\s+\w+=|\w+=\S+\s+\w)/.test(command))
    problems.push('Bash environment assignment: use $env:NAME = value; command, or pwsh_run.env.');
  if (/<<-?\s*['"]?\w+/.test(command))
    problems.push('Bash heredoc: use a PowerShell here-string @\\\' newline ... newline \\\'@, or pass literal source as an argument.');
  if (/(?:^|\n)\s*(?:sudo|source|chmod|which)\b/.test(command))
    problems.push('POSIX builtin: use Get-Command / dot sourcing, or explicitly call an installed Git Bash executable with pwsh_run.');
  if (/(?:^|\n)\s*rm\s+-[a-zA-Z]*r[a-zA-Z]*f\b/.test(command))
    problems.push('rm -rf: PowerShell requires Remove-Item -LiteralPath PATH -Recurse -Force. Check the resolved path first.');
  if (/(?:^|\n)\s*(?:cat|ls|find|grep|sed|awk|head|tail)\b/.test(command))
    problems.push('Prefer read / glob / grep / list_directory for files. Unix flags are not PowerShell alias parameters.');
  if (/\\\r?\n/.test(command)) problems.push('Bash line continuation: PowerShell uses a backtick, or put the command on one line.');
  // Diagnostics only: rewriting shell text without an AST can change quoting and side effects.
  return problems;
}

const workerScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
if (Get-Variable PSStyle -ErrorAction SilentlyContinue) { $PSStyle.OutputRendering = 'PlainText' }
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Forge persistent mode requires PowerShell 7+' }
[Console]::Out.WriteLine('__READY__')
while ($null -ne ($forgeLine = [Console]::In.ReadLine())) {
  try {
    $forgeRequest = ConvertFrom-Json -InputObject $forgeLine
    $forgeCode = 0
    Set-Location -LiteralPath $forgeRequest.cwd
    $global:LASTEXITCODE = 0
    $ErrorActionPreference = 'Stop'
    $PSNativeCommandUseErrorActionPreference = $false
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Text.UTF8Encoding]::new($false)
    $forgeSource = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($forgeRequest.source))
    $forgeBlock = [ScriptBlock]::Create($forgeSource)
    . $forgeBlock *>&1 | Out-String -Stream -Width 240 | ForEach-Object { [Console]::Out.WriteLine($_) }
    if ($global:LASTEXITCODE -ne 0) { $forgeCode = $global:LASTEXITCODE }
  } catch {
    $forgeCode = 1
    [Console]::Error.WriteLine(($_ | Out-String -Width 240))
  }
  [Console]::Out.WriteLine()
  [Console]::Error.WriteLine()
  [Console]::Out.WriteLine($forgeRequest.marker + ':' + $forgeCode)
  [Console]::Error.WriteLine($forgeRequest.marker + ':' + $forgeCode)
}
`;
export const workerEncoded = Buffer.from(workerScript, 'utf16le').toString('base64');

class Tail {
  constructor(max) { this.max = max; this.text = ''; this.truncated = false; }
  add(text) {
    this.text += text;
    if (this.text.length > this.max) { this.truncated = true; this.text = this.text.slice(-this.max); }
  }
}

// A provider can be stuck inside startup/teardown despite its abort contract.
// Bound our wait, but keep tracking its handle until actual cleanup is confirmed.
async function settledWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true, () => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
const cancelled = Symbol('cancelled');

class Resident {
  constructor(ctx, executable, cwd, maxOutput, lifecycleSignal) {
    this.maxOutput = maxOutput;
    this.closed = false;
    this.quiescent = false;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Startup can fail before a queued run starts awaiting ready.
    this.ready.catch(() => {});
    this.handle = ctx.subprocess.spawn({
      argv: [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', workerEncoded],
      cwd, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 500,
      signal: lifecycleSignal, env: { NO_COLOR: '1', GIT_PAGER: 'cat', PAGER: 'cat' },
    });
    this.streams = { stdout: { pending: '', tail: new Tail(maxOutput) }, stderr: { pending: '', tail: new Tail(maxOutput) } };
    this.listeners = [];
    for (const name of ['stdout', 'stderr']) {
      this.handle[name].setEncoding('utf8');
      const data = value => this.consume(name, value);
      const error = value => { this.fail(value); this.close(); };
      this.handle[name].on('data', data);
      this.handle[name].on('error', error);
      this.listeners.push([this.handle[name], 'data', data], [this.handle[name], 'error', error]);
    }
    const inputError = error => { this.fail(error); this.close(); };
    this.handle.stdin.on('error', inputError);
    this.listeners.push([this.handle.stdin, 'error', inputError]);
    this.handle.done.then(
      result => { this.fail(new Error(`PowerShell process exited (${result.exitCode}); session state lost; command was not retried`)); this.close(); },
      error => { this.fail(error); this.close(); },
    );
  }
  consume(name, data) {
    if (this.closed) return;
    const stream = this.streams[name];
    stream.pending += data;
    let lineEnd;
    while ((lineEnd = stream.pending.indexOf('\n')) >= 0) {
      const line = stream.pending.slice(0, lineEnd).replace(/\r$/, '');
      stream.pending = stream.pending.slice(lineEnd + 1);
      if (name === 'stdout' && line === '__READY__' && !this.initialized) {
        this.initialized = true; this.resolveReady(); this.resolveReady = undefined; this.rejectReady = undefined; continue;
      }
      if (this.active && line.startsWith(this.active.marker + ':')) {
        const code = Number(line.slice(this.active.marker.length + 1));
        if (Number.isInteger(code)) {
          this.active.finished.add(name);
          this.active.exitCode = code;
          if (this.active.finished.size === 2) {
            const active = this.active; this.active = undefined;
            active.resolve({ exitCode: active.exitCode, stdout: this.streams.stdout.tail,
              stderr: this.streams.stderr.tail });
          }
          continue;
        }
      }
      stream.tail.add(line + '\n');
    }
    // Keep enough suffix to recognize a marker even after a huge unterminated line.
    if (stream.pending.length > this.maxOutput) {
      stream.tail.add(stream.pending.slice(0, -256));
      stream.pending = stream.pending.slice(-256);
    }
  }
  fail(error) {
    this.closed = true; this.rejectReady?.(error);
    this.resolveReady = undefined; this.rejectReady = undefined;
    this.active?.reject(error); this.active = undefined;
  }
  async run(command, cwd, signal, timeoutMs, cleanupMs) {
    abort(signal);
    let timedOut = false;
    let stopResolve;
    const interrupted = new Promise(resolve => { stopResolve = resolve; });
    const deadline = performance.now() + timeoutMs;
    const stop = () => { this.close(); stopResolve(cancelled); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    try {
      if (await Promise.race([this.ready, interrupted]) === cancelled) throw cancelled;
      abort(signal);
      if (performance.now() >= deadline) { timedOut = true; throw cancelled; }
      if (this.closed) throw new Error('PowerShell session is closed');
      for (const stream of Object.values(this.streams)) stream.tail = new Tail(this.maxOutput);
      const marker = `__FORGE_${randomUUID().replaceAll('-', '')}__`;
      const result = new Promise((resolve, reject) => { this.active = { marker, resolve, reject, finished: new Set() }; });
      const request = JSON.stringify({ marker, cwd, source: Buffer.from(command).toString('base64') }) + '\n';
      this.handle.stdin.write(request, 'utf8', error => { if (error) { this.fail(error); this.close(); } });
      const outcome = await Promise.race([result, interrupted]);
      // A blocked event loop can delay the timer beyond marker delivery.
      if (outcome === cancelled || signal.aborted || performance.now() >= deadline) {
        if (!signal.aborted) timedOut = true;
        throw cancelled;
      }
      return { ...outcome, timedOut: false, aborted: false };
    } catch (error) {
      if (timedOut || signal.aborted) {
        const cleanup = this.close();
        const confirmed = await settledWithin(cleanup, cleanupMs);
        return { exitCode: null, timedOut, aborted: !timedOut && signal.aborted,
          stdout: this.streams.stdout.tail, stderr: this.streams.stderr.tail, stateLost: true,
          cleanupPending: !confirmed };
      }
      throw error;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); }
  }
  close() {
    if (this.cleanup) return this.cleanup;
    this.fail(new Error('PowerShell session closed; command was not retried'));
    // Set cleanup before signalling, since a provider can settle synchronously.
    this.cleanup = Promise.resolve().then(async () => {
      this.handle.terminate();
      // `done` is only the direct command outcome; surviving descendants belong
      // to the same managed range and must also be gone before reuse is safe.
      const [, empty] = await Promise.all([
        this.handle.done.catch(() => {}),
        this.handle.waitForExit(),
      ]);
      if (empty !== true) throw new Error('PowerShell process range termination is unconfirmed');
      this.quiescent = true;
      for (const [stream, event, listener] of this.listeners) stream.off(event, listener);
      this.listeners.length = 0;
      for (const stream of Object.values(this.streams)) stream.pending = '';
    });
    this.cleanup.catch(error => { this.cleanupError = String(error.message ?? error); });
    return this.cleanup;
  }
}

export class PowerShellTools {
  constructor(ctx, files, config = {}) {
    this.ctx = ctx; this.files = files;
    this.config = { persistent: true, maxOutputChars: 32000, timeoutMs: 120000, idleMs: 120000,
      cleanupMs: 2000, maxProcesses: 16, ...config };
    this.owners = new WeakMap();
    this.live = new Set();
    this.isolated = new Set();
    this.lifecycle = new AbortController();
    setMaxListeners(this.config.maxProcesses + 1, this.lifecycle.signal);
    this.disposed = false;
    this.stats = { calls: 0, residentStarts: 0, residentCalls: 0, isolatedCalls: 0 };
  }
  owner(agent) {
    let owner = this.owners.get(agent);
    if (owner) return owner;
    owner = { slot: undefined, disposed: false, isolated: new Set() };
    this.owners.set(agent, owner);
    // One disposer per agent, rather than one closure retaining every restarted
    // worker and its output buffers until the agent itself is disposed.
    agent.ctx?.effect(() => () => {
      owner.disposed = true;
      for (const entry of owner.isolated) entry.stop();
      return owner.slot ? this.closeSlot(owner, owner.slot) : undefined;
    });
    return owner;
  }
  closeSlot(owner, slot) {
    if (slot.closeWait) return slot.closeWait;
    clearTimeout(slot.idle);
    slot.queue.close(new Error('PowerShell session closed; queued command was not run'));
    const cleanup = slot.resident.close();
    if (!slot.releaseHook) {
      slot.releaseHook = true;
      cleanup.then(() => {
        this.live.delete(slot);
        if (owner.slot === slot) owner.slot = undefined;
      }, () => {});
    }
    slot.closeWait = settledWithin(Promise.all([cleanup, Promise.allSettled([...slot.pending])]), this.config.cleanupMs);
    return slot.closeWait;
  }
  async execute(args, exec) {
    if (this.disposed) throw new Error('PowerShell plugin is disposed');
    abort(exec.signal);
    const timeoutMs = boundedInt(args.timeout_ms ?? args.timeout, this.config.timeoutMs, 1, 600000);
    const started = performance.now(), deadline = started + timeoutMs;
    const timeout = new AbortController();
    const timeoutReason = new Error('PowerShell tool deadline exceeded before completion');
    const signal = AbortSignal.any([exec.signal, this.lifecycle.signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(timeoutReason), timeoutMs);
    const call = { started, phase: 'preparation', remaining: () => {
      const left = deadline - performance.now();
      if (left <= 0) timeout.abort(timeoutReason);
      abort(signal);
      return Math.max(1, Math.ceil(left));
    } };
    try {
      const result = await this.executeWithinDeadline(args, { ...exec, signal }, call);
      // The first cause wins. A slow cleanup can outlive the total deadline
      // after external cancellation; that must remain cancellation.
      return signal.aborted && result.kind !== 'background'
        ? { ...result, exitCode: null, timedOut: signal.reason === timeoutReason,
          aborted: signal.reason !== timeoutReason } : result;
    } catch (error) {
      if (signal.reason !== timeoutReason) throw error;
      const startedCommand = call.phase === 'running';
      if (startedCommand) {
        const owner = this.owners.get(exec.agent);
        if (owner?.slot) this.closeSlot(owner, owner.slot);
        for (const entry of owner?.isolated ?? []) entry.stop();
      }
      // Preparation and queued-command deadlines do not kill another call's
      // resident or imply that this command ever reached the shell.
      return { exitCode: null, stdout: '', stderr: '', timedOut: true, aborted: false,
        truncated: false, stateLost: startedCommand, cleanupPending: startedCommand,
        cleanupScope: startedCommand ? 'unconfirmed' : 'not-started',
        mode: startedCommand ? 'unknown' : 'not-started', phase: call.phase,
        elapsedMs: Math.round(performance.now() - started),
        warnings: [startedCommand
          ? 'Tool deadline expired; process termination is unconfirmed and side effects may still occur. Command was not retried.'
          : 'Tool deadline expired before this command was sent to PowerShell; command was not retried.'] };
    } finally { clearTimeout(timer); }
  }
  async executeWithinDeadline(args, exec, call) {
    if (!exec.agent) throw new Error('PowerShell tools require an agent-owned session');
    const owner = this.owner(exec.agent);
    if (owner.disposed) throw new Error('PowerShell owner is disposed');
    if ([...owner.isolated].some(entry => entry.abandoned))
      throw new Error('Previous PowerShell termination is unconfirmed; wait for cleanup before running another command. Side effects may still be pending.');
    const warnings = inspectCommand(args.command);
    if (args.strict && warnings.length) throw new Error(warnings.join('\n'));
    this.stats.calls++;
    call.remaining();
    // Cancel only the wait: HostFiles keeps its scarce I/O slot until an
    // uncooperative cwd provider really settles. A late result cannot resume
    // this method or start a process after cancellation.
    const cwd = args.workdir ?? await waitWithSignal(this.files.cwd(exec), exec.signal);
    const policy = await waitWithSignal(
      resolvePolicy(this.ctx, 'pwsh', args, exec, this.ctx.shell.sandboxMode !== undefined), exec.signal);
    call.remaining();
    const started = call.started;
    const old = owner.slot;
    // A resident process must never survive a call under a different policy.
    if (old && old.policy !== JSON.stringify(policy)) {
      clearTimeout(old.idle);
      if (!await waitWithSignal(this.closeSlot(owner, old), exec.signal))
        throw new Error('Previous PowerShell termination is unconfirmed; policy change cannot start another command. Side effects may still be pending.');
    }
    if (owner.slot?.resident.closed && !await waitWithSignal(this.closeSlot(owner, owner.slot), exec.signal))
      throw new Error('Previous PowerShell termination is unconfirmed; wait for cleanup before running another command. Side effects may still be pending.');
    if (this.disposed || owner.disposed) throw new Error('PowerShell owner is disposed');
    call.remaining();
    if (args.run_in_background) return this.background(args, exec, cwd, policy, call.remaining());
    let outcome;
    const useResident = this.config.persistent && args.session_mode !== 'isolated'
      && !args.env && policy.mode === 'danger-full-access' && this.ctx.shell.pwshPath;
    this.files.clear();
    try {
      if (useResident) {
        let slot = owner.slot;
        let created = false;
        if (!slot || slot.resident.closed) {
          if (slot && !await waitWithSignal(this.closeSlot(owner, slot), exec.signal))
            throw new Error('Previous PowerShell termination is unconfirmed; wait for cleanup before running another command. Side effects may still be pending.');
          if (this.disposed || owner.disposed) throw new Error('PowerShell owner is disposed');
          if (this.live.size + this.isolated.size >= this.config.maxProcesses)
            throw new Error('Forge PowerShell process limit reached; wait for existing workers or unconfirmed termination to finish.');
          call.remaining();
          slot = { resident: new Resident(this.ctx, this.ctx.shell.pwshPath, cwd, this.config.maxOutputChars, this.lifecycle.signal),
            owner, queue: new Gate(1), pending: new Set(), policy: JSON.stringify(policy), idle: undefined };
          owner.slot = slot; this.live.add(slot); this.stats.residentStarts++;
          created = true;
          const tracked = slot;
          tracked.resident.handle.done.then(
            () => this.closeSlot(owner, tracked), () => this.closeSlot(owner, tracked),
          ).catch(() => {});
        }
        clearTimeout(slot.idle);
        slot.idleGeneration = (slot.idleGeneration ?? 0) + 1;
        const idleGeneration = slot.idleGeneration;
        call.phase = 'queued';
        const operation = slot.queue.run(async () => {
          abort(exec.signal);
          if (this.disposed || owner.disposed) throw new Error('PowerShell owner is disposed');
          const remaining = call.remaining();
          call.phase = 'running';
          this.stats.residentCalls++;
          return slot.resident.run(args.command, cwd, exec.signal, remaining, this.config.cleanupMs);
        }, exec.signal);
        slot.pending.add(operation);
        try { outcome = await operation; }
        finally {
          slot.pending.delete(operation);
          if (!this.disposed && !owner.disposed && !slot.resident.closed && slot.idleGeneration === idleGeneration) slot.idle = setTimeout(() => {
            // Close only after all queued commands have reached quiescence.
            Promise.allSettled([...slot.pending]).then(() => {
              if (slot.idleGeneration !== idleGeneration || slot.pending.size) return;
              return this.closeSlot(owner, slot);
            }).catch(() => {});
          }, this.config.idleMs);
          slot.idle?.unref();
          if (slot.resident.closed || (created && call.phase !== 'running')) this.closeSlot(owner, slot);
        }
      } else {
        const remaining = call.remaining();
        call.phase = 'running';
        this.stats.isolatedCalls++;
        outcome = await this.runIsolated(args, exec, cwd, policy, remaining, owner);
      }
      const stdout = typeof outcome.stdout === 'string' ? outcome.stdout : outcome.stdout.text;
      const stderr = typeof outcome.stderr === 'string' ? outcome.stderr : outcome.stderr.text;
      return { exitCode: outcome.exitCode, stdout: stdout.slice(-this.config.maxOutputChars),
        stderr: stderr.slice(-this.config.maxOutputChars), timedOut: outcome.timedOut, aborted: outcome.aborted,
        truncated: !!outcome.stdout.truncated || !!outcome.stderr.truncated,
        stateLost: !!outcome.stateLost, mode: useResident ? 'persistent' : 'isolated',
        cleanupPending: !!outcome.cleanupPending,
        cleanupScope: useResident ? 'managed-range' : 'provider-execution',
        elapsedMs: Math.round(performance.now() - started), warnings: outcome.cleanupPending
          ? [...warnings, 'Process termination is unconfirmed. Side effects may still occur. This agent cannot start another command until cleanup is confirmed; no command was retried.']
          : warnings,
        ...(outcome.sandbox ? { sandbox: outcome.sandbox } : {}) };
    } finally { this.files.clear(); }
  }
  async runIsolated(args, exec, cwd, policy, timeoutMs, owner) {
    if (this.live.size + this.isolated.size >= this.config.maxProcesses)
      throw new Error('Forge PowerShell process limit reached; wait for existing workers or unconfirmed termination to finish.');
    const controller = new AbortController();
    let interrupt;
    const interrupted = new Promise(resolve => { interrupt = resolve; });
    const entry = { abandoned: false, process: undefined, stop: () => {
      entry.abandoned = true;
      controller.abort(new Error('PowerShell execution stopped'));
      try { entry.process?.kill(); }
      catch (error) { entry.stopError = String(error.message ?? error); }
      finally { interrupt(cancelled); }
    } };
    this.isolated.add(entry); owner.isolated.add(entry);
    let timedOut = false;
    const deadline = performance.now() + timeoutMs;
    const timer = setTimeout(() => { timedOut = true; entry.stop(); }, timeoutMs);
    const stop = () => entry.stop();
    exec.signal.addEventListener('abort', stop, { once: true });
    this.lifecycle.signal.addEventListener('abort', stop, { once: true });
    const operation = (async () => {
      const execution = await this.ctx.shell.execute(this.ctx.shell.resolve({
        command: args.command, workdir: cwd, timeoutMs, onExpiry: 'kill',
        signal: controller.signal, sandboxPolicy: policy, ...(args.env ? { env: args.env } : {}),
      }));
      entry.process = execution;
      // A nonconforming slow provider may publish the handle after cancellation.
      if (controller.signal.aborted) {
        try { execution.kill(); } catch (error) { entry.stopError = String(error.message ?? error); }
      }
      try { return await execution.result(); } finally { await execution.done; }
    })();
    const cleanup = operation.then(() => {}, () => {}).finally(() => {
      this.isolated.delete(entry); owner.isolated.delete(entry);
    });
    cleanup.catch(() => {});
    try {
      const outcome = await Promise.race([operation, interrupted]);
      if (outcome !== cancelled && !controller.signal.aborted && performance.now() < deadline) return outcome;
      if (!controller.signal.aborted) { timedOut = true; entry.stop(); }
      const confirmed = await settledWithin(cleanup, this.config.cleanupMs);
      const read = channel => entry.process?.observed?.[channel]?.readFrom(0)
        ?? { text: '', lossy: false };
      const stdout = read('stdout'), stderr = read('stderr');
      return { exitCode: null, timedOut, aborted: !timedOut, stateLost: true, cleanupPending: !confirmed,
        stdout: { text: stdout.text, truncated: stdout.lossy }, stderr: { text: stderr.text, truncated: stderr.lossy } };
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      const confirmed = await settledWithin(cleanup, this.config.cleanupMs);
      return { exitCode: null, timedOut, aborted: !timedOut, stateLost: true, cleanupPending: !confirmed,
        stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } };
    } finally {
      clearTimeout(timer);
      exec.signal.removeEventListener('abort', stop);
      this.lifecycle.signal.removeEventListener('abort', stop);
    }
  }
  background(args, exec, cwd, policy, timeoutMs) {
    const jobs = this.ctx.get('jobs');
    if (!jobs) throw new Error('Background commands need the DSH jobs service');
    abort(exec.signal);
    let process;
    const spec = this.ctx.shell.resolve({
      command: args.command, workdir: cwd, timeoutMs, onExpiry: 'none',
      sandboxPolicy: policy, ...(args.env ? { env: args.env } : {}),
    });
    const id = jobs.start({
      kind: 'pwsh', label: args.command, owner: exec.agent.id,
      toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
      output: ['stdout', 'stderr'].map(channel => ({
        channel, read: offset => process?.observed[channel].readFrom(offset)
          ?? { text: '', nextOffset: offset, lossy: false },
      })),
      run: () => {
        const controller = new AbortController();
        const done = (async () => {
          this.files.clear();
          try {
            process = await this.ctx.shell.execute({ ...spec, signal: controller.signal });
            if (controller.signal.aborted) process.kill();
            await process.done;
            return { status: process.status === 'killed' ? 'killed' : 'completed',
              detail: `exit code: ${process.exitCode ?? 'null'}${process.sandbox?.denied ? '; sandbox denied' : ''}` };
          } catch (error) {
            return { status: controller.signal.aborted ? 'killed' : 'failed', detail: String(error.message ?? error) };
          } finally { this.files.clear(); }
        })();
        return { done, cancel: reason => { controller.abort(reason); process?.kill(); } };
      },
    });
    return { kind: 'background', jobId: id, cwd,
      message: 'Use job_output, job_list and job_kill. Background execution has no foreground deadline.' };
  }
  metrics() { return { ...this.stats, residentProcesses: this.live.size, isolatedProcesses: this.isolated.size,
    cleanupPending: [...this.live].filter(slot => slot.resident.closed && !slot.resident.quiescent).length
      + [...this.isolated].filter(entry => entry.abandoned).length }; }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle.abort(new Error('Plugin disposed'));
    for (const entry of this.isolated) entry.stop();
    await Promise.allSettled([...this.live].map(slot => this.closeSlot(slot.owner, slot)));
  }
}
