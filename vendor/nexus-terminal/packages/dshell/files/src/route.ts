/**
 * The file navigator's route: one exact `/api` endpoint behind dsh's existing
 * trust and authentication fence, mirroring the other dshell routes.
 *
 * Five actions, all against ONE directory, in the session's own execution
 * world. The world is chosen by the filesystem seam itself, not here: every call
 * runs inside `ctx.agents.withInitiator`, and `ctx.fs` resolves the ambient
 * session — a device-bound session's tree is read over its own SSH route, this
 * machine's otherwise. That is also why the walk is unbounded: the routing
 * helper passes an absolute path outside the session's mount directory through
 * unchanged, so on a device `/etc` means the device's `/etc`.
 *
 *  - `list` reads the directory.
 *  - `cd` moves the session's main shell into it, which is the one way to move
 *    an interactive shell: its working directory is process state, so a command
 *    run through the shell seam would not touch it. The input therefore goes to
 *    the terminal bridge's own input path, the same one a keystroke takes, so
 *    the command is tracked and rendered like any command the user types. It is
 *    the bridge's session-keyed entry, so the path handed over is the canonical
 *    one in that world — a device session's shell cds on the device.
 *  - `resolve` canonicalizes one path without moving anything, which is how the
 *    composer learns what a `cd` did.
 *  - `complete` answers the composer's shell line: which source answers is
 *    decided by the LINE itself (`./shell-line.ts` in the standard layer), so
 *    the command position is a position rather than "the first word".
 *  - `warm` asks the same questions in the background, so that a Tab pressed a
 *    moment later finds the answers in memory. It exists because a device world
 *    answers each of them with a process of its own, and paying for three of
 *    those on the keystroke is what made Tab feel slow there; see `./readings.ts`.
 *
 * Listing is a read, and every sandbox mode permits reads (the policy fence
 * covers mutations only), so this route adds no gate the session did not
 * already have through `read`.
 */

import { homedir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { Context } from '@deepseek-ai/cordis'
import type { DshellTerminalBridge } from '@nexus-aethra/dshell-terminal-bridge'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
// Type-only: pulls the shell service merge (`ctx.shell`), which the command
// list uses to ask a device world for its PATH.
import type {} from '@deepseek-ai/dsh-shell'
// Type-only: pulls the session-controller service merge (`ctx.sessionController`).
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  DSHELL_FILES_PATH, type DshellCompletion, type DshellCompletionCandidate, type DshellCompletionKind,
  type DshellFileEntry, type DshellFileKind, type DshellFilesListing, type DshellFilesRequest,
  type DshellFilesResponse,
} from './protocol.js'
// The line scanner straight from the shared layer: it is not part of this
// route's wire vocabulary (the browser half reads the same module), so it is not
// re-exported through `./protocol.js` — that module exists to hold the shapes
// this route answers with.
import { readShellCaret, type ShellCaret } from '@nexus-aethra/dshell-std'
import { readingKey, ReadingCache, type DirectoryReading } from './readings.js'
import { askShell, OracleCache } from './shell-completion.js'
import { quote } from './shell-quote.js'
import { runInWorld } from './world-shell.js'
import type { TransferRoutingSeat } from './transfer.js'

/**
 * Entries one listing returns before it is reported truncated.
 *
 * A directory of this size is already unusable as a list, and the cap keeps one
 * request from pushing a whole tree through the browser in a single frame.
 */
const MAX_ENTRIES = 1000

/**
 * Candidates one completion answers with.
 *
 * A completion menu is read by eye, and past a screenful the useful move is to
 * keep typing rather than scroll — so the cap is small and the answer says it
 * was cut.
 */
const MAX_COMPLETIONS = 60

/**
 * How long a session's command list is trusted.
 *
 * Long enough that typing is never blocked by a PATH walk, short enough that an
 * install shows up in the same working session.
 */
const COMMAND_CACHE_MS = 300_000

/** A PATH probe reads one variable; it must not outlive a blink. */
const COMMAND_PROBE_TIMEOUT_MS = 5_000

/** Bytes a PATH probe may return: a variable, not a directory. */
const COMMAND_PROBE_STDOUT_BYTES = 4 * 1024

/** JSON response in the shape the browser face parses. */
function respond(body: DshellFilesResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Resolve one session, and one directory in its world.
 *
 * Both actions start here, so "the session can be resumed" and "this is really
 * a directory" are stated once. The resolved target is canonical, and its key is
 * the absolute path in that world — the string both the listing and the shell
 * command are built from.
 *
 * @param routing - the ssh routing seat, which decides what "no directory named"
 *   means for a session that runs on a device (see {@link sessionDirectory}).
 */
async function openDirectory(
  ctx: Context,
  routing: () => TransferRoutingSeat | undefined,
  sessionId: string,
  path: string | undefined,
): Promise<{ agent: Agent; target: FsTarget }> {
  const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId))
  if ('error' in resolved) throw new Error(`会话不可用：${resolved.error.code}`)
  const agent = resolved.agent
  const home = sessionDirectory(routing, sessionId, agent.session.header.cwd)
  const start = path === undefined || path.trim().length === 0 ? home : path.trim()
  if (start === undefined) throw new Error('这个会话没有工作目录，且请求没有给出路径')
  const options = home === undefined ? {} : { cwd: home }

  // Every call is made as the session, synchronously entering the seam so the
  // provider reads the right initiator.
  const target = await ctx.agents.withInitiator(agent, () => ctx.fs.resolve(start, options))
  const info = await ctx.agents.withInitiator(agent, () => ctx.fs.stat(target))
  if (info === undefined) throw new Error(`目录不存在：${String(target.targetKey)}`)
  if (info.type !== 'directory') throw new Error(`不是目录：${String(target.targetKey)}`)
  return { agent, target }
}

