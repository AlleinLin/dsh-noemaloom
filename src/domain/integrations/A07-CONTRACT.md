# A07 集成合同

工厂均接受 `NexusServices`，返回同一 dispatcher 可注册的模块：

- `src/domain/files/index.ts` → `createFilesModule`，id `files`。
- `src/domain/runtime/index.ts` → `createRuntimeModule`，id `runtime`。
- `src/domain/usage/index.ts` → `createUsageModule`，id `usage`。
- `src/domain/resources/index.ts` → `createResourcesModule`，id `resources`。
- `src/domain/integrations/index.ts` → `createConnectionsModule`，id `connections`。
- `src/adapters/search/index.ts` → `createSearchModule`，id `search`。

`createConnectionsModule` 返回额外的 `nativeRemote`：在官方 webServer 注册 exact upgrades `/ios/v1` 与 `/nexus/web/v1`，handler 调 `nativeRemote.handleUpgrade(req,socket,head)`。Host 停用时模块 disposer 会关闭全部 owned WebSocket、SSH 和转发。只有配对之后才能访问非握手方法。公开广播仅发送最小状态，不广播搜索查询、模型正文、账户凭据和 SSH 原始输出。

## 文件

路径相对 `context.workspaceRoot`，缺省 services.workspaceRoot。`read {path,offset?,maxBytes?,snapshotId?}` 返回 content 或二进制 base64、hash、revision、encoding、newline、truncated、nextCursor。`write {path,content,createOnly:true}` 创建，已有文件必须 `expectedRevision` 或 params.expectedHash。`edit/replace` 另需 oldText，内容使用 content/newText；多匹配默认拒绝。写入保留编码和换行，经同目录临时写/fsync/版本复核/rename/audit 完成，不制作原文件恢复副本。

`list/stat/mkdir/copy/move/rename/remove`、`search/glob/grep`、`watch.start/watch.stop/history`、`batch.read/batch.edit/batch.plan/batch.run/batch.resume/cancel`、`result.page/result.release` 和 `capability.discover` 提供实际实现。扫描具有 snapshot、结果引用、页完整与扫描完整区分、预算和 off 模式。

`table.read` 读取 CSV/TSV 引号与跨行字段；`doc.read` 抽取 DOCX 主文档、表格结构和关系（不承诺完整页面排版）；`pdf.read` 使用 PDFParse 提取文本与页码，空文本报需要 OCR。`archive.list/read/create` 支持 ZIP、TAR 和 TAR.GZ；拒绝链接、目录穿越、重复条目和展开超额，不自动解压工作区。

## 运行与 Git

`shells` 返回真实可执行路径、identity、版本与 available。Windows Git Bash 不接受 WSL/System32 假 bash。`shell.run {shellId,command,cwd?,background?,timeoutMs?}` 使用匹配 Shell；`terminal.run {command,args:string[],cwd?,stdin?,background?}` 使用唯一受批准执行器。持久 PTY 通过正式 host `terminal.*` seam；缺失时返回能力错误。`jobs.list/get/cancel` 保留真实退出、取消、截断和逐作业所有权。

Git action 前缀为 `git.`，包含 status/diff/log/branches/refs/show/stage/unstage/commit/discard/checkout/pull/push/revert/cherry-pick/continue/abort/worktrees/worktree.create/worktree.remove。log 默认 200 条，commit message 从 stdin 传入。写操作受审批和串行队列，支持 expectedSnapshot，删除主树拒绝。

## 用量与账户

Host 每次真实模型尝试调用 `usage.record {attemptId,logicalCallId,sessionId,provider,model,usage,status,startedAt,completedAt,role,providerRequestId?,source?,usageRevision?,isFinal?}`。唯一键为 logicalCallId+attemptId；流式最终替换，所有重试分别保留，迟到旧 usageRevision 无效果。Host camel inputTokens 为互斥 uncached bucket，绝不再减 cache。missing 与 invalid 保持独立；unknown 不补零。

`summary/list/live/estimate/export` 读取同一账本。`prices.save/list` 保存版本、provider/model、币种、effectiveAt、来源与十进制每百万四桶价格；币种分开，缺价为 unknown，计算成本不冒充实际账单。估计另表，不加到 reported。

`accounts.save/list/refresh/remove` 保存 credentialRef 与受限 monitor；保留所有 13 上游适配器。后台 5 分钟刷新、有单飞/退避/陈旧成功值；OpenRouter 使用 Management Key，OpenCode 本地 auth 只有显式开启才读。自托管只授权指定 origin+解析地址。

## 搜索

`configure {id:keenable|exa|tavily,credentialRef,enabled?}`，`status`，`query {query,maxResults?:1..20,timeRange?:day|week|month|year,providerPolicy?:balanced|preferred|all}` 与 `fetch {url,maxChars?:1..50000,live?:boolean,providerPolicy?}`。唯一调度器支持 round-robin、失败切换、全局 45 秒/单源15秒、并发2、401/429冷却、成功空结果不额外重查、规范化错误和缓存来源。URL DNS 全量检查并固定连接地址，重定向重新验证，网络压缩/展开预算独立于展示字符数。

## 连接

`save/list/get/remove/test/test.batch` 配置 ssh/remote/github/channel/mcp/webhook，只允许凭据引用。SSH `ssh.import.preview/apply` 有 Include 深度/循环和 Match/wildcard 跳过说明；`ssh.connect/disconnect/test/exec/sftp/forward.start/list/stop/cluster` 为 ssh2 实际连接，host key 指纹审批固定、密码/私钥/agent/passphrase 从宿主解析、ProxyJump 多跳、转发只绑定 127.0.0.1。

`native.pair.token/native.devices/native.revoke` 为原生协议；`remote.pair/remote.devices/remote.revoke` 为 Web 协议。两种 token 不通用，均经 P256 `hello→pair.begin→pair.finish`。`remote.connect/status/disconnect/invoke` 为另一个 Nexus Host 的实际认证握手和有限领域转发；只配置 origin，不硬编码 Desktop 随机端口。

`github.issues/issue.create/issue.update/issue.comment/pulls/pull/request` 使用受限仓库 HTTPS transport、独立凭据引用、写审批与审计回执。`channel.send/history` 使用指定连接，只有实际远端成功响应才记 delivered。通知走宿主 notification seam。
