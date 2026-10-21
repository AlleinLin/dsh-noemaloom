import { resolve } from 'node:path';

export function replaceAnchor(source, anchor, replacement, label) {
  const offset = source.indexOf(anchor);
  if (offset < 0 || source.indexOf(anchor, offset + anchor.length) >= 0) {
    throw new Error(`${label}: upstream anchor changed; review the adaptation before upgrading`);
  }
  return source.slice(0, offset) + replacement + source.slice(offset + anchor.length);
}

/** Keep the archive tree unchanged and fail closed when upstream code moves. */
export function adaptTerminalSource(filename, source, root) {
  const path = resolve(filename).replaceAll('\\', '/');
  const base = resolve(root).replaceAll('\\', '/');
  const name = path.slice(base.length + 1);
  const inject = names => { source = `import { ${names} } from ${JSON.stringify(resolve(root, 'nexus-adapter/platform.ts').replaceAll('\\', '/'))}\n${source}`; };
  const replace = (anchor, value) => { source = replaceAnchor(source, anchor, value, name); };
  if (name === 'packages/dshell/terminal-bridge/src/pty.ts') {
    inject('localShellPlan, windowsHost, observeWindowsCwd, forgetWindowsCwd, spawnHostPty');
    replace("import * as nodePty from 'node-pty'", `import type { HostPty } from ${JSON.stringify(resolve(root, 'nexus-adapter/platform.ts').replaceAll('\\', '/'))}\nimport type { Context } from '@deepseek-ai/cordis'`);
    replace('private readonly pty: nodePty.IPty', 'private readonly pty: HostPty');
    replace("const LOCAL_SHELL = { argv: ['/bin/bash', '--noprofile', '--norc', '-i'] } as const", 'const LOCAL_SHELL = localShellPlan()');
    replace("export const LOCAL_SHELL_SUPPORTED = process.platform !== 'win32'", 'export const LOCAL_SHELL_SUPPORTED = true');
    replace("        await shellLocale(),", '        windowsHost ? undefined : await shellLocale(),');
    replace('    plan: { argv: readonly string[]; env?: Record<string, string> | undefined },',
      '    plan: { argv: readonly string[]; env?: Record<string, string> | undefined; pty?: HostPty | undefined },');
    replace(`    this.pty = nodePty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      ...(cwd === undefined || cwd === '' ? {} : { cwd }),
      env: {
        ...process.env,
        ...(locale === undefined ? {} : { LC_ALL: locale }),
        TERM: 'xterm-256color',
        ...plan.env,
      } as Record<string, string>,
    })`, '    if (plan.pty === undefined) throw new Error("DSH terminal provider did not allocate a PTY")\n    this.pty = plan.pty');
    replace('        LOCAL_SHELL,', '        { ...LOCAL_SHELL, pty: await spawnHostPty(this.hostContext!, spec, this.cols, this.rows) },');
    replace('    private readonly onForeign: ((owner: unknown, sessionId: TerminalSessionId) => void) | undefined = undefined,',
      '    private readonly onForeign: ((owner: unknown, sessionId: TerminalSessionId) => void) | undefined = undefined,\n    private readonly hostContext: Context | undefined = undefined,');
    replace("    this.pty.onData((data: string) => { this.onData(this.decoder.write(data)) })",
      '    this.pty.onData((data: string) => { observeWindowsCwd(this.pty.pid, data); this.onData(data) })');
    replace("    this.pty.onExit(({ exitCode, signal }) => {", '    this.pty.onExit(({ exitCode, signal, detail }) => {\n      this.startupDetail = detail\n      forgetWindowsCwd(this.pty.pid)');
    replace("    try { process.kill(-pid, signal as NodeJS.Signals) } catch { /* already gone */ }\n    try { process.kill(pid, signal as NodeJS.Signals) } catch { /* already gone */ }",
      '    this.pty.kill()');
    replace('    this.pty.write(text)\n  }\n\n  resize(cols: number, rows: number): void {',
      "    this.pty.write(text)\n  }\n\n  override async signal(signal: TerminalSignal): Promise<TerminalSignalResult> {\n    return { delivered: true, targetPgid: await this.pty.nexusSignal(signal) }\n  }\n\n  override async close(reason: string): Promise<void> {\n    await super.close(reason)\n    await this.pty.nexusTerminate()\n  }\n\n  resize(cols: number, rows: number): void {");
    replace('  startSend(request: TerminalSendRequest): TerminalSendOperation {\n    if (this.closed)',
      '  startSend(request: TerminalSendRequest): TerminalSendOperation {\n    request.signal?.throwIfAborted()\n    if (this.closed)');
    replace("    this.scheduleSettle(operation, input.length > 0)",
      "    if (request.signal !== undefined) {\n      const abort = (): void => { operation.cancel() }\n      request.signal.addEventListener('abort', abort, { once: true })\n      void operation.done.finally(() => request.signal?.removeEventListener('abort', abort)).catch(() => {})\n      if (request.signal.aborted) abort()\n    }\n    this.scheduleSettle(operation, input.length > 0)");
  }
  if (name === 'packages/dshell/commands/src/index.ts') {
    replace("      + 'dshell_terminal_read.',",
      "      + 'dshell_terminal_read. Local Windows terminals use PowerShell 7: use Get-ChildItem, '\n      + 'Set-Location -LiteralPath and PowerShell quoting, not Bash flags or syntax. '\n      + 'SSH device terminals retain the remote POSIX shell. The returned shell field is authoritative.',");
    replace("        properties: { sessionId: { type: 'string', required: true } },",
      "        properties: { sessionId: { type: 'string', required: true }, shell: { type: 'string', required: true } },");
    replace("      render: (_args, value) => [{ type: 'text', text: value.sessionId }],",
      "      render: (_args, value) => [{ type: 'text', text: `sessionId: ${value.sessionId}\\nshell: ${value.shell}` }],");
    replace("      return { sessionId: String(await bridge.agentTerminalId(String(agent.id))) }",
      "      const remote = (ctx.get('dshellSshRouting') as { targetForSession(id: string): unknown } | undefined)?.targetForSession(String(agent.id)) !== undefined\n      const shell = process.platform === 'win32' && !remote ? 'PowerShell 7 (Windows; use PowerShell syntax and literal paths)' : 'POSIX shell (Bash-compatible)'\n      return { sessionId: String(await bridge.agentTerminalId(String(agent.id))), shell }");
  }
  if (name === 'packages/dshell/mode/src/index.ts') {
    source = `import { terminalWorkspaceRoot, prepareTerminalRoot } from ${JSON.stringify(resolve(root, 'nexus-adapter/terminal-workspace.ts').replaceAll('\\', '/'))}\n${source}`;
    replace('  const terminalRoot = hostHome()', '  const terminalRoot = terminalWorkspaceRoot(hostHome())');
    replace('        onStart: (sessionId: string) => {',
      '        prepareRoot: (signal: AbortSignal) => prepareTerminalRoot(terminalRoot, signal),\n        onStart: (sessionId: string) => {');
  }
  if (name === 'packages/dshell/mode/src/terminal-mode.ts') {
    replace('export interface TerminalModeRouteDeps {',
      'export interface TerminalModeRouteDeps {\n  /** Fixed-root preparation reached only through Connection owner admission. */\n  readonly prepareRoot?: (signal: AbortSignal) => Promise<void>');
    replace("          if (input.action === 'set' && typeof input.sessionId === 'string') {",
      "          if (input.action === 'prepare-root') {\n            await deps.prepareRoot?.(request.signal)\n          } else if (input.action === 'set' && typeof input.sessionId === 'string') {");
  }
  if (name === 'packages/dshell/mode/src/terminal-mode-protocol.ts') {
    replace('export type TerminalModeRequest =',
      "export type TerminalModeRequest =\n  /** Owner explicitly requested the fixed new-terminal workspace. */\n  | { readonly action: 'prepare-root' }");
  }
  if (name === 'packages/dshell/mode/src/client/terminal-mode.ts') {
    replace('  /** Remember which workspace the section lives in. */',
      "  /** Explicit owner action; GET/load never creates a directory. */\n  async prepareRoot(): Promise<void> {\n    const response = await fetch(DSHELL_TERMINAL_MODE_PATH, {\n      method: 'POST', credentials: 'include',\n      headers: { 'content-type': 'application/json' },\n      body: JSON.stringify({ action: 'prepare-root' }),\n    })\n    if (!response.ok) throw new Error('Could not prepare the terminal workspace; choose an existing writable workspace')\n    this.publish(await response.json() as TerminalModeResponse)\n  }\n\n  /** Remember which workspace the section lives in. */");
  }
  if (name === 'packages/dshell/mode/src/client/terminal-section.ts') {
    replace('      const path = deps.modes.root()',
      '      await deps.modes.prepareRoot()\n      const path = deps.modes.root()');
  }
  if (name === 'packages/dshell/terminal-bridge/src/index.ts') {
    inject('windowsHost, windowsPromptInit, windowsCwd, quotePowerShell');
    replace("  static inject = ['terminals', 'agents'] as const", "  static inject = ['terminals', 'agents', 'subprocess', 'sandboxPolicy', 'sessionProjections', 'workingDirectory'] as const");
    replace('    void this.claimForeignAgent(owner, sessionId)\n  })',
      '    void this.claimForeignAgent(owner, sessionId)\n  }, this.ctx)');
    replace("    const init = [", '    const init = windowsHost && !record.session.redirected ? windowsPromptInit(options.cdTo) : [');
    replace("    try {\n      return readlinkSync(`/proc/${String(session.pid)}/cwd`)", "    if (windowsHost) return windowsCwd(session.pid)\n    try {\n      return readlinkSync(`/proc/${String(session.pid)}/cwd`)");
    replace('function forkDirWord(record: MainRecord | undefined): string | undefined {',
      'function forkDirWord(record: MainRecord | undefined): string | undefined {\n  if (windowsHost && record !== undefined && !record.session.redirected) {\n    const directory = windowsCwd(record.session.pid)\n    return directory === undefined ? undefined : quotePowerShell(directory)\n  }');
  }
  if (name === 'packages/dshell/files/src/route.ts') {
    inject('windowsHost, directoryCommand, completeWindows');
    replace('  bridge.feed(sessionId, `cd ${quote(directory)}\\r`)',
      '  bridge.feed(sessionId, directoryCommand(directory, routing()?.targetForSession(sessionId) !== undefined))');
    replace('  // What the line expects where the caret is, and where the word it replaces',
      "  if (windowsHost && routing()?.targetForSession(sessionId) === undefined) {\n    const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId))\n    if ('error' in resolved) throw new Error(`Session unavailable: ${resolved.error.code}`)\n    return await completeWindows(ctx, resolved.agent, runInWorld, line, cursor, shellCwd ?? cwd ?? resolved.agent.session.header.cwd ?? process.cwd())\n  }\n  // What the line expects where the caret is, and where the word it replaces");
    replace('  oracle: boolean,\n): Promise<void> {\n  const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId))',
      "  oracle: boolean,\n): Promise<void> {\n  if (windowsHost && routing()?.targetForSession(sessionId) === undefined) return\n  const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId))");
    replace("  return (value ?? '').split(':').map(part => part.trim()).filter(part => part.length > 0)",
      "  return (value ?? '').split(windowsHost && value?.includes(';') ? ';' : ':').map(part => part.trim()).filter(part => part.length > 0)");
  }
  if (name === 'packages/dshell/mode/src/client/completion.ts') {
    replace("      const name = item.kind === 'directory'",
      "      const insertion = (item as { insertion?: string }).insertion\n      const name = insertion ?? (item.kind === 'directory'");
    replace('          : item.name\n      const text =', '          : item.name)\n      const text =');
  }
  if (name === 'packages/dshell/std/src/contracts.ts') {
    replace("export const DSHELL_BUNDLE_NAME = '@nexus-aethra/dshell-bundle'", "export const DSHELL_BUNDLE_NAME = '@local/dsh-nexus'");
  }
  if (name === 'packages/dshell/ssh/src/connection.ts') {
    replace("  const path = join(root, 'lib', 'helper.js')", "  const path = join(root, 'lib', 'native', 'dshell-ssh-helper.js')");
    replace("      if (manifest.name === '@nexus-aethra/dshell-ssh') return directory",
      "      if (manifest.name === '@local/dsh-nexus') return directory");
  }
  return source;
}
