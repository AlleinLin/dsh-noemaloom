/**
 * The position rule table, driven by lines that were actually typed.
 *
 * Every fixture below comes from real history (the user's `~/.bash_history`,
 * dshell's shell-history index, and the session PTY logs) — the shapes that
 * appear in this project, not invented ones. A completion that misreads the
 * position offers the wrong KIND of thing, which is worse than offering
 * nothing, so each case states both the position and the command the caret
 * belongs to.
 */

import { describe, expect, it } from 'vitest'
import {
  classifyShellPosition, readShellCaret, tokenizeShellLine,
  type ShellCaret, type ShellPosition,
} from '@nexus-aethra/dshell-std'

/** The caret at the end of `line`, as the composer sends it. */
function caretAt(line: string): ShellCaret {
  const caret = readShellCaret(line, line.length)
  if (caret === undefined) throw new Error(`no caret reading for ${JSON.stringify(line)}`)
  return caret
}

/** Position + command for a line, with the caret at its end. */
function positionOf(line: string): { readonly position: ShellPosition; readonly command: string | undefined; readonly prefix: string } {
  const caret = caretAt(line)
  return { position: caret.position, command: caret.command, prefix: caret.prefix }
}

describe('tokenizeShellLine', () => {
  it('keeps quoted whitespace inside one token, and records the quoting', () => {
    const tokens = tokenizeShellLine(`echo 'two words' "and three"`)
    expect(tokens.map(token => token.text)).toEqual(['echo', "'two words'", '"and three"'])
    expect(tokens.map(token => token.quoted)).toEqual([false, true, true])
    expect(tokens[1]?.start).toBe(5)
  })

  it('keeps an unterminated quote whole — the reader is still typing it', () => {
    expect(tokenizeShellLine(`echo 'unfinished`).map(token => token.text)).toEqual(['echo', "'unfinished"])
  })

  it('splits operators that were written without spaces', () => {
    expect(tokenizeShellLine('ls>out.txt').map(token => [token.kind, token.text])).toEqual([
      ['word', 'ls'], ['redirection', '>'], ['word', 'out.txt'],
    ])
    expect(tokenizeShellLine('pwd;hostname').map(token => [token.kind, token.text])).toEqual([
      ['word', 'pwd'], ['separator', ';'], ['word', 'hostname'],
    ])
  })

  it('knows a file-descriptor duplication from a redirection with a target', () => {
    const tokens = tokenizeShellLine('make 2>&1 | tail -5')
    expect(tokens.filter(token => token.kind === 'redirection').map(token => [token.text, token.target])).toEqual([
      ['2>&1', false],
    ])
    expect(tokenizeShellLine('make >2.log').filter(token => token.kind === 'redirection').map(token => [token.text, token.target]))
      .toEqual([['>', true]])
  })

  it('marks the words that wrap or open a command as reserved', () => {
    expect(tokenizeShellLine('sudo rm -rf ./x').map(token => token.kind))
      .toEqual(['reserved', 'word', 'word', 'word'])
    expect(tokenizeShellLine('if true; then ls').map(token => token.kind))
      .toEqual(['reserved', 'word', 'separator', 'reserved', 'word'])
    expect(tokenizeShellLine('for f in a b').map(token => token.kind))
      .toEqual(['reserved', 'word', 'reserved', 'word', 'word'])
  })
})

