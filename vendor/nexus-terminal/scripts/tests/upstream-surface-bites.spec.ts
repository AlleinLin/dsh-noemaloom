/**
 * Red-light proof: the surface gate must fail when the checkout loses a name.
 *
 * A gate nobody has seen fail is a gate nobody knows works. This spec builds a reader
 * over the REAL checkout -- the catalogs verbatim, the context walk real -- and then
 * removes one service, one slot and one event, asserting the comparison names exactly
 * those. The catalogs are edited in memory so the checkout itself is never touched.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DSHELL_SURFACE,
  UPSTREAM_SURFACE_FILES,
  missingSurface,
  readUpstreamSurface,
} from '../upstream-surface.ts'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DSH_ROOT = join(REPO_ROOT, 'dsh')

/** Every non-test source file under the checkout's `packages` tree. */
function listDshSources(): readonly string[] {
  const found: string[] = []
  const skip = new Set(['node_modules', 'lib', 'dist'])
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
        found.push(relative(DSH_ROOT, path).replaceAll('\\', '/'))
      }
    }
  }
  walk(join(DSH_ROOT, 'packages'))
  return found
}

/** A reader over the real checkout, with optional in-memory edits per catalog. */
function reader(edits: Partial<Record<string, (text: string) => string>> = {}) {
  const sources = listDshSources()
  return (path: string): string => {
    const text = readFileSync(join(DSH_ROOT, path), 'utf8')
    const edit = edits[path]
    return edit === undefined ? text : edit(text)
  }
}

/** Remove every line carrying `needle`. */
function dropLine(needle: string) {
  return (text: string): string => text.split('\n').filter(line => !line.includes(needle)).join('\n')
}

describe('the surface gate bites', () => {
  it('is green on the untouched checkout', () => {
    const declared = readUpstreamSurface(reader(), listDshSources)
    expect(missingSurface(DSHELL_SURFACE, declared)).toEqual([])
  })

  it('goes red when a service it uses disappears', () => {
    // `terminals` is what the PTY bridge registers its backend into. It is declared
    // in TWO places -- the generated catalog and the package's own `Context` merge --
    // so a red light needs both gone. Deleting one alone must still be green: a gate
    // that fired on the catalog alone would report a rename dsh never made.
    const both = reader({
      [UPSTREAM_SURFACE_FILES.services]: dropLine("key: 'terminals'"),
    })
    const declared = readUpstreamSurface(
      path => both(path).replace('terminals: TerminalSessionService', 'terminalsX: TerminalSessionService'),
      listDshSources,
    )
    expect(missingSurface(DSHELL_SURFACE, declared).map(gap => gap.kind + ':' + gap.name))
      .toContain('service:terminals')
  })

  it('stays green when only one of the two declarations is removed', () => {
    // The catalog is a projection of the Context merges. Losing it alone is a dsh
    // regeneration artifact, not a rename dshell has to chase.
    const declared = readUpstreamSurface(
      reader({ [UPSTREAM_SURFACE_FILES.services]: dropLine("key: 'terminals'") }),
      listDshSources,
    )
    expect(missingSurface(DSHELL_SURFACE, declared)).toEqual([])
  })

  it('goes red when a slot it registers into disappears', () => {
    const declared = readUpstreamSurface(
      reader({ [UPSTREAM_SURFACE_FILES.slots]: dropLine("key: 'sidebar.right.pane.tab'") }),
      listDshSources,
    )
    expect(missingSurface(DSHELL_SURFACE, declared).map(gap => gap.kind + ':' + gap.name))
      .toContain('slot:sidebar.right.pane.tab')
  })

  it('goes red when an event it matches on disappears', () => {
    const declared = readUpstreamSurface(
      reader({ [UPSTREAM_SURFACE_FILES.events]: dropLine("'assistant/message'") }),
      listDshSources,
    )
    expect(missingSurface(DSHELL_SURFACE, declared).map(gap => gap.kind + ':' + gap.name))
      .toContain('event:assistant/message')
  })

  it('refuses a checkout whose catalog it cannot read', () => {
    // A format change must fail loudly, not return an empty set that looks green.
    expect(() => readUpstreamSurface(
      reader({ [UPSTREAM_SURFACE_FILES.services]: () => '// no entries' }),
      listDshSources,
    )).toThrow(/declared no service names/)
  })

  it('refuses when the context walk finds nothing', () => {
    // An empty walk would silently drop every browser-side service from the check.
    expect(() => readUpstreamSurface(reader(), () => [])).toThrow(/walk itself is broken/)
  })
})
