/**
 * The built-in device registry: where device kinds from OUTSIDE this package
 * plug in, and the contracts they are written against.
 *
 * dshell-ssh owns the device MODEL — stored rows, bindings, routing, the seams
 * the shell and the agent consume — but not every device KIND, and it must not
 * learn one: a kind with its own transport and no credential registers a
 * {@link DshellDeviceProvider} here, and every seam that used to branch on a
 * kind asks the registry instead — for its rows, for its doors, and for what
 * its kind can and cannot do (see {@link DshellDeviceProvider.helper}). A
 * composition that omits the provider's package leaves this registry empty and
 * this package exactly as it was before providers existed.
 *
 * The contracts live in THIS module rather than dshell-std because they speak
 * in node streams (`DeviceCommand`, `DeviceShell`), and std must stay
 * browser-compilable. A provider imports them as types from
 * `@nexus-aethra/dshell-ssh` — type-only, so the dependency runs one way at
 * runtime: this package never imports a provider.
 */

import type { Duplex, Readable } from 'node:stream'
import type { DeviceConnection, DeviceView } from '@nexus-aethra/dshell-std'

// The connection shape is the registry's vocabulary too — providers build it
// outside this package — so it is re-exported here beside the contracts that
// name it.
export type { DeviceConnection } from '@nexus-aethra/dshell-std'

/** How one remote command ended. */
export interface DeviceOutcome {
  /** The remote exit status, or null when it ended on a signal. */
  readonly exitCode: number | null
  /** The signal that ended it, when it did. */
  readonly signal: string | null
  /**
   * The channel was closed without an exit status: the far side tore it down.
   *
   * Not a signal and not a cancellation — the command's fate is unknown, and
   * the only honest reading is that the connection is gone. A caller that can
   * repeat its command says so; a caller that cannot reports it as the loss it
   * is.
   */
  readonly connectionLost?: boolean
}

/** One running remote command, before its output has been read. */
export interface DeviceCommand {
  /** The command's stdin and stdout, as one duplex channel. */
  readonly stream: Duplex
  /** The command's stderr, a stream of its own. */
  readonly stderr: Readable
  /** Settles with the remote outcome; never rejects. */
  readonly done: Promise<DeviceOutcome>
  /** Ask the device to stop. Fire-and-forget; `done` reports the result. */
  terminate(signal?: string): void
}

/** What one collected command produced. */
export interface DeviceExecResult extends DeviceOutcome {
  readonly stdout: string
  readonly stderr: string
  /** Whether the stdout cap dropped bytes from the front. */
  readonly truncated: boolean
}

/** Options one command runs with. */
export interface DeviceExecOptions {
  /** Cancellation; the remote side is asked to stop. */
  readonly signal?: AbortSignal | undefined
  /** Bound on the run, after which the command is terminated. */
  readonly graceMs?: number | undefined
  /** Environment additions for the remote process. */
  readonly env?: Record<string, string | undefined> | undefined
  /** Bytes to write to the command's stdin before it is closed. */
  readonly stdin?: string | Uint8Array | undefined
  /**
   * Leave the command's stdin open for the caller to write to.
   *
   * The default closes it, which is what `ssh -T` gave a command that asked for
   * no input: the remote side sees EOF rather than a pipe nobody writes to, and a
   * program that reads stdin therefore ends instead of waiting for the grace
   * period. A caller that wants to write later says so here.
   */
  readonly openStdin?: boolean | undefined
}

/** A pty-backed remote shell, which is what a visible terminal is. */
export interface DeviceShell {
  /** The shell's stdin and stdout, as one duplex channel. */
  readonly stream: Duplex
  /** Settles with the shell's exit status; never rejects. */
  readonly done: Promise<DeviceOutcome>
  /** Resize the remote terminal. */
  setWindow(rows: number, cols: number): void
  /** End the shell. */
  close(): void
}

