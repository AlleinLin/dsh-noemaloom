/**
 * The device-side entry point.
 *
 * The only thing this file owns is *how the helper is launched*: its own path
 * (which the handshake hashes), the signals that mean the connection is over,
 * and the rule that it takes no arguments. The behaviour lives in
 * `helper/run.ts` so it can be tested over explicit streams.
 *
 * Launched as `node --disable-sigusr1 <this file>`; see `helperLine` for why
 * that flag is not optional.
 */
import { fileURLToPath } from 'node:url'
import { runDshellHelper } from './helper/run.js'

const controller = new AbortController()
const stop = (): void => { controller.abort(new Error('the dshell SSH helper process was signalled')) }
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.once(signal, stop)
try {
  // Arguments would mean the client believes it can configure this process.
  // It cannot: the connection's whole contract is one helper, as shipped.
  if (process.argv.length !== 2) throw new Error('the dshell SSH helper accepts no command arguments')
  await runDshellHelper({
    input: process.stdin,
    output: process.stdout,
    entryPath: fileURLToPath(import.meta.url),
    signal: controller.signal,
  })
} catch (error) {
  process.stderr.write(`dshell-ssh-helper: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 127
} finally {
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.off(signal, stop)
}
