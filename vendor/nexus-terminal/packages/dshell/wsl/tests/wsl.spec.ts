/**
 * The WSL device's pure pieces: the management output's decoding, the
 * distribution list's parsing, the argv a `wsl.exe` run is built from, and
 * the provider's registration — rows, doors, refusals — as the registry
 * reads them.
 *
 * The decoding cases come from real `wsl.exe` behavior: management output is
 * UTF-16LE with a BOM when redirected and without one in some pipes, while
 * executed Linux commands answer UTF-8. The parse cases include a localized
 * header (the columns are not always named NAME/STATE/VERSION) and both
 * spellings of the default-distribution marker.
 */
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { decodeWslOutput, distroOf, isWslDevice, parseWslList, wslExecArgs, WSL_EXE, WslTransport, type WslSpawn } from '../src/transport.js'
import { WslDeviceProvider } from '../src/provider.js'

function utf16le(text: string, bom = true): Buffer {
  const body = Buffer.from(text, 'utf16le')
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body
}

describe('decodeWslOutput', () => {
  it('decodes UTF-16LE with a BOM', () => {
    const raw = utf16le('NAME            STATE           VERSION\r\n')
    expect(decodeWslOutput(raw)).toContain('VERSION')
    expect(decodeWslOutput(raw)).not.toContain('\u0000')
  })

  it('decodes UTF-16LE without a BOM by the NUL-byte tell', () => {
    const raw = utf16le('Ubuntu-24.04', false)
    expect(decodeWslOutput(raw)).toBe('Ubuntu-24.04')
  })

  it('decodes UTF-8 output untouched', () => {
    const raw = Buffer.from('/root\n', 'utf8')
    // UTF-8 has no NUL run, so the heuristic must not read it as UTF-16LE.
    expect(decodeWslOutput(raw)).toBe('/root\n')
  })
})

describe('parseWslList', () => {
  it('parses the English columns, marker standalone', () => {
    const out = [
      'NAME            STATE           VERSION',
      '* Ubuntu-24.04    Running         2',
      '  Debian-12      Stopped         2',
      '  Legacy-20      Stopped         1',
    ].join('\r\n')
    expect(parseWslList(out)).toEqual([
      { name: 'Ubuntu-24.04', default: true, version: 2 },
      { name: 'Debian-12', default: false, version: 2 },
      { name: 'Legacy-20', default: false, version: 1 },
    ])
  })

  it('parses a localized header and glued marker', () => {
    // A zh-CN wsl.exe names the header in Chinese and may glue the marker
    // to the name; the states are localized words without spaces.
    const out = [
      '名称            状态            版本',
      '*Ubuntu-24.04    正在运行        2',
      '  Debian-12      已停止          2',
    ].join('\r\n')
    expect(parseWslList(out)).toEqual([
      { name: 'Ubuntu-24.04', default: true, version: 2 },
      { name: 'Debian-12', default: false, version: 2 },
    ])
  })

  it('skips lines it cannot read rather than inventing a device', () => {
    const out = [
      'NAME            STATE           VERSION',
      '  Ubuntu-24.04    Running         2',
      'Installing...', // transitional row: no trailing version digit
      '',
    ].join('\r\n')
    expect(parseWslList(out)).toHaveLength(1)
  })

  it('returns nothing for empty output', () => {
    expect(parseWslList('')).toEqual([])
  })
})

describe('wsl device identity', () => {
  it('builds the exec argv from the id', () => {
    const id = 'wsl:Ubuntu-24.04'
    expect(wslExecArgs('wsl:Ubuntu-24.04', 'echo hi')).toEqual(['-d', 'Ubuntu-24.04', '-e', 'bash', '-c', 'echo hi'])
    expect(distroOf('wsl:Ubuntu-24.04')).toBe('Ubuntu-24.04')
  })

  it('keeps a command with quotes and spaces as ONE argv element', () => {
    const args = wslExecArgs('wsl:Ubuntu-24.04', `bash -c 'printf "%s" x'`)
    expect(args[5]).toBe(`bash -c 'printf "%s" x'`)
  })

  it('recognizes built-in ids', () => {
    expect(isWslDevice('wsl:Ubuntu-24.04')).toBe(true)
    expect(isWslDevice('tencent')).toBe(false)
  })

  it('names the wsl.exe path', () => {
    expect(WSL_EXE).toMatch(/wsl\.exe$/u)
  })
})

