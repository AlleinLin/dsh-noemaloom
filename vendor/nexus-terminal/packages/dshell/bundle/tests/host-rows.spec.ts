/**
 * The row ids dshell's bundle patch names, measured against the rows the host
 * actually ships.
 *
 * The patch is the last layer applied, and both of its moves are references
 * into a composition dshell does not own: `disabled: true` on the two stock
 * rows dshell must own outright (the filesystem provider, whose service name
 * admits one provider, and the dev-only HMR row) and rows of its own. If
 * upstream renames or drops either, dshell's layer becomes a no-op — and since
 * 0.1.6 starts best-effort, a no-op is a line in a log rather than a failed
 * boot. This spec makes it a red test instead.
 *
 * The ids come from the checkout in `dsh/`, not from a list written here, so
 * the spec keeps watching the real thing. The composition it reads is the one
 * the `web` profile resolves: `@deepseek-ai/dsh-base`, then
 * `@deepseek-ai/dsh-web-app`, then dshell's own patch — the order the two
 * bundle patches are applied in, and the reason an id can be introduced by
 * either of them.
 *
 * dsh's patch files carry `!!js` tags, which the YAML default schema rejects;
 * the loader extends it with a scalar handler for that tag. Its values are
 * never read here, only the row ids beside them.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const DSH_ROOT = join(REPO_ROOT, 'dsh')
const OUR_PATCH = join(REPO_ROOT, 'packages/dshell/bundle/cordis.patch.yml')

/** The bundles the `web` profile composes, in application order. */
const WEB_PROFILE_BUNDLES = ['base', 'web-app'] as const

/** One entry of a bundle patch: an insert block, or an override of one row. */
interface PatchEntry {
  readonly id?: string
  readonly name?: string
  readonly insert?: readonly PatchEntry[]
}

/** The shape of `js-yaml` we use, resolved from dsh's own dependency graph. */
interface YamlModule {
  readonly DEFAULT_SCHEMA: { extend: (types: readonly unknown[]) => unknown }
  readonly Type: new (tag: string, options: { kind: string; construct: (data: unknown) => unknown }) => unknown
  load: (text: string, options: { schema: unknown }) => unknown
}

const yaml = createRequire(join(DSH_ROOT, 'package.json'))('js-yaml') as YamlModule
const JS_TAG_SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: data => data ?? null }),
])

/** Parse a patch file into its entries, `!!js` values left as raw text. */
function readPatch(path: string): readonly PatchEntry[] {
  const parsed: unknown = yaml.load(readFileSync(path, 'utf8'), { schema: JS_TAG_SCHEMA })
  if (!Array.isArray(parsed)) throw new Error(`${path}: a bundle patch is a list of entries`)
  return parsed as readonly PatchEntry[]
}

function findPatch(...segments: readonly string[]): string {
  return join(DSH_ROOT, 'packages', 'bundle', ...segments)
}

/** The bundle patches the `web` profile applies, in order. */
const hostPatches: readonly (readonly PatchEntry[])[] = WEB_PROFILE_BUNDLES.flatMap(bundle => {
  const manifest = JSON.parse(readFileSync(findPatch(bundle, 'package.json'), 'utf8')) as {
    dsh?: { bundle?: { patch?: string | readonly string[] } }
  }
  const declared = manifest.dsh?.bundle?.patch
  const files = typeof declared === 'string' ? [declared] : declared ?? []
  return files.map(file => readPatch(join(DSH_ROOT, 'packages', 'bundle', bundle, file)))
})

/** Rows the host introduces, by id. */
const hostInserted = new Set<string>()
/** Rows the host patches in place, by id — a reference, not an introduction. */
const hostOverridden = new Set<string>()
for (const patch of hostPatches) {
  for (const entry of patch) {
    for (const row of entry.insert ?? []) if (row.id !== undefined) hostInserted.add(row.id)
    if (entry.id !== undefined) hostOverridden.add(entry.id)
  }
}

