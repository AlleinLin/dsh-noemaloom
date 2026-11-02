/**
 * Write the supported dsh range into every manifest that declares one.
 *
 * A dshell package names the dsh versions it runs on through @deepseek-ai/dsh-*
 * peers, and dsh refuses to activate a plugin whose peers reject its own version.
 * The range is therefore a fact about this repository, not about any one package:
 * 213 declaration sites across 11 manifests, and every one has to say the same thing
 * or a profile activates some rows and silently disables the rest.
 *
 * Leaving that fact to hand edits is how a release ends up gated on one prerelease.
 * The range used to name exact versions, so the next dsh patch or release candidate
 * matched nothing and users waited on a dshell release that moved a string. The
 * supported window lives in dsh-upstream.json; this script writes it out, and
 * --check reports drift instead of applying it, so a manifest edited by hand fails a
 * gate rather than publishing a range nobody else agrees with.
 *
 * Usage:
 *   node scripts/sync-host-range.mjs           # write the range into every manifest
 *   node scripts/sync-host-range.mjs --check   # report manifests that disagree
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const MANIFEST = join(REPO_ROOT, 'dsh-upstream.json')
const PACKAGES = join(REPO_ROOT, 'packages/dshell')
const HOST_PREFIX = '@deepseek-ai/dsh-'

/** The dependency maps a host range may appear in. */
const SECTIONS = ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies']

const range = JSON.parse(readFileSync(MANIFEST, 'utf8')).support.range
if (typeof range !== 'string' || range.trim() === '') {
  console.error('dsh-upstream.json: support.range must be a non-empty string')
  process.exit(1)
}

/** Every dshell package directory that carries a manifest. */
function packageDirectories() {
  return readdirSync(PACKAGES)
    .filter((name) => {
      try {
        readFileSync(join(PACKAGES, name, 'package.json'))
        return true
      } catch {
        return false
      }
    })
    .sort()
}

/**
 * Serialize a manifest the way it is already written, so a rewrite touches only the
 * ranges and leaves line endings alone.
 *
 * These manifests are CRLF and pretty-printed with two spaces; JSON.parse and
 * JSON.stringify preserve both, so a round trip is byte-identical and cheaper than
 * editing lines.
 *
 * @param value - the parsed manifest.
 * @param source - the manifest as read from disk, for its line endings.
 * @returns the manifest serialized in the source's own formatting.
 */
function serialize(value, source) {
  const crlf = source.includes('\r\n')
  const body = JSON.stringify(value, null, 2)
  const text = crlf ? body.replace(/\n/g, '\r\n') : body
  return text + (crlf ? '\r\n' : '\n')
}

const check = process.argv.slice(2).includes('--check')
const drifted = []
let rewritten = 0

for (const name of packageDirectories()) {
  const path = join(PACKAGES, name, 'package.json')
  const before = readFileSync(path, 'utf8')
  const manifest = JSON.parse(before)
  let changed = 0
  for (const section of SECTIONS) {
    const map = manifest[section]
    if (map === undefined || map === null) continue
    for (const key of Object.keys(map)) {
      if (!key.startsWith(HOST_PREFIX)) continue
      if (map[key] === range) continue
      map[key] = range
      changed++
    }
  }
  if (changed === 0) continue
  rewritten += changed
  if (check) {
    drifted.push(name + ': ' + changed + ' host declaration(s)')
    continue
  }
  writeFileSync(path, serialize(manifest, before))
}

if (check) {
  if (drifted.length === 0) {
    console.log('all host declarations carry ' + range)
    process.exit(0)
  }
  console.error('manifests disagree with dsh-upstream.json (support.range = ' + range + '):')
  for (const line of drifted) console.error('  ' + line)
  console.error('run node scripts/sync-host-range.mjs to write them')
  process.exit(1)
}

console.log('rewrote ' + rewritten + ' host declaration(s) to ' + range)
