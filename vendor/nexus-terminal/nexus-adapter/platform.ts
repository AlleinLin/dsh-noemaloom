import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import { StringDecoder } from 'node:string_decoder'
import { constants } from 'node:os'
import { stripVTControlCharacters } from 'node:util'
import { stat } from 'node:fs/promises'
import { win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactString } from '../../../src/domain/operations/index.js'
import type { TerminalBackendSpawnSpec, TerminalSignal } from '@deepseek-ai/dsh-terminal'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { DshellCompletion } from '../packages/dshell/std/src/contracts.js'

export const windowsHost = process.platform === 'win32'

const guardedOwners = new WeakMap<Agent, { ctx: Context }>()

/** Preserve the sandbox's complete argv behind the installed console runtime. */
export function desktopConsolePlan(argv: readonly string[], options: {
  platform?: NodeJS.Platform; electron?: string | undefined; executable?: string; helper?: string
} = {}): { argv: string[]; requiredFiles: string[] } {
  const platform = options.platform ?? process.platform
  const electron = Object.hasOwn(options, 'electron') ? options.electron : process.versions.electron
  const executable = options.executable ?? process.execPath
  if (platform !== 'win32' || electron === undefined || argv[0] === undefined
    || win32.resolve(argv[0]).toLowerCase() !== win32.resolve(executable).toLowerCase()) {
    return { argv: [...argv], requiredFiles: [] }
  }
  const node = win32.join(win32.dirname(executable), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
  const helper = options.helper ?? fileURLToPath(new URL('./dshell-pty-console.js', import.meta.url))
  return { argv: [node, helper, '--', ...argv], requiredFiles: [node, helper] }
}

export interface HostPty {
  readonly pid: number
  write(text: string): void
  resize(cols: number, rows: number): void
  kill(): void
  nexusTerminate(): Promise<void>
  nexusSignal(signal: TerminalSignal): Promise<number>
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (exit: { exitCode: number; signal?: number; detail?: string }) => void): { dispose(): void }
}

/** Only bounded, redacted startup facts reach the original connection banner. */
export function terminalStartupDetail(error: unknown, output: string, launch: string): string {
  const messages: string[] = []
  const seen = new Set<unknown>()
  for (let cause = error; cause !== undefined && cause !== null && !seen.has(cause) && messages.length < 3;) {
    seen.add(cause)
    if (cause instanceof Error) {
      const code = (cause as NodeJS.ErrnoException).code
      messages.push(`${code === undefined ? '' : `${code}: `}${cause.message}`)
      cause = cause.cause
    } else { messages.push(String(cause)); break }
  }
  // Strip complete terminal strings before Node's CSI cleanup: some Node
  // versions consume only the OSC introducer and leave its private payload.
  // An unfinished string stays non-printing through the end of the capture.
  const clean = (text: string, limit = 1600): string => redactString(stripVTControlCharacters(text
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/gu, '')
    .replace(/(?:\u001b[P^_X]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/gu, ''))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, ''), limit)
  const tail = clean(output.slice(-8192), 8192).split(/\r?\n/u).map(line => line.trim()).filter(Boolean).slice(-3).join(' | ').slice(-600)
  return clean([messages.length === 0 ? undefined : clean(messages.join(' ← '), 450), tail || undefined, clean(launch, 500)]
    .filter(Boolean).join('; ')).slice(0, 1600)
}

