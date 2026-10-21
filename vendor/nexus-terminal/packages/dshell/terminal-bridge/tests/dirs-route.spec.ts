/**
 * The directory browser: what a typed path resolves to, and what the picker is
 * shown below it.
 *
 * Two things are pinned down here and both are about the reader's expectations
 * rather than about the code being clever. First, the path rules: `~` means the
 * host user's home, a relative path means "below that home" (never below the
 * harness's working directory, which a browser cannot see and would therefore
 * misread), and a path that merely LOOKS like `~someone` is left alone because
 * it names another account. Second, what counts as a directory: a symlink to
 * one does — moving a data root to another disk is usually exactly that — while
 * a file and a symlink to a file do not.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DshellDirsResponse } from '@nexus-aethra/dshell-std'
import { createDirsRoute, listDirectories, resolveBrowsePath, resolveNewDirectoryPath } from '../src/dirs-route.js'

/** Every tree a spec made, removed afterwards. */
const made: string[] = []

/** A directory under the system temp root, removed when the spec ends. */
function scratch(name: string): string {
  const path = mkdtempSync(join(tmpdir(), `dshell-dirs-${name}-`))
  made.push(path)
  return path
}

/**
 * Whether this machine lets an unprivileged process create a symbolic link.
 *
 * Windows decides that with a privilege ("Create symbolic links") or with
 * Developer Mode, so a machine with neither cannot make the link a symlink
 * points at — and the case that needs one cannot be posed there.
 */
const SYMLINKS = ((): boolean => {
  const probe = join(tmpdir(), `dshell-dirs-symlink-probe-${String(process.pid)}`)
  try {
    symlinkSync(join(tmpdir(), 'dshell-dirs-symlink-target'), probe)
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { force: true })
  }
})()

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('resolving a typed path', () => {
  // The home is the one this machine has: a typed path names a directory on the
  // HOST, so it is spelled and resolved with the host's rules, and a fixture
  // written in POSIX would come back Windows-spelled.
  const home = homedir()

  it('opens at the home directory when nothing was asked for', () => {
    expect(resolveBrowsePath(undefined, home)).toBe(normalize(home))
    expect(resolveBrowsePath('', home)).toBe(normalize(home))
    expect(resolveBrowsePath('   ', home)).toBe(normalize(home))
    expect(resolveBrowsePath('~', home)).toBe(normalize(home))
  })

  it('expands ~ and resolves a relative path against the home, not the cwd', () => {
    expect(resolveBrowsePath('~/dshell-data', home)).toBe(join(home, 'dshell-data'))
    expect(resolveBrowsePath('dshell-data', home)).toBe(join(home, 'dshell-data'))
    expect(resolveBrowsePath('data/../dshell', home)).toBe(join(home, 'dshell'))
  })

  it('leaves an absolute path alone and refuses to guess another account', () => {
    // An absolute path is taken as it is: it names a directory on this machine,
    // and the picker is a browser that cannot see the host's disk.
    const absolute = join(home, 'mnt', 'big')
    expect(resolveBrowsePath(absolute, home)).toBe(normalize(absolute))
    expect(resolveBrowsePath('/', home)).toBe(normalize('/'))
    // `~someone` is not a home this process can expand, and silently resolving
    // it against the READER's home would list a directory they never named.
    expect(resolveBrowsePath('~someone/dir', home)).toBe(normalize(join(home, '~someone', 'dir')))
  })
})

