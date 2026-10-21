import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { AgentBlock, buildSteps, segmentsOf } from '../src/client/agent-block.js'
import { emptyBlock } from '../src/client/blocks.js'
import { getTheme } from '../src/client/palettes.js'
import { WHALE_TAIL_PATH } from '../src/client/dsh-icons.js'
import { sessionRowsOf, type SessionRow, type SessionRowRole } from '../src/client/session-rows.js'

const t = ((key: string) => key) as TranslateNS<'dshellMode'>

function row(role: SessionRowRole, key: string, extra: Partial<SessionRow> = {}): SessionRow {
  return { role, key, text: key, time: 100, collapsible: false, defaultCollapsed: false, ...extra }
}

function assistant(seq: number, content: readonly unknown[]): readonly SessionRow[] {
  return sessionRowsOf({
    type: 'assistant/message', seq, time: seq * 100,
    data: { turn: 1, step: seq, message: { role: 'assistant', content } },
  } as SessionEventLike, new Map(), t)
}

const call = (id: string) => ({ type: 'tool-call', id, name: 'bash', arguments: JSON.stringify({ command: `echo ${id}` }) })

describe('agent transcript order', () => {
  it('keeps prose and tools interleaved within each human-message segment', () => {
    const input = [
      row('user', 'ask one'),
      row('assistant', 'first explanation'),
      row('call', 'call one', { callId: 'one' }),
      row('tool', 'result one', { callId: 'one' }),
      row('reasoning', 'thinking again'),
      row('call', 'call two', { callId: 'two' }),
      row('tool', 'result two', { callId: 'two' }),
      row('assistant', 'final answer'),
      row('user', 'ask two'),
      row('assistant', 'second answer'),
    ]
    const segments = segmentsOf(input)
    expect(segments).toHaveLength(2)
    expect(segments.filter(segment => segment.ask !== undefined).map(segment => ({
      ask: segment.ask?.key,
      rows: segment.rows.map(item => item.key),
    }))).toEqual([
      { ask: 'ask one', rows: ['first explanation', 'call one', 'result one', 'thinking again', 'call two', 'result two', 'final answer'] },
      { ask: 'ask two', rows: ['second answer'] },
    ])
  })

  it('keeps a result at its own position when the call is outside the loaded history', () => {
    const steps = buildSteps([
      row('assistant', 'before result'),
      row('tool', 'retained result', { callId: 'older-call', label: 'bash' }),
      row('assistant', 'after result'),
    ], 0, t)
    expect(steps.map(step => step.kind)).toEqual(['text', 'tool', 'text'])
    expect(steps[1]?.kind === 'tool' ? steps[1].output : undefined).toBe('retained result')
  })

  it('does not merge serial calls from different assistant messages', () => {
    const rows = [
      ...assistant(1, [call('one')]),
      row('tool', 'result one', { callId: 'one' }),
      ...assistant(2, [call('two')]),
      row('tool', 'result two', { callId: 'two' }),
    ]
    const steps = buildSteps(rows, 0, t)
    expect(steps.map(step => step.kind)).toEqual(['tool', 'tool'])
    expect(steps.map(step => step.kind === 'tool' ? step.output : undefined)).toEqual(['result one', 'result two'])
  })

  it('groups adjacent calls in one assistant batch and pairs reversed results by call id', () => {
    const rows = [
      ...assistant(1, [call('one'), call('two')]),
      row('tool', 'result two', { callId: 'two' }),
      row('tool', 'result one', { callId: 'one' }),
    ]
    const steps = buildSteps(rows, 0, t)
    expect(steps).toHaveLength(1)
    expect(steps[0]?.kind).toBe('group')
    if (steps[0]?.kind === 'group') {
      expect(steps[0].items.map(item => item.output)).toEqual(['result one', 'result two'])
    }
  })

  it('retains text between calls inside one assistant message', () => {
    const rows = assistant(1, [
      { type: 'text', text: 'before' }, call('one'),
      { type: 'text', text: 'between' }, call('two'),
      { type: 'text', text: 'after' },
    ])
    expect(rows.map(item => item.role)).toEqual(['assistant', 'call', 'assistant', 'call', 'assistant'])
    expect(rows.filter(item => item.role === 'assistant').map(item => item.text)).toEqual(['before', 'between', 'after'])
    expect(new Set(rows.map(item => item.key)).size).toBe(rows.length)
    expect(buildSteps(rows, 0, t).map(step => step.kind)).toEqual(['text', 'tool', 'text', 'tool', 'text'])
  })

  it('does not label a mixed tool batch as one kind of tool', () => {
    const rows = assistant(1, [call('one'), { ...call('two'), name: 'read_file' }])
    expect(buildSteps(rows, 0, t).map(step => step.kind)).toEqual(['tool', 'tool'])
  })

  it('keeps adjacent text fragments together without moving reasoning or images', () => {
    const attachment = { id: 'image one' }
    const rows = assistant(1, [
      { type: 'text', text: 'first ' }, { type: 'text', text: 'sentence' },
      { type: 'reasoning', text: 'thinking' },
      { type: 'image', attachment }, call('one'),
    ])
    expect(rows.map(item => item.role)).toEqual(['assistant', 'reasoning', 'assistant', 'call'])
    expect(rows[0]?.text).toBe('first sentence')
    expect(rows[2]?.images).toEqual([attachment])
  })

  it('pairs a late result across a steering message without moving either human message', () => {
    const rows = [
      row('user', 'original request'), ...assistant(1, [call('one')]),
      row('user', 'steering request'), row('tool', 'late result', { callId: 'one' }),
      row('assistant', 'response to steering'),
    ]
    const segments = segmentsOf(rows).filter(segment => segment.ask !== undefined)
    const steps = buildSteps(segments[0]?.rows ?? [], 0, t, rows)
    expect(steps[0]?.kind === 'tool' ? steps[0].output : undefined).toBe('late result')
    expect(segments.map(segment => segment.ask?.text)).toEqual(['original request', 'steering request'])
  })
})

