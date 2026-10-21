/**
 * Who a pipe may join.
 *
 * The feature serves dshell's terminal sessions, and the check lives on the
 * host rather than in the panel because a route call walks around any filter
 * the browser draws. What the spec pins is the three-state answer the registry
 * gives: a session it lists is served, one it does not list is refused, and a
 * composition with no registry at all cannot tell — which is a skip, not a
 * blanket refusal. The registry's own load is awaited first, or a table that
 * has not read its document yet would refuse a legitimate session.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DSHELL_HOME_ENV } from '@nexus-aethra/dshell-std'
import { BufferService } from '../src/service.js'

const TERMINAL = 'session-terminal'
const CHAT = 'session-chat'

let home = ''

afterEach(() => {
  if (home.length > 0) rmSync(home, { recursive: true, force: true })
  home = ''
  delete process.env[DSHELL_HOME_ENV]
})

/** One service over an empty harness home, with an optional terminal registry. */
function service(registry?: { readonly terminals: readonly string[] }): BufferService {
  home = mkdtempSync(join(tmpdir(), 'dshell-buffer-scope-'))
  process.env[DSHELL_HOME_ENV] = home
  let ready = false
  const seat = registry === undefined ? undefined : {
    load: async () => { ready = true },
    isOn: (sessionId: string) => ready && registry.terminals.includes(sessionId),
  }
  const ctx = {
    get: (key: unknown) => key === 'dshellTerminalMode' ? seat : undefined,
    inject: () => {},
    on: () => () => {},
  } as unknown as Context
  return new BufferService(ctx, ((key: string) => key) as never)
}

describe('createLink scope', () => {
  it('connects two terminal sessions', async () => {
    const svc = service({ terminals: [TERMINAL, 'session-other'] })
    const link = await svc.createLink(TERMINAL, 'session-other')
    expect(svc.linksFor(TERMINAL).map(entry => entry.id)).toEqual([link.id])
  })

  it('refuses a session the registry does not list', async () => {
    const svc = service({ terminals: [TERMINAL] })
    await expect(svc.createLink(TERMINAL, CHAT)).rejects.toThrow('error.notTerminal')
    expect(svc.linksFor(TERMINAL)).toEqual([])
  })

  it('awaits the registry\'s load before judging', async () => {
    // The seat answers `false` for everything until load() has run — the
    // stand-in for a table that has not read its document yet — so a check
    // that skipped the await would refuse two real terminal sessions.
    const svc = service({ terminals: [TERMINAL, CHAT] })
    await expect(svc.createLink(TERMINAL, CHAT)).resolves.toBeDefined()
  })

  it('connects anything when the composition has no registry', async () => {
    const svc = service()
    await expect(svc.createLink(TERMINAL, CHAT)).resolves.toBeDefined()
  })
})
