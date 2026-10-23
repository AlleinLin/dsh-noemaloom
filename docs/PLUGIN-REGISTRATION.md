# 插件注册名与升级

插件使用与 GitHub 仓库一致的名称 `dsh-noemaloom`：

- npm 包与 Desktop 插件管理：`dsh-noemaloom`
- 宿主注册名：`dsh-noemaloom`
- 客户端注册名：`dsh-noemaloom-client`
- 子模块：`dsh-noemaloom/compaction`、`dsh-noemaloom/subagent`、
  `dsh-noemaloom/original/*`、`dsh-noemaloom/native/*` 等

完整退出 Desktop 后，运行交付包内的 `install-desktop.ps1`。
安装器先检查宿主版本和包校验和，安装并校验新包后，再通过宿主内置
CLI 移除旧包 `@local/dsh-nexus`。宿主 CLI 同步处理已选 bundle，
安装器还会检查旧依赖和旧 bundle 选择均已消失。

若新包安装失败，旧包不会被提前移除。若旧包移除失败，安装器会撤回
本次新加的注册，并明确报告失败；不要在迁移失败时启动宿主。
`-CheckOnly` 只检查并报告是否需要迁移，`-VerifyOnly` 只校验安装结果。
脚本不终止进程、不启动宿主、不修改会话或数据库。

原有 `nexus` 根入口 ID、`data/nexus` 数据目录、数据库表、设置键、
消息来源和进程共享锁保持稳定。这些是已有数据的标识，不是插件注册名。
旧的诊断和恢复工具现同时识别新旧包位置。
第三方原插件的名称、来源记录和许可也保持各自的身份。

仓库提供的所有预设和组合声明已使用新模块名。如果自行编写过宿主
overlay 或预设，在其中将模块标识 `@local/dsh-nexus` 替换为
`dsh-noemaloom`，例如：

```yaml
- id: compaction-basic
  name: dsh-noemaloom/compaction
```

配置值中的数据路径、稳定的 `nexus-*` 入口 ID 和历史日志不需要替换。
用户自写 overlay 不由安装器重写。
