/**
 * The two messages the buffer delivers, and the bounded one-line accounts that
 * ride their transcript rows.
 *
 * These are the only text a model ever sees from this plugin, so they carry the
 * whole protocol: what is being asked, what it may touch, and — for the
 * requester — an explicit instruction to resume the work it interrupted. That
 * last line is the "return to the original task" guarantee made concrete: the
 * notice is not a status report, it is the message that reopens the turn.
 *
 * The text is HOST copy, and the transcript is the user's screen: the same
 * bytes are rendered as a collapsed row (see the summaries) and read by the
 * model, so their language follows the host copy the user's screen is in. The
 * translator is passed in (bound once from `ctx.dshellHostCopy` in the service)
 * rather than resolved here, because the language can change between calls.
 */

import { boundContextSummary } from '@deepseek-ai/dsh-llm'
import type { DshellBufferHostKey, DshellBufferHostTranslate } from './host-locales.js'
import type { BufferGrant, BufferTicket } from './protocol.js'

/**
 * Ticket-state identifier → dictionary key. The identifier stays a protocol
 * value; only the display word is localized, at call time.
 */
const TICKET_STATE_KEY: Record<Exclude<BufferTicket['state'], 'queued' | 'running'>, DshellBufferHostKey> = {
  done: 'state.done',
  failed: 'state.failed',
  timeout: 'state.timeout',
  cancelled: 'state.cancelled',
}

/** Build a short rights label over the bound translator. */
function makeRightsLabel(t: DshellBufferHostTranslate): (rights: readonly string[]) => string {
  return (rights) => {
    const parts: string[] = []
    if (rights.includes('read')) parts.push(t('rights.read'))
    if (rights.includes('write')) parts.push(t('rights.write'))
    return parts.length > 0 ? parts.join('/') : t('rights.none')
  }
}

/**
 * A readable handle for a session inside message text.
 *
 * The id fallback drops the `session-` prefix first: every id starts with it,
 * so a first-8 slice named every peer `session-`. What is left is the leading
 * part of the random component, which distinguishes peers.
 *
 * The cwd wrapper is left as written: both callers pass no cwd, so the branch
 * is unreachable, and changing the signature would reach into the tool's
 * (out-of-scope) agent-facing output.
 */
export function sessionLabel(sessionId: string, title: string | undefined, cwd: string | undefined): string {
  const name = title !== undefined && title.trim().length > 0
    ? title.trim()
    : sessionId.replace(/^session-/u, '').slice(0, 8) || sessionId.slice(0, 8)
  return cwd === undefined ? name : `${name}（${cwd}）`
}

/** Minutes a deadline is away, rounded up, for the worker's warning line. */
function minutesUntil(deadlineAt: number): number {
  return Math.max(1, Math.ceil((deadlineAt - Date.now()) / 60_000))
}

/**
 * The message a worker session receives when a request is delegated to it.
 *
 * @param t - the host translator, bound to the user's screen language.
 * @param ticket - the freshly created ticket.
 * @param from - the requester's display label.
 * @param grants - grants created or referenced by this ticket.
 * @returns the message text.
 */
export function renderRequestNotice(
  t: DshellBufferHostTranslate,
  ticket: BufferTicket,
  from: string,
  grants: readonly BufferGrant[],
): string {
  const rightsLabel = makeRightsLabel(t)
  const lines = [
    t('notice.request.head', { from, id: ticket.id }),
    '',
    t('notice.subject', { subject: ticket.subject }),
  ]
  if (ticket.detail !== undefined && ticket.detail.trim().length > 0) {
    lines.push('', t('notice.request.detailLabel'), ticket.detail.trim())
  }
  if (grants.length > 0) {
    lines.push('', t('notice.request.mappingIntro'))
    for (const grant of grants) {
      for (const area of grant.areas) {
        if (area.as !== undefined) {
          lines.push(t('notice.request.mappingLine', { as: area.as, path: area.path, rights: rightsLabel(area.rights) }))
        }
      }
      if (grant.description.trim().length > 0) {
        lines.push(t('notice.request.grantNote', { description: grant.description.trim() }))
      }
    }
    lines.push(t('notice.request.paths'), t('notice.request.direction'))
  }
  lines.push(
    '',
    t('notice.request.progressHead'),
    t('notice.request.claim', { id: ticket.id }),
    t('notice.request.progress', { id: ticket.id }),
    t('notice.request.finish', { id: ticket.id }),
    t('notice.request.fail', { id: ticket.id }),
    '',
    t('notice.request.watchdog', { minutes: minutesUntil(ticket.deadlineAt) }),
  )
  return lines.join('\n')
}

/**
 * The message the requester receives once a ticket settles — the wake that
 * reopens its turn. Delivered for every terminal state, including timeout and
 * cancellation, so the requester is never left waiting on something that
 * already ended.
 *
 * @param t - the host translator, bound to the user's screen language.
 * @param ticket - the settled ticket.
 * @param to - the worker's display label.
 * @returns the message text.
 */
export function renderSettlementNotice(t: DshellBufferHostTranslate, ticket: BufferTicket, to: string): string {
  const stateKey: DshellBufferHostKey = ticket.state === 'queued' || ticket.state === 'running'
    ? 'state.ended'
    : TICKET_STATE_KEY[ticket.state]
  const lines = [
    t('notice.settlement.head', { to, state: t(stateKey), id: ticket.id }),
    '',
    t('notice.subject', { subject: ticket.subject }),
  ]
  if (ticket.result !== undefined && ticket.result.trim().length > 0) {
    lines.push('', t('notice.settlement.resultLabel'), ticket.result.trim())
  }
  if (ticket.error !== undefined && ticket.error.trim().length > 0) {
    lines.push('', t('notice.settlement.reason', { reason: ticket.error.trim() }))
  }
  if (ticket.state === 'timeout') {
    lines.push('', t('notice.settlement.timeout'))
  }
  if (ticket.reports.length > 0) {
    const last = ticket.reports[ticket.reports.length - 1]
    lines.push('', t('notice.settlement.lastProgress', { text: last?.text ?? '' }))
  }
  lines.push('', t('notice.settlement.closing'))
  return lines.join('\n')
}

/** Bounded one-line account for a request notice's transcript row. */
export function requestSummary(t: DshellBufferHostTranslate, ticket: BufferTicket, from: string): string {
  return boundContextSummary(t('notice.request.summary', { from, subject: ticket.subject }))
}

/** Bounded one-line account for a settlement notice's transcript row. */
export function settlementSummary(t: DshellBufferHostTranslate, ticket: BufferTicket, to: string): string {
  const stateKey: DshellBufferHostKey = ticket.state === 'queued' || ticket.state === 'running'
    ? 'state.end'
    : TICKET_STATE_KEY[ticket.state]
  return boundContextSummary(t('notice.settlement.summary', { to, state: t(stateKey), subject: ticket.subject }))
}
