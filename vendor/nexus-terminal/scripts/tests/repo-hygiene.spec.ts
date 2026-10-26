/**
 * The repository must not carry one machine's identity.
 *
 * The repo is PUBLIC, so a tracked file is published the moment it is pushed.
 * That makes three things worth ruling out mechanically, because each of them
 * has already happened here:
 *
 * - a device's public address, in text (the handover document) or in pixels
 *   (two screenshots: `grep` is blind to a PNG, and one of them was the
 *   README's first image);
 * - a home directory, which says whose machine it was — the lockfile carried
 *   thirty of them, written by pnpm on one author's Linux box;
 * - a `link:`/`file:` spec with an absolute path, which cannot be installed
 *   from anywhere else.
 *
 * The images are the interesting case: no text rule can see inside a PNG, so
 * the tracked set is pinned by NAME here. A new screenshot has to be added
 * here deliberately, which is the moment to look at it.
 *
 * What is allowed: the repo's own fictional users (`/home/reader` and
 * friends), the loopback and private ranges, and paths that are relative.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** The home directories the repo may mention: its own invented ones. */
const FICTIONAL_USERS: ReadonlySet<string> = new Set([
  'reader', 'dev', 'pi', 'u', 'other', 'deploy', 'user', 'box', 'nobody',
])

/** The images the repo tracks. A new one has to be listed here on purpose. */
const TRACKED_IMAGES: readonly string[] = [
  'docs/images/device-file-pane.png',
  'docs/images/device-status-card.png',
  'docs/images/device-terminal.png',
  'docs/images/main-view.png',
  'docs/images/pipe-detail.png',
  'docs/images/pipe-graph.png',
  'docs/images/task-block.png',
  'docs/images/usage.png',
]

/** Extensions whose bytes are not text; they are checked by name instead. */
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.mp4', '.woff', '.woff2', '.ttf', '.zip', '.gz'])

/** The addresses that are not an address: loopback, private, unspecified. */
function isPublicAddress(address: string): boolean {
  const parts = address.split('.').map(part => Number(part))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  if (a === 10 || a === 127 || a === 0) return false
  if (a === 192 && b === 168) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 255) return false
  // The ranges reserved for documentation are not anybody's machine either.
  if (a === 192 && b === 0 && parts[2] === 2) return false
  if (a === 198 && b === 51 && parts[2] === 100) return false
  if (a === 203 && b === 0 && parts[2] === 113) return false
  return true
}

/** The tracked files, as git sees them. */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
  return out.split('\0').filter(name => name !== '')
}

/**
 * Whether a path is a build artifact or a local tool's workspace.
 *
 * Both are things a machine leaves behind: a packed tarball carries whatever
 * the working tree held when it was packed, and a design tool's workspace
 * records the machine the design was made against — its address, its private
 * registry. Neither is source, and the second one has already carried a
 * device's public address into this directory.
 */
function isLocalArtifact(file: string): boolean {
  return file.endsWith('.tgz') || file.startsWith('.superdesign/')
}

/**
 * The paths the ignore rules must cover.
 *
 * These are the artifacts this work actually leaves behind, named so the
 * rule that covers them can be checked rather than assumed.
 */
const LOCAL_ARTIFACTS: readonly string[] = [
  'packages/dshell/mode/nexus-aethra-dshell-mode-0.1.14.tgz',
  '.superdesign/init/pages.md',
]