/** One directory reading, as the session that owns the world. */
async function list(
  ctx: Context,
  routing: () => TransferRoutingSeat | undefined,
  sessionId: string,
  path: string | undefined,
  canCd: boolean,
): Promise<DshellFilesListing> {
  const { agent, target } = await openDirectory(ctx, routing, sessionId, path)
  const children = await ctx.agents.withInitiator(agent, () => ctx.fs.listDir(target))
  const entries: DshellFileEntry[] = children.slice(0, MAX_ENTRIES).map(child => ({
    name: child.name,
    kind: child.type,
    ...child.size === undefined ? {} : { size: child.size },
  }))
  return {
    path: String(target.targetKey),
    entries,
    truncated: children.length > MAX_ENTRIES,
    canCd,
  }
}

/** Send the session's shell into one directory, and answer with that directory. */
async function cd(
  ctx: Context,
  routing: () => TransferRoutingSeat | undefined,
  bridge: DshellTerminalBridge,
  sessionId: string,
  path: string | undefined,
): Promise<string> {
  const directory = String((await openDirectory(ctx, routing, sessionId, path)).target.targetKey)
  // `\r` is the byte dsh's own terminal backend appends for "run this"; the
  // bridge's input path is raw, so the newline is ours to add.
  bridge.feed(sessionId, `cd ${quote(directory)}\r`)
  return directory
}

/**
 * The commands that take a directory and nothing else.
 *
 * `cd` is the reason this exists at all, and a completion that offered a file
 * there would be offering something the shell refuses. The mirror-image rule —
 * a command that takes only FILES — is not expressible this way, which is why
 * there is no `file` counterpart: a path is completed a segment at a time, so
 * `less logs/app.log<Tab>` has to pass through `logs/` before it ever names a file.
 */
const CD_COMMANDS = new Set(['cd', 'chdir', 'pushd', 'popd'])

/** The home of a session's world: a device's remote root, or this machine's. */
function worldHome(routing: () => TransferRoutingSeat | undefined, sessionId: string): string {
  return routing()?.targetForSession(sessionId)?.remoteRoot ?? homedir()
}

