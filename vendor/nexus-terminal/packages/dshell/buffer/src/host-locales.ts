/**
 * `dshellBuffer`'s HOST dictionaries — the copy this package's host half
 * composes that a reader sees.
 *
 * Two host-composed surfaces are covered here, and both exist because the
 * browser cannot write them:
 *
 * - the pipe NOTICES: the delegated request a worker reads and the settlement
 *   a requester reads. They ride a plugin-sourced message, so the transcript
 *   renders them (collapsed summary row, full body when expanded) and the
 *   model reads the same text. The user's screen is the reason they are
 *   written in the same language as the panel.
 * - the route REFUSALS a panel action can trigger. The route serializes the
 *   service's thrown `Error.message` verbatim, and the panel renders it as the
 *   error line, so it too must match the screen.
 *
 * The browser face keeps its own dictionaries in `client/locales.ts`: the two
 * sets are disjoint by construction — this one is text the host authors, that
 * one is text the browser authors — and only this file is reachable from the
 * host half. `ctx.dshellHostCopy` answers which language this text should be
 * in (see the std contract).
 *
 * Text a tool call returns (and the tool/prompt descriptions themselves) is
 * deliberately absent: that is the agent's interface, written once, not UI
 * copy. Keys for it would be localized for the wrong reader.
 */

import type { HostCopyDictionaries, HostCopyParams } from '@nexus-aethra/dshell-std'

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  // Settlement notice / summary state words. The protocol identifiers
  // (done/failed/…) stay identifiers; these are only their display words.
  'state.done': '已完成',
  'state.failed': '已失败',
  'state.timeout': '已超时',
  'state.cancelled': '已被取消',
  // A non-terminal ticket at settlement time (queued/running).
  'state.ended': '已结束',
  // The summary row's shorter form of the same non-terminal state.
  'state.end': '结束',

  'rights.read': '读',
  'rights.write': '写',
  'rights.none': '无',

  'notice.subject': '主题：{subject}',

  'notice.request.head': '【管道请求】会话「{from}」把一件事委派给你（ticket {id}）。',
  'notice.request.detailLabel': '说明：',
  'notice.request.mappingIntro': '为完成它，对方把下面的位置映射进了你们的缓冲区——这就是你访问它们的方式（先 action="ls" 看结构）：',
  'notice.request.mappingLine': '- /{as} ← {path}（{rights}）',
  'notice.request.grantNote': '  用途说明：{description}',
  'notice.request.paths': '缓冲路径以 / 为根，形如 /名字/子/文件；用 ls / read / edit / download / upload 操作它。',
  'notice.request.direction':
    '注意方向：动手的是持有授权的一方——要取走文件用 download（配上 dest，文件会复制到你自己的世界）；'
    + '要改动对方的文件用 edit；把你自己世界的文件送过去用 upload（需要对方给了写权限）。',
  'notice.request.progressHead': '处理进度与结论必须回报，不要静默放着：',
  'notice.request.claim': '- 认领：dshell_buffer action="claim" ticket_id="{id}"',
  'notice.request.progress': '- 进度：dshell_buffer action="progress" ticket_id="{id}" text="..."',
  'notice.request.finish': '- 成功：dshell_buffer action="finish" ticket_id="{id}" result="..."',
  'notice.request.fail': '- 失败：dshell_buffer action="fail" ticket_id="{id}" error="..."',
  'notice.request.watchdog': '若 {minutes} 分钟内没有任何结算，看门狗会把它判为超时并回报给请求方。',
  'notice.request.summary': '管道请求 · 来自 {from} · {subject}',

  'notice.settlement.head': '【管道回报】你委派给会话「{to}」的请求{state}（ticket {id}）。',
  'notice.settlement.resultLabel': '结果：',
  'notice.settlement.reason': '原因：{reason}',
  'notice.settlement.timeout': '对方没有在期限内回报。你可以重新委派、改用其他会话，或自己继续。',
  'notice.settlement.lastProgress': '对方最后一条进度：{text}',
  'notice.settlement.closing': '现在回到你原来的任务继续，不要重复已经完成的委派。',
  'notice.settlement.summary': '管道回报 · {to} · {state} · {subject}',

  // Route refusals reached from a panel action (the route serializes the
  // thrown `.message`): linking, unlinking, revoking, cancelling, browsing.
  'error.unknownAction': '未知操作',
  'error.linkSelf': '不能把会话连接到它自己',
  'error.linkExists': '这两个会话之间已经有管道了',
  'error.unknownLink': '没有这条管道：{id}',
  'error.notAnEndpoint': '只有管道的两端可以给它命名或写用途（{id}）',
  'error.notTerminal': '管道只连接 dshell 的终端会话：{id} 不是终端会话，不能接进来（对端是 {peer}）',
  'error.noLink': '没有这个管道：{id}',
  'error.noTicket': '没有这个 ticket：{id}',
  'error.grantNotOnLink': '授权不属于这条管道，或已被回收',
  'error.grantMissing': '这条缓冲路径已失效：对应的授权不存在',
  'error.grantMissingRight': '这条缓冲路径不含「{right}」权限',
  'error.granterUnavailable': '授权方会话不可用：{code}',
  'error.areaOutOfBounds': '{path}：越界',
  'error.areaRejected': '{path}：{reason}',
  'error.outOfScope': '这个位置不在受权的范围内（区域内路径 {path}）：{reasons}',
  'error.reasonSeparator': '；',
  'error.absolutePath': 'path 必须是相对于授权目录的路径，收到绝对路径：{path}',
} satisfies Record<string, string>

