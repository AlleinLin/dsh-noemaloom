# Noemaloom R54 / 0.5.0

适用 Windows x64 与官方 DeepSeek Harness Desktop 0.2.2-rc.1。所有同源 SDK 随宿主整体迁移，不用 allow-version。官方 nightly 当前 staging 100%，安装器固定其文件大小和 SHA512，并核验签名。

先核对 SHA256SUMS.txt、install-manifest.json 和压缩包摘要。仅在宿主正常退出后安装：

```powershell
.\install-desktop.ps1 -HarnessDirectory 'D:\Program Files\DeepSeek Harness' -CheckOnly
.\install-desktop.ps1 -HarnessDirectory 'D:\Program Files\DeepSeek Harness'
.\install-desktop.ps1 -HarnessDirectory 'D:\Program Files\DeepSeek Harness' -VerifyOnly
```

安装只操作指定 Desktop profile；保留已有启用选择，尤其自动上下文维护关闭状态。不恢复备份，不清理用户会话或改写数据库，不在运行中覆盖插件。本轮没有安装到正在运行的真实 DSH；本机已自行升级到 rc.1，不能把交付版本当成已安装版本。

本轮来源与适配见 upstream-audit-2026-11-09.md/json，实际验收与限制见 release-r54-verification.json。Forge 0.1.7 是独立可选 companion，不随主包自动安装。GUI、真实供应商、真实五小时与长时间压力均不由离线结果证明，间歇闪退仍无根因结论。
