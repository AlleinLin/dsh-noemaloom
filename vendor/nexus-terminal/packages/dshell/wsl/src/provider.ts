/**
 * The WSL device provider: this machine's WSL2 distributions, as built-in
 * rows registered into dshell-ssh's device registry.
 *
 * A distribution is a device the MODEL didn't store: it appears with
 * detection, carries no credential (the distro is its own), cannot be edited
 * or deleted, and is served by {@link WslTransport} rather than the pooled
 * ssh2 client. All of that is exactly what `DshellDeviceProvider` states, and
 * all of it is derived — nothing here is persisted, so a distro that vanishes
 * takes its rows with it and reads as an unknown device through the ordinary
 * unservable path until then.
 */

import { execFile } from 'node:child_process'
// Type-only: DeviceConnection/DeviceView are std facts; the doors/provider
// contract is dshell-ssh's extension point (see the note in index.ts).
import type { DeviceConnection, DeviceView } from '@nexus-aethra/dshell-std'
import type { DeviceDoors, DshellDeviceProvider, DshellDeviceSeam } from '@nexus-aethra/dshell-ssh'
import {
  decodeWslOutput,
  distroOf,
  isWslDevice,
  parseWslList,
  WSL_DEVICE_PREFIX,
  WSL_EXE,
  wslTransport,
  type WslDistro,
} from './transport.js'

/** Why this provider refuses a port forward, as the forward seams say it. */
const FORWARD_REFUSAL = 'WSL 与本机共享回环，端口本来就通，无需转发'

/** Why a distribution carries no helper, as the helper seams say it. */
const HELPER_REFUSAL = 'WSL 发行版不部署 helper：它的 exec 门就是设备本身，远端没有可运行 helper 的 Node'

/** Why a distribution is not dialled, as the host-key seams say it. */
const DIAL_REFUSAL = 'WSL 发行版不走 SSH，没有握手，也就没有主机密钥可信任'

/**
 * The WSL provider. One instance per host, registered by this package's
 * `apply` and unregistered when the package unloads.
 */
export class WslDeviceProvider implements DshellDeviceProvider {
  /** Port forwards to a WSL distribution are refused (see {@link refusal}). */
  readonly forwards = false
  /**
   * A distribution carries no helper.
   *
   * The helper is an SSH-kind concept: a bundle this build deploys to a device
   * over the exec lane, which a distro has no use for — the exec lane IS the
   * device, and there is no Node on the far side to run a helper with. Saying so
   * is what stops `installHelper` from writing the bundle into the distro and
   * `surveyHelper` from recording this package's helper state for a kind that has
   * none.
   */
  readonly helper = false
  /**
   * A distribution is not reached over SSH.
   *
   * There is no handshake, so there is no host key to verify and none to trust:
   * a `known_hosts` entry for host `wsl` port 0 would describe a connection that
   * never happened. Saying so is what keeps `router.test` from reporting host-key
   * trust for a built-in row, and the host-key seams from operating on a
   * destination that was never dialled.
   */
  readonly reachable = false

  private cache: { at: number; distros: WslDistro[] } | undefined

  /**
   * The WSL2 distributions this machine could run a shell in, asked once per
   * short window. `wsl.exe` is asked only on Windows and only through its
   * management output, whose UTF-16LE encoding the decoder owns; a machine
   * without WSL answers an empty list and the built-in rows simply never
   * appear.
   */
  private async distros(): Promise<WslDistro[]> {
    if (process.platform !== 'win32') return []
    const cached = this.cache
    if (cached !== undefined && Date.now() - cached.at < 30_000) return cached.distros
    const distros = await new Promise<WslDistro[]>((resolve) => {
      execFile(WSL_EXE, ['--list', '--verbose'], { timeout: 8_000, windowsHide: true, encoding: 'buffer' }, (error, stdout) => {
        if (error !== null) { resolve([]); return }
        try {
          resolve(parseWslList(decodeWslOutput(stdout as Buffer)).filter(distro => distro.version === 2))
        } catch {
          resolve([])
        }
      })
    })
    this.cache = { at: Date.now(), distros }
    return distros
  }

  /** The built-in rows: one per detected WSL2 distribution. */
  async rows(): Promise<readonly DeviceView[]> {
    const distros = await this.distros()
    return distros.map(distro => this.view(distro))
  }

  /**
   * One distribution's connection parameters, derived rather than stored.
   *
   * A distribution that has vanished (WSL uninstalled, distro removed) reads
   * as an unknown device: the assignment survives, every seam refuses through
   * the ordinary unservable path, and the rows return when WSL answers again.
   */
  async connection(deviceId: string): Promise<DeviceConnection | undefined> {
    if (!isWslDevice(deviceId)) return undefined
    const name = distroOf(deviceId)
    const present = (await this.distros()).some(distro => distro.name === name)
    if (!present) return undefined
    return {
      id: deviceId,
      name,
      host: 'wsl',
      port: 0,
      user: '',
      remoteRoot: '~',
      auth: 'wsl',
      kind: 'wsl',
      secret: undefined,
    }
  }

  /** Whether this id names one of this provider's distributions. */
  owns(deviceId: string): boolean {
    return isWslDevice(deviceId)
  }

  /** The WSL doors, for this provider's own devices and no others. */
  doors(device: DeviceConnection): DeviceDoors | undefined {
    return device.kind === 'wsl' || isWslDevice(device.id) ? wslTransport() : undefined
  }

  /** The forward refusal, in the provider's own words. */
  refusal(deviceId: string): string | undefined {
    return isWslDevice(deviceId) ? FORWARD_REFUSAL : undefined
  }

  /**
   * The refusal for one seam, in this provider's own words.
   *
   * The helper and dial seams are SSH-kind questions a distribution cannot
   * answer, and the words are the provider's because only the provider knows
   * what its kind is. A caller that asks about a seam this kind does serve —
   * exec, open, shell — gets undefined, which is the answer that means "go
   * ahead".
   */
  refusalFor(deviceId: string, seam: DshellDeviceSeam): string | undefined {
    if (!isWslDevice(deviceId)) return undefined
    if (seam === 'forward') return FORWARD_REFUSAL
    if (seam === 'helper') return HELPER_REFUSAL
    if (seam === 'dial') return DIAL_REFUSAL
    return undefined
  }

  /**
   * Every distribution that answers right now, as connections.
   *
   * A WSL device has no helper handshake to volunteer its root — the ssh
   * package's load probes whoever says they need it, and the answers fill the
   * same cache a bind fills, so the files seam never sees the literal `~`.
   */
  async probeTargets(): Promise<DeviceConnection[]> {
    const targets: DeviceConnection[] = []
    for (const distro of await this.distros()) {
      const connection = await this.connection(WSL_DEVICE_PREFIX + distro.name)
      if (connection !== undefined) targets.push(connection)
    }
    return targets
  }

  /** The built-in view one distribution carries: no credential, no helper. */
  private view(distro: WslDistro): DeviceView {
    return {
      id: `${WSL_DEVICE_PREFIX}${distro.name}`,
      // The distro's own name, unadorned: dsh's session-row device badge caps
      // at 96px, and any prefix we add ("WSL · ") is what clips it mid-glyph.
      // The distro name is the recognizable part; the admin card is where the
      // WSL context is spelled out.
      name: distro.name,
      host: 'wsl',
      port: 0,
      user: '',
      remoteRoot: '~',
      auth: 'wsl',
      builtin: true,
      hasSecret: false,
      hasPassphrase: false,
    }
  }
}
