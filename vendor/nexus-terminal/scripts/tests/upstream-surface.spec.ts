/**
 * The dsh contract dshell consumes, asserted against the checkout in front of it.
 *
 * dsh's public APIs are pre-stable: a release may drop or rename any name dshell
 * reaches for while dshell's own peer ranges still admit that release. The version
 * gate cannot see that -- it compares numbers, not names -- so a broken upgrade would
 * install cleanly, boot cleanly, and leave one dshell surface silently dead. This spec
 * turns that into a red test naming the missing identifier and the file that used it.
 *
 * It reads the checkout rather than a snapshot, for the same reason host-rows.spec.ts
 * reads the bundle patches: the thing worth watching is the dsh in front of us, and a
 * frozen copy would keep passing long after the real one moved.
 *
 * The browser-side names are the hard half. dsh generates a catalog for its HOST
 * services, but a client service is declared by merging cordis's `Context` interface
 * in its own package, so those are read by walking the tree. Both halves matter:
 * dshell injects host services (`terminals`, `fs`, `shell`) and client services
 * (`slots`, `uiConversation`, `locale`) through the same `inject` declaration, and the
 * loader refuses a package whose declared service no plugin provides.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DSHELL_SURFACE,
  type SurfaceClaim,
  type SurfaceGap,
  missingSurface,
  readUpstreamSurface,
} from '../upstream-surface.ts'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DSH_ROOT = join(REPO_ROOT, 'dsh')

/** Read a path relative to the dsh checkout. */
function readDshFile(path: string): string {
  return readFileSync(join(DSH_ROOT, path), 'utf8')
}

/** Every non-test source file under the checkout's `packages` tree, relative to it. */
function listDshSources(): readonly string[] {
  const found: string[] = []
  const skip = new Set(['node_modules', 'lib', 'dist'])
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue
      const path = join(dir, name)
      const entry = statSync(path)
      if (entry.isDirectory()) walk(path)
      else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
        found.push(relative(DSH_ROOT, path).replaceAll('\\', '/'))
      }
    }
  }
  walk(join(DSH_ROOT, 'packages'))
  return found
}

/** The checkout's declared surface, read once. */
const declared = readUpstreamSurface(readDshFile, listDshSources)

/** Render one gap the way the failure message should read. */
function describeGap(gap: SurfaceGap): string {
  return gap.kind + " '" + gap.name + "' (used at " + gap.usedAt + ')'
}

describe('the dsh surface dshell consumes', () => {
  it('is declared by the checkout in front of it', () => {
    expect(missingSurface(DSHELL_SURFACE, declared).map(describeGap)).toEqual([])
  })

  it('names more services than the host catalog alone carries', () => {
    // The browser half is read by walking `declare module` merges, not from a generated
    // file. If that walk silently stopped finding anything, every client-side claim
    // would fail loudly -- but a walk that found only host services would pass while
    // leaving `slots`, `uiConversation` and `locale` unguarded. This pins that the
    // merged half is populated at all.
    const clientOnly = ['slots', 'uiConversation', 'locale', 'sidebarRightTabs', 'inputTriggers']
    const missing = clientOnly.filter(name => !declared.services.has(name))
    expect(missing).toEqual([])
  })

  it('reads a checkout that has the catalogs it depends on', () => {
    // A checkout without these files is a gate that cannot judge. The reader throws
    // on an empty catalog, so reaching this line proves the shape was recognised.
    expect(declared.services.size).toBeGreaterThan(100)
    expect(declared.slots.size).toBeGreaterThan(50)
    expect(declared.events.size).toBeGreaterThan(20)
  })
})

describe('the claim itself', () => {
  it('names each service once', () => {
    const keys = DSHELL_SURFACE.services.map(service => service.key)
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([])
  })

  it('names each slot once', () => {
    const keys = DSHELL_SURFACE.slots.map(slot => slot.key)
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([])
  })

  it('marks dshell seats as its own rather than expecting them from dsh', () => {
    // A seat dshell provides is not a dsh service; claiming it as one would fail on
    // every checkout. Every key that is neither a known upstream name nor a dshell
    // prefix must fail the upstream check, so the partition is a decision, not a
    // default.
    const own = DSHELL_SURFACE.services.filter(service => service.own)
    expect(own.length).toBeGreaterThan(0)
    expect(own.map(service => service.key).every(key => key.startsWith('dshell') || key === 'deviceFs'))
      .toBe(true)
  })
})

describe('the comparison', () => {
  const empty = { services: new Set<string>(), slots: new Set<string>(), events: new Set<string>() }

  it('reports every name a checkout does not declare', () => {
    const gaps = missingSurface(DSHELL_SURFACE, empty)
    expect(gaps.length).toBeGreaterThan(0)
    expect(gaps.every(gap => !gap.name.startsWith('dshell') && gap.name !== 'deviceFs')).toBe(true)
  })

  it('reports nothing when the checkout declares everything', () => {
    const everything = {
      services: new Set(DSHELL_SURFACE.services.map(service => service.key)),
      slots: new Set(DSHELL_SURFACE.slots.map(slot => slot.key)),
      events: new Set(DSHELL_SURFACE.events),
    }
    expect(missingSurface(DSHELL_SURFACE, everything)).toEqual([])
  })

  it('does not insist on the seats dshell provides itself', () => {
    // Only the services dsh should provide are demanded. A checkout that carries none
    // of dshell's own seats is still a checkout dshell can be built against.
    const onlyOwn = { services: new Set<string>(), slots: new Set<string>(), events: new Set<string>() }
    const claim: SurfaceClaim = {
      services: DSHELL_SURFACE.services.filter(service => service.own),
      slots: [],
      events: [],
      routes: DSHELL_SURFACE.routes,
    }
    expect(missingSurface(claim, onlyOwn)).toEqual([])
  })
})
