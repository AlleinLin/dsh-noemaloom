/**
 * Reading the shell's own report of where it stands, out of the PTY stream.
 *
 * Every fixture below is a slice of a REAL log (`$DSH_HOME/dshell-pty/*.log`) or
 * a faithful fragment of one, because what matters here is not that the parser
 * handles a shape this file invented, but that it reads the bytes dsh's shell
 * integration actually writes — including the two ways the value can arrive
 * split across chunks, which is how a stream arrives.
 */

import { describe, expect, it } from 'vitest'
import { shellReportCwd } from '../src/client/shell-report.js'

/** The report as dsh's integration writes it: BEL closes 133;D, ST closes 3008. */
const DEVICE_REPORT = '\u001b]133;D;0\u0007\u001b]3008;start=9b15e29d;user=root;hostname=VM-0-6-ubuntu;cwd=/root\u001b\\'

describe('reading the shell\'s reported directory', () => {
  it('reads the cwd out of a device session\'s prompt report', () => {
    expect(shellReportCwd(DEVICE_REPORT)).toBe('/root')
  })

  it('reads a local session\'s report, and the last one when a chunk holds several', () => {
    const local = '\u001b]3008;start=abc;user=reader;hostname=box;cwd=/home/reader/nexus/Nexus-Shell\u001b\\'
    expect(shellReportCwd(local)).toBe('/home/reader/nexus/Nexus-Shell')
    // A redraw reprints the report; the newest one is the directory in force.
    expect(shellReportCwd(`${local}${DEVICE_REPORT}`)).toBe('/root')
  })

  it('accepts BEL as the terminator too, so a report is read wherever it is legal', () => {
    expect(shellReportCwd('\u001b]3008;start=x;cwd=/tmp\u0007')).toBe('/tmp')
  })

  it('keeps a directory whose name contains the field separator', () => {
    // The value runs to the terminator, not to the next `;` — a path may
    // legitimately contain one, and truncating it would name another directory.
    expect(shellReportCwd('\u001b]3008;start=x;cwd=/home/reader/a;b;c\u001b\\')).toBe('/home/reader/a;b;c')
  })

  it('says nothing when the chunk carries no report, or an unfinished one', () => {
    expect(shellReportCwd('plain output\r\n')).toBeUndefined()
    expect(shellReportCwd('running \u001b]133;D;0\u0007 now')).toBeUndefined()
    // The report opened but the chunk ended before the path did: recording ""
    // would claim the shell stands nowhere, and the next chunk will have it.
    expect(shellReportCwd('\u001b]3008;start=x;cwd=')).toBeUndefined()
    expect(shellReportCwd('tail of a report;cwd=/split\u001b\\')).toBeUndefined()
  })
})
