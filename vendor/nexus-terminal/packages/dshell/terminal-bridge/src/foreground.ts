/**
 * What is on the session's terminal, and whether it is drawing a full screen.
 *
 * Two signals, because neither one is complete on its own:
 *
 * - **The foreground process group.** A PTY's foreground group is the exact
 *   answer to "has something other than the shell taken this terminal", and it
 *   is read from `/proc/<pid>/stat`: a group other than the shell's own means a
 *   program is in charge. It catches the full-screen apps that never switch
 *   buffers — `minimax-code` is one — which the alternate screen cannot see.
 * - **The alternate screen.** `ESC[?1049h` / `ESC[?1049l` is the classic
 *   full-screen signal, and it is the only one that answers on a platform where
 *   the foreground cannot be read at all.
 *
 * The foreground alone is too eager to be a trigger: `sleep 30` and a long
 * build are both foreground programs, and neither should cost the reader their
 * timeline. So a foreground program counts only once it has shown that it is
 * PAINTING the screen rather than merely writing to it — hiding the cursor,
 * opening a synchronized update, or turning on mouse reporting. `vim` passes on
 * the alternate screen instead; `npm install` passes on neither.
 *
 * Both readings come from `/proc`, so this is Linux's answer. Elsewhere the
 * read fails, the foreground stays unknown, and the alternate screen carries
 * the feature alone.
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

/**
 * How often the foreground is re-read.
 *
 * Entry does not wait for this — a chunk that proves a program is painting
 * reads `/proc` on the spot (see `ForegroundState.probing`). What the interval
 * bounds is how long the reader stays in TUI mode after the program ends, so it
 * is short enough that quitting a full-screen app feels like it happened.
 */
export const FOREGROUND_POLL_MS = 300

/** Alternate-screen enter/leave, as the bytes arrive. */
const ALT_ENTER = '\u001b[?1049h'
const ALT_LEAVE = '\u001b[?1049l'

/**
 * The name a foreground group is reported under when it could not be read.
 *
 * A group whose `cmdline` will not open is one that is dying or not yet
 * started, so this is not the same answer as "no program" — see
 * `ForegroundState.setProgram` for what it deliberately does not do.
 */
const UNNAMED = '?'

/**
 * The sequences that say a program is painting the screen rather than writing
 * lines to it. Any one of them is enough to call a foreground program a TUI.
 */
const SCREEN_CONTROL = [
  '\u001b[?25l', // hide the cursor
  '\u001b[?2026h', // begin a synchronized update
  '\u001b[?1000h', // mouse reporting
  '\u001b[?1002h',
  '\u001b[?1003h',
  '\u001b[?1006h',
] as const

/** Every sequence this module watches for, in one list. */
const WATCHED: readonly string[] = [ALT_ENTER, ALT_LEAVE, ...SCREEN_CONTROL]

/**
 * The tail of `text` that could still turn into one of {@link WATCHED}.
 *
 * Only an INCOMPLETE sequence is carried into the next chunk — never a fixed
 * number of trailing characters. The difference is not tidiness: a blind tail
 * re-presents the previous chunk's bytes to the match, so a `?25l` that has
 * already been counted arms the latch a second time after a new program
 * cleared it, and the plain command that follows a TUI is handed the surface
 * the TUI earned. Which is the exact false positive the clearing exists to
 * prevent.
 *
 * @param text - the combined carry and chunk just scanned.
 * @returns the longest suffix that is a proper prefix of a watched sequence.
 */
function pendingTail(text: string): string {
  const longest = WATCHED.reduce((most, sequence) => Math.max(most, sequence.length), 0)
  const from = Math.max(0, text.length - longest + 1)
  for (let at = from; at < text.length; at += 1) {
    const tail = text.slice(at)
    if (WATCHED.some(sequence => sequence.length > tail.length && sequence.startsWith(tail))) return tail
  }
  return ''
}

/** What the terminal looks like right now, as the browser needs it. */
export interface ForegroundSnapshot {
  /** The program holding the foreground, or null when the shell itself does. */
  readonly program: string | null
  /** Whether the alternate screen is in use. */
  readonly alt: boolean
  /** Whether a full-screen program should be given the whole surface. */
  readonly active: boolean
}

/**
 * The process-group ids out of one `/proc/<pid>/stat` line.
 *
 * The offsets are the whole point of this being a function: `comm` is
 * parenthesised and may itself contain spaces AND parentheses (a process can
 * name itself `(x) y`), so the numeric fields start after the LAST `)` — which
 * puts `pgrp` at 2 and `tpgid` at 5 of what remains.
 * @param stat - the file's contents.
 * @returns the two group ids, or undefined when the line is not one.
 */
export function terminalOwnerOf(stat: string): { pgid: number; tpgid: number } | undefined {
  const close = stat.lastIndexOf(')')
  if (close === -1) return undefined
  const fields = stat.slice(close + 2).split(' ')
  const pgid = Number.parseInt(fields[2] ?? '', 10)
  const tpgid = Number.parseInt(fields[5] ?? '', 10)
  if (!Number.isFinite(pgid) || !Number.isFinite(tpgid)) return undefined
  return { pgid, tpgid }
}

