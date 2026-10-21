/**
 * The secret vault: named groups of credentials, each group its own policy.
 *
 * A group is either token-protected — its secrets sealed with AES-256-GCM under
 * a key stretched from a token the user chose, one salt per group — or plain.
 * Devices do not hold secrets; they reference a credential, so rotating a key
 * that thirty machines log in with is one edit rather than thirty.
 *
 * **Read the file, not the policy.** Whether a stored secret is sealed is
 * decided by the marker on its first line, never by what the group currently
 * says. That is what makes a group's policy changeable: flip a group to
 * token-protected and the secrets already in it are still readable, because
 * they were never lying about being plain.
 *
 * **What a sealed group resists, and what it does not.** It resists the disk.
 * Copy the `dshell/ssh` directory away and every credential in a sealed group is
 * a sealed blob, and the plaintext that opens them is never written down: it
 * exists in this process's memory, and in no file at all. It does NOT resist a
 * process running as the same user while the group is unlocked, because that
 * process can ask this one to open what it holds. The honest summary is: locked
 * means clean, and unlocked means in use — in memory, not on disk.
 *
 * **A plain group is not protected at all**, and the UI says so rather than
 * letting an unencrypted row look like it sits inside a vault.
 *
 * GCM rather than a plain cipher is load-bearing. A wrong token under an
 * unauthenticated mode decrypts to garbage that is then sent to a remote host as
 * a password, which reads to the user as "your password was rejected"; GCM's tag
 * fails loudly and the reader is told the token was wrong.
 *
 * A group's token is not stored, hashed or recoverable anywhere. Losing it means
 * re-entering every credential in that group — there is no reset, and adding one
 * would mean storing something that defeats the encryption.
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

// `scrypt` is overloaded, and promisify resolves the overload WITHOUT options,
// which would silently drop the memory-hardness parameters that are the whole
// point of using it. Pinned to the four-argument form so they are checked.
const scryptDerive = promisify(scrypt) as (
  password: string | Uint8Array,
  salt: string | Uint8Array,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

/** File format marker, so a plain secret is recognisable without a policy. */
export const SEAL_MARKER = 'dshell-vault-v1'

/** scrypt parameters. N=16384,r=8,p=1 needs 16 MB, inside Node's default cap. */
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const
const SCRYPT_MAXMEM = 32 * 1024 * 1024
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const SALT_BYTES = 16

/** The plaintext a group's verifier seals, so a token can be checked cheaply. */
const VERIFIER_PLAINTEXT = SEAL_MARKER

/**
 * The reader-facing messages this module raises.
 *
 * They reach the browser verbatim — the route answers with `error.message` and
 * the panel prints it — so they are written for the reader rather than for a
 * log. `verifier mismatched` used to be one of them.
 */
const WRONG_TOKEN = '令牌不正确，解不开这个分组'
const UNCLAIMED_GROUP = '这个分组还没有令牌，先为它设置一个才能解锁'
const EMPTY_TOKEN = '令牌不能为空'

/** A group's key derivation, as it lives on disk. */
export interface GroupKdf {
  algo: 'scrypt'
  N: number
  r: number
  p: number
  /** base64. */
  salt: string
}

/** One group, as stored. */
export interface VaultGroup {
  id: string
  name: string
  /** Whether credentials in this group are sealed. */
  sealed: boolean
  /** Present exactly when {@link sealed}. */
  kdf?: GroupKdf
  /** GCM(iv || tag || ciphertext) of the verifier; present when sealed. */
  verifier?: string
}

interface VaultDocument {
  v: 1
  groups: VaultGroup[]
}

/** What a group looks like to the UI: no key material, ever. */
export interface GroupView {
  readonly id: string
  readonly name: string
  readonly sealed: boolean
  /** Sealed and not currently open: its credentials cannot be read right now. */
  readonly locked: boolean
  /**
   * Whether a token exists for this group. A sealed group without one is
   * unclaimed: it cannot be unlocked, only claimed.
   */
  readonly hasToken: boolean
}

/** A token that does not open a group, as distinct from a store unreadable. */
export class VaultLockedError extends Error {
  /**
   * The group the refusal is about, when it is about one.
   *
   * Carried so a surface that has a vault panel can open THAT group's unlock
   * box instead of leaving the reader to find it.
   */
  readonly groupId: string | undefined
  constructor(message: string, groupId?: string) {
    super(message)
    this.name = 'VaultLockedError'
    this.groupId = groupId
  }
}

/** A fresh, path-safe group id. */
function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
}

/**
 * The group registry, the unlock state, and the seal itself.
 *
 * One instance per host process. Derived keys live only in this object's memory,
 * so a restart comes back locked — which is the point: the disk alone never
 * yields a usable credential.
 */
export class SecretVault {
  private groups: VaultGroup[] | undefined = undefined
  /** Group id → its derived key, for the groups currently unlocked. */
  private readonly keys = new Map<string, Buffer>()

  constructor(private readonly root: () => string) {}

  private get documentPath(): string {
    return join(this.root(), 'vault.json')
  }