describe('native task chrome', () => {
  it('keeps the request before the fold and all answers readable while collapsed', () => {
    const block = emptyBlock('task', 100, 'question')
    block.status = 'done'
    block.rows.push(
      row('user', 'question'), row('assistant', 'before'),
      row('call', 'one', { callId: 'one' }), row('tool', 'output one', { callId: 'one' }),
      row('assistant', 'between'), row('call', 'two', { callId: 'two' }),
      row('assistant', 'after'),
    )
    const html = renderToStaticMarkup(createElement(AgentBlock, { block, theme: getTheme('default', 'light'), loadImage: undefined, t }))
    expect(html.indexOf('question')).toBeLessThan(html.indexOf('data-dshell-fold'))
    expect(html.indexOf('before')).toBeLessThan(html.indexOf('between'))
    expect(html.indexOf('between')).toBeLessThan(html.indexOf('after'))
    expect(html.match(/data-dshell-step-kind="answer"/gu)).toHaveLength(3)
    expect(html).not.toContain('data-dshell-step-kind="tool"')
    expect(html).toContain('data-dshell-whale-tail')
    expect(html).not.toContain('data-dshell-whale-animated')
  })

  it('uses the official whale-tail shape and native shimmer while running', () => {
    const block = emptyBlock('task', 100, 'question')
    const html = renderToStaticMarkup(createElement(AgentBlock, { block, theme: getTheme('default', 'light'), loadImage: undefined, t }))
    expect(html).toContain('data-dshell-whale-animated')
    expect(html).toContain('data-shimmer="true"')
    expect(html).toContain(WHALE_TAIL_PATH)
    expect(html).not.toContain('23.16')
  })

  it('ships the exact native animated mask and static fallback path', () => {
    const native = readFileSync(new URL('../../../../dsh/packages/client/ui-chat/src/client/chat/running-whale@2x.png', import.meta.url))
    const bundled = readFileSync(new URL('../src/client/running-whale@2x.png', import.meta.url))
    expect(bundled).toEqual(native)
    expect(bundled.includes(Buffer.from('acTL'))).toBe(true)
    const source = readFileSync(new URL('../../../../dsh/packages/client/ui-chat/src/client/chat/RunningWhaleTail.tsx', import.meta.url), 'utf8')
    expect(source.match(/const REST_PATH = '([^']+)'/u)?.[1]).toBe(WHALE_TAIL_PATH)
  })
})
