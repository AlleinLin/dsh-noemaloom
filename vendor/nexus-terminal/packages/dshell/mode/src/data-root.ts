/**
 * dshell's own data root: which directory its files live under, and what
 * happens to the files that are already under the old one.
 *
 * dsh derives a home (`DSH_HOME`, else `~/.dsh`) and dshell put two trees under
 * it: `dshell/` (device registry, keys, buffer state, session tags, the mount
 * points device sessions stand in) and `dshell-pty/` (transcripts, timelines,
 * the command-history database). Those files are the reason this module exists:
 * they are the part of dshell a reader may need somewhere else — a bigger disk,
 * an encrypted volume, a directory their own backups already cover.
 *
 * It is deliberately NOT the harness's home, and the settings card says so in
 * dsh's own words rather than promising something it cannot: moving dsh's home
 * takes sessions, settings and storage with it, so a reader who wants their
 * shell transcripts on another disk must not have to relocate dsh. The setting
 * therefore resolves into `DSHELL_HOME`, which only dshell's own path helpers
 * read.
 *
 * ### When it takes effect, and the one thing that is not instant
 *
 * The root is fixed for the life of a process: the settings card names it, and
 * the next harness start resolves it, migrates what the previous root was
 * holding, and exports it before any path helper asks. A change made while the
 * harness runs is stored and does nothing until then — the alternative is a
 * live process writing half its files under one root and half under another,
 * which is worse than waiting.
 *
 * The migration is a MOVE, and it is selective on purpose:
 *
 *   - `dshell/ssh`, `dshell/buffer`,
 *     `dshell/tags.json` and `dshell-pty` travel, because they are dshell's own
 *     records and mean the same thing in either root. The ssh tree travels
 *     whole — registry, credentials, bindings and this plugin's own
 *     `known_hosts` — and nothing in it is left behind: there is no per-process
 *     scratch under it any more, because the transport that talks to a device
 *     is a library call rather than a child process with a socket of its own.
 *   - `dshell/mnt/**` does NOT travel. Those are the local directories that
 *     stand in for device trees, and each one is the working directory of a
 *     session dsh recorded as an ABSOLUTE path. Moving them would leave every
 *     existing device session pointing at a directory that no longer exists, so
 *     they stay where they are; new sessions mount under the new root.
 *
 * Nothing is ever deleted from the destination: an entry that is already there
 * is left alone and reported, so a root that already holds dshell data is never
 * merged or clobbered by accident.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DSHELL_HOME_ENV } from '@nexus-aethra/dshell-std'

/** Where a resolved data root came from, in precedence order. */
export type DataRootSource = 'setting' | 'environment' | 'harness'

/**
 * Name of the record a migrated root carries: where its contents came from, and
 * what the move did.
 *
 * It is written for a human who finds dshell's files somewhere unexpected, and
 * for the log line that reports a partial move. It is NOT a lock — see
 * {@link migrateDataRoot} for why refusing to look again would strand the
 * reader's data.
 */
export const DATA_ROOT_MARKER = '.dshell-root.json'

/**
 * Name of the file, at the DEFAULT root, that records where the data is now.
 *
 * The record above answers "where did this root's contents come from?", which is
 * a fact about a destination. This one answers a different question the default
 * root has to be able to ask: "the setting is empty again — where did my files
 * go?" Without it, emptying the field is a one-way door: the harness starts at
 * the default root, finds an empty `dshell/`, and presents a reader with no
 * devices and no transcripts while their files sit on the other disk. Nothing
 * would be lost, but the reader would have to know to go looking.
 *
 * It lives in the default root's `dshell/` directory (which survives a move: the
 * mount points and control sockets stay there) and holds one absolute path.
 */
export const DATA_ROOT_POINTER = '.dshell-data-root'

/**
 * One entry of the move plan, as a path relative to a root.
 */
interface RootMove {
  /** Path under both roots, which may be a directory or a file. */
  readonly path: string
}

