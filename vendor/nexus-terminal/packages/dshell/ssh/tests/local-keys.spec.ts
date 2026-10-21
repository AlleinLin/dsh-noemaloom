/**
 * Which files under `~/.ssh` the device form is allowed to offer, and which of
 * them it is allowed to read back.
 *
 * The read is the part that matters: the browser sends a path string, so every
 * assertion here is about a path being recognised as one of ours rather than
 * merely looking plausible.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isInsideSshDirectory, listLocalKeys, readLocalKey } from '../src/local-keys.js'

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz\n-----END OPENSSH PRIVATE KEY-----\n'

let home = ''
let ssh = ''

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dshell-home-'))
  ssh = join(home, '.ssh')
  await mkdir(ssh, { recursive: true })
  // homedir() reads the process env, so the whole module-under-test has to be
  // pointed at the sandbox rather than the reader's real key directory.
  process.env.HOME = home
  process.env.USERPROFILE = home
})

afterEach(async () => {
  delete process.env.HOME
  delete process.env.USERPROFILE
  await rm(home, { recursive: true, force: true })
})

describe('listing', () => {
  it('offers a private key', async () => {
    await writeFile(join(ssh, 'id_ed25519'), KEY)
    expect((await listLocalKeys()).map(k => k.name)).toEqual(['id_ed25519'])
  })

  it('offers a key that does not follow the id_ convention', async () => {
    await writeFile(join(ssh, 'prod_ed25519'), KEY)
    expect((await listLocalKeys()).map(k => k.name)).toEqual(['prod_ed25519'])
  })

  it('never offers the things that live beside keys', async () => {
    for (const name of ['config', 'known_hosts', 'authorized_keys', 'environment']) {
      await writeFile(join(ssh, name), 'anything at all')
    }
    await writeFile(join(ssh, 'id_ed25519.pub'), KEY)
    await writeFile(join(ssh, 'id_ed25519.bak'), KEY)
    await writeFile(join(ssh, 'id_ed25519'), KEY)
    expect((await listLocalKeys()).map(k => k.name)).toEqual(['id_ed25519'])
  })

  it('offers a directory of notes and config as nothing', async () => {
    await writeFile(join(ssh, 'id_ed25519'), 'just a note about the id_ed25519 key\n')
    expect(await listLocalKeys()).toEqual([])
  })

  it('is empty when there is no ~/.ssh at all', async () => {
    await rm(ssh, { recursive: true, force: true })
    expect(await listLocalKeys()).toEqual([])
  })
})

describe('reading a listed key back', () => {
  it('returns the contents for a path it listed', async () => {
    const path = join(ssh, 'id_ed25519')
    await writeFile(path, KEY)
    expect(await readLocalKey(path)).toBe(KEY)
  })

  it('refuses a path outside ~/.ssh', async () => {
    await writeFile(join(home, 'secret'), KEY)
    expect(await readLocalKey(join(home, 'secret'))).toBeUndefined()
  })

  // The traversal case: a path that STARTS inside ~/.ssh and climbs out of it.
  it('refuses a path that climbs out of ~/.ssh', async () => {
    const outside = join(home, 'secret')
    await writeFile(outside, KEY)
    expect(await readLocalKey(join(ssh, '..', 'secret'))).toBeUndefined()
  })

  it('refuses the directory itself', async () => {
    expect(await readLocalKey(ssh)).toBeUndefined()
  })

  it('refuses a key-shaped file it did not list', async () => {
    // Present under ~/.ssh but excluded by the listing rules, so the read has
    // to apply the same rules rather than only the path shape.
    await writeFile(join(ssh, 'known_hosts'), KEY)
    expect(await readLocalKey(join(ssh, 'known_hosts'))).toBeUndefined()
  })
})

describe('the containment check', () => {
  it('accepts a file inside', () => {
    expect(isInsideSshDirectory(join(ssh, 'id_ed25519'))).toBe(true)
  })

  it('rejects the root and anything outside it', () => {
    expect(isInsideSshDirectory(ssh)).toBe(false)
    expect(isInsideSshDirectory('/etc/passwd')).toBe(false)
  })

  it('rejects a sibling whose name merely starts the same', () => {
    expect(isInsideSshDirectory(`${ssh}-other/id_ed25519`)).toBe(false)
  })
})
