# 04 开发工作流、技能、工具与多代理编排规格

规格版本：0.1.0。日期：2026-10-19。工程根：`D:\dshplugin\plugin`。本章以可开发、可测试的行为合同描述综合插件的工作流域，细度按“净室软件开发级别”要求组织；不要求实际净室隔离，不禁止在合法范围复用源码。开发可组合现有模块；实现路线和素材许可分别留档。研究证据见 [04-workflow-evidence.md](../research/04-workflow-evidence.md)。

本文定义的 `wf_*`、`WorkflowRuntime`、对象 schema、状态与事件均为**新插件自身拟定的内部接口**，不是宣称 DeepSeek Harness 官方已经提供同名 API。`wf_*` 只作实现别名与本章行为索引；对模型的会话固定公共 surface 只经 `nexus_workflow`、`nexus_quality`、`nexus_review`、`nexus_files`、`nexus_agents`、`nexus_artifact` 等 dispatcher 暴露，最终名称、action 和 schema 由第 09 章全局注册表裁决。正式宿主集成以平台章节核实的官方版本、注入服务、工具输出合同、Desktop 安装所有权与许可机制为准。社区源码中的旧 `ctx.*` 只能作为迁移线索。所有旧功能均须保留或重建；停更、版本落后、旧预设目录失效不能作为删除依据。

## 1. 范围、角色和不可混淆的概念

### 1.1 工作流域必须提供的能力

工作流域包括：Git/SVN 工作副本与历史审查、全项目审查、辅助上下文和证据回执；方法包/技能/提示词/persona/会话预设；专家目录、专家团、普通子代理、宿主原生团队、长期独立会话与外部 CLI；DAG 计划、任务预算、等待、取消、恢复、重试和审计；待办与经验提炼成技能；有界文件搜索/读写/批处理/文档读取/结果引用与 Native/PTC 投影；素材画布；HTML 交互图、explainer、Mermaid、导出与安全预览；广播房间、文件/服务声明、旁观评审、通知渠道、书签与历史搜索等交叉工作台能力。

记忆召回/写回算法、对话 DAG/回退恢复引擎、完整 UI 设计令牌和账户计费属于相邻章节。此处定义它们与任务/技能/产物的接口，不另造第二套记忆真源或会话日志。凡任务结果进入记忆，使用主规格记忆写入策略并保留原始来源；凡恢复工作区文件，使用回退域的恢复计划与救援点，不用本章 `remove` 模拟恢复。

### 1.2 使用者与执行主体

使用者是正在操作 Desktop 的人；主会话 agent 代表使用者完成当前已授权任务；子代理是有 parent/run 关系的受限执行者；专家是一种可选 persona 与能力描述；专家团是职责和协作模板；独立会话是可长期持久、能由人接管的宿主会话；外部 CLI 是由用户机器上另一个程序执行的作业。专家不天然有额外工具权限，团队不天然获得全盘文件访问，后台运行不天然获得自动发送通知或升级软件的许可。

系统不能混淆以下资产：

| 对象 | 作用 | 激活后影响 | 禁止的隐式效果 |
|---|---|---|---|
| Skill | 某任务的可复用步骤、资源和工具使用说明 | 被显式/自动路由加载后提供指导 | 安装即执行脚本、自动修改项目规则 |
| MethodPack | 多个 skill 与路由/检查纪律的版本化集合 | 选择风险策略、推荐步骤与证据格式 | 取代宿主权限、宣称拥有最终完成裁决权 |
| PromptTemplate | 可搜索、填参和定次注入的文本资产 | 在指定会话/轮次增加带来源的指令或材料 | 冒充用户、永久写入系统提示而无记录 |
| Persona | 角色视角、领域职责、输出偏好 | 限定一个执行者的身份和分析重点 | 替换父会话人格、扩权或再递归召唤 |
| AgentPreset | 宿主组合的工具/技能/persona/模式集合 | 新会话创建时决定正式 agent plane | 写已废弃目录后宣称安装成功 |
| TeamTemplate | 成员角色、分工、目标与交付约束 | 编译为计划节点与协作规则 | 选择团队即自动发送任务 |
| TaskPlan | 一次任务的 DAG、范围、预算与后置条件 | 审核通过后产生可运行的 Run | 修改已运行任务范围且沿用旧确认 |
| Artifact | JSON/HTML/报告/图片等可定位产物 | 被引用、预览、导出或按需读入 | 文件存在即自动注入模型上下文 |

## 2. 总体架构与复用落点

### 2.1 模块边界

新包内部至少分为 `workflow-domain`、`review-domain`、`asset-domain`、`file-kernel-adapter`、`cli-adapter`、`artifact-domain`、`host-adapter`、`workflow-ui`。这些是逻辑模块，不要求各自成为 npm 插件；最终只有一个安装、配置、升级和卸载入口。domain 不能 import 宿主 UI、进程全局 singleton 或另一个插件的内部 registry。宿主 adapter 对每个支持版本给出 capability facts，domain 仅接受标准化能力与授权结果。

| 上游 | 优先复用的模块 | 组合方式 | 必须改造的部分 |
|---|---|---|---|
| Code Review | VCS capture、固定版本身份、context identity、primary input、coverage、后台审查作业、模型协议校验 | 保留其只读核心，工具/模型/存储接统一 adapter；许可允许的发行中可直接移植 | 授权不再由一个无条件 true 回调代表全部能力；统一作业身份；商业用途许可条件另存发布清单 |
| Aegis | 方法包目录、风险分流、项目基线/ADR/反熵/续接、DSH 薄引导与诊断 | 作为版本化 MethodPack，可按用户选择启用 | 合并入口路由、去重持续注入、保持方法建议与运行时权限分离 |
| Agency Agents | 专家/团队 schema、library、运行引擎选择、草稿并发保护、编辑 UI | 资产库与调度器共享统一 ID/revision，persona 可独立内容包 | 旧版本 persona 注入/工具过滤集中于 host adapter；取消与预算接统一 Run |
| OPS | Rust 文件/文档内核、schema catalogue、结果引用、Native/PTC 投影、错误/效果回执 | 一套内核与两种投影；发现服务只选择能力不执行 | 与宿主 sandbox/approval/jobs 重绑；不默认全局隐藏宿主工具；老后台能力迁移为可选执行模式 |
| Superpowers DSH | 按需 provider、15 技能、诊断资产与工具映射 | 和 Aegis 去重成 MethodPack 变体，保留所有独有步骤 | 补齐许可证来源、保留用户技能优先、诊断读取真实 transcript 须受授权根限制 |
| Archify | typed IR、十类 renderer、explainer、validator、局部 diagnostics、Viewer/原子交付 | 内置 artifact pipeline，工具入口为新插件自有能力 | 正式 Desktop 文件产物桥、隔离预览、许可筛选后的图标/字体清单；纯 skill adapter 不当 native 工具 |
| J-Space | preset composition、认知模块、控制器/账本、完整性工具 | 可选预设和方法模块，使用正式 bundle；保留周期完整重读选项 | 将第三方引文与自有内容分离；旧团队/目录接缝更新；重读成本受预算显式约束 |
| Memory Evolve | todo、skills、prompts、session-orch、COI、broadcast、canvas、search-docs、advisor、notify 等 | 各 service 迁入新域，前端从 TSX 源重建 | 统一身份/权限/错误；撤销自动评审冒充用户来源；修复排序/丢预设/工作区 attach 竞态 |

复用必须记录 upstream repository、完整 SHA、导入文件、原许可、修改摘要、依赖许可证和再发行条件。保留必要上游版权及 NOTICE；新增代码使用最终工程选定许可。对未确定的商业定位，以发布配置选择“非商业含 W1”或“获商业授权含 W1”或“独立实现 W1 行为”；研究阶段不因此停工。涉及未授权第三方引文、推理片段、品牌资产时只阻止该材料进入发行包，功能本身仍须通过自有材料实现。

### 2.2 宿主能力探测与门槛

每次加载形成 `HostCapabilities` 快照：hostVersion、carrier（desktop/web/headless）、平台/架构、profileIdentity、schemaAdapterVersion，以及 tools/skills/agents/subagents/nativeTeam/sessions/sessionFork/jobs/sandbox/approval/settings/artifactUi/PTC 等状态。每一项状态为 available/disabled/unsupported/unverified，并带官方证据引用或运行探针结果。没有发现官方服务名不允许由字符串猜测创建服务；未核实接口在 UI 标“待适配”，用已验证等效路径恢复功能，不能显示成功。

用户必须能看见：任务将用普通子代理、原生团队、独立会话还是外部 CLI；是否持久化；哪个模型；工作目录；哪些文件读写与外部目标；计划预算。探测不发送源码、不登录 CLI、不建立外部通知或自动下载 runtime。

Desktop 安装/更新归宿主拥有者管理；工作流模块只产生可检查配置/诊断，不在任务执行中修改 profile。PTC loader 必须使用宿主已有的正式沙箱代码执行服务，不新增不受宿主控制的 `eval` 通道。

## 3. 公共对象、schema 和错误合同

### 3.1 公共信封

所有工作流自有工具输出都必须对应严格 schema。推荐拟定形状：

```ts
type WfOutcome<T> = {
  contractVersion: "1";
  requestId: string;
  status: "completed" | "partial" | "accepted" | "running" |
          "rejected" | "failed" | "cancelled" | "unknown";
  effectState: "none" | "observed" | "applied" | "partial" | "unknown";
  data?: T;
  error?: {
    code: string;
    message: string;
    retry: "never" | "after_refresh" | "after_authorization" |
           "after_backoff" | "after_inspection";
    nextAction: string;
    field?: string;
    detailsRef?: string;
  };
  coverage?: {
    scanComplete: boolean;
    pageComplete: boolean;
    observed: number;
    total?: number;
    skipped: number;
    failed: number;
  };
  continuation?: { cursor: string; expiresAt: string };
  receipts: ReceiptRef[];
};
```

该信封是本产品合同；如当前官方 tool output 要求不同，host adapter 必须无损映射并保持 Native/PTC 事实相同。`accepted`/`running` 不能渲染成“已完成”；`completed` 只表示该操作完成，审查覆盖/模型语义/交付质量另有字段。`effectState=unknown` 时 UI 必须给“检查状态”入口；默认重试按钮不可直接重复变更。

时间存 UTC ISO-8601，显示使用用户时区 Asia/Shanghai 或用户明确设置；deadline 日期保留 date-only 和原始时区。ID 使用不可复用的随机标识，不能依赖毫秒时间戳唯一。每个持久对象含 `schemaVersion`、`id`、`revision`、`createdAt`、`updatedAt`、`ownerScope`、`provenance`；更新要求 expectedRevision。字符串按字段规定长度，不能混用 UTF-16 length 与用户码点/字素上限。用户输入与资产正文原样保留；搜索可以另建规范化派生索引。

### 3.2 数据对象最小字段

