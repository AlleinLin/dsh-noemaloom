/**
 * The argv that LEAVES for a device, and the shell that builds it.
 *
 * The command is the caller's, the device's shell runs it, and the argv that
 * carries it is built by the HOST's shell — which is a different program. On a
 * Windows host that is `powershell.exe` and a pile of its own flags, and a
 * device cannot execute any of it: the path names a file on the host's disk,
 * and the flags are the host shell's. Every device-side command then died on
 * the device with an ENOENT that named a directory the device had never heard
 * of, which is a far worse report than the one the reader gets here.
 *
 * So the seam replaces the argv for a device session, and the executor's own
 * argv-level seam — the one a confining subclass wraps — is where it does it.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellExecSpec } from '@deepseek-ai/dsh-shell'
import { installShellRouting, type SshRouter } from '../src/router.js'
import type { DshellSshTranslate } from '../src/host-locales.js'

/** A translator that answers with the key; the refusals are not what is under test. */
const translate = ((key: string): string => key) as DshellSshTranslate

/** The argv a Windows host's executor builds: its own shell, and the command. */
const HOST_PWSH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** The session the call belongs to; the seam reads it from the agent scope. */
const DEVICE_SESSION = 'session-on-device'
const LOCAL_SESSION = 'session-on-this-machine'

/**
 * An executor shaped like the host's: `resolve` fills a spec, and `argv`
 * turns the spec into the host shell's own invocation.
 */
class FakeExecutor {
  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 30_000,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1024,
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  argv(spec: ShellExecSpec): string[] {
    return [HOST_PWSH, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', spec.command]
  }
}

/** A context with one shell service and one ambient session. */
function contextFor(shell: FakeExecutor, sessionId: string | undefined): Context {
  return {
    get: (key: string) => key === 'shell' ? shell : undefined,
    agents: { currentInitiator: () => sessionId === undefined ? undefined : { id: sessionId } },
    logger: { info: () => {} },
  } as unknown as Context
}

/** A router that knows one session's device, and nothing else. */
function routerFor(sessionId: string): SshRouter {
  return {
    targetForSession: (id: string) => id === sessionId
      ? { device: { name: 'A' }, remoteRoot: '/srv', mount: '/local/stand-in' }
      : undefined,
    assignmentForSession: () => undefined,
  } as unknown as SshRouter
}

/** One resolved spec, as the executor would hand it to its own argv. */
function spec(command: string): ShellExecSpec {
  return {
    command,
    workdir: process.cwd(),
    timeoutMs: 30_000,
    onExpiry: 'kill',
    stdoutMaxBytes: 1024,
    sandboxPolicy: undefined,
  }
}

describe('a command bound for a device', () => {
  it('is run by the device own shell, not the host one', () => {
    const shell = new FakeExecutor()
    const dispose = installShellRouting(contextFor(shell, DEVICE_SESSION), routerFor(DEVICE_SESSION), translate)
    try {
      expect(shell.argv(spec('bash -c \'echo hi\''))).toEqual(['bash', '-c', 'bash -c \'echo hi\''])
    } finally {
      dispose()
    }
  })

  it('leaves a command for this machine alone', () => {
    const shell = new FakeExecutor()
    const dispose = installShellRouting(contextFor(shell, LOCAL_SESSION), routerFor(DEVICE_SESSION), translate)
    try {
      expect(shell.argv(spec('echo hi'))).toEqual([HOST_PWSH, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'echo hi'])
    } finally {
      dispose()
    }
  })

  it('gives the host its own argv back when the seam is removed', () => {
    const shell = new FakeExecutor()
    const dispose = installShellRouting(contextFor(shell, DEVICE_SESSION), routerFor(DEVICE_SESSION), translate)
    dispose()
    expect(shell.argv(spec('echo hi'))).toEqual([HOST_PWSH, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'echo hi'])
  })
})
