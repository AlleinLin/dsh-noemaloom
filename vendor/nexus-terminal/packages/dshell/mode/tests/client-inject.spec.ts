/**
 * The services this client half reads, and the ones it declares.
 *
 * Cordis gates every service property behind the package's inject
 * declaration: reading `ctx.sidebarRightTabs` in a package that did not
 * declare it throws "cannot get property \"sidebarRightTabs\" without inject"
 * — and it throws where the reader is, not where the mistake is. The device
 * panel hit exactly that: the type was registered from the right pane's
 * registry, and the registry was never declared.
 *
 * So this walks the client's own source and checks every service it reads
 * against the declaration, because the declaration is the one line that is
 * easy to forget and hard to notice.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { inject } from '../src/client/index.js'

const CLIENT_DIR = fileURLToPath(new URL('../src/client/', import.meta.url))

/** The services a client context always has, declared or not. */
const CORE = new Set(['get', 'inject', 'effect', 'effects', 'plugin'])

/** Every source file of the client half. */
function clientSources(dir: string = CLIENT_DIR): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      files.push(path)
    } else if (entry.endsWith('/') || entry === 'client') {
      files.push(...clientSources(path))
    }
  }
  return files
}

/** The source without its comments, so a mention in prose is not a reading. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

describe('the client half', () => {
  it('declares every service it reads', () => {
    const declared = new Set<string>(inject)
    const missing: string[] = []
    for (const file of clientSources()) {
      for (const match of code(readFileSync(file, 'utf8')).matchAll(/\bctx\.([A-Za-z_$][\w$]*)/gu)) {
        const service = match[1]
        if (service === undefined || CORE.has(service)) continue
        if (!declared.has(service)) missing.push(`${file}: ctx.${service}`)
      }
    }

    expect(missing).toEqual([])
  })

  it('declares the right pane\'s type registry', () => {
    // The device panel IS a type in that registry, and the registry is what
    // the right pane dispatches on.
    expect([...inject]).toContain('sidebarRightTabs')
  })
})