/** Whether `child` is `parent` or lies inside it; lexical, like the seam's own check. */
function under(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * The directory a session stands in, spelled in the world that answers for it.
 *
 * A session's own working directory is a path on THIS machine, and for a session
 * that runs on a device the harness cannot move it: it was created here, and the
 * device's tree is reached through the mount directory standing in for it. So a
 * session whose directory is neither that mount nor anything under it has a
 * directory that names no place in its world at all — a terminal session is
 * created in the reader's home and only afterwards pointed at a device, and
 * `/home/reader` on the device is somebody else's directory or nobody's.
 *
 * For those the answer is the device's own root, which is where its shell
 * already is. A session created in the mount keeps its directory: the seam
 * translates that one, and translating it here too would lose the subdirectory.
 *
 * @param routing - the ssh routing seat, when one is composed.
 * @param sessionId - session whose directory is being asked for.
 * @param cwd - the directory as this machine spells it, or undefined.
 * @returns the directory to resolve against, in the answering world's namespace.
 */
export function sessionDirectory(
  routing: () => TransferRoutingSeat | undefined,
  sessionId: string,
  cwd: string | undefined,
): string | undefined {
  const bound = routing()?.targetForSession(sessionId)
  if (bound === undefined) return cwd
  if (cwd !== undefined && bound.mount !== undefined && under(bound.mount, cwd)) return cwd
  return bound.remoteRoot
}

/**
 * Which machine a session's answers come from.
 *
 * Part of every cache key that holds an answer about a world: two sessions on
 * this machine may share one, and a session bound to a device is another machine
 * with its own bash-completion, installed packages and files. A device answer
 * served out of this machine's cache is the mistake this key exists to prevent —
 * it happened once, to the oracle.
 *
 * @param routing - the ssh routing seat, when one is composed.
 * @param sessionId - the session whose world to name.
 * @returns the device id, or `local` for a session that runs here.
 */
function worldOf(routing: () => TransferRoutingSeat | undefined, sessionId: string): string {
  return routing()?.targetForSession(sessionId)?.device.id ?? 'local'
}

/**
 * Expand a leading `~` against that home. The filesystem seam does not do it —
 * `resolve('~')` answers `<cwd>/~` — so both the completion and the `cd` mirror
 * have to, in the session's own world rather than this process's.
 */
function expandHome(value: string, home: string): string {
  if (!value.startsWith('~')) return value
  return `${home.replace(/\/+$/u, '')}${value.slice(1)}`
}

/**
 * Fold A–Z in a name, so a typed prefix can be compared the way a reader reads
 * it rather than the way the filesystem stores it.
 *
 * Every path this route looks up stays exact — the lookup is the shell's, in
 * the shell's own world — but a *completion* is a guess about what the reader
 * meant. Typing the wrong case is the ordinary way to miss a directory whose
 * name is already on the screen, and the answer costs nothing: fold for the
 * comparison, hand back the real spelling, and choosing that candidate (or
 * being the only one, which applies it outright) rewrites the line with the
 * true name. The key that opens the list is then the key that corrects it.
 *
 * Only capitals fold, and only the ASCII ones. The mistake being repaired is a
 * missed shift on a Latin letter; a locale-aware fold would start equating
 * names that are not the same name in other scripts (a Turkish dotless i, the
 * Kelvin sign), and could change the length of the string the candidate offsets
 * are measured in.
 */
function foldAscii(value: string): string {
  return value.replace(/[A-Z]/gu, char => char.toLowerCase())
}

/**
 * The directory readings the completion path asks its world for, kept briefly.
 *
 * Why a completion remembers them at all, and why for seconds rather than
 * minutes, is the whole argument in `./readings.ts`: a device answers one of
 * these with a process of its own (~0.4 s), a Tab used to need three of them,
 * and the listing is the one answer a reader compares against their own screen.
 */
const readingCache = new ReadingCache();

/**
 * One directory reading inside the session's world.
 *
 * The two misses are kept apart because the reader is told which one happened:
 * an absent path and a path that is a file are different mistakes, and only the
 * first is worth recovering from capitals.
 */
async function readDirectory(
  ctx: Context,
  agent: Agent,
  path: string,
  base: string | undefined,
): Promise<DirectoryReading> {
  const options = base === undefined ? {} : { cwd: base }
  const target = await ctx.agents.withInitiator(agent, () => ctx.fs.resolve(path, options))
  const info = await ctx.agents.withInitiator(agent, () => ctx.fs.stat(target))
  const dir = String(target.targetKey)
  if (info === undefined) return { ok: false, dir, note: 'noDirectory' }
  if (info.type !== 'directory') return { ok: false, dir, note: 'notDirectory' }
  const children = await ctx.agents.withInitiator(agent, () => ctx.fs.listDir(target))
  return { ok: true, dir, children }
}

/**
 * The same reading, once per key per few seconds.
 *
 * @param world - the world the path lives in, which is part of the cache key:
 *   two sessions on this machine share their readings, and a session bound to a
 *   device is another machine whose directories must never be answered from
 *   this one's cache.
 */
async function readDirectoryCached(
  ctx: Context,
  agent: Agent,
  path: string,
  base: string | undefined,
  world: string,
): Promise<DirectoryReading> {
  return await readingCache.read(
    readingKey(world, path, base),
    () => readDirectory(ctx, agent, path, base),
  )
}

/**
 * Complete the directory a token ended with, when the exact path was not one.
 *
 * `ls neXus-shell/<Tab>` asks for the contents of a directory stored as
 * `Nexus-shell`. The reading misses, but only because of capitals, and the
 * repair is the one the trailing segment already gets: the answer completes
 * THAT segment — one candidate per folded match, spelled the way the
 * filesystem spells it, replacing the segment and the slash the reader typed.
 * The line is corrected, and the next Tab lists the directory, which is what
 * the slash asked for.
 *
 * Only a miss reaches here, so a path that exists is used exactly as written
 * and a correctly spelled directory is never re-read as a different one that
 * happens to differ in case. A file is no candidate: the reader wrote a slash,
 * and only a directory can answer one.
 *
 * @returns the completion for the segment, or undefined when the token has no
 *   segment of its own, the parent cannot be read, or nothing folds to it — the
 *   caller then reports its own miss for the path as typed.
 */
async function completeDirectorySegment(
  ctx: Context,
  agent: Agent,
  token: ShellCaret,
  base: string | undefined,
  home: string,
  world: string,
): Promise<DshellCompletion | undefined> {
  // `dirPart` ends AT the last slash, so its own last segment is the name to
  // complete and everything before it is the directory to complete it in.
  const head = token.dirPart.replace(/\/+$/u, '')
  const slash = head.lastIndexOf('/')
  const parentPart = slash < 0 ? '' : head.slice(0, slash + 1)
  const segment = head.slice(slash + 1)
  // Something after the last slash means the reader is completing a name INSIDE
  // a directory that did not resolve; correcting the directory would have to
  // rewrite text the candidate does not own, so this stays a plain miss.
  if (segment.length === 0 || token.prefix.length > 0) return undefined
  const rawParent = expandHome(parentPart, home)
  const parent = rawParent.length === 0 ? base : rawParent
  if (parent === undefined) return undefined
  const reading = await readDirectoryCached(ctx, agent, parent, base, world)
  if (!reading.ok) return undefined
  const needle = foldAscii(segment)
  const matched = reading.children
    .filter(child => child.type === 'directory' && foldAscii(child.name).startsWith(needle))
    .sort((left, right) => left.name.localeCompare(right.name))
  if (matched.length === 0) return undefined
  // The segment starts after everything the token keeps, and — because the token
  // ends at its slash — runs to the cursor, so the reader's slash goes with it.
  const segmentStart = token.start - token.dirPart.length + parentPart.length
  const candidates: DshellCompletionCandidate[] = matched.slice(0, MAX_COMPLETIONS).map(child => ({
    name: child.name,
    kind: 'directory' as DshellFileKind,
    hint: '目录',
  }))
  return {
    start: segmentStart,
    end: token.start,
    dir: reading.dir,
    candidates,
    truncated: matched.length > MAX_COMPLETIONS,
    position: token.position,
  }
}

/** One line's completion, resolved in the session's own world. */
async function complete(
  ctx: Context,
  routing: () => TransferRoutingSeat | undefined,
  sessionId: string,
  line: string,
  cursor: number,
  cwd: string | undefined,
  shellCwd: string | undefined,
  phase: 'fast' | 'refine',
): Promise<DshellCompletion | undefined> {
  // What the line expects where the caret is, and where the word it replaces
  // starts and ends. The reading is the SHELL's (std's rule table): the position
  // is a property of the line, and both halves of this feature must not each
  // decide it — a first-word rule and a client-side "looks like a path" guess is
  // what drifted before. A blank line, or an operator under the caret, has
  // nothing to complete and says so.
  const caret = readShellCaret(line, cursor)
  if (caret === undefined) return undefined
  const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId))
  if ('error' in resolved) throw new Error(`会话不可用：${resolved.error.code}`)
  const agent = resolved.agent
  // The shell runs in the session's world, so a bare token completes against
  // the directory the terminal stands in. Where the shell IS outranks every
  // mirror of it: the bridge reads a local shell's own process cwd, so a `cd`
  // typed in, fed by the file navigator, or spelled in a way the composer's
  // line scanner refuses all land here. The composer's tracked value is the
  // fallback for a session whose shell cannot be read (a device's `ssh`), and
  // `~` resolves against that world's home either way.
  const base = shellCwd ?? sessionDirectory(
    routing, sessionId, cwd !== undefined && cwd.length > 0 ? cwd : agent.session.header.cwd,
  )
  const home = worldHome(routing, sessionId)
  const world = worldOf(routing, sessionId)
  const refine = phase === 'refine'
  const refinable = shellCouldKnowMore(caret)
  if (!refine) {
    // The fast pass. It is EMPTY on purpose whenever the session's own shell is
    // about to be asked about this line, and — on a device — that is also the
    // difference between a Tab and a second of waiting: a directory read is
    // three round trips there (see `./readings.ts`), and it is the fallback for a
    // shell that turns out to have nothing, not the answer. The refine branch
    // below pays for it in exactly that case, and only then.
    return await completeFast(
      ctx, routing, sessionId, agent, caret, base, home, refinable, !refinable, world,
    )
  }
  if (!refinable) {
    return await completeFast(ctx, routing, sessionId, agent, caret, base, home, false, true, world)
  }
  const asked = await completeByShell(ctx, routing, sessionId, agent, caret, line, cursor, base, home)
  // The shell's answer REPLACES the fast one when it has one; when it does not,
  // the file system's is the answer — read now rather than earlier, so the
  // ordinary case never paid for it. A miss must never take a candidate away: a
  // path listing the reader is already looking at is a real answer even if the
  // shell has nothing to add to it.
  if (asked !== undefined) return asked
  return await completeFast(ctx, routing, sessionId, agent, caret, base, home, false, true, world)
}