/** Host dictionary key union. */
export type DshellBufferHostKey = keyof typeof zh

/** A bound host translator: `ctx.dshellHostCopy.bind(hostCopy)`. */
export type DshellBufferHostTranslate =
  (key: DshellBufferHostKey, params?: HostCopyParams) => string

/** English dictionary, checked complete against the Chinese key set. */
export const en = {
  'state.done': 'completed',
  'state.failed': 'failed',
  'state.timeout': 'timed out',
  'state.cancelled': 'was cancelled',
  'state.ended': 'has ended',
  'state.end': 'ended',

  'rights.read': 'read',
  'rights.write': 'write',
  'rights.none': 'none',

  'notice.subject': 'Subject: {subject}',

  'notice.request.head': '[Pipe request] Session "{from}" has delegated a task to you (ticket {id}).',
  'notice.request.detailLabel': 'Details:',
  'notice.request.mappingIntro': 'To get it done, the other side has mapped the locations below into your shared buffer; this is how you reach them (run action="ls" first to see the structure):',
  'notice.request.mappingLine': '- /{as} ← {path} ({rights})',
  'notice.request.grantNote': '  Purpose: {description}',
  'notice.request.paths': 'Buffer paths are rooted at / and shaped like /name/sub/file; work on them with ls / read / edit / download / upload.',
  'notice.request.direction':
    'Mind the direction: the side holding the grant does the work. To take a file out use download '
    + '(with dest, the file is copied into your own world); to change the other side\'s file use edit; '
    + 'to send a file from your own world over use upload (the other side must have granted write access).',
  'notice.request.progressHead': 'Progress and outcome must be reported back, not left silent:',
  'notice.request.claim': '- Claim: dshell_buffer action="claim" ticket_id="{id}"',
  'notice.request.progress': '- Progress: dshell_buffer action="progress" ticket_id="{id}" text="..."',
  'notice.request.finish': '- Success: dshell_buffer action="finish" ticket_id="{id}" result="..."',
  'notice.request.fail': '- Failure: dshell_buffer action="fail" ticket_id="{id}" error="..."',
  'notice.request.watchdog': 'If nothing settles it within {minutes} minutes, the watchdog marks it as timed out and reports back to the requester.',
  'notice.request.summary': 'Pipe request · from {from} · {subject}',

  'notice.settlement.head': '[Pipe settlement] The request you delegated to session "{to}" {state} (ticket {id}).',
  'notice.settlement.resultLabel': 'Result:',
  'notice.settlement.reason': 'Reason: {reason}',
  'notice.settlement.timeout': 'The other side did not report back in time. You can delegate again, use another session, or carry on yourself.',
  'notice.settlement.lastProgress': "The other side's last progress note: {text}",
  'notice.settlement.closing': 'Now return to your original task and continue; do not repeat the delegation that already finished.',
  'notice.settlement.summary': 'Pipe settlement · {to} · {state} · {subject}',

  'error.unknownAction': 'Unknown action',
  'error.linkSelf': 'Cannot connect a session to itself',
  'error.linkExists': 'These two sessions are already connected',
  'error.unknownLink': 'No such pipe: {id}',
  'error.notAnEndpoint': 'Only the two ends of a pipe may name it or state its purpose ({id})',
  'error.notTerminal': 'Pipes connect dshell terminal sessions only: {id} is not one, so it cannot be wired (the other end is {peer})',
  'error.noLink': 'No such pipe: {id}',
  'error.noTicket': 'No such ticket: {id}',
  'error.grantNotOnLink': 'That grant does not belong to this pipe, or has already been revoked',
  'error.grantMissing': 'That buffer path is no longer valid: the grant does not exist',
  'error.grantMissingRight': 'That buffer path does not grant "{right}" access',
  'error.granterUnavailable': 'The granting session is unavailable: {code}',
  'error.areaOutOfBounds': '{path}: outside the area',
  'error.areaRejected': '{path}: {reason}',
  'error.outOfScope': 'That location is outside the granted scope (area-relative path {path}): {reasons}',
  'error.reasonSeparator': '; ',
  'error.absolutePath': 'path must be relative to the granted directory; received an absolute path: {path}',
} satisfies Record<DshellBufferHostKey, string>

/** The pair `ctx.dshellHostCopy.bind()` takes. */
export const hostCopy: HostCopyDictionaries<DshellBufferHostKey> = { zh, en }
