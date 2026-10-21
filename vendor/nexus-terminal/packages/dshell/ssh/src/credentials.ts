/**
 * The credential library: named secrets that devices point at.
 *
 * The reason this exists as its own store rather than a field on a device is
 * rotation. One deploy key commonly opens thirty machines; stored per device it
 * becomes thirty copies that drift the first time one is updated, and nothing
 * ever says which machines still use the old one. Stored once and referenced,
 * the key is edited in one place and every user of it can be listed.
 *
 * Every credential belongs to exactly one vault group, which decides whether its
 * bytes are sealed. See `vault.ts` for what that does and does not buy.
 *
 * The stored body is sealed on disk and the plaintext is produced when a live
 * connection asks for it — as bytes, handed straight to the transport that needs
 * them. A sealed group's plaintext is never written to a file, not even a
 * temporary one, so there is nothing on the disk to sweep when the group is
 * locked and nothing left behind when the process dies.
 *
 * Records hold PATHS, never contents, and the view handed to the API reports
 * only whether a secret exists — the same rule the device store has always
 * followed, so a settings document that leaks carries no credential in it.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CredentialInput, CredentialKind, CredentialView } from './protocol.js'
import { SecretVault } from './vault.js'

/** A stored credential. `file` holds the key or password; key may add a passphrase. */
interface CredentialRecord {
  id: string
  group: string
  name: string
  kind: CredentialKind
  file: string
  passphraseFile?: string
}

function asRecord(value: unknown): CredentialRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id.length === 0) return undefined
  if (typeof raw.file !== 'string' || raw.file.length === 0) return undefined
  if (typeof raw.group !== 'string' || raw.group.length === 0) return undefined
  return {
    id: raw.id,
    group: raw.group,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : raw.id,
    kind: raw.kind === 'password' ? 'password' : 'key',
    file: raw.file,
    ...(typeof raw.passphraseFile === 'string' && raw.passphraseFile.length > 0
      ? { passphraseFile: raw.passphraseFile }
      : {}),
  }
}

