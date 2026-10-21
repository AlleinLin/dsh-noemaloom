/**
 * Package the dsh Electron desktop app for linux-x64.
 *
 * Upstream supports mac-arm64, mac-x64, and win-x64 only, and gates each target
 * through two literal registries inside `dsh/` — a read-only upstream checkout.
 * `scripts/linux-target-hooks.mjs` widens those two at load time, and this script
 * drives upstream's own release preparation in upstream's own order, from
 * `dsh/apps/desktop/scripts/package-target.ts`:
 *
 *   build:official → release:pack{dsh,vendor} → pack desktop-host → landlock
 *   → prepare:runtime → prepare:packages → prepare:dsh → electron-builder
 *
 * The last prepare step is `prepare:dsh` and not `prepare:seed`, because the
 * checkout is `0.1.6-alpha.1`: that release renamed rc.2's `prepare-seed.ts`, and
 * its `seed` / `seedPnpm` build paths, to `prepare-dsh.ts` and `dsh` / `dshPnpm`
 * (`dshell-roadmap.md`, Phase 10.4, recorded the rename as the reason the
 * packaging target was pinned to rc.2 at the time). The old name is not a
 * fallback — it fails with `ERR_MODULE_NOT_FOUND`, and it fails at the END of a
 * ten-minute build, after every earlier step has already succeeded.
 *
 * The steps that never resolve a target (the builds and the packing) run through
 * plain `pnpm`, exactly as upstream runs them. The four steps that do resolve one
 * — `prepare:runtime`, `prepare:packages`, `prepare:dsh`, and electron-builder
 * itself — are launched as explicit `node --import <hooks> …` processes. That
 * split matters: the hook cannot travel in `NODE_OPTIONS`, because pnpm 11
 * re-executes itself for nested scripts and a loader already registered in the
 * environment makes the re-execution fail (`Error during pnpmfile execution …
 * Cannot find module '…/.pnpmfile.mjs'`). Command-line `--import` reaches exactly
 * the process that needs the widened registry and nothing else.
 *
 * The prepare scripts also get `--import tsx`, because they need real TypeScript
 * transpilation (the desktop sources use parameter properties, which Node's
 * strip-only mode rejects). Loading tsx as a module keeps it in the same process
 * as the hook, unlike the `tsx` CLI, which forks a child that a command-line
 * `--import` does not follow.
 *
 * Upstream's release record is not written: it exists to describe an upload to a
 * Tencent COS bucket, and this build stops at a local artifact.
 *
 * Usage:
 *   node scripts/package-linux.mjs --dir            # unpacked directory (fast check)
 *   node scripts/package-linux.mjs                  # AppImage
 *   node scripts/package-linux.mjs --prepare-only   # runtime/packages/dsh only
 *   node scripts/package-linux.mjs --dir --from=builder
 *       Resume at one step, skipping earlier ones and reusing their output. The
 *       step ids are build, pack-dsh, pack-host, pack-vendor, landlock, runtime,
 *       packages, dsh, builder. Debugging aid; a full run rebuilds everything.
 *
 * Environment overrides:
 *   DSH_DESKTOP_APP_ID            reverse-DNS app id (default com.nexusaethra.dshell)
 *   DSH_DESKTOP_AUTO_UPDATE_ENV   'production' (default, fixed origin) or 'test'
 *   DSHELL_NODE_MIRROR            Node.js tarball mirror (default npmmirror)
 *   DSHELL_ELECTRON_MIRROR        Electron mirror (default npmmirror)
 *   DSHELL_ELECTRON_BINARIES_MIRROR  electron-builder binaries mirror (default npmmirror)
 *   DSHELL_SKIP_NODE_PRESEED      set to 1 to let dsh download Node from nodejs.org
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(ROOT, 'dsh')
const DESKTOP = join(REPO, 'apps', 'desktop')
const NATIVE = join(REPO, 'native', 'system')
const SCRATCH = join(ROOT, '.linux-pack')
const BOOTSTRAP = join(ROOT, 'scripts', 'linux-target-patch.mjs')
const BUILDER_CONFIG = join(ROOT, 'scripts', 'electron-builder.linux.config.mjs')
const PREPARE_RUNTIME = join(DESKTOP, 'scripts', 'prepare-runtime.ts')

const NODE_MIRROR = process.env.DSHELL_NODE_MIRROR ?? 'https://npmmirror.com/mirrors/node'
const ELECTRON_MIRROR = process.env.DSHELL_ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/'
const BINARIES_MIRROR = process.env.DSHELL_ELECTRON_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/'

/**
 * Resolve a tool's real JavaScript entry, the way Node resolves it for the
 * workspace that depends on it.
 *
 * `node_modules/.bin` entries are POSIX shell shims here, so they cannot be run
 * as `node <shim>`; going through the manifest also picks whatever version the
 * workspace actually resolved instead of a hardcoded one.
 * @param baseManifest - package.json to resolve from.
 * @param name - Package name.
 * @param bin - Bin key, when the package exposes more than one.
 * @returns Absolute path to the tool's entry module.
 */