  /**
   * The groups, in creation order.
   *
   * A group with no token of its own is created on first read: a vault that has
   * credentials but nowhere to put them is a broken state, and silently
   * defaulting them to plain would be the wrong repair. This one is sealed, so
   * the very first thing a user meets is a prompt for a token.
   */
  async list(): Promise<readonly GroupView[]> {
    return (await this.groupsOf()).map(group => this.view(group))
  }

  private view(group: VaultGroup): GroupView {
    return {
      id: group.id,
      name: group.name,
      sealed: group.sealed,
      locked: group.sealed && !this.keys.has(group.id),
      hasToken: group.kdf !== undefined,
    }
  }

  private async groupsOf(): Promise<VaultGroup[]> {
    if (this.groups !== undefined) return this.groups
    let groups: VaultGroup[] = []
    try {
      const parsed = JSON.parse(await readFile(this.documentPath, 'utf8')) as VaultDocument
      if (Array.isArray(parsed?.groups)) groups = parsed.groups.filter(isGroup)
    } catch {
      // No vault yet, or an unreadable one. An empty list is the right reading of
      // both: a corrupt document must not strand credentials that are still plain.
      groups = []
    }
    if (groups.length === 0) {
      groups = [{ id: 'default', name: '默认', sealed: true }]
      this.groups = groups
      await this.write()
      return groups
    }
    this.groups = groups
    return groups
  }

