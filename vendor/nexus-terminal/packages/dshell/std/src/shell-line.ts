/**
 * The shell line, tokenized and classified — the rule table behind Tab.
 *
 * The composer's completion has to know WHICH position the caret is in before it
 * can know what to offer, because a position is a property of the LINE, not of
 * the word: `dock` is a command in `dock`, an argument in `cd dock`, and a file
 * in `tee > dock`. bash's own grammar is what defines it (the start of a *simple
 * command*), and that start is introduced by an operator, a keyword, or a prefix
 * word — never by "it happens to be first".
 *
 * This module is that rule table, kept pure: no services, no filesystem, no
 * process. Both halves of the feature depend on it — the host decides which
 * source answers, the browser decides when an empty answer is worth showing —
 * and `packages/dshell/std/tests/shell-line.spec.ts` drives it with real lines.
 *
 * Deliberately NOT a shell parser. bash's grammar is unbounded (`eval`, nested
 * substitutions, heredocs, functions), so this walk answers the shapes it can
 * PROVE and admits what it cannot: a blank line or an operator under the caret
 * reports "nothing to complete" rather than guessing, and the caller decides
 * what no-answer means. There is no "maybe" position — a caller cannot act on
 * one, and a wrong KIND of candidate (`-launcher.sh` offered for `-la<Tab>`) is
 * worse than silence.
 */

/** What one token of the line is. */
export type ShellTokenKind =
  /** A plain word, quotes and all (they are kept: the caller resolves them). */
  | 'word'
  /** `VAR=value` — a shape, not a decision: it only assigns in a command position. */
  | 'assign'
  /** `;` `&` `&&` `||` `|` `|&` — the next word starts a new command. */
  | 'separator'
  /** `(` `{` `$(` `` ` `` — a nested command list begins. */
  | 'open'
  /** `)` `}` — a nested command list ends. */
  | 'close'
  /** `>` `>>` `<` `<<` `2>` … — may or may not want a target (see {@link ShellToken.target}). */
  | 'redirection'
  /** `if` `then` `do` `fi` … — keywords that open or close a command list. */
  | 'reserved'

/** One token, with the offsets a completion has to report. */
export interface ShellToken {
  readonly kind: ShellTokenKind
  /** The token exactly as written, quotes included. */
  readonly text: string
  /** Offset of the first character in the line. */
  readonly start: number
  /** Offset one past the last character. */
  readonly end: number
  /** Whether any part of the token was quoted. */
  readonly quoted: boolean
  /**
   * For a redirection: whether it names a target (`> file` does, `2>&1` does
   * not — that one names a file descriptor). Getting this wrong is what makes a
   * completion offer a file where bash expects a digit.
   */
  readonly target: boolean
}

/** Where the caret sits, in the line's grammar. */
export type ShellPosition =
  /** The word names the command itself. */
  | 'command'
  /** A word of a command already named (a path, usually). */
  | 'argument'
  /** A `-`/`--` word of a command already named. */
  | 'flag'
  /** The word is what a redirection writes to or reads from: a file. */
  | 'redir'

/** The caret's token, its span, and what the line is doing there. */
export interface ShellCaret {
  readonly position: ShellPosition
  /**
   * The command the position belongs to: the last command word before the
   * caret, skipping the prefix words (`sudo docker r` → `docker`). Undefined
   * until the line has named one.
   */
  readonly command: string | undefined
  /** Offset the completion replaces from (the start of the name, after any slash). */
  readonly start: number
  /** Offset the completion replaces to: the caret. */
  readonly end: number
  /** The token's directory part, `''` when it has no slash. */
  readonly dirPart: string
  /** The name being completed — what follows the last slash. */
  readonly prefix: string
  /** Whether the caret sits after whitespace, where a new word begins. */
  readonly empty: boolean
}

/** Characters that end a word. */
const BLANKS = new Set([' ', '\t', '\n', '\r'])

/**
 * Words after which a simple command begins, so the NEXT word is that command's
 * name: wrapper commands (`sudo`, `env`, `time`, `xargs`, … — bash's own
 * bash-completion registers several of these, e.g. `complete -F _comp_command
 * time xargs nohup`) and the keywords that open a command list.
 */
const BEFORE_COMMAND = new Set([
  'if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', 'time', '{',
  'sudo', 'doas', 'env', 'nice', 'ionice', 'nohup', 'setsid', 'strace',
  'command', 'builtin', 'exec', 'xargs', 'watch', 'timeout', 'noglob', 'nocorrect',
])