| 对象 | 必须字段与约束 |
|---|---|
| TaskPlan | goal、scope、nodes、edges、budgets、deliveryContract、authorizationRefs、ownerSessionId、projectId、revision；节点 ID 唯一，DAG 无环，引用必须存在 |
| TaskNode | kind（review/prompt/tool/agent/session/cli/manual/approval/synthesis/merge/export）、executorRef、briefRef、inputRefs、outputContracts、dependencyPolicy、writeClaims、timeout、retryPolicy、budgetReservation、state；`status` 仅为旧格式迁移别名 |
| Run | planId/planRevision/planHash、initiator、hostCapabilitySnapshot、routeSnapshot、startedAt/finishedAt、terminalReason、nodeRuns、usage、coverage、artifactRefs |
| Budget | maxConcurrent、maxNodes、maxDepth、maxChildren、maxModelCalls、maxInputBytes、maxOutputBytes、maxBytesRead、maxBytesWritten、maxTokens（input/output/total）、maxCost、maxWallMs、deadline、maxRetries、maxNotifications、hardOrAdvisory；无法测量费用时不声称硬成本上限有效 |
| Receipt | action、subjectIdentity、beforeHash/afterHash、effectState、sourceVersion、toolVersion、authorizationRef、started/ended、warnings；敏感正文另存受控 artifact |
| ReviewPreview | repositoryIdentity、mode、left/right、snapshotManifest、selectedPaths、excluded/blocked、context/rules/callers、route、budgets、expiresAt、previewHash、sessionBinding、authorizationState |
| Finding | candidateId、reviewRunId、severity、title、trigger、impact、location、evidenceRefs、counterEvidenceRefs、verificationState、dedupeKey、confidenceMeaning |
| Asset | kind、displayName、summary、tags、locale、source、licenseRecords、contentHash、contentRef、enabled、invocation、scope、revision |
| Todo | scope、project/branch/date、content、status、quadrant、due、category、assignee、linkedNodeId、completionEvidenceRefs、archivedAt |
| CliAdapter | binaryIdentity、versionRange、argvTemplate、promptTransport、cwdPolicy、envAllowlist、resumeStrategy、imageStrategy、outputParser、cancelStrategy、defaultBudgets、license/attribution |
| CanvasNode | type、ownerScope、pathOrAssetRef、noteRef、geometry、provenance、visibility、contentHashWhen Pinned；模型不通过 x/y 获得内容权限 |
| ArtifactManifest | mediaType、sourceIRRef、rendererVersion、validationResults、contentHash、absolutePath、scope、safePreviewMode、licenses、lastGoodRef、exportVariants |
| RoomMessage | senderSession、senderAgent/plugin 来源、room/member target、subject、bodyRef、attachments、ack/received/read timestamps、idempotencyKey；不能变成匿名 user message |
| WriteClaim | normalizedProjectPath/resource、intent、ownerNode、leaseExpiresAt、source declared/observed、exclusive/advisory、releaseReason；声明不是 OS 文件锁 |

### 3.3 错误分类

严格入参拒绝 `INVALID_ARGUMENT`、`UNKNOWN_FIELD`、`MUTUALLY_EXCLUSIVE_FIELDS`；对象与权限错误 `NOT_FOUND`、`SCOPE_MISMATCH`、`AUTHORIZATION_REQUIRED`、`AUTHORIZATION_EXPIRED`、`HOST_CAPABILITY_UNAVAILABLE`；一致性错误 `REVISION_CONFLICT`、`SNAPSHOT_STALE`、`SEARCH_STALE`、`DESTINATION_EXISTS`；资源与运行错误 `BUDGET_EXHAUSTED`、`RATE_LIMITED`、`TIMEOUT`、`CANCELLED`、`PROCESS_EXIT_NONZERO`、`PROCESS_EFFECT_UNKNOWN`；模型与文档错误 `MODEL_PROTOCOL_INVALID`、`EVIDENCE_MISMATCH`、`FORMAT_UNSUPPORTED`、`TEXT_LAYER_UNAVAILABLE`、`METADATA_UNSUPPORTED`；产物错误 `IR_INVALID`、`LAYOUT_INVALID`、`PREVIEW_DENIED`、`EXPORT_UNAVAILABLE`。

错误必须给可操作的下一步，不把账号密钥/命令全环境/敏感正文放在 message。相同错误重复两次不自动更换权限更强的工具“绕开”；允许更换等价 provider，但必须保持读取范围、身份、预算和 provenance。部分结果保留可用数据与未完成列表；不得因为有一份成功结果丢掉其他失败。

后文叙述中的 `conflict`、`stale_cursor`、`unsupported`、`resource_limit`、`expert_recursion_denied` 是内部原因标签，对公共错误分别映射 `REVISION_CONFLICT`、`SEARCH_STALE`、`FORMAT_UNSUPPORTED/HOST_CAPABILITY_UNAVAILABLE`、`BUDGET_EXHAUSTED`、`SCOPE_MISMATCH`，并在 `details.reason` 保留原标签。模型公共 envelope 不引入第二套大小写混用错误枚举；最终映射由第 09 章错误注册表裁决。

## 4. 工具 surface 与名称空间

### 4.1 发现与版本

`wf_` 前缀仅用于内部 handler/能力 ID，禁止把第 4.2 节每一行都注册为模型独立工具。模型在一个会话中固定看到第 09 章裁决的公共 dispatcher，description、schema 和注册顺序不得随所选模块、任务状态或资产目录动态改变。dispatcher 用稳定 `action` 与按需返回的 `capabilityId` 路由；内部别名变化不改变公共 surface。工具 catalogue 是 schema 单真源；Native description、PTC binding、UI 表单、参数文档和 telemetry 事件均生成自同一声明。能力分基础与按需发现：发现一次最多返回三个最相关能力和简短约束；可显式按内部 capability ID 选择，最多五个。选择能力只加载其参数说明/资源或授权快照，不执行动作，不新增会话工具名，不让当前 PTC 代码误以为 snapshot 已更新。

所有工具使用严格对象 `additionalProperties:false`；枚举/互斥/默认值在 schema 和运行层一致。路径统一 `path`、目的 `to`、读取根 `rootRef`；禁止同工具同时接受 `file_path/cwd/workspace` 别名造成歧义。公开工具名修改必须提供旧名可见迁移映射，旧名执行仍进入同权限合同，不另保留不受控旧注册器。

### 4.2 内部能力组及公共 dispatcher 映射

下表第一列是内部别名。默认映射为：`wf_plan/run/status/wait/cancel/retry/todo/prompt_apply` → `nexus_workflow`；审查预览/执行 → `nexus_review`；方法治理与技能提炼 → `nexus_quality`；文件与文档 → `nexus_files`；专家/团队/会话/CLI/房间/claim → `nexus_agents`；canvas/图表/产物/结果引用 → `nexus_artifact`。资产、通知、历史与 advisor 的跨域 action 由第 09 章注册表最终分派；不得因此另增临时工具。`wf_discover` 对应公共 discovery action，不是另一个独立注册。

| 内部别名 | 主要输入 | 主要输出与副作用 |
|---|---|---|
| wf_discover | query 或 names、presentation | 能力摘要、可用状态、下一步生效；无业务副作用 |
| wf_plan | goal、nodeSpecs、edges、scope、budgets | 校验后的计划/风险/所需能力；不执行节点 |
| wf_run | planId、planRevision、idempotencyKey、authorizationRef | Run ID 与启动结果；启动不等于完成 |
| wf_status | runId、sinceEvent、include | 当前节点、预算、artifactRefs、终态；受 ownerScope 限制 |
| wf_wait | runId、afterRevision、timeoutMs | 状态变化或超时快照；默认 30 秒、最大 60 秒，用户输入可中断等待 |
| wf_cancel | runId、nodeId?、reason | 取消确认/未停止项/已完成结果；操作幂等 |
| wf_retry | runId、failedNodeIds、inspectionRef?、authorizationRef? | 同范围新 attempt；效果未知必须有检查回执 |
| wf_result | action page/release、resultRef、cursor | 当前 scope 的受控分页；释放不删除不可变审计 |
| wf_review_preview | VCS/mode/端点/选择/context/route/budget | 固定 Preview、覆盖风险、发送披露；不调审查模型 |
| wf_review_execute | previewId、authorizationRef、idempotencyKey | 引用同一 Review Run，不接受范围覆盖参数 |
| wf_assets | action list/get/create/update/enable/disable/import/export | skill/method/persona/prompt/preset/team 元数据与版本化更改 |
| wf_prompt_apply | templateId/revision、bindings、target、schedule | 注入计划/实际生效事件；不能冒充用户 |
| wf_todo | action、target/scope、fields、expectedRevision | 待办查询/变更/归档与来源 |
| wf_skill_propose | evidenceRefs、name、draftRef、overwriteTarget? | 待审核候选，默认不激活 |
| wf_session | action spawn/wake/list/status/rename、identity、briefRef | 正式宿主会话标识/运行状态/工作区归组回执 |
| wf_cli | action adapters/plan/dispatch/status/wait/cancel/resume | 外部作业合同和结果，安装/登录另走用户操作 |
| wf_room | action create/join/leave/list/send/read/delete/dissolve/kick/presence | 带来源房间协作；发消息权限取决于当前任务授权 |
| wf_claim | action declare/status/release | 文件/服务所有权协调、冲突与租约 |
| wf_canvas | action list/get/add_note/add_ref/update/move_scope/remove | 素材板 CRUD；模型只读获准节点，默认不注入 |
| wf_artifact | action validate/render/deliver/preview/export | typed IR 与生成产物、诊断、精确路径 |
| wf_notify | action plan/send/status、channelRefs、attachments | 通知/直发逐渠道结果；未来执行时遵守用户明确授权 |
| wf_session_search | sources、roots、query、project、sort、limit/window | 只读授权历史摘录，保留来源与格式支持 |
| wf_advisor | action enable/disable/reset/review/accept/dismiss | 旁观评审建议与采纳记录，独立来源 |

文件内部 handler 对应 `wf_read_many/inspect/grep/glob/stat/diff/write/edit/edit_many/replace/copy/move/remove/batch/table_read/doc_read/pdf_read`，全部经固定 `nexus_files` dispatcher。旧 `code_review_*`、`ops_*`、`de_*` 和 `dtodo` 仅在导入旧技能时解析为能力 ID；迁移映射不向模型注册旧名或几十个兼容别名。第 4.2 节和后文的点号 API 同样表示内部接口或公共 dispatcher 的 action path。

## 5. Git/SVN 审查行为

### 5.1 入口、预览与发送授权

审查入口包括当前会话工具、命令与审查面板，必须产生同一 ReviewPreview。第一阶段发现仓库与选区、读取固定证据并生成可审阅范围；第二阶段使用该快照调用模型并交付报告。若用户已经明确授权某范围和模型审查，授权记录可直接匹配 preview，不重复询问；若授权不完整，应先把可读预览做具体，再请求缺失的发送或网络范围。规格的两阶段协议不意味着每次调用工具都新增无意义确认，也不意味着一个模型传 `confirmed:true` 就等同于真实用户授权。

