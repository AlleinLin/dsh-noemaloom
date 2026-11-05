# R53 上游审查摘要（2026-11-05）

- 宿主目标：官方 Desktop 0.2.1-rc.5。0.2.2-rc.1 已观察，但 SDK 迁移试验未通过类型检查，未采用。
- 清单：154 个来源；以 2026-11-02 锁定资料作增量比较，未变化来源不下载。
- 采用：11 个兼容 rc.5 的 npm 更新；Cognition 0.9.22；billion-context 0.1.212 内 acp-kernel 0.0.178；Veyra 0.1.69 的 redact.mjs；Aegis 2.15.0 选定技能文件；Nexus-Terminal 0.1.16 同版本 Git 树。
- 延后：better-sidebar 0.30.x、task-board/usage 0.4.15 要求 rc.1；dsh-cross-session-approval Git-only 0.3.11、Computer Use Windows 0.5.4、外部 OpenViking/Hindsight 等未作为已发布运行更新。
- Veyra 的 dsh-codebase-memory-mcp 0.1.6 已记入来源清单，仅作参考，不安装第二个 bridge 或 daemon。
- Forge 0.1.6 为本地原创 companion，无独立声明上游；保留可选启用，沿用既有 rc.5 证据。

本轮仅在独立临时环境做构建、测试和官方 rc.5 合成 profile 验收；没有读写真实 profile、会话、凭据，也没有重启运行中的 DSH。未做真实供应商请求、真实 GUI 点击或长时间压力验收。

完整机器可读记录见同名 JSON；逐项来源决定和完整摘要见 `upstreams.json`、`sources.lock.json`。
