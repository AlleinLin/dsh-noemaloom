# Noemaloom R53 / 0.4.6

适用 Windows x64 与官方 DeepSeek Harness Desktop 0.2.1-rc.5。

安装前先核对 `SHA256SUMS.txt`、`install-manifest.json` 和压缩包摘要。安装器只操作指定的 Desktop profile，不改写会话数据库，不恢复备份，也不会自动打开上下文维护。请在宿主正常退出后运行：

```powershell
.\install-desktop.ps1 -HarnessDirectory 'D:\Program Files\DeepSeek Harness' -CheckOnly
.\install-desktop.ps1 -HarnessDirectory 'D:\Program Files\DeepSeek Harness'
.\install-desktop.ps1 -HarnessDirectory 'D:\Program Files\DeepSeek Harness' -VerifyOnly
```

本轮上游同步继续使用 rc.5：11 个兼容 npm 更新、Cognition 0.9.22、ACP kernel 0.0.178、Veyra 0.1.69 的脱敏模块、Aegis 2.15.0 选定技能和 Nexus-Terminal 0.1.16。0.2.2-rc.1 因 API 类型不兼容未采用；不使用 `allow-version` 豁免。

交付在独立官方 rc.5 合成 profile 上通过构建、类型检查、2536 项回归、离线 Cognition 回归、桌面准入和会话恢复检查。没有真实供应商请求、真实用户会话重放或长时间压力结论。Forge 0.1.6 仍是独立可选 companion，不自动安装到用户 profile。
