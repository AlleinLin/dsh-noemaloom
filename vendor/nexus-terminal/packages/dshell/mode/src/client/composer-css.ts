/**
 * The terminal session's composer sits on the page, not in a card.
 *
 * dsh's composer is a raised rounded card (`[data-composer-card]`, 28px radius,
 * a surface fill and a shadow), which is right for a chat page and wrong for a
 * terminal: the input line belongs to the same surface as the output above it.
 * The card therefore loses its fill, radius and shadow, and the row gains a
 * hairline above it — the divider that separates terminal output from input
 * without boxing the input in.
 *
 * The submit button wears a return key rather than dsh's send arrow — the same
 * keystroke the user presses, drawn as the key that sends it. Only the arrow is
 * replaced: the stop square dsh swaps in during a turn keeps its own artwork,
 * which is what the artwork selector keys on.
 *
 * The composer's own controls are styled from here too: the legend and full
 * screen buttons are icons with no labels, so their hover is the only thing that
 * says they are controls — and it is dsh's hover token, not one of ours, because
 * they sit in a row of dsh's own.
 *
 * Scoped to terminal sessions only, by a body attribute this package sets while
 * one is on screen: a stock session's composer keeps dsh's own card and arrow.
 */

const STYLE_ID = 'dshell-composer-css'

/** The body attribute that scopes these rules to a terminal session. */
const BODY_ATTR = 'data-dshell-terminal-session'

/** dsh's own marker on the composer card. */
const CARD = '[data-composer-card]'

/** The submit button, matched by the role segment its CSS-module class keeps. */
const SUBMIT = `${CARD} button[class*='_primary']`

/**
 * The submit button itself, narrowed to the send state by its arrow artwork.
 *
 * The class name is a CSS-module hash, so the role segment is as much as can be
 * stated; the arrow path prefix is what tells the send state from the stop one.
 */
const SEND = `${SUBMIT}:has(> svg > path[d^='M8.3125'])`

/** The return key, stroke-only so `currentColor` can tint the mask. */
const RETURN_GLYPH = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12.6 3.2v5.3a2.6 2.6 0 0 1-2.6 2.6H4.4'/%3E%3Cpath d='M7.3 8.1 4.4 11l2.9 2.9'/%3E%3C/svg%3E")`

const RULES = `
body[${BODY_ATTR}='on'] ${CARD} {
  background: transparent;
  border-radius: 0;
  box-shadow: none;
}
body[${BODY_ATTR}='on'] *:has(> ${CARD}) {
  border-top: 1px solid var(--dsw-alias-border-l1);
}
body[${BODY_ATTR}='on'] ${SEND} {
  position: relative;
}
body[${BODY_ATTR}='on'] ${SEND} > svg {
  display: none;
}
body[${BODY_ATTR}='on'] ${SEND}::after {
  content: '';
  position: absolute;
  inset: 0;
  margin: auto;
  width: 16px;
  height: 16px;
  background-color: currentColor;
  -webkit-mask: ${RETURN_GLYPH} center / 16px 16px no-repeat;
  mask: ${RETURN_GLYPH} center / 16px 16px no-repeat;
}
body[${BODY_ATTR}='on'] [data-dshell-control] {
  background: transparent;
}
body[${BODY_ATTR}='on'] [data-dshell-control]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
body[${BODY_ATTR}='on'] [data-dshell-control]:focus-visible {
  outline: 2px solid var(--dsw-alias-interactive-bg-hover-accent);
  outline-offset: 1px;
}
`

/** Inject the rules once per page. */
export function injectComposerCss(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = RULES
  document.head.append(style)
}

/**
 * Mark (or unmark) the page as showing a terminal session.
 * @param on - whether the current session is a terminal one.
 */
export function markTerminalSession(on: boolean): void {
  if (typeof document === 'undefined') return
  if (on) document.body.setAttribute(BODY_ATTR, 'on')
  else document.body.removeAttribute(BODY_ATTR)
}
