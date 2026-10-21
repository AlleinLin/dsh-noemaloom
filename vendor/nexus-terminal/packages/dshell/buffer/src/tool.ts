/**
 * The single `dshell_buffer` tool — the only door between an agent and the
 * buffer.
 *
 * Four families of action behind one name (linking state, ticket lifecycle,
 * the grant view, and granted file access). One tool rather than a dozen keeps
 * the surface small for the model and, more importantly, keeps every check in
 * one place: the granted file actions are the only way a session can touch
 * another session's tree, and they run through the service's single
 * containment test.
 *
 * The calling session is taken from `exec.agent`, never from an argument, so a
 * model cannot claim to be someone else.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { sessionLabel } from './notice.js'
import type { BufferGrant, BufferLink, BufferTicket } from './protocol.js'
import type { DelegateInput, GrantRequest, BufferService } from './service.js'

/** Hard cap on text an agent may pull out of one granted file in one call. */
const MAX_READ_CHARS = 120_000

const ACTION_KINDS: Record<string, GenericCallView['kind']> = {
  links: 'read',
  tickets: 'read',
  grants: 'read',
  read: 'read',
  ls: 'read',
  download: 'move',
  upload: 'move',
}

const DESCRIPTION =
  'Cross-session pipe. Reach for this when a task belongs to another machine or another session — the user '
  + 'names a server or device, or the files and environment you need are not in this session\'s own world: '
  + 'action="links" tells you whether a peer is connected and where it runs, and a task you would otherwise '
  + 'be unable to complete here is handed over with action="delegate" instead of improvised with ssh/scp. '
  + 'Use it as well to serve requests other sessions handed to you. Peers are dshell terminal sessions '
  + '(the ones the sidebar lists as terminals); only the user creates pipes. Actions:\n'
  + '- links: the pipes this session is an end of (how you learn the peer session ids and link ids, and '
  + 'what each pipe is for).\n'
  + '- describe: name a pipe and/or state what it is for. The peer\'s model reads that text before '
  + 'deciding whether a request belongs there, so write it for the peer: what travels over this pipe and '
  + 'why, in one short line. Either end may write it; an empty string clears a field. Use it when a pipe '
  + 'has no purpose yet and you have learned what it is for.\n'
  + '- delegate: send a request to the session on the other end of a pipe. Supply to or link_id, a '
  + 'subject, optional detail, an optional deadline_ms, and optionally grants — files or directories '
  + 'of THIS session\'s world you open to the other side, each with read and/or write rights. Every '
  + 'granted area gets a NAME, which is the buffer path the other side uses to reach it (give one '
  + 'with `as`; omitted, the path\'s last segment is used, and a name already taken on that side gets '
  + 'a numeric suffix — the result below reports the effective names). Re-granting an area this pair '
  + 'already covers just re-holds the same authorization. Returns at once with a ticket id; the answer '
  + 'arrives later as a new message, so end your turn or keep working on something else instead of '
  + 'waiting.\n'
  + '- tickets: the requests sent to you (direction "in") or by you (direction "out").\n'
  + '- claim / progress / finish / fail: the worker side of a ticket. A ticket you received must end '
  + 'in finish (with a result) or fail (with a reason); nothing may be left unresolved.\n'
  + '- cancel: withdraw an outstanding ticket from either end.\n'
  + '- grants: the mapped paths other sessions opened to you (with rights and the real location behind '
  + 'each), and the ones you opened to them, with their remaining reference counts.\n'
  + '- ls: with no path, list the buffer roots this session holds (path "/" or none) — each mapped area as /name/ with '
  + 'its rights and origin. With a buffer path, list that directory.\n'
  + '- read: one text file from the buffer, addressed by buffer path (/mappedName/sub/file). offset '
  + 'is a 1-based line to start from and limit caps lines, so big files page instead of flooding.\n'

  + '- edit: replace old_string with new_string inside one buffer file, in place — for targeted '
  + 'changes this beats download-then-upload. old_string must already exist and be unique unless '
  + 'replace_all is set; edit cannot create files, upload does that.\n'
  + '- download / upload: the explicit byte moves between the two machines. download copies a buffer '
  + 'file to dest in this session\'s own world; upload pushes this session\'s src file into the buffer '
  + 'at path. Binary-safe, capped by max_bytes; files up to 32 MiB move inline, anything larger is '
  + 'relayed in 16 MiB chunks with sha256 verification (up to 4 GiB).\n'
  + 'Buffer paths are rooted at /: an area named "study" mapped from a DIRECTORY is addressed as '
  + '/study/sub/file, while an area mapped from a FILE is addressed by the mapping path itself (/name) — '
  + 'action=ls '
  + 'with no path (or path "/") lists this session\'s mapped roots. That path IS the whole contract '
  + 'between the two sessions — never refer to anything by an internal id. The namespace is per SESSION: '
  + 'the areas of every live grant this session holds merge under one root, so names are unique on that '
  + 'side. DIRECTIONS: whoever HOLDS a grant is the one who acts inside the other side\'s world — so to '
  + 'hand a file over, grant read and tell the other side to download it into its own world; to receive '
  + 'one, the other side must grant write and you upload your file in. A grant stays alive only while a '
  + 'ticket references it: settle the ticket and its mapped paths end with it.'

