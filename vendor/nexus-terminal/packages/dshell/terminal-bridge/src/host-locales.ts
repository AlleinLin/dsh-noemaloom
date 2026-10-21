/**
 * `dshell-terminal-bridge`'s HOST dictionaries — the copy this package's host
 * half composes that a reader sees.
 *
 * Two surfaces consume these: the bridge's spawn-failure text, which the
 * terminal's connection panel shows verbatim (`dshell-mode`'s
 * `connection-notice.ts`), and the `/dshell/pty` route refusals. Both are
 * written by the host and read by the browser, so their language has to match
 * the screen; `ctx.dshellHostCopy` answers which language that is (see the std
 * contract), and these dictionaries are what it binds.
 *
 * The browser face keeps its own dictionaries in `client/locales.ts`: the two
 * sets are disjoint by construction, and only this file is reachable from the
 * host half. The wire field names, the protocol tokens that ride `reason`
 * (`session closed`, `session deleted`) and the internal `dshell-bridge: …`
 * diagnostics are contracts, not copy, and stay untranslated.
 */

import type { HostCopyDictionaries, HostCopyParams } from '@nexus-aethra/dshell-std'

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'spawn.failed': '终端启动失败',
  'spawn.exitBeforePrompt': 'PTY shell 在首次提示符前退出{exit}',
  'spawn.startupTimeout': 'PTY shell 在启动超时前未到达提示符',
  'spawn.withDetail': '{head}：{detail}',
  'route.postOnly': '这条路由只接受 POST',
  'route.unknownAction': '未知操作',
} satisfies Record<string, string>

/** Host dictionary key union. */
export type DshellTerminalBridgeHostKey = keyof typeof zh

/** English dictionary, checked complete against the Chinese key set. */
export const en = {
  'spawn.failed': 'Terminal failed to start',
  'spawn.exitBeforePrompt': 'PTY shell exited before its first prompt{exit}',
  'spawn.startupTimeout': 'PTY shell did not reach a prompt before the startup timeout',
  'spawn.withDetail': '{head}: {detail}',
  'route.postOnly': 'This route only accepts POST',
  'route.unknownAction': 'Unknown action',
} satisfies Record<DshellTerminalBridgeHostKey, string>

/** The pair `ctx.dshellHostCopy.bind()` takes. */
export const hostCopy: HostCopyDictionaries<DshellTerminalBridgeHostKey> = { zh, en }

/**
 * The bound translator this package's host half threads through its modules —
 * a thin alias of what `bind()` returns, so the backend, the route and the
 * service all name the same function type without re-deriving it.
 */
export type DshellTerminalBridgeHostTranslator = (
  key: DshellTerminalBridgeHostKey,
  params?: HostCopyParams,
) => string
