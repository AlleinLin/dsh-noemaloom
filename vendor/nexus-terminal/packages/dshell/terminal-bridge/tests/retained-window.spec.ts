import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PtyBuffer } from '../src/buffer.js'

/**
 * The retained window is the scrollback the canvas restores from, so what it
 * keeps is a contract: the NEWEST lines, within both caps.
 *
 * The trim used to measure the window by splitting it on every append and
 * dropping one line at a time, which is quadratic in the session's own output.
 * The count is now incremental and the cut goes to a low-water mark in one
 * pass; these specs pin what that cut keeps.
 */
describe('the retained window', () => {
  it('keeps the newest lines and stays within both caps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshell-window-'))
    try {
      const path = join(dir, 'pty.log')
      const buffer = await PtyBuffer.open(path, {
        windowMaxBytes: 1024,
        windowMaxLines: 20,
        seedMaxBytes: 64 * 1024,
        flushIntervalMs: 150,
        timelineSaveDelayMs: 500,
      })
      for (let index = 0; index < 200; index += 1) {
        buffer.append(`line-${String(index)}\n`)
      }
      const text = buffer.text()
      const lines = text.split('\n').filter(line => line.length > 0)
      expect(lines.length).toBeLessThanOrEqual(20)
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024)
      // The NEWEST line survives: a trim that dropped the wrong end would
      // leave the reader looking at a session's first commands.
      expect(lines.at(-1)).toBe('line-199')
      await buffer.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the newest content when the byte cap is the one crossed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshell-window-'))
    try {
      const path = join(dir, 'pty.log')
      const buffer = await PtyBuffer.open(path, {
        windowMaxBytes: 512,
        windowMaxLines: 10_000,
        seedMaxBytes: 64 * 1024,
        flushIntervalMs: 150,
        timelineSaveDelayMs: 500,
      })
      // A few very long lines: the LINE cap is never crossed, so only the
      // byte cap can trim this window.
      for (let index = 0; index < 20; index += 1) {
        buffer.append(`${'x'.repeat(100)}-${String(index)}\n`)
      }
      const text = buffer.text()
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512)
      expect(text).toContain('-19')
      await buffer.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the timeline in step with the window it describes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshell-window-'))
    try {
      const path = join(dir, 'pty.log')
      const buffer = await PtyBuffer.open(path, {
        windowMaxBytes: 1024,
        windowMaxLines: 20,
        seedMaxBytes: 64 * 1024,
        flushIntervalMs: 150,
        timelineSaveDelayMs: 500,
      })
      for (let index = 0; index < 200; index += 1) {
        buffer.append(`line-${String(index)}\n`)
      }
      // The timeline accounts for exactly the characters the window holds:
      // a mismatch would time the scrollback by the wrong frame.
      const accounted = buffer.timelineEntries().reduce((sum, entry) => sum + entry.n, 0)
      expect(accounted).toBe(buffer.text().length)
      await buffer.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
