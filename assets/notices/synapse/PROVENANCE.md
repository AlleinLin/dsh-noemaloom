# Synapse 复用说明

上游 dsh-synapse 0.4.2；来源为来源锁中的 `SRC-21 / dsh-synapse-main`，许可 MIT，完整许可与版权保留于同目录 `LICENSE`。

`projection.ts` 实质改写 `index.js` 的 WorkspaceStore 投影逻辑：保留一次会话/轮次只生成一个节点、child-before-parent 修复、源变化检测、编辑镜像保护，以及隐藏状态在重新扫描后仍保持的行为。持久化由 NexusStore 的 CAS 和图事务统一承载，不再安装独立 workspaces.json 写入器或定时器。

上游 `index.js` SHA256：`9B76FC3A7F1AC32481DF0590FA6DCB616CDE894A4FE14277F80084069C8B9D45`。

不复制上游旧 webServer 拦截器、内部客户端 injection 或 profile patch；由本产品统一认证 Connection 与客户端 slot 适配完成宿主接入。
