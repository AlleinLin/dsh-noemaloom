/**
 * What the vault actually guarantees about the bytes it writes.
 *
 * The claims worth testing are the ones that would fail silently: a wrong token
 * that decrypts to garbage instead of refusing, a secret that stays plain after
 * its group was set to sealed, a group whose policy flip strands what was
 * already stored. None of those throw anywhere near the mistake.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SecretVault, VaultLockedError, SEAL_MARKER } from '../src/vault.js'
import { CredentialStore } from '../src/credentials.js'

const KEY_BODY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\n'

let dir = ''
let vault: SecretVault
let credentials: CredentialStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dshell-vault-'))
  vault = new SecretVault(() => dir)
  credentials = new CredentialStore(() => dir, vault)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A sealed group, unlocked, with its token kept for the tests that re-lock. */
async function openGroup(name = '工作', token = 'correct horse'): Promise<string> {
  const group = await vault.createGroup(name, token)
  return group.id
}

describe('a sealed group', () => {
  it('comes back locked after a fresh instance reads the same document', async () => {
    const id = await openGroup()
    const reopened = new SecretVault(() => dir)
    const groups = await reopened.list()
    expect(groups.find(g => g.id === id)).toMatchObject({ sealed: true, locked: true })
  })

  // The load-bearing claim of using GCM at all.
  it('refuses a wrong token instead of producing garbage', async () => {
    const id = await openGroup()
    await vault.lock(id)
    await expect(vault.unlock(id, 'wrong horse')).rejects.toBeInstanceOf(VaultLockedError)
    // And the group stays locked rather than half-open.
    expect((await vault.list()).find(g => g.id === id)?.locked).toBe(true)
  })

  it('opens with the right token and round-trips a secret', async () => {
    const id = await openGroup()
    const sealed = await vault.sealFor(id, KEY_BODY)
    expect(sealed).not.toContain('b3BlbnNzaC1rZXk')
    expect(await vault.openFor(id, sealed)).toBe(KEY_BODY)
  })

  // Both paths must agree byte-for-byte, or simply enabling a token would change
  // what ssh receives — and OpenSSH's key parser requires that newline.
  it('keeps the trailing newline a key parser requires', async () => {
    const id = await openGroup()
    expect(await vault.openFor(id, await vault.sealFor(id, 'no-newline'))).toBe('no-newline\n')
    const plain = await vault.createGroup('临时', null)
    expect(await vault.sealFor(plain.id, 'no-newline')).toBe('no-newline\n')
  })

  it('throws rather than handing back a sealed body it cannot open', async () => {
    const id = await openGroup()
    const sealed = await vault.sealFor(id, KEY_BODY)
    await vault.lock(id)
    await expect(vault.openFor(id, sealed)).rejects.toBeInstanceOf(VaultLockedError)
  })

  // The message reaches the browser verbatim, so it is part of the contract.
  it('names the refusal in words the reader can act on', async () => {
    const id = await openGroup()
    await vault.lock(id)
    await expect(vault.unlock(id, 'wrong horse')).rejects.toThrow('令牌不正确')
  })

  it('reports whether a group carries a token at all', async () => {
    // What tells an unlock box from a claim: the default group and a plain
    // group have no token to check a guess against, so offering them one would
    // be offering a door with no lock.
    const sealed = await openGroup()
    const plain = await vault.createGroup('明文', null)
    const groups = await vault.list()
    expect(groups.find(g => g.id === sealed)).toMatchObject({ hasToken: true })
    expect(groups.find(g => g.id === plain.id)).toMatchObject({ hasToken: false })
  })
})

