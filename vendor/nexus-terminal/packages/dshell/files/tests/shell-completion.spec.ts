/**
 * The shell oracle's edges, driven without a shell.
 *
 * The probe itself runs in the session's world (`askShell`), and what it prints
 * is the only thing that crosses back — so the reading of that output, the
 * quoting invariant that makes the probe safe to build, and the cache that
 * decides when a world is asked at all are the parts worth pinning down here.
 * The fixtures are real bash-completion answers, captured from this machine's
 * own `git`, `docker` and `tar` completions.
 */

import { describe, expect, it } from 'vitest'
import { OracleCache, ORACLE_PROBE, parseProbeOutput } from '../src/shell-completion.js'
import { quote } from '../src/shell-quote.js'

/** One probe answer, as the markers wrap it. */
function wrapped(names: readonly string[]): string {
  return `DSHELL_BEGIN\n${names.join('\n')}\nDSHELL_END\n`
}

describe('the probe script', () => {
  it('contains no single quote at all', () => {
    // Not a style rule: `quote()` wraps the whole script in single quotes, so a
    // quote inside would have to be escaped — and a script whose safety depends
    // on every future edit re-escaping correctly is one edit away from a
    // command-line injection. The probe builds the characters it compares
    // against with printf instead, and this is what keeps it that way.
    expect(ORACLE_PROBE.includes('\'')).toBe(false)
  })

  it('loads the framework and the lazy loader before asking', () => {
    // bash-completion registers most commands on FIRST USE (`_completion_loader
    // git` is what makes `complete -p git` answer), and a shell started with
    // --noprofile — the local bridge's own — has sourced none of it.
    expect(ORACLE_PROBE).toContain('bash-completion/bash_completion')
    expect(ORACLE_PROBE).toContain('_completion_loader')
    expect(ORACLE_PROBE).toContain('complete -p')
  })

  it('takes the line and the caret as arguments, never as script text', () => {
    expect(ORACLE_PROBE).toContain('line=$1')
    expect(ORACLE_PROBE).toContain('pos=$2')
  })
})

describe('quote', () => {
  it('closes and reopens around a quote in the value', () => {
    expect(quote('plain')).toBe('\'plain\'')
    expect(quote('a\'b')).toBe('\'a\'\\\'\'b\'')
    expect(quote('')).toBe('\'\'')
  })

  it('leaves a line with newlines and dollars as one word', () => {
    // A pasted multi-line draft is still one argument, and `$(...)` in it stays
    // text: completion reads the line, it never runs it.
    expect(quote('echo $(rm -rf /)\nls')).toBe('\'echo $(rm -rf /)\nls\'')
  })
})

describe('parseProbeOutput', () => {
  it('reads the candidates between the markers', () => {
    expect(parseProbeOutput(wrapped(['rename', 'restart', 'rm', 'rmi', 'run'])))
      .toEqual(['rename', 'restart', 'rm', 'rmi', 'run'])
  })

  it('drops the trailing space bash-completion uses to mean "this word is done"', () => {
    // `git ch` answers `checkout ` / `cherry-pick ` / `cherry `: which suffix
    // follows a taken candidate is the composer's rule, so it is stripped here.
    expect(parseProbeOutput(wrapped(['checkout ', 'cherry-pick ', 'cherry '])))
      .toEqual(['checkout', 'cherry-pick', 'cherry'])
  })

  it('drops empty lines and repeats', () => {
    expect(parseProbeOutput('DSHELL_BEGIN\n\n--force\n--force\n\nDSHELL_END\n')).toEqual(['--force'])
  })

  it('reads an answer with no candidates as an empty list', () => {
    // A spec that matched nothing is not the same as no spec: the caller keeps
    // its own answer in both cases, but only one of them means "this world has
    // a completion for that command and it found nothing".
    expect(parseProbeOutput(wrapped([]))).toEqual([])
  })

  it('reports "no spec" as undefined, which is what tells the caller to fall back', () => {
    expect(parseProbeOutput('DSHELL_NOSPEC\n')).toBeUndefined()
  })

  it('reports unreadable output as undefined rather than as an empty answer', () => {
    expect(parseProbeOutput('')).toBeUndefined()
    expect(parseProbeOutput('bash: syntax error near unexpected token\n')).toBeUndefined()
    expect(parseProbeOutput('DSHELL_END\nDSHELL_BEGIN\n')).toBeUndefined()
  })

  it('ignores anything printed outside the markers', () => {
    // Completion functions print to stdout sometimes; the markers are what keeps
    // their noise from becoming candidates.
    expect(parseProbeOutput(`warning: foo\n${wrapped(['install'])}trailing junk`)).toEqual(['install'])
  })
})

