# R46：会话定时固定文字注入

目标宿主为官方 Desktop **0.2.1-rc.5**。上游审查仍覆盖 153 项来源；公开候选
`0.2.2-alpha.2` 没有可验证的正式 Desktop 发布渠道，因此没有混用 alpha 宿主或
同源开发版 SDK。Forge 为原创本地 companion，本轮随 rc.5 适配版本 0.1.6 交付。

本轮新增 `workflow/prompt/schedule` 后端和“延时”会话按钮：

- 主代理和子代理输入栏都显示同一个会话范围的“延时”按钮。
- 填写分钟数（1 分钟至 7 天）和固定文字后，计划持久化到当前会话。
- 到点调用正式宿主注入；宿主忙或暂不可用时保持 `queued`，每 30 秒重试。
- 计划可以取消，不会修改会话数据库或重放正在运行的代理。
- 主代理阅读页也提供入口，跨会话发送继续受 `agents:message` 权限保护。

验证结果：

- `npm run check`：2409 项测试通过、0 失败，产物校验通过。
- `npm run pack:delivery`：依赖审计 0 漏洞，实际包审计通过。
- 本机安装：`INSTALLED_AND_FILES_VERIFIED`，目标宿主 `0.2.1-rc.5`。
- 安装目录：`C:/Users/Allei/.dsh/profiles/desktop/node_modules/dsh-noemaloom`。
- 安装过程未启动、重启或终止 DSH；用户已在安装前退出 DSH。

未覆盖事项：本轮没有自动启动真实用户 Desktop，也没有修改会话数据库；重新打开
DSH 后可在主代理或子代理输入栏点击“延时”验证完整交互。现有 UTC 时间遮罩、
冻结重试、R40/R45 兼容、R40 子代理压缩、原生入口、三级范围隔离和 Claude 主题
均保留。
