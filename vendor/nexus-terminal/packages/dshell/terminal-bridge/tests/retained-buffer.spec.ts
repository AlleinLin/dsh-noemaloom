/**
 * The retained PTY buffer must stay bounded under every shape of output.
 *
 * The previous incremental trim had two holes: a single line with no newline
 * that grew past the byte cap was never cut at all (the line-drop helper
 * found no boundary and returned), and a buffer that crossed the cap was
 * trimmed one line at a time, re-copying the whole 4 MB on each iteration.
 * These tests exercise the pure seam directly, including the byte-accurate
 * counters the caller re-bases itself on.
 */

import { describe, expect, it } from 'vitest'
import { trimRetainedText } from '../src/pty.js'

const MAX_BYTES = 4 * 1024 * 1024
const MAX_LINES = 10_000

/** Self-check: the result's counters describe EXACTLY the text it returned. */
function expectConsistent(result: ReturnType<typeof trimRetainedText>): void {
  expect(result.bytes).toBe(Buffer.byteLength(result.text))
  expect(result.lines).toBe(result.text.split('\n').length)
}

describe('trimRetainedText', () => {
  it('leaves a buffer that is inside both caps untouched', () => {
    const text = 'first\nsecond\nthird'
    const result = trimRetainedText(text)
    expect(result.text).toBe(text)
    expect(result.truncated).toBe(false)
    expectConsistent(result)
  })

  it('cuts a buffer with too many lines back to the low-water mark', () => {
    const text = Array.from({ length: MAX_LINES + 500 }, (_, i) => 'line-' + i).join('\n')
    const result = trimRetainedText(text)
    expect(result.truncated).toBe(true)
    // Half the cap, not exactly the cap: the next chunk must not immediately
    // trigger another full scan.
    expect(result.lines).toBeLessThanOrEqual(Math.floor(MAX_LINES / 2))
    expect(result.lines).toBeGreaterThan(0)
    expect(result.text.startsWith('line-')).toBe(true)
    expectConsistent(result)
  })

  it('cuts a buffer that is over the byte cap', () => {
    const line = 'x'.repeat(1024)
    const text = Array.from({ length: 6000 }, () => line).join('\n')
    expect(Buffer.byteLength(text)).toBeGreaterThan(MAX_BYTES)
    const result = trimRetainedText(text)
    expect(result.truncated).toBe(true)
    expect(result.bytes).toBeLessThanOrEqual(MAX_BYTES)
    expect(result.bytes).toBeLessThanOrEqual(Math.floor(MAX_BYTES / 2) + 2048)
    expectConsistent(result)
  })

  it('BOUNDS one giant line with no newline (the regression)', () => {
    // The old incremental trim could not drop anything here: no newline
    // means no line boundary, so the buffer grew forever. This is the shape
    // a shell printing a progress bar or a base64 blob produces.
    const text = 'x'.repeat(MAX_BYTES + 1024 * 1024)
    const result = trimRetainedText(text)
    expect(result.truncated).toBe(true)
    expect(result.bytes).toBeLessThan(MAX_BYTES)
    expect(result.bytes).toBeLessThanOrEqual(Math.floor(MAX_BYTES / 2) + 8)
    expect(result.lines).toBe(1)
    expectConsistent(result)
  })

  it('cuts multi-byte UTF-8 text on a character boundary', () => {
    // A cut in the middle of a surrogate pair would produce a lone half and
    // corrupt the snapshot that the terminal renderer reads.
    const emoji = '\u{1F600}'
    const text = emoji.repeat(MAX_BYTES / 4 + 100_000)
    expect(Buffer.byteLength(text)).toBeGreaterThan(MAX_BYTES)
    const result = trimRetainedText(text)
    expect(result.truncated).toBe(true)
    expect(result.bytes).toBeLessThan(MAX_BYTES)
    expect(result.text.includes('\uFFFD')).toBe(false)
    // Every remaining unit is a complete surrogate pair.
    expect([...result.text].every(ch => ch === emoji)).toBe(true)
    expectConsistent(result)
  })

  it('is idempotent once the buffer is back under the caps', () => {
    const text = Array.from({ length: MAX_LINES + 1 }, (_, i) => 'l' + i).join('\n')
    const once = trimRetainedText(text)
    const twice = trimRetainedText(once.text)
    expect(twice.text).toBe(once.text)
    expect(twice.truncated).toBe(false)
    expectConsistent(twice)
  })
})
