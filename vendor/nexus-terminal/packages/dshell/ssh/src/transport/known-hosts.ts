/**
 * What this machine will accept as a device's host key.
 *
 * Read back from this plugin's OWN known_hosts rather than asked of the device:
 * anything the device reports travels over the very connection whose identity is
 * in question, so an interposed host can answer with whatever fingerprint it
 * likes. The local store is the only source that means "what dshell will accept
 * the next time it connects".
 *
 * The file is OpenSSH's, so the grammar is OpenSSH's: comments, hashed entries,
 * certificates, `@revoked`/`@cert-authority` markers, and one line per key type.
 * Parsing it here rather than shelling out to `ssh-keygen` is what removes the
 * last `child_process` from this package, and it is only safe because the
 * interesting half — which entries a destination has — is decided by a comparison
 * of key blobs, not by a guess at what a line means.
 *
 * Two shapes matter in practice:
 *
 *  - plain: `[host]:port ssh-ed25519 AAAA…`
 *  - hashed: `|1|c2FsdA==|aGFzaA== ssh-ed25519 AAAA…` — most distributions set
 *    `HashKnownHosts=yes`, so a file `ssh` itself wrote is usually this one. The
 *    hash is HMAC-SHA1 keyed by the salt over the destination spelling.
 */
import { createHmac, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** One parsed known_hosts line. */
export interface KnownHostEntry {
  /** Destination spelling the line is filed under, as OpenSSH writes it. */
  readonly host: string
  /** Key algorithm name, e.g. `ssh-ed25519`. */
  readonly keyType: string
  /** The key blob, base64, exactly as the file carries it. */
  readonly blob: string
  /** A marker the line carried, when it had one. */
  readonly marker?: 'cert-authority' | 'revoked'
  /** The salt of a hashed entry, base64; absent on a plain one. */
  readonly salt?: string
  /** The HMAC of a hashed entry, base64; absent on a plain one. */
  readonly hash?: string
}

/**
 * The spelling OpenSSH stores a destination under: bare host on the default
 * port, `[host]:port` otherwise. Getting this wrong silently reports "nothing
 * trusted" for every non-default port.
 *
 * @param host - device host.
 * @param port - device port.
 * @returns the known_hosts host field.
 */
export function knownHostsLookup(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${String(port)}`
}

/** OpenSSH's fingerprint spelling: SHA-256 of the blob, base64, unpadded. */
export function fingerprintOf(blob: string): string {
  const digest = createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64')
  return `SHA256:${digest.replace(/=+$/, '')}`
}

/**
 * The key algorithm a blob names, read out of the blob itself.
 *
 * An SSH public key is a length-prefixed sequence whose first element is the
 * algorithm name, so the type travels with the bytes. Needed because the
 * connection handshake hands over the raw key only, and a known_hosts line
 * without its type is not a line.
 *
 * @param blob - the key bytes the device offered.
 * @returns the algorithm name, or undefined when the blob is not one.
 */
export function keyTypeOfBlob(blob: Buffer): string | undefined {
  if (blob.length < 4) return undefined
  const length = blob.readUInt32BE(0)
  if (length === 0 || length > 64 || 4 + length > blob.length) return undefined
  const name = blob.subarray(4, 4 + length).toString('ascii')
  return /^[a-z0-9@.-]+$/u.test(name) ? name : undefined
}

/** HMAC-SHA1 of a destination under one salt, base64 — OpenSSH's hashed form. */
function hashedDestination(salt: Buffer, destination: string): string {
  return createHmac('sha1', salt).update(destination, 'utf8').digest('base64')
}

/**
 * Every entry the file holds, in file order.
 *
 * A line that cannot be read is dropped rather than treated as an entry: an
 * unparseable line matches no destination, which is the same answer OpenSSH
 * gives, and refusing the whole file over one malformed line would make a
 * hand-edited known_hosts disable every device.
 *
 * @param path - known_hosts file to read.
 * @returns the entries, empty when the file is absent or unreadable.
 */
export function readKnownHosts(path: string): KnownHostEntry[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const entries: KnownHostEntry[] = []
  for (const line of text.split('\n')) {
    const entry = parseLine(line)
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

/** Parse one known_hosts line; undefined when it holds no entry. */
function parseLine(line: string): KnownHostEntry | undefined {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return undefined
  const fields = trimmed.split(/\s+/u)
  let marker: KnownHostEntry['marker']
  if (fields[0] === '@revoked' || fields[0] === '@cert-authority') {
    marker = fields[0] === '@revoked' ? 'revoked' : 'cert-authority'
    fields.shift()
  }
  const host = fields[0]
  const keyType = fields[1]
  const blob = fields[2]
  if (host === undefined || keyType === undefined || blob === undefined) return undefined
  if (host.startsWith('|1|')) {
    // `|1|<salt>|<hmac>` splits into an empty head, the version, and the two
    // encoded halves — the version is what makes this a hashed entry at all.
    const [head, version, salt, hash] = host.split('|')
    if (head !== '' || version !== '1' || salt === undefined || hash === undefined || hash === '') return undefined
    return { host, keyType, blob, ...(marker === undefined ? {} : { marker }), salt, hash }
  }
  return { host, keyType, blob, ...(marker === undefined ? {} : { marker }) }
}

/** Whether one entry is filed under this destination, hashed or plain. */
function entryMatches(entry: KnownHostEntry, destination: string): boolean {
  if (entry.salt === undefined || entry.hash === undefined) {
    // A plain entry's host field is a comma-separated pattern list, and the only
    // wildcard that can appear is a leading `*`/`?`; a negated pattern (`!host`)
    // is an exclusion dshell never writes and a device's key is never filed under.
    return entry.host.split(',').some(pattern => pattern === destination || pattern === '*')
  }
  let salt: Buffer
  try {
    salt = Buffer.from(entry.salt, 'base64')
  } catch {
    return false
  }
  return hashedDestination(salt, destination) === entry.hash
}

/**
 * Every entry filed under one destination.
 *
 * @param entries - the parsed file.
 * @param host - device host.
 * @param param2 - device port.
 * @returns the entries, empty when nothing is recorded.
 */
export function entriesFor(entries: readonly KnownHostEntry[], host: string, port: number): KnownHostEntry[] {
  const destination = knownHostsLookup(host, port)
  return entries.filter(entry => entryMatches(entry, destination))
}

/** What an offered key means against what is recorded. */
export type HostKeyDecision =
  /** The exact key is recorded for this destination. */
  | 'trusted'
  /** Nothing is recorded for this destination: first contact. */
  | 'first'
  /** Something else is recorded for this destination. */
  | 'changed'
  /** The exact key is recorded as revoked. */
  | 'revoked'

/**
 * Decide what an offered key means for one destination.
 *
 * @param entries - the parsed file.
 * @param host - device host.
 * @param port - device port.
 * @param blob - the key bytes the device offered.
 * @returns the decision; see {@link HostKeyDecision}.
 */
export function hostKeyDecision(
  entries: readonly KnownHostEntry[],
  host: string,
  port: number,
  blob: Buffer,
): HostKeyDecision {
  const offered = blob.toString('base64')
  const filed = entriesFor(entries, host, port)
  if (filed.some(entry => entry.marker === 'revoked' && entry.blob === offered)) return 'revoked'
  if (filed.some(entry => entry.marker !== 'revoked' && entry.blob === offered)) return 'trusted'
  return filed.length === 0 ? 'first' : 'changed'
}

/**
 * Append one host key, the way `accept-new` does.
 *
 * Written as a hashed entry, matching what a stock OpenSSH client would leave
 * behind on a distribution with `HashKnownHosts=yes`: the file is then
 * indistinguishable from one the user's own ssh maintains, and a destination's
 * host is not readable from it by anyone who can read the file.
 *
 * @param path - known_hosts file to append to.
 * @param host - device host.
 * @param port - device port.
 * @param blob - the key bytes the device offered.
 * @returns the entry that was written, or undefined when the blob is not a key.
 */
export function recordHostKey(path: string, host: string, port: number, blob: Buffer): KnownHostEntry | undefined {
  const keyType = keyTypeOfBlob(blob)
  if (keyType === undefined) return undefined
  const salt = createHash('sha256').update(`${host}:${String(port)}:${Date.now().toString(36)}`).digest()
  const destination = knownHostsLookup(host, port)
  const entry: KnownHostEntry = {
    host: `|1|${salt.toString('base64')}|${hashedDestination(salt, destination)}`,
    keyType,
    blob: blob.toString('base64'),
    salt: salt.toString('base64'),
    hash: hashedDestination(salt, destination),
  }
  // The device directory exists once anything has been stored in it, but the
  // first host key a fresh install learns is recorded before that: the
  // connection is what creates the directory, and it is created here.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${formatEntry(entry)}\n`, { mode: 0o600, flag: 'a' })
  return entry
}

