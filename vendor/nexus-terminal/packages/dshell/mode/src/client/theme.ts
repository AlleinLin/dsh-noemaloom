/**
 * dshell's live palette: the selected scheme, dsh's current mode, and the
 * renderer mapping.
 *
 * The registry is a module-level snapshot store so a palette switch re-renders
 * every seat (chips, block view, settings card) without prop drilling. A second
 * store holds which of dsh's two surfaces is in force, because a palette here is
 * a colour scheme with a light skin and a dark skin (`palettes.ts`) and the
 * resolved colours are a function of both.
 *
 * The selected id is authoritative in the Host settings document
 * (`../settings.ts`, namespace `dshell`) and is edited through the card
 * the browser half contributes to the dshell-mode page in the Plugins panel.
 * localStorage
 * holds the last accepted id ONLY as a pre-paint cache: the first render
 * happens before the settings scope answers, and repainting the default
 * palette on every load would flash. A Host answer always wins over the cache.
 *
 * The MODE is not ours to choose and is never persisted: dsh's own theme
 * setting owns it, and it announces itself by toggling `data-ds-dark-theme` on
 * `<body>` (see ui-theme's boot script and its ThemePresenter). Nothing emits an
 * event for it, so this module watches the attribute.
 */

import { useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ITheme } from '@xterm/xterm'
import { DEFAULT_THEME_ID, isThemeId, type DshellThemeId } from '../settings.js'
import { getTheme, THEMES, type DshellThemeMode, type Theme } from './palettes.js'
import { XTERM_CSS } from './xterm-css.js'

export { getTheme, THEMES }
export type { DshellThemeMode, Palette, Theme, ThemeSkin } from './palettes.js'

/** The attribute dsh's theme presenter toggles on `<body>` for dark mode. */
const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/**
 * Read dsh's mode from the DOM.
 *
 * The attribute is written by ui-theme's inline boot script before any client
 * bundle evaluates, so it is authoritative as soon as `<body>` exists. The
 * media query is only the answer for the sliver before that, and for a page
 * that never got the boot script.
 * @returns which surface dsh is painting.
 */
function readMode(): DshellThemeMode {
  const body = typeof document === 'undefined' ? null : document.body
  if (body !== null) return body.hasAttribute(DARK_ATTRIBUTE) ? 'dark' : 'light'
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

/** dsh's current mode; every resolved palette reads it. */
export const themeModeStore = createSnapshotStore<DshellThemeMode>(readMode())

/**
 * Follow dsh's mode for the life of the page.
 *
 * Two observers rather than one, because the bundle can evaluate while `<body>`
 * is still being parsed: the first waits for the element, then hands over to the
 * attribute observer that does the real work.
 */
function watchMode(): void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
  const followAttributes = (body: HTMLElement): void => {
    new MutationObserver(() => { themeModeStore.set(readMode()) })
      .observe(body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] })
    themeModeStore.set(readMode())
  }
  if (document.body !== null) {
    followAttributes(document.body)
    return
  }
  const waiter = new MutationObserver(() => {
    if (document.body === null) return
    waiter.disconnect()
    followAttributes(document.body)
  })
  waiter.observe(document.documentElement, { childList: true })
}

watchMode()

export const THEME_STORAGE_KEY = 'dshell.theme'

/** Read the pre-paint cache; an unknown or unavailable store means the default. */
function cachedTheme(): DshellThemeId {
  if (typeof localStorage === 'undefined') return DEFAULT_THEME_ID
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return isThemeId(stored) ? stored : DEFAULT_THEME_ID
  } catch {
    return DEFAULT_THEME_ID
  }
}

/**
 * Write the settings namespace, when one is bound. `null` means this client
 * has no settings transport: the palette then stays browser-local rather than
 * silently dropping the user's pick.
 */
let persistTheme: ((id: DshellThemeId) => void) | null = null

/**
 * Bind the Host settings writer. Called once by the plugin body with the
 * scope it created; the setter identity is stable for the process lifetime.
 * @param persist - sink receiving each accepted palette id.
 */
export function connectThemeSettings(persist: (id: DshellThemeId) => void): void {
  persistTheme = persist
}

/** Module-level palette store; single subscription feeds every dock instance. */
export const themeStore = createSnapshotStore<DshellThemeId>(cachedTheme())

/**
 * Adopt a palette. The local store updates first so the UI is never waiting on
 * a round trip; the durable write follows through whichever sink is bound.
 * @param id - palette to select; unknown ids fall back to the default.
 */
export function setTheme(id: unknown): void {
  const theme = getTheme(id, themeModeStore.getSnapshot())
  themeStore.set(theme.id)
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(THEME_STORAGE_KEY, theme.id) } catch { /* ignore */ }
  }
  persistTheme?.(theme.id)
}

/**
 * Adopt a palette the Host reported, without writing it back. Used by the
 * settings mirror (another browser, or the same user's earlier session).
 * @param id - palette id from the settings document.
 */
export function adoptTheme(id: unknown): void {
  if (!isThemeId(id)) return
  if (themeStore.getSnapshot() === id) return
  themeStore.set(id)
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(THEME_STORAGE_KEY, id) } catch { /* ignore */ }
  }
}

/**
 * React binding for the selected palette, resolved against dsh's current mode.
 * Both stores are subscribed, so switching dsh's theme repaints every dshell
 * surface without a reload.
 */
export function useDshellTheme(): Theme {
  const id = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot)
  const mode = useSyncExternalStore(themeModeStore.subscribe, themeModeStore.getSnapshot)
  return getTheme(id, mode)
}

export let xtermCssInjected = false

/** The combo loader serves one client.js per plugin — inject the stylesheet at runtime. */
export function injectXtermCss(): void {
  if (xtermCssInjected) return
  xtermCssInjected = true
  const style = document.createElement('style')
  // xterm's own CSS leaves the viewport opaque in some renderers; force the
  // whole terminal tree transparent so each terminal blends with the app
  // surface instead of painting a black card.
  style.textContent = `${XTERM_CSS}\n.xterm,.xterm-viewport,.xterm-screen,.xterm-scrollable-element{background-color:transparent !important;}`
  document.head.append(style)
}

/** Map a dock theme palette onto the xterm renderer. The background stays
 * fully transparent so the terminal blends with the app surface instead of
 * painting its own black card (the palette's `bg` is `transparent` too), and
 * the skin's ANSI slots travel with it: they are what a program's own colours
 * are rendered as, and the light skin's set exists so `ls` stays readable on a
 * white page. */
export function xtermTheme(theme: Theme): ITheme {
  return {
    background: '#00000000',
    foreground: theme.text,
    cursor: theme.accent,
    cursorAccent: '#00000000',
    ...theme.ansi,
    // Reverse-video selection, keyed to the active palette: the highlight is
    // the theme's own accent and the glyphs invert to its flat surface
    // (`menuBg`), so a selection reads as part of the current theme rather
    // than a fixed system blue. Both pairs are set — focus usually sits in
    // the composer while the user drags across the canvas, and xterm would
    // otherwise paint its near-invisible inactive colour.
    selectionBackground: theme.accent,
    selectionInactiveBackground: theme.accent,
    selectionForeground: theme.menuBg,
  }
}