/**
 * The three doors every device transport opens, whatever carries the bytes.
 *
 * The ssh transport's pooled `ssh2` client and a provider's own process doors
 * both satisfy this shape structurally; the routing seams (probe, subprocess,
 * filesystem, shell plan) consume it so they never learn which transport
 * answered.
 */
export interface DeviceDoors {
  /** Run one command to completion and collect its output. */
  exec(device: DeviceConnection, command: string, options?: DeviceExecOptions): Promise<DeviceExecResult>
  /** Open one long-lived command channel. */
  open(device: DeviceConnection, command: string, options?: DeviceExecOptions): Promise<DeviceCommand>
  /** Open the pty-backed shell a visible terminal runs in. */
  shell(device: DeviceConnection, command: string, window: { rows: number; cols: number; term: string }): Promise<DeviceShell>
}

/**
 * One source of built-in devices, contributed by a package outside dshell-ssh.
 *
 * A kind with its own transport and no credential registers a provider here:
 * its rows join the device list, its ids refuse save/remove, its doors answer
 * for its connections, and it says which seams its kind cannot serve (see
 * {@link DshellDeviceProvider.helper} and {@link DshellDeviceProvider.reachable}).
 * A composition that omits the provider's package simply has none of its
 * devices.
 */
export interface DshellDeviceProvider {
  /**
   * The built-in rows this provider contributes, appended to the stored ones.
   *
   * Derived on every call — a built-in device exists only while the
   * provider reports it — and each row must carry {@link DeviceView.builtin}.
   */
  rows(): Promise<readonly DeviceView[]>
  /**
   * The connection for one provider-owned id, or undefined when it is gone.
   *
   * A vanished built-in (the distro was removed) reads as an unknown device:
   * the assignment survives, every seam refuses through the ordinary
   * unservable path, and the rows return when the provider sees it again.
   */
  connection(deviceId: string): Promise<DeviceConnection | undefined>
  /** Whether this id is the provider's own — such rows cannot be saved or removed. */
  owns(deviceId: string): boolean
  /**
   * The doors for one of this provider's connections, or undefined when it
   * does not serve this device.
   */
  doors(device: DeviceConnection): DeviceDoors | undefined
  /**
   * Whether port forwards can be opened to this provider's devices.
   *
   * False comes with {@link refusal} — the forward seams answer with the
   * provider's own words rather than a generic no.
   */
  forwards?: boolean
  /**
   * Whether this kind uses the SSH helper at all.
   *
   * The helper is a Node process this package deploys onto a device and then
   * talks to over an SSH channel; a kind that is reached another way has no
   * such process, no channel, and no need for one. Saying so here keeps the
   * deploy seam from putting a helper on a device whose kind never wanted it.
   *
   * Default: **true** — a provider that says nothing is an SSH kind, so a
   * composition that adds a provider without touching this field keeps every
   * SSH behaviour it had. A kind that never uses the helper sets this to
   * false, and the seams that would deploy or survey one refuse instead.
   */
  helper?: boolean
  /**
   * Whether this kind is reachable through the ordinary dial path.
   *
   * The dial path is this package's pooled ssh2 transport: it opens a TCP
   * connection to a host and port, authenticates with a credential, and
   * verifies the host's key against the store of trusted keys. A kind that is
   * not reached that way has no host key to trust and no credential to ask
   * for — recording a host key for it would write an entry about a host that
   * was never dialled, and asking it for a credential would ask a question it
   * has no answer to.
   *
   * Default: **true** — a provider that says nothing is an SSH kind, and the
   * dial path applies to it as it always did.
   */
  reachable?: boolean
  /**
   * The provider's own refusal for a seam it does not serve, in the active
   * locale where the provider has one.
   *
   * @param deviceId - the device the seam was asked about.
   * @returns the message, or undefined when the id is not the provider's.
   */
  refusal?(deviceId: string): string | undefined
  /**
   * The provider's own refusal for ONE seam, when it words that seam
   * differently from the others.
   *
   * The refusal above is the provider's answer about the device in general
   * (today: the port forward it declines). A kind that declines more than one
   * thing — a helper it will never carry and a forward it cannot tunnel —
   * says which is which here, so each seam gets the words that fit it rather
   * than one message reused for both.
   *
   * Optional: a provider that words every seam the same way needs only
   * {@link refusal}, and one that has no message of its own for a seam gets
   * the registry's neutral sentence — which names no kind.
   *
   * @param deviceId - the device the seam was asked about.
   * @param seam - the seam that was asked about.
   * @returns the message, or undefined when the provider has none for it.
   */
  refusalFor?(deviceId: string, seam: DshellDeviceSeam): string | undefined
  /**
   * The connections whose home directory should be probed when the host loads.
   *
   * An SSH device's helper handshake volunteers its root as a side effect of
   * connecting; a provider's devices have no handshake, so the ones that need
   * a root ask for it here — probed once, in the background, at load.
   */
  probeTargets?(): Promise<DeviceConnection[]>
}

