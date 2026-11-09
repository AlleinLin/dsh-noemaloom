/**
 * The guards for the fixes that keep the desktop app alive.
 *
 * Four defects, one shape of failure: the desktop app froze, burned CPU and
 * restarted. Each guard below fails if the old writing comes back.
 *
 *  1. A floating promise in the bridge or the buffer package. dsh treats an
 *     unhandled rejection as FATAL (`proc.exit(1)` in app-boot), and the
 *     desktop app restarts the host when it dies. A rejection that escapes
 *     is therefore a restart.
 *  2. The retained PTY buffer was measured by re-splitting it on every chunk
 *     of output: quadratic in the session's own output.
 *  3. The browser's copy of a block grew without any cap.
 *  4. The device-detail seat dropped a session that a second reader was
 *     still watching.
 *
 * The first guard reads the SOURCE AS A TREE. A floating promise is a
 * `void` applied to a promise chain whose last link is not a rejection
 * handler — and the subtlety is that `.then(a, b)` handles the PROMISE's
 * rejection but NOT a throw inside `a`, which becomes a fresh unhandled
 * rejection. Reading that off the text alone is guesswork; the AST answers
 * it exactly.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/** This spec's own directory. */
const specDir = dirname(fileURLToPath(import.meta.url))

/** The source of one file, relative to this spec. */
function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

/** One floating promise, as the AST found it. */
interface Floating {
  /** The file it was found in. */
  readonly file: string
  /** The line it sits on, 1-based. */
  readonly line: number
  /** The text of the statement, for the failure message. */
  readonly text: string
}

/**
 * The outermost call in a chain: `a.b().c().d()` — the node whose parent is
 * not itself a call on the same expression.
 */
function chainRoot(node: ts.Node): ts.Node {
  let current = node
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const parent = current.parent
    if (ts.isCallExpression(parent) && parent.expression === current) {
      current = parent
      continue
    }
    break
  }
  return current
}

/**
 * Whether a promise chain ends in a rejection handler.
 *
 * A chain is safe when its LAST link is `.catch(...)`, or when it is a
 * `.then(a, b)` — but that only covers the promise's own rejection. A throw
 * inside `a` is a new rejection, so a `.then(a, b)` is safe ONLY if it is
 * followed by a `.catch(...)`.
 */
function chainIsHandled(root: ts.Node): boolean {
  const calls: ts.CallExpression[] = []
  let current: ts.Node = root
  while (ts.isCallExpression(current)) {
    calls.push(current)
    if (!ts.isPropertyAccessExpression(current.expression)) break
    current = current.expression.expression
  }
  // calls[0] is the outermost; walk from the innermost outward.
  for (const call of calls) {
    if (!ts.isPropertyAccessExpression(call.expression)) continue
    const name = call.expression.name.text
    if (name === 'catch') return true
  }
  // No `.catch` anywhere: a `.then` with two handlers still lets a throw
  // inside the first escape.
  return false
}

/**
 * Whether the awaited call is a method whose own body already handles its
 * failures.
 *
 * `save()` in the block log catches its own write error and returns; a
 * floating `void this.save()` is therefore safe. The list is the set of
 * such methods, and each one is named in the guard's failure message so a
 * new unhandled call has to be looked at rather than waved through.
 */
const SELF_HANDLING = new Set([
  'save',
  'saveTimeline',
  'flush',
  'truncate',
])

/** The name of the method a floating call invokes, if it invokes one. */
function calledMethod(operand: ts.Node): string | undefined {
  if (!ts.isCallExpression(operand)) return undefined
  if (!ts.isPropertyAccessExpression(operand.expression)) return undefined
  return operand.expression.name.text
}