/**
 * Keywords that END a command list rather than open one. `in` is here on
 * purpose: what follows it are words (`for f in a b`), not a command.
 *
 * The walk does not need this split — a keyword in the command position is never
 * the command itself, whatever list it belongs to — so this set only decides
 * which words are tokens of kind `reserved` rather than plain words.
 */
const AFTER_COMMAND = new Set(['fi', 'done', 'esac', '}', 'in', 'case', 'select', 'function', 'for'])

/** One operator form. Order matters: the longest/dup forms must be tried first. */
const OPERATORS: readonly { readonly re: RegExp; readonly kind: ShellTokenKind; readonly target: boolean }[] = [
  { re: /^&&/u, kind: 'separator', target: false },
  { re: /^\|\|/u, kind: 'separator', target: false },
  { re: /^\|&/u, kind: 'separator', target: false },
  { re: /^;/u, kind: 'separator', target: false },
  { re: /^\|/u, kind: 'separator', target: false },
  // A file-descriptor duplication (`2>&1`, `>&2`) names a descriptor, not a
  // file — it must be matched before the plain redirections below.
  { re: /^[0-9]*>&[0-9-]+/u, kind: 'redirection', target: false },
  { re: /^&>>?/u, kind: 'redirection', target: true },
  { re: /^&/u, kind: 'separator', target: false },
  { re: /^[0-9]*(?:>>|>\||>\|?|<[<>]?)/u, kind: 'redirection', target: true },
  { re: /^\$\(/u, kind: 'open', target: false },
  { re: /^\(/u, kind: 'open', target: false },
  { re: /^\)/u, kind: 'close', target: false },
  { re: /^`/u, kind: 'open', target: false },
]

/** The operator at `index`, if any. */
function operatorAt(line: string, index: number): { readonly kind: ShellTokenKind; readonly text: string; readonly target: boolean } | undefined {
  for (const form of OPERATORS) {
    const matched = form.re.exec(line.slice(index))
    if (matched !== null) return { kind: form.kind, text: matched[0], target: form.target }
  }
  return undefined
}

/** Whether a bare word is an assignment rather than a name. */
function isAssignment(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(text)
}

/** The kind of a word, from its own shape alone (its position decides the rest). */
function kindOfWord(text: string, quoted: boolean): ShellTokenKind {
  if (!quoted && (text === '{' || text === '}')) return text === '{' ? 'open' : 'close'
  // An assignment tests the RAW text, not the quoting: what makes `FOO='a b'`
  // an assignment is its unquoted `name=` head, and the quotes only hide the
  // value. Quoting the NAME (`'FOO'=a`) makes it an ordinary word, which is
  // exactly what anchoring the test at offset 0 already gives.
  if (isAssignment(text)) return 'assign'
  if (quoted) return 'word'
  if (BEFORE_COMMAND.has(text) || AFTER_COMMAND.has(text)) return 'reserved'
  return 'word'
}

/**
 * Split one line into tokens, stopping at nothing: a completion also runs on a
 * half-written line, so quotes may be open and the last word may be cut off.
 *
 * Quote handling is what a completion needs, not what a shell needs: whitespace
 * inside quotes does not split, an unterminated quote keeps its token whole (the
 * reader is still typing it), and the operators that are not separated by spaces
 * (`a>b`, `x;y`) still split — which the word scanner does by asking
 * {@link operatorAt} before consuming a character.
 *
 * @param line - the line as written.
 * @returns the tokens in order, with their offsets.
 */
export function tokenizeShellLine(line: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let index = 0
  while (index < line.length) {
    if (BLANKS.has(line[index] as string)) { index += 1; continue }
    const operator = operatorAt(line, index)
    if (operator !== undefined) {
      tokens.push({
        kind: operator.kind, text: operator.text, start: index, end: index + operator.text.length,
        quoted: false, target: operator.target,
      })
      index += operator.text.length
      continue
    }
    const start = index
    let text = ''
    let quoted = false
    while (index < line.length) {
      const char = line[index] as string
      if (BLANKS.has(char)) break
      if (char === '\\' && index + 1 < line.length) {
        text += line.slice(index, index + 2)
        index += 2
        continue
      }
      if (char === '\'' || char === '"' || char === '`') {
        quoted = true
        text += char
        index += 1
        while (index < line.length && line[index] !== char) {
          if (char === '"' && line[index] === '\\' && index + 1 < line.length) {
            text += line.slice(index, index + 2)
            index += 2
            continue
          }
          text += line[index]
          index += 1
        }
        // An unterminated quote is a word still being written: keep it whole.
        if (index < line.length) { text += char; index += 1 }
        continue
      }
      if (operatorAt(line, index) !== undefined) break
      text += char
      index += 1
    }
    if (text.length === 0) { index += 1; continue }
    tokens.push({ kind: kindOfWord(text, quoted), text, start, end: index, quoted, target: false })
  }
  return tokens
}

