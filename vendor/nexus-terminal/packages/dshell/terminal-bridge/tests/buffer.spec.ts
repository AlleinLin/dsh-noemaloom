import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { PtyBuffer } from '../src/buffer.js'

describe('PtyBuffer log reset', () => {
  it('empties the log without failing (Windows append handles cannot ftruncate)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshell-buffer-'))
    try {
      const path = join(dir, 'pty.log')
      const buffer = await PtyBuffer.open(path)
      buffer.append('old scrollback\n')
      await buffer.flush()
      expect((await stat(path)).size).toBeGreaterThan(0)

      // The regression this guards: the log's handle is opened in append
      // mode, and on Windows such a handle carries only FILE_APPEND_DATA,
      // so SetEndOfFile failed there with EPERM — and that rejection took
      // the whole desktop host down with it.
      await expect(buffer.truncate()).resolves.toBeUndefined()

      expect((await stat(path)).size).toBe(0)
      await buffer.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps appending at the end of the emptied log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshell-buffer-'))
    try {
      const path = join(dir, 'pty.log')
      const buffer = await PtyBuffer.open(path)
      buffer.append('old\n')
      await buffer.flush()
      await buffer.truncate()
      buffer.append('new\n')
      await buffer.flush()
      expect(await readFile(path, 'utf8')).toBe('new\n')
      await buffer.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('drops the text that was still pending when the reset ran', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshell-buffer-'))
    try {
      const path = join(dir, 'pty.log')
      const buffer = await PtyBuffer.open(path)
      // Never flushed: the reset has to discard it, not write it and then
      // leave it behind.
      buffer.append('stale\n')
      await buffer.truncate()
      await buffer.flush()
      expect(await readFile(path, 'utf8')).toBe('')
      expect(buffer.text()).toBe('')
      await buffer.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('resolves even when the log cannot be zeroed', async () => {
    // The host treats an unhandled rejection as fatal, so a log that
    // refuses to be reset must still leave the caller with a resolved
    // promise.
    const dir = await mkdtemp(join(tmpdir(), 'dshell-buffer-'))
    try {
      const path = join(dir, 'pty.log')
      const buffer = await PtyBuffer.open(path)
      buffer.append('text\n')
      await buffer.flush()
      // The log disappears from under the buffer. On Windows the unlink is
      // refused (the file is open), so the log is still there and the
      // reset simply succeeds — either way the caller must not see a
      // rejection.
      await rm(path, { force: true }).catch(() => { /* Windows refuses to unlink an open file */ })
      await expect(buffer.truncate()).resolves.toBeUndefined()
      await buffer.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes each pending batch once when flushes overlap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshell-buffer-'))
    try {
      const path = join(dir, 'pty.log')
      const buffer = await PtyBuffer.open(path)
      buffer.append('once\n')
      await Promise.all([buffer.flush(), buffer.flush()])
      expect(await readFile(path, 'utf8')).toBe('once\n')
      await buffer.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
