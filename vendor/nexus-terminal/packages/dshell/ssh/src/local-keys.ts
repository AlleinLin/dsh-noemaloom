/**
 * The harness user's own `~/.ssh`, read on their behalf.
 *
 * Exists because the device form's alternative to pasting a private key should
 * not require having the key on the clipboard. The browser is told NAMES and
 * paths; the contents come back only for a path the host recognises as one of
 * its own, so this file is a closed list rather than an arbitrary read primitive.
 *
 * `~/.ssh/config` may name an `IdentityFile` outside that directory. Those are
 * deliberately not offered: a device form that can read any path the user types
 * is a different and much larger thing to hand out than a picker over one
 * directory.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { SshKeyFile } from '@nexus-aethra/dshell-std'

/** One entry the picker may offer. */
export interface LocalKey extends SshKeyFile {
  readonly path: string
}

/** Names that live in `~/.ssh` but are never private keys. */
const NOT_A_KEY = new Set(['config', 'known_hosts', 'known_hosts.old', 'authorized_keys', 'environment'])

/** A private key's first line, in either OpenSSH or PEM spelling. */
const KEY_HEADER = /^-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY-{5}$/

/** Bounded so a pathological home directory cannot turn the picker into a scan. */
const MAX_ENTRIES = 64
const MAX_KEY_BYTES = 64 * 1024

/** `~/.ssh` as an absolute path with no trailing separator. */
export function sshDirectory(): string {
  return join(homedir(), '.ssh')
}

/**
 * Whether a path is inside `~/.ssh`.
 *
 * Checked on the way back as well as on the way in: the picker sends a path, and
 * between listing and reading that path is a string the browser supplied.
 *
 * @param path - the path to test.
 * @returns true when the path is a file under `~/.ssh`.
 */
export function isInsideSshDirectory(path: string): boolean {
  const root = resolve(sshDirectory())
  const full = resolve(path)
  if (full === root) return false
  return full.startsWith(root + sep)
}

/**
 * The private keys in `~/.ssh`, newest name order.
 *
 * Read by CONTENT rather than by name, because the name is a convention and the
 * header is the fact: `id_ed25519` is usually a key and is sometimes a note to
 * oneself, and a user who named a key `prod.pem` deserves it offered too. Every
 * format `ssh` accepts opens with a `BEGIN … PRIVATE KEY` line, so the header
 * test loses nothing by being the only test.
 *
 * @returns the keys, or an empty list when there is no `~/.ssh`.
 */
export async function listLocalKeys(): Promise<LocalKey[]> {
  let names: string[]
  try {
    names = await readdir(sshDirectory())
  } catch {
    return []
  }
  const found: LocalKey[] = []
  for (const name of names.sort()) {
    if (found.length >= MAX_ENTRIES) break
    if (NOT_A_KEY.has(name) || name.endsWith('.pub') || name.endsWith('.bak')) continue
    const path = join(sshDirectory(), name)
    // Follows the same rules ssh does: a key must be a regular file, and it is
    // the permission on the FILE that matters (ssh refuses a group-readable one).
    const info = await stat(path).catch(() => undefined)
    if (info?.isFile() !== true) continue
    const head = await readHead(path)
    if (head === undefined || !KEY_HEADER.test(head)) continue
    found.push({ name, path })
  }
  return found
}

/** The first line of a file, or undefined when it cannot be read or is huge. */
async function readHead(path: string): Promise<string | undefined> {
  try {
    const handle = await stat(path)
    if (handle.size > MAX_KEY_BYTES) return undefined
    const text = await readFile(path, 'utf8')
    return text.split('\n')[0]?.trim() ?? ''
  } catch {
    return undefined
  }
}

/**
 * One listed key's contents.
 *
 * @param path - a path from {@link listLocalKeys}.
 * @returns the key text, or undefined when the path is not one of ours.
 */
export async function readLocalKey(path: string): Promise<string | undefined> {
  if (!isInsideSshDirectory(path)) return undefined
  const known = await listLocalKeys()
  if (!known.some(key => key.path === resolve(path))) return undefined
  return await readFile(resolve(path), 'utf8').catch(() => undefined)
}
