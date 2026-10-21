/**
 * The host copy direction: the contract for text a HOST writes that the user
 * reads.
 *
 * Browser faces learn their language from dsh's `ctx.locale`, which the host
 * cannot see. Host-composed text — route refusals, device errors, the delegated
 * request a peer's model reads, a command's result line — therefore needs its
 * own statement of "which language", and it needs it from the browser that is
 * actually on screen. Two signals stand in for it, in order: what the browser
 * last reported to {@link DSHELL_LOCALE_PATH} (exact, and it covers a language
 * the browser picked for itself when the user never chose one), then the durable
 * `locale.preference` dsh's own Language row writes. With neither, the host
 * writes the project's source-of-truth language, `zh`.
 *
 * The rules here follow this package's layering: declaration only — the shapes
 * and the path — with no imports, no dsh packages and no runtime state. The
 * service that RESOLVES the language is provided by `dshell-mode`
 * (`ctx.dshellHostCopy`), so every package binds its own host dictionaries to it
 * instead of re-implementing the lookup.
 */

/** Where the browser reports the locale it actually resolved. */
export const DSHELL_LOCALE_PATH = '/api/dshell/locale'

/** The languages a host message can be written in, in report order. */
export const HOST_LOCALE_IDS = ['zh', 'en'] as const

/** One language a host message can be written in. */
export type HostLocaleId = typeof HOST_LOCALE_IDS[number]

/** Interpolation values for `{name}` placeholders in a host dictionary entry. */
export interface HostCopyParams {
  readonly [name: string]: string | number
}

/**
 * One package's host-face dictionaries. `zh` is the key-set source of truth —
 * the convention the browser faces already follow — and `en` must carry exactly
 * the same keys, which `satisfies Record<Key, string>` enforces at compile time.
 */
export interface HostCopyDictionaries<K extends string = string> {
  readonly zh: Record<K, string>
  readonly en: Record<K, string>
}

/** Body of a locale report: the id the browser resolved, as its own tag. */
export interface HostCopyReport {
  readonly locale?: string | undefined
}

/**
 * What `ctx.dshellHostCopy` offers a package whose host half writes text the
 * user reads. Both members resolve the language at CALL time, so a language
 * switch reaches host-composed text as soon as the report lands — no restart,
 * no cached dictionaries.
 */
export interface HostCopy {
  /** The language host-composed text should currently be written in. */
  locale(): HostLocaleId
  /**
   * Bind a package's host dictionaries to a translator.
   * @param dicts - the package's `zh`/`en` pair.
   * @returns a translator interpolating `{name}` placeholders from `params`.
   */
  bind<K extends string>(dicts: HostCopyDictionaries<K>): (key: K, params?: HostCopyParams) => string
}