/**
 * What travels when the root changes.
 *
 * Order is irrelevant — every entry is an independent move — but the list is
 * the policy, so it is written out rather than derived from a directory scan:
 * a tree dshell adds later has to be considered here on purpose, not swept
 * along by a wildcard.
 *
 * The ssh tree travels whole. It once had a `ctl/` child of live control sockets
 * and an `askpass.sh` that was regenerated on every start; both are gone now
 * that a device connection is an `ssh2` client inside this process, so the
 * directory holds records only — and a record means the same thing under either
 * root, which is the whole test for belonging on this list.
 *
 * The names are LOGICAL — they say which tree moved, not where it lives — so they
 * are written in POSIX on every machine, and the record a reader can read and a
 * log line they can compare say the same thing everywhere. The path itself is
 * built with `join`, which turns them into the host's own spelling: a Windows
 * host gets `dshell\ssh` on disk and `dshell/ssh` in the record.
 */
const ROOT_MOVES: readonly RootMove[] = [
  { path: 'dshell/ssh' },
  { path: 'dshell/buffer' },
  { path: 'dshell/tags.json' },
  { path: 'terminal-mode.json' },
  { path: 'dshell-pty' },
]

/** What one migration did, in the words a start-up log line can use. */
export interface DataRootMigration {
  /** The root the data came from. */
  readonly from: string
  /** The root it was moved to. */
  readonly to: string
  /** Relative paths that moved. */
  readonly moved: readonly string[]
  /** Relative paths that were already present at the destination and were left as they are. */
  readonly kept: readonly string[]
  /** Relative paths that could not be moved; the data is still at `from`. */
  readonly failed: readonly string[]
}
/** A resolved data root, and whether this process has applied it. */
export interface DataRootPlan {
  /** The directory dshell's own trees are resolved under. */
  readonly root: string
  /** Which source decided it. */
  readonly source: DataRootSource
  /** What the migration did, when one ran. */
  readonly migration?: DataRootMigration
}

/**
 * Expand the value the settings card stored into an absolute directory.
 *
 * `~` and `~/…` mean the host user's home — the picker hands back absolute
 * paths, but the field accepts typing, and `~/dshell-data` is a reasonable
 * thing to type. A relative path is resolved against that home for the same
 * reason a browser cannot be trusted with a cwd: the same text would otherwise
 * name a different directory depending on how the harness was started.
 *
 * The answer is canonical (`/data/dshell/`, `//data/dshell` and `/data/dshell`
 * are one directory, so they must be one value): a root spelled two ways would
 * otherwise compare unequal to itself, and a "move" from a root to itself is
 * the one operation this module must never attempt.
 *
 * @param value - the stored setting.
 * @param home - the host user's home directory.
 * @returns the absolute root, or undefined when nothing was configured.
 */
export function resolveDataRootPath(value: string | undefined, home: string): string | undefined {
  const raw = (value ?? '').trim()
  if (raw.length === 0) return undefined
  if (raw === '~') return resolve(home)
  if (raw.startsWith('~/')) return resolve(join(home, raw.slice(2)))
  return resolve(isAbsolute(raw) ? raw : join(home, raw))
}

/**
 * Decide which root this process uses, without touching anything.
 *
 * Precedence mirrors dsh's own home resolution — an explicit setting, then the
 * environment, then the default — because the alternative (letting the
 * environment outrank a setting a reader just chose in the UI) would make the
 * card silently do nothing on a deployment that exports the variable.
 *
 * @param options - the stored setting, the ambient variable, and the two homes.
 * @returns the root and the source that decided it.
 */
export function resolveDataRoot(options: {
  setting: string | undefined
  environment: string | undefined
  harnessHome: string
  home: string
}): Omit<DataRootPlan, 'migration'> {
  const configured = resolveDataRootPath(options.setting, options.home)
  if (configured !== undefined) return { root: configured, source: 'setting' }
  const ambient = resolveDataRootPath(options.environment, options.home)
  if (ambient !== undefined) return { root: ambient, source: 'environment' }
  return { root: resolve(options.harnessHome), source: 'harness' }
}

