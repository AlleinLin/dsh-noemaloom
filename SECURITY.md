# Security

请勿在公开 issue 中提交 API key、用户会话、账号文件或可直接利用的敏感数据。
若仓库启用了 GitHub 的 Private vulnerability reporting，请使用仓库 Security 页面的
“Report a vulnerability”。普通缺陷可以通过 issue 报告，并附脱敏后的最小复现。

插件使用宿主提供的权限与沙箱服务。涉及权限提升、命令执行、路径边界、缓存隔离、
凭据引用或第三方组件的修改，应在对应版本的宿主环境中验证。

依赖安装使用已修复安全问题的 Node.js，具体版本见 `.nvmrc` 和 `package.json`。
依赖版本与安全覆盖固定在 `package-lock.json`；CI 和交付打包前执行
`npm run audit:security`，任何已知等级漏洞都会阻止交付。
Node.js 安全基线依据 [2026-10-21 官方公告](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)：
22.23.4、24.22.1、26.12.1。宿主自带的 Node.js/Electron 需要由宿主更新。