预览必须显示：本地仓库绝对根、VCS、仓库身份、比较左右侧/固定 revision、选中节点数、辅助上下文/规则/调用方来源、预计发送模型与 provider、模型调用/读取预算、独立 review rounds、并发、排除和阻断原因、网络读取、快照散列、有效期。默认有效期五分钟，可配置 1–30 分钟；previewId 绑定创建会话、项目和 route。更改模型、端点、规则、范围、网络或预算上调均需新 Preview；减小预算也形成新 revision 以准确回执。

execute 仅接受 previewId/授权引用/幂等键。执行前验证 repo identity、固定对象、工作副本 hash/manifest、model route 和授权；变化返回 `SNAPSHOT_STALE` 并保留旧预览，不自动拓宽。执行中源变化不污染已捕获快照；报告仍明确基于旧快照，结束验证发现变化则 `outdated=true`。任何预览/审查都不 commit/stash/reset/checkout/update/merge、修改索引或运行项目代码。只读审查若需要动态测试，必须另建获准 tool node，报告分清静态与执行证据。

### 5.2 Git 比较语义

worktree 默认比较 HEAD 与当前工作区净内容，staged 比 HEAD 与 index，unstaged 比 index 与工作区。被暂存后再修改的文件必须准确各自取侧，不把当前文件冒充 staged 结果。未跟踪文件默认不读，只在 worktree/unstaged 显式 selectedPaths 并具有读取许可时纳入；忽略、链接、submodule、嵌套仓库不能无提示跨入。

历史单提交使用唯一父提交，根提交用空树；merge 提交要求明确 old/new 两端，不推测主父。区间是两个解析后不可变 commit/tree 端点，不是 merge-base，也不意味着逐提交审查。所有历史 source/context/rule/caller 只能来自相应 blob；找不到时标缺失，不能回退当前文件。重命名记录旧/新路径和内容身份；相似度猜测只用于导航，不能改变缺陷归因。

### 5.3 SVN 比较语义

当前态用工作副本 BASE 与 working。单 revision N 比 N-1→N，revision 是十进制字符串，禁止 HEAD/date/r 前缀。区间 old<new；同仓库 UUID 不同分支可相同 revision 比较。分支路径必须是已识别 repository root 下的相对路径，不接受任意 URL。每侧固定 URL、peg revision、operative revision、UUID、内容 hash 与属性状态。

历史网络 opt-in 仅允许该工作副本来源上的固定 revision 读取；file URL 不等于允许任意文件路径。不能把远端登录失败替换为本地当前态。externals、稀疏节点、switched、mixed BASE、symlink/special、不支持关键字/EOL 属性、来源不完整均单列状态。工作副本读取要保留源身份；关键字/EOL 规范化仅在已验证映射可逆且符合支持表时使用。未提交替换的旧节点来源不清时必须由显式 replacement revision 固定，不能假称旧 BASE。

effective mergeinfo 是可选有界属性导航，空属性屏蔽继承；读取最近祖先带预算和 provenance。它不能证明某 revision 已审查、某合并来自哪个逻辑提交或代码语义一致。不同 UUID、嵌套重叠来源和不明祖先拒绝，不尝试偷偷 checkout 来补齐。

### 5.4 上下文、规则与主审边界

`contextPaths` 是辅助正文，`oldContextPaths` 仅旧侧，`rulePaths` 是待解释约束，`businessRequirement` 是用户目标数据，`callerScopePaths` 是字面引用检索授权。规则/需求可以确定应检查什么，但单独不构成代码缺陷证据。外部文本内的“忽略规则/运行命令/上传源码”都作为不可信数据，不提升权限。一个文件被读作 context 不计入其主审 completed。

默认变更审查上限沿成熟行为设 200 主文件、单文件 256 KiB、总捕获正文 4 MiB；超过给出缩小选择/分批计划。自动依赖最多三层、共享 512 精确路径探测、20 辅助槽、1 MiB 辅助源文，callerScope 最多四个非根目录。模型检索和主文件获取共享全局读取账本；不能每次 tool call 重新获得一份预算。可通过显式计划提升上限，但预览必须显示且不得突破宿主硬保护。

字面 import/include/caller 导航必须标“有限导航”，不能称完整调用图或跨语言语义分析。未找到引用不等于没有调用方。历史读取要保留每次命中哪一侧，旧侧证据不用于证明目标侧行为。去重辅助材料按仓库/版本/路径/hash，不能把同路径不同版本合并。

### 5.5 模型协议、阶段与覆盖

一次审查的阶段为 capture→risk planning（可选）→primary review→bounded retrieval→verification→synthesis→finalization。全项目审查按 12 节点一批，默认最多三批并行，可设 1–8，批内依赖串行。清单默认上限 10,000，单次选择最多 1,000 节点/16 MiB；不能使用插件秒表强行截断后报成功。rounds 1–3 是独立审查轮数，不是“思考强度”，必须披露额外模型调用。多轮发现合并时保留来源，不能把相同模型重复判断伪称独立专家一致。

模型输入/输出采用阶段严格 schema，不合法字段整批拒绝。完整结束但 JSON 无效可以最多两次明确请求纠正；主审实体/行证据错误至多一次完整纠正；均计总预算，不补括号、不猜枚举、不静默丢字段。提供方错误、取消、不完整结束、超长输出不进入 JSON 修复循环。检索请求若任一项非法，整批不执行并给有限纠正机会；不能“先执行合法部分”导致模型误解证据集。

每条候选包含可定位原文、侧、路径、版本/hash、行范围、触发条件、影响、主审发现和复核结果。复核为 supported/refuted/uncertain/incomplete；原文匹配不是缺陷真值证明。只允许同文件同侧唯一精确文本重新定位行号，保留原坐标与纠正原因；不能跨文件或模糊匹配。严重度语义统一 P0–P3 或工程选定等级，不能以“模型很自信”替代影响判断。

报告总状态 complete/partial/failed/cancelled/interrupted/outdated 与作业状态分别记录。文件状态 completed/excluded/blocked/pending；一份报告必须能核算选中总数。零 findings 只有覆盖 complete 时可写“本次已完成范围内未发现可确认问题”，不能写“代码完全正确”。综合未完成保留批内候选并标不完整，不强行生成一份确定总结。

后台执行 start 只返回任务 ID；调用方需 wait 到终态并统一交付完整报告。插件重启将运行作业置 interrupted，保留检查点，不能在重启后自动重发源码。恢复应重新检查授权/快照/预算，展示待重跑阶段。多会话可各自审同一仓库；单会话互斥但不使用全局 busy 阻断别的会话。

## 6. 技能、方法包、persona、preset 与提示词

### 6.1 资产发现与优先级

资产浏览先列 name/summary/tags/source/license/status/whenToUse，正文按需取；默认列表不回传全体 persona/skills 全文。Skill 兼容标准 SKILL.md frontmatter，要求 name/description，支持明确宿主的 model/user invocation 字段与 resourceBase；未知扩展字段原样保留在 metadata，但不能驱动未定义执行。解析 YAML 不执行标签表达式，不把用户导入技能当 Cordis 配置。

提供者不关闭宿主默认个人/项目技能根。相同 canonical name 的解决顺序必须可见：当前项目显式覆盖→用户显式覆盖→已选择自定义资产→包内资产；实际宿主 rank 由 adapter 映射。发生同级冲突应列出来源供选择，不随机采用文件遍历第一个。显示当前生效版本、被覆盖版本及原因，启停不删除原文。关闭本模块仅撤销自身 provider，不能让宿主所有其他技能消失。

导入支持本地文件/目录、已下载 ZIP、URL/仓库引用的“获取计划”；远程获取是独立许可动作，路径穿越、绝对路径、symlink、超量压缩比、重复条目拒绝。默认每包 32 MiB、2,000 文件、解压后 128 MiB，超限给明确资源错误；不运行 install/postinstall/脚本。导出含 asset manifest、版本、内容 hash、资源、许可证和来源，不导出 credentials/真实会话。

### 6.2 方法包组合与择优

统一方法包必须保留：需求对齐、项目基线建立、目标/验收框定、头脑风暴、规格/计划编写、当前会话执行、每任务新子代理、并行分派、根因调试、可选 TDD、完成证据、双向代码评审、工作树隔离、分支收尾、技能写作、transcript 复盘、ADR、反熵/旧路径退役、第一原则评审、长任务续接、UI/UX 治理、认知模块/控制器/账本/周期重读。

轻量任务由风险路由选 fast，不自动创建全部文档或代理；复杂/有状态/跨边界任务建议标准或严格。用户可以手动选 auto/explicit 激活和 TDD off/auto/strict；用户已明确要求严格测试时不得用 off 覆盖。方法包的建议呈现为“建议/检查清单”，真正写入、模型调用、计划模式切换、审批仍由宿主处理。即使方法包包含“必须先确认”文本，运行时应先检查用户已有授权与当前模式，不重复无关确认。

两个方法包同阶段重复时，生成一个合并步骤并列出来源：项目基线/风险分流优先 Aegis，调试/工作树/任务与整分支评审/复盘优先保留 Superpowers 的完整能力，J-Space 认知控制和账本作为可选附加。不得把提示词原样相连导致三份“最高指令”互相冲突。允许用户合规选择原版内容，不强制重写一切；修改版必须标差异与来源。

周期完整重读是可选操作，必须按正文实际 token 计预算，压缩归档只是存储传输，不宣称模型 token 压缩。控制器若需要 Python，先探测运行时并显示可用/不可用；无运行时仍能加载文字方法，执行按钮给安装指引但不自动安装。长任务续接应产出 checkpoint：目标、基线、决策、已验证项、未完成项、授权边界、预算和 artifact refs，不能只靠一份主观摘要。

### 6.3 专家与团队资产

必须支持 22 类以上可扩展分类、关键词/tag/source/enabled 筛选、中文/英文名称、用户自定义分类、单个专家和专家团、内置/导入/自有来源区分。331 是参考快照的内容规模而非数据模型上限；可合规内置、按需导入或自编同等类别。验收要求目录/路由/角色调用完整、所有来源许可透明，不要求把 331 篇正文机械复制。

专家有名称最多 40 码点、简介 160、persona 正文 20,000、emoji 一个扩展字素、头像引用和能力建议。自定义默认上限 200，可配置资源上限，不把限制写成数据库不可扩展常量。persona 不决定模型 key；模型默认继承主会话。禁用专家后不可新派任务，但已运行项依其快照完成；删除用软删除，历史引用保留。

