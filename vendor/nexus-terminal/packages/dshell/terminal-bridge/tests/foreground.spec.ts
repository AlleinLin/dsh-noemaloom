/**
 * The full-screen reading: when a program owns the terminal, and when the
 * surface should be handed to it.
 *
 * These are the rules that decide whether a reader keeps their timeline or
 * loses it to a program, so each one is here because getting it wrong is a
 * visible failure rather than a wrong number:
 *
 * - the field offsets, because `comm` may contain parentheses;
 * - the alternate screen across a chunk boundary, because a PTY read is not
 *   aligned to escape sequences;
 * - a foreground program being necessary but NOT sufficient, because
 *   `sleep 30` and `npm install` are foreground programs too;
 * - evidence not being inherited by the next command, because a TUI's hidden
 *   cursor would otherwise hand the surface to whatever runs next.
 *
 * The reading itself (`foregroundProgram`) needs a real PTY and is verified
 * against a live harness — see docs/dshell-architecture.md § 18.
 */

import { describe, expect, it } from 'vitest'
import { ForegroundState, terminalOwnerOf } from '../src/foreground.js'

/** One `/proc/<pid>/stat` line, in the kernel's own field order. */
function statLine(comm: string, pgid: number, tpgid: number): string {
  // pid, comm, state, ppid, pgrp, session, tty_nr, tpgid
  return `1234 (${comm}) S 1 ${String(pgid)} ${String(pgid)} 34816 ${String(tpgid)} 0 -1`
}

describe('terminalOwnerOf', () => {
  it('reads the group ids after the last closing parenthesis', () => {
    expect(terminalOwnerOf(statLine('bash', 100, 100))).toEqual({ pgid: 100, tpgid: 100 })
  })

  it('survives a comm that contains spaces and parentheses', () => {
    // A process may name itself anything, including a name that would move the
    // field boundary if the FIRST parenthesis were used.
    expect(terminalOwnerOf(statLine('(x) y', 100, 200))).toEqual({ pgid: 100, tpgid: 200 })
  })

  it('refuses a line it cannot read ids out of', () => {
    expect(terminalOwnerOf('not a stat line')).toBeUndefined()
    expect(terminalOwnerOf('1234 (bash) S 1 x y z')).toBeUndefined()
  })
})

describe('ForegroundState', () => {
  it('starts with nothing on screen', () => {
    expect(new ForegroundState().snapshot).toEqual({ program: null, alt: false, active: false })
  })

  it('hands the surface over on the alternate screen', () => {
    const state = new ForegroundState()
    expect(state.feed('\u001b[?1049h')).toBe(true)
    expect(state.snapshot).toEqual({ program: null, alt: true, active: true })
    expect(state.feed('vim\n')).toBe(false)
    expect(state.feed('\u001b[?1049l')).toBe(true)
    expect(state.snapshot.active).toBe(false)
  })

  it('recognises the alternate screen split across two chunks', () => {
    const state = new ForegroundState()
    expect(state.feed('text\u001b[?10')).toBe(false)
    expect(state.feed('49h more')).toBe(true)
    expect(state.snapshot.alt).toBe(true)
  })

  it('takes the LAST switch on one chunk as the answer', () => {
    const state = new ForegroundState()
    state.feed('\u001b[?1049h')
    expect(state.feed('\u001b[?1049l\u001b[?1049h')).toBe(false)
    expect(state.snapshot.alt).toBe(true)
  })

  it('does not hand the surface to a foreground program that only writes', () => {
    // `sleep 30` and `npm install` are foreground programs. Neither paints.
    const state = new ForegroundState()
    // The NAME is reported even when the surface is not handed over: it is what
    // the full-screen bar puts in front of the reader, and what a reader's own
    // decision is keyed to.
    expect(state.setProgram('sleep')).toBe(true)
    expect(state.snapshot).toEqual({ program: 'sleep', alt: false, active: false })
  })

  it('hands the surface to a foreground program that paints', () => {
    const state = new ForegroundState()
    state.setProgram('minimax-code')
    expect(state.feed('\u001b[?25l\u001b[?2026h')).toBe(true)
    expect(state.snapshot.active).toBe(true)
  })

  it('lets the next named program prove itself', () => {
    // Otherwise a command that follows a TUI inherits the TUI's hidden cursor.
    const state = new ForegroundState()
    state.setProgram('mcode')
    state.feed('\u001b[?25l')
    expect(state.snapshot.active).toBe(true)
    state.setProgram('sleep')
    expect(state.snapshot.active).toBe(false)
    // …and the TUI's own bytes must not arm the evidence again from the tail of
    // the chunk they arrived in. A blind carry did exactly that, handing the
    // surface to the command that came next.
    state.feed('tick\n')
    expect(state.snapshot.active).toBe(false)
    state.feed('\u001b[?25l\u001b[?2026h')
    expect(state.snapshot.active).toBe(true)
  })

  it('keeps the evidence when a name cannot be read', () => {
    // `?` is a dying or starting group, not a different program: dropping the
    // surface here would take a running program's screen away over a name.
    const state = new ForegroundState()
    state.setProgram('minimax-code')
    state.feed('\u001b[?25l')
    state.setProgram('?')
    expect(state.snapshot).toEqual({ program: '?', alt: false, active: true })
  })

  it('ends the episode when the shell takes the terminal back', () => {
    const state = new ForegroundState()
    state.setProgram('minimax-code')
    state.feed('\u001b[?25l')
    state.setProgram(null)
    expect(state.snapshot.active).toBe(false)
    // The evidence went with the episode: the same name returning later has to
    // paint again before it gets the surface.
    state.setProgram('minimax-code')
    expect(state.snapshot.active).toBe(false)
  })

  it('asks for a foreground read exactly while it cannot name what is painting', () => {
    const state = new ForegroundState()
    expect(state.probing).toBe(false)
    state.feed('\u001b[?25l')
    expect(state.probing).toBe(true)
    state.setProgram('minimax-code')
    expect(state.probing).toBe(false)
  })

  it('reports no change when nothing a reader would act on changed', () => {
    // The host broadcasts on this answer, so a busy shell must not produce a
    // frame per chunk.
    const state = new ForegroundState()
    state.setProgram('mcode')
    state.feed('\u001b[?25l')
    expect(state.feed('plain output\n')).toBe(false)
    expect(state.setProgram('mcode')).toBe(false)
  })
})
