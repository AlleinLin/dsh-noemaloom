import { lstat, mkdir, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { win32 } from 'node:path'

/** Selection is pure: startup and GET requests must never create this path. */
export function terminalWorkspaceRoot(home: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? win32.join(home, 'DSH-Terminal') : home
}

function sameWindowsPath(left: string, right: string): boolean {
  return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase()
}

function containsWindowsPath(parent: string, child: string): boolean {
  const relative = win32.relative(parent.toLowerCase(), child.toLowerCase())
  return relative === '' || relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative)
}

/**
 * Called only by the owner-only Connection route after the reader presses New.
 * This creates one fixed directory; Workspace adoption and Session creation
 * still pass through their original APIs, and PTY sandbox policy is untouched.
 */
export async function prepareTerminalRoot(
  root: string, signal?: AbortSignal,
  options: { home?: string; temporary?: string; platform?: NodeJS.Platform } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return
  const home = options.home ?? homedir()
  const fixed = terminalWorkspaceRoot(home, platform)
  if (!sameWindowsPath(root, fixed)) throw new Error('Only the fixed DSH terminal workspace can be prepared')
  signal?.throwIfAborted()
  const canonicalHome = await realpath(home)
  const canonicalRoot = win32.join(canonicalHome, 'DSH-Terminal')
  const temporary = await realpath(options.temporary ?? tmpdir())
  if (containsWindowsPath(canonicalRoot, temporary)) throw new Error('The terminal workspace must not contain the temporary directory')
  let entry = await lstat(root).catch(error => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (entry === undefined) {
    signal?.throwIfAborted()
    await mkdir(root).catch(error => { if (error.code !== 'EEXIST') throw error })
    entry = await lstat(root)
  }
  if (!entry.isDirectory() || entry.isSymbolicLink() || !sameWindowsPath(await realpath(root), canonicalRoot)) {
    throw new Error('The terminal workspace must be a real child directory, not a link or redirected path')
  }
  signal?.throwIfAborted()
}
