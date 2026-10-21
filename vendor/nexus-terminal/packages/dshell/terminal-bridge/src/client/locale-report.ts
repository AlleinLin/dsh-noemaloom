/**
 * Tell the host which language this browser resolved.
 *
 * dsh's locale service is browser-side: the host never sees the language a face
 * is rendering in, which is how host-composed text drifted out of language the
 * moment the user switched. dshell's browser faces post the active id here on
 * boot and on every change, and `ctx.dshellHostCopy` prefers that report over
 * the durable preference.
 *
 * A report that cannot be delivered is not worth surfacing: the host keeps
 * answering from the durable `locale.preference`, which is exactly what it did
 * before this existed.
 */

import { DSHELL_LOCALE_PATH, type HostCopyReport } from '@nexus-aethra/dshell-std'

/**
 * Post one locale report.
 * @param locale - the id the locale service reports as active.
 */
export async function sendLocaleReport(locale: string): Promise<void> {
  const body: HostCopyReport = { locale }
  try {
    await fetch(DSHELL_LOCALE_PATH, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    // Deliberately silent: see the module note.
  }
}
