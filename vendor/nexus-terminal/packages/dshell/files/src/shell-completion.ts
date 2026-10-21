/**
 * The completion oracle: what the session's own shell answers for a line.
 *
 * The file system can answer "which names start with this word" and nothing
 * else, so `docker r<Tab>` had no source between a PATH lookup (wrong kind of
 * name) and a directory listing (wrong kind of name again). What DOES know is
 * the shell itself: bash-completion registers a completion function per command
 * — `docker`'s knows its subcommands, `git`'s knows its options, `sudo`'s knows
 * how to shift the position so the inner command gets asked — and the session's
 * world is exactly the place those are installed. So we ask it, in a process of
 * its own, and treat its answer as one more source the route can dispatch to.
 *
 * Three boundaries this module holds to:
 *
 *  - **The line is DATA.** It travels as an argument (`bash -c <script> name
 *    <line> <cursor>`) and is never spliced into the script text. The script
 *    itself is written without a single quote character for the same reason,
 *    which is an invariant `tests/shell-completion.spec.ts` asserts rather than
 *    a comment someone has to trust.
 *  - **Nothing here executes the reader's line.** The probe only feeds it to a
 *    completion function, which reads words; it is completion, not evaluation.
 *    That is also why the loader and the function run in a fresh process with
 *    no access to the session's terminal, whose single active send must stay the
 *    user's (`dshell-terminal-bridge` mirrors the visible terminal read-only).
 *  - **Failure is silent.** A world without bash-completion, a device that will
 *    not answer, a function that dies: all of them return "no answer", and the
 *    caller falls back to what it already knew. A completion must never cost the
 *    reader the answer they would otherwise have had.
 *
 * The trust note that belongs in the code and not only in docs: the functions
 * being run are CODE ON THAT MACHINE — which is what the reader's own Tab already
 * runs when they press it in a terminal. This asks the same question in a
 * separate process instead of typing into their shell, and it never executes the
 * line: a completion function reads the words, and the probe is what feeds them
 * to it.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SingleFlight } from './readings.js'
import { quote } from './shell-quote.js'
import { runInWorld } from './world-shell.js'

/**
 * The probe, as an array of lines rather than one template: the script is full
 * of `${...}` and `\n`, both of which a template literal would eat.
 *
 * It runs as `bash -c <this> dshell-probe <line> <cursor>`, so `$1` and `$2` are
 * the line and the caret offset — data, not text. There is deliberately no
 * single quote anywhere below (the quote characters it needs are built with
 * printf), because that is what makes quoting the script a no-op.
 */