function resolveTool(baseManifest, name, bin) {
  const require = createRequire(baseManifest)
  const manifestPath = require.resolve(`${name}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[bin]
  if (typeof relative !== 'string') throw new Error(`package-linux: ${name} exposes no ${bin} bin`)
  return resolve(dirname(manifestPath), relative)
}

const requireFromRepo = createRequire(join(REPO, 'package.json'))
const ELECTRON_BUILDER = resolveTool(join(DESKTOP, 'package.json'), 'electron-builder', 'electron-builder')
/** tsx's module entry, for `--import`; the CLI would fork and drop the hook. */
const TSX_LOADER = requireFromRepo.resolve('tsx')

/** The packaging environment, with target-independent steps left target-free. */
function baseEnvironment() {
  const environment = { ...process.env }
  // A user- or CI-supplied NODE_OPTIONS would reach pnpm's nested re-executions
  // and break them the same way our own flag did.
  delete environment.NODE_OPTIONS
  return environment
}

/** Read the Node.js version upstream pins, so the preseed cannot drift from it. */
function pinnedNodeVersion() {
  const match = /const NODE_VERSION = '([^']+)'/u.exec(readFileSync(PREPARE_RUNTIME, 'utf8'))
  if (match === null) throw new Error(`package-linux: cannot read NODE_VERSION from ${PREPARE_RUNTIME}`)
  return match[1]
}

async function fetchTo(url, path, label) {
  process.stdout.write(`package-linux: fetching ${label} from ${url}\n`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`package-linux: ${url} returned HTTP ${String(response.status)}`)
  writeFileSync(path, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 })
}

/**
 * Place the pinned Node.js tarball and its checksum file in dsh's download cache.
 *
 * `prepare-runtime.ts` fetches both from nodejs.org, which is slow or unreachable
 * from here; it skips any file already present and still verifies the checksum
 * itself, so preseeded bytes get the same scrutiny as a fresh download.
 */
async function preseedNodeRuntime() {
  if (process.env.DSHELL_SKIP_NODE_PRESEED === '1') return
  const version = pinnedNodeVersion()
  const downloads = join(DESKTOP, '.desktop-build', 'downloads')
  const archiveName = `node-v${version}-linux-x64.tar.gz`
  const archive = join(downloads, archiveName)
  const sums = join(downloads, `node-v${version}-SHASUMS256.txt`)
  mkdirSync(downloads, { recursive: true })
  if (!existsSync(sums)) await fetchTo(`${NODE_MIRROR}/v${version}/SHASUMS256.txt`, sums, `${archiveName} checksums`)
  if (existsSync(archive)) {
    process.stdout.write(`package-linux: ${archiveName} already cached\n`)
  }
  else {
    await fetchTo(`${NODE_MIRROR}/v${version}/${archiveName}`, archive, `Node.js ${version} linux-x64`)
  }
  const line = readFileSync(sums, 'utf8').split(/\r?\n/u).find(candidate => candidate.endsWith(`  ${archiveName}`))
  if (line === undefined) throw new Error(`package-linux: ${archiveName} is absent from the fetched checksum file`)
  const expected = line.split(/\s+/u)[0]
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (actual !== expected) throw new Error(`package-linux: checksum mismatch for ${archiveName} (expected ${expected}, got ${actual})`)
  process.stdout.write(`package-linux: ${archiveName} verified sha256 ${actual.slice(0, 16)}…\n`)
}

/**
 * Ask upstream for the linux-x64 registries and build paths, under the hook.
 *
 * This is the first-step assertion as well as the source of every directory this
 * script uses: if the widening did not apply, upstream throws here — named and
 * early — instead of failing somewhere inside a ten-minute build.
 * @returns {Promise<{ buildTarget: string, updateTarget: string, paths: Record<string, string> }>}
 */
function probeUpstream() {
  mkdirSync(SCRATCH, { recursive: true })
  const probe = join(SCRATCH, 'probe.mjs')
  const pathsUrl = new URL(`file://${join(DESKTOP, 'scripts', 'desktop-build-paths.mjs')}`).href
  const updateUrl = new URL(`file://${join(DESKTOP, 'scripts', 'desktop-auto-update-environment.mjs')}`).href
  writeFileSync(probe, [
    `const paths = await import(${JSON.stringify(pathsUrl)})`,
    `const update = await import(${JSON.stringify(updateUrl)})`,
    `process.stdout.write(JSON.stringify({`,
    `  buildTarget: paths.resolveDesktopBuildTarget({}, 'linux', 'x64'),`,
    `  updateTarget: update.resolveDesktopAutoUpdateTarget('linux', 'x64'),`,
    `  paths: paths.desktopTargetBuildPaths('linux-x64'),`,
    `}) + '\\n')`,
    '',
  ].join('\n'))
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', BOOTSTRAP, probe], {
      cwd: ROOT,
      env: baseEnvironment(),
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`package-linux: widening probe exited with ${String(code)} — upstream still rejects linux-x64`))
        return
      }
      const result = JSON.parse(stdout.trim())
      if (result.buildTarget !== 'linux-x64' || result.updateTarget !== 'linux-x64') {
        reject(new Error(`package-linux: widening probe returned ${stdout.trim()}`))
        return
      }
      resolvePromise(result)
    })
  })
}