describe('the default group a fresh vault creates', () => {
  it('is sealed, so a credential with nowhere to go is never stored plainly', async () => {
    // Covered above in the store document; the state that matters here is the
    // one that follows from it.
    const groups = await vault.list()
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ id: 'default', sealed: true, locked: true, hasToken: false })
  })

  it('cannot be unlocked, because there is no token to check a guess against', async () => {
    // The dead end this replaces: `unlock` used to return silently for a group
    // with no kdf, so the reader typed a token into a box that could never open
    // and nothing at all happened.
    await vault.list()
    await expect(vault.unlock('default', 'anything at all')).rejects.toThrow('还没有令牌')
    await expect(vault.unlock('default', 'anything at all')).rejects.toBeInstanceOf(VaultLockedError)
  })

  it('refuses to write a credential while it cannot be opened', async () => {
    await vault.list()
    await expect(credentials.save({ group: 'default', name: '部署', kind: 'password', secret: 'pw' }))
      .rejects.toBeInstanceOf(VaultLockedError)
  })

  it('is claimed by setting a token, after which it behaves like any other group', async () => {
    await vault.list()
    await vault.setToken('default', 'claim me')
    expect((await vault.list()).find(g => g.id === 'default'))
      .toMatchObject({ sealed: true, locked: false, hasToken: true })
    const credential = await credentials.save({ group: 'default', name: '部署', kind: 'key', secret: KEY_BODY })
    expect(await credentials.open(credential.id, 'secret')).toBe(KEY_BODY)
    // A restart forgets the key, and the token that claimed the group reopens it.
    const reopened = new SecretVault(() => dir)
    expect((await reopened.list()).find(g => g.id === 'default')?.locked).toBe(true)
    await reopened.unlock('default', 'claim me')
    expect((await reopened.list()).find(g => g.id === 'default')?.locked).toBe(false)
  })
})

describe('a plain group', () => {
  it('writes its secrets unsealed and reads them with nothing unlocked', async () => {
    const group = await vault.createGroup('临时', null)
    const body = await vault.sealFor(group.id, KEY_BODY)
    expect(body).toBe(KEY_BODY)
    expect(SecretVault.isSealed(body)).toBe(false)
    expect(await vault.openFor(group.id, body)).toBe(KEY_BODY)
  })

  it('is reported as unsealed so the UI can say so out loud', async () => {
    const group = await vault.createGroup('临时', null)
    expect((await vault.list()).find(g => g.id === group.id)).toMatchObject({ sealed: false, locked: false })
  })
})

// The property that makes a policy change safe to offer: the file decides, not
// the group. If this ever reads the policy instead, flipping a group strands
// whatever was already in it.
describe('a group whose policy moves', () => {
  it('still reads a plain secret after the group was set to sealed', async () => {
    const plain = await vault.createGroup('会变的', null)
    const body = await vault.sealFor(plain.id, KEY_BODY)
    await vault.setToken(plain.id, 'a token')
    // Unwrapped or not, this body was plain, and it must still come back.
    expect(SecretVault.isSealed(body)).toBe(false)
    expect(await vault.openFor(plain.id, body)).toBe(KEY_BODY)
  })

  it('re-wraps stored credentials when the group gains a token', async () => {
    const group = await vault.createGroup('会变的', null)
    await credentials.save({ group: group.id, name: '部署密钥', kind: 'key', secret: KEY_BODY })
    const [credential] = await credentials.list()
    const file = join(dir, 'credentials', `${credential?.id}.key`)
    expect(await readFile(file, 'utf8')).toBe(KEY_BODY)

    await vault.setToken(group.id, 'a token')
    await credentials.rewrapGroup(group.id)
    const after = await readFile(file, 'utf8')
    expect(SecretVault.isSealed(after)).toBe(true)
    expect(after).not.toContain('b3BlbnNzaC1rZXk')

    // And the secret comes back through the group, byte for byte.
    expect(await credentials.open(credential?.id ?? '', 'secret')).toBe(KEY_BODY)
  })

  it('re-wraps back to plain when the group loses its token', async () => {
    const id = await openGroup()
    await credentials.save({ group: id, name: '口令', kind: 'password', secret: 'p@ss' })
    const [credential] = await credentials.list()
    await vault.clearToken(id)
    await credentials.rewrapGroup(id)
    const file = join(dir, 'credentials', `${credential?.id}.password`)
    expect(await readFile(file, 'utf8')).toBe('p@ss\n')
  })

  // GCM draws a fresh IV every call, so a second rewrap could never be
  // byte-identical anyway; what has to hold is that it does not touch a file
  // already in the shape the group calls for. That is what makes a rewrap
  // interrupted half-way through safe to simply run again.
  it('leaves an already-correct body alone, so an interrupted rewrap is resumable', async () => {
    const group = await vault.createGroup('会变的', null)
    await credentials.save({ group: group.id, name: '部署密钥', kind: 'key', secret: KEY_BODY })
    await vault.setToken(group.id, 'a token')
    await credentials.rewrapGroup(group.id)
    const [credential] = await credentials.list()
    const file = join(dir, 'credentials', `${credential?.id}.key`)
    const once = await readFile(file, 'utf8')
    await credentials.rewrapGroup(group.id)
    expect(await readFile(file, 'utf8')).toBe(once)
    expect(await credentials.open(credential?.id ?? '', 'secret')).toBe(KEY_BODY)
  })
})