/**
 * Fill this process's caches for the line the reader is typing.
 *
 * The whole point is that nobody waits for it: a warm answers with nothing, and
 * what it fetches sits in the caches the next Tab reads (see `./readings.ts`).
 * What it warms is exactly what a Tab on that line would ask for, decided by the
 * same dispatch `complete` uses — so it cannot warm something a Tab would not
 * have wanted, and a Tab that arrives while a warm is still on the wire JOINS it
 * rather than starting a second one (the single-flight in both caches).
 *
 * Nothing here may surface. A warm is a guess about what the reader does next,
 * and a guess that fails must cost them nothing: every failure is a failure to
 * have something ready, never an error on a line they are still typing.
 *
 * @param oracle - whether the session's own shell may be asked as well. The
 *   switch for that lives in the browser (like every other dshell switch), so
 *   the browser is the side that has to say: a warm that probed anyway would run
 *   a process per context for a reader who turned the oracle off.
 */
async function warm(
  ctx: Context,
  routing: () => TransferRoutingSeat | undefined,
  sessionId: string,
  line: string,
  cursor: number,
  cwd: string | undefined,
  shellCwd: string | undefined,
  oracle: boolean,
): Promise<void> {
  const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId))
  if ('error' in resolved) return
  const agent = resolved.agent
  const base = shellCwd ?? sessionDirectory(
    routing, sessionId, cwd !== undefined && cwd.length > 0 ? cwd : agent.session.header.cwd,
  )
  const home = worldHome(routing, sessionId)
  const world = worldOf(routing, sessionId)
  const caret = readShellCaret(line, cursor)
  if (caret === undefined) {
    // A line that names no word — which is what the composer holds right after a
    // command was sent, and the moment the world has just changed: the shell may
    // have moved, files may have appeared or gone. What a Tab here would read is
    // the directory the shell stands in (`cd <Tab>` and `ls <Tab>` both list it)
    // plus the command list a fresh word comes from. Reading it now costs the
    // reader nothing, because it happens while they read the command's output.
    if (base !== undefined && base.length > 0) {
      void readDirectoryCached(ctx, agent, base, base, world).catch(() => undefined)
    }
    await commandNames(ctx, routing, sessionId, agent).catch(() => undefined)
    return
  }
  const refinable = shellCouldKnowMore(caret)
  // Both halves of what a Tab on this line asks for, and both started before
  // either is awaited: the shell's own vocabulary (the answer the reader is
  // waiting for on a flag or a bare word), and the directory this side answers
  // from — which a Tab reads twice, once to have something on screen and again
  // as the fallback when the shell turns out to have nothing to add. The second
  // read is why this is not simply "warm whatever the fast pass warms": on a
  // device the fallback is three round trips, and the whole point is that the
  // reader never waits for them.
  const probed = refinable && oracle
    ? completeByShell(ctx, routing, sessionId, agent, caret, line, cursor, base, home)
    : Promise.resolve(undefined)
  await completeFast(ctx, routing, sessionId, agent, caret, base, home, refinable, true, world)
  await probed
}

/**
 * Read one directory into the cache, in the world it belongs to.
 *
 * This is the pre-warm the feature leans on hardest, because it is the earliest
 * moment the next Tab's answer is knowable: a reader cannot complete inside a
 * directory before they are standing in it, so a `cd` that RESOLVES is the
 * promise. Reading it then costs them nothing — they are looking at a prompt —
 * and it is the only trigger that can cover `cd /var/log` followed by a Tab,
 * which no keystroke warm can (the key comes before the directory exists as
 * something this side knows about).
 *
 * @param dir - the directory, canonical, in the session's own world.
 */
