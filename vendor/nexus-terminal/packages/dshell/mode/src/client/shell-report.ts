/**
 * The shell's own report of where it stands, read out of the PTY stream.
 *
 * A shell's working directory is process state with no channel back over a PTY:
 * `cd` moves a process and tells nobody. dsh's shell integration closes that by
 * printing an OSC 3008 report before every prompt —
 *
 *     ESC ] 3008 ; start=<id> ; user=<u> ; hostname=<h> ; cwd=<path> ESC \
 *
 * — and the same bytes ride the log a fresh attach replays. That report is the
 * only place the CLIENT can learn where a session's shell is, and for a device
 * session it matters most: the composer's mirror of the directory was filled
 * only by a `cd` typed through it (`trackCd`), so a session entered after a
 * `cd` — or one whose shell starts somewhere other than the session's recorded
 * directory — had no cwd at all, and the pre-warm then read the wrong tree.
 *
 * The directory reported is the SHELL's own path: the device's for a device
 * session. That is the right namespace to hand back to the host, because a
 * world's path translation passes through anything that is not inside a mount
 * directory unchanged (see dshell-ssh's `toRemotePath`).
 *
 * The value is read up to the report's terminator rather than up to the next
 * `;`, because a directory name may contain one. `cwd` is the last field dsh's
 * integration writes, so "the rest of the report" is exactly the path.
 */

/** The bytes that open the report. */
const REPORT_OPEN = '\u001b]3008;'

/** Terminators an OSC string may use: BEL, or ST (`ESC \`). */
const TERMINATORS = ['\u0007', '\u001b\\'] as const

/**
 * The directory the shell reported last in one chunk of output.
 *
 * @param text - a chunk of PTY output, or any text carrying the report.
 * @returns the reported absolute path, or undefined when the chunk has none.
 */
export function shellReportCwd(text: string): string | undefined {
  let found: string | undefined
  let from = 0
  for (;;) {
    const open = text.indexOf(REPORT_OPEN, from)
    if (open < 0) break
    const body = open + REPORT_OPEN.length
    let end = text.length
    for (const terminator of TERMINATORS) {
      const at = text.indexOf(terminator, body)
      if (at >= 0 && at < end) end = at
    }
    const report = text.slice(body, end)
    const field = report.lastIndexOf('cwd=')
    if (field >= 0) {
      const value = report.slice(field + 'cwd='.length)
      // An empty value means the report is still arriving (the chunk ended
      // before the path did), which is a reason to wait for the next one
      // rather than to record a directory the shell never named.
      if (value.length > 0) found = value
    }
    from = end
  }
  return found
}
