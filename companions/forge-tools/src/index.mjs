import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { HostFiles, renderFileRead, boundedInt } from './host-files.mjs';
import { SearchEngine } from './search.mjs';
import { PowerShellTools, nativeCommand } from './pwsh.mjs';
import { escalationFields } from './safety.mjs';

export const name = 'forge-tools';
export const inject = ['tools', 'fs', 'workingDirectory', 'sandboxPolicy', 'shell', 'subprocess', 'systemPrompt'];
export const Config = z.object({
  cacheMiB: z.number().default(64).description('Maximum in-memory file content cache in MiB'),
  cacheFileKiB: z.number().default(2048),
  cacheTtlMs: z.number().default(1000).description('Maximum unvalidated read/snapshot age; 0 disables cache reuse'),
  ioConcurrency: z.number().default(4),
  searchThreads: z.number().default(2),
  watch: z.boolean().default(true),
  persistentPwsh: z.boolean().default(true),
  pwshIdleMs: z.number().default(120000),
  maxOutputChars: z.number().default(32000),
  rgPath: z.string(),
});

const string = (description, required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) });
const integer = description => ({ type: 'integer', description });
const bool = description => ({ type: 'boolean', description });
const object = properties => ({ type: 'object', additionalProperties: false, properties });
const fileReadParameters = {
  file_path: string('Path relative to the current working directory, or absolute.', true),
  offset: integer('1-based first line. Default 1.'),
  limit: integer('1..2000 lines.'),
  fresh: bool('Force an authoritative provider read, bypassing the bounded-age cache.'),
};
const shellDescription = `Execute PowerShell 7 on Windows. Prefer read/glob/grep for files.
Use $env:NAME, -LiteralPath, single-quoted paths, and PowerShell syntax.
Use pwsh_run(file,args) for native programs: no manual quoting or Bash syntax.
Statements separated by semicolons run unconditionally; &&/|| require PowerShell 7.
exit N ends a persistent session; use session_mode=isolated for exit/scripts that alter host state.
Commands are serialized per agent. Persistent state is best effort and expires after idle.
Restricted sessions always use the official sandbox executor.`;

function mutationSummary(value, includeDiff = true) {
  const beforeBytes = Buffer.byteLength(value.before ?? ''), afterBytes = Buffer.byteLength(value.after ?? '');
  const summary = { path: value.path, operation: value.operation ?? 'update', version: value.version,
    changed: value.changed, sha256: value.sha256, beforeBytes, afterBytes };
  // Keep the exact diff only when it fits. Never present a partial diff as the
  // whole edit, or copy arbitrarily large bodies into the model/session history.
  if (includeDiff && beforeBytes + afterBytes <= 65536) {
    summary.before = value.before; summary.after = value.after;
  } else summary.diffOmitted = true;
  return summary;
}
function retainMutationContext(exec, records, uncertainPath) {
  if (!exec.deferContext || (!records.length && !uncertainPath)) return;
  const committed = records.map(record => ({
    path: String(record.path).slice(0, 2048), sha256: record.sha256, changed: record.changed,
  }));
  exec.deferContext(createUserMessage({
    source: { kind: 'forge-file-status', form: 'notice', summary: 'Forge file mutation commit status' },
    content: [{ type: 'text',
    text: `Forge file mutation status: ${JSON.stringify({ committed,
      ...(uncertainPath ? { unconfirmed: String(uncertainPath).slice(0, 2048) } : {}) })}\n` +
      'Confirmed commits are not rolled back by cancellation. If a commit is unconfirmed, fresh-read the target before deciding whether to retry; never blindly repeat a mutation.' }],
  }));
}
const mutationPresentation = (_args, value) => ({ path: value.path, operation: value.operation,
  ...(value.diffOmitted ? {} : { diffs: [{ path: value.path, oldText: value.before, newText: value.after }] }) });

