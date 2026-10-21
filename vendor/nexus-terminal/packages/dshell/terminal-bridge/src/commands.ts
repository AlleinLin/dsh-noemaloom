/**
 * Command splitting for one main PTY — dshell context management (Phase A).
 *
 * The bridge sees both directions of the shell: the input chunks it forwards
 * to the PTY (user keystrokes, agent `terminal_send`) and the raw output
 * stream. Bash is already told to print an end-of-command marker before every
 * prompt (`OSC 133;D;<exit-code>`), so the two streams can be joined into
 * command-level records without any further shell cooperation:
 *
 *  - the input side assembles the current line (handling backspace, Ctrl+C,
 *    Ctrl+U/W and CSI sequences) and queues it on Enter;
 *  - the output side closes one record at each `133;D` marker, pairing it
 *    with the oldest queued command and slicing its output.
 *
 * Everything here is pure and side-effect free so it can be checked without a
 * live PTY (`tests/commands.spec.ts`). Parsing is best-effort: an
 * untracked command (history recall, a marker-less shell) still yields a
 * record with an empty command and the raw output, and the caller always has
 * the sanitized raw delta as a fallback.
 */

/** One command's output as the durable store keeps it. */
export interface StoredOutput {
  /** Retained tail, with no truncation marker of its own. */
  readonly text: string
  /** Total bytes the command produced, before truncation. */
  readonly bytes: number
  /** Bytes missing from the front of {@link text}. */
  readonly dropped: number
}

/** One completed command with the output it produced. */
export interface TerminalCommandRecord {
  /** Monotonic within one shell generation. */
  readonly seq: number
  /** The assembled command line, or '' when it could not be tracked. */
  readonly command: string
  /** Bash's exit status from the marker, or null when the marker carried none. */
  readonly exitCode: number | null
  /** Sanitized output between the previous prompt and this one. */
  readonly output: string
  /** Arrival time of the chunk that closed the record. */
  readonly at: number
  /**
   * The same output as the durable store keeps it: a longer tail than
   * {@link output} (the store's cap, not the preview's) with the byte counts a
   * paged reader needs. Absent only on records that did not come from a live
   * shell split.
   */
  readonly stored?: StoredOutput | undefined
}

/** Mutable splitter state for one shell. */
export interface CommandSplitterState {
  /** Input line being assembled from the client/agent side. */
  pending: string
  /** In-progress CSI sequence on the input side ('' = none). */
  inputEscape: string
  /** Commands submitted on Enter, awaiting their end-of-command marker. */
  queued: string[]
  /** Sanitized raw output accumulated since the last marker. */
  output: string
  /** Record counter. */
  seq: number
}

/** One slice of the retained window, resolved against absolute offsets. */
export interface WindowSlice {
  /** UTF-8 text from the requested offset (or from the window start when the request fell behind). */
  readonly text: string
  /** The requested offset predates the retained window. */
  readonly dropped: boolean
  /** The absolute offset the returned text starts at. */
  readonly start: number
}

/**
 * Resolve a cursor offset against the retained window. The window has slid
 * forward by `absOffset - byteLength(windowText)`, so an offset before that
 * start is gone (`dropped`) and the slice begins at the window head instead.
 * This is what makes the incremental read lossless across trims.
 * @param windowText - the current in-memory window.
 * @param absOffset - absolute byte offset just past the window's end.
 * @param fromOffset - the cursor's absolute offset.
 * @returns the slice plus its dropped flag and resolved start.
 */
export function sliceWindow(windowText: string, absOffset: number, fromOffset: number): WindowSlice {
  const windowStart = absOffset - Buffer.byteLength(windowText, 'utf8')
  let dropped = false
  let from = fromOffset
  if (from < windowStart) {
    dropped = true
    from = windowStart
  }
  if (from > absOffset) {
    dropped = true
    from = absOffset
  }
  const bytes = Buffer.from(windowText, 'utf8')
  return { text: bytes.subarray(from - windowStart).toString('utf8'), dropped, start: from }
}

/** Retain at most this much unmarked output (a shell that never prints markers). */
const MAX_PENDING_OUTPUT_BYTES = 64 * 1024

/** Per-record output cap for the in-memory window: how much a preview shows. */
export const MAX_RECORD_OUTPUT_BYTES = 16 * 1024

/**
 * Per-record output cap for the durable store — the ceiling on what the
 * agent-facing reader can page through.
 *
 * Equal to the splitter's pending bound on purpose: a command's output is
 * accumulated in memory until its end marker arrives, and that accumulation is
 * already trimmed to {@link MAX_PENDING_OUTPUT_BYTES}. Keeping more would mean
 * holding more, so the store's cap is that bound rather than a number of its
 * own — raising it is a memory decision, not a storage one.
 */
export const MAX_STORED_OUTPUT_BYTES = MAX_PENDING_OUTPUT_BYTES

/** Fresh splitter state for one shell generation. */
export function createSplitter(): CommandSplitterState {
  return { pending: '', inputEscape: '', queued: [], output: '', seq: 0 }
}

/** Remove ANSI/VT control sequences (OSC, CSI, two-char escapes) from text. */
export function stripAnsi(input: string): string {
  return input
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/\u001b/g, '')
}

/**
 * Model-facing text for raw terminal bytes: control sequences stripped,
 * carriage returns normalized, and the prompt markers removed. This is what
 * the agent sees for the incremental delta, so it never has to reason about
 * terminal control codes.
 * @param input - raw PTY text (may span the marker bytes).
 * @returns printable text with `\r\n` line endings.
 */
