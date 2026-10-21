/**
 * `dshellSsh`'s HOST dictionaries — the copy this package's host half composes
 * that a reader sees.
 *
 * These are the messages the host writes for a browser that cannot see its own
 * language: route refusals, device errors, the connection test's result line,
 * the reason a spawn failed, and the errors a remote command surfaces. The
 * browser face keeps its own dictionaries in `client/locales.ts`; the two sets
 * are disjoint, and only this file is reachable from the host half.
 *
 * `ctx.dshellHostCopy` answers which language to write (see the std contract);
 * `hostCopy` below is the pair it binds.
 */

import type { HostCopyDictionaries, HostCopyParams } from '@nexus-aethra/dshell-std'

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'error.unknownAction': '未知操作',
  'error.unknownDevice': '未知设备：{id}',
  'error.hostUserRequired': 'host 与 user 不能为空',
  'error.passphraseWithoutKey': '口令要配一把私钥才有意义：先存私钥，或者不要口令。',
  'error.unknownKey': '这个路径不是 ~/.ssh 里列出来的私钥。',
  'error.groupNotEmpty': '这个分组里还有凭据，先把它们移走或删掉。',
  'error.credentialInUse': '这些设备还在用这条凭据：{names}。先给它们换一条。',
  'error.remoteSignal': '远端命令被信号中断（{signal}）',
  'error.remoteLost': '与设备的连接中断了：通道没有返回退出状态，命令的结果未知。',
  'error.remoteFailed': '远端命令失败（退出码 {code}）',
  'mount.createFailed': '无法在设备上创建 {root}',
  'mount.unbound': '该会话没有绑定设备，但它的目录是设备挂载目录（{cwd}）：'
    + '在这里本机执行只会落在一个空目录里，因此已拒绝。'
    + '请检查该设备是否已被删除；若设备仍在，请在会话里重试连接或新建会话。',
  'route.noDevice': '该会话绑定在设备 {id} 上，但这台设备现在无法服务（可能已被删除，或它的绑定没有可用的挂载映射）：'
    + '在本机执行会让这个会话读写宿主机的文件，因此已拒绝。'
    + '请检查设备配置，或把会话改回「本机」。',
  'test.connected': '已连接 {user}@{host}（{system}） · {ms}ms',
  'test.unknownSystem': '未知系统',
  'test.exitCode': 'ssh 退出码 {code}',
  'test.hostKeyFirst': '主机密钥 {fingerprint}（首次信任，请与服务器管理员核对）',
  'test.hostKeyTrusted': '主机密钥 {fingerprint}（已信任）',
  'test.helperAbsent': '设备上没有 helper，点「部署 helper」即可安装',
  'test.helperPresent': '与本地构建一致',
  'shell.missingRemoteDir': 'dshell: 远端目录 {root} 不存在，已回到登录目录',
  'install.noNode': '设备上没有可用的 node，仍可走 shell seam（RPC 不可用）',
  'install.mismatch': '设备上的副本与本机构建不一致，重新部署即可',
  'install.probeFailed': 'helper 部署前的探测失败（{code}）',
} satisfies Record<string, string>

/** Host dictionary key union. */
export type DshellSshHostKey = keyof typeof zh

/** A translator bound to this package's host dictionaries. */
export type DshellSshTranslate = (key: DshellSshHostKey, params?: HostCopyParams) => string

/** English dictionary, checked complete against the Chinese key set. */
export const en = {
  'error.unknownAction': 'Unknown action',
  'error.unknownDevice': 'Unknown device: {id}',
  'error.hostUserRequired': 'Host and user are required',
  'error.passphraseWithoutKey': 'A passphrase needs a key to unlock: store the key first, or store no passphrase.',
  'error.unknownKey': 'That path is not one of the private keys listed under ~/.ssh.',
  'error.groupNotEmpty': 'This group still holds credentials. Move or delete them first.',
  'error.credentialInUse': 'These devices still use this credential: {names}. Point them at another one first.',
  'error.remoteSignal': 'Remote command interrupted by signal ({signal})',
  'error.remoteLost': 'The connection to the device was lost: the channel closed without an exit status, so the command’s outcome is unknown.',
  'error.remoteFailed': 'Remote command failed (exit code {code})',
  'mount.createFailed': 'Could not create {root} on the device',
  'mount.unbound': 'This session is not bound to a device, but its directory is a device mount directory ({cwd}): '
    + 'running locally here would only land in an empty directory, so it was refused. '
    + 'Check whether the device was deleted; if it still exists, retry the connection in the session or start a new session.',
  'route.noDevice': 'This session is bound to device {id}, which cannot be served right now '
    + '(it was deleted, or its binding has no mount mapping to translate with): '
    + 'running here would make the session read and write THIS machine, so it was refused. '
    + 'Check the device, or bind the session back to this machine.',
  'test.connected': 'Connected {user}@{host} ({system}) · {ms}ms',
  'test.unknownSystem': 'unknown system',
  'test.exitCode': 'ssh exit code {code}',
  'test.hostKeyFirst': 'Host key {fingerprint} (first contact; verify it with the server administrator)',
  'test.hostKeyTrusted': 'Host key {fingerprint} (already trusted)',
  'test.helperAbsent': 'No helper on the device; deploy one to enable RPC',
  'test.helperPresent': 'Matches this build',
  'shell.missingRemoteDir': 'dshell: remote directory {root} does not exist; falling back to the login directory',
  'install.noNode': 'No node available on the device; the shell seam still works, RPC is unavailable',
  'install.mismatch': 'The device runs a different build; deploy again to replace it',
  'install.probeFailed': 'Pre-install probe exited {code}',
} satisfies Record<DshellSshHostKey, string>

/** The pair `ctx.dshellHostCopy.bind()` takes. */
export const hostCopy: HostCopyDictionaries<DshellSshHostKey> = { zh, en }