团队 2–8 名不重复成员、自定义默认 100 团队；目标/约束/交付各 2,000 码点，成员职责 100、附加指令 2,000，1–3 个任务示例；协调文本可以模板或用户自定义，修改 revision CAS。内置五团至少覆盖产品/技术/内容/数据/专题研究。启用团所需专家未启用时，先展示依赖并由用户选择同时启用或仅本次使用；不悄悄永久改全部专家状态。

聊天选择团队、替换草稿或插入任务例子都不自动发送；确认期间用户改动草稿/附件/引用则旧插入中止并保留新草稿。切换语言不改自定义正文或未保存内容。主会话做协调和统一交付，不额外消耗一个“团长 agent”。默认普通模式并发四个、一次最多八个，任务 brief 默认 2,000 码点并可通过受控文本 artifact 传长内容。

### 6.4 提示词库与注入计划

提示词 list 支持 name/category/tag/description/general filter，多个条件取交集，get 返回正文与许可，create/update 要求 revision 和 provenance。启用状态仅控制新调用；禁用模板仍可查看旧版本。参数替换仅支持声明式 bindings，默认按文本插入，不能执行 `!!js`、模板代码或读取环境变量。未填必填参数拒绝，不把占位符原样送模型。

注入计划有 target session/node、template revision/hash、source actor、schedule、remainingRounds、everyTurns、activationStep、cancelledAt。支持一次、有限 N 轮、每 N 轮、持续直到撤销以及当前回合立即 steer；立即模式固定一次，不把 rounds=0 隐式解释成无限。持续模式必须有 UI 可见指示、暂停/撤销按钮和预算占用。

立即 steer 使用宿主正式消息/注入 API，带 `plugin:<new-plugin>`/agent 来源及原授权引用；没有正式能力则排队下一轮并明确状态，不写会话日志伪造。旁观评审或外部 CLI 输出只能作为建议材料，不能以 user 身份自动执行。模板加载或持续注入不新增文件/网络/通知权限；子代理继承哪些模板在计划快照中明确。

### 6.5 技能经验提炼与审核

技能候选来源于重复工作流、用户明确保存的经验或已完成任务证据。候选包含适用条件、不适用条件、步骤、输入输出、命令示例、风险/权限、验证、来源 evidence refs、生成模型与版本。必须去除凭据、个人数据、一次性路径、会话 ID、未经许可的第三方长文本；不能把失败轨迹当成功经验。相似主题优先建议补丁，不能每个任务生成一个同义 skill。

默认流程 proposed→screening→pending_review→approved/rejected→published→retired；用户可以对自己明确授权的可信范围开启自动发布，但该策略可见且可撤销。approve 前提供完整 diff、资源清单、许可和验证建议；批准写入 canonical skill 根，原子替换、CAS，先落盘成功再启用。更新已有 skill 要先读其当前版本，禁止覆盖未看过或已变化正文。拒绝保留审计与可选草稿，不自动删除用户已有 skill。

技能脚本的语法检查/单元测试是独立执行任务，按实际授权运行；文字技能可用离线 fixture/触发样例验证。不能因为没运行真实子代理测试而声称效果已证明。用户有手动编辑时以新 hash/revision 捕获，导入/更新不会绕过它。

## 7. 待办与项目行动项

待办保留 life/work/project/daily 四目标，支持全部查询、按当前项目/分支/日期、状态、四象限、deadline、category、文本关键词过滤。状态 pending/doing/blocked/done/cancelled，done 保留完成时间与证据；从 done 返回 doing/pending 保留历史事件但清除当前 doneAt。due 为用户时区日期，日期格式和真实日历都验证，不能接受 2026-02-30。

默认视图最多八条：逾期未完成→今日截止→重要紧急→重要不紧急→紧急不重要→其余，组内按 due/创建时间/ID 稳定排序；不得最后 reverse 把逾期沉底。旧 daily 中未完成无 due 的条目按其原日期判断过期，默认不挤满当前任务，提供“历史未完”单独入口；所有隐藏筛选都显示计数。

add/update/done/remove/archive 用稳定 ID 与 revision，删除默认软删或回收站，批量 clear 有可审阅范围。待办可以关联 TaskNode，但“节点返回零退出”不自动把人工待办 done；需要 deliveryContract 满足及 evidence refs。被取消作业关联待办保持 blocked/pending，并写原因。模型建议待办需带来源，不能无限自动创建提醒。

提醒仅依据 due 或用户建立的调度规则，日历提醒与长期自动化统一走宿主自动化域，不在本模块偷偷起 timer。导入原 Markdown 标签 `id/q1/due/status/cat/doneAt` 时保留未知标签与原正文，导出仍能人类编辑；冲突不全文件覆盖。跨进程写入用共享存储事务或锁，原文件有漂移时备份并提示合并。

## 8. DAG、多代理、会话与 CLI 编排

### 8.1 统一任务模型与状态机

每一次用户请求、工具调用、子代理或外部 CLI 都映射为一个 `TaskNode`。节点字段至少包含 `id`（带足够随机部分的 ULID 或 UUID）、`parentId`、`sessionId`、第 3.2 节定义的 `kind`、`engine`、`model`、`cwdRef`、`presetRef`、`inputRefs`、`outputRefs`、`budget`、`attempt`、`idempotencyKey`、`state`、`createdAt`、`updatedAt` 和 `eventSeq`。输入与输出正文默认保存为 artifact 引用，界面只按需取内容，避免在每次状态刷新时把长日志重新注入模型。`TaskPlan.nodes` 是计划定义，运行字段保存在 `Run.nodeRuns`；同一计划可产生多个 Run，不能把其中一次运行状态回写为计划模板状态。

状态为 `draft → queued → starting → running → waiting → succeeded`，并允许以下终态或中断态：`failed`、`cancelRequested`、`cancelled`、`timedOut`、`interrupted`、`effectUnknown`、`blocked`、`superseded`。`starting` 已经向引擎发出请求时，重试不得回到 `queued` 而直接新建同一幂等键的恢复尝试；引擎返回“已接受但无结果”时置 `effectUnknown`，必须先查询或人工处理，禁止盲目重复发送有副作用的 prompt、写操作和渠道消息。

DAG 边为 `dependsOn`、`produces`、`gates` 三类。依赖节点只有在所有必需边满足 `succeeded` 或显式允许的 `partial` 时才能入队；任一必需节点 `failed/cancelled`，下游置 `blocked` 并保存原因。可选依赖的输出必须标为 `missingOptional`，不能伪造空字符串。循环依赖在提交前用拓扑排序拒绝，错误中列出最短闭环路径。每次状态转移追加不可变事件，事件序号单调递增；读取者遇到序号缺口应重新拉取，而不是自行补齐。

状态转换及副作用遵循：

```text
queued --start--> starting --accepted--> running
running --needs-input--> waiting --input--> running
running --success--> succeeded
running --failure(retryable)--> queued (attempt+1, same idempotency key)
running --failure(nonretryable)--> failed
starting/running --cancel--> cancelRequested --ack--> cancelled
starting --lost response--> effectUnknown --reconcile--> succeeded|failed|cancelled
any active --host restart--> interrupted --resume check--> queued|blocked|effectUnknown
```

每一条边都要有 `actor`、`reason`、`authorizationRef` 和可选 `evidenceRefs`。只有宿主确认的取消才能转为 `cancelled`；插件自行停止轮询只可标 `interrupted`。用户界面必须能看到“正在取消”“等待引擎确认”等中间态。

### 8.2 引擎选择与递归边界

路由器按任务风险、是否需要独立上下文、是否需要工具、预算和用户策略，在普通 subagent、宿主 native team、独立 session、外部 CLI 四类引擎中选择。普通 subagent 适合短文本和共享会话上下文；native team 适合有正式成员、广播和并发收集的任务；独立 session 适合长任务、隔离凭据或需要单独历史的任务；CLI 只在用户已安装并授权对应 provider 且需要其特有模型/图片参数时使用。路由结果必须返回 `engineReason` 和不满足的能力，用户可以在提交前改选。

创建子代理过程中若宿主已返回远端 task/session ID，插件必须将节点定为 `starting/running` 并以原 ID 恢复查询；禁止因为 UI 超时或 attach 失败就切换另一引擎重新执行。真正未创建成功才可在仍未产生副作用的情况下重试，且重试事件标明“creation failed before acceptance”。普通专家persona默认是非递归、只读的咨询角色；未经授权调用 `spawn`、`team`、`channel_send` 或文件写工具时返回 `expert_recursion_denied` 或对应权限拒绝。第12章受控层级编排是显式独立策略：只有编译进冻结TaskPlan、获得递归capability、剩余深度/节点/预算/ownership均验证通过的执行角色才可派生后代，仍由同一调度器执行。persona文本本身不能解锁递归；此规则取代无条件禁止所有专家后代的旧表述。

### 8.3 spawn、wake、resume 与工作区竞态

`spawn` 必须继承父节点的 `model/provider/cwd/preset/locale/permissionProfile` 快照；子节点可以明确覆写模型和工作目录，但覆写要写入事件并在 UI 显示。未设置的字段不应因版本默认变化而漂移。`wake` 只唤醒已存在且状态为 waiting/interrupted 的节点，`resume` 需携带上次 checkpoint hash、未完成边和剩余预算；`continue` 表示在同一会话追加用户指令，不能误建新会话。

工作区 attach 是有竞争的异步操作。每个工作区有 `attachLease`（owner、leaseId、expiresAt、baseRevision）。获取 lease 失败时返回冲突双方和建议，不覆盖已有工作区；过期 lease 需再确认当前分支和文件哈希才可接管。子代理在工作区中写文件必须声明 write claim，声明只用于协作提示，不等同于文件锁，最终写入仍以原子 CAS 和冲突检测为准。任务关闭时释放 lease；进程崩溃由宿主回收过期 lease。

### 8.4 预算、取消、等待、重试与恢复

预算对象使用第 3.2 节唯一 Budget schema，至少对 `maxWallMs`、`maxModelCalls`、`maxTokens.input/output/total`、`maxBytesRead`、`maxBytesWritten`、`maxChildren`、`maxConcurrent` 和 `maxNotifications` 给有效值或明确 unlimited/unsupported。父节点给子节点预留预算后可用值立即扣减；子节点结束时仅将可证明未用的预留量通过事务归还父池，不能自己增加预算或重复归还。预算消耗写事件，显示已用、保留和可用值。超预算进入 `timedOut` 或 `failed`，不会以“成功但被截断”结束。

取消分三层：UI 请求、引擎取消、文件/渠道副作用撤销。请求后立即显示 `cancelRequested`；可撤销引擎收到 cancel ACK 后转 `cancelled`，无 ACK 到期限转 `effectUnknown` 并要求 reconcile。已经提交的渠道消息、已落盘文件和外部命令不能假设可撤销，需显示 effect refs。重试采用指数退避加抖动，按错误类型白名单；同一副作用节点最多一次自动重试，超过后要求用户选择“查询结果/强制重发/结束为未知”。