describe('listing the directories below a path', () => {
  it('lists directories, sorted, and never files', () => {
    const root = scratch('tree')
    mkdirSync(join(root, 'zeta'))
    mkdirSync(join(root, 'alpha'))
    mkdirSync(join(root, '.hidden'))
    writeFileSync(join(root, 'notes.txt'), 'x\n')

    return listDirectories(root).then(({ entries, truncated }) => {
      expect(entries.map(entry => entry.name)).toEqual(['.hidden', 'alpha', 'zeta'])
      expect(truncated).toBe(false)
      // Every entry carries the absolute path the field will store.
      expect(entries[1]?.path).toBe(join(root, 'alpha'))
    })
  })

  // A symlink to a directory counts as one — that is a shape people really use
  // for this (`~/dshell-data -> /mnt/big/dshell`), and refusing it would be
  // refusing the most common way to move a data root to another disk. A symlink
  // to a file does not.
  it.skipIf(!SYMLINKS)('counts a link to a directory and ignores a link to a file', () => {
    const root = scratch('links')
    mkdirSync(join(root, 'alpha'))
    writeFileSync(join(root, 'notes.txt'), 'x\n')
    symlinkSync(join(root, 'alpha'), join(root, 'link-to-dir'))
    symlinkSync(join(root, 'notes.txt'), join(root, 'link-to-file'))

    return listDirectories(root).then(({ entries }) => {
      expect(entries.map(entry => entry.name)).toEqual(['alpha', 'link-to-dir'])
    })
  })

  it('reports an empty directory as empty rather than as a failure', async () => {
    const root = scratch('empty')
    expect(await listDirectories(root)).toEqual({ entries: [], truncated: false })
  })
})

describe('naming a directory to create', () => {
  const parent = join(homedir(), 'data')

  it('accepts one ordinary segment below the parent', () => {
    expect(resolveNewDirectoryPath(parent, 'dshell')).toBe(join(parent, 'dshell'))
    expect(resolveNewDirectoryPath(parent, '  spaced  ')).toBe(join(parent, 'spaced'))
    expect(resolveNewDirectoryPath(parent, 'a.b-c_d')).toBe(join(parent, 'a.b-c_d'))
  })

  it('refuses anything that is not a single segment below the parent', () => {
    // A field that accepts these creates directories the reader cannot see
    // while typing, or writes over the parent's own name.
    for (const name of ['', '   ', '.', '..', 'a/b', 'a\\b', '/etc', '../escape', 'a/../b']) {
      expect(resolveNewDirectoryPath(parent, name), name).toBeUndefined()
    }
  })
})

describe('creating a directory through the route', () => {
  /** The route's fetch, driven by a request body the way the browser sends it. */
  function post(body: Record<string, unknown>): Promise<DshellDirsResponse> {
    const route = createDirsRoute()
    return route.fetch(new Request('http://host/api/dshell/dirs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })).then(async response => await response.json() as DshellDirsResponse)
  }

  it('creates the directory and answers with ITS listing', async () => {
    const root = scratch('create')
    const answer = await post({ action: 'mkdir', path: root, name: 'transcripts' })
    expect(answer.created).toBe(join(root, 'transcripts'))
    // Landed inside it: the picker shows the new directory, not its parent.
    expect(answer.path).toBe(join(root, 'transcripts'))
    expect(answer.entries).toEqual([])
    expect(existsSync(join(root, 'transcripts'))).toBe(true)
  })

  it('says a name already exists instead of failing, and lists the parent', async () => {
    const root = scratch('exists')
    mkdirSync(join(root, 'taken'))
    const answer = await post({ action: 'mkdir', path: root, name: 'taken' })
    expect(answer.note).toBe('exists')
    expect(answer.created).toBeUndefined()
    expect(answer.path).toBe(root)
    expect(answer.entries?.map(entry => entry.name)).toEqual(['taken'])
  })

  it('refuses a name that is not one segment, without creating anything', async () => {
    const root = scratch('badname')
    const answer = await post({ action: 'mkdir', path: root, name: '../escape' })
    expect(answer.note).toBe('badName')
    expect(answer.created).toBeUndefined()
    expect(existsSync(join(root, '..', 'escape'))).toBe(false)
    // The listing that came with the refusal is still the truth.
    expect(answer.path).toBe(root)
  })

  // Windows decides access with ACLs, not with the POSIX mode bits, so a
  // directory made read-only here is still writable there — and the refusal
  // this pins cannot be provoked by the file system at all.
  it.skipIf(process.platform === 'win32')('reports the parent it cannot write to', async () => {
    const root = scratch('readonly')
    chmodSync(root, 0o500)
    try {
      const answer = await post({ action: 'mkdir', path: root, name: 'nope' })
      expect(answer.note).toBe('noAccess')
      expect(answer.created).toBeUndefined()
    } finally {
      chmodSync(root, 0o700)
    }
  })
})
