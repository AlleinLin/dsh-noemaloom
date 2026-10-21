/**
 * dshell's own data root: which directory it resolves to, and what moves when a
 * reader changes their mind.
 *
 * The specs below use a REAL directory tree under `os.tmpdir()` rather than a
 * mocked file system, because what is being pinned down is a claim about files:
 * that a device registry ends up in the new root, that a mount point does not,
 * and that a second start finds nothing left to do. A mocked `rename` would
 * agree with any of those claims.
 *
 * The one thing NOT exercised here is the environment: `applyDataRoot` reads
 * `process.env` and sets it, which is a process-wide effect a spec should not
 * take lightly. The precedence rule it implements is covered through
 * `resolveDataRoot`, which takes the same facts as arguments.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DSHELL_HOME_ENV } from '@nexus-aethra/dshell-std'
import {
  applyDataRoot, DATA_ROOT_MARKER, DATA_ROOT_POINTER, migrateDataRoot, resolveDataRoot, resolveDataRootPath,
  type DataRootPlan,
} from '../src/data-root.js'

/** Every tree a spec made, removed afterwards. */
const made: string[] = []

/** A directory under the system temp root, removed when the spec ends. */
function scratch(name: string): string {
  const path = mkdtempSync(join(tmpdir(), `dshell-${name}-`))
  made.push(path)
  return path
}

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** One file, with its directory created. */
function file(path: string, body = 'x\n'): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

/**
 * A root that looks like a used harness home: the five records dshell keeps,
 * plus the one thing that must stay behind.
 */
function usedRoot(name: string): string {
  const root = scratch(name)
  file(join(root, 'dshell/ssh/devices.json'), '{"devices":[]}\n')
  file(join(root, 'dshell/ssh/keys/tencent.pem'), 'key\n')
  file(join(root, 'dshell/ssh/known_hosts'), 'host\n')
  file(join(root, 'dshell/buffer/state.json'), '{}\n')
  file(join(root, 'dshell/tags.json'), '{}\n')
  file(join(root, 'terminal-mode.json'), '{"version":2,"records":[]}\n')
  file(join(root, 'dshell-pty/session-abc.log'), 'log\n')
  // Stays: a session's working directory, which dsh recorded as an absolute
  // path. Everything under the ssh tree travels, because there is nothing there
  // that belongs to a running process rather than to the record.
  mkdirSync(join(root, 'dshell/mnt/tencent/root'), { recursive: true })
  file(join(root, 'dshell/mnt/tencent/root/README.md'), 'in the way\n')
  return root
}

describe('resolving the data root', () => {
  // The roots are named the way THIS machine spells them: a data root is a
  // directory on the host, so it is resolved with the host's rules, and a
  // fixture written in POSIX would come back Windows-spelled.
  const facts = { harnessHome: join(homedir(), '.dsh'), home: homedir() }
  const setting = join(homedir(), 'data', 'dshell')
  const environment = join(homedir(), 'env', 'dshell')

  it('prefers the configured setting over everything else', () => {
    expect(resolveDataRoot({ ...facts, setting, environment }))
      .toEqual({ root: setting, source: 'setting' })
  })

  it('falls back to the environment, then to the harness home', () => {
    expect(resolveDataRoot({ ...facts, setting: '', environment }))
      .toEqual({ root: environment, source: 'environment' })
    expect(resolveDataRoot({ ...facts, setting: undefined, environment: undefined }))
      .toEqual({ root: facts.harnessHome, source: 'harness' })
  })

  it('treats a blank setting as "not configured" rather than as a directory', () => {
    // The card stores the empty string for "follow dsh", so a reader who clears
    // the field must get the harness home back and not a root named "".
    expect(resolveDataRoot({ ...facts, setting: '   ', environment: undefined }).source).toBe('harness')
  })

  it('expands ~ and refuses to depend on the process cwd', () => {
    const home = homedir()
    expect(resolveDataRootPath('~', home)).toBe(home)
    expect(resolveDataRootPath('~/dshell-data', home)).toBe(join(home, 'dshell-data'))
    expect(resolveDataRootPath('dshell-data', home)).toBe(join(home, 'dshell-data'))
    // An absolute path is taken as it is, and comes back canonical: the same
    // directory written two ways has to be one value, or a move from a root to
    // itself would look like a move.
    expect(resolveDataRootPath(`${join(home, 'data', 'dshell')}${sep}`, home)).toBe(join(home, 'data', 'dshell'))
    expect(resolveDataRootPath('', home)).toBeUndefined()
  })
})