宿主重启时，运行节点全部变为 `interrupted` 并保留最后 checkpoint。启动恢复扫描节点与引擎状态，先验证授权、工作区 revision、预算和 provider 可用性，再按策略恢复。默认只恢复查询和无副作用等待节点；写文件、通知、删除、移动及外部 CLI 节点需要用户在 UI 看到待恢复清单后显式继续。重启不会自动重新发送源码、提示词或消息。

### 8.5 CLI provider adapter

适配器接口固定为 `describe()`, `newSession()`, `resumeSession()`, `continueSession()`, `sendPrompt()`, `sendImage()`, `cancel()`, `status()`, `collectLogs()`。内置 Kimi、Codex、Grok、Hermes 适配器提供参数能力矩阵，模型、图片支持、resume 语义和退出码映射由 `describe` 返回；用户可注册自定义 adapter，但只能使用允许的可执行文件白名单。命令参数以结构化 argv 生成，长 prompt 写入受限临时文件或标准输入，禁止把超长 prompt 拼入 shell 命令；临时文件在任务结束后按宿主策略清理并记录 hash。

`new/resume/continue` 的语义分别是建立新轨迹、从已知 session 恢复未完成任务、在同一轨迹追加指令。图片输入记录来源、mime、hash、尺寸和 provider 映射；不支持图片的 provider 必须在提交前报错。环境变量只允许引用宿主的已批准白名单，工作目录必须在授权根内。stdout、stderr、退出码、启动命令摘要、版本和时间写入审计 artifact；凭据、完整 token 和敏感环境值全部脱敏。

CLI 数据作用域保留 `session/project/global/temporary` 四种：session 为当前会话私有；project 受项目 ACL；global 为当前用户全局，默认不跨用户；temporary 随保留期到期清理。作用域只决定存储和可见范围，不代表已同意注入。`injectionPlan` 必须列出选中的 memory refs、user prompt refs、key refs 和实际发送字节，默认空；key 若意味着 credential 只能经宿主 secret store 传给运行环境，绝不把密钥正文塞 prompt。显式文字注入经记忆域的读取/来源规则，不能绕过授权。保留期允许用户配置并显示每项清理时间，清理日志不抹掉不可变 effect 审计。

### 8.6 广播房间、presence 与文件协作

广播 API 支持 `room.create/join/leave/list`、`message.send/list/read/delete`、`presence.list`、`kick` 和 `room.remove`。房间成员、角色、加入时间、最后心跳和可见范围必须持久化；消息使用 sequence、sender、replyTo、mentions、attachments 和 delivery 状态。presence 只表示在线/忙碌/离线估计，不代表任务已执行。房间删除是软删除，历史消息仍可在审计范围读取。

协调服务提供 `claim.declare/status/release` 和冲突建议。`resourceKind=file` 声明包含路径模式、读写类型、节点、预计期限和目的；`resourceKind=service` 包含规范化服务名、协议、bind address/port、工作区和用途，不读取服务凭据。同一路径的重叠写声明或同端口服务声明应提示风险，但不会阻止读或取决于聊天顺序。声明的 `declared` 与真实观察到的 `observed` 分开，退出服务与释放声明也分开；不能因为 release 就杀掉未归当前节点所有的进程。真正写入需 CAS（见第 9 节），冲突时生成三方差异 artifact。广播消息和文件/服务声明都必须与 `TaskNode` 关联，避免无法追踪“谁说要改、谁实际改了”。

## 9. 文件、搜索、压缩读写与 Native/PTC

### 9.1 文件能力统一合同

产品内置 OPS 的 16 项能力：`inspect_local_file`、`grep`、`glob`、`replace`、`write_file`、`edit_file`、`diff`、`stat`、`copy`、`move`、`remove`、`read_many`、`edit_many`、`table_read`、`doc_read`、`pdf_read`。每个工具都有 `path/root/scope`、输入大小、编码、换行与 revision 字段，返回统一 envelope、`warnings`、`effect` 和 artifact refs。产品 UI 先执行 `discover` 或 SDK `loadNext` 获取精简 schema，再按需加载详细参数，避免首轮 prompt 携带全部工具正文。

读工具分 `Native` 与 `PTC` 两种呈现。Native 返回紧凑行号文本、明确截断和 `nextCursor`；PTC 返回 typed rows、分页、聚合和结果引用。两者可以共享同一授权和扫描内核，但不能声称输出形状相同。用户在表格/文档场景可选 PTC；代码审查和快速上下文优先 Native。权限由宿主授予，工具不能自行扩大根目录或读取环境秘密。

### 9.2 读取、分页与结果引用

扫描响应至少含 `scanId`、`snapshotId`、`root`、`items`、`pageInfo{cursor,hasNext,scanComplete,pageComplete}`、`truncated`、`warnings` 和 `resultRef`。`pageComplete` 只表示当前页结束，`scanComplete` 才表示目录遍历和索引完整；当预算耗尽或 provider 报错时必须为 false。cursor 绑定 provider、snapshot、查询、排序和权限 revision；过期或漂移返回 `stale_cursor`，客户端重新发起 scan，不能从新快照拼接旧页。

大结果存为受 ACL 保护的 artifact，引用具有 expiry、size、hash、mediaType 和 producer node。默认只在对话中返回前 100 行或 64 KiB，用户点击或显式请求才取更多。批次读取/编辑返回 item-level 状态与失败原因，保留 `batchId` 和 completed indexes；resume 只重做未完成且无 effect unknown 的项。工具批次不以一个“全部成功”布尔值掩盖部分失败。

### 9.3 原子写、CAS 与路径安全

每次 `write_file/edit_file/replace/edit_many` 都要求 `expectedRevision` 或明确 `createOnly`。写入流程为校验路径→读取当前 stat/hash→生成临时文件→fsync（宿主能力允许时）→原子 rename→刷新 stat/hash→追加审计。revision 漂移返回 `conflict`，同时提供基线、当前和候选三方差异；不会静默覆盖。批次写要么按声明的事务策略逐项提交并报告，不能宣称跨文件原子。

元数据选项包括 encoding、BOM、newline（LF/CRLF/保持）、permissions、mtime 和 ACL；默认保持原文件编码与换行。用户明确要求转换时记录 before/after。`copy` 默认 `noOverwrite=true`，`move` 先检查目标和同卷原子能力，跨卷移动降级为 copy+verify+remove 并披露中间状态。软链接、junction、绝对路径、`..` 穿越、设备路径、压缩炸弹和超大稀疏文件都在规范化后拒绝；每个根绑定 allowlist，符号链接不得跳出根。

### 9.4 文件检索与压缩读写边界

广域检索 provider 按平台/能力依次支持宿主索引、macOS `mdfind`、Windows Everything `es`、`rg`、受限递归 walk；索引 provider 缺失时明确降级，不自动安装工具。查询支持 filename/content/all/off、扩展名、目录、mtime、排序和 cache TTL；off 时既不检索也不主动构建缓存。结果标明 provider、索引时间、是否可能遗漏和实际路径。默认只读，用户明确授权后才可跨项目根。搜索结果按 root、路径、hash 去重，保留同路径不同版本。全文搜索限制单文件大小、总扫描字节、并发 worker 和正则复杂度；超限返回 `resource_limit`。

“压缩读写”在本产品中定义为两层能力：一是对模型输出采用紧凑字段、行号范围和 resultRef，降低传输量；二是对 `.zip/.tar(.gz)` 等归档执行受限列目录、读取单条目和写入新归档。第二层是产品新增能力，不能宣称 OPS 已提供通用 ZIP 工具。归档读取默认不自动解压到工作区，限制压缩比、条目数、单条目大小、总展开大小、嵌套深度和路径；绝对路径、`..`、重复目标名和 symlink 条目拒绝。归档写入采用新文件+校验+原子交付，不修改原归档；压缩失败保留临时 artifact 并清理索引。

### 9.5 文档格式实际支持

`table_read` 支持 CSV/TSV 的流式行读取、分隔符和引号配置，提供列类型推断但允许用户覆盖；坏行按行报告。`doc_read` 支持 DOCX 主要段落、表格、标题和文档关系，保留页眉页脚能力差异；不保证完整布局。`pdf_read` 只承诺可抽取文本和页码范围，扫描 PDF、复杂字体、版面重排、图片和 OCR 需要明确标为 unsupported 或 partial。当前范围不包含 DOC、通用 PDF 渲染或网页抓取。失败应给格式、页码/条目和建议，不把空文本当成功。

### 9.6 Native/PTC SDK 与权限

SDK 提供 `batch.plan`、`batch.run`、`batch.resume`、`result.page`、`result.release`、`cancel` 和 `capability.discover`。计划阶段只校验参数、预算、授权和潜在影响，不写文件；run 返回 batchId；resume 使用 checkpoint 和 snapshot；release 释放 resultRef。每个调用都带 `actor`、`session`、`authorizationRef`、`cwd` 和 `dryRun`。取消计划不会撤销已完成 effect，界面列出已完成、待执行和未知项目。

权限提示使用分级 `read`、`write`、`delete`、`external_process`、`network`、`notification`、`cross_project`，按会话和任务快照绑定。用户取消某一权限后，后续工具请求必须失败并说明哪一项缺失；不能通过换用另一个 provider 绕过取消。工具错误需区分参数错误、权限拒绝、资源上限、冲突、provider 不可用和内部故障。

## 10. 素材画布、图表、HTML 与 explainer

### 10.1 Canvas 数据模型

画布使用版本化 JSON IR 保存，不把完整图内容注入每次对话。文档包含 `canvasId`、`revision`、`scope`、`nodes`、`edges`、`groups`、`themeRef`、`locale`、`focus`、`createdBy` 和 `lastGoodRef`。默认上限 500 nodes、50 AI notes、单 note 128 KiB；超过上限按用户扩容策略拒绝或分页。`canvas.list/get` 返回摘要和节点索引，`canvas.add_note` 通过 `expectedRevision` CAS，冲突时要求刷新，不能后写覆盖先写。

scope 为 `session`、`project`、`user` 三种。session 画布随会话归档，project 画布受项目 ACL，user 画布不自动暴露给项目成员。AI note 明确标注生成者、时间、模型、来源 refs、是否已采纳；删 note 不删除其 evidence。加载画布只取当前焦点附近节点，用户要求时再展开邻接节点，避免上下文膨胀。

### 10.2 Archify 图表 IR 与类型

统一图表入口 `visual.create` 接收 `diagramType`、`sourceRefs`、`theme`、`locale`、`focus`、`audience`、`outputTargets` 和 `validationPolicy`。支持 architecture、workflow、sequence、dataflow、lifecycle、ERD、class、tree、timeline、waterfall 十类，类型 schema 可扩展但未知类型必须拒绝。内部流程为 source snapshot→IR 生成→schema validate→布局诊断→局部修复（最多两轮）→渲染→原子交付。确定性验证检查节点 ID 唯一、边端点存在、必填标签、循环许可、层级闭合和输出尺寸；它不替代视觉复核。

