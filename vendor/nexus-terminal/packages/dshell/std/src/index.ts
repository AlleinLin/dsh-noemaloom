/**
 * dshell's standard layer.
 *
 * Everything here is shared machinery that must not belong to any one feature:
 * the wire contracts ({@link ./contracts.ts}), the host copy direction
 * ({@link ./host-copy.ts}) that a host half binds its own dictionaries to, the
 * storage contract ({@link ./storage.ts}) that a feature calls without knowing
 * its medium, and as the refactor continues, the dsh seam adapters (route
 * definition, session/world addressing, capability probing) that today live
 * duplicated inside feature packages.
 *
 * The rule that makes this layer worth having: it is the ONLY dshell package
 * allowed to care about how dsh spells things. A feature package imports from
 * here and keeps to its own product logic, so a dsh interface change is
 * absorbed in one place instead of re-implemented per plugin.
 */

export * from './contracts.js'
export * from './data-root.js'
export * from './host-copy.js'
export * from './session-view.js'
export * from './shell-line.js'
export * from './storage.js'