  private async write(): Promise<void> {
    const document: VaultDocument = { v: 1, groups: this.groups ?? [] }
    await mkdir(this.root(), { recursive: true, mode: 0o700 })
    await writeFile(this.documentPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  }

  private async find(groupId: string): Promise<VaultGroup | undefined> {
    return (await this.groupsOf()).find(group => group.id === groupId)
  }

  /**
   * Create a group.
   *
   * @param name - display name.
   * @param token - the group's token, or null for a plain (UNPROTECTED) group.
   * @returns the new group.
   */
  async createGroup(name: string, token: string | null): Promise<GroupView> {
    const groups = await this.groupsOf()
    const group: VaultGroup = { id: newId('g'), name, sealed: token !== null }
    if (token !== null) {
      if (token === '') throw new Error(EMPTY_TOKEN)
      group.kdf = { algo: 'scrypt', ...SCRYPT_PARAMS, salt: randomBytes(SALT_BYTES).toString('base64') }
      const key = await this.derive(token, group.kdf)
      group.verifier = (await seal(VERIFIER_PLAINTEXT, key)).toString('base64')
      this.keys.set(group.id, key)
    }
    this.groups = [...groups, group]
    await this.write()
    return this.view(group)
  }

  /** Rename a group. Nothing about its secrets changes. */
  async renameGroup(groupId: string, name: string): Promise<void> {
    const group = await this.need(groupId)
    group.name = name
    await this.write()
  }

  /** Remove a group and its key. The caller owns the credentials inside it. */
  async removeGroup(groupId: string): Promise<void> {
    await this.need(groupId)
    this.keys.delete(groupId)
    this.groups = (this.groups ?? []).filter(group => group.id !== groupId)
    await this.write()
  }

  /**
   * Unlock a group with its token.
   *
   * A sealed group with no token of its own — the default group a fresh vault
   * creates — cannot be unlocked: there is no salt to derive against and no
   * verifier to check a guess with. Returning silently would leave the reader
   * typing a token into a box that can never open, so this says so instead.
   *
   * @throws VaultLockedError when the token does not open it, or when the group
   *   has no token to open it with.
   */
  async unlock(groupId: string, token: string): Promise<void> {
    const group = await this.need(groupId)
    if (!group.sealed) return
    if (group.kdf === undefined) {
      throw new VaultLockedError(UNCLAIMED_GROUP, groupId)
    }
    const key = await this.derive(token, group.kdf)
    try {
      const opened = await open(Buffer.from(group.verifier ?? '', 'base64'), key)
      if (opened.toString('utf8') !== VERIFIER_PLAINTEXT) throw new VaultLockedError(WRONG_TOKEN, groupId)
    } catch (error) {
      // A failed guess must not disturb a group that was already open.
      if (error instanceof VaultLockedError) throw error
      throw new VaultLockedError(WRONG_TOKEN, groupId)
    }
    this.keys.set(groupId, key)
  }

  /**
   * Drop one group's key.
   *
   * The plaintext that key opened is not written anywhere, so dropping the key
   * is the whole of the lock: there is no copy on disk to sweep and no cache of
   * one to invalidate. A connection that resolved its secret before the lock is
   * refused after it, because every read goes through the group and the group no
   * longer has a key.
   */
  async lock(groupId?: string): Promise<void> {
    if (groupId === undefined) this.keys.clear()
    else this.keys.delete(groupId)
  }

  /** Whether a group is sealed, without exposing anything else about it. */
  async isSealed(groupId: string): Promise<boolean> {
    return (await this.find(groupId))?.sealed === true
  }

  /**
   * Set a group's token, sealing it from now on.
   *
   * Does NOT re-encrypt what is already stored — the caller does that, because
   * only the caller knows which credentials are in the group and where they
   * live. Keeping the rewrap outside means this method cannot half-complete.
   */
  async setToken(groupId: string, token: string): Promise<void> {
    const group = await this.need(groupId)
    if (token === '') throw new Error(EMPTY_TOKEN)
    group.sealed = true
    group.kdf = { algo: 'scrypt', ...SCRYPT_PARAMS, salt: randomBytes(SALT_BYTES).toString('base64') }
    const key = await this.derive(token, group.kdf)
    group.verifier = (await seal(VERIFIER_PLAINTEXT, key)).toString('base64')
    this.keys.set(groupId, key)
    await this.write()
  }

  /**
   * Remove a group's token, making it plain from now on.
   *
   * Same boundary as {@link setToken}: the caller rewrites the stored secrets.
   *
   * The derived key is deliberately KEPT. The only way to unseal what is already
   * stored is to open it, and dropping the key here would strand those bytes
   * permanently — the group would say "plain" while its files stayed sealed
   * under a key nothing holds any more. `lock` is what forgets it, and a policy
   * change is followed by a rewrap, not by silence.
   */
  async clearToken(groupId: string): Promise<void> {
    const group = await this.need(groupId)
    group.sealed = false
    delete group.kdf
    delete group.verifier
    await this.write()
  }

  /**
   * Whether a stored body is sealed.
   *
   * The single question the read path asks, and the reason a group's policy can
   * change without stranding anything.
   */
  static isSealed(body: string): boolean {
    return body.startsWith(`${SEAL_MARKER}\n`)
  }

  /**
   * The file body for a plaintext secret, sealed if its group is.
   *
   * @param groupId - the owning group.
   * @param plaintext - the secret.
   * @returns what to write.
   * @throws VaultLockedError when the group is sealed and not unlocked.
   */
  async sealFor(groupId: string, plaintext: string): Promise<string> {
    const body = plaintext.endsWith('\n') ? plaintext : `${plaintext}\n`
    if (!await this.isSealed(groupId)) return body
    // The newline is added on BOTH paths on purpose: a sealed secret has to come
    // back byte-identical, or enabling a token would change what `ssh` receives
    // — and OpenSSH's key parser requires that trailing newline.
    return `${SEAL_MARKER}\n${(await seal(body, await this.keyOf(groupId))).toString('base64')}\n`
  }

  /**
   * Open a stored body back into plaintext.
   *
   * @param groupId - the owning group, whose key is needed only if it is sealed.
   * @param body - the file body.
   * @throws VaultLockedError when it is sealed and the group is not unlocked.
   */
  async openFor(groupId: string, body: string): Promise<string> {
    if (!SecretVault.isSealed(body)) return body
    return (await open(
      Buffer.from(body.slice(SEAL_MARKER.length + 1).trim(), 'base64'),
      await this.keyOf(groupId),
    )).toString('utf8')
  }

  /**
   * The key for one group, or a refusal naming it.
   *
   * The name is in the message because the reader meets this error far from the
   * vault — a device test, a terminal command, a tool call — and "this group is
   * locked" names nothing they can act on. The id rides along on the error so a
   * surface with a vault panel can open the right group's unlock box.
   */
  private async keyOf(groupId: string): Promise<Buffer> {
    const key = this.keys.get(groupId)
    if (key !== undefined) return key
    const group = await this.find(groupId)
    const name = group?.name ?? groupId
    throw new VaultLockedError(`分组「${name}」已锁定，先解锁才能读取或写入它的凭据`, groupId)
  }

  private async derive(token: string, kdf: GroupKdf): Promise<Buffer> {
    return await scryptDerive(Buffer.from(token, 'utf8'), Buffer.from(kdf.salt, 'base64'), KEY_BYTES, {
      N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT_MAXMEM,
    })
  }

  private async need(groupId: string): Promise<VaultGroup> {
    const group = await this.find(groupId)
    if (group === undefined) throw new Error(`unknown vault group ${groupId}`)
    return group
  }

  /**
   * Remove the directory the old design kept its plaintext in.
   *
   * Before the transport became a library, a sealed secret had to be unsealed
   * into a file, because the external `ssh` could only be handed a path to read.
   * That file lived under `run/`, and an installation upgraded from that design
   * still has the directory — possibly holding the plaintext of a secret whose
   * group was locked before the process was killed rather than stopped.
   *
   * Nothing writes there any more, so the directory is pure leftover. Swept once
   * at start-up, which is the only moment it can be: those files are not this
   * process's to keep, and no later moment would know they were there.
   */
  async sweepLegacyRunDir(): Promise<void> {
    await rm(join(this.root(), 'run'), { recursive: true, force: true }).catch(() => {})
  }
}

/** A parsed group, rejecting anything that cannot be used. */
function isGroup(value: unknown): value is VaultGroup {
  if (typeof value !== 'object' || value === null) return false
  const group = value as Record<string, unknown>
  return typeof group.id === 'string' && group.id.length > 0 && typeof group.name === 'string'
}

function seal(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

function open(sealed: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV_BYTES))
  decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
  return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()])
}
