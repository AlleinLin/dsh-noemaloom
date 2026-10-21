/**
 * The known_hosts grammar, and the decisions it drives.
 *
 * The file this plugin reads was written by OpenSSH, which means it can be in
 * either of two shapes — plain destinations or HMAC-hashed ones — and the answer
 * to "will dshell accept this key" has to be the same for both. These pin the
 * shapes a real file carries, including the hashed one most distributions leave
 * behind, and the three outcomes a comparison can reach.
 */

import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  entriesFor,
  fingerprintOf,
  hostKeyDecision,
  knownHostsLookup,
  keyTypeOfBlob,
  readKnownHosts,
  recordHostKey,
  revokeHostKeys,
} from '../src/transport/known-hosts.js'

/** A directory holding the known_hosts these cases write, removed with the process. */
const scratch = mkdtempSync(join(tmpdir(), 'dshell-known-hosts-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

function file(name: string, body: string): string {
  const path = join(scratch, name)
  writeFileSync(path, body)
  return path
}

/** An ed25519 public key blob: the algorithm name, then its 32 bytes. */
const ED25519 = Buffer.concat([
  Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'),
  Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7),
])
const ED25519_BASE64 = ED25519.toString('base64')
const OTHER = Buffer.concat([
  Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'),
  Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 9),
])
const OTHER_BASE64 = OTHER.toString('base64')

/** OpenSSH's hashed form of one destination: `|1|salt|hmac`. */
function hashed(salt: Buffer, destination: string): string {
  return `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(destination).digest('base64')}`
}

describe('the destination spelling', () => {
  it('is the bare host on the default port', () => {
    expect(knownHostsLookup('example.test', 22)).toBe('example.test')
  })

  it('is bracketed with the port everywhere else', () => {
    // The one case that silently reports "nothing trusted" when it is wrong.
    expect(knownHostsLookup('example.test', 2222)).toBe('[example.test]:2222')
  })
})

describe('reading a file', () => {
  it('reads a plain entry', () => {
    const entries = readKnownHosts(file('plain', `example.test ssh-ed25519 ${ED25519_BASE64}\n`))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ host: 'example.test', keyType: 'ssh-ed25519', blob: ED25519_BASE64 })
  })

  it('reads a hashed entry and matches it by destination', () => {
    const salt = Buffer.alloc(16, 3)
    const entries = readKnownHosts(file('hashed', `${hashed(salt, 'example.test')} ssh-ed25519 ${ED25519_BASE64}\n`))
    expect(entries).toHaveLength(1)
    expect(entriesFor(entries, 'example.test', 22)).toHaveLength(1)
    // A different destination never matches, which is the point of hashing.
    expect(entriesFor(entries, 'other.test', 22)).toHaveLength(0)
  })

  it('keeps every key type one destination has', () => {
    const entries = readKnownHosts(file('two', [
      `example.test ssh-ed25519 ${ED25519_BASE64}`,
      `example.test ecdsa-sha2-nistp256 ${OTHER_BASE64}`,
      '',
    ].join('\n')))
    expect(entriesFor(entries, 'example.test', 22).map(entry => entry.keyType))
      .toEqual(['ssh-ed25519', 'ecdsa-sha2-nistp256'])
  })

  it('reads a bracketed non-default port', () => {
    const entries = readKnownHosts(file('port', `[example.test]:2222 ssh-ed25519 ${ED25519_BASE64}\n`))
    expect(entriesFor(entries, 'example.test', 2222)).toHaveLength(1)
    expect(entriesFor(entries, 'example.test', 22)).toHaveLength(0)
  })

  it('reads a marker and remembers it', () => {
    const entries = readKnownHosts(file('revoked', `@revoked example.test ssh-ed25519 ${ED25519_BASE64}\n`))
    expect(entries[0]?.marker).toBe('revoked')
  })

  it('drops a comment, a blank line and a malformed one', () => {
    // An unparseable line matches no destination, so refusing the whole file
    // over one would disable every device because of a hand edit.
    const entries = readKnownHosts(file('mixed', [
      '# a comment',
      '',
      'nonsense',
      `example.test ssh-ed25519 ${ED25519_BASE64}`,
      '',
    ].join('\n')))
    expect(entries).toHaveLength(1)
  })

  it('answers nothing for a file that is not there', () => {
    expect(readKnownHosts(join(scratch, 'absent'))).toEqual([])
  })
})