IR 必须可重现：记录 generator 版本、输入 refs/hash、随机种子、字体/图标包版本和主题。`focus`、`reach`、`route`、`lens`、`story`、`minimap` 等视图参数只影响投影，不修改原 IR。delta 更新以 `baseRevision` 和操作列表提交，单次变更过大应拆批。品牌和 locale 作为主题数据，不能把第三方品牌字体或图标许可证默认当作本产品授权。

### 10.3 HTML explainer 与预览安全

HTML 交付包含精确输出路径、文件 hash、入口文件、资源清单、浏览器兼容和安全策略。预览使用 sandboxed iframe、禁止脚本访问宿主 Electron bridge、限制 CSP、禁用任意外链和远端字体，默认只允许项目内相对资源。需要 loopback 服务时使用随机端口、只绑定 localhost、单文件目录和短时 token；服务停止后 token 失效。用户选择外链资产时显示域名、风险和缓存 hash。

预览动作与正式 `Produced Files` 宿主桥分离。画布可以先交付 preview artifact；要发布到宿主产物区必须调用正式 bridge，确认目标路径、覆盖策略、ACL 和交付清单。bridge 不可用时应提供下载/复制路径，不假称已发布。last-good 版本在新渲染失败时继续可预览，失败版本进入 diagnostics，不能覆盖上一个可用文件。

### 10.4 交付与失败恢复

局部诊断失败最多自动修复两轮，每轮只修改报告定位的 IR 节点；两轮后保留错误与候选 patch，要求用户选择。渲染过程中取消要清理临时目录；若已生成文件则标为 uncommitted artifact。原子交付顺序为写临时目录→完整校验→写 manifest→rename 入口和资源→更新 canvas revision。任何步骤失败都恢复 last-good，审计记录临时文件和清理结果。

## 11. 其他独特能力与跨产品边界

### 11.1 书签、中间 turn fork 与历史

书签保存 `sessionId/turnId/messageRange/label/evidenceRefs`，可在同一会话或用户授权的相邻会话域跳转。中间 turn fork 创建新分支历史，继承截至该 turn 的上下文快照；后续消息历史独立，分支元数据标记 parentTurn。同一workspace的物理文件仍然共享，普通fork不提供文件写入隔离。用户选择“隔离工作区分支”时另建目录/worktree计划、绑定新WorkspaceIdentity并披露Git/磁盘影响，不能把它归为官方fork自带保证。fork不复制凭据、未授权附件或正在运行的effect；继承历史按09章原始来源身份处理，不重新capture或付费retain。

跨产品历史搜索只读。旧 W8 证据仅明确支持 Codex JSONL 读取，本产品应提供 `historyProvider.describe`，对不支持的 Desktop 数据源返回 unsupported；不能把压缩日志、其他产品数据库或不存在的索引伪称已实现。命中结果携带产品、会话、时间、文件 hash 和可见性，用户无权的会话完全不返回。

### 11.2 旁观 advisor 与来源标记

Advisor 只能读取当前用户明确可见的 user/assistant 消息、工具结果和授权 artifact。输出 `kind` 为 `observation/risk/suggestion/question`，严重度独立保留旧功能的 `info/nit/concern/blocker` 四级，不能把内容种类误当严重度。可选择采纳为草稿、steer 建议或忽略，可重开独立评审会话；重开保留旧建议与采纳记录，重新观察前只取得本次授权快照。Advisor 永远不能伪装 user、替用户发送消息、改变系统提示词或获得额外权限；所有插入带 `plugin:<new-plugin>/advisor` 来源和原授权引用。steer 没有正式宿主 API 时只进入待发送草稿，不写入会话日志。

### 11.3 通知、渠道与图片附件

通知 API 分为宿主 Web bell、本地桌面通知和外部渠道 adapter。未来渠道包括飞书、QQ、微信、企业微信等，当前只定义接口和授权，不实际发送。`notify` 是通知当前用户，`channel_send` 是面向指定渠道和收件人的直接发送，二者共享内容合同但不共享默认收件人/授权。每次发送包含 channel、recipient、payload hash、附件 refs、idempotencyKey、授权、attempt 和 delivery receipt；channel adapter 返回 accepted/delivered/failed/unknown。超时或 unknown 时先查询 receipt，默认不重复发送。图片附件可来自本地文件、会话附件查询、画布导出、CLI 结果、已授权远端 URL 或显式 base64，记录 mime、hash、大小、来源和过期时间；base64 解码前限制编码体积，解码后验证魔数与真实媒体类型；来源不可验证时拒绝外发。`session.images` 必须按会话权限返回附件元数据和可取引用，不能读取其他会话附件。

用户可按渠道、收件人和任务撤销通知权限。发送前 UI 显示正文摘要、附件、目标和有效期；未来自动化只能在已有授权范围运行，不把“通知用户”理解为取得第三方发送同意。渠道失败不改变主任务成功状态，写入关联 warning 和 retry 建议。

### 11.4 模型、活动会话和 Mermaid

`models.list` 查询宿主实时可用模型、provider、上下文上限、图片能力、价格/配额提示和 deprecated 状态；`models.set` 只影响当前草稿或明确目标节点，已运行节点保持快照。活动会话筛选支持 session/project/branch/provider/status/time，停止会话要求使用宿主正式 cancel。Mermaid 作为可导入导出格式保留；解析失败提供行列诊断，不能用正则删除未知语法后声称成功。

## 12. 配置、持久化、迁移、可观测与资源限额

### 12.1 配置分层与安全存储

配置层级为宿主默认→用户→项目→会话→任务快照，后层只覆盖允许字段。凭据仅存宿主 secret store，配置文件与导出包只保存 secret reference。每项配置有 schemaVersion、revision、source、updatedAt；更新采用 CAS。未知字段保留在 extension 区供前向兼容，但不能驱动未声明行为。禁用某模块只停用它的 provider，不删除历史任务、技能或画布。

### 12.2 持久化结构与迁移

持久化分为 `index.db`（任务、会话、引用、状态）、`artifacts/`（内容寻址文件）、`events/`（追加事件）和 `exports/`（用户导出）。artifact 使用 SHA-256 内容寻址，写入先临时文件后校验 rename；引用计数和过期策略避免悬空文件。事件按 session/task 分区，保留 schemaVersion、producerVersion 和校验链，损坏时可从最近 checkpoint 重建索引。

迁移必须是可回滚、幂等、分阶段：备份→只读校验→新结构写入→校验计数/hash→原子切换→记录 migration receipt。旧版本未知字段和旧状态保留在 `legacy`，不能把旧任务全部转为 succeeded。升级失败恢复旧索引并保持新生成 artifact 可回收。导入外部资产必须显式映射许可、owner、来源和时间，不把文件名当唯一 ID。

### 12.3 可观测性与隐私

日志分 `user-visible`、`audit`、`debug`，默认 debug 关闭。每个请求有 traceId、sessionId、taskId、parentSpanId、provider、duration、bytes、token estimates、resultRef 和 effect summary。日志正文脱敏，禁止记录 credential、完整授权 token、私有 prompt 全文和未经许可的附件。指标包括队列等待、运行时长、重试率、effect unknown、工具失败类型、扫描截断率、渲染失败、通知 receipt 延迟和预算耗尽。用户可导出某任务的事件与证据包，并选择是否包含 prompt/output 原文。

### 12.4 资源与公平性限制

默认限制：单任务输入 16 MiB、单结果 64 MiB、单画布 500 nodes、单批 1,000 项、并发代理 4、单任务子节点 8、技能包 32 MiB/2,000 文件、归档展开 128 MiB/深度 3、文件扫描 256 MiB、正则单次 5 秒。所有限制在 capability discovery 返回并可由宿主策略收紧。队列采用每会话公平调度，重试不能无限占用并发；高风险写/删任务比读任务拥有更短的自动重试预算。

### 12.5 失败恢复矩阵

| 场景 | 状态 | 自动动作 | 用户可选动作 |
|---|---|---|---|
| provider 启动前崩溃 | failed | 可安全重试创建 | 重试/改引擎/结束 |
| provider 已接受无回执 | effectUnknown | 查询 status/receipt | 查询/强制重发/结束 |
| 文件 revision 漂移 | blocked | 生成三方 diff | 合并/覆盖/放弃 |
| 宿主重启 | interrupted | 恢复只读查询 | 逐项继续写任务 |
| 预算耗尽 | timedOut | 保存 partial refs | 增加预算/结束 |
| 预览渲染失败 | failed | 保留 last-good | 修复 IR/下载诊断 |
| 渠道发送超时 | effectUnknown | 查询 receipt | 重试/不再发送 |

## 13. WF 验收条款（Given/When/Then）

以下条款作为发布门槛，测试数据使用临时项目、虚拟 provider 和无真实凭据的 fixture。每条都要保留 task/event/artifact refs；视觉条款需人工在受控浏览器确认。

### 13.1 编排与会话

- **WF-001** Given 两个互不依赖节点，When 提交 DAG，Then 两者可并行且状态事件序号连续。
- **WF-002** Given 节点 A 依赖 B，When B failed，Then A 为 blocked 并显示失败原因和 evidence refs。
- **WF-003** Given 提交包含闭环依赖，When 校验，Then 整批拒绝并返回闭环路径。
- **WF-004** Given provider 已返回远端 ID 后 UI 超时，When 刷新，Then 查询原 ID，绝不创建第二个节点。
- **WF-005** Given starting 阶段 effect unknown，When 用户点击重试，Then 首先要求 reconcile 或明确强制重发。
- **WF-006** Given 普通专家无递归capability时尝试spawn，When 策略检查，Then 返回expert_recursion_denied且主会话仍可继续；第12章受控层级角色必须通过冻结计划、授权、深度/预算/ownership检查才能派生。
- **WF-007** Given 子代理未指定模型/cwd/preset，When spawn，Then 继承父快照并在详情显示继承来源。
- **WF-008** Given 子代理覆写模型，When spawn，Then 事件记录覆写值和授权，父节点配置不改变。
- **WF-009** Given attach lease 被另一节点持有，When attach，Then 返回冲突双方，不覆盖工作区。
- **WF-010** Given lease 过期且分支 hash 漂移，When 接管，Then 要求用户确认并生成差异。
- **WF-011** Given cancel 尚未收到 ACK，When 用户查看，Then 显示 cancelRequested/effectUnknown，不伪称已取消。
- **WF-012** Given 宿主重启，When 恢复扫描，Then 活动节点为 interrupted 并保留 checkpoint。
- **WF-013** Given 重启后的写文件节点，When 自动恢复策略执行，Then 必须等待显式继续授权。
- **WF-014** Given 可重试网络错误，When 自动重试，Then 使用退避、同一幂等键并递增 attempt。
- **WF-015** Given 非幂等通知超时，When retry，Then 先查 receipt，不直接重复发送。
- **WF-016** Given 预算 maxModelCalls=1，When 子节点将超限，Then 节点 timedOut/failed 且不再调用模型。
- **WF-017** Given CLI provider 不支持图片，When 提交图片，Then 提交前返回 unsupported，不启动进程。
- **WF-018** Given prompt 长度超过 shell 安全阈值，When 调用 CLI，Then 使用临时文件/stdin，不出现在 argv。
- **WF-019** Given 自定义 adapter 执行文件不在白名单，When describe，Then provider 不可用并给配置原因。
- **WF-020** Given 广播成员离线，When send message，Then 保存 accepted/receipt 状态，不把 presence 当执行确认。

