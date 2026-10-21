/**
 * `dshellFiles` namespace dictionaries, and the namespace's declaration.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'dshellFiles'>` or `PropsLocale<'dshellFiles'>` needs only this
 * file, whichever entry a program loads first.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** File-navigator type name, guide entry, row states, and failure lines. */
    dshellFiles: DshellFilesKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'type.label': '文件',
  'guide.title': '可移动的文件浏览器',
  'guide.description': '在本机或设备上前后移动地浏览文件',
  loading: '正在读取…',
  empty: '空目录',
  truncated: '条目太多，只显示了一部分。',
  noWorkspace: '这个会话没有工作目录。',
  reload: '重新读取',
  back: '后退',
  forward: '前进',
  cd: '让终端进入这个目录',
  parent: '双击进入上一级',
  root: '跳到根目录',
  'entry.other': '这不是文件或目录，没法打开。',
  'error.unavailable': '读取失败：{message}',
  'error.cd': '终端跳转失败：{message}',
  'transfer.label': '文件传输',
  'transfer.open': '打开文件传输',
  'transfer.preparing': '正在准备传输…',
  'transfer.blocked': '这个会话没有可传输的设备。',
  'transfer.local': '本机',
  'transfer.remote': '设备',
  'transfer.reload': '重新读取两侧',
  'transfer.hint': '把一侧的文件或文件夹拖到另一侧，就会复制过去。',
  'transfer.cancel': '取消',
  'transfer.overwrite': '覆盖',
  'transfer.dismiss': '移除',
  'transfer.state.walking': '统计中…',
  'transfer.state.copying': '传输中',
  'transfer.state.done': '完成',
  'transfer.state.failed': '失败',
  'transfer.state.cancelled': '已取消',
  'transfer.counts': '{done}/{total} 项',
  'transfer.chunks': '分块 {done}/{total}',
  'transfer.skipped': '跳过 {count} 个',
} satisfies Record<string, string>

/** Files dictionary key union. */
export type DshellFilesKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'type.label': 'Files',
  'guide.title': 'Movable file browser',
  'guide.description': 'Move back and forth through files on this machine or a device',
  loading: 'Reading…',
  empty: 'Empty directory',
  truncated: 'Too many entries, showing only some of them.',
  noWorkspace: 'This session has no working directory.',
  reload: 'Reload',
  back: 'Back',
  forward: 'Forward',
  cd: 'Send the terminal into this directory',
  parent: 'Double-click to go up one level',
  root: 'Jump to the root',
  'entry.other': 'Not a file or a directory, so it cannot be opened.',
  'error.unavailable': 'Read failed: {message}',
  'error.cd': 'Could not move the terminal: {message}',
  'transfer.label': 'File transfer',
  'transfer.open': 'Open file transfer',
  'transfer.preparing': 'Preparing the transfer…',
  'transfer.blocked': 'This session has no device to transfer with.',
  'transfer.local': 'This machine',
  'transfer.remote': 'Device',
  'transfer.reload': 'Reload both sides',
  'transfer.hint': 'Drag a file or folder from one side to the other to copy it over.',
  'transfer.cancel': 'Cancel',
  'transfer.overwrite': 'Overwrite',
  'transfer.dismiss': 'Remove',
  'transfer.state.walking': 'Planning…',
  'transfer.state.copying': 'Transferring',
  'transfer.state.done': 'Done',
  'transfer.state.failed': 'Failed',
  'transfer.state.cancelled': 'Cancelled',
  'transfer.counts': '{done}/{total} items',
  'transfer.chunks': 'chunk {done}/{total}',
  'transfer.skipped': '{count} skipped',
} satisfies Record<DshellFilesKey, string>