/** One entry as OpenSSH would write it. */
function formatEntry(entry: KnownHostEntry): string {
  const marker = entry.marker === undefined ? '' : `@${entry.marker} `
  return `${marker}${entry.host} ${entry.keyType} ${entry.blob}`
}

/**
 * Drop every entry filed under one destination.
 *
 * A rewrite rather than a filter over the parsed entries, so a line this parser
 * does not understand survives the removal of everything around it: an
 * unrecognised line matches no destination, and keeping it is what
 * {@link readKnownHosts} already promises.
 *
 * @param path - known_hosts file to rewrite.
 * @param host - device host.
 * @param port - device port.
 * @returns whether any entry was removed.
 */
export function revokeHostKeys(path: string, host: string, port: number): boolean {
  if (!existsSync(path)) return false
  let lines: string[]
  try {
    lines = readFileSync(path, 'utf8').split('\n')
  } catch {
    return false
  }
  const destination = knownHostsLookup(host, port)
  const kept: string[] = []
  let removed = 0
  for (const line of lines) {
    const entry = parseLine(line)
    // Kept when the line is not an entry at all, or when its entries are filed
    // under another destination. An empty last field is the trailing newline.
    if (entry !== undefined && entryMatches(entry, destination)) {
      removed += 1
      continue
    }
    kept.push(line)
  }
  if (removed === 0) return false
  const text = kept.join('\n')
  writeFileSync(path, text === '' ? '' : text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 })
  return removed > 0
}