async function warmDirectory(
  ctx: Context,
  routing: () => TransferRoutingSeat | undefined,
  sessionId: string,
  dir: string,
): Promise<void> {
  const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId))
  if ('error' in resolved) return
  // The base is the directory itself: a completion inside it resolves a relative
  // word against where the shell stands, which is exactly this.
  await readDirectoryCached(ctx, resolved.agent, dir, dir, worldOf(routing, sessionId))
}

/**
 * Whether the session's own shell could answer better than this side can.
 *
 * Two positions, and each is here for its own reason. A FLAG cannot be answered
 * from a directory at all — the file system has no idea that `--force` belongs
 * to `docker rm` — so asking is the only way it gets an answer. A bare WORD in
 * an argument position is where a shell keeps its own vocabulary (subcommands,
 * targets, branches) and where the file system is a guess: `git ch<Tab>` finds
 * nothing in the directory, and `ch` is not a path. Everything else is already
 * answered by the side that knows: a word with a path in it is the file
 * system's question, `cd` takes a directory and nothing else can be right, and
 * a command name comes from the PATH walk, which is both cheaper and more
 * complete than what `complete -A command` would give.
 */
function shellCouldKnowMore(caret: ShellCaret): boolean {
  if (caret.position === 'flag') return true
  if (caret.position !== 'argument') return false
  if (caret.command !== undefined && CD_COMMANDS.has(caret.command)) return false
  return caret.dirPart === '' && !caret.prefix.startsWith('~') && !caret.prefix.startsWith('.')
}

/**
 * The word before the caret's, as a shell completion function reads it.
 *
 * @param line - the line as typed.
 * @param caret - the caret's reading.
 * @returns that word, or `''` when the caret's word is the first one.
 */
function previousWord(line: string, caret: ShellCaret): string {
  const match = /(\S+)\s*$/u.exec(line.slice(0, caret.start - caret.dirPart.length))
  return match?.[1] ?? ''
}

/**
 * Ask the session's own shell what completes here — the completion oracle.
 *
 * @returns the completion its answer makes, or undefined when the shell had
 *   nothing to say (no spec registered for the line, an empty list, or a world
 *   that could not be asked). The caller then keeps the fast answer.
 */
async function completeByShell(
  ctx: Context,
  routing: () => TransferRoutingSeat | undefined,
  sessionId: string,
  agent: Agent,
  caret: ShellCaret,
  line: string,
  cursor: number,
  base: string | undefined,
  home: string,
): Promise<DshellCompletion | undefined> {
  // Which world answers is part of the question. Two sessions on this machine
  // share one world and may share one answer; a session bound to a device is a
  // different machine with its own bash-completion, its own installed packages
  // and its own paths, so its answer must never come out of this one's cache.
  const world = worldOf(routing, sessionId)
  const names = await askShell(ctx, agent, {
    line,
    cursor,
    // What the answer depends on besides the typed word: the world, which
    // command's completion applies, and the word before this one — a function
    // reads the last two, so an answer cached for one pair must not be served
    // for another.
    context: `${world}\u0000${caret.command ?? ''}\u0000${previousWord(line, caret)}`,
    prefix: caret.prefix,
    workdir: base ?? home,
    root: home,
  }, oracleCache)
  if (names === undefined || names.length === 0) return undefined
  return {
    start: caret.start,
    end: caret.end,
    // The command whose own completion answered, which is the provenance worth
    // showing: `--force` came from docker's completion, not from a directory and
    // not from the PATH.
    dir: caret.command ?? 'shell',
    candidates: names.slice(0, MAX_COMPLETIONS).map(name => ({
      name,
      kind: (name.length > 1 && name.startsWith('-') ? 'flag' : 'word') as DshellCompletionKind,
    })),
    truncated: names.length > MAX_COMPLETIONS,
    position: caret.position,
  }
}

/**
 * The half of the answer this side can give: the PATH cache for a command, a
 * directory read in the session's world for anything path-shaped, and the
 * positions that get an empty answer rather than a wrong KIND of one.
 *
 * @param pending - whether a refine is already on its way for this line, which
 *   the browser has to know before it draws an empty answer.
 * @param allowRead - whether this side may go and READ its world when the
 *   directory is not already in memory. False on a fast pass whose line the
 *   session's own shell is about to answer: the file system is the fallback
 *   there, and on a device a fallback that costs three round trips is worth
 *   asking for only once the shell has actually declined (see `complete`).
 * @param world - the machine the path's answers come from, for the cache key.
 */
async function completeFast(
  ctx: Context,
  routing: () => TransferRoutingSeat | undefined,
  sessionId: string,
  agent: Agent,
  caret: ShellCaret,
  base: string | undefined,
  home: string,
  pending: boolean,
  allowRead: boolean,
  world: string,
): Promise<DshellCompletion | undefined> {
  // The command position completes from the commands the session's world offers
  // rather than from the directory the shell stands in — which is now decided by
  // the LINE (`sudo dock<Tab>`, `pwd; dock<Tab>` and `xargs dock<Tab>` all land
  // here), not by a word happening to be first. A command word with a slash is
  // still a path (`./build.sh<Tab>`, `/usr/bin/doc<Tab>`): it names a file in the
  // world, and the PATH's names cannot answer it.
  if (caret.position === 'command' && caret.dirPart === '' && caret.prefix.length > 0) {
    return await completeCommand(ctx, routing, sessionId, agent, caret)
  }
  // Build this session's command list in the background, whoever asked for what.
  // A device world answers each directory over its own route, so the FIRST
  // command completion there costs a probe plus a round trip per directory —
  // seconds, where every later one is a cache hit. Starting the walk from a path
  // completion (which is what a reader does first) usually has the list ready by
  // the time a Tab asks for it. Fire and forget: a world that cannot be read
  // answers nothing, and the Tab that needs the list reports its own miss.
  void commandNames(ctx, routing, sessionId, agent).catch(() => { /* see above */ })
  // Nothing here answers a flag: the directory's files would be a wrong KIND of
  // answer (`ls -la<Tab>` is not asking for `-launcher.sh`). So the fast pass is
  // empty on purpose, and its `pending` is what tells the browser that the real
  // answer — the shell's — is still coming.
  if (caret.position === 'flag') {
    if (!pending) return undefined
    return {
      start: caret.start, end: caret.end, dir: 'shell', candidates: [], truncated: false,
      position: 'flag', pending: true,
    }
  }
  // `cd` and its relatives take a directory and nothing else, so a file in that
  // list would be a candidate the shell refuses. Everything else — including a
  // redirection's target — is a path, and a path is walked a segment at a time,
  // so directories answer there too (`> logs/app.log<Tab>` passes through `logs/`).
  const directoryOnly = caret.command !== undefined && CD_COMMANDS.has(caret.command)
  return await completePath(
    ctx, agent, caret, base, home, directoryOnly ? 'directory' : 'any', pending, allowRead, world,
  )
}