/**
 * Move one entry, then remove it from the old root.
 *
 * `rename` is the whole operation when both roots are on one file system — it
 * is atomic and costs nothing. Across file systems it fails with `EXDEV`, and
 * the copy-then-remove fallback is what makes a data root on another disk
 * possible at all.
 *
 * A destination that already exists is refused BEFORE the attempt, and that
 * check is load-bearing rather than defensive: POSIX `rename` replaces an
 * existing file atomically and silently, so a start-up "move" would otherwise
 * delete the reader's newer `devices.json` in the destination root without a
 * word. The caller reports the collision instead — the reader's new root
 * holding dshell data is their decision, not a start-up routine's.
 *
 * @param from - absolute source.
 * @param to - absolute destination.
 * @returns whether the move completed.
 */
function moveEntry(from: string, to: string): boolean {
  if (existsSync(to)) return false
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') return false
  }
  try {
    cpSync(from, to, { recursive: true, force: false, errorOnExist: true })
    rmSync(from, { recursive: true, force: true })
    return true
  } catch {
    // A half-copied destination is removed only when the source is intact, so
    // the data always exists in exactly one place.
    rmSync(to, { recursive: true, force: true })
    return false
  }
}

/** What moving one planned entry did, in relative paths. */
interface MovedEntry {
  /** The entry moved (all of it, or as much as had somewhere to go). */
  readonly moved: boolean
  /** Children left alone because the destination already had them. */
  readonly kept: readonly string[]
  /** Whether a child could not be moved; its data is still under the old root. */
  readonly failed: boolean
}

/**
 * Move one planned entry, then report what happened.
 *
 * @param from - the old root.
 * @param to - the new root.
 * @param move - the planned entry.
 * @returns what moved, what was left, and whether anything failed.
 */
function movePlanned(from: string, to: string, move: RootMove): MovedEntry {
  const source = join(from, move.path)
  if (!existsSync(source)) return { moved: false, kept: [], failed: false }
  if (existsSync(join(to, move.path))) return { moved: false, kept: [move.path], failed: false }
  return moveEntry(source, join(to, move.path))
    ? { moved: true, kept: [], failed: false }
    : { moved: false, kept: [], failed: true }
}

/**
 * Move the durable parts of one data root into another.
 *
 * Idempotence does not need a guard, and deliberately does not have one: a move
 * REMOVES what it moved, so a source that has already been drained has nothing
 * to offer and the call reports nothing. The alternative — refusing to look
 * again because the destination carries a marker — was wrong in a way that
 * showed up immediately in testing: it stranded the reader's files the second
 * time they chose a root they had used before, because the marker left by the
 * first visit was still there while the data had since gone home. The file
 * below is therefore a RECORD of the last move into a root (a human reading the
 * directory can see where its contents came from), never a lock.
 *
 * Nor is anything ever overwritten: an entry the destination already holds is
 * reported as `kept` and left alone — on both sides, so the reader can diff the
 * two rather than discover a silent replacement. A run whose only outcome is
 * conflicts still reports them, because "your new directory already had a
 * devices.json and I did not touch it" is a fact the reader has to act on.
 *
 * Failures are per entry and never fatal: an entry that cannot move stays where
 * it is and is reported, which leaves a reader with a working harness and a line
 * of output naming what to copy by hand.
 *
 * @param from - the root the data is under now.
 * @param to - the configured root.
 * @returns what happened, or undefined when the source held nothing to move.
 */
export function migrateDataRoot(from: string, to: string): DataRootMigration | undefined {
  if (resolve(from) === resolve(to)) return undefined
  const moved: string[] = []
  const kept: string[] = []
  const failed: string[] = []
  for (const move of ROOT_MOVES) {
    const outcome = movePlanned(from, to, move)
    if (outcome.moved) moved.push(move.path)
    kept.push(...outcome.kept)
    if (outcome.failed) failed.push(move.path)
  }
  if (moved.length === 0 && kept.length === 0 && failed.length === 0) return undefined
  const marker = join(to, 'dshell', DATA_ROOT_MARKER)
  mkdirSync(join(to, 'dshell'), { recursive: true })
  writeFileSync(marker, `${JSON.stringify({ movedFrom: from, at: new Date().toISOString(), moved, kept, failed }, null, 2)}\n`)
  return { from, to, moved, kept, failed }
}