describe('WslDeviceProvider', () => {
  const provider = new WslDeviceProvider()

  it('claims only the ids carrying the wsl prefix', () => {
    expect(provider.owns('wsl:Ubuntu-24.04')).toBe(true)
    expect(provider.owns('tencent')).toBe(false)
  })

  it('answers its doors for its own devices and nothing else', () => {
    const doors = provider.doors({ id: 'wsl:Ubuntu-24.04', name: 'Ubuntu-24.04', host: 'wsl', port: 0, user: '', remoteRoot: '~', auth: 'wsl', kind: 'wsl', secret: undefined })
    expect(doors).toBeInstanceOf(WslTransport)
    expect(provider.doors({ id: 'tencent', name: 'tencent', host: 'x', port: 22, user: 'u', remoteRoot: '~', auth: 'key', secret: undefined })).toBeUndefined()
  })

  it('refuses port forwards in its own words, for its own ids', () => {
    expect(provider.forwards).toBe(false)
    expect(provider.refusal('wsl:Ubuntu-24.04')).toContain('回环')
    expect(provider.refusal('tencent')).toBeUndefined()
  })

  it('rows carry the builtin mark and the distro name unadorned', async () => {
    // Detection runs only on Windows; elsewhere the rows are simply absent.
    const rows = await provider.rows()
    for (const row of rows) {
      expect(row.builtin).toBe(true)
      expect(row.id.startsWith('wsl:')).toBe(true)
      expect(row.name).not.toContain('wsl:')
    }
  })
})

describe('the exec door', () => {
  const device = { id: 'wsl:Ubuntu-24.04', name: 'Ubuntu-24.04', host: 'wsl', port: 0, user: '', remoteRoot: '~', auth: 'wsl', kind: 'wsl', secret: undefined }

  /**
   * Stand in for `wsl.exe`: a node process running `script`. The door's
   * contract is a property of how its stream is wired, not of what WSL
   * prints, so the child need not be WSL at all.
   */
  function fakeSpawn(script: string): WslSpawn {
    return (_file, _args, options) => spawn(process.execPath, ['-e', script], options as SpawnOptions)
  }

  /** Capture the options one `wsl.exe` run was spawned with. */
  function recordingSpawn(): { spawn: WslSpawn; seen: { env?: Record<string, string | undefined> } } {
    const seen: { env?: Record<string, string | undefined> } = {}
    const recorder: WslSpawn = (_file, _args, options) => {
      seen.env = options.env as Record<string, string | undefined> | undefined
      // A child that answers nothing but exits cleanly, so the run settles.
      return spawn(process.execPath, ['-e', 'process.exit(0)'], options as SpawnOptions)
    }
    return { spawn: recorder, seen }
  }
  it('collects the child stdout and its exit code', async () => {
    const doors = new WslTransport(fakeSpawn("process.stdout.write('HELLO\\n')"))
    const out = await doors.exec(device, 'echo HELLO')
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toBe('HELLO\n')
  })

  it('still collects stdout printed AFTER stdin is closed', async () => {
    // THE REGRESSION. One PassThrough carried both directions, so ending
    // stdin (what the no-stdin contract does) also ended the readable side
    // and dropped every byte printed afterwards. A real command is often
    // exactly this shape: read its input to EOF, then answer.
    const script = [
      "process.stdin.resume()",
      "process.stdin.on('end', () => process.stdout.write('AFTER\\n'))",
    ].join('; ')
    const doors = new WslTransport(fakeSpawn(script))
    const out = await doors.exec(device, 'cat')
    expect(out.stdout).toBe('AFTER\n')
    expect(out.exitCode).toBe(0)
  })

  it('carries stdin in and stdout out at the same time', async () => {
    const script = [
      "process.stdin.setEncoding('utf8')",
      "let buf = ''",
      "process.stdin.on('data', c => { buf += c; if (buf.includes('X')) { process.stdout.write('GOT:' + buf); process.exit(0) } })",
    ].join('\n')
    const doors = new WslTransport(fakeSpawn(script))
    const out = await doors.exec(device, 'read', { stdin: 'X' })
    expect(out.stdout).toBe('GOT:X')
    expect(out.exitCode).toBe(0)
  })

  it('leaves stdin open when the caller asked for openStdin', async () => {
    const script = [
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', c => { process.stdout.write('GOT:' + c.trim()); process.exit(0) })",
    ].join('\n')
    const doors = new WslTransport(fakeSpawn(script))
    const run = await doors.open(device, 'read', { openStdin: true })
    run.stream.write('PING')
    run.stream.end()
    const chunks: Buffer[] = []
    run.stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    await run.done
    expect(Buffer.concat(chunks).toString('utf8')).toBe('GOT:PING')
  })

  it('hands the caller env additions to the child', async () => {
    const doors = new WslTransport(fakeSpawn("process.stdout.write(String(process.env.DSHELL_TEST_ENV))"))
    const out = await doors.exec(device, 'printenv', { env: { DSHELL_TEST_ENV: 'yes' } })
    expect(out.stdout).toBe('yes')
  })

  it('collects stderr separately from stdout', async () => {
    const doors = new WslTransport(fakeSpawn("process.stdout.write('OUT'); process.stderr.write('ERR')"))
    const out = await doors.exec(device, 'both')
    expect(out.stdout).toBe('OUT')
    expect(out.stderr).toBe('ERR')
  })

  it('reports a nonzero exit code', async () => {
    const doors = new WslTransport(fakeSpawn("process.stdout.write('o'); process.exit(3)"))
    const out = await doors.exec(device, 'fail')
    expect(out.exitCode).toBe(3)
    expect(out.stdout).toBe('o')
  })

  it('survives a child that dies without a word', async () => {
    const doors = new WslTransport(fakeSpawn('process.exit(0)'))
    const out = await doors.exec(device, 'silent')
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toBe('')
  })

  it('feeds a batch payload through the open door and closes stdin', async () => {
    // The open door owns the stdin contract, the way the SSH transport's does:
    // a payload is written and then closed, so the far side sees EOF. A caller
    // that goes through `open` rather than `exec` — the spawn path, the binary
    // read — must not lose what it handed over.
    const script = [
      "process.stdin.setEncoding('utf8')",
      "let buf = ''",
      "process.stdin.on('data', c => { buf += c })",
      "process.stdin.on('end', () => { process.stdout.write(buf.trim()); process.exit(0) })",
    ].join('\n')
    const doors = new WslTransport(fakeSpawn(script))
    const run = await doors.open(device, 'read', { stdin: 'payload' })
    const chunks: Buffer[] = []
    run.stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    await run.done
    expect(Buffer.concat(chunks).toString('utf8')).toBe('payload')
  })

  it('bridges the caller env into the distro through WSLENV', async () => {
    // `wsl.exe` drops the Windows environment: it hands the distro a fixed set
    // (PATH, HOME, …) and nothing else. Setting the variable on the child alone
    // would therefore satisfy nothing, so the transport has to list the names
    // in `WSLENV` — the bridge WSL itself provides — for them to arrive.
    const { spawn: recorder, seen } = recordingSpawn()
    const doors = new WslTransport(recorder)
    await doors.exec(device, 'printenv DSHELL_PROBE', {
      env: { DSHELL_PROBE: 'passed', DSHELL_OTHER: 'x' },
    })
    expect(seen.env?.DSHELL_PROBE).toBe('passed')
    expect(seen.env?.DSHELL_OTHER).toBe('x')
    // The host's own environment survives: a provider's command still runs
    // with the PATH and HOME it needs.
    expect(seen.env?.PATH).toBe(process.env.PATH)
    // And the names are bridged, without erasing a list the host already set.
    const bridge = (seen.env?.WSLENV ?? '').split(':')
    expect(bridge).toContain('DSHELL_PROBE')
    expect(bridge).toContain('DSHELL_OTHER')
  })

  it('keeps the host WSLENV when bridging the caller env', async () => {
    const previous = process.env.WSLENV
    process.env.WSLENV = 'ALREADY_THERE'
    try {
      const { spawn: recorder, seen } = recordingSpawn()
      const doors = new WslTransport(recorder)
      await doors.exec(device, 'true', { env: { MINE: '1' } })
      const bridge = (seen.env?.WSLENV ?? '').split(':')
      expect(bridge).toContain('ALREADY_THERE')
      expect(bridge).toContain('MINE')
      // No duplicates when a name is already listed.
      expect(bridge.filter(name => name === 'MINE')).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.WSLENV
      else process.env.WSLENV = previous
    }
  })
})