/**
 * Complete one word of the line as a path in the session's world.
 *
 * @param want - what can answer: `directory` for a command that takes one
 *   (`cd`), `any` everywhere else.
 * @param pending - whether the shell is still going to be asked about this
 *   line, which every answer here carries through (see `DshellCompletion.pending`).
 * @param allowRead - whether a cold reading may be taken from the world; false
 *   answers the cache or says nothing (see `completeFast`).
 * @param world - the machine this path's answers come from, for the cache key.
 */
async function completePath(
  ctx: Context,
  agent: Agent,
  caret: ShellCaret,
  base: string | undefined,
  home: string,
  want: 'any' | 'directory',
  pending: boolean,
  allowRead: boolean,
  world: string,
): Promise<DshellCompletion | undefined> {
  // A lonely `~` names a directory, and nothing is named "~": the answer is the
  // tilde itself, so the composer writes `~/` and the next Tab lists it.
  if (caret.dirPart === '' && caret.prefix === '~') {
    return {
      start: caret.start,
      end: caret.end,
      dir: home,
      candidates: [{ name: '~', kind: 'directory', hint: '目录' }],
      truncated: false,
      position: caret.position,
      ...pending ? { pending: true } : {},
    }
  }
  const rawDir = expandHome(caret.dirPart, home)
  const start = rawDir.length === 0 ? base : rawDir
  if (start === undefined) throw new Error('这个会话没有工作目录，无法补全相对路径')
  // A cold reading is a round trip this process may not want to spend: when a
  // refine is on its way, the answer here is only a fallback, and the world is
  // asked for it once the shell has declined (see `complete`). What this side
  // already holds is still served — a warm usually put it there — so the reader
  // who typed and then pressed Tab gets their list without waiting for anything.
  if (!allowRead && readingCache.peek(readingKey(world, start, base)) === undefined) {
    return {
      start: caret.start, end: caret.end, dir: start, candidates: [], truncated: false,
      position: caret.position, ...pending ? { pending: true } : {},
    }
  }
  const reading = await readDirectoryCached(ctx, agent, start, base, world)
  if (!reading.ok) {
    // A directory the reader spelled with the wrong capitals is the same mistake
    // the trailing segment is repaired for, so an ABSENT path is given that one
    // chance before the miss is reported. A path that exists but is not a
    // directory gets no such chance: it is not an older spelling of something
    // else, and the candidate that would replace it is a real name the reader
    // did not ask for (`ls foo/` must not become `ls foo.d/` just because the
    // slash was wrong for a file).
    const recovered = reading.note === 'noDirectory'
      ? await completeDirectorySegment(ctx, agent, caret, base, home, world)
      : undefined
    return recovered ?? {
      start: caret.start, end: caret.end, dir: reading.dir, candidates: [], truncated: false,
      position: caret.position, ...pending ? { pending: true } : {}, note: reading.note,
    }
  }
  // Case-folded on the reader's side only: a name that matches regardless of
  // capitals is still answered with its own spelling, so `nexus-sh` completes to
  // `Nexus-shell/`, and a set that matches either way — `nexus-study` beside
  // `Nexus-shell` under `nexus-` — is listed rather than guessed at.
  const needle = foldAscii(caret.prefix)
  const matched = reading.children
    .filter(child => want !== 'directory' || child.type === 'directory')
    .filter(child => foldAscii(child.name).startsWith(needle))
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name)
    })
  const candidates: DshellCompletionCandidate[] = matched.slice(0, MAX_COMPLETIONS).map(child => ({
    name: child.name,
    kind: (child.type === 'directory' ? 'directory' : child.type === 'file' ? 'file' : 'other') as DshellFileKind,
    ...child.size === undefined ? {} : { size: child.size },
    hint: child.type === 'directory' ? '目录' : child.size === undefined ? '' : `${String(child.size)} B`,
  }))
  return {
    start: caret.start,
    end: caret.end,
    dir: reading.dir,
    candidates,
    truncated: matched.length > MAX_COMPLETIONS,
    position: caret.position,
    ...pending ? { pending: true } : {},
    ...candidates.length === 0 ? { note: 'noMatch' as const } : {},
  }
}

/**
 * The commands a session's world offers, as the list the first token completes
 * against: PATH's own directories plus the shell's interactive builtins.
 *
 * Cached per session for {@link COMMAND_CACHE_MS}. A PATH holds a few thousand
 * names across a dozen directories, and listing them is a filesystem walk — a
 * device session pays an SSH round trip per directory — so a Tab that re-walked
 * would be unusable. Installed software changes on the scale of a session, not
 * of a keystroke; the cache expires rather than being invalidated, and a miss
 * costs one stale list, never a wrong one.
 */
