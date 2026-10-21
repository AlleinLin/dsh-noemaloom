/**
 * Pairing cryptography: base64url codecs, the SHA-256 the roster stores
 * instead of secrets, and the ES256 (ECDSA P-256 + SHA-256) verification that
 * admits a phone into the device roster.
 *
 * Nothing here is mocked away in tests: a test generates a real P-256 key pair
 * with node:crypto and signs with it, so a broken curve check, a DER-vs-raw
 * signature mismatch or a swapped digest fails the suite.
 * @module dsh-remote-bridge/core/crypto
 */

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from 'node:crypto'

/** Length of a raw (IEEE P1363, r||s) P-256 signature. */
export const ES256_SIGNATURE_BYTES = 64

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

/** Encode bytes as unpadded base64url. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/**
 * Decode unpadded base64url text.
 * @returns the bytes, or undefined when the text is not base64url.
 */
export function base64UrlDecode(text: string): Buffer | undefined {
  if (text === '' || !BASE64URL_RE.test(text)) return undefined
  const bytes = Buffer.from(text, 'base64url')
  // Buffer.from is lenient: it drops unknown characters and stops early, so a
  // re-encode is the only proof the text was canonical.
  return bytes.toString('base64url') === text ? bytes : undefined
}

/** Lowercase hex SHA-256 of a byte string or UTF-8 text. */
export function sha256Hex(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Cryptographically random unpadded base64url string of `byteLength` bytes. */
export function randomBase64Url(byteLength: number): string {
  return base64UrlEncode(randomBytes(byteLength))
}

/**
 * Compare two strings without leaking where they differ. Both sides are
 * hashed first so the comparison is over two equal-length digests: a plain
 * `===` on a token would return early on the first differing byte.
 */
export function constantTimeEqualText(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest()
  const b = createHash('sha256').update(right).digest()
  return timingSafeEqual(a, b)
}

/** @returns the token's stored hash: what the roster keeps in place of the secret. */
export function tokenHash(token: string): string {
  return sha256Hex(token)
}

/**
 * Fingerprint of a public key: SHA-256 over the DER of the SPKI exactly as the
 * client sent it. It is the human-comparable identity of the device, and the
 * roster pins it next to the key so a swapped key is visible.
 * @returns the hex fingerprint, or undefined when the SPKI does not decode.
 */
export function fingerprintOfSpki(spkiBase64Url: string): string | undefined {
  const der = base64UrlDecode(spkiBase64Url)
  if (der === undefined) return undefined
  return sha256Hex(der)
}

/** Whether an SPKI blob is an EC P-256 public key this bridge will verify against. */
export function isP256Spki(spkiBase64Url: string): boolean {
  return importP256Spki(spkiBase64Url) !== undefined
}

/**
 * Import a client-supplied SPKI blob, refusing anything that is not EC P-256.
 * The curve check is not decoration: node would happily verify a P-384 key and
 * the bridge would accept a device that can never be interoperable.
 */
function importP256Spki(spkiBase64Url: string): ReturnType<typeof createPublicKey> | undefined {
  const der = base64UrlDecode(spkiBase64Url)
  if (der === undefined) return undefined
  let key: ReturnType<typeof createPublicKey>
  try {
    key = createPublicKey({ key: der, format: 'der', type: 'spki' })
  } catch {
    return undefined
  }
  if (key.asymmetricKeyType !== 'ec') return undefined
  return key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : undefined
}

/**
 * Verify one ES256 signature over a message.
 * @param spkiBase64Url - the device's base64url SPKI, P-256.
 * @param signatureBase64Url - base64url of the raw 64-byte r||s signature.
 * @param message - the exact bytes that were signed.
 * @returns whether the signature is valid for that key.
 */
export function verifyEs256(spkiBase64Url: string, signatureBase64Url: string, message: Uint8Array): boolean {
  const key = importP256Spki(spkiBase64Url)
  if (key === undefined) return false
  const signature = base64UrlDecode(signatureBase64Url)
  // WebCrypto, iOS CryptoKit and every other ES256 producer emit raw r||s. A
  // DER blob would otherwise be accepted by node's default encoding, so the
  // length is checked instead of leaving the encoding to the verifier.
  if (signature === undefined || signature.length !== ES256_SIGNATURE_BYTES) return false
  return cryptoVerify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, signature)
}