/** A fresh, path-safe credential id. */
function newId(): string {
  return `c-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}

/** The credential registry. */
export class CredentialStore {
  private loaded = false
  private records: CredentialRecord[] = []

  /**
   * @param root - resolves the ssh data directory, read when needed rather than
   *   captured: the data root is a setting settled while the composition runs.
   * @param vault - seals what this store writes. Shared with the device store so
   *   one unlock opens both.
   */
  constructor(private readonly root: () => string, private readonly vault: SecretVault) {}

  private get documentPath(): string {
    return join(this.root(), 'credentials.json')
  }

  /** Where credential bytes live, separate from the device keys directory. */
  private get secretDir(): string {
    return join(this.root(), 'credentials')
  }

  /** Every credential, in creation order. */
  async list(): Promise<readonly CredentialView[]> {
    await this.ensure()
    return this.records.map(record => this.view(record))
  }

  private view(record: CredentialRecord): CredentialView {
    return {
      id: record.id,
      group: record.group,
      name: record.name,
      kind: record.kind,
      hasSecret: true,
      hasPassphrase: record.passphraseFile !== undefined,
    }
  }

  private async ensure(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.documentPath, 'utf8')) as unknown
      const raw = Array.isArray(parsed) ? parsed : (parsed as { credentials?: unknown }).credentials
      this.records = (Array.isArray(raw) ? raw : []).flatMap(entry => {
        const record = asRecord(entry)
        return record === undefined ? [] : [record]
      })
    } catch {
      this.records = []
    }
  }

  private async persist(): Promise<void> {
    await mkdir(this.root(), { recursive: true, mode: 0o700 })
    await writeFile(this.documentPath, `${JSON.stringify({ credentials: this.records }, null, 2)}\n`, { mode: 0o600 })
  }

  /** Look one up without handing back its paths. */
  async get(id: string): Promise<CredentialView | undefined> {
    await this.ensure()
    const record = this.records.find(candidate => candidate.id === id)
    return record === undefined ? undefined : this.view(record)
  }

  /**
   * Create or update one credential.
   *
   * @param input - the submitted credential; `id` absent means create.
   * @throws when the name or group is missing, or a passphrase is given to a
   *   password credential — a secret nothing will ever read is the shape of a
   *   credential nobody rotates.
   */
  async save(input: CredentialInput): Promise<CredentialView> {
    await this.ensure()
    if (!await this.vault.list().then(groups => groups.some(group => group.id === input.group))) {
      throw new Error('unknown vault group')
    }
    if (input.name.trim() === '') throw new Error('credential name is empty')
    const existing = input.id === undefined ? undefined : this.records.find(candidate => candidate.id === input.id)
    if (input.id !== undefined && existing === undefined) throw new Error(`unknown credential ${input.id}`)
    if (input.kind === 'password' && input.passphrase !== undefined && input.passphrase !== '') {
      throw new Error('a password credential has no key to unlock')
    }
    const id = existing?.id ?? newId()
    // A credential's kind decides its file name, so switching kind has to move
    // the bytes rather than relabel them — and a create has no bytes yet.
    if (existing !== undefined && existing.kind !== input.kind) await this.removeFiles(existing)
    const record: CredentialRecord = {
      id,
      group: input.group,
      name: input.name.trim(),
      kind: input.kind,
      file: join(this.secretDir, `${id}.${input.kind === 'password' ? 'password' : 'key'}`),
      ...existing?.passphraseFile === undefined ? {} : { passphraseFile: existing.passphraseFile },
    }
    if (input.secret !== undefined && input.secret.trim() !== '') {
      record.file = await this.writeBody(id, input.kind, input.secret, input.group)
    }
    if (input.passphrase !== undefined) {
      if (input.passphrase === '') {
        await this.removePassphrase(record)
      } else {
        record.passphraseFile = await this.writePassphrase(id, input.passphrase, input.group)
      }
    }
    this.records = existing === undefined
      ? [...this.records, record]
      : this.records.map(candidate => candidate.id === record.id ? record : candidate)
    await this.persist()
    return this.view(record)
  }

  /** Remove one credential and its stored bytes. */
  async remove(id: string): Promise<void> {
    await this.ensure()
    const record = this.records.find(candidate => candidate.id === id)
    if (record === undefined) return
    await this.removeFiles(record)
    this.records = this.records.filter(candidate => candidate.id !== id)
    await this.persist()
  }

  private async writeBody(id: string, kind: CredentialKind, secret: string, group: string): Promise<string> {
    await mkdir(this.secretDir, { recursive: true, mode: 0o700 })
    const path = join(this.secretDir, `${id}.${kind === 'password' ? 'password' : 'key'}`)
    await writeFile(path, await this.vault.sealFor(group, secret), { mode: 0o600 })
    return path
  }

  private async writePassphrase(id: string, passphrase: string, group: string): Promise<string> {
    await mkdir(this.secretDir, { recursive: true, mode: 0o700 })
    const path = join(this.secretDir, `${id}.passphrase`)
    await writeFile(path, await this.vault.sealFor(group, passphrase), { mode: 0o600 })
    return path
  }

  private async removeFiles(record: CredentialRecord): Promise<void> {
    await rm(record.file, { force: true })
    if (record.passphraseFile !== undefined) await rm(record.passphraseFile, { force: true })
  }

  private async removePassphrase(record: CredentialRecord): Promise<void> {
    if (record.passphraseFile === undefined) return
    await rm(record.passphraseFile, { force: true })
    delete record.passphraseFile
  }

  /**
   * The stored body of one credential's secret.
   *
   * Returned rather than opened because the caller decides whether it needs
   * plaintext at all: a listing needs nothing, a rewrap needs the body's shape,
   * and only a live connection needs the secret.
   */
  async bodyOf(id: string, which: 'secret' | 'passphrase'): Promise<string | undefined> {
    await this.ensure()
    const record = this.records.find(candidate => candidate.id === id)
    if (record === undefined) return undefined
    const path = which === 'secret' ? record.file : record.passphraseFile
    if (path === undefined) return undefined
    return await readFile(path, 'utf8').catch(() => undefined)
  }

  /** Which group a credential belongs to, for the seal on the read path. */
  async groupOf(id: string): Promise<string | undefined> {
    await this.ensure()
    return this.records.find(candidate => candidate.id === id)?.group
  }

  /**
   * The plaintext of one credential's secret, opened against its group.
   *
   * This is the read path a live connection uses, and deliberately the only one.
   * The plaintext comes back as bytes and goes no further than the transport that
   * needs it: nothing here writes it down, so a sealed group's secret has no
   * copy on the disk for a lock to have to sweep.
   *
   * @param id - the credential to open.
   * @param which - which of its two parts.
   * @returns the plaintext, or undefined when the credential has no such part.
   * @throws VaultLockedError when the group is sealed and not unlocked.
   */
  async open(id: string, which: 'secret' | 'passphrase'): Promise<string | undefined> {
    const body = await this.bodyOf(id, which)
    const group = await this.groupOf(id)
    if (body === undefined || group === undefined) return undefined
    return await this.vault.openFor(group, body)
  }

  /**
   * Re-seal (or unseal) every credential's bytes to match its group now.
   *
   * Called after a group's token is set or cleared. Each body is compared to what
   * its group now calls for and only rewritten when they disagree, so a second
   * run touches nothing. That matters beyond tidiness: GCM draws a fresh IV every
   * call, so re-encrypting is never byte-identical, and a process that dies
   * half-way through must be resumable by simply running it again.
   *
   * @param groupId - the group whose policy just moved.
   * @throws VaultLockedError when the group is sealed and not unlocked.
   */
  async rewrapGroup(groupId: string): Promise<void> {
    await this.ensure()
    const sealed = await this.vault.isSealed(groupId)
    for (const record of this.records.filter(candidate => candidate.group === groupId)) {
      for (const which of ['secret', 'passphrase'] as const) {
        const path = which === 'secret' ? record.file : record.passphraseFile
        if (path === undefined) continue
        const body = await readFile(path, 'utf8').catch(() => undefined)
        if (body === undefined || SecretVault.isSealed(body) === sealed) continue
        const plaintext = await this.vault.openFor(groupId, body)
        await writeFile(path, await this.vault.sealFor(groupId, plaintext), { mode: 0o600 })
      }
    }
  }
}