/** The Desktop's provider owns its ABI-matched ConPTY binary and process range. */
export async function spawnHostPty(
  ctx: Context, spec: TerminalBackendSpawnSpec, cols: number, rows: number,
): Promise<HostPty> {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('Terminal requires the DSH subprocess provider')
  const policyService = ctx.get('sandboxPolicy')
  const workingDirectory = ctx.get('workingDirectory')
  const projections = ctx.get('sessionProjections')
  if (policyService === undefined || workingDirectory === undefined || projections === undefined) {
    throw new Error('DSH terminal requires sandboxPolicy, sessionProjections and workingDirectory')
  }
  if (!guardedOwners.has(spec.owner)) {
    const guard = { ctx }
    guardedOwners.set(spec.owner, guard)
    spec.owner.ctx.on('internal/dispatch', (_mode, eventName, args) => {
      if (eventName !== 'session/event') return
      const [session, event] = args as [typeof spec.owner.session, { type: string; data: { mode: string } }]
      if (session !== spec.owner.session || event.type !== 'sandbox/mode') return
      const activePolicy = guard.ctx.get('sandboxPolicy')
      const current = guard.ctx.get('sessionProjections')?.stateOf(session, 'sandboxMode') ?? activePolicy?.defaultMode
      const terminals = guard.ctx.get('terminals')
      if (event.data.mode !== current && terminals?.hasOwnerActivity(spec.owner)) {
        throw new Error('Close persistent terminal sessions before changing sandbox mode')
      }
    }, { global: true })
  } else guardedOwners.get(spec.owner)!.ctx = ctx
  const policy = policyService.resolve({ session: spec.owner.session })
  const cwd = spec.cwd ?? await workingDirectory.ensure(spec.owner, spec.signal)
  const shell = localShellPlan()
  let argv = [...shell.argv]
  if (policy.mode !== 'danger-full-access') {
    const sandbox = ctx.get('sandbox')
    if (sandbox === undefined) throw new Error(`DSH terminal requires sandbox for ${policy.mode}`)
    argv = [...(await sandbox.confine(argv, { ...policy, mode: policy.mode }, spec.signal)).argv]
  }
  const consolePlan = desktopConsolePlan(argv)
  for (const file of consolePlan.requiredFiles) {
    const present = await stat(file).catch(() => undefined)
    if (!present?.isFile()) throw new Error(terminalStartupDetail(undefined, '', `DSH console runtime or bridge is unavailable: ${file}`))
  }
  argv = consolePlan.argv
  spec.signal?.throwIfAborted()
  const launch = `executable=${argv[0]}; shell=${shell.argv[0]}; runtime=${process.execPath}; electronNode=${process.env.ELECTRON_RUN_AS_NODE === '1'}`
  const handle = await subprocess.spawnTerminal({
    argv, cwd, cols, rows, terminalType: 'xterm-256color', graceMs: 1000, signal: spec.signal,
    env: { ...shell.env, DSH_SHELL: '1', DSH_SESSION_ID: String(spec.owner.id), DSH_PTY_SESSION_ID: String(spec.sessionId) },
  }).catch(error => {
    throw new Error(terminalStartupDetail(error, '', launch))
  })
  const decoder = new StringDecoder('utf8')
  const listeners = new Set<(data: string) => void>()
  let subscribed = false, pending = '', tail = '', providerFailure: unknown
  let finishOutput!: () => void
  const outputDone = new Promise<void>(resolve => { finishOutput = resolve })
  const deliver = (text: string): void => {
    if (text === '') return
    tail = (tail + text).slice(-8192)
    if (!subscribed) pending = (pending + text).slice(-65536)
    for (const listener of listeners) listener(text)
  }
  handle.output.on('error', error => { providerFailure = error; finishOutput() })
  handle.output.once('end', () => { deliver(decoder.end()); finishOutput() })
  handle.output.once('close', finishOutput)
  handle.output.on('data', (bytes: Buffer | string) => deliver(typeof bytes === 'string' ? bytes : decoder.write(bytes)))
  if (handle.output.readableEnded || handle.output.destroyed) finishOutput()
  const outcome = handle.done.then(async result => {
    // The native contract ends output after its queued bytes, separately from
    // top-level process exit. Keep their order even when it exits immediately.
    await outputDone
    return { exitCode: result.exitCode ?? 1,
      signal: result.signal === null ? undefined : constants.signals[result.signal],
      detail: terminalStartupDetail(providerFailure, tail, launch) }
  }, error => ({ exitCode: 1, detail: terminalStartupDetail(error, tail, launch) }))
  return {
    pid: handle.pid,
    write(text: string) { void handle.write(text).catch(() => handle.terminate()).catch(() => undefined) },
    resize(width: number, height: number) { void handle.resize(width, height).catch(() => undefined) },
    kill() { void handle.terminate().catch(() => undefined) },
    nexusTerminate() { return handle.terminate() },
    nexusSignal(signal: TerminalSignal) { return handle.signalForeground(signal) },
    onData(listener: (data: string) => void) {
      listeners.add(listener)
      if (!subscribed) {
        subscribed = true
        const buffered = pending
        pending = ''
        if (buffered !== '') listener(buffered)
      }
      return { dispose() { listeners.delete(listener) } }
    },
    onExit(listener: (exit: { exitCode: number; signal?: number; detail?: string }) => void) {
      let disposed = false
      void outcome.then(result => { if (!disposed) listener(result) })
      return { dispose() { disposed = true } }
    },
  }
}

