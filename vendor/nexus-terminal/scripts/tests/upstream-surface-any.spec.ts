/**
 * The same surface claim, measured against ANY dsh checkout.
 *
 * scripts/tests/upstream-surface.spec.ts guards the checkout dsh-upstream.json pins.
 * That is the gate a release runs, but it cannot answer "would the NEXT dsh still
 * work?" — which is exactly the question a peer-range widening has to ask before it
 * is written, because the version gate compares numbers and a dsh release may drop
 * or rename any name dshell reaches for while the range still admits it.
 *
 * Point DSH_SURFACE_ROOT at a checkout and this asks the same question of it:
 *
 *   DSH_SURFACE_ROOT=path/to/dsh vitest run scripts/tests/upstream-surface-any.spec.ts
 *
 * With no variable set it reads the pinned mirror, so a plain run reports the same
 * checkout as the release gate and the two agree — the title names which one it got.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  DSHELL_SURFACE,
  missingSurface,
  readSurfaceAt,
  type SurfaceGap,
} from '../upstream-surface.ts'

// Any dsh checkout can be measured: point DSH_SURFACE_ROOT at it. The default is
// the pinned mirror, which is what the release gate reads.
const ROOT = process.env.DSH_SURFACE_ROOT ?? fileURLToPath(new URL('../../dsh', import.meta.url))
const WHICH = process.env.DSH_SURFACE_ROOT === undefined ? 'the pinned mirror' : ROOT

// Awaited at the top of every test rather than at module scope: a checkout that
// cannot be read must fail the test that asked for it, not the collection of the
// whole file, so the failure names the checkout.
let declared: Awaited<ReturnType<typeof readSurfaceAt>>

beforeAll(async () => { declared = await readSurfaceAt(ROOT) })

function describeGap(gap: SurfaceGap): string {
  return gap.kind + " '" + gap.name + "' (used at " + gap.usedAt + ')'
}

describe('the dsh surface dshell consumes, against ' + WHICH, () => {
  it('is declared by that checkout', () => {
    expect(missingSurface(DSHELL_SURFACE, declared).map(describeGap)).toEqual([])
  })

  it('still carries the browser-side services', () => {
    const clientOnly = ['slots', 'uiConversation', 'locale', 'sidebarRightTabs', 'inputTriggers']
    expect(clientOnly.filter(name => !declared.services.has(name))).toEqual([])
  })

  it('reads a checkout that has the catalogs it depends on', () => {
    // The reader refuses a checkout whose catalogs are missing or empty, so
    // reaching here at all is the proof these are populated. The numbers are
    // asserted rather than merely logged, so a checkout that shrank below the
    // surface dshell needs fails instead of reporting a smaller reading.
    expect(declared.services.size).toBeGreaterThan(100)
    expect(declared.slots.size).toBeGreaterThan(50)
    expect(declared.events.size).toBeGreaterThan(20)
  })

  it('reports what it measured', () => {
    // The reading itself, so a run's output says which checkout answered and how
    // much of it there was. Printed rather than asserted: the assertions above
    // are the gate, this is the evidence.
    console.log('SURFACE ' + WHICH + ' services=' + declared.services.size + ' slots=' + declared.slots.size + ' events=' + declared.events.size)
  })
})