export function apply(ctx, supplied = {}) {
  const config = { cacheMiB: 64, cacheFileKiB: 2048, cacheTtlMs: 1000, ioConcurrency: 4,
    searchThreads: 2, watch: true, persistentPwsh: true, pwshIdleMs: 120000,
    maxOutputChars: 32000, ...supplied };
  boundedInt(config.cacheMiB, 64, 0, 2048); boundedInt(config.cacheFileKiB, 2048, 1, 16384);
  boundedInt(config.cacheTtlMs, 1000, 0, 30000); boundedInt(config.ioConcurrency, 4, 1, 32);
  boundedInt(config.searchThreads, 2, 1, 16); boundedInt(config.pwshIdleMs, 120000, 1000, 3600000);
  boundedInt(config.maxOutputChars, 32000, 1024, 1048576);
  const files = new HostFiles(ctx, { cacheBytes: config.cacheMiB * 1024 * 1024,
    cacheFileBytes: config.cacheFileKiB * 1024, ttlMs: config.cacheTtlMs,
    concurrency: config.ioConcurrency, watch: config.watch });
  const search = new SearchEngine({ threads: config.searchThreads, ttlMs: config.cacheTtlMs, rgPath: config.rgPath });
  files.onInvalidate = () => search.invalidate();
  const pwsh = new PowerShellTools(ctx, files, { persistent: config.persistentPwsh,
    idleMs: config.pwshIdleMs, maxOutputChars: config.maxOutputChars });
  const mutate = async (kind, args, exec, includeDiff = true) => {
    try {
      const value = mutationSummary(await files.mutate(kind, args, exec), includeDiff);
      retainMutationContext(exec, [value]);
      return value;
    } catch (error) {
      if (error.commitState === 'unknown') retainMutationContext(exec, [], args.file_path);
      throw error;
    }
  };
  const register = (toolName, description, parameters, execute, options = {}) =>
    ctx.tools.register(defineTool({
      name: toolName, description, parameters,
      output: { schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }], ...options.output },
      execute, ...options,
    }));
  // File, search and PowerShell capabilities are always installed together.
  {
    register('read', 'Read UTF-8 text with line numbers, bounded cache and fresh option.', fileReadParameters,
      (args, exec) => files.read(args, exec), {
        isConcurrencySafe: () => true,
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: renderFileRead(value) }],
          presentationMeta: (_args, value) => ({ path: value.path, offset: value.offset, lines: value.lines, totalLines: value.totalLines }) },
      });
    register('read_many', 'Read up to 32 files in one tool call with bounded I/O concurrency. Each item has an independent result.',
      { files: { type: 'array', required: true, items: object(fileReadParameters) } },
      async (args, exec) => {
        if (!args.files.length || args.files.length > 32) throw new Error('read_many accepts 1..32 files');
        const results = await Promise.all(args.files.map(async input => {
          try { return { ok: true, ...await files.read(input, exec) }; }
          catch (error) { exec.signal.throwIfAborted(); return { ok: false, path: input.file_path, error: error.message }; }
        }));
        let budget = 192000;
        for (const result of results) {
          if (!result.ok) continue;
          const retained = [];
          for (const line of result.lines) {
            const size = line.text.length + 16;
            if (size > budget) { result.truncated = true; break; }
            budget -= size; retained.push(line);
          }
          result.lines = retained;
        }
        return results;
      }, { isConcurrencySafe: () => true });
    register('write', 'Create or atomically replace a UTF-8 file through the host observation and sandbox policy.',
      { file_path: string('Target path.', true), content: string('Complete text.', true),
        ...escalationFields(ctx.fs.sandboxMode !== undefined) },
      (args, exec) => mutate('write', args, exec),
      { output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text',
        text: `${value.operation ?? 'Updated'} ${value.path}\nsha256=${value.sha256}` }],
        presentationMeta: mutationPresentation } });
    register('edit', 'Precisely replace text through the host atomic, version-guarded edit API.',
      { file_path: string('Target path.', true), old_string: string('Exact existing text, nonempty.', true),
        new_string: string('Replacement text.', true), replace_all: bool('Replace every occurrence. Default false.'),
        ...escalationFields(ctx.fs.sandboxMode !== undefined) },
      (args, exec) => mutate('edit', args, exec), {
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          presentationMeta: mutationPresentation },
      });
    register('batch_edit', 'Apply up to 32 ordered file edits. Stops on first error; reports committed edits. Not a cross-file transaction.',
      { edits: { type: 'array', required: true, items: object({
        file_path: string('Target path.', true), old_string: string('Exact existing text.', true),
        new_string: string('Replacement.', true), replace_all: bool('Replace all matches.'),
      }) }, ...escalationFields(ctx.fs.sandboxMode !== undefined) },
      async (args, exec) => {
        if (!args.edits.length || args.edits.length > 32) throw new Error('batch_edit accepts 1..32 edits');
        const results = [];
        for (const input of args.edits) {
          exec.signal.throwIfAborted();
          try { results.push({ ok: true, ...await mutate('edit', { ...input,
            sandbox_permissions: args.sandbox_permissions, justification: args.justification }, exec, false) }); }
          catch (error) {
            exec.signal.throwIfAborted();
            return { completed: results.length, failed: input.file_path, error: error.message, results };
          }
        }
        return { completed: results.length, results };
      });
    register('list_directory', 'List direct children without recursively scanning or reading contents.',
      { path: string('Directory, defaults to .'), limit: integer('1..5000 results, default 500.') },
      (args, exec) => files.list(args, exec), { isConcurrencySafe: () => true });
    const runSearch = async (kind, args, exec) => {
      const controller = new AbortController(), deadline = performance.now() + 30000;
      const expire = () => controller.abort(new DOMException('Search exceeded 30000 ms; narrow path/glob', 'TimeoutError'));
      const timer = setTimeout(expire, 30000);
      timer.unref?.();
      const signal = AbortSignal.any([exec.signal, controller.signal]);
      try {
        const root = await files.searchRoot(args, { ...exec, signal });
        if (performance.now() >= deadline) expire();
        signal.throwIfAborted();
        const result = await search[kind](root, args, signal);
        if (performance.now() >= deadline) expire();
        signal.throwIfAborted();
        return result;
      } finally { clearTimeout(timer); }
    };
    register('glob', 'Find files using ripgrep ignore-aware directory snapshots. No directory results. Patterns are relative to path.',
      { pattern: string('Glob, e.g. **/*.cs or src/**/*.ts.', true), path: string('Directory root.'),
        limit: integer('1..5000, default 500.'), hidden: bool('Include hidden files.'),
        no_ignore: bool('Include ignored files.'), fresh: bool('Re-enumerate now.') },
      (args, exec) => runSearch('glob', args, exec), { isConcurrencySafe: () => true });
    register('grep', 'Search text using bundled ripgrep. Bounded streaming output; no PowerShell startup. Default respects ignore files.',
      { pattern: string('Rust regex or literal with fixed_strings.', true), path: string('Directory root.'),
        glob: string('File glob filter, e.g. *.cs.'), ignore_case: bool('Ignore case.'), fixed_strings: bool('Literal search.'),
        multiline: bool('Enable multiline matching.'), hidden: bool('Include hidden files.'), no_ignore: bool('Include ignored files.'),
        fresh: bool('Bypass identical-query cache.'),
        limit: integer('Global match cap 1..2000, default 100.'), head_limit: integer('Alias for limit.'),
        output_mode: { type: 'string', enum: ['content', 'files_with_matches'] } },
      (args, exec) => runSearch('grep', args, exec), { isConcurrencySafe: () => true });
  }
  const shellParameters = {
    command: string('PowerShell source text; use pwsh_run for native argv.', true),
    workdir: string('Explicit working directory; default current DSH working directory.'),
    timeout: integer('Compatibility alias for timeout_ms, milliseconds.'),
    timeout_ms: integer('1..600000 ms, default 120000.'),
    description: string('Short description of the operation.'),
    session_mode: { type: 'string', enum: ['persistent', 'isolated'] },
    run_in_background: bool('Create an official DSH job; inspect using job_output.'),
    strict: bool('Reject recognizable Bash-only syntax with a correction before execution.'),
    ...escalationFields(ctx.shell.sandboxMode !== undefined),
  };
  register('pwsh', shellDescription, shellParameters, (args, exec) => pwsh.execute(args, exec));
  register('pwsh_run', 'Run a native executable with a literal argument array. Handles spaces, quotes, $, backticks and Unicode. Uses isolated sandbox execution.',
    { file: string('Executable name or path.', true), args: { type: 'array', items: { type: 'string' }, required: true },
      workdir: string('Working directory.'), timeout_ms: integer('Timeout milliseconds.'),
      env: { type: 'object', additionalProperties: true, description: 'Explicit environment strings; isolates this call.' },
      run_in_background: bool('Start an official job.'), ...escalationFields(ctx.shell.sandboxMode !== undefined) },
    (args, exec) => {
      if (args.env && Object.values(args.env).some(value => typeof value !== 'string'))
        throw new Error('env values must be strings');
      return pwsh.execute({ ...args, command: nativeCommand(args.file, args.args), session_mode: 'isolated' }, exec);
    });
  register('forge_status', 'Show cache, search and PowerShell performance counters. Reset in-memory file snapshots with clear_cache.',
    { clear_cache: bool('Drop content and directory caches.') }, async (args, exec) => {
      if (args.clear_cache) files.clear();
      const policy = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {});
      return { version: '0.1.5', files: files.metrics(), search: search.metrics(), pwsh: pwsh.metrics(),
        permissions: { currentMode: policy.mode,
          guidance: 'Omit sandbox_permissions and justification for ordinary calls. They inherit the current session policy. Only genuine widening requires a nonempty reason and user approval.' },
        freshness: `Cached read bodies and glob snapshots may be up to ${config.cacheTtlMs} ms old; use fresh for current state.` };
    }, { isConcurrencySafe: args => !args.clear_cache });
  ctx.systemPrompt.section({
    name: 'forge:windows-tools', order: 499,
    text: `Windows tools: pwsh is PowerShell, not Bash. Use pwsh_run(file,args) for native executables.
Prefer read/read_many/glob/grep/list_directory over shell file commands. read offsets are 1-based.
Normal calls inherit the current session sandbox policy: OMIT sandbox_permissions and justification.
These fields request a one-call escalation, never select a stricter mode. Only request wider permissions after an actual sandbox denial, with a nonempty reason; user approval is still required.
forge_status reports the current session mode if needed. Redundant equal/lower permission requests do not change the standing policy.
Cached reads/globs have a ${config.cacheTtlMs} ms freshness bound; use fresh:true for external changes or verification.
Read existing files before edit/write; stale-version rejection requires a fresh read, never an unconditional retry.
Use one read_many for independent reads and one batch_edit for ordered edits. Keep file/search roots narrow.
Use $env:NAME; -LiteralPath for paths; avoid Bash heredocs, export, rm -rf, and Unix alias flags.
Do not replace && with semicolon: that would discard conditional execution.
Persistent pwsh variables/functions can survive commands but idle/timeout/exit discards them. Workdir resets per call.
Use session_mode:isolated for scripts that call exit, change global shell settings or require pristine state.
For terminal interaction, use official terminal_* tools when present. For background work use run_in_background and job_* tools.`,
  });
  ctx.effect(() => async () => { files.dispose(); await Promise.all([search.dispose(), pwsh.dispose()]); });
  return { files, search, pwsh };
}