### 13.2 文件、搜索与文档

- **WF-021** Given 文件 revision 与 expectedRevision 相同，When edit，Then 原子写入并返回新 hash/revision。
- **WF-022** Given revision 漂移，When edit，Then 返回 conflict 和三方 diff，不覆盖当前文件。
- **WF-023** Given 路径含 `..` 穿越根，When read，Then 拒绝并记录 normalized path。
- **WF-024** Given symlink 指向根外，When inspect，Then 拒绝读取并显示 link target 风险。
- **WF-025** Given copy 目标已存在，When copy 默认调用，Then noOverwrite 冲突且源文件不变。
- **WF-026** Given 跨卷 move，When 执行，Then 返回copy+verify+remove阶段而不是宣称单次原子移动。
- **WF-027** Given 扫描达到字节上限，When 返回页面，Then pageComplete=true、scanComplete=false并给warning。
- **WF-028** Given cursor对应快照已过期，When 继续分页，Then 返回stale_cursor并要求新scan。
- **WF-029** Given 批次中第3项失败，When resume，Then 只重做未完成项并保留第1/2项结果。
- **WF-030** Given Native读取代码，When 返回，Then 含行号、截断标记和nextCursor。
- **WF-031** Given PTC读取表格，When 返回，Then 含typed rows和分页信息，不伪装成行号文本。
- **WF-032** Given CSV坏行，When table_read，Then 逐行报告错误且其他合法行可取。
- **WF-033** Given PDF为扫描图，When pdf_read，Then 标记OCR unsupported/partial，不返回空成功。
- **WF-034** Given DOCX包含段落表格，When doc_read，Then 返回两类结构及格式边界警告。
- **WF-035** Given 归档含绝对路径条目，When list/read，Then 拒绝该条目并不解压到工作区。
- **WF-036** Given 归档展开超过128MiB，When read entry，Then 返回resource_limit并清理临时目录。
- **WF-037** Given 工具权限被撤销，When 后续write，Then 拒绝且不通过其他provider绕过。
- **WF-038** Given resultRef已过期，When result.page，Then 返回expired并保留原审计事件。

### 13.3 画布、图表与 HTML

- **WF-039** Given 画布revision=4，When add_note expectedRevision=4，Then 生成revision=5并保留note来源。
- **WF-040** Given 两个客户端同时写revision=4，When 第二个提交，Then CAS冲突且第一个结果不被覆盖。
- **WF-041** Given 画布超过500 nodes，When add，Then 拒绝或按已配置分页策略，并说明限额。
- **WF-042** Given 未知diagramType，When visual.create，Then schema拒绝并列出受支持类型。
- **WF-043** Given 图表边指向不存在节点，When validate，Then 确定性诊断失败，不进入渲染。
- **WF-044** Given 布局只有局部节点错位，When auto-fix，Then 最多两轮且patch范围可审计。
- **WF-045** Given 新渲染失败，When preview，Then 继续显示last-good且新版本不覆盖入口。
- **WF-046** Given 预览HTML含外链脚本，When 打开，Then CSP/iframe阻断并显示资源来源。
- **WF-047** Given 请求Produced Files交付但bridge不可用，When deliver，Then 返回未发布和精确本地路径。
- **WF-048** Given loopback预览，When 停止任务，Then 端口token失效且服务退出。
- **WF-049** Given 品牌字体未获许可，When 导出，Then 使用替代字体并在manifest列出许可警告。
- **WF-050** Given Mermaid语法未知，When 导入，Then 返回行列诊断，不静默删语法。

### 13.4 技能、提示词、待办与治理

- **WF-051** Given 同名skill有项目和用户版本，When list，Then 显示冲突和当前生效来源。
- **WF-052** Given 导入zip含symlink和postinstall，When import，Then 拒绝危险项且不执行脚本。
- **WF-053** Given 技能更新revision过期，When update，Then CAS拒绝并要求读取最新版本。
- **WF-054** Given 用户编辑了技能，When 运行候选提炼，Then 生成新hash并不覆盖用户正文。
- **WF-055** Given 模板缺少必填binding，When inject，Then 拒绝且不把占位符发给模型。
- **WF-056** Given 持续注入激活，When 查看会话，Then 显示remainingRounds、撤销入口和预算占用。
- **WF-057** Given advisor建议steer，When 无正式注入API，Then 进入草稿并标明来源，不冒充user。
- **WF-058** Given 人工待办关联节点且缺少delivery evidence，When 关联节点成功，Then 保留待办原状态，不能只凭节点成功自动完成人工待办。
- **WF-059** Given overdue待办和未来待办混合，When 默认视图，Then overdue排在前且组内排序稳定。
- **WF-060** Given 日期2026-02-30，When import，Then 拒绝非法日期并保留原正文。

### 13.5 通知、权限、迁移与可观测

- **WF-061** Given 渠道发送返回unknown，When 任务刷新，Then 先查询receipt并显示unknown，不重复发送。
- **WF-062** Given 用户撤销微信渠道权限，When 自动化触发，Then 拒绝发送并保留主任务结果。
- **WF-063** Given 图片来自未授权远端URL，When channel_send，Then 拒绝附件并给来源错误。
- **WF-064** Given 旧索引迁移中途崩溃，When restart，Then 恢复旧索引且迁移可重试。
- **WF-065** Given artifact hash校验失败，When load，Then 隔离损坏文件并从checkpoint重建引用。
- **WF-066** Given 导入旧状态未知，When migrate，Then 保留legacy状态而非转成succeeded。
- **WF-067** Given 日志包含token，When export audit，Then 输出脱敏版本且原token不存在于导出文件。
- **WF-068** Given 用户无权访问另一项目会话，When history search，Then 不返回命中或路径侧信道。
- **WF-069** Given provider模型已deprecated，When models.list，Then 显示deprecated并阻止新任务默认选用。
- **WF-070** Given 并发任务超过maxConcurrent，When queue，Then 按会话公平排队并显示等待原因。
- **WF-071** Given debug日志关闭，When 任务运行，Then 用户日志仍含trace/task/effect摘要但不含prompt全文。
- **WF-072** Given 用户请求导出任务证据，When export，Then 包含事件、refs、版本和许可清单，且不含凭据。

### 13.6 视觉与发行门槛

- **WF-073** Given 窄屏宽屏和深浅主题，When 打开任务详情，Then 状态、预算、取消和错误均可读且不遮挡主要操作。
- **WF-074** Given 键盘无鼠标，When 执行提交、取消、展开结果，Then 焦点顺序可预测且有可见焦点。
- **WF-075** Given 屏幕阅读器，When 读取工具结果，Then 分页、截断、权限和effect unknown有语义标签。
- **WF-076** Given 高对比度模式，When 查看画布，Then 节点边界不只靠颜色区分。
- **WF-077** Given 网络断开，When 查看已缓存报告，Then 显示缓存时间和过期状态，不伪称实时。
- **WF-078** Given 升级后启动，When 读取旧项目，Then 迁移receipt可追踪，旧任务、技能和画布仍可打开。
- **WF-079** Given 许可证清单缺失第三方来源，When build release，Then 发行检查失败并列出待补 notices。
- **WF-080** Given 所有必需fixture通过，When 发布候选构建，Then 生成可复核验收报告和版本化 manifest。

### 13.7 代码审查、方法包和功能复活专门条款

- **WF-081** Given 同一文件既有 staged 又有 unstaged 变更，When 分别预览，Then staged 右侧取 index，unstaged 左侧取 index，且两份 hash 可核算。
- **WF-082** Given Git 根提交与 merge 提交，When 选择单提交审查，Then 根提交比空树，merge 要求明确 old/new 两端。
- **WF-083** Given 已固定历史 revision 的规则和上下文，When 工作区同名文件随后变化，Then 审查仍使用固定 blob，报告不引用当前文件。
- **WF-084** Given SVN 单 revision 123，When 捕获，Then 比较 122→123，接收十进制 revision 且拒绝 HEAD/date/r123。
- **WF-085** Given SVN UUID 相同的两个分支都取 revision 123，When 明确选择分支比较，Then 允许相同 revision 并固定各自 URL/peg/operative identity。
- **WF-086** Given SVN externals、mixed BASE、switched 和 sparse 节点，When 预览，Then 单列 excluded/blocked/unsupported，不悄悄跟随 externals。
- **WF-087** Given Preview 后文件、模型、范围或预算改变，When execute，Then 返回 SNAPSHOT_STALE 或要求新 Preview，旧授权不能覆盖扩大范围。
- **WF-088** Given 用户已明确授权同一范围和模型，When execute，Then 匹配现有授权记录，不重复索取无关确认。
- **WF-089** Given 审查模型完整结束但 JSON 无效，When 协议修复，Then 最多两次纠正；不补括号、不丢字段，计入预算。
- **WF-090** Given 审查模型取消、provider 错误或不完整输出，When 处理结果，Then 不进入 JSON 修复循环。
- **WF-091** Given finding 原坐标漂移但同文件同侧存在唯一精确原文，When 复核，Then 允许重新定位并保留原坐标；多次或模糊匹配则 uncertain。
- **WF-092** Given 1,000 个选中节点只有 900 完成，When 汇总，Then coverage 显示 partial、各状态总数可核算，不输出“全项目无问题”。
- **WF-093** Given 两会话审同一仓库，When 同时提交，Then 可各自运行；同一会话第二个审查必须排队或显式替代。
- **WF-094** Given Aegis、Superpowers、J-Space 都覆盖计划阶段，When 编译方法计划，Then 只出现一个主步骤，保留三者来源和独有可选模块。
- **WF-095** Given 简单低风险请求和 TDD off 策略，When 方法路由，Then 不强制生成全部文档或创建代理；用户明确要求测试时照用户要求执行。
- **WF-096** Given 旧 J-Space preset 目录已废弃，When 导入旧资产，Then 迁移为当前正式 bundle；旧认知模块仍可用并有完整性报告。
- **WF-097** Given Agency persona 目录超过 331 项，When 导入合法新内容，Then 数据模型可扩展、分类可搜索，不把 331 写成数据库上限。
- **WF-098** Given 后台审查启动只返回 ID，When 主会话交付，Then 必须等待终态并统一交付完整或明确 partial 报告。
- **WF-099** Given Code Review 素材用于非商业发行且许可条件满足，When 构建，Then 允许复用并保留原许可；商业配置无授权时只阻止相应材料发行，研究和其余模块不受阻。
- **WF-100** Given 旧 Evolve 本机搜索、广播、CLI、画布或通知功能因旧宿主接缝失效，When 新适配器不可用，Then 显示待适配/替代路径和对应验收，不能直接删掉该能力条目或报告成功。