const ourPatch = readPatch(OUR_PATCH)
const ourInserts = ourPatch.flatMap(entry => entry.insert ?? [])
const ourTargets = ourPatch.flatMap(entry => entry.id === undefined ? [] : [entry])

describe('the host row inventory', () => {
  it('is read from a composition that still has the shape we assume', () => {
    // The two bundle packages are named by the profile table, and each declares
    // the patch file this spec parses. A move to a different file, or a profile
    // that stopped composing these two, would leave the assertions below
    // watching nothing at all.
    const profileSource = readFileSync(join(DSH_ROOT, 'packages/boot/app-boot/src/profile.ts'), 'utf8')
    expect(profileSource).toContain("bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']")

    for (const [bundle, name] of [['base', '@deepseek-ai/dsh-base'], ['web-app', '@deepseek-ai/dsh-web-app']]) {
      const manifest = JSON.parse(readFileSync(findPatch(bundle, 'package.json'), 'utf8')) as {
        name?: string
        dsh?: { bundle?: { patch?: string | readonly string[] } }
      }
      expect(manifest.name).toBe(name)
      // rc.2 lets a bundle declare one patch file or an ordered list; the web
      // app now ships its presets as extra files beside `cordis.patch.yml`.
      const declared = manifest.dsh?.bundle?.patch
      const files = typeof declared === 'string' ? [declared] : declared
      expect(files?.[0]).toBe('./cordis.patch.yml')
    }
  })

  it('introduces rows, and every row it overrides is one of them', () => {
    // If this fails, the inventory below is missing rows the host really has
    // (an override names a row no insert declared), which would make the
    // existence check below unreliable rather than merely strict.
    expect(hostInserted.size).toBeGreaterThan(100)
    expect([...hostOverridden].filter(id => !hostInserted.has(id))).toEqual([])
  })
})

describe('dshell\'s bundle patch', () => {
  it('targets only rows that exist', () => {
    // The two `disabled: true` rows. A rename upstream — `fs-sandbox`
    // becoming something else, say — leaves dshell's row in place and the
    // stock backend back on screen, with one warning at boot.
    const missing = ourTargets
      .map(entry => entry.id!)
      .filter(id => !hostInserted.has(id) && !hostOverridden.has(id))
    expect(missing).toEqual([])
  })

  it('inserts ids the host does not already use', () => {
    // An insert id colliding with a stock row would silently shadow it: the
    // last write wins by id, so dshell would take over a row it does not own.
    const colliding = ourInserts
      .map(row => row.id!)
      .filter(id => hostInserted.has(id) || hostOverridden.has(id))
    expect(colliding).toEqual([])
  })

  it('inserts each id once', () => {
    const ids = ourInserts.map(row => row.id!)
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
  })

  it('carries the rows it is documented to carry', () => {
    // A floor, not a ceiling: this is the count the patch is described with in
    // dshell-packages.md, so a row lost to a bad edit is visible here even
    // though the existence checks above would not notice. Nine inserts: our own
    // nine packages plus the one dsh row the composition needs (`dsh-terminal`,
    // the PTY service our bridge registers a backend into). The targets are
    // exactly the two stock rows dshell overrides (see the module doc).
    expect(ourInserts.length).toBeGreaterThanOrEqual(9)
    expect(ourTargets.length).toBe(2)
  })

  it('names no dsh tool row', () => {
    // The scope rule, pinned: dshell wraps the terminal, it does not hand the
    // model dsh's own capabilities. `dsh-terminal` is a SERVICE the bridge
    // registers into; a row naming a dsh TOOL package (`dsh-tool-*`) would put
    // dsh's tools in front of every session, stock ones included, which dsh's
    // own web surface deliberately leaves to presets.
    const toolRows = ourInserts
      .map(row => String(row.name ?? ''))
      .filter(name => name.includes('dsh-tool-'))
    expect(toolRows).toEqual([])
  })
})
