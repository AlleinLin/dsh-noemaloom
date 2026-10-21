/**
 * The transfer view's glyph: two arrows passing each other.
 *
 * Drawn here rather than taken from dsh's icon set, which has no exchange
 * glyph — the closest pair (`download` / `right-up`) names one direction each,
 * while this is the feature's whole idea. Follows the set's contract: a
 * `currentColor` fill and a `{size, className}` shape, so it sits in a header
 * button and a chip exactly as the shipped icons do.
 */

import { createElement, type ReactElement } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Two horizontal arrows, the upper one pointing right and the lower one left.
 * @param props - glyph size, and an optional class for the caller's own styling.
 * @returns the glyph.
 */
export function TransferGlyph({ size = 16, className }: IconProps): ReactElement {
  return createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    className,
    'aria-hidden': true,
  },
    createElement('path', {
      d: 'M2.6 5.1h9.3M9.4 2.6l2.5 2.5-2.5 2.5',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
    createElement('path', {
      d: 'M13.4 10.9H4.1M6.6 8.4l-2.5 2.5 2.5 2.5',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}
