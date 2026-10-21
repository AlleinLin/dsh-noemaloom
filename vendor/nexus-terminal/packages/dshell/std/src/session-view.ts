/**
 * Which Session the main view is holding.
 *
 * The host's rule, taken once. `0.1.5-rc.2` published the Session on screen as
 * `sessions.list.current`; `0.1.6-alpha.2` removed that field, because a Client
 * may now hold several generations at once and no service owns "the one on
 * screen" — navigation belongs to view owners. What replaced the field is
 * RETENTION: the surface displaying a Session claims it with
 * `retain(target, { source: 'mainView' })`, and the Session on screen is the row
 * whose `mainView` count is positive.
 *
 * The derivation is what the host itself repeats wherever it needs the answer —
 * `ui-workspace/tree.ts`, `ui-layout/DocumentTitle.tsx`, `ui-session`,
 * `ui-settings-general` all write it out — so reading it here is not a dshell
 * invention, it is the same reading taken once instead of once per package.
 *
 * `undefined` means no view holds a Session: on a page that has not navigated
 * yet, and in the window between a release and the next retain.
 */

/**
 * The fields the rule reads.
 *
 * Structural rather than imported: `dshell-std` is the layer allowed to care
 * about how dsh spells things, and the cheapest way to keep that true is to
 * state the fields instead of depending on the package that owns them.
 */
export interface RetainedSessionRow<Id> {
  readonly id: Id
  /**
   * The host's retention counts. Left as `object` rather than spelled out: the
   * host types them as a partial record of its own source names, and restating
   * that here would tie this module to the package that owns it — which is the
   * dependency this layer exists to avoid.
   */
  readonly retainedBy?: object | undefined
}

/**
 * The Session the main view is holding, by the host's own rule.
 * @param rows - the session-list rows, in any order.
 * @returns the held Session's id, or undefined when no view holds one.
 */
export function mainSessionId<Id>(rows: Iterable<RetainedSessionRow<Id>>): Id | undefined {
  for (const row of rows) {
    // The cast is the point of the structural parameter: the host publishes a
    // frozen partial record whose source names are its own, and the one this
    // rule reads is `mainView`.
    const counts = row.retainedBy as Readonly<Record<string, number | undefined>> | undefined
    if ((counts?.mainView ?? 0) > 0) return row.id
  }
  return undefined
}