describe('OracleCache', () => {
  const context = 'docker\u0000run'

  it('answers a longer word from the shorter one that was asked', () => {
    const cache = new OracleCache()
    cache.store(context, '--', ['--detach', '--dns', '--env', '--publish'], 1_000)
    // `--d` is a local filter of the same list, so no world is asked again.
    expect(cache.lookup(context, '--d', 1_000)).toEqual(['--detach', '--dns'])
    expect(cache.lookup(context, '--', 1_000)).toEqual(['--detach', '--dns', '--env', '--publish'])
  })

  it('reports a miss when the filter is empty, so the caller asks the world again', () => {
    const cache = new OracleCache()
    cache.store(context, 'r', ['rename', 'restart', 'rm', 'rmi', 'run'], 1_000)
    // An empty filter means the cached list was not a superset: a function that
    // answers per prefix (`__gitcomp` for one kind of word, `_filedir` for
    // another) would otherwise be answered from a list it never produced.
    expect(cache.lookup(context, 'zz', 1_000)).toBeUndefined()
  })

  it('does not serve one context to another', () => {
    const cache = new OracleCache()
    cache.store('docker\u0000rm', '--f', ['--force'], 1_000)
    expect(cache.lookup('docker\u0000run', '--f', 1_000)).toBeUndefined()
  })

  it('forgets an answer once it is old', () => {
    const cache = new OracleCache()
    cache.store(context, '--', ['--detach'], 1_000)
    expect(cache.lookup(context, '--d', 1_000 + 59_000)).toEqual(['--detach'])
    expect(cache.lookup(context, '--d', 1_000 + 61_000)).toBeUndefined()
  })

  it('keeps a bounded number of prefixes per context', () => {
    const cache = new OracleCache()
    for (let at = 1; at <= 10; at += 1) {
      const prefix = 'x'.repeat(at)
      cache.store(context, prefix, [`${prefix}-cmd`], 1_000)
    }
    // One answer per keystroke, kept until the session ends, would grow with the
    // reader's patience; the newest prefix is the one the next Tab is about, and
    // the oldest are the ones already behind the caret.
    expect(cache.lookup(context, 'x', 1_000)).toBeUndefined()
    expect(cache.lookup(context, 'xxxxxxxxxx', 1_000)).toEqual(['xxxxxxxxxx-cmd'])
  })

  it('runs one probe when a warm and the Tab it was warming for overlap', async () => {
    const cache = new OracleCache()
    let probes = 0
    const probe = async (): Promise<readonly string[]> => {
      probes += 1
      await new Promise(resolve => setTimeout(resolve, 5))
      return ['run']
    }
    // This is the case the warm exists for: the reader typed, the warm went out,
    // and the key landed while it was still on the wire. The keystroke must wait
    // for that answer rather than pay for a second one — on a device a probe is a
    // process of its own.
    const [warm, tab] = await Promise.all([cache.probe('k', probe), cache.probe('k', probe)])
    expect(probes).toBe(1)
    expect(warm).toEqual(['run'])
    expect(tab).toEqual(warm)
  })
})