const PROBE_LINES: readonly string[] = [
  'set +m',
  'line=$1',
  'pos=$2',
  '[ -n "$line" ] || exit 0',
  // bash-completion is loaded lazily per command, and a shell started with
  // --noprofile (the bridge's own) has loaded none of it: source the framework
  // first, exactly as an interactive login shell would.
  'if [ -r /usr/share/bash-completion/bash_completion ]; then',
  '  . /usr/share/bash-completion/bash_completion',
  'elif [ -r /etc/bash_completion ]; then',
  '  . /etc/bash_completion',
  'fi',
  'COMP_LINE=$line',
  'COMP_POINT=$pos',
  'COMP_TYPE=9',
  'COMP_KEY=9',
  // The quote characters and the blanks, spelled by printf rather than typed:
  // this is what keeps the whole script free of a single quote, which is what
  // makes quoting it a no-op.
  'sq=$(printf "\\\\47")',
  'dq=$(printf "\\\\42")',
  'tab=$(printf "\\\\t")',
  'nl=$(printf "\\\\n")',
  // Split the part BEFORE the caret the way the shell parser does: blanks
  // separate, quotes group and are dropped, and an unterminated quote leaves the
  // word open — which is the word the reader is still typing.
  'before=${line:0:$pos}',
  'words=()',
  'cur=""',
  'inq=""',
  'i=0',
  'n=${#before}',
  'while [ "$i" -lt "$n" ]; do',
  '  c=${before:$i:1}',
  '  if [ -n "$inq" ]; then',
  '    if [ "$c" = "$inq" ]; then inq=""; else cur=$cur$c; fi',
  '  elif [ "$c" = "$sq" ] || [ "$c" = "$dq" ]; then',
  '    inq=$c',
  '  elif [ "$c" = " " ] || [ "$c" = "$tab" ] || [ "$c" = "$nl" ]; then',
  '    if [ -n "$cur" ]; then words+=("$cur"); cur=""; fi',
  '  else',
  // Operators end a word: `pwd;host` is two commands to a completion function,
  // the same way it is to the shell.
  '    case "$c" in',
  '      ";"|"|"|"&"|"("|")"|"<"|">")',
  '        if [ -n "$cur" ]; then words+=("$cur"); cur=""; fi',
  '        words+=("$c")',
  '        ;;',
  '      *) cur=$cur$c ;;',
  '    esac',
  '  fi',
  '  i=$((i + 1))',
  'done',
  // The tail is always a word, empty or not: `docker ` completes the word the
  // reader has not started yet, which is the one the function must see.
  'words+=("$cur")',
  'COMP_WORDS=("${words[@]}")',
  'COMP_CWORD=$((${#words[@]} - 1))',
  'curword=${COMP_WORDS[$COMP_CWORD]}',
  'prevword=""',
  'if [ "$COMP_CWORD" -gt 0 ]; then prevword=${COMP_WORDS[$((COMP_CWORD - 1))]}; fi',
  // The command whose completion applies is the FIRST word that has a spec,
  // because that is how bash works: `sudo` has one, and its function shifts the
  // position itself, which is why `sudo docker r<TAB>` reaches docker's. The
  // loader call is what makes this possible at all — a bare `complete -p git`
  // answers nothing until that command's completion has been loaded once.
  'spec=""',
  'compcmd=""',
  'for ((w = 0; w <= COMP_CWORD; w++)); do',
  '  candidate=${COMP_WORDS[$w]:-}',
  '  [ -n "$candidate" ] || continue',
  '  if type -t _completion_loader >/dev/null 2>&1; then _completion_loader "$candidate" 2>/dev/null; fi',
  '  probe=$(complete -p -- "$candidate" 2>/dev/null)',
  '  if [ -n "$probe" ]; then spec=$probe; compcmd=$candidate; break; fi',
  'done',
  // No spec is an answer of its own: the caller falls back rather than guessing.
  'if [ -z "$spec" ]; then echo DSHELL_NOSPEC; exit 0; fi',
  'compfn=""',
  'compact=""',
  'compword=""',
  'case "$spec" in *" -F "*) compfn=$(printf %s "$spec" | sed -n "s/.* -F \\([^ ]*\\).*/\\1/p") ;; esac',
  'case "$spec" in *" -A "*) compact=$(printf %s "$spec" | sed -n "s/.* -A \\([^ ]*\\).*/\\1/p") ;; esac',
  'case "$spec" in *" -W "*) compword=$(printf %s "$spec" | sed -n "s/.* -W \\([^ ]*\\).*/\\1/p") ;; esac',
  'COMPREPLY=()',
  // In order, and once: a function wins over the `-A`/`-W` fallbacks because a
  // spec can carry both, and the function is the more specific of the two.
  'if [ -n "$compfn" ]; then',
  '  "$compfn" "$compcmd" "$curword" "$prevword" >/dev/null 2>&1',
  'elif [ -n "$compword" ]; then',
  '  COMPREPLY=($(compgen -W "$compword" -- "$curword"))',
  'elif [ -n "$compact" ]; then',
  '  COMPREPLY=($(compgen -A "$compact" -- "$curword"))',
  'fi',
  'echo DSHELL_BEGIN',
  'if [ "${#COMPREPLY[@]}" -gt 0 ]; then printf %s\\\\n "${COMPREPLY[@]}"; fi',
  'echo DSHELL_END',
]

/** The probe script as one string. See {@link PROBE_LINES} for the rules it obeys. */
export const ORACLE_PROBE = PROBE_LINES.join('\n')

