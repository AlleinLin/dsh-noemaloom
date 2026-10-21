/**
 * dshell-commands host face — Phases 6/8.
 *
 * `/new` creates a fresh session with the invoking session's cwd (the dock
 * additionally intercepts `/new` client-side, because the "current session"
 * selection is client-only state no host command can switch). `/compact` is
 * dsh's own `command-compact` — dshell must not re-register it; the dock
 * routes it to the stock executor.
 * `dshell_get_agent_terminal` hands the agent the addressable
 * `TerminalSessionId` of its OWN shell — the PTY the bridge spawns for it,
 * separate from the one the user types into.
 * `dshell_terminal_read` reads the USER's shell (read-only) at command
 * granularity — incremental since an opaque cursor, or the latest commands.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-commands'
// Type-only: pulls the host merges (ctx.sessionController, ctx.tools) and
// the bridge service merge (ctx.dshellTerminalBridge) into the program.
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type { HostCopy } from '@nexus-aethra/dshell-std'
import type { DshellTerminalBridge, TerminalCommandRecord } from '@nexus-aethra/dshell-terminal-bridge'
import { hostCopy } from './host-locales.js'

export const name = '@nexus-aethra/dshell-commands'

/** Bytes one `dshell_terminal_output` call returns by default. */
const DEFAULT_OUTPUT_SLICE_BYTES = 2 * 1024

/**
 * Ceiling on one slice.
 *
 * The point of the tool is that reading is bounded: a caller must not be able to
 * pull a command's output in one gulp and blow up the context the tool exists to
 * protect.
 */
const MAX_OUTPUT_SLICE_BYTES = 8 * 1024

/**
 * UTF-8 byte length of a string.
 *
 * The offsets this tool speaks are bytes, while `String.length` counts UTF-16
 * units. Counted here rather than with `Buffer` so this host-only package stays
 * free of Node types for one arithmetic call.
 */
function utf8Bytes(text: string): number {
  let bytes = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x1_0000 ? 3 : 4
  }
  return bytes
}

/** Render one command record for the model. */
function formatCommand(record: TerminalCommandRecord, includeOutput: boolean): string {
  const name = record.command.length > 0 ? record.command : '(未跟踪的命令)'
  const exit = record.exitCode === null ? '' : `  exit ${String(record.exitCode)}`
  // The seq travels with the line: it is the key dshell_terminal_output takes to
  // read more of this command's output.
  const head = `$ ${name}${exit}  · seq=${String(record.seq)}`
  const output = record.output.trim()
  if (!includeOutput || output.length === 0) return head
  return `${head}\n${output}`
}

/**
 * Hand this package's registrations the services they read.
 *
 * Nested rather than an entry-level `inject`: a plugin-level list holds the
 * ENTRY at `pending` until every name exists, so the bundle it belongs to is
 * reported as failed whenever the host mounts the rows this one waits on after
 * ours — which is what a live enable in the desktop application's plugin window
 * does. Every other dshell package injects this way; the registrations
 * themselves are unchanged, they just run when the services are there.
 *
 * `dshellHostCopy` is what the `/new` command's result lines are localized
 * through, and `sessionController` is what creates the session the command
 * reports on.
 */
export function apply(ctx: Context): void {
  ctx.inject(
    ['commands', 'tools', 'dshellTerminalBridge', 'dshellHostCopy', 'sessionController'],
    (injected) => { register(injected) },
  )
}

