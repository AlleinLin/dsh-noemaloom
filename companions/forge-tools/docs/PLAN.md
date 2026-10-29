# 实施与证据计划

目标：针对 DSH 0.2.1-rc.2 的独立工具插件；安装者只需一个 tgz。
本项目不修改相邻 Nexus 项目，不调整安全软件、系统服务或宿主权限。

## Phase 0 — 接口与资料

- 核实固定版官方 `tools`、filesystem、sandbox、terminal 与 bundle/preset 源码。
- 核实社区持久 Shell、Windows Bash 与编码工具的适用版本、许可和失败模式。
- 核实 Node 文件监听、ripgrep、Windows minifilter 与 Git 索引的资料。
- Allowed APIs 和工具覆盖清单写入 RESEARCH.md；不推测宿主替换 API。

## Phase 1 — 文件与搜索引擎

- 使用 Node fs/promises 与 ripgrep；避免每次工具调用启动 PowerShell。
- 有界 LRU、同请求合并、监听失效、强一致读取选项、写前真实文件校验。
- 批量读写、精确 edit、统一 patch、按需目录快照、单次流式搜索。
- 验证外部修改、监听丢失后的过期、符号链接与边界、并发和取消；
  不使用会无限期提供陈旧数据的永久内容缓存。

## Phase 2 — 宿主适配与工具

- 依据 Phase 0 的真实 defineTool / permission / sandbox 接口实现注册。
- 用单独 preset 明确启用替换，不劫持全局服务或覆盖其他插件。
- 保持官方语义服务（会话、子代理、目标、网络、图像）可用；
  用覆盖表解释哪些执行引擎替换、哪些由宿主提供。
- 原生 shell 走宿主沙箱；不在受限会话直接 child_process 执行任意命令。

## Phase 3 — 性能与交付

- 测试正确性及真实 SDK 加载、dispose、协议与 preset 内容。
- 基准同时记录直读、热读、目录、搜索、批量和缓存计数；
  加入可控每次 I/O 延迟模拟，明确不代表工作机实测。
- build / npm pack / 解包 smoke / SHA-256 / 安装说明 / 回滚说明。
- 交付可离线安装包、校验和、研究与基准报告；不声称完成工作机安装。