/**
 * One delegation's inline grant, as the model writes it.
 *
 * A separate shape from the service's `GrantRequest` only because the wire form
 * is snake_case-JSON while the service speaks camelCase.
 */
interface GrantParam {
  readonly description: string
  readonly areas: readonly { readonly path: string; readonly rights: readonly ('read' | 'write')[]; readonly as?: string }[]
}

/** Normalize a model-supplied grant into the service's request shape. */
function toGrantRequest(grants: readonly GrantParam[]): GrantRequest[] {
  return grants.map(grant => ({
    description: grant.description,
    areas: grant.areas.map(area => ({
      path: area.path,
      rights: [...area.rights],
      ...(area.as === undefined ? {} : { as: area.as }),
    })),
  }))
}

/** Require one non-empty string argument. */
function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) throw new Error(`缺少参数 ${name}`)
  return value.trim()
}

/** Minutes from now until a deadline, never below zero. */
function minutesLeft(deadlineAt: number): number {
  return Math.max(0, Math.ceil((deadlineAt - Date.now()) / 60_000))
}

/** `读/写` for a rights list. */
function rightsLabel(rights: readonly string[]): string {
  const parts: string[] = []
  if (rights.includes('read')) parts.push('读')
  if (rights.includes('write')) parts.push('写')
  return parts.length > 0 ? parts.join('/') : '无'
}

/** One line acounting for a ticket, from the side of the session reading it. */
function ticketLine(ticket: BufferTicket, service: BufferService, viewer: string): string {
  const peer = ticket.from === viewer ? ticket.to : ticket.from
  const who = ticket.from === viewer ? '发给' : '来自'
  const state = ticket.state === 'queued' || ticket.state === 'running'
    ? `${ticket.state}（剩约 ${String(minutesLeft(ticket.deadlineAt))} 分钟）`
    : ticket.state
  const tail = ticket.result ?? ticket.error ?? ticket.reports[ticket.reports.length - 1]?.text
  return `- ${ticket.id} · ${state} · ${who} ${service.label(peer)} · ${ticket.subject}${tail === undefined ? '' : ` · ${tail}`}`
}

/** Render the link list. */
function renderLinks(service: BufferService, viewer: string): string {
  const links = service.linksFor(viewer)
  if (links.length === 0) {
    return '本会话还没有连接到任何会话。请让用户打开「管道」页面建立连接；建立之前无法委派。'
  }
  const lines = ['本会话的管道：']
  for (const link of links) {
    const peer = service.peerOf(link, viewer)
    // The pipe's own label is NOT the peer's name (labelOf falls back to it), so
    // state it separately instead of printing the same words twice.
    lines.push(`- link_id=${link.id} · 对端 session id=${peer} · ${sessionLabel(peer, undefined, undefined)}`
      + (link.label === undefined ? '' : ` · 名称「${link.label}」`))
    lines.push(link.description === undefined
      ? '  用途：（还没写。如果你已经知道这条管道用来做什么，用 action="describe" 写下来，对端的模型会读到。）'
      : `  用途：${link.description}${link.annotatedBy === undefined ? '' : `（由 ${service.label(link.annotatedBy)} 填写）`}`)
  }
  lines.push('', 'delegate 时 to 填对端 session id（上面每行都有），或 link_id 填管道 id——两者任选其一。')
  lines.push('action="describe" 可以给管道命名、写用途（link_id 或 to 任选其一）。')
  return lines.join('\n')
}

