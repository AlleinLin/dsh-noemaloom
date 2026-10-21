/**
 * `dshellTerminalBridge` namespace dictionaries, and the namespace's declaration.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'dshellTerminalBridge'>` needs only this file, whichever entry a
 * program loads first.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The wire client's connection copy shown when the host reports no reason. */
    dshellTerminalBridge: DshellTerminalBridgeKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  disconnect: '与服务端的连接已断开',
} satisfies Record<string, string>

/** Namespace key union. */
export type DshellTerminalBridgeKey = keyof typeof zh

/** English dictionary, checked complete against the Chinese key set. */
export const en = {
  disconnect: 'Disconnected from the server',
} satisfies Record<DshellTerminalBridgeKey, string>