describe('moving a data root', () => {
  it('moves the records, leaves the mount points, and marks the destination', () => {
    const from = usedRoot('from')
    const to = scratch('to')
    const migration = migrateDataRoot(from, to)
    expect(migration).toBeDefined()
    expect(migration?.moved).toEqual(['dshell/ssh', 'dshell/buffer', 'dshell/tags.json', 'terminal-mode.json', 'dshell-pty'])
    expect(migration?.failed).toEqual([])

    // The device registry, the keys and the transcripts are in the new root.
    expect(existsSync(join(to, 'dshell/ssh/devices.json'))).toBe(true)
    expect(existsSync(join(to, 'dshell/ssh/keys/tencent.pem'))).toBe(true)
    expect(existsSync(join(to, 'dshell-pty/session-abc.log'))).toBe(true)
    // And gone from the old one, so there is exactly one copy.
    expect(existsSync(join(from, 'dshell/ssh/devices.json'))).toBe(false)
    expect(existsSync(join(from, 'dshell-pty/session-abc.log'))).toBe(false)

    // A session's working directory stays: dsh holds that absolute path.
    expect(existsSync(join(from, 'dshell/mnt/tencent/root/README.md'))).toBe(true)
    expect(existsSync(join(to, 'dshell/mnt'))).toBe(false)
    // The device's own known_hosts travels with it: the trust a root recorded
    // is part of what that root means.
    expect(existsSync(join(to, 'dshell/ssh/known_hosts'))).toBe(true)
    expect(existsSync(join(from, 'dshell/ssh/known_hosts'))).toBe(false)

    expect(existsSync(join(to, 'dshell', DATA_ROOT_MARKER))).toBe(true)
  })

  it('has nothing to do, and records nothing, once the source is drained', () => {
    const from = usedRoot('from')
    const to = scratch('to')
    migrateDataRoot(from, to)
    expect(migrateDataRoot(from, to)).toBeUndefined()
    expect(migrateDataRoot(to, to)).toBeUndefined()
  })

  it('reports a record that appears at the old root afterwards as a conflict, not a drop', () => {
    // A file written at the old root after the move is not stranded by a note
    // in the destination — the move is decided by what is THERE — but it does
    // not replace what the new root already holds either. The reader is told.
    const from = usedRoot('from')
    const to = scratch('to')
    migrateDataRoot(from, to)
    file(join(from, 'dshell/tags.json'), '{"later":true}\n')
    const after = migrateDataRoot(from, to)
    expect(after?.moved).toEqual([])
    expect(after?.kept).toEqual(['dshell/tags.json'])
    expect(readFileSync(join(to, 'dshell/tags.json'), 'utf8')).toBe('{}\n')
  })

  it('never overwrites what the destination already holds', () => {
    const from = usedRoot('from')
    const to = scratch('to')
    file(join(to, 'dshell/ssh/devices.json'), '{"devices":[{"name":"newer"}]}\n')
    const migration = migrateDataRoot(from, to)
    // The whole ssh tree is one entry, so a registry already sitting at the
    // destination keeps the whole tree behind: moving the keys around it would
    // leave a root whose credentials outnumber its devices. The reader is told,
    // and the source keeps its copy to diff by hand.
    expect(migration?.kept).toEqual(['dshell/ssh'])
    expect(migration?.moved).not.toContain('dshell/ssh')
    expect(migration?.failed).toEqual([])
    expect(readFileSync(join(to, 'dshell/ssh/devices.json'), 'utf8')).toBe('{"devices":[{"name":"newer"}]}\n')
    expect(existsSync(join(to, 'dshell/ssh/keys/tencent.pem'))).toBe(false)
    expect(existsSync(join(from, 'dshell/ssh/devices.json'))).toBe(true)
    // The trees with no conflict moved.
    expect(existsSync(join(to, 'dshell-pty/session-abc.log'))).toBe(true)
  })

  it('reports nothing when a root that was never used has nothing to move', () => {
    const from = scratch('from')
    const to = scratch('to')
    expect(migrateDataRoot(from, to)).toBeUndefined()
    expect(existsSync(join(to, 'dshell', DATA_ROOT_MARKER))).toBe(false)
  })
})

