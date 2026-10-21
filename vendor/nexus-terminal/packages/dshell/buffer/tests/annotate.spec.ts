/**
 * Naming a pipe, and saying what it is for.
 *
 * The text is the only thing a peer's model has to judge whether a request
 * belongs on this pipe, so the rules that matter are who may write it and what
 * an empty string means: both ends write (each is acting on its own
 * relationship), a non-endpoint is refused, and a blank clears the field rather
 * than storing whitespace. `annotatedBy` is what lets the panel say a peer's
 * words are the peer's — writing from the panel passes no writer and clears it.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DSHELL_HOME_ENV } from '@nexus-aethra/dshell-std'
import { renderBufferPrompt } from '../src/prompt.js'
import { BufferService } from '../src/service.js'

const A = 'session-a'
const B = 'session-b'
const OUTSIDER = 'session-outsider'

let home = ''

afterEach(() => {
  if (home.length > 0) rmSync(home, { recursive: true, force: true })
  home = ''
  delete process.env[DSHELL_HOME_ENV]
})

/** One service over an empty, throwaway harness home. */
function service(): BufferService {
  home = mkdtempSync(join(tmpdir(), 'dshell-buffer-annotate-'))
  process.env[DSHELL_HOME_ENV] = home
  const ctx = {
    get: () => undefined,
    inject: () => {},
    on: () => () => {},
  } as unknown as Context
  return new BufferService(ctx, ((key: string) => key) as never)
}

/** The persisted document, for the round-trip assertions. */
function persisted(): { links: readonly { label?: string; description?: string; annotatedBy?: string }[] } {
  return JSON.parse(readFileSync(join(home, 'dshell', 'buffer', 'state.json'), 'utf8')) as never
}

describe('annotateLink', () => {
  it('lets either end name a pipe and state its purpose', async () => {
    const svc = service()
    const link = await svc.createLink(A, B)
    expect(link.label).toBeUndefined()

    const byA = await svc.annotateLink(link.id, { label: '部署机', description: '把构建产物送到 43.138.••.••' }, A)
    expect(byA.label).toEqual('部署机')
    expect(byA.description).toEqual('把构建产物送到 43.138.••.••')
    expect(byA.annotatedBy).toEqual(A)
    expect(svc.linksFor(A).find(entry => entry.id === link.id)?.description).toEqual('把构建产物送到 43.138.••.••')

    const byB = await svc.annotateLink(link.id, { description: '接收构建产物并部署' }, B)
    expect(byB.label).toEqual('部署机')
    expect(byB.description).toEqual('接收构建产物并部署')
    expect(byB.annotatedBy).toEqual(B)
    expect(persisted().links[0]?.description).toEqual('接收构建产物并部署')
  })

  it('refuses a session that is not an end of the pipe', async () => {
    const svc = service()
    const link = await svc.createLink(A, B)
    await expect(svc.annotateLink(link.id, { label: '偷看' }, OUTSIDER)).rejects.toThrow('error.notAnEndpoint')
    await expect(svc.annotateLink('link_missing', { label: 'x' }, A)).rejects.toThrow('error.unknownLink')
  })

  it('clears a field given as blank, and leaves the other alone', async () => {
    const svc = service()
    const link = await svc.createLink(A, B, '名字', '用途')
    const cleared = await svc.annotateLink(link.id, { label: '   ' }, A)
    expect(cleared.label).toBeUndefined()
    expect(cleared.description).toEqual('用途')
    expect(persisted().links[0]?.label).toBeUndefined()
  })

  it('records the user as the writer when no session is given', async () => {
    const svc = service()
    const link = await svc.createLink(A, B)
    await svc.annotateLink(link.id, { description: 'agent 说的' }, A)
    expect(svc.linksFor(A)[0]?.annotatedBy).toEqual(A)
    const byUser = await svc.annotateLink(link.id, { description: '用户改写的' })
    expect(byUser.annotatedBy).toBeUndefined()
    expect(byUser.description).toEqual('用户改写的')
  })
})

describe('the prompt section', () => {
  it('states each live pipe\'s purpose, so a peer can judge the request', () => {
    const text = renderBufferPrompt([{
      linkId: 'link_1', peer: '终端会话 21:29', where: '运行在设备「43.138.••.••」，工作目录 /root',
      purpose: '把构建产物送到服务器',
    }])
    expect(text).toContain('purpose: 把构建产物送到服务器')
    expect(text).toContain('action="describe"')
  })

  it('stays silent about a purpose nobody wrote', () => {
    const text = renderBufferPrompt([{ linkId: 'link_1', peer: 'peer', where: '运行在本机', purpose: undefined }])
    expect(text).toContain('link_1 ↔ peer')
    expect(text).not.toContain('purpose:')
  })
})