/**
 * Record which root the data lives under, so "follow the default" can find it
 * again.
 *
 * Best effort: a deployment that cannot write here still works, it just cannot
 * promise that emptying the field brings the files home on its own.
 *
 * @param harnessHome - the default root, where the record lives.
 * @param root - the root in force.
 */
function recordDataRoot(harnessHome: string, root: string): void {
  try {
    mkdirSync(join(harnessHome, 'dshell'), { recursive: true })
    writeFileSync(join(harnessHome, 'dshell', DATA_ROOT_POINTER), `${root}\n`)
  } catch { /* the pointer is a convenience, never a requirement */ }
}

/**
 * The root the record names, or undefined when there is none to read.
 *
 * @param harnessHome - the default root holding the record.
 * @returns the recorded absolute path, if any.
 */
function recordedDataRoot(harnessHome: string): string | undefined {
  try {
    const value = readFileSync(join(harnessHome, 'dshell', DATA_ROOT_POINTER), 'utf8').trim()
    return value.length === 0 ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * Apply the configured data root to this process, migrating what the old one
 * held, and export it for the path helpers.
 *
 * Only a root named by the SETTING migrates. The environment variable is
 * honoured but never triggers a move, and that asymmetry is the safety property
 * that matters: `DSHELL_HOME=/tmp/scratch dsh web` is how a test or a package
 * run points dshell at a throwaway directory, and a routine that relocated the
 * reader's devices and transcripts into that scratch directory would be
 * destroying real state on behalf of a flag they meant as a sandbox. A move
 * happens when a reader asked for one, in the UI, where the card can say so.
 *
 * The variable is exported only when the setting is what decided the root, for
 * a related reason: an inherited `DSHELL_HOME` would follow into a nested
 * harness started from dshell's own terminal and pin ITS dshell plugin to this
 * root, which is exactly the "two harnesses share one data directory" defect
 * this setting exists to make avoidable.
 *
 * Coming BACK is the other half, and it is why the pointer above exists: an
 * empty setting means the harness home again, and if a record says the data is
 * somewhere else, it is moved back. A dead record (a root that is gone) is
 * simply rewritten rather than migrated from, so a reader who deleted the old
 * directory by hand is not told about a move that never happened.
 *
 * @param options - the stored setting and the two homes.
 * @returns what was applied, for the start-up log line.
 */
export function applyDataRoot(options: {
  setting: string | undefined
  harnessHome: string
  home: string
}): DataRootPlan {
  const resolved = resolveDataRoot({
    setting: options.setting,
    environment: process.env[DSHELL_HOME_ENV],
    harnessHome: options.harnessHome,
    home: options.home,
  })
  if (resolved.source === 'setting') {
    const migration = migrateDataRoot(options.harnessHome, resolved.root)
    process.env[DSHELL_HOME_ENV] = resolved.root
    if (resolve(options.harnessHome) !== resolved.root) recordDataRoot(options.harnessHome, resolved.root)
    return migration === undefined ? resolved : { ...resolved, migration }
  }
  if (resolved.source === 'harness') {
    const recorded = recordedDataRoot(options.harnessHome)
    if (recorded === undefined || resolve(recorded) === resolved.root) return resolved
    // Whether or not the move had anything to carry, the record now names the
    // root actually in use: a record left pointing at the root the data just
    // came from would be re-examined on every start from then on.
    const migration = existsSync(recorded) ? migrateDataRoot(recorded, resolved.root) : undefined
    recordDataRoot(options.harnessHome, resolved.root)
    if (migration !== undefined) return { ...resolved, migration }
  }
  return resolved
}

/** The host user's home, as the resolution needs it. @returns an absolute path. */
export function hostHome(): string {
  return homedir()
}

/** dsh's own harness home, read the way dsh reads it. @returns an absolute path. */
export function harnessHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Whether a directory exists and can be written to, as far as a start-up check
 * can tell.
 *
 * Best effort by design: it runs to put an honest line in the log, and a root
 * that fails the check still becomes the root (the settings card validates the
 * choice when it is made, and refusing to start over a `stat` is worse than
 * starting with a warning).
 *
 * @param path - the configured root.
 * @returns whether the path is an existing directory.
 */
export function dataRootReady(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
