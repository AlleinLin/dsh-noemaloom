/**
 * The dshell-ssh entry config.
 *
 * Device records and keys stay in this plugin's own directory (a settings
 * document is the wrong home for secrets), but the *preference* — which device
 * a new session offers first — is ordinary plugin configuration. rc.2 takes it
 * from the schema the entry exports as `Config`, keyed by the entry id in the
 * bundle patch (`dshell-ssh`), which is also what dispatches this plugin's own
 * settings card.
 */

import z from '@deepseek-ai/schemastery'
import { HIDDEN_DEVICES_FIELD } from '@nexus-aethra/dshell-std'
import { SSH_SETTINGS_NAMESPACE } from './protocol.js'

export { SSH_SETTINGS_NAMESPACE }

// Re-exported for the browser half, which reads and writes this field without
// importing this file -- a client bundle that reached the schema would pull
// @deepseek-ai/schemastery into the browser, where dsh's module table does not
// serve it.
export { HIDDEN_DEVICES_FIELD }

/** Field carrying the device preselected for new sessions. */
export const DEFAULT_DEVICE_FIELD = 'defaultDevice'


/** The durable section. */
export interface SshSettings {
  /** Device id preselected in the new-session picker; empty means local. */
  defaultDevice: string
  /**
   * Device ids the reader hid from the pickers.
   *
   * A picker preference rather than device state: a hidden row still exists,
   * still answers, and a session already bound to it keeps running there.
   * Only a provider's built-in row is ever hidden (see
   * {@link isHiddenDevice}), because the toggle that writes this lives on the
   * provider's own card and a stored device is managed by deleting it.
   */
  hiddenDevices: string[]
}

/** Default when the config carries no override. */
export const DEFAULT_SSH_SETTINGS: SshSettings = { defaultDevice: '', hiddenDevices: [] }

/** The entry config schema, on the Host and on the wire. */
export const Config = z.object({
  [DEFAULT_DEVICE_FIELD]: z.string().default(''),
  // An array rather than a map: the document holds ids, and the card that
  // writes them is a list of rows with a toggle each. Declared even though
  // only the browser acts on it -- an undeclared field is stored but dropped
  // from the RESOLVED value, so a second browser would never see the choice.
  [HIDDEN_DEVICES_FIELD]: z.array(z.string()).default([]),
}) as unknown as z<SshSettings>