export function sanitizeTerminalText(input: string): string {
  return stripAnsi(input)
    .replace(/\u001b\]133[A-Z];?-?\d*\u0007/g, '')
    .replace(/\u0008/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
}

/** Accumulate one input chunk into the current line; Enter queues it. */
export function trackInput(state: CommandSplitterState, text: string): void {
  for (const ch of text) {
    if (state.inputEscape.length > 0) {
      // CSI: ESC [ params/intermediates final(0x40-0x7E). Other escapes are
      // two characters (ESC + final).
      if (state.inputEscape === '\u001b') {
        state.inputEscape += ch
        if (ch !== '[') state.inputEscape = ''
        continue
      }
      const code = ch.charCodeAt(0)
      if (code >= 0x40 && code <= 0x7e) state.inputEscape = ''
      else state.inputEscape += ch
      continue
    }
    if (ch === '\u001b') {
      state.inputEscape = '\u001b'
      continue
    }
    switch (ch) {
      case '\r':
      case '\n':
        if (state.pending.trim().length > 0) state.queued.push(state.pending)
        state.pending = ''
        break
      case '\u007f':
      case '\u0008':
        state.pending = state.pending.slice(0, -1)
        break
      case '\u0003': // Ctrl+C abandons the line
      case '\u0015': // Ctrl+U
        state.pending = ''
        break
      case '\u0017': // Ctrl+W
        state.pending = state.pending.replace(/\S+\s*$/, '')
        break
      case '\t': // completion redraws via output; not tracked here
        break
      default:
        if (ch >= ' ') state.pending += ch
        break
    }
  }
}

/** Drop the echoed prompt + command line from a record's output slice. */
function stripEcho(slice: string, command: string): string {
  if (command.length > 0) {
    const at = slice.indexOf(command)
    if (at >= 0) {
      const newline = slice.indexOf('\n', at + command.length)
      if (newline >= 0) return slice.slice(newline + 1)
    }
  }
  const firstBreak = slice.indexOf('\n')
  return firstBreak >= 0 ? slice.slice(firstBreak + 1) : ''
}

/** Cut `text` to its last `limit` bytes, reporting how many went. */
function tailBytes(text: string, limit: number): { text: string; dropped: number } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= limit) return { text, dropped: 0 }
  let start = bytes.length - limit
  // Do not start on a UTF-8 continuation byte: a character cut in half decodes
  // as a replacement character at the seam.
  while (start < bytes.length && (bytes[start]! & 0b1100_0000) === 0b1000_0000) start += 1
  return { text: bytes.subarray(start).toString('utf8'), dropped: start }
}

/**
 * One closed command's output in both forms: what the store keeps (the longer
 * tail, with the byte counts a paged reader needs) and what a preview shows
 * (the shorter tail, with the truncation spelled out so a reader knows it is
 * not seeing everything).
 *
 * The tail, not the head, in both: a command that printed too much is explained
 * by its end.
 */
function outputsOf(raw: string): { output: string; stored: StoredOutput } {
  const bytes = Buffer.byteLength(raw, 'utf8')
  const kept = tailBytes(raw, MAX_STORED_OUTPUT_BYTES)
  const shown = tailBytes(kept.text, MAX_RECORD_OUTPUT_BYTES)
  const dropped = kept.dropped + shown.dropped
  return {
    output: dropped > 0 ? `…(省略前 ${String(dropped)} 字节)\n${shown.text}` : shown.text,
    stored: { text: kept.text, bytes, dropped: kept.dropped },
  }
}

/**
 * Feed one raw output chunk; returns the records closed by the markers it
 * contains (usually zero or one). Markers spanning chunk boundaries are
 * handled because the scan runs over the accumulated output.
 * @param state - splitter state for this shell.
 * @param chunk - raw PTY output.
 * @param at - arrival time recorded on any closed record.
 * @returns completed command records in stream order.
 */
export function splitOutput(
  state: CommandSplitterState,
  chunk: string,
  at: number,
): TerminalCommandRecord[] {
  state.output += chunk
  const records: TerminalCommandRecord[] = []
  let last = 0
  for (const match of state.output.matchAll(/\u001b\]133;D;(-?\d*)\u0007/g)) {
    const index = match.index
    const slice = state.output.slice(last, index)
    last = index + match[0].length
    const exitCode = match[1] === '' || match[1] === undefined ? null : Number(match[1])
    const sanitized = sanitizeTerminalText(slice)
    const next = state.queued[0]
    if (next !== undefined) {
      const { output, stored } = outputsOf(stripEcho(sanitized, next))
      // A bare prompt (startup, Ctrl+C at the line editor, an empty Enter)
      // carries no command and no output: it must not consume the command
      // queued behind it, and it is not worth recording.
      if (output.trim().length === 0 && !sanitized.includes(next)) continue
      state.queued.shift()
      records.push({ seq: state.seq + 1, command: next, exitCode, output, at, stored })
      state.seq += 1
      continue
    }
    // No tracked command (history recall, external writer): keep the output
    // rather than losing it, attributed to no command line.
    const { output, stored } = outputsOf(stripEcho(sanitized, ''))
    if (output.trim().length === 0) continue
    records.push({ seq: state.seq + 1, command: '', exitCode, output, at, stored })
    state.seq += 1
  }
  if (last > 0) state.output = state.output.slice(last)
  if (Buffer.byteLength(state.output, 'utf8') > MAX_PENDING_OUTPUT_BYTES) {
    const bytes = Buffer.from(state.output, 'utf8')
    state.output = bytes.subarray(bytes.length - MAX_PENDING_OUTPUT_BYTES).toString('utf8')
  }
  return records
}