describe('deciding what an offered key means', () => {
  const entries = readKnownHosts(file('decision', [
    `example.test ssh-ed25519 ${ED25519_BASE64}`,
    `other.test ssh-ed25519 ${OTHER_BASE64}`,
    '',
  ].join('\n')))

  it('trusts the exact key recorded for the destination', () => {
    expect(hostKeyDecision(entries, 'example.test', 22, ED25519)).toBe('trusted')
  })

  it('treats an unrecorded destination as first contact', () => {
    expect(hostKeyDecision(entries, 'fresh.test', 22, ED25519)).toBe('first')
  })

  it('calls a different key for a recorded destination changed', () => {
    expect(hostKeyDecision(entries, 'example.test', 22, OTHER)).toBe('changed')
  })

  it('calls a revoked key revoked even though it is recorded', () => {
    const revoked = readKnownHosts(file('revoked-decision', `@revoked example.test ssh-ed25519 ${ED25519_BASE64}\n`))
    expect(hostKeyDecision(revoked, 'example.test', 22, ED25519)).toBe('revoked')
  })
})

describe('recording a key', () => {
  it('writes a hashed entry and appends to what is there', () => {
    const path = file('record', `# kept\n`)
    recordHostKey(path, 'example.test', 22, ED25519)
    recordHostKey(path, 'example.test', 2222, OTHER)
    const entries = readKnownHosts(path)
    expect(entries).toHaveLength(2)
    // The destination is not readable from the file, which is what a stock
    // OpenSSH client leaves behind on a `HashKnownHosts=yes` host.
    expect(readFileSync(path, 'utf8')).not.toContain('example.test')
    expect(hostKeyDecision(entries, 'example.test', 22, ED25519)).toBe('trusted')
    expect(hostKeyDecision(entries, 'example.test', 2222, OTHER)).toBe('trusted')
  })

  it('names the key type out of the blob itself', () => {
    expect(keyTypeOfBlob(ED25519)).toBe('ssh-ed25519')
    expect(keyTypeOfBlob(Buffer.alloc(0))).toBeUndefined()
  })

  it('spells a fingerprint the way OpenSSH does', () => {
    expect(fingerprintOf(ED25519_BASE64)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/u)
  })
})

describe('dropping a destination', () => {
  it('removes every key it has and leaves the others', () => {
    const path = file('revoke', [
      `example.test ssh-ed25519 ${ED25519_BASE64}`,
      `example.test ecdsa-sha2-nistp256 ${OTHER_BASE64}`,
      `other.test ssh-ed25519 ${OTHER_BASE64}`,
      '',
    ].join('\n'))
    expect(revokeHostKeys(path, 'example.test', 22)).toBe(true)
    expect(entriesFor(readKnownHosts(path), 'example.test', 22)).toHaveLength(0)
    expect(entriesFor(readKnownHosts(path), 'other.test', 22)).toHaveLength(1)
  })

  it('reports nothing removed when there was nothing', () => {
    const path = file('revoke-none', `other.test ssh-ed25519 ${OTHER_BASE64}\n`)
    expect(revokeHostKeys(path, 'example.test', 22)).toBe(false)
    expect(readKnownHosts(path)).toHaveLength(1)
  })

  it('is a no-op on a file that is not there', () => {
    expect(revokeHostKeys(join(scratch, 'absent'), 'example.test', 22)).toBe(false)
  })
})
