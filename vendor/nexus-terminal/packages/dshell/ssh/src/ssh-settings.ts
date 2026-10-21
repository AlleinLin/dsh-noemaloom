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
import { SSH_SETTINGS_NAMESPACE } from './protocol.js'

export { SSH_SETTINGS_NAMESPACE }

/** Field carrying the device preselected for new sessions. */
export const DEFAULT_DEVICE_FIELD = 'defaultDevice'

/** The durable section. */
export interface SshSettings {
  /** Device id preselected in the new-session picker; empty means local. */
  defaultDevice: string
}

/** Default when the config carries no override. */
export const DEFAULT_SSH_SETTINGS: SshSettings = { defaultDevice: '' }

/** The entry config schema, on the Host and on the wire. */
export const Config = z.object({
  [DEFAULT_DEVICE_FIELD]: z.string().default(''),
}) as unknown as z<SshSettings>

