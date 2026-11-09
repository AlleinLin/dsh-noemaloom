/**
 * The dshell 管理台's own icon in the settings navigation.
 *
 * dsh's settings shell picks an icon from the section ids it ships and draws
 * a generic gear for anything else, and the `settings.section` seat carries no
 * icon of its own — so the console's row would read as "some settings" instead
 * of dshell's.
 *
 * The artwork is the terminal, drawn like the icons beside it (16 viewBox,
 * 1.3px stroke): a prompt chevron and the underscore after it. Idempotent
 * via the label check and a marker attribute; delete both files the day
 * `settings.section` accepts an icon.
 */

/** The terminal: a prompt chevron and the underscore after it. */
const PROMPT_PATHS = [
  { d: 'M2.75 3.75L6.75 8L2.75 12.25', stroke: true },
  { d: 'M8.75 11.75H13.25', stroke: true },
] as const

const SVG_NS = 'http://www.w3.org/2000/svg'

/** The marker that says a row already carries our artwork. */
const MARKER = 'data-dshell-admin-icon'

/** One prompt, sized and coloured like the icons beside it. */
function promptIcon(size: number, className: string | null): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke-width', '1.3')
  svg.setAttribute('aria-hidden', 'true')
  if (className !== null) svg.setAttribute('class', className)
  for (const spec of PROMPT_PATHS) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', spec.d)
    if (spec.stroke) path.setAttribute('stroke', 'currentColor')
    else path.setAttribute('fill', 'currentColor')
    svg.append(path)
  }
  return svg
}

/**
 * Keep the settings navigation's dshell row drawn with the prompt.
 *
 * @param label - the section label as the shell renders it, in the live locale.
 * @returns the disposer that stops watching.
 */
export function watchDshellNavIcon(label: () => string): () => void {
  if (typeof document === 'undefined') return () => {}
  const patch = (): void => {
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      for (const row of dialog.querySelectorAll('nav button')) {
        const text = row.textContent?.trim() ?? ''
        if (text !== label()) continue
        const svg = row.querySelector('svg')
        if (svg === null || svg.getAttribute(MARKER) !== null) continue
        const replacement = promptIcon(
          Number(svg.getAttribute('width') ?? 16) || 16,
          svg.getAttribute('class'),
        )
        replacement.setAttribute(MARKER, '')
        svg.replaceWith(replacement)
      }
    }
  }
  patch()
  const observer = new MutationObserver(() => { patch() })
  observer.observe(document.body, { childList: true, subtree: true })
  return () => { observer.disconnect() }
}
