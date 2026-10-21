/**
 * Widen dsh's closed packaging registries to include `linux-x64`, at load time.
 *
 * `dsh/` is an untouched upstream checkout, so the literal allowlists that gate a
 * Desktop release target — `SUPPORTED_TARGETS` in `desktop-build-paths.mjs` and
 * `UPDATE_TARGETS` in `desktop-auto-update-environment.mjs` — cannot be edited in
 * place. They are the only two things between upstream's prepare scripts and a
 * Linux build (see `docs/dshell-roadmap.md`, Phase 10.3), and each is a plain
 * literal in a file whose path is stable, so patching the loaded source leaves
 * every other line of upstream authoritative.
 *
 * The third patch is not about the target at all. `prepare-dsh.ts` runs
 * `tests/fixtures/runtime-payload-smoke.mjs` against the materialized runtime,
 * and that fixture asserts five payloads: `koffi`, `sharp`, `turndown` and
 * `node-pty` — each declared by a first-party package — and `fs-ext`, which
 * **nothing declares**. Upstream still expects it: `project-manager.ts` lists it
 * in `allowBuilds` beside the other two native modules, and
 * `runtime-file-policy.ts` carries rules for its compiler output by name. So the
 * declaration is supplied here, into the runtime project's dependencies, rather
 * than the check being skipped — `fs-ext@2.1.1` builds and satisfies it on the
 * bundled Node 24.17.0. Delete this patch when upstream declares it itself.
 *
 * Applied with `node --import scripts/linux-target-patch.mjs <script>` on the
 * individual leaf processes (`scripts/package-linux.mjs`). Deliberately *not*
 * via `NODE_OPTIONS`: pnpm 11 re-executes itself for nested `pnpm run` calls, and
 * a pre-registered loader in the environment makes those re-executions fail with
 * `Error during pnpmfile execution … Cannot find module '…/.pnpmfile.mjs'`. The
 * widened registries are announced on stderr, so a build log states what happened.
 */

import { fileURLToPath } from 'node:url'

/**
 * The version supplied for upstream's undeclared `fs-ext` dependency.
 *
 * Pinned exactly, because the desktop project manifests reject anything that is
 * not an exact registry version. It is the version the payload check was
 * verified against; upstream pins none of its own.
 */
const FS_EXT_VERSION = '2.1.1'

/** @type {{ label: string, file: string, widen: (source: string) => string | undefined }[]} */
const PATCHES = [
  {
    label: 'desktop-build-paths.mjs SUPPORTED_TARGETS',
    file: 'apps/desktop/scripts/desktop-build-paths.mjs',
    widen: source => source.replace(
      /const SUPPORTED_TARGETS = new Set\(\[([^\]]*)\]\)/u,
      (_match, items) => `const SUPPORTED_TARGETS = new Set([${items}, 'linux-x64'])`,
    ),
  },
  {
    label: 'desktop-auto-update-environment.mjs UPDATE_TARGETS',
    file: 'apps/desktop/scripts/desktop-auto-update-environment.mjs',
    widen: source => source.replace(
      /const UPDATE_TARGETS = new Set\(\[([^\]]*)\]\)/u,
      (_match, items) => `const UPDATE_TARGETS = new Set([${items}, 'linux-x64'])`,
    ),
  },
  {
    label: 'project-manager.ts runtime payload (fs-ext)',
    file: 'apps/desktop/src/project-manager.ts',
    widen: source => source.replace(
      /dependencies: desktopCorePackageOverrides\(packageSet\),/u,
      `dependencies: { ...desktopCorePackageOverrides(packageSet), 'fs-ext': '${FS_EXT_VERSION}' },`,
    ),
  },
]

/**
 * Return the patched source for one module, or undefined when it is not ours.
 * @param url - Module URL Node is loading.
 * @param source - Source text the earlier hooks produced.
 * @returns Patched source, or undefined when this module needs no widening.
 */
function widenFor(url, source) {
  let pathname
  try {
    pathname = fileURLToPath(url)
  }
  catch {
    return undefined
  }
  for (const patch of PATCHES) {
    if (!pathname.endsWith(patch.file)) continue
    const widened = patch.widen(source)
    if (widened === source) {
      process.stderr.write(`[linux-target] ${patch.label}: no match, left as upstream\n`)
      return undefined
    }
    process.stderr.write(`[linux-target] ${patch.label}: widened for linux-x64\n`)
    return widened
  }
  return undefined
}

/**
 * Node module hook: widen a target registry as its source passes through.
 * @param url - Module URL.
 * @param context - Load context.
 * @param nextLoad - Next hook in the chain.
 * @returns The load result, with patched source when applicable.
 */
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  const source = result.source
  if (typeof source !== 'string' && !(source instanceof Uint8Array)) return result
  const text = typeof source === 'string' ? source : new TextDecoder().decode(source)
  const widened = widenFor(url, text)
  if (widened === undefined) return result
  return { ...result, source: widened }
}