/**
 * The pipe a naming call addresses, from `link_id` or the peer's session id.
 *
 * Only the caller's own pipes are candidates, so a link id belonging to another
 * pair reads as unknown rather than as somebody else's business.
 */
function requireLinkBy(
  service: BufferService,
  viewer: string,
  args: { readonly link_id?: string | undefined; readonly to?: string | undefined },
): BufferLink {
  const links = service.linksFor(viewer)
  if (args.link_id !== undefined) {
    const found = links.find(link => link.id === args.link_id)
    if (found === undefined) throw new Error(`不是本会话的管道：${args.link_id}（用 action="links" 查看）`)
    return found
  }
  if (args.to !== undefined) {
    const found = links.find(link => link.a === args.to || link.b === args.to)
    if (found === undefined) throw new Error(`没有连接 ${args.to} 的管道（用 action="links" 查看）`)
    return found
  }
  throw new Error('请给出 link_id 或 to，指明是哪条管道。')
}

/** Render the granted-area view, from both directions. */
function renderGrants(service: BufferService, viewer: string): string {
  const received = service.grantsFor(viewer)
  const issued = service.grantsIssuedBy(viewer)
  const lines: string[] = []
  lines.push('他人授予本会话的访问权：')
  if (received.length === 0) {
    lines.push('- （无）')
  } else {
    for (const grant of received) {
      lines.push(`- 来自 ${service.label(grant.from)}（剩余引用 ${String(grant.count)}）`)
      if (grant.description.trim().length > 0) lines.push(`  用途：${grant.description.trim()}`)
      for (const area of grant.areas) {
        lines.push(`  ${area.as === undefined ? area.path : `/${area.as}/ ← ${area.path}`}（${rightsLabel(area.rights)}）`)
      }
    }
    lines.push('', '用 ls / read / edit / download / upload 以缓冲路径访问（根为 /，如 /名字/子/文件）；下载会复制到你自己的世界，上传会把你的文件写进对方的映射。')
  }
  lines.push('', '本会话发出的访问权：')
  if (issued.length === 0) {
    lines.push('- （无）')
  } else {
    for (const grant of issued) {
      const state = grant.revokedAt === undefined ? `剩余引用 ${String(grant.count)}` : '已回收'
      lines.push(`- 给 ${service.label(grant.to)} · ${state}`)
      for (const area of grant.areas) {
        lines.push(`  ${area.as === undefined ? area.path : `/${area.as}/ ← ${area.path}`}（${rightsLabel(area.rights)}）`)
      }
    }
  }
  return lines.join('\n')
}

/** Render a delegate outcome for the requester. */
function renderDelegated(
  ticket: BufferTicket,
  targetStatus: string,
  grants: readonly BufferGrant[],
  service: BufferService,
): string {
  const lines = [
    `已委派给 ${service.label(ticket.to)}（ticket ${ticket.id}）。`,
    targetStatus === 'idle'
      ? '对方当时空闲，已用一条新消息唤醒它。'
      : '对方当时正忙，请求已排进它的队列。',
  ]
  if (grants.length > 0) {
    lines.push('', '对方可以通过这些缓冲路径访问你开出的位置（任务结算时自动回收）：')
    for (const grant of grants) {
      for (const area of grant.areas) {
        const name = area.as === undefined ? area.path : `/${area.as}`
        lines.push(`- ${name} ← ${area.path}（${rightsLabel(area.rights)}）`)
      }
    }
    lines.push('映射的是文件就直接用 /名字；映射的是目录，它的内容在 /名字/… 下面。')
    lines.push('对方如果只读，让它用 download 把文件取到它自己的世界（你开出的授权是它在你的世界里动手的凭据）。')
  }
  lines.push(
    '',
    `结果会以一条新消息回到本会话（ticket ${ticket.id}），无论成功、失败还是超时。`,
    '现在不要空等：结束本回合，或继续你手上其他的事；回报到达时你的回合会被重新打开。',
  )
  return lines.join('\n')
}