describe('the provider declares what a distribution can do', () => {
  const provider = new WslDeviceProvider()

  it('declares a distribution as neither helper-carrying nor dialled', () => {
    // The registry's documented default is "a provider that says nothing is an
    // SSH kind", so a provider that stays silent about these two is read as a
    // device with a helper to deploy and a host key to trust - exactly the wrong
    // answer for a distro. The registry reads these two fields; the specs that
    // pin what it does with them live beside it (ssh/tests/registry.spec.ts).
    expect(provider.helper).toBe(false)
    expect(provider.reachable).toBe(false)
  })

  it('words the helper and dial refusals itself', () => {
    const helper = provider.refusalFor?.('wsl:Ubuntu-24.04', 'helper')
    const dial = provider.refusalFor?.('wsl:Ubuntu-24.04', 'dial')
    expect(helper).toBeDefined()
    expect(helper).toContain('helper')
    expect(dial).toBeDefined()
    expect(dial).toContain('主机密钥')
  })

  it('serves the seams a distro does answer', () => {
    // exec, open and shell are the three doors. forward, helper and dial are the
    // three refused ones, so a refusal naming any of the doors would be a lie.
    const forward = provider.refusalFor?.('wsl:Ubuntu-24.04', 'forward')
    expect(forward).toContain('回环')
    expect(provider.refusalFor?.('wsl:Ubuntu-24.04', 'helper')).toBeDefined()
    expect(provider.refusalFor?.('wsl:Ubuntu-24.04', 'dial')).toBeDefined()
  })

  it('says nothing about a device it does not own', () => {
    expect(provider.refusalFor?.('tencent', 'helper')).toBeUndefined()
    expect(provider.refusalFor?.('tencent', 'dial')).toBeUndefined()
    expect(provider.refusal('tencent')).toBeUndefined()
  })
})