interface CommandList {
  readonly names: readonly string[]
  /** The directories that were searched, for the list's provenance line. */
  readonly dirs: readonly string[]
}

const commandCache = new Map<string, { at: number; list: Promise<CommandList> }>()

/**
 * The completion oracle's answers, keyed by world and line context.
 *
 * One cache for the whole route rather than one per session, because two
 * sessions in the same world (this machine, or one device) ask the same
 * bash-completion the same question; the WORLD is part of every key, so a device
 * answer can never come out of this machine's cache. The PATH walk above is per
 * session instead, for the same reason seen from the other side: it is a walk
 * this process performs, and the sessions it performs it for are not always the
 * same machine.
 */
const oracleCache = new OracleCache()

/**
 * Interactive builtins, which PATH cannot answer for.
 *
 * `cd`, `exit`, `export` and friends are shell builtins: they have no file in
 * any PATH directory, and a reader who types one is asking the shell, not the
 * filesystem. This is bash's interactive set (`compgen -b`), trimmed to the
 * words a person types at a prompt — the declaring and job-control builtins
 * would only crowd the list.
 */
const SHELL_BUILTINS: readonly string[] = [
  'alias', 'bg', 'cd', 'declare', 'dirs', 'disown', 'echo', 'eval', 'exec', 'exit',
  'export', 'fg', 'hash', 'help', 'history', 'jobs', 'kill', 'local', 'popd', 'printf',
  'pushd', 'pwd', 'read', 'readonly', 'set', 'shopt', 'source', 'time', 'times', 'trap',
  'type', 'ulimit', 'umask', 'unalias', 'unset', 'wait',
]

/** Where a Linux world keeps its commands, when its own PATH cannot be read. */
const FALLBACK_PATH_DIRS: readonly string[] = [
  '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin',
]

/** Split one PATH string into directories, dropping empty entries. */
function pathDirs(value: string | undefined): string[] {
  return (value ?? '').split(':').map(part => part.trim()).filter(part => part.length > 0)
}

/**
 * The PATH of the shell that runs in a session's world.
 *
 * A local session's shell is spawned by the terminal bridge as a child of this
 * process with `--noprofile --norc`, so its PATH IS this process's — no probe
 * is needed and none could be more exact. A device session's shell is an `ssh`
 * on the device, whose PATH belongs to that machine and is not derivable from
 * anything here, so that world is asked once, through the same shell seam the
 * transfer writes through (fenced read-only: this command reads one variable).
 *
 * @returns the directories to search. Empty means the world could not be asked
 *   and the caller should fall back rather than report "no commands".
 */
async function worldPathDirs(
  ctx: Context,
  routing: () => TransferRoutingSeat | undefined,
  sessionId: string,
  agent: Agent,
): Promise<string[]> {
  const target = routing()?.targetForSession(sessionId)
  if (target === undefined) return pathDirs(process.env.PATH)
  const result = await runInWorld(ctx, agent, {
    command: 'printf %s "$PATH"',
    workdir: target.remoteRoot,
    root: target.remoteRoot,
    timeoutMs: COMMAND_PROBE_TIMEOUT_MS,
    stdoutMaxBytes: COMMAND_PROBE_STDOUT_BYTES,
  })
  // A world that will not answer leaves the caller to fall back to the standard
  // directories rather than to report "no commands".
  return result !== undefined && result.exitCode === 0 ? pathDirs(result.stdout.text) : []
}

/**
 * Every command name one session's world offers, cached.
 *
 * The cache holds the PROMISE, not the answer: a background warm (see
 * `complete`) and a Tab that arrives while it is still walking share one walk
 * instead of starting a second. A failure is not cached — the next Tab may find
 * a world that answers.
 */
async function commandNames(
  ctx: Context,
  routing: () => TransferRoutingSeat | undefined,
  sessionId: string,
  agent: Agent,
  signal?: AbortSignal,
): Promise<CommandList> {
  const cached = commandCache.get(sessionId)
  if (cached !== undefined && Date.now() - cached.at < COMMAND_CACHE_MS) return await cached.list
  // One entry per session, so the map only grows with the sessions this process
  // has completed in; expired ones are dropped as they are passed over.
  for (const [key, entry] of commandCache) {
    if (Date.now() - entry.at >= COMMAND_CACHE_MS) commandCache.delete(key)
  }
  const list = buildCommandNames(ctx, routing, sessionId, agent, signal)
  const guarded = list.catch((error: unknown) => {
    commandCache.delete(sessionId)
    throw error
  })
  commandCache.set(sessionId, { at: Date.now(), list: guarded })
  return await guarded
}

/** The walk itself: the world's PATH, then one listing per directory, at once. */
async function buildCommandNames(
  ctx: Context,
  routing: () => TransferRoutingSeat | undefined,
  sessionId: string,
  agent: Agent,
  signal?: AbortSignal,
): Promise<CommandList> {
  const probed = await worldPathDirs(ctx, routing, sessionId, agent)
  const dirs = probed.length > 0 ? probed : [...FALLBACK_PATH_DIRS]
  // Every directory at once. Each listing is a round trip in that world (an SSH
  // exec on a device), so a walk that awaited them one by one would take the
  // SUM of a dozen — the difference between a Tab that answers and one that
  // looks broken. An absent PATH entry is ordinary (per-user directories usually
  // are), so a refused or missing listing contributes nothing.
  const listings = await Promise.all(dirs.map(async (dir) => {
    try {
      const target = await ctx.agents.withInitiator(agent, () => ctx.fs.resolve(dir))
      return await ctx.agents.withInitiator(agent, () => ctx.fs.listDir(target, signal))
    } catch {
      return []
    }
  }))
  const names = new Set<string>(SHELL_BUILTINS)
  for (const children of listings) {
    // A directory on the PATH is not a command; a file, a symlink and a
    // socket-to-be all are, and the seam only separates the first.
    for (const child of children) if (child.type !== 'directory') names.add(child.name)
  }
  return { names: [...names].sort((left, right) => left.localeCompare(right)), dirs }
}

