# Security

请勿在公开 issue 中提交 API key、用户会话、账号文件或可直接利用的敏感数据。
若仓库启用了 GitHub 的 Private vulnerability reporting，请使用仓库 Security 页面的
“Report a vulnerability”。普通缺陷可以通过 issue 报告，并附脱敏后的最小复现。

插件使用宿主提供的权限与沙箱服务。涉及权限提升、命令执行、路径边界、缓存隔离、
凭据引用或第三方组件的修改，应在对应版本的宿主环境中验证。
