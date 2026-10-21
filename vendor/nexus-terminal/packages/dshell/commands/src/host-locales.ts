/**
 * `dshell-commands`'s HOST dictionaries — the copy this package's `/new`
 * command composes that a reader sees.
 *
 * A command result renders in dsh's command-result surface, so its language has
 * to match the screen even though the host writes it. `ctx.dshellHostCopy`
 * answers which language that is (see the std contract); these dictionaries are
 * what it binds. The model-facing half of this package — every tool
 * description, parameter description and `execute` return line — is deliberately
 * absent: the model reads those, not the user, and they stay in their source
 * language.
 *
 * The browser face keeps its own dictionaries elsewhere: the two sets are
 * disjoint by construction, and only this file is reachable from the host half.
 */

import type { HostCopyDictionaries } from '@nexus-aethra/dshell-std'

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'command.new.created': '新会话已创建:{id}',
  'command.new.failed': '创建会话失败:{message}',
} satisfies Record<string, string>

/** Host dictionary key union. */
export type DshellCommandsHostKey = keyof typeof zh

/** English dictionary, checked complete against the Chinese key set. */
export const en = {
  'command.new.created': 'New session created: {id}',
  'command.new.failed': 'Failed to create a session: {message}',
} satisfies Record<DshellCommandsHostKey, string>

/** The pair `ctx.dshellHostCopy.bind()` takes. */
export const hostCopy: HostCopyDictionaries<DshellCommandsHostKey> = { zh, en }
