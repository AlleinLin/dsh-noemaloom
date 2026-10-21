/**
 * Deploy the helper this build ships onto one device, content-addressed by
 * digest.
 *
 * One `ssh` invocation, one shell script. The script does four things:
 *
 *   1. `mkdir -p ~/.dshell/helper`
 *   2. decode the bundle, which the harness ships base64 on stdin, into
 *      `~/.dshell/helper/helper-<hash>.mjs`
 *   3. `chmod 0700` that path (so another user on the device cannot read or
 *      replace it; the directory is `0700` too, by the same chmod)
 *   4. emit the helper's hash so the harness can compare it with the artifact
 *      it just shipped, catching a transfer that ended up with the wrong
 *      bytes before any session is bound.
 *
 * Why a hash because it is the same check the next connection's `hello` reply
 * carries, and a deployment that does not match is one the client will refuse
 * on first use anyway — better to find out here, where the action is named.
 *
 * Why a script and not a `tar | ssh | tar` pipe: the helper bundle is one
 * file. `base64 -d` is on every POSIX system the transport reaches, and base64
 * over the command's own stdin is the same channel the route uses for
 * interactive sessions, so no new plumbing is needed.
 *
 * The whole payload is base64 of the bundle, written to stdin. The destination
 * hash and path are interpolated into the script from fields that are not
 * user-supplied at request time (the digest is from the local artifact, the
 * path is derived from `$HOME`), so a shell-injection through them is not a
 * threat model: still, both are formatted as `'…'`-quoted literals to keep the
 * script readable.
 */
import { readFileSync } from 'node:fs'
import type { DeviceConnection } from '../devices.js'
import { quote } from '../shell-quote.js'
import { deviceTransport } from '../transport/transport.js'

/** Device subdirectory the helper is installed under, relative to home. */
const HELPER_DIRECTORY = '.dshell/helper'

/**
 * Read the bundle from disk and base64-encode it for the wire.
 * @param artifactPath - absolute path of the helper bundle on this machine.
 * @returns the base64-encoded body, sized so the caller can pass it through
 *   ssh's stdin without breaking the channel's own framing.
 */
export function encodeHelperBody(artifactPath: string): string {
  return readFileSync(artifactPath).toString('base64')
}

/**
 * The expected on-device hash, from the bundle the host just sent.
 * @param expectedHash - digest of the artifact.
 * @returns the absolute path the device's helper lives at, given `$HOME`.
 *
 * The extension is `.mjs`, never `.js`: the bundle is ESM, and the helper lands
 * in the device user's home, whose nearest `package.json` we cannot control. A
 * `.js` file inherits that scope — under `"type": "commonjs"` node refuses it
 * with `Failed to load the ES module`, and on a node old enough to lack module
 * detection it refuses it with no scope at all. `.mjs` is unambiguous on every
 * node version and ignores the surrounding package entirely.
 */
export function helperPathFor(home: string, expectedHash: string): string {
  const trimmed = home.replace(/\/+$/u, '')
  return `${trimmed}/${HELPER_DIRECTORY}/helper-${expectedHash}.mjs`
}

/**
 * Run the deployment for one device.
 *
 * One command. Returns the digest the device just wrote, which the caller
 * compares against `artifact.hash`; a mismatch is a failed deployment even when
 * the exit was 0 (corrupted transport, partial write, the device's `base64` is
 * older and lacks `-d`, etc.).
 *
 * @param device - device to deploy to.
 * @param artifactPath - absolute path of the local helper bundle.
 * @param artifactHash - digest of the bundle; the device's path is named after it.
 * @param installHome - device's home directory, from the probe; the helper's
 *   parent directory is created under it.
 * @returns the digest the device reported, plus the verbatim message.
 */
export async function deployHelper(
  device: DeviceConnection,
  artifactPath: string,
  artifactHash: string,
  installHome: string,
): Promise<{ onDevice: string; path: string; message: string }> {
  const path = helperPathFor(installHome, artifactHash)
  // The directory is created with mode 0700 in the same chmod so another user
  // on the device cannot read or replace the bundle. The script echoes the
  // bundle's last char of the digest back, which the harness verifies.
  const script = [
    'set -eu',
    `d='${installHome.replace(/'/gu, "'\\''")}'/.dshell/helper`,
    'mkdir -m 0700 -p -- "$d" || { echo mkdir-failed >&2; exit 20; }',
    't="$d/.tmp"',
    'base64 -d > "$t" || { echo base64-decode-failed >&2; exit 21; }',
    `chmod 0700 -- "$t" || { echo chmod-tmp-failed >&2; exit 22; }`,
    'sha256sum -- "$t" | awk \'{print $1}\' > "$t.sha" || { echo sha-write-failed >&2; exit 23; }',
    `mv -f -- "$t" "${path.replace(/'/gu, "'\\''")}" || { echo mv-failed >&2; exit 24; }`,
    `sha256sum -- "${path.replace(/'/gu, "'\\''")}" | awk '{print $1}'`,
  ].join('\n')
  const result = await deviceTransport().exec(
    device,
    `sh -c ${quote(script)}`,
    { stdin: encodeHelperBody(artifactPath), graceMs: 60_000 },
  )
  const stdout = result.stdout.trim()
  const stderr = result.stderr.trim()
  if (result.exitCode !== 0) {
    throw new Error(stderr === '' ? `helper deploy exited ${String(result.exitCode ?? 'on a signal')}` : stderr)
  }
  // The last line of stdout is the digest; the row before it is the device's
  // own sha256 of the staging file (a copy we wrote for forensics, but the
  // harness only reads the last line). A regex-parsing here is safe because
  // both lines are 64 lowercase hex characters.
  const onDevice = stdout.split('\n').pop()?.trim() ?? ''
  return {
    onDevice,
    path,
    message: onDevice === artifactHash
      ? `已部署到 ${path}`
      : `部署后校验不一致：本地 ${artifactHash}，设备 ${onDevice || '未知'}`,
  }
}