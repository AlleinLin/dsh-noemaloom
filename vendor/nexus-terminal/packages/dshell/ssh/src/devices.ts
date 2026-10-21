/**
 * The durable SSH device registry and its key material.
 *
 * Records live in one JSON document (`$DSH_HOME/dshell/ssh/devices.json`);
 * private keys are separate files under `keys/<device-id>` written 0600, so a
 * key never appears in a document that other features might read or echo.
 * Both are read lazily on the first operation and rewritten atomically.
 *
 * Key material is write-only from the API's point of view: `DeviceView` reports
 * only whether a key exists, never its contents.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DshellSshTranslate } from './host-locales.js'
import type { DeviceAuth, DeviceInput, DeviceView } from './protocol.js'
import type { DeviceHelperStatus } from '@nexus-aethra/dshell-std'
import type { CredentialStore } from './credentials.js'
import { DeviceSshError } from './transport/errors.js'

/** A stored device record; the secret path is absent when none is stored. */
interface DeviceRecord {
  id: string
  name: string
  host: string
  port: number
  user: string
  remoteRoot: string
  /** Login method; a `key` device with no stored secret has no identity to offer. */
  auth: DeviceAuth
  /**
   * The vault credential this device logs in with, instead of its own files.
   *
   * Preferred whenever present. The inline paths below are what every device
   * had before the vault existed and stay readable, but a device holding both
   * would have two answers to the same question with only one of them rotated.
   */
  credentialId?: string
  /** Absolute path of the stored key or password file. */
  secretFile?: string
  /**
   * Absolute path of the stored passphrase for {@link secretFile}.
   *
   * A separate file rather than an option beside it, because the two answer to
   * different prompts: the transport reads the key and its passphrase as two
   * separate facts, and one file can only be one of them.
   */
  passphraseFile?: string
  /** Last observed helper deployment on this device, when checks have run. */
  helper?: DeviceHelperStatus
}

/** A device id safe to interpolate into a path. */
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * The credential a record points at, with a cleared reference read as none.
 *
 * The form has always sent the field even when empty — that is how a pick is
 * cleared — so documents written before {@link DeviceStore.save} normalized it
 * can hold an empty string. Reading it as a reference would make such a device
 * look like it holds a credential nothing can resolve.
 */
function referenceOf(record: DeviceRecord): string | undefined {
  return record.credentialId === undefined || record.credentialId === '' ? undefined : record.credentialId
}

/** Connection parameters resolved for one connection attempt. */
export interface DeviceConnection {
  readonly id: string
  readonly name: string
  readonly host: string
  readonly port: number
  readonly user: string
  readonly remoteRoot: string
  readonly auth: DeviceAuth
  /**
   * The device's stored secret, resolved when a connection is made.
   *
   * A resolver rather than a value, because a secret sealed in the vault is
   * opened through its group: the device list is cached for the life of a
   * session, and a secret resolved when that list was read would outlive the
   * unlock that produced it. Resolving at the connection means a group locked in
   * between refuses the connection, which is the honest outcome — and a refusal
   * that names the group, rather than a file that is not there any more.
   */
  readonly secret: DeviceSecret | undefined
}

/**
 * How one device's stored secret is obtained.
 *
 * The two parts answer to two different prompts — the key and its passphrase
 * are read as two separate facts, and one file can only be one of them.
 *
 * Both hand back PLAINTEXT rather than a path. The transport used to be given a
 * path to a key file, and that file was the only reason a sealed secret had to be
 * written down at all: an external `ssh` can only read a path. The transport is
 * a library now, so it is given the bytes, and a credential sealed in a group is
 * opened through that group — never written to disk to be read back.
 */
export interface DeviceSecret {
  /**
   * The key or the password, as it should be sent.
   *
   * @returns the secret, or undefined when the device holds no such secret.
   */
  readonly open: () => Promise<string | undefined>
  /**
   * The key's passphrase, when the key needs one.
   *
   * @returns the passphrase, or undefined when there is none.
   */
  readonly passphrase?: () => Promise<string | undefined>
}

/** Stored secret path of a parsed record, accepting the legacy field name. */
function readSecretPath(raw: Record<string, unknown>): { secretFile?: string; passphraseFile?: string } {
  for (const field of ['secretFile', 'keyFile']) {
    const value = raw[field]
    if (typeof value === 'string' && value.length > 0) {
      return {
        secretFile: value,
        ...typeof raw.passphraseFile === 'string' && raw.passphraseFile.length > 0
          ? { passphraseFile: raw.passphraseFile }
          : {},
      }
    }
  }
  return {}
}