describe('applying a root, and coming back', () => {
  /**
   * The variable this code exports is per-PROCESS in reality, and every start
   * is a new process. The specs below call `applyDataRoot` several times in one
   * process to model several starts, so each call starts from the same ambient
   * state a fresh harness would have: nothing exported yet.
   */
  const ambient = process.env[DSHELL_HOME_ENV]

  afterEach(() => {
    if (ambient === undefined) delete process.env[DSHELL_HOME_ENV]
    else process.env[DSHELL_HOME_ENV] = ambient
  })

  /** One harness start's worth of state: the settings value, and no exported root. */
  function start(harnessHome: string, setting: string): DataRootPlan {
    delete process.env[DSHELL_HOME_ENV]
    return applyDataRoot({ setting, harnessHome, home: harnessHome })
  }

  it('exports the root, records it, and brings the files home when the field is emptied', () => {
    const harnessHome = usedRoot('harness')
    const destination = scratch('destination')

    const first = start(harnessHome, destination)
    expect(first.source).toBe('setting')
    expect(first.migration?.moved).toEqual(['dshell/ssh', 'dshell/buffer', 'dshell/tags.json', 'terminal-mode.json', 'dshell-pty'])
    // The variable is what the other packages' path helpers read.
    expect(process.env[DSHELL_HOME_ENV]).toBe(destination)
    expect(existsSync(join(destination, 'dshell/ssh/devices.json'))).toBe(true)
    // And the default root records where the files went.
    expect(readFileSync(join(harnessHome, 'dshell', DATA_ROOT_POINTER), 'utf8').trim()).toBe(destination)

    // The reader clears the field: the next start comes home, files included.
    const second = start(harnessHome, '')
    expect(second.source).toBe('harness')
    expect(second.root).toBe(harnessHome)
    expect(second.migration?.from).toBe(destination)
    expect(existsSync(join(harnessHome, 'dshell/ssh/devices.json'))).toBe(true)
    expect(existsSync(join(harnessHome, 'dshell-pty/session-abc.log'))).toBe(true)
    // The record follows the data HOME in the same start, so the root the files
    // came from is not examined again from then on.
    expect(readFileSync(join(harnessHome, 'dshell', DATA_ROOT_POINTER), 'utf8').trim()).toBe(harnessHome)

    // A third start has nothing left to do — the record names the current root.
    const third = start(harnessHome, '')
    expect(third.migration).toBeUndefined()
    expect(readFileSync(join(harnessHome, 'dshell', DATA_ROOT_POINTER), 'utf8').trim()).toBe(harnessHome)
  })

  it('reports a move once, then stays quiet on the next start', () => {
    const harnessHome = usedRoot('harness')
    const destination = scratch('destination')
    expect(start(harnessHome, destination).migration).toBeDefined()
    // Same setting, next start: the source has been drained, so there is
    // nothing to report — and no lock standing in the way either.
    expect(start(harnessHome, destination).migration).toBeUndefined()
  })

  it('goes out, comes home, and goes out to the SAME directory again', () => {
    // The regression this pins: the record a destination keeps after the first
    // visit must not refuse the second one. Before it was fixed, choosing a
    // directory a reader had already used left their files at home while the
    // harness switched to the empty destination — the whole point of the
    // feature, failing on the second use.
    const harnessHome = usedRoot('harness')
    const destination = scratch('destination')
    expect(start(harnessHome, destination).migration?.moved).toHaveLength(5)
    expect(start(harnessHome, '').migration?.from).toBe(destination)
    const again = start(harnessHome, destination)
    expect(again.migration?.moved).toHaveLength(5)
    expect(existsSync(join(destination, 'dshell/ssh/devices.json'))).toBe(true)
    expect(start(harnessHome, '').migration?.from).toBe(destination)
    expect(existsSync(join(harnessHome, 'dshell/ssh/devices.json'))).toBe(true)
  })

  it('rewrites a record whose root is gone instead of migrating from it', () => {
    const harnessHome = usedRoot('harness')
    const vanished = join(scratch('vanished'), 'gone')
    mkdirSync(join(harnessHome, 'dshell'), { recursive: true })
    writeFileSync(join(harnessHome, 'dshell', DATA_ROOT_POINTER), `${vanished}\n`)
    const plan = start(harnessHome, '')
    expect(plan.migration).toBeUndefined()
    // The record now names the root actually in use, so the dead path is not
    // looked for again on every start.
    expect(readFileSync(join(harnessHome, 'dshell', DATA_ROOT_POINTER), 'utf8').trim()).toBe(harnessHome)
  })

  it('never migrates for an exported root: a scratch deployment must not move real data', () => {
    const harnessHome = usedRoot('harness')
    const scratchRoot = scratch('scratch')
    delete process.env[DSHELL_HOME_ENV]
    const plan = applyDataRoot({ setting: '', harnessHome, home: harnessHome })
    expect(plan.source).toBe('harness')
    // Same call, but the deployment exported a root: honoured, and NOT acted on.
    process.env[DSHELL_HOME_ENV] = scratchRoot
    const exported = applyDataRoot({ setting: '', harnessHome, home: harnessHome })
    expect(exported).toEqual({ root: scratchRoot, source: 'environment' })
    // The reader's own trees are exactly where they were.
    expect(existsSync(join(harnessHome, 'dshell/ssh/devices.json'))).toBe(true)
    expect(existsSync(join(scratchRoot, 'dshell'))).toBe(false)
  })
})
