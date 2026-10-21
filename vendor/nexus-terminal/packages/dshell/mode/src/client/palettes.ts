/**
 * dshell's palettes, in both of dsh's theme modes.
 *
 * A palette is dshell's own idea — a colour scheme, named and picked in the
 * settings card — but the SURFACE it is painted on is dsh's. dshell's block view
 * draws straight onto the app background (`bg` below is always `transparent`),
 * and dsh paints that background white (rgb(255, 255, 255)) in light mode and
 * near-black (rgb(21, 21, 23)) in dark mode. So every palette needs two skins:
 * the same identity, read against two different grounds.
 *
 * That is not cosmetic. Before this split the palettes were dark-only, and the
 * default one's `text` (#e8e8ec) landed on a white page as near-invisible grey —
 * a light-mode dsh with dshell installed showed shell output nobody could read.
 * `tests/palettes.spec.ts` holds the line: it measures each skin's contrast
 * against the exact surfaces above and fails if a palette drifts back to
 * unreadable.
 *
 * The ANSI vocabulary in a skin is the SURFACE's, not the identity's, and it is
 * the other half of that same bug: dshell hands xterm its palette, and xterm's
 * own defaults are the Tango set (`#eeeeec`, `#8ae234`, `#729fcf`) that a dark
 * ground wants. On a white page `ls` painted filenames near-white and
 * executables bright green — output that survived the foreground fix and was
 * still unreadable. A light skin therefore carries its own sixteen slots, and a
 * palette's identity shows through its chrome below instead.
 *
 * This module is deliberately DOM-free (no stores, no observers, no xterm) so
 * that measurement needs no browser: `theme.ts` is the stateful half that wires
 * these palettes to dsh's mode, the settings store, and the renderer.
 */

import { DEFAULT_THEME_ID, isThemeId, type DshellThemeId } from '../settings.js'
import type { DshellModeKey } from './locales.js'

/** Which of dsh's two surfaces a skin is drawn for. */
export type DshellThemeMode = 'light' | 'dark'

/**
 * The sixteen ANSI slots, named as xterm's `ITheme` names them.
 *
 * A slot is not a colour dshell chose to look nice — it is where a program's
 * own escape sequence lands, so the set has to be legible on the ground it is
 * measured against and nothing more. Which ground that is comes from the mode.
 */
export interface AnsiSkin {
  readonly black: string
  readonly red: string
  readonly green: string
  readonly yellow: string
  readonly blue: string
  readonly magenta: string
  readonly cyan: string
  readonly white: string
  readonly brightBlack: string
  readonly brightRed: string
  readonly brightGreen: string
  readonly brightYellow: string
  readonly brightBlue: string
  readonly brightMagenta: string
  readonly brightCyan: string
  readonly brightWhite: string
}

/** The surface-facing half of a palette — the fields dsh's mode decides. */
export interface ThemeSkin {
  readonly text: string
  readonly muted: string
  readonly border: string
  readonly borderStrong: string
  readonly inputBar: string
  readonly accent: string
  readonly accentText: string
  readonly accentBorder: string
  readonly accentFaint: string
  readonly menuBg: string
  readonly menuBorder: string
  /** Failure ink: a failed job, a lost wire, a thrown render. */
  readonly danger: string
  /** The same ink as a field behind it, for a notice or a crash report. */
  readonly dangerFaint: string
  /** Caution ink: a path that does not exist yet, a state to notice. */
  readonly warn: string
  /**
   * The faintest fill still visible on this ground: a hover, or the one row a
   * list marks as current. A white film on a dark page, a black one on a light
   * page, so neither can be written as a constant.
   */
  readonly faintFill: string
  /** The sixteen slots program output lands in (see {@link AnsiSkin}). */
  readonly ansi: AnsiSkin
}

/** A palette resolved for one mode: what every dshell surface actually reads. */
export interface Theme extends ThemeSkin {
  readonly id: DshellThemeId
  /** Dictionary key of the display name; the id above is the identifier. */
  readonly labelKey: DshellModeKey
  readonly mode: DshellThemeMode
  /** Always transparent: the app surface is the background. */
  readonly bg: 'transparent'
}

/** A named palette: one identity, drawn for either surface. */
export interface Palette {
  readonly id: DshellThemeId
  readonly labelKey: DshellModeKey
  readonly dark: ThemeSkin
  readonly light: ThemeSkin
}

