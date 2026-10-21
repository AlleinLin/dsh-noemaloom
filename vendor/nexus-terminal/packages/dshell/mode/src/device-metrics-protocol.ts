/**
 * The wire contract of the device resource readout.
 *
 * The status chip answers "what is this session doing"; this answers "what is
 * the machine it is doing it on". Both are facts a reader looks up in the same
 * glance at the session header, and both are session-scoped — because the
 * machine is not this process. A session bound to an SSH device runs there, so
 * its CPU and memory are the device's, and reporting this machine's instead
 * would be a confident lie. That is why the request names a session and the
 * answer names a machine back.
 *
 * Usage is reported as a fraction of ALL cores, not as a percentage of one:
 * a 16-core machine at 100% is saturated and a phone at 100% is not, and a
 * reader comparing two devices needs the same denominator on both. The
 * one-minute load average rides along because it is the number a person who
 * lives in a shell actually looks at, and it is the only figure that survives
 * a platform with no `/proc` to read.
 */

/** The route's exact path, behind dsh's own `/api` trust fence. */
export const DSHELL_DEVICE_METRICS_PATH = '/api/dshell/device-metrics'

/** Which machine a reading describes. */
export interface DshellDeviceIdentity {
  /** `local` for this machine, `device` for one reached over SSH. */
  readonly kind: 'local' | 'device'
  /** The name the reader gave the device; absent for this machine. */
  readonly name?: string | undefined
  /** `user@host:port` for a device; absent for this machine. */
  readonly endpoint?: string | undefined
}

/** Processor load, and the size it is a fraction of. */
export interface DshellCpuReading {
  /**
   * Busy share of all cores over the interval since the previous reading, in
   * `[0, 1]`. Undefined where the platform reports no cumulative counters —
   * the row then shows the core count alone rather than a fabricated 0%.
   */
  readonly used: number | undefined
  /** Logical cores the machine has. */
  readonly cores: number
  /** One-minute load average, where the platform publishes one. */
  readonly load1: number | undefined
}

/** Physical memory, in bytes. */
export interface DshellMemoryReading {
  readonly total: number
  /** In use — total minus what the kernel reports as reclaimable. */
  readonly used: number
}

/** One machine's reading, as the chip draws it. */
export interface DshellDeviceMetrics {
  readonly device: DshellDeviceIdentity
  readonly cpu: DshellCpuReading
  readonly memory: DshellMemoryReading
  /** When the counters were read, in epoch milliseconds. */
  readonly at: number
}

/** Which session's machine to read; a GET carries it as `?session=`. */
export interface DshellDeviceMetricsRequest {
  readonly sessionId: string
}

/** The answer, or why there is none. */
export interface DshellDeviceMetricsResponse {
  readonly metrics?: DshellDeviceMetrics | undefined
  /**
   * Why no reading was produced. Distinct from an absent `metrics` on a
   * platform that simply has no counter: this is the host saying it could not
   * ask, which the row reports instead of falling back to this machine.
   */
  readonly error?: string | undefined
}
