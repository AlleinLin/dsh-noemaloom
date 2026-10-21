/**
 * Durable buffer state: one JSON document holding every link, ticket and grant.
 *
 * Written atomically (temp file + rename) with 0600/0700 modes, the same
 * convention the SSH device store uses: a half-written document would lose
 * outstanding tickets, and a ticket lost on disk is a requester that never
 * gets woken.
 *
 * The store is deliberately dumb — read and write a whole document. Ordering
 * and consistency belong to the service, which serializes its own mutations.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BufferGrant, BufferLink, BufferTicket } from './protocol.js'
import { bufferRoot } from './paths.js'

/** Current document shape version, so a future migration can recognise a file. */
export const BUFFER_DOC_VERSION = 1

/** The whole persisted buffer. */
export interface BufferDocument {
  readonly version: number
  readonly links: readonly BufferLink[]
  readonly tickets: readonly BufferTicket[]
  readonly grants: readonly BufferGrant[]
}

const EMPTY: BufferDocument = { version: BUFFER_DOC_VERSION, links: [], tickets: [], grants: [] }

/** The state document's path. */
export function bufferDocumentPath(): string {
  return join(bufferRoot(), 'state.json')
}

/**
 * Read the state document. Anything unreadable or malformed reads empty rather
 * than throwing: a corrupt buffer must not stop dsh from starting, and the
 * tickets it cannot read were already unusable.
 */
export function readDocument(): BufferDocument {
  const path = bufferDocumentPath()
  if (!existsSync(path)) return EMPTY
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return EMPTY
    const record = parsed as Partial<BufferDocument>
    return {
      version: typeof record.version === 'number' ? record.version : BUFFER_DOC_VERSION,
      links: Array.isArray(record.links) ? record.links : [],
      tickets: Array.isArray(record.tickets) ? record.tickets : [],
      grants: Array.isArray(record.grants) ? record.grants : [],
    }
  } catch {
    return EMPTY
  }
}

/**
 * Replace the state document atomically. The temp file lives beside the target
 * so the rename stays within one filesystem; the directory is created 0700 and
 * the file 0600 because a grant names paths the user chose to expose.
 */
export function writeDocument(document: BufferDocument): void {
  const root = bufferRoot()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = bufferDocumentPath()
  const tmp = `${path}.${String(process.pid)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}
