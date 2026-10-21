/**
 * In-memory bootstrap tokens and pairing nonces.
 *
 * Both are one-shot and short-lived, and neither is ever persisted: a token an
 * operator reads off the Host log is only useful while its 30 s window is open,
 * and a restart invalidating every pending pairing is the desired behavior.
 * @module dsh-remote-bridge/core/pairing
 */

import { randomBase64Url } from './crypto.js'

/** Lifetime of one bootstrap token handed to the operator's phone. */
export const BOOTSTRAP_TOKEN_TTL_MS = 30_000
/** Lifetime of one pairing nonce, from `pair.begin` to `pair.finish`. */
export const PAIR_NONCE_TTL_MS = 60_000
/** Entropy of one bootstrap token. */
export const BOOTSTRAP_TOKEN_BYTES = 32
/** Entropy of one pairing nonce. */
export const PAIR_NONCE_BYTES = 16

/** A minted one-shot secret and the instant it stops being accepted. */
export interface PairingTicket {
  readonly value: string
  readonly expiresAt: number
}

export interface PairingServiceOptions {
  /** Clock, injectable so expiry is tested without sleeping. */
  readonly now?: () => number
  readonly tokenTtlMs?: number
  readonly nonceTtlMs?: number
  /** Secret source, injectable so a test can pin the value it will present. */
  readonly random?: (byteLength: number) => string
}

/**
 * The two one-shot secrets of the pairing handshake.
 *
 * `issueToken` is called by the loopback-only route an operator reaches from
 * the Host itself; `beginPairing` consumes that token and mints the nonce the
 * phone signs; `consumeNonce` closes the handshake. Consumption happens BEFORE
 * any signature check in the caller, so a wrong signature still burns the
 * nonce: a brute-force loop cannot reuse one challenge.
 */
export class PairingService {
  readonly #now: () => number
  readonly #tokenTtlMs: number
  readonly #nonceTtlMs: number
  readonly #random: (byteLength: number) => string
  readonly #tokens = new Map<string, number>()
  readonly #nonces = new Map<string, number>()

  constructor(options: PairingServiceOptions = {}) {
    this.#now = options.now ?? (() => Date.now())
    this.#tokenTtlMs = options.tokenTtlMs ?? BOOTSTRAP_TOKEN_TTL_MS
    this.#nonceTtlMs = options.nonceTtlMs ?? PAIR_NONCE_TTL_MS
    this.#random = options.random ?? randomBase64Url
  }

  /** Mint one bootstrap token, valid until its own expiry. */
  issueToken(): PairingTicket {
    this.#prune()
    const value = this.#random(BOOTSTRAP_TOKEN_BYTES)
    const expiresAt = this.#now() + this.#tokenTtlMs
    this.#tokens.set(value, expiresAt)
    return { value, expiresAt }
  }

  /**
   * Consume one bootstrap token.
   * @returns whether the token was live; a consumed or expired token is gone.
   */
  consumeToken(token: string): boolean {
    this.#prune()
    const expiresAt = this.#tokens.get(token)
    if (expiresAt === undefined) return false
    this.#tokens.delete(token)
    return true
  }

  /** Mint one pairing nonce for a connection that just consumed a valid token. */
  issueNonce(): PairingTicket {
    this.#prune()
    const value = this.#random(PAIR_NONCE_BYTES)
    const expiresAt = this.#now() + this.#nonceTtlMs
    this.#nonces.set(value, expiresAt)
    return { value, expiresAt }
  }

  /**
   * Consume one pairing nonce.
   * @returns whether the nonce was live; a consumed or expired nonce is gone.
   */
  consumeNonce(nonce: string): boolean {
    this.#prune()
    const expiresAt = this.#nonces.get(nonce)
    if (expiresAt === undefined) return false
    this.#nonces.delete(nonce)
    return true
  }

  /** @returns how many tokens and nonces are currently acceptable, for tests and diagnostics. */
  get pending(): { tokens: number; nonces: number } {
    this.#prune()
    return { tokens: this.#tokens.size, nonces: this.#nonces.size }
  }

  #prune(): void {
    const now = this.#now()
    for (const [value, expiresAt] of this.#tokens) if (expiresAt <= now) this.#tokens.delete(value)
    for (const [value, expiresAt] of this.#nonces) if (expiresAt <= now) this.#nonces.delete(value)
  }
}