/**
 * The bytes of a device's own stored secret, or a refusal the reader can act on.
 *
 * A raw ENOENT here names the file's absolute path and reads as a broken
 * filesystem; what it actually means is that the credential this device needs
 * is not on disk any more, which is a credential problem — re-enter the secret
 * — and not a dead device. The path stays in `cause`, where a log has it, and
 * out of the sentence the reader sees.
 *
 * @param path - the file holding the secret, if the device has one.
 * @returns the secret, or undefined when the device holds no such file.
 */
async function readStoredSecret(path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    throw new DeviceSshError(
      'auth',
      'the credential for this device could not be read; re-enter the secret for this device',
      { cause: error },
    )
  }
}

/** Coerce one parsed record, dropping anything that cannot be used. */
function asRecord(value: unknown): DeviceRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || !SAFE_ID.test(raw.id)) return undefined
  if (typeof raw.host !== 'string' || raw.host.length === 0) return undefined
  if (typeof raw.user !== 'string' || raw.user.length === 0) return undefined
  const port = typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65_536
    ? raw.port
    : 22
  const helper = readHelperStatus(raw.helper)
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : raw.host,
    host: raw.host,
    port,
    user: raw.user,
    remoteRoot: typeof raw.remoteRoot === 'string' && raw.remoteRoot.length > 0 ? raw.remoteRoot : '~',
    auth: raw.auth === 'password' ? 'password' : 'key',
    // `keyFile` is this field's earlier name: documents written before the
    // login-method split carry it, and dropping it would silently detach an
    // already-stored key from its device.
    ...readSecretPath(raw),
    ...(typeof raw.credentialId === 'string' && raw.credentialId.length > 0
      ? { credentialId: raw.credentialId }
      : {}),
    ...(helper === undefined ? {} : { helper }),
  }
}

function connectionKey(record: { host: string; port: number; user: string; remoteRoot: string }): string {
  return `${record.host}:${record.port}:${record.user}:${record.remoteRoot}`
}

function readHelperStatus(raw: unknown): DeviceHelperStatus | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const helper = raw as Record<string, unknown>
  const state = helper.state
  if (state !== 'absent' && state !== 'present' && state !== 'mismatch') return undefined
  const message = typeof helper.message === 'string' ? helper.message : ''
  const status: Record<string, unknown> = { state, message }
  if (typeof helper.onDevice === 'string') status.onDevice = helper.onDevice
  if (typeof helper.expected === 'string') status.expected = helper.expected
  if (typeof helper.path === 'string') status.path = helper.path
  return status as unknown as DeviceHelperStatus
}

/** Derive a stable, path-safe id from a device name. */
function idFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return slug.length > 0 ? slug : `device-${Date.now().toString(36)}`
}

/** The registry. */
export class DeviceStore {
  private loaded = false
  private records: DeviceRecord[] = []

  /**
   * @param root - device directory (`$DSH_HOME/dshell/ssh`).
   */
  /**
   * @param root - resolves the device directory (`<data root>/dshell/ssh`),
   *   read when it is needed rather than captured: the data root is a setting,
   *   settled while the composition is still running (see `std/data-root.ts`).
   */
  constructor(private readonly root: () => string, private readonly credentials: CredentialStore) {}

  /** The device document path. */
  private get documentPath(): string {
    return join(this.root(), 'devices.json')
  }

  /** The secret directory (private keys and passwords, never the document). */
  private get secretDir(): string {
    return join(this.root(), 'keys')
  }

  /** Every device, in registration order. */
  async list(): Promise<readonly DeviceView[]> {
    await this.ensure()
    return this.records.map(record => this.view(record))
  }

  /** Resolve one device for execution, or undefined when unknown. */
  async connection(deviceId: string): Promise<DeviceConnection | undefined> {
    await this.ensure()
    const record = this.records.find(candidate => candidate.id === deviceId)
    if (record === undefined) return undefined
    const credentialId = referenceOf(record)
    // The secret, resolved twice on purpose. The eager one is how a device whose
    // credential sits in a locked group is found: the refusal has to be raised
    // where the group is known, because a group id is what the route turns into a
    // pointer at the right unlock box. The lazy one is what the transport reads,
// and it goes through the group again — a group locked after this connection
    // was built refuses the secret rather than handing over plaintext nobody may
    // use any more.
    if (credentialId !== undefined) await this.credentials.open(credentialId, 'secret')
    const open = credentialId === undefined
      ? async (): Promise<string | undefined> => await readStoredSecret(record.secretFile)
      : async (): Promise<string | undefined> => await this.credentials.open(credentialId, 'secret')
    const passphrase = credentialId === undefined
      ? async (): Promise<string | undefined> => await readStoredSecret(record.passphraseFile)
      : async (): Promise<string | undefined> => await this.credentials.open(credentialId, 'passphrase')
    return {
      id: record.id,
      name: record.name,
      host: record.host,
      port: record.port,
      user: record.user,
      remoteRoot: record.remoteRoot,
      auth: record.auth,
      secret: { open, passphrase },
    }
  }