/** Where the probe's candidate list sits between the markers. */
const BEGIN = 'DSHELL_BEGIN'
const END = 'DSHELL_END'
/** What the probe says when no completion spec is registered for the line. */
const NOSPEC = 'DSHELL_NOSPEC'

/** Longest a probe may take before its world is treated as not answering. */
const PROBE_TIMEOUT_MS = 4_000

/** Bytes of stdout the probe may return: a subcommand list, never a file dump. */
const PROBE_STDOUT_BYTES = 64 * 1024

/** Candidates one oracle answer carries, before the route's own cap applies. */
const MAX_ORACLE_NAMES = 400

/**
 * Read the probe's stdout.
 *
 * @param stdout - everything the probe printed.
 * @returns the candidates, or undefined when the shell had no spec to apply
 *   (which is an ANSWER: it tells the caller to fall back rather than guess) or
 *   the output could not be read.
 */
export function parseProbeOutput(stdout: string): readonly string[] | undefined {
  if (stdout.includes(NOSPEC)) return undefined
  const begin = stdout.indexOf(BEGIN)
  const end = stdout.indexOf(END, begin + 1)
  if (begin < 0 || end < begin) return undefined
  const body = stdout.slice(begin + BEGIN.length, end)
  const names: string[] = []
  const seen = new Set<string>()
  for (const raw of body.split('\n')) {
    // bash-completion's items carry the trailing space that says "this word is
    // finished" (`checkout `), and its `-o nospace` specs leave it out. Which
    // suffix follows a taken candidate is the CLIENT's rule (see the composer's
    // apply), so the space is dropped here rather than transported.
    const name = raw.trim()
    if (name.length === 0 || seen.has(name)) continue
    seen.add(name)
    names.push(name)
    if (names.length >= MAX_ORACLE_NAMES) break
  }
  return names
}

/**
 * One cached oracle answer, as the prefix it was asked about.
 *
 * The prefix is part of the entry rather than the key alone because a shell's
 * answer for a SHORTER word usually contains the answer for a longer one that
 * extends it (`docker r` returns rename/restart/rm/rmi/run, and `docker re` is a
 * local filter of exactly that). Reusing it costs nothing and saves the round
 * trip that dominates a device session.
 */
interface OracleAnswer {
  readonly at: number
  readonly names: readonly string[]
}

/** How long one context's answers stay usable. */
const CACHE_TTL_MS = 60_000
/** Prefixes kept per context, newest first. */
const CACHE_PREFIXES = 6
/** Contexts kept per session, oldest evicted first. */
const CACHE_CONTEXTS = 200

/**
 * The oracle's answers, keyed by the context they were asked in.
 *
 * A completion function reads the whole line, so the only honest cache key is
 * the line itself — which would cache nothing. What it does NOT commonly depend
 * on is the word being typed: nearly every function filters one name list by
 * that word, so an answer for `docker r` is the answer for `docker re` too, and
 * the cache is therefore keyed by CONTEXT (the command and the word before the
 * caret) and stores each answer under the prefix it was asked for. A lookup
 * takes the longest stored prefix that the requested one extends and filters
 * locally; when that comes back empty the caller must ask the world again, since
 * an empty filter means the cached list was not a superset.
 */
export class OracleCache {
  private readonly contexts = new Map<string, Map<string, OracleAnswer>>()
  /**
   * One probe per context-and-prefix on the wire at a time.
   *
   * A device answers a probe with a process of its own, and the warm that runs
   * while the reader is typing is still on the wire when they press Tab often
   * enough that it matters: without this, the keystroke would start a second
   * probe for the answer the first one is already fetching.
   */
  private readonly probes = new SingleFlight<readonly string[] | undefined>()

  /**
   * Run one probe, shared with whoever else is waiting for the same one.
   *
   * @param key - the context and the prefix the answer is for.
   * @param produce - the probe itself.
   */
  probe(key: string, produce: () => Promise<readonly string[] | undefined>): Promise<readonly string[] | undefined> {
    return this.probes.join(key, produce)
  }

