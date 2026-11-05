/**
 * This package's copy namespace.
 *
 * The card is the 管理台's WSL surface; the keys it needs are its own, and the
 * ones it shares with the SSH form (the test button's label, the name
 * separator) are copied rather than imported — client bundles are
 * per-package, and a locale key is one line.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WSL card: title, detection summary, rows, test action, hint. */
    dshellWsl: DshellWslKey
  }
}

/** The zh dictionary; `DshellWslKey` pins en to the same key set. */
export const zh = {
  'admin.card.wsl': 'WSL 发行版',
  'wsl.summary': '检测到 {count} 个发行版：{names}',
  'wsl.empty': '这台机器没有检测到可用的 WSL2 发行版',
  'wsl.hint': '发行版是本机内建设备：无需配置，在新建会话或会话的运行位置里即可选择。',
  'device.test': '测试',
  'device.testTooltip': '连接该发行版并报告系统信息',
  'card.nameSeparator': '、',
} as const

export type DshellWslKey = keyof typeof zh

/** The en dictionary, pinned to the same keys. */
export const en: Record<DshellWslKey, string> = {
  'admin.card.wsl': 'WSL distributions',
  'wsl.summary': '{count} distributions detected: {names}',
  'wsl.empty': 'No usable WSL2 distribution was detected on this machine',
  'wsl.hint': 'Distributions are built-in devices of this machine: nothing to configure — pick one as a session\'s run location.',
  'device.test': 'Test',
  'device.testTooltip': 'Connect to this distribution and report its system information',
  'card.nameSeparator': ', ',
}