// The promise a sealed group makes: its plaintext exists in memory and on no
// disk. The old design had to write it down, because the external `ssh` could
// only be handed a path to read; the transport is a library now, so it is
// handed the bytes.
describe('a sealed secret on the disk', () => {
  it('is written to no file, not even a temporary one', async () => {
    const id = await openGroup()
    await credentials.save({ group: id, name: '部署密钥', kind: 'key', secret: KEY_BODY })
    const [credential] = await credentials.list()

    // Opening it produces the plaintext, and the plaintext comes back as
    // bytes: there is no file for it to live in.
    expect(await credentials.open(credential?.id ?? '', 'secret')).toBe(KEY_BODY)

    // The only things on the disk are the sealed body and the two documents.
    expect((await readdir(dir)).sort()).toEqual(['credentials', 'credentials.json', 'vault.json'])
    const stored = await readFile(join(dir, 'credentials', `${credential?.id}.key`), 'utf8')
    expect(SecretVault.isSealed(stored)).toBe(true)
    expect(stored).not.toContain('b3BlbnNzaC1rZXk')
  })

  it('leaves no run/ directory, even for an installation that had one', async () => {
    // The upgrade path: the old design kept the plaintext there, and a host
    // upgraded from it still has the directory. Swept at start-up, because no
    // later moment would know those files were there.
    await mkdir(join(dir, 'run'), { recursive: true })
    await writeFile(join(dir, 'run', 'web.secret'), 'p@ss\n', { mode: 0o600 })
    await vault.sweepLegacyRunDir()
    expect(await readdir(dir)).not.toContain('run')
  })

  it('sweeps nothing else on the way', async () => {
    // The sweep is aimed at one directory. A credential that is still stored
    // is not collateral.
    const id = await openGroup()
    await credentials.save({ group: id, name: '部署密钥', kind: 'key', secret: KEY_BODY })
    await vault.sweepLegacyRunDir()
    expect((await readdir(dir)).sort()).toEqual(['credentials', 'credentials.json', 'vault.json'])
  })
})

describe('the store document', () => {
  it('never carries a secret, a key or a token', async () => {
    const id = await openGroup()
    await credentials.save({ group: id, name: '部署密钥', kind: 'key', secret: KEY_BODY, passphrase: 'hp' })
    const documents = [
      await readFile(join(dir, 'vault.json'), 'utf8'),
      await readFile(join(dir, 'credentials.json'), 'utf8'),
    ].join('\n')
    expect(documents).not.toContain('b3BlbnNzaC1rZXk')
    expect(documents).not.toContain('correct horse')
    expect(documents).not.toContain(SEAL_MARKER)
  })

  it('creates a sealed default group rather than a plain one', async () => {
    // A credential with nowhere to go must not default to unencrypted.
    const groups = await vault.list()
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ sealed: true })
  })
})