  /**
   * @param context - key for what the answer depends on besides the typed word
   *   (the command and the word before it).
   * @param prefix - the word being completed, as typed.
   * @param now - millisecond clock, injected so a spec can move time.
   * @returns the candidates that extend `prefix`, or undefined when nothing
   *   cached can answer.
   */
  lookup(context: string, prefix: string, now: number): readonly string[] | undefined {
    const answers = this.contexts.get(context)
    if (answers === undefined) return undefined
    let best: string | undefined
    for (const [stored, answer] of answers) {
      if (now - answer.at > CACHE_TTL_MS) { answers.delete(stored); continue }
      if (!prefix.startsWith(stored)) continue
      if (best === undefined || stored.length > best.length) best = stored
    }
    if (best === undefined) return undefined
    if (answers.size === 0) this.contexts.delete(context)
    const names = (answers.get(best) as OracleAnswer).names.filter(name => name.startsWith(prefix))
    return names.length === 0 ? undefined : names
  }

  /**
   * @param context - as {@link lookup}.
   * @param prefix - the word this answer was asked about.
   * @param names - what the probe answered.
   * @param now - millisecond clock.
   */
  store(context: string, prefix: string, names: readonly string[], now: number): void {
    let answers = this.contexts.get(context)
    if (answers === undefined) {
      answers = new Map()
      this.contexts.set(context, answers)
    }
    answers.set(prefix, { at: now, names })
    while (answers.size > CACHE_PREFIXES) {
      const oldest = answers.keys().next()
      if (oldest.done === true) break
      answers.delete(oldest.value)
    }
    while (this.contexts.size > CACHE_CONTEXTS) {
      const oldest = this.contexts.keys().next()
      if (oldest.done === true) break
      this.contexts.delete(oldest.value)
    }
  }
}

/** What one ask needs to know: the line, the caret, and where to run. */
export interface OracleAsk {
  readonly line: string
  readonly cursor: number
  /** The context key: the command and the word before the caret. */
  readonly context: string
  /** The word being completed, as typed. */
  readonly prefix: string
  /** Directory the probe runs in, in the session's world (the shell's own). */
  readonly workdir: string
  /** The world's root, for the read-only policy below. */
  readonly root: string
}

/**
 * Ask that world's shell what completes here.
 *
 * @param ctx - host context holding the shell service.
 * @param agent - the session's agent, so the shell seam routes to its world.
 * @param ask - the line, the caret, and where to run.
 * @param cache - this route's cache, consulted first and filled on a miss.
 * @returns the candidates, or undefined when the world answered nothing.
 */
export async function askShell(
  ctx: Context,
  agent: Agent,
  ask: OracleAsk,
  cache: OracleCache,
): Promise<readonly string[] | undefined> {
  const cached = cache.lookup(ask.context, ask.prefix, Date.now())
  if (cached !== undefined) return cached
  // The line and the caret ride the command line as ARGUMENTS (their own shell
  // words, quoted once by `quote`), never as text inside the script: completion
  // reads what the reader typed, and nothing it typed may become syntax.
  return await cache.probe(`${ask.context}\u0000${ask.prefix}`, async () => {
    const result = await runInWorld(ctx, agent, {
      command: `bash -c ${quote(ORACLE_PROBE)} dshell-probe ${quote(ask.line)} ${quote(String(ask.cursor))}`,
      workdir: ask.workdir,
      root: ask.root,
      timeoutMs: PROBE_TIMEOUT_MS,
      stdoutMaxBytes: PROBE_STDOUT_BYTES,
    })
    if (result === undefined) return undefined
    const names = parseProbeOutput(result.stdout.text)
    // An empty answer is NOT cached. "This world has no completion for that
    // command" is stable, but "the function looked at the directory and found
    // nothing yet" is not, and the two are indistinguishable from here.
    if (names === undefined || names.length === 0) return names
    cache.store(ask.context, ask.prefix, names, Date.now())
    return names
  })
}
