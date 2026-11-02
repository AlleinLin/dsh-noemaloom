/**
 * Materialize the upstream dsh checkout this repository builds against.
 *
 * `dsh/` is git-ignored: it is a source mirror, not part of this repository, and
 * every `link:./dsh/...` override in the root manifest resolves through it. That
 * makes it a *prerequisite* rather than an artifact -- nothing installs, typechecks
 * or tests without it -- so the step that puts it there belongs to the repository
 * too, and CI and a fresh clone must run the same one.
 *
 * The ref comes from `dsh-upstream.json`, which IS tracked: the tag a release was
 * built against is a fact about this repository, and leaving it to whatever the
 * local mirror happens to hold is how a half-moved checkout reaches `main`.
 *
 * Usage:
 *   node scripts/fetch-upstream.mjs            # clone the pinned tag into dsh/
 *   node scripts/fetch-upstream.mjs --force    # replace an existing dsh/
 *   node scripts/fetch-upstream.mjs --check    # verify an existing dsh/ matches the pin
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const TARGET = join(REPO_ROOT, 'dsh')
const MANIFEST = join(REPO_ROOT, 'dsh-upstream.json')

/** Mirrors tried in order when the direct clone fails; a sandboxed network commonly allows only these. */
const MIRRORS = ['https://gh-proxy.com/__URL__']

const pin = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const force = args.includes('--force')

/** The version the checkout declares, or undefined when it is not a checkout. */
function checkoutVersion() {
  const manifest = join(TARGET, 'package.json')
  if (!existsSync(manifest)) return undefined
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).version
  } catch {
    return undefined
  }
}

/** The tag the checkout is on, or undefined when it is not a git checkout. */
function checkoutTag() {
  if (!existsSync(join(TARGET, '.git'))) return undefined
  try {
    return execFileSync('git', ['-C', TARGET, 'describe', '--tags', '--exact-match'], { encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
}

if (checkOnly) {
  const version = checkoutVersion()
  const tag = checkoutTag()
  if (version === undefined) {
    console.error(`dsh/ is missing; run 'node scripts/fetch-upstream.mjs'`)
    process.exit(1)
  }
  if (version !== pin.version || tag !== pin.tag) {
    console.error(`dsh/ is at ${tag ?? 'an untagged checkout'} (${version}); dsh-upstream.json pins ${pin.tag} (${pin.version})`)
    process.exit(1)
  }
  console.log(`dsh/ is ${pin.tag} (${pin.version})`)
  process.exit(0)
}

if (versionOk() && !force) {
  console.log(`dsh/ already holds ${pin.tag}; leaving it alone (--force to replace)`)
  process.exit(0)
}

function versionOk() {
  return checkoutVersion() === pin.version
}

if (force) rmSync(TARGET, { recursive: true, force: true })

/** Clone the pinned tag, trying the direct URL first and each mirror after. */
function clone(remote) {
  execFileSync('git', [
    'clone', '--depth', '1', '--branch', pin.tag, '--single-branch', remote, TARGET,
  ], { stdio: 'inherit' })
}

const urls = [pin.repository, ...MIRRORS.map(mirror => mirror.replace('__URL__', pin.repository))]
let cloned = false
for (const url of urls) {
  if (cloned) break
  console.log(`fetching ${pin.tag} from ${url}`)
  try {
    clone(url)
    cloned = true
  } catch (error) {
    console.warn(`  failed: ${String(error).split('\n')[0]}`)
    rmSync(TARGET, { recursive: true, force: true })
  }
}
if (!cloned) {
  console.error('could not fetch ' + pin.tag + ' from any of:')
  for (const url of urls) console.error('  ' + url)
  process.exit(1)
}

const version = checkoutVersion()
if (version !== pin.version) {
  console.error(`fetched ${pin.tag} but its package.json says ${version ?? '(missing)'}; dsh-upstream.json says ${pin.version}`)
  process.exit(1)
}
console.log(`dsh/ is now ${pin.tag} (${version})`)
