import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Keep a console process attached while the unchanged Electron ACL runner owns
 * the confined shell. The native subprocess provider owns the complete tree.
 */
export function runConsoleBridge(argv, { launch = spawn, parent = process } = {}) {
  const fail = error => {
    const label = error instanceof Error ? error.message : String(error)
    parent.stderr.write(`dsh-pty-console: ${label.slice(0, 1000)}\n`)
    parent.exitCode = 127
  }
  if (argv[0] !== '--' || typeof argv[1] !== 'string' || argv[1].length === 0) {
    fail(new Error('expected the original confined argv after --'))
    return
  }
  // Ctrl+C/Ctrl+Break already reach the attached foreground console processes.
  // Keep this lifetime owner alive; child.kill("SIGINT") on Windows terminates
  // the process rather than delivering an interactive console interrupt.
  const keepConsole = () => {}
  parent.on('SIGINT', keepConsole)
  parent.on('SIGBREAK', keepConsole)
  const detach = () => {
    parent.removeListener('SIGINT', keepConsole)
    parent.removeListener('SIGBREAK', keepConsole)
  }
  let child
  try {
    child = launch(argv[1], argv.slice(2), {
      stdio: 'inherit', shell: false, windowsHide: true,
    })
  } catch (error) {
    detach()
    fail(error)
    return
  }
  let failed = false
  child.once('error', error => {
    failed = true
    fail(error)
  })
  child.once('close', (code, signal) => {
    detach()
    if (!failed) parent.exitCode = code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0))
  })
  return child
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runConsoleBridge(process.argv.slice(2))
}
