/**
 * What the manifests promise the host, checked against the checkout rather
 * than against memory.
 *
 * dshell's 211 first-party pins and the 45 names they carry were the largest
 * unverified surface in the repo: nothing failed if a name was misspelled, if
 * an override went missing, or if the range stopped matching the checkout in
 * front of it. That is how the 0.1.6 move reached the desktop profile with a
 * hard error in hand — the shape was wrong in a way no test looked at.
 *
 * Four claims live here, all of them about files rather than behavior:
 *
 * - a package's dsh peers and its devDependencies name the same set with the
 *   same ranges (the dev copy is what the local build resolves, so the two
 *   drifting apart is a local-vs-published difference);
 * - every name we declare is owned by the checkout, through the root
 *   `pnpm.overrides` link whose target manifest answers to that name;
 * - every declared range satisfies the version `dsh/` is actually on, so a
 *   half-done host move fails here instead of at boot;
 * - no `@deepseek-ai/*` name is ever a `dependencies` entry. dsh 0.1.6's
 *   desktop validator rejects exactly that for the packages its runtime owns —
 *   and which those are is upstream's business, so the rule we hold is the
 *   stricter, place-independent one.
 *
 * Two more files are pinned to the host: the client bundler's `neverBundle`
 * list must be a subset of dsh's `PLATFORM_MODULES`, and the install recipe
 * must name every package in the workspace.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DSH_ROOT = join(REPO_ROOT, 'dsh')
const DSH_PACKAGE_PREFIX = '@deepseek-ai/'

/**
 * First-party packages dshell declares as DEPENDENCIES rather than peers.
 *
 * Each is a package the desktop runtime does NOT own, verified against the
 * desktop release's own `desktop-packages.json` (the core set it installs into
 * every profile — 278 `@deepseek-ai/dsh-*` entries as of 0.2.0-rc.2:
 * `dsh-terminal`, `dsh-api-session-controller`, `dsh-api-workspace-files` and
 * `dsh-client-ui-deliverables` are in it, `dsh-ssh` is not). A plugin may only
 * rely on what the runtime ships, and for these it ships nothing, so the
 * dependency is what makes an install self-sufficient:
 *
 * - `@deepseek-ai/dsh-ssh`: dshell-ssh value-imports `SshRpcPeer` and
 *   `RemoteOperationError` from `@deepseek-ai/dsh-ssh/protocol`. Leaving it a
 *   peer meant the desktop profile had no copy, the row failed to import, and —
 *   because the bundle hands `ctx.fs` to that row — the session controller, the
 *   workspace files and the deliverables tabs all stayed pending on `fs`.
 */
const RUNTIME_OMITTED: ReadonlySet<string> = new Set(['@deepseek-ai/dsh-ssh'])

interface Manifest {
  readonly name?: string
  readonly version?: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest
}

/** Every package in the dshell workspace, by directory name. */
const DSHell_PACKAGES: readonly string[] = readdirSync(join(REPO_ROOT, 'packages/dshell'))
  .filter(name => existsSync(join(REPO_ROOT, 'packages/dshell', name, 'package.json')))
  .sort()

function manifestOf(pkg: string): Manifest {
  return readJson(join(REPO_ROOT, 'packages/dshell', pkg, 'package.json'))
}

/** The `@deepseek-ai/*` names a map declares, as name→range. */
function declared(map: Readonly<Record<string, string>> | undefined): [string, string][] {
  return Object.entries(map ?? {}).filter(([name]) => name.startsWith(DSH_PACKAGE_PREFIX))
}

const OVERRIDES = (readJson(join(REPO_ROOT, 'package.json')) as Manifest & {
  pnpm?: { overrides?: Readonly<Record<string, string>> }
}).pnpm?.overrides ?? {}

/** The version of the checkout the local build and the harness run against. */
const HOST_VERSION = readJson(join(DSH_ROOT, 'package.json')).version!

/** semver as the desktop validator sees it — same package, same graph. */
const semver = createRequire(join(DSH_ROOT, 'apps/desktop/package.json'))('semver') as {
  satisfies: (version: string, range: string) => boolean
  valid: (version: string) => string | null
}

