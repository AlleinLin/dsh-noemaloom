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
  'wsl.empty': '这台主机当前没有可用的 WSL2 发行版',
  'wsl.hint': '发行版是本机内建设备：无需配置，在新建会话或会话的运行位置里即可选择。',
  'wsl.visibilityNote': '「隐藏」只把该发行版从新建会话和设备选择列表里去掉：它仍然可以连接，已经绑定它的会话也照旧在它上面运行。',
  'device.hide': '隐藏',
  'device.hideTooltip': '在新建会话和设备选择列表里隐藏这个发行版（不影响已在它上面运行的会话）',
  'device.show': '显示',
  'device.showTooltip': '重新在新建会话和设备选择列表里显示这个发行版',
  'device.hiddenNote': '已从设备选择列表中隐藏',
  'device.visibilityRefused': '这台部署没有可写的设置文档，隐藏状态保存不下来：本次会话内有效，重启后恢复。',
  'device.test': '测试',
  'device.testTooltip': '连接该发行版并报告系统信息',
  'card.nameSeparator': '、',
} as const

export type DshellWslKey = keyof typeof zh

/** The en dictionary, pinned to the same keys. */
export const en: Record<DshellWslKey, string> = {
  'admin.card.wsl': 'WSL distributions',
  'wsl.summary': '{count} distributions detected: {names}',
  'wsl.empty': 'This host has no usable WSL2 distribution available',
  'wsl.hint': 'Distributions are built-in devices of this machine: nothing to configure — pick one as a session\'s run location.',
  'wsl.visibilityNote': 'Hiding only removes a distribution from the new-session and device pickers: it still answers, and a session already bound to it keeps running there.',
  'device.hide': 'Hide',
  'device.hideTooltip': 'Hide this distribution from the new-session and device pickers (sessions already running on it are unaffected)',
  'device.show': 'Show',
  'device.showTooltip': 'Offer this distribution in the new-session and device pickers again',
  'device.hiddenNote': 'hidden from the device pickers',
  'device.visibilityRefused': 'This deployment has no writable settings document, so the hidden state cannot be kept: it lasts for this session only and returns on restart.',
  'device.test': 'Test',
  'device.testTooltip': 'Connect to this distribution and report its system information',
  'card.nameSeparator': ', ',
}
