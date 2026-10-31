# R45：模型 UTC 时间遮罩

目标宿主为官方 Desktop **0.2.1-rc.5**。上游检查覆盖 153 项来源；最新公开候选仍为
`0.2.2-alpha.2`，没有可验证的正式 Desktop 目标，因此没有混用 alpha 宿主或同源 SDK。
Forge 仍是原创本地 companion，没有独立可核实的远程发布源。

本轮新增默认开启的 `nexus:utc-time` 模块：在 `system-prompt/assemble` 的最终模型输入中
移除已有的本地/宿主/浏览器时间和时区片段，追加当前 UTC/GMT ISO 时间与 UTC 调度规则。
宿主内部的 `clientTimeZone` 只保留在路由元数据，不进入模型提示。待办默认日期和返回的
`timezone` 已改为 UTC；用户要求北京时间时由模型从 UTC 做算术换算后展示。

验证结果：

- `npm run typecheck`：通过。
- `npx tsx --test tests/utc-time-context.test.ts tests/workflow.test.ts`：36 项通过。
- `npm run build`：通过。
- `npm run check`：2406 项测试通过、0 失败；产物校验通过。
- `npm run pack:delivery`：依赖审计 0 漏洞，桌面包已生成。
- 本机安装：`INSTALLED_AND_FILES_VERIFIED`，宿主 `0.2.1-rc.5`，未启动或重启 DSH。

未覆盖事项：本轮没有自动启动真实用户 DSH，也没有修改会话数据库；需用户重新打开
桌面后确认提示诊断中的 UTC 上下文。安装期间宿主依赖 `cpu-features` 的可选原生构建
报告了 `enable_thin_lto` 配置告警，但 Noemaloom 关键文件摘要全部匹配。
