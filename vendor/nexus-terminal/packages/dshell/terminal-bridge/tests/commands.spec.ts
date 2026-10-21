/**
 * The command splitter and the output window, checked where they can be checked.
 *
 * This was `scripts/check-commands.ts`, a `tsx` script that lived beside `src/`
 * and therefore outside the vitest glob: thirteen assertions that ran when
 * someone remembered to run them. The splitter is pure, so it belongs in
 * `pnpm test` — same assertions, same fixtures, a runner that fails the build
 * instead of printing a line nobody reads.
 *
 * What it covers: the OSC 133;D marker that pairs a typed command with its
 * output and exit code, the input edits that must not leak into the recorded
 * line, the ANSI/control stripping the model sees, the two truncation caps
 * (preview vs store), and `sliceWindow`'s cursor arithmetic.
 */

import { describe, expect, it } from 'vitest'
import {
  createSplitter, sanitizeTerminalText, sliceWindow, splitOutput, stripAnsi, trackInput,
} from '../src/commands.js'

const MARK = (code: number): string => `\u001b]133;D;${String(code)}\u0007`
const PROMPT = 'reader@host:~/x$ '
const CRLF = '\r\n'

describe('the command splitter', () => {
  it('pairs a typed command with its output and exit code', () => {
    const state = createSplitter()
    trackInput(state, 'ls -la\r')
    const records = splitOutput(state, `${PROMPT}ls -la${CRLF}total 0${CRLF}${MARK(0)}`, 1)
    expect(records.length).toBe(1)
    expect(records[0]!.command).toBe('ls -la')
    expect(records[0]!.exitCode).toBe(0)
    expect(records[0]!.output.trim()).toBe('total 0')
  })

  it('records a non-zero exit code', () => {
    const state = createSplitter()
    trackInput(state, 'false\r')
    const records = splitOutput(state, `${PROMPT}false${CRLF}${MARK(1)}`, 1)
    expect(records[0]!.exitCode).toBe(1)
    expect(records[0]!.command).toBe('false')
  })

  it('handles a marker split across chunks', () => {
    const state = createSplitter()
    trackInput(state, 'echo hi\r')
    const first = splitOutput(state, `${PROMPT}echo hi${CRLF}hi${CRLF}\u001b]133;D`, 1)
    expect(first.length).toBe(0)
    const second = splitOutput(state, `;0\u0007`, 2)
    expect(second.length).toBe(1)
    expect(second[0]!.exitCode).toBe(0)
    expect(second[0]!.output.trim()).toBe('hi')
  })

  it('tracks backspace, Ctrl+C and Ctrl+U edits', () => {
    const state = createSplitter()
    trackInput(state, 'lss\u007f\r') // "lss" then backspace -> "ls"
    trackInput(state, 'ignored\u0003') // Ctrl+C abandons
    trackInput(state, 'also ignored\u0015') // Ctrl+U abandons
    trackInput(state, 'pwd\r')
    const records = splitOutput(
      state,
      `${PROMPT}ls${CRLF}${MARK(0)}${PROMPT}${MARK(0)}${PROMPT}pwd${CRLF}/tmp${CRLF}${MARK(0)}`,
      1,
    )
    expect(records.map(r => r.command)).toEqual(['ls', 'pwd'])
  })

  it('ignores ANSI/CSI input sequences (arrows do not leak into the line)', () => {
    const state = createSplitter()
    trackInput(state, '\u001b[A\u001b[Cgit status\r') // up, right, then text
    const records = splitOutput(state, `${PROMPT}git status${CRLF}${MARK(0)}`, 1)
    expect(records[0]!.command).toBe('git status')
  })

  it('an untracked command still yields a record with its output', () => {
    const state = createSplitter()
    // No trackInput: the shell printed a prompt and a command we never saw
    // (history recall, a marker-only shell, an external writer).
    const records = splitOutput(state, `${PROMPT}mystery${CRLF}answer${CRLF}${MARK(0)}`, 1)
    expect(records.length).toBe(1)
    expect(records[0]!.command).toBe('')
    expect(records[0]!.output.trim()).toBe('answer')
  })

  it('two commands in one chunk keep their own outputs', () => {
    const state = createSplitter()
    trackInput(state, 'a\r')
    trackInput(state, 'b\r')
    const records = splitOutput(
      state,
      `${PROMPT}a${CRLF}out-a${CRLF}${MARK(0)}${PROMPT}b${CRLF}out-b${CRLF}${MARK(2)}`,
      1,
    )
    expect(records.map(r => r.command)).toEqual(['a', 'b'])
    expect(records.map(r => r.output.trim())).toEqual(['out-a', 'out-b'])
    expect(records.map(r => r.exitCode)).toEqual([0, 2])
  })

  it('truncates oversized output with an explicit marker', () => {
    const state = createSplitter()
    const huge = 'x'.repeat(20 * 1024)
    trackInput(state, 'cat big\r')
    const records = splitOutput(state, `${PROMPT}cat big${CRLF}${huge}${CRLF}${MARK(0)}`, 1)
    expect(records[0]!.output).toMatch(/省略/)
  })

  it('keeps a longer tail for the store than for the preview', () => {
    // Past the preview cap (16 KiB) but inside the store cap (64 KiB): the preview
    // is truncated while the stored form is whole, and the counts say so.
    const state = createSplitter()
    const body = 'y'.repeat(20 * 1024)
    trackInput(state, 'cat wide\r')
    const record = splitOutput(state, `${PROMPT}cat wide${CRLF}${body}${CRLF}${MARK(0)}`, 1)[0]!
    expect(record.output).toMatch(/省略/)
    expect(record.stored!.dropped).toBe(0)
    expect(record.stored!.text.trimEnd().endsWith('y'.repeat(100))).toBe(true)
    expect(record.stored!.bytes > 20 * 1024).toBe(true)

    // Past the store cap too: the stored text is the tail and reports its front.
    const state2 = createSplitter()
    const huge = 'z'.repeat(80 * 1024)
    trackInput(state2, 'cat huge\r')
    const stored = splitOutput(state2, `${PROMPT}cat huge${CRLF}${huge}${CRLF}${MARK(0)}`, 1)[0]!.stored!
    expect(stored.dropped > 0).toBe(true)
    expect(Buffer.byteLength(stored.text, 'utf8') <= 64 * 1024).toBe(true)
  })
})