  /**
   * Create or update one device. A supplied key replaces the stored one; an
   * empty key removes it; an omitted key leaves it alone.
   * @param input - the submitted device; `id` absent means create.
   * @param t - this package's bound host copy, for the refusals below.
   * @returns the saved view.
   */
  async save(input: DeviceInput, t: DshellSshTranslate): Promise<DeviceView> {
    await this.ensure()
    const id = input.id ?? this.uniqueId(idFor(input.name))
    const existing = this.records.find(record => record.id === id)
    if (input.id !== undefined && existing === undefined) throw new Error(t('error.unknownDevice', { id: input.id }))
    // An empty reference means "no credential": the form sends it to clear one,
    // and storing the empty string would leave a device that reads as holding a
    // credential it cannot resolve (`hasSecret` true, the store finding
    // nothing). Normalizing here keeps the document free of them; records
    // written before this still read correctly through {@link referenceOf}.
    const credentialId = input.credentialId === '' ? undefined : input.credentialId
    // A device pointed at a credential logs in the way that credential says: a
    // key credential means key auth, a password credential means password auth.
    // Deriving it here rather than trusting the caller keeps a mismatched pair
    // — which would connect with the wrong method — from ever being stored.
    const credential = credentialId === undefined ? undefined : await this.credentials.get(credentialId)
    const auth: DeviceAuth = credential?.kind ?? input.auth ?? existing?.auth ?? 'key'
    const baseRecord: DeviceRecord = {
      id,
      name: input.name.trim() !== '' ? input.name.trim() : (existing?.name ?? input.host),
      host: input.host.trim(),
      port: input.port ?? existing?.port ?? 22,
      user: input.user.trim(),
      remoteRoot: input.remoteRoot?.trim() !== undefined && input.remoteRoot.trim() !== ''
        ? input.remoteRoot.trim()
        : (existing?.remoteRoot ?? '~'),
      auth,
      ...existing?.secretFile === undefined ? {} : { secretFile: existing.secretFile },
      ...existing?.passphraseFile === undefined ? {} : { passphraseFile: existing.passphraseFile },
    }
    const record: DeviceRecord = {
      ...baseRecord,
      ...(existing === undefined || connectionKey(existing) === connectionKey(baseRecord)
        ? (existing?.helper === undefined ? {} : { helper: existing.helper })
        : {}),
    }
    if (record.host === '' || record.user === '') throw new Error(t('error.hostUserRequired'))
    // Switching the login method retires the other secret: a stored password
    // must not linger on a device that now authenticates by key.
    if (existing !== undefined && existing.auth !== auth) await this.removeSecret(record)
    // Pointing a device at a credential retires its inline secret: leaving the
    // files in place would keep a copy of the key alive that nothing rotates and
    // that the device no longer reads.
    if (credentialId !== undefined && credentialId !== record.credentialId) {
      await this.removeSecret(record)
      record.credentialId = credentialId
    }
    const submitted = record.credentialId !== undefined ? undefined
      : auth === 'password' ? input.password : input.key
    if (submitted !== undefined) {
      if (submitted.trim() === '') {
        await this.removeSecret(record)
      } else {
        record.secretFile = await this.writeSecret(record.id, auth, submitted)
      }
    }
    // A passphrase for a key that is not there would be a stored secret nothing
    // can ever read, which is the shape of a credential nobody rotates.
    if (input.passphrase !== undefined) {
      if (auth !== 'key' || record.secretFile === undefined) {
        if (input.passphrase !== '') throw new Error(t('error.passphraseWithoutKey'))
      } else if (input.passphrase === '') {
        await this.removePassphrase(record)
      } else {
        record.passphraseFile = await this.writePassphrase(record.id, input.passphrase)
      }
    }
    this.records = existing === undefined
      ? [...this.records, record]
      : this.records.map(candidate => candidate.id === id ? record : candidate)
    await this.saveDocument()
    return this.view(record)
  }