/**
 * Complete a word in the command position as a command name.
 *
 * The names come from the session's own world, so a device session completes
 * the device's commands — the same rule the path side follows (see the module
 * header). Only a prefix match is offered; a candidate lands as the bare name,
 * and the composer appends the space the next word needs.
 */
async function completeCommand(
  ctx: Context,
  routing: () => TransferRoutingSeat | undefined,
  sessionId: string,
  agent: Agent,
  caret: ShellCaret,
): Promise<DshellCompletion> {
  const list = await commandNames(ctx, routing, sessionId, agent)
  const matches = list.names.filter(name => name.startsWith(caret.prefix))
  return {
    start: caret.start,
    end: caret.end,
    dir: 'PATH',
    candidates: matches.slice(0, MAX_COMPLETIONS).map(name => ({ name, kind: 'command' as const })),
    truncated: matches.length > MAX_COMPLETIONS,
    position: caret.position,
    ...matches.length === 0 ? { note: 'noCommand' as const } : {},
  }
}

/**
 * Canonicalize one path in the session's world.
 *
 * This is how the composer learns what a `cd` did: the shell's own working
 * directory is process state with no channel back (see the terminal bridge), so
 * every line the composer routes to it is inspected, and a `cd` is resolved
 * through the same seam the navigator uses — which is also what makes `~` and a
 * device session's paths come out right.
 *
 * A `cd` that could not land must not move the composer's mirror: the shell
 * stays where it was, so answering with the path the user typed would point
 * every later relative completion at a directory the shell never entered. Only
 * a directory answers.
 */
async function resolvePath(
  ctx: Context,
  routing: () => TransferRoutingSeat | undefined,
  sessionId: string,
  path: string,
  cwd: string | undefined,
): Promise<string | undefined> {
  const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId))
  if ('error' in resolved) throw new Error(`会话不可用：${resolved.error.code}`)
  const agent = resolved.agent
  const home = sessionDirectory(routing, sessionId, cwd)
  const options = home === undefined ? {} : { cwd: home }
  const target = await ctx.agents.withInitiator(
    agent,
    () => ctx.fs.resolve(expandHome(path, worldHome(routing, sessionId)), options),
  )
  const info = await ctx.agents.withInitiator(agent, () => ctx.fs.stat(target))
  if (info === undefined || info.type !== 'directory') return undefined
  return String(target.targetKey)
}

/**
 * Bind the route to the filesystem seam and, when one is composed, the terminal
 * bridge.
 *
 * The bridge arrives as a getter rather than a value because the two are
 * optional to each other: a composition without dshell-terminal-bridge has no
 * way to drive a session's shell, and this route then answers every listing
 * with `canCd: false` and refuses `cd`. Reading it per request also keeps the
 * question "is it composed *now*" honest across a later load or unload.
 */
export function createFilesRoute(
  ctx: Context,
  terminal: () => DshellTerminalBridge | undefined,
  routing: () => TransferRoutingSeat | undefined = () => undefined,
): ConnectionFetchRoute {
  const handle = async (request: Request): Promise<DshellFilesResponse> => {
    if (request.method === 'GET') return { error: '文件列表只接受 POST' }
    const input = await request.json() as DshellFilesRequest
    const bridge = terminal()
    switch (input.action) {
      case 'list':
        return { listing: await list(ctx, routing, input.sessionId, input.path, bridge !== undefined) }
      case 'cd': {
        if (bridge === undefined) return { error: '本次组合没有终端桥，无法把终端切换到该目录' }
        return { cdTo: await cd(ctx, routing, bridge, input.sessionId, input.path) }
      }
      case 'resolve': {
        const resolved = await resolvePath(ctx, routing, input.sessionId, input.path ?? '.', input.cwd)
        // A path that resolved is a place the reader is about to stand in — the
        // composer asks this after a `cd`, and the file navigator asks it while
        // walking. Reading the listing now is what makes the FIRST Tab in that
        // directory cheap; see `warmDirectory`.
        if (resolved !== undefined) {
          void warmDirectory(ctx, routing, input.sessionId, resolved)
            .catch(() => { /* a warm that failed costs the reader nothing */ })
        }
        return { resolved }
      }
      case 'complete':
        return {
          completion: await complete(
            ctx, routing, input.sessionId, input.line ?? '', input.cursor ?? 0, input.cwd,
            bridge?.shellCwd(input.sessionId), input.phase === 'refine' ? 'refine' : 'fast',
          ),
        }
      case 'warm':
        // Fire and forget, deliberately: the work IS the answer, and a warm the
        // reader had to wait for would be a slower Tab rather than a faster one.
        void warm(
          ctx, routing, input.sessionId, input.line ?? '', input.cursor ?? 0, input.cwd,
          bridge?.shellCwd(input.sessionId), input.oracle === true,
        ).catch(() => { /* a warm nobody asked for must never surface */ })
        return { warmed: true }
      default:
        return { error: '未知操作' }
    }
  }

  return {
    path: DSHELL_FILES_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return respond(await handle(request))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return respond({ error: reason }, 400)
      }
    },
  }
}
