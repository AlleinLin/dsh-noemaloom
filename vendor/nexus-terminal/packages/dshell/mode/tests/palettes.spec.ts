/**
 * dshell's palettes, measured against the surfaces dsh actually paints.
 *
 * The bug this exists for: the palettes were dark-only, so a light-mode dsh —
 * the desktop app's default is whatever the harness setting says, and the
 * settings document said light — drew dshell's terminal in #e8e8ec on white.
 * The output was there and nobody could read it. Contrast is the property that
 * failed, so contrast is what this file measures, with the two surfaces taken
 * from dsh's own palette (`--dsw-alias-bg-base`: `neutral-bluish-00` in light,
 * `neutral-bluish-950` in dark) rather than invented here.
 *
 * The thresholds are the WCAG ones where they apply: 4.5 for body text, 3.0 for
 * non-text indicators like the accent dot and the cursor. `muted` gets 3.5 —
 * it carries hints and secondary labels rather than prose, and two of the four
 * DARK skins measure 3.9–4.1 today, which this fix must not restyle.
 */

import { describe, expect, it } from 'vitest'
import { THEME_IDS } from '../src/settings.js'
import { getTheme, THEMES, type AnsiSkin, type ThemeSkin } from '../src/client/palettes.js'

/** dsh's own surfaces, from `ui-theme`'s `--dsw-alias-bg-base`. */
const SURFACE = { light: '#ffffff', dark: '#151517' } as const