  /**
   * Record one helper deployment result against a device.
   *
   * The install action owns this write. `save` is the user's device form and
   * requires the connection fields a deployment does not touch; routing a
   * status update through it would also re-read the login method, which is
   * what would otherwise retire an unrelated stored secret.
   * @param deviceId - device to update.
   * @param helper - the status the check just produced.
   * @returns the updated view, or undefined when the device is unknown.
   */
  async setHelper(deviceId: string, helper: DeviceHelperStatus): Promise<DeviceView | undefined> {
    await this.ensure()
    const record = this.records.find(candidate => candidate.id === deviceId)
    if (record === undefined) return undefined
    const next: DeviceRecord = { ...record, helper }
    this.records = this.records.map(candidate => (candidate.id === deviceId ? next : candidate))
    await this.saveDocument()
    return this.view(next)
  }

  /**
   * Remove one device and its key.
   * @param deviceId - device to remove.
   */
  async remove(deviceId: string): Promise<void> {
    await this.ensure()
    const record = this.records.find(candidate => candidate.id === deviceId)
    if (record === undefined) return
    await this.removeSecret(record)
    this.records = this.records.filter(candidate => candidate.id !== deviceId)
    await this.saveDocument()
  }

  private view(record: DeviceRecord): DeviceView {
    const credentialId = referenceOf(record)
    return {
      id: record.id,
      name: record.name,
      host: record.host,
      port: record.port,
      user: record.user,
      remoteRoot: record.remoteRoot,
      auth: record.auth,
      ...(credentialId === undefined ? {} : { credentialId }),
      hasSecret: record.secretFile !== undefined || credentialId !== undefined,
      // Reported only when it means something: a password-auth device has no
      // key to unlock, so a passphrase there would be a secret nothing reads.
      hasPassphrase: record.auth === 'key' && record.passphraseFile !== undefined,
      helper: record.helper,
    }
  }

  /** Mint an id that is not taken yet. */
  private uniqueId(base: string): string {
    if (!this.records.some(record => record.id === base)) return base
    for (let n = 2; ; n += 1) {
      const candidate = `${base}-${String(n)}`
      if (!this.records.some(record => record.id === candidate)) return candidate
    }
  }

  /** Write one secret (private key or password) with owner-only permissions. */
  private async writeSecret(deviceId: string, auth: DeviceAuth, secret: string): Promise<string> {
    await mkdir(this.secretDir, { recursive: true, mode: 0o700 })
    const path = join(this.secretDir, auth === 'password' ? `${deviceId}.password` : deviceId)
    // A trailing newline is required by OpenSSH's key parser; the transport
    // strips it back off a password before sending it (see `transport/auth.ts`).
    const body = secret.endsWith('\n') ? secret : `${secret}\n`
    await writeFile(path, body, { mode: 0o600 })
    await chmod(path, 0o600)
    return path
  }

  private async removeSecret(record: DeviceRecord): Promise<void> {
    await this.removePassphrase(record)
    if (record.secretFile === undefined) return
    await rm(record.secretFile, { force: true })
    delete record.secretFile
  }

  /** Write a key's passphrase with owner-only permissions. */
  private async writePassphrase(deviceId: string, passphrase: string): Promise<string> {
    await mkdir(this.secretDir, { recursive: true, mode: 0o700 })
    const path = join(this.secretDir, `${deviceId}.passphrase`)
    // The transport strips the trailing newline before handing the passphrase to
    // the key parser, the same way it strips one from a password.
    await writeFile(path, `${passphrase}\n`, { mode: 0o600 })
    await chmod(path, 0o600)
    return path
  }

  private async removePassphrase(record: DeviceRecord): Promise<void> {
    if (record.passphraseFile === undefined) return
    await rm(record.passphraseFile, { force: true })
    delete record.passphraseFile
  }

  /** Load once; a missing or unreadable document is an empty registry. */
  private async ensure(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.documentPath, 'utf8')) as unknown
      const raw = Array.isArray(parsed) ? parsed : (parsed as { devices?: unknown }).devices
      this.records = (Array.isArray(raw) ? raw : []).flatMap((entry) => {
        const record = asRecord(entry)
        return record === undefined ? [] : [record]
      })
    } catch {
      this.records = []
    }
  }

  /** Rewrite the document atomically. */
  private async saveDocument(): Promise<void> {
    await mkdir(this.root(), { recursive: true })
    const temporary = `${this.documentPath}.tmp`
    await writeFile(temporary, JSON.stringify({ devices: this.records }, null, 2), 'utf8')
    await rename(temporary, this.documentPath)
  }
}
