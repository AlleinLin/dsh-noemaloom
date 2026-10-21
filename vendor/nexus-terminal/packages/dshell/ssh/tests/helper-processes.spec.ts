/**
 * The device's process table, and the slot a failed start must not keep.
 *
 * The table is per connection, and every process on the device draws from it:
 * the terminal, the agent's tool calls, the metric probe. A start that failed
 * used to charge the table a slot it would never use — the entry was released
 * AFTER the error was thrown, so the throw skipped the release — and one
 * failed start per attempt filled the table until the helper refused every
 * process on that device. The refusal names a limit, never the failure that
 * caused it, so the reader is left with a number and no cause.
 *
 * The cap is set to ONE here, because a cap of sixty-four would need
 * sixty-four failures to show the same thing.
 */

import { describe, expect, it } from 'vitest'
import { RemoteProcesses, type PrepareRequest } from '../src/helper/processes.js'

/** A start request for a program that does not exist. */
function failing(): PrepareRequest {
  return {
    // A path, so the platform reports a missing file rather than a missing
    // name — and missing is the point: the child never starts.
    argv: ['/dshell-no-such-program-4f2a'],
    cwd: process.cwd(),
    stdin: 'ignore',
    stdout: { maxBytes: 1024 },
    stderr: { maxBytes: 1024 },
    graceMs: 100,
  }
}

describe('a start that could not be made', () => {
  it('gives its slot back', async () => {
    const table = new RemoteProcesses(() => process.cwd(), 1)
    const first = table.prepare(failing())
    // The failure reaches the caller as a rejection, not as an exit status:
    // "the device has no such program" is a setup fact.
    await expect(table.done(first.id)).rejects.toThrow()
    // The table's cap is one, so a second start is the proof: with the slot
    // still held this refuses, and the refusal is the whole symptom.
    const second = table.prepare(failing())
    await expect(table.done(second.id)).rejects.toThrow()
  })

  it('keeps the slot for a process that really ran', async () => {
    const table = new RemoteProcesses(() => process.cwd(), 1)
    const first = table.prepare({
      argv: [process.execPath, '-e', 'process.exit(0)'],
      cwd: process.cwd(),
      stdin: 'ignore',
      stdout: { maxBytes: 1024 },
      stderr: { maxBytes: 1024 },
      graceMs: 100,
    })
    const answer = await table.done(first.id)
    expect(answer.outcome.exitCode).toBe(0)
    // And the slot comes back once the caller has read the output, so a
    // long-lived connection is not a one-shot.
    const second = table.prepare(failing())
    await expect(table.done(second.id)).rejects.toThrow()
  })
})