/** sRGB relative luminance, per WCAG 2.1. */
function luminance(color: string): number {
  const hex = color.replace('#', '')
  const channels = [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const linear = channels.map(channel => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

function contrast(left: string, right: string): number {
  const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a)
  return (high! + 0.05) / (low! + 0.05)
}

const MODES = ['light', 'dark'] as const

describe('the palette table', () => {
  it('offers exactly the ids the settings schema accepts', () => {
    // A palette missing from here would leave a selectable id resolving to the
    // fallback, which looks like the picker doing nothing.
    expect(THEMES.map(palette => palette.id)).toEqual([...THEME_IDS])
  })

  it('gives every palette the same fields in both modes', () => {
    const fields: (keyof ThemeSkin)[] = [
      'text', 'muted', 'border', 'borderStrong', 'inputBar',
      'accent', 'accentText', 'accentBorder', 'accentFaint', 'menuBg', 'menuBorder',
      'danger', 'dangerFaint', 'warn', 'faintFill',
    ]
    for (const palette of THEMES) {
      for (const mode of MODES) {
        for (const field of fields) {
          expect(palette[mode][field], `${palette.id}.${mode}.${field}`).toMatch(/^(#[0-9a-f]{6}|rgba\()/u)
        }
      }
    }
  })

  it('resolves an unknown id to the default palette rather than to nothing', () => {
    expect(getTheme('not-a-palette').id).toBe(THEME_IDS[0])
    expect(getTheme('not-a-palette', 'light').mode).toBe('light')
  })

  it('keeps the app surface as the background in both modes', () => {
    for (const palette of THEMES) {
      expect(getTheme(palette.id, 'light').bg).toBe('transparent')
      expect(getTheme(palette.id, 'dark').bg).toBe('transparent')
    }
  })

  it('resolves one object per palette and mode', () => {
    // Not an optimisation: the block view rebuilds a shell region's terminal
    // when its theme changes, so a fresh object per call would tear down and
    // reopen every visible terminal on every render.
    for (const palette of THEMES) {
      for (const mode of MODES) {
        expect(getTheme(palette.id, mode)).toBe(getTheme(palette.id, mode))
      }
    }
    expect(getTheme('midnight', 'light')).not.toBe(getTheme('midnight', 'dark'))
  })
})

describe('contrast against dsh\'s surface', () => {
  for (const palette of THEMES) {
    for (const mode of MODES) {
      const skin = getTheme(palette.id, mode)
      const surface = SURFACE[mode]

      it(`${palette.id} (${mode}): body text is readable`, () => {
        expect(contrast(skin.text, surface)).toBeGreaterThanOrEqual(4.5)
      })

      it(`${palette.id} (${mode}): hints and secondary labels are readable`, () => {
        expect(contrast(skin.muted, surface)).toBeGreaterThanOrEqual(3.5)
      })

      it(`${palette.id} (${mode}): the accent reads as an indicator`, () => {
        expect(contrast(skin.accent, surface)).toBeGreaterThanOrEqual(3)
      })

      it(`${palette.id} (${mode}): accent-coloured text is readable`, () => {
        expect(contrast(skin.accentText, surface)).toBeGreaterThanOrEqual(4.5)
      })

      it(`${palette.id} (${mode}): text stays readable on the palette's own surface`, () => {
        // Menus, the block card and xterm's selection foreground paint
        // `menuBg` themselves, so this pair does not have dsh underneath it.
        expect(contrast(skin.text, skin.menuBg)).toBeGreaterThanOrEqual(4.5)
      })
    }
  }

  it('does not put a dark ink on the light surface or the reverse', () => {
    for (const palette of THEMES) {
      expect(luminance(getTheme(palette.id, 'light').text)).toBeLessThan(luminance(SURFACE.light) / 6)
      expect(luminance(getTheme(palette.id, 'dark').text)).toBeGreaterThan(luminance(SURFACE.dark) * 6)
    }
  })
})

/**
 * xterm's own ANSI defaults, copied from its `DEFAULT_ANSI_COLORS`.
 *
 * A literal because the assertion that uses it is about dshell NOT inventing
 * these: a dsh without dshell paints program output with exactly this table, and
 * a release that repainted it would be a regression dressed as a fix.
 */
const XTERM_ANSI: AnsiSkin = {
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
}

/** The slots a program paints with, in the order xterm names them. */
const ANSI_SLOTS = Object.keys(XTERM_ANSI) as (keyof AnsiSkin)[]

describe('the ANSI vocabulary', () => {
  /** The slots xterm's own table gets wrong on a white page. */
  const WRONG_ON_WHITE = ANSI_SLOTS.filter(slot => contrast(XTERM_ANSI[slot], SURFACE.light) < 4.5)

  it('redraws exactly the slots a light surface cannot read', () => {
    // The half of the light-mode bug that survives a foreground-only fix:
    // xterm's table is built for a dark ground, so a slot left at its default
    // still paints invisible text on white — `white` (#d3d7cf) above all, which
    // is what `ls` prints a filename in, and the bright column `ls` uses for a
    // directory. `black` and `brightBlack` stay as they are: on white they are
    // the readable greys they were never the problem.
    expect(WRONG_ON_WHITE.length, 'xterm\'s table is presumed unreadable on white').toBeGreaterThan(0)
    for (const palette of THEMES) {
      const light = getTheme(palette.id, 'light').ansi
      expect(Object.keys(light).sort()).toEqual([...ANSI_SLOTS].sort())
      const leftAlone = WRONG_ON_WHITE.filter(slot => light[slot] === XTERM_ANSI[slot])
      expect(leftAlone, `${palette.id} left these slots at xterm's dark value`).toEqual([])
    }
  })

  it('keeps xterm\'s own table on the dark surface, verbatim', () => {
    // The dark vocabulary is not dshell's to restyle — a release that repainted
    // it would change what every existing user's `ls` looks like — so it is
    // asserted as a copy rather than judged by the light skin's floor. Three of
    // these slots (`red`, `blue`, `magenta`) do sit below 4.5 against a
    // near-black ground; that is Tango's call, and it is the call a dsh without
    // dshell already makes.
    for (const palette of THEMES) {
      expect(getTheme(palette.id, 'dark').ansi, `${palette.id} dark`).toEqual(XTERM_ANSI)
    }
  })

  it('is readable on the light surface, every slot', () => {
    for (const palette of THEMES) {
      const light = getTheme(palette.id, 'light').ansi
      for (const slot of ANSI_SLOTS) {
        expect(light[slot], `${palette.id}.light.ansi.${slot}`).toMatch(/^#[0-9a-f]{6}$/u)
        expect(contrast(light[slot], SURFACE.light), `${palette.id}.light.ansi.${slot}`)
          .toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps failure and caution ink readable where a palette paints it', () => {
    for (const palette of THEMES) {
      for (const mode of MODES) {
        const skin = getTheme(palette.id, mode)
        expect(contrast(skin.danger, SURFACE[mode]), `${palette.id}.${mode}.danger`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(skin.warn, SURFACE[mode]), `${palette.id}.${mode}.warn`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
