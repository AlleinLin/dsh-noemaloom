/**
 * The host half's copy direction — the provider behind `ctx.dshellHostCopy`.
 *
 * A browser face learns its language from dsh's `ctx.locale`, which the host
 * cannot see. Host-composed text therefore asks this service instead, and it
 * answers from the two signals that stand in for the browser's choice, in
 * order:
 *
 * 1. what the browser last REPORTED to {@link DSHELL_LOCALE_PATH} — the exact
 *    id it resolved, including a language it picked for itself when the user
 *    never touched the switcher;
 * 2. the durable `locale.preference` dsh's Language row writes, read straight
 *    from the settings document.
 *
 * With neither, `zh` — this project's source-of-truth language, the same rule
 * the browser dictionaries follow.
 *
 * Both members resolve the language at CALL time, so a switch reaches
 * host-composed text as soon as the report lands: no restart, and no cached
 * dictionary to go stale.
 *
 * It is provided by `dshell-terminal-bridge`, and that placement is forced by
 * the activation graph rather than by taste: `dshell-mode` is the package that
 * owns the presentation surfaces, but it WAITS for the PTY service this package
 * provides (`dshellTerminalBridge`), so a provider mode owned would deadlock the
 * profile — mode pending on the bridge, the bridge pending on mode. The
 * dependency edge already points this way, so the service sits at the far end of
 * it, and every writer of host copy waits for the bridge (which is what it was
 * already doing) instead of for a service the bridge also depends on.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import {
  HOST_LOCALE_IDS,
  type HostCopy,
  type HostCopyDictionaries,
  type HostCopyParams,
  type HostLocaleId,
} from '@nexus-aethra/dshell-std'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The language host-composed, user-visible text should be written in. */
    dshellHostCopy: HostCopy
  }
}

/** dsh's own settings namespace and field for the Language row. */
const LOCALE_NAMESPACE = 'locale'
const LOCALE_FIELD = 'preference'

/** One `{name}` placeholder, the same template syntax the browser faces use. */
const PLACEHOLDER = /\{(\w+)\}/gu

/** The service plus the report entry the route calls; only this module needs it. */
export interface HostCopyService extends HostCopy {
  /**
   * Record the locale the browser reported.
   * @param locale - an id from {@link HOST_LOCALE_IDS}; anything else is ignored.
   */
  report(locale: unknown): void
}

/**
 * Build the host copy service over a context whose settings document may not
 * have mounted yet — the read is lazy, so one that appears later is honored.
 * @param ctx - host root context.
 * @returns the service, ready to provide as `dshellHostCopy`.
 */
export function createHostCopy(ctx: Context): HostCopyService {
  let reported: HostLocaleId | undefined
  const locale = (): HostLocaleId => {
    if (reported !== undefined) return reported
    // rc.2 has no per-namespace host read: the settings service publishes every
    // active entry's schema AND its resolved value through `describe()`, which
    // is what a host package uses to read another plugin's document. It becomes
    // enumerable only once the Loader has settled the entry, so a composition
    // that is still coming up degrades to the Chinese source of truth.
    let durable: unknown
    const settings = ctx.get('settings')
    try {
      durable = (settings?.describe().find(entry => entry.ns === LOCALE_NAMESPACE)?.value as
        { readonly [LOCALE_FIELD]?: unknown } | undefined)?.[LOCALE_FIELD]
    } catch {
      durable = undefined
    }
    return HOST_LOCALE_IDS.includes(durable as HostLocaleId) ? durable as HostLocaleId : 'zh'
  }
  return {
    locale,
    report: (value) => {
      if (HOST_LOCALE_IDS.includes(value as HostLocaleId)) reported = value as HostLocaleId
    },
    bind: <K extends string>(dicts: HostCopyDictionaries<K>) => (key: K, params?: HostCopyParams): string => {
      // The active dictionary first, then the source of truth, then the key
      // itself — the same order the browser lookup uses, so a dictionary that
      // is somehow incomplete degrades to Chinese rather than to a bare key.
      const template = dicts[locale()][key] ?? dicts.zh[key] ?? key
      if (params === undefined) return template
      return template.replace(PLACEHOLDER, (match: string, name: string) =>
        name in params ? String(params[name]) : match)
    },
  }
}
