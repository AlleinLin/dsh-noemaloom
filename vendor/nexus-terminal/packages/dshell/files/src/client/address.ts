/**
 * The `dsh-resource://file/…` address of one file, built here because dsh's own
 * builder is not reachable from a plugin bundle.
 *
 * `@deepseek-ai/dsh-util-workspace-path` owns this grammar but is not in the
 * browser module table, so a dshell client face cannot import it at runtime —
 * the same boundary that makes the stock file tree copy its sibling's header
 * row. The grammar it implements (from that package's `file-address.ts`) is
 * stable and small, and every segment is component-encoded with `:` left
 * literal so a Windows drive letter reads as written:
 *
 *   dsh-resource://file/session/<sessionId>/<path>
 *
 * The session scope accepts an absolute path, which is what this navigator
 * always passes: it roams outside the working directory, so a path relative to
 * that directory would name something else.
 */

/** Component-encode one id or path segment, keeping `:` literal for drive letters. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/giu, ':')
}

/**
 * Build the address of a file read through one session.
 * @param sessionId - the session whose world resolves the path.
 * @param path - absolute path in that world.
 * @returns the `dsh-resource://file/session/<sessionId>/<path>` address.
 */
export function sessionFileAddress(sessionId: string, path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '')
  const encoded = normalized.split('/').map(encodeSegment).join('/')
  return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encoded}`
}

/**
 * The parent directory of a POSIX path, or undefined at the root.
 *
 * Deliberately not `node:path`: both execution worlds here are POSIX, and a
 * device path must not be rewritten by a path module that assumes this
 * machine's platform.
 * @param path - absolute POSIX path.
 * @returns the parent directory, or undefined when there is none.
 */
export function parentOf(path: string): string | undefined {
  const trimmed = path.replace(/\/+$/u, '')
  if (trimmed === '' || trimmed === '/') return undefined
  const cut = trimmed.lastIndexOf('/')
  if (cut < 0) return undefined
  return cut === 0 ? '/' : trimmed.slice(0, cut)
}

/** One clickable crumb of a path. */
export interface PathSegment {
  readonly label: string
  /** Absolute path this crumb navigates to. */
  readonly path: string
}

/**
 * Split a POSIX path into the crumbs a header shows, root first.
 *
 * A path that is not absolute (a device-relative spelling, or a bare name) is
 * one crumb leading to itself, so the header still renders something usable.
 * @param path - absolute POSIX path.
 * @returns the crumbs, outer-most first.
 */
export function pathSegments(path: string): PathSegment[] {
  if (!path.startsWith('/')) return [{ label: path, path }]
  const segments: PathSegment[] = [{ label: '/', path: '/' }]
  let accumulated = ''
  for (const part of path.split('/').filter(part => part.length > 0)) {
    accumulated += `/${part}`
    segments.push({ label: part, path: accumulated })
  }
  return segments
}
