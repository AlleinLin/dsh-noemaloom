#!/usr/bin/env node
/**
 * A read-only npm registry over a directory of packed tarballs, with a
 * passthrough for everything else.
 *
 * This exists to verify the thing P1 is about: that `pnpm pack` output is a
 * complete, installable plugin — the manifest rewritten (`workspace:^` to a
 * real range, no `link:`), `files` carrying every module the host half imports,
 * and `dsh.bundle.patch` present. Installing from a *directory* cannot prove
 * that (a path install skips the registry's metadata and `files` handling), and
 * the desktop shell's own plugin window cannot either, because it pins
 * `--config.registry=https://registry.npmjs.org/` in
 * `apps/desktop/src/project-manager.ts`. So: pack, serve, install for real.
 *
 * Anything this directory does not publish is proxied to the upstream registry
 * for its metadata only (tarball URLs in that metadata still point upstream),
 * so an install that also needs a third-party dependency — `ws`, `node-pty`,
 * `@xyflow/react` — resolves without mirroring npm.
 *
 * Usage:
 *   node scripts/local-registry.mjs [--port 4873] [--dir /tmp/dshell-packs]
 *
 * Then, in another shell:
 *   pnpm pack --pack-destination /tmp/dshell-packs   (per package)
 *   pnpm add @nexus-aethra/dshell-bundle \
 *     --config.registry=http://127.0.0.1:4873 --save-exact
 *
 * Only the metadata and tarball endpoints pnpm's installer actually calls are
 * implemented; publishing, dist-tags and auth are out of scope on purpose.
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

/** Parse `--flag value` pairs; both flags are optional. */
function options(argv) {
  const parsed = { port: 4873, dir: '/tmp/dshell-packs' }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`local-registry: ${flag} needs a value`)
    if (flag === '--port') parsed.port = Number(value)
    else if (flag === '--dir') parsed.dir = value
    else throw new Error(`local-registry: unknown flag ${flag}`)
  }
  return parsed
}

/** Read one file out of a tarball without unpacking it. */
function readFromTarball(tarball, member) {
  return execFileSync('tar', ['xzOf', tarball, member], { maxBuffer: 64 * 1024 * 1024 })
}

/** Build the registry metadata document for one packed tarball. */
function describe(tarball, tarballName) {
  const manifest = JSON.parse(readFromTarball(tarball, 'package/package.json').toString('utf8'))
  const bytes = readFileSync(tarball)
  return {
    name: manifest.name,
    version: manifest.version,
    manifest,
    tarballName,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  }
}

const { port, dir } = options(process.argv.slice(2))
const root = resolve(dir)
/** name -> version -> record, plus the tarball served for each record. */
const packages = new Map()
for (const entry of readdirSync(root)) {
  if (!entry.endsWith('.tgz')) continue
  const tarball = join(root, entry)
  const record = describe(tarball, entry)
  let versions = packages.get(record.name)
  if (versions === undefined) {
    versions = new Map()
    packages.set(record.name, versions)
  }
  versions.set(record.version, record)
}

/** One package's metadata, in the shape the installer reads. */
function metadata(name) {
  const versions = packages.get(name)
  if (versions === undefined) return undefined
  const latest = [...versions.keys()].sort().at(-1)
  const origin = `http://127.0.0.1:${String(port)}`
  return {
    name,
    'dist-tags': { latest },
    versions: Object.fromEntries([...versions].map(([version, record]) => [version, {
      ...record.manifest,
      version,
      dist: {
        tarball: `${origin}/${name}/-/${record.tarballName}`,
        integrity: record.integrity,
        shasum: record.shasum,
      },
    }])),
  }
}

/** Decode a request path into a package name and, optionally, a tarball file. */
function route(pathname) {
  const decoded = decodeURIComponent(pathname.replace(/^\//u, ''))
  const marker = '/-/'
  const split = decoded.indexOf(marker)
  // `/@scope/name/-/file.tgz` and `/<name>/-/file.tgz` share this shape; the
  // tarball half is always the last segment after the marker.
  if (split === -1) return { name: decoded }
  const name = decoded.slice(0, split)
  return { name, file: decoded.slice(split + marker.length) }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${String(port)}`)
  const { name, file } = route(url.pathname)
  if (file !== undefined) {
    const record = packages.get(name)?.get(resolveVersion(name, file))
    if (record === undefined) {
      response.writeHead(404).end('not found')
      return
    }
    const bytes = readFileSync(join(root, record.tarballName))
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.byteLength })
    response.end(bytes)
    return
  }
  const document = metadata(name)
  if (document === undefined) {
    void proxy(url.pathname, response)
    return
  }
  const body = JSON.stringify(document)
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
})

/** Forward one unknown metadata request upstream; tarballs are fetched directly. */
async function proxy(pathname, response) {
  try {
    const upstream = await fetch(`https://registry.npmjs.org${pathname}`, {
      headers: { accept: 'application/json' },
    })
    const body = Buffer.from(await upstream.arrayBuffer())
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'content-length': body.byteLength,
    })
    response.end(body)
  } catch (error) {
    response.writeHead(502, { 'content-type': 'text/plain' })
    response.end(`upstream unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Find the version whose packed filename is the one being requested. */
function resolveVersion(name, file) {
  for (const [version, record] of packages.get(name) ?? []) {
    if (record.tarballName === file) return version
  }
  return ''
}

server.listen(port, '127.0.0.1', () => {
  const total = [...packages.values()].reduce((count, versions) => count + versions.size, 0)
  console.log(`local-registry: http://127.0.0.1:${String(port)} serving ${String(total)} package version(s) from ${root}`)
  for (const [name, versions] of [...packages].sort()) {
    console.log(`  ${name}@${[...versions.keys()].join(', ')}`)
  }
})