const WINDOWS_ENCODING_SETUP = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Text.UTF8Encoding]::new($false)'
// The official ACL runner ignores Ctrl+C to preserve its lifetime. Windows
// inherits that ignore flag into the confined child. Restore it INSIDE the
// shell, after confinement, without changing the runner or its token/stdio.
// Add-Type emits this small interop type in memory on PowerShell 7.
const WINDOWS_INTERRUPT_SETUP = 'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class NexusConsoleControl { [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, [MarshalAs(UnmanagedType.Bool)] bool add); }\' -ErrorAction Stop; if (-not [NexusConsoleControl]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }; [Console]::TreatControlCAsInput = $false'
const WINDOWS_PROMPT_SETUP = "function global:prompt { $nexusSucceeded = $?; $nexusExit = if ($nexusSucceeded) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }; $nexusPath = (Get-Location).ProviderPath; $nexusEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($nexusPath)); [Console]::Write(([char]27).ToString() + ']133;D;' + $nexusExit + [char]7 + ([char]27).ToString() + ']1337;NexusCwd=' + $nexusEncoded + [char]7); $env:USERNAME + '@' + $env:COMPUTERNAME + ':' + $nexusPath + '$ ' }"
const WINDOWS_CLEAR = '[Console]::Write(([char]27).ToString() + "[2J" + ([char]27).ToString() + "[H")'

/** Fixed argv bootstrap runs before the first interactive ReadLine/prompt. */
export function windowsShellBootstrap(): string {
  return 'try { ' + [
    // Prevent SaveAtExit on module removal as well as subsequent global history
    // writes. Dshell owns editing, history and completion in its original UI.
    'if (Get-Module -Name PSReadLine) { Set-PSReadLineOption -HistorySaveStyle SaveNothing -ErrorAction Stop; Remove-Module -Name PSReadLine -Force -ErrorAction Stop }',
    WINDOWS_INTERRUPT_SETUP,
    WINDOWS_ENCODING_SETUP,
    WINDOWS_PROMPT_SETUP,
  ].join('; ') + " } catch { [Console]::Error.WriteLine('dsh-pty-bootstrap: ' + $_.Exception.Message); exit 127 }"
}

export function localShellPlan(platform: NodeJS.Platform = process.platform): { argv: readonly string[]; env?: Record<string, string> } {
  return platform === 'win32'
    ? { argv: [resolvePwshPath(), '-NoLogo', '-NoProfile', '-NoExit', '-Command', windowsShellBootstrap()], env: { TERM: 'xterm-256color' } }
    : { argv: ['/bin/bash', '--noprofile', '--norc', '-i'] }
}

export function quotePowerShell(value: string): string {
  if (/[\u0000\r\n]/u.test(value)) throw new Error('A shell path cannot contain a line break or NUL')
  return `'${value.replaceAll("'", "''")}'`
}

export function windowsPromptInit(cdWord?: string): string {
  // Preserve upstream's post-allocation send/settle handshake, now with one
  // submitted line. Encoding, prompt and ReadLine policy are already ready.
  const cd = cdWord === undefined ? '' : `Set-Location -LiteralPath ${cdWord}; `
  return `${cd}${WINDOWS_CLEAR}\r`
}

const workingDirectories = new Map<number, string>()
const markerCarries = new Map<number, string>()

