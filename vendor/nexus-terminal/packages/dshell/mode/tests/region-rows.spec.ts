/**
 * The rows a shell region renders at — measured, not counted by newlines.
 *
 * Every fixture below is a slice of a real PTY log (the tencent device
 * session's, `$DSH_HOME/dshell-pty/session-5d18abc5-….log`), because the shapes
 * that matter here are the ones a live session produces: a respawn's banner,
 * the `clear` that follows it, and the OSC reports the bridge's own shell
 * integration emits around every prompt.
 *
 * The failure this pins down: a region is sized from its measured rows, so a
 * measurement that counts bytes the screen no longer holds renders a wall of
 * empty rows under the region's last line — one banner taller with every
 * reconnect.
 */

import { describe, expect, it } from 'vitest'
import { regionMetrics, renderedRows } from '../src/client/block-terminal.js'

/** Rows a region would render at `cols`, the way `createSpanTerminal` decides. */
function rowsAt(text: string, cols = 123): number {
  return renderedRows(regionMetrics(text), cols)
}

/** The five-prompt redraw cluster a respawn opens with (real bytes). */
const PROMPT_REDRAWS = '\r\u001b[K\rroot@VM-0-6-ubuntu:~# '.repeat(5)

/** The bridge's startup line, echoed by the shell on every respawn (real bytes). */
const INIT_ECHO = 'export DSHELL_PS1=\'\\u@\\h:\\w\\$ \'; export PS1="$DSHELL_PS1"; '
  + 'export PROMPT_COMMAND=\'printf "\\033]133;D;%s\\007" "$?"; PS1="$DSHELL_PS1"\'\r\nclear\r\n'
  + 'bash: /root/.acme.sh/acme.sh.env: No such file or directory\r\n'

/** What `clear` writes on this TERM: home, erase display, erase scrollback. */
const CLEAR = '\u001b[H\u001b[2J\u001b[3J'

/** The OSC reports the shell integration emits around a prompt (real bytes). */
const PROMPT_REPORT = '\u001b]133;D;0\u0007\u001b]3008;start=9b15e29d;user=root;hostname=VM-0-6-ubuntu;cwd=/root\u001b\\'

/** One respawn's banner, as the log keeps it. */
const RESPAWN_BANNER = `${PROMPT_REDRAWS}\r\n${INIT_ECHO}\u001b[?2004hroot@VM-0-6-ubuntu:~# `

describe('regionMetrics — the display that was erased is not height', () => {
  it('measures a plain region by its lines', () => {
    expect(rowsAt('one\ntwo\nthree\n')).toBe(3)
  })

  it('drops the rows a respawn banner printed before the clear', () => {
    // Three respawns' banners, then the clear, then what the reader can actually
    // see: one command's output and the prompt under it.
    const text = `${RESPAWN_BANNER}\r\n${RESPAWN_BANNER}\r\n${RESPAWN_BANNER}\r\n`
      + `${CLEAR}${PROMPT_REPORT}root@VM-0-6-ubuntu:~# docker ps\r\n`
      + 'CONTAINER ID   IMAGE   COMMAND\r\n'
      + '561cf83c132a   study   "/usr/local/bin/nexu…"\r\n'
      + `${PROMPT_REPORT}root@VM-0-6-ubuntu:~# `
    // Four rows of visible screen — not the eleven the byte log holds.
    expect(rowsAt(text)).toBe(4)
  })

  it('keeps a region whose clear is the FIRST thing in it', () => {
    // The respawn that opened the region: nothing before the clear is on screen,
    // and a region that renders one row per banner line is the whole bug.
    const text = `${PROMPT_REDRAWS}\r\n${INIT_ECHO}${CLEAR}root@VM-0-6-ubuntu:~# `
    expect(rowsAt(text)).toBe(1)
  })

  it('does not treat an erase of the SCROLLBACK as an erase of the display', () => {
    // `ESC[3J` throws away saved lines; the screen is untouched, so the rows
    // above it are still rows the reader sees.
    const text = `first\nsecond\nthird\n\u001b[3Jfourth\n`
    expect(rowsAt(text)).toBe(4)
  })

  it('forgets the wrap and redraw widths of the erased stretch too', () => {
    // A progress bar that stacked rows before the clear cannot widen the grid
    // afterwards: the width a region needs is the width of what it shows.
    const stacked = '\r'.repeat(1) + 'progress'.repeat(40) + '\r\n'
    const text = `${stacked}${CLEAR}short\r\n`
    const metrics = regionMetrics(text)
    expect(metrics.redrawCols).toBe(0)
    expect(renderedRows(metrics, 123)).toBe(1)
  })

  it('still counts the wraps of a long line after the clear', () => {
    // 300 cells at 123 columns is three rows, and that is what the region must
    // be tall: the erase changes which rows exist, not how wide they are.
    const text = `${CLEAR}${'x'.repeat(300)}\n`
    expect(rowsAt(text)).toBe(3)
  })

  it('keeps trimming the trailing blank rows a respawn echoes', () => {
    // The other half of the same complaint: readline's empty echo after the
    // startup line, and the blank the bridge's init ends with.
    expect(rowsAt(`done\r\n\r\n\r\n\r\n`)).toBe(1)
  })
})