## 14. 宿主待确认点、产品自拟接口与实施切片

### 14.1 必须向 Deep Seek Harness Desktop 核实的宿主能力

1. 原生 `spawn/wake/resume/cancel` 是否提供稳定 ID、幂等键和 effect status；若仅有 UI 操作，不能宣称可靠恢复。
2. session/team/worktree attach 是否有正式 lease、分支 revision 和跨会话 ACL；没有则采用本产品保守锁与人工确认。
3. Native/PTC 文件 API 的真实 schema、分页 cursor 生命周期、最大输入输出和权限错误码。
4. Produced Files bridge、画布/附件/图片协议、预览沙箱和 CSP 配置是否稳定公开。
5. 模型查询、消息注入、advisor 可见范围、活动会话筛选和历史搜索是否有官方 API；无 API 的功能必须降级为草稿或 unsupported。
6. Desktop 渠道通知是否支持 receipt 查询、附件 hash 和去重；外部渠道 adapter 在 API 稳定前仅实现 dry-run。
7. 个人/项目技能根、provider rank、配置迁移、secret store、日志脱敏和自动化调度的版本兼容承诺。

### 14.2 产品自拟但必须版本化的接口

以下接口是新插件提出的产品层协议，不能冒称宿主已有：`TaskNode` 状态机及事件、`batch.plan/run/resume` envelope、`canvas` IR/CAS、`visual.create` 十类图表、`historyProvider` 能力矩阵、`advisor` 分级建议、渠道 `receipt`/幂等、归档读取写入、技能候选审批、统一资源限额和迁移 receipt。每个接口在 `contracts/<name>.schema.json` 发布，携带 `schemaVersion` 和兼容策略；宿主适配器只负责映射，不能修改业务语义。

### 14.3 建议实施切片

- **S0 基线与合规**：锁定上游版本、license/NOTICE、能力探测、配置分层和最小 UI shell；输出来源清单和冲突矩阵。
- **S1 任务内核**：TaskNode/DAG、事件日志、幂等、预算、取消、恢复和虚拟 provider；先通过 WF-001–020。
- **S2 文件与文档**：OPS 16 工具适配、Native/PTC SDK、CAS、分页、压缩读写、CSV/DOCX/PDF 边界；通过 WF-021–038。
- **S3 方法与资产**：Aegis/Superpowers/J-Space 方法合并、Agency 专家/团队、提示词注入、技能提炼、待办；通过 WF-051–060。
- **S4 视觉交付**：Archify IR、画布、HTML explainer、sandbox 预览、Produced Files bridge、Mermaid；通过 WF-039–050。
- **S5 通知与历史**：书签/fork、只读历史、advisor、模型/活动会话、通知 adapter dry-run 和 receipts；通过 WF-061–072。
- **S6 迁移和发行**：升级/回滚、可观测、资源公平性、全量无障碍、许可证扫描和 release manifest；通过 WF-073–080。

每个切片必须留下可运行的降级路径和证据包；禁止以“后续接宿主 API”掩盖当前调用假成功。切片之间仅通过版本化 contracts 传递 artifact refs，避免循环依赖。所有上游复用模块在实现登记表注明仓库、commit、文件、license、修改差异和测试来源，Code Review 的非商业许可按适用范围执行，商业发行前由法务/产品确认授权边界。未确认的 Desktop 适配器在 UI 中显示 `experimental/unsupported`，不影响其余本地只读功能运行。

本规格书完成后，开发团队应先生成能力探测报告和 contracts，再创建最小垂直切片；任何“功能已支持”的产品文案都必须能指向宿主能力证据、实现版本和至少一条 WF 验收记录。

## 15. 功能需求索引与覆盖追踪

`WF-Rxxx` 是功能需求 ID，`WF-xxx` 是验收 ID，二者不能互换。下表可直接进入全局 coverage；本章中每个“必须/不得”都从属于相应功能需求，细分实现项可追加后缀，不能修改已有 ID 的含义。上游编号 W1–W8 的固定 SHA 与证据坐标见研究文档第 1 节。

| 需求 ID | 完整功能簇及来源 | 规格位置 | 主要验收 |
|---|---|---|---|
| WF-R001 | 一包安装/配置/卸载，宿主版本与能力探测，固定 dispatcher，内部别名迁移；全部上游 | §2–4、§14 | WF-064–080、WF-100 |
| WF-R002 | Git worktree/staged/unstaged/单提交/区间/全项目、重命名与固定 blob；W1 | §5.1–5.2 | WF-081–083、WF-087–088 |
| WF-R003 | SVN working/单 revision/区间/分支/mergeinfo、UUID/URL/peg/属性/来源身份；W1 | §5.3 | WF-084–087 |
| WF-R004 | 规则/上下文/有限依赖导航、候选检索、严格模型 JSON、复核证据、去重、覆盖报告；W1 | §5.4–5.5 | WF-089–092 |
| WF-R005 | 后台审查启动/状态/等待/取消、同会话互斥/跨会话并行、快照过期与重启；W1 | §5.5、§8 | WF-011–015、WF-093、WF-098 |
| WF-R006 | 风险分流、基线、目标/验收、头脑风暴、计划、TDD、调试、评审、隔离、收尾、复盘、ADR、反熵、UIUX、第一原则；W2/W5 | §6.2 | WF-094–095 |
| WF-R007 | J-Space 正式 preset、13认知模块/7参考/控制器/账本/周期完整重读与预算；W7 | §6.1–6.2 | WF-095–096 |
| WF-R008 | skill discovery/get/import/export/冲突优先/enable/disable/frontmatter/resourceBase；W2/W4/W5/W7/W8 | §6.1 | WF-051–054 |
| WF-R009 | 经验提炼、相似技能补丁、审核/拒绝/发布/退役、先读后改和人工编辑保护；W8 | §6.5 | WF-053–054 |
| WF-R010 | 22类可扩展专家库、331快照/中英内容、自定义persona/分类/筛选、启停/软删除；W3 | §6.3 | WF-006–008、WF-097 |
| WF-R011 | 专家团成员/职责/目标/约束/交付/示例、普通subagent/native team路由、草稿并发保护；W3/W7 | §6.3、§8.2 | WF-001–010、WF-097 |
| WF-R012 | 提示词检索/CRUD/参数、一次/定次/每N轮/持续/立即注入、来源与撤销；W8 | §6.4 | WF-055–057 |
| WF-R013 | life/work/project/daily待办、四象限/due/category/状态/归档/排序/旧标签导入；W8 | §7 | WF-058–060 |
| WF-R014 | DAG/任务快照/依赖/预算/公平调度/幂等/取消/等待/重试/重启/effect unknown；W1/W3/W8 | §8.1–8.4、§12 | WF-001–016、WF-064–072 |
| WF-R015 | 独立session spawn/wake/resume/continue、模型/cwd/preset继承、工作区attach与用户接管；W8 | §8.3 | WF-004–013 |
| WF-R016 | Kimi/Codex/Grok/Hermes及自定义CLI adapter、图片/模板/作用域/注入/日志/保留；W8 | §8.5 | WF-017–019、WF-100 |
| WF-R017 | 房间广播create/join/leave/list/dissolve/kick、send/read/delete、unread摘要、presence、图片；W8 | §8.6 | WF-020、WF-061、WF-100 |
| WF-R018 | 文件/服务声明declare/status/release、declared/observed、冲突/租约与非锁语义；W8 | §8.3、§8.6 | WF-009–010、WF-021–022 |
| WF-R019 | OPS 16能力：inspect/grep/glob/replace/write/edit/diff/stat/copy/move/remove/read_many/edit_many/table/doc/pdf；W4 | §9 | WF-021–034 |
| WF-R020 | Native紧凑行号/PTC typed数据、discover/loadNext、batch plan/run/resume、result page/release、错误/效果回执；W4 | §4、§9.1–9.2、§9.6 | WF-027–031、WF-037–038 |
| WF-R021 | 本机文件名/正文/扩展名/mtime检索、宿主索引/mdfind/Everything es/rg/walk/cache、授权根；W8 | §9.4 | WF-023–024、WF-027–028、WF-068、WF-100 |
| WF-R022 | 紧凑输出/resultRef和受限归档列目录/单条目读取/新归档原子写；前半W4，归档新增 | §9.2、§9.4 | WF-035–038 |
| WF-R023 | 素材画布文件/图像/音频路径引用、session/project/user视角、CRUD/AI note/rev CAS/按需上下文；W8 | §10.1 | WF-039–041、WF-100 |
| WF-R024 | 十类Archify图、typed IR/局部delta/品牌/locale/theme/focus/reach/route/lens/story/minimap/导出；W6 | §10.2 | WF-042–045、WF-049 |
| WF-R025 | Explainer/HTML-SVG/loopback单文件预览、CSP/iframe、last-good、两轮局部修复、原子交付/Produced Files桥；W6 | §10.3–10.4 | WF-043–048 |
| WF-R026 | 书签/轮次跳转/搜索/中间turn fork/分支谱系、只读跨产品历史及provider格式矩阵；W8 | §11.1 | WF-068、WF-078、WF-100 |
| WF-R027 | 旁观advisor持续独立评审/分级/重开/采纳/忽略/steer及明确来源；W8 | §11.2 | WF-057、WF-068 |
| WF-R028 | Web bell/桌面/飞书QQ微信企微通知、文本/图片/会话附件查询/多来源/逐渠道receipt与防重；W8 | §11.3 | WF-061–063、WF-100 |
| WF-R029 | 模型查询/设置、活动会话筛选、会话ID/别名入口、Mermaid、移动适配与上下文占用提醒；W8 | §11.4，详细UI交相邻UI章 | WF-050、WF-069、WF-073–077 |
| WF-R030 | 配置分层/secret store、对象和artifact持久化、迁移回滚、日志指标/证据导出、资源公平性；全部上游 | §12 | WF-064–072、WF-078 |
| WF-R031 | 合法源码组合/来源SHA/改动清单、版权NOTICE、内容和品牌许可、商业发行配置；全部上游 | §2.1、§14.3及研究§2 | WF-079–080、WF-099 |

覆盖解释：`WF-R029` 的移动、上下文占用和会话入口属于 UI 章联合责任；本章必须提供数据和动作，不把分工当删除。`WF-R026` 的宿主分支历史属于会话图章联合责任；本章使用正式 fork/provider 协议，不创建第二套会话真源。`WF-R022` 的归档是明确新增的产品能力，其可实施与限额合同独立于对 OPS 原有能力的事实判断。
