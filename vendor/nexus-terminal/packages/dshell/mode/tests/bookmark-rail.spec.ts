/**
 * What the turn rail's ladder is built from.
 *
 * One mark per agent turn, oldest first, each carrying the request's first
 * line and the first lines of the answer for the hover preview. The cases
 * that matter are the ones the fold actually produces: a slash-command turn
 * draws a marker line rather than a card, an aborted submission draws nothing
 * at all, and neither should put a mark on the ladder — a mark that points at
 * an empty conversation is worse than no mark.
 *
 * Escape sequences are stripped before the text is measured, because a preview
 * body is drawn from a screen capture and would otherwise spend its three
 * clamped lines on colour runs.
 */

import { describe, expect, it } from 'vitest'
import { bookmarksOf } from '../src/client/bookmark-rail.js'
import type { TurnBlock } from '../src/client/blocks.js'
import type { SessionRow, SessionRowRole } from '../src/client/session-rows.js'

/** A row as the fold keeps it; only the fields the labels read. */
function row(role: SessionRowRole, text: string): SessionRow {
  return { role, key: `${role}:${text}`, text, collapsible: false, defaultCollapsed: false, time: 0 }
}

/** A turn block with the labels' inputs overridden. */
function block(key: string, over: Partial<TurnBlock> = {}): TurnBlock {
  return {
    key, turn: undefined, title: '', status: 'done', rows: [], stream: undefined,
    startedAt: 0, steps: 0, tokens: 0, notice: undefined, seen: new Set(), ...over,
  }
}

describe('bookmarksOf', () => {
  it('marks every agent turn, oldest first, titled by the request', () => {
    const marks = bookmarksOf([
      block('a', { rows: [row('user', '第一条请求'), row('assistant', '收到')] }),
      block('b', { rows: [row('user', '第二条请求'), row('assistant', '好的')] }),
    ], '(空)')
    expect(marks.map(m => m.key)).toEqual(['a', 'b'])
    expect(marks.map(m => m.prompt)).toEqual(['第一条请求', '第二条请求'])
  })

  it('skips turns that draw no card: a slash command, and an empty abort', () => {
    const marks = bookmarksOf([
      block('cmd', { rows: [row('command', 'model'), row('command', 'pro')] }),
      block('aborted', { status: 'aborted' }),
      block('real', { rows: [row('user', '干活')] }),
    ], '(空)')
    expect(marks.map(m => m.key)).toEqual(['real'])
  })

  it('takes the answer from the assistant row, keeping its first three lines', () => {
    const marks = bookmarksOf([
      block('a', { rows: [row('user', '问'), row('assistant', '一\n\n二\n三\n四')] }),
    ], '(空)')
    expect(marks[0]?.response).toBe('一\n二\n三')
  })

  it('leaves the body empty when the turn has no answer yet', () => {
    const marks = bookmarksOf([block('a', { status: 'running', rows: [row('user', '问')] })], '(空)')
    expect(marks[0]?.response).toBe('')
    expect(marks[0]?.status).toBe('running')
  })

  it('falls back to the empty label when the request carries no text', () => {
    const marks = bookmarksOf([block('a', { rows: [row('assistant', '只有回答')] })], '(空消息)')
    expect(marks[0]?.prompt).toBe('(空消息)')
  })

  it('strips escape sequences before either label is measured', () => {
    const marks = bookmarksOf([
      block('a', { rows: [row('user', '\u001b[31m红色\u001b[0m请求'), row('assistant', '\u001b[1;32m绿\u001b[0m')] }),
    ], '(空)')
    expect(marks[0]?.prompt).toBe('红色请求')
    expect(marks[0]?.response).toBe('绿')
  })

  it('truncates a long label instead of letting the preview card size itself', () => {
    const long = 'x'.repeat(400)
    const marks = bookmarksOf([block('a', { rows: [row('user', long)] })], '(空)')
    expect(marks[0]?.prompt.endsWith('…')).toBe(true)
    expect((marks[0]?.prompt.length ?? 0)).toBeLessThan(long.length)
  })
})