/**
 * Run one child to completion, inheriting stdio.
 * @param label - Step name for the log.
 * @param command - Executable.
 * @param args - Arguments.
 * @param cwd - Working directory.
 * @param env - Environment.
 */
function step(label, command, args, cwd, env) {
  process.stdout.write(`\npackage-linux: === ${label} ===\n`)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`package-linux: ${label} exited with ${String(code ?? signal)}`))
    })
  })
}

/** `pnpm <args>` in one directory — used only for steps that resolve no target. */
function pnpmStep(label, args, cwd, env) {
  return step(label, 'pnpm', args, cwd, env)
}

/**
 * `node --import <hooks> --import tsx <script>` in the desktop app.
 *
 * Both hooks live in this one process: tsx transpiles the TypeScript, and the
 * widening hook patches the registries as their source passes through the chain.
 */
function hookedStep(label, script, env) {
  return step(label, process.execPath, ['--import', BOOTSTRAP, '--import', TSX_LOADER, script], DESKTOP, env)
}

async function main() {
  const passthrough = process.argv.slice(2)
  const directory = passthrough.includes('--dir')
  const prepareOnly = passthrough.includes('--prepare-only')
  const from = passthrough.find(argument => argument.startsWith('--from='))?.slice('--from='.length)
  const appId = process.env.DSH_DESKTOP_APP_ID ?? 'com.nexusaethra.dshell'
  const updateEnvironment = process.env.DSH_DESKTOP_AUTO_UPDATE_ENV ?? 'production'

  await preseedNodeRuntime()
  const { paths } = await probeUpstream()
  process.stdout.write([
    `package-linux: target   linux-x64 (widening verified)`,
    `package-linux: app id   ${appId}`,
    `package-linux: artifacts ${paths.artifacts}`,
    `package-linux: mirrors  node=${NODE_MIRROR}`,
    `package-linux:          electron=${ELECTRON_MIRROR}`,
    '',
  ].join('\n'))

  const buildEnv = baseEnvironment()
  const targetEnv = {
    ...buildEnv,
    DSH_DESKTOP_TARGET_PLATFORM: 'linux',
    DSH_DESKTOP_TARGET_ARCH: 'x64',
  }
  const builderEnv = {
    ...targetEnv,
    DSH_DESKTOP_APP_ID: appId,
    DSH_DESKTOP_AUTO_UPDATE_ENV: updateEnvironment,
    ELECTRON_MIRROR,
    ELECTRON_BUILDER_BINARIES_MIRROR: BINARIES_MIRROR,
    ELECTRON_BUILDER_CACHE: join(SCRATCH, 'electron-cache'),
  }

  const steps = [
    { id: 'build', run: () => pnpmStep('build:official', ['run', 'build:official'], REPO, buildEnv) },
    { id: 'pack-dsh', run: () => pnpmStep('release:pack dsh', ['run', 'release:pack', '--family', 'dsh', '--out', paths.packedDsh], REPO, buildEnv) },
    { id: 'pack-host', run: () => pnpmStep('pack desktop-host', ['--dir', 'apps/desktop-host', 'pack', '--pack-destination', paths.packedDsh], REPO, buildEnv) },
    { id: 'pack-vendor', run: () => pnpmStep('release:pack vendor', ['run', 'release:pack', '--family', 'vendor', '--out', paths.packedVendor], REPO, buildEnv) },
    {
      id: 'landlock',
      run: async () => {
        rmSync(paths.packedLandlock, { recursive: true, force: true })
        mkdirSync(paths.packedLandlock, { recursive: true })
        await pnpmStep('landlock build:ts', ['run', 'build:ts'], NATIVE, buildEnv)
        await pnpmStep('pack landlock entry', ['pack', '--pack-destination', paths.packedLandlock], join(NATIVE, 'packages', 'entry'), buildEnv)
      },
    },
    { id: 'runtime', run: () => hookedStep('prepare:runtime', join(DESKTOP, 'scripts', 'prepare-runtime.ts'), targetEnv) },
    { id: 'packages', run: () => hookedStep('prepare:packages', join(DESKTOP, 'scripts', 'prepare-package-set.ts'), targetEnv) },
    { id: 'dsh', run: () => hookedStep('prepare:dsh', join(DESKTOP, 'scripts', 'prepare-dsh.ts'), targetEnv) },
    {
      id: 'builder',
      run: () => step(
        directory ? 'electron-builder --dir' : 'electron-builder AppImage',
        process.execPath,
        [
          '--import', BOOTSTRAP,
          ELECTRON_BUILDER,
          '--config', BUILDER_CONFIG,
          '--linux', '--x64',
          '--publish', 'never',
          ...(directory ? ['--dir'] : []),
        ],
        DESKTOP,
        builderEnv,
      ),
    },
  ]

  let pending = steps
  if (prepareOnly) pending = pending.filter(entry => entry.id !== 'builder')
  if (from !== undefined) {
    const index = steps.findIndex(entry => entry.id === from)
    if (index < 0) throw new Error(`package-linux: unknown --from step ${JSON.stringify(from)}; expected ${steps.map(entry => entry.id).join(', ')}`)
    pending = pending.filter(entry => steps.indexOf(entry) >= index)
  }
  for (const entry of pending) await entry.run()

  process.stdout.write(prepareOnly
    ? '\npackage-linux: preparation finished (--prepare-only)\n'
    : `\npackage-linux: finished; artifacts in ${paths.artifacts}\n`)
}

await main()
