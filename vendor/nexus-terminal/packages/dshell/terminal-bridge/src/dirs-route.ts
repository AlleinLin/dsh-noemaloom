/**
 * The directory browser route: dshell's own folder picker, because the browser
 * cannot have a native one.
 *
 * A settings field that names a directory on the HOST machine has exactly two
 * honest shapes: the reader types a path, or the host lists its directories and
 * the reader picks. It cannot be the operating system's folder dialog — a page
 * has no access to the host's file system, and the composition this runs in
 * proves why that is not a limitation to work around: the harness may be a
 * remote `dsh web`, or the desktop shell, and in neither case is the browser's
 * machine the machine the files live on.
 *
 * So the host answers the question it can answer, and only that one: what
 * directories exist below this path, whether this path can be written to, and
 * where up and home are. It reads DIRECTORIES only — the field names a data
 * root, and offering files would be offering something it cannot accept.
 *
 * It lives beside the locale route rather than in a package of its own because
 * this is the same kind of host plumbing: one route, registered once with the
 * connection seam, belonging to no session and touching no session's world. It
 * lists the machine the HARNESS runs on, which is deliberate — a session
 * bound to a device has its own file browser (`dshell-files`), and a data
 * directory on a device is not a thing dshell can have.
 */

import { access, mkdir, readdir, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import {
  DSHELL_DIRS_PATH, type DshellDirsEntry, type DshellDirsRequest, type DshellDirsResponse,
} from '@nexus-aethra/dshell-std'

/**
 * How many directories one answer may carry.
 *
 * A data root is rarely a directory with thousands of children, but `/usr` and
 * a build tree are, and the picker has to stay a picker. The cap is honest: the
 * answer says it was cut, and the reader narrows by typing instead.
 */
const MAX_ENTRIES = 500

/** JSON response in the shape the browser half parses. */
function respond(body: DshellDirsResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Resolve what the reader typed into the absolute path to list.
 *
 * `~` and `~/…` mean the host user's home; a relative path is resolved against
 * that home rather than against the process's working directory, because the
 * caller is a browser on the other end of a wire and a cwd it cannot see would
 * make the same text mean different things in two compositions. A bare `~user`
 * is NOT expanded: it names another account, which is not what the field is for,
 * and guessing would silently list the wrong tree.
 *
 * The result is normalized but not resolved through symlinks — the picker shows
 * the path the reader chose, not the one the kernel would follow.
 *
 * @param input - the request's path, or nothing for the home directory.
 * @param home - the host user's home directory.
 * @returns the absolute path to list.
 */
export function resolveBrowsePath(input: string | undefined, home: string): string {
  const raw = (input ?? '').trim()
  if (raw.length === 0) return normalize(home)
  if (raw === '~') return normalize(home)
  if (raw.startsWith('~/')) return normalize(join(home, raw.slice(2)))
  return normalize(isAbsolute(raw) ? raw : join(home, raw))
}

/**
 * The directories below one path, as the picker draws them.
 *
 * Sorted by name with the locale's own collation, hidden directories included:
 * a data directory is very often a dotted one (`~/.local/share`), so filtering
 * by the leading dot would hide the answer the reader came for.
 *
 * A symlink that points at a directory counts as one — that is a shape people
 * really use for this (`~/dshell-data -> /mnt/big/dshell`), and refusing it
 * would be refusing the most common way to move a data root to another disk.
 *
 * @param path - absolute directory to list.
 * @returns the entries and whether the cap cut the list.
 */
export async function listDirectories(path: string): Promise<{ entries: DshellDirsEntry[]; truncated: boolean }> {
  const dirents = await readdir(path, { withFileTypes: true })
  const directories: string[] = []
  for (const dirent of dirents) {
    if (dirent.isDirectory()) { directories.push(dirent.name); continue }
    if (!dirent.isSymbolicLink()) continue
    // One stat per link, and only for links: the common case (a real tree) is
    // already decided by the dirent.
    const target = await stat(join(path, dirent.name)).catch(() => undefined)
    if (target?.isDirectory() === true) directories.push(dirent.name)
  }
  directories.sort((left, right) => left.localeCompare(right))
  return {
    entries: directories.slice(0, MAX_ENTRIES).map(name => ({ name, path: join(path, name) })),
    truncated: directories.length > MAX_ENTRIES,
  }
}

/**
 * Resolve one new directory's name into the absolute path to create.
 *
 * This is the whole guard on a request that WRITES to the host's file system,
 * so it refuses rather than repairs, and it refuses anything that is not a
 * single ordinary path segment:
 *
 *   - empty, `.` and `..` — the parent itself, or its parent, neither of which is
 *     a directory being created;
 *   - anything containing a separator (`/`, `\`) — a field that accepts `a/b/c`
 *     would create directories the reader cannot see while typing;
 *   - a name that normalizes to something else, or that is absolute.
 *
 * The caller supplies the parent, which it has already listed, so containment
 * needs no second check: the name cannot leave the directory it was typed in.
 *
 * @param name - the submitted name.
 * @returns the absolute path to create, or undefined when the name is refused.
 */
export function resolveNewDirectoryPath(parent: string, name: string): string | undefined {
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed === '.' || trimmed === '..') return undefined
  if (trimmed.includes('/') || trimmed.includes('\\')) return undefined
  if (trimmed.includes(sep) || trimmed.includes('\0')) return undefined
  const path = resolve(join(parent, trimmed))
  // A name that is a path in disguise (`~`, `C:`, a drive-relative spelling) is
  // caught here: the result must sit directly below the parent.
  return dirname(path) === resolve(parent) ? path : undefined
}

/**
 * Bind the route to the host's own file system.
 * @returns the route the host's connection layer can register.
 */
export function createDirsRoute(): ConnectionFetchRoute {
  return {
    path: DSHELL_DIRS_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method !== 'POST') return respond({ error: 'directory listing expects POST' }, 405)
      const home = homedir()
      let input: DshellDirsRequest = {}
      try {
        input = await request.json() as DshellDirsRequest
      } catch {
        // An unreadable body is an empty request, not a failure: the field is
        // optional and the home directory is the answer either way.
      }
      const path = resolveBrowsePath(typeof input.path === 'string' ? input.path : undefined, home)
      if (input.action === 'mkdir') return await createDirectory(path, typeof input.name === 'string' ? input.name : '', home)
      return await readDirectory(path, home)
    },
  }
}

