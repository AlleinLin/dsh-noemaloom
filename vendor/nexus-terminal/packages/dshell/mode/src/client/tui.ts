/**
 * The reader's own answer to "give this program the whole surface".
 *
 * The host reads the terminal and says what is on it; this is the one place a
 * human overrules it. The overrule is needed because the reading can be wrong
 * in both directions — a program that drives the screen without ever hiding
 * the cursor is missed, and one that shares a name with a long build is not —
 * and because a reader who can see the program is better informed than any
 * reading of `/proc`.
 *
 * A choice is kept against the program it was made about, not against the
 * session. That is what keeps it from becoming a mode: the next program starts
 * from the host's reading again, so "this one is a TUI, that one is not" costs
 * nothing to express and nothing to undo.
 */

import type { TuiReading } from '@nexus-aethra/dshell-terminal-bridge/client'

/** One reader's decision, made about one program. */
export interface TuiChoice {
  /** The program that was on the terminal when the decision was made. */
  readonly program: string | null
  /** Whether that program was given the whole surface. */
  readonly full: boolean
}

/**
 * Whether the surface belongs to a full-screen program right now.
 * @param reading - the host's reading, or undefined before one has arrived.
 * @param choice - the reader's decision, if they have made one.
 * @returns whether the program gets the whole surface.
 */
export function tuiFullScreen(
  reading: TuiReading | undefined,
  choice: TuiChoice | undefined,
): boolean {
  if (choice !== undefined && choice.program === (reading?.program ?? null)) return choice.full
  return reading?.active === true
}

/**
 * The choice that flips what the reader is looking at.
 *
 * Written as a function of what is on screen rather than of the previous
 * choice: with the host reading `active` and the reader having said nothing,
 * the first click must turn the surface OFF, not on — the two states are not
 * "unset" and "set", they are what the reader sees now and its opposite.
 * @param reading - the host's reading.
 * @param choice - the reader's current decision.
 * @returns the decision the next click should record.
 */
export function toggledChoice(
  reading: TuiReading | undefined,
  choice: TuiChoice | undefined,
): TuiChoice {
  return {
    program: reading?.program ?? null,
    full: !tuiFullScreen(reading, choice),
  }
}
