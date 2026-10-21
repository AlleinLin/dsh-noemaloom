# 原生工作流与技能

各能力直接使用原插件及其原生设置，不增加聚合工作台。技能由 DSH 的
`skills` 注册表统一发现、按需加载，主代理与允许使用技能的子代理共用同一底座。
这里只提供能力；用户指令和项目规则仍优先。

| 能力 | 入口 | 实现 |
| --- | --- | --- |
| Superpowers | 原设置页；`/using-superpowers`、`/writing-plans` 等 | Wenaixi 8.0.0 原 provider，15 个技能，逐技能开关、中英描述 |
| Ponytail | 原设置页；`/ponytail`、`/ponytail-review` 等 | Wenaixi 5.6.1 原 provider，6 个技能、七阶工作法、会话模式及默认模式 |
| OpenSpec | `/opsx-*` 和 `/openspec-*` | 原 DSH 适配器 0.4.0，12 个技能和12个用户命令别名；CLI 1.14.3 |
| Karpathy | `/karpathy-guidelines` 或模型按需加载 | 原 DSH provider，读取 canonical 原始技能正文 |
| dsh-ops | 原组件的工具、设置；可选原生 Panel/TUI | 0.4.1 原组合补丁，shell/file/PTC/discovery 默认启用，panel/TUI/隐藏官方工具默认关闭 |

Superpowers 与 Ponytail 的原生配置面板分别放在 DSH 设置的同名入口。
原组件、配置控制器和开关逻辑保持上游实现，避免组合包身份遮住原包的配置卡片。

Ponytail 的 lite/full/ultra 是其**方法严格程度**，不是模型的
`reasoning_effort`。默认设置写入当前 DSH profile 的原生配置，显式会话命令
只影响该会话。会话基线提示前缀固定，模式变化通过原插件增量提醒进入上下文，
避免每轮重写系统提示破坏模型缓存。可选服务使用公开 scoped lookup，
以免桌面上误回退到所有 profile 共用的数据目录。

Superpowers 的完整正文只在加载技能时读取，不把15份正文每轮塞入上下文。
重复技能名由 DSH 原生 rank 决定；不同时运行旧 LayneChai provider。

OpenSpec 的项目产物存放当前工作目录的 `openspec/`。技能里的 CLI 命令
使用包内固定版本的 Node CLI，Windows 路径按 PowerShell 规则引用，
不要求全局 npm 安装，不改 PATH，不另造执行通道。调用仍经 DSH 的
命令权限、工作目录、sandbox 与取消机制。首次使用可执行
`/opsx-new` 或 `/opsx-propose`，再用 `/opsx-apply`、`/opsx-verify`、
`/opsx-archive`；具体步骤保留上游技能。

Karpathy 技能来源是 multica-ai/andrej-karpathy-skills，由 forrestchang
编写，受 Karpathy 观点启发，并非 Karpathy 官方发布。原项目没有单独
LICENSE 文件，其插件元数据声明 MIT；相关原文、元数据和来源均随包保留。

调试器、代理邮箱和工作流分别拥有生命周期。方法类技能不会替用户暂停、
终止或重建正在运行的代理。
