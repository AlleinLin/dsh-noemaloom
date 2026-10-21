/**
 * The durable dshell section in the user-settings document.
 *
 * Everything dshell configures lives here, because a settings namespace is one
 * document and the Plugins section dispatches ONE card per namespace: the
 * terminal palette the composer draws with, and the switches for the shell
 * helpers that read the composer's line (Tab completion, the ↑ history list,
 * the ghost command hint).
 *
 * What travels is only the vocabulary: the palette id, and three booleans.
 * Nothing here is a fact the Host acts on — the colours stay in the browser
 * (`client/theme.ts`) and each switch gates a gesture in the key interceptor —
 * so the Host stores them and the browser half reads them.
 *
 * Only the vocabulary lives here, with no schema import: the browser half
 * merges it into the client bundle (which has no module table entry for
 * schemastery), while the Host half adds the schema from `settings-schema.ts`.
 * Sharing this file is why it sits beside `index.ts` rather than under
 * `client/`.
 */

/**
 * The plugin's own configuration, as rc.2 models it.
 *
 * A settings namespace is no longer registered under a free string: it IS the
 * profile entry id of the plugin that declares the schema (see the bundle
 * patch's `id: dshell-mode`), and the schema is the entry's exported `Config`.
 * Both halves below therefore name that entry rather than a namespace of their
 * own, and the two documents dshell used to keep (the terminal palette and
 * where it stores files) are sections of the one entry config.
 */

/** The profile entry whose config carries dshell's settings. */
export const DSHELL_ENTRY_ID = 'dshell-mode'

/** Field carrying the selected terminal palette. */
export const THEME_FIELD = 'theme'

/** Field enabling Tab path completion in the composer. */
export const TAB_COMPLETION_FIELD = 'tabCompletion'

/** Field enabling the ↑ history list. */
export const HISTORY_LIST_FIELD = 'historyList'

/** Field enabling the ghost command hint. */
export const COMMAND_HINT_FIELD = 'commandHint'

/**
 * Field allowing completion to ask the session's own shell.
 *
 * The one switch here that is not about a key: it decides whether Tab may spend
 * a round trip (and a bash process in the session's world) on the words the file
 * system cannot know — a flag, a subcommand. Off, Tab still completes commands
 * and paths; it just never asks the world what IT would offer.
 */
export const SHELL_ORACLE_FIELD = 'completionShellOracle'

/**
 * Field naming dshell's own data root — the directory its `dshell/` and
 * `dshell-pty/` trees are resolved under.
 *
 * The one field in dshell's settings the HOST reads for itself: everything else
 * travels to the browser and stops there, while this one is settled into the
 * process before any path helper asks (see `data-root.ts`). It is also the one
 * field whose change is not live — a process cannot move its own data root out
 * from under files it is writing, so a config change that moves it is only
 * honoured by the next start, and the card says so.
 *
 * The empty string means "follow the harness home", which is why the default is
 * empty rather than a path: a default spelling out `~/.dsh` would be a decision
 * taken at build time about a machine that has not been seen yet.
 */
export const DATA_DIR_FIELD = 'dir'

/**
 * Field carrying how often the session header re-reads its machine's load.
 *
 * The one setting here that buys something with a NUMBER rather than a yes: the
 * readout is a poll, and what it costs depends entirely on where the session
 * runs. On this machine a tick is a file read; on a device it is an `ssh` round
 * trip that spawns a shell, so the same interval is free in one world and
 * expensive in the other. Rather than pick for the reader, the interval is theirs
 * — and the card says what the number buys on a device.
 */
export const DEVICE_POLL_FIELD = 'devicePollMs'

/**
 * The intervals on offer, in milliseconds, cheapest first.
 *
 * A fixed ladder rather than a number box: the useful answers are "about as
 * often as I can read it" and "often enough that I stop noticing", and a box
 * invites a value no one means — a millisecond, or an hour.
 */
export const DEVICE_POLL_CHOICES = [2000, 5000, 10_000, 30_000, 60_000] as const

/** How often the readout re-reads a session's machine until a document says otherwise. */
export const DEVICE_POLL_DEFAULT = 5000

/** One offered interval. */
export type DevicePollMs = typeof DEVICE_POLL_CHOICES[number]

/** Value meaning "no override": resolve under the harness home, as before the field existed. */
export const DATA_DIR_DEFAULT = ''