describe('the repository carries no machine of its own', () => {
  it('names no public address in a tracked file', () => {
    const found: string[] = []
    for (const file of trackedFiles()) {
      if (BINARY_EXTENSIONS.has(file.slice(file.lastIndexOf('.')))) continue
      const text = readFileSync(join(REPO_ROOT, file), 'utf8')
      text.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g)) {
          if (isPublicAddress(match[0])) found.push(`${file}:${index + 1} ${match[0]}`)
        }
      })
    }
    expect(found).toEqual([])
  })

  it('names no home directory but its own invented ones', () => {
    const found: string[] = []
    for (const file of trackedFiles()) {
      if (BINARY_EXTENSIONS.has(file.slice(file.lastIndexOf('.')))) continue
      const text = readFileSync(join(REPO_ROOT, file), 'utf8')
      text.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(/\/home\/([A-Za-z0-9._-]+)\//g)) {
          if (!FICTIONAL_USERS.has(match[1])) found.push(`${file}:${index + 1} /home/${match[1]}/`)
        }
        for (const match of line.matchAll(/[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)\\?/g)) {
          if (!FICTIONAL_USERS.has(match[1])) found.push(`${file}:${index + 1} ${match[0]}`)
        }
      })
    }
    expect(found).toEqual([])
  })

  it('pins no dependency to an absolute path', () => {
    const found: string[] = []
    for (const file of trackedFiles()) {
      if (BINARY_EXTENSIONS.has(file.slice(file.lastIndexOf('.')))) continue
      const text = readFileSync(join(REPO_ROOT, file), 'utf8')
      text.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(/(?:link|file):(?:\/\/)?[A-Za-z]:[\\/]/g)) found.push(`${file}:${index + 1} ${match[0]}`)
        for (const match of line.matchAll(/(?:link|file):\/(?!dsh\/|home\/reader|\/)/g)) found.push(`${file}:${index + 1} ${match[0]}`)
      })
    }
    expect(found).toEqual([])
  })

  it('tracks exactly the images it says it does', () => {
    // The README's own pictures: these are the ones a reader sees, and the
    // ones a machine's address can hide in. The icons and the whale are build
    // assets, not pictures of a session.
    const images = trackedFiles().filter(file => file.startsWith('docs/images/') && file.endsWith('.png'))
    expect([...images].sort()).toEqual([...TRACKED_IMAGES].sort())
  })

  it('tracks no build artifact and no local tool workspace', () => {
    // The ignore rule is the first line of defence; this is the second, and
    // it is the one that catches a forced add.
    const found = trackedFiles().filter(isLocalArtifact)
    expect(found).toEqual([])
  })

  it('ignores the artifacts a build or a design tool leaves behind', () => {
    // The rule has to exist, not merely be intended: a rule that was renamed
    // away would leave the artifact one `git add` away from the public
    // repository.
    const ignored = execFileSync('git', ['check-ignore', '-v', ...LOCAL_ARTIFACTS], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    for (const artifact of LOCAL_ARTIFACTS) {
      expect(ignored).toContain(artifact)
    }
  })
})

describe('the guard itself is honest', () => {
  it('would catch a public address', () => {
    // Assembled from parts on purpose: a literal address in this file would be
    // the very thing the rule forbids, and the guard would (rightly) fail on
    // itself.
    const address = ['43', '138', '57', '105'].join('.')
    expect(isPublicAddress(address)).toBe(true)
    expect(isPublicAddress('10.0.0.1')).toBe(false)
    expect(isPublicAddress('127.0.0.1')).toBe(false)
    expect(isPublicAddress('192.168.1.4')).toBe(false)
    expect(isPublicAddress('203.0.113.5')).toBe(false)
  })

  it('is looking at a repository that exists', () => {
    expect(statSync(REPO_ROOT).isDirectory()).toBe(true)
    expect(relative(REPO_ROOT, join(REPO_ROOT, 'package.json'))).toBe('package.json')
  })

  it('knows an artifact from a source file', () => {
    // A guard that cannot tell a tarball from a source file guards nothing.
    expect(isLocalArtifact('packages/dshell/mode/nexus-aethra-dshell-mode-0.1.14.tgz')).toBe(true)
    expect(isLocalArtifact('.superdesign/init/pages.md')).toBe(true)
    expect(isLocalArtifact('packages/dshell/mode/src/client/device-panel.tsx')).toBe(false)
    expect(isLocalArtifact('docs/handoff.md')).toBe(false)
  })
})
