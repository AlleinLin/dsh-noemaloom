# 恢复核心复用

`upstream/` 的账本、Git 私有对象检查点、原始字节存储、锁、路径缓存和恢复引擎来自
`Anionex/dsh-turn-rewind`，BSD-3-Clause，版权与许可全文保留在 `upstream/LICENSE`。

Nexus 的宿主边界、主体绑定、精确会话分支、幂等操作账本和公共 DTO 在 `index.ts`。
本次适配包括：120 秒计划有效期；默认私密路径在读取前排除；Windows ADS、设备名和
路径别名拒绝；预览不写入文件 blob；逐文件完成 journal；补偿先比对可识别 postimage，
发现外部新编辑即保留当前内容并进入人工恢复；Windows sharing violation 不先删除目标。
链接额外保存原始目标、文件/目录符号链接、Windows junction 与 reparse tag；未知 reparse
仅展示，内部 junction 使用 `junction` 类型还原，绝不跟随链接读取外部文件内容。

插件装载时不捕获用户文件。文件捕获及 apply 均需要运行时宿主权限；本次开发部署禁止
创建本机恢复备份的指令优先，开发与安装流程不得调用 capture/apply。
未来回合自动检查点默认关闭，必须通过显式 `recovery.configure` 启用；`capture.turn`
重新验证宿主直接用户消息及尚未跨过副作用边界。该配置不能用于本次部署备份。
