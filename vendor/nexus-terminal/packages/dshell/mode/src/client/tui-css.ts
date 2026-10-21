/**
 * Put dsh's composer away while a program owns the screen.
 *
 * A full-screen mode and a line-oriented input box cannot both be on screen:
 * the composer claims Tab, the arrows, Escape and Ctrl+C for its own assists
 * and its own line editing, and a program that reads the keyboard directly
 * needs exactly those keys. So the composer goes away for as long as the
 * program is on the screen, and the surface it was taking is the surface the
 * program gets — which is also the point, since a full-screen program wants
 * every row it can have.
 *
 * The anchor is `data-composer-seat`, which dsh puts on the composer's own
 * seat: the element that holds the composer card and its dock row, and the
 * element that stops taking layout space when it is hidden — so the view above
 * it grows and the terminal is re-measured without anything else being asked.
 */

const STYLE_ID = 'dshell-tui-css'

/** The body attribute that scopes the rule to a session in full-screen mode. */
const BODY_ATTR = 'data-dshell-tui'

/** dsh's own marker on the composer's seat. */
const COMPOSER_SEAT = '[data-composer-seat]'

/**
 * Inject the rule once per page.
 *
 * Marking an element dsh owns by its own data attribute is what keeps this from
 * depending on a hashed class name; the attribute is the one the layout itself
 * is built on, so it moves only when the layout does.
 */
export function injectTuiCss(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `body[${BODY_ATTR}] ${COMPOSER_SEAT} { display: none !important; }`
  document.head.append(style)
}

/**
 * Whether the composer is currently away.
 * @param hidden - true to put it away, false to bring it back.
 */
export function setComposerHidden(hidden: boolean): void {
  if (typeof document === 'undefined') return
  if (hidden) document.body.setAttribute(BODY_ATTR, '')
  else document.body.removeAttribute(BODY_ATTR)
}