describe('classifyShellPosition — the first word is only sometimes the command', () => {
  it('reads a plain command', () => {
    expect(positionOf('dock')).toEqual({ position: 'command', command: undefined, prefix: 'dock' })
  })

  it('looks THROUGH the wrapper words instead of treating them as the command', () => {
    expect(positionOf('sudo dock')).toEqual({ position: 'command', command: undefined, prefix: 'dock' })
    expect(positionOf('sudo docker r')).toEqual({ position: 'argument', command: 'docker', prefix: 'r' })
    expect(positionOf('env FOO=1 dock')).toEqual({ position: 'command', command: undefined, prefix: 'dock' })
    expect(positionOf('xargs docker r')).toEqual({ position: 'argument', command: 'docker', prefix: 'r' })
  })

  it('starts a new command after every operator', () => {
    expect(positionOf('pwd; host')).toEqual({ position: 'command', command: undefined, prefix: 'host' })
    // The caret sits inside `pwd`, which is that command's own name — so it is
    // the `pwd` command position again, not an argument of `echo`.
    expect(positionOf('echo cancel-restore-works; pwd')).toEqual({ position: 'command', command: undefined, prefix: 'pwd' })
    expect(positionOf('ls | grep mini')).toEqual({ position: 'argument', command: 'grep', prefix: 'mini' })
    expect(positionOf('test -f x && dock')).toEqual({ position: 'command', command: undefined, prefix: 'dock' })
    expect(positionOf('cat f | wc')).toEqual({ position: 'command', command: undefined, prefix: 'wc' })
  })

  it('opens a command position inside a substitution', () => {
    expect(positionOf('echo $(dock')).toEqual({ position: 'command', command: undefined, prefix: 'dock' })
    expect(positionOf('echo `dock')).toEqual({ position: 'command', command: undefined, prefix: 'dock' })
    expect(positionOf('cd $(git rev-parse')).toEqual({ position: 'argument', command: 'git', prefix: 'rev-parse' })
  })

  it('treats an assignment prefix as part of the command line, not as the command', () => {
    expect(positionOf('DSHELL_HOME=/tmp dock')).toEqual({ position: 'command', command: undefined, prefix: 'dock' })
  })

  it('calls a dash word a flag, but only after the command is named', () => {
    expect(positionOf('ls -la')).toEqual({ position: 'flag', command: 'ls', prefix: '-la' })
    expect(positionOf('docker --form')).toEqual({ position: 'flag', command: 'docker', prefix: '--form' })
    expect(positionOf('sudo docker r')).toEqual({ position: 'argument', command: 'docker', prefix: 'r' })
    // A lone dash is the stdin convention, not a flag prefix (`docker r -`).
    expect(positionOf('docker r -')).toEqual({ position: 'argument', command: 'docker', prefix: '-' })
  })

  it('expects a FILE, not a command, after a redirection', () => {
    // The prefix is the NAME (after the slash), the same contract the path
    // completion has always used: `/tmp/` stays, `x` is what gets rewritten.
    expect(positionOf('head -c 100 /dev/urandom > /tmp/x')).toEqual({ position: 'redir', command: 'head', prefix: 'x' })
    expect(positionOf('head -c 100 /dev/urandom >/tmp/x')).toEqual({ position: 'redir', command: 'head', prefix: 'x' })
    expect(positionOf('ls > out')).toEqual({ position: 'redir', command: 'ls', prefix: 'out' })
    expect(positionOf('wc < in')).toEqual({ position: 'redir', command: 'wc', prefix: 'in' })
  })

  it('does not treat a duplicated descriptor as a file', () => {
    // `2>&1` names a descriptor, so the word after it is still an ordinary
    // argument — and the caret inside the operator itself names nothing at all.
    expect(positionOf('nginx -t 2>&1 -g')).toEqual({ position: 'flag', command: 'nginx', prefix: '-g' })
    expect(readShellCaret('nginx -t 2>&1', 13)).toBeUndefined()
  })

  it('hands the argument after `cd` to the same command, not to a new one', () => {
    expect(positionOf('cd nexus-study-stack')).toEqual({ position: 'argument', command: 'cd', prefix: 'nexus-study-stack' })
    expect(positionOf('cd "$HOME"/')).toEqual({ position: 'argument', command: 'cd', prefix: '' })
  })

  it('reads a real init line the way bash would', () => {
    const line = `cd "$HOME"/'nexus' 2>/dev/null; export DSHELL_PS1='\\u@\\h:\\w\\$ '; expor`
    expect(positionOf(line)).toEqual({ position: 'command', command: undefined, prefix: 'expor' })
  })})

describe('readShellCaret — the span a completion replaces', () => {
  it('reports the directory part and the name separately', () => {
    const caret = caretAt('ls nexus-shell/src/ind')
    // The span starts at the name (`ind`), not at the word: the directory part
    // is kept, so the completion rewrites only what the user is still typing.
    expect(caret).toMatchObject({ position: 'argument', dirPart: 'nexus-shell/src/', prefix: 'ind', start: 19, end: 22 })
  })

  it('splits a command word the same way', () => {
    const caret = caretAt('/usr/bin/doc')
    expect(caret).toMatchObject({ position: 'command', dirPart: '/usr/bin/', prefix: 'doc', start: 9 })
  })

  it('reads the empty word after whitespace as a new argument', () => {
    expect(caretAt('ls ')).toMatchObject({ position: 'argument', prefix: '', empty: true, start: 3 })
    expect(caretAt('sudo ')).toMatchObject({ position: 'command', prefix: '', empty: true })
  })

  it('keeps the file slot open right after a redirection', () => {
    // bash lists the directory here, and the empty word is why: the operator is
    // complete, so the caret is in the slot it opened.
    expect(caretAt('ls >')).toMatchObject({ position: 'redir', prefix: '', empty: true, start: 4, end: 4 })
    expect(caretAt('nginx 2>')).toMatchObject({ position: 'redir', prefix: '', empty: true })
    expect(caretAt('ls > ')).toMatchObject({ position: 'redir', prefix: '', empty: true, start: 5 })
  })

  it('completes nothing on a blank line or under an operator', () => {
    expect(readShellCaret('', 0)).toBeUndefined()
    expect(readShellCaret('   ', 3)).toBeUndefined()
    expect(readShellCaret('ls |', 4)).toBeUndefined()
    // …but the word AFTER the operator is a command again, which is the whole
    // point of walking the line instead of reading the first word.
    expect(readShellCaret('ls | grep', 9)).toMatchObject({ position: 'command', command: undefined })
  })

  it('reads the caret mid-line, not just at the end', () => {
    // The caret is inside the third word, so the prefix is what precedes it and
    // the span still starts where the word does. Replacing [start, end) rewrites
    // exactly the part the reader has typed, and leaves the rest untouched.
    const caret = readShellCaret('ls nexus-shell/src/x', 8)
    expect(caret).toMatchObject({ position: 'argument', prefix: 'nexus', dirPart: '', start: 3 })
    expect(caret?.end).toBe(8)
  })
})