/** Cap one granted read so a huge file cannot swallow the context. */
function capRead(text: string): string {
  if (text.length <= MAX_READ_CHARS) return text
  return `${text.slice(0, MAX_READ_CHARS)}\n…（已截断，原文 ${String(text.length)} 字符）`
}

/** Pending-call card for one action. */
function present(args: { action?: string; to?: string; ticket_id?: string; path?: string; subject?: string }): GenericCallView {
  const kind = args.action === undefined ? undefined : ACTION_KINDS[args.action]
  const target = args.to ?? args.ticket_id ?? args.path
  const title = args.action === 'delegate' && args.subject !== undefined
    ? `管道委派：${args.subject}`
    : `管道 ${args.action ?? '操作'}`
  return { card: 'generic', title, ...kind === undefined ? {} : { kind }, ...target === undefined ? {} : { rawInput: target } }
}
/** Register the one buffer tool. */
export function registerBufferTool(ctx: Context, service: BufferService): () => void {
  return ctx.tools.register(defineTool({
    name: 'dshell_buffer',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['links', 'describe', 'delegate', 'tickets', 'claim', 'progress', 'finish', 'fail', 'cancel', 'grants', 'read', 'ls', 'edit', 'download', 'upload'],
        description: 'Which buffer operation to perform.',
      },
      to: { type: 'string', description: 'delegate: target session id (the peer of a pipe). describe: the peer whose pipe to name, instead of link_id.' },
      link_id: { type: 'string', description: 'delegate: the pipe to send over, instead of to. describe: the pipe to name.' },
      pipe_label: { type: 'string', description: 'describe: the pipe\'s name. Empty string clears it.' },
      pipe_description: { type: 'string', description: 'describe: what this pipe is for, written for the PEER\'s model — what travels over it and why. Empty string clears it.' },
      subject: { type: 'string', description: 'delegate: one-line statement of what is being asked.' },
      detail: { type: 'string', description: 'delegate: the full request, including acceptance criteria.' },
      grants: {
        type: 'array',
        description: 'delegate: directories this session opens to the target, each with read and/or write rights. Released automatically when the ticket settles.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string', required: true },
            areas: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true, description: 'A real directory or file in THIS session\'s world to map into the buffer.' },
                  rights: { type: 'array', required: true, items: { type: 'string', enum: ['read', 'write'] } },
                  as: { type: 'string', description: 'The name this area takes in the buffer (a single path segment). Omitted, the path\'s last segment is used; a name already taken on the other side is suffixed, and the result reports the effective name.' },
                },
              },
            },
          },
        },
      },
      deadline_ms: { type: 'number', description: 'delegate: how long the target has before the watchdog settles the ticket as timeout. Default 10 minutes.' },
      ticket_id: { type: 'string', description: 'The ticket a lifecycle action applies to.' },
      direction: { type: 'string', enum: ['in', 'out', 'both'], description: 'tickets: which side to list. Default both.' },
      text: { type: 'string', description: 'progress: what to report.' },
      result: { type: 'string', description: 'finish: the outcome handed back to the requester.' },
      error: { type: 'string', description: 'fail: why the request could not be completed.' },
      path: { type: 'string', description: 'Buffer path rooted at /: /mappedName/sub/file — the name the delegating side declared with as. ls with no path (or "/") lists every mapped root.' },
      offset: { type: 'number', description: 'read: 1-based line number to start from, for paging through a big text file.' },
      limit: { type: 'number', description: 'read: maximum lines to return.' },
      old_string: { type: 'string', description: 'edit: the exact text to replace; must already exist in the file (edit cannot create files — use upload for that), and must occur exactly once unless replace_all.' },
      new_string: { type: 'string', description: 'edit: the replacement text (may be empty to delete).' },
      replace_all: { type: 'boolean', description: 'edit: replace every occurrence of old_string. Default false.' },
      dest: { type: 'string', description: 'download: the full destination file path in THIS session\'s own world; omitted means the same relative path as path.' },
      src: { type: 'string', description: 'upload: the source file path in THIS session\'s own world.' },
      max_bytes: { type: 'number', description: 'download / upload: whole-file size ceiling in bytes. Files up to 32 MiB move inline; larger files transfer automatically in 16 MiB chunks with sha256 verification (default ceiling 1 GiB, hard cap 4 GiB).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec): Promise<{ text: string }> {
      if (exec.agent === undefined) throw new Error('dshell_buffer 只能在某个会话的 agent 内调用')
      const text = await run(args, String(exec.agent.id), service, exec.signal)
      return { text }
    },
    presentCall: args => present(args as Parameters<typeof present>[0]),
  }))
}

