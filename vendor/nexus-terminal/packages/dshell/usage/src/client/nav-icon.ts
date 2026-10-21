/**
 * The usage entry's own icon in the settings navigation.
 *
 * dsh's settings shell picks a nav icon from a map of the section ids IT ships
 * (`account`, `models`, `plugins`, …) and draws a generic gear for anything
 * else, and rc.2's `settings.section` seat carries no icon of its own — so a
 * contributed section cannot ask for one and ours read as "some settings".
 *
 * Hence the one DOM patch in this package: find our own row by the label we
 * registered, and put a gauge where the gear was. It is the same technique
 * dshell's sidebar section uses (and the artwork is copied verbatim from
 * `@deepseek-ai/dsh-client-ui-primitives`, medium weight, 16 viewBox, 1.3px
 * stroke) because a surface mounted into a node dsh owns cannot render React
 * components into it.
 *
 * The row is re-created whenever the dialog opens, so a MutationObserver
 * watches for it; the patch is idempotent (it re-checks the label and a marker
 * attribute) and only touches the svg node React will not write to again.
 * Delete this file the day `settings.section` accepts an icon.
 */

/**
 * The gauge artwork, verbatim from the primitives package
 * (`IconGaugeOutlineMedium`): the same three paths, in the same order.
 */
const GAUGE_PATHS = [
  { d: 'M3.4041 13.096C2.49514 12.187 1.87614 11.0288 1.62537 9.76798C1.37459 8.50716 1.50331 7.20028 1.99525 6.01261C2.48719 4.82494 3.32025 3.80981 4.3891 3.09557C5.45795 2.38134 6.71458 2.00008 8.0001 2C9.28563 2.00008 10.5423 2.38134 11.6111 3.09557C12.68 3.80981 13.513 4.82494 14.005 6.01261C14.4969 7.20028 14.6256 8.50716 14.3748 9.76798C14.1241 11.0288 13.5051 12.187 12.5961 13.096', stroke: true },
  { d: 'M8 8.49994L11.6114 4.88855', stroke: true },
  { d: 'M8 9.75C8.69036 9.75 9.25 9.19036 9.25 8.5C9.25 7.80964 8.69036 7.25 8 7.25C7.30964 7.25 6.75 7.80964 6.75 8.5C6.75 9.19036 7.30964 9.75 8 9.75Z', stroke: false },
] as const

const SVG_NS = 'http://www.w3.org/2000/svg'

/** The marker that says a row already carries our artwork. */
const MARKER = 'data-dshell-usage-icon'

/** One gauge, sized and coloured like the icons beside it. */
function gauge(size: number, className: string | null): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke-width', '1.3')
  svg.setAttribute('aria-hidden', 'true')
  if (className !== null) svg.setAttribute('class', className)
  for (const spec of GAUGE_PATHS) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', spec.d)
    if (spec.stroke) path.setAttribute('stroke', 'currentColor')
    else path.setAttribute('fill', 'currentColor')
    svg.append(path)
  }
  return svg
}

/**
 * Keep the settings navigation's usage row drawn with the gauge.
 *
 * @param label - the section label as the shell renders it, in the live locale.
 * @returns the disposer that stops watching.
 */
export function watchUsageNavIcon(label: () => string): () => void {
  if (typeof document === 'undefined') return () => {}
  const patch = (): void => {
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      for (const row of dialog.querySelectorAll('nav button')) {
        const text = row.textContent?.trim() ?? ''
        if (text !== label()) continue
        const svg = row.querySelector('svg')
        if (svg === null || svg.getAttribute(MARKER) !== null) continue
        // React owns both children by position and neither is re-rendered while
        // the dialog lives, so the replacement is what the reader sees; the
        // pristine node would only come back with a full re-mount, which the
        // observer catches.
        const replacement = gauge(
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