/**
 * The program holding `pid`'s terminal, or null when the shell still owns it.
 *
 * `undefined` means the question cannot be answered here — no `/proc`, or the
 * shell is gone — and is deliberately not the same answer as `null`: a caller
 * that treats "cannot tell" as "nothing is running" would drop out of TUI mode
 * on the first read failure of a platform this does not support.
 *
 * @param pid - the PTY's child process, whose controlling terminal this is.
 * @returns the foreground program's name, null, or undefined.
 */
export function foregroundProgram(pid: number): string | null | undefined {
  let stat: string
  try {
    stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
  } catch {
    return undefined
  }
  const owner = terminalOwnerOf(stat)
  if (owner === undefined) return undefined
  if (owner.tpgid === owner.pgid) return null
  try {
    const argv = readFileSync(`/proc/${String(owner.tpgid)}/cmdline`, 'utf8')
    const first = argv.split('\u0000')[0] ?? ''
    // A program is free to rewrite its own argv (the full-screen apps do), so
    // this is a label for the reader, never a key anything is matched on.
    return first === '' ? UNNAMED : basename(first)
  } catch {
    // The group died between the two reads. It is gone, so "nothing owns it"
    // is the honest reading; the next poll corrects it if it is not.
    return null
  }
}

/**
 * One session's live answer to "is a full-screen program on the terminal".
 *
 * Held as state rather than recomputed because the two signals arrive on
 * different clocks — the foreground from a poll, the alternate screen from the
 * output stream — and the trigger is a conjunction of them.
 */
export class ForegroundState {
  private carry = ''
  private alt = false
  private control = false
  private program: string | null = null
  private reported: ForegroundSnapshot = { program: null, alt: false, active: false }

  /** The current reading. */
  get snapshot(): ForegroundSnapshot {
    return this.reported
  }

  /**
   * Whether a chunk has just shown a program painting the screen while the
   * program behind it is still unknown — the one moment worth reading `/proc`
   * on the spot instead of waiting for the poll.
   *
   * The poll leaves a window as wide as its interval, and the first chunk of a
   * full-screen program is the largest one it will ever send. That chunk is
   * exactly the chunk that must not enter the timeline, so the boundary is
   * settled by reading the foreground the moment there is anything to ask
   * about, rather than as soon as the poll happens to come round.
   */
  get probing(): boolean {
    return this.control && this.program === null
  }

  /** Whether a full-screen program should be given the whole surface. */
  private get active(): boolean {
    return this.alt || (this.program !== null && this.control)
  }

  /**
   * Fold one output chunk.
   * @param chunk - the PTY bytes as they arrived.
   * @returns whether the reading a reader would act on has changed.
   */
  feed(chunk: string): boolean {
    const text = this.carry + chunk
    const entered = text.lastIndexOf(ALT_ENTER)
    const left = text.lastIndexOf(ALT_LEAVE)
    if (entered !== -1 || left !== -1) this.alt = entered > left
    if (!this.control && SCREEN_CONTROL.some(sequence => text.includes(sequence))) {
      this.control = true
    }
    this.carry = pendingTail(text)
    return this.settle()
  }

  /**
   * Fold one foreground reading, as the poll found it.
   * @param program - the foreground program's name, or null for the shell.
   * @returns whether the reading a reader would act on has changed.
   */
  setProgram(program: string | null): boolean {
    if (program === this.program) {
      // An unchanged reading still settles an episode: the shell owning the
      // terminal again drops the cursor evidence with it, so the next program
      // proves itself rather than inheriting what this one did.
      if (program === null) this.control = false
      return false
    }
    // Each NAMED program has to prove itself, so a command that inherits a
    // TUI's hidden cursor cannot claim the surface the TUI earned. The reset
    // deliberately does not fire for an unnamed reading, or for a name
    // arriving where there was none: those are the same foreground group this
    // side already knew about — its `cmdline` is gone because it is dying, or
    // was not written yet because it is starting — and taking a running
    // program's surface away over a name is the one mistake that costs the
    // reader their screen.
    const replaced = this.program !== null && this.program !== UNNAMED
      && program !== null && program !== UNNAMED
    if (program === null || replaced) this.control = false
    this.program = program
    return this.settle()
  }

  /** Publish a new reading when the answer changed, and say whether it did. */
  private settle(): boolean {
    const next: ForegroundSnapshot = {
      program: this.program,
      alt: this.alt,
      active: this.active,
    }
    const previous = this.reported
    if (next.program === previous.program && next.alt === previous.alt && next.active === previous.active) {
      return false
    }
    this.reported = next
    return true
  }
}

/**
 * Watch one shell's foreground until the returned disposer is called.
 *
 * Only changes are reported, and an unreadable `/proc` reports nothing at all
 * rather than reporting "nothing is running" every tick.
 * @param pid - the PTY's child process.
 * @param onChange - called with the foreground program's name, or null.
 * @param intervalMs - the poll interval.
 * @returns the disposer.
 */
export function watchForeground(
  pid: number,
  onChange: (program: string | null) => void,
  intervalMs: number = FOREGROUND_POLL_MS,
): () => void {
  let last: string | null | undefined
  const tick = (): void => {
    const program = foregroundProgram(pid)
    if (program === undefined || program === last) return
    last = program
    onChange(program)
  }
  const timer = setInterval(tick, intervalMs)
  return () => { clearInterval(timer) }
}