/**
 * Palette ids, in the order the picker shows them. The colours for each id
 * live in `client/theme.ts`; only the vocabulary is shared, so the Host schema
 * and the browser registry cannot drift apart.
 */
export const THEME_IDS = ['midnight', 'solarized', 'dracula', 'forest'] as const

/** One selectable terminal palette id. */
export type DshellThemeId = typeof THEME_IDS[number]

/** Palette used when the settings document carries no override. */
export const DEFAULT_THEME_ID: DshellThemeId = 'midnight'

/**
 * Whether a shell helper is available when the document carries no override.
 *
 * On, because these are assists the composer was built around: a shell-mode
 * line with Tab, ↑ and the hint all live is the surface the rest of dshell
 * assumes. Turning one off is a deliberate act, so the default never has to be
 * the quiet one.
 */
export const SHELL_HELPER_DEFAULT = true

/** The shell-helper switches, as the settings document names them. */
export type DshellShellHelper = 'tabCompletion' | 'historyList' | 'commandHint' | 'completionShellOracle'

/** The shell-helper switches, in the order the settings card shows them. */
export const SHELL_HELPER_FIELDS: readonly DshellShellHelper[] = [
  'tabCompletion', 'historyList', 'commandHint', 'completionShellOracle',
]

/** The durable dshell section (the entry config). */
export interface DshellSettings {
  /** Selected terminal palette. */
  theme: DshellThemeId
  /** Whether Tab completes a path in the composer. */
  tabCompletion: boolean
  /** Whether ↑ opens the command history. */
  historyList: boolean
  /** Whether a recent command is ghosted after the caret. */
  commandHint: boolean
  /** Whether completion may ask the session's own shell for the rest. */
  completionShellOracle: boolean
  /** Directory dshell's own files live under; empty follows the harness home. */
  dir: string
  /** How often the session header re-reads its machine's load. */
  devicePollMs: DevicePollMs
}

/** The data-root section of the entry config. */
export interface DshellDataSettings {
  /** Directory dshell's own files live under; empty follows the harness home. */
  dir: string
}

/**
 * Narrow a value crossing the settings, registry, or storage boundary.
 * @param value - candidate palette id.
 * @returns whether the value names a known palette.
 */
export function isThemeId(value: unknown): value is DshellThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}

/**
 * Read one helper switch from a settings value of unknown shape.
 *
 * The document is user data: a hand-edited file, an older version, or another
 * browser's write can carry anything. A value that is not a boolean therefore
 * falls back to the default rather than to "off" — a switch is only off when
 * the document says so. (On the Host path a document that fails the schema is
 * refused as a whole, so this per-field reading is what the localStorage cache
 * and a partial mirror value go through.)
 *
 * @param value - the bound settings value, possibly partial or absent.
 * @param field - which switch to read.
 * @returns the stored switch, or the default.
 */
export function readShellHelper(value: unknown, field: DshellShellHelper): boolean {
  if (value === null || typeof value !== 'object') return SHELL_HELPER_DEFAULT
  const stored = (value as Record<string, unknown>)[field]
  return typeof stored === 'boolean' ? stored : SHELL_HELPER_DEFAULT
}

/**
 * Read the data-root field from a settings value of unknown shape.
 *
 * Same per-field reading as {@link readShellHelper}, with a different default:
 * a value that is not a string means "follow the harness home", so a document
 * written by an older dshell (which had no such field) resolves to the paths
 * that dshell used before rather than to a root nobody chose.
 *
 * @param value - the bound settings value, possibly partial or absent.
 * @returns the stored directory, or the empty string for the harness home.
 */
export function readDataDir(value: unknown): string {
  if (value === null || typeof value !== 'object') return DATA_DIR_DEFAULT
  const stored = (value as Record<string, unknown>)[DATA_DIR_FIELD]
  return typeof stored === 'string' ? stored.trim() : DATA_DIR_DEFAULT
}

/**
 * Narrow a value crossing the settings boundary to the data section.
 *
 * Exported for the browser half's mirror: the card reads the same field the host
 * settles, so both sides go through one reading rule rather than two that can
 * drift.
 *
 * @param value - the bound settings value, possibly partial or absent.
 * @returns the data section with its default applied.
 */
export function readDataSettings(value: unknown): DshellDataSettings {
  return { dir: readDataDir(value) }
}