/**
 * The seams a provider's kind can decline.
 *
 * A seam is a thing this package does to a device: opening a port forward to
 * it, putting the SSH helper onto it, dialling it over the pooled transport
 * where a host key is trusted and a credential is asked for. A kind that is
 * served another way declines some of them, and it says so in its own words
 * (see {@link DshellDeviceProvider.refusalFor}).
 */
export type DshellDeviceSeam = 'forward' | 'helper' | 'dial'

/**
 * The neutral refusal for a seam a kind declines without a message of its own.
 *
 * Deliberately says nothing about the kind: a reader is told what the seam
 * cannot do, and the provider's own wording is what says why.
 */
const SEAM_REFUSALS: Record<DshellDeviceSeam, string> = {
  forward: 'this device does not forward ports',
  helper: 'this device does not use the SSH helper',
  dial: 'this device is not reached over SSH',
}

/** The built-in devices contributed by the composition's provider packages. */
export class DshellDeviceRegistry {
  private readonly entries = new Set<DshellDeviceProvider>()

  /** Add one provider; its rows and doors answer from the next call on. */
  register(provider: DshellDeviceProvider): void {
    this.entries.add(provider)
  }

  /** Remove one provider — its rows and doors stop answering. */
  unregister(provider: DshellDeviceProvider): void {
    this.entries.delete(provider)
  }

  /** Every registered provider, registration order. */
  providers(): readonly DshellDeviceProvider[] {
    return [...this.entries]
  }

  /** Every built-in row, across providers, in registration order. */
  async rows(): Promise<readonly DeviceView[]> {
    const all: DeviceView[] = []
    for (const provider of this.entries) all.push(...await provider.rows())
    return all
  }

  /** One built-in connection, from the provider that owns its id. */
  async connection(deviceId: string): Promise<DeviceConnection | undefined> {
    for (const provider of this.entries) {
      const connection = await provider.connection(deviceId)
      if (connection !== undefined) return connection
    }
    return undefined
  }

  /** Whether any provider claims this id as its own built-in. */
  owns(deviceId: string): boolean {
    for (const provider of this.entries) {
      if (provider.owns(deviceId)) return true
    }
    return false
  }

  /**
   * The doors for one device, from the provider that serves it.
   *
   * @returns the provider's doors, or undefined when no provider claims the
   *   device — the caller falls back to this package's own ssh transport.
   */
  doorsFor(device: DeviceConnection): DeviceDoors | undefined {
    for (const provider of this.entries) {
      const doors = provider.doors(device)
      if (doors !== undefined) return doors
    }
    return undefined
  }