/**
 * Walk the tokens before the caret and report what the line expects there.
 *
 * `command` is the command the caret's word belongs to, so it is undefined
 * wherever the line has not named one YET — which is why every operator, and
 * every keyword sitting where a command would go, clears it again.
 *
 * @param tokens - the line's tokens, in order.
 * @param index - the token under the caret, or the token count for a word that
 *   has not been typed yet (an empty token after whitespace).
 * @returns the position, and the command it belongs to when there is one.
 */
export function classifyShellPosition(
  tokens: readonly ShellToken[],
  index: number,
): { readonly position: ShellPosition; readonly command: string | undefined } {
  let expecting: 'command' | 'argument' | 'file' = 'command'
  let command: string | undefined
  for (let at = 0; at < index && at < tokens.length; at += 1) {
    const token = tokens[at] as ShellToken
    if (token.kind === 'redirection') {
      // A duplication (`2>&1`) names no file, so it leaves the expectation
      // alone; only a real redirection opens the file slot that follows it.
      expecting = token.target ? 'file' : expecting
      continue
    }
    if (token.kind === 'separator' || token.kind === 'open') {
      expecting = 'command'
      command = undefined
      continue
    }
    if (token.kind === 'close') { expecting = 'argument'; continue }
    if (token.kind === 'assign') continue
    if (token.kind === 'reserved' && expecting === 'command') {
      // A keyword or a wrapper word in the command position does not become the
      // command: `if`/`then`/`do` open a list and `fi`/`done` close one (either
      // way a command follows), while `sudo`/`env`/`time` hand the position on
      // to the next word. So all of them clear `command` and keep waiting.
      command = undefined
      continue
    }
    if (expecting === 'command') {
      command = token.text
      expecting = 'argument'
      continue
    }
    if (expecting === 'file') expecting = 'argument'
  }
  const caret = tokens[index]
  // No word under the caret yet: the expectation IS the answer, with the file
  // slot reported as the `redir` position it always was.
  if (caret === undefined) return { position: expecting === 'file' ? 'redir' : expecting, command }
  if (expecting === 'file') return { position: 'redir', command }
  if (expecting === 'command') return { position: 'command', command }
  if (caret.kind === 'word' && caret.text.length > 1 && caret.text.startsWith('-')) {
    return { position: 'flag', command }
  }
  return { position: 'argument', command }
}

/**
 * Everything the completion needs to know about one caret: where the word is,
 * which part of it is the name, and what the line expects there.
 *
 * @param line - the line as written (the draft).
 * @param cursor - the caret offset within it.
 * @returns the caret reading, or undefined when there is nothing to complete —
 *   a blank line, or an operator under the caret, which names no word (a
 *   redirection WITH a target is the exception: `ls >` is a file slot with an
 *   empty word in it, and the reader reports it as such).
 */
export function readShellCaret(line: string, cursor: number): ShellCaret | undefined {
  const before = line.slice(0, Math.max(0, Math.min(cursor, line.length)))
  const tokens = tokenizeShellLine(before)
  const last = tokens[tokens.length - 1]
  let index = tokens.length
  let start = before.length
  let dirPart = ''
  let prefix = ''
  let empty = true
  if (last !== undefined && last.end === before.length && last.kind === 'redirection' && last.target) {
    // `ls >` — the operator is complete and the word it names is empty, so the
    // walk (which now sees that redirection) reports the file slot. bash reads
    // it the same way: Tab right after `>` lists the directory.
  } else if (last !== undefined && last.end === before.length) {
    // An operator under the caret names nothing: there is no word being typed.
    if (last.kind !== 'word' && last.kind !== 'assign' && last.kind !== 'reserved') return undefined
    const slash = last.text.lastIndexOf('/')
    dirPart = slash < 0 ? '' : last.text.slice(0, slash + 1)
    prefix = last.text.slice(slash + 1)
    start = last.start + dirPart.length
    index = tokens.length - 1
    empty = false
  } else if (before.trim().length === 0) {
    // A blank line completes nothing, which is what a terminal does too.
    return undefined
  }
  const { position, command } = classifyShellPosition(tokens, index)
  return { position, command, start, end: before.length, dirPart, prefix, empty }
}