describe('the dshell manifests', () => {
  it('declare their peers the same way in devDependencies', () => {
    // The published copy is the peer list; the dev copy is what this repo's own
    // build resolves. A name added to one and not the other builds locally and
    // breaks on install.
    const drifted: string[] = []
    for (const pkg of DSHell_PACKAGES) {
      const manifest = manifestOf(pkg)
      const peers = declared(manifest.peerDependencies)
      const dev = declared(manifest.devDependencies)
      const peerMap = new Map(peers)
      const devMap = new Map(dev)
      for (const [name, range] of peerMap) {
        if (devMap.get(name) !== range) drifted.push(`${pkg}: ${name} peer=${range} dev=${devMap.get(name) ?? '(absent)'}`)
      }
      for (const name of devMap.keys()) {
        if (!peerMap.has(name)) drifted.push(`${pkg}: ${name} is a devDependency but not a peer`)
      }
    }
    expect(drifted).toEqual([])
  })

  it('name only packages the checkout owns', () => {
    // The override is the workspace's map from a first-party name to the
    // checkout path, and its target manifest is what proves the name is real:
    // a typo resolves to nothing, a moved package resolves to the wrong one.
    // The check covers every override, not only the `@deepseek-ai/*` ones:
    // `node-pty`'s store-path override is the one that broke when pnpm
    // 11.7.0 started appending `patch_hash=` to its directory name.
    const problems: string[] = []
    for (const [name, target] of Object.entries(OVERRIDES)) {
      if (!target.startsWith('link:')) { problems.push(`${name} override is not a link (${target})`); continue }
      const dir = join(REPO_ROOT, target.slice('link:'.length))
      if (!existsSync(join(dir, 'package.json'))) { problems.push(`${name} links to a missing package (${dir})`); continue }
      const owner = readJson(join(dir, 'package.json')).name
      if (owner !== name) problems.push(`${name} links to a package named ${String(owner)}`)
    }
    expect(problems).toEqual([])
  })

  it('never name a first-party package as a dependency, bar the runtime-omitted ones', () => {
    // The desktop profile fails on this for the packages its runtime owns. That
    // set belongs to upstream and is not visible from here, so the default is
    // absolute: if the package is first-party, it is a peer.
    const offenders: string[] = []
    for (const pkg of DSHell_PACKAGES) {
      const manifest = manifestOf(pkg)
      for (const [name] of declared(manifest.dependencies)) {
        if (!RUNTIME_OMITTED.has(name)) offenders.push(`${pkg}: dependencies.${name}`)
      }
      for (const [name] of declared(manifest.optionalDependencies)) offenders.push(`${pkg}: optionalDependencies.${name}`)
    }
    expect(offenders).toEqual([])
  })

  it('declares a runtime-omitted package everywhere it must be', () => {
    // An exception is only sound when it is spelled out the same way three
    // times: the dependency makes an install bring it, the peer keeps it under
    // the host-compatibility check the desktop runs, and the dev copy is what
    // this repository builds against.
    const problems: string[] = []
    for (const pkg of DSHell_PACKAGES) {
      const manifest = manifestOf(pkg)
      for (const [name, range] of declared(manifest.dependencies)) {
        if (!RUNTIME_OMITTED.has(name)) continue
        const peers = new Map(declared(manifest.peerDependencies))
        const dev = new Map(declared(manifest.devDependencies))
        if (peers.get(name) !== range) problems.push(`${pkg}: ${name} dependency=${range} peer=${peers.get(name) ?? '(absent)'}`)
        if (dev.get(name) !== range) problems.push(`${pkg}: ${name} dependency=${range} dev=${dev.get(name) ?? '(absent)'}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('carry ranges the checkout in front of them satisfies', () => {
    // This is the guard for a half-done host move: pointing `dsh/` at a new tag
    // without widening the ranges leaves a repo that builds (dev copies) and
    // installs against a host none of its peers accept.
    //
    // Only `dsh-*` names are host-versioned. `@deepseek-ai/cordis` and
    // `-schemastery` live in the same namespace but carry their own version
    // lines (`^4.0.2`, `^3.18.2`), which no host release moves.
    expect(semver.valid(HOST_VERSION)).not.toBeNull()
    const rejected: string[] = []
    for (const pkg of DSHell_PACKAGES) {
      for (const [name, range] of declared(manifestOf(pkg).peerDependencies)) {
        if (!name.startsWith('@deepseek-ai/dsh-')) continue
        if (!semver.satisfies(HOST_VERSION, range)) rejected.push(`${pkg}: ${name}@${range} does not accept ${HOST_VERSION}`)
      }
    }
    expect(rejected).toEqual([])
  })
})

describe('the client bundler', () => {
  it('lists only module-table names the host actually serves', () => {
    // `neverBundle` means "resolve this through the injected require, dsh's
    // loader owns it". A name that is not in the host's table is a module the
    // browser cannot resolve, which shows up as a page that loads no plugins.
    // The comments inside the block are prose with apostrophes in it, so they
    // come out before the quoted names are read.
    const preset = readFileSync(join(REPO_ROOT, 'tsdown.dshell.preset.ts'), 'utf8')
    const opened = preset.slice(preset.indexOf('neverBundle: ['))
    const body = opened.slice(0, opened.indexOf(']'))
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n')
    const ours = [...body.matchAll(/'([^']+)'/g)].map(match => match[1]!)

    const platform = readFileSync(join(DSH_ROOT, 'packages/client/web/src/platform.ts'), 'utf8')
    const table = platform.slice(platform.indexOf('PLATFORM_MODULES'))
    const served = new Set([...table.slice(0, table.indexOf(']')).matchAll(/'([^']+)'/g)].map(match => match[1]!))

    expect(ours.length).toBeGreaterThan(0)
    expect(served.size).toBeGreaterThan(5)
    expect(ours.filter(name => !served.has(name))).toEqual([])
  })
})

describe('the install recipe', () => {
  it('names every package in the workspace', () => {
    // A new package that the script does not install is a package that exists
    // in the repo and nowhere else — dsh resolves a patch row's name from the
    // bundle's own node_modules, so an uninstalled package is a failed import
    // at boot with nothing pointing at the script.
    const script = readFileSync(join(REPO_ROOT, 'scripts/install-into-dsh-profile.sh'), 'utf8')
    const array = script.slice(script.indexOf('PLUGINS=('))
    const listed = new Set([...array.slice(0, array.indexOf(')')).matchAll(/^\s*([a-z][a-z-]*)$/gm)].map(match => match[1]!))
    for (const match of script.matchAll(/dshell\/([a-z][a-z-]*)/g)) listed.add(match[1]!)

    expect(listed.size).toBeGreaterThan(5)
    expect([...DSHell_PACKAGES].filter(pkg => !listed.has(pkg))).toEqual([])
    expect([...listed].filter(pkg => !DSHell_PACKAGES.includes(pkg))).toEqual([])
  })
})
