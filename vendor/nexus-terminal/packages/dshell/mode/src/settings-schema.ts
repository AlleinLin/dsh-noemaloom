/**
 * The Host-side schema for dshell's entry config.
 *
 * Split from `settings.ts` because schema construction must not reach the
 * browser bundle: the client build resolves only the platform module table, and
 * pulling schemastery in through a shared import breaks the whole client
 * plugin load with a missing-module error.
 *
 * rc.2 reads a plugin's configuration from the schema its entry EXPORTS as
 * `Config`; the entry id in the bundle patch (`dshell-mode`) is the namespace
 * the browser's `ctx.configForms` keys on. The two documents dshell kept in
 * alpha.2 (terminal preferences, data root) are now sections of this one
 * object, which is why one configuration page renders both cards.
 */

import z from '@deepseek-ai/schemastery'
import {
  COMMAND_HINT_FIELD, DATA_DIR_DEFAULT, DATA_DIR_FIELD, DEFAULT_THEME_ID, DEVICE_POLL_CHOICES, DEVICE_POLL_DEFAULT, DEVICE_POLL_FIELD,
  HISTORY_LIST_FIELD, SHELL_HELPER_DEFAULT, SHELL_ORACLE_FIELD, TAB_COMPLETION_FIELD, THEME_FIELD, THEME_IDS,
  type DshellSettings,
} from './settings.js'

/**
 * The entry config schema, on the Host and on the wire.
 *
 * Each helper switch is a plain boolean with the shared default, so an empty or
 * older document resolves to the assists being ON — the composer those settings
 * govern is built around them.
 */
export const Config = z.object({
  [THEME_FIELD]: z.union([...THEME_IDS]).default(DEFAULT_THEME_ID),
  [TAB_COMPLETION_FIELD]: z.boolean().default(SHELL_HELPER_DEFAULT),
  [HISTORY_LIST_FIELD]: z.boolean().default(SHELL_HELPER_DEFAULT),
  [COMMAND_HINT_FIELD]: z.boolean().default(SHELL_HELPER_DEFAULT),
  // Declared even though only the browser acts on it: an undeclared field is
  // stored but dropped from the RESOLVED value, so the mirror this card reads
  // back (and any second browser) would see the default instead of the choice.
  [SHELL_ORACLE_FIELD]: z.boolean().default(SHELL_HELPER_DEFAULT),
  // The data root is a section of the same object now, and it is the one field
  // the Host settles for itself at apply. Its change is not live: a running
  // process cannot move its own data root out from under files it is writing,
  // so the card labels it as next-start and says so in its own copy.
  [DATA_DIR_FIELD]: z.string().default(DATA_DIR_DEFAULT),
  // The poll interval for the session header's machine readout. Declared as the
  // ladder rather than a natural number so a document cannot name an interval
  // the card offers no way back from.
  [DEVICE_POLL_FIELD]: z.union([...DEVICE_POLL_CHOICES]).default(DEVICE_POLL_DEFAULT),
}) as unknown as z<DshellSettings>