/**
 * The half of a skin every palette shares, by mode: the semantic inks and the
 * ANSI vocabulary.
 *
 * A red is a red — a failure means the same thing whichever palette is picked —
 * so these are the surface's, and all four palettes read them. They live here
 * rather than in each skin because a palette's own identity is what varies
 * between the four: its greys, its borders, its accent.
 *
 * The dark ANSI set is xterm's own Tango default, written out rather than
 * inherited so that dshell's dark mode keeps painting program output exactly as
 * a dshell-less dsh does — a release that repainted everyone's `ls` would be a
 * regression dressed as a fix. Tango's bright column is unusable on white
 * ground, which is why the light set is dshell's own: same hues, darkened until
 * every slot clears 4.5:1 against the page (the floor `tests/palettes.spec.ts`
 * enforces).
 */
const SURFACE: Record<DshellThemeMode, Pick<ThemeSkin, 'danger' | 'dangerFaint' | 'warn' | 'faintFill' | 'ansi'>> = {
  dark: {
    danger: '#f87171',
    dangerFaint: 'rgba(248, 113, 113, 0.10)',
    warn: '#f0b46b',
    faintFill: 'rgba(255, 255, 255, 0.02)',
    ansi: {
      black: '#2e3436',
      red: '#cc0000',
      green: '#4e9a06',
      yellow: '#c4a000',
      blue: '#3465a4',
      magenta: '#75507b',
      cyan: '#06989a',
      white: '#d3d7cf',
      brightBlack: '#555753',
      brightRed: '#ef2929',
      brightGreen: '#8ae234',
      brightYellow: '#fce94f',
      brightBlue: '#729fcf',
      brightMagenta: '#ad7fa8',
      brightCyan: '#34e2e2',
      brightWhite: '#eeeeec',
    },
  },
  light: {
    danger: '#b42318',
    dangerFaint: 'rgba(180, 35, 24, 0.07)',
    warn: '#8a5a00',
    faintFill: 'rgba(15, 17, 21, 0.04)',
    ansi: {
      // Tango's hues, held back far enough that a white page stays readable.
      black: '#2e3436',
      red: '#a40000',
      green: '#3f7a05',
      yellow: '#8a6d00',
      blue: '#204a87',
      magenta: '#5c3566',
      cyan: '#0b6e70',
      white: '#5c6470',
      brightBlack: '#555753',
      brightRed: '#c00000',
      brightGreen: '#457d05',
      brightYellow: '#8f6c00',
      brightBlue: '#2a5d9e',
      brightMagenta: '#8a5a94',
      brightCyan: '#0e8085',
      brightWhite: '#6e7781',
    },
  },
}