/**
 * List one directory, saying why when it cannot.
 *
 * @param path - absolute directory to list.
 * @param home - the host user's home directory, echoed for the picker's shortcuts.
 * @returns the answer.
 */
async function readDirectory(path: string, home: string): Promise<Response> {
  try {
    const listed = await listDirectories(path)
    const writable = await access(path, constants.W_OK).then(() => true, () => false)
    const parent = dirname(path)
    return respond({
      path,
      parent: parent === path ? null : parent,
      home,
      entries: listed.entries,
      writable,
      ...listed.truncated ? { truncated: true } : {},
    })
  } catch (error) {
    return respond(refusal(path, home, error))
  }
}

/**
 * Create one directory below `path`, then answer with ITS listing.
 *
 * Landing the reader inside what they just made is the point: the picker's next
 * act is either to fill it or to take it, and both read better from inside. A
 * name that already exists is a note rather than an error — the reader picks the
 * existing directory instead, which the listing beside the note already shows.
 *
 * `mkdir` without `recursive` is deliberate: it fails with `ENOENT` if the parent
 * vanished between the listing and the request, and refusing is better than
 * silently rebuilding a tree the reader is not looking at.
 *
 * @param parent - the directory the name is created in.
 * @param name - the submitted name.
 * @param home - the host user's home directory, echoed for the picker's shortcuts.
 * @returns the answer, listing the new directory.
 */
async function createDirectory(parent: string, name: string, home: string): Promise<Response> {
  const target = resolveNewDirectoryPath(parent, name)
  if (target === undefined) {
    const listing = await readDirectory(parent, home)
    const body = await listing.json() as DshellDirsResponse
    return respond({ ...body, note: 'badName' })
  }
  try {
    await mkdir(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') {
      const listing = await readDirectory(parent, home)
      const body = await listing.json() as DshellDirsResponse
      // The parent's own refusal (missing, a file, unreadable) explains the
      // failure better than a bare code, and the picker already has words for it.
      if (body.note !== undefined) return respond(body)
      return respond({ path: parent, home, parent: dirname(parent), note: 'noAccess' })
    }
    // Already there: not a failure, but not a creation either.
    const listing = await readDirectory(parent, home)
    const body = await listing.json() as DshellDirsResponse
    return respond({ ...body, note: 'exists' })
  }
  const listing = await readDirectory(target, home)
  const body = await listing.json() as DshellDirsResponse
  return respond({ ...body, created: target })
}

/**
 * The refusal for a directory that could not be read.
 *
 * Three reasons, three answers, because the picker says which one it was rather
 * than "could not read": a path that is not there is a typo, a path that is a
 * file is a wrong pick, and a path that cannot be read is the one a permission
 * change can fix.
 *
 * @param path - the directory that was asked for.
 * @param home - the host user's home directory.
 * @param error - what the file system said.
 * @returns the answer body.
 */
function refusal(path: string, home: string, error: unknown): DshellDirsResponse {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOTDIR') return { path, home, parent: null, note: 'notDirectory' }
  if (code === 'ENOENT') return { path, home, parent: null, note: 'noDirectory' }
  if (code === 'EACCES' || code === 'EPERM') return { path, home, parent: null, note: 'noAccess' }
  return { error: error instanceof Error ? error.message : String(error) }
}
