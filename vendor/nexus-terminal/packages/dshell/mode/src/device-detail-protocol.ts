/**
 * The wire contract of the device detail readout.
 *
 * The metrics route answers "how loaded is the machine"; this one answers "what
 * is ON it" — the processes it is running, the containers it holds, the sockets
 * it is listening on. They are the same question asked at two depths, so they
 * share the same shape: a request names a SESSION (because the session decides
 * the machine, never the other way round) and the answer names the machine
 * back.
 *
 * The three lists are snapshots, not gauges. A process list is what a person
 * running `ps` would see; a container list is what `docker ps` would show; the
 * socket list is what a port-forward would have to bind. They are reported
 * separately because each one can be missing for its own reason — a machine
 * without a container runtime, a device whose `ps` is BusyBox — and a reader
 * must be able to tell "there are none" from "we could not look".
 */

import type { DshellDeviceIdentity } from './device-metrics-protocol.js'

/** The route's exact path, behind dsh's own `/api` trust fence. */
export const DSHELL_DEVICE_DETAIL_PATH = '/api/dshell/device-detail'

/** One process on the machine. */
export interface DshellProcessInfo {
  /** The process id. */
  readonly pid: number
  /** The parent process id. */
  readonly ppid: number
  /** Share of one core, in percent, as the platform reports it. */
  readonly cpu: number
  /** Share of the machine's memory, in percent. */
  readonly memory: number
  /** The command name, without its arguments. */
  readonly command: string
  /** The owner of the process; absent when the platform did not say. */
  readonly user?: string | undefined
  /** The process state, `ps` style: `R` running, `S` sleeping, `D` waiting on IO. */
  readonly state?: string | undefined
  /** How long the process has been alive, in seconds. */
  readonly elapsedSeconds?: number | undefined
  /** The whole command line, arguments and all. */
  readonly args?: string | undefined
}

/** One container. */
export interface DshellContainerInfo {
  /** The short id the runtime prints. */
  readonly id: string
  /** The image it runs. */
  readonly image: string
  /** The name it was given. */
  readonly name: string
  /** The runtime's own status word, e.g. `Up 3 hours`. */
  readonly state: string
}

/** One listening socket. */
export interface DshellPortInfo {
  /** The transport. */
  readonly proto: 'tcp' | 'udp'
  /** The port, as the machine reports it. */
  readonly port: number
  /** The address it is bound to; `0.0.0.0` means every interface. */
  readonly address: string
  /** The name of the process holding the socket; absent when the platform would not say. */
  readonly processName?: string | undefined
  /** The pid of the process holding the socket. */
  readonly processPid?: number | undefined
}

/**
 * Why a list is missing, as a code the browser turns into a sentence.
 *
 * A code and not a sentence: the host does not know the reader's language, and
 * a sentence would have to be written twice — once on each side — to be
 * translatable at all.
 */
export type DshellDeviceNoteCode =
  /** The machine's `ps` could not answer: it is missing, or it does not speak the fields asked for. */
  | 'no-ps'
  /** Neither `docker` nor `podman` could answer: missing, or the daemon is not running. */
  | 'no-container-runtime'
  /** Neither `ss` nor `netstat` could answer. */
  | 'no-socket-tool'
  /** The machine answered, but said nothing about its processes. */
  | 'processes-unreported'
  /** The machine answered, but said nothing about its containers. */
  | 'containers-unreported'
  /** The machine answered, but said nothing about its sockets. */
  | 'ports-unreported'

/** A machine's snapshot, as the panel draws it. */
export interface DshellDeviceDetail {
  /** Which machine this describes. */
  readonly device: DshellDeviceIdentity
  /** The busiest processes, most expensive first. */
  readonly processes: readonly DshellProcessInfo[]
  /** The containers the runtime reports. */
  readonly containers: readonly DshellContainerInfo[]
  /** The sockets the machine is listening on. */
  readonly ports: readonly DshellPortInfo[]
  /**
   * What could not be read, and why.
   *
   * A missing section is said out loud rather than shown as an empty list: a
   * reader who cannot tell the two apart would read "no containers" on a
   * machine that simply has no container runtime.
   */
  readonly notes: readonly DshellDeviceNoteCode[]
  /** When the snapshot was taken, in epoch milliseconds. */
  readonly at: number
}

/** The answer, or why there is none. */
export interface DshellDeviceDetailResponse {
  readonly detail?: DshellDeviceDetail | undefined
  /**
   * Why no snapshot was produced. Distinct from a snapshot whose lists are
   * empty: this is the host saying it could not ask.
   */
  readonly error?: string | undefined
}