export const THEMES: readonly Palette[] = [
  {
    id: 'midnight',
    labelKey: 'theme.midnight',
    dark: {
      text: '#e8e8ec',
      muted: '#9d9da6',
      border: '#1c1d22',
      borderStrong: '#2c2c33',
      inputBar: 'rgba(8, 8, 11, 0.6)',
      accent: '#7c3aed',
      accentText: '#cbb5ff',
      accentBorder: '#4c2a8a',
      accentFaint: 'rgba(124, 58, 237, 0.12)',
      menuBg: '#131418',
      menuBorder: '#2a2b31',
      ...SURFACE.dark,
    },
    light: {
      text: '#1b1c22',
      muted: '#61626b',
      border: '#e8e8ec',
      borderStrong: '#c6c7d0',
      inputBar: 'rgba(15, 17, 21, 0.05)',
      accent: '#6d28d9',
      accentText: '#5b21b6',
      accentBorder: '#c4b5fd',
      accentFaint: 'rgba(109, 40, 217, 0.08)',
      menuBg: '#ffffff',
      menuBorder: '#d9dae2',
      ...SURFACE.light,
    },
  },
  {
    id: 'solarized',
    labelKey: 'theme.solarized',
    dark: {
      text: '#93a1a1',
      muted: '#657b83',
      border: '#0f3a44',
      borderStrong: '#268bd2',
      inputBar: 'rgba(7, 38, 43, 0.55)',
      accent: '#b58900',
      accentText: '#fdf6e3',
      accentBorder: '#8a6a00',
      accentFaint: 'rgba(181, 137, 0, 0.14)',
      menuBg: '#002b36',
      menuBorder: '#0f3a44',
      ...SURFACE.dark,
    },
    light: {
      // Solarized's own light ground (base3) with its base00/01 inks.
      text: '#4b5f66',
      muted: '#6e8088',
      border: '#e7e0cc',
      borderStrong: '#b9b29b',
      inputBar: 'rgba(0, 43, 54, 0.05)',
      accent: '#a17800',
      accentText: '#7a5c00',
      accentBorder: '#d8c48a',
      accentFaint: 'rgba(161, 120, 0, 0.10)',
      menuBg: '#fdf6e3',
      menuBorder: '#e7e0cc',
      ...SURFACE.light,
    },
  },
  {
    id: 'dracula',
    labelKey: 'theme.dracula',
    dark: {
      text: '#f8f8f2',
      muted: '#6272a4',
      border: '#44475a',
      borderStrong: '#6272a4',
      inputBar: 'rgba(40, 42, 54, 0.6)',
      accent: '#ff79c6',
      accentText: '#ffb3da',
      accentBorder: '#bd4188',
      accentFaint: 'rgba(255, 121, 198, 0.14)',
      menuBg: '#282a36',
      menuBorder: '#44475a',
      ...SURFACE.dark,
    },
    light: {
      // The same pink, darkened to hold its contrast on a white page.
      text: '#282a36',
      muted: '#666a80',
      border: '#e6e6ee',
      borderStrong: '#c5c7d6',
      inputBar: 'rgba(40, 42, 54, 0.05)',
      accent: '#b2339a',
      accentText: '#8c1f74',
      accentBorder: '#e5b0d8',
      accentFaint: 'rgba(178, 51, 154, 0.08)',
      menuBg: '#ffffff',
      menuBorder: '#e0e0ea',
      ...SURFACE.light,
    },
  },
  {
    id: 'forest',
    labelKey: 'theme.forest',
    dark: {
      text: '#d0d7c5',
      muted: '#8a9a76',
      border: '#1f2e1c',
      borderStrong: '#4a6b3a',
      inputBar: 'rgba(15, 25, 18, 0.6)',
      accent: '#7fb069',
      accentText: '#bce09a',
      accentBorder: '#4a6b3a',
      accentFaint: 'rgba(127, 176, 105, 0.14)',
      menuBg: '#141c14',
      menuBorder: '#2a3a26',
      ...SURFACE.dark,
    },
    light: {
      text: '#232d1c',
      muted: '#617052',
      border: '#e3e8dd',
      borderStrong: '#c3cdb7',
      inputBar: 'rgba(31, 46, 28, 0.05)',
      accent: '#4a6b3a',
      accentText: '#3a5530',
      accentBorder: '#b6c9a4',
      accentFaint: 'rgba(74, 107, 58, 0.08)',
      menuBg: '#ffffff',
      menuBorder: '#dde5d5',
      ...SURFACE.light,
    },
  },
]

/**
 * Resolved skins, keyed by palette and mode.
 *
 * A palette is a constant, so a resolution of it is one too: the same pair
 * always answers with the same object. That identity is load-bearing — the
 * block view hands a theme to each shell region, and a region rebuilds its
 * xterm when the theme *changes*, so a fresh object per call would tear down
 * and reopen every visible terminal on every render. Returning the same object
 * keeps that effect firing when the palette or the mode actually changes, which
 * is exactly when the terminals must repaint.
 */
const RESOLVED = new Map<string, Theme>()

/**
 * Resolve a palette for one mode.
 * @param id - palette id; anything unknown falls back to the default palette.
 * @param mode - which of dsh's surfaces the result will be drawn on.
 * @returns the palette's skin for that mode, plus its identity.
 */
export function getTheme(id: unknown, mode: DshellThemeMode = 'dark'): Theme {
  const palette = THEMES.find(candidate => candidate.id === id) ?? THEMES[0]!
  const key = `${palette.id}:${mode}`
  const cached = RESOLVED.get(key)
  if (cached !== undefined) return cached
  const theme: Theme = {
    ...(mode === 'light' ? palette.light : palette.dark),
    id: palette.id,
    labelKey: palette.labelKey,
    mode,
    bg: 'transparent',
  }
  RESOLVED.set(key, theme)
  return theme
}

/** The palette a browser with no usable cache shows before the Host answers. */
export const FALLBACK_THEME_ID: DshellThemeId = DEFAULT_THEME_ID

export { isThemeId }