  /**
   * Whether port forwards may be opened to this device.
   *
   * A provider that says no names its reason (see
   * {@link DshellDeviceProvider.refusal}); a device no provider claims is an
   * ssh device, and ssh devices forward.
   *
   * The provider's own flag is read as well as its message, so a kind that
   * declares that it does not forward is refused even when it has no message
   * of its own to say why — the flag was the promise, and the message was
   * only ever the way to keep it.
   */
  forwardsAllowed(deviceId: string): boolean {
    for (const provider of this.entries) {
      if (provider.owns(deviceId) && provider.forwards === false) return false
      if (provider.refusal?.(deviceId) !== undefined) return false
    }
    return true
  }

  /**
   * Whether this device's kind uses the SSH helper.
   *
   * The answer comes from the provider that claims the id; a device no
   * provider claims is an SSH device, and an SSH device has a helper.
   *
   * @param deviceId - the device to ask about.
   * @returns false only when a provider that owns the id says its kind has no
   *   helper; true otherwise.
   */
  usesHelper(deviceId: string): boolean {
    for (const provider of this.entries) {
      if (provider.owns(deviceId)) return provider.helper ?? true
    }
    return true
  }

  /**
   * Whether this device's kind is reachable through the ordinary dial path.
   *
   * The answer comes from the provider that claims the id; a device no
   * provider claims is an SSH device, and an SSH device is dialled.
   *
   * @param deviceId - the device to ask about.
   * @returns false only when a provider that owns the id says its kind is not
   *   dialled; true otherwise.
   */
  isReachable(deviceId: string): boolean {
    for (const provider of this.entries) {
      if (provider.owns(deviceId)) return provider.reachable ?? true
    }
    return true
  }

  /**
   * One provider's own refusal for a seam it does not serve.
   *
   * @returns the message, or undefined when no provider refuses this id.
   */
  refusal(deviceId: string): string | undefined {
    for (const provider of this.entries) {
      const message = provider.refusal?.(deviceId)
      if (message !== undefined) return message
    }
    return undefined
  }

  /**
   * The words one seam refuses with, in the provider's own voice.
   *
   * The provider that owns the device is asked first, through its per-seam
   * refusal. A provider that has no message of its own for this seam gets the
   * registry's neutral sentence, which names no kind: the seam says what it
   * cannot do, and only the provider can say why.
   *
   * The general {@link refusal} is the FORWARD refusal — it is the seam
   * {@link forwardsAllowed} consults, and it was introduced for that seam — so
   * it is not reused for the others. A kind that declines more than one thing
   * words them through {@link DshellDeviceProvider.refusalFor}.
   *
   * @param deviceId - the device the seam was asked about.
   * @param seam - the seam that was asked about.
   * @returns the refusal, or undefined when the seam is served.
   */
  refusalFor(deviceId: string, seam: DshellDeviceSeam): string | undefined {
    if (!this.declines(deviceId, seam)) return undefined
    for (const provider of this.entries) {
      if (!provider.owns(deviceId)) continue
      const own = provider.refusalFor?.(deviceId, seam)
      if (own !== undefined) return own
      break
    }
    if (seam === 'forward') {
      for (const provider of this.entries) {
        const general = provider.refusal?.(deviceId)
        if (general !== undefined) return general
      }
    }
    return SEAM_REFUSALS[seam]
  }

  /**
   * Whether this kind declines one seam.
   *
   * The answer is the capability's, not a separate list: a kind that says it
   * has no helper declines the helper seam, and one that says it is not
   * dialled declines the dial seam.
   *
   * @param deviceId - the device the seam was asked about.
   * @param seam - the seam that was asked about.
   * @returns whether the seam is declined.
   */
  private declines(deviceId: string, seam: DshellDeviceSeam): boolean {
    if (seam === 'helper') return !this.usesHelper(deviceId)
    if (seam === 'dial') return !this.isReachable(deviceId)
    return !this.forwardsAllowed(deviceId)
  }

  /** Every connection the providers want probed when the host loads. */
  async probeTargets(): Promise<readonly DeviceConnection[]> {
    const all: DeviceConnection[] = []
    for (const provider of this.entries) all.push(...await provider.probeTargets?.() ?? [])
    return all
  }
}
