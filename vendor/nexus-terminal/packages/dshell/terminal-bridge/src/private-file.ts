/**
 * Owner-only artifacts for the bridge.
 *
 * The terminal transcript is the most sensitive file this plugin owns: it holds
 * everything the shell printed, and — because the splitter records the input
 * side too — every line the user typed. Under a group-writable umask those
 * files were being created 0664, so any other account on the machine could read
 * them, while `history.sqlite` (which SQLite creates itself) was already 0600.
 *
 * Creation mode alone would only fix future sessions, so a write also tightens
 * the file it just wrote: an existing transcript left at 0664 by an earlier
 * build is exactly the file worth closing.
 */

import { chmod, writeFile } from 'node:fs/promises'

/** Mode for a file only its owner may read. */
export const PRIVATE_FILE_MODE = 0o600

/** Mode for a directory only its owner may enter. */
export const PRIVATE_DIR_MODE = 0o700

/** Tighten one path, best effort: a mode is not worth failing a write over. */
async function tighten(path: string, mode: number): Promise<void> {
  await chmod(path, mode).catch(() => { /* best effort */ })
}

/** Write a file owner-only, tightening a pre-existing one as well. */
export async function writePrivate(path: string, data: string): Promise<void> {
  await writeFile(path, data, { encoding: 'utf8', mode: PRIVATE_FILE_MODE })
  await tighten(path, PRIVATE_FILE_MODE)
}

/** Tighten a file this module did not create (an append handle's target). */
export async function hardenFile(path: string): Promise<void> {
  await tighten(path, PRIVATE_FILE_MODE)
}

/** Tighten a directory this module did not create. */
export async function hardenDir(path: string): Promise<void> {
  await tighten(path, PRIVATE_DIR_MODE)
}