/**
 * Resolve the file actions' target: a buffer path (/mappedName/sub/file) picks
 * A buffer path is the ONLY addressing: its first segment names the mapping, and
 * the rest is the path inside that mapped area.
 */
/** The buffer path a call used, echoed back in its output. */
function resolveLabel(args: { path?: string }): string {
  return (args.path ?? '').trim()
}

function resolveTarget(service: BufferService, viewer: string, args: { path?: string }): { grantId: string; path: string } {
  const path = (args.path ?? '').trim()
  if (path === '' || path === '/') throw new Error('需要缓冲路径，例如 /名字/子/文件；用 action=ls 查看结构')
  return service.resolveBufferPath(viewer, path)
}

/** One dispatched action, returning its model-facing text. */
async function run(
  args: {
    action: string
    to?: string
    link_id?: string
    subject?: string
    detail?: string
    grants?: readonly GrantParam[]
    deadline_ms?: number
    ticket_id?: string
    direction?: string
    text?: string
    result?: string
    error?: string
    path?: string
    offset?: number
    limit?: number
    old_string?: string
    new_string?: string
    replace_all?: boolean
    src?: string
    content?: string
    dest?: string
    side?: string
    max_bytes?: number
    pipe_label?: string
    pipe_description?: string
  },
  viewer: string,
  service: BufferService,
  signal: AbortSignal,
): Promise<string> {
  switch (args.action) {
    case 'links':
      return renderLinks(service, viewer)

    case 'describe': {
      const link = requireLinkBy(service, viewer, args)
      const updated = await service.annotateLink(link.id, {
        label: args.pipe_label,
        description: args.pipe_description,
      }, viewer)
      return `已更新管道 ${updated.id}：名称「${updated.label ?? '（未命名）'}」，用途「${updated.description ?? '（未写）'}」。`
        + '对端的模型会在每次组装提示词时读到这段用途。'
    }

    case 'delegate': {
      const input: DelegateInput = {
        ...args.to === undefined ? {} : { to: args.to },
        ...args.link_id === undefined ? {} : { linkId: args.link_id },
        subject: required(args.subject, 'subject'),
        ...args.detail === undefined ? {} : { detail: args.detail },
        ...args.grants === undefined ? {} : { grants: toGrantRequest(args.grants) },
        ...args.deadline_ms === undefined ? {} : { deadlineMs: args.deadline_ms },
      }
      const outcome = await service.delegate(viewer, input)
      return renderDelegated(outcome.ticket, outcome.targetStatus, outcome.grants, service)
    }

    case 'tickets': {
      const direction = args.direction === 'in' || args.direction === 'out' ? args.direction : 'both'
      const tickets = service.ticketsFor(viewer, direction)
      if (tickets.length === 0) {
        return direction === 'in'
          ? '没有其他会话委派给你的请求。'
          : direction === 'out' ? '本会话还没有委派过请求。' : '本会话没有管道请求记录。'
      }
      const lines = [`管道请求（${direction}，共 ${String(tickets.length)} 条）：`]
      for (const ticket of tickets) lines.push(ticketLine(ticket, service, viewer))
      const open = tickets.filter(ticket => ticket.state === 'queued' || ticket.state === 'running')
      if (open.some(ticket => ticket.to === viewer)) {
        lines.push('', '其中发给本会话的未结算请求，必须用 claim / progress / finish / fail 推进到结算。')
      }
      return lines.join('\n')
    }

    case 'claim': {
      const ticketId = required(args.ticket_id, 'ticket_id')
      await service.claim(ticketId, viewer)
      return `已认领 ${ticketId}。完成后请用 finish（带 result）或 fail（带 error）结算。`
    }

    case 'progress': {
      const ticketId = required(args.ticket_id, 'ticket_id')
      const body = required(args.text, 'text')
      await service.report(ticketId, viewer, body, false)
      return `已记录进度（${ticketId}）。`
    }

    case 'finish': {
      const ticketId = required(args.ticket_id, 'ticket_id')
      const result = required(args.result, 'result')
      await service.finish(ticketId, viewer, result)
      return `已结算 ${ticketId} 为完成，请求方会被唤醒并收到结果。`
    }

    case 'fail': {
      const ticketId = required(args.ticket_id, 'ticket_id')
      const reason = required(args.error, 'error')
      await service.fail(ticketId, viewer, reason)
      return `已结算 ${ticketId} 为失败，请求方会被唤醒并收到原因。`
    }

    case 'cancel': {
      const ticketId = required(args.ticket_id, 'ticket_id')
      await service.cancel(ticketId, viewer)
      return `已取消 ${ticketId}。`
    }

    case 'grants':
      return renderGrants(service, viewer)

    // File actions address the buffer by mapped name (see ls) or by
    // Buffer paths only: the first segment resolves the mapping for us.
    // Reading and editing happen in the granter's world, zero copy; download
    // and upload are the explicit cross-world byte moves.
    case 'read': {
      const target = resolveTarget(service, viewer, args)
      const body = await service.readGranted(
        viewer,
        target.grantId,
        target.path,
        { offset: args.offset, limit: args.limit },
        signal,
      )
      return `${resolveLabel(args)}：\n\n${capRead(body)}`
    }

    case 'edit': {
      const target = resolveTarget(service, viewer, args)
      if (args.old_string === undefined || args.new_string === undefined) throw new Error('缺少参数 old_string / new_string')
      const edited = await service.editGranted(
        viewer, target.grantId, target.path,
        args.old_string, args.new_string, args.replace_all === true, signal,
      )
      return `已编辑 ${resolveLabel(args)}：替换 ${String(edited.replacements)} 处`
        + `（${String(edited.fromLength)} → ${String(edited.toLength)} 字符）。`
    }

    case 'download': {
      const target = resolveTarget(service, viewer, args)
      const outcome = await service.download(viewer, target.grantId, target.path, args.dest, args.max_bytes, signal)
      return `已下载：${outcome.source} → ${outcome.destination}，${String(outcome.bytes)} 字节`
        + (outcome.chunks === undefined ? '' : `（分 ${String(outcome.chunks)} 块中继，sha256 已校验）`) + '。'
    }

    case 'upload': {
      const target = resolveTarget(service, viewer, args)
      if (args.src === undefined || args.src.trim().length === 0) throw new Error('缺少参数 src')
      const outcome = await service.upload(viewer, target.grantId, target.path, args.src, args.max_bytes, signal)
      return `已上传：${outcome.source} → ${outcome.destination}，${String(outcome.bytes)} 字节`
        + (outcome.chunks === undefined ? '' : `（分 ${String(outcome.chunks)} 块中继，sha256 已校验）`) + '。'
    }

    case 'ls': {
      const rawPath = (args.path ?? '').trim()
      if (rawPath === '' || /^\/+$/u.test(rawPath)) {
        return service.bufferTree(viewer)
      }
      const target = resolveTarget(service, viewer, args)
      const listing = await service.listGranted(viewer, target.grantId, target.path, signal)
      return `缓冲路径 ${resolveLabel(args)}：\n${listing}`
    }

    default:
      throw new Error(`未知 action：${args.action}`)
  }
}