describe('the terminal text the model sees', () => {
  it('strips OSC markers and control sequences', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red')
    expect(stripAnsi('\u001b]0;title\u0007body')).toBe('body')
    expect(sanitizeTerminalText(`${PROMPT}ls${CRLF}${MARK(0)}`)).toBe(`${PROMPT}ls\n`)
    expect(sanitizeTerminalText('a\r\nb\rc')).toBe('a\nbc')
  })
})

describe('sliceWindow', () => {
  it('returns only what the cursor has not seen', () => {
    const full = 'aaa\nbbb\nccc\n'
    const abs = Buffer.byteLength(full, 'utf8')
    const first = sliceWindow(full, abs, 0)
    expect(first.text).toBe(full)
    expect(first.dropped).toBe(false)
    const cursor = Buffer.byteLength('aaa\nbbb\n', 'utf8')
    const rest = sliceWindow(full, abs, cursor)
    expect(rest.text).toBe('ccc\n')
    expect(rest.dropped).toBe(false)
    // Re-reading the same cursor is empty: no duplication across turns.
    expect(sliceWindow(full, abs, abs).text).toBe('')
  })

  it('flags an offset that fell out of the retained window', () => {
    const windowText = 'ccc\nddd\n' // aaa/bbb already dropped from memory
    const abs = 20
    const slice = sliceWindow(windowText, abs, 4) // window starts at 20 - 8 = 12
    expect(slice.dropped).toBe(true)
    expect(slice.text).toBe(windowText)
    expect(slice.start).toBe(12)
  })

  it('clamps an offset past the end', () => {
    const slice = sliceWindow('abc', 3, 99)
    expect(slice.dropped).toBe(true)
    expect(slice.text).toBe('')
    expect(slice.start).toBe(3)
  })
})