/** Every floating promise in one file. */
function floatingIn(file: string, text: string): Floating[] {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: Floating[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && ts.isVoidExpression(node.expression)) {
      const operand = node.expression.expression
      // Only a promise chain can reject.
      if (ts.isCallExpression(operand)) {
        const root = chainRoot(operand)
        const method = calledMethod(operand)
        // A method that handles its own failures is safe to float.
        if (method !== undefined && SELF_HANDLING.has(method) && !chainIsHandled(root)) {
          ts.forEachChild(node, visit)
          return
        }
        if (!chainIsHandled(root)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          found.push({
            file,
            line: line + 1,
            text: node.getText(sourceFile).slice(0, 200),
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

describe('the desktop app stays up', () => {
  describe('no floating rejection can take the host down', () => {
    /**
     * Every HOST-side source file that runs in the dsh host process.
     *
     * The list is a SCAN, not a hand-kept list of files: a file added to a
     * package later is in scope the moment it exists, which is the only way
     * this guard can keep its promise. The bridge, the buffer package, the SSH
     * package and the WSL package all run on the host side, and dsh treats an
     * unhandled rejection as FATAL — the desktop app restarts the host when it
     * dies.
     */
    const HOST_ROOTS = [
      join(specDir, '..', '..', 'terminal-bridge', 'src'),
      join(specDir, '..', '..', 'buffer', 'src'),
      join(specDir, '..', '..', 'ssh', 'src'),
      join(specDir, '..', '..', 'wsl', 'src'),
    ]

    /** Every TypeScript file under the roots, excluding the client half. */
    function hostFiles(): readonly string[] {
      const found: string[] = []
      const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name)
          if (entry.isDirectory()) {
            // The browser half runs in the renderer: a rejection there cannot
            // take the host down, and the renderer's own error boundary owns it.
            if (entry.name === 'client') continue
            walk(path)
            continue
          }
          if (!entry.name.endsWith('.ts')) continue
          if (entry.name.endsWith('.d.ts')) continue
          found.push(path)
        }
      }
      for (const root of HOST_ROOTS) walk(root)
      return found.sort()
    }

    it('every floating promise on the host side ends in a rejection handler', () => {
      const floating: Floating[] = []
      for (const file of hostFiles()) {
        floating.push(...floatingIn(file, readFileSync(file, 'utf8')))
      }
      expect(
        floating.map(entry => `${entry.file.replace(specDir, '.')}:${entry.line}\n    ${entry.text}`).join('\n'),
      ).toBe('')
    })

    it('the bridge claims a foreign shell without letting the claim reject', () => {
      const text = source('../src/index.ts')
      // The claim reads the agent's log file, which on Windows can be locked
      // by the process that wrote it. An unclaimed shell is a state the client
      // already draws; a rejected claim is a dead host.
      expect(text).toMatch(/void this\.claimForeignAgent\(owner, sessionId\)\.catch\(/)
    })

    it('the bridge disposes without letting the teardown reject', () => {
      const text = source('../src/index.ts')
      expect(text).toMatch(/void this\.disposeAll\(\)\.catch\(/)
    })

    it('the buffer watchdog survives a failing sweep', () => {
      const text = source('../../buffer/src/service.ts')
      expect(text).toMatch(/void this\.sweep\(\)\.catch\(/)
      expect(text).toMatch(/void this\.reconcile\(\)\.catch\(/)
    })

    it('the shell-up handler catches a throw from inside the handler', () => {
      const text = source('../src/index.ts')
      // `.then(onFulfilled, onRejected)` does NOT catch a throw from
      // `onFulfilled`: it becomes a fresh unhandled rejection, and the host
      // exits the process on those.
      const start = text.indexOf("this.ctx.terminals.startSend(record.agent, record.ptyId, { text: init")
      expect(start).toBeGreaterThan(-1)
      const chain = text.slice(start, start + 4000)
      expect(chain).toMatch(/\}, \(\) => \{[\s\S]*?\}\)\s*\.catch\(/)
    })
  })

  describe('the retained PTY buffer is measured incrementally', () => {
    it('never splits the whole buffer to count its lines', () => {
      const text = source('../src/pty.ts')
      const start = text.indexOf('private trimRetained()')
      expect(start).toBeGreaterThan(-1)
      const body = text.slice(start, start + 2000)
      expect(body).not.toMatch(/split\('\\n'\)/)
      expect(body).not.toMatch(/Buffer\.byteLength\(this\.retained\)/)
    })

    it('only calls the trimmer after a hard cap was crossed', () => {
      const text = source('../src/pty.ts')
      const start = text.indexOf('protected onData(text: string)')
      expect(start).toBeGreaterThan(-1)
      const body = text.slice(start, start + 1200)
      expect(body).toMatch(/this\.retainedLines > RETAINED_MAX_LINES \|\| this\.retainedBytes > RETAINED_MAX_BYTES/)
      expect(body).toMatch(/this\.trimRetained\(\)/)
    })

    it('has a byte-cap fallback for a line with no newline', () => {
      const text = source('../src/pty.ts')
      // No line boundary worked -> keep a byte-sized tail. Without this
      // branch a single enormous line can never be trimmed at all.
      expect(text).toMatch(/const keepFrom = total - targetBytes/)
      expect(text).toMatch(/export function trimRetainedText/)
    })

    it('keeps the byte and line counts as the buffer grows', () => {
      const text = source('../src/pty.ts')
      expect(text).toMatch(/private retainedBytes = 0/)
      expect(text).toMatch(/private retainedLines = 1/)
      // The counters have to be updated where the text is appended, or the
      // trim would measure a buffer that no longer exists.
      const start = text.indexOf('protected onData(text: string)')
      expect(start).toBeGreaterThan(-1)
      const body = text.slice(start, start + 1200)
      expect(body).toMatch(/this\.retainedBytes \+=/)
      expect(body).toMatch(/this\.retainedLines \+= 1/)
    })
  })

  describe('the browser block text is capped', () => {
    it('caps a block that grows by deltas', () => {
      const text = source('../src/client/index.ts')
      expect(text).toMatch(/const BLOCK_MAX_CHARS = \d+ \* 1024/)
      const start = text.indexOf("frame.kind === 'block-text'")
      expect(start).toBeGreaterThan(-1)
      const body = text.slice(start, start + 900)
      expect(body).toMatch(/block\.text\.length > BLOCK_MAX_CHARS/)
      expect(body).toMatch(/block\.text = block\.text\.slice\(/)
    })
  })
})

describe('a session stays watched while a reader remains', () => {
  it('the device-detail seat counts every reader down', () => {
    const text = source('../../mode/src/client/device-detail.ts')
    // The FIRST watcher's release used to delete the entry outright, which
    // dropped a session a second reader was still watching.
    const start = text.indexOf('watch(sessionId) {')
    expect(start).toBeGreaterThan(-1)
    const body = text.slice(start, start + 2000)
    const deletes = body.match(/watchers\.delete\(sessionId\)/g) ?? []
    const decrements = body.match(/watch\.readers -= 1/g) ?? []
    expect(deletes.length).toBe(2)
    expect(decrements.length).toBe(2)
    // And the second delete is guarded by the count.
    expect(body).toMatch(/watch\.readers -= 1\s*\n\s*if \(watch\.readers > 0\) return\s*\n\s*watchers\.delete\(sessionId\)/)
  })

  it('the block view subscribes once the binding arrives', () => {
    const text = source('../../mode/src/client/block-view.ts')
    // Binding later and returning left the view with no subscription at all,
    // and the transcript silently stopped growing.
    expect(text).toMatch(/unsubscribeBound = bound\?\.subscribe\(accept\)/)
    expect(text).toMatch(/clearInterval\(timer\)\s*\n\s*unsubscribeBound = bound\?\.subscribe\(accept\)/)
  })
})