/** Everything this package contributes, with its services in hand. */
function register(ctx: Context): void {
  const bridge: DshellTerminalBridge = ctx.dshellTerminalBridge
  // Structural read, as this repo reads dshell services whose accessor
  // declaration lives with the PROVIDER (dshell-terminal-bridge): a consumer's tsc program
  // does not include that package's source, and the `inject` list above is what
  // guarantees the service is there. Bound once, read at call time, so a
  // language switch reaches the next `/new` result without re-binding.
  const copy = ctx.get('dshellHostCopy') as HostCopy
  const t = copy.bind(hostCopy)

  ctx.commands.register({
    name: 'new',
    description: 'Create a new dshell session inheriting the current working directory.',
    handler: async (invocation): Promise<CommandResult> => {
      try {
        const cwd = invocation.agent.session?.header?.cwd
        const created = await ctx.sessionController.create(cwd === undefined ? {} : { cwd })
        return { kind: 'success', text: t('command.new.created', { id: String(created.sessionId) }) }
      } catch (error) {
        return {
          kind: 'error',
          text: t('command.new.failed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        }
      }
    },
  })

  ctx.tools.register(defineTool({
    name: 'dshell_get_agent_terminal',
    description: 'Return the terminal session id of YOUR OWN shell — a PTY spawned for you, '
      + 'starting in the directory the user\'s shell is in. Pass it to terminal_send / '
      + 'terminal_read / terminal_signal to run commands. It is a separate shell from the one '
      + 'the user types into, so your commands and theirs never block each other, and the user '
      + 'can watch yours live in the task card. The user\'s own shell is only readable, via '
      + 'dshell_terminal_read.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { sessionId: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.sessionId }],
    },
    async execute(_args: Record<string, never>, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('dshell_get_agent_terminal requires an agent context')
      return { sessionId: String(await bridge.agentTerminalId(String(agent.id))) }
    },
    presentCall: () => ({ card: 'generic', title: '获取 AI 终端', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'dshell_terminal_read',
    description: 'Read the USER\'s terminal — the shell they are typing into — at command '
      + 'granularity, read-only. Without a cursor it lists the most recent commands; with the '
      + 'cursor a previous call returned, it reports only what happened since — the way to catch '
      + 'up on what the user has been doing without asking them. Output is stripped of terminal '
      + 'control codes. Run your own commands in the shell from '
      + 'dshell_get_agent_terminal instead: typing into the user\'s terminal takes the foreground '
      + 'away from them.',
    parameters: {
      cursor: {
        type: 'string',
        description: 'Opaque cursor from a previous call. Omit to list the most recent commands.',
      },
      limit: {
        type: 'integer',
        description: 'Without a cursor: how many recent commands to list (default 20).',
      },
      includeOutput: {
        type: 'boolean',
        description: 'Without a cursor: include each command\'s output (default true).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          cursor: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.cursor.length > 0 ? `${value.text}\n\ncursor: ${value.cursor}` : value.text,
      }],
    },
    async execute(args: { cursor?: string; limit?: number; includeOutput?: boolean }, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('dshell_terminal_read requires an agent context')
      const sessionId = String(agent.id)
      const NO_SHELL = '主终端尚未打开：用户还没有打开这个会话的终端。'
      if (args.cursor !== undefined && args.cursor.length > 0) {
        const delta = bridge.since(sessionId, args.cursor)
        if (delta === undefined) return { text: NO_SHELL, cursor: '' }
        const lines: string[] = []
        if (delta.cleared) {
          lines.push('终端已重启，游标已失效；下面是新终端的状态。')
        }
        if (delta.newCommandCount > 0) {
          lines.push(`完成 ${String(delta.newCommandCount)} 条命令：`)
          for (const command of delta.commands) lines.push(formatCommand(command, true))
        }
        const text = delta.text.trim()
        if (text.length > 0) lines.push('输出：', text)
        if (delta.dropped) lines.push('…(更早的输出已滚出终端缓冲区)')
        if (lines.length === 0) lines.push('自游标以来没有新的终端活动。')
        return { text: lines.join('\n'), cursor: delta.cursor }
      }
      const history = bridge.history(sessionId, args.limit ?? 20)
      if (history === undefined) return { text: NO_SHELL, cursor: '' }
      const lines = history.commands.length === 0
        ? ['主终端还没有执行过可识别的命令。']
        : history.commands.map(command => formatCommand(command, args.includeOutput !== false))
      return { text: lines.join('\n'), cursor: history.cursor }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.cursor === undefined ? '读取主终端历史' : '读取主终端增量',
      kind: 'read',
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'dshell_terminal_output',
    description: 'Read one command\'s output from the USER\'s terminal in slices — the way to look '
      + 'at a command whose output was too long to be injected whole. Pass the `cursor` from the '
      + 'terminal block that was injected into your context (or from a previous call) and the '
      + 'command\'s `seq`; `offset` and `limit` are bytes into the retained output. Output is kept '
      + 'for the newest commands of the session, at most 64 KiB each, and the *tail* is what '
      + 'survives: when `dropped` is larger than zero that many bytes are missing from the front, so '
      + 'offset 0 is not the beginning of the output. List commands with dshell_terminal_read, then '
      + 'come here for the parts you actually need.',
    parameters: {
      cursor: {
        type: 'string',
        description: 'Session cursor from the injected terminal block or a previous call. Required: '
          + 'it pins the shell generation, so a respawned shell is reported as stale rather than '
          + 'read at the wrong seq.',
        required: true,
      },
      seq: {
        type: 'integer',
        description: 'The command whose output to read, as listed by dshell_terminal_read.',
        required: true,
      },
      offset: {
        type: 'integer',
        description: `Byte offset into the retained output (default 0).`,
      },
      limit: {
        type: 'integer',
        description: `Bytes to return (default ${String(DEFAULT_OUTPUT_SLICE_BYTES)}, at most ${String(MAX_OUTPUT_SLICE_BYTES)}).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          cursor: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(
      args: { cursor: string; seq: number; offset?: number; limit?: number },
      exec,
    ) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('dshell_terminal_output requires an agent context')
      const offset = Math.max(0, Math.trunc(args.offset ?? 0))
      const limit = Math.max(1, Math.min(Math.trunc(args.limit ?? DEFAULT_OUTPUT_SLICE_BYTES), MAX_OUTPUT_SLICE_BYTES))
      const answer = bridge.commandOutput(String(agent.id), args.cursor, Math.trunc(args.seq), offset, limit)
      if (answer === undefined) {
        return { text: '主终端尚未打开：用户还没有打开这个会话的终端。', cursor: '' }
      }
      if (answer.stale) {
        return {
          text: `游标来自已被替换的 shell，seq ${String(args.seq)} 可能指向别的命令。`
            + '请重新读取终端历史（dshell_terminal_read），用新的游标和 seq 再试。',
          cursor: answer.cursor,
        }
      }
      if (!answer.retained || answer.output === null) {
        return {
          text: `seq ${String(args.seq)} 的输出未保留（已被保留期裁掉，或写入早于输出持久化）。`,
          cursor: answer.cursor,
        }
      }
      const slice = answer.output
      const sliceBytes = utf8Bytes(slice.text)
      const head = `$ ${answer.command ?? '(未跟踪的命令)'}`
        + (answer.exitCode === null ? '' : `  exit ${String(answer.exitCode)}`)
      const meta = `[保留 ${String(slice.total)} 字节, 原输出 ${String(slice.bytes)} 字节`
        + (slice.dropped > 0 ? `, 前 ${String(slice.dropped)} 字节已丢弃` : '')
        + `; 本次 offset ${String(slice.offset)}`
        + (slice.truncated ? ` -> ${String(slice.offset + sliceBytes)}` : ' -> 末尾')
        + ']'
      const next = slice.truncated
        ? `\n\n(next offset: ${String(slice.offset + sliceBytes)})`
        : ''
      return {
        text: `${head}\n${meta}\n${slice.text}${next}\n\ncursor: ${answer.cursor}`,
        cursor: answer.cursor,
      }
    },
    presentCall: () => ({ card: 'generic', title: '读取命令输出', kind: 'read' }),
  }))
}

export default { name, apply }