/** Prompt bytes are observational only; no path from the terminal is executed. */
export function observeWindowsCwd(pid: number, chunk: string): void {
  if (!windowsHost) return
  const text = (markerCarries.get(pid) ?? '') + chunk
  for (const match of text.matchAll(/\u001b\]1337;NexusCwd=([A-Za-z0-9+/=]*)\u0007/gu)) {
    const path = Buffer.from(match[1]!, 'base64').toString('utf8')
    if (/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(path) && !/[\u0000\r\n]/u.test(path)) workingDirectories.set(pid, path)
  }
  const start = text.lastIndexOf('\u001b]1337;NexusCwd=')
  if (start >= 0 && text.indexOf('\u0007', start) < 0 && text.length - start <= 32768) {
    markerCarries.set(pid, text.slice(start))
  } else markerCarries.delete(pid)
}

export function windowsCwd(pid: number): string | undefined { return workingDirectories.get(pid) }
export function forgetWindowsCwd(pid: number): void {
  workingDirectories.delete(pid)
  markerCarries.delete(pid)
}

export function directoryCommand(path: string, remote: boolean): string {
  if (windowsHost && !remote) return `Set-Location -LiteralPath ${quotePowerShell(path)}\r`
  return `cd '${path.replaceAll("'", "'\\''")}'\r`
}

type RunInWorld = (ctx: Context, agent: Agent, request: {
  command: string; workdir: string; root: string; timeoutMs: number; stdoutMaxBytes: number
}) => Promise<{ exitCode: number | null; stdout: { text: string } } | undefined>

/** TabExpansion2 parses the draft as data; the draft is never invoked. */
export async function completeWindows(
  ctx: Context, agent: Agent, run: RunInWorld, line: string, cursor: number, cwd: string,
): Promise<DshellCompletion> {
  // The official read-only ACL runner can place PowerShell in constrained
  // language mode. Literal JSON + a cmdlet works there; Convert/Encoding
  // method calls do not. Quote as data rather than evaluating the draft.
  const literal = quotePowerShell(JSON.stringify({ line, cursor }))
  const script = `$nexusAsk = ${literal} | ConvertFrom-Json; `
    + '$nexusResult = TabExpansion2 -inputScript $nexusAsk.line -cursorColumn $nexusAsk.cursor; '
    // ASCII JSON survives every console code page without attempting a
    // forbidden Console property assignment in constrained language mode.
    + '$nexusResult | Select-Object ReplacementIndex,ReplacementLength,@{Name="Matches";Expression={@($_.CompletionMatches | Select-Object -First 61 | Select-Object CompletionText,ListItemText,ResultType,ToolTip)}} | ConvertTo-Json -Depth 5 -Compress -EscapeHandling EscapeNonAscii'
  const response = await run(ctx, agent, { command: script, workdir: cwd, root: cwd, timeoutMs: 3000, stdoutMaxBytes: 131072 })
  const empty: DshellCompletion = { start: cursor, end: cursor, dir: cwd, position: 'argument', candidates: [], truncated: false }
  if (response?.exitCode !== 0) return empty
  let parsed: { ReplacementIndex?: unknown; ReplacementLength?: unknown; Matches?: unknown }
  try { parsed = JSON.parse(response.stdout.text.trim()) } catch { return empty }
  const start = parsed.ReplacementIndex
  const length = parsed.ReplacementLength
  if (!Number.isInteger(start) || !Number.isInteger(length) || (start as number) < 0 || (length as number) < 0
    || (start as number) + (length as number) > line.length) return empty
  // PowerShell's Select-Object/JSON pipeline unwraps a singleton property.
  const matches = Array.isArray(parsed.Matches) ? parsed.Matches
    : parsed.Matches && typeof parsed.Matches === 'object' ? [parsed.Matches] : []
  const candidates = matches.slice(0, 60).flatMap((match: Record<string, unknown>) => {
    if (typeof match.CompletionText !== 'string') return []
    const kind = Number(match.ResultType) === 4 ? 'directory' as const
      : Number(match.ResultType) === 2 ? 'command' as const : 'file' as const
    return [{ name: String(match.ListItemText ?? match.CompletionText), kind,
      insertion: match.CompletionText + (kind === 'command' ? ' ' : ''),
      hint: String(match.ToolTip ?? '').slice(0, 100) }]
  })
  return { ...empty, start: start as number, end: (start as number) + (length as number),
    candidates, truncated: matches.length > 60, position: candidates[0]?.kind === 'command' ? 'command' : 'argument' }
}
